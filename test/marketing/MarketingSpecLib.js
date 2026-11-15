// The Marketing specs' shared helpers (impl-marketing P2 onward): rows made as the system, internal organizations, users who are
// agents of organizations in a spec group holding the permissions named, a service called as a user (authorization off: the
// service's own rule) answering its result or its refusal, and a campaign made the way an author makes one. Each spec has its own
// prefix, so the specs do not share records. The operator is john.doe.
const OPERATOR = "john.doe"
const entityLib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const run = (name, parameters) => {
    const out = ec.service.sync().name(name).parameters(parameters).disableAuthz().call() || {}
    if (ec.message.hasError()) {
        const text = ec.message.getErrorsString()
        ec.message.clearErrors()
        throw new Error(text)
    }
    return out
}
const make = (entity, values) => run("create#" + entity, values)
const row = (entity, fields) => ec.entity.find(entity).condition(fields).disableAuthz().one()
const rows = (entity, fields) => Array.from(ec.entity.find(entity).condition(fields).disableAuthz().list())
function system(action) {
    login(OPERATOR)
    const was = ec.artifactExecution.disableAuthz()
    try {
        return action()
    } finally {
        if (!was) ec.artifactExecution.enableAuthz()
    }
}
function organization(partyId, name) {
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
    make("mantle.party.Organization", {partyId, organizationName: name})
    make("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
// A user (its userId and partyId: prefix_KIND), agent of the organizations, in a spec group holding the permissions.
function user(prefix, kind, organizationPartyIds, permissions) {
    const id = prefix + "_" + kind.toUpperCase()
    make("mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    make("mantle.party.Person", {partyId: id, firstName: "Marketing spec", lastName: kind})
    for (const toPartyId of organizationPartyIds)
        make("mantle.party.PartyRelationship", {
            fromPartyId: id,
            toPartyId,
            relationshipTypeEnumId: "PrtAgent",
            toRoleTypeId: "OrgInternal",
            fromDate: 0
        })
    make("moqui.security.UserGroup", {userGroupId: id, description: "Marketing spec " + kind})
    for (const userPermissionId of permissions)
        make("moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId, fromDate: 0})
    make("moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId: id,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA"
    })
    make("moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: 0})
    return id
}
// A service as the user, authorization off (the service's own rule, not a grant): its result with refusal "", or {refusal} with
// the error text, so a negative case checks the code and a positive case with the same parameters gets "".
function as(username, name, parameters = {}) {
    login(username)
    const was = ec.artifactExecution.disableAuthz()
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(name).parameters(parameters).call() || {}
        return ec.message.hasError() ? {refusal: ec.message.getErrorsString()} : Object.assign({refusal: ""}, out)
    } catch (error) {
        return {refusal: String(error.message)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        if (!was) ec.artifactExecution.enableAuthz()
        login(OPERATOR)
    }
}
const C = "mantle.marketing.CampaignServices."
// The campaign's revision for a write (its lastUpdatedStamp in millis) and its approval revision.
const revisionOf = marketingCampaignId => {
    const found = row("mantle.marketing.campaign.MarketingCampaign", {marketingCampaignId})
    return {
        expectedRevision: entityLib.ms(found.lastUpdatedStamp),
        targetRevision: Number(found.campaignRevision || 1),
        row: found
    }
}
// A campaign as an author makes one, ready for approval (dates, a currency, the author its manager); fields override.
function campaign(username, organizationPartyId, fields = {}) {
    const out = as(
        username,
        C + "create#Campaign",
        Object.assign(
            {
                organizationPartyId,
                campaignName: "Spec campaign",
                fromDate: new Date(Date.now() + 86400000),
                thruDate: new Date(Date.now() + 30 * 86400000),
                costUomId: "USD",
                budgetedCost: "1000"
            },
            fields
        )
    )
    if (out.refusal) throw new Error("campaign: " + out.refusal)
    return out.marketingCampaignId
}

;({OPERATOR, run, make, row, rows, system, organization, user, as, C, revisionOf, campaign})
