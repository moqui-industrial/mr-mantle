// Resource booking policy and blackouts (mantle.work.ResourceBookingServices' policy, approver and availability services, the
// planned blocks of record#, correct# and end#ResourceUnavailability, and the guard of EventServices' book#Resource and
// check#ResourceBookings; IronStone Maintenance design §7.1; impl-maintenance P15, F15): a booking over an outage is refused even
// with allowConflicts, and says no more than "out of service"; adjacent bookings of a managed room are accepted; a hidden event
// is answered as Busy, with no title, in a conflict and in the availability read; a booking past the horizon, a recurring one
// whose range runs past it and one over the maximum duration are refused; allowConflicts alone books nothing over another booking
// of a managed room, the override with its permission and a reason does; approval required with no approver blocks, and ending the
// last approver with a request waiting needs another or a reason; an unmanaged room behaves as before (its approver fallback); a
// new blackout of the building flags the approved booking of its room and cancels nothing, and refuses a booking under it;
// Manufacturing's offline time of a work center is a planned block written by record#, which a Maintenance supervisor may correct
// and whose withdraw ends the row in force. Standalone: spec-local organizations, a building with three rooms, a compressor, a
// plant with a work center, groups and users; the services called as each user with the artifact check aside.
// Run: ./moq test mr-mantle --spec ResourceBookingPolicy
const prefix = "RBP"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    building = prefix + "_BLDG",
    managedRoom = prefix + "_ROOM_M",
    plainRoom = prefix + "_ROOM_U",
    approvedRoom = prefix + "_ROOM_P",
    compressor = prefix + "_COMP",
    projector = prefix + "_PROJ",
    plant = prefix + "_PLANT",
    line = prefix + "_LINE",
    since = "2000-01-01T00:00:00Z"
const R = "mantle.work.ResourceBookingServices.",
    E = "mantle.work.EventServices.",
    L = "mantle.work.ProductionPlanningServices."
const state = {}
const hour = 3600000,
    day = 24 * hour
// three days ahead at 10:00 UTC, so every booking lies in the future
const base = Math.floor(Date.now() / day) * day + 3 * day + 10 * hour
const at = (hours, days = 0) => new Date(base + days * day + hours * hour)
let keySeq = 0
const key = () => prefix + "-op-" + ++keySeq
const ms = value => (/^-?\d+$/.test(String(value)) ? Number(value) : Date.parse(String(value)))

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
function organization(partyId) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    call("create#mantle.party.Organization", {partyId, organizationName: partyId})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
function user(kind, permissions, organizationPartyId = orgA) {
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Booking policy " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    const partyId = prefix + "_P_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Booking", lastName: kind})
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
        userFullName: "Booking " + kind,
        partyId,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA"
    })
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: since})
    state[kind + "_PARTY"] = partyId
    return id
}
// an event of the user from start to end (an RRULE makes it a series)
function event(username, name, from, to, rrule) {
    return as(username, E + "create#Event", {
        workEffortName: name,
        estimatedStartDate: from,
        estimatedCompletionDate: to,
        rrule: rrule || null
    }).workEffortId
}
const facilityBooking = (workEffortId, facilityId) =>
    ec.entity.find("mantle.work.effort.WorkEffortFacility").condition({workEffortId, facilityId}).disableAuthz().one()

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(orgA)
        organization(orgB)
        call("create#mantle.facility.Facility", {
            facilityId: building,
            facilityTypeEnumId: "FcTpBuilding",
            facilityName: "Policy building",
            ownerPartyId: orgA
        })
        for (const [facilityId, facilityName] of [
            [managedRoom, "Managed room"],
            [plainRoom, "Plain room"],
            [approvedRoom, "Approved room"]
        ])
            call("create#mantle.facility.Facility", {
                facilityId,
                facilityTypeEnumId: "FcTpRoom",
                facilityName,
                parentFacilityId: building,
                bookable: "Y",
                capacity: 8
            })
        call("create#mantle.product.asset.Asset", {
            assetId: compressor,
            assetTypeEnumId: "AstTpEquipment",
            assetName: "Spec compressor",
            statusId: "AstAvailable",
            ownerPartyId: orgA,
            facilityId: building,
            bookable: "Y"
        })
        call("create#mantle.product.asset.Asset", {
            assetId: projector,
            assetTypeEnumId: "AstTpEquipment",
            assetName: "Spec projector",
            statusId: "AstAvailable",
            ownerPartyId: orgA,
            facilityId: building,
            bookable: "Y"
        })
        call("create#mantle.facility.Facility", {
            facilityId: plant,
            facilityTypeEnumId: "FcTpPlant",
            facilityName: "Policy plant",
            ownerPartyId: orgA
        })
        call("create#mantle.facility.Facility", {
            facilityId: line,
            facilityTypeEnumId: "FcTpLine",
            facilityName: "Policy line",
            parentFacilityId: plant,
            ownerPartyId: orgA
        })
        call("create#mantle.work.production.WorkCenter", {facilityId: line})
        state.resources = user("RESOURCES", ["MAINTENANCE_RESOURCE_VIEW", "RESOURCE_POLICY_VIEW", "RESOURCE_POLICY_EDIT"])
        state.supervisor = user("SUPERVISOR", ["MAINTENANCE_VIEW", "MAINTENANCE_SUPERVISE"])
        state.scheduler = user("SCHEDULER", ["PRODUCTION_SCHEDULE", "PRODUCTION_VIEW"])
        state.ann = user("ANN", [])
        state.bob = user("BOB", [])
        state.overrider = user("OVERRIDER", ["RESOURCE_BOOKING_OVERRIDE"])
        state.outsider = user("OUTSIDER", ["RESOURCE_BOOKING_OVERRIDE"], orgB)
        state.approver = user("APPROVER", ["RESOURCE_BOOKING_VIEW_ASSIGNED", "RESOURCE_BOOKING_APPROVE"])
        // the plain room keeps the approver fallback: an approver and no policy
        call("create#mantle.facility.FacilityParty", {
            facilityId: approvedRoom,
            partyId: state.APPROVER_PARTY,
            roleTypeId: "BookingApprover",
            fromDate: since
        })
        // the compressor is out of service (an actual outage, open)
        call("create#mantle.work.effort.ResourceUnavailability", {
            unavailabilityKindEnumId: "RukActual",
            assetId: compressor,
            organizationPartyId: orgA,
            fromDate: new Date(Date.now() - day),
            unavailabilityReasonEnumId: "RurEquipmentFault",
            plannedOutage: "N",
            description: "Bearing seized, spares on order",
            revision: 1
        })
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature("the managed room's policy: a holder of the edit permission sets it, another user cannot, and it reads back in words", {
    when() {
        const refused = as(state.supervisor, R + "store#ResourceBookingPolicy", {
            facilityId: managedRoom,
            approvalModeEnumId: "RbamAutomatic"
        })
        const stored = as(state.resources, R + "store#ResourceBookingPolicy", {
            facilityId: managedRoom,
            approvalModeEnumId: "RbamAutomatic",
            bookingHorizonDays: 30,
            maximumDurationMinutes: 120,
            softConflictOverride: "Y"
        })
        as(state.resources, R + "store#ResourceBookingPolicy", {
            assetId: projector,
            approvalModeEnumId: "RbamAutomatic",
            bookingHorizonDays: 30
        })
        const noReason = as(state.resources, R + "store#ResourceBookingPolicy", {
            facilityId: managedRoom,
            expectedRevision: 1,
            maximumDurationMinutes: 90
        })
        const read = as(state.resources, R + "get#ResourceBookingPolicy", {facilityId: managedRoom})
        const listed = as(state.resources, R + "find#BookableResources", {facilityId: building, managed: "Y"})
        const strangers = as(state.ann, R + "get#ResourceBookingPolicy", {facilityId: managedRoom})
        return {refused, stored, noReason, read, listed, strangers}
    },
    then({refused, stored, noReason, read, listed, strangers}) {
        code(refused) == "PERMISSION_DENIED"
        stored.error == ""
        stored.revision == 1
        code(noReason) == "REASON_REQUIRED"
        read.managed == true
        read.policy.maximumDurationMinutes == 120
        read.policyText.includes("at most 2 hours")
        listed.resourceList.map(row => row.facilityId || row.assetId) == [managedRoom, projector]
        code(strangers) == "PERMISSION_DENIED"
    }
})

feature("adjacent bookings of the managed room are accepted; one longer than two hours or past the horizon is refused", {
    when() {
        const first = event(state.ann, "Ann first", at(0), at(1))
        const next = event(state.bob, "Bob next", at(1), at(2))
        const long = event(state.ann, "Ann long", at(3), at(6))
        const far = event(state.ann, "Ann far ahead", at(0, 40), at(1, 40))
        const daily = event(state.ann, "Ann daily", at(4, 1), at(5, 1), "FREQ=DAILY")
        const threeDays = event(state.ann, "Ann three days", at(6, 1), at(7, 1), "FREQ=DAILY;COUNT=3")
        const standing = event(state.ann, "Ann standing", at(10, -600), at(10.5, -600), "FREQ=DAILY;COUNT=610")
        state.annFirst = first
        state.bobNext = next
        const threeDaysBooked = as(state.ann, E + "book#Resource", {workEffortId: threeDays, facilityId: managedRoom})
        // the booked series' rule made unbounded afterwards: checked again over its range and refused, the rule kept as it was
        const extended = as(state.ann, E + "store#EventRecurrence", {workEffortId: threeDays, rrule: "FREQ=DAILY"})
        const rule = ec.entity
            .find("mantle.work.effort.WorkEffortRecurrence")
            .condition("workEffortId", threeDays)
            .disableAuthz()
            .one()?.rrule
        // equipment named at an unbounded series' creation: the rule is stored first, so the whole range is checked
        const projectorSeries = as(state.ann, E + "create#Event", {
            workEffortName: "Ann projector daily",
            estimatedStartDate: at(8, 1),
            estimatedCompletionDate: at(9, 1),
            assetId: projector,
            rrule: "FREQ=DAILY"
        })
        return {
            projectorSeries,
            threeDays: threeDaysBooked,
            extended,
            rule,
            // a series begun long ago is decided from now: its past meetings do not count against the horizon
            standing: as(state.ann, E + "book#Resource", {workEffortId: standing, facilityId: managedRoom}),
            first: as(state.ann, E + "book#Resource", {workEffortId: first, facilityId: managedRoom}),
            next: as(state.bob, E + "book#Resource", {workEffortId: next, facilityId: managedRoom}),
            long: as(state.ann, E + "book#Resource", {workEffortId: long, facilityId: managedRoom}),
            far: as(state.ann, E + "book#Resource", {workEffortId: far, facilityId: managedRoom}),
            daily: as(state.ann, E + "book#Resource", {workEffortId: daily, facilityId: managedRoom})
        }
    },
    then({first, next, long, far, daily, threeDays, extended, rule, standing, projectorSeries}) {
        first.error == ""
        first.statusId == "WefAssigned"
        next.error == ""
        next.statusId == "WefAssigned"
        long.error.includes("at most 2 hours")
        far.error.includes("at most 30 days ahead")
        // an unbounded series runs past the horizon: the whole range is checked, not its first meeting
        daily.error.includes("at most 30 days ahead")
        threeDays.error == ""
        extended.error.includes("at most 30 days ahead")
        rule == "FREQ=DAILY;COUNT=3"
        standing.error == ""
        projectorSeries.error.includes("at most 30 days ahead")
    }
})

feature("a hidden event is Busy with no title; allowConflicts alone books nothing over it, the override with a reason does", {
    when() {
        const clash = event(state.bob, "Bob clash", at(0.5), at(1.5))
        const bare = as(state.bob, E + "book#Resource", {workEffortId: clash, facilityId: managedRoom})
        const allowed = as(state.bob, E + "book#Resource", {workEffortId: clash, facilityId: managedRoom, allowConflicts: true})
        const overrideClash = event(state.overrider, "Override clash", at(0.5), at(1.5))
        const noReason = as(state.overrider, E + "book#Resource", {
            workEffortId: overrideClash,
            facilityId: managedRoom,
            allowConflicts: true
        })
        const overridden = as(state.overrider, E + "book#Resource", {
            workEffortId: overrideClash,
            facilityId: managedRoom,
            allowConflicts: true,
            overrideReason: "Board visit"
        })
        const availability = as(state.bob, R + "get#ResourceAvailability", {
            facilityId: managedRoom,
            fromDate: at(0),
            thruDate: at(2)
        })
        // the managed room's calendar read: Ann's event is Busy to Bob, with no organizer
        const calendar = as(state.bob, E + "get#FullCalendarData", {
            facilityId: managedRoom,
            start: at(-24).toISOString().substring(0, 10),
            end: at(24).toISOString().substring(0, 10)
        })
        const otherOrg = as(state.outsider, E + "book#Resource", {
            workEffortId: event(state.outsider, "Outsider clash", at(0.5), at(1.5)),
            facilityId: managedRoom,
            allowConflicts: true,
            overrideReason: "Not ours"
        })
        return {
            bare,
            allowed,
            noReason,
            overridden,
            availability,
            calendar,
            otherOrg,
            comments: facilityBooking(overrideClash, managedRoom)?.comments
        }
    },
    then({bare, allowed, noReason, overridden, availability, calendar, otherOrg, comments}) {
        // Ann's event is hidden from Bob: Busy, never its title; Bob's own is named
        bare.error.includes("is booked then: Busy")
        bare.error.includes("Bob next")
        !bare.error.includes("Ann first")
        allowed.error.includes("override")
        noReason.error.includes("a reason")
        overridden.error == ""
        overridden.statusId == "WefAssigned"
        comments.startsWith("Override: Board visit")
        availability.intervalList.map(row => row.label).includes("Busy")
        !availability.intervalList.map(row => row.label).includes("Ann first")
        availability.intervalList.filter(row => row.label == "Busy").every(row => row.workEffortId == null)
        calendar.error == ""
        !calendar.eventList.some(row => row.title.startsWith("Ann first"))
        calendar.eventList.some(row => row.title.startsWith("Bob next"))
        calendar.eventList.filter(row => row.title == "Busy").every(row => row.ownerName == null && row.freeBusyOnly)
        // the override permission is the room's organization's: another organization's holder overrides nothing
        otherOrg.error.includes("override")
    }
})

feature("a booking over an outage is refused with allowConflicts and says only that the compressor is out of service", {
    when() {
        const meeting = event(state.ann, "Ann compressor trial", at(2, 1), at(3, 1))
        const refused = as(state.ann, E + "book#Resource", {workEffortId: meeting, assetId: compressor, allowConflicts: true})
        const created = as(state.ann, E + "create#Event", {
            workEffortName: "Ann with the compressor",
            estimatedStartDate: at(4, 2),
            estimatedCompletionDate: at(5, 2),
            assetId: compressor
        })
        const freeBusy = as(state.ann, E + "get#FreeBusy", {assetIdList: [compressor], fromDate: at(0, 1), thruDate: at(0, 2)})
        return {refused, created, freeBusy}
    },
    then({refused, created, freeBusy}) {
        refused.error.includes("Spec compressor is out of service then")
        !refused.error.includes("Bearing")
        created.error.includes("out of service")
        freeBusy.freeBusyList[0].busyList.map(row => row.status).includes("down")
    }
})

feature(
    "approval required with no approver blocks; an approver added makes it requested, and ending them with it waiting needs another",
    {
        when() {
            const changed = as(state.resources, R + "store#ResourceBookingPolicy", {
                facilityId: managedRoom,
                approvalModeEnumId: "RbamApprovers",
                bookingHorizonDays: 30,
                maximumDurationMinutes: 120,
                softConflictOverride: "Y",
                expectedRevision: 1,
                changeReason: "Approval from now on"
            })
            const meeting = event(state.ann, "Ann needs approval", at(6), at(7))
            const blocked = as(state.ann, E + "book#Resource", {workEffortId: meeting, facilityId: managedRoom})
            const findings = as(state.resources, R + "get#ResourceBookingPolicy", {facilityId: managedRoom}).setupFindings
            const added = as(state.resources, R + "store#ResourceApprover", {
                facilityId: managedRoom,
                partyId: state.APPROVER_PARTY
            })
            const requested = as(state.ann, E + "book#Resource", {workEffortId: meeting, facilityId: managedRoom})
            const approverReads = as(state.approver, R + "get#ResourceBookingPolicy", {facilityId: managedRoom})
            const pending = as(state.resources, R + "store#ResourceApprover", {
                facilityId: managedRoom,
                partyId: state.APPROVER_PARTY,
                end: "Y"
            })
            const handedOver = as(state.resources, R + "store#ResourceApprover", {
                facilityId: managedRoom,
                partyId: state.APPROVER_PARTY,
                end: "Y",
                replacementPartyId: state.RESOURCES_PARTY
            })
            return {changed, blocked, findings, added, requested, approverReads, pending, handedOver}
        },
        then({changed, blocked, findings, added, requested, approverReads, pending, handedOver}) {
            changed.error == ""
            blocked.error.includes("has no approver")
            findings.length == 1
            added.added == true
            requested.statusId == "WefRequested"
            requested.requiresApproval == true
            approverReads.error == ""
            code(pending) == "APPROVER_PENDING"
            handedOver.ended == true
        }
    }
)

feature("an unmanaged room behaves as before: its approver's fallback, a conflict refused and allowConflicts booking it", {
    when() {
        const meeting = event(state.ann, "Ann plain", at(0), at(1))
        const clash = event(state.bob, "Bob plain", at(0.5), at(1.5))
        const waiting = event(state.ann, "Ann approved room", at(0), at(1))
        return {
            plain: as(state.ann, E + "book#Resource", {workEffortId: meeting, facilityId: plainRoom}),
            refused: as(state.bob, E + "book#Resource", {workEffortId: clash, facilityId: plainRoom}),
            allowed: as(state.bob, E + "book#Resource", {workEffortId: clash, facilityId: plainRoom, allowConflicts: true}),
            fallback: as(state.ann, E + "book#Resource", {workEffortId: waiting, facilityId: approvedRoom})
        }
    },
    then({plain, refused, allowed, fallback}) {
        plain.statusId == "WefAssigned"
        refused.error.includes("Plain room is booked then")
        allowed.error == ""
        allowed.conflictList.length == 1
        fallback.statusId == "WefRequested"
    }
})

feature("a blackout of the building flags the approved booking of its room, cancels nothing and refuses a booking under it", {
    when() {
        const notStaff = as(state.ann, R + "record#ResourceUnavailability", {
            facilityId: building,
            unavailabilityKindEnumId: "RukPlanned",
            fromDate: at(0),
            thruDate: at(2)
        })
        const noEnd = as(state.resources, R + "record#ResourceUnavailability", {
            facilityId: building,
            unavailabilityKindEnumId: "RukPlanned",
            fromDate: at(0)
        })
        const blackout = as(state.resources, R + "record#ResourceUnavailability", {
            facilityId: building,
            unavailabilityKindEnumId: "RukPlanned",
            unavailabilityReasonEnumId: "RurClosure",
            fromDate: at(0),
            thruDate: at(2),
            description: "Fire alarm testing"
        })
        const underIt = event(state.bob, "Bob under the blackout", at(1.5, 0), at(1.75, 0))
        const refused = as(state.bob, E + "book#Resource", {workEffortId: underIt, facilityId: plainRoom})
        const listed = as(state.resources, R + "find#ResourceUnavailability", {
            unavailabilityKindEnumId: "RukPlanned",
            facilityId: building
        })
        return {notStaff, noEnd, blackout, refused, listed, kept: facilityBooking(state.annFirst, managedRoom)}
    },
    then({notStaff, noEnd, blackout, refused, listed, kept}) {
        code(notStaff) == "PERMISSION_DENIED"
        code(noEnd) == "END_REQUIRED"
        blackout.error == ""
        blackout.affectedBookingIds.includes(state.annFirst)
        blackout.affectedBookingIds.includes(state.bobNext)
        kept.statusId == "WefAssigned"
        refused.error.includes("is not available then")
        !refused.error.includes("Fire alarm")
        listed.outageList.length == 1
        listed.outageList[0].stateText == "Planned"
        listed.outageList[0].affectedBookingCount >= 2
    }
})

feature(
    "Manufacturing's offline time is a planned block written by record#; a supervisor corrects it and the withdraw ends the row in force",
    {
        when() {
            const applied = as(state.scheduler, L + "store#WorkCenterOffline", {
                action: "apply",
                facilityId: line,
                fromDate: at(0, 2),
                thruDate: at(4, 2),
                reason: "Retooling",
                operationKey: key()
            })
            const blockId = applied.result?.resourceUnavailabilityId
            const row = ec.entity
                .find("mantle.work.effort.ResourceUnavailability")
                .condition("resourceUnavailabilityId", blockId)
                .disableAuthz()
                .one()
            const corrected = as(state.supervisor, R + "correct#ResourceUnavailability", {
                resourceUnavailabilityId: blockId,
                expectedRevision: 1,
                thruDate: at(6, 2),
                changeReason: "The tooling arrives late"
            })
            const withdrawn = as(state.scheduler, L + "store#WorkCenterOffline", {
                action: "withdraw",
                facilityId: line,
                resourceUnavailabilityId: blockId,
                operationKey: key()
            })
            const inForce = ec.entity
                .find("mantle.work.effort.ResourceUnavailability")
                .condition("resourceUnavailabilityId", corrected.resourceUnavailabilityId)
                .disableAuthz()
                .one()
            // a blackout of the plant is the line's offline time too (ProductionCalendar's offline read, the plant above the center)
            const plantBlackout = as(state.resources, R + "record#ResourceUnavailability", {
                facilityId: plant,
                unavailabilityKindEnumId: "RukPlanned",
                fromDate: at(0, 4),
                thruDate: at(3, 4)
            })
            const time = ec.resource.script("component://mr-mantle/service/mantle/work/ProductionCalendar.js")
            const ctx = time.forCall()
            const offline = Array.from(
                time.offlineOf(ctx, time.centerOf(ctx, line), base + 4 * day - hour, base + 4 * day + 4 * hour)
            )
            return {applied, row, corrected, withdrawn, inForce, plantBlackout, offline}
        },
        then({applied, row, corrected, withdrawn, inForce, plantBlackout, offline}) {
            plantBlackout.error == ""
            offline.some(block => block.sourceId == plantBlackout.resourceUnavailabilityId && block.kind == "planned")
            applied.error == ""
            row.unavailabilityKindEnumId == "RukPlanned"
            row.unavailabilityReasonEnumId == "RurOffline"
            row.revision == 1
            corrected.error == ""
            corrected.correctedUnavailabilityId == row.resourceUnavailabilityId
            withdrawn.error == ""
            withdrawn.result.resourceUnavailabilityId == corrected.resourceUnavailabilityId
            ms(inForce.thruDate) == ms(inForce.fromDate)
        }
    }
)
