// The pipeline dataset (impl-sales P6, F66; design-sales §1.4 CX-OPS-REPORTS, §8; report/mantle-sales-pipeline.json,
// data/SalesPipelineReportData.xml, SalesWorkspaceServices get#PipelineRowFilter): its row filter is Sales' scope, so a
// representative's rows are their organization's deals assigned to them or their team, a manager's (SALES_TEAM_VIEW) the
// organization's, never another organization's, and a user who reads nothing of Sales gets none; another user's filter is refused.
// The document carries the deal's organization, stage (with a label that sorts by the pipeline's order) and current owner and team,
// and read through the report engine as each user (when search is available) the rows follow the filter. Standalone: spec-local
// organizations, teams, users and deals, the dataset admitted and granted to a spec group.
// Run: ./moq test mr-mantle --spec SalesPipelineDataset
const prefix = "SPD"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const W = "mantle.sales.SalesWorkspaceServices."
const users = {}
const teams = {}
const deals = {}

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
function organization(partyId, name) {
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    make("mantle.party.Organization", {partyId, organizationName: name})
    make("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
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
    make("mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtSalesTeamMember",
        fromPartyId: partyId,
        fromRoleTypeId: "SalesRepresentative",
        toPartyId: teamPartyId,
        toRoleTypeId: "SalesTeam",
        fromDate: 0
    })
}
function user(kind, organizationPartyIds, permissions) {
    const id = prefix + "_" + kind.toUpperCase()
    make("mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    make("mantle.party.Person", {partyId: id, firstName: "Dataset", lastName: kind})
    for (const toPartyId of organizationPartyIds)
        make("mantle.party.PartyRelationship", {
            fromPartyId: id,
            toPartyId,
            relationshipTypeEnumId: "PrtAgent",
            toRoleTypeId: "OrgInternal",
            fromDate: 0
        })
    make("moqui.security.UserGroup", {userGroupId: id, description: "Dataset " + kind})
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
// As the user with artifact authorization on: the action's result, or the refusal's message (refused).
function as(username, action) {
    login(username)
    const was = ec.artifactExecution.authzDisabled()
    ec.artifactExecution.enableAuthz()
    ec.message.pushErrors()
    try {
        const out = action()
        return ec.message.hasError() ? {refused: ec.message.getErrorsString()} : out
    } catch (error) {
        return {refused: String(error.message)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        if (was) ec.artifactExecution.disableAuthz()
        login("john.doe")
    }
}
const invoke = (name, parameters) => ec.service.sync().name(name).parameters(parameters).requireNewTransaction(true).call() || {}
const filterOf = username => as(username, () => invoke(W + "get#PipelineRowFilter", {userId: ec.user.userId}).filter)
// the values of a filter's field condition, at its top or in its bool all
function valuesOf(filter, name) {
    const parts = filter?.bool?.all ? Array.from(filter.bool.all) : [filter]
    const found = parts.find(part => part?.field?.name === name)
    return found
        ? Array.from(found.field.values || [])
              .sort()
              .join(",")
        : null
}
const nothing = filter => Array.from(filter?.bool?.none || []).length === 1

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Dataset A")
            organization(orgB, "Dataset B")
            make("moqui.security.UserGroup", {userGroupId: prefix + "_GRANT", description: "Dataset spec grant"})
            make("moqui.security.ArtifactGroup", {artifactGroupId: prefix + "_SERVICES", description: "Dataset spec services"})
            for (const [artifactName, pattern] of [
                ["mantle\\.sales\\..*", "Y"],
                ["org.moqui.report.dataset.mantle-sales-pipeline", "N"],
                ["org.moqui.report.ReportServices.query#Documents", "N"]
            ])
                make("moqui.security.ArtifactGroupMember", {
                    artifactGroupId: prefix + "_SERVICES",
                    artifactName,
                    artifactTypeEnumId: "AT_SERVICE",
                    nameIsPattern: pattern,
                    inheritAuthz: "Y"
                })
            make("moqui.security.ArtifactAuthz", {
                artifactAuthzId: prefix + "_GRANT",
                userGroupId: prefix + "_GRANT",
                artifactGroupId: prefix + "_SERVICES",
                authzTypeEnumId: "AUTHZT_ALLOW",
                authzActionEnumId: "AUTHZA_ALL"
            })
            make("moqui.entity.document.DataDocumentUserGroup", {
                dataDocumentId: "MantleSalesOpportunity",
                userGroupId: prefix + "_GRANT"
            })
            if (!ec.entity.find("moqui.report.BusinessDataset").condition("datasetId", "mantle-sales-pipeline").one())
                make("moqui.report.BusinessDataset", {
                    datasetId: "mantle-sales-pipeline",
                    admittedDate: new Date(),
                    versionNumber: 1
                })
            const rep = ["SALES_VIEW", "SALES_OPPORTUNITY_EDIT"]
            users.east = user("east", [orgA], rep)
            users.west = user("west", [orgA], rep)
            users.manager = user("manager", [orgA], rep.concat(["SALES_TEAM_VIEW"]))
            users.repB = user("repb", [orgB], rep)
            users.none = user("none", [orgA], ["SALES_OPPORTUNITY_EDIT"])
            teams.east = team("east", orgA)
            teams.west = team("west", orgA)
            member(users.east, teams.east)
            member(users.west, teams.west)
        })
        const create = (username, organizationPartyId, opportunityName) =>
            as(username, () =>
                invoke("mantle.sales.OpportunityServices.create#Opportunity", {
                    organizationPartyId,
                    opportunityName,
                    opportunityStageId: "SalesProposal"
                })
            ).salesOpportunityId
        deals.east = create(users.east, orgA, "East deal")
        deals.west = create(users.west, orgA, "West deal")
        deals.b = create(users.repB, orgB, "B deal")
    }
})

feature("the row filter is Sales' scope: a rep's assigned deals, a manager's organization, never another organization's", {
    when() {
        return {
            east: filterOf(users.east),
            manager: filterOf(users.manager),
            repB: filterOf(users.repB),
            none: filterOf(users.none),
            otherUser: as(users.east, () => invoke(W + "get#PipelineRowFilter", {userId: users.manager}))
        }
    },
    then(r) {
        valuesOf(r.east, "organizationPartyId") == orgA
        valuesOf(r.east, "salesOpportunityId") == deals.east
        valuesOf(r.manager, "organizationPartyId") == orgA
        valuesOf(r.manager, "salesOpportunityId") == null
        valuesOf(r.repB, "organizationPartyId") == orgB
        nothing(r.none)
        r.otherUser.refused.includes("signed-in user only")
    }
})

feature("the document carries the deal's stage label, owner and team, and the rows read through the engine follow the filter", {
    when() {
        const documents = system(() =>
            Object.fromEntries(
                Object.entries(deals).map(([key, salesOpportunityId]) => [
                    key,
                    Array.from(ec.entity.getDataDocuments("MantleSalesOpportunity", {salesOpportunityId}))[0]
                ])
            )
        )
        const searched = ec.search.isAvailable()
        let rows = {}
        if (searched) {
            system(() => ec.search.indexDocuments(Object.values(documents).filter(Boolean)))
            const seen = username =>
                as(username, () =>
                    Array.from(
                        invoke("org.moqui.report.ReportServices.query#Documents", {
                            datasetId: "mantle-sales-pipeline",
                            from: "now-1d",
                            thru: "now+1d",
                            pageSize: 200
                        }).hits || []
                    )
                        .map(hit => hit.body?.salesOpportunityId)
                        .filter(id => Object.values(deals).includes(id))
                        .sort()
                        .join(",")
                )
            rows = {east: seen(users.east), manager: seen(users.manager), repB: seen(users.repB)}
        }
        return {documents, searched, rows}
    },
    then({documents, searched, rows}) {
        documents.east.organizationPartyId == orgA
        documents.east.opportunityStageId == "SalesProposal"
        documents.east.stageName == "Proposal"
        documents.east.stageLabel.endsWith(" Proposal")
        documents.east.ownerPartyId == users.east
        documents.east.teamPartyId == teams.east
        // through the report engine (a runtime with search): each reader's own rows
        !searched || rows.east == deals.east
        !searched || rows.manager == [deals.east, deals.west].sort().join(",")
        !searched || rows.repB == deals.b
    }
})
