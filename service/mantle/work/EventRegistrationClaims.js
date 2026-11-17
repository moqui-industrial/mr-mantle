// A verified account's claim of its public reservations (SEC-PSS-61; the owner's call of Nov 16, 2026). CC0 1.0 Universal plus
// Grant of Patent License.
//
// A public reservation names nobody by an address typed on the page: its buyer and each attendee typed with an address are new
// people (MarketingPortal.js buyerOf, EventRegistrationPlaces.js personOf). Once a signed-in account's own verified address
// (ExternalAccess selfOf: its current email verified, its own party outside the organization) is the reservation's typed buyer
// address or an attendee's typed address, that person is claimed: merged into the account's party (merge#Parties as the system,
// with claimRegistration, so its live registrations move with it while the event is still to come), as Shop claims a verified
// account's guest purchases (ShopCustomer.js claimGuestPurchases). The merge moves the reservation, the places, the ticket order,
// its payment and invoices and the answers, and marks the person merged (mergedToPartyId). A claimed buyer's capabilities (the
// page's token and every link mailed) name the reservation's buyer party, which ExternalAccess.check compares with the record's,
// so they are re-pointed to the account's party in the merge's transaction: the links already sent keep working.
//
// Nothing is claimed for an account without a verified address, an address that is not the one typed, a reservation already the
// account's (or another account's: that person is not a reservation's alone), or one with no live place (cancelled or expired).
// A person with anything else (an account, a relationship, a role but a customer's, another reservation, registration or order,
// a contact grant) is never merged. Each claim runs in a transaction of its own; a failure is logged and the page goes on.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows} = lib
const access = () => ec.resource.script("component://mr-mantle/service/mantle/party/ExternalAccess.js")

const RESERVATION = "mantle.work.registration.EventReservation"
const REGISTRATION = "mantle.work.registration.EventRegistration"
const CAPABILITY = "mantle.party.ExternalAccessCapability"
const LIVE_STATES = ["EvrHeld", "EvrPending", "EvrConfirmed", "EvrWaitlisted", "EvrReview"]
const lower = value =>
    String(value || "")
        .trim()
        .toLowerCase()

// The signed-in account's own party and verified address, or null.
function accountParty() {
    const account = ec.user.userAccount
    const address = lower(account?.emailAddress)
    if (!account?.partyId || !address || !access().selfOf(account.partyId)) return null
    return {partyId: account.partyId, address}
}
const addressOfMech = contactMechId =>
    contactMechId ? lower(one("mantle.party.contact.ContactMech", {contactMechId})?.infoString) : ""
// A party's current email addresses.
const addressesOf = partyId =>
    rows("mantle.party.contact.PartyContactMechInfo", {partyId, contactMechTypeEnumId: "CmtEmailAddress"})
        .filter(row => lib.active(row))
        .map(row => lower(row.infoString))

// Whether a party is still only what the reservation made: a person of no organization, with no account, relationship, contact
// grant or role but a customer's, and no reservation, place or order but this reservation's.
function reservationOnly(partyId, reservation) {
    const party = one("mantle.party.Party", {partyId})
    if (!party || party.partyTypeEnumId !== "PtyPerson" || party.disabled === "Y" || party.mergedToPartyId) return false
    if (party.privateOwnerUserId || (party.ownerPartyId && party.ownerPartyId !== "_NA_")) return false
    if (find("moqui.security.UserAccount", {partyId}).count() > 0) return false
    if (find("mantle.party.PartyRelationship", {fromPartyId: partyId}).count() > 0) return false
    if (find("mantle.party.PartyRelationship", {toPartyId: partyId}).count() > 0) return false
    if (find("mantle.party.ExternalAccessContact", {partyId}).count() > 0) return false
    if (find("mantle.party.ExternalAccessContact", {outsidePartyId: partyId}).count() > 0) return false
    if (rows("mantle.party.PartyRole", {partyId}).some(row => !/^Customer/.test(row.roleTypeId))) return false
    const own = row => row.reservationId === reservation.reservationId
    if (!rows(RESERVATION, {buyerPartyId: partyId}).every(own)) return false
    if (!rows(REGISTRATION, {buyerPartyId: partyId}).every(own)) return false
    if (!rows(REGISTRATION, {attendeePartyId: partyId}).every(own)) return false
    if (find("mantle.order.OrderPart", {vendorPartyId: partyId}).count() > 0) return false
    return rows("mantle.order.OrderPart", {customerPartyId: partyId}).every(part => part.orderId === reservation.orderId)
}

// The people of a reservation the signed-in verified account may claim: the buyer when the typed buyer address is the account's,
// and each live place's attendee typed with the account's address. [{partyId, buyer}]
function claimable(reservation, own) {
    const live = rows(REGISTRATION, {reservationId: reservation.reservationId}).filter(row => LIVE_STATES.includes(row.statusId))
    if (!live.length) return []
    const found = []
    if (reservation.buyerPartyId !== own.partyId && addressOfMech(reservation.emailContactMechId) === own.address)
        found.push({partyId: reservation.buyerPartyId, buyer: true})
    for (const row of live) {
        const partyId = row.attendeePartyId
        if (!partyId || partyId === own.partyId || found.some(item => item.partyId === partyId)) continue
        if (partyId === reservation.buyerPartyId) continue
        if (addressesOf(partyId).includes(own.address)) found.push({partyId, buyer: false})
    }
    return found.filter(item => reservationOnly(item.partyId, reservation))
}

// claim: the reservation's people the signed-in verified account claims, each merged into its party with a claimed buyer's
// capabilities re-pointed, in a transaction of its own. {claimed}.
function claim(reservationId) {
    const own = accountParty()
    const reservation = own && reservationId ? one(RESERVATION, {reservationId}) : null
    if (!reservation) return {claimed: 0}
    let claimed = 0
    for (const item of claimable(reservation, own)) {
        ec.message.pushErrors()
        try {
            ec.transaction.runRequireNew(null, "Error claiming a registration", () => {
                ec.service
                    .sync()
                    .name("mantle.party.DuplicateServices.merge#Parties")
                    .parameters({toPartyId: own.partyId, fromPartyId: item.partyId, claimRegistration: true})
                    .disableAuthz()
                    .call()
                if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
                const merged = one("mantle.party.Party", {partyId: item.partyId})
                if (merged?.mergedToPartyId !== own.partyId) throw new Error("Party " + item.partyId + " was not merged")
                if (item.buyer)
                    for (const capability of rows(CAPABILITY, {
                        recordType: "EventRegistration",
                        recordId: reservation.reservationId,
                        partyId: item.partyId
                    }))
                        lib.call("update#" + CAPABILITY, {capabilityId: capability.capabilityId, partyId: own.partyId})
            })
            claimed++
        } catch (error) {
            ec.logger.error(
                "Registration " +
                    reservation.reservationId +
                    " of party " +
                    item.partyId +
                    " not claimed: " +
                    String(error?.message || error).split("\n")[0]
            )
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    return {claimed}
}
;({claim, claimable, reservationOnly})
