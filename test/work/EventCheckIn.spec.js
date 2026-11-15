// Event check-in (impl-marketing P18; design-marketing §9 CheckIn, RegistrationDetail's Attendance; mantle.work.EventRegistrationServices
// preview#CheckIn, checkIn#Registration, resolve#EntryCode and get#Attendance over EventCheckIn.js): an entry code checks a confirmed
// place in once, a second scan answering the first; a cancelled, pending, waitlisted, wrong-event or closed-door ticket is refused with
// its reason, and a substituted attendee's old code names no one; staff find an attendee by name and check them in with a reason, and
// override a pending place with a reason that changes neither its state nor its payment, never a waitlisted one; a reader and another
// organization's events manager are refused; at a door tablet (a registered device fixed to the offer, its display account holding
// MARKETING_CHECKIN in the organization) a code checks in and the attendee shows as a first name and initial, a lookup by name is
// refused and another occurrence is unavailable, even with an events manager's permissions given to its display account;
// MARKETING_CHECKIN outside a device is refused. Standalone: spec-local organizations, users, people, events, offers and registrations,
// a display account, a route group admitting the spec's own screen (EventCheckInSpecScreen.xml) and a device registered and redeemed
// for it. Artifact authorization is off: the rules are the services'.
// Run: ./moq test mr-mantle --spec EventCheckIn
const lib = ec.resource.script("component://mr-mantle/test/marketing/MarketingSpecLib.js")
const {make, row, rows, system, organization, user, as, run} = lib
const E = "mantle.work.EventRegistrationServices."
const R = "mantle.work.registration.EventRegistration"
const ATTENDANCE = "mantle.work.registration.EventAttendance"
const screen = "component://mr-mantle/test/work/EventCheckInSpecScreen.xml"
const prefix = "MKCI"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const users = {}
const ids = {}
const codes = {}
const state = {}
const hourMs = 3600000
const code = out => (/([A-Z][A-Z0-9_]{3,}):/.exec(out.refusal || out.error || "") || [])[1] || ""
let keys = 0
const key = () => prefix + "k" + ++keys

// an event of A with one offer for an occurrence starting at startMs: {workEffortId, registrationPolicyId, ticketTypeId}
function offer(name, startMs) {
    const workEffortId = prefix + "_EV_" + name
    make("mantle.work.effort.WorkEffort", {
        workEffortId,
        workEffortTypeEnumId: "WetEvent",
        workEffortName: "Check-in event " + name,
        statusId: "WeInPlanning",
        estimatedStartDate: new Date(startMs),
        estimatedCompletionDate: new Date(startMs + 2 * hourMs)
    })
    make("mantle.work.registration.RegistrationEvent", {workEffortId, organizationPartyId: orgA, createdDate: new Date()})
    const registrationPolicyId = prefix + "_OFFER_" + name
    make("mantle.work.registration.EventRegistrationPolicy", {
        registrationPolicyId,
        workEffortId,
        occurrenceStart: new Date(startMs),
        occurrenceEnd: new Date(startMs + 2 * hourMs),
        organizationPartyId: orgA,
        statusId: "ErpPublished",
        publicTitle: "Check-in offer " + name,
        timeZone: "UTC",
        totalSeats: 20,
        holdMinutes: 15,
        policyRevision: 1,
        termsRevision: 0,
        publishedDate: new Date()
    })
    make("mantle.work.registration.EventTicketType", {
        ticketTypeId: registrationPolicyId + "_T",
        registrationPolicyId,
        ticketName: "Standard",
        priceSourceEnumId: "EtpFree",
        sequenceNum: 1,
        fromDate: new Date(Date.now() - 86400000)
    })
    return {workEffortId, registrationPolicyId, ticketTypeId: registrationPolicyId + "_T"}
}
// a confirmed place of an attendee on an offer with an entry code (the code kept for the spec), then moved to statusId when given
function place(name, of, statusId = null) {
    const partyId = prefix + "_P_" + name.toUpperCase()
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    make("mantle.party.Person", {partyId, firstName: name, lastName: "Doorspec"})
    const registrationId = prefix + "_R_" + name.toUpperCase()
    make(R, {
        registrationId,
        registrationPolicyId: of.registrationPolicyId,
        ticketTypeId: of.ticketTypeId,
        attendeePartyId: partyId,
        buyerPartyId: partyId,
        statusId: "EvrConfirmed",
        confirmedDate: new Date(),
        createdDate: new Date()
    })
    const places = ec.resource.script("component://mr-mantle/service/mantle/work/EventRegistrationPlaces.js")
    codes[name] = ec.transaction.runRequireNew(null, "Spec entry code", () => places.issueCode(registrationId)).code
    // the state set straight (no transition from confirmed leads there), the code kept, so the door sees why it is refused
    if (statusId) ec.entity.find(R).condition("registrationId", registrationId).disableAuthz().updateAll({statusId})
    ids[name] = registrationId
    return registrationId
}
// the door tablet's display group given an events manager's permissions while fn runs (a misassigned bundle), then taken back
function promoted(fn) {
    const grant = ["MARKETING_VIEW", "MARKETING_EVENT_MANAGE"]
    system(() =>
        grant.forEach(userPermissionId =>
            make("moqui.security.UserGroupPermission", {userGroupId: state.display, userPermissionId, fromDate: 0})
        )
    )
    try {
        return fn()
    } finally {
        system(() =>
            ec.entity
                .find("moqui.security.UserGroupPermission")
                .condition("userGroupId", state.display)
                .condition("userPermissionId", "in", grant)
                .deleteAll()
        )
    }
}
const attendances = registrationId => rows(ATTENDANCE, {registrationId})
const actions = registrationId =>
    rows("mantle.work.registration.EventRegistrationAction", {registrationId, actionEnumId: "EraCheckedIn"}).length
// a call at the door tablet: its request, with its cookie, to the spec's screen the route group admits
function atDoor(op, parameters = {}) {
    const rendered = ec.screen
        .makeTest()
        .rootScreen(screen)
        .header("cookie", "moqui.device=" + state.cookie)
        .render("call", Object.assign({op}, parameters), "post")
    ec.message.clearErrors()
    const answer = JSON.parse(String(rendered.output || "{}"))
    return Object.assign({}, answer.out, {error: answer.error || "", userId: answer.userId})
}

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Check-in A")
            organization(orgB, "Check-in B")
            users.manager = user(prefix, "manager", [orgA], ["MARKETING_VIEW", "MARKETING_EVENT_MANAGE"])
            users.reader = user(prefix, "reader", [orgA], ["MARKETING_VIEW"])
            users.managerB = user(prefix, "managerB", [orgB], ["MARKETING_VIEW", "MARKETING_EVENT_MANAGE"])
            users.checkin = user(prefix, "checkin", [orgA], ["MARKETING_CHECKIN"])
            const now = Date.now()
            ids.door = offer("DOOR", now - hourMs)
            ids.other = offer("OTHER", now - hourMs / 2)
            ids.later = offer("LATER", now + 5 * 24 * hourMs)
            place("Ana", ids.door)
            place("Ben", ids.door, "EvrCancelled")
            place("Cleo", ids.door, "EvrPending")
            place("Dee", ids.door, "EvrWaitlisted")
            place("Eve", ids.other)
            place("Finn", ids.door)
            place("Gus", ids.door)
            place("Hal", ids.later)
            place("Ivy", ids.door)
            // the door tablet's display account: a member of A, in a registered bundle holding MARKETING_CHECKIN alone
            state.displayParty = prefix + "_DISPLAY"
            make("mantle.party.Party", {partyId: state.displayParty, partyTypeEnumId: "PtyPerson"})
            make("mantle.party.Person", {partyId: state.displayParty, firstName: "Door", lastName: "Tablet"})
            make("mantle.party.PartyRelationship", {
                relationshipTypeEnumId: "PrtMember",
                fromPartyId: state.displayParty,
                toPartyId: orgA,
                toRoleTypeId: "OrgInternal",
                fromDate: 0
            })
            state.display = prefix + "_DISPLAY"
            make("moqui.security.UserGroup", {userGroupId: state.display, description: "Check-in spec door"})
            make("moqui.security.UserGroupPermission", {
                userGroupId: state.display,
                userPermissionId: "MARKETING_CHECKIN",
                fromDate: 0
            })
            make("moqui.security.CapabilityBundle", {
                userGroupId: state.display,
                appName: "Marketing",
                description: "Check-in spec door"
            })
            make("moqui.security.UserAccount", {
                userId: state.display,
                username: "checkin.spec.display",
                userFullName: "Check-in spec door",
                partyId: state.displayParty,
                displayAccount: "Y"
            })
            make("moqui.security.UserGroupMember", {userId: state.display, userGroupId: state.display, fromDate: 0})
            // its route group: the spec's screen and its call transition, the offer the fixed parameter
            make("moqui.security.ArtifactGroup", {artifactGroupId: prefix, description: "Check-in spec door"})
            make("moqui.security.ArtifactGroupMember", {
                artifactGroupId: prefix,
                artifactTypeEnumId: "AT_XML_SCREEN",
                artifactName: screen,
                inheritAuthz: "N",
                nameIsPattern: "N"
            })
            make("moqui.security.ArtifactGroupMember", {
                artifactGroupId: prefix,
                artifactTypeEnumId: "AT_XML_SCREEN_TRANS",
                artifactName: screen + "/call",
                inheritAuthz: "N",
                nameIsPattern: "N"
            })
            make("moqui.security.DeviceRouteGroup", {
                routeGroupId: prefix,
                description: "Check-in spec doors",
                artifactGroupId: prefix,
                homePath: "/apps/AppList",
                parameterName: "registrationPolicyId",
                parameterRequired: "Y"
            })
        })
        const registered = system(() =>
            ec.service
                .sync()
                .name("org.moqui.admin.DeviceServices.register#Device")
                .parameters({
                    deviceName: "Check-in spec door",
                    routeGroupId: prefix,
                    displayUserId: state.display,
                    parameterValue: ids.door.registrationPolicyId
                })
                .call()
        )
        ec.message.clearErrors()
        state.deviceId = registered?.deviceId
        const redeemed = ec.screen
            .makeTest()
            .rootScreen("component://webroot/screen/webroot.xml")
            .render("Device/redeem", {code: registered?.registrationCode}, "post")
        state.cookie = String(redeemed.header("Set-Cookie") || "")
            .split(";")[0]
            .replace("moqui.device=", "")
        login(lib.OPERATOR)
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login(lib.OPERATOR)
        system(() => {
            ec.entity.find("moqui.security.DeviceCredential").condition("displayUserId", state.display).deleteAll()
            ec.entity.find("moqui.security.DeviceRouteGroup").condition("routeGroupId", prefix).deleteAll()
        })
    }
})

feature("an entry code checks a confirmed place in once and a second scan answers the first; refused tickets name their reason", {
    when() {
        const door = ids.door.registrationPolicyId
        const ask = entryCode => as(users.manager, E + "preview#CheckIn", {registrationPolicyId: door, entryCode})
        const enter = (entryCode, operationKey = key()) =>
            as(users.manager, E + "checkIn#Registration", {registrationPolicyId: door, entryCode, operationKey})
        const previewed = ask(codes.Ana)
        const first = enter(codes.Ana)
        const again = enter(codes.Ana)
        const resolvedAgain = as(users.manager, E + "resolve#EntryCode", {registrationPolicyId: door, scanText: codes.Ana})
        // a substitution revokes the old attendee's code
        const corrected = as(users.manager, E + "correct#Registration", {
            registrationId: ids.Gus,
            expectedRevision: row(R, {registrationId: ids.Gus}).lastUpdatedStamp,
            attendeeName: "Gus Newcomer",
            reason: "Gus sent a colleague"
        })
        return {
            previewed,
            first,
            again,
            resolvedAgain,
            corrected,
            anaAttendances: attendances(ids.Ana),
            anaActions: actions(ids.Ana),
            cancelled: enter(codes.Ben),
            pending: enter(codes.Cleo),
            waitlisted: enter(codes.Dee),
            wrongEvent: enter(codes.Eve),
            closed: as(users.manager, E + "checkIn#Registration", {
                registrationPolicyId: ids.later.registrationPolicyId,
                entryCode: codes.Hal
            }),
            unknown: enter("EVNOSUCHCODE0000000000000"),
            substituted: enter(codes.Gus),
            refusedPreview: ask(codes.Ben),
            resolvedCancelled: as(users.manager, E + "resolve#EntryCode", {registrationPolicyId: door, scanText: codes.Ben}),
            noneWritten: [ids.Ben, ids.Cleo, ids.Dee, ids.Eve, ids.Hal, ids.Gus].every(id => attendances(id).length === 0)
        }
    },
    then(r) {
        r.previewed.refusal == "" && r.previewed.decision.eligible && r.previewed.decision.attendeeText == "Ana Doorspec"
        r.previewed.desk.openNow && r.previewed.desk.checkedInCount == 0 && r.previewed.desk.expectedCount == 4
        r.first.refusal == "" && r.first.checkedIn && !r.first.repeated
        r.again.refusal == "" && r.again.repeated && r.again.decision.reasonCode == "ALREADY_CHECKED_IN"
        r.resolvedAgain.refusal == "" && r.resolvedAgain.matches[0].detail.startsWith("Already checked in")
        r.anaAttendances.length == 1 && r.anaAttendances[0].methodEnumId == "EamCode" && r.anaActions == 1
        r.anaAttendances[0].credentialRevision == 1 && r.anaAttendances[0].checkInByUserId == users.manager
        code(r.cancelled) == "CANCELLED"
        code(r.pending) == "PENDING"
        code(r.waitlisted) == "WAITLISTED"
        code(r.wrongEvent) == "WRONG_EVENT"
        code(r.closed) == "CHECK_IN_CLOSED"
        code(r.unknown) == "CODE_UNKNOWN"
        r.corrected.refusal == "" && r.corrected.substituted && code(r.substituted) == "CODE_UNKNOWN"
        r.refusedPreview.refusal == "" &&
            !r.refusedPreview.decision.eligible &&
            r.refusedPreview.decision.reasonCode == "CANCELLED"
        code(r.resolvedCancelled) == "CANCELLED"
        r.noneWritten
    }
})

feature("staff find an attendee by name and check them in with a reason; an override of a pending place keeps its state", {
    when() {
        const door = ids.door.registrationPolicyId
        const found = as(users.manager, E + "preview#CheckIn", {registrationPolicyId: door, term: "ivy"})
        const ivy = found.candidates?.find(candidate => candidate.registrationId == ids.Ivy)
        const enter = parameters =>
            as(
                users.manager,
                E + "checkIn#Registration",
                Object.assign({registrationPolicyId: door, operationKey: key()}, parameters)
            )
        const noReason = enter({registrationId: ids.Ivy})
        const byName = enter({registrationId: ids.Ivy, reason: "Forgot her phone", expectedRevision: ivy?.expectedRevision})
        const pendingPlain = enter({registrationId: ids.Cleo, reason: "At the door"})
        const pendingOverride = enter({registrationId: ids.Cleo, reason: "Paid; the organizer confirms later", override: true})
        const waitlistedOverride = enter({registrationId: ids.Dee, reason: "Asked nicely", override: true})
        const attendance = as(users.manager, E + "get#Attendance", {registrationId: ids.Cleo})
        return {
            found,
            ivy,
            noReason,
            byName,
            pendingPlain,
            pendingOverride,
            waitlistedOverride,
            attendance,
            ivyAttendance: attendances(ids.Ivy)[0],
            cleo: row(R, {registrationId: ids.Cleo}),
            reader: as(users.reader, E + "preview#CheckIn", {registrationPolicyId: door, entryCode: codes.Finn}),
            other: as(users.managerB, E + "checkIn#Registration", {registrationPolicyId: door, entryCode: codes.Finn}),
            outside: as(users.checkin, E + "checkIn#Registration", {registrationPolicyId: door, entryCode: codes.Finn}),
            finnUntouched: attendances(ids.Finn).length == 0
        }
    },
    then(r) {
        r.found.refusal == "" && !!r.ivy && r.ivy.eligible && r.ivy.attendeeText == "Ivy Doorspec"
        r.found.candidates.length == 1
        code(r.noReason) == "REASON_REQUIRED"
        r.byName.refusal == "" && r.byName.checkedIn && r.ivyAttendance.methodEnumId == "EamLookup"
        r.ivyAttendance.reason == "Forgot her phone" && r.ivyAttendance.credentialRevision == null
        code(r.pendingPlain) == "PENDING"
        r.pendingOverride.refusal == "" && r.pendingOverride.checkedIn
        r.attendance.attended && r.attendance.attendance.methodEnumId == "EamOverride"
        r.attendance.attendance.reason == "Paid; the organizer confirms later"
        r.cleo.statusId == "EvrPending" && r.cleo.paymentId == null
        code(r.waitlistedOverride) == "WAITLISTED"
        code(r.reader) == "PERMISSION_DENIED"
        code(r.other) == "RECORD_UNAVAILABLE"
        code(r.outside) == "DEVICE_REQUIRED"
        r.finnUntouched
    }
})

feature("at the door tablet a code checks in with the attendee as a first name and initial; no lookup, no other occurrence", {
    when() {
        const resolved = atDoor("resolve", {entryCode: codes.Finn})
        const entered = atDoor("checkIn", {entryCode: codes.Finn, operationKey: key()})
        const repeat = atDoor("checkIn", {entryCode: codes.Finn, operationKey: key()})
        return {
            resolved,
            entered,
            repeat,
            lookup: atDoor("preview", {term: "ivy"}),
            byId: atDoor("checkIn", {registrationId: ids.Ivy, reason: "Tablet"}),
            otherOccurrence: atDoor("checkIn", {askOffer: ids.other.registrationPolicyId, entryCode: codes.Eve}),
            wrongEvent: atDoor("checkIn", {entryCode: codes.Eve}),
            finn: attendances(ids.Finn),
            // a display account wrongly given an events manager's permissions is still the tablet at its device
            promoted: promoted(() => ({
                lookup: atDoor("preview", {term: "ivy"}),
                byId: atDoor("checkIn", {registrationId: ids.Ivy, reason: "Tablet"}),
                pending: atDoor("checkIn", {registrationId: ids.Cleo, reason: "Tablet", override: true}),
                resolved: atDoor("resolve", {entryCode: codes.Finn})
            }))
        }
    },
    then(r) {
        r.resolved.error == "" && r.resolved.userId == state.display
        r.resolved.matches[0].label == "Finn D. · Standard" && r.resolved.matches[0].id == codes.Finn
        r.entered.error == "" && r.entered.checkedIn && !r.entered.repeated
        r.entered.decision.attendeeText == "Finn D." && r.entered.decision.stateText == null
        r.repeat.error == "" && r.repeat.repeated && r.repeat.decision.attendance.byText == null
        r.finn.length == 1 && r.finn[0].deviceId == state.deviceId && r.finn[0].checkInByUserId == state.display
        code(r.lookup) == "PERMISSION_DENIED"
        code(r.byId) == "PERMISSION_DENIED"
        code(r.otherOccurrence) == "RECORD_UNAVAILABLE"
        code(r.wrongEvent) == "WRONG_EVENT"
        code(r.promoted.lookup) == "PERMISSION_DENIED" && code(r.promoted.byId) == "PERMISSION_DENIED"
        code(r.promoted.pending) == "PERMISSION_DENIED"
        r.promoted.resolved.error == "" && r.promoted.resolved.matches[0].label.startsWith("Finn D.")
    }
})
