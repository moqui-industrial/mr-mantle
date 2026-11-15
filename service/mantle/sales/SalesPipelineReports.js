// Sales' pipeline reports (mantle.sales.ForecastServices get#PipelineAnalysis and get#WinLoss; IronStone Sales design §8
// PipelineAnalysis and WinLoss; impl-sales P19, SAL-REPORT, SAL-ANALYTICS).
//
// - Both read the deals of a Sales report reader (SALES_REPORT_VIEW) in the organizations of their scope, and only those they see
//   (SalesAccess.js assignedOpportunityIds: their own and their teams' for a reader without SALES_TEAM_VIEW); another organization
//   is refused (ORGANIZATION_DENIED). Nothing is added across currencies: every amount is by currency, and counts are counts.
// - A deal as it stood at a time is read from its audit log: a field's value then is the old value of its first change after that
//   time, else its value now (statusId, typeEnumId, opportunityStageId, estimatedAmount, estimatedProbability, estimatedCloseDate,
//   recurringAmount and closedDate are audit-logged, SalesEntities.xml). Its owner and team then are its dated party rows.
// - Stage durations are measured between audited stage changes, reopenings included: a stay whose entry or exit the log does not
//   show (a deal whose first recorded change starts from a stage, or two changes that do not chain) is counted as unknown, never
//   guessed. Lead conversion is over an explicit cohort of leads created between two days (convertedDate, set once by
//   qualify#Lead), not over today's type counts.
// - Win/loss is over a close cohort: in the final-outcome mode (the default) each deal once, by its outcome and close date as of
//   the report time; in the event mode each close event in the period, a reopened deal's earlier close among them. Win rate is won
//   over won and lost opportunities only; a lead closed Lost (disqualified before qualification) is counted apart.
// - A read past 2,000 deals is refused naming what to narrow (TOO_MANY_RECORDS), never counted short.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const salesAccess = ec.resource.script("component://mr-mantle/service/mantle/sales/SalesAccess.js")
const {find, one, rows, denied, ms} = lib

const OPPORTUNITY = "mantle.sales.opportunity.SalesOpportunity"
const OPPORTUNITY_PARTY = "mantle.sales.opportunity.SalesOpportunityParty"
const STAGE = "mantle.sales.opportunity.SalesOpportunityStage"
const WORK_LINK = "mantle.sales.opportunity.SalesOpportunityWorkEffort"
const AUDIT = "moqui.entity.EntityAuditLog"
const roles = salesAccess.opportunityRoles
const types = {lead: "SotLead", opportunity: "SotOpportunity"}
const statuses = {open: "SalesOppOpen", won: "SalesOppWon", lost: "SalesOppLost"}
const closedStatuses = [statuses.won, statuses.lost]
const doneTaskStatuses = ["WeComplete", "WeClosed", "WeCancelled"]
const auditedFields = [
    "statusId",
    "typeEnumId",
    "opportunityStageId",
    "estimatedAmount",
    "estimatedProbability",
    "estimatedCloseDate",
    "recurringAmount",
    "closedDate",
    "lostReasonEnumId"
]
const dealLimit = 2000
const dayMs = 24 * 60 * 60 * 1000
const groupings = ["stage", "source", "owner", "age"]
const ageBands = [
    {key: "a30", label: "Up to 30 days", upTo: 30},
    {key: "a60", label: "31 to 60 days", upTo: 60},
    {key: "a90", label: "61 to 90 days", upTo: 90},
    {key: "a90plus", label: "More than 90 days", upTo: Infinity}
]
// The visit step of the funnel (impl-sales P19; Marketing P20 adds visits): a service of this name, when it exists, answers
// {visitCount} for {organizationPartyId, fromDate, thruDate, marketingCampaignId, dataSourceId}; until then the step is not
// available, never zero.
const visitService = "mantle.marketing.MarketingReportServices.count#SalesVisits"

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const L = value => ec.l10n.localize(value)
const zero = () => toDecimal(0)
const moneyText = (value, currencyUomId) =>
    value == null
        ? ""
        : currencyUomId
          ? ec.l10n.formatCurrency(ec.l10n.roundCurrency(toDecimal(value), currencyUomId), currencyUomId)
          : ec.l10n.format(toDecimal(value), "#,##0.00")
const dayText = value => (value == null ? "" : ec.l10n.format(new Date(value), "d MMM yyyy"))
const daysText = value => (value == null ? "" : ec.l10n.format(value, "0.#") + " d")
const percentOf = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : null)
const percentText = value => (value == null ? "" : value + " %")
// A timestamp from a stored value or an audit text (digits are millis; a date and time with a space is read as one with a T).
function timeOf(value) {
    if (value == null || value === "") return null
    if (value instanceof Date) return value.getTime()
    const found = String(value).trim()
    if (/^-?\d+$/.test(found)) return Number(found)
    const parsed = Date.parse(found.replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, "$1T$2"))
    return Number.isFinite(parsed) ? parsed : ms(found)
}
const decimalOf = value => (value == null || value === "" ? null : toDecimal(value))
function dateOf(value, label) {
    if (blank(value)) return null
    const found = timeOf(value)
    if (found == null || !Number.isFinite(found)) denied("DATE_INVALID", label + " is not a date")
    return found
}
const inChunks = (ids, read) => {
    const out = []
    for (let index = 0; index < ids.length; index += 500) out.push(...read(ids.slice(index, index + 500)))
    return out
}

// ===== scope and the deals =====
function reader(p) {
    const userScope = salesAccess.scope()
    salesAccess.requireCapability(userScope, "reportRead")
    const organizationPartyId = text(p.organizationPartyId)
    if (organizationPartyId) salesAccess.requireOrganization(userScope, organizationPartyId)
    return {userScope, organizationPartyId}
}
// The ids of the deals with a row of a role for a party in effect at a time.
function idsWith(roleTypeId, partyId, at) {
    return Array.from(
        find(OPPORTUNITY_PARTY)
            .condition("partyId", partyId)
            .condition("roleTypeId", roleTypeId)
            .conditionDate("fromDate", "thruDate", new Date(at))
            .selectField("salesOpportunityId")
            .list()
    ).map(row => row.salesOpportunityId)
}
// The deals the reader sees under the filters, made by the time given: at most dealLimit, else refused.
function deals(scope, p, at) {
    const {userScope, organizationPartyId} = scope
    let query = find(OPPORTUNITY)
    if (organizationPartyId) query = query.condition("organizationPartyId", organizationPartyId)
    else if (userScope.organizationPartyIds != null) {
        if (!userScope.organizationPartyIds.length) return []
        query = query.condition("organizationPartyId", "in", Array.from(userScope.organizationPartyIds))
    }
    let ids = salesAccess.assignedOpportunityIds(userScope)
    const narrow = found => {
        ids = ids == null ? found : ids.filter(id => found.includes(id))
    }
    if (text(p.ownerPartyId)) narrow(idsWith(roles.owner, text(p.ownerPartyId), at))
    if (text(p.teamPartyId)) narrow(idsWith(roles.team, text(p.teamPartyId), at))
    if (ids != null) {
        if (!ids.length) return []
        query = query.condition("salesOpportunityId", "in", ids)
    }
    for (const field of ["salesPipelineId", "dataSourceId", "marketingCampaignId", "accountPartyId"])
        if (text(p[field])) query = query.condition(field, text(p[field]))
    query = query.condition(
        ec.entity.conditionFactory.makeCondition(
            [
                ec.entity.conditionFactory.makeCondition("createdDate", "is-null", null),
                ec.entity.conditionFactory.makeCondition("createdDate", "less-equals", new Date(at))
            ],
            "or"
        )
    )
    const found = Array.from(
        query
            .orderBy("salesOpportunityId")
            .limit(dealLimit + 1)
            .list()
    )
    if (found.length > dealLimit)
        denied(
            "TOO_MANY_RECORDS",
            "More than " + dealLimit + " deals to count here; choose a team, a person, a source or a pipeline"
        )
    return found
}
// The audit history of deals, by deal and field, in the order written.
function histories(ids) {
    const out = {}
    const order = (a, b) =>
        (timeOf(a.changedDate) ?? 0) - (timeOf(b.changedDate) ?? 0) ||
        (Number(a.auditHistorySeqId) || 0) - (Number(b.auditHistorySeqId) || 0) ||
        String(a.auditHistorySeqId).localeCompare(String(b.auditHistorySeqId))
    for (const row of inChunks(ids, chunk =>
        Array.from(
            find(AUDIT)
                .condition("changedEntityName", OPPORTUNITY)
                .condition("changedFieldName", "in", auditedFields)
                .condition("pkPrimaryValue", "in", chunk)
                .list()
        )
    )) {
        const deal = (out[row.pkPrimaryValue] = out[row.pkPrimaryValue] || {})
        ;(deal[row.changedFieldName] = deal[row.changedFieldName] || []).push(row)
    }
    for (const deal of Object.values(out)) for (const list of Object.values(deal)) list.sort(order)
    return out
}
// A field's value at a time: the old value of its first change after it, else the value now.
function valueAt(deal, history, field, at) {
    const later = (history?.[field] || []).find(change => (timeOf(change.changedDate) ?? 0) > at)
    if (later) return later.oldValueText == null || later.oldValueText === "" ? null : later.oldValueText
    const value = deal[field]
    return value == null || value === "" ? null : value
}
// A deal as it stood at a time.
function dealAt(deal, history, at) {
    const value = field => valueAt(deal, history, field, at)
    return {
        deal,
        salesOpportunityId: deal.salesOpportunityId,
        statusId: value("statusId") || statuses.open,
        typeEnumId: value("typeEnumId"),
        opportunityStageId: value("opportunityStageId"),
        estimatedAmount: decimalOf(value("estimatedAmount")),
        estimatedProbability: decimalOf(value("estimatedProbability")),
        estimatedCloseDate: timeOf(value("estimatedCloseDate")),
        recurringAmount: decimalOf(value("recurringAmount")),
        closedDate: timeOf(value("closedDate")),
        lostReasonEnumId: value("lostReasonEnumId"),
        currencyUomId: deal.currencyUomId || null,
        createdDate: timeOf(deal.createdDate)
    }
}
// The owner and team of deals at a time, by deal.
function peopleAt(ids, at) {
    const out = {}
    for (const row of inChunks(ids, chunk =>
        Array.from(
            find(OPPORTUNITY_PARTY)
                .condition("salesOpportunityId", "in", chunk)
                .condition("roleTypeId", "in", [roles.owner, roles.team])
                .conditionDate("fromDate", "thruDate", new Date(at))
                .list()
        )
    )) {
        const entry = (out[row.salesOpportunityId] = out[row.salesOpportunityId] || {})
        if (row.roleTypeId === roles.owner) entry.owner = row.partyId
        else entry.team = row.partyId
    }
    return out
}
// The deals with an open linked activity now, with the next one's name and due day.
function nextActivities(ids) {
    const out = {}
    const links = inChunks(ids, chunk => Array.from(find(WORK_LINK).condition("salesOpportunityId", "in", chunk).list()))
    if (!links.length) return out
    const tasks = new Map(
        inChunks([...new Set(links.map(row => row.workEffortId))], chunk =>
            Array.from(
                find("mantle.work.effort.WorkEffort")
                    .condition("workEffortId", "in", chunk)
                    .condition("statusId", "not-in", doneTaskStatuses)
                    .list()
            )
        ).map(row => [row.workEffortId, row])
    )
    for (const link of links) {
        const task = tasks.get(link.workEffortId)
        if (!task) continue
        const due = timeOf(task.estimatedCompletionDate) ?? Infinity
        if (!out[link.salesOpportunityId] || due < out[link.salesOpportunityId].due) out[link.salesOpportunityId] = {due, task}
    }
    return out
}
function names(ids) {
    return lib.partyNames([...new Set(ids.filter(Boolean))])
}
function stageNames(stageIds) {
    const ids = [...new Set(stageIds.filter(Boolean))]
    return Object.fromEntries(
        ids.length
            ? Array.from(find(STAGE).condition("opportunityStageId", "in", ids).list()).map(row => [row.opportunityStageId, row])
            : []
    )
}
function sourceNames(sourceIds) {
    const ids = [...new Set(sourceIds.filter(Boolean))]
    return Object.fromEntries(
        ids.length
            ? Array.from(find("moqui.basic.DataSource").condition("dataSourceId", "in", ids).list()).map(row => [
                  row.dataSourceId,
                  row.description || row.dataSourceId
              ])
            : []
    )
}
function enumNames(enumIds) {
    const ids = [...new Set(enumIds.filter(Boolean))]
    return Object.fromEntries(
        ids.length
            ? Array.from(find("moqui.basic.Enumeration").condition("enumId", "in", ids).list()).map(row => [row.enumId, row])
            : []
    )
}
function asOfOf(p) {
    return dateOf(p.asOfDate, "The as-of time") ?? ms(ec.user.nowTimestamp)
}

// ===== stage durations =====
// The completed and unknown stays in each stage, from the deals' audited stage changes up to a time: a stay is known when the log
// shows both its entry (a change into the stage, the creation among them) and its exit (the next change, chained from it).
function stageDurations(dealRows, history, at) {
    const out = {}
    const entry = stageId =>
        (out[stageId] = out[stageId] || {opportunityStageId: stageId, entered: 0, completed: 0, unknown: 0, totalMs: 0})
    for (const deal of dealRows) {
        const changes = (history[deal.salesOpportunityId]?.opportunityStageId || []).filter(
            change => (timeOf(change.changedDate) ?? 0) <= at
        )
        let current = null // the stage held: {stageId, since}
        for (const change of changes) {
            const from = blank(change.oldValueText) ? null : String(change.oldValueText)
            const to = blank(change.newValueText) ? null : String(change.newValueText)
            const when = timeOf(change.changedDate)
            if (current && from === current.stageId) {
                // chained: the stay ends now
                entry(from).completed++
                entry(from).totalMs += when - current.since
            } else {
                // the log shows no exit of the stage held, and no entry of the stage left
                if (current) entry(current.stageId).unknown++
                if (from) {
                    entry(from).entered++
                    entry(from).unknown++
                }
            }
            current = to ? {stageId: to, since: when} : null
            if (to) entry(to).entered++
        }
    }
    return out
}

// ===== get#PipelineAnalysis =====
function pipelineAnalysis(p) {
    const scope = reader(p)
    const at = asOfOf(p)
    const groupBy = text(p.groupBy) || "stage"
    if (!groupings.includes(groupBy)) denied("GROUPING_INVALID", "Group by stage, source, owner or age")
    const closeFrom = dateOf(p.closeFrom, "The close period")
    const closeThru = dateOf(p.closeThru, "The close period")
    const currencyUomId = text(p.currencyUomId)
    const stageFilter = text(p.opportunityStageId)
    const all = deals(scope, p, at)
    const ids = all.map(row => row.salesOpportunityId)
    const history = histories(ids)
    const then = all.map(row => dealAt(row, history[row.salesOpportunityId], at))
    const people = peopleAt(ids, at)
    // the open qualified deals as of the time, under the deal filters
    const open = then.filter(
        deal =>
            !closedStatuses.includes(deal.statusId) &&
            deal.typeEnumId === types.opportunity &&
            (!stageFilter || deal.opportunityStageId === stageFilter) &&
            (!currencyUomId || deal.currencyUomId === currencyUomId) &&
            (closeFrom == null || (deal.estimatedCloseDate != null && deal.estimatedCloseDate >= closeFrom)) &&
            (closeThru == null || (deal.estimatedCloseDate != null && deal.estimatedCloseDate < closeThru + dayMs))
    )
    const openLeadCount = then.filter(deal => !closedStatuses.includes(deal.statusId) && deal.typeEnumId === types.lead).length
    const activities = nextActivities(open.map(deal => deal.salesOpportunityId))
    const durations = stageDurations(then, history, at)
    const stages = stageNames(open.map(deal => deal.opportunityStageId).concat(Object.keys(durations)))
    const sources = sourceNames(open.map(deal => deal.deal.dataSourceId))
    const partyNames = names(Object.values(people).flatMap(entry => [entry.owner, entry.team]))
    const plans = enumNames(open.map(deal => deal.deal.recurringPlanEnumId))
    const ageDays = deal => (deal.createdDate == null ? null : (at - deal.createdDate) / dayMs)
    const groupOf = deal => {
        if (groupBy === "stage") {
            const stage = stages[deal.opportunityStageId]
            return {
                key: deal.opportunityStageId || "",
                label: stage ? stage.description || stage.opportunityStageId : L("No stage"),
                order: stage ? (stage.sequenceNum ?? 0) : 1e6
            }
        }
        if (groupBy === "source")
            return {key: deal.deal.dataSourceId || "", label: sources[deal.deal.dataSourceId] || L("No source"), order: 0}
        if (groupBy === "owner") {
            const owner = people[deal.salesOpportunityId]?.owner
            return {key: owner || "", label: owner ? partyNames[owner] || owner : L("No owner"), order: 0}
        }
        const age = ageDays(deal)
        const band = age == null ? null : ageBands.findIndex(row => age <= row.upTo)
        return band == null || band < 0
            ? {key: "", label: L("Unknown age"), order: 99}
            : {key: ageBands[band].key, label: L(ageBands[band].label), order: band}
    }
    const measures = new Map()
    for (const deal of open) {
        const group = groupOf(deal)
        const key = group.key + "|" + (deal.currencyUomId || "")
        if (!measures.has(key))
            measures.set(key, {
                groupKey: group.key,
                groupLabel: group.label,
                order: group.order,
                currencyUomId: deal.currencyUomId,
                dealCount: 0,
                estimatedAmount: zero(),
                weightedAmount: zero(),
                monthlyRecurringAmount: zero(),
                missingEstimateCount: 0,
                withActivityCount: 0,
                ageTotal: 0,
                ageCount: 0
            })
        const row = measures.get(key)
        row.dealCount++
        if (deal.estimatedAmount == null) row.missingEstimateCount++
        else {
            row.estimatedAmount = row.estimatedAmount.add(deal.estimatedAmount)
            if (deal.estimatedProbability != null)
                row.weightedAmount = row.weightedAmount.add(
                    deal.estimatedAmount.multiply(deal.estimatedProbability).divide(toDecimal(100), 6, "HALF_EVEN")
                )
        }
        const months = Number(plans[deal.deal.recurringPlanEnumId]?.enumCode) || null
        if (deal.recurringAmount != null && months)
            row.monthlyRecurringAmount = row.monthlyRecurringAmount.add(
                deal.recurringAmount.divide(toDecimal(months), 6, "HALF_EVEN")
            )
        if (activities[deal.salesOpportunityId]) row.withActivityCount++
        const age = ageDays(deal)
        if (age != null) {
            row.ageTotal += age
            row.ageCount++
        }
    }
    const measureList = [...measures.values()]
        .sort(
            (a, b) =>
                a.order - b.order ||
                a.groupLabel.localeCompare(b.groupLabel) ||
                String(a.currencyUomId).localeCompare(String(b.currencyUomId))
        )
        .map(row => {
            const averageAge = row.ageCount ? row.ageTotal / row.ageCount : null
            const coverage = percentOf(row.withActivityCount, row.dealCount)
            return {
                groupKey: row.groupKey,
                groupLabel: row.groupLabel,
                currencyUomId: row.currencyUomId || null,
                dealCount: row.dealCount,
                estimatedAmount: row.currencyUomId
                    ? ec.l10n.roundCurrency(row.estimatedAmount, row.currencyUomId)
                    : row.estimatedAmount,
                estimatedText: moneyText(row.estimatedAmount, row.currencyUomId),
                weightedAmount: row.currencyUomId
                    ? ec.l10n.roundCurrency(row.weightedAmount, row.currencyUomId)
                    : row.weightedAmount,
                weightedText: moneyText(row.weightedAmount, row.currencyUomId),
                monthlyRecurringAmount: row.monthlyRecurringAmount,
                monthlyRecurringText: row.monthlyRecurringAmount.isZero()
                    ? ""
                    : moneyText(row.monthlyRecurringAmount, row.currencyUomId),
                averageAgeDays: averageAge == null ? null : Math.round(averageAge * 10) / 10,
                averageAgeText: daysText(averageAge),
                missingEstimateCount: row.missingEstimateCount,
                withActivityCount: row.withActivityCount,
                activityCoveragePercent: coverage,
                activityCoverageText: percentText(coverage)
            }
        })

    // stage durations over the deals read, up to the time
    const durationRows = Object.values(durations)
        .map(row => {
            const stage = stages[row.opportunityStageId]
            const averageDays = row.completed ? row.totalMs / row.completed / dayMs : null
            return {
                opportunityStageId: row.opportunityStageId,
                stageText: stage ? stage.description || stage.opportunityStageId : row.opportunityStageId,
                order: stage ? (stage.sequenceNum ?? 0) : 1e6,
                enteredCount: row.entered,
                completedCount: row.completed,
                unknownCount: row.unknown,
                averageDays: averageDays == null ? null : Math.round(averageDays * 10) / 10,
                averageText: averageDays == null ? L("Unknown") : daysText(averageDays)
            }
        })
        .sort((a, b) => a.order - b.order || a.stageText.localeCompare(b.stageText))
        .map(({order, ...row}) => row)

    // lead conversion over a cohort of leads created between two days (default: the 90 days to the time)
    const cohortFrom = dateOf(p.cohortFrom, "The cohort's first day") ?? at - 90 * dayMs
    const cohortThru = dateOf(p.cohortThru, "The cohort's last day")
    const cohortEnd = cohortThru == null ? at : Math.min(at, cohortThru + dayMs)
    const createdAsLead = deal => {
        const created = (history[deal.salesOpportunityId]?.typeEnumId || [])[0]
        if (created && blank(created.oldValueText)) return created.newValueText === types.lead
        return deal.typeEnumId === types.lead || deal.convertedDate != null
    }
    const cohort = all.filter(
        deal =>
            deal.createdDate != null &&
            timeOf(deal.createdDate) >= cohortFrom &&
            timeOf(deal.createdDate) < cohortEnd &&
            createdAsLead(deal)
    )
    const converted = cohort.filter(deal => timeOf(deal.convertedDate) != null && timeOf(deal.convertedDate) <= at)
    const cohortThen = cohort.map(deal => dealAt(deal, history[deal.salesOpportunityId], at))
    const disqualified = cohortThen.filter(deal => deal.typeEnumId === types.lead && deal.statusId === statuses.lost)
    const wonFromCohort = cohortThen.filter(deal => deal.statusId === statuses.won)
    const conversion = {
        cohortFromText: dayText(cohortFrom),
        cohortThruText: dayText(cohortEnd - 1),
        leadCount: cohort.length,
        convertedCount: converted.length,
        disqualifiedCount: disqualified.length,
        openLeadCount: cohortThen.filter(deal => deal.typeEnumId === types.lead && !closedStatuses.includes(deal.statusId))
            .length,
        wonCount: wonFromCohort.length,
        conversionPercent: percentOf(converted.length, cohort.length),
        conversionText: percentText(percentOf(converted.length, cohort.length))
    }
    // the funnel: visits (Marketing's, when it records them), leads created, qualified, won; counts, never amounts
    let visitCount = null
    if (ec.service.getServiceDefinition(visitService)) {
        try {
            visitCount =
                lib.probe(visitService, {
                    organizationPartyId: scope.organizationPartyId,
                    fromDate: new Date(cohortFrom),
                    thruDate: new Date(cohortEnd),
                    marketingCampaignId: text(p.marketingCampaignId),
                    dataSourceId: text(p.dataSourceId)
                }).visitCount ?? null
        } catch (error) {
            ec.logger.error("Sales pipeline funnel: " + visitService + " failed: " + error.message)
            visitCount = null
        }
    }
    const funnelSteps = [
        {
            stepKey: "visits",
            label: L("Visits"),
            count: visitCount,
            countText: visitCount == null ? L("Not available") : String(visitCount)
        },
        {stepKey: "leads", label: L("Leads created"), count: cohort.length, countText: String(cohort.length)},
        {stepKey: "qualified", label: L("Qualified"), count: converted.length, countText: String(converted.length)},
        {stepKey: "won", label: L("Won"), count: wonFromCohort.length, countText: String(wonFromCohort.length)}
    ].map(step => {
        const share = step.stepKey === "visits" || step.count == null ? null : percentOf(step.count, cohort.length)
        return Object.assign(step, {sharePercent: share, shareText: percentText(share)})
    })

    // the open deals behind the measures, paged
    const dealRows = open
        .map(deal => {
            const entry = people[deal.salesOpportunityId] || {}
            const stage = stages[deal.opportunityStageId]
            const next = activities[deal.salesOpportunityId]
            const age = ageDays(deal)
            return {
                salesOpportunityId: deal.salesOpportunityId,
                opportunityName: deal.deal.opportunityName || deal.salesOpportunityId,
                stageText: stage ? stage.description || stage.opportunityStageId : "",
                ownerName: entry.owner ? partyNames[entry.owner] || entry.owner : "",
                teamName: entry.team ? partyNames[entry.team] || entry.team : "",
                sourceText: sources[deal.deal.dataSourceId] || "",
                currencyUomId: deal.currencyUomId,
                estimatedAmount: deal.estimatedAmount,
                amountText: deal.estimatedAmount == null ? L("Unestimated") : moneyText(deal.estimatedAmount, deal.currencyUomId),
                probabilityText:
                    deal.estimatedProbability == null ? "" : String(Number(String(deal.estimatedProbability))) + " %",
                closeText: dayText(deal.estimatedCloseDate),
                ageDays: age == null ? null : Math.floor(age),
                ageText: age == null ? "" : Math.floor(age) + " d",
                nextActivityText: next
                    ? next.task.workEffortName +
                      (next.task.estimatedCompletionDate ? " · " + dayText(timeOf(next.task.estimatedCompletionDate)) : "")
                    : L("None")
            }
        })
        .sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1) || a.opportunityName.localeCompare(b.opportunityName))
    const paged = lib.pageList(dealRows, p, "dealList", {noLimitCap: dealLimit})
    return Object.assign(
        {
            organizationPartyId: scope.organizationPartyId,
            groupBy,
            asOf: new Date(at),
            asOfText: ec.l10n.format(new Date(at), "d MMM yyyy HH:mm"),
            openDealCount: open.length,
            openLeadCount,
            measureList,
            stageDurationList: durationRows,
            conversion,
            funnelSteps,
            activityNote: L("Activity coverage is of the open tasks now, not as of the report time.")
        },
        paged
    )
}

// ===== get#WinLoss =====
// The close events of deals up to a time: each change of statusId to Won or Lost, with the close date written with it (else the
// change's time), and the reopen events (a change from Won or Lost back to Open).
function closeEvents(deal, history, at) {
    const statusChanges = (history?.statusId || []).filter(change => (timeOf(change.changedDate) ?? 0) <= at)
    const closedDates = history?.closedDate || []
    const events = []
    let reopens = 0
    for (const change of statusChanges) {
        const to = change.newValueText
        const from = change.oldValueText
        const when = timeOf(change.changedDate)
        if (closedStatuses.includes(to)) {
            const dated = closedDates.find(row => timeOf(row.changedDate) === when && !blank(row.newValueText))
            events.push({statusId: to, closedDate: dated ? timeOf(dated.newValueText) : when, changedAt: when})
        } else if (closedStatuses.includes(from)) reopens++
    }
    // a deal closed before the log (or loaded) has its stored close only
    if (!events.length && closedStatuses.includes(deal.statusId) && deal.closedDate != null && timeOf(deal.closedDate) <= at)
        events.push({statusId: deal.statusId, closedDate: timeOf(deal.closedDate), changedAt: timeOf(deal.closedDate)})
    return {events, reopens}
}
// The lost reason written with a close: the reason's change in the same update (its audit row stamped within a moment of the
// status change's), else none.
function reasonOf(history, changedAt) {
    const rows = (history?.lostReasonEnumId || []).filter(
        row => !blank(row.newValueText) && Math.abs((timeOf(row.changedDate) ?? 0) - changedAt) <= 2000
    )
    return rows.length ? String(rows[rows.length - 1].newValueText) : null
}
function winLoss(p) {
    const scope = reader(p)
    const at = asOfOf(p)
    const mode = text(p.mode) || "final"
    if (!["final", "events"].includes(mode)) denied("MODE_INVALID", "Choose the final outcome or each close event")
    let fromMs = dateOf(p.fromDate, "The period's first day")
    let thruMs = dateOf(p.thruDate, "The period's last day")
    if (fromMs == null && thruMs == null) {
        const range = ec.user.getPeriodRange("quarter", 0, new Date(at))
        fromMs = Number(range[0])
        thruMs = Number(range[1]) - dayMs
    }
    const endMs = thruMs == null ? at + 1 : thruMs + dayMs
    if (fromMs != null && fromMs >= endMs) denied("DATE_INVALID", "Choose an increasing period")
    const inPeriod = when => when != null && (fromMs == null || when >= fromMs) && when < endMs && when <= at
    const currencyUomId = text(p.currencyUomId)
    const reasonFilter = text(p.lostReasonEnumId)
    const all = deals(scope, p, at)
    const ids = all.map(row => row.salesOpportunityId)
    const history = histories(ids)
    const outcomes = []
    let reopenTotal = 0
    for (const deal of all) {
        if (currencyUomId && deal.currencyUomId !== currencyUomId) continue
        const dealHistory = history[deal.salesOpportunityId]
        const {events, reopens} = closeEvents(deal, dealHistory, at)
        const chosen =
            mode === "events"
                ? events.filter(event => inPeriod(event.closedDate))
                : (() => {
                      const then = dealAt(deal, dealHistory, at)
                      if (!closedStatuses.includes(then.statusId) || !inPeriod(then.closedDate)) return []
                      return [
                          {
                              statusId: then.statusId,
                              closedDate: then.closedDate,
                              changedAt: events.length ? events[events.length - 1].changedAt : then.closedDate
                          }
                      ]
                  })()
        if (chosen.length) reopenTotal += reopens
        for (const event of chosen) {
            // the deal as it stood when it closed: its type (a lead closed Lost is a disqualification), amount and lost reason
            const then = dealAt(deal, dealHistory, event.changedAt)
            const lostReasonEnumId =
                event.statusId === statuses.lost ? reasonOf(dealHistory, event.changedAt) || then.lostReasonEnumId || null : null
            if (reasonFilter && lostReasonEnumId !== reasonFilter) continue
            outcomes.push({
                deal,
                statusId: event.statusId,
                closedDate: event.closedDate,
                lead: then.typeEnumId === types.lead,
                amount: then.estimatedAmount,
                currencyUomId: deal.currencyUomId || null,
                lostReasonEnumId,
                cycleDays: deal.createdDate == null ? null : (event.closedDate - timeOf(deal.createdDate)) / dayMs,
                reopens
            })
        }
    }
    const reasons = enumNames(outcomes.map(row => row.lostReasonEnumId))
    const opportunities = outcomes.filter(row => !row.lead)
    const won = opportunities.filter(row => row.statusId === statuses.won)
    const lost = opportunities.filter(row => row.statusId === statuses.lost)
    const disqualified = outcomes.filter(row => row.lead && row.statusId === statuses.lost)
    const average = list => {
        const known = list.filter(row => row.cycleDays != null)
        return known.length ? known.reduce((sum, row) => sum + row.cycleDays, 0) / known.length : null
    }
    const byCurrency = new Map()
    for (const row of opportunities) {
        const key = row.currencyUomId || ""
        if (!byCurrency.has(key))
            byCurrency.set(key, {
                currencyUomId: row.currencyUomId,
                wonCount: 0,
                wonAmount: zero(),
                lostCount: 0,
                lostAmount: zero(),
                unestimatedCount: 0
            })
        const total = byCurrency.get(key)
        if (row.amount == null) total.unestimatedCount++
        if (row.statusId === statuses.won) {
            total.wonCount++
            if (row.amount != null) total.wonAmount = total.wonAmount.add(row.amount)
        } else {
            total.lostCount++
            if (row.amount != null) total.lostAmount = total.lostAmount.add(row.amount)
        }
    }
    const outcomeList = [...byCurrency.values()].map(total => {
        const rate = percentOf(total.wonCount, total.wonCount + total.lostCount)
        return Object.assign(total, {
            wonText: moneyText(total.wonAmount, total.currencyUomId),
            lostText: moneyText(total.lostAmount, total.currencyUomId),
            winRatePercent: rate,
            winRateText: percentText(rate)
        })
    })
    const reasonTotals = new Map()
    for (const row of lost) {
        const key = (row.lostReasonEnumId || "") + "|" + (row.currencyUomId || "")
        if (!reasonTotals.has(key))
            reasonTotals.set(key, {
                lostReasonEnumId: row.lostReasonEnumId,
                reasonText: row.lostReasonEnumId
                    ? reasons[row.lostReasonEnumId]?.description || row.lostReasonEnumId
                    : L("No reason recorded"),
                currencyUomId: row.currencyUomId,
                lostCount: 0,
                lostAmount: zero()
            })
        const total = reasonTotals.get(key)
        total.lostCount++
        if (row.amount != null) total.lostAmount = total.lostAmount.add(row.amount)
    }
    const reasonList = [...reasonTotals.values()]
        .sort((a, b) => b.lostCount - a.lostCount || a.reasonText.localeCompare(b.reasonText))
        .map(total => Object.assign(total, {lostText: moneyText(total.lostAmount, total.currencyUomId)}))
    const people = peopleAt(ids, at)
    const partyNames = names(outcomes.map(row => people[row.deal.salesOpportunityId]?.owner))
    const dealRows = outcomes
        .sort((a, b) => b.closedDate - a.closedDate || String(a.deal.salesOpportunityId).localeCompare(b.deal.salesOpportunityId))
        .map(row => {
            const owner = people[row.deal.salesOpportunityId]?.owner
            return {
                salesOpportunityId: row.deal.salesOpportunityId,
                opportunityName: row.deal.opportunityName || row.deal.salesOpportunityId,
                outcomeText: row.lead ? L("Disqualified lead") : row.statusId === statuses.won ? L("Won") : L("Lost"),
                closedText: dayText(row.closedDate),
                ownerName: owner ? partyNames[owner] || owner : "",
                currencyUomId: row.currencyUomId,
                amount: row.amount,
                amountText: row.amount == null ? L("Unestimated") : moneyText(row.amount, row.currencyUomId),
                reasonText: row.lostReasonEnumId ? reasons[row.lostReasonEnumId]?.description || row.lostReasonEnumId : "",
                cycleText: daysText(row.cycleDays),
                reopenCount: row.reopens
            }
        })
    const rate = percentOf(won.length, won.length + lost.length)
    const averageWon = average(won)
    const averageLost = average(lost)
    return Object.assign(
        {
            organizationPartyId: scope.organizationPartyId,
            mode,
            modeText:
                mode === "final"
                    ? L("Final outcome as of the report time: each deal once, by its outcome and close date then")
                    : L("Close events: each close in the period, a reopened deal's earlier closes among them"),
            fromText: dayText(fromMs),
            thruText: dayText(endMs - 1),
            asOf: new Date(at),
            asOfText: ec.l10n.format(new Date(at), "d MMM yyyy HH:mm"),
            wonCount: won.length,
            lostCount: lost.length,
            disqualifiedCount: disqualified.length,
            winRatePercent: rate,
            winRateText: percentText(rate),
            averageWonCycleDays: averageWon == null ? null : Math.round(averageWon * 10) / 10,
            averageWonCycleText: averageWon == null ? "" : daysText(averageWon),
            averageLostCycleText: averageLost == null ? "" : daysText(averageLost),
            reopenCount: reopenTotal,
            outcomeList,
            reasonList
        },
        lib.pageList(dealRows, p, "dealList", {noLimitCap: dealLimit})
    )
}

const operations = {pipelineAnalysis, winLoss}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown sales pipeline report " + op)
        return operations[op](parameters || {})
    }
})
