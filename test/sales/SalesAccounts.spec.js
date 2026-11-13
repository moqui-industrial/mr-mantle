// Sales' accounts and contacts (impl-sales P3; design-sales §4; mantle/sales/SalesAccounts.js, SalesAccess.js) and the merge guards
// (mantle/party/PartyMerge.js, merge#Parties; X15, impl-sales §4 F45): an account is created in an organization of the caller's
// sales scope only, with the edit permission, never anonymously and never under another organization's parent; ending a contact
// keeps the person, and another organization's representative is refused it; the account reads answer the caller's organization
// and the shared accounts; a merge across organizations is refused for anyone, a representative is refused one, a Sales manager's
// merge of two accounts of their organization moves an opportunity's account, and a merged party's opportunity of another
// organization refuses the merge. Standalone: spec-local organizations, groups, users and records; the users' services run with
// artifact authorization on under a spec grant of the sales and duplicate services, as an app root's grant gives them.
// Run: ./moq test mr-mantle --spec SalesAccounts
const prefix = "SAC"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const accounts = "mantle.sales.AccountServices."
const workspace = "mantle.sales.SalesWorkspaceServices."
const duplicates = "mantle.party.DuplicateServices."
const users = {}

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
const one = (entity, values) => ec.entity.find(entity).condition(values).disableAuthz().one()
function organization(partyId, name) {
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    make("mantle.party.Organization", {partyId, organizationName: name})
    make("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
// a user, agent of the organizations, in a spec group holding the permissions and the spec's service grant
function user(kind, organizationPartyIds, permissions) {
    const id = prefix + "_" + kind.toUpperCase()
    make("mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    make("mantle.party.Person", {partyId: id, firstName: "Accounts", lastName: kind})
    for (const toPartyId of organizationPartyIds)
        make("mantle.party.PartyRelationship", {
            fromPartyId: id,
            toPartyId,
            relationshipTypeEnumId: "PrtAgent",
            toRoleTypeId: "OrgInternal",
            fromDate: 0
        })
    make("moqui.security.UserGroup", {userGroupId: id, description: "Sales accounts " + kind})
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
    make("moqui.security.UserGroupMember", {userId: id, userGroupId: prefix + "_GRANT", fromDate: 0})
    return id
}
// an account of an organization, made directly (as demo data would), with its roles
function account(id, name, ownerPartyId) {
    make("mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyOrganization", ownerPartyId})
    make("mantle.party.Organization", {partyId: id, organizationName: name})
    make("mantle.party.PartyRole", {partyId: id, roleTypeId: "Account"})
    make("mantle.party.PartyRole", {partyId: id, roleTypeId: "Customer"})
    return id
}
// action as the user with artifact authorization on, then john.doe again
function as(username, action) {
    login(username)
    const was = ec.artifactExecution.authzDisabled()
    ec.artifactExecution.enableAuthz()
    try {
        return action()
    } finally {
        ec.message.clearErrors()
        if (was) ec.artifactExecution.disableAuthz()
        login("john.doe")
    }
}
// the message a call is refused with, or "" when it succeeds (a negative case uses the parameters of a positive one)
function refusal(service, parameters) {
    ec.message.pushErrors()
    try {
        ec.service.sync().name(service).parameters(parameters).requireNewTransaction(true).call()
        return ec.message.hasError() ? ec.message.getErrorsString() : ""
    } catch (error) {
        return String(error.message)
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}
const ids = list => Array.from(list || []).map(row => row.partyId)

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Accounts A")
            organization(orgB, "Accounts B")
            make("moqui.security.UserGroup", {userGroupId: prefix + "_GRANT", description: "Sales accounts spec grant"})
            make("moqui.security.ArtifactGroup", {
                artifactGroupId: prefix + "_SERVICES",
                description: "Sales accounts spec services"
            })
            for (const artifactName of ["mantle\\.sales\\..*", "mantle\\.party\\.DuplicateServices\\..*"])
                make("moqui.security.ArtifactGroupMember", {
                    artifactGroupId: prefix + "_SERVICES",
                    artifactName,
                    artifactTypeEnumId: "AT_SERVICE",
                    nameIsPattern: "Y",
                    inheritAuthz: "Y"
                })
            make("moqui.security.ArtifactAuthz", {
                artifactAuthzId: prefix + "_GRANT",
                userGroupId: prefix + "_GRANT",
                artifactGroupId: prefix + "_SERVICES",
                authzTypeEnumId: "AUTHZT_ALLOW",
                authzActionEnumId: "AUTHZA_ALL"
            })
            users.rep = user("rep", [orgA], ["SALES_VIEW", "SALES_ACCOUNT_EDIT"])
            users.viewer = user("viewer", [orgA], ["SALES_VIEW"])
            users.repB = user("repb", [orgB], ["SALES_VIEW", "SALES_ACCOUNT_EDIT"])
            users.manager = user("manager", [orgA], ["SALES_VIEW", "SALES_TEAM_VIEW", "SALES_ACCOUNT_EDIT", "SALES_TEAM_MANAGE"])
            account(prefix + "_PARENT_B", "Parent of B", orgB)
            account(prefix + "_ACC_B", "Account of B", orgB)
            account(prefix + "_SHARED", "Shared account", "_NA_")
        })
    }
})

feature(
    "an account is created in the caller's organization with its roles and manager; edit permission and organization required",
    {
        when() {
            const parameters = {organizationPartyId: orgA, organizationName: "New account A", emailAddress: "buyer@sac-a.example"}
            const created = as(users.rep, () => call(accounts + "create#Account", parameters).partyId)
            const party = one("mantle.party.Party", {partyId: created})
            const roles = Array.from(
                ec.entity.find("mantle.party.PartyRole").condition("partyId", created).disableAuthz().list()
            ).map(row => row.roleTypeId)
            const manager = one("mantle.party.PartyRelationship", {
                toPartyId: created,
                relationshipTypeEnumId: "PrtAccountManager"
            })
            return {
                party,
                roles,
                manager,
                viewer: as(users.viewer, () => refusal(accounts + "create#Account", parameters)),
                otherOrganization: as(users.repB, () => refusal(accounts + "create#Account", parameters)),
                ownOrganization: as(users.repB, () =>
                    refusal(accounts + "create#Account", Object.assign({}, parameters, {organizationPartyId: orgB}))
                )
            }
        },
        then({party, roles, manager, viewer, otherOrganization, ownOrganization}) {
            party.ownerPartyId == orgA
            roles.includes("Account") && roles.includes("Customer")
            manager.fromPartyId == users.rep
            viewer.includes("PERMISSION_DENIED")
            otherOrganization.includes("ORGANIZATION_DENIED")
            ownOrganization == ""
        }
    }
)

feature("an anonymous call is refused", {
    when() {
        logout()
        const anonymous = refusal(accounts + "create#Account", {organizationPartyId: orgA, organizationName: "Anonymous account"})
        login("john.doe")
        return {
            anonymous,
            made: ec.entity
                .find("mantle.party.Organization")
                .condition("organizationName", "Anonymous account")
                .disableAuthz()
                .count()
        }
    },
    then({anonymous, made}) {
        anonymous != ""
        made == 0
    }
})

feature("another organization's parent is refused, an own organization's or shared one taken", {
    when() {
        const parameters = parentAccountPartyId => ({
            organizationPartyId: orgA,
            organizationName: "Child of " + parentAccountPartyId,
            parentAccountPartyId
        })
        return as(users.rep, () => ({
            other: refusal(accounts + "create#Account", parameters(prefix + "_PARENT_B")),
            shared: refusal(accounts + "create#Account", parameters(prefix + "_SHARED"))
        }))
    },
    then({other, shared}) {
        other.includes("RECORD_UNAVAILABLE")
        shared == ""
    }
})

feature("a contact's relationship is ended and the person kept; another organization's representative is refused it", {
    when() {
        const accountId = system(() => account(prefix + "_ACC_CONTACT", "Account with contact", orgA))
        const contactId = as(
            users.rep,
            () =>
                call(accounts + "create#Contact", {
                    accountPartyId: accountId,
                    firstName: "Casey",
                    lastName: "Contact",
                    relationshipName: "Buyer"
                }).partyId
        )
        const relationship = one("mantle.party.PartyRelationship", {
            fromPartyId: contactId,
            toPartyId: accountId,
            relationshipTypeEnumId: "PrtContact"
        })
        const listed = as(users.rep, () => ids(call(workspace + "find#AccountContacts", {accountPartyId: accountId}).contactList))
        const otherRep = as(users.repB, () =>
            refusal(accounts + "delete#Contact", {partyRelationshipId: relationship.partyRelationshipId})
        )
        const ended = as(users.rep, () =>
            refusal(accounts + "delete#Contact", {partyRelationshipId: relationship.partyRelationshipId})
        )
        const after = as(users.rep, () => ids(call(workspace + "find#AccountContacts", {accountPartyId: accountId}).contactList))
        return {
            contactId,
            owner: one("mantle.party.Party", {partyId: contactId}).ownerPartyId,
            listed,
            otherRep,
            ended,
            after,
            thruDate: one("mantle.party.PartyRelationship", {partyRelationshipId: relationship.partyRelationshipId}).thruDate,
            person: one("mantle.party.Party", {partyId: contactId})
        }
    },
    then({contactId, owner, listed, otherRep, ended, after, thruDate, person}) {
        owner == orgA
        listed.includes(contactId)
        otherRep.includes("RECORD_UNAVAILABLE")
        ended == ""
        !after.includes(contactId)
        thruDate != null
        person != null && person.disabled != "Y"
    }
})

feature("the account reads answer the caller's organization and the shared accounts, another organization's as missing", {
    when() {
        return as(users.rep, () => {
            const found = ids(call(workspace + "find#Accounts", {text: "Account", pageSize: 100}).accountList)
            return {
                found,
                own: call(workspace + "get#CustomerSales", {customerPartyId: prefix + "_ACC_CONTACT"}),
                other: call(workspace + "get#CustomerSales", {customerPartyId: prefix + "_ACC_B"}),
                otherOrganization: refusal(workspace + "find#Accounts", {organizationPartyId: orgB})
            }
        })
    },
    then({found, own, other, otherOrganization}) {
        found.includes(prefix + "_ACC_CONTACT")
        found.includes(prefix + "_SHARED")
        !found.includes(prefix + "_ACC_B")
        own.customerFound == true
        own.customerDetail.contacts.length == 0
        own.customerDetail.ordersRead == false
        other.customerFound == false
        otherOrganization.includes("ORGANIZATION_DENIED")
    }
})

feature(
    "merges: across organizations refused for anyone, a representative refused, a manager's moves the opportunity, another organization's dependency refused",
    {
        when() {
            const ids = system(() => {
                const keep = account(prefix + "_MERGE_KEEP", "Merge Keep", orgA)
                const gone = account(prefix + "_MERGE_GONE", "Merge Keep Inc", orgA)
                const crossed = account(prefix + "_MERGE_CROSSED", "Merge Crossed", orgA)
                make("mantle.sales.opportunity.SalesOpportunity", {
                    salesOpportunityId: prefix + "_OPP_GONE",
                    opportunityName: "Gone's deal",
                    accountPartyId: gone,
                    organizationPartyId: orgA
                })
                make("mantle.sales.opportunity.SalesOpportunity", {
                    salesOpportunityId: prefix + "_OPP_CROSSED",
                    opportunityName: "Crossed deal",
                    accountPartyId: crossed,
                    organizationPartyId: orgB
                })
                return {keep, gone, crossed}
            })
            const pair = {toPartyId: ids.keep, fromPartyId: ids.gone}
            const acrossOrganizations = system(() =>
                refusal(duplicates + "merge#Parties", {toPartyId: ids.keep, fromPartyId: prefix + "_ACC_B"})
            )
            const representative = as(users.rep, () => refusal(duplicates + "merge#Parties", pair))
            const checked = as(users.manager, () => call(duplicates + "check#PartyMerge", pair))
            const manager = as(users.manager, () => refusal(duplicates + "merge#Parties", pair))
            const dependency = as(users.manager, () =>
                refusal(duplicates + "merge#Parties", {toPartyId: ids.keep, fromPartyId: ids.crossed})
            )
            return {
                acrossOrganizations,
                representative,
                checked,
                manager,
                dependency,
                gone: one("mantle.party.Party", {partyId: ids.gone}),
                crossed: one("mantle.party.Party", {partyId: ids.crossed}),
                opportunity: one("mantle.sales.opportunity.SalesOpportunity", {salesOpportunityId: prefix + "_OPP_GONE"})
            }
        },
        then({acrossOrganizations, representative, checked, manager, dependency, gone, crossed, opportunity}) {
            acrossOrganizations.includes("ORGANIZATION_MISMATCH")
            representative.includes("PERMISSION_DENIED")
            checked.allowed == true && checked.admittedBy == "sales"
            manager == ""
            gone.mergedToPartyId == prefix + "_MERGE_KEEP"
            opportunity.accountPartyId == prefix + "_MERGE_KEEP"
            dependency.includes("DEPENDENCY_OTHER_ORGANIZATION")
            crossed.mergedToPartyId == null
        }
    }
)
