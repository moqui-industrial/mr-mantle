// mantle.party.ContactBookServices.find#ContactPeople: the contacts hook of MR Moqui chat's people (the framework's
// org.moqui.chat.ChatPeopleServices.find#ContactPeople, the STRT_CHAT_CONTACT_SERVICE theme value IronStone sets): of the
// contacts a user can see (filter#VisibleContacts, the rules of filter#ContactAddresses), those with a number (in E.164,
// however it is stored), a mail address (any case) or a user account asked about, each with its own addresses. Never
// another user's personal contact. New spec, no Groovy original.
const effectiveTime = Date.now()
const dayMillis = 86400000
const SERVICE = "mantle.party.ContactBookServices.find#ContactPeople"
const users = {}
const parties = {}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.user.setEffectiveTime(effectiveTime)
    },
    setup() { ec.artifactExecution.disableAuthz() },
    cleanup() {
        ec.artifactExecution.enableAuthz()
        login("john.doe")
    },
})

function as(username, run) {
    login(username, "moqui1!!")
    try { return run() } finally { login("john.doe") }
}
const peopleOf = (userId, addressList) => call(SERVICE, { userId, addressList }).contactList || []
const byRef = (list, partyId) => list.find((contact) => contact.contactRef === partyId) || null

feature("an organization, two users (one an employee with a phone), a personal contact each and a directory customer", {
    when() {
        const orgId = call("mantle.party.PartyServices.create#Organization", { organizationName: "People Hook Co", roleTypeId: "OrgInternal" }).partyId
        for (const [first, username] of [["Ann", "cph.ann"], ["Ben", "cph.ben"]]) {
            const partyId = call("mantle.party.PartyServices.create#Person", { firstName: first, lastName: "Hooker" }).partyId
            parties[first] = partyId
            users[first] = call("mantle.party.PartyServices.create#PartyUserAccount", { partyId, emailAddress: `${username}@example.com`, username,
                    newPassword: "moqui1!!", newPasswordVerify: "moqui1!!" }).userId
            call("create#mantle.party.PartyRelationship", { relationshipTypeEnumId: "PrtEmployee", fromPartyId: partyId, fromRoleTypeId: "Employee",
                    toPartyId: orgId, toRoleTypeId: "OrgInternal", fromDate: effectiveTime - dayMillis })
            call("store#mantle.party.PartyRole", { partyId, roleTypeId: "Employee" })
        }
        // Ben's work phone, written with a dash
        call("mantle.party.ContactServices.create#TelecomNumber", { partyId: parties.Ben, countryCode: "1", areaCode: "555", contactNumber: "444-0010",
                contactMechPurposeId: "PhoneWork" })
        // Ann's and Ben's personal contacts
        parties.annFriend = as("cph.ann", () => call("mantle.party.ContactBookServices.create#PersonalContact", { firstName: "Fran", lastName: "Friend",
                emailAddress: "Fran.Friend@Example.org" }).partyId)
        call("mantle.party.ContactServices.create#TelecomNumber", { partyId: parties.annFriend, countryCode: "1", areaCode: "555", contactNumber: "4440001",
                contactMechPurposeId: "PhoneMobile" })
        parties.benFriend = as("cph.ben", () => call("mantle.party.ContactBookServices.create#PersonalContact", { firstName: "Gale", lastName: "Private" }).partyId)
        call("mantle.party.ContactServices.create#TelecomNumber", { partyId: parties.benFriend, countryCode: "1", areaCode: "555", contactNumber: "444 0002",
                contactMechPurposeId: "PhoneMobile" })
        // a customer of the organization, in the directory
        parties.customer = call("mantle.party.PartyServices.create#Person", { firstName: "Cody", lastName: "Customer", roleTypeId: "Customer", ownerPartyId: orgId }).partyId
        call("mantle.party.ContactServices.create#TelecomNumber", { partyId: parties.customer, countryCode: "1", areaCode: "555", contactNumber: "444.0003",
                contactMechPurposeId: "PhonePrimary" })
        return {}
    },
    then() {
        users.Ann != null
        parties.annFriend != null && parties.benFriend != null && parties.customer != null
    },
})

feature("Ann's people: her own contact by number or address, with its other address; the directory's customer and coworker; never Ben's personal contact", {
    when() {
        return {
            ann: peopleOf(users.Ann, ["tel:+15554440001", "email:fran.friend@example.org", "tel:+15554440002", "tel:+15554440003", "user:" + users.Ben, "junk"]),
            ben: peopleOf(users.Ben, ["tel:+15554440001", "tel:+15554440002"]),
            // the current user by default
            own: as("cph.ann", () => call(SERVICE, { addressList: ["tel:+15554440010"] }).contactList),
            none: peopleOf(users.Ann, []),
        }
    },
    then({ ann, ben, own, none }) {
        // Fran: by her number and her address in any case, once, with both addresses
        ann.filter((contact) => contact.contactRef === parties.annFriend).length == 1
        byRef(ann, parties.annFriend).name == "Fran Friend"
        byRef(ann, parties.annFriend).addressList.includes("tel:+15554440001")
        byRef(ann, parties.annFriend).addressList.includes("email:fran.friend@example.org")
        // Ben's personal contact is his alone
        byRef(ann, parties.benFriend) == null
        // the directory customer, whose number is stored with a dot
        byRef(ann, parties.customer).addressList.includes("tel:+15554440003")
        // the coworker by user: his party, his work number and his user account
        byRef(ann, parties.Ben).addressList.includes("user:" + users.Ben)
        byRef(ann, parties.Ben).addressList.includes("tel:+15554440010")
        // Ben sees his own contact, not Ann's
        byRef(ben, parties.benFriend) != null
        byRef(ben, parties.annFriend) == null
        byRef(own, parties.Ben) != null
        none.length == 0
    },
})
