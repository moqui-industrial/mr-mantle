// Internal organizations (service/mantle/party/Organizations.js, IdentityServices.xml; mr-boss impl-admin P7, design-admin §7):
// an organization's settings operator finds its organization and the child it creates, not another organization, and cannot
// create one outside its scope or make its child top-level; a parent links only two internal organizations, dated (the earlier parent ended and kept), never
// in a cycle, and moving a child out of the operator's organization takes it out of its scope; the profile and a registered
// default change at their revision, and a default no one registered for internal organizations, or one its owner sets, is
// refused. Scope is the organization entity filters of the services' ALL_USERS grant (MANTLE_USER_ORG) for the operator and
// ADMIN's own grant (every organization with none active). The operator holds the framework's ADMIN_SETTINGS_* through a spec
// group. New spec, no Groovy original.
// Run: ./moq test mr-mantle --spec InternalOrganizations
const S = "mantle.party.IdentityServices."
const dayMillis = 86400000
const effectiveTime = Date.now()
const orgs = {}

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
    if (username === "john.doe") login(username)
    else login(username, "moqui1!!")
    ec.artifactExecution.enableAuthz()
    try {
        return run()
    } finally {
        ec.artifactExecution.disableAuthz()
        login("john.doe")
    }
}
const rollups = partyId =>
    Array.from(
        ec.entity
            .find("mantle.party.PartyRelationship")
            .condition({fromPartyId: partyId, relationshipTypeEnumId: "PrtOrgRollup"})
            .orderBy("fromDate")
            .disableAuthz()
            .list()
    )
const ids = list => Array.from(list || []).map(row => row.organizationPartyId)

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.user.setPreference("ACTIVE_ORGANIZATION", null)
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.artifactExecution.enableAuthz()
        login("john.doe")
    }
})

feature(
    "two internal organizations, a party that is not one, a settings operator of the first and a member without the permission",
    {
        when() {
            for (const [key, name, role] of [
                ["one", "Org Rules One", "OrgInternal"],
                ["two", "Org Rules Two", "OrgInternal"],
                ["outside", "Org Rules Supplier", "Supplier"]
            ])
                orgs[key] = call("mantle.party.PartyServices.create#Organization", {
                    organizationName: name,
                    roleTypeId: role
                }).partyId
            call("create#moqui.security.UserGroup", {userGroupId: "IOR_SETTINGS", description: "Spec organization settings"})
            for (const permission of ["ADMIN_SETTINGS_VIEW", "ADMIN_SETTINGS_MANAGE"])
                call("create#moqui.security.UserGroupPermission", {
                    userGroupId: "IOR_SETTINGS",
                    userPermissionId: permission,
                    fromDate: effectiveTime - dayMillis
                })
            for (const [first, username, inGroup] of [
                ["Ola", "ior.operator", true],
                ["Uma", "ior.member", false]
            ]) {
                const partyId = call("mantle.party.PartyServices.create#Person", {firstName: first, lastName: "Org"}).partyId
                const userId = call("mantle.party.PartyServices.create#PartyUserAccount", {
                    partyId,
                    emailAddress: username + "@example.com",
                    username,
                    newPassword: "moqui1!!",
                    newPasswordVerify: "moqui1!!"
                }).userId
                call("create#mantle.party.PartyRelationship", {
                    relationshipTypeEnumId: "PrtEmployee",
                    fromPartyId: partyId,
                    toPartyId: orgs.one,
                    toRoleTypeId: "OrgInternal",
                    fromDate: effectiveTime - dayMillis
                })
                if (inGroup)
                    call("create#moqui.security.UserGroupMember", {
                        userGroupId: "IOR_SETTINGS",
                        userId,
                        fromDate: effectiveTime - dayMillis
                    })
            }
            // a store of the first organization, for its invoice store default
            call("create#mantle.product.store.ProductStore", {
                productStoreId: "IOR_STORE",
                storeName: "Org Rules store",
                organizationPartyId: orgs.one
            })
        },
        then() {
            orgs.one && orgs.two && orgs.outside
        }
    }
)

feature("the operator creates a child of its organization and finds both, not another; it cannot create outside its scope", {
    when() {
        return as("ior.operator", () => {
            const child = result(S + "create#InternalOrganization", {
                organizationName: "Org Rules Child",
                parentPartyId: orgs.one
            })
            orgs.child = child.organizationPartyId
            return {
                child,
                found: result(S + "find#InternalOrganizations", {}),
                topLevel: result(S + "create#InternalOrganization", {organizationName: "Org Rules Loose"}),
                underOther: result(S + "create#InternalOrganization", {
                    organizationName: "Org Rules Stray",
                    parentPartyId: orgs.two
                }),
                other: result(S + "get#InternalOrganization", {organizationPartyId: orgs.two}),
                // ending its child's parent would make a top-level organization, out of its parent's administrators' scope
                detach: result(S + "store#OrganizationParent", {organizationPartyId: orgs.child}),
                member: as("ior.member", () => result(S + "find#InternalOrganizations", {}))
            }
        })
    },
    then({child, found, topLevel, underOther, other, detach, member}) {
        child.applied && child.error == ""
        rollups(orgs.child).length == 1 && rollups(orgs.child)[0].toPartyId == orgs.one && rollups(orgs.child)[0].thruDate == null
        ids(found.organizationList).includes(orgs.one) && ids(found.organizationList).includes(orgs.child)
        !ids(found.organizationList).includes(orgs.two) && found.everyOrganization == false
        found.organizationList.find(row => row.organizationPartyId == orgs.child).parentName == "Org Rules One"
        topLevel.applied == false && topLevel.reasonCode == "PARENT_REQUIRED" && detach.reasonCode == "PARENT_REQUIRED"
        underOther.error.includes("RECORD_UNAVAILABLE") && other.error.includes("RECORD_UNAVAILABLE")
        member.error.includes("ADMIN_SETTINGS_VIEW")
    }
})

feature("a parent links only internal organizations, never in a cycle, dated: the earlier parent ended and kept", {
    when() {
        const admin = (parentPartyId, organizationPartyId = orgs.child) =>
            as("john.doe", () => result(S + "store#OrganizationParent", {organizationPartyId, parentPartyId}))
        return {
            outside: admin(orgs.outside),
            cycle: admin(orgs.child, orgs.one),
            moved: admin(orgs.two),
            again: admin(orgs.two),
            // moved out of the operator's organization, the child is out of its scope
            operator: as("ior.operator", () => result(S + "get#InternalOrganization", {organizationPartyId: orgs.child}))
        }
    },
    then({outside, cycle, moved, again, operator}) {
        outside.reasonCode == "NOT_INTERNAL" && cycle.reasonCode == "PARENT_CYCLE"
        moved.applied && moved.error == ""
        rollups(orgs.child).length == 2
        rollups(orgs.child)[0].toPartyId == orgs.one && rollups(orgs.child)[0].thruDate != null
        rollups(orgs.child)[1].toPartyId == orgs.two && rollups(orgs.child)[1].thruDate == null
        again.reasonCode == "PARENT_UNCHANGED"
        operator.error.includes("RECORD_UNAVAILABLE")
    }
})

feature("the profile and a registered default change at their revision; an unregistered or owner's default is refused", {
    when() {
        return as("ior.operator", () => {
            const read = result(S + "get#InternalOrganization", {organizationPartyId: orgs.one})
            const store = value =>
                result(S + "store#OrganizationDefault", {
                    organizationPartyId: orgs.one,
                    partySettingTypeId: "OrgInvoiceProductStoreId",
                    settingValue: value,
                    expectedRevision: ""
                })
            return {
                read,
                stale: result(S + "store#InternalOrganization", {
                    organizationPartyId: orgs.one,
                    expectedRevision: "1",
                    organizationName: "Org Rules Renamed"
                }),
                renamed: result(S + "store#InternalOrganization", {
                    organizationPartyId: orgs.one,
                    expectedRevision: read.organization.revision,
                    organizationName: "Org Rules First"
                }),
                unregistered: result(S + "store#OrganizationDefault", {
                    organizationPartyId: orgs.one,
                    partySettingTypeId: "CustomerSingleLot",
                    settingValue: "BlY"
                }),
                owners: result(S + "store#OrganizationDefault", {
                    organizationPartyId: orgs.one,
                    partySettingTypeId: "OrgTemplateInvoicePrint",
                    settingValue: "component://somewhere/Template.xml"
                }),
                foreign: store("NOT_A_STORE_OF_ONE"),
                stored: store("IOR_STORE"),
                staleDefault: store("IOR_STORE")
            }
        })
    },
    then({read, stale, renamed, unregistered, owners, foreign, stored, staleDefault}) {
        read.error == "" && read.membersShown == false && read.memberCount == 2
        read.defaults.find(row => row.partySettingTypeId == "OrgInvoiceProductStoreId").editable == true
        read.defaults.find(row => row.partySettingTypeId == "OrgTemplateInvoicePrint").editable == false
        stale.reasonCode == "REVISION_CHANGED" && renamed.applied
        ec.entity.find("mantle.party.Organization").condition("partyId", orgs.one).disableAuthz().one().organizationName ==
            "Org Rules First"
        unregistered.reasonCode == "NOT_REGISTERED" && owners.reasonCode == "OWNER_SETTING"
        foreign.reasonCode == "VALUE_INVALID" && stored.applied && staleDefault.reasonCode == "REVISION_CHANGED"
        ec.entity
            .find("mantle.party.PartySetting")
            .condition({partyId: orgs.one, partySettingTypeId: "OrgInvoiceProductStoreId"})
            .disableAuthz()
            .one().settingValue == "IOR_STORE"
    }
})
