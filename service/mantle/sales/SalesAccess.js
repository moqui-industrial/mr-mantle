// Sales' scope (IronStone Sales design §1.1; impl-sales P1, §2): the one module the sales services call to learn what the
// caller may do and in which organizations, before they read or write an opportunity, an account, a quote, an order, an
// agreement or a forecast, and before a sales report answers. The organization filter (X12: SalesOpportunity, SalesForecast
// and Agreement by organizationPartyId in MANTLE_USER_ORG and MANTLE_ACTIVE_ORG, data/MantleSetupData.xml) bounds what an app
// root's user reads; the services check the organization here again, as the filter does not reach a service that reads with
// authorization disabled.
//
// - Capabilities come from the SALES_* permissions (permissions, data/MantleSetupData.xml), never a group name, a calling
//   screen or a supplied app root. A write permission alone reads nothing (reads): a Sales read is SALES_VIEW,
//   SALES_TEAM_VIEW or SALES_REPORT_VIEW.
// - The caller's organizations are their own (get#PartyOrganizationInfo over get#PartyInternalOrgIds), narrowed to the active
//   one when it is theirs; every organization (organizationPartyIds null) for a system administrator or a holder of
//   SALES_ALL_ORGANIZATIONS, which reads nothing by itself (the user's call, impl-sales P1 review: the Sales administrator's, as
//   People's and Maintenance's); none for a caller who reads nothing. No other Sales permission widens them.
// - Refusals carry reason codes (EntityLib.js denied): an organization outside the scope ORGANIZATION_DENIED, a missing
//   permission PERMISSION_DENIED.
//
// P1 builds the capabilities and the organizations; later phases extend the tables and add the record checks (the account
// scope P3, the assignment and team scope of opportunities P4, below, quotes and orders P7 and P11), and this module grants
// nothing by itself.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {denied} = lib
const access = lib.access

// ===== capabilities =====
const permissions = {
    view: "SALES_VIEW",
    teamView: "SALES_TEAM_VIEW",
    teamManage: "SALES_TEAM_MANAGE",
    opportunityEdit: "SALES_OPPORTUNITY_EDIT",
    accountEdit: "SALES_ACCOUNT_EDIT",
    quoteEdit: "SALES_QUOTE_EDIT",
    quoteSend: "SALES_QUOTE_SEND",
    orderEdit: "SALES_ORDER_EDIT",
    orderApprove: "SALES_ORDER_APPROVE",
    orderChange: "SALES_ORDER_CHANGE",
    approve: "SALES_APPROVE",
    agreementEdit: "SALES_AGREEMENT_EDIT",
    recurrenceManage: "SALES_RECURRENCE_MANAGE",
    forecastEdit: "SALES_FORECAST_EDIT",
    reportView: "SALES_REPORT_VIEW",
    customerInvite: "SALES_CUSTOMER_INVITE",
    import: "SALES_IMPORT",
    configure: "SALES_CONFIGURE",
    ownerChange: "SALES_OWNER_CHANGE",
    // the scope of a read in every internal organization; no read by itself
    allOrganizations: "SALES_ALL_ORGANIZATIONS"
}
// The derived reads, each from view permissions only: anything of Sales in an organization (anyRead), the organization's
// whole pipeline rather than one's own and one's team's (teamRead), and its sales reports (reportRead).
const reads = {
    anyRead: ["view", "teamView", "reportView"],
    teamRead: ["teamView"],
    reportRead: ["reportView"]
}
function capabilities() {
    const found = {}
    for (const [name, permission] of Object.entries(permissions)) found[name] = access.has(permission)
    for (const [name, from] of Object.entries(reads)) found[name] = from.some(capability => found[capability])
    return found
}

// ===== scope =====
// The caller's own organizations: those they belong to, narrowed to the active one when it is theirs; an active organization
// they do not belong to is set aside.
function ownOrganizations() {
    const info = ec.user.userId
        ? ec.service.sync().name("mantle.party.PartyServices.get#PartyOrganizationInfo").disableAuthz().call() || {}
        : {}
    const memberPartyIds = Array.from(info.userOrgIds || [])
    const filtered = Array.from(info.filterOrgIds || []).filter(partyId => memberPartyIds.includes(partyId))
    return {
        activeOrganizationPartyId: memberPartyIds.includes(info.activeOrgId) ? info.activeOrgId : null,
        organizationPartyIds: filtered.length ? filtered : memberPartyIds
    }
}
// The caller's capabilities, party and organizations (organizationPartyIds null: every organization).
function scope() {
    const caps = capabilities()
    const own = caps.anyRead ? ownOrganizations() : null
    const all = !!own && (access.systemAdmin() || caps.allOrganizations)
    return {
        capabilities: caps,
        partyId: ec.user.userAccount?.partyId || null,
        allOrganizations: all,
        activeOrganizationPartyId: own?.activeOrganizationPartyId || null,
        organizationPartyIds: own ? (all ? null : own.organizationPartyIds) : []
    }
}
// Whether the scope covers an organization.
function covers(userScope, partyId) {
    return !!partyId && (userScope.organizationPartyIds == null || userScope.organizationPartyIds.includes(partyId))
}
function requireCapability(userScope, capability) {
    if (!Object.hasOwn(userScope.capabilities, capability)) throw new Error("Unknown sales capability " + capability)
    if (!userScope.capabilities[capability]) denied("PERMISSION_DENIED", "Sales " + capability + " is required")
}
function requireOrganization(userScope, partyId) {
    if (!covers(userScope, partyId)) denied("ORGANIZATION_DENIED", "Organization " + (partyId || "") + " is not available")
    return partyId
}

// ===== reports =====
// The organizations a sales report answers a Sales report reader for (SalesAnalysis.js organizations, impl-sales P1, F2): those
// named, each one in the reader's scope, else every one of the scope; costs withheld without PRODUCT_COST_VIEW. Refuses a caller
// without SALES_REPORT_VIEW (PERMISSION_DENIED) and an organization outside the scope (ORGANIZATION_DENIED).
function reportOrganizations(named = []) {
    const userScope = scope()
    requireCapability(userScope, "reportRead")
    for (const partyId of named) requireOrganization(userScope, partyId)
    const all = userScope.organizationPartyIds
    return {
        organizationPartyIds: named.length ? named : all == null ? null : all.length ? all : ["_NA_"],
        costWithheld: !access.has("PRODUCT_COST_VIEW")
    }
}

// ===== accounts (P3) =====
// An account (design §4 Accounts; impl-sales P3) is a party with a Sales account role (Account, Customer or Prospect) that is not
// an internal organization, not disabled or merged, and not another user's personal contact; it belongs to the organization that
// owns it (Party.ownerPartyId, the same field the organization filters read) or, owned by none (_NA_), is shared and seen by every
// organization, as Customer Service's shared customers are. A Sales reader sees the accounts of the organizations of their scope
// and the shared ones; a contact is a person with a current PrtContact relationship to such an account, and is seen through it.
// A refused account answers as a missing one (RECORD_UNAVAILABLE).
const accountRoles = ["Account", "Customer", "Prospect"]
const sharedOwner = "_NA_"
function isInternal(partyId) {
    return !!lib.one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
function hasAccountRole(partyId) {
    return (
        lib.find("mantle.party.PartyRole").condition("partyId", partyId).condition("roleTypeId", "in", accountRoles).count() > 0
    )
}
// The party as a party the caller may see: not disabled, not another user's personal contact, owned by an organization of the
// scope or by none (_NA_).
function visibleParty(userScope, partyId) {
    if (!partyId || !userScope.capabilities.anyRead) return null
    const party = lib.one("mantle.party.Party", {partyId})
    if (!party || party.disabled === "Y" || party.mergedToPartyId) return null
    if (party.privateOwnerUserId && party.privateOwnerUserId !== ec.user.userId) return null
    const ownerPartyId = party.ownerPartyId || sharedOwner
    if (ownerPartyId !== sharedOwner && !covers(userScope, ownerPartyId)) return null
    return party
}
// The account, or null: {party, organizationPartyId (its owner, null when shared), shared}.
function accountOf(userScope, partyId) {
    const party = visibleParty(userScope, partyId)
    if (!party || !hasAccountRole(partyId) || isInternal(partyId)) return null
    const ownerPartyId = party.ownerPartyId || sharedOwner
    return {party, organizationPartyId: ownerPartyId === sharedOwner ? null : ownerPartyId, shared: ownerPartyId === sharedOwner}
}
function requireAccount(userScope, partyId) {
    const account = accountOf(userScope, partyId)
    if (!account) denied("RECORD_UNAVAILABLE", "Account " + (partyId || "") + " is not available")
    return account
}
// The accounts of the scope a person is a current contact of (PrtContact from the person to the account).
function contactAccounts(userScope, partyId) {
    if (!visibleParty(userScope, partyId)) return []
    const accounts = []
    for (const row of lib.rows("mantle.party.PartyRelationship", {fromPartyId: partyId, relationshipTypeEnumId: "PrtContact"})) {
        if (!lib.active(row)) continue
        const account = accountOf(userScope, row.toPartyId)
        if (account && !accounts.some(found => found.party.partyId === row.toPartyId))
            accounts.push(Object.assign({partyRelationshipId: row.partyRelationshipId}, account))
    }
    return accounts
}
// The organization a new record is for when none is named: the active one, else the scope's only one, else the only one of the
// scope the caller works for themselves (an agent or employee: a representative of Retail whose scope also holds Retail's rollup
// children, P4 review); null when that leaves a choice. The rule is Mantle's, for every app (FacilityScope.js defaultOrganization).
function defaultOrganization(userScope) {
    return ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js").defaultOrganization(userScope)
}
// The organization an account write is for: the one named, which must be in the scope, else the default one (defaultOrganization).
// Refuses a caller without SALES_ACCOUNT_EDIT (PERMISSION_DENIED) and an organization outside the scope or none chosen
// (ORGANIZATION_DENIED).
function accountOrganization(userScope, organizationPartyId) {
    requireCapability(userScope, "accountEdit")
    const chosen = organizationPartyId || defaultOrganization(userScope)
    if (!chosen) denied("ORGANIZATION_DENIED", "Choose the organization the account belongs to")
    if (!isInternal(chosen)) denied("ORGANIZATION_DENIED", "Organization " + chosen + " is not available")
    return requireOrganization(userScope, chosen)
}
// Whether the caller may merge accounts of an organization (design §4 MergeAccounts, impl-sales §4 F45): a Sales manager or
// administrator, SALES_ACCOUNT_EDIT with SALES_TEAM_MANAGE or SALES_CONFIGURE, for an organization of their scope.
function mergesFor(userScope, organizationPartyId) {
    const caps = userScope.capabilities
    return (
        !!organizationPartyId && caps.accountEdit && (caps.teamManage || caps.configure) && covers(userScope, organizationPartyId)
    )
}

// ===== P2: sales teams (impl-sales P2; design-sales §9 Teams) =====
// A sales team is an Organization party with the SalesTeam role, owned by its organization; its dated PrtSalesTeamOf row to the
// organization is its effective interval, and its members are dated PrtSalesTeamMember rows from the person (a
// SalesRepresentative or a Manager) to the team (data/SalesCrmSeedData.xml; OpportunityServices store#SalesTeam and
// store#SalesTeamMember). Reads only, no check: the organization of a team and the teams of a person, which P4's assignment
// scope ("their dated team") reads here. Membership grants no permission.
const teamRelationships = {of: "PrtSalesTeamOf", member: "PrtSalesTeamMember"}
// The organization of a team (its PrtSalesTeamOf row, the latest; an ended team keeps its organization), or null for a party
// that is no sales team.
function teamOrganization(teamPartyId) {
    if (!teamPartyId) return null
    const row = Array.from(
        lib
            .find("mantle.party.PartyRelationship", {relationshipTypeEnumId: teamRelationships.of, fromPartyId: teamPartyId})
            .orderBy("-fromDate")
            .limit(1)
            .list()
    )[0]
    return row?.toPartyId || null
}
// The teams a person is a member of at a time (now when not given), by their dated membership rows.
function memberTeams(partyId, at = ec.user.nowTimestamp) {
    if (!partyId) return []
    const found = lib
        .rows("mantle.party.PartyRelationship", {relationshipTypeEnumId: teamRelationships.member, fromPartyId: partyId})
        .filter(row => lib.active(row, at))
        .map(row => row.toPartyId)
    return Array.from(new Set(found))
}

// ===== P4: opportunities (impl-sales P4; design-sales §1.1, §3) =====
// A lead or an opportunity (SalesOpportunity) belongs to its selling organization (organizationPartyId, kept equal to its
// OrgInternal SalesOpportunityParty row by the opportunity services). Inside an organization of the scope a Sales reader sees the
// deals assigned to them (a current SalesRepresentative row: the primary owner) or to a team they are a current member of (a
// current SalesTeam row: a team's deal, or an unassigned lead in its queue), and a holder of SALES_TEAM_VIEW (teamRead) the
// organization's every deal. A customer link (the account, a contact) never widens it. Ending a membership ends the team's deals
// from that date (memberTeams reads the dated rows). An edit needs SALES_OPPORTUNITY_EDIT on a deal the caller sees. A deal
// outside the scope answers as a missing one (RECORD_UNAVAILABLE).
const opportunityRoles = {owner: "SalesRepresentative", team: "SalesTeam", contact: "Contact", organization: "OrgInternal"}
// The parties whose assignment shows a deal to the caller: their own party and their current teams.
function assignmentParties(userScope, at = ec.user.nowTimestamp) {
    return userScope.partyId ? [userScope.partyId].concat(memberTeams(userScope.partyId, at)) : []
}
// The ids of the deals assigned now to the caller or a team of theirs (the owner and team rows), or null for a reader of the
// organizations' whole pipeline (teamRead), whose reads are bounded by the organizations alone.
function assignedOpportunityIds(userScope) {
    if (userScope.capabilities.teamRead) return null
    const partyIds = assignmentParties(userScope)
    if (!partyIds.length) return []
    return Array.from(
        new Set(
            Array.from(
                lib
                    .find("mantle.sales.opportunity.SalesOpportunityParty")
                    .condition("partyId", "in", partyIds)
                    .condition("roleTypeId", "in", [opportunityRoles.owner, opportunityRoles.team])
                    .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                    .selectField("salesOpportunityId")
                    .list()
            ).map(row => row.salesOpportunityId)
        )
    )
}
// The deal as the caller may see it, or null: {opportunity, organizationPartyId, canEdit}.
function opportunityOf(userScope, salesOpportunityId) {
    if (!salesOpportunityId || !userScope.capabilities.anyRead) return null
    const opportunity = lib.one("mantle.sales.opportunity.SalesOpportunity", {salesOpportunityId})
    if (!opportunity || !covers(userScope, opportunity.organizationPartyId)) return null
    if (!userScope.capabilities.teamRead) {
        const partyIds = assignmentParties(userScope)
        const assigned =
            partyIds.length > 0 &&
            lib
                .find("mantle.sales.opportunity.SalesOpportunityParty")
                .condition("salesOpportunityId", salesOpportunityId)
                .condition("partyId", "in", partyIds)
                .condition("roleTypeId", "in", [opportunityRoles.owner, opportunityRoles.team])
                .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                .count() > 0
        if (!assigned) return null
    }
    return {
        opportunity,
        organizationPartyId: opportunity.organizationPartyId,
        canEdit: !!userScope.capabilities.opportunityEdit
    }
}
// The deal or a refusal: RECORD_UNAVAILABLE when the caller does not see it, PERMISSION_DENIED for an edit without
// SALES_OPPORTUNITY_EDIT.
function requireOpportunity(userScope, salesOpportunityId, edit = false) {
    const found = opportunityOf(userScope, salesOpportunityId)
    if (!found) denied("RECORD_UNAVAILABLE", "Opportunity " + (salesOpportunityId || "") + " is not available")
    if (edit) requireCapability(userScope, "opportunityEdit")
    return found
}

// ===== P7: quotes (impl-sales P7; design-sales §1.1, §5) =====
// A quote is a native order of purpose SalesQuote (OrderHeader.orderPurposeEnumId OrpSalesQuote) whose part sells: its vendor an
// internal organization of the scope, its customer not internal. Inside the organization a Sales reader sees the quotes assigned to
// them or a team of theirs (the part's SalesRepresentative and SalesTeam OrderPartParty rows, which create#Quote writes) and a holder
// of SALES_TEAM_VIEW the organization's every quote; a customer or an opportunity link never widens it. An edit needs
// SALES_QUOTE_EDIT on a quote the caller sees. A quote outside the scope answers as a missing one (RECORD_UNAVAILABLE).
const quoteRoles = {owner: "SalesRepresentative", team: "SalesTeam", contact: "Contact"}
const quotePurpose = "OrpSalesQuote"
// The ids of the orders assigned now to the caller or a team of theirs (the part's owner and team rows), or null for a reader of
// the organizations' every quote (teamRead).
function assignedQuoteOrderIds(userScope) {
    if (userScope.capabilities.teamRead) return null
    const partyIds = assignmentParties(userScope)
    if (!partyIds.length) return []
    return Array.from(
        new Set(
            Array.from(
                lib
                    .find("mantle.order.OrderPartParty")
                    .condition("partyId", "in", partyIds)
                    .condition("roleTypeId", "in", [quoteRoles.owner, quoteRoles.team])
                    .selectField("orderId")
                    .list()
            ).map(row => row.orderId)
        )
    )
}
// The quote as the caller may see it, or null: {order, part, organizationPartyId, customerPartyId, canEdit}.
function quoteOf(userScope, orderId) {
    if (!orderId || !userScope.capabilities.anyRead) return null
    const order = lib.one("mantle.order.OrderHeader", {orderId})
    if (!order || order.orderPurposeEnumId !== quotePurpose) return null
    const part = Array.from(lib.find("mantle.order.OrderPart").condition("orderId", orderId).orderBy("orderPartSeqId").list())[0]
    if (!part || !covers(userScope, part.vendorPartyId) || !isInternal(part.vendorPartyId)) return null
    if (!part.customerPartyId || isInternal(part.customerPartyId)) return null
    let approverOnly = false
    if (!userScope.capabilities.teamRead) {
        const partyIds = assignmentParties(userScope)
        const assigned =
            partyIds.length > 0 &&
            lib
                .find("mantle.order.OrderPartParty")
                .condition("orderId", orderId)
                .condition("partyId", "in", partyIds)
                .condition("roleTypeId", "in", [quoteRoles.owner, quoteRoles.team])
                .count() > 0
        // P9: a holder of SALES_APPROVE sees a quote of their organizations that asked for an approval (design §1.1 "an assigned
        // approval grants its authorized approver the source projection needed to decide that"), to read and decide, not to edit
        if (!assigned) {
            if (!approvalAsked(userScope, orderId)) return null
            approverOnly = true
        }
    }
    return {
        order,
        part,
        organizationPartyId: part.vendorPartyId,
        customerPartyId: part.customerPartyId,
        canEdit: !!userScope.capabilities.quoteEdit && !approverOnly
    }
}
// ===== P9: approvals (impl-sales P9; design-sales §1.1, §5 Approvals) =====
// Whether the caller approves Sales exceptions (SALES_APPROVE) and the quote asked for one (an OrderDecision of purpose SapQuote,
// mantle.order.SalesApprovalServices request#QuoteApproval); the organization is checked by quoteOf.
function approvalAsked(userScope, orderId) {
    return (
        !!userScope.capabilities.approve &&
        lib
            .find("mantle.order.OrderDecision")
            .condition("orderId", orderId)
            .condition("decisionPurposeEnumId", "SapQuote")
            .count() > 0
    )
}
// The quote or a refusal: RECORD_UNAVAILABLE when the caller does not see it, PERMISSION_DENIED for an edit without
// SALES_QUOTE_EDIT.
function requireQuote(userScope, orderId, edit = false) {
    const found = quoteOf(userScope, orderId)
    if (!found) denied("RECORD_UNAVAILABLE", "Quote " + (orderId || "") + " is not available")
    if (edit) requireCapability(userScope, "quoteEdit")
    // P9: an approver who sees the quote only for its approval may not change it
    if (edit && !found.canEdit) denied("PERMISSION_DENIED", "Quote " + orderId + " is for you to decide, not to change")
    return found
}

// ===== P11: sales orders (impl-sales P11; design-sales §1.1, §6 Orders) =====
// A sales order is a native order whose first part sells: its vendor an internal organization of the scope, its customer not
// internal. It is a direct order (purpose OrpSalesOrder, a draft while Open), an accepted quote (OrpSalesQuote once placed), or any
// other sales order of the seller (a store's, Projects', a replacement), placed. Never a quote not yet placed, a quote template, a
// recurring base or an open cart. Inside the organization a Sales reader sees the orders assigned to them or a team of theirs (the
// part's SalesRepresentative and SalesTeam rows) and a holder of SALES_TEAM_VIEW the organization's every one; a holder of
// SALES_ORDER_APPROVE or ORDER_APPROVE sees the organization's orders awaiting approval or on hold, to decide them, not to change them (design
// §1.1 "an assigned approval grants its authorized approver the source projection"), and (P12) read only an order they decided once it
// is approved. One outside the scope answers as missing.
const orderPurposes = {direct: "OrpSalesOrder", quote: quotePurpose}
const orderExcludedPurposes = ["OrpRecurringTemplate", "OrpSalesQuoteTemplate"]
const approvalStatuses = ["OrderPlaced", "OrderHold"]
// P14: the statuses in which a change operator (SALES_ORDER_CHANGE) sees the organization's orders, read only, to propose and apply
// commercial changes (design §1.1 BOSS_SALES_CHANGE; mantle.order.OrderChangeServices checks the change itself)
const changeStatuses = ["OrderPlaced", "OrderProcessing", "OrderApproved", "OrderHold"]
// Whether an order header and its first part are a sales order of Sales' kind (above), the scope aside.
function isSalesOrder(order, part) {
    if (!order || !part) return false
    if (orderExcludedPurposes.includes(order.orderPurposeEnumId)) return false
    if (order.orderPurposeEnumId === quotePurpose && !order.placedDate) return false
    if (order.statusId === "OrderOpen" && order.orderPurposeEnumId !== orderPurposes.direct) return false
    return !!part.vendorPartyId && isInternal(part.vendorPartyId) && !!part.customerPartyId && !isInternal(part.customerPartyId)
}
// The ids of the orders assigned now to the caller or a team of theirs, or null for a reader of the organizations' every one.
function assignedOrderIds(userScope) {
    return assignedQuoteOrderIds(userScope)
}
// Whether the caller approves sales orders: SALES_ORDER_APPROVE (a seller whose approval setting is on) or ORDER_APPROVE (elsewhere).
function orderApprover(userScope) {
    return !!userScope.capabilities.orderApprove || access.has("ORDER_APPROVE")
}
// The order as the caller may see it, or null: {order, part, parts, organizationPartyId, customerPartyId, canEdit, approverOnly}.
function orderOf(userScope, orderId) {
    if (!orderId || !userScope.capabilities.anyRead) return null
    const order = lib.one("mantle.order.OrderHeader", {orderId})
    if (!order) return null
    const parts = Array.from(lib.find("mantle.order.OrderPart").condition("orderId", orderId).orderBy("orderPartSeqId").list())
    const part = parts[0]
    if (!isSalesOrder(order, part) || !covers(userScope, part.vendorPartyId)) return null
    let approverOnly = false
    if (!userScope.capabilities.teamRead) {
        const partyIds = assignmentParties(userScope)
        const assigned =
            partyIds.length > 0 &&
            lib
                .find("mantle.order.OrderPartParty")
                .condition("orderId", orderId)
                .condition("partyId", "in", partyIds)
                .condition("roleTypeId", "in", [quoteRoles.owner, quoteRoles.team])
                .count() > 0
        if (!assigned) {
            // P12 (the user's call of Nov 14, P11's review): an approver keeps read-only sight of an order they decided (an
            // OrderDecision of theirs) once it is approved; the organization's other approved orders stay out of sight
            const approverReach = orderApprover(userScope) && (approvalStatuses.includes(order.statusId) || decidedBy(orderId))
            // P14: a change operator's reach, read only (changeStatuses)
            const changeReach = !!userScope.capabilities.orderChange && changeStatuses.includes(order.statusId)
            if (!approverReach && !changeReach) return null
            approverOnly = true
        }
    }
    return {
        order,
        part,
        parts,
        organizationPartyId: part.vendorPartyId,
        customerPartyId: part.customerPartyId,
        canEdit: !!userScope.capabilities.orderEdit && !approverOnly,
        approverOnly
    }
}
// The order or a refusal: RECORD_UNAVAILABLE when the caller does not see it, PERMISSION_DENIED for a change without
// SALES_ORDER_EDIT or by an approver who sees it only to decide it.
function requireOrder(userScope, orderId, edit = false) {
    const found = orderOf(userScope, orderId)
    if (!found) denied("RECORD_UNAVAILABLE", "Order " + (orderId || "") + " is not available")
    if (edit) requireCapability(userScope, "orderEdit")
    if (edit && !found.canEdit) denied("PERMISSION_DENIED", "Order " + orderId + " is for you to decide, not to change")
    return found
}

// ===== P8: requests for quote (impl-sales P8; design-sales §1.1, §5 QuoteRequests) =====
// A request for quote (RFQ) is a Request of type RqtQuote whose current OrgInternal RequestParty is its selling organization; its
// customer and contact are its Customer and Contact rows, its owner and team its SalesRepresentative and SalesTeam rows, as a quote's
// part has them. Inside an organization of the scope a Sales reader sees the RFQs assigned to them or a team of theirs and a holder
// of SALES_TEAM_VIEW the organization's every one; a customer link never widens it. A change needs SALES_QUOTE_EDIT. One outside the
// scope answers as a missing one (RECORD_UNAVAILABLE). A warranty claim (RqtWarranty, Customer Service's) is a quote's source only
// while its current decision is a chargeable repair (repairSourceOf, in SalesQuoteRequests.js): it is never an RFQ here.
const quoteRequestType = "RqtQuote"
const quoteRequestRoles = {
    organization: "OrgInternal",
    customer: "Customer",
    contact: "Contact",
    owner: "SalesRepresentative",
    team: "SalesTeam"
}
// The current RequestParty rows of a request.
function requestParties(requestId) {
    return lib.rows("mantle.request.RequestParty", {requestId}).filter(row => lib.active(row))
}
// The ids of the RFQs assigned now to the caller or a team of theirs, or null for a reader of the organizations' every one
// (teamRead).
function assignedQuoteRequestIds(userScope) {
    if (userScope.capabilities.teamRead) return null
    const partyIds = assignmentParties(userScope)
    if (!partyIds.length) return []
    return Array.from(
        new Set(
            Array.from(
                lib
                    .find("mantle.request.RequestParty")
                    .condition("partyId", "in", partyIds)
                    .condition("roleTypeId", "in", [quoteRequestRoles.owner, quoteRequestRoles.team])
                    .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                    .selectField("requestId")
                    .list()
            ).map(row => row.requestId)
        )
    )
}
// The RFQ as the caller may see it, or null: {request, parties, organizationPartyId, customerPartyId, canEdit}.
function quoteRequestOf(userScope, requestId) {
    if (!requestId || !userScope.capabilities.anyRead) return null
    const request = lib.one("mantle.request.Request", {requestId})
    if (!request || request.requestTypeEnumId !== quoteRequestType) return null
    const parties = requestParties(requestId)
    const partyOf = roleTypeId => parties.find(row => row.roleTypeId === roleTypeId)?.partyId || null
    const organizationPartyId = partyOf(quoteRequestRoles.organization)
    if (!organizationPartyId || !covers(userScope, organizationPartyId) || !isInternal(organizationPartyId)) return null
    if (!userScope.capabilities.teamRead) {
        const partyIds = assignmentParties(userScope)
        const assigned = parties.some(
            row => [quoteRequestRoles.owner, quoteRequestRoles.team].includes(row.roleTypeId) && partyIds.includes(row.partyId)
        )
        if (!assigned) return null
    }
    return {
        request,
        parties,
        organizationPartyId,
        customerPartyId: partyOf(quoteRequestRoles.customer),
        contactPartyId: partyOf(quoteRequestRoles.contact),
        ownerPartyId: partyOf(quoteRequestRoles.owner),
        teamPartyId: partyOf(quoteRequestRoles.team),
        canEdit: !!userScope.capabilities.quoteEdit
    }
}
// The RFQ or a refusal: RECORD_UNAVAILABLE when the caller does not see it, PERMISSION_DENIED for a change without SALES_QUOTE_EDIT.
function requireQuoteRequest(userScope, requestId, edit = false) {
    const found = quoteRequestOf(userScope, requestId)
    if (!found) denied("RECORD_UNAVAILABLE", "Request for quote " + (requestId || "") + " is not available")
    if (edit) requireCapability(userScope, "quoteEdit")
    return found
}

// ===== P12: quote templates and the approver's decided orders (impl-sales P12; design-sales §5 QuoteTemplates) =====
// A quote template is a native order of purpose SalesQuoteTemplate (OrderHeader.orderPurposeEnumId OrpSalesQuoteTemplate), never
// placed and never leaving Open, whose one part names its selling organization (the vendor, an internal organization) and no
// customer; its published interval is the part's validity: a draft has none, a published one a start (current from it, scheduled
// before it) and an end once replaced by its successor or ended (impl-sales §4, Nov 11). Inside an organization of the scope a Sales
// reader sees its current templates (to start a quote from one); a template manager (SALES_QUOTE_EDIT with SALES_TEAM_MANAGE or
// SALES_CONFIGURE: a Sales manager or administrator, design §2's M and S) sees and maintains every one of the organization, and
// changes only a draft. One outside the scope, or not shown to the caller, answers as missing (RECORD_UNAVAILABLE).
const templatePurpose = "OrpSalesQuoteTemplate"
// Whether the caller maintains quote templates (a Sales manager or administrator who edits quotes).
function templateManager(userScope) {
    const caps = userScope.capabilities
    return !!caps.quoteEdit && !!(caps.teamManage || caps.configure)
}
// A template's state from its part's validity at a time (now when not given): draft, scheduled, current or ended.
function templateState(part, at = ec.user.nowTimestamp) {
    const from = lib.ms(part.validFromDate)
    const thru = lib.ms(part.validThruDate)
    const now = lib.ms(at)
    if (from == null) return "draft"
    if (thru != null && thru <= now) return "ended"
    return from > now ? "scheduled" : "current"
}
// The template as the caller may see it, or null: {order, part, organizationPartyId, state, canManage, canEdit}.
function templateOf(userScope, orderId) {
    if (!orderId || !userScope.capabilities.anyRead) return null
    const order = lib.one("mantle.order.OrderHeader", {orderId})
    if (!order || order.orderPurposeEnumId !== templatePurpose) return null
    const part = Array.from(lib.find("mantle.order.OrderPart").condition("orderId", orderId).orderBy("orderPartSeqId").list())[0]
    if (!part || !covers(userScope, part.vendorPartyId) || !isInternal(part.vendorPartyId)) return null
    const state = templateState(part)
    const canManage = templateManager(userScope)
    if (!canManage && state !== "current") return null
    return {order, part, organizationPartyId: part.vendorPartyId, state, canManage, canEdit: canManage && state === "draft"}
}
// The template or a refusal: RECORD_UNAVAILABLE when the caller does not see it; for a change, PERMISSION_DENIED for a caller who
// does not maintain templates and TEMPLATE_PUBLISHED for one no longer a draft (a published template is changed by its successor).
function requireTemplate(userScope, orderId, edit = false) {
    const found = templateOf(userScope, orderId)
    if (!found) denied("RECORD_UNAVAILABLE", "Quote template " + (orderId || "") + " is not available")
    if (edit && !found.canManage)
        denied("PERMISSION_DENIED", "Quote templates are maintained by a Sales manager or administrator")
    if (edit && !found.canEdit)
        denied("TEMPLATE_PUBLISHED", "Quote template " + orderId + " is published; start its successor to change it")
    return found
}
// Whether the caller recorded a decision on the order (an approval or refusal of theirs, OrderDecision; a request is the asker's).
const decidedResults = ["SdrApproved", "SdrRefused"]
function decidedBy(orderId) {
    return (
        !!ec.user.userId &&
        lib
            .find("mantle.order.OrderDecision")
            .condition("orderId", orderId)
            .condition("decisionByUserId", ec.user.userId)
            .condition("decisionResultEnumId", "in", decidedResults)
            .count() > 0
    )
}
// The ids of the orders the caller recorded a decision on (find#SalesOrders' approver reach beside the orders awaiting approval).
function decidedOrderIds() {
    if (!ec.user.userId) return []
    return Array.from(
        new Set(
            Array.from(
                lib
                    .find("mantle.order.OrderDecision")
                    .condition("decisionByUserId", ec.user.userId)
                    .condition("decisionResultEnumId", "in", decidedResults)
                    .selectField("orderId")
                    .list()
            ).map(row => row.orderId)
        )
    )
}
// ===== end of P12 =====

;({
    permissions,
    reads,
    capabilities,
    scope,
    covers,
    requireCapability,
    requireOrganization,
    defaultOrganization,
    reportOrganizations,
    // P3: accounts and contacts
    accountRoles,
    isInternal,
    visibleParty,
    accountOf,
    requireAccount,
    contactAccounts,
    accountOrganization,
    mergesFor,
    // P2: sales teams
    teamRelationships,
    teamOrganization,
    memberTeams,
    // P4: opportunities
    opportunityRoles,
    assignmentParties,
    assignedOpportunityIds,
    opportunityOf,
    requireOpportunity,
    // P7
    quoteRoles,
    quotePurpose,
    assignedQuoteOrderIds,
    quoteOf,
    requireQuote,
    // P8: requests for quote
    quoteRequestType,
    quoteRequestRoles,
    requestParties,
    assignedQuoteRequestIds,
    quoteRequestOf,
    requireQuoteRequest,
    // P11: sales orders
    orderPurposes,
    orderExcludedPurposes,
    isSalesOrder,
    assignedOrderIds,
    orderApprover,
    // P14: the change operator's statuses
    changeStatuses,
    orderOf,
    requireOrder,
    // P12: quote templates; the orders an approver decided
    templatePurpose,
    templateManager,
    templateState,
    templateOf,
    requireTemplate,
    decidedOrderIds
})
