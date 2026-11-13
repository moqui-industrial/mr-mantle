// Sales' pipeline setup (mantle.sales.OpportunityServices, its settings verbs, and SalesWorkspaceServices.get#SalesReadiness;
// IronStone Sales design §9 Settings, Stages, Teams, LeadSources and TypesAndReasons, §12.1 O and S; impl-sales P2, SAL-CRM).
//
// - Pipelines (SalesPipeline): an organization's, or the instance's shared one (no organization), which every organization is
//   offered until it sets a default of its own; one default in effect per organization; an optional team narrows a pipeline to
//   that team. Ended, never deleted; a pipeline whose stages hold open deals is not ended.
// - Stages (SalesOpportunityStage): a pipeline's, ordered by sequence (moved up or down, or numbered), with a default
//   probability and a fold flag. A stage that holds open deals (not Won or Lost) is retired only with another current stage of
//   the same pipeline to move them to; closed deals keep it. Never deleted.
// - Teams: an Organization party with the SalesTeam role, owned by its organization, dated by its PrtSalesTeamOf row; members
//   are dated PrtSalesTeamMember rows from a person who works for the organization (an agent or employee in effect), as a
//   SalesRepresentative or a Manager, starting and ending now or later (access changes prospectively). Ended, never deleted;
//   ending a team ends its memberships. Membership grants no permission. No People record is read: People's directory is the
//   BOSS lookup's, for a caller who reads it.
// - Lead sources: moqui.basic.DataSource rows of a LEAD_SOURCE type, shared by the instance, offered to an organization by a
//   dated SalesLeadSourceBinding. A source's name or type is changed only by one whose scope covers every organization it is
//   offered to; a binding is added or ended for an organization of the caller's.
// - Lost reasons: the SalesLostReason Enumeration values, the instance's, added, renamed, reordered and ended (thruDate),
//   never deleted.
// - get#SalesOptions: what an organization offers now (types, outcomes, pipelines and stages, teams, sources, reasons, plans),
//   to any Sales reader of it; get#SalesSetup: the same with the ended rows, counts and edit flags, to its configurer or team
//   manager; get#SalesReadiness: the setup findings, each with its owner's place as a route key.
//
// Checks (SalesAccess.js): the settings verbs need SALES_CONFIGURE, the team verbs SALES_CONFIGURE or SALES_TEAM_MANAGE, each with
// the organization in the caller's scope (a read: an edit permission alone has no organization); the shared pipeline needs every
// organization's scope. Refusals carry reason codes; writes of an existing row name the revision they read (REVISION_CHANGED).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const salesAccess = ec.resource.script("component://mr-mantle/service/mantle/sales/SalesAccess.js")
const {find, one, rows, denied, call, ms} = lib

const PIPELINE = "mantle.sales.opportunity.SalesPipeline"
const STAGE = "mantle.sales.opportunity.SalesOpportunityStage"
const OPPORTUNITY = "mantle.sales.opportunity.SalesOpportunity"
const BINDING = "mantle.sales.opportunity.SalesLeadSourceBinding"
const RELATIONSHIP = "mantle.party.PartyRelationship"
const SOURCE = "moqui.basic.DataSource"
const ENUM = "moqui.basic.Enumeration"
const {of: TEAM_OF, member: TEAM_MEMBER} = salesAccess.teamRelationships
const closedStatuses = ["SalesOppWon", "SalesOppLost"]
const memberRoles = {SalesRepresentative: "Representative", Manager: "Manager"}
const workerRelationships = ["PrtAgent", "PrtEmployee"]
const minuteMs = 60 * 1000
const sourceCap = 500

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const flag = value => value === true || value === "true" || value === "Y"
const nowMs = () => ms(ec.user.nowTimestamp)
const revisionOf = row => String(ms(row?.lastUpdatedStamp) ?? 0)
const dateText = value => (value == null || value === "" ? "" : lib.dateText(value))
const organizationName = partyId =>
    partyId ? one("mantle.party.Organization", {partyId})?.organizationName || partyId : "Every organization"
const inEffect = (row, at = nowMs()) => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at
const ended = (row, at = nowMs()) => (ms(row.thruDate) ?? Infinity) <= at
const stateText = (row, at = nowMs()) =>
    ended(row, at)
        ? "Ended " + dateText(row.thruDate)
        : (ms(row.fromDate) ?? -Infinity) > at
          ? "From " + dateText(row.fromDate)
          : row.thruDate
            ? "Ends " + dateText(row.thruDate)
            : "Current"

function requireRevision(row, expected, label) {
    const revision = revisionOf(row)
    if (text(expected) !== revision)
        denied("REVISION_CHANGED", label + " changed since you read it; open it again (revision " + revision + ")")
}
// A date a change takes effect: now when not given, never before now (a minute's grace): access changes prospectively.
function fromNow(value, label) {
    if (blank(value)) return ec.user.nowTimestamp
    if (ms(value) < nowMs() - minuteMs) denied("DATE_INVALID", label + " is now or later")
    return value
}

// ===== scope =====
function signedIn() {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in to change Sales' settings")
    return salesAccess.scope()
}
function configurer() {
    const userScope = signedIn()
    salesAccess.requireCapability(userScope, "configure")
    return userScope
}
function teamManager() {
    const userScope = signedIn()
    if (!userScope.capabilities.configure && !userScope.capabilities.teamManage)
        denied("PERMISSION_DENIED", "Sales teams are kept by a Sales administrator or a sales manager")
    return userScope
}
// The organization of a pipeline in the caller's scope; the shared pipeline (none) needs every organization's.
function requirePipelineScope(userScope, organizationPartyId) {
    if (organizationPartyId) return salesAccess.requireOrganization(userScope, organizationPartyId)
    if (userScope.organizationPartyIds != null)
        denied("ORGANIZATION_DENIED", "The shared pipeline is changed by an administrator of every organization")
    return null
}

// ===== pipelines and stages =====
// The pipelines an organization is offered: its own and the shared ones, in effect unless includeEnded.
function pipelinesOf(organizationPartyId, includeEnded = false) {
    const factory = ec.entity.conditionFactory
    const found = Array.from(
        find(PIPELINE)
            .condition(
                factory.makeCondition(
                    factory.makeCondition("organizationPartyId", "equals", organizationPartyId),
                    "or",
                    factory.makeCondition("organizationPartyId", "is-null", null)
                )
            )
            .orderBy(["organizationPartyId", "pipelineName"])
            .list()
    )
    return includeEnded ? found : found.filter(row => !ended(row))
}
// The organization's default pipeline in effect: its own default, else the shared one; null when none.
function defaultPipeline(organizationPartyId) {
    const current = pipelinesOf(organizationPartyId).filter(row => inEffect(row) && row.defaultFlag === "Y")
    return (
        current.find(row => row.organizationPartyId === organizationPartyId) ||
        current.find(row => !row.organizationPartyId) ||
        null
    )
}
function stagesOf(salesPipelineId, includeEnded = false) {
    const found = rows(STAGE, {salesPipelineId}).sort(
        (a, b) => (a.sequenceNum ?? 0) - (b.sequenceNum ?? 0) || String(a.description).localeCompare(String(b.description))
    )
    return includeEnded ? found : found.filter(row => !ended(row))
}
// The open deals on a stage: not Won or Lost.
function openOnStage(opportunityStageId) {
    return Array.from(
        find(OPPORTUNITY)
            .condition("opportunityStageId", opportunityStageId)
            .condition("statusId", "not-in", closedStatuses)
            .selectField("salesOpportunityId")
            .list()
    )
        .concat(
            Array.from(
                find(OPPORTUNITY)
                    .condition("opportunityStageId", opportunityStageId)
                    .condition("statusId", "is-null", null)
                    .selectField("salesOpportunityId")
                    .list()
            )
        )
        .map(row => row.salesOpportunityId)
}
function requirePipeline(userScope, salesPipelineId) {
    const pipeline = text(salesPipelineId) ? one(PIPELINE, {salesPipelineId: text(salesPipelineId)}) : null
    if (!pipeline) denied("RECORD_UNAVAILABLE", "Pipeline " + (salesPipelineId || "") + " is not available")
    try {
        requirePipelineScope(userScope, pipeline.organizationPartyId)
    } catch (error) {
        // another organization's pipeline answers as a missing one; the shared one names its rule
        if (pipeline.organizationPartyId) denied("RECORD_UNAVAILABLE", "Pipeline " + salesPipelineId + " is not available")
        throw error
    }
    return pipeline
}

// store#Pipeline: a new pipeline of an organization, or a pipeline's name, description, team, default flag or end.
function storePipeline(p) {
    const userScope = configurer()
    const teamPartyId = text(p.teamPartyId)
    const checkTeam = organizationPartyId => {
        if (!teamPartyId) return
        const team = teamRow(teamPartyId)
        if (!team || team.organizationPartyId !== organizationPartyId || ended(team.relationship))
            denied("TEAM_UNAVAILABLE", "Choose a current team of the pipeline's organization")
    }
    if (!text(p.salesPipelineId)) {
        const organizationPartyId = text(p.organizationPartyId)
        if (!organizationPartyId) denied("ORGANIZATION_REQUIRED", "Choose the pipeline's organization")
        salesAccess.requireOrganization(userScope, organizationPartyId)
        const pipelineName = text(p.pipelineName)
        if (!pipelineName) denied("NAME_REQUIRED", "Give the pipeline a name")
        checkTeam(organizationPartyId)
        const fromDate = fromNow(p.fromDate, "A pipeline starts")
        if (flag(p.defaultFlag)) clearDefault(organizationPartyId, null)
        const created = call("create#" + PIPELINE, {
            organizationPartyId,
            pipelineName,
            description: text(p.description),
            teamPartyId,
            defaultFlag: flag(p.defaultFlag) ? "Y" : "N",
            fromDate
        })
        return {salesPipelineId: created.salesPipelineId}
    }
    const pipeline = requirePipeline(userScope, p.salesPipelineId)
    if (ended(pipeline)) denied("RECORD_ENDED", (pipeline.pipelineName || pipeline.salesPipelineId) + " has ended")
    requireRevision(pipeline, p.expectedRevision, "This pipeline")
    const changes = {salesPipelineId: pipeline.salesPipelineId}
    if (p.pipelineName != null) {
        changes.pipelineName = text(p.pipelineName)
        if (!changes.pipelineName) denied("NAME_REQUIRED", "Give the pipeline a name")
    }
    if (p.description != null) changes.description = text(p.description)
    if (p.teamPartyId != null) {
        checkTeam(pipeline.organizationPartyId)
        changes.teamPartyId = teamPartyId
    }
    if (p.defaultFlag != null) {
        changes.defaultFlag = flag(p.defaultFlag) ? "Y" : "N"
        if (changes.defaultFlag === "Y") clearDefault(pipeline.organizationPartyId, pipeline.salesPipelineId)
    }
    if (flag(p.end) || !blank(p.thruDate)) {
        const thruDate = blank(p.thruDate) ? ec.user.nowTimestamp : fromNow(p.thruDate, "A pipeline ends")
        const open = stagesOf(pipeline.salesPipelineId).reduce(
            (count, stage) => count + openOnStage(stage.opportunityStageId).length,
            0
        )
        if (open) denied("PIPELINE_IN_USE", "Move the " + open + " open deals off its stages before ending this pipeline")
        changes.thruDate = thruDate
    }
    call("update#" + PIPELINE, changes)
    return {salesPipelineId: pipeline.salesPipelineId}
}
// One default per organization: the default flag of the organization's other pipelines is cleared.
function clearDefault(organizationPartyId, exceptId) {
    for (const row of rows(PIPELINE, {organizationPartyId: organizationPartyId || null}))
        if (row.salesPipelineId !== exceptId && row.defaultFlag === "Y" && !ended(row))
            call("update#" + PIPELINE, {salesPipelineId: row.salesPipelineId, defaultFlag: "N"})
}

// Number a pipeline's current stages 10, 20, 30... in their order, so a move swaps neighbours.
function renumber(salesPipelineId) {
    const current = stagesOf(salesPipelineId)
    current.forEach((stage, index) => {
        if (stage.sequenceNum !== (index + 1) * 10)
            call("update#" + STAGE, {opportunityStageId: stage.opportunityStageId, sequenceNum: (index + 1) * 10})
    })
    return stagesOf(salesPipelineId)
}
// store#Stage: a new stage of a pipeline, a stage's name, probability, fold flag or order (a number, or a move up or down), or
// its retirement with the reassignment of its open deals.
function storeStage(p) {
    const userScope = configurer()
    const sequenceNum = blank(p.sequenceNum) ? null : Number(text(p.sequenceNum))
    if (sequenceNum != null && (!Number.isInteger(sequenceNum) || sequenceNum < 0 || sequenceNum > 9999))
        denied("SEQUENCE_INVALID", "The order is a whole number from 0 to 9999")
    const probability = blank(p.defaultProbability) ? null : Number(text(p.defaultProbability))
    if (probability != null && (!Number.isFinite(probability) || probability < 0 || probability > 100))
        denied("PROBABILITY_INVALID", "The probability is a percentage from 0 to 100")
    if (!text(p.opportunityStageId)) {
        const pipeline = requirePipeline(userScope, p.salesPipelineId)
        if (ended(pipeline)) denied("RECORD_ENDED", (pipeline.pipelineName || pipeline.salesPipelineId) + " has ended")
        const description = text(p.description)
        if (!description) denied("NAME_REQUIRED", "Give the stage a name")
        const current = stagesOf(pipeline.salesPipelineId)
        if (current.some(row => String(row.description || "").toLowerCase() === description.toLowerCase()))
            denied("DUPLICATE_VALUE", description + " is already a stage of this pipeline")
        const last = current.length ? (current[current.length - 1].sequenceNum ?? 0) : 0
        const created = call("create#" + STAGE, {
            salesPipelineId: pipeline.salesPipelineId,
            description,
            defaultProbability: probability,
            sequenceNum: sequenceNum ?? last + 10,
            foldFlag: flag(p.foldFlag) ? "Y" : "N",
            fromDate: ec.user.nowTimestamp
        })
        return {opportunityStageId: created.opportunityStageId, moved: 0}
    }
    const stage = one(STAGE, {opportunityStageId: text(p.opportunityStageId)})
    if (!stage) denied("RECORD_UNAVAILABLE", "Stage " + p.opportunityStageId + " is not available")
    const pipeline = requirePipeline(userScope, stage.salesPipelineId)
    if (ended(stage)) denied("RECORD_ENDED", (stage.description || stage.opportunityStageId) + " is retired")
    requireRevision(stage, p.expectedRevision, "This stage")
    const move = text(p.move)
    if (move) {
        if (!["up", "down"].includes(move)) denied("VALUE_INVALID", "A stage moves up or down")
        const current = renumber(pipeline.salesPipelineId)
        const index = current.findIndex(row => row.opportunityStageId === stage.opportunityStageId)
        const other = current[move === "up" ? index - 1 : index + 1]
        if (other) {
            call("update#" + STAGE, {opportunityStageId: stage.opportunityStageId, sequenceNum: other.sequenceNum})
            call("update#" + STAGE, {opportunityStageId: other.opportunityStageId, sequenceNum: current[index].sequenceNum})
        }
        return {opportunityStageId: stage.opportunityStageId, moved: 0}
    }
    const changes = {opportunityStageId: stage.opportunityStageId}
    if (p.description != null) {
        const description = text(p.description)
        if (!description) denied("NAME_REQUIRED", "Give the stage a name")
        if (
            description !== stage.description &&
            stagesOf(pipeline.salesPipelineId).some(
                row =>
                    row.opportunityStageId !== stage.opportunityStageId &&
                    String(row.description || "").toLowerCase() === description.toLowerCase()
            )
        )
            denied("DUPLICATE_VALUE", description + " is already a stage of this pipeline")
        changes.description = description
    }
    if (p.defaultProbability != null) changes.defaultProbability = probability
    if (p.sequenceNum != null) changes.sequenceNum = sequenceNum
    if (p.foldFlag != null) changes.foldFlag = flag(p.foldFlag) ? "Y" : "N"
    let moved = 0
    if (flag(p.retire)) {
        const open = openOnStage(stage.opportunityStageId)
        const reassignStageId = text(p.reassignStageId)
        if (open.length && !reassignStageId)
            denied(
                "STAGE_IN_USE",
                (stage.description || stage.opportunityStageId) +
                    " holds " +
                    open.length +
                    " open deals: choose the stage they move to"
            )
        if (reassignStageId) {
            const target = one(STAGE, {opportunityStageId: reassignStageId})
            if (
                !target ||
                target.opportunityStageId === stage.opportunityStageId ||
                target.salesPipelineId !== stage.salesPipelineId ||
                !inEffect(target)
            )
                denied("STAGE_INVALID", "Move the open deals to another current stage of the same pipeline")
            // each open deal moves, its stage audit-logged; closed deals keep the retired stage
            for (const salesOpportunityId of open)
                call("update#" + OPPORTUNITY, {salesOpportunityId, opportunityStageId: target.opportunityStageId})
            moved = open.length
        }
        changes.thruDate = ec.user.nowTimestamp
    }
    if (Object.keys(changes).length > 1) call("update#" + STAGE, changes)
    return {opportunityStageId: stage.opportunityStageId, moved}
}

// ===== teams =====
// A sales team as read: its party, name, organization (its PrtSalesTeamOf row) and that row; null for a party that is no team.
function teamRow(teamPartyId) {
    if (!teamPartyId) return null
    if (!one("mantle.party.PartyRole", {partyId: teamPartyId, roleTypeId: "SalesTeam"})) return null
    const relationship = Array.from(
        find(RELATIONSHIP, {relationshipTypeEnumId: TEAM_OF, fromPartyId: teamPartyId}).orderBy("-fromDate").limit(1).list()
    )[0]
    if (!relationship) return null
    const organization = one("mantle.party.Organization", {partyId: teamPartyId})
    return {
        teamPartyId,
        teamName: organization?.organizationName || teamPartyId,
        organizationPartyId: relationship.toPartyId,
        relationship,
        organization
    }
}
function requireTeam(userScope, teamPartyId) {
    const team = teamRow(text(teamPartyId))
    if (!team || !salesAccess.covers(userScope, team.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Team " + (teamPartyId || "") + " is not available")
    return team
}
// The teams of an organization, by name: in effect, or every one with includeEnded.
function teamsOf(organizationPartyId, includeEnded = false) {
    const relationships = rows(RELATIONSHIP, {relationshipTypeEnumId: TEAM_OF, toPartyId: organizationPartyId})
    const latest = {}
    for (const row of relationships)
        if (!latest[row.fromPartyId] || (ms(row.fromDate) ?? 0) > (ms(latest[row.fromPartyId].fromDate) ?? 0))
            latest[row.fromPartyId] = row
    return Object.keys(latest)
        .map(teamRow)
        .filter(team => team && team.organizationPartyId === organizationPartyId && (includeEnded || !ended(team.relationship)))
        .sort((a, b) => a.teamName.localeCompare(b.teamName))
}
const teamRevision = team =>
    String(Math.max(ms(team.relationship.lastUpdatedStamp) ?? 0, ms(team.organization?.lastUpdatedStamp) ?? 0))
function memberRows(teamPartyId) {
    return rows(RELATIONSHIP, {relationshipTypeEnumId: TEAM_MEMBER, toPartyId: teamPartyId}).sort(
        (a, b) => (ms(a.fromDate) ?? 0) - (ms(b.fromDate) ?? 0)
    )
}
// Whether a person works for an organization now: a Person with an agent or employee relationship to it in effect.
function worksFor(partyId, organizationPartyId) {
    if (!one("mantle.party.Person", {partyId})) return false
    return Array.from(
        find(RELATIONSHIP)
            .condition("fromPartyId", partyId)
            .condition("toPartyId", organizationPartyId)
            .condition("relationshipTypeEnumId", "in", workerRelationships)
            .list()
    ).some(row => inEffect(row))
}
// The open memberships of a team ended at a time (a membership starting later is ended at its own start).
function endMemberships(teamPartyId, thruDate) {
    for (const row of memberRows(teamPartyId)) {
        if (ended(row)) continue
        const at = (ms(row.fromDate) ?? 0) > ms(thruDate) ? row.fromDate : thruDate
        if (row.thruDate && ms(row.thruDate) <= ms(at)) continue
        call("update#" + RELATIONSHIP, {partyRelationshipId: row.partyRelationshipId, thruDate: at})
    }
}

// store#SalesTeam: a new team of an organization (an Organization party with the SalesTeam role, its PrtSalesTeamOf row from
// fromDate, and its manager's membership when one is given), or a team's name or end (its memberships end with it).
function storeSalesTeam(p) {
    const userScope = teamManager()
    if (!text(p.teamPartyId)) {
        const organizationPartyId = text(p.organizationPartyId)
        if (!organizationPartyId) denied("ORGANIZATION_REQUIRED", "Choose the team's organization")
        salesAccess.requireOrganization(userScope, organizationPartyId)
        const teamName = text(p.teamName)
        if (!teamName) denied("NAME_REQUIRED", "Give the team a name")
        if (teamsOf(organizationPartyId).some(team => team.teamName.toLowerCase() === teamName.toLowerCase()))
            denied("DUPLICATE_VALUE", teamName + " is already a team of this organization")
        const managerPartyId = text(p.managerPartyId)
        if (managerPartyId && !worksFor(managerPartyId, organizationPartyId))
            denied("MEMBER_INVALID", "The manager is a person who works for the team's organization")
        const fromDate = fromNow(p.fromDate, "A team starts")
        const party = call("create#mantle.party.Party", {partyTypeEnumId: "PtyOrganization", ownerPartyId: organizationPartyId})
        const teamPartyId = party.partyId
        call("create#mantle.party.Organization", {partyId: teamPartyId, organizationName: teamName})
        call("create#mantle.party.PartyRole", {partyId: teamPartyId, roleTypeId: "SalesTeam"})
        call("create#" + RELATIONSHIP, {
            relationshipTypeEnumId: TEAM_OF,
            fromPartyId: teamPartyId,
            fromRoleTypeId: "SalesTeam",
            toPartyId: organizationPartyId,
            toRoleTypeId: "OrgInternal",
            fromDate
        })
        if (managerPartyId) addMembership(teamPartyId, managerPartyId, "Manager", fromDate)
        return {teamPartyId}
    }
    const team = requireTeam(userScope, p.teamPartyId)
    if (ended(team.relationship)) denied("RECORD_ENDED", team.teamName + " has ended")
    if (text(p.expectedRevision) !== teamRevision(team))
        denied("REVISION_CHANGED", "This team changed since you read it; open it again (revision " + teamRevision(team) + ")")
    if (p.teamName != null) {
        const teamName = text(p.teamName)
        if (!teamName) denied("NAME_REQUIRED", "Give the team a name")
        if (
            teamName !== team.teamName &&
            teamsOf(team.organizationPartyId).some(
                other => other.teamPartyId !== team.teamPartyId && other.teamName.toLowerCase() === teamName.toLowerCase()
            )
        )
            denied("DUPLICATE_VALUE", teamName + " is already a team of this organization")
        if (teamName !== team.teamName)
            call("update#mantle.party.Organization", {partyId: team.teamPartyId, organizationName: teamName})
    }
    if (flag(p.end) || !blank(p.thruDate)) {
        const thruDate = blank(p.thruDate) ? ec.user.nowTimestamp : fromNow(p.thruDate, "A team ends")
        endMemberships(team.teamPartyId, thruDate)
        call("update#" + RELATIONSHIP, {partyRelationshipId: team.relationship.partyRelationshipId, thruDate})
    }
    return {teamPartyId: team.teamPartyId}
}
function addMembership(teamPartyId, partyId, roleTypeId, fromDate, thruDate = null) {
    const created = call("create#" + RELATIONSHIP, {
        relationshipTypeEnumId: TEAM_MEMBER,
        fromPartyId: partyId,
        fromRoleTypeId: roleTypeId,
        toPartyId: teamPartyId,
        toRoleTypeId: "SalesTeam",
        fromDate,
        thruDate
    })
    return created.partyRelationshipId
}
// store#SalesTeamMember: a person joins a team as a representative or its manager from a date (now or later), or a membership
// ends (now or later). A person has one membership of a team at a time. Never deleted.
function storeSalesTeamMember(p) {
    const userScope = teamManager()
    const team = requireTeam(userScope, p.teamPartyId)
    const partyRelationshipId = text(p.partyRelationshipId)
    if (partyRelationshipId) {
        const row = one(RELATIONSHIP, {partyRelationshipId})
        if (!row || row.relationshipTypeEnumId !== TEAM_MEMBER || row.toPartyId !== team.teamPartyId)
            denied("RECORD_UNAVAILABLE", "This membership is not available")
        if (ended(row)) denied("RECORD_ENDED", "This membership has ended")
        requireRevision(row, p.expectedRevision, "This membership")
        const thruDate = blank(p.thruDate) ? ec.user.nowTimestamp : fromNow(p.thruDate, "A membership ends")
        // a membership that has not started ends at its own start
        const at = (ms(row.fromDate) ?? 0) > ms(thruDate) ? row.fromDate : thruDate
        call("update#" + RELATIONSHIP, {partyRelationshipId, thruDate: at})
        return {partyRelationshipId}
    }
    if (ended(team.relationship)) denied("RECORD_ENDED", team.teamName + " has ended")
    const partyId = text(p.partyId)
    if (!partyId || !worksFor(partyId, team.organizationPartyId))
        denied("MEMBER_INVALID", "A member is a person who works for the team's organization")
    const roleTypeId = text(p.roleTypeId) || "SalesRepresentative"
    if (!Object.hasOwn(memberRoles, roleTypeId)) denied("VALUE_INVALID", "A member is a representative or the manager")
    const fromDate = fromNow(p.fromDate, "A membership starts")
    const thruDate = blank(p.thruDate) ? null : p.thruDate
    if (thruDate && ms(thruDate) <= ms(fromDate)) denied("DATE_INVALID", "A membership ends after it starts")
    const overlaps = memberRows(team.teamPartyId).some(
        row =>
            row.fromPartyId === partyId &&
            (ms(row.thruDate) ?? Infinity) > ms(fromDate) &&
            (thruDate == null || (ms(row.fromDate) ?? -Infinity) < ms(thruDate))
    )
    if (overlaps) denied("MEMBER_EXISTS", "This person is already a member of the team then")
    return {partyRelationshipId: addMembership(team.teamPartyId, partyId, roleTypeId, fromDate, thruDate)}
}

// ===== lead sources =====
// The DataSourceType values of lead sources: LEAD_SOURCE and those under it.
function sourceTypes() {
    return [
        "LEAD_SOURCE",
        ...Array.from(find(ENUM, {enumTypeId: "DataSourceType", parentEnumId: "LEAD_SOURCE"}).list()).map(row => row.enumId)
    ]
}
function leadSource(dataSourceId) {
    const row = text(dataSourceId) ? one(SOURCE, {dataSourceId: text(dataSourceId)}) : null
    if (!row || !sourceTypes().includes(row.dataSourceTypeEnumId))
        denied("RECORD_UNAVAILABLE", "Lead source " + (dataSourceId || "") + " is not available")
    return row
}
const bindingsOf = dataSourceId => rows(BINDING, {dataSourceId})
// store#LeadSource: a new source offered to an organization from now, a source's name or type (by one whose scope covers every
// organization it is offered to), or an organization's binding added (bind) or ended (unbind).
function storeLeadSource(p) {
    const userScope = configurer()
    const types = sourceTypes()
    const typeId = text(p.dataSourceTypeEnumId)
    if (typeId && !types.includes(typeId)) denied("TYPE_INVALID", "Choose a lead source type")
    const organizationPartyId = text(p.organizationPartyId)
    if (!text(p.dataSourceId)) {
        if (!organizationPartyId) denied("ORGANIZATION_REQUIRED", "Choose the organization the source is offered to")
        salesAccess.requireOrganization(userScope, organizationPartyId)
        const description = text(p.description)
        if (!description) denied("NAME_REQUIRED", "Give the source a name")
        const sameName = Array.from(find(SOURCE).condition("dataSourceTypeEnumId", "in", types).list()).some(
            row => String(row.description || "").toLowerCase() === description.toLowerCase()
        )
        if (sameName) denied("DUPLICATE_VALUE", description + " is already a lead source: offer it instead")
        const created = call("create#" + SOURCE, {description, dataSourceTypeEnumId: typeId || "LEAD_SOURCE"})
        call("create#" + BINDING, {dataSourceId: created.dataSourceId, organizationPartyId, fromDate: ec.user.nowTimestamp})
        return {dataSourceId: created.dataSourceId}
    }
    const source = leadSource(p.dataSourceId)
    const current = bindingsOf(source.dataSourceId).filter(row => !ended(row))
    if (p.description != null || typeId) {
        // a shared source is renamed only by one whose scope covers every organization it is offered to
        if (current.some(row => !salesAccess.covers(userScope, row.organizationPartyId)))
            denied("SOURCE_SHARED", "This source is offered to an organization of another administrator: rename it there")
        requireRevision(source, p.expectedRevision, "This source")
        const changes = {dataSourceId: source.dataSourceId}
        if (p.description != null) {
            changes.description = text(p.description)
            if (!changes.description) denied("NAME_REQUIRED", "Give the source a name")
        }
        if (typeId) changes.dataSourceTypeEnumId = typeId
        call("update#" + SOURCE, changes)
    }
    if (flag(p.bind) || flag(p.unbind)) {
        if (!organizationPartyId) denied("ORGANIZATION_REQUIRED", "Choose the organization")
        salesAccess.requireOrganization(userScope, organizationPartyId)
        const binding = current.find(row => row.organizationPartyId === organizationPartyId)
        if (flag(p.bind)) {
            if (binding) denied("BINDING_EXISTS", (source.description || source.dataSourceId) + " is already offered there")
            call("create#" + BINDING, {
                dataSourceId: source.dataSourceId,
                organizationPartyId,
                fromDate: fromNow(p.fromDate, "An offer starts")
            })
        } else {
            if (!binding) denied("RECORD_UNAVAILABLE", (source.description || source.dataSourceId) + " is not offered there")
            const thruDate = blank(p.thruDate) ? ec.user.nowTimestamp : fromNow(p.thruDate, "An offer ends")
            call("update#" + BINDING, {
                dataSourceId: binding.dataSourceId,
                organizationPartyId: binding.organizationPartyId,
                fromDate: binding.fromDate,
                thruDate: (ms(binding.fromDate) ?? 0) > ms(thruDate) ? binding.fromDate : thruDate
            })
        }
    }
    return {dataSourceId: source.dataSourceId}
}
// The lead sources offered to an organization now.
function sourcesOffered(organizationPartyId) {
    const ids = Array.from(
        new Set(
            rows(BINDING, {organizationPartyId})
                .filter(row => inEffect(row))
                .map(row => row.dataSourceId)
        )
    )
    if (!ids.length) return []
    return Array.from(find(SOURCE).condition("dataSourceId", "in", ids).orderBy("description").list()).map(row => ({
        dataSourceId: row.dataSourceId,
        description: row.description || row.dataSourceId,
        dataSourceTypeEnumId: row.dataSourceTypeEnumId
    }))
}

// ===== lost reasons =====
const REASONS = "SalesLostReason"
function reasonsOf(includeEnded = false) {
    const found = rows(ENUM, {enumTypeId: REASONS}).sort(
        (a, b) => (a.sequenceNum ?? 0) - (b.sequenceNum ?? 0) || String(a.description).localeCompare(String(b.description))
    )
    return includeEnded ? found : found.filter(row => !ended(row))
}
// store#LostReason: a new reason, a reason's name or order, or its end (now or later); never deleted.
function storeLostReason(p) {
    configurer()
    const sequenceNum = blank(p.sequenceNum) ? null : Number(text(p.sequenceNum))
    if (sequenceNum != null && (!Number.isInteger(sequenceNum) || sequenceNum < 0 || sequenceNum > 9999))
        denied("SEQUENCE_INVALID", "The order is a whole number from 0 to 9999")
    const duplicate = (description, exceptId) =>
        reasonsOf().some(
            row => row.enumId !== exceptId && String(row.description || "").toLowerCase() === description.toLowerCase()
        )
    if (!text(p.enumId)) {
        const description = text(p.description)
        if (!description) denied("NAME_REQUIRED", "Give the reason a name")
        if (duplicate(description, null)) denied("DUPLICATE_VALUE", description + " is already a reason")
        const last = reasonsOf().reduce((max, row) => Math.max(max, row.sequenceNum ?? 0), 0)
        const created = call("create#" + ENUM, {enumTypeId: REASONS, description, sequenceNum: sequenceNum ?? last + 10})
        return {enumId: created.enumId}
    }
    const row = one(ENUM, {enumId: text(p.enumId)})
    if (!row || row.enumTypeId !== REASONS) denied("RECORD_UNAVAILABLE", "This reason is not available")
    if (ended(row)) denied("RECORD_ENDED", (row.description || row.enumId) + " has ended")
    requireRevision(row, p.expectedRevision, "This reason")
    const changes = {enumId: row.enumId}
    if (p.description != null) {
        const description = text(p.description)
        if (!description) denied("NAME_REQUIRED", "Give the reason a name")
        if (description !== row.description && duplicate(description, row.enumId))
            denied("DUPLICATE_VALUE", description + " is already a reason")
        changes.description = description
    }
    if (p.sequenceNum != null) changes.sequenceNum = sequenceNum
    if (flag(p.end) || !blank(p.thruDate))
        changes.thruDate = blank(p.thruDate) ? ec.user.nowTimestamp : fromNow(p.thruDate, "A reason ends")
    if (Object.keys(changes).length > 1) call("update#" + ENUM, changes)
    return {enumId: row.enumId}
}

// ===== reads =====
const enumOptions = enumTypeId =>
    rows(ENUM, {enumTypeId})
        .filter(row => !ended(row))
        .sort((a, b) => (a.sequenceNum ?? 0) - (b.sequenceNum ?? 0))
        .map(row => ({enumId: row.enumId, description: row.description || row.enumId, enumCode: row.enumCode || null}))
const stageView = (stage, withCounts) => {
    const view = {
        opportunityStageId: stage.opportunityStageId,
        salesPipelineId: stage.salesPipelineId,
        description: stage.description || stage.opportunityStageId,
        // a percentage as a number (a decimal field)
        defaultProbability: stage.defaultProbability == null ? null : Number(String(stage.defaultProbability)),
        sequenceNum: stage.sequenceNum ?? null,
        folded: stage.foldFlag === "Y",
        ended: ended(stage),
        stateText: ended(stage) ? "Retired " + dateText(stage.thruDate) : "Current",
        revision: revisionOf(stage)
    }
    if (withCounts) view.openCount = openOnStage(stage.opportunityStageId).length
    return view
}
function pipelineView(pipeline, organizationPartyId, includeEnded, withCounts) {
    const team = pipeline.teamPartyId ? teamRow(pipeline.teamPartyId) : null
    return {
        salesPipelineId: pipeline.salesPipelineId,
        pipelineName: pipeline.pipelineName || pipeline.salesPipelineId,
        description: pipeline.description || null,
        organizationPartyId: pipeline.organizationPartyId || null,
        organizationName: organizationName(pipeline.organizationPartyId),
        shared: !pipeline.organizationPartyId,
        teamPartyId: pipeline.teamPartyId || null,
        teamName: team?.teamName || "",
        isDefault: pipeline.defaultFlag === "Y",
        ended: ended(pipeline),
        stateText: stateText(pipeline),
        fromDateText: dateText(pipeline.fromDate),
        thruDateText: dateText(pipeline.thruDate),
        revision: revisionOf(pipeline),
        stages: stagesOf(pipeline.salesPipelineId, includeEnded).map(stage => stageView(stage, withCounts))
    }
}
// get#SalesOptions: what an organization offers now, to any Sales reader of it.
function salesOptions(p) {
    const userScope = salesAccess.scope()
    salesAccess.requireCapability(userScope, "anyRead")
    const organizationPartyId = salesAccess.requireOrganization(userScope, text(p.organizationPartyId))
    const found = defaultPipeline(organizationPartyId)
    return {
        types: enumOptions("SalesOpportunityType"),
        statuses: rows("moqui.basic.StatusItem", {statusTypeId: "SalesOpportunity"})
            .sort((a, b) => (a.sequenceNum ?? 0) - (b.sequenceNum ?? 0))
            .map(row => ({statusId: row.statusId, description: row.description})),
        defaultPipelineId: found?.salesPipelineId || null,
        pipelines: pipelinesOf(organizationPartyId)
            .filter(row => inEffect(row))
            .map(row => pipelineView(row, organizationPartyId, false, false)),
        teams: teamsOf(organizationPartyId)
            .filter(team => inEffect(team.relationship))
            .map(team => ({teamPartyId: team.teamPartyId, teamName: team.teamName})),
        sources: sourcesOffered(organizationPartyId),
        lostReasons: enumOptions(REASONS),
        recurringPlans: enumOptions("SalesRecurringPlan")
    }
}
// get#SalesSetup: the settings of an organization as its configurer or team manager reads them: every pipeline it is offered with
// its stages and their open deals, its teams and their members, the lead sources (offered there or not) and the lost reasons,
// ended rows with includeEnded, and whether the caller may change each part.
function salesSetup(p) {
    const userScope = teamManager()
    const organizationPartyId = salesAccess.requireOrganization(userScope, text(p.organizationPartyId))
    const includeEnded = flag(p.includeEnded)
    const canConfigure = !!userScope.capabilities.configure
    const shared = userScope.organizationPartyIds == null
    const at = nowMs()
    const teams = teamsOf(organizationPartyId, includeEnded).map(team => {
        const members = memberRows(team.teamPartyId).filter(row => includeEnded || !ended(row, at))
        const names = lib.partyNames(members.map(row => row.fromPartyId))
        return {
            teamPartyId: team.teamPartyId,
            teamName: team.teamName,
            organizationPartyId,
            ended: ended(team.relationship, at),
            stateText: stateText(team.relationship, at),
            fromDateText: dateText(team.relationship.fromDate),
            thruDateText: dateText(team.relationship.thruDate),
            revision: teamRevision(team),
            memberCount: new Set(members.filter(row => inEffect(row, at)).map(row => row.fromPartyId)).size,
            managerNames: members
                .filter(row => inEffect(row, at) && row.fromRoleTypeId === "Manager")
                .map(row => names[row.fromPartyId] || row.fromPartyId)
                .join(", "),
            members: members.map(row => ({
                partyRelationshipId: row.partyRelationshipId,
                partyId: row.fromPartyId,
                personName: names[row.fromPartyId] || row.fromPartyId,
                roleTypeId: row.fromRoleTypeId,
                roleText: memberRoles[row.fromRoleTypeId] || row.fromRoleTypeId || "",
                fromDateText: dateText(row.fromDate),
                thruDateText: dateText(row.thruDate),
                current: inEffect(row, at),
                ended: ended(row, at),
                stateText: stateText(row, at),
                revision: revisionOf(row)
            }))
        }
    })
    let sources = []
    let reasons = []
    let pipelines = []
    if (canConfigure) {
        const types = sourceTypes()
        const typeNames = Object.fromEntries(
            Array.from(find(ENUM).condition("enumId", "in", types).list()).map(row => [row.enumId, row.description])
        )
        sources = Array.from(
            find(SOURCE).condition("dataSourceTypeEnumId", "in", types).orderBy("description").limit(sourceCap).list()
        ).map(row => {
            const bindings = bindingsOf(row.dataSourceId).filter(binding => !ended(binding, at))
            const here = bindings.find(binding => binding.organizationPartyId === organizationPartyId)
            const elsewhere = bindings.filter(binding => binding.organizationPartyId !== organizationPartyId)
            return {
                dataSourceId: row.dataSourceId,
                description: row.description || row.dataSourceId,
                dataSourceTypeEnumId: row.dataSourceTypeEnumId,
                typeText: typeNames[row.dataSourceTypeEnumId] || row.dataSourceTypeEnumId,
                offered: !!here && inEffect(here, at),
                offeredText: here ? (inEffect(here, at) ? "Offered" : "From " + dateText(here.fromDate)) : "Not offered",
                // the other organizations it is offered to: named when in the caller's scope, counted otherwise
                elsewhereText: elsewhere.length
                    ? elsewhere
                          .map(binding =>
                              salesAccess.covers(userScope, binding.organizationPartyId)
                                  ? organizationName(binding.organizationPartyId)
                                  : null
                          )
                          .filter(Boolean)
                          .concat(
                              elsewhere.some(binding => !salesAccess.covers(userScope, binding.organizationPartyId))
                                  ? ["other organizations"]
                                  : []
                          )
                          .join(", ")
                    : "",
                canRename: !bindings.some(binding => !salesAccess.covers(userScope, binding.organizationPartyId)),
                revision: revisionOf(row)
            }
        })
        reasons = reasonsOf(includeEnded).map(row => ({
            enumId: row.enumId,
            description: row.description || row.enumId,
            sequenceNum: row.sequenceNum ?? null,
            ended: ended(row, at),
            stateText: ended(row, at)
                ? "Ended " + dateText(row.thruDate)
                : row.thruDate
                  ? "Ends " + dateText(row.thruDate)
                  : "In use",
            revision: revisionOf(row)
        }))
        pipelines = pipelinesOf(organizationPartyId, includeEnded).map(row => {
            const view = pipelineView(row, organizationPartyId, includeEnded, true)
            view.canEdit = !view.ended && (!view.shared || shared)
            return view
        })
    }
    return {
        organizationPartyId,
        organizationName: organizationName(organizationPartyId),
        defaultPipelineId: defaultPipeline(organizationPartyId)?.salesPipelineId || null,
        pipelines,
        teams,
        sources,
        sourceTypes: enumOptionsOf(sourceTypes()),
        lostReasons: reasons,
        types: enumOptions("SalesOpportunityType"),
        recurringPlans: enumOptions("SalesRecurringPlan"),
        canConfigure,
        canManageTeams: !!(userScope.capabilities.configure || userScope.capabilities.teamManage),
        canEditShared: canConfigure && shared
    }
}
const enumOptionsOf = enumIds =>
    Array.from(find(ENUM).condition("enumId", "in", enumIds).list())
        .map(row => ({enumId: row.enumId, description: row.description || row.enumId}))
        .sort((a, b) =>
            a.enumId === "LEAD_SOURCE" ? -1 : b.enumId === "LEAD_SOURCE" ? 1 : a.description.localeCompare(b.description)
        )

// ===== readiness =====
// Each finding names its owner's place as a route key (fixRoute, with fixId where it names a record) that the app showing it
// resolves (the framework's readiness contract, moqui.server.ReadinessProvider sales.readiness): Sales' Stages, Teams and Sources.
// Later phases add theirs (templates, policies, the commercial revision, the public app).
const routes = {settings: "salesSettings", stages: "salesStages", teams: "salesTeams", sources: "salesLeadSources"}
const readinessChecks = [
    {
        checkKey: "sales.defaultPipeline",
        title: "Default pipeline",
        run: organizationPartyId => {
            const found = defaultPipeline(organizationPartyId)
            if (!found)
                return {
                    state: "failed",
                    reasonCode: "NO_DEFAULT_PIPELINE",
                    message: "No default pipeline: new opportunities have no stages to move through",
                    fixRoute: routes.stages
                }
            return {
                state: "ready",
                message: (found.pipelineName || found.salesPipelineId) + (found.organizationPartyId ? "" : " (shared)")
            }
        }
    },
    {
        checkKey: "sales.pipelineStages",
        title: "Pipeline stages",
        run: organizationPartyId => {
            const empty = pipelinesOf(organizationPartyId)
                .filter(row => inEffect(row))
                .filter(row => !stagesOf(row.salesPipelineId).some(stage => inEffect(stage)))
            if (empty.length)
                return {
                    state: "failed",
                    reasonCode: "PIPELINE_WITHOUT_STAGES",
                    message: empty.map(row => row.pipelineName || row.salesPipelineId).join(", ") + " has no stages",
                    fixRoute: routes.stages,
                    fixId: empty[0].salesPipelineId
                }
            return {state: "ready", message: "Every pipeline has stages"}
        }
    },
    {
        checkKey: "sales.teams",
        title: "Sales teams",
        run: organizationPartyId => {
            const teams = teamsOf(organizationPartyId).filter(team => inEffect(team.relationship))
            const staffed = teams.filter(team => memberRows(team.teamPartyId).some(row => inEffect(row)))
            if (!staffed.length)
                return {
                    state: "warning",
                    reasonCode: "NO_TEAM",
                    message: teams.length ? "No team has a member" : "No sales team: opportunities are assigned by person only",
                    fixRoute: routes.teams
                }
            return {state: "ready", message: staffed.length + (staffed.length === 1 ? " team" : " teams")}
        }
    },
    {
        checkKey: "sales.leadSources",
        title: "Lead sources",
        run: organizationPartyId => {
            const sources = sourcesOffered(organizationPartyId)
            if (!sources.length)
                return {
                    state: "warning",
                    reasonCode: "NO_SOURCE",
                    message: "No lead source is offered: leads cannot say where they came from",
                    fixRoute: routes.sources
                }
            return {state: "ready", message: sources.length + (sources.length === 1 ? " source" : " sources")}
        }
    }
]
// The organizations that use Sales: a pipeline, a team, a source offered or an opportunity of theirs.
function usesSales(organizationPartyId) {
    return (
        find(PIPELINE, {organizationPartyId}).count() > 0 ||
        find(RELATIONSHIP, {relationshipTypeEnumId: TEAM_OF, toPartyId: organizationPartyId}).count() > 0 ||
        find(BINDING, {organizationPartyId}).count() > 0 ||
        find(OPPORTUNITY, {organizationPartyId}).count() > 0
    )
}
// get#SalesReadiness: the checks of the organization asked, or of each organization of the caller's scope that uses Sales, for a
// holder of SALES_CONFIGURE. One check that fails is unavailable by name and the others go on.
function readiness(p) {
    const userScope = configurer()
    let organizationPartyIds
    if (text(p.organizationPartyId))
        organizationPartyIds = [salesAccess.requireOrganization(userScope, text(p.organizationPartyId))]
    else {
        const internal = Array.from(
            find("mantle.party.PartyRole", {roleTypeId: "OrgInternal"}).selectField("partyId").list()
        ).map(row => row.partyId)
        const scoped =
            userScope.organizationPartyIds == null ? internal : userScope.organizationPartyIds.filter(id => internal.includes(id))
        organizationPartyIds = scoped.filter(organizationPartyId => {
            try {
                return usesSales(organizationPartyId)
            } catch (error) {
                ec.logger.error("Sales readiness for " + organizationPartyId + " failed: " + error.message)
                return false
            }
        })
    }
    const checks = []
    for (const organizationPartyId of organizationPartyIds) {
        const subject = organizationName(organizationPartyId)
        for (const check of readinessChecks) {
            let found
            ec.message.pushErrors()
            try {
                found = check.run(organizationPartyId)
                if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
            } catch (error) {
                ec.logger.error("Sales readiness " + check.checkKey + " for " + organizationPartyId + " failed: " + error.message)
                found = {state: "unavailable", reasonCode: "CHECK_FAILED", message: check.title + " could not be checked"}
            } finally {
                ec.message.clearErrors()
                ec.message.popErrors()
            }
            checks.push({
                checkKey: check.checkKey,
                title: check.title,
                state: found.state,
                reasonCode: found.reasonCode || null,
                message: found.message,
                fixRoute: found.state === "ready" ? null : found.fixRoute || routes.settings,
                fixId: found.state === "ready" ? null : found.fixId || null,
                subject,
                scope: {organizationPartyId},
                organizationPartyId,
                organizationName: subject
            })
        }
    }
    return {checks}
}

const operations = {
    storePipeline,
    storeStage,
    storeSalesTeam,
    storeSalesTeamMember,
    storeLeadSource,
    storeLostReason,
    salesOptions,
    salesSetup,
    readiness
}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown sales settings operation " + op)
        return operations[op](parameters || {})
    },
    // for Sales' choices and P4's services, never a service's parameters: the teams and offered sources of an organization, its
    // default pipeline and whether a person works for it
    teamsOf,
    sourcesOffered,
    defaultPipeline,
    worksFor
})
