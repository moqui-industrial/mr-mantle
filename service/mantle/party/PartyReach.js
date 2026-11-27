// Whom a user reaches as people to message, call, mention or look up (mantle.party.PartyServices filter#VisibleParties;
// plans/archive/Security-Review-Medium.md SEC-BOS-98, SEC-BOS-99, SEC-BOS-100, the owner's decisions of 2026-11-19).
// visibleParties(partyIdList, includeDisabled): of the parties, those read with authorization on under the caller's own
// entity filters (not another user's personal contact, not disabled unless includeDisabled), and a person working for an
// internal organization (or a unit whose PrtOrgRollup root is one) only when one of those organizations is one the user may
// see or shares its top-level organization with one the user works for or their filter names. A script, so a caller in a
// frame of its own (a shell provider run as its app) asks it under that frame's filters, with no service to authorize.
// CC0 plus patent grant.
function visibleParties(partyIdList, includeDisabled) {
    const cf = ec.entity.conditionFactory
    const ids = Array.from(
        new Set(
            Array.from(partyIdList || [])
                .map(id => String(id || ""))
                .filter(id => id)
        )
    )
    if (!ids.length) return []
    if (ec.artifactExecution.authzDisabled()) {
        const exists = new Set(
            Array.from(ec.entity.find("mantle.party.Party").condition("partyId", "in", ids).selectField("partyId").list()).map(
                row => row.partyId
            )
        )
        return ids.filter(id => exists.has(id))
    }
    if (!ec.user.userId) return []
    const visible = cf.makeCondition(
        [
            cf.makeCondition("privateOwnerUserId", "equals", null),
            cf.makeCondition("privateOwnerUserId", "equals", ec.user.userId)
        ],
        "or"
    )
    // with authorization on: the calling app's filters
    let find = ec.entity
        .find("mantle.party.PartyDetail")
        .condition("partyId", "in", ids)
        .condition(visible)
        .selectField("partyId")
    if (!includeDisabled) find = find.condition(cf.makeCondition("disabled", "not-equals", "Y", true))
    const seen = new Set(Array.from(find.list()).map(row => row.partyId))
    if (!seen.size) return []
    // a user with no party and no filter organization belongs to no organization (a system or service account, a
    // framework-only user): no organization's staff is kept from them by employment, as no organization is kept from a
    // person with no party; what they read is still their filters' alone
    if (!ec.user.userAccount?.partyId && !Array.from(ec.user.context.filterOrgIds || []).length)
        return ids.filter(id => seen.has(id))
    // the organizations each works for, read with no authorization (a relationship is no record the user reads here), each
    // with its top-level organization (its PrtOrgRollup root): a party is staff when one of them, or its root, is internal
    const orgsOf = {}
    const rootOf = {}
    let userRoots = new Set()
    const me = ec.user.userAccount?.partyId || null
    const employersOf = partyIds =>
        Array.from(
            ec.entity
                .find("mantle.party.PartyRelationship")
                .condition("fromPartyId", "in", partyIds)
                .condition("relationshipTypeEnumId", "in", ["PrtAgent", "PrtEmployee", "PrtMember"])
                .conditionDate("fromDate", "thruDate", null)
                .selectField("fromPartyId")
                .selectField("toPartyId")
                .disableAuthz()
                .list()
        )
    const relationships = employersOf(Array.from(seen))
    const mine = me ? employersOf([me]).map(row => row.toPartyId) : []
    // the root of an organization: up its current PrtOrgRollup parents (child to parent), at most ten levels
    const root = orgId => {
        if (orgId in rootOf) return rootOf[orgId]
        let at = orgId
        for (let depth = 0; depth < 10; depth++) {
            const parent = Array.from(
                ec.entity
                    .find("mantle.party.PartyRelationship")
                    .condition("fromPartyId", at)
                    .condition("relationshipTypeEnumId", "PrtOrgRollup")
                    .conditionDate("fromDate", "thruDate", null)
                    .selectField("toPartyId")
                    .disableAuthz()
                    .list()
            )[0]?.toPartyId
            if (!parent || parent === at) break
            at = parent
        }
        rootOf[orgId] = at
        return at
    }
    const targets = Array.from(new Set(relationships.map(row => row.toPartyId)))
    const candidates = Array.from(new Set(targets.concat(targets.map(root))))
    const internal = new Set(
        candidates.length
            ? Array.from(
                  ec.entity
                      .find("mantle.party.PartyRole")
                      .condition("partyId", "in", candidates)
                      .condition("roleTypeId", "OrgInternal")
                      .selectField("partyId")
                      .disableAuthz()
                      .list()
              ).map(row => row.partyId)
            : []
    )
    for (const row of relationships)
        if (internal.has(row.toPartyId) || internal.has(root(row.toPartyId)))
            (orgsOf[row.fromPartyId] || (orgsOf[row.fromPartyId] = [])).push(row.toPartyId)
    // the user's own top-level organizations: of what they work for, departments too, and their filter's organizations.
    // Reaching staff only (the owner's decision, 2026-11-19): departments, their parent and siblings reach each other;
    // what the user reads is still their filters' alone.
    userRoots = new Set(mine.concat(Array.from(ec.user.context.filterOrgIds || [])).map(root))
    const organizations = Array.from(new Set(Object.values(orgsOf).flat()))
    // the organizations the user may see, under the same filters, or of one of the user's top-level organizations
    const seenOrganizations = new Set(
        organizations.length
            ? Array.from(
                  ec.entity
                      .find("mantle.party.PartyDetail")
                      .condition("partyId", "in", organizations)
                      .selectField("partyId")
                      .list()
              ).map(row => row.partyId)
            : []
    )
    const reached = org => seenOrganizations.has(org) || userRoots.has(rootOf[org] ?? org)
    return ids.filter(id => seen.has(id) && (!orgsOf[id] || orgsOf[id].some(reached)))
}

;({visibleParties})
