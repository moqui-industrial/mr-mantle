// Marketing's campaigns (mantle.marketing.CampaignServices, C; IronStone Marketing design §3 Campaigns and CampaignDetail, §14.1,
// §14.3; impl-marketing P2): the plan, its responsible parties, budget and associations, the native status flow, duplication, the
// campaign's files and the lifecycle participant's moves. Approvals are MarketingApprovals.js, costs MarketingCosts.js.
//
// - Scope: each operation reads the caller's scope (MarketingAccess.js). A campaign outside it, missing or unowned answers as
//   missing (RECORD_UNAVAILABLE); a write needs MARKETING_CAMPAIGN_EDIT (PERMISSION_DENIED) and an organization of the scope
//   (ORGANIZATION_DENIED). A read needs a Marketing read (MARKETING_VIEW, MARKETING_AUDIENCE_VIEW or MARKETING_REPORT_VIEW).
// - Revisions: every write names the revision it read (expectedRevision, the campaign's lastUpdatedStamp in millis): none
//   REVISION_REQUIRED, another STALE_REVISION naming the current one.
// - The organization: one effective MarketingOrganization MarketingCampaignParty row, which organizationPartyId copies (X12);
//   store#CampaignParty ends the row and starts the next, refused while the campaign has costs, associations or child campaigns
//   (ORGANIZATION_IN_USE): they belong to the organization they were made in.
// - A material change (the organization, parent, dates, currency, budget, a manager) raises campaignRevision, which supersedes the
//   approvals of the earlier revision (MarketingApprovals.supersede); an approved campaign returns to Planned for review; an in
//   progress campaign takes no material change (CAMPAIGN_IN_PROGRESS) and a completed or cancelled one no change (CAMPAIGN_CLOSED).
// - The flow (native statuses): Planned → Approved (decide#MarketingApproval only) → In progress (start: the approval of the
//   current revision, APPROVAL_REQUIRED) → Completed (refused with the pending work's counts, PENDING_WORK: open child campaigns
//   in P2, the sends P8 and enrollments P11); Cancelled from the three open statuses, ending its pending requests.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const marketingAccess = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingAccess.js")
const approvals = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingApprovals.js")
const {find, one, rows, denied, call} = lib

const CAMPAIGN = "mantle.marketing.campaign.MarketingCampaign"
const PARTY = "mantle.marketing.campaign.MarketingCampaignParty"
const ASSOCIATION = "mantle.marketing.campaign.CampaignAssociation"
const COST = "mantle.marketing.campaign.CampaignCost"
const ASSET = "mantle.marketing.campaign.CampaignAsset"
const NOTE = "mantle.marketing.campaign.MarketingCampaignNote"
const roles = {
    organization: "MarketingOrganization",
    manager: "MarketingCampaignManager",
    contributor: "MarketingCampaignContributor"
}
const roleNames = {
    MarketingOrganization: "Organization",
    MarketingCampaignManager: "Manager",
    MarketingCampaignContributor: "Contributor"
}
const openStatuses = ["MKTG_CAMP_PLANNED", "MKTG_CAMP_APPROVED", "MKTG_CAMP_INPROGRESS"]
const statusText = {
    MKTG_CAMP_PLANNED: "Planned",
    MKTG_CAMP_APPROVED: "Approved",
    MKTG_CAMP_INPROGRESS: "In progress",
    MKTG_CAMP_COMPLETED: "Completed",
    MKTG_CAMP_CANCELLED: "Cancelled"
}
const statusColor = {
    MKTG_CAMP_PLANNED: "grey-8",
    MKTG_CAMP_APPROVED: "primary",
    MKTG_CAMP_INPROGRESS: "positive",
    MKTG_CAMP_COMPLETED: "secondary",
    MKTG_CAMP_CANCELLED: "negative"
}
const workerRelationships = ["PrtAgent", "PrtEmployee"]
const pageCap = 1000

const text = value => (value == null ? "" : String(value).trim())
const blank = value => value == null || value === ""
function dateOf(value, label) {
    if (blank(value)) return null
    const millis = lib.ms(value)
    if (millis == null || !Number.isFinite(millis)) denied("DATE_INVALID", label + " is not a date")
    return new Date(millis)
}
// An amount for a campaign: empty for none, else a number of at least zero rounded to its currency.
function amountOf(value, currencyUomId, label) {
    if (blank(value)) return null
    let decimal
    try {
        decimal = toDecimal(value)
    } catch (_) {
        denied("AMOUNT_INVALID", label + " is not an amount")
    }
    if (decimal.compare(0) < 0) denied("AMOUNT_INVALID", label + " cannot be below zero")
    return currencyUomId ? ec.l10n.roundCurrency(decimal, currencyUomId) : decimal
}
const organizationName = partyId => (partyId ? one("mantle.party.Organization", {partyId})?.organizationName || partyId : "")
const moneyText = (value, currencyUomId) =>
    value == null ? "" : currencyUomId ? ec.l10n.formatCurrency(value, currencyUomId) || String(value) : String(value)
function worksFor(partyId, organizationPartyId) {
    if (!partyId || !one("mantle.party.Person", {partyId})) return false
    return rows("mantle.party.PartyRelationship", {fromPartyId: partyId, toPartyId: organizationPartyId}).some(
        row => workerRelationships.includes(row.relationshipTypeEnumId) && lib.active(row)
    )
}

// ===== scope and records =====
function reader() {
    const userScope = marketingAccess.scope()
    if (!userScope.capabilities.anyRead) denied("PERMISSION_DENIED", "Marketing is not open to you")
    return userScope
}
function editor() {
    const userScope = marketingAccess.scope()
    marketingAccess.requireCapability(userScope, "campaignEdit")
    if (!userScope.capabilities.anyRead) denied("PERMISSION_DENIED", "Marketing is not open to you")
    return userScope
}
// A campaign of the scope, else RECORD_UNAVAILABLE (missing, another organization's, unowned alike).
function campaignOf(userScope, marketingCampaignId, lock = false) {
    const id = text(marketingCampaignId)
    let query = id ? find(CAMPAIGN, {marketingCampaignId: id}) : null
    if (query && lock) query = query.forUpdate(true)
    const row = query ? query.one() : null
    if (!row || !marketingAccess.covers(userScope, row.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Campaign " + id + " is not available")
    return row
}
// The revision a write names, against the campaign's own.
function requireRevision(row, expectedRevision) {
    if (blank(expectedRevision))
        denied("REVISION_REQUIRED", "Name the revision of campaign " + row.marketingCampaignId + " you read")
    if (lib.ms(expectedRevision) !== lib.ms(row.lastUpdatedStamp))
        denied(
            "STALE_REVISION",
            "Campaign " +
                row.marketingCampaignId +
                " changed since it was read; its revision is now " +
                lib.ms(row.lastUpdatedStamp)
        )
}
function requireOpen(row) {
    if (!openStatuses.includes(row.statusId))
        denied("CAMPAIGN_CLOSED", "Campaign " + row.marketingCampaignId + " is " + statusText[row.statusId].toLowerCase())
}
// A material change of the campaign: refused in progress; raises the revision, supersedes the earlier approvals and returns an
// approved campaign to review. The fields to write with it.
function materialChange(row, reason) {
    if (row.statusId === "MKTG_CAMP_INPROGRESS")
        denied(
            "CAMPAIGN_IN_PROGRESS",
            "Campaign " + row.marketingCampaignId + " is in progress; its organization, dates, budget and managers are kept"
        )
    const campaignRevision = Number(row.campaignRevision || 1) + 1
    approvals.supersede("campaign", row.marketingCampaignId, campaignRevision)
    const fields = {campaignRevision}
    if (row.statusId === "MKTG_CAMP_APPROVED") {
        fields.statusId = "MKTG_CAMP_PLANNED"
        fields.statusId_changeReason = "Returned to review: " + reason
    }
    return fields
}
// The current rows of a role on a campaign.
const currentParties = (marketingCampaignId, roleTypeId) =>
    rows(PARTY, {marketingCampaignId, roleTypeId}).filter(row => lib.active(row))

// A parent campaign the caller may name: of the same organization, open, never the campaign itself or one under it.
function requireParent(userScope, parentCampaignId, organizationPartyId, selfId) {
    if (!parentCampaignId) return null
    const parent = campaignOf(userScope, parentCampaignId)
    if (parent.organizationPartyId !== organizationPartyId)
        denied("ORGANIZATION_MISMATCH", "A parent campaign belongs to the same organization")
    if (!openStatuses.includes(parent.statusId)) denied("PARENT_CLOSED", "Campaign " + parentCampaignId + " is closed")
    let cursor = parent
    for (let depth = 0; cursor && depth < 20; depth++) {
        if (selfId && cursor.marketingCampaignId === selfId) denied("PARENT_INVALID", "A campaign cannot be under itself")
        cursor = cursor.parentCampaignId ? one(CAMPAIGN, {marketingCampaignId: cursor.parentCampaignId}) : null
    }
    return parent.marketingCampaignId
}
// The currency a new campaign takes: the one named, the organization's policy's, its accounting base currency, else none.
function defaultCurrency(organizationPartyId) {
    const policy = approvals.policyOf(organizationPartyId)
    if (policy?.currencyUomId) return policy.currencyUomId
    return one("mantle.ledger.config.PartyAcctgPreference", {organizationPartyId})?.baseCurrencyUomId || null
}
function datesOf(p, row = {}) {
    const fromDate = Object.hasOwn(p, "fromDate") ? dateOf(p.fromDate, "The start") : row.fromDate || null
    const thruDate = Object.hasOwn(p, "thruDate") ? dateOf(p.thruDate, "The end") : row.thruDate || null
    if (fromDate && thruDate && lib.ms(thruDate) <= lib.ms(fromDate)) denied("DATES_INVALID", "A campaign ends after it starts")
    return {fromDate, thruDate}
}

// ===== find#Campaigns =====
const orderFields = {campaignName: "^campaignName", fromDate: "fromDate", thruDate: "thruDate", statusId: "statusId"}
function findCampaigns(p) {
    const userScope = reader()
    const cf = ec.entity.conditionFactory
    const organizationPartyId = text(p.organizationPartyId)
    if (organizationPartyId) marketingAccess.requireOrganization(userScope, organizationPartyId)
    const organizationIds = organizationPartyId ? [organizationPartyId] : marketingAccess.organizationIds(userScope)
    const empty = lib.pageList([], p, "campaignList")
    if (!organizationIds.length) return empty
    let query = find(CAMPAIGN).condition("organizationPartyId", "in", organizationIds)
    const searchText = text(p.text)
    if (searchText) {
        const like = "%" + searchText.replace(/[\\%_]/g, character => "\\" + character) + "%"
        query = query.condition(
            cf.makeCondition(
                ["marketingCampaignId", "campaignName", "campaignSummary"].map(field =>
                    cf.makeCondition(field, "like", like).ignoreCase()
                ),
                "or"
            )
        )
    }
    const statusId = text(p.statusId)
    if (statusId === "open") query = query.condition("statusId", "in", openStatuses)
    else if (statusId && statusId !== "all") query = query.condition("statusId", statusId)
    if (text(p.parentCampaignId)) query = query.condition("parentCampaignId", text(p.parentCampaignId))
    // the campaigns running in a date range: overlapping it
    const rangeFrom = dateOf(p.rangeFrom, "The range start")
    const rangeThru = dateOf(p.rangeThru, "The range end")
    if (rangeFrom)
        query = query.condition(
            cf.makeCondition([cf.makeCondition("thruDate", "is-null", null), cf.makeCondition("thruDate", ">=", rangeFrom)], "or")
        )
    if (rangeThru)
        query = query.condition(
            cf.makeCondition([cf.makeCondition("fromDate", "is-null", null), cf.makeCondition("fromDate", "<=", rangeThru)], "or")
        )
    // the campaigns a person manages or contributes to (mine: the caller)
    const memberPartyId = p.mine === "Y" || p.mine === true ? userScope.partyId : text(p.managerPartyId)
    if (memberPartyId) {
        const ids = rows(PARTY, {partyId: memberPartyId})
            .filter(row => row.roleTypeId !== roles.organization && lib.active(row))
            .map(row => row.marketingCampaignId)
        if (!ids.length) return empty
        query = query.condition("marketingCampaignId", "in", Array.from(new Set(ids)))
    }
    query = query.orderBy(orderFields[text(p.orderByField).replace(/^[-^+]/, "")] || "-fromDate").orderBy("marketingCampaignId")
    const count = query.count()
    const paged = lib.page(query, p, "campaignList", count, {noLimitCap: pageCap})
    const campaignIds = paged.rows.map(row => row.marketingCampaignId)
    const managers = {}
    if (campaignIds.length) {
        const managerRows = Array.from(
            find(PARTY).condition("marketingCampaignId", "in", campaignIds).condition("roleTypeId", roles.manager).list()
        ).filter(row => lib.active(row))
        const names = lib.partyNames(managerRows.map(row => row.partyId))
        for (const row of managerRows) (managers[row.marketingCampaignId] ||= []).push(names[row.partyId] || row.partyId)
    }
    const parentNames = {}
    const parentIds = Array.from(new Set(paged.rows.map(row => row.parentCampaignId).filter(Boolean)))
    if (parentIds.length)
        for (const row of Array.from(find(CAMPAIGN).condition("marketingCampaignId", "in", parentIds).list()))
            if (marketingAccess.covers(userScope, row.organizationPartyId))
                parentNames[row.marketingCampaignId] = row.campaignName || row.marketingCampaignId
    const out = Object.assign({}, paged)
    delete out.rows
    delete out.records
    out.campaignList = paged.rows.map(row => listRow(row, managers[row.marketingCampaignId], parentNames[row.parentCampaignId]))
    return out
}
function listRow(row, managerNames, parentName) {
    return {
        marketingCampaignId: row.marketingCampaignId,
        campaignName: row.campaignName || row.marketingCampaignId,
        statusId: row.statusId,
        statusText: statusText[row.statusId] || row.statusId || "",
        statusColor: statusColor[row.statusId] || "grey-8",
        organizationPartyId: row.organizationPartyId,
        organizationName: organizationName(row.organizationPartyId),
        parentCampaignId: row.parentCampaignId || null,
        parentName: parentName || "",
        fromDate: row.fromDate,
        thruDate: row.thruDate,
        datesText: [lib.dateText(row.fromDate), lib.dateText(row.thruDate)].filter(Boolean).join(" to "),
        budgetedCost: row.budgetedCost,
        actualCost: row.actualCost,
        costUomId: row.costUomId,
        budgetText: moneyText(row.budgetedCost, row.costUomId),
        actualText: moneyText(row.actualCost, row.costUomId),
        managerName: (managerNames || []).join(", "),
        revision: lib.ms(row.lastUpdatedStamp)
    }
}

// ===== create#Campaign =====
function create(p) {
    const userScope = editor()
    const organizationPartyId = marketingAccess.requireOrganization(userScope, text(p.organizationPartyId))
    const campaignName = text(p.campaignName)
    if (!campaignName) denied("NAME_REQUIRED", "Name the campaign")
    const {fromDate, thruDate} = datesOf(p)
    const costUomId = text(p.costUomId) || defaultCurrency(organizationPartyId)
    const budgetedCost = amountOf(p.budgetedCost, costUomId, "The budget")
    const estimatedCost = amountOf(p.estimatedCost, costUomId, "The estimated cost")
    if ((budgetedCost != null || estimatedCost != null) && !costUomId) denied("CURRENCY_REQUIRED", "A budget needs its currency")
    const parentCampaignId = requireParent(userScope, text(p.parentCampaignId), organizationPartyId, null)
    const managerPartyId = text(p.managerPartyId) || userScope.partyId
    if (!worksFor(managerPartyId, organizationPartyId))
        denied("PARTY_INVALID", "A campaign's manager is a person who works for its organization")
    const marketingCampaignId = call("create#" + CAMPAIGN, {
        campaignName,
        campaignSummary: text(p.campaignSummary) || null,
        organizationPartyId,
        parentCampaignId,
        fromDate,
        thruDate,
        costUomId,
        budgetedCost,
        estimatedCost,
        statusId: "MKTG_CAMP_PLANNED",
        campaignRevision: 1,
        createdByUserId: ec.user.userId
    }).marketingCampaignId
    const now = ec.user.nowTimestamp
    call("create#" + PARTY, {marketingCampaignId, partyId: organizationPartyId, roleTypeId: roles.organization, fromDate: now})
    ensureRole(managerPartyId, roles.manager)
    call("create#" + PARTY, {marketingCampaignId, partyId: managerPartyId, roleTypeId: roles.manager, fromDate: now})
    return {marketingCampaignId}
}
function ensureRole(partyId, roleTypeId) {
    if (!one("mantle.party.PartyRole", {partyId, roleTypeId})) call("create#mantle.party.PartyRole", {partyId, roleTypeId})
}

// ===== store#Campaign =====
// The plan's fields; a change of the parent or the dates is material.
const planFields = ["campaignName", "campaignSummary", "expectedResponsePercent", "expectedRevenue"]
function store(p) {
    const userScope = editor()
    const row = campaignOf(userScope, p.marketingCampaignId, true)
    requireRevision(row, p.expectedRevision)
    requireOpen(row)
    const fields = {marketingCampaignId: row.marketingCampaignId}
    for (const field of planFields) if (Object.hasOwn(p, field)) fields[field] = blank(p[field]) ? null : p[field]
    if (Object.hasOwn(fields, "campaignName") && !text(fields.campaignName)) denied("NAME_REQUIRED", "Name the campaign")
    if (Object.hasOwn(fields, "expectedRevenue"))
        fields.expectedRevenue = amountOf(fields.expectedRevenue, row.costUomId, "The expected revenue")
    if (Object.hasOwn(fields, "expectedResponsePercent") && fields.expectedResponsePercent != null) {
        const percent = Number(fields.expectedResponsePercent)
        if (!Number.isFinite(percent) || percent < 0 || percent > 100)
            denied("PERCENT_INVALID", "The expected response is a percent from 0 to 100")
        fields.expectedResponsePercent = percent
    }
    const material = []
    const dates = datesOf(p, row)
    if (lib.ms(dates.fromDate) !== lib.ms(row.fromDate) || lib.ms(dates.thruDate) !== lib.ms(row.thruDate)) {
        material.push("its dates")
        Object.assign(fields, dates)
    }
    if (Object.hasOwn(p, "parentCampaignId") && text(p.parentCampaignId) !== text(row.parentCampaignId)) {
        fields.parentCampaignId = requireParent(
            userScope,
            text(p.parentCampaignId),
            row.organizationPartyId,
            row.marketingCampaignId
        )
        material.push("its parent")
    }
    if (material.length) Object.assign(fields, materialChange(row, material.join(" and ") + " changed"))
    call("update#" + CAMPAIGN, fields)
    return {marketingCampaignId: row.marketingCampaignId, campaignRevision: fields.campaignRevision || row.campaignRevision || 1}
}

// ===== store#CampaignBudget =====
// The target and expected spend in the campaign's currency, a material change; the explanation recorded as the audit reason.
function storeBudget(p) {
    const userScope = editor()
    const row = campaignOf(userScope, p.marketingCampaignId, true)
    requireRevision(row, p.expectedRevision)
    requireOpen(row)
    const costUomId = Object.hasOwn(p, "costUomId") ? text(p.costUomId) || null : row.costUomId
    if (costUomId !== (row.costUomId || null) && find(COST, {marketingCampaignId: row.marketingCampaignId}).count())
        denied("CURRENCY_IN_USE", "Campaign " + row.marketingCampaignId + " has costs in " + row.costUomId)
    const budgetedCost = Object.hasOwn(p, "budgetedCost") ? amountOf(p.budgetedCost, costUomId, "The budget") : row.budgetedCost
    const estimatedCost = Object.hasOwn(p, "estimatedCost")
        ? amountOf(p.estimatedCost, costUomId, "The estimated cost")
        : row.estimatedCost
    if ((budgetedCost != null || estimatedCost != null) && !costUomId) denied("CURRENCY_REQUIRED", "A budget needs its currency")
    const same = (a, b) => (a == null && b == null) || (a != null && b != null && toDecimal(a).compare(toDecimal(b)) === 0)
    if (same(budgetedCost, row.budgetedCost) && same(estimatedCost, row.estimatedCost) && costUomId === (row.costUomId || null))
        return {marketingCampaignId: row.marketingCampaignId, campaignRevision: row.campaignRevision || 1, changed: false}
    const reason = text(p.explanation) || "Budget changed"
    const fields = Object.assign(
        {
            marketingCampaignId: row.marketingCampaignId,
            budgetedCost,
            estimatedCost,
            costUomId,
            budgetedCost_changeReason: reason,
            estimatedCost_changeReason: reason,
            costUomId_changeReason: reason
        },
        materialChange(row, "its budget changed")
    )
    call("update#" + CAMPAIGN, fields)
    return {marketingCampaignId: row.marketingCampaignId, campaignRevision: fields.campaignRevision, changed: true}
}

// ===== store#CampaignParty =====
// Adds (action add) or ends (action end) a dated row of a role: the organization (its successor, mirrored to organizationPartyId),
// a manager or a contributor, a person who works for the campaign's organization. A change of the organization or a manager is
// material; the last manager is not ended while the policy requires one (MANAGER_REQUIRED).
function storeParty(p) {
    const userScope = editor()
    const row = campaignOf(userScope, p.marketingCampaignId, true)
    requireRevision(row, p.expectedRevision)
    requireOpen(row)
    const roleKey = Object.keys(roles).find(key => roles[key] === text(p.roleTypeId) || key === text(p.roleTypeId))
    if (!roleKey) denied("ROLE_INVALID", "A campaign's parties are its organization, managers and contributors")
    const roleTypeId = roles[roleKey]
    const action = text(p.action) || "add"
    const partyId = text(p.partyId)
    const now = ec.user.nowTimestamp
    const fields = {marketingCampaignId: row.marketingCampaignId}
    if (roleKey === "organization") {
        if (action !== "add") denied("ROLE_INVALID", "A campaign keeps one organization; name its successor")
        marketingAccess.requireOrganization(userScope, partyId)
        if (partyId === row.organizationPartyId) return {marketingCampaignId: row.marketingCampaignId, changed: false}
        const id = row.marketingCampaignId
        if (
            find(COST, {marketingCampaignId: id}).count() ||
            rows(ASSOCIATION, {marketingCampaignId: id}).some(link => lib.active(link)) ||
            find(CAMPAIGN, {parentCampaignId: id}).count() ||
            row.parentCampaignId
        )
            denied("ORGANIZATION_IN_USE", "Campaign " + id + " has costs, links or related campaigns of its organization")
        for (const current of currentParties(id, roleTypeId))
            call("update#" + PARTY, {
                marketingCampaignId: id,
                partyId: current.partyId,
                roleTypeId,
                fromDate: current.fromDate,
                thruDate: now
            })
        // the people of the old organization end with it
        for (const role of [roles.manager, roles.contributor])
            for (const current of currentParties(id, role))
                if (!worksFor(current.partyId, partyId))
                    call("update#" + PARTY, {
                        marketingCampaignId: id,
                        partyId: current.partyId,
                        roleTypeId: role,
                        fromDate: current.fromDate,
                        thruDate: now
                    })
        call("create#" + PARTY, {marketingCampaignId: id, partyId, roleTypeId, fromDate: now})
        Object.assign(fields, {organizationPartyId: partyId, organizationPartyId_changeReason: "Organization changed"})
        Object.assign(fields, materialChange(row, "its organization changed"))
        call("update#" + CAMPAIGN, fields)
        return {marketingCampaignId: id, campaignRevision: fields.campaignRevision, changed: true}
    }
    const current = currentParties(row.marketingCampaignId, roleTypeId)
    if (action === "add") {
        if (!worksFor(partyId, row.organizationPartyId)) denied("PARTY_INVALID", "A campaign's people work for its organization")
        if (current.some(found => found.partyId === partyId))
            return {marketingCampaignId: row.marketingCampaignId, changed: false}
        ensureRole(partyId, roleTypeId)
        call("create#" + PARTY, {marketingCampaignId: row.marketingCampaignId, partyId, roleTypeId, fromDate: now})
    } else if (action === "end") {
        const ending = current.filter(found => found.partyId === partyId)
        if (!ending.length) denied("RECORD_UNAVAILABLE", "That person has no current role of this kind on the campaign")
        const policy = approvals.policyOf(row.organizationPartyId)
        if (roleKey === "manager" && current.length <= ending.length && policy?.managerRequired !== "N")
            denied("MANAGER_REQUIRED", "A campaign keeps a manager; add the next one first")
        for (const found of ending)
            call("update#" + PARTY, {
                marketingCampaignId: row.marketingCampaignId,
                partyId,
                roleTypeId,
                fromDate: found.fromDate,
                thruDate: now
            })
    } else denied("ACTION_INVALID", "Add or end")
    // a manager is material; a contributor is not
    if (roleKey === "manager") {
        Object.assign(fields, materialChange(row, "its managers changed"))
        call("update#" + CAMPAIGN, fields)
    }
    return {
        marketingCampaignId: row.marketingCampaignId,
        campaignRevision: fields.campaignRevision || row.campaignRevision || 1,
        changed: true
    }
}

// ===== store#CampaignAssociation =====
// Each kind of record a campaign links to, with the organization it belongs to: a list (not a mailbox) and a segment by their
// owner, a store promotion by its store's organization, a form publication by its own; an event (P16) and a page (P14) once their
// organization is kept (KIND_UNAVAILABLE until then).
const associationKinds = {
    CakList: {
        name: "List",
        organization: sourceId => {
            const list = one("mantle.marketing.contact.ContactList", {contactListId: sourceId})
            return list && list.contactListTypeEnumId !== "MAILBOX"
                ? {owner: list.ownerPartyId, label: list.contactListName}
                : null
        }
    },
    CakSegment: {
        name: "Segment",
        organization: sourceId => {
            const segment = one("mantle.marketing.segment.MarketSegment", {marketSegmentId: sourceId})
            return segment ? {owner: segment.ownerPartyId, label: segment.description} : null
        }
    },
    CakPromotion: {
        name: "Promotion",
        organization: sourceId => {
            const promotion = one("mantle.product.store.ProductStorePromotion", {storePromotionId: sourceId})
            const store = promotion ? one("mantle.product.store.ProductStore", {productStoreId: promotion.productStoreId}) : null
            return store ? {owner: store.organizationPartyId, label: promotion.promotionName || promotion.storePromotionId} : null
        }
    },
    CakForm: {
        name: "Form",
        organization: sourceId => {
            const publication = one("mantle.party.FormPublication", {publicationId: sourceId})
            return publication ? {owner: publication.organizationPartyId, label: publication.publicationId} : null
        }
    }
}
function storeAssociation(p) {
    const userScope = editor()
    const row = campaignOf(userScope, p.marketingCampaignId, true)
    requireOpen(row)
    const action = text(p.action) || "add"
    if (action === "end") {
        const link = one(ASSOCIATION, {campaignAssociationId: text(p.campaignAssociationId)})
        if (!link || link.marketingCampaignId !== row.marketingCampaignId || !lib.active(link))
            denied("RECORD_UNAVAILABLE", "That link is not a current link of the campaign")
        call("update#" + ASSOCIATION, {campaignAssociationId: link.campaignAssociationId, thruDate: ec.user.nowTimestamp})
        return {campaignAssociationId: link.campaignAssociationId}
    }
    if (action !== "add") denied("ACTION_INVALID", "Add or end")
    const kindId = text(p.associationKindEnumId)
    if (!Object.hasOwn(associationKinds, kindId)) denied("KIND_UNAVAILABLE", "A campaign cannot link this kind of record yet")
    const sourceId = text(p.sourceId)
    const found = sourceId ? associationKinds[kindId].organization(sourceId) : null
    if (!found) denied("RECORD_UNAVAILABLE", associationKinds[kindId].name + " " + sourceId + " is not available")
    // another organization's record answers as a mismatch, never naming it
    if (found.owner !== row.organizationPartyId)
        denied("ORGANIZATION_MISMATCH", "A campaign links records of its own organization only")
    const existing = rows(ASSOCIATION, {
        marketingCampaignId: row.marketingCampaignId,
        associationKindEnumId: kindId,
        sourceId
    }).find(link => lib.active(link))
    if (existing) return {campaignAssociationId: existing.campaignAssociationId}
    const campaignAssociationId = call("create#" + ASSOCIATION, {
        marketingCampaignId: row.marketingCampaignId,
        associationKindEnumId: kindId,
        sourceId,
        purpose: text(p.purpose) || null,
        fromDate: ec.user.nowTimestamp,
        createdByUserId: ec.user.userId
    }).campaignAssociationId
    return {campaignAssociationId}
}

// ===== the flow: start, complete, cancel =====
// The pending work completion would leave: open child campaigns (P2); the sends (P8) and enrollments (P11) add theirs.
const pendingWorkSources = [
    {
        key: "childCampaigns",
        title: "open related campaigns",
        count: marketingCampaignId =>
            find(CAMPAIGN, {parentCampaignId: marketingCampaignId}).condition("statusId", "in", openStatuses).count()
    }
]
function pendingWork(marketingCampaignId) {
    return pendingWorkSources.map(source => ({
        key: source.key,
        title: source.title,
        count: Number(source.count(marketingCampaignId))
    }))
}
function transition(p) {
    const userScope = editor()
    const row = campaignOf(userScope, p.marketingCampaignId, true)
    requireRevision(row, p.expectedRevision)
    const action = text(p.action)
    const id = row.marketingCampaignId
    const by = " by " + (ec.user.username || ec.user.userId)
    if (action === "start") {
        if (row.statusId !== "MKTG_CAMP_APPROVED") denied("STATUS_INVALID", "Campaign " + id + " is not approved")
        if (!approvals.currentApproval("campaign", id, Number(row.campaignRevision || 1)))
            denied("APPROVAL_REQUIRED", "Campaign " + id + " needs the approval of its current revision")
        call("update#" + CAMPAIGN, {
            marketingCampaignId: id,
            statusId: "MKTG_CAMP_INPROGRESS",
            statusId_changeReason: "Started" + by,
            startDate: ec.user.nowTimestamp,
            isActive: "Y"
        })
    } else if (action === "complete") {
        if (row.statusId !== "MKTG_CAMP_INPROGRESS") denied("STATUS_INVALID", "Campaign " + id + " is not in progress")
        const pending = pendingWork(id).filter(work => work.count)
        if (pending.length)
            denied("PENDING_WORK", "Campaign " + id + " has " + pending.map(work => work.count + " " + work.title).join(", "))
        call("update#" + CAMPAIGN, {
            marketingCampaignId: id,
            statusId: "MKTG_CAMP_COMPLETED",
            statusId_changeReason: "Completed" + by,
            isActive: "N"
        })
    } else if (action === "cancel") {
        requireOpen(row)
        // its pending requests end with it (a later revision none will approve); sent and registered facts stay
        const campaignRevision = Number(row.campaignRevision || 1) + 1
        approvals.supersede("campaign", id, campaignRevision)
        call("update#" + CAMPAIGN, {
            marketingCampaignId: id,
            statusId: "MKTG_CAMP_CANCELLED",
            statusId_changeReason: (text(p.reason) || "Cancelled") + by,
            campaignRevision,
            isActive: "N"
        })
    } else denied("ACTION_INVALID", "Start, complete or cancel")
    const after = one(CAMPAIGN, {marketingCampaignId: id})
    return {marketingCampaignId: id, statusId: after.statusId}
}

// ===== duplicate#Campaign =====
// A new planned campaign from one the caller reads (a campaign template is a campaign duplicated so, design §3): its name (given,
// else "Copy of" it), summary, organization, parent, currency, budget, managers and current links; new dates when given. Its
// approvals, costs, files and notes stay with the original.
function duplicate(p) {
    const userScope = editor()
    const source = campaignOf(userScope, p.marketingCampaignId)
    marketingAccess.requireOrganization(userScope, source.organizationPartyId)
    const managers = currentParties(source.marketingCampaignId, roles.manager)
    const parentOpen = source.parentCampaignId
        ? openStatuses.includes(one(CAMPAIGN, {marketingCampaignId: source.parentCampaignId})?.statusId)
        : false
    const created = create({
        organizationPartyId: source.organizationPartyId,
        campaignName: text(p.campaignName) || "Copy of " + (source.campaignName || source.marketingCampaignId),
        campaignSummary: source.campaignSummary,
        parentCampaignId: parentOpen ? source.parentCampaignId : null,
        fromDate: Object.hasOwn(p, "fromDate") ? p.fromDate : null,
        thruDate: Object.hasOwn(p, "thruDate") ? p.thruDate : null,
        costUomId: source.costUomId,
        budgetedCost: source.budgetedCost,
        estimatedCost: source.estimatedCost,
        managerPartyId: managers.find(row => worksFor(row.partyId, source.organizationPartyId))?.partyId || null
    })
    const now = ec.user.nowTimestamp
    for (const manager of managers.slice(1))
        if (worksFor(manager.partyId, source.organizationPartyId))
            call("create#" + PARTY, {
                marketingCampaignId: created.marketingCampaignId,
                partyId: manager.partyId,
                roleTypeId: roles.manager,
                fromDate: now
            })
    for (const link of rows(ASSOCIATION, {marketingCampaignId: source.marketingCampaignId}).filter(link => lib.active(link)))
        call("create#" + ASSOCIATION, {
            marketingCampaignId: created.marketingCampaignId,
            associationKindEnumId: link.associationKindEnumId,
            sourceId: link.sourceId,
            purpose: link.purpose,
            fromDate: now,
            createdByUserId: ec.user.userId
        })
    return created
}

// ===== get#Campaign =====
// The campaign for its detail and its plan print: the plan, organization, parent and children, dated parties, the budget with the
// actual cost (MarketingCosts.js summary, masked sources), associations, decisions, the native notes and what the caller may do. As
// of a date (asOf) the parties, links, costs and decisions are those in effect then.
function get(p) {
    const userScope = reader()
    const row = campaignOf(userScope, p.marketingCampaignId)
    const id = row.marketingCampaignId
    const asOf = p.asOf ? dateOf(p.asOf, "The date") : ec.user.nowTimestamp
    const asOfMs = lib.ms(asOf)
    const policy = approvals.policyOf(row.organizationPartyId, asOf)
    const partyRows = rows(PARTY, {marketingCampaignId: id})
        .filter(party => (lib.ms(party.fromDate) ?? 0) <= asOfMs)
        .sort((a, b) => (lib.ms(a.fromDate) ?? 0) - (lib.ms(b.fromDate) ?? 0))
    const names = lib.partyNames(partyRows.map(party => party.partyId))
    const parties = partyRows.map(party => ({
        partyId: party.partyId,
        partyName: names[party.partyId] || organizationName(party.partyId) || party.partyId,
        roleTypeId: party.roleTypeId,
        roleText: roleNames[party.roleTypeId] || party.roleTypeId,
        fromDate: party.fromDate,
        fromDateText: lib.dateText(party.fromDate),
        thruDateText: lib.dateText(party.thruDate),
        current: lib.active(party, asOf)
    }))
    const associations = rows(ASSOCIATION, {marketingCampaignId: id})
        .filter(link => (lib.ms(link.fromDate) ?? 0) <= asOfMs)
        .map(link => {
            const kind = associationKinds[link.associationKindEnumId]
            let label = link.sourceId
            try {
                label = kind?.organization(link.sourceId)?.label || link.sourceId
            } catch (error) {
                ec.logger.error("Campaign " + id + " link " + link.campaignAssociationId + ": " + error.message)
            }
            return {
                campaignAssociationId: link.campaignAssociationId,
                associationKindEnumId: link.associationKindEnumId,
                kindText: kind?.name || link.associationKindEnumId,
                sourceId: link.sourceId,
                label,
                purpose: link.purpose || "",
                fromDateText: lib.dateText(link.fromDate),
                thruDateText: lib.dateText(link.thruDate),
                current: lib.active(link, asOf)
            }
        })
    const children = rows(CAMPAIGN, {parentCampaignId: id})
        .filter(child => marketingAccess.covers(userScope, child.organizationPartyId))
        .map(child => listRow(child))
    const parent = row.parentCampaignId ? one(CAMPAIGN, {marketingCampaignId: row.parentCampaignId}) : null
    const notes = rows(NOTE, {marketingCampaignId: id})
        .filter(note => (lib.ms(note.noteDate) ?? 0) <= asOfMs)
        .sort((a, b) => (lib.ms(b.noteDate) ?? 0) - (lib.ms(a.noteDate) ?? 0))
        .map(note => ({noteDateText: lib.dateText(note.noteDate), noteText: note.noteText || ""}))
    const costs = ec.resource
        .script("component://mr-mantle/service/mantle/marketing/MarketingCosts.js")
        .summary(userScope, row, asOf)
    const revision = Number(row.campaignRevision || 1)
    const decisions = approvals.decisionRows(approvals.targetKinds.campaign, id, p.asOf ? asOf : null)
    const caps = userScope.capabilities
    const open = openStatuses.includes(row.statusId)
    const pending = approvals.pendingRequest(approvals.targetKinds.campaign, id, revision)
    const problems = approvals.campaignProblems(row, policy)
    const edit = caps.campaignEdit && marketingAccess.covers(userScope, row.organizationPartyId)
    const authorIds = [row.createdByUserId, pending?.decidedByUserId].filter(Boolean)
    const own = authorIds.includes(ec.user.userId)
    return {
        campaign: Object.assign(
            listRow(
                row,
                parties.filter(party => party.current && party.roleTypeId === roles.manager).map(party => party.partyName),
                parent && marketingAccess.covers(userScope, parent.organizationPartyId)
                    ? parent.campaignName || parent.marketingCampaignId
                    : ""
            ),
            {
                campaignSummary: row.campaignSummary || "",
                estimatedCost: row.estimatedCost,
                estimatedText: moneyText(row.estimatedCost, row.costUomId),
                expectedResponsePercent: row.expectedResponsePercent,
                expectedRevenue: row.expectedRevenue,
                expectedRevenueText: moneyText(row.expectedRevenue, row.costUomId),
                startDateText: lib.dateText(row.startDate),
                fromDateText: lib.dateText(row.fromDate),
                thruDateText: lib.dateText(row.thruDate),
                campaignRevision: revision,
                // a legacy numSent and convertedLeads stay as data, never an authority (design §3)
                numSent: row.numSent
            }
        ),
        parties,
        associations,
        children,
        notes,
        costs: costs.costs,
        costSummary: costs.summary,
        decisions,
        pendingWork: pendingWork(id),
        approvalProblems: problems,
        awaitingApproval: !!pending,
        capabilities: {
            canEdit: !!edit && open,
            canEditMaterial: !!edit && ["MKTG_CAMP_PLANNED", "MKTG_CAMP_APPROVED"].includes(row.statusId),
            canRequestApproval: !!edit && row.statusId === "MKTG_CAMP_PLANNED" && !pending && !problems.length,
            canDecide: !!caps.approve && !!pending && (!own || approvals.selfApprovalAdmits(policy, "campaign", null)),
            canStart: !!edit && row.statusId === "MKTG_CAMP_APPROVED" && !!approvals.currentApproval("campaign", id, revision),
            canComplete: !!edit && row.statusId === "MKTG_CAMP_INPROGRESS",
            canCancel: !!edit && open,
            canDuplicate: !!edit,
            canAddCost: !!edit && open
        },
        asOfText: lib.dateText(asOf)
    }
}

// ===== hosts: Chatter and RecordFiles (design §14.3) =====
// check#CampaignAccess: whether the caller sees the campaign (a Marketing reader of its organization) and may change it (its
// editor while it is open): the record visibility of get#RecordLinkInfo and RecordFiles. A call with no user sees none.
function access(p) {
    if (!ec.user.userId) return {recordVisible: false, canEdit: false}
    const userScope = marketingAccess.scope()
    if (!userScope.capabilities.anyRead) return {recordVisible: false, canEdit: false}
    const row = one(CAMPAIGN, {marketingCampaignId: text(p.marketingCampaignId)})
    if (!row || !marketingAccess.covers(userScope, row.organizationPartyId)) return {recordVisible: false, canEdit: false}
    return {
        recordVisible: true,
        canEdit: !!userScope.capabilities.campaignEdit && openStatuses.includes(row.statusId),
        organizationPartyId: row.organizationPartyId
    }
}
// create#CampaignAsset's check: the campaign's editor.
function assetAccess(p) {
    const found = access(p)
    if (!found.recordVisible) denied("RECORD_UNAVAILABLE", "Campaign " + text(p.marketingCampaignId) + " is not available")
    if (!found.canEdit) denied("PERMISSION_DENIED", "Adding a campaign's files needs Marketing campaign edit on an open campaign")
    return found
}

// ===== the lifecycle participant marketing.campaigns (Admin's registry; §4, F59) =====
// A user's open campaigns' manager and contributor rows (not completed or cancelled), names only, for Admin's offboarding; another
// user's need MARKETING_OWNER_CHANGE (the caller's own list is theirs).
function ownerAccount(userId) {
    if (!userId) denied("USER_REQUIRED", "Name the user")
    if (userId !== ec.user.userId && !ec.user.hasPermission("MARKETING_OWNER_CHANGE"))
        denied("PERMISSION_DENIED", "Another user's campaign roles need Marketing owner change")
    const account = one("moqui.security.UserAccount", {userId})
    if (!account) denied("RECORD_UNAVAILABLE", "User " + userId + " is not available")
    return account
}
function ownedRows(partyId) {
    if (!partyId) return []
    return rows(PARTY, {partyId})
        .filter(row => [roles.manager, roles.contributor].includes(row.roleTypeId) && lib.active(row))
        .map(row => ({row, campaign: one(CAMPAIGN, {marketingCampaignId: row.marketingCampaignId})}))
        .filter(found => found.campaign && openStatuses.includes(found.campaign.statusId))
}
function findOwnedRoles(p) {
    const account = ownerAccount(text(p.userId))
    const resourceList = ownedRows(account.partyId).map(({row, campaign}) => ({
        resourceId: row.roleTypeId + ":" + row.marketingCampaignId,
        resourceName:
            (roleNames[row.roleTypeId] || row.roleTypeId) +
            " of " +
            (campaign.campaignName || campaign.marketingCampaignId) +
            " · " +
            organizationName(campaign.organizationPartyId),
        resourceKind: "assignment",
        transferable: true,
        note: null
    }))
    return {resourceList}
}
// Moves one row (campaignResourceId role:campaign) of fromUserId's to toUserId from now: the old row ended, the new one started;
// a manager's move is material (the plan's revision rises). Needs MARKETING_OWNER_CHANGE always; refuses a row fromUserId does not
// hold (RECORD_UNAVAILABLE), a closed campaign (CAMPAIGN_CLOSED), a successor who is disabled or no person (OWNER_INVALID) or does
// not work for the campaign's organization (NOT_EMPLOYED).
function transferRole(p) {
    if (!ec.user.hasPermission("MARKETING_OWNER_CHANGE"))
        denied("PERMISSION_DENIED", "Moving campaign roles needs Marketing owner change")
    const from = ownerAccount(text(p.fromUserId))
    const to = one("moqui.security.UserAccount", {userId: text(p.toUserId)})
    if (!to || to.disabled === "Y" || !to.partyId || !one("mantle.party.Person", {partyId: to.partyId}))
        denied("OWNER_INVALID", "The successor is an enabled user who is a person")
    const [roleTypeId, marketingCampaignId] = text(p.campaignResourceId).split(":")
    const owned = ownedRows(from.partyId).find(
        found => found.row.roleTypeId === roleTypeId && found.row.marketingCampaignId === marketingCampaignId
    )
    if (!owned) {
        const campaign = marketingCampaignId ? one(CAMPAIGN, {marketingCampaignId}) : null
        if (campaign && !openStatuses.includes(campaign.statusId))
            denied("CAMPAIGN_CLOSED", "Campaign " + marketingCampaignId + " is closed")
        denied("RECORD_UNAVAILABLE", "That campaign role is not the user's")
    }
    if (!worksFor(to.partyId, owned.campaign.organizationPartyId))
        denied("NOT_EMPLOYED", "The successor does not work for the campaign's organization")
    const now = ec.user.nowTimestamp
    call("update#" + PARTY, {
        marketingCampaignId,
        partyId: from.partyId,
        roleTypeId,
        fromDate: owned.row.fromDate,
        thruDate: now
    })
    if (!currentParties(marketingCampaignId, roleTypeId).some(row => row.partyId === to.partyId)) {
        ensureRole(to.partyId, roleTypeId)
        call("create#" + PARTY, {marketingCampaignId, partyId: to.partyId, roleTypeId, fromDate: now})
    }
    // a manager's move changes who answers for an approved plan: material, but never refused in progress (the person left)
    if (roleTypeId === roles.manager && owned.campaign.statusId !== "MKTG_CAMP_INPROGRESS")
        call("update#" + CAMPAIGN, Object.assign({marketingCampaignId}, materialChange(owned.campaign, "its manager left")))
    ec.logger.info(
        "Campaign " +
            marketingCampaignId +
            " " +
            roleTypeId +
            " moved from " +
            from.userId +
            " to " +
            to.userId +
            (text(p.reason) ? ": " + text(p.reason) : "")
    )
    return {transferred: true}
}

// ===== counts for Home (MarketingWorkspace.js) =====
const runningCount = organizationIds =>
    organizationIds.length
        ? find(CAMPAIGN)
              .condition("organizationPartyId", "in", organizationIds)
              .condition("statusId", "MKTG_CAMP_INPROGRESS")
              .count()
        : 0

const operations = {
    find: findCampaigns,
    create,
    store,
    storeBudget,
    storeParty,
    storeAssociation,
    transition,
    duplicate,
    get,
    access,
    assetAccess,
    findOwnedRoles,
    transferRole
}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown marketing campaign operation " + op)
        return operations[op](parameters || {})
    },
    campaignOf,
    requireRevision,
    requireOpen,
    openStatuses,
    statusText,
    statusColor,
    listRow,
    runningCount,
    worksFor
})
