// Sales' leads and opportunities (mantle.sales.OpportunityServices, its lifecycle verbs; IronStone Sales design §3 Opportunities,
// Leads and OpportunityDetail, §12.1 O, §12.2; impl-sales P4, SAL-CRM, SAL-COLLAB).
//
// - A lead and an opportunity are one record, SalesOpportunity, its type SotLead or SotOpportunity: qualification changes the type
//   of the same record (qualify#Lead), keeping its id, source, activities, files and joins. Its outcome (statusId) is Open, Won or
//   Lost, apart from its stage; Lost needs a current lost reason; a reopen clears the outcome and the audit log keeps the close
//   history. Its stage is a current stage of its pipeline (a pipeline of its organization or the shared one); a stage move is not a
//   closure. Its probability is the stage's default in Stage mode (copied on create and move) and the rep's value in Manual mode,
//   kept across moves until Stage is chosen again.
// - Its people are dated SalesOpportunityParty rows: the selling organization (OrgInternal, kept equal to organizationPartyId),
//   one current primary owner (SalesRepresentative), a team (SalesTeam) and contacts (Contact). Ended, never deleted.
// - Access (SalesAccess.js opportunityOf): a Sales reader of the organization sees the deals assigned to them or a team of theirs,
//   a holder of SALES_TEAM_VIEW the organization's; an edit needs SALES_OPPORTUNITY_EDIT on a deal they see. Every party, account,
//   pipeline, stage, team, source and reason given is checked, never trusted; a deal outside the scope answers RECORD_UNAVAILABLE.
// - Every write of an existing deal names the revision it read (expectedRevision: the latest stamp of the deal and its party rows,
//   REVISION_CHANGED naming the current one); qualification carries an operation key, so a retry answers the first result
//   (PostingOperation, EntityLib.js operation); a batch runs each deal on its own and names each failure.
// - Collaboration: files are SalesOpportunityContent rows (create#OpportunityContent); activities are Commons tasks linked by
//   link#WorkEffortRecord, which writes SalesOpportunityWorkEffort, the opportunity's own join (get#RecordLinkInfo).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const salesAccess = ec.resource.script("component://mr-mantle/service/mantle/sales/SalesAccess.js")
const settings = ec.resource.script("component://mr-mantle/service/mantle/sales/SalesSettings.js")
const {find, one, rows, denied, call, ms} = lib

const OPPORTUNITY = "mantle.sales.opportunity.SalesOpportunity"
const OPPORTUNITY_PARTY = "mantle.sales.opportunity.SalesOpportunityParty"
const COMPETITOR = "mantle.sales.opportunity.SalesOpportunityCompetitor"
const WORK_LINK = "mantle.sales.opportunity.SalesOpportunityWorkEffort"
const ORDER_LINK = "mantle.sales.opportunity.SalesOpportunityOrder"
const STAGE = "mantle.sales.opportunity.SalesOpportunityStage"
const PIPELINE = "mantle.sales.opportunity.SalesPipeline"
const ENUM = "moqui.basic.Enumeration"
const roles = salesAccess.opportunityRoles
const types = {lead: "SotLead", opportunity: "SotOpportunity"}
const statuses = {open: "SalesOppOpen", won: "SalesOppWon", lost: "SalesOppLost"}
const closedStatuses = [statuses.won, statuses.lost]
const modes = {stage: "SpmStage", manual: "SpmManual"}
const doneTaskStatuses = ["WeComplete", "WeClosed", "WeCancelled"]
const statusColors = {SalesOppOpen: "primary", SalesOppWon: "positive", SalesOppLost: "negative"}
const editableRoles = [roles.owner, roles.team, roles.contact]
const minuteMs = 60 * 1000
const dayMs = 24 * 60 * minuteMs

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const flag = value => value === true || value === "true" || value === "Y"
const nowMs = () => ms(ec.user.nowTimestamp)
const L = value => ec.l10n.localize(value)
const dateText = value => (value == null || value === "" ? "" : lib.dateText(value))
const dayText = value => (value == null || value === "" ? "" : ec.l10n.format(new Date(ms(value)), "d MMM yyyy"))
const amountText = (value, currencyUomId) =>
    value == null ? "" : ec.l10n.formatCurrency(ec.l10n.roundCurrency(toDecimal(value), currencyUomId), currencyUomId)
const percentText = value => (value == null ? "" : Number(String(value)) + " %")
const likeText = value => "%" + String(value).replace(/[\\%_]/g, character => "\\" + character) + "%"
const isOpen = row => !closedStatuses.includes(row.statusId)
const current = (row, at = nowMs()) => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at

// ===== revisions =====
// A deal's revision: the latest stamp of the deal and its party rows, so a change of its people is a change of the deal.
function revisionOf(opportunity, partyRows = null) {
    const parties = partyRows || rows(OPPORTUNITY_PARTY, {salesOpportunityId: opportunity.salesOpportunityId})
    return String(
        parties.reduce((max, row) => Math.max(max, ms(row.lastUpdatedStamp) ?? 0), ms(opportunity.lastUpdatedStamp) ?? 0)
    )
}
function requireRevision(opportunity, expected) {
    const revision = revisionOf(opportunity)
    if (text(expected) !== revision)
        denied("REVISION_CHANGED", "This deal changed since you read it; open it again (revision " + revision + ")")
}

// ===== scope =====
function signedIn() {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in to work with leads and opportunities")
    return salesAccess.scope()
}
// The organization a new deal is for: the one named, which must be in the caller's scope, else the active one, else the scope's only
// one. Needs SALES_OPPORTUNITY_EDIT.
function organizationFor(userScope, organizationPartyId) {
    salesAccess.requireCapability(userScope, "opportunityEdit")
    salesAccess.requireCapability(userScope, "anyRead")
    let chosen = text(organizationPartyId) || userScope.activeOrganizationPartyId
    if (!chosen && userScope.organizationPartyIds?.length === 1) chosen = userScope.organizationPartyIds[0]
    if (!chosen) denied("ORGANIZATION_DENIED", "Choose the organization the deal is for")
    if (!salesAccess.isInternal(chosen)) denied("ORGANIZATION_DENIED", "Organization " + chosen + " is not available")
    return salesAccess.requireOrganization(userScope, chosen)
}
// A deal the caller edits, open: its record, after the revision.
function editable(userScope, p, mustBeOpen = true) {
    const {opportunity} = salesAccess.requireOpportunity(userScope, text(p.salesOpportunityId), true)
    requireRevision(opportunity, p.expectedRevision)
    if (mustBeOpen && !isOpen(opportunity))
        denied("RECORD_CLOSED", (opportunity.opportunityName || opportunity.salesOpportunityId) + " is closed; reopen it first")
    return opportunity
}

// ===== what a deal may be given =====
function pipelineFor(organizationPartyId, salesPipelineId) {
    if (blank(salesPipelineId)) return settings.defaultPipeline(organizationPartyId)
    const pipeline = one(PIPELINE, {salesPipelineId: text(salesPipelineId)})
    if (
        !pipeline ||
        !settings.inEffect(pipeline) ||
        (pipeline.organizationPartyId && pipeline.organizationPartyId !== organizationPartyId)
    )
        denied("PIPELINE_INVALID", "Choose a pipeline the organization uses")
    return pipeline
}
function stageFor(pipeline, opportunityStageId) {
    if (!pipeline) denied("PIPELINE_REQUIRED", "The organization has no pipeline; Sales settings add one")
    const stages = settings.stagesOf(pipeline.salesPipelineId)
    if (blank(opportunityStageId)) {
        if (!stages.length) denied("STAGE_INVALID", (pipeline.pipelineName || pipeline.salesPipelineId) + " has no stage")
        return stages[0]
    }
    const stage = stages.find(row => row.opportunityStageId === text(opportunityStageId))
    if (!stage) denied("STAGE_INVALID", "Choose a current stage of " + (pipeline.pipelineName || pipeline.salesPipelineId))
    return stage
}
// An account of the scope for a deal of the organization: its own or a shared one (another organization's is refused as missing).
function accountFor(userScope, organizationPartyId, accountPartyId) {
    if (blank(accountPartyId)) return null
    const account = salesAccess.requireAccount(userScope, text(accountPartyId))
    if (account.organizationPartyId && account.organizationPartyId !== organizationPartyId)
        denied("RECORD_UNAVAILABLE", "Account " + accountPartyId + " is not available")
    return account
}
// A person the caller may see, not internal: a contact of a deal.
function personFor(userScope, partyId) {
    const person = salesAccess.visibleParty(userScope, text(partyId))
    if (!person || person.partyTypeEnumId !== "PtyPerson" || salesAccess.isInternal(person.partyId))
        denied("RECORD_UNAVAILABLE", "Person " + (partyId || "") + " is not available")
    return person
}
// The owner of a deal: the one named, else the caller when they work for the organization. A person who works for it; a caller
// without SALES_TEAM_MANAGE assigns only themselves or a current member of one of their teams ("reassign within team").
function ownerFor(userScope, organizationPartyId, ownerPartyId) {
    const chosen = text(ownerPartyId) || (settings.worksFor(userScope.partyId, organizationPartyId) ? userScope.partyId : null)
    if (!chosen) return null
    if (!settings.worksFor(chosen, organizationPartyId))
        denied("OWNER_INVALID", "The owner must be a person who works for the deal's organization")
    if (chosen !== userScope.partyId && !userScope.capabilities.teamManage) {
        const mine = salesAccess.memberTeams(userScope.partyId)
        if (!salesAccess.memberTeams(chosen).some(teamPartyId => mine.includes(teamPartyId)))
            denied("PERMISSION_DENIED", "A sales manager assigns a deal outside your teams")
    }
    return chosen
}
// The team of a deal: the one named (a current team of the organization), else the owner's only current team there.
function teamFor(userScope, organizationPartyId, teamPartyId, ownerPartyId) {
    if (!blank(teamPartyId)) {
        const team = settings.teamRow(text(teamPartyId))
        if (!team || team.organizationPartyId !== organizationPartyId || !settings.inEffect(team.relationship))
            denied("TEAM_UNAVAILABLE", "Choose a current team of the deal's organization")
        if (!userScope.capabilities.teamManage && !salesAccess.memberTeams(userScope.partyId).includes(team.teamPartyId))
            denied("PERMISSION_DENIED", "A sales manager assigns a deal to a team you are not in")
        return team.teamPartyId
    }
    if (!ownerPartyId) return null
    const teams = salesAccess
        .memberTeams(ownerPartyId)
        .filter(teamPartyId => salesAccess.teamOrganization(teamPartyId) === organizationPartyId)
    return teams.length === 1 ? teams[0] : null
}
function sourceFor(organizationPartyId, dataSourceId) {
    if (blank(dataSourceId)) return null
    if (!settings.sourcesOffered(organizationPartyId).some(row => row.dataSourceId === text(dataSourceId)))
        denied("SOURCE_INVALID", "Choose a lead source offered to the organization")
    return text(dataSourceId)
}
function campaignFor(marketingCampaignId) {
    if (blank(marketingCampaignId)) return null
    if (!one("mantle.marketing.campaign.MarketingCampaign", {marketingCampaignId: text(marketingCampaignId)}))
        denied("CAMPAIGN_INVALID", "Campaign " + marketingCampaignId + " is not available")
    return text(marketingCampaignId)
}
function enumFor(enumTypeId, enumId, reason, label) {
    if (blank(enumId)) return null
    const row = one(ENUM, {enumId: text(enumId)})
    if (!row || row.enumTypeId !== enumTypeId || settings.ended(row)) denied(reason, "Choose a current " + label)
    return row.enumId
}
function probabilityOf(value) {
    if (blank(value)) return null
    const number = Number(String(value).trim())
    if (!Number.isFinite(number) || number < 0 || number > 100) denied("PROBABILITY_INVALID", "A probability is from 0 to 100")
    return toDecimal(String(number))
}
function amountOf(value, label = "An amount") {
    if (blank(value)) return null
    let decimal
    try {
        decimal = toDecimal(String(value).trim())
    } catch (error) {
        denied("AMOUNT_INVALID", label + " is a number")
    }
    if (decimal.compare(0) < 0) denied("AMOUNT_INVALID", label + " is not negative")
    return decimal
}
// The currency of an amount: the one given, else the organization's base currency; none for no amount.
function currencyFor(organizationPartyId, currencyUomId, hasAmount) {
    if (!blank(currencyUomId)) {
        const uom = one("moqui.basic.Uom", {uomId: text(currencyUomId)})
        if (!uom || uom.uomTypeEnumId !== "UT_CURRENCY_MEASURE") denied("CURRENCY_INVALID", "Choose a currency")
        return uom.uomId
    }
    if (!hasAmount) return null
    let base = null
    try {
        base = lib.probe("mantle.ledger.LedgerServices.find#PartyAcctgPreference", {organizationPartyId}).partyAcctgPreference
            ?.baseCurrencyUomId
    } catch (error) {
        base = null
    }
    if (!base) denied("CURRENCY_REQUIRED", "Choose the amount's currency")
    return base
}
// A date given to a service (a Timestamp parameter, converted by the service), checked: null when empty.
function dateOf(value, label) {
    if (blank(value)) return null
    const at = ms(value)
    if (at == null || !Number.isFinite(at)) denied("DATE_INVALID", label + " is a date")
    return value
}

// ===== party rows =====
const partyRowsOf = salesOpportunityId => rows(OPPORTUNITY_PARTY, {salesOpportunityId})
function startParty(salesOpportunityId, partyId, roleTypeId, fromDate = ec.user.nowTimestamp) {
    call("create#" + OPPORTUNITY_PARTY, {salesOpportunityId, partyId, roleTypeId, fromDate})
}
function endParty(row, thruDate = ec.user.nowTimestamp) {
    call("update#" + OPPORTUNITY_PARTY, {
        salesOpportunityId: row.salesOpportunityId,
        partyId: row.partyId,
        roleTypeId: row.roleTypeId,
        fromDate: row.fromDate,
        thruDate
    })
}
// One current row of a role (the owner, the team): the others of that role end, the party's starts when it has none.
function setOnly(salesOpportunityId, roleTypeId, partyId) {
    const found = partyRowsOf(salesOpportunityId).filter(row => row.roleTypeId === roleTypeId && current(row))
    for (const row of found) if (row.partyId !== partyId) endParty(row)
    if (partyId && !found.some(row => row.partyId === partyId)) startParty(salesOpportunityId, partyId, roleTypeId)
}
function addContactRow(salesOpportunityId, partyId) {
    if (!partyRowsOf(salesOpportunityId).some(row => row.roleTypeId === roles.contact && row.partyId === partyId && current(row)))
        startParty(salesOpportunityId, partyId, roles.contact)
}

// ===== create#Opportunity =====
// A lead (SotLead: an account and stage optional) or an opportunity (SotOpportunity: a stage of the pipeline, the first by default)
// of an organization of the caller's scope, owned by the caller or the person named, on the owner's team or the one named.
function createOpportunity(p) {
    const userScope = signedIn()
    const organizationPartyId = organizationFor(userScope, p.organizationPartyId)
    const typeEnumId = p.typeEnumId === types.lead ? types.lead : types.opportunity
    const opportunityName = text(p.opportunityName)
    if (!opportunityName) denied("NAME_REQUIRED", "Give the deal a name")
    const account = accountFor(userScope, organizationPartyId, p.accountPartyId)
    const contact = blank(p.contactPartyId) ? null : personFor(userScope, p.contactPartyId)
    const pipeline =
        typeEnumId === types.opportunity || !blank(p.salesPipelineId) ? pipelineFor(organizationPartyId, p.salesPipelineId) : null
    const stage =
        typeEnumId === types.opportunity || !blank(p.opportunityStageId) ? stageFor(pipeline, p.opportunityStageId) : null
    const ownerPartyId = ownerFor(userScope, organizationPartyId, p.ownerPartyId)
    const teamPartyId = teamFor(userScope, organizationPartyId, p.teamPartyId, ownerPartyId)
    if (!ownerPartyId && !teamPartyId) denied("ASSIGNMENT_REQUIRED", "Choose the deal's owner or team")
    const estimatedAmount = amountOf(p.estimatedAmount, "The estimated amount")
    const recurringAmount = amountOf(p.recurringAmount, "The recurring amount")
    const manualProbability = probabilityOf(p.estimatedProbability)
    const mode =
        p.probabilityModeEnumId === modes.stage || (manualProbability == null && p.probabilityModeEnumId !== modes.manual)
            ? modes.stage
            : modes.manual
    const created = call("create#" + OPPORTUNITY, {
        typeEnumId,
        organizationPartyId,
        opportunityName,
        description: text(p.description),
        nextStep: text(p.nextStep),
        accountPartyId: account?.party.partyId || null,
        salesPipelineId: pipeline?.salesPipelineId || null,
        opportunityStageId: stage?.opportunityStageId || null,
        probabilityModeEnumId: mode,
        estimatedProbability: mode === modes.stage ? (stage?.defaultProbability ?? null) : manualProbability,
        estimatedAmount,
        currencyUomId: currencyFor(organizationPartyId, p.currencyUomId, estimatedAmount != null || recurringAmount != null),
        estimatedCloseDate: dateOf(p.estimatedCloseDate, "The expected close"),
        recurringAmount,
        recurringPlanEnumId: enumFor("SalesRecurringPlan", p.recurringPlanEnumId, "PLAN_INVALID", "recurring plan"),
        dataSourceId: sourceFor(organizationPartyId, p.dataSourceId),
        marketingCampaignId: campaignFor(p.marketingCampaignId),
        statusId: statuses.open,
        createdDate: ec.user.nowTimestamp,
        stageEnteredDate: stage ? ec.user.nowTimestamp : null
    })
    const salesOpportunityId = created.salesOpportunityId
    startParty(salesOpportunityId, organizationPartyId, roles.organization)
    if (ownerPartyId) startParty(salesOpportunityId, ownerPartyId, roles.owner)
    if (teamPartyId) startParty(salesOpportunityId, teamPartyId, roles.team)
    if (contact) startParty(salesOpportunityId, contact.partyId, roles.contact)
    return {salesOpportunityId}
}

// ===== update#Opportunity =====
// The deal's facts: name, description, next step, account, amounts and currency, probability and its mode, expected close, recurring
// amount and plan, source and campaign; each given field changes, an empty one clears (the name and a qualified deal's account
// stay). An open deal only, at its revision.
function updateOpportunity(p) {
    const userScope = signedIn()
    const opportunity = editable(userScope, p)
    const organizationPartyId = opportunity.organizationPartyId
    const changes = {salesOpportunityId: opportunity.salesOpportunityId}
    const given = name => p[name] != null
    if (given("opportunityName")) {
        changes.opportunityName = text(p.opportunityName)
        if (!changes.opportunityName) denied("NAME_REQUIRED", "Give the deal a name")
    }
    for (const name of ["description", "nextStep"]) if (given(name)) changes[name] = text(p[name])
    if (given("accountPartyId")) {
        if (blank(p.accountPartyId) && opportunity.typeEnumId === types.opportunity)
            denied("ACCOUNT_REQUIRED", "A qualified deal keeps an account")
        changes.accountPartyId = accountFor(userScope, organizationPartyId, p.accountPartyId)?.party.partyId || null
    }
    if (given("estimatedAmount")) changes.estimatedAmount = amountOf(p.estimatedAmount, "The estimated amount")
    if (given("recurringAmount")) changes.recurringAmount = amountOf(p.recurringAmount, "The recurring amount")
    if (given("recurringPlanEnumId"))
        changes.recurringPlanEnumId = enumFor("SalesRecurringPlan", p.recurringPlanEnumId, "PLAN_INVALID", "recurring plan")
    if (given("currencyUomId") || changes.estimatedAmount != null || changes.recurringAmount != null) {
        const hasAmount = (changes.estimatedAmount ?? opportunity.estimatedAmount) != null
        changes.currencyUomId =
            given("currencyUomId") && !blank(p.currencyUomId)
                ? currencyFor(organizationPartyId, p.currencyUomId, hasAmount)
                : opportunity.currencyUomId || currencyFor(organizationPartyId, null, hasAmount)
    }
    if (given("estimatedCloseDate")) changes.estimatedCloseDate = dateOf(p.estimatedCloseDate, "The expected close")
    if (given("dataSourceId")) changes.dataSourceId = sourceFor(organizationPartyId, p.dataSourceId)
    if (given("marketingCampaignId")) changes.marketingCampaignId = campaignFor(p.marketingCampaignId)
    // the probability: a value given is the rep's (Manual) unless Stage is chosen, which copies the stage's default
    const mode = text(p.probabilityModeEnumId)
    if (mode && !Object.values(modes).includes(mode)) denied("MODE_INVALID", "Choose Stage or Manual")
    if (mode === modes.stage) {
        changes.probabilityModeEnumId = modes.stage
        const stage = opportunity.opportunityStageId ? one(STAGE, {opportunityStageId: opportunity.opportunityStageId}) : null
        changes.estimatedProbability = stage?.defaultProbability ?? null
    } else if (given("estimatedProbability") || mode === modes.manual) {
        changes.probabilityModeEnumId = modes.manual
        if (given("estimatedProbability")) changes.estimatedProbability = probabilityOf(p.estimatedProbability)
    }
    if (Object.keys(changes).length > 1) call("update#" + OPPORTUNITY, changes)
    return {salesOpportunityId: opportunity.salesOpportunityId}
}

// ===== move#Opportunity =====
// A move to a stage of the deal's pipeline, or of another pipeline the organization uses when salesPipelineId is given: the
// stage's default probability copied in Stage mode only, the stage's entry dated, the move audit-logged with its note. Not a
// closure: a closed deal is refused. probabilityModeEnumId Stage or Manual changes the mode with the move.
function moveOpportunity(p) {
    const userScope = signedIn()
    const opportunity = editable(userScope, p)
    const pipeline = pipelineFor(opportunity.organizationPartyId, text(p.salesPipelineId) || opportunity.salesPipelineId)
    const stage = stageFor(pipeline, text(p.opportunityStageId) || "_NONE_")
    const mode = text(p.probabilityModeEnumId) || opportunity.probabilityModeEnumId || modes.stage
    if (!Object.values(modes).includes(mode)) denied("MODE_INVALID", "Choose Stage or Manual")
    const changes = {salesOpportunityId: opportunity.salesOpportunityId, probabilityModeEnumId: mode}
    if (stage.opportunityStageId !== opportunity.opportunityStageId) {
        changes.opportunityStageId = stage.opportunityStageId
        changes.stageEnteredDate = ec.user.nowTimestamp
        if (text(p.note)) changes.opportunityStageId_changeReason = text(p.note)
    }
    if (pipeline.salesPipelineId !== opportunity.salesPipelineId) changes.salesPipelineId = pipeline.salesPipelineId
    if (mode === modes.stage) changes.estimatedProbability = stage.defaultProbability ?? null
    else if (!blank(p.estimatedProbability)) changes.estimatedProbability = probabilityOf(p.estimatedProbability)
    call("update#" + OPPORTUNITY, changes)
    return {
        salesOpportunityId: opportunity.salesOpportunityId,
        opportunityStageId: stage.opportunityStageId,
        stageText: stage.description || stage.opportunityStageId
    }
}

// ===== close#Opportunity, reopen#Opportunity =====
// The outcome: Won, or Lost with a current lost reason (a lead's disqualification); the close time and actor, the note in the audit
// log. Won may reference accepted documents and needs no order.
function closeOpportunity(p) {
    const userScope = signedIn()
    const opportunity = editable(userScope, p)
    const statusId = text(p.statusId)
    if (!closedStatuses.includes(statusId)) denied("STATUS_INVALID", "Close a deal as Won or Lost")
    const lostReasonEnumId =
        statusId === statuses.lost ? enumFor("SalesLostReason", p.lostReasonEnumId, "REASON_INVALID", "lost reason") : null
    if (statusId === statuses.lost && !lostReasonEnumId) denied("REASON_REQUIRED", "A lost deal needs its reason")
    const closedDate = blank(p.closedDate) ? ec.user.nowTimestamp : dateOf(p.closedDate, "The close date")
    const changes = {
        salesOpportunityId: opportunity.salesOpportunityId,
        statusId,
        lostReasonEnumId,
        closedDate,
        closedByUserId: ec.user.userId
    }
    if (text(p.note)) changes.statusId_changeReason = text(p.note)
    call("update#" + OPPORTUNITY, changes)
    return {salesOpportunityId: opportunity.salesOpportunityId, statusId}
}
// A closed deal open again, with the reason (in the audit log beside the close it undoes), optionally a current stage of its
// pipeline and a new expected close. The outcome's fields are cleared; the audit log keeps the close history.
function reopenOpportunity(p) {
    const userScope = signedIn()
    const opportunity = editable(userScope, p, false)
    if (isOpen(opportunity)) denied("RECORD_OPEN", (opportunity.opportunityName || opportunity.salesOpportunityId) + " is open")
    const reason = text(p.reason)
    if (!reason) denied("REASON_REQUIRED", "Say why the deal is reopened")
    const changes = {
        salesOpportunityId: opportunity.salesOpportunityId,
        statusId: statuses.open,
        statusId_changeReason: reason,
        lostReasonEnumId: null,
        closedDate: null,
        closedByUserId: null
    }
    if (!blank(p.opportunityStageId)) {
        const stage = stageFor(pipelineFor(opportunity.organizationPartyId, opportunity.salesPipelineId), p.opportunityStageId)
        if (stage.opportunityStageId !== opportunity.opportunityStageId) {
            changes.opportunityStageId = stage.opportunityStageId
            changes.stageEnteredDate = ec.user.nowTimestamp
            if ((opportunity.probabilityModeEnumId || modes.stage) === modes.stage)
                changes.estimatedProbability = stage.defaultProbability ?? null
        }
    }
    if (!blank(p.estimatedCloseDate)) changes.estimatedCloseDate = dateOf(p.estimatedCloseDate, "The expected close")
    call("update#" + OPPORTUNITY, changes)
    return {salesOpportunityId: opportunity.salesOpportunityId, statusId: statuses.open}
}

// ===== qualify#Lead =====
// The same record promoted, atomically: its account (one given, of the organization or shared; or a new prospect named
// accountName; or the lead's own), its contact (a person given, made a contact of the account; or a new one named), its pipeline
// and stage, owner, amount and close; the type Opportunity, the conversion time and actor; the source, activities, files and
// joins kept. The operation key answers a retry with the first result, never a second account.
function qualifyLead(p) {
    const userScope = signedIn()
    const {opportunity: read} = salesAccess.requireOpportunity(userScope, text(p.salesOpportunityId), true)
    const request = {}
    for (const name of [
        "salesOpportunityId",
        "accountPartyId",
        "accountName",
        "contactPartyId",
        "contactFirstName",
        "contactLastName",
        "contactEmail",
        "salesPipelineId",
        "opportunityStageId",
        "ownerPartyId",
        "estimatedAmount",
        "currencyUomId",
        "estimatedCloseDate"
    ])
        request[name] = blank(p[name]) ? null : String(p[name])
    const op = lib.operation(p, "SalesQualifyLead", read.organizationPartyId, request)
    const previous = lib.previous(op)
    if (previous) return previous
    if (read.typeEnumId !== types.lead)
        denied("ALREADY_QUALIFIED", (read.opportunityName || read.salesOpportunityId) + " is an opportunity")
    const opportunity = editable(userScope, p)
    const organizationPartyId = opportunity.organizationPartyId
    // the account: the one given, else a new prospect, else the lead's own
    let accountPartyId = accountFor(userScope, organizationPartyId, p.accountPartyId)?.party.partyId || null
    if (!accountPartyId && text(p.accountName))
        accountPartyId = call("mantle.sales.AccountServices.create#Account", {
            organizationPartyId,
            organizationName: text(p.accountName),
            roleTypeId: "Prospect"
        }).partyId
    if (!accountPartyId && opportunity.accountPartyId)
        accountPartyId = accountFor(userScope, organizationPartyId, opportunity.accountPartyId).party.partyId
    if (!accountPartyId) denied("ACCOUNT_REQUIRED", "Choose the account or name a new one")
    // the contact: a person given, made a contact of the account; else a new person named
    let contactPartyId = null
    if (!blank(p.contactPartyId)) {
        contactPartyId = personFor(userScope, p.contactPartyId).partyId
        call("mantle.sales.AccountServices.add#Contact", {partyId: contactPartyId, accountPartyId, organizationPartyId})
    } else if (text(p.contactFirstName) || text(p.contactLastName)) {
        contactPartyId = call("mantle.sales.AccountServices.create#Contact", {
            accountPartyId,
            organizationPartyId,
            firstName: text(p.contactFirstName),
            lastName: text(p.contactLastName),
            emailAddress: text(p.contactEmail)
        }).partyId
    }
    const pipeline = pipelineFor(organizationPartyId, text(p.salesPipelineId) || opportunity.salesPipelineId)
    const stage = stageFor(pipeline, text(p.opportunityStageId) || opportunity.opportunityStageId)
    if (!blank(p.ownerPartyId))
        setOnly(opportunity.salesOpportunityId, roles.owner, ownerFor(userScope, organizationPartyId, p.ownerPartyId))
    const estimatedAmount = blank(p.estimatedAmount)
        ? opportunity.estimatedAmount
        : amountOf(p.estimatedAmount, "The estimated amount")
    const mode = opportunity.probabilityModeEnumId || modes.stage
    const changes = {
        salesOpportunityId: opportunity.salesOpportunityId,
        typeEnumId: types.opportunity,
        typeEnumId_changeReason: "Qualified",
        accountPartyId,
        salesPipelineId: pipeline.salesPipelineId,
        opportunityStageId: stage.opportunityStageId,
        probabilityModeEnumId: mode,
        estimatedAmount,
        currencyUomId: blank(p.currencyUomId)
            ? opportunity.currencyUomId || currencyFor(organizationPartyId, null, estimatedAmount != null)
            : currencyFor(organizationPartyId, p.currencyUomId, true),
        convertedDate: ec.user.nowTimestamp,
        convertedByUserId: ec.user.userId
    }
    if (mode === modes.stage) changes.estimatedProbability = stage.defaultProbability ?? null
    if (stage.opportunityStageId !== opportunity.opportunityStageId) changes.stageEnteredDate = ec.user.nowTimestamp
    if (!blank(p.estimatedCloseDate)) changes.estimatedCloseDate = dateOf(p.estimatedCloseDate, "The expected close")
    call("update#" + OPPORTUNITY, changes)
    if (contactPartyId) addContactRow(opportunity.salesOpportunityId, contactPartyId)
    const result = {salesOpportunityId: opportunity.salesOpportunityId, accountPartyId, contactPartyId}
    lib.complete(op, OPPORTUNITY, opportunity.salesOpportunityId, result)
    return result
}

// ===== store#OpportunityParty =====
// A person or team on the deal: the owner (one current primary: the previous one ends), its team (one current team), a contact
// (several); or a current row of one of them ended (end with partyId, roleTypeId and the row's fromDate). The organization's row is
// the services' own. At the deal's revision.
function storeOpportunityParty(p) {
    const userScope = signedIn()
    const opportunity = editable(userScope, p, false)
    const organizationPartyId = opportunity.organizationPartyId
    const roleTypeId = text(p.roleTypeId)
    if (!editableRoles.includes(roleTypeId)) denied("ROLE_INVALID", "Choose the owner, the team or a contact")
    const salesOpportunityId = opportunity.salesOpportunityId
    if (flag(p.end)) {
        const row = partyRowsOf(salesOpportunityId).find(
            found =>
                found.partyId === text(p.partyId) &&
                found.roleTypeId === roleTypeId &&
                current(found) &&
                (blank(p.fromDate) || ms(found.fromDate) === ms(p.fromDate))
        )
        if (!row) denied("RECORD_UNAVAILABLE", "This person is not on the deal")
        if (roleTypeId === roles.owner) denied("OWNER_REQUIRED", "Choose the new owner instead; a deal keeps its owner")
        endParty(row)
        return {salesOpportunityId}
    }
    if (roleTypeId === roles.owner) {
        if (blank(p.partyId)) denied("OWNER_INVALID", "Choose the owner")
        setOnly(salesOpportunityId, roles.owner, ownerFor(userScope, organizationPartyId, p.partyId))
    } else if (roleTypeId === roles.team) {
        const teamPartyId = teamFor(userScope, organizationPartyId, p.partyId, null)
        if (!teamPartyId) denied("TEAM_UNAVAILABLE", "Choose a current team of the deal's organization")
        setOnly(salesOpportunityId, roles.team, teamPartyId)
    } else addContactRow(salesOpportunityId, personFor(userScope, p.partyId).partyId)
    return {salesOpportunityId}
}

// ===== store#Competitor =====
// A competitor on the deal (an organization the caller may see, not internal), its position, strengths and weaknesses; remove
// takes it off. At the deal's revision.
function storeCompetitor(p) {
    const userScope = signedIn()
    const opportunity = editable(userScope, p, false)
    const competitor = salesAccess.visibleParty(userScope, text(p.competitorPartyId))
    if (!competitor || competitor.partyTypeEnumId !== "PtyOrganization" || salesAccess.isInternal(competitor.partyId))
        denied("COMPETITOR_INVALID", "Choose an organization as the competitor")
    const keys = {salesOpportunityId: opportunity.salesOpportunityId, competitorPartyId: competitor.partyId}
    const found = one(COMPETITOR, keys)
    if (flag(p.remove)) {
        if (found) call("delete#" + COMPETITOR, keys)
        return keys
    }
    call(
        (found ? "update#" : "create#") + COMPETITOR,
        Object.assign({}, keys, {
            positionEnumId: enumFor("SalesCompetitorPosition", p.positionEnumId, "POSITION_INVALID", "position"),
            strengths: text(p.strengths),
            weaknesses: text(p.weaknesses)
        })
    )
    return keys
}

// ===== apply#OpportunityBatch =====
// Each deal on its own (OpportunityBatch): move to a stage, assign an owner or close as Lost, each at the revision its key names
// ("id@revision"), in its own transaction; a stale, refused or failed deal is named with its reason and the others go on.
function applyOpportunityBatch(p) {
    signedIn()
    const operation = text(p.operation)
    const verbs = {
        move: key => ["mantle.sales.OpportunityServices.move#Opportunity", {opportunityStageId: p.opportunityStageId}],
        assign: key => [
            "mantle.sales.OpportunityServices.store#OpportunityParty",
            {roleTypeId: roles.owner, partyId: p.ownerPartyId}
        ],
        lose: key => [
            "mantle.sales.OpportunityServices.close#Opportunity",
            {statusId: statuses.lost, lostReasonEnumId: p.lostReasonEnumId, note: p.note}
        ]
    }
    if (!Object.hasOwn(verbs, operation)) denied("OPERATION_INVALID", "Choose move, assign or lose")
    const keys = (Array.isArray(p.opportunityKeys) ? p.opportunityKeys : String(p.opportunityKeys || "").split(","))
        .map(key => String(key).trim())
        .filter(Boolean)
    if (!keys.length) denied("SELECTION_REQUIRED", "Choose the deals")
    const results = []
    for (const key of Array.from(new Set(keys))) {
        const [salesOpportunityId, expectedRevision] = key.split("@")
        const [service, parameters] = verbs[operation](key)
        try {
            lib.probe(service, Object.assign({salesOpportunityId, expectedRevision: expectedRevision || ""}, parameters))
            results.push({salesOpportunityId, ok: true, reasonCode: null, message: ""})
        } catch (error) {
            results.push({
                salesOpportunityId,
                ok: false,
                // the code of the first "CODE: message" in the errors (a service's errors read "Error: CODE: ...")
                reasonCode: lib.reasonCode(error) || /\b([A-Z][A-Z0-9_]{2,}):/.exec(String(error.message || ""))?.[1] || null,
                message: String(error.message || error)
            })
        }
    }
    return {results, successCount: results.filter(row => row.ok).length}
}

// ===== reads =====
const enumNames = enumIds => {
    const ids = Array.from(new Set(enumIds.filter(Boolean)))
    if (!ids.length) return {}
    return Object.fromEntries(
        Array.from(find(ENUM).condition("enumId", "in", ids).list()).map(row => [row.enumId, row.description])
    )
}
const statusNames = () =>
    Object.fromEntries(
        rows("moqui.basic.StatusItem", {statusTypeId: "SalesOpportunity"}).map(row => [row.statusId, row.description])
    )
// The current owner and team of deals, by deal: {id: {owner, team, rows}}.
function peopleOf(ids) {
    const out = {}
    if (!ids.length) return out
    for (const row of find(OPPORTUNITY_PARTY).condition("salesOpportunityId", "in", ids).list()) {
        const entry = (out[row.salesOpportunityId] = out[row.salesOpportunityId] || {rows: []})
        entry.rows.push(row)
        if (!current(row)) continue
        if (row.roleTypeId === roles.owner) entry.owner = row.partyId
        if (row.roleTypeId === roles.team) entry.team = row.partyId
    }
    return out
}
// The next open activity of deals (a linked task not done, the earliest due), by deal.
function nextActivities(ids) {
    const out = {}
    if (!ids.length) return out
    const links = Array.from(find(WORK_LINK).condition("salesOpportunityId", "in", ids).list())
    if (!links.length) return out
    const tasks = Object.fromEntries(
        Array.from(
            find("mantle.work.effort.WorkEffort")
                .condition(
                    "workEffortId",
                    "in",
                    links.map(row => row.workEffortId)
                )
                .condition("statusId", "not-in", doneTaskStatuses)
                .list()
        ).map(row => [row.workEffortId, row])
    )
    for (const link of links) {
        const task = tasks[link.workEffortId]
        if (!task) continue
        const known = out[link.salesOpportunityId]
        const due = ms(task.estimatedCompletionDate) ?? Infinity
        if (!known || due < known.due) out[link.salesOpportunityId] = {due, task}
    }
    return out
}
// The organization the board's columns are for: the one asked, else the active one, else the scope's only one.
function boardOrganization(userScope, organizationPartyId) {
    if (organizationPartyId) return organizationPartyId
    if (userScope.activeOrganizationPartyId) return userScope.activeOrganizationPartyId
    return userScope.organizationPartyIds?.length === 1 ? userScope.organizationPartyIds[0] : null
}
// The ids of the deals with a current row of a role for a party.
function idsWith(roleTypeId, partyId) {
    return Array.from(
        find(OPPORTUNITY_PARTY)
            .condition("partyId", partyId)
            .condition("roleTypeId", roleTypeId)
            .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
            .selectField("salesOpportunityId")
            .list()
    ).map(row => row.salesOpportunityId)
}

// find#Opportunities: the one scoped query of the board, the list, the calendar, Home and the palette.
function findOpportunities(p) {
    const userScope = salesAccess.scope()
    salesAccess.requireCapability(userScope, "anyRead")
    const organizationPartyId = text(p.organizationPartyId)
    if (organizationPartyId) salesAccess.requireOrganization(userScope, organizationPartyId)
    const factory = ec.entity.conditionFactory
    // the conditions, applied to a fresh find for the page and for the totals
    const conditions = []
    const add = (field, operator, value) => conditions.push(factory.makeCondition(field, operator, value))
    let none = false
    if (organizationPartyId) add("organizationPartyId", "equals", organizationPartyId)
    else if (userScope.organizationPartyIds != null) {
        if (!userScope.organizationPartyIds.length) none = true
        else add("organizationPartyId", "in", Array.from(userScope.organizationPartyIds))
    }
    let ids = salesAccess.assignedOpportunityIds(userScope)
    const narrow = found => {
        ids = ids == null ? found : ids.filter(id => found.includes(id))
    }
    const ownerPartyId = flag(p.mine) ? userScope.partyId : text(p.ownerPartyId)
    if (ownerPartyId) narrow(idsWith(roles.owner, ownerPartyId))
    if (text(p.teamPartyId)) narrow(idsWith(roles.team, text(p.teamPartyId)))
    if (ids != null) {
        if (!ids.length) none = true
        else add("salesOpportunityId", "in", ids)
    }
    for (const field of [
        "typeEnumId",
        "salesPipelineId",
        "opportunityStageId",
        "accountPartyId",
        "dataSourceId",
        "marketingCampaignId"
    ])
        if (text(p[field])) add(field, "equals", text(p[field]))
    const statusId = text(p.statusId)
    if (statusId === statuses.open)
        conditions.push(
            factory.makeCondition(
                [factory.makeCondition("statusId", "not-in", closedStatuses), factory.makeCondition("statusId", "is-null", null)],
                "or"
            )
        )
    else if (statusId === "closed") add("statusId", "in", closedStatuses)
    else if (statusId) add("statusId", "equals", statusId)
    if (!blank(p.closeFrom)) add("estimatedCloseDate", "greater-equals", dateOf(p.closeFrom, "The close period"))
    if (!blank(p.closeThru)) add("estimatedCloseDate", "less", new Date(ms(dateOf(p.closeThru, "The close period")) + dayMs))
    if (!blank(p.closeFrom) || !blank(p.closeThru)) add("estimatedCloseDate", "is-not-null", null)
    const term = text(p.text)
    if (term)
        conditions.push(
            factory.makeCondition(
                ["salesOpportunityId", "opportunityName"].map(field =>
                    factory.makeCondition(field, "like", likeText(term)).ignoreCase()
                ),
                "or"
            )
        )
    const query = () => {
        let found = find(OPPORTUNITY)
        for (const condition of conditions) found = found.condition(condition)
        return found
    }
    const orderBy = text(p.orderByField)
    const sort =
        orderBy && /^[-+^]?(opportunityName|estimatedAmount|estimatedCloseDate|createdDate|estimatedProbability)$/.test(orderBy)
            ? [orderBy, "salesOpportunityId"]
            : ["estimatedCloseDate", "opportunityName", "salesOpportunityId"]
    const count = none ? 0 : query().count()
    const paged = lib.page(
        none ? query().condition("salesOpportunityId", "_NONE_") : query().orderBy(sort),
        p,
        "opportunityList",
        count,
        {
            noLimitCap: 1000
        }
    )
    // the totals of the whole filtered result, by currency
    const totals = {}
    if (!none)
        for (const row of query().selectField("currencyUomId").selectField("estimatedAmount").list()) {
            if (row.estimatedAmount == null) continue
            const key = row.currencyUomId || ""
            const total = (totals[key] = totals[key] || {
                currencyUomId: row.currencyUomId || null,
                amount: toDecimal(0),
                count: 0
            })
            total.amount = total.amount.add(toDecimal(row.estimatedAmount))
            total.count++
        }
    const pageRows = paged.rows
    const pageIds = pageRows.map(row => row.salesOpportunityId)
    const people = peopleOf(pageIds)
    const activities = nextActivities(pageIds)
    const stageIds = Array.from(new Set(pageRows.map(row => row.opportunityStageId).filter(Boolean)))
    const stages = stageIds.length
        ? Object.fromEntries(
              Array.from(find(STAGE).condition("opportunityStageId", "in", stageIds).list()).map(row => [
                  row.opportunityStageId,
                  row
              ])
          )
        : {}
    const enums = enumNames(pageRows.flatMap(row => [row.typeEnumId, row.lostReasonEnumId, row.recurringPlanEnumId]))
    const statusText = statusNames()
    const accountNames = {}
    for (const accountPartyId of Array.from(new Set(pageRows.map(row => row.accountPartyId).filter(Boolean)))) {
        const account = salesAccess.accountOf(userScope, accountPartyId)
        if (account) accountNames[accountPartyId] = lib.partyNames([accountPartyId])[accountPartyId] || accountPartyId
    }
    const partyIds = Object.values(people).flatMap(entry => [entry.owner, entry.team])
    const names = lib.partyNames(partyIds.filter(Boolean))
    const sourceIds = Array.from(new Set(pageRows.map(row => row.dataSourceId).filter(Boolean)))
    const sources = sourceIds.length
        ? Object.fromEntries(
              Array.from(find("moqui.basic.DataSource").condition("dataSourceId", "in", sourceIds).list()).map(row => [
                  row.dataSourceId,
                  row.description
              ])
          )
        : {}
    const at = nowMs()
    const opportunityList = pageRows.map(row => {
        const entry = people[row.salesOpportunityId] || {rows: []}
        const stage = stages[row.opportunityStageId]
        const next = activities[row.salesOpportunityId]
        const revision = revisionOf(row, entry.rows)
        const statusIdOf = row.statusId || statuses.open
        return {
            salesOpportunityId: row.salesOpportunityId,
            opportunityName: row.opportunityName || row.salesOpportunityId,
            typeEnumId: row.typeEnumId,
            typeText: enums[row.typeEnumId] || "",
            organizationPartyId: row.organizationPartyId,
            accountPartyId: accountNames[row.accountPartyId] ? row.accountPartyId : null,
            accountName: accountNames[row.accountPartyId] || "",
            estimatedAmount: row.estimatedAmount,
            currencyUomId: row.currencyUomId,
            amountText: row.estimatedAmount == null ? L("Unestimated") : amountText(row.estimatedAmount, row.currencyUomId),
            estimatedProbability: row.estimatedProbability,
            probabilityText: percentText(row.estimatedProbability),
            probabilityModeEnumId: row.probabilityModeEnumId,
            estimatedCloseDate: row.estimatedCloseDate,
            closeText: dayText(row.estimatedCloseDate),
            salesPipelineId: row.salesPipelineId,
            opportunityStageId: row.opportunityStageId,
            stageText: stage ? stage.description || stage.opportunityStageId : "",
            stageAgeText: row.stageEnteredDate ? Math.floor((at - ms(row.stageEnteredDate)) / dayMs) + " d" : "",
            statusId: statusIdOf,
            statusText: statusText[statusIdOf] || statusIdOf,
            statusColor: statusColors[statusIdOf] || "grey",
            lostReasonText: enums[row.lostReasonEnumId] || "",
            ownerPartyId: entry.owner || null,
            ownerName: entry.owner ? names[entry.owner] || entry.owner : "",
            teamPartyId: entry.team || null,
            teamName: entry.team ? names[entry.team] || entry.team : "",
            sourceText: sources[row.dataSourceId] || "",
            marketingCampaignId: row.marketingCampaignId || null,
            createdText: dayText(row.createdDate),
            ageText: row.createdDate ? Math.floor((at - ms(row.createdDate)) / dayMs) + " d" : "",
            nextActivityText: next
                ? next.task.workEffortName +
                  (next.task.estimatedCompletionDate ? " · " + dayText(next.task.estimatedCompletionDate) : "")
                : "",
            recurringText:
                row.recurringAmount == null
                    ? ""
                    : amountText(row.recurringAmount, row.currencyUomId) +
                      " " +
                      (enums[row.recurringPlanEnumId] || "").toLowerCase(),
            revision,
            selectionKey: row.salesOpportunityId + "@" + revision
        }
    })
    // the board's columns: the stages of the pipeline asked, else of the organization's default, in order (empty ones too)
    const boardOrganizationId = boardOrganization(userScope, organizationPartyId)
    let boardPipeline = null
    try {
        boardPipeline = text(p.salesPipelineId)
            ? one(PIPELINE, {salesPipelineId: text(p.salesPipelineId)})
            : boardOrganizationId
              ? settings.defaultPipeline(boardOrganizationId)
              : null
    } catch (error) {
        boardPipeline = null
    }
    const stageColumns = boardPipeline
        ? settings.stagesOf(boardPipeline.salesPipelineId).map(row => ({
              opportunityStageId: row.opportunityStageId,
              description: row.description || row.opportunityStageId
          }))
        : []
    return Object.assign(paged, {
        opportunityList,
        totals: Object.values(totals).map(total => ({
            currencyUomId: total.currencyUomId,
            amount: total.amount,
            count: total.count,
            amountText: amountText(total.amount, total.currencyUomId)
        })),
        boardPipelineId: boardPipeline?.salesPipelineId || null,
        stageColumns
    })
}

// get#Opportunity: OpportunityDetail's record as the caller may see it, or opportunityFound false.
function getOpportunity(p) {
    const userScope = salesAccess.scope()
    const found = salesAccess.opportunityOf(userScope, text(p.salesOpportunityId))
    if (!found) return {opportunityFound: false}
    const row = found.opportunity
    const partyRows = partyRowsOf(row.salesOpportunityId)
    const revision = revisionOf(row, partyRows)
    const statusId = row.statusId || statuses.open
    const open = isOpen(row)
    const caps = userScope.capabilities
    const canEdit = !!caps.opportunityEdit
    const enums = enumNames([row.typeEnumId, row.lostReasonEnumId, row.recurringPlanEnumId, row.probabilityModeEnumId])
    const account = row.accountPartyId ? salesAccess.accountOf(userScope, row.accountPartyId) : null
    const pipeline = row.salesPipelineId ? one(PIPELINE, {salesPipelineId: row.salesPipelineId}) : null
    const stages = pipeline ? settings.stagesOf(pipeline.salesPipelineId) : []
    const stage = row.opportunityStageId ? one(STAGE, {opportunityStageId: row.opportunityStageId}) : null
    const names = lib.partyNames(
        partyRows.map(partyRow => partyRow.partyId).concat(row.accountPartyId ? [row.accountPartyId] : [])
    )
    const at = nowMs()
    const roleNames = {
        SalesRepresentative: L("Owner"),
        SalesTeam: L("Team"),
        Contact: L("Contact"),
        OrgInternal: L("Organization")
    }
    const parties = partyRows
        .filter(partyRow => partyRow.roleTypeId !== roles.organization)
        .sort((a, b) => (ms(b.fromDate) ?? 0) - (ms(a.fromDate) ?? 0))
        .map(partyRow => ({
            partyId: partyRow.partyId,
            name: names[partyRow.partyId] || partyRow.partyId,
            roleTypeId: partyRow.roleTypeId,
            roleText: roleNames[partyRow.roleTypeId] || partyRow.roleTypeId,
            fromDate: partyRow.fromDate,
            fromText: dayText(partyRow.fromDate),
            thruText: dayText(partyRow.thruDate),
            current: current(partyRow, at)
        }))
    const ownerRow = parties.find(partyRow => partyRow.current && partyRow.roleTypeId === roles.owner)
    const teamRow = parties.find(partyRow => partyRow.current && partyRow.roleTypeId === roles.team)
    const competitorRows = rows(COMPETITOR, {salesOpportunityId: row.salesOpportunityId})
    const competitorNames = lib.partyNames(competitorRows.map(competitor => competitor.competitorPartyId))
    const positions = enumNames(competitorRows.map(competitor => competitor.positionEnumId))
    const competitors = competitorRows.map(competitor => ({
        competitorPartyId: competitor.competitorPartyId,
        name: competitorNames[competitor.competitorPartyId] || L("A competitor"),
        positionEnumId: competitor.positionEnumId,
        positionText: positions[competitor.positionEnumId] || "",
        strengths: competitor.strengths || "",
        weaknesses: competitor.weaknesses || ""
    }))
    // the linked tasks (activities), open first
    const links = rows(WORK_LINK, {salesOpportunityId: row.salesOpportunityId})
    const tasks = links.length
        ? Array.from(
              find("mantle.work.effort.WorkEffort")
                  .condition(
                      "workEffortId",
                      "in",
                      links.map(link => link.workEffortId)
                  )
                  .orderBy(["estimatedCompletionDate", "workEffortId"])
                  .list()
          )
        : []
    const taskStatus = tasks.length
        ? Object.fromEntries(
              Array.from(
                  find("moqui.basic.StatusItem")
                      .condition("statusId", "in", Array.from(new Set(tasks.map(task => task.statusId).filter(Boolean))))
                      .list()
              ).map(item => [item.statusId, item.description])
          )
        : {}
    const activities = tasks.map(task => ({
        workEffortId: task.workEffortId,
        workEffortName: task.workEffortName || task.workEffortId,
        dueText: dayText(task.estimatedCompletionDate),
        statusText: taskStatus[task.statusId] || task.statusId || "",
        done: doneTaskStatuses.includes(task.statusId)
    }))
    // the linked quotes and orders: an organization reader's until the quote and order scope (P7, P11), of the scope's sellers
    const orders = []
    if (caps.teamRead)
        for (const link of rows(ORDER_LINK, {salesOpportunityId: row.salesOpportunityId})) {
            const order = one("mantle.order.OrderHeader", {orderId: link.orderId})
            if (!order) continue
            const vendor = Array.from(
                find("mantle.order.OrderPart").condition("orderId", link.orderId).selectField("vendorPartyId").list()
            )
                .map(part => part.vendorPartyId)
                .some(partyId => salesAccess.covers(userScope, partyId))
            if (!vendor) continue
            const status = order.statusId ? one("moqui.basic.StatusItem", {statusId: order.statusId}) : null
            orders.push({
                orderId: order.orderId,
                orderName: order.orderName || order.orderId,
                statusText: status?.description || order.statusId || "",
                dateText: dayText(order.entryDate || order.placedDate),
                amountText: order.grandTotal == null ? "" : amountText(order.grandTotal, order.currencyUomId)
            })
        }
    const source = row.dataSourceId ? one("moqui.basic.DataSource", {dataSourceId: row.dataSourceId}) : null
    const campaign = row.marketingCampaignId
        ? one("mantle.marketing.campaign.MarketingCampaign", {marketingCampaignId: row.marketingCampaignId})
        : null
    const organization = one("mantle.party.Organization", {partyId: row.organizationPartyId})
    const opportunity = {
        salesOpportunityId: row.salesOpportunityId,
        opportunityName: row.opportunityName || row.salesOpportunityId,
        typeEnumId: row.typeEnumId,
        typeText: enums[row.typeEnumId] || "",
        isLead: row.typeEnumId === types.lead,
        organizationPartyId: row.organizationPartyId,
        organizationName: organization?.organizationName || row.organizationPartyId,
        accountPartyId: account ? row.accountPartyId : null,
        accountName: account ? names[row.accountPartyId] || row.accountPartyId : "",
        description: row.description || "",
        nextStep: row.nextStep || "",
        estimatedAmount: row.estimatedAmount,
        currencyUomId: row.currencyUomId,
        amountText: row.estimatedAmount == null ? L("Unestimated") : amountText(row.estimatedAmount, row.currencyUomId),
        estimatedProbability: row.estimatedProbability == null ? null : Number(String(row.estimatedProbability)),
        probabilityText: percentText(row.estimatedProbability),
        probabilityModeEnumId: row.probabilityModeEnumId || modes.stage,
        probabilityModeText: enums[row.probabilityModeEnumId] || "",
        estimatedCloseDate: row.estimatedCloseDate,
        closeText: dayText(row.estimatedCloseDate),
        recurringAmount: row.recurringAmount,
        recurringPlanEnumId: row.recurringPlanEnumId,
        recurringText:
            row.recurringAmount == null
                ? ""
                : amountText(row.recurringAmount, row.currencyUomId) + " " + (enums[row.recurringPlanEnumId] || "").toLowerCase(),
        salesPipelineId: row.salesPipelineId,
        pipelineName: pipeline?.pipelineName || "",
        opportunityStageId: row.opportunityStageId,
        stageText: stage ? stage.description || stage.opportunityStageId : "",
        stageAgeText: row.stageEnteredDate ? Math.floor((at - ms(row.stageEnteredDate)) / dayMs) + " d" : "",
        statusId,
        statusText: statusNames()[statusId] || statusId,
        statusColor: statusColors[statusId] || "grey",
        lostReasonEnumId: row.lostReasonEnumId,
        lostReasonText: enums[row.lostReasonEnumId] || "",
        closedText: dayText(row.closedDate),
        convertedText: dayText(row.convertedDate),
        createdText: dayText(row.createdDate),
        dataSourceId: row.dataSourceId,
        sourceText: source?.description || "",
        marketingCampaignId: row.marketingCampaignId,
        campaignText: campaign?.campaignName || "",
        ownerPartyId: ownerRow?.partyId || null,
        ownerName: ownerRow?.name || "",
        teamPartyId: teamRow?.partyId || null,
        teamName: teamRow?.name || "",
        revision
    }
    return {
        opportunityFound: true,
        opportunity,
        stages: stages.map(stageRow => ({
            opportunityStageId: stageRow.opportunityStageId,
            description: stageRow.description || stageRow.opportunityStageId,
            defaultProbability: stageRow.defaultProbability == null ? null : Number(String(stageRow.defaultProbability)),
            current: stageRow.opportunityStageId === row.opportunityStageId
        })),
        parties,
        competitors,
        activities,
        orders,
        canEdit: canEdit && open,
        canClose: canEdit && open,
        canReopen: canEdit && !open,
        canQualify: canEdit && open && row.typeEnumId === types.lead,
        canAddActivity: canEdit
    }
}

// check#OpportunityAccess: whether the caller sees the deal and may change it (get#RecordLinkInfo, RecordFiles); a call with no
// user sees none.
function opportunityAccess(p) {
    if (!ec.user.userId) return {recordVisible: false, canEdit: false}
    const found = salesAccess.opportunityOf(salesAccess.scope(), text(p.salesOpportunityId))
    return {recordVisible: !!found, canEdit: !!found?.canEdit, organizationPartyId: found?.organizationPartyId || null}
}
// create#OpportunityContent's check: the deal's editor.
function contentAccess(p) {
    return salesAccess.requireOpportunity(signedIn(), text(p.salesOpportunityId), true)
}

// ===== add#OpportunityActivity =====
// An activity on the deal: a Commons task (create#SimpleTask) assigned to the caller or a person who works for the deal's
// organization, due when given, linked to the deal (link#WorkEffortRecord, which writes SalesOpportunityWorkEffort). Completing it
// neither qualifies nor closes the deal.
function addActivity(p) {
    const userScope = signedIn()
    const {opportunity} = salesAccess.requireOpportunity(userScope, text(p.salesOpportunityId), true)
    const workEffortName = text(p.workEffortName)
    if (!workEffortName) denied("NAME_REQUIRED", "Name the activity")
    const assignee = text(p.assignToPartyId) || userScope.partyId
    if (!assignee || !settings.worksFor(assignee, opportunity.organizationPartyId))
        denied("OWNER_INVALID", "The activity goes to a person who works for the deal's organization")
    const workEffortId = call("mantle.work.TaskServices.create#SimpleTask", {
        workEffortName,
        description: text(p.description),
        estimatedCompletionDate: dateOf(p.estimatedCompletionDate, "The due date"),
        assignToPartyId: assignee
    }).workEffortId
    call("mantle.work.WorkEffortServices.link#WorkEffortRecord", {
        workEffortId,
        recordEntityName: OPPORTUNITY,
        recordId: opportunity.salesOpportunityId
    })
    return {workEffortId}
}

const operations = {
    createOpportunity,
    updateOpportunity,
    moveOpportunity,
    closeOpportunity,
    reopenOpportunity,
    qualifyLead,
    storeOpportunityParty,
    storeCompetitor,
    applyOpportunityBatch,
    findOpportunities,
    getOpportunity,
    opportunityAccess,
    contentAccess,
    addActivity
}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown sales opportunity operation " + op)
        return operations[op](parameters || {})
    }
})
