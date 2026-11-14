// Marketing's scope (IronStone Marketing design §1.1; impl-marketing P1, §2): the one module the marketing services call to learn
// what the caller may do and in which organizations, before they read or write a campaign, a list, a segment, a send or an
// event, and before a marketing report answers. The organization filters (X12: MarketingCampaign by organizationPartyId,
// MarketSegment and ContactList by ownerPartyId, in MANTLE_USER_ORG and MANTLE_ACTIVE_ORG, data/MantleSetupData.xml) bound what
// an app root's user reads; the services check the organization here again, as the filters do not reach a service that reads
// with authorization disabled.
//
// - Capabilities come from the MARKETING_* and Comms' MESSAGE_* permissions (permissions), never a group name, a calling screen
//   or a supplied app root. A write permission alone reads nothing (reads): a Marketing read is MARKETING_VIEW,
//   MARKETING_AUDIENCE_VIEW or MARKETING_REPORT_VIEW.
// - The caller's organizations are their own (get#PartyOrganizationInfo), narrowed to the active one when it is theirs; every
//   organization (organizationPartyIds null) for a system administrator or a holder of MARKETING_ALL_ORGANIZATIONS, which reads
//   nothing by itself (as Sales', People's and Maintenance's: the Marketing administrator's); none for a caller who reads
//   nothing.
// - An unowned record (an owner or organization that is empty or _NA_, a legacy campaign, list or segment) is no organization's:
//   no scope covers it, so nothing reads or writes it through a Marketing service until an administrator adopts it
//   (MarketingAdoption.js).
// - A contact list that is not a mailbox (listReachable): reached by a user who works for its owner, a holder of
//   MARKETING_ALL_ORGANIZATIONS for an owner that is an internal organization, and a contact administrator (CONTACT_ADMIN) or
//   ADMIN, who keep every list for Comms' Consent screens (impl-marketing F77). A mailbox keeps its own rules
//   (ContactListServices get#ContactListAccess).
// - Refusals carry reason codes (EntityLib.js denied): an organization outside the scope ORGANIZATION_DENIED, a missing
//   permission PERMISSION_DENIED, a record that is missing or outside the scope RECORD_UNAVAILABLE.
//
// P1 builds the capabilities, the organizations and the list rule; later phases add their record checks (a campaign P2, a
// list's policy P3, a segment P5, a send P8, an event P16), and this module grants nothing by itself.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, denied} = lib
const access = lib.access

// ===== capabilities =====
const permissions = {
    view: "MARKETING_VIEW",
    campaignEdit: "MARKETING_CAMPAIGN_EDIT",
    sendEdit: "MARKETING_SEND_EDIT",
    contentEdit: "MARKETING_CONTENT_EDIT",
    audienceView: "MARKETING_AUDIENCE_VIEW",
    audienceEdit: "MARKETING_AUDIENCE_EDIT",
    audienceImport: "MARKETING_AUDIENCE_IMPORT",
    audienceExport: "MARKETING_AUDIENCE_EXPORT",
    consentEdit: "MARKETING_CONSENT_EDIT",
    approve: "MARKETING_APPROVE",
    dispatch: "MARKETING_DISPATCH",
    eventManage: "MARKETING_EVENT_MANAGE",
    reportView: "MARKETING_REPORT_VIEW",
    configure: "MARKETING_CONFIGURE",
    // Comms' shared permissions (design §1.1), each an explicit grant
    templateView: "MESSAGE_TEMPLATE_VIEW",
    templateEdit: "MESSAGE_TEMPLATE_EDIT",
    sendingConfigure: "MESSAGE_SENDING_CONFIGURE",
    suppressionReview: "MESSAGE_SUPPRESSION_REVIEW",
    // the scope of a read in every internal organization; no read by itself
    allOrganizations: "MARKETING_ALL_ORGANIZATIONS"
}
// The derived reads, each from view permissions only: anything of Marketing in an organization (anyRead), its person-level
// audiences (audienceRead) and its aggregate reports (reportRead).
const reads = {
    anyRead: ["view", "audienceView", "reportView"],
    audienceRead: ["audienceView"],
    reportRead: ["reportView"]
}
function capabilities() {
    const found = {}
    for (const [name, permission] of Object.entries(permissions)) found[name] = access.has(permission)
    for (const [name, from] of Object.entries(reads)) found[name] = from.some(capability => found[capability])
    return found
}

// ===== scope =====
// The organizations the caller belongs to and their active one (set aside when it is not theirs).
function memberOrganizations() {
    const info = ec.user.userId
        ? ec.service.sync().name("mantle.party.PartyServices.get#PartyOrganizationInfo").disableAuthz().call() || {}
        : {}
    const memberPartyIds = Array.from(info.userOrgIds || [])
    const filtered = Array.from(info.filterOrgIds || []).filter(partyId => memberPartyIds.includes(partyId))
    return {
        memberPartyIds,
        activeOrganizationPartyId: memberPartyIds.includes(info.activeOrgId) ? info.activeOrgId : null,
        organizationPartyIds: filtered.length ? filtered : memberPartyIds
    }
}
// The caller's capabilities, party and organizations (organizationPartyIds null: every organization).
function scope() {
    const caps = capabilities()
    const own = caps.anyRead ? memberOrganizations() : null
    const all = !!own && (access.systemAdmin() || caps.allOrganizations)
    return {
        capabilities: caps,
        partyId: ec.user.userAccount?.partyId || null,
        allOrganizations: all,
        activeOrganizationPartyId: own?.activeOrganizationPartyId || null,
        organizationPartyIds: own ? (all ? null : own.organizationPartyIds) : []
    }
}
// An owner or organization that makes a record no organization's: empty or _NA_.
const unowned = partyId => !partyId || partyId === "_NA_"
// Whether a party is an internal organization.
const internalOrganization = partyId =>
    !unowned(partyId) && find("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"}).count() > 0
// Whether the scope covers an organization; never an unowned one.
function covers(userScope, partyId) {
    if (unowned(partyId)) return false
    return userScope.organizationPartyIds == null
        ? internalOrganization(partyId)
        : userScope.organizationPartyIds.includes(partyId)
}
function requireCapability(userScope, capability) {
    if (!Object.hasOwn(userScope.capabilities, capability)) throw new Error("Unknown marketing capability " + capability)
    if (!userScope.capabilities[capability]) denied("PERMISSION_DENIED", "Marketing " + capability + " is required")
}
function requireOrganization(userScope, partyId) {
    if (!covers(userScope, partyId)) denied("ORGANIZATION_DENIED", "Organization " + (partyId || "") + " is not available")
    return partyId
}
// The organizations of a scope as a list: its own, or every internal organization when it is every one.
function organizationIds(userScope) {
    if (userScope.organizationPartyIds != null) return Array.from(userScope.organizationPartyIds)
    return Array.from(find("mantle.party.PartyRole", {roleTypeId: "OrgInternal"}).selectField("partyId").list()).map(
        row => row.partyId
    )
}

// ===== contact lists (impl-marketing F77) =====
// A contact administrator keeps every list, as Comms' Consent screens need, and ADMIN with them.
const contactAdministrator = () => access.has("CONTACT_ADMIN")
// Whether the current user may reach a contact list that is not a mailbox through the list services (get#ContactListAccess's
// non-mailbox branch): a contact administrator any; a user who works for its owner, or a holder of MARKETING_ALL_ORGANIZATIONS
// when its owner is an internal organization; an unowned list nobody else until it is adopted. With no user (a run with
// authorization off, as the system) the list services behave as before.
function listReachable(ownerPartyId) {
    if (!ec.user.userId) return true
    if (contactAdministrator()) return true
    if (unowned(ownerPartyId)) return false
    if (access.has("MARKETING_ALL_ORGANIZATIONS") && internalOrganization(ownerPartyId)) return true
    return memberOrganizations().memberPartyIds.includes(ownerPartyId)
}
// The owner a new contact list that is not a mailbox may take (create#ContactList): one the caller may reach, which a contact
// administrator need not name; refused otherwise (ORGANIZATION_DENIED).
function requireListOwner(ownerPartyId) {
    if (!ec.user.userId || contactAdministrator()) return ownerPartyId || null
    if (unowned(ownerPartyId) || !listReachable(ownerPartyId))
        denied("ORGANIZATION_DENIED", "A list belongs to an organization you work for")
    return ownerPartyId
}

;({
    permissions,
    reads,
    capabilities,
    memberOrganizations,
    scope,
    unowned,
    internalOrganization,
    covers,
    requireCapability,
    requireOrganization,
    organizationIds,
    contactAdministrator,
    listReachable,
    requireListOwner
})
