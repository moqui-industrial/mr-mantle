// Sales' lead qualification (impl-sales P4; design-sales §3 Leads, QualifyLead; mantle/sales/SalesOpportunities.js qualifyLead):
// a lead with no account is promoted as the same record (one salesOpportunityId), with a new prospect account and contact, its
// activity kept; a retry under its operation key answers the first result and makes no second account; another organization's
// account is refused, an existing person is joined as the account's contact, and an opportunity is not qualified again.
// Standalone: spec-local organizations, users and records, the users' services run with artifact authorization on under a spec
// grant of the sales services.
// Run: ./moq test mr-mantle --spec SalesLeadQualify
const prefix = "SLQ"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const service = "mantle.sales.OpportunityServices."
const users = {}
const teams = {}
const ids = {}

const make = (entity, values) => call("create#" + entity, values)
const one = (entity, values) => ec.entity.find(entity).condition(values).disableAuthz().one()
const rowsOf = (entity, values) => Array.from(ec.entity.find(entity).condition(values).disableAuthz().list())
function system(action) {
    login("john.doe")
    const was = ec.artifactExecution.disableAuthz()
    try {
        return action()
    } finally {
        if (!was) ec.artifactExecution.enableAuthz()
    }
}
function organization(partyId, name) {
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    make("mantle.party.Organization", {partyId, organizationName: name})
    make("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
// a team of an organization, from the start of time
function team(kind, organizationPartyId) {
    const partyId = prefix + "_TEAM_" + kind.toUpperCase()
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: organizationPartyId})
    make("mantle.party.Organization", {partyId, organizationName: "Team " + kind})
    make("mantle.party.PartyRole", {partyId, roleTypeId: "SalesTeam"})
    make("mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtSalesTeamOf",
        fromPartyId: partyId,
        fromRoleTypeId: "SalesTeam",
        toPartyId: organizationPartyId,
        toRoleTypeId: "OrgInternal",
        fromDate: 0
    })
    return partyId
}
function member(partyId, teamPartyId) {
    return make("mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtSalesTeamMember",
        fromPartyId: partyId,
        fromRoleTypeId: "SalesRepresentative",
        toPartyId: teamPartyId,
        toRoleTypeId: "SalesTeam",
        fromDate: 0
    }).partyRelationshipId
}
// a user, agent of the organizations, in a spec group holding the permissions and the spec's service grant
function user(kind, organizationPartyIds, permissions) {
    const id = prefix + "_" + kind.toUpperCase()
    make("mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    make("mantle.party.Person", {partyId: id, firstName: "Qualify", lastName: kind})
    for (const toPartyId of organizationPartyIds)
        make("mantle.party.PartyRelationship", {
            fromPartyId: id,
            toPartyId,
            relationshipTypeEnumId: "PrtAgent",
            toRoleTypeId: "OrgInternal",
            fromDate: 0
        })
    make("moqui.security.UserGroup", {userGroupId: id, description: "Qualify " + kind})
    for (const userPermissionId of permissions)
        make("moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId, fromDate: 0})
    make("moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId: id,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA"
    })
    make("moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: 0})
    make("moqui.security.UserGroupMember", {userId: id, userGroupId: prefix + "_GRANT", fromDate: 0})
    return id
}
// A call as the user with artifact authorization on: its result, or the refusal's message (refused), in an error frame of its own.
function as(username, verb, parameters = {}) {
    login(username)
    const was = ec.artifactExecution.authzDisabled()
    ec.artifactExecution.enableAuthz()
    ec.message.pushErrors()
    try {
        const out =
            ec.service
                .sync()
                .name(verb.includes(".") ? verb : service + verb)
                .parameters(parameters)
                .requireNewTransaction(true)
                .call() || {}
        return ec.message.hasError() ? {refused: ec.message.getErrorsString()} : Object.assign({refused: ""}, out)
    } catch (error) {
        return {refused: String(error.message)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        if (was) ec.artifactExecution.disableAuthz()
        login("john.doe")
    }
}
// Whether get#RecordLinkInfo shows the deal to the user (Chatter's and RecordFiles' host check), asked with authorization off
function linkVisible(username, salesOpportunityId) {
    login(username)
    const was = ec.artifactExecution.disableAuthz()
    try {
        return !!ec.service
            .sync()
            .name("mantle.party.CommunicationServices.get#RecordLinkInfo")
            .parameters({
                recordEntityName: "mantle.sales.opportunity.SalesOpportunity",
                recordId: salesOpportunityId,
                checkOnly: true
            })
            .call()?.recordVisible
    } finally {
        ec.message.clearErrors()
        if (!was) ec.artifactExecution.enableAuthz()
        login("john.doe")
    }
}
const idsOf = found => Array.from(found.opportunityList || []).map(row => row.salesOpportunityId)
const revision = (username, salesOpportunityId) => as(username, "get#Opportunity", {salesOpportunityId}).opportunity?.revision

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Qualify A")
            organization(orgB, "Qualify B")
            make("moqui.security.UserGroup", {userGroupId: prefix + "_GRANT", description: "Qualify spec grant"})
            make("moqui.security.ArtifactGroup", {artifactGroupId: prefix + "_SERVICES", description: "Qualify spec services"})
            make("moqui.security.ArtifactGroupMember", {
                artifactGroupId: prefix + "_SERVICES",
                artifactName: "mantle\\.sales\\..*",
                artifactTypeEnumId: "AT_SERVICE",
                nameIsPattern: "Y",
                inheritAuthz: "Y"
            })
            make("moqui.security.ArtifactAuthz", {
                artifactAuthzId: prefix + "_GRANT",
                userGroupId: prefix + "_GRANT",
                artifactGroupId: prefix + "_SERVICES",
                authzTypeEnumId: "AUTHZT_ALLOW",
                authzActionEnumId: "AUTHZA_ALL"
            })
            users.rep = user("rep", [orgA], ["SALES_VIEW", "SALES_OPPORTUNITY_EDIT", "SALES_ACCOUNT_EDIT"])
            teams.east = team("east", orgA)
            member(users.rep, teams.east)
            // B's account, and a person of A to join as a contact
            make("mantle.party.Party", {partyId: prefix + "_ACC_B", partyTypeEnumId: "PtyOrganization", ownerPartyId: orgB})
            make("mantle.party.Organization", {partyId: prefix + "_ACC_B", organizationName: "Account of B"})
            make("mantle.party.PartyRole", {partyId: prefix + "_ACC_B", roleTypeId: "Account"})
            make("mantle.party.PartyRole", {partyId: prefix + "_ACC_B", roleTypeId: "Customer"})
            make("mantle.party.Party", {partyId: prefix + "_PERSON", partyTypeEnumId: "PtyPerson", ownerPartyId: orgA})
            make("mantle.party.Person", {partyId: prefix + "_PERSON", firstName: "Jo", lastName: "Known"})
        })
        // two leads with no account, the first with an activity
        ids.lead = as(users.rep, "create#Opportunity", {
            typeEnumId: "SotLead",
            organizationPartyId: orgA,
            opportunityName: "Inbound enquiry"
        }).salesOpportunityId
        ids.other = as(users.rep, "create#Opportunity", {
            typeEnumId: "SotLead",
            organizationPartyId: orgA,
            opportunityName: "Trade fair card"
        }).salesOpportunityId
        ids.task = as(users.rep, "add#OpportunityActivity", {
            salesOpportunityId: ids.lead,
            workEffortName: "Call back"
        }).workEffortId
    }
})

const accountsNamed = name =>
    system(() => ec.entity.find("mantle.party.Organization").condition("organizationName", name).count())

feature("a lead is promoted as the same record with a new prospect and contact; a retry under its key makes no second account", {
    when() {
        const before = system(() => one("mantle.sales.opportunity.SalesOpportunity", {salesOpportunityId: ids.lead}))
        const parameters = {
            salesOpportunityId: ids.lead,
            expectedRevision: revision(users.rep, ids.lead),
            operationKey: prefix + "-qualify-1",
            accountName: "Qualified Prospect Co",
            contactFirstName: "Pat",
            contactLastName: "Buyer",
            estimatedAmount: "5000",
            currencyUomId: "USD"
        }
        const first = as(users.rep, "qualify#Lead", parameters)
        const retry = as(users.rep, "qualify#Lead", parameters)
        const changed = as(users.rep, "qualify#Lead", Object.assign({}, parameters, {accountName: "Another Co"}))
        const after = system(() => one("mantle.sales.opportunity.SalesOpportunity", {salesOpportunityId: ids.lead}))
        const roles = system(() => rowsOf("mantle.party.PartyRole", {partyId: first.accountPartyId}).map(row => row.roleTypeId))
        const contactRow = system(() =>
            rowsOf("mantle.sales.opportunity.SalesOpportunityParty", {salesOpportunityId: ids.lead, roleTypeId: "Contact"}).map(
                row => row.partyId
            )
        )
        const activity = system(() =>
            one("mantle.sales.opportunity.SalesOpportunityWorkEffort", {salesOpportunityId: ids.lead, workEffortId: ids.task})
        )
        return {before, first, retry, changed, after, roles, contactRow, activity, made: accountsNamed("Qualified Prospect Co")}
    },
    then(r) {
        r.before.typeEnumId == "SotLead"
        r.before.accountPartyId == null
        r.first.refused == ""
        r.first.salesOpportunityId == ids.lead
        r.first.accountPartyId != null
        r.retry.refused == ""
        r.retry.alreadyApplied == true
        r.retry.accountPartyId == r.first.accountPartyId
        r.changed.refused.includes("OPERATION_KEY_CONFLICT")
        r.made == 1
        r.after.typeEnumId == "SotOpportunity"
        r.after.accountPartyId == r.first.accountPartyId
        r.after.convertedDate != null
        r.after.convertedByUserId == users.rep
        r.after.opportunityStageId == "SalesQualified"
        r.roles.includes("Prospect")
        r.contactRow.includes(r.first.contactPartyId)
        r.activity != null
    }
})

feature(
    "another organization's account is refused; an existing person joins the account; an opportunity is not qualified again",
    {
        when() {
            const base = () => ({salesOpportunityId: ids.other, expectedRevision: revision(users.rep, ids.other)})
            const crossed = as(
                users.rep,
                "qualify#Lead",
                Object.assign(base(), {operationKey: prefix + "-cross", accountPartyId: prefix + "_ACC_B"})
            )
            const stillLead = system(
                () => one("mantle.sales.opportunity.SalesOpportunity", {salesOpportunityId: ids.other}).typeEnumId
            )
            const joined = as(
                users.rep,
                "qualify#Lead",
                Object.assign(base(), {
                    operationKey: prefix + "-join",
                    accountName: "Fair Visitor Ltd",
                    contactPartyId: prefix + "_PERSON"
                })
            )
            const contact = system(
                () =>
                    rowsOf("mantle.party.PartyRelationship", {
                        fromPartyId: prefix + "_PERSON",
                        toPartyId: joined.accountPartyId,
                        relationshipTypeEnumId: "PrtContact"
                    }).length
            )
            const again = as(
                users.rep,
                "qualify#Lead",
                Object.assign(base(), {operationKey: prefix + "-again", accountName: "Third Co"})
            )
            return {crossed, stillLead, joined, contact, again}
        },
        then(r) {
            r.crossed.refused.includes("RECORD_UNAVAILABLE")
            r.stillLead == "SotLead"
            r.joined.refused == ""
            r.joined.contactPartyId == prefix + "_PERSON"
            r.contact == 1
            r.again.refused.includes("ALREADY_QUALIFIED")
        }
    }
)
