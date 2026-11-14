// Sales' pipeline setup (impl-sales P2; design-sales §9 Stages, Teams, LeadSources and TypesAndReasons; SalesSettings.js): a stage
// that holds open deals is retired only with a reassignment, which moves them and leaves the closed ones; a team membership is
// ended, never deleted, and a member is a person who works for the team's organization; a lead source offered to one
// organization is not offered to another, and is renamed only by an administrator of every organization it is offered to; the
// settings are refused without SALES_CONFIGURE (a team manager keeps teams only) and another organization's records answer as
// missing; the readiness names a pipeline without stages with its fix place. Standalone: spec-local organizations, users and
// records; the services check the permissions themselves, so they are called with artifact authorization off.
// Run: ./moq test mr-mantle --spec SalesPipelineSetup
const prefix = "SPS"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const service = "mantle.sales.OpportunityServices."

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
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
    make("mantle.party.Organization", {partyId, organizationName: name})
    make("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
function person(kind, organizationPartyIds) {
    const id = prefix + "_" + kind.toUpperCase()
    make("mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    make("mantle.party.Person", {partyId: id, firstName: "Pipeline setup", lastName: kind})
    for (const toPartyId of organizationPartyIds)
        make("mantle.party.PartyRelationship", {
            fromPartyId: id,
            toPartyId,
            relationshipTypeEnumId: "PrtAgent",
            toRoleTypeId: "OrgInternal",
            fromDate: 0
        })
    return id
}
// a user of the organizations in a spec group holding the permissions
function user(kind, organizationPartyIds, permissions) {
    const id = person(kind, organizationPartyIds)
    make("moqui.security.UserGroup", {userGroupId: id, description: "Pipeline setup " + kind})
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
    return id
}
// A call as the user: its result, or the refusal's message (refused), in an error frame of its own.
function as(username, verb, parameters = {}) {
    login(username)
    const was = ec.artifactExecution.disableAuthz()
    ec.message.pushErrors()
    try {
        const out =
            ec.service
                .sync()
                .name(service + verb)
                .parameters(parameters)
                .requireNewTransaction(true)
                .call() || {}
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
const read = (entity, conditions) => system(() => ec.entity.find(entity).condition(conditions).one())
// the revision a write names, as the services read it (EntityLib.js ms of lastUpdatedStamp)
const entityLib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const revision = row => String(entityLib.ms(row.lastUpdatedStamp) ?? 0)
const users = {}
const ids = {}

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Pipeline setup A")
            organization(orgB, "Pipeline setup B")
            // the administrator of A (configure), of both, a team manager of A and a reader of A who configures nothing
            users.admin = user("admin", [orgA], ["SALES_VIEW", "SALES_CONFIGURE"])
            users.adminBoth = user("adminboth", [orgA, orgB], ["SALES_VIEW", "SALES_CONFIGURE"])
            users.manager = user("manager", [orgA], ["SALES_VIEW", "SALES_TEAM_VIEW", "SALES_TEAM_MANAGE"])
            users.reader = user("reader", [orgA], ["SALES_VIEW"])
            // P4: a configurer of every organization (SALES_ALL_ORGANIZATIONS), who alone changes the instance's lost reasons
            users.adminAll = user("adminall", [orgA], ["SALES_VIEW", "SALES_CONFIGURE", "SALES_ALL_ORGANIZATIONS"])
            ids.repA = person("repa", [orgA])
            ids.repB = person("repb", [orgB])
        })
    }
})

feature("a stage holding open deals is retired only with a reassignment, which moves them and leaves the closed ones", {
    when() {
        const pipeline = as(users.admin, "store#Pipeline", {organizationPartyId: orgA, pipelineName: "Spec pipeline"})
        const first = as(users.admin, "store#Stage", {salesPipelineId: pipeline.salesPipelineId, description: "First"})
        const second = as(users.admin, "store#Stage", {salesPipelineId: pipeline.salesPipelineId, description: "Second"})
        const duplicate = as(users.admin, "store#Stage", {salesPipelineId: pipeline.salesPipelineId, description: "second"})
        const otherStage = "SalesQualified"
        system(() => {
            for (const [suffix, statusId] of [
                ["OPEN", "SalesOppOpen"],
                ["NEW", null],
                ["WON", "SalesOppWon"]
            ])
                make("mantle.sales.opportunity.SalesOpportunity", {
                    salesOpportunityId: prefix + "_OPP_" + suffix,
                    organizationPartyId: orgA,
                    opportunityStageId: first.opportunityStageId,
                    statusId
                })
        })
        const stage = () => read("mantle.sales.opportunity.SalesOpportunityStage", {opportunityStageId: first.opportunityStageId})
        const withoutTarget = as(users.admin, "store#Stage", {
            opportunityStageId: first.opportunityStageId,
            retire: true,
            expectedRevision: revision(stage())
        })
        const otherPipeline = as(users.admin, "store#Stage", {
            opportunityStageId: first.opportunityStageId,
            retire: true,
            reassignStageId: otherStage,
            expectedRevision: revision(stage())
        })
        const stale = as(users.admin, "store#Stage", {
            opportunityStageId: first.opportunityStageId,
            description: "Renamed",
            expectedRevision: "1"
        })
        // the second stage moves up before the first, then the first is retired into it
        const moved = as(users.admin, "store#Stage", {
            opportunityStageId: second.opportunityStageId,
            move: "up",
            expectedRevision: revision(
                read("mantle.sales.opportunity.SalesOpportunityStage", {opportunityStageId: second.opportunityStageId})
            )
        })
        const order = system(() =>
            Array.from(
                ec.entity
                    .find("mantle.sales.opportunity.SalesOpportunityStage")
                    .condition("salesPipelineId", pipeline.salesPipelineId)
                    .orderBy("sequenceNum")
                    .list()
            ).map(row => row.description)
        )
        const retired = as(users.admin, "store#Stage", {
            opportunityStageId: first.opportunityStageId,
            retire: true,
            reassignStageId: second.opportunityStageId,
            expectedRevision: revision(stage())
        })
        const stageOf = suffix =>
            read("mantle.sales.opportunity.SalesOpportunity", {salesOpportunityId: prefix + "_OPP_" + suffix}).opportunityStageId
        // the pipeline's end is refused while its stages hold open deals
        const pipelineRow = read("mantle.sales.opportunity.SalesPipeline", {salesPipelineId: pipeline.salesPipelineId})
        const endPipeline = as(users.admin, "store#Pipeline", {
            salesPipelineId: pipeline.salesPipelineId,
            end: true,
            expectedRevision: revision(pipelineRow)
        })
        return {
            pipeline,
            duplicate,
            withoutTarget,
            otherPipeline,
            stale,
            moved,
            order,
            retired,
            first: first.opportunityStageId,
            second: second.opportunityStageId,
            stages: {open: stageOf("OPEN"), fresh: stageOf("NEW"), won: stageOf("WON")},
            retiredRow: stage(),
            endPipeline
        }
    },
    then(r) {
        r.pipeline.refused == ""
        r.duplicate.refused.includes("DUPLICATE_VALUE")
        r.withoutTarget.refused.includes("STAGE_IN_USE")
        r.otherPipeline.refused.includes("STAGE_INVALID")
        r.stale.refused.includes("REVISION_CHANGED")
        r.moved.refused == ""
        JSON.stringify(r.order) == JSON.stringify(["Second", "First"])
        r.retired.refused == ""
        r.retired.moved == 2
        r.stages.open == r.second
        r.stages.fresh == r.second
        // a closed deal keeps the retired stage, which is kept, ended
        r.stages.won == r.first
        r.retiredRow != null && r.retiredRow.thruDate != null
        r.endPipeline.refused.includes("PIPELINE_IN_USE")
    }
})

feature("a team membership is ended, never deleted; a member works for the team's organization, once at a time", {
    when() {
        const team = as(users.manager, "store#SalesTeam", {organizationPartyId: orgA, teamName: "Spec team"})
        const joined = as(users.manager, "store#SalesTeamMember", {teamPartyId: team.teamPartyId, partyId: ids.repA})
        const again = as(users.manager, "store#SalesTeamMember", {teamPartyId: team.teamPartyId, partyId: ids.repA})
        const outsider = as(users.manager, "store#SalesTeamMember", {teamPartyId: team.teamPartyId, partyId: ids.repB})
        const backdated = as(users.manager, "store#SalesTeamMember", {
            teamPartyId: team.teamPartyId,
            partyId: ids.repA,
            fromDate: new Date(Date.now() - 86400000).getTime()
        })
        const membership = () => read("mantle.party.PartyRelationship", {partyRelationshipId: joined.partyRelationshipId})
        const ended = as(users.manager, "store#SalesTeamMember", {
            teamPartyId: team.teamPartyId,
            partyRelationshipId: joined.partyRelationshipId,
            expectedRevision: revision(membership())
        })
        // a later membership of the same person, the team then ended with it
        const rejoined = as(users.manager, "store#SalesTeamMember", {
            teamPartyId: team.teamPartyId,
            partyId: ids.repA,
            fromDate: new Date(Date.now() + 86400000).getTime(),
            roleTypeId: "Manager"
        })
        const teamRead = as(users.manager, "get#SalesSetup", {organizationPartyId: orgA, includeEnded: true})
        const found = teamRead.teams?.find(row => row.teamPartyId === team.teamPartyId)
        const endTeam = as(users.manager, "store#SalesTeam", {
            teamPartyId: team.teamPartyId,
            end: true,
            expectedRevision: found?.revision
        })
        const rows = system(() =>
            Array.from(
                ec.entity
                    .find("mantle.party.PartyRelationship")
                    .condition("relationshipTypeEnumId", "PrtSalesTeamMember")
                    .condition("toPartyId", team.teamPartyId)
                    .list()
            ).map(row => ({ended: row.thruDate != null}))
        )
        // the other organization's team answers as a missing one
        const otherTeam = as(users.adminBoth, "store#SalesTeam", {organizationPartyId: orgB, teamName: "B team"})
        const crossed = as(users.manager, "store#SalesTeamMember", {teamPartyId: otherTeam.teamPartyId, partyId: ids.repA})
        // a team ending in two days: a membership after its end is refused, one joining now ends with it
        const dated = as(users.manager, "store#SalesTeam", {organizationPartyId: orgA, teamName: "Spec dated team"})
        const datedRevision = as(users.manager, "get#SalesSetup", {organizationPartyId: orgA}).teams?.find(
            row => row.teamPartyId === dated.teamPartyId
        )?.revision
        const teamEnd = Date.now() + 2 * 86400000
        const scheduled = as(users.manager, "store#SalesTeam", {
            teamPartyId: dated.teamPartyId,
            thruDate: teamEnd,
            expectedRevision: datedRevision
        })
        const afterEnd = as(users.manager, "store#SalesTeamMember", {
            teamPartyId: dated.teamPartyId,
            partyId: ids.repA,
            fromDate: teamEnd + 86400000
        })
        const withTeam = as(users.manager, "store#SalesTeamMember", {teamPartyId: dated.teamPartyId, partyId: ids.repA})
        const withTeamRow = read("mantle.party.PartyRelationship", {partyRelationshipId: withTeam.partyRelationshipId})
        return {
            team,
            joined,
            again,
            outsider,
            backdated,
            ended,
            rejoined,
            endTeam,
            rows,
            crossed,
            scheduled,
            afterEnd,
            withTeam,
            withTeamThru: entityLib.ms(withTeamRow?.thruDate),
            teamEnd
        }
    },
    then(r) {
        r.team.refused == ""
        r.joined.refused == ""
        r.again.refused.includes("MEMBER_EXISTS")
        r.outsider.refused.includes("MEMBER_INVALID")
        r.backdated.refused.includes("DATE_INVALID")
        r.ended.refused == ""
        r.rejoined.refused == ""
        r.endTeam.refused == ""
        // both memberships kept, each ended (the later one at its own start)
        r.rows.length == 2
        r.rows.every(row => row.ended)
        r.crossed.refused.includes("RECORD_UNAVAILABLE")
        // no membership outlives its team
        r.scheduled.refused == ""
        r.afterEnd.refused.includes("DATE_INVALID")
        r.withTeam.refused == ""
        Math.abs(r.withTeamThru - r.teamEnd) < 1000
    }
})

feature("a lead source offered to one organization is not offered to another, and is renamed only within the scope", {
    when() {
        const created = as(users.admin, "store#LeadSource", {
            organizationPartyId: orgA,
            description: "Spec trade fair",
            dataSourceTypeEnumId: "TRADE_SHOW"
        })
        const wrongType = as(users.admin, "store#LeadSource", {
            organizationPartyId: orgA,
            description: "Spec bought list",
            dataSourceTypeEnumId: "DST_PURCHASED_DATA"
        })
        const offered = organizationPartyId => as(users.adminBoth, "get#SalesOptions", {organizationPartyId}).sources || []
        const inA = offered(orgA).map(row => row.dataSourceId)
        const inB = offered(orgB).map(row => row.dataSourceId)
        const notTheirs = as(users.admin, "store#LeadSource", {
            dataSourceId: created.dataSourceId,
            organizationPartyId: orgB,
            bind: true
        })
        const toB = as(users.adminBoth, "store#LeadSource", {
            dataSourceId: created.dataSourceId,
            organizationPartyId: orgB,
            bind: true
        })
        const source = () => read("moqui.basic.DataSource", {dataSourceId: created.dataSourceId})
        const renameShared = as(users.admin, "store#LeadSource", {
            dataSourceId: created.dataSourceId,
            description: "Spec fair renamed",
            expectedRevision: revision(source())
        })
        const unbound = as(users.adminBoth, "store#LeadSource", {
            dataSourceId: created.dataSourceId,
            organizationPartyId: orgB,
            unbind: true
        })
        const inBAfter = offered(orgB).map(row => row.dataSourceId)
        const renamed = as(users.admin, "store#LeadSource", {
            dataSourceId: created.dataSourceId,
            description: "Spec fair renamed",
            expectedRevision: revision(source())
        })
        return {created, wrongType, inA, inB, notTheirs, toB, renameShared, unbound, inBAfter, renamed, id: created.dataSourceId}
    },
    then(r) {
        r.created.refused == ""
        r.wrongType.refused.includes("TYPE_INVALID")
        r.inA.includes(r.id)
        !r.inB.includes(r.id)
        r.notTheirs.refused.includes("ORGANIZATION_DENIED")
        r.toB.refused == ""
        r.renameShared.refused.includes("SOURCE_SHARED")
        r.unbound.refused == ""
        !r.inBAfter.includes(r.id)
        r.renamed.refused == ""
    }
})

feature("the settings are refused without SALES_CONFIGURE, the shared pipeline outside every organization's scope", {
    when() {
        return {
            managerStage: as(users.manager, "store#Stage", {salesPipelineId: "SalesDefault", description: "Manager's"}),
            managerReason: as(users.manager, "store#LostReason", {description: "Manager's reason"}),
            readerTeam: as(users.reader, "store#SalesTeam", {organizationPartyId: orgA, teamName: "Reader's"}),
            readerSetup: as(users.reader, "get#SalesSetup", {organizationPartyId: orgA}),
            readerOptions: as(users.reader, "get#SalesOptions", {organizationPartyId: orgA}),
            otherOptions: as(users.reader, "get#SalesOptions", {organizationPartyId: orgB}),
            sharedStage: as(users.admin, "store#Stage", {salesPipelineId: "SalesDefault", description: "Admin's"}),
            otherPipeline: as(users.admin, "store#Pipeline", {organizationPartyId: orgB, pipelineName: "Not mine"}),
            // P4 (the user's call, impl-sales §4 Nov 13): the lost reasons are the instance's, changed with every organization's
            // scope only; a configurer of one organization reads them
            reason: as(users.admin, "store#LostReason", {description: "Spec reason"}),
            adminSetup: as(users.admin, "get#SalesSetup", {organizationPartyId: orgA}),
            reasonAll: as(users.adminAll, "store#LostReason", {description: "Spec reason"}),
            allSetup: as(users.adminAll, "get#SalesSetup", {organizationPartyId: orgA}),
            managerSetup: as(users.manager, "get#SalesSetup", {organizationPartyId: orgA})
        }
    },
    then(r) {
        r.managerStage.refused.includes("PERMISSION_DENIED")
        r.managerReason.refused.includes("PERMISSION_DENIED")
        r.readerTeam.refused.includes("PERMISSION_DENIED")
        r.readerSetup.refused.includes("PERMISSION_DENIED")
        r.readerOptions.refused == ""
        r.readerOptions.defaultPipelineId == "SalesDefault"
        r.readerOptions.pipelines.find(row => row.salesPipelineId === "SalesDefault").stages.length >= 4
        r.otherOptions.refused.includes("ORGANIZATION_DENIED")
        r.sharedStage.refused.includes("ORGANIZATION_DENIED")
        r.otherPipeline.refused.includes("ORGANIZATION_DENIED")
        r.reason.refused.includes("ORGANIZATION_DENIED")
        r.adminSetup.canEditReasons == false
        r.adminSetup.lostReasons.length > 0
        r.reasonAll.refused == ""
        r.allSetup.canEditReasons == true
        // a team manager reads the teams and nothing of the configuration
        r.managerSetup.refused == ""
        r.managerSetup.canConfigure == false
        r.managerSetup.pipelines.length == 0
    }
})

feature("the readiness names a pipeline without stages with its fix place, and a missing team and source", {
    when() {
        const pipeline = as(users.adminBoth, "store#Pipeline", {organizationPartyId: orgB, pipelineName: "Empty pipeline"})
        login(users.adminBoth)
        const was = ec.artifactExecution.disableAuthz()
        let checks
        try {
            checks = ec.service
                .sync()
                .name("mantle.sales.SalesWorkspaceServices.get#SalesReadiness")
                .parameters({organizationPartyId: orgB})
                .call().checks
        } finally {
            if (!was) ec.artifactExecution.enableAuthz()
            login("john.doe")
        }
        const refused = (() => {
            login(users.manager)
            ec.message.pushErrors()
            try {
                ec.service
                    .sync()
                    .name("mantle.sales.SalesWorkspaceServices.get#SalesReadiness")
                    .parameters({})
                    .disableAuthz()
                    .call()
                return ec.message.getErrorsString()
            } catch (error) {
                return String(error.message)
            } finally {
                ec.message.clearErrors()
                ec.message.popErrors()
                login("john.doe")
            }
        })()
        const byKey = Object.fromEntries(Array.from(checks).map(check => [check.checkKey, check]))
        // A's administrator, asking for every organization of theirs, reads A's checks and none of B's
        const ownChecks = (() => {
            login(users.admin)
            try {
                return Array.from(
                    ec.service
                        .sync()
                        .name("mantle.sales.SalesWorkspaceServices.get#SalesReadiness")
                        .parameters({})
                        .disableAuthz()
                        .call().checks
                ).map(check => check.organizationPartyId)
            } finally {
                login("john.doe")
            }
        })()
        // an open deal of B on the shared pipeline is counted for B's reader, not for A's
        system(() =>
            make("mantle.sales.opportunity.SalesOpportunity", {
                salesOpportunityId: prefix + "_OPP_SHARED_B",
                organizationPartyId: orgB,
                opportunityStageId: "SalesQualified",
                statusId: "SalesOppOpen"
            })
        )
        const sharedCount = (user, organizationPartyId) =>
            as(user, "get#SalesSetup", {organizationPartyId})
                .pipelines?.find(row => row.salesPipelineId === "SalesDefault")
                ?.stages.find(stage => stage.opportunityStageId === "SalesQualified")?.openCount
        return {
            pipeline,
            byKey,
            refused,
            ownChecks,
            countA: sharedCount(users.admin, orgA),
            countB: sharedCount(users.adminBoth, orgB)
        }
    },
    then({pipeline, byKey, refused, ownChecks, countA, countB}) {
        ownChecks.includes(orgA)
        !ownChecks.includes(orgB)
        countA == 0
        countB == 1
        byKey["sales.defaultPipeline"].state == "ready"
        byKey["sales.pipelineStages"].state == "failed"
        byKey["sales.pipelineStages"].fixRoute == "salesStages"
        byKey["sales.pipelineStages"].fixId == pipeline.salesPipelineId
        byKey["sales.pipelineStages"].message.includes("Empty pipeline")
        // the team made in the second feature has no member
        byKey["sales.teams"].state == "warning"
        byKey["sales.leadSources"].state == "warning"
        byKey["sales.leadSources"].fixRoute == "salesLeadSources"
        refused.includes("PERMISSION_DENIED")
    }
})
