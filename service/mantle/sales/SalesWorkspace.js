// Sales' workspace projections (mantle.sales.SalesWorkspaceServices; IronStone Sales design §3 Home, §1.4, §8; impl-sales P6): Home's
// counters and assigned work, the pipeline dataset's row filter, and the lifecycle participant of Admin's offboarding (the
// owned-resource contract, framework service/org/moqui/admin/IdentityServices.xml).
//
// - Home (get#SalesHome): each counter is the count of the scoped list it opens (find#Opportunities with the list's own filters,
//   SalesOpportunities.js), so a counter and its list never disagree; a counter that fails is unavailable, never zero, and the
//   others go on. The counters of records later phases build (requests for quote, quotes, blocked orders) are not configured.
// - The row filter (get#PipelineRowFilter, the report engine's ReportScopePolicy MantleSalesScope): Sales' scope, the organization
//   and then the assignment or team (SalesAccess.js), not the organization alone, which would show a representative the
//   organization's whole pipeline (impl-sales F66).
// - The lifecycle participant (find#OwnedSalesAssignments, transfer#SalesAssignment): the open leads and opportunities a departing
//   user owns, their open quotes (P7) and the accounts they manage, read and moved by a holder of SALES_OWNER_CHANGE (Admin's identity operator and
//   administrator), the new owner one who works for the record's organization. Names only; no amount.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const salesAccess = ec.resource.script("component://mr-mantle/service/mantle/sales/SalesAccess.js")
const settings = ec.resource.script("component://mr-mantle/service/mantle/sales/SalesSettings.js")
const opportunities = ec.resource.script("component://mr-mantle/service/mantle/sales/SalesOpportunities.js")
const {find, one, rows, denied, call, ms} = lib

const OPPORTUNITY = "mantle.sales.opportunity.SalesOpportunity"
const OPPORTUNITY_PARTY = "mantle.sales.opportunity.SalesOpportunityParty"
const RELATIONSHIP = "mantle.party.PartyRelationship"
const roles = salesAccess.opportunityRoles
const managerRelationship = "PrtAccountManager"
const openStatus = "SalesOppOpen"
const assignedLimit = 10
const ownedCap = 500
const dayMs = 24 * 60 * 60 * 1000

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const L = value => ec.l10n.localize(value)
const current = (row, at = ms(ec.user.nowTimestamp)) =>
    (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at
const dayOf = at => ec.l10n.format(new Date(at), "yyyy-MM-dd")

// ===== get#SalesHome =====
// The counters, each the count of a scoped list with that list's own filters and the screen path it opens: the leads to work (the
// open leads the user sees: theirs and their teams' queues, or the organization's for SALES_TEAM_VIEW), the user's own open
// opportunities and those of them past their expected close (to yesterday, in the user's zone).
function counterDefinitions(organizationPartyId) {
    const organization = organizationPartyId ? {organizationPartyId} : {}
    const yesterday = dayOf(ms(ec.user.nowTimestamp) - dayMs)
    return [
        {
            counterKey: "leads",
            title: "Leads to work",
            listPath: "Pipeline/Leads",
            parameters: Object.assign({}, organization),
            find: Object.assign({typeEnumId: "SotLead", statusId: openStatus}, organization)
        },
        {
            counterKey: "myOpportunities",
            title: "My open opportunities",
            listPath: "Pipeline/Opportunities",
            parameters: Object.assign({mine: "Y"}, organization),
            find: Object.assign({typeEnumId: "SotOpportunity", statusId: openStatus, mine: "Y"}, organization)
        },
        {
            counterKey: "pastClose",
            title: "Past their expected close",
            listPath: "Pipeline/Opportunities",
            parameters: Object.assign({mine: "Y", closeThru: yesterday}, organization),
            find: Object.assign(
                {typeEnumId: "SotOpportunity", statusId: openStatus, mine: "Y", closeThru: yesterday},
                organization
            )
        }
    ]
}
// the counters of the records later phases build: not configured until then, never zero
const laterCounters = [
    {counterKey: "quotesToSend", title: "Quotes to send", source: "Quotes"},
    {counterKey: "quotesExpiring", title: "Quotes expiring", source: "Quotes"},
    {counterKey: "ordersBlocked", title: "Orders blocked", source: "Orders"}
]
function findDeals(parameters) {
    ec.message.pushErrors()
    try {
        const found = opportunities.execute("findOpportunities", parameters)
        if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
        return found
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}
function salesHome(p) {
    const userScope = salesAccess.scope()
    salesAccess.requireCapability(userScope, "anyRead")
    const organizationPartyId = text(p.organizationPartyId)
    if (organizationPartyId) salesAccess.requireOrganization(userScope, organizationPartyId)
    const counters = []
    for (const definition of counterDefinitions(organizationPartyId)) {
        const counter = {
            counterKey: definition.counterKey,
            title: L(definition.title),
            listPath: definition.listPath,
            parameters: definition.parameters,
            count: null,
            state: "unavailable",
            stateText: L("Unavailable")
        }
        try {
            counter.count = Number(findDeals(Object.assign({pageSize: 1}, definition.find)).opportunityListCount || 0)
            counter.state = "ready"
            counter.stateText = String(counter.count)
        } catch (error) {
            ec.logger.error("Sales Home counter " + definition.counterKey + " is unavailable: " + error.message)
        }
        counters.push(counter)
    }
    // P8: the requests for quote awaiting a response (not quoted, declined or completed) the user sees, in the RFQ list's filter
    const rfqCounter = {
        counterKey: "quoteRequests",
        title: L("RFQs awaiting response"),
        listPath: "Quotes/QuoteRequests",
        parameters: Object.assign({state: "awaiting"}, organizationPartyId ? {organizationPartyId} : {}),
        count: null,
        state: "unavailable",
        stateText: L("Unavailable")
    }
    ec.message.pushErrors()
    try {
        const found = ec.resource
            .script("component://mr-mantle/service/mantle/order/SalesQuoteRequests.js")
            .execute("findQuoteRequests", Object.assign({pageSize: 1}, rfqCounter.parameters))
        if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
        rfqCounter.count = Number(found.quoteRequestListCount || 0)
        rfqCounter.state = "ready"
        rfqCounter.stateText = String(rfqCounter.count)
    } catch (error) {
        ec.logger.error("Sales Home counter quoteRequests is unavailable: " + error.message)
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
    counters.push(rfqCounter)
    for (const later of laterCounters)
        counters.push({
            counterKey: later.counterKey,
            title: L(later.title),
            listPath: null,
            parameters: {},
            count: null,
            state: "notConfigured",
            stateText: L("Not configured"),
            source: L(later.source)
        })
    // the next commercial actions: the user's own open leads and opportunities, the soonest to close first, with their next activity
    let assignedWork = []
    let assignedCount = null
    let assignedState = "ready"
    try {
        const found = findDeals(
            Object.assign(
                {mine: "Y", statusId: openStatus, orderByField: "estimatedCloseDate", pageSize: assignedLimit},
                organizationPartyId ? {organizationPartyId} : {}
            )
        )
        assignedCount = Number(found.opportunityListCount || 0)
        assignedWork = Array.from(found.opportunityList || []).map(row => ({
            salesOpportunityId: row.salesOpportunityId,
            opportunityName: row.opportunityName,
            typeText: row.typeText,
            accountName: row.accountName,
            stageText: row.stageText,
            amountText: row.amountText,
            closeText: row.closeText,
            nextActivityText: row.nextActivityText,
            statusText: row.statusText,
            statusColor: row.statusColor
        }))
    } catch (error) {
        assignedState = "unavailable"
        ec.logger.error("Sales Home assigned work is unavailable: " + error.message)
    }
    return {counters, assignedWork, assignedCount, assignedState}
}

// ===== get#PipelineRowFilter =====
// The pipeline dataset's rows the signed-in viewer reads: the deals of the organizations of their sales scope and, without
// SALES_TEAM_VIEW, of those only the deals assigned now to them or a team of theirs (the rule of SalesAccess.js opportunityOf).
// Nothing for a viewer who reads nothing of Sales; another user's filter is refused.
const nothing = () => ({bool: {none: [{match_all: {}}]}})
function pipelineRowFilter(p) {
    if (!ec.user.userId) return {filter: nothing()}
    if (text(p.userId) && text(p.userId) !== ec.user.userId)
        denied("PERMISSION_DENIED", "The sales row filter is computed for the signed-in user only")
    const userScope = salesAccess.scope()
    if (!userScope.capabilities.anyRead) return {filter: nothing()}
    const all = []
    if (userScope.organizationPartyIds != null) {
        if (!userScope.organizationPartyIds.length) return {filter: nothing()}
        all.push({field: {name: "organizationPartyId", op: "in", values: Array.from(userScope.organizationPartyIds)}})
    }
    const assigned = salesAccess.assignedOpportunityIds(userScope)
    if (assigned != null) {
        if (!assigned.length) return {filter: nothing()}
        all.push({field: {name: "salesOpportunityId", op: "in", values: assigned}})
    }
    if (!all.length) return {filter: {match_all: {}}}
    return {filter: all.length === 1 ? all[0] : {bool: {all}}}
}

// ===== the lifecycle participant =====
// The account a lookup or transfer is about: the caller's own, or another user's for a holder of SALES_OWNER_CHANGE.
function ownerAccount(userId, permission = "SALES_OWNER_CHANGE") {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in to see sales assignments")
    if (userId !== ec.user.userId && !ec.user.hasPermission(permission))
        denied("PERMISSION_DENIED", permission + " is required for another user's sales assignments")
    return one("moqui.security.UserAccount", {userId})
}
function organizationName(partyId) {
    return one("mantle.party.Organization", {partyId})?.organizationName || partyId || ""
}
// The open deals a party owns now (a current owner row on a deal not Won or Lost). The cap is on the open deals: a closed deal keeps
// its owner row, so capping the owner rows would leave out open deals of a long-serving owner.
function ownedDeals(partyId) {
    const ids = Array.from(
        find(OPPORTUNITY_PARTY)
            .condition("partyId", partyId)
            .condition("roleTypeId", roles.owner)
            .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
            .selectField("salesOpportunityId")
            .list()
    ).map(row => row.salesOpportunityId)
    if (!ids.length) return []
    const cf = ec.entity.conditionFactory
    const open = cf.makeCondition(
        [cf.makeCondition("statusId", "equals", openStatus), cf.makeCondition("statusId", "is-null", null)],
        "or"
    )
    return Array.from(
        find(OPPORTUNITY)
            .condition("salesOpportunityId", "in", Array.from(new Set(ids)))
            .condition(open)
            .orderBy("salesOpportunityId")
            .limit(ownedCap)
            .list()
    )
}
// The open quotes a party owns (P7): a quote (OrderHeader of purpose SalesQuote) Open, Requested or Proposed and never placed whose
// part names them as its owner (an OrderPartParty SalesRepresentative row, which has no dates: the row is the current owner).
const PART_PARTY = "mantle.order.OrderPartParty"
const openQuoteStatuses = ["OrderOpen", "OrderRequested", "OrderProposed"]
function ownedQuotes(partyId) {
    const ids = Array.from(
        new Set(
            Array.from(
                find(PART_PARTY)
                    .condition("partyId", partyId)
                    .condition("roleTypeId", salesAccess.quoteRoles.owner)
                    .selectField("orderId")
                    .list()
            ).map(row => row.orderId)
        )
    )
    if (!ids.length) return []
    return Array.from(
        find("mantle.order.OrderHeader")
            .condition("orderId", "in", ids)
            .condition("orderPurposeEnumId", salesAccess.quotePurpose)
            .condition("statusId", "in", openQuoteStatuses)
            .condition("placedDate", "is-null", null)
            .orderBy("orderId")
            .limit(ownedCap)
            .list()
    )
}
function quoteSeller(orderId) {
    return (
        Array.from(find("mantle.order.OrderPart").condition("orderId", orderId).orderBy("orderPartSeqId").list())[0]
            ?.vendorPartyId || null
    )
}
// The accounts a party manages now (a current PrtAccountManager relationship from them).
function managedAccounts(partyId) {
    return Array.from(
        find(RELATIONSHIP)
            .condition("fromPartyId", partyId)
            .condition("relationshipTypeEnumId", managerRelationship)
            .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
            .limit(ownedCap)
            .list()
    )
}
// find#OwnedSalesAssignments: what userId owns of Sales, for an offboarding preview: each open lead or opportunity they own
// (resourceId deal:id) and each account they manage (account:partyId), transferable, named with its organization, never its amount.
function findOwnedAssignments(p) {
    const account = ownerAccount(text(p.userId))
    const partyId = account?.partyId
    if (!partyId) return {resourceList: []}
    const resourceList = []
    for (const deal of ownedDeals(partyId))
        resourceList.push({
            resourceId: "deal:" + deal.salesOpportunityId,
            resourceName:
                (deal.typeEnumId === "SotLead" ? L("Lead") : L("Opportunity")) +
                " " +
                (deal.opportunityName || deal.salesOpportunityId) +
                " · " +
                organizationName(deal.organizationPartyId),
            resourceKind: deal.typeEnumId === "SotLead" ? "lead" : "opportunity",
            transferable: true,
            note: ""
        })
    for (const quote of ownedQuotes(partyId))
        resourceList.push({
            resourceId: "quote:" + quote.orderId,
            resourceName:
                L("Quote") + " " + (quote.orderName || quote.orderId) + " · " + organizationName(quoteSeller(quote.orderId)),
            resourceKind: "quote",
            transferable: true,
            note: ""
        })
    const names = lib.partyNames(managedAccounts(partyId).map(row => row.toPartyId))
    for (const row of managedAccounts(partyId)) {
        const owner = one("mantle.party.Party", {partyId: row.toPartyId})?.ownerPartyId
        // a shared account has no organization to manage it (set#AccountManager refuses one), so no new manager can take it: listed,
        // not transferable, and its old relationship ends with the user's access
        const shared = !owner || owner === "_NA_"
        resourceList.push({
            resourceId: "account:" + row.toPartyId,
            resourceName:
                L("Account") + " " + (names[row.toPartyId] || row.toPartyId) + (shared ? "" : " · " + organizationName(owner)),
            resourceKind: "account",
            transferable: !shared,
            note: shared ? L("A shared account has no account manager to hand over") : ""
        })
    }
    return {resourceList}
}
// The new owner: an enabled account with a party who works for the record's organization now.
function newOwner(toUserId, organizationPartyId) {
    const account = toUserId ? one("moqui.security.UserAccount", {userId: toUserId}) : null
    if (!account || account.disabled === "Y" || !account.partyId)
        denied("OWNER_INVALID", "The new owner needs an enabled account with a person")
    if (!organizationPartyId || !settings.worksFor(account.partyId, organizationPartyId))
        denied("NOT_EMPLOYED", "The new owner must work for " + organizationName(organizationPartyId))
    return account.partyId
}
// transfer#SalesAssignment: one deal or account of fromUserId's handed to toUserId's person: a deal's owner row ends now and the new
// owner's starts (the deal's team is kept), an account's manager relationship ends now and the new manager's starts. Refuses a
// resource fromUserId does not own now (RECORD_UNAVAILABLE), a closed deal (RECORD_CLOSED) and a new owner who cannot own it.
function transferAssignment(p) {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in to move sales assignments")
    if (!ec.user.hasPermission("SALES_OWNER_CHANGE"))
        denied("PERMISSION_DENIED", "SALES_OWNER_CHANGE is required to move another user's sales assignments")
    const from = one("moqui.security.UserAccount", {userId: text(p.fromUserId) || "_NA_"})
    const fromPartyId = from?.partyId
    const resourceId = text(p.salesResourceId) || ""
    const [kind, id] = [resourceId.split(":")[0], resourceId.substring(resourceId.indexOf(":") + 1)]
    const unavailable = () =>
        denied("RECORD_UNAVAILABLE", "Sales assignment " + resourceId + " is not " + (p.fromUserId || "") + "'s")
    if (!fromPartyId || !id || id === resourceId) unavailable()
    const now = ec.user.nowTimestamp
    if (kind === "deal") {
        const deal = one(OPPORTUNITY, {salesOpportunityId: id})
        const ownerRows = rows(OPPORTUNITY_PARTY, {salesOpportunityId: id, roleTypeId: roles.owner}).filter(row => current(row))
        if (!deal || !ownerRows.some(row => row.partyId === fromPartyId)) unavailable()
        if (deal.statusId && deal.statusId !== openStatus) denied("RECORD_CLOSED", (deal.opportunityName || id) + " is closed")
        const toPartyId = newOwner(text(p.toUserId), deal.organizationPartyId)
        if (toPartyId === fromPartyId) return {transferred: false}
        for (const row of ownerRows)
            call("update#" + OPPORTUNITY_PARTY, {
                salesOpportunityId: id,
                partyId: row.partyId,
                roleTypeId: row.roleTypeId,
                fromDate: row.fromDate,
                thruDate: now
            })
        call("create#" + OPPORTUNITY_PARTY, {salesOpportunityId: id, partyId: toPartyId, roleTypeId: roles.owner, fromDate: now})
        ec.logger.info(
            "Sales deal " +
                id +
                " moved from " +
                p.fromUserId +
                " to " +
                p.toUserId +
                " by " +
                ec.user.userId +
                (p.reason ? ": " + p.reason : "")
        )
        return {transferred: true}
    }
    if (kind === "quote") {
        // P7: an open quote's owner row (undated: the old row removed, the new owner's made); its team and contact are kept
        const order = one("mantle.order.OrderHeader", {orderId: id})
        const ownerRows = rows(PART_PARTY, {orderId: id, partyId: fromPartyId, roleTypeId: salesAccess.quoteRoles.owner})
        if (!order || order.orderPurposeEnumId !== salesAccess.quotePurpose || !ownerRows.length) unavailable()
        if (!openQuoteStatuses.includes(order.statusId) || order.placedDate)
            denied("RECORD_CLOSED", (order.orderName || id) + " is no longer an open quote")
        const toPartyId = newOwner(text(p.toUserId), quoteSeller(id))
        if (toPartyId === fromPartyId) return {transferred: false}
        for (const row of ownerRows) {
            const key = {orderId: id, orderPartSeqId: row.orderPartSeqId, roleTypeId: row.roleTypeId}
            call("delete#" + PART_PARTY, Object.assign({partyId: fromPartyId}, key))
            if (!one(PART_PARTY, Object.assign({partyId: toPartyId}, key)))
                call("create#" + PART_PARTY, Object.assign({partyId: toPartyId}, key))
        }
        ec.logger.info(
            "Sales quote " +
                id +
                " moved from " +
                p.fromUserId +
                " to " +
                p.toUserId +
                " by " +
                ec.user.userId +
                (p.reason ? ": " + p.reason : "")
        )
        return {transferred: true}
    }
    if (kind === "account") {
        const managing = managedAccounts(fromPartyId).filter(row => row.toPartyId === id)
        if (!managing.length) unavailable()
        const owner = one("mantle.party.Party", {partyId: id})?.ownerPartyId
        const toPartyId = newOwner(text(p.toUserId), owner && owner !== "_NA_" ? owner : null)
        for (const row of managing) call("update#" + RELATIONSHIP, {partyRelationshipId: row.partyRelationshipId, thruDate: now})
        if (!managedAccounts(toPartyId).some(row => row.toPartyId === id)) {
            if (!one("mantle.party.PartyRole", {partyId: toPartyId, roleTypeId: "SalesRepresentative"}))
                call("create#mantle.party.PartyRole", {partyId: toPartyId, roleTypeId: "SalesRepresentative"})
            call("create#" + RELATIONSHIP, {
                relationshipTypeEnumId: managerRelationship,
                fromPartyId: toPartyId,
                fromRoleTypeId: "SalesRepresentative",
                toPartyId: id,
                toRoleTypeId: "Account",
                fromDate: now
            })
        }
        ec.logger.info(
            "Sales account " +
                id +
                " moved from " +
                p.fromUserId +
                " to " +
                p.toUserId +
                " by " +
                ec.user.userId +
                (p.reason ? ": " + p.reason : "")
        )
        return {transferred: true}
    }
    unavailable()
}

const operations = {salesHome, pipelineRowFilter, findOwnedAssignments, transferAssignment}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown sales workspace operation " + op)
        return operations[op](parameters || {})
    }
})
