// The projected CardDAV address book (impl-sales P5, F29; mantle.party.ContactDavServices projected-{projectionId}; CX-SYNC) and
// Sales' My accounts on it (SalesWorkspaceServices get#AccountContactProjection): a rep's collections list My accounts, read only,
// with the contacts of the account they manage and of their team's deal's account, and not those of another team's account; a
// card's write and delete are refused; a user who reads nothing of Sales gets no such collection. Called as the DAV server calls
// them, as the user with artifact authorization off.
// Run: ./moq test mr-mantle --spec ProjectedAddressBook
const prefix = "PAB"
const org = prefix + "_ORG"
const COLLECTION = "projected-SalesMyAccounts"
const users = {}
const parties = {}

const make = (entity, values) => call("create#" + entity, values)
function system(action) {
    login("john.doe")
    const was = ec.artifactExecution.disableAuthz()
    try {
        return action()
    } finally {
        if (!was) ec.artifactExecution.enableAuthz()
    }
}
function as(username, service, parameters = {}) {
    login(username)
    const was = ec.artifactExecution.disableAuthz()
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(service).parameters(parameters).call() || {}
        return ec.message.hasError() ? {refused: ec.message.getErrorsString()} : Object.assign({refused: ""}, out)
    } catch (error) {
        return {refused: String(error.message)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        if (!was) ec.artifactExecution.enableAuthz()
        login("john.doe")
    }
}
function person(kind, firstName, ownerPartyId = org) {
    const partyId = prefix + "_P_" + kind
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson", ownerPartyId})
    make("mantle.party.Person", {partyId, firstName, lastName: kind})
    return partyId
}
function user(kind, permissions) {
    const partyId = person(kind, "Rep")
    make("mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtAgent",
        fromPartyId: partyId,
        toPartyId: org,
        toRoleTypeId: "OrgInternal",
        fromDate: 0
    })
    make("moqui.security.UserGroup", {userGroupId: partyId, description: "Address book " + kind})
    for (const userPermissionId of permissions)
        make("moqui.security.UserGroupPermission", {userGroupId: partyId, userPermissionId, fromDate: 0})
    make("moqui.security.UserAccount", {
        userId: partyId,
        username: partyId,
        partyId,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA"
    })
    make("moqui.security.UserGroupMember", {userId: partyId, userGroupId: partyId, fromDate: 0})
    return partyId
}
function account(kind) {
    const partyId = prefix + "_ACC_" + kind
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: org})
    make("mantle.party.Organization", {partyId, organizationName: "Account " + kind})
    make("mantle.party.PartyRole", {partyId, roleTypeId: "Customer"})
    return partyId
}
function contactOf(personPartyId, accountPartyId) {
    make("mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtContact",
        fromPartyId: personPartyId,
        toPartyId: accountPartyId,
        fromDate: 0
    })
}
function team(kind, members) {
    const partyId = prefix + "_TEAM_" + kind
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: org})
    make("mantle.party.Organization", {partyId, organizationName: "Team " + kind})
    make("mantle.party.PartyRole", {partyId, roleTypeId: "SalesTeam"})
    make("mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtSalesTeamOf",
        fromPartyId: partyId,
        toPartyId: org,
        fromDate: 0
    })
    for (const member of members)
        make("mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtSalesTeamMember",
            fromPartyId: member,
            toPartyId: partyId,
            fromDate: 0
        })
    return partyId
}
function deal(kind, accountPartyId, teamPartyId) {
    const salesOpportunityId = prefix + "_OPP_" + kind
    make("mantle.sales.opportunity.SalesOpportunity", {
        salesOpportunityId,
        typeEnumId: "SotOpportunity",
        organizationPartyId: org,
        opportunityName: "Deal " + kind,
        accountPartyId,
        statusId: "SalesOppOpen"
    })
    make("mantle.sales.opportunity.SalesOpportunityParty", {
        salesOpportunityId,
        partyId: org,
        roleTypeId: "OrgInternal",
        fromDate: 0
    })
    make("mantle.sales.opportunity.SalesOpportunityParty", {
        salesOpportunityId,
        partyId: teamPartyId,
        roleTypeId: "SalesTeam",
        fromDate: 0
    })
}
const collectionsOf = username =>
    Array.from(as(username, "mantle.party.ContactDavServices.get#DavCollections").collectionList || [])

spec({
    setupSpec() {
        system(() => {
            make("mantle.party.Party", {partyId: org, partyTypeEnumId: "PtyOrganization", ownerPartyId: org})
            make("mantle.party.Organization", {partyId: org, organizationName: "Address book org"})
            make("mantle.party.PartyRole", {partyId: org, roleTypeId: "OrgInternal"})
            users.rep = user("REP", ["SALES_VIEW"])
            users.other = user("OTHER", ["SALES_VIEW"])
            users.none = user("NONE", [])
            const east = team("EAST", [users.rep])
            const west = team("WEST", [users.other])
            parties.managed = account("MANAGED")
            parties.deal = account("DEAL")
            parties.west = account("WEST")
            make("mantle.party.PartyRelationship", {
                relationshipTypeEnumId: "PrtAccountManager",
                fromPartyId: users.rep,
                toPartyId: parties.managed,
                fromDate: 0
            })
            deal("EAST", parties.deal, east)
            deal("WEST", parties.west, west)
            parties.managedContact = person("MC", "Managed")
            parties.dealContact = person("DC", "Deal")
            parties.westContact = person("WC", "West")
            contactOf(parties.managedContact, parties.managed)
            contactOf(parties.dealContact, parties.deal)
            contactOf(parties.westContact, parties.west)
            // a deal of an organization the rep does not sell for, left assigned to them, on a shared account (_NA_) with a shared
            // contact: it brings no account (P5 review R3)
            const elsewhere = prefix + "_ORG_ELSEWHERE"
            make("mantle.party.Party", {partyId: elsewhere, partyTypeEnumId: "PtyOrganization", ownerPartyId: elsewhere})
            make("mantle.party.Organization", {partyId: elsewhere, organizationName: "Elsewhere"})
            make("mantle.party.PartyRole", {partyId: elsewhere, roleTypeId: "OrgInternal"})
            parties.shared = prefix + "_ACC_SHARED"
            make("mantle.party.Party", {partyId: parties.shared, partyTypeEnumId: "PtyOrganization", ownerPartyId: "_NA_"})
            make("mantle.party.Organization", {partyId: parties.shared, organizationName: "Account shared"})
            make("mantle.party.PartyRole", {partyId: parties.shared, roleTypeId: "Customer"})
            parties.sharedContact = person("SC", "Shared", "_NA_")
            contactOf(parties.sharedContact, parties.shared)
            make("mantle.sales.opportunity.SalesOpportunity", {
                salesOpportunityId: prefix + "_OPP_ELSEWHERE",
                typeEnumId: "SotOpportunity",
                organizationPartyId: elsewhere,
                opportunityName: "Deal elsewhere",
                accountPartyId: parties.shared,
                statusId: "SalesOppOpen"
            })
            make("mantle.sales.opportunity.SalesOpportunityParty", {
                salesOpportunityId: prefix + "_OPP_ELSEWHERE",
                partyId: users.rep,
                roleTypeId: "SalesRepresentative",
                fromDate: 0
            })
        })
    }
})

feature(
    "My accounts lists the rep's accounts' contacts read only, not another team's; a write is refused; no Sales, no collection",
    {
        when() {
            const collection = collectionsOf(users.rep).find(row => row.collectionId === COLLECTION)
            const objects = Array.from(
                as(users.rep, "mantle.party.ContactDavServices.get#DavObjects", {collectionId: COLLECTION, withData: true})
                    .objectList || []
            )
            const otherObjects = Array.from(
                as(users.other, "mantle.party.ContactDavServices.get#DavObjects", {collectionId: COLLECTION}).objectList || []
            )
            const put = as(users.rep, "mantle.party.ContactDavServices.put#DavObject", {
                collectionId: COLLECTION,
                objectName: parties.dealContact + ".vcf",
                data: "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Changed\r\nN:Changed;;;;\r\nEND:VCARD\r\n"
            })
            const removed = as(users.rep, "mantle.party.ContactDavServices.delete#DavObject", {
                collectionId: COLLECTION,
                objectName: parties.dealContact + ".vcf"
            })
            const none = collectionsOf(users.none).some(row => row.collectionId === COLLECTION)
            const noneObjects = as(users.none, "mantle.party.ContactDavServices.get#DavObjects", {collectionId: COLLECTION})
            return {collection, objects, otherObjects, put, removed, none, noneObjects}
        },
        then(r) {
            r.collection != null
            r.collection.readOnly == true
            r.collection.name == "My accounts"
            r.objects.map(row => row.name).includes(parties.managedContact + ".vcf")
            r.objects.map(row => row.name).includes(parties.dealContact + ".vcf")
            !r.objects.map(row => row.name).includes(parties.westContact + ".vcf")
            !r.objects.map(row => row.name).includes(parties.sharedContact + ".vcf")
            r.objects.find(row => row.name === parties.dealContact + ".vcf").data.includes("Deal")
            r.otherObjects.map(row => row.name).includes(parties.westContact + ".vcf")
            !r.otherObjects.map(row => row.name).includes(parties.dealContact + ".vcf")
            r.put.status == 403
            r.removed.status == 403
            r.none == false
            r.noneObjects.refused.includes("not found")
        }
    }
)
