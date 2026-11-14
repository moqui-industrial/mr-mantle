// Marketing's organization scope (impl-marketing P1, §2; design-marketing §1.1, §15.4, X12): the organization filters of
// MarketingCampaign, MarketSegment and ContactList (MANTLE_USER_ORG_MCMP, _MSEG, _CLST and their MANTLE_ACTIVE_ORG twins,
// data/MantleSetupData.xml) leave another organization's and an unowned campaign, segment and list out of a find under an app's
// ordinary grant (MANTLE_USER_ORG), a mailbox of any owner left to its own rules, and an administrator's grant
// (MANTLE_ACTIVE_ORG) finds every one until an organization is active; the list services reach a list that is not a mailbox
// only for its organization's users and a contact administrator (F77), so another organization's and an unowned list answer as
// missing and a list is created for one's own organization only, a mailbox unaffected; MarketingAccess gives a reader their
// organizations and an edit permission alone none; adoption assigns an unowned record once, by reason code per record, and the
// adopted list is then the organization's; the readiness check names what awaits adoption. Standalone: spec-local
// organizations, records, groups and users; the grants are spec-local artifact groups carrying the filter sets, as an app root's
// do.
// Run: ./moq test mr-mantle --spec MarketingScope
const prefix = "MKS"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
// the artifact a find runs under, authorized by the spec's grants with their filter sets
const artifact = "mantle.marketing.spec.MarketingScope"
const accessModule = "component://mr-mantle/service/mantle/marketing/MarketingAccess.js"
const listServices = "mantle.marketing.ContactListServices."
const campaignServices = "mantle.marketing.CampaignServices."
const workspaceServices = "mantle.marketing.MarketingWorkspaceServices."

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
    make("mantle.party.Person", {partyId: id, firstName: "Marketing scope", lastName: kind})
    for (const toPartyId of organizationPartyIds)
        make("mantle.party.PartyRelationship", {
            fromPartyId: id,
            toPartyId,
            relationshipTypeEnumId: "PrtAgent",
            toRoleTypeId: "OrgInternal",
            fromDate: 0
        })
    make("moqui.security.UserGroup", {userGroupId: id, description: "Marketing scope " + kind})
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
    make("moqui.security.UserGroup", {userGroupId: groupId, description: "Marketing scope grant " + groupId})
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
// The ids of each marketing record kind the user finds under the spec's artifact, with authorization on and the user's
// organizations in the user context (as an app root's setup#UserOrganizationInfo puts them), the active organization set for
// the find.
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
            campaigns: ids("mantle.marketing.campaign.MarketingCampaign", "marketingCampaignId"),
            segments: ids("mantle.marketing.segment.MarketSegment", "marketSegmentId"),
            lists: ids("mantle.marketing.contact.ContactList", "contactListId")
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
// A service as the user, authorization off (the service's own rule, not the grant): its result, or its errors as refusal
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
        login("john.doe")
    }
}
const access = (username, contactListId) => as(username, listServices + "get#ContactListAccess", {contactListId})
const ids = list => JSON.stringify(list)

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Marketing scope A")
            organization(orgB, "Marketing scope B")
            make("moqui.security.ArtifactGroup", {artifactGroupId: prefix + "_ARTIFACT", description: "Marketing scope spec"})
            make("moqui.security.ArtifactGroupMember", {
                artifactGroupId: prefix + "_ARTIFACT",
                artifactName: artifact,
                artifactTypeEnumId: "AT_OTHER",
                nameIsPattern: "N",
                inheritAuthz: "Y"
            })
            grant(prefix + "_USER_GRANT", "AUTHZT_ALLOW", "MANTLE_USER_ORG")
            grant(prefix + "_ADMIN_GRANT", "AUTHZT_ALWAYS", "MANTLE_ACTIVE_ORG")
            users.author = user("author", [orgA], ["MARKETING_VIEW", "MARKETING_AUDIENCE_EDIT"], prefix + "_USER_GRANT")
            users.admin = user("admin", [orgA], ["MARKETING_VIEW", "MARKETING_CONFIGURE"], prefix + "_ADMIN_GRANT")
            users.editor = user("editor", [orgA], ["MARKETING_CAMPAIGN_EDIT"], null)
            users.contactAdmin = user("contacts", [orgB], ["CONTACT_ADMIN"], null)
            for (const [suffix, owner] of [
                ["A", orgA],
                ["B", orgB],
                ["NONE", null]
            ]) {
                make("mantle.marketing.campaign.MarketingCampaign", {
                    marketingCampaignId: prefix + "_CMP_" + suffix,
                    campaignName: "Scope campaign " + suffix,
                    statusId: "MKTG_CAMP_PLANNED",
                    organizationPartyId: owner
                })
                make("mantle.marketing.segment.MarketSegment", {
                    marketSegmentId: prefix + "_SEG_" + suffix,
                    description: "Scope segment " + suffix,
                    marketSegmentTypeEnumId: "MARKET_SEGMENT",
                    ownerPartyId: owner || "_NA_"
                })
                make("mantle.marketing.contact.ContactList", {
                    contactListId: prefix + "_LST_" + suffix,
                    contactListName: "Scope list " + suffix,
                    contactListTypeEnumId: "NEWSLETTER",
                    isPublic: "Y",
                    ownerPartyId: owner
                })
            }
            // a public mailbox of B: the Inbox's, whoever its owner
            make("mantle.marketing.contact.ContactList", {
                contactListId: prefix + "_MBX_B",
                contactListName: "Scope mailbox B",
                contactListTypeEnumId: "MAILBOX",
                isPublic: "Y",
                ownerPartyId: orgB
            })
        })
    }
})

feature(
    "an ordinary grant finds its organization's campaign, segment and list and every mailbox, not another's nor an unowned one",
    {
        when() {
            return {author: found(users.author)}
        },
        then({author}) {
            ids(author.campaigns) == ids([prefix + "_CMP_A"])
            ids(author.segments) == ids([prefix + "_SEG_A"])
            ids(author.lists) == ids([prefix + "_LST_A", prefix + "_MBX_B"])
        }
    }
)

feature("an administrator's grant finds every one, the unowned among them, until an organization is active, then its own", {
    when() {
        return {all: found(users.admin), active: found(users.admin, orgA)}
    },
    then({all, active}) {
        ids(all.campaigns) == ids([prefix + "_CMP_A", prefix + "_CMP_B", prefix + "_CMP_NONE"])
        ids(all.segments) == ids([prefix + "_SEG_A", prefix + "_SEG_B", prefix + "_SEG_NONE"])
        ids(all.lists) == ids([prefix + "_LST_A", prefix + "_LST_B", prefix + "_LST_NONE", prefix + "_MBX_B"])
        ids(active.campaigns) == ids([prefix + "_CMP_A"])
        ids(active.segments) == ids([prefix + "_SEG_A"])
        ids(active.lists) == ids([prefix + "_LST_A", prefix + "_MBX_B"])
    }
})

feature(
    "the list services reach a list for its organization's users and a contact administrator; another's and an unowned one answer as missing; a mailbox is unaffected",
    {
        when() {
            return {
                own: access(users.author, prefix + "_LST_A"),
                other: access(users.author, prefix + "_LST_B"),
                unowned: access(users.author, prefix + "_LST_NONE"),
                mailbox: access(users.author, prefix + "_MBX_B"),
                renameUnowned: as(users.author, listServices + "update#ContactList", {
                    contactListId: prefix + "_LST_NONE",
                    contactListName: "Taken"
                }),
                contactAdminUnowned: access(users.contactAdmin, prefix + "_LST_NONE"),
                contactAdminOther: access(users.contactAdmin, prefix + "_LST_A"),
                createOther: as(users.author, listServices + "create#ContactList", {
                    contactListName: "Spec list of B",
                    contactListTypeEnumId: "NEWSLETTER",
                    ownerPartyId: orgB
                }),
                createNone: as(users.author, listServices + "create#ContactList", {
                    contactListName: "Spec list of no one",
                    contactListTypeEnumId: "NEWSLETTER"
                }),
                createOwn: as(users.author, listServices + "create#ContactList", {
                    contactListName: "Spec list of A",
                    contactListTypeEnumId: "NEWSLETTER",
                    ownerPartyId: orgA
                })
            }
        },
        then({
            own,
            other,
            unowned,
            mailbox,
            renameUnowned,
            contactAdminUnowned,
            contactAdminOther,
            createOther,
            createNone,
            createOwn
        }) {
            own.exists == true && own.canSeeHeader == true && own.canPost == true
            other.exists == false && other.canSeeHeader == false && other.contactList == null
            unowned.exists == false && unowned.canSeeHeader == false
            mailbox.isMailbox == true && mailbox.canSeeHeader == true
            renameUnowned.refusal.includes("not found")
            contactAdminUnowned.canSeeHeader == true
            contactAdminOther.canSeeHeader == true
            createOther.refusal.includes("ORGANIZATION_DENIED")
            createNone.refusal.includes("ORGANIZATION_DENIED")
            createOwn.refusal == "" && !!createOwn.contactListId
        }
    }
)

feature("MarketingAccess gives a reader their organizations and refuses another's; an edit permission alone reads none", {
    when() {
        const scopeOf = username => {
            login(username)
            try {
                const marketing = ec.resource.script(accessModule)
                const userScope = marketing.scope()
                let refusal = ""
                try {
                    marketing.requireOrganization(userScope, orgB)
                } catch (error) {
                    refusal = String(error.message)
                }
                return {organizationPartyIds: userScope.organizationPartyIds, capabilities: userScope.capabilities, refusal}
            } finally {
                login("john.doe")
            }
        }
        return {author: scopeOf(users.author), editor: scopeOf(users.editor)}
    },
    then({author, editor}) {
        ids(author.organizationPartyIds) == ids([orgA])
        author.capabilities.anyRead == true &&
            author.capabilities.audienceEdit == true &&
            author.capabilities.audienceRead == false
        author.refusal.includes("ORGANIZATION_DENIED")
        editor.capabilities.campaignEdit == true && editor.capabilities.anyRead == false
        editor.organizationPartyIds.length == 0
        editor.refusal.includes("ORGANIZATION_DENIED")
    }
})

feature("adoption assigns each unowned record once, by reason code per record, and the adopted list is then its organization's", {
    when() {
        const preview = as(users.admin, campaignServices + "preview#Adoption")
        const mine = Array.from(preview.records || []).filter(row => String(row.recordId).startsWith(prefix))
        const stamp = recordId => mine.find(row => row.recordId === recordId)?.lastUpdatedStamp
        const readiness = as(users.admin, workspaceServices + "get#Readiness", {providerKey: "marketing.setup"})
        const applied = as(users.admin, campaignServices + "apply#Adoption", {
            assignments: [
                {
                    recordKind: "list",
                    recordId: prefix + "_LST_NONE",
                    organizationPartyId: orgA,
                    lastUpdatedStamp: stamp(prefix + "_LST_NONE")
                },
                {
                    recordKind: "campaign",
                    recordId: prefix + "_CMP_NONE",
                    organizationPartyId: orgA,
                    lastUpdatedStamp: stamp(prefix + "_CMP_NONE")
                },
                {recordKind: "segment", recordId: prefix + "_SEG_NONE", organizationPartyId: orgB},
                {recordKind: "segment", recordId: prefix + "_SEG_A", organizationPartyId: orgA},
                {recordKind: "list", recordId: prefix + "_MBX_B", organizationPartyId: orgA},
                {recordKind: "segment", recordId: prefix + "_SEG_NONE", organizationPartyId: orgA},
                {recordKind: "segment", recordId: prefix + "_SEG_NONE", organizationPartyId: orgA, lastUpdatedStamp: 1},
                {recordKind: "store", recordId: prefix + "_LST_A", organizationPartyId: orgA}
            ]
        })
        const again = as(users.admin, campaignServices + "apply#Adoption", {
            assignments: [{recordKind: "list", recordId: prefix + "_LST_NONE", organizationPartyId: orgA}]
        })
        const party = system(() =>
            ec.entity
                .find("mantle.marketing.campaign.MarketingCampaignParty")
                .condition({marketingCampaignId: prefix + "_CMP_NONE", roleTypeId: "MarketingOrganization"})
                .list()
        )
        const campaign = system(() =>
            ec.entity
                .find("mantle.marketing.campaign.MarketingCampaign")
                .condition({marketingCampaignId: prefix + "_CMP_NONE"})
                .one()
        )
        return {
            mine: mine.map(row => row.recordKind + ":" + row.recordId).sort(),
            readiness: Array.from(readiness.checks || []).find(row => row.checkKey === "marketing.adoption") || {},
            codes: Array.from(applied.results || []).map(row => row.reasonCode || "adopted"),
            adoptedCount: applied.adoptedCount,
            again: Array.from(again.results || []).map(row => row.reasonCode),
            partyIds: Array.from(party).map(row => row.partyId),
            campaignOrganization: campaign.organizationPartyId,
            listAfter: access(users.author, prefix + "_LST_NONE"),
            refused: as(users.author, campaignServices + "preview#Adoption"),
            readinessRefused: as(users.author, workspaceServices + "get#Readiness", {providerKey: "marketing.setup"}),
            readinessOther: as(users.admin, workspaceServices + "get#Readiness", {organizationPartyId: orgB})
        }
    },
    then({
        mine,
        readiness,
        codes,
        adoptedCount,
        again,
        partyIds,
        campaignOrganization,
        listAfter,
        refused,
        readinessRefused,
        readinessOther
    }) {
        ids(mine) == ids(["campaign:" + prefix + "_CMP_NONE", "list:" + prefix + "_LST_NONE", "segment:" + prefix + "_SEG_NONE"])
        readiness.state == "warning" && readiness.reasonCode == "UNOWNED_RECORDS" && readiness.fixRoute == "marketingAdoption"
        ids(codes) ==
            ids([
                "adopted",
                "adopted",
                "ORGANIZATION_DENIED",
                "ALREADY_OWNED",
                "RECORD_UNAVAILABLE",
                "REVISION_REQUIRED",
                "REVISION_CHANGED",
                "UNKNOWN_KIND"
            ])
        adoptedCount == 2
        ids(again) == ids(["ALREADY_OWNED"])
        ids(partyIds) == ids([orgA])
        campaignOrganization == orgA
        listAfter.canSeeHeader == true && listAfter.canPost == true
        refused.refusal.includes("PERMISSION_DENIED")
        readinessRefused.refusal.includes("PERMISSION_DENIED")
        readinessOther.refusal.includes("ORGANIZATION_DENIED")
    }
})

feature("Home answers each source by name, those not built yet shown not available; a caller who reads nothing is refused", {
    when() {
        return {
            home: as(users.author, workspaceServices + "get#Home", {organizationPartyId: orgA}),
            attention: as(users.admin, workspaceServices + "get#Attention"),
            other: as(users.author, workspaceServices + "get#Home", {organizationPartyId: orgB}),
            editor: as(users.editor, workspaceServices + "get#Upcoming")
        }
    },
    then({home, attention, other, editor}) {
        home.refusal == ""
        Array.from(home.cards)
            .map(card => card.cardKey)
            .join(",") == "campaigns,approvals,dueSends,failedDeliveries,registrations,audienceChanges"
        // P2 counts the running campaigns and pending approvals; the others are not built yet
        Array.from(home.cards)
            .filter(card => !["campaigns", "approvals"].includes(card.cardKey))
            .every(card => card.state == "notAvailable" && card.value == null)
        Array.from(home.cards)
            .filter(card => ["campaigns", "approvals"].includes(card.cardKey))
            .every(card => card.state == "available" && card.value == 0)
        home.failedSources.length == 0
        // the approvals awaiting a decision are an approver's (P2): the administrator holds no approval
        Array.from(attention.sources)
            .map(source => source.sourceKey + ":" + source.state)
            .join(",") == "adoption:available,deliveries:notAvailable"
        other.refusal.includes("ORGANIZATION_DENIED")
        editor.refusal.includes("PERMISSION_DENIED")
    }
})
