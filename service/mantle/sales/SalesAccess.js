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
//   one when it is theirs; every organization (organizationPartyIds null) for a system administrator; none for a caller who
//   reads nothing. No Sales permission widens them to other organizations.
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
    ownerChange: "SALES_OWNER_CHANGE"
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
    const all = !!own && access.systemAdmin()
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

;({permissions, reads, capabilities, scope, covers, requireCapability, requireOrganization, reportOrganizations})
