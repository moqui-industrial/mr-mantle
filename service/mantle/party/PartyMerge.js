// The guards of a party merge (mantle.party.DuplicateServices merge#Parties and check#PartyMerge; IronStone design-drawers-commons
// §6, design-sales §4 MergeAccounts, crosscut X15; impl-sales P3, §4 F45): inside Mantle, so every path to a merge meets them.
//
// Who may merge (admits):
// - a caller that disabled authorization or runs as the system (a job, Shop's claim of a verified account's guest purchases,
//   ShopCustomer.js): its own code decided, as before P3;
// - a contact administrator (CONTACT_ADMIN, which Mantle grants ADMIN), as Commons' merge has asked since it was built;
// - the owner of a personal contact merging it into a directory party or into another of their own (link#PersonalContactToDirectory);
// - for an account of their organization, a Sales manager or administrator: SALES_ACCOUNT_EDIT with SALES_TEAM_MANAGE or
//   SALES_CONFIGURE, both parties a Sales account or a contact of one in their sales scope, owned by the same organization of it
//   (SalesAccess.js mergesFor; the user's call, impl-sales §4). No new permission.
// What any merge must be (rules):
// - two parties, both found (another user's personal contact is not found), the merged one not an internal organization;
// - of one kind, a person with a person and an organization with an organization;
// - of one owner organization: two parties owned by different organizations (Party.ownerPartyId, neither _NA_) are refused;
// - the merged party's opportunities and agreements of the owner organization only (a cross-organization dependency is refused,
//   never moved), and for a Sales merger its orders with the organizations of their scope only.
// Refusals carry reason codes (EntityLib.js denied). merge#Parties moves what it may (ExternalAccessContact, agreements and their
// parties, an opportunity's account and parties) after these checks.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {one, denied} = lib
const access = lib.access
const salesAccess = () => ec.resource.script("component://mr-mantle/service/mantle/sales/SalesAccess.js")

const sharedOwner = "_NA_"
const ownerOf = party => party.ownerPartyId || sharedOwner

// The two parties as the caller may see them: another user's personal contact is not found.
function partiesOf(toPartyId, fromPartyId) {
    const read = partyId => {
        const party = partyId ? one("mantle.party.Party", {partyId}) : null
        if (!party || (party.privateOwnerUserId && party.privateOwnerUserId !== ec.user.userId))
            denied("RECORD_UNAVAILABLE", "Party " + (partyId || "") + " is not available")
        return party
    }
    if (!toPartyId || toPartyId === fromPartyId) denied("SAME_PARTY", "Choose two different parties")
    return {to: read(toPartyId), from: read(fromPartyId)}
}
// A Sales account or a contact of one in the scope.
function salesParty(userScope, partyId) {
    const sales = salesAccess()
    return !!sales.accountOf(userScope, partyId) || sales.contactAccounts(userScope, partyId).length > 0
}
// How the caller is admitted, or PERMISSION_DENIED.
function admits(to, from) {
    if (!ec.user.userId || ec.artifactExecution.authzDisabled()) return {by: "system"}
    if (access.has("CONTACT_ADMIN")) return {by: "contactAdmin"}
    const userId = ec.user.userId
    if (from.privateOwnerUserId === userId && (!to.privateOwnerUserId || to.privateOwnerUserId === userId)) return {by: "owner"}
    const owner = ownerOf(to) === ownerOf(from) && ownerOf(to) !== sharedOwner ? ownerOf(to) : null
    if (owner) {
        const userScope = salesAccess().scope()
        if (salesAccess().mergesFor(userScope, owner) && salesParty(userScope, to.partyId) && salesParty(userScope, from.partyId))
            return {by: "sales", userScope}
    }
    denied("PERMISSION_DENIED", "You may not merge these parties")
}
// The rules every merge meets, then for a Sales merger the documents it moves.
function rules(to, from, admitted) {
    if (isInternal(from.partyId))
        denied("INTERNAL_PARTY", "Party " + from.partyId + " is an internal organization and is not merged")
    if (to.partyTypeEnumId !== from.partyTypeEnumId) denied("PARTY_KIND_MISMATCH", "A person and an organization are not merged")
    const toOwner = ownerOf(to)
    const fromOwner = ownerOf(from)
    if (toOwner !== sharedOwner && fromOwner !== sharedOwner && toOwner !== fromOwner)
        denied("ORGANIZATION_MISMATCH", "Parties of two organizations are not merged")
    const organizationPartyId = toOwner !== sharedOwner ? toOwner : fromOwner !== sharedOwner ? fromOwner : null
    if (organizationPartyId) {
        const other = dependencyOrganizations(from.partyId).find(partyId => partyId !== organizationPartyId)
        if (other)
            denied(
                "DEPENDENCY_OTHER_ORGANIZATION",
                "Party " + from.partyId + " has opportunities or agreements of another organization and is not merged"
            )
    }
    if (admitted.by === "sales") {
        // the merged party's orders, invoices and payments with an internal organization outside the Sales merger's scope
        // (read without the caller's filters, as merge#Parties moves them)
        const sales = salesAccess()
        const others = counterparties(from.partyId).filter(
            partyId => isInternal(partyId) && !sales.covers(admitted.userScope, partyId)
        )
        if (others.length)
            denied(
                "DEPENDENCY_UNAVAILABLE",
                "Party " + from.partyId + " has orders, invoices or payments you may not see and is not merged"
            )
    }
}
// Reads without the caller's entity filters (impl-sales P3 review): the guard sees every row merge#Parties will move, which it moves
// unfiltered too, so a row of an organization the caller's root filters out is neither missed by the guard nor left behind.
function unfiltered(entityName, conditions) {
    let query = ec.entity.find(entityName).disableAuthz()
    for (const [field, value] of Object.entries(conditions))
        query = Array.isArray(value) ? query.condition(field, "in", value) : query.condition(field, value)
    return query
}
const distinctOf = (entityName, conditions, field) =>
    Array.from(unfiltered(entityName, conditions).selectField(field).distinct(true).list())
        .map(row => row[field])
        .filter(Boolean)
function isInternal(partyId) {
    return !!unfiltered("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"}).one()
}
// The other parties of the party's orders (OrderPart vendor and customer), invoices and payments.
function counterparties(partyId) {
    const ids = new Set()
    for (const [entityName, mine, other] of [
        ["mantle.order.OrderPart", "customerPartyId", "vendorPartyId"],
        ["mantle.order.OrderPart", "vendorPartyId", "customerPartyId"],
        ["mantle.account.invoice.Invoice", "toPartyId", "fromPartyId"],
        ["mantle.account.invoice.Invoice", "fromPartyId", "toPartyId"],
        ["mantle.account.payment.Payment", "toPartyId", "fromPartyId"],
        ["mantle.account.payment.Payment", "fromPartyId", "toPartyId"]
    ])
        for (const id of distinctOf(entityName, {[mine]: partyId}, other)) if (id !== partyId) ids.add(id)
    return Array.from(ids)
}
// The organizations of the party's opportunities (as the account or a party of one) and agreements (as the other party or a party).
function dependencyOrganizations(partyId) {
    const ids = new Set(distinctOf("mantle.sales.opportunity.SalesOpportunity", {accountPartyId: partyId}, "organizationPartyId"))
    const opportunityIds = distinctOf("mantle.sales.opportunity.SalesOpportunityParty", {partyId}, "salesOpportunityId")
    if (opportunityIds.length)
        for (const id of distinctOf(
            "mantle.sales.opportunity.SalesOpportunity",
            {salesOpportunityId: opportunityIds},
            "organizationPartyId"
        ))
            ids.add(id)
    for (const id of distinctOf("mantle.party.agreement.Agreement", {otherPartyId: partyId}, "organizationPartyId")) ids.add(id)
    const agreementIds = distinctOf("mantle.party.agreement.AgreementParty", {partyId}, "agreementId")
    if (agreementIds.length)
        for (const id of distinctOf("mantle.party.agreement.Agreement", {agreementId: agreementIds}, "organizationPartyId"))
            ids.add(id)
    return Array.from(ids)
}

// The guard merge#Parties runs before it changes anything: throws the refusal.
function guard(toPartyId, fromPartyId) {
    const {to, from} = partiesOf(toPartyId, fromPartyId)
    const admitted = admits(to, from)
    rules(to, from, admitted)
    return {admittedBy: admitted.by}
}
// check#PartyMerge: whether the caller may merge fromPartyId into toPartyId, without failing: {allowed, admittedBy, reasonCode,
// message}.
function check(toPartyId, fromPartyId) {
    try {
        const found = guard(toPartyId, fromPartyId)
        return {allowed: true, admittedBy: found.admittedBy, reasonCode: null, message: null}
    } catch (error) {
        const reasonCode = lib.reasonCode(error)
        if (!reasonCode) throw error
        return {allowed: false, admittedBy: null, reasonCode, message: String(error.message).replace(/^[A-Z0-9_]+: /, "")}
    }
}

;({guard, check})
