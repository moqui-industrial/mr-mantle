// Smithy's view rule (mr-pass plan/design-smithy.md §5.1; service/mantle/smithy/SmithyCore.js): the effective visibility
// of a repository is the narrowest of its own and its groups'; anyone views a public one, an active site member a
// members-only one (a suspended member does not), and a private one needs a role; a child wider than its parent is
// refused, and one stored wider is still read as the narrowest; a hidden repository, one in a group that is not active
// and anything on a site that is not published are Not Found, exactly as a repository that is not there. Spec-local
// site, accounts, group and db repositories. Regression suite: these are rules. Run: ./moq test mr-mantle --spec SmithyVisibility
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const SITE = "SMV_SITE"
const ids = {}
const view = (username, repositoryId) => lib.op(username, SITE, "getRepository", {repositoryId})

spec({
    requires: ["git"],
    setupSpec() {
        login(lib.OPERATOR)
        lib.site(SITE)
        lib.account(SITE, "SMV_STRANGER")
        lib.account(SITE, "SMV_MEMBER", {member: true})
        lib.account(SITE, "SMV_SUSPENDED", {member: true})
        lib.account(SITE, "SMV_GUEST")
        lib.account(SITE, "SMV_OWNER")
        lib.make("mantle.forum.ForumSanction", {
            sanctionId: "SMV_SANCTION",
            siteId: SITE,
            partyId: "SMV_SUSPENDED",
            kind: "suspend",
            fromDate: ec.user.timestampMillis(ec.user.nowTimestamp) - 1000,
            revision: 1
        })
        ids.group = lib.createGroup(lib.OPERATOR, {
            siteId: SITE,
            pathSegment: "smvgroup",
            name: "Visibility",
            visibility: "public"
        }).groupId
        for (const visibility of ["public", "members", "private"])
            ids[visibility] = lib.createRepository(lib.OPERATOR, {
                siteId: SITE,
                groupId: ids.group,
                slug: "smv-" + visibility,
                visibility
            }).repositoryId
        lib.role(SITE, {repositoryId: ids.private}, "SMV_GUEST", "SmrGuest")
        lib.role(SITE, {repositoryId: ids.public}, "SMV_OWNER", "SmrOwner")
    }
})

feature("anyone views a public repository, a site member a members-only one, and a private one needs a role", {
    when() {
        return {
            anonymous: ["public", "members", "private"].map(name => view(null, ids[name])),
            stranger: view("SMV_STRANGER", ids.members),
            member: [view("SMV_MEMBER", ids.members), view("SMV_MEMBER", ids.private)],
            suspended: view("SMV_SUSPENDED", ids.members),
            guest: [view("SMV_GUEST", ids.private), view("SMV_GUEST", ids.members)],
            absent: view(null, "SMV_NO_SUCH")
        }
    },
    then({anonymous, stranger, member, suspended, guest, absent}) {
        anonymous[0].repository.repositoryPath == "smvgroup/smv-public"
        anonymous[0].repository.effectiveVisibility == "public"
        anonymous[0].myRole == null
        !anonymous[0].capabilities.signedIn
        anonymous[1].kind == "NotFound"
        anonymous[2].kind == "NotFound"
        // what may not be viewed answers exactly as what is not there
        JSON.stringify({...anonymous[2], correlationId: null}) == JSON.stringify({...absent, correlationId: null})
        stranger.kind == "NotFound"
        member[0].repository.visibility == "members"
        member[1].kind == "NotFound"
        suspended.kind == "NotFound"
        guest[0].repository.visibility == "private"
        guest[0].myRole == "guest"
        // a role opens a private repository only: members-only is the site's members
        guest[1].kind == "NotFound"
    }
})

feature(
    "a child is no wider than its parent, a repository is private unless asked, and one stored wider is read as the narrowest",
    {
        when() {
            const subgroup = lib.createGroup(lib.OPERATOR, {
                siteId: SITE,
                parentGroupId: ids.group,
                pathSegment: "inner",
                visibility: "members"
            })
            const widerGroup = lib.createGroup(lib.OPERATOR, {
                siteId: SITE,
                parentGroupId: subgroup.groupId,
                pathSegment: "wider",
                visibility: "public"
            })
            const widerRepository = lib.createRepository(lib.OPERATOR, {
                siteId: SITE,
                groupId: subgroup.groupId,
                slug: "wide",
                visibility: "public"
            })
            ids.inner = lib.createRepository(lib.OPERATOR, {siteId: SITE, groupId: subgroup.groupId, slug: "inside"}).repositoryId
            const asMade = lib.row("mantle.smithy.SmithyRepository", {repositoryId: ids.inner}).visibilityEnumId
            lib.set("mantle.smithy.SmithyRepository", {repositoryId: ids.inner}, {visibilityEnumId: "SmvPublic"})
            return {
                subgroup,
                widerGroup,
                widerRepository,
                asMade,
                anonymous: view(null, ids.inner),
                member: view("SMV_MEMBER", ids.inner)
            }
        },
        then({subgroup, widerGroup, widerRepository, asMade, anonymous, member}) {
            subgroup.groupPath == "smvgroup/inner"
            widerGroup.reason == "policyRefused"
            widerRepository.reason == "policyRefused"
            asMade == "SmvPrivate"
            anonymous.kind == "NotFound"
            member.repository.visibility == "public"
            member.repository.effectiveVisibility == "members"
        }
    }
)

feature("a list has only what the caller may view, and a group's counts are of that", {
    when() {
        const list = (username, more = {}) =>
            lib
                .op(username, SITE, "findRepositories", {groupId: ids.group, includeSubgroups: "true", ...more})
                .repositoryList.map(r => r.slug)
        const first = lib.op("SMV_MEMBER", SITE, "findRepositories", {groupId: ids.group, includeSubgroups: "true", limit: "2"})
        return {
            anonymous: list(null),
            member: list("SMV_MEMBER"),
            guest: list("SMV_GUEST"),
            // a page ends where the next begins, and a typed % or _ is no wildcard
            paged: [first.repositoryList.map(r => r.slug), list("SMV_MEMBER", {limit: "2", cursor: first.nextCursor})],
            searched: [
                list("SMV_MEMBER", {query: "MEMB"}),
                list("SMV_MEMBER", {query: "smv_"}),
                list("SMV_MEMBER", {query: "%"})
            ],
            anonymousGroup: lib.op(null, SITE, "getGroup", {groupId: ids.group}).group,
            memberGroup: lib.op("SMV_MEMBER", SITE, "getGroup", {groupId: ids.group}).group,
            groups: lib.op(null, SITE, "findGroups", {parentGroupId: ids.group}).groupList.length
        }
    },
    then({anonymous, member, guest, paged, searched, anonymousGroup, memberGroup, groups}) {
        anonymous == ["smv-public"]
        member == ["inside", "smv-members", "smv-public"]
        guest == ["smv-private", "smv-public"]
        paged == [["inside", "smv-members"], ["smv-public"]]
        searched == [["smv-members"], [], []]
        anonymousGroup.repositoryCount == 1
        anonymousGroup.subgroupCount == 0
        memberGroup.repositoryCount == 2
        memberGroup.subgroupCount == 1
        groups == 0
    }
})

feature("a hidden repository is Not Found to all but its Owners and the site's staff", {
    when() {
        lib.set("mantle.smithy.SmithyRepository", {repositoryId: ids.public}, {hiddenAt: ec.user.nowTimestamp})
        return {
            anonymous: view(null, ids.public),
            member: view("SMV_MEMBER", ids.public),
            owner: view("SMV_OWNER", ids.public),
            operator: view(lib.OPERATOR, ids.public),
            git: lib.authz("", ids.public, "VIEW")
        }
    },
    then({anonymous, member, owner, operator, git}) {
        anonymous.kind == "NotFound"
        member.kind == "NotFound"
        owner.repository.hidden == true
        operator.repository.hidden == true
        git == "AUTHZT_NONE"
    },
    cleanup() {
        lib.set("mantle.smithy.SmithyRepository", {repositoryId: ids.public}, {hiddenAt: null})
    }
})

feature("a group that is not active is Not Found to all but its requester and the operators", {
    when() {
        lib.set("mantle.smithy.SmithyGroup", {groupId: ids.group}, {statusId: "SmgRequested", requestedByPartyId: "SMV_OWNER"})
        return {
            anonymous: lib.op(null, SITE, "getGroup", {groupId: ids.group}),
            repository: view(null, ids.public),
            requester: lib.op("SMV_OWNER", SITE, "getGroup", {groupId: ids.group}),
            operator: lib.op(lib.OPERATOR, SITE, "getGroup", {groupId: ids.group})
        }
    },
    then({anonymous, repository, requester, operator}) {
        anonymous.kind == "NotFound"
        repository.kind == "NotFound"
        requester.group.status == "requested"
        operator.group.status == "requested"
    },
    cleanup() {
        lib.set("mantle.smithy.SmithyGroup", {groupId: ids.group}, {statusId: "SmgActive"})
    }
})

feature("everything is Not Found on a site that is not published", {
    when() {
        const before = view(null, ids.public)
        lib.set("mantle.public.PublicSite", {siteId: SITE}, {state: "disabled"})
        return {
            before,
            anonymous: view(null, ids.public),
            member: view("SMV_MEMBER", ids.members),
            git: lib.authz("", ids.public, "VIEW")
        }
    },
    then({before, anonymous, member, git}) {
        before.repository.repositoryId == ids.public
        anonymous.kind == "NotFound"
        member.kind == "NotFound"
        git == "AUTHZT_NONE"
    },
    cleanup() {
        lib.set("mantle.public.PublicSite", {siteId: SITE}, {state: "published"})
    }
})
