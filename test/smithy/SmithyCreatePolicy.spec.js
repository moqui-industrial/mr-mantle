// Who may make a group and a personal repository on a site (mr-pass plan/design-smithy.md §5.5, §11 SiteSettings, §15.3;
// SmithyManage.js getSmithySettings, storeSmithySettings, requestGroup, findGroupRequests, decideGroupRequest,
// createRepository): the site's owners set the policy and nobody else reads more of the settings than the policy; by the
// operators policy only the site's owners make a group; by request an account asks, has one request waiting, and the
// site's owners approve (the requester is its Owner) or refuse with a reason; by verified any account with a confirmed
// address makes one at once; a personal repository is made by its policy within the account's count; a write is refused
// without a confirmed address, under a suspension, and for text the forum's rules block; and a create with the same
// operationId answers once. Spec-local site and accounts. Regression suite: these are rules.
// Run: ./moq test mr-mantle --spec SmithyCreatePolicy
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const SITE = "SCP_SITE"
const op = (username, operation, input) => lib.op(username, SITE, operation, input)
const request = (username, pathSegment, operationId, more = {}) =>
    op(username, "requestGroup", {pathSegment, visibility: "public", operationId, ...more})
const policy = fields => lib.settings(SITE, fields)

spec({
    requires: ["git"],
    setupSpec() {
        login(lib.OPERATOR)
        lib.site(SITE)
        lib.account(SITE, "SCP_OWNER", {member: true, siteRole: "owner"})
        lib.account(SITE, "SCP_MODERATOR", {member: true, siteRole: "moderator"})
        lib.account(SITE, "SCP_ASKER", {handle: "scpasker"})
        lib.account(SITE, "SCP_OTHER", {handle: "scpother"})
        lib.account(SITE, "SCP_UNCONFIRMED", {handle: "scpunconfirmed", unconfirmed: true})
        lib.account(SITE, "SCP_SUSPENDED", {handle: "scpsuspended"})
        lib.account(SITE, "SCP_SILENCED", {handle: "scpsilenced"})
        lib.sanction(SITE, "SCP_SUSPENDED", "suspend")
        lib.sanction(SITE, "SCP_SILENCED", "silence")
        // the two that make several groups and repositories here are past a new account's day's limit of one (the limit
        // is SmithyLimits' rule)
        for (const partyId of ["SCP_ASKER", "SCP_OTHER"]) {
            lib.settled(SITE, partyId)
            lib.set("mantle.forum.ForumMemberState", {siteId: SITE, partyId}, {trustLevel: "member"})
        }
    }
})

feature("the site's owners store the settings, and anyone else reads only the policy", {
    when() {
        const first = op("SCP_OWNER", "getSmithySettings", {})
        const stored = op("SCP_OWNER", "storeSmithySettings", {
            groupCreate: "operators",
            defaultMaxRepositories: "2",
            expectedRevision: first.revision
        })
        return {
            first,
            stored,
            stale: op("SCP_OWNER", "storeSmithySettings", {groupCreate: "verified", expectedRevision: first.revision}),
            moderator: op("SCP_MODERATOR", "storeSmithySettings", {groupCreate: "verified", expectedRevision: stored.revision}),
            asker: op("SCP_ASKER", "getSmithySettings", {}),
            owner: op("SCP_OWNER", "getSmithySettings", {})
        }
    },
    then({first, stored, stale, moderator, asker, owner}) {
        // the defaults until a row is stored: a group by request, a personal repository for any confirmed account
        first.groupCreate == "request"
        first.repositoryCreate == "verified"
        first.defaultMaxRepositories == 5
        first.repositoryKind == "db"
        first.revision == 0
        stored.revision == 1
        stale.kind == "Conflict"
        stale.reason == "staleRevision"
        moderator.kind == "Unauthorized"
        moderator.reason == "accessDenied"
        asker.groupCreate == "operators"
        asker.defaultMaxRepositories == null
        asker.revision == null
        asker.capabilities.canRequestGroup == false
        asker.capabilities.canCreateRepository == true
        owner.defaultMaxRepositories == 2
        owner.capabilities.canRequestGroup == true
    }
})

feature("by the operators policy only the site's owners make a group", {
    when() {
        policy({groupCreateEnumId: "ScpOperators"})
        return {
            asker: request("SCP_ASKER", "scpoperators", "scp-operators-1"),
            owner: request("SCP_OWNER", "scpoperators", "scp-operators-2")
        }
    },
    then({asker, owner}) {
        asker.kind == "Unprocessable"
        asker.reason == "policyRefused"
        owner.status == "active"
        owner.groupPath == "scpoperators"
        op("SCP_OWNER", "getGroup", {groupId: owner.groupId}).myRole == "owner"
    }
})

feature("by request an account asks once, and the site's owners approve or refuse with a reason", {
    when() {
        policy({groupCreateEnumId: "ScpRequest"})
        const asked = request("SCP_ASKER", "scpasked", "scp-request-1", {reason: "A place for my project"})
        const second = request("SCP_ASKER", "scpsecond", "scp-request-2")
        const other = request("SCP_OTHER", "scpdenied", "scp-request-3")
        const waiting = {
            stranger: op("SCP_OTHER", "getGroup", {groupId: asked.groupId}),
            list: op("SCP_OWNER", "findGroupRequests", {}),
            notOwner: op("SCP_ASKER", "findGroupRequests", {})
        }
        const decide = (username, groupId, decision, more = {}) =>
            op(username, "decideGroupRequest", {groupId, decision, expectedRevision: 1, ...more})
        return {
            asked,
            second,
            waiting,
            byAsker: decide("SCP_ASKER", asked.groupId, "approve"),
            approved: decide("SCP_OWNER", asked.groupId, "approve"),
            again: decide("SCP_OWNER", asked.groupId, "refuse", {reason: "Too late"}),
            noReason: decide("SCP_OWNER", other.groupId, "refuse"),
            refused: decide("SCP_OWNER", other.groupId, "refuse", {reason: "Not a project"}),
            after: {
                requester: op("SCP_ASKER", "getGroup", {groupId: asked.groupId}),
                // with its request decided the account asks again, and a refused request's path is free
                next: request("SCP_ASKER", "scpdenied", "scp-request-4")
            }
        }
    },
    then({asked, second, waiting, byAsker, approved, again, noReason, refused, after}) {
        asked.status == "requested"
        second.kind == "Conflict"
        waiting.stranger.kind == "NotFound"
        waiting.list.requestList.map(item => item.group.groupPath + " " + item.requestedBy + " " + item.requestReason) ==
            ["scpasked scpasker A place for my project", "scpdenied scpother "]
        waiting.notOwner.reason == "accessDenied"
        byAsker.reason == "accessDenied"
        approved.status == "active"
        approved.revision == 2
        again.kind == "Conflict"
        noReason.kind == "Unprocessable"
        refused.status == "refused"
        after.requester.myRole == "owner"
        after.next.status == "requested"
        after.next.groupPath == "scpdenied"
    }
})

feature(
    "by the verified policy an account with a confirmed address makes a group at once, and the same operationId answers once",
    {
        when() {
            policy({groupCreateEnumId: "ScpVerified"})
            const made = request("SCP_OTHER", "scpverified", "scp-verified-1", {name: "Verified"})
            return {
                made,
                replay: request("SCP_OTHER", "scpverified", "scp-verified-1", {name: "Verified"}),
                changed: request("SCP_OTHER", "scpverified", "scp-verified-1", {name: "Another"}),
                unconfirmed: request("SCP_UNCONFIRMED", "scpunconfirmed1", "scp-verified-2"),
                suspended: request("SCP_SUSPENDED", "scpsuspended1", "scp-verified-3"),
                silenced: request("SCP_SILENCED", "scpsilenced1", "scp-verified-4"),
                anonymous: request(null, "scpanonymous", "scp-verified-5")
            }
        },
        then({made, replay, changed, unconfirmed, suspended, silenced, anonymous}) {
            made.status == "active"
            replay == made
            changed.kind == "Conflict"
            unconfirmed.kind == "Unauthorized"
            unconfirmed.reason == "addressUnconfirmed"
            suspended.kind == "Unauthorized"
            suspended.reason == "accessDenied"
            // a silence refuses what an account writes for others to read: a name
            silenced.kind == "Unauthorized"
            silenced.reason == "accessDenied"
            anonymous.kind == "AuthenticationRequired"
            lib.row("mantle.smithy.SmithyGroup", {siteId: SITE, groupPath: "scpunconfirmed1"}) == null
        }
    }
)

feature("a name the forum's rules block is refused", {
    when() {
        lib.make("mantle.forum.ForumRule", {
            ruleId: "SCP_RULE",
            siteId: SITE,
            ruleType: "word",
            pattern: "scpforbidden",
            action: "block",
            enabled: "Y",
            priority: 1,
            revision: 1
        })
        return {
            blocked: request("SCP_OTHER", "scprule1", "scp-rule-1", {description: "All about scpforbidden things"}),
            allowed: request("SCP_OTHER", "scprule2", "scp-rule-2", {description: "All about other things"})
        }
    },
    then({blocked, allowed}) {
        blocked.kind == "Unprocessable"
        blocked.message == "The site's rules do not allow that text"
        allowed.status == "active"
    }
})

feature("a personal repository is made by its policy, in the account's namespace and within its count", {
    when() {
        policy({repositoryCreateEnumId: "ScpVerified", defaultMaxRepositories: 1})
        const create = (username, slug, operationId) =>
            op(username, "createRepository", {slug, visibility: "public", operationId})
        const first = create("SCP_ASKER", "first", "scp-repository-1")
        const second = create("SCP_ASKER", "second", "scp-repository-2")
        policy({repositoryCreateEnumId: "ScpOperators"})
        return {
            first,
            second,
            operators: create("SCP_OTHER", "mine", "scp-repository-3"),
            unconfirmed: create("SCP_UNCONFIRMED", "mine", "scp-repository-4"),
            view: op("SCP_ASKER", "getRepository", {repositoryId: first.repositoryId})
        }
    },
    then({first, second, operators, unconfirmed, view}) {
        first.repositoryPath == "scpasker/first"
        // the site's kind for a new repository, which a caller does not choose
        lib.row("moqui.resource.GitRepository", {repositoryId: first.repositoryId}).repositoryKind == "db"
        view.myRole == "owner"
        second.kind == "Unprocessable"
        second.reason == "quotaExceeded"
        operators.reason == "policyRefused"
        unconfirmed.reason == "addressUnconfirmed"
    }
})

feature("Smithy answers only on a site that mounts it, and a site that lost its mount keeps its clones and takes no write", {
    when() {
        // a site of other apps: an open site, a confirmed member with a handle, and no Smithy mount
        lib.make("mantle.public.PublicSite", {
            siteId: "SCP_BARE",
            name: "SCP_BARE",
            state: "published",
            registrationMode: "closed",
            locale: "en",
            timeZone: "UTC",
            policyRevision: 1,
            generation: 1
        })
        lib.make("mantle.public.PublicSiteApp", {
            siteId: "SCP_BARE",
            appMountId: "SCP_BARE_F",
            app: "forum",
            pathPrefix: "/",
            enabled: "Y"
        })
        lib.account("SCP_BARE", "SCP_BARE_USER", {handle: "scpbare"})
        const bare = (operation, input) => lib.op("SCP_BARE_USER", "SCP_BARE", operation, input)
        const none = {
            settings: bare("getSmithySettings", {}),
            repository: bare("createRepository", {slug: "mine", operationId: "scp-bare-1"}),
            group: bare("requestGroup", {pathSegment: "scpbaregroup", operationId: "scp-bare-2"}),
            keys: bare("findGitAccess", {})
        }
        // a site that had Smithy: its public repository, and a Developer of it
        lib.site("SCP_LOST")
        lib.account("SCP_LOST", "SCP_LOST_DEV", {handle: "scplostdev"})
        const groupId = lib.createGroup(lib.OPERATOR, {siteId: "SCP_LOST", pathSegment: "scplost", visibility: "public"}).groupId
        const repositoryId = lib.createRepository(lib.OPERATOR, {
            siteId: "SCP_LOST",
            groupId,
            slug: "code",
            visibility: "public"
        }).repositoryId
        lib.role("SCP_LOST", {groupId}, "SCP_LOST_DEV", "SmrDeveloper")
        const state = () => ({
            page: lib.op("SCP_LOST_DEV", "SCP_LOST", "getRepository", {repositoryId}).kind || "shown",
            git: ["VIEW", "UPDATE"].map(action => lib.authz("SCP_LOST_DEV", repositoryId, action)),
            push: lib.gate("Push", {repositoryId, userId: "SCP_LOST_DEV", packBytes: 10})
        })
        const mounted = state()
        lib.set("mantle.public.PublicSiteApp", {siteId: "SCP_LOST", appMountId: "SCP_LOST_S"}, {enabled: "N"})
        return {none, mounted, lost: state()}
    },
    then({none, mounted, lost}) {
        none.settings.kind == "NotFound"
        none.repository.kind == "NotFound"
        none.group.kind == "NotFound"
        none.keys.kind == "NotFound"
        lib.row("mantle.smithy.SmithyRepository", {siteId: "SCP_BARE", ownerPartyId: "SCP_BARE_USER"}) == null
        mounted.page == "shown"
        mounted.git == ["AUTHZT_ALLOW", "AUTHZT_ALLOW"]
        mounted.push == []
        lost.page == "NotFound"
        // who could view it still clones it; nobody pushes
        lost.git == ["AUTHZT_ALLOW", "AUTHZT_NONE"]
        lost.push.length == 1
        lost.push[0].includes("no longer hosts")
    }
})
