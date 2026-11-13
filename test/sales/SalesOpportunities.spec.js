// Sales' leads and opportunities (impl-sales P4; design-sales §3, §1.1; mantle/sales/SalesOpportunities.js, SalesAccess.js
// opportunityOf): a representative finds their own and their team's deals and not another team's, a manager the organization's,
// and ending a membership ends the team's deals; another organization's deal answers as missing; a stale move is refused naming
// the stamp, and a manual probability is kept across a move; Lost needs a reason, and a reopen keeps the close history; a batch
// names the stale deal and moves the rest. Standalone: spec-local organizations, teams, users and records; the users' services run
// with artifact authorization on under a spec grant of the sales services, as an app root's grant gives them.
// Run: ./moq test mr-mantle --spec SalesOpportunities
const prefix = "SOP"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const service = "mantle.sales.OpportunityServices."
const users = {}
const teams = {}
const deals = {}

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
    make("mantle.party.Person", {partyId: id, firstName: "Deals", lastName: kind})
    for (const toPartyId of organizationPartyIds)
        make("mantle.party.PartyRelationship", {
            fromPartyId: id,
            toPartyId,
            relationshipTypeEnumId: "PrtAgent",
            toRoleTypeId: "OrgInternal",
            fromDate: 0
        })
    make("moqui.security.UserGroup", {userGroupId: id, description: "Deals " + kind})
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
            organization(orgA, "Deals A")
            organization(orgB, "Deals B")
            make("moqui.security.UserGroup", {userGroupId: prefix + "_GRANT", description: "Deals spec grant"})
            make("moqui.security.ArtifactGroup", {artifactGroupId: prefix + "_SERVICES", description: "Deals spec services"})
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
            const rep = ["SALES_VIEW", "SALES_OPPORTUNITY_EDIT", "SALES_ACCOUNT_EDIT"]
            users.rep = user("rep", [orgA], rep)
            users.mate = user("mate", [orgA], rep)
            users.other = user("other", [orgA], rep)
            users.manager = user("manager", [orgA], rep.concat(["SALES_TEAM_VIEW", "SALES_TEAM_MANAGE"]))
            users.repB = user("repb", [orgB], rep)
            teams.east = team("east", orgA)
            teams.west = team("west", orgA)
            member(users.rep, teams.east)
            teams.mateMembership = member(users.mate, teams.east)
            member(users.other, teams.west)
        })
        // each rep's deal, on their team (the owner's only team), and a deal of B
        deals.rep = as(users.rep, "create#Opportunity", {
            organizationPartyId: orgA,
            opportunityName: "Rep's deal"
        }).salesOpportunityId
        deals.mate = as(users.mate, "create#Opportunity", {
            organizationPartyId: orgA,
            opportunityName: "Mate's deal"
        }).salesOpportunityId
        deals.other = as(users.other, "create#Opportunity", {
            organizationPartyId: orgA,
            opportunityName: "Other's deal"
        }).salesOpportunityId
        deals.b = as(users.repB, "create#Opportunity", {
            organizationPartyId: orgB,
            opportunityName: "B's deal"
        }).salesOpportunityId
    }
})

feature("a rep finds their own and their team's deals, not another team's or organization's; a manager the organization's", {
    when() {
        const find = username => idsOf(as(username, "find#Opportunities", {pageSize: 100}))
        const created = system(() => one("mantle.sales.opportunity.SalesOpportunity", {salesOpportunityId: deals.rep}))
        const parties = system(() => rowsOf("mantle.sales.opportunity.SalesOpportunityParty", {salesOpportunityId: deals.rep}))
        return {
            created,
            parties: parties.map(row => row.roleTypeId + ":" + row.partyId),
            rep: find(users.rep),
            manager: find(users.manager),
            otherDeal: as(users.rep, "get#Opportunity", {salesOpportunityId: deals.other}).opportunityFound,
            otherOrganization: as(users.rep, "get#Opportunity", {salesOpportunityId: deals.b}).opportunityFound,
            otherMove: as(users.rep, "move#Opportunity", {
                salesOpportunityId: deals.other,
                opportunityStageId: "SalesDiscovery",
                expectedRevision: "0"
            }).refused,
            bFind: as(users.rep, "find#Opportunities", {organizationPartyId: orgB}).refused,
            access: as(users.other, "check#OpportunityAccess", {salesOpportunityId: deals.rep}).recordVisible,
            // get#RecordLinkInfo's rule holds whatever the authorization: asked as the other team's rep with it off
            linkInfo: linkVisible(users.other, deals.rep),
            ownLink: linkVisible(users.rep, deals.rep)
        }
    },
    then(r) {
        r.created.organizationPartyId == orgA
        r.created.typeEnumId == "SotOpportunity"
        r.created.statusId == "SalesOppOpen"
        r.created.opportunityStageId == "SalesQualified"
        r.created.probabilityModeEnumId == "SpmStage"
        r.parties.includes("OrgInternal:" + orgA)
        r.parties.includes("SalesRepresentative:" + users.rep)
        r.parties.includes("SalesTeam:" + teams.east)
        r.rep.includes(deals.rep) && r.rep.includes(deals.mate)
        !r.rep.includes(deals.other)
        !r.rep.includes(deals.b)
        r.manager.includes(deals.rep) && r.manager.includes(deals.other)
        !r.manager.includes(deals.b)
        r.otherDeal == false
        r.otherOrganization == false
        r.otherMove.includes("RECORD_UNAVAILABLE")
        r.bFind.includes("ORGANIZATION_DENIED")
        r.access == false
        r.linkInfo == false
        r.ownLink == true
    }
})

feature("ending a rep's team membership ends the team's deals from their list, their own kept", {
    when() {
        const before = idsOf(as(users.mate, "find#Opportunities", {pageSize: 100}))
        system(() =>
            call("update#mantle.party.PartyRelationship", {
                partyRelationshipId: teams.mateMembership,
                thruDate: ec.user.nowTimestamp
            })
        )
        const after = idsOf(as(users.mate, "find#Opportunities", {pageSize: 100}))
        return {before, after}
    },
    then({before, after}) {
        before.includes(deals.rep)
        !after.includes(deals.rep)
        after.includes(deals.mate)
    }
})

feature("a stale move is refused naming the stamp; a manual probability is kept across a move, Stage copies the default", {
    when() {
        const read = revision(users.rep, deals.rep)
        const stale = as(users.rep, "move#Opportunity", {
            salesOpportunityId: deals.rep,
            opportunityStageId: "SalesDiscovery",
            expectedRevision: "1"
        }).refused
        const manual = as(users.rep, "update#Opportunity", {
            salesOpportunityId: deals.rep,
            expectedRevision: read,
            estimatedProbability: "33",
            estimatedAmount: "1200",
            currencyUomId: "USD"
        }).refused
        const moved = as(users.rep, "move#Opportunity", {
            salesOpportunityId: deals.rep,
            opportunityStageId: "SalesDiscovery",
            expectedRevision: revision(users.rep, deals.rep),
            note: "Call booked"
        }).refused
        const afterMove = system(() => one("mantle.sales.opportunity.SalesOpportunity", {salesOpportunityId: deals.rep}))
        const otherPipeline = as(users.rep, "move#Opportunity", {
            salesOpportunityId: deals.rep,
            opportunityStageId: "SPS_NOT_A_STAGE",
            expectedRevision: revision(users.rep, deals.rep)
        }).refused
        const staged = as(users.rep, "move#Opportunity", {
            salesOpportunityId: deals.rep,
            opportunityStageId: "SalesProposal",
            probabilityModeEnumId: "SpmStage",
            expectedRevision: revision(users.rep, deals.rep)
        }).refused
        const afterStage = system(() => one("mantle.sales.opportunity.SalesOpportunity", {salesOpportunityId: deals.rep}))
        const audit = system(() =>
            rowsOf("moqui.entity.EntityAuditLog", {
                changedEntityName: "mantle.sales.opportunity.SalesOpportunity",
                changedFieldName: "opportunityStageId",
                pkPrimaryValue: deals.rep
            }).map(row => row.changeReason)
        )
        return {read, stale, manual, moved, afterMove, otherPipeline, staged, afterStage, audit}
    },
    then(r) {
        r.stale.includes("REVISION_CHANGED")
        r.stale.includes("revision " + r.read)
        r.manual == ""
        r.moved == ""
        r.afterMove.opportunityStageId == "SalesDiscovery"
        r.afterMove.probabilityModeEnumId == "SpmManual"
        Number(String(r.afterMove.estimatedProbability)) == 33
        r.otherPipeline.includes("STAGE_INVALID")
        r.staged == ""
        r.afterStage.probabilityModeEnumId == "SpmStage"
        Number(String(r.afterStage.estimatedProbability)) == 50
        r.audit.includes("Call booked")
    }
})

feature("Lost needs a reason; a closed deal is not moved; a reopen clears the outcome and keeps the close history", {
    when() {
        const reason = system(() => rowsOf("moqui.basic.Enumeration", {enumTypeId: "SalesLostReason"})[0].enumId)
        const noReason = as(users.mate, "close#Opportunity", {
            salesOpportunityId: deals.mate,
            statusId: "SalesOppLost",
            expectedRevision: revision(users.mate, deals.mate)
        }).refused
        const lost = as(users.mate, "close#Opportunity", {
            salesOpportunityId: deals.mate,
            statusId: "SalesOppLost",
            lostReasonEnumId: reason,
            note: "Went with a rival",
            expectedRevision: revision(users.mate, deals.mate)
        }).refused
        const closed = system(() => one("mantle.sales.opportunity.SalesOpportunity", {salesOpportunityId: deals.mate}))
        const moveClosed = as(users.mate, "move#Opportunity", {
            salesOpportunityId: deals.mate,
            opportunityStageId: "SalesDiscovery",
            expectedRevision: revision(users.mate, deals.mate)
        }).refused
        const noWhy = as(users.mate, "reopen#Opportunity", {
            salesOpportunityId: deals.mate,
            expectedRevision: revision(users.mate, deals.mate)
        }).refused
        const reopened = as(users.mate, "reopen#Opportunity", {
            salesOpportunityId: deals.mate,
            reason: "They came back",
            expectedRevision: revision(users.mate, deals.mate)
        }).refused
        const open = system(() => one("mantle.sales.opportunity.SalesOpportunity", {salesOpportunityId: deals.mate}))
        const history = system(() =>
            rowsOf("moqui.entity.EntityAuditLog", {
                changedEntityName: "mantle.sales.opportunity.SalesOpportunity",
                changedFieldName: "statusId",
                pkPrimaryValue: deals.mate
            }).map(row => (row.newValueText || "") + ":" + (row.changeReason || ""))
        )
        const reasonHistory = system(() =>
            rowsOf("moqui.entity.EntityAuditLog", {
                changedEntityName: "mantle.sales.opportunity.SalesOpportunity",
                changedFieldName: "lostReasonEnumId",
                pkPrimaryValue: deals.mate
            }).map(row => row.newValueText || "")
        )
        return {reason, noReason, lost, closed, moveClosed, noWhy, reopened, open, history, reasonHistory}
    },
    then(r) {
        r.noReason.includes("REASON_REQUIRED")
        r.lost == ""
        r.closed.statusId == "SalesOppLost"
        r.closed.lostReasonEnumId == r.reason
        r.closed.closedDate != null
        r.moveClosed.includes("RECORD_CLOSED")
        r.noWhy.includes("REASON_REQUIRED")
        r.reopened == ""
        r.open.statusId == "SalesOppOpen"
        r.open.lostReasonEnumId == null
        r.open.closedDate == null
        r.history.includes("SalesOppLost:Went with a rival")
        r.history.includes("SalesOppOpen:They came back")
        r.reasonHistory.includes(r.reason)
    }
})

feature("a batch names the stale deal and moves the rest, each on its own", {
    when() {
        const rows = Array.from(
            as(users.manager, "find#Opportunities", {organizationPartyId: orgA, pageSize: 100}).opportunityList
        )
        const key = salesOpportunityId => rows.find(row => row.salesOpportunityId === salesOpportunityId).selectionKey
        const batch = as(users.manager, "apply#OpportunityBatch", {
            operation: "move",
            opportunityStageId: "SalesNegotiation",
            opportunityKeys: [key(deals.mate), deals.other + "@1"]
        })
        const stages = system(() => ({
            mate: one("mantle.sales.opportunity.SalesOpportunity", {salesOpportunityId: deals.mate}).opportunityStageId,
            other: one("mantle.sales.opportunity.SalesOpportunity", {salesOpportunityId: deals.other}).opportunityStageId
        }))
        return {batch, stages}
    },
    then({batch, stages}) {
        batch.refused == ""
        batch.successCount == 1
        batch.results.find(row => row.salesOpportunityId === deals.other).reasonCode == "REVISION_CHANGED"
        batch.results.find(row => row.salesOpportunityId === deals.mate).ok == true
        stages.mate == "SalesNegotiation"
        stages.other != "SalesNegotiation"
    }
})
