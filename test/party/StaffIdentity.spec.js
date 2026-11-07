// Organization-scoped staff identity (service/mantle/party/IdentityServices.xml; mr-boss impl-admin P4, design-admin §4.1):
// an identity operator of one internal organization finds its staff and not another organization's only staff; an
// account-wide change of an identity shared with an organization the operator does not administer is refused without
// ADMIN_IDENTITY_GLOBAL, while a reset request is sent; a reset mails reset#Password and sets no password; an organization
// membership is dated and ended, never deleted; and a staff account comes with its organization relationship and the grant
// proposal's registered bundles, an unregistered group refused with nothing written. Scope is the organization entity filters
// of the authorization (impl-admin §4, the P4 follow-up): the operators call under the services' ALL_USERS grant
// (MANTLE_USER_ORG), the chief under a spec grant naming MANTLE_ACTIVE_ORG (every organization with none active, F65), and an
// account's notes follow the same filters (F75). The operators hold the framework's ADMIN_IDENTITY_* permissions through spec
// groups, never an app group. New spec, no Groovy original.
// Run: ./moq test mr-mantle --spec party/StaffIdentity
const S = "mantle.party.IdentityServices."
const dayMillis = 86400000
const effectiveTime = Date.now()
const users = {}
const parties = {}
let orgId
let otherOrgId

function result(name, params) {
    try {
        const out =
            ec.service
                .sync()
                .name(name)
                .parameters(params || {})
                .call() || {}
        const error = ec.message.hasError() ? ec.message.getErrorsString() : ""
        ec.message.clearErrors()
        return Object.assign({}, out, {error})
    } catch (e) {
        ec.message.clearErrors()
        return {error: String(e.message)}
    }
}
// as username with artifact authorization on, as a screen calls the services
function as(username, run) {
    login(username, "moqui1!!")
    ec.artifactExecution.enableAuthz()
    try {
        return run()
    } finally {
        ec.artifactExecution.disableAuthz()
        login("john.doe")
    }
}
const rows = (entityName, conditions) => Array.from(ec.entity.find(entityName).condition(conditions).disableAuthz().list())

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.artifactExecution.enableAuthz()
        login("john.doe")
    }
})

feature("two internal organizations, an operator of one, staff of each and an identity working for both", {
    when() {
        orgId = call("mantle.party.PartyServices.create#Organization", {
            organizationName: "Staff One Co",
            roleTypeId: "OrgInternal"
        }).partyId
        otherOrgId = call("mantle.party.PartyServices.create#Organization", {
            organizationName: "Staff Two Co",
            roleTypeId: "OrgInternal"
        }).partyId
        call("create#moqui.security.UserGroup", {userGroupId: "SID_OPERATORS", description: "Spec identity operators"})
        call("create#moqui.security.UserGroup", {userGroupId: "SID_GLOBAL", description: "Spec identity global"})
        for (const permission of ["ADMIN_IDENTITY_VIEW", "ADMIN_IDENTITY_MANAGE"])
            call("create#moqui.security.UserGroupPermission", {
                userGroupId: "SID_OPERATORS",
                userPermissionId: permission,
                fromDate: effectiveTime - dayMillis
            })
        call("create#moqui.security.UserGroupPermission", {
            userGroupId: "SID_GLOBAL",
            userPermissionId: "ADMIN_IDENTITY_GLOBAL",
            fromDate: effectiveTime - dayMillis
        })
        // a registered bundle (the capability registry) an app would supply, and a group that is not one
        call("create#moqui.security.UserGroup", {userGroupId: "SID_BUNDLE", description: "Spec staff bundle"})
        call("create#moqui.security.CapabilityBundle", {
            userGroupId: "SID_BUNDLE",
            appName: "Spec",
            description: "Spec staff bundle"
        })
        call("create#moqui.security.UserGroup", {userGroupId: "SID_UNREGISTERED", description: "Spec unregistered"})
        const person = (key, username, orgs) => {
            parties[key] = call("mantle.party.PartyServices.create#Person", {firstName: key, lastName: "Staff"}).partyId
            users[key] = call("mantle.party.PartyServices.create#PartyUserAccount", {
                partyId: parties[key],
                emailAddress: username + "@example.com",
                username,
                newPassword: "moqui1!!",
                newPasswordVerify: "moqui1!!"
            }).userId
            for (const org of orgs)
                call("create#mantle.party.PartyRelationship", {
                    relationshipTypeEnumId: "PrtEmployee",
                    fromPartyId: parties[key],
                    toPartyId: org,
                    toRoleTypeId: "OrgInternal",
                    fromDate: effectiveTime - dayMillis
                })
        }
        // the chief's grant names MANTLE_ACTIVE_ORG, as an administrator's app root does; ALWAYS, so it is the one the
        // services run under rather than their ALL_USERS grant; the notes grant names MANTLE_USER_ORG, as an app's groups do
        call("create#moqui.security.UserGroup", {userGroupId: "SID_CHIEFS", description: "Spec identity chiefs"})
        call("create#moqui.security.UserGroup", {userGroupId: "SID_NOTES", description: "Spec record notes"})
        call("create#moqui.security.ArtifactGroup", {artifactGroupId: "SID_IDENTITY", description: "Spec identity services"})
        call("create#moqui.security.ArtifactGroupMember", {
            artifactGroupId: "SID_IDENTITY",
            artifactTypeEnumId: "AT_SERVICE",
            artifactName: "mantle\\.party\\.IdentityServices\\..*",
            nameIsPattern: "Y",
            inheritAuthz: "Y"
        })
        call("create#moqui.security.ArtifactGroup", {artifactGroupId: "SID_NOTES", description: "Spec record notes"})
        call("create#moqui.security.ArtifactGroupMember", {
            artifactGroupId: "SID_NOTES",
            artifactTypeEnumId: "AT_SERVICE",
            artifactName: "mantle.party.CommunicationServices.get#RecordLinkInfo",
            nameIsPattern: "N",
            inheritAuthz: "Y"
        })
        for (const [authzId, groupId, artifactGroupId, type, filterSetId] of [
            ["SID_CHIEFS", "SID_CHIEFS", "SID_IDENTITY", "AUTHZT_ALWAYS", "MANTLE_ACTIVE_ORG"],
            ["SID_NOTES", "SID_NOTES", "SID_NOTES", "AUTHZT_ALLOW", "MANTLE_USER_ORG"]
        ]) {
            call("create#moqui.security.ArtifactAuthz", {
                artifactAuthzId: authzId,
                userGroupId: groupId,
                artifactGroupId,
                authzTypeEnumId: type,
                authzActionEnumId: "AUTHZA_ALL"
            })
            call("create#moqui.security.ArtifactAuthzFilter", {artifactAuthzId: authzId, entityFilterSetId: filterSetId})
        }
        person("Operator", "sid.operator", [orgId])
        person("Chief", "sid.chief", [orgId])
        person("Global", "sid.global", [orgId])
        person("One", "sid.one", [orgId])
        person("Two", "sid.two", [otherOrgId])
        person("Both", "sid.both", [orgId, otherOrgId])
        for (const [groupId, keys] of [
            ["SID_OPERATORS", ["Operator", "Global", "Chief"]],
            ["SID_CHIEFS", ["Chief"]],
            ["SID_NOTES", ["Operator", "Two"]]
        ])
            for (const key of keys)
                call("create#moqui.security.UserGroupMember", {
                    userGroupId: groupId,
                    userId: users[key],
                    fromDate: effectiveTime - dayMillis
                })
        call("create#moqui.security.UserGroupMember", {
            userGroupId: "SID_GLOBAL",
            userId: users.Global,
            fromDate: effectiveTime - dayMillis
        })
        call("create#moqui.security.UserAuthcFactor", {
            factorId: "SID_FACTOR",
            userId: users.Both,
            factorTypeEnumId: "UafTotp",
            fromDate: effectiveTime - dayMillis,
            needsValidation: "N"
        })
    },
    then() {
        orgId && otherOrgId && users.Operator && users.Both
    }
})

feature("an operator finds its organization's staff, not another organization's, and is refused that one's account", {
    when() {
        return as("sid.operator", () => ({
            found: result(S + "find#Users", {text: "sid."}),
            other: result(S + "get#Account", {userId: users.Two}),
            shared: result(S + "get#Account", {userId: users.Both}),
            otherOrganization: result(S + "find#Users", {organizationPartyId: otherOrgId})
        }))
    },
    then({found, other, shared, otherOrganization}) {
        const ids = found.userList.map(row => row.userId)
        ids.includes(users.One) && ids.includes(users.Both) && !ids.includes(users.Two)
        found.userList.find(row => row.userId == users.Both).organizations == "Staff One Co"
        found.userList.find(row => row.userId == users.Both).otherOrganizationCount == 1
        other.error.includes("RECORD_UNAVAILABLE")
        shared.error == "" && shared.sharedBeyondScope == true && shared.canChangeAccount == false
        // the other organization is not named, and its factor is metadata only
        shared.organizations.length == 1 && shared.organizations[0].partyId == orgId
        shared.factorList.some(row => row.factorId == "SID_FACTOR") && !JSON.stringify(shared).includes("factorOption")
        otherOrganization.error.includes("RECORD_UNAVAILABLE")
    }
})

feature(
    "an authorization naming MANTLE_ACTIVE_ORG sees every organization's staff with none active, the active one's with one (F65)",
    {
        when() {
            return as("sid.chief", () => {
                const none = {
                    found: result(S + "find#Users", {text: "sid."}),
                    shared: result(S + "get#Account", {userId: users.Both})
                }
                ec.user.setPreference("ACTIVE_ORGANIZATION", orgId)
                try {
                    return {
                        none,
                        active: result(S + "find#Users", {text: "sid."}),
                        other: result(S + "get#Account", {userId: users.Two}),
                        shared: result(S + "get#Account", {userId: users.Both})
                    }
                } finally {
                    ec.user.setPreference("ACTIVE_ORGANIZATION", null)
                }
            })
        },
        then({none, active, other, shared}) {
            const noneIds = none.found.userList.map(row => row.userId)
            noneIds.includes(users.One) && noneIds.includes(users.Two)
            none.shared.error == "" && none.shared.sharedBeyondScope == false
            const activeIds = active.userList.map(row => row.userId)
            activeIds.includes(users.One) && !activeIds.includes(users.Two)
            other.error.includes("RECORD_UNAVAILABLE")
            shared.sharedBeyondScope == true && shared.canChangeAccount == false
        }
    }
)

feature(
    "the shared identity's account-wide change is refused without ADMIN_IDENTITY_GLOBAL; a reset request is sent and sets no password",
    {
        when() {
            const before = rows("moqui.security.UserAccount", {userId: users.Both})[0]
            const operator = as("sid.operator", () => {
                const revision = result(S + "get#Account", {userId: users.Both}).account.revision
                return {
                    account: result(S + "store#Account", {
                        userId: users.Both,
                        expectedRevision: revision,
                        emailAddress: "taken@example.com"
                    }),
                    factor: result(S + "reset#Authentication", {userId: users.Both, resetKind: "factor", factorId: "SID_FACTOR"}),
                    lock: result(S + "reset#Authentication", {userId: users.Both, resetKind: "lock"}),
                    password: result(S + "reset#Authentication", {userId: users.Both, resetKind: "password", reason: "Forgot it"})
                }
            })
            const after = rows("moqui.security.UserAccount", {userId: users.Both})[0]
            const global = as("sid.global", () =>
                result(S + "reset#Authentication", {userId: users.Both, resetKind: "factor", factorId: "SID_FACTOR"})
            )
            const factor = rows("moqui.security.UserAuthcFactor", {factorId: "SID_FACTOR"})[0]
            return {before, operator, after, global, factor}
        },
        then({before, operator, after, global, factor}) {
            operator.account.applied == false && operator.account.reasonCode == "IDENTITY_GLOBAL"
            operator.factor.applied == false && operator.factor.reasonCode == "IDENTITY_GLOBAL"
            operator.lock.reasonCode == "IDENTITY_GLOBAL"
            after.emailAddress == before.emailAddress
            // reset#Password: a reset password for the user to change, the current password kept
            operator.password.applied == true
            after.resetPassword != null && after.currentPassword == before.currentPassword
            global.applied == true
            factor.thruDate != null
        }
    }
)

feature("an organization membership is dated and ended, never deleted, and refused for another organization", {
    when() {
        return as("sid.operator", () => {
            const added = result(S + "store#OrganizationMembership", {
                partyId: parties.Two,
                organizationPartyId: orgId,
                relationshipTypeEnumId: "PrtAgent",
                reason: "Covering"
            })
            const duplicate = result(S + "store#OrganizationMembership", {
                partyId: parties.Two,
                organizationPartyId: orgId,
                relationshipTypeEnumId: "PrtAgent"
            })
            const elsewhere = result(S + "store#OrganizationMembership", {partyId: parties.One, organizationPartyId: otherOrgId})
            const stale = result(S + "store#OrganizationMembership", {
                partyRelationshipId: added.partyRelationshipId,
                expectedRevision: "1"
            })
            const ended = result(S + "store#OrganizationMembership", {
                partyRelationshipId: added.partyRelationshipId,
                expectedRevision: added.revision,
                reason: "Cover over"
            })
            return {added, duplicate, elsewhere, stale, ended}
        })
    },
    then({added, duplicate, elsewhere, stale, ended}) {
        added.applied == true && duplicate.reasonCode == "MEMBERSHIP_EXISTS"
        elsewhere.error.includes("RECORD_UNAVAILABLE")
        stale.reasonCode == "REVISION_CHANGED"
        ended.applied == true
        const kept = rows("mantle.party.PartyRelationship", {partyRelationshipId: added.partyRelationshipId})
        kept.length == 1 && kept[0].thruDate != null
        rows("moqui.entity.EntityAuditLog", {
            changedEntityName: "mantle.party.PartyRelationship",
            pkPrimaryValue: added.partyRelationshipId
        }).some(row => row.changedFieldName == "thruDate" && row.changeReason == "Cover over")
    }
})

feature(
    "a staff account comes with its organization and registered bundles; an unregistered group is refused with nothing written",
    {
        when() {
            return as("sid.operator", () => ({
                refused: result(S + "create#StaffAccount", {
                    firstName: "Nora",
                    lastName: "Refused",
                    emailAddress: "sid.refused@example.com",
                    organizationPartyId: orgId,
                    bundleGroupIdList: ["SID_UNREGISTERED"],
                    sendReset: false
                }),
                created: result(S + "create#StaffAccount", {
                    firstName: "Nina",
                    lastName: "New",
                    emailAddress: "sid.new@example.com",
                    organizationPartyId: orgId,
                    bundleGroupIdList: ["SID_BUNDLE"],
                    sendReset: false,
                    reason: "Seasonal"
                })
            }))
        },
        then({refused, created}) {
            refused.applied == false && refused.reasonCode == "UNREGISTERED_BUNDLE"
            rows("moqui.security.UserAccount", {username: "sid.refused@example.com"}).length == 0
            created.applied == true && created.userId
            const account = rows("moqui.security.UserAccount", {userId: created.userId})[0]
            account.currentPassword == null
            rows("moqui.security.UserGroupMember", {userId: created.userId, userGroupId: "SID_BUNDLE"}).length == 1
            rows("mantle.party.PartyRelationship", {fromPartyId: created.partyId, toPartyId: orgId}).length == 1
        }
    }
)

feature(
    "bounded delegation: an account holding a sealed permission the operator lacks, or a site identity, is refused (review R1, R2)",
    {
        when() {
            // a person with an account and no organization: a site identity
            parties.Site = call("mantle.party.PartyServices.create#Person", {firstName: "Site", lastName: "Staff"}).partyId
            users.Site = call("mantle.party.PartyServices.create#PartyUserAccount", {
                partyId: parties.Site,
                emailAddress: "sid.site@example.com",
                username: "sid.site"
            }).userId
            const before = rows("moqui.security.UserAccount", {userId: users.Global})[0]
            const operator = as("sid.operator", () => ({
                account: result(S + "store#Account", {
                    userId: users.Global,
                    expectedRevision: result(S + "get#Account", {userId: users.Global}).account.revision,
                    emailAddress: "sid.taken@example.com"
                }),
                lock: result(S + "reset#Authentication", {userId: users.Global, resetKind: "lock"}),
                site: result(S + "store#OrganizationMembership", {partyId: parties.Site, organizationPartyId: orgId})
            }))
            const global = as("sid.global", () =>
                result(S + "store#OrganizationMembership", {partyId: parties.Site, organizationPartyId: orgId})
            )
            return {before, operator, global, after: rows("moqui.security.UserAccount", {userId: users.Global})[0]}
        },
        then({before, operator, global, after}) {
            // sid.global holds the sealed ADMIN_IDENTITY_GLOBAL, which sid.operator does not
            operator.account.applied == false && operator.account.reasonCode == "IDENTITY_PRIVILEGED"
            operator.lock.reasonCode == "IDENTITY_PRIVILEGED"
            after.emailAddress == before.emailAddress
            operator.site.applied == false && operator.site.reasonCode == "IDENTITY_GLOBAL"
            global.applied == true
        }
    }
)

feature("an account's notes follow the organization filters, and with none named are nobody's (F75)", {
    when() {
        // as the user, with authorization on (the notes grant's MANTLE_USER_ORG) or off (no organization filter)
        const visible = (username, userId, authz = true) => {
            login(username, "moqui1!!")
            if (authz) ec.artifactExecution.enableAuthz()
            try {
                return result("mantle.party.CommunicationServices.get#RecordLinkInfo", {
                    recordEntityName: "moqui.security.UserAccount",
                    recordId: userId,
                    checkOnly: true
                }).recordVisible
            } finally {
                ec.artifactExecution.disableAuthz()
                login("john.doe")
            }
        }
        return {
            inScope: visible("sid.operator", users.One),
            outOfScope: visible("sid.operator", users.Two),
            otherOrganization: visible("sid.two", users.One),
            ownOrganization: visible("sid.two", users.Both),
            noFilter: visible("sid.operator", users.One, false)
        }
    },
    then({inScope, outOfScope, otherOrganization, ownOrganization, noFilter}) {
        inScope == true && outOfScope == false
        otherOrganization == false && ownOrganization == true
        noFilter == false
    }
})
