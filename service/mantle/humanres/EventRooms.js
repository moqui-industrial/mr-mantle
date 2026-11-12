// The meeting room of an event People keeps (a training session, Training.js; an interview, Recruiting.js): IronStone People
// follow-up 3 (impl-people, the user's call of Nov 12, 2026; impl-maintenance F356). The room is a booking of Maintenance's
// resource booking (mantle.work.EventServices book#Resource, check#ResourceBookings, cancel#ResourceBooking: a WorkEffortFacility
// row), so the room's policy, its other bookings and its blackouts and outages apply, its approvers decide a booking that waits,
// and the room's calendar shows it. A free-text place stays for a place that is no bookable room (off site).
//
// The event is an application's (the EventManager rows PeopleTrainingSession and PeopleInterview), so no user changes it or its
// bookings on Commons' screens; the owning module checks its caller first and then books, moves and cancels the room here as the
// system (runAsSystem: no user, authorization off), which the booking services admit for any event. As the system the booking
// services name an event the user may not see Busy (ResourcePolicy.js eventVisibility answers no event visible with no user), so a
// clash says when, not whose. A refusal (a clash, a blackout or outage, the policy's maximum or horizon, a room no longer bookable)
// is ROOM_UNAVAILABLE with the booking service's words, and the caller's change is rolled back with it.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, denied, ms} = lib

const ROOM = "mantle.facility.Facility"
const BOOKING = "mantle.work.effort.WorkEffortFacility"
const EVENTS = "mantle.work.EventServices."
const DENIED = "WefRequestDenied"
const statuses = {
    WefAssigned: {roomStatus: "booked", roomStatusText: "Room booked"},
    WefRequested: {roomStatus: "requested", roomStatusText: "Room waiting for its approver"},
    [DENIED]: {roomStatus: "refused", roomStatusText: "Room refused: choose another"}
}
const text = value => String(value ?? "").trim()

// A bookable meeting room (a Facility of type FcTpRoom, bookable, not closed), {facilityId, roomName}; ROOM_UNAVAILABLE otherwise.
function roomOf(facilityId) {
    const id = text(facilityId)
    const room = id ? one(ROOM, {facilityId: id}) : null
    const closed = room?.closedDate != null && (ms(room.closedDate) ?? Infinity) <= ms(ec.user.nowTimestamp)
    if (!room || room.facilityTypeEnumId !== "FcTpRoom" || room.bookable !== "Y" || closed)
        denied("ROOM_UNAVAILABLE", "Room " + id + " is not a bookable meeting room")
    return {facilityId: id, roomName: room.facilityName || id}
}

// A booking service called as the system, for the event its caller checked; a refusal is ROOM_UNAVAILABLE with its words.
function asSystem(name, parameters) {
    let problem = null
    let out = {}
    ec.message.pushErrors()
    try {
        out =
            ec.artifactExecution.runAsSystem(() =>
                ec.service
                    .sync()
                    .name(EVENTS + name)
                    .parameters(parameters)
                    .call()
            ) || {}
        if (ec.message.hasError()) problem = ec.message.getErrorsString()
    } catch (error) {
        problem = String(error.message || error)
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
    if (problem) denied("ROOM_UNAVAILABLE", problem)
    return out
}

// The room of the event from now on: facilityId (null for none) at the event's stored time. A room no longer chosen is cancelled;
// the room kept is checked again at the new time when the event moved (its clashes and blocks refuse the move, an approval asked
// again where its policy says); a new room, or one refused before that is chosen again for a new time, is booked (at once, or
// waiting for its approvers).
function place(workEffortId, facilityId, moved) {
    const current = rows(BOOKING, {workEffortId})
    const wanted = text(facilityId) || null
    for (const row of current)
        if (row.facilityId !== wanted) asSystem("cancel#ResourceBooking", {workEffortId, facilityId: row.facilityId})
    const kept = wanted ? current.find(row => row.facilityId === wanted) || null : null
    if (kept && kept.statusId !== DENIED) {
        if (moved) asSystem("check#ResourceBookings", {workEffortId})
    } else if (wanted && (!kept || moved)) asSystem("book#Resource", {workEffortId, facilityId: roomOf(wanted).facilityId})
}

// Every room booking of the event cancelled with it (its approvers' notices withdrawn).
function cancelAll(workEffortId) {
    for (const row of rows(BOOKING, {workEffortId}))
        asSystem("cancel#ResourceBooking", {workEffortId, facilityId: row.facilityId})
}

// The room of each event: {workEffortId: {facilityId, roomName, roomStatus (booked, requested, refused), roomStatusText}}.
function roomsOf(workEffortIds) {
    const found = {}
    const ids = Array.from(new Set(workEffortIds.filter(Boolean)))
    if (!ids.length) return found
    const bookings = Array.from(find(BOOKING).condition("workEffortId", "in", ids).list())
    if (!bookings.length) return found
    const names = new Map(
        Array.from(
            find(ROOM)
                .condition("facilityId", "in", Array.from(new Set(bookings.map(row => row.facilityId))))
                .selectField("facilityId,facilityName")
                .list()
        ).map(row => [row.facilityId, row.facilityName || row.facilityId])
    )
    // a refused room is shown only while no other room is booked
    for (const row of bookings.sort((a, b) => (a.statusId === DENIED ? 1 : 0) - (b.statusId === DENIED ? 1 : 0)))
        if (!found[row.workEffortId])
            found[row.workEffortId] = Object.assign(
                {facilityId: row.facilityId, roomName: names.get(row.facilityId) || row.facilityId},
                statuses[row.statusId] || {roomStatus: "booked", roomStatusText: "Room booked"}
            )
    return found
}

;({roomOf, place, cancelAll, roomsOf})
