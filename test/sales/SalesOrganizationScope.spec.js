// Sales' organization scope (impl-sales P1, §2; design-sales §1.1, X12): the organization filters of SalesOpportunity,
// SalesForecast and Agreement (MANTLE_USER_ORG_SOPP, _SFC, _AGR and their MANTLE_ACTIVE_ORG twins, data/MantleSetupData.xml)
// leave another organization's opportunity, forecast and agreement out of a find under an app's ordinary grant
// (MANTLE_USER_ORG), and an administrator's grant (MANTLE_ACTIVE_ORG) finds every organization's until one is active and then
// that one's only; and SalesAccess.js gives a Sales reader their own organizations, a write permission alone none, and refuses
// another organization with a reason code, but for a holder of SALES_ALL_ORGANIZATIONS, who reads every one (that permission
// alone reading nothing). Standalone: spec-local organizations, records, groups and users; the grants are
// spec-local artifact groups carrying the filter sets, as an app root's do.
// Run: ./moq test mr-mantle --spec SalesOrganizationScope
const prefix = "SOS"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
// the artifact a find runs under, authorized by the spec's grants with their filter sets
const artifact = "mantle.sales.spec.SalesOrganizationScope"
const accessModule = "component://mr-mantle/service/mantle/sales/SalesAccess.js"

function system(action) {
    login("john.doe")
    const was = ec.artifactExecution.disableAuthz()
    try {
        return action()
    } finally {
        if (!was) ec.artifactExecution.enableAuthz()
    }
}
const make = (entity, values) => call("create#" + entity, values)
function organization(partyId, name) {
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
    make("mantle.party.Organization", {partyId, organizationName: name})
    make("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
// a user, agent of the organizations, in a spec group holding the permissions and, when named, the grant
function user(kind, organizationPartyIds, permissions, grantGroupId) {
    const id = prefix + "_" + kind.toUpperCase()
    make("mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    make("mantle.party.Person", {partyId: id, firstName: "Sales scope", lastName: kind})
    for (const toPartyId of organizationPartyIds)
        make("mantle.party.PartyRelationship", {
            fromPartyId: id,
            toPartyId,
            relationshipTypeEnumId: "PrtAgent",
            toRoleTypeId: "OrgInternal",
            fromDate: 0
        })
    make("moqui.security.UserGroup", {userGroupId: id, description: "Sales scope " + kind})
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
    if (grantGroupId) make("moqui.security.UserGroupMember", {userId: id, userGroupId: grantGroupId, fromDate: 0})
    return id
}
// a grant of the spec's artifact to a group, with its type and filter set
function grant(groupId, authzTypeEnumId, entityFilterSetId) {
    make("moqui.security.UserGroup", {userGroupId: groupId, description: "Sales scope grant " + groupId})
    make("moqui.security.ArtifactAuthz", {
        artifactAuthzId: groupId,
        userGroupId: groupId,
        artifactGroupId: prefix + "_ARTIFACT",
        authzTypeEnumId,
        authzActionEnumId: "AUTHZA_ALL"
    })
    make("moqui.security.ArtifactAuthzFilter", {artifactAuthzId: groupId, entityFilterSetId})
}
const users = {}
// The ids of each Sales record kind the user finds under the spec's artifact, with authorization on and the user's
// organizations in the user context (as an app root's setup#UserOrganizationInfo puts them), the active organization set
// for the find.
function found(username, activeOrganizationPartyId = null) {
    login(username)
    ec.user.setPreference("ACTIVE_ORGANIZATION", activeOrganizationPartyId)
    const was = ec.artifactExecution.disableAuthz()
    call("mantle.party.PartyServices.setup#UserOrganizationInfo", {})
    ec.artifactExecution.enableAuthz()
    ec.artifactExecution.push(artifact, "AT_OTHER", "AUTHZA_VIEW", true)
    try {
        const ids = (entity, field) =>
            Array.from(
                ec.entity
                    .find(entity)
                    .condition(field, "like", prefix + "%")
                    .orderBy(field)
                    .list()
            ).map(row => row[field])
        return {
            opportunities: ids("mantle.sales.opportunity.SalesOpportunity", "salesOpportunityId"),
            forecasts: ids("mantle.sales.forecast.SalesForecast", "salesForecastId"),
            agreements: ids("mantle.party.agreement.Agreement", "agreementId")
        }
    } finally {
        ec.artifactExecution.pop()
        if (was) ec.artifactExecution.disableAuthz()
        else ec.artifactExecution.enableAuthz()
        ec.user.setPreference("ACTIVE_ORGANIZATION", null)
        for (const name of ["userOrgIds", "filterOrgIds", "activeOrgId"]) ec.user.context.remove(name)
        login("john.doe")
    }
}
// SalesAccess.js as the user: the scope, and the code a refusal of an organization carries ("" when it passes)
function salesScope(username, organizationPartyId) {
    login(username)
    try {
        const access = ec.resource.script(accessModule)
        const userScope = access.scope()
        let refusal = ""
        try {
            access.requireOrganization(userScope, organizationPartyId)
        } catch (error) {
            refusal = String(error.reason || error.message)
        }
        return {
            organizationPartyIds: userScope.organizationPartyIds,
            anyRead: userScope.capabilities.anyRead,
            opportunityEdit: userScope.capabilities.opportunityEdit,
            refusal
        }
    } finally {
        login("john.doe")
    }
}

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Sales scope A")
            organization(orgB, "Sales scope B")
            make("moqui.security.ArtifactGroup", {artifactGroupId: prefix + "_ARTIFACT", description: "Sales scope spec"})
            make("moqui.security.ArtifactGroupMember", {
                artifactGroupId: prefix + "_ARTIFACT",
                artifactName: artifact,
                artifactTypeEnumId: "AT_OTHER",
                nameIsPattern: "N",
                inheritAuthz: "Y"
            })
            grant(prefix + "_USER_GRANT", "AUTHZT_ALLOW", "MANTLE_USER_ORG")
            grant(prefix + "_ADMIN_GRANT", "AUTHZT_ALWAYS", "MANTLE_ACTIVE_ORG")
            users.rep = user("rep", [orgA], ["SALES_VIEW"], prefix + "_USER_GRANT")
            users.admin = user("admin", [orgA, orgB], ["SALES_VIEW", "SALES_CONFIGURE"], prefix + "_ADMIN_GRANT")
            users.editor = user("editor", [orgA], ["SALES_OPPORTUNITY_EDIT"], null)
            // every organization's reader (SALES_ALL_ORGANIZATIONS, the Sales administrator's), an agent of A alone, and the
            // permission alone, which reads nothing
            users.all = user("all", [orgA], ["SALES_VIEW", "SALES_ALL_ORGANIZATIONS"], null)
            users.allOnly = user("allonly", [orgA], ["SALES_ALL_ORGANIZATIONS"], null)
            for (const [suffix, organizationPartyId] of [
                ["A", orgA],
                ["B", orgB]
            ]) {
                make("mantle.sales.opportunity.SalesOpportunity", {
                    salesOpportunityId: prefix + "_OPP_" + suffix,
                    opportunityName: "Scope deal " + suffix,
                    organizationPartyId
                })
                make("mantle.sales.forecast.SalesForecast", {salesForecastId: prefix + "_FC_" + suffix, organizationPartyId})
                make("mantle.party.agreement.Agreement", {
                    agreementId: prefix + "_AGR_" + suffix,
                    agreementTypeEnumId: "AgrSales",
                    organizationPartyId,
                    organizationRoleTypeId: "OrgInternal"
                })
            }
        })
    }
})

feature("an ordinary grant finds its organization's opportunity, forecast and agreement and not another's", {
    when() {
        return {rep: found(users.rep)}
    },
    then({rep}) {
        JSON.stringify(rep.opportunities) == JSON.stringify([prefix + "_OPP_A"])
        JSON.stringify(rep.forecasts) == JSON.stringify([prefix + "_FC_A"])
        JSON.stringify(rep.agreements) == JSON.stringify([prefix + "_AGR_A"])
    }
})

feature("an administrator's grant finds every organization's until one is active, then the active one's only", {
    when() {
        return {all: found(users.admin), active: found(users.admin, orgB)}
    },
    then({all, active}) {
        JSON.stringify(all.opportunities) == JSON.stringify([prefix + "_OPP_A", prefix + "_OPP_B"])
        JSON.stringify(all.forecasts) == JSON.stringify([prefix + "_FC_A", prefix + "_FC_B"])
        JSON.stringify(all.agreements) == JSON.stringify([prefix + "_AGR_A", prefix + "_AGR_B"])
        JSON.stringify(active.opportunities) == JSON.stringify([prefix + "_OPP_B"])
        JSON.stringify(active.forecasts) == JSON.stringify([prefix + "_FC_B"])
        JSON.stringify(active.agreements) == JSON.stringify([prefix + "_AGR_B"])
    }
})

feature(
    "SalesAccess gives a reader their organizations and refuses another's, an every-organization reader every one; a write permission alone reads none",
    {
        when() {
            return {
                rep: salesScope(users.rep, orgB),
                repOwn: salesScope(users.rep, orgA),
                editor: salesScope(users.editor, orgA),
                all: salesScope(users.all, orgB),
                allOnly: salesScope(users.allOnly, orgB)
            }
        },
        then({rep, repOwn, editor, all, allOnly}) {
            rep.anyRead == true
            JSON.stringify(rep.organizationPartyIds) == JSON.stringify([orgA])
            rep.refusal.includes("ORGANIZATION_DENIED")
            repOwn.refusal == ""
            editor.opportunityEdit == true
            editor.anyRead == false
            editor.organizationPartyIds.length == 0
            editor.refusal.includes("ORGANIZATION_DENIED")
            // the user's call (impl-sales P1 review): every organization for a holder, B among them without membership
            all.organizationPartyIds == null
            all.refusal == ""
            allOnly.anyRead == false
            allOnly.organizationPartyIds.length == 0
            allOnly.refusal.includes("ORGANIZATION_DENIED")
        }
    }
)
