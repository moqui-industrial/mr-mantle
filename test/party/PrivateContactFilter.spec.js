// The personal contact filter (MANTLE_PRIVATE_CONTACT, data/MantleSetupData.xml) fails closed on a view over Party
// (allowMissingAlias="N", SEC-DAT-11): a view that left out Party's privateOwnerUserId was read with the filter term left
// out, so another user saw a row of someone's personal contact. The views over Party alias it; here a carrier that is a
// user's personal contact, read through CarrierShipmentMethodDetail under a grant that carries the filter, is its owner's
// only. On a view over two parties (SalesAccountContact: the account and its contact) each party is held to the filter
// on its own, so a row with one public party and the owner's personal one is the owner's. Authorization on, spec-local
// users and records. Run: ./moq test mr-mantle --spec PrivateContactFilter
const VIEW = "mantle.shipment.carrier.CarrierShipmentMethodDetail"
const PAIR_VIEW = "mantle.sales.SalesAccountContact"
const ids = {carrier: "PCF_CARRIER", owner: "PCF_OWNER", other: "PCF_OTHER", group: "PCF_READ", contact: "PCF_PUBLIC"}
const since = "2026-01-01 00:00:00"

function user(id) {
    call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId: id, firstName: "Filter", lastName: id})
    call("create#moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId: id,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        timeZone: ec.user.userAccount?.timeZone || "America/Chicago"
    })
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: ids.group, fromDate: since})
}
// the carrier's rows of a view as a user with authorization on
function carrierRows(username, view = VIEW, field = "carrierPartyId") {
    login(username)
    ec.artifactExecution.enableAuthz()
    try {
        return Array.from(ec.entity.find(view).condition(field, ids.carrier).useCache(false).list()).length
    } finally {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        call("create#moqui.security.UserGroup", {userGroupId: ids.group, description: "Private contact filter spec"})
        call("create#moqui.security.ArtifactGroup", {artifactGroupId: ids.group, description: "Private contact filter spec"})
        for (const view of [VIEW, PAIR_VIEW]) {
            call("create#moqui.security.ArtifactGroupMember", {
                artifactGroupId: ids.group,
                artifactTypeEnumId: "AT_ENTITY",
                artifactName: view,
                nameIsPattern: "N",
                inheritAuthz: "Y"
            })
        }
        call("create#moqui.security.ArtifactAuthz", {
            artifactAuthzId: ids.group,
            userGroupId: ids.group,
            artifactGroupId: ids.group,
            authzTypeEnumId: "AUTHZT_ALLOW",
            authzActionEnumId: "AUTHZA_VIEW"
        })
        call("create#moqui.security.ArtifactAuthzFilter", {
            artifactAuthzId: ids.group,
            entityFilterSetId: "MANTLE_PRIVATE_CONTACT"
        })
        user(ids.owner)
        user(ids.other)
        call("create#mantle.party.Party", {
            partyId: ids.carrier,
            partyTypeEnumId: "PtyOrganization",
            privateOwnerUserId: ids.owner
        })
        call("create#mantle.party.Organization", {partyId: ids.carrier, organizationName: "Filter spec carrier"})
        call("create#mantle.shipment.carrier.CarrierShipmentMethod", {
            carrierPartyId: ids.carrier,
            shipmentMethodEnumId: "ShMthGround"
        })
        // a public person, a contact of the owner's personal account
        call("create#mantle.party.Party", {partyId: ids.contact, partyTypeEnumId: "PtyPerson"})
        call("create#mantle.party.Person", {partyId: ids.contact, firstName: "Public", lastName: "Contact"})
        call("create#mantle.party.PartyRole", {partyId: ids.carrier, roleTypeId: "Customer"})
        call("create#mantle.party.PartyRelationship", {
            partyRelationshipId: "PCF_REL",
            relationshipTypeEnumId: "PrtContact",
            fromPartyId: ids.contact,
            toPartyId: ids.carrier,
            fromDate: since
        })
    },
    cleanupSpec() {
        ec.artifactExecution.enableAuthz()
    }
})

feature("a personal contact's row of a view over Party is its owner's only", {
    when() {
        return {owner: carrierRows(ids.owner), other: carrierRows(ids.other)}
    },
    then({owner, other}) {
        owner == 1
        other == 0
    }
})

feature("a row of a view over two parties, one public and one personal, is the personal one's owner's", {
    when() {
        return {owner: carrierRows(ids.owner, PAIR_VIEW, "accountPartyId"), other: carrierRows(ids.other, PAIR_VIEW, "accountPartyId")}
    },
    then({owner, other}) {
        owner == 1
        other == 0
    }
})
