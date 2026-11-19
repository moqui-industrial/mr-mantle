// What limits a search of the mantle index for the user, shared by the universal search (UniversalSearchServices.xml
// search#Universal) and Marble's general search (GeneralServices.xml search#MantleFiltered): the organization fields of each
// document type, the user's organization limit, and the clauses that show a type's records under it. CC0 plus patent grant.

// what shows a record of each document type under an organization limit: org fields holding one of the user's
// organizations, user fields holding the user's party, and party fields holding either; a type that is not here
// shows nothing, and null is not limited
// TODO: only current party rows (parties.partyThruDate empty or later than now) once the Postgres backend can
//     compare a date in a child list (it casts the stored text, which the feed writes as epoch millis)
const scopes = {
    MantleParty: {org: ["ownerPartyId"]},
    MantleProduct: {org: ["ownerPartyId"]},
    MantleFacility: {org: ["ownerPartyId"]},
    MantleAsset: {org: ["ownerPartyId"]},
    MantleOrder: {org: ["parts.vendorPartyId", "parts.customerPartyId"]},
    MantleInvoice: {org: ["fromPartyId", "toPartyId"]},
    MantlePayment: {org: ["fromPartyId", "toPartyId"]},
    MantleAcctgTrans: {org: ["organizationPartyId"]},
    MantleGlAccount: {org: ["organizationPartyIds"]},
    MantleShipment: {org: ["fromPartyId", "toPartyId"]},
    MantleProject: {party: ["ownerPartyId", "parties.partyId"]},
    MantleTask: {party: ["ownerPartyId", "parties.partyId"]},
    MantleEvent: {party: ["ownerPartyId", "parties.partyId"]},
    MantleRequest: {org: ["storeOrganizationPartyId", "facilityOwnerPartyId"], user: ["filedByPartyId"], party: ["parties.partyId"]},
    MantleCommunicationEvent: {user: ["fromPartyId", "toPartyId", "parties.partyId"]},
    MantleWikiPage: null
}
// a type's scope: its row of the table, {} (shows nothing under a limit) for a type not in it
const scopeOf = type => (Object.prototype.hasOwnProperty.call(scopes, type) ? scopes[type] : {})

// the user's organization limit, as get#RecordLinkInfo has it: every filter set on a party find is looked at (an
// authorization may carry MANTLE_PRIVATE_CONTACT and others beside the organization set); the organizations, or null for
// none
function organizationLimit() {
    if (ec.user.context.filterOrgIds === undefined)
        ec.service.sync().name("mantle.party.PartyServices.setup#UserOrganizationInfo").call()
    const filterSetIds = () =>
        new Set(Array.from(ec.artifactExecution.getFindFiltersForUser("mantle.party.Party") || []).map(filter => filter.entityFilterSetId))
    const activeOrgId = ec.user.context.activeOrgId || null
    const filterOrgIds = Array.from(ec.user.context.filterOrgIds || [])
    let filterSets = filterSetIds()
    if (filterSets.has("MANTLE_USER_ORG")) return filterOrgIds
    if (filterSets.has("MANTLE_ACTIVE_ORG")) return activeOrgId ? [activeOrgId] : filterOrgIds
    if (activeOrgId) return null
    // MANTLE_ACTIVE_ORG applies only with an active organization (its applyCond): whether the authorization names it is
    // asked with one in the user context for the moment
    const hadActive = "activeOrgId" in ec.user.context
    const oldActive = ec.user.context.activeOrgId
    ec.user.context.activeOrgId = "_NA_"
    try {
        filterSets = filterSetIds()
    } finally {
        if (hadActive) ec.user.context.activeOrgId = oldActive ?? null
        else delete ec.user.context.activeOrgId
    }
    return filterSets.has("MANTLE_ACTIVE_ORG") ? filterOrgIds : null
}

// the clauses that show a type's records under the limit, any one of them; none leaves the type out. extraClauses: more
// alternatives the caller has (the mailboxes the user reads, for a communication event)
function scopeClauses(type, scope, orgIds, userPartyId, extraClauses = []) {
    const orgValues = type === "MantleParty" ? orgIds.concat(["_NA_"]) : orgIds
    const partyValues = userPartyId ? orgIds.concat([userPartyId]) : orgIds
    const any = []
    if (orgValues.length) for (const name of scope.org || []) any.push({field: {name, op: "in", values: orgValues}})
    if (userPartyId) for (const name of scope.user || []) any.push({field: {name, op: "eq", value: userPartyId}})
    if (partyValues.length) for (const name of scope.party || []) any.push({field: {name, op: "in", values: partyValues}})
    return any.concat(extraClauses)
}

// a party that is a personal contact (privateOwnerUserId) only for its owner, with or without a limit
function privateClause() {
    const notPrivate = {field: {name: "privateOwnerUserId", op: "exists", negate: true}}
    return ec.user.userId
        ? {bool: {any: [notPrivate, {field: {name: "privateOwnerUserId", op: "eq", value: ec.user.userId}}]}}
        : notPrivate
}

;({scopes, scopeOf, organizationLimit, scopeClauses, privateClause})
