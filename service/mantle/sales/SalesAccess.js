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
// scope P3, the assignment and team scope of opportunities P4, quotes and orders P7 and P11), and this module grants nothing
// by itself.
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
// The organization an account write is for: the one named, which must be in the scope, else the active one, else the scope's
// only one. Refuses a caller without SALES_ACCOUNT_EDIT (PERMISSION_DENIED) and an organization outside the scope or none chosen
// (ORGANIZATION_DENIED).
function accountOrganization(userScope, organizationPartyId) {
    requireCapability(userScope, "accountEdit")
    let chosen = organizationPartyId || userScope.activeOrganizationPartyId
    if (!chosen && userScope.organizationPartyIds?.length === 1) chosen = userScope.organizationPartyIds[0]
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

;({
    permissions,
    reads,
    capabilities,
    scope,
    covers,
    requireCapability,
    requireOrganization,
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
    memberTeams
})
