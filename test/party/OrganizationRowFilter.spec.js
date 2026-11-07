// The organization row filter of business datasets (mantle.party.PartyServices.get#OrganizationRowFilter, the report engine's
// ReportScopePolicy MantleOrganization; BOSS impl-insights P3, F11): the viewer's organizations on the field the dataset names,
// the active one alone when set, a child organization with its parent, nothing for a viewer of no organization, every
// organization for a system administrator. New spec, no Groovy original.
const FILTER = "mantle.party.PartyServices.get#OrganizationRowFilter"
const dayMillis = 86400000
const users = {}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.artifactExecution.enableAuthz()
        login("john.doe")
    }
})

// the filter as a user would get it from the report engine, with their own userId
function filterAs(username, parameters) {
    login(username, "moqui1!!")
    ec.artifactExecution.disableAuthz()
    try {
        return call(FILTER, Object.assign({userId: ec.user.userId, datasetId: "orf-dataset"}, parameters || {})).filter
    } finally {
        login("john.doe")
    }
}
function errorOf(username, parameters) {
    login(username, "moqui1!!")
    ec.artifactExecution.disableAuthz()
    try {
        call(FILTER, parameters)
    } catch (error) {
        ec.message.clearErrors()
        return String(error.message)
    } finally {
        login("john.doe")
    }
    return null
}
const valuesOf = filter => Array.from(filter?.field?.values || []).sort()

feature("two internal organizations, a child of the first, and a user of both and one of none", {
    when() {
        const past = Date.now() - dayMillis
        for (const [partyId, name] of [
            ["ORF_A", "Row Filter A"],
            ["ORF_B", "Row Filter B"],
            ["ORF_C", "Row Filter A Child"]
        ]) {
            call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: "_NA_"})
            call("create#mantle.party.Organization", {partyId, organizationName: name})
            call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
        }
        // ORF_C rolls up to ORF_A, so A's people see its rows
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtOrgRollup",
            fromPartyId: "ORF_C",
            fromRoleTypeId: "OrgInternal",
            toPartyId: "ORF_A",
            toRoleTypeId: "OrgInternal",
            fromDate: past
        })
        for (const [username, orgIds] of [
            ["orf.both", ["ORF_A", "ORF_B"]],
            ["orf.none", []]
        ]) {
            const partyId = call("mantle.party.PartyServices.create#Person", {firstName: username, lastName: "RowFilter"}).partyId
            users[username] = call("mantle.party.PartyServices.create#PartyUserAccount", {
                partyId,
                emailAddress: username + "@example.com",
                username,
                newPassword: "moqui1!!",
                newPasswordVerify: "moqui1!!"
            }).userId
            for (const toPartyId of orgIds)
                call("create#mantle.party.PartyRelationship", {
                    relationshipTypeEnumId: "PrtEmployee",
                    fromPartyId: partyId,
                    fromRoleTypeId: "Employee",
                    toPartyId,
                    toRoleTypeId: "OrgInternal",
                    fromDate: past
                })
        }
        return {created: Object.keys(users).length}
    },
    then({created}) {
        created == 2
    }
})

feature("the user's organizations and the child on the dataset's field, or organizationPartyId by default", {
    when() {
        return {
            named: filterAs("orf.both", {rowFilterParameters: {organizationField: "vendorPartyId"}}),
            plain: filterAs("orf.both")
        }
    },
    then({named, plain}) {
        named.field.name == "vendorPartyId"
        named.field.op == "in"
        valuesOf(named).join(",") == "ORF_A,ORF_B,ORF_C"
        plain.field.name == "organizationPartyId"
        valuesOf(plain).join(",") == "ORF_A,ORF_B,ORF_C"
    }
})

feature("the active organization alone when the user has set one", {
    when() {
        login("orf.both", "moqui1!!")
        ec.user.setPreference("ACTIVE_ORGANIZATION", "ORF_B")
        login("john.doe")
        const active = filterAs("orf.both", {rowFilterParameters: {organizationField: "vendorPartyId"}})
        login("orf.both", "moqui1!!")
        ec.user.setPreference("ACTIVE_ORGANIZATION", null)
        login("john.doe")
        return {active}
    },
    then({active}) {
        valuesOf(active).join(",") == "ORF_B"
    }
})

feature("nothing for a user of no organization, everything for a system administrator, and refusals", {
    when() {
        ec.artifactExecution.disableAuthz()
        const admin = call(FILTER, {userId: ec.user.userId}).filter
        return {
            none: filterAs("orf.none"),
            admin,
            otherUser: errorOf("orf.both", {userId: users["orf.none"]}),
            expression: errorOf("orf.both", {rowFilterParameters: {organizationField: "a) || (b"}})
        }
    },
    then({none, admin, otherUser, expression}) {
        none.bool.none.length == 1
        none.field == null
        admin.match_all != null
        otherUser.includes("signed-in user only")
        expression.includes("is not a field name")
    }
})
