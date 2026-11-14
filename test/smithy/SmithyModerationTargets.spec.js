// Report and Hide, and the day's limits of Smithy's kinds (mr-pass plan/design-smithy.md §12.2, §12.3, §15.7;
// plans/Dogfood.md §5.9, §6.4; SmithyForum.js reportSmithyTarget and hideSmithyTarget, SmithyScope.js targetModerator and
// decideTarget, SmithyCore.js mayHide and viewable, ForumCore.js gate): a report on a repository or a group by an account
// with a confirmed address files one review item (target type repository or group) in the queue of the scope above it,
// each account's report kept; who decides it and who hides is the site's staff and an Owner of a group above, never a
// role on the target itself; a hidden repository or group is Not Found to all but its Owners and the site's staff, on the
// pages and in git; what the site's staff hid, an Owner does not show again; and a new account makes one repository,
// two forks and five pipeline runs a day. Spec-local site, group, db repositories and accounts. Regression suite: these
// are rules. Run: ./moq test mr-mantle --spec SmithyModerationTargets
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const SITE = "SMT_SITE"
const ids = {}
const op = (username, operation, input) => lib.op(username, SITE, operation, input)
const kind = out => out.kind || null
const repository = () => lib.row("mantle.smithy.SmithyRepository", {repositoryId: ids.repositoryId})
const group = () => lib.row("mantle.smithy.SmithyGroup", {groupId: ids.groupId})
const hide = (username, targetType, hidden, reason = "Looks like abuse") =>
    op(username, "hideSmithyTarget", {
        targetType,
        targetId: targetType === "group" ? ids.groupId : ids.repositoryId,
        hidden,
        reason,
        expectedRevision: Number((targetType === "group" ? group() : repository()).revision || 1)
    })
const report = (username, targetType, operationId) => {
    lib.settled(SITE, username)
    return op(username, "reportSmithyTarget", {
        targetType,
        targetId: targetType === "group" ? ids.groupId : ids.repositoryId,
        reason: "Spam",
        note: "It only links to a shop",
        operationId
    })
}
const items = targetType =>
    Array.from(
        ec.entity
            .find("mantle.forum.ForumReviewItem")
            .condition({siteId: SITE, targetType, targetId: targetType === "group" ? ids.groupId : ids.repositoryId})
            .disableAuthz()
            .list()
    )
const queue = (username, input) => (op(username, "findReviews", input).reviewList || []).map(item => item.targetType)

spec({
    requires: ["git"],
    setupSpec() {
        login(lib.OPERATOR)
        lib.site(SITE)
        Object.assign(ids, lib.tracker(SITE, "SMT", "smtgroup"))
        lib.account(SITE, "SMT_MOD", {member: true, siteRole: "moderator"})
        lib.account(SITE, "SMT_UNCONFIRMED", {handle: "smtunconfirmed", unconfirmed: true})
        // an Owner of the repository alone, by its own row
        lib.account(SITE, "SMT_REPO_OWNER", {handle: "smtrepoowner"})
        lib.role(SITE, {repositoryId: ids.repositoryId}, "SMT_REPO_OWNER", "SmrOwner")
        lib.account(SITE, "SMT_NEW", {handle: "smtnew"})
        lib.settings(SITE, {repositoryCreateEnumId: "ScpVerified", forkCreateEnumId: "ScpVerified", defaultMaxRepositories: 10})
    }
})

feature("a report files one item in the queue of the scope above its target, and each account's report is kept", {
    when() {
        const first = report("SMT_STRANGER", "repository", "smt-report-1")
        const second = report("SMT_AUTHOR", "repository", "smt-report-2")
        const again = report("SMT_AUTHOR", "repository", "smt-report-3")
        const ofGroup = report("SMT_STRANGER", "group", "smt-report-4")
        const item = items("repository")[0]
        return {
            first,
            second,
            again,
            unconfirmed: op("SMT_UNCONFIRMED", "reportSmithyTarget", {
                targetType: "repository",
                targetId: ids.repositoryId,
                reason: "Spam",
                operationId: "smt-report-5"
            }),
            count: items("repository").length,
            scope: item.contactListId === group().contactListId,
            reports: ec.entity.find("mantle.forum.ForumReviewReport").condition("reviewId", item.reviewId).disableAuthz().count(),
            // the group's Owner decides a report on a repository of the group; an Owner of the repository alone does not
            owner: queue("SMT_OWNER", {scopeContactListId: group().contactListId}),
            ownerView: op("SMT_OWNER", "getReview", {reviewId: item.reviewId}),
            repositoryOwner: kind(op("SMT_REPO_OWNER", "getReview", {reviewId: item.reviewId})),
            // a report on a top-level group is the site's staff's: its own Owner neither reads nor decides it
            ofGroup,
            groupScope: items("group")[0].contactListId,
            ownGroup: kind(op("SMT_OWNER", "getReview", {reviewId: items("group")[0].reviewId})),
            staff: queue("SMT_MOD", {}).sort()
        }
    },
    then({
        first,
        second,
        again,
        unconfirmed,
        count,
        scope,
        reports,
        owner,
        ownerView,
        repositoryOwner,
        ofGroup,
        groupScope,
        ownGroup,
        staff
    }) {
        first.reported == true
        second.reported == true
        again.reported == true
        unconfirmed.reason == "addressUnconfirmed"
        count == 1
        scope == true
        reports == 2
        owner == ["repository"]
        ownerView.target.path == "smtgroup/code"
        ownerView.reports.length == 2
        repositoryOwner == "Unauthorized"
        ofGroup.reported == true
        groupScope == null
        ownGroup == "Unauthorized"
        staff == ["group", "repository"]
    }
})

feature(
    "a hidden repository is Not Found to all but its Owners and the site's staff, in git too; what staff hid an Owner does not show",
    {
        when() {
            const seen = () => ({
                stranger: kind(op("SMT_STRANGER", "getRepository", {repositoryId: ids.repositoryId})),
                anonymous: kind(op(null, "resolveSmithyPath", {path: "smtgroup/code"})),
                owner: kind(op("SMT_REPO_OWNER", "getRepository", {repositoryId: ids.repositoryId})),
                moderator: kind(op("SMT_MOD", "getRepository", {repositoryId: ids.repositoryId})),
                git: [
                    lib.authz("SMT_STRANGER", ids.repositoryId, "VIEW"),
                    lib.authz("", ids.repositoryId, "VIEW"),
                    lib.authz("SMT_REPO_OWNER", ids.repositoryId, "VIEW")
                ]
            })
            const before = seen()
            const maintainer = hide("SMT_MAINT", "repository", true)
            const repositoryOwner = hide("SMT_REPO_OWNER", "repository", true)
            const hidden = hide("SMT_OWNER", "repository", true)
            const while_ = seen()
            const shown = hide("SMT_OWNER", "repository", false, "A mistake")
            const after = seen()
            // the site's moderator decides the report: rejected hides it
            const item = items("repository")[0]
            const decided = op("SMT_MOD", "decideReview", {
                reviewId: item.reviewId,
                expectedRevision: Number(lib.row("mantle.forum.ForumReviewItem", {reviewId: item.reviewId}).revision),
                decision: "rejected",
                reason: "It is spam"
            })
            const byStaff = !!repository().hiddenAt
            const ownerShows = hide("SMT_OWNER", "repository", false, "Please")
            const staffShows = hide("SMT_MOD", "repository", false, "Cleaned up")
            return {
                before,
                maintainer,
                repositoryOwner,
                hidden,
                while_,
                shown,
                after,
                decided,
                byStaff,
                ownerShows,
                staffShows,
                log: Array.from(
                    ec.entity
                        .find("mantle.forum.ForumModerationAction")
                        .condition({siteId: SITE, targetType: "repository", targetId: ids.repositoryId})
                        .condition("action", "in", ["hide", "hide-staff", "unhide"])
                        .orderBy("createdAt")
                        .disableAuthz()
                        .list()
                ).map(action => action.action + " " + (action.contactListId === group().contactListId))
            }
        },
        then({before, maintainer, repositoryOwner, hidden, while_, shown, after, decided, byStaff, ownerShows, staffShows, log}) {
            before.stranger == null
            before.git[0] == before.git[2]
            // never by a role on the target itself
            maintainer.reason == "accessDenied"
            repositoryOwner.reason == "accessDenied"
            hidden.hidden == true
            while_.stranger == "NotFound"
            while_.anonymous == "NotFound"
            while_.owner == null
            while_.moderator == null
            // in git: a stranger and no user are answered as for a repository that is not there, its Owner as before
            while_.git[0] != before.git[0]
            while_.git[1] != before.git[1]
            while_.git[2] == before.git[2]
            shown.hidden == false
            after == before
            decided.state == "rejected"
            byStaff == true
            ownerShows.reason == "accessDenied"
            staffShows.hidden == false
            log.sort() == ["hide true", "hide-staff true", "unhide true", "unhide true"].sort()
        }
    }
)

feature("a hidden group hides what is in it; its own Owner does not hide it, the site's staff do", {
    when() {
        const owner = hide("SMT_OWNER", "group", true)
        const staff = hide("SMT_MOD", "group", true)
        const hidden = {
            group: kind(op("SMT_STRANGER", "getGroup", {groupId: ids.groupId})),
            repository: kind(op("SMT_STRANGER", "getRepository", {repositoryId: ids.repositoryId})),
            issues: kind(op("SMT_STRANGER", "findIssues", {repositoryId: ids.repositoryId})),
            git: lib.authz("SMT_STRANGER", ids.repositoryId, "VIEW") == lib.authz("SMT_OWNER", ids.repositoryId, "VIEW"),
            owner: op("SMT_OWNER", "getGroup", {groupId: ids.groupId}).group?.hidden
        }
        const shown = hide("SMT_MOD", "group", false, "Reviewed")
        return {owner, staff, hidden, shown, after: kind(op("SMT_STRANGER", "getGroup", {groupId: ids.groupId}))}
    },
    then({owner, staff, hidden, shown, after}) {
        owner.reason == "accessDenied"
        staff.hidden == true
        hidden == {group: "NotFound", repository: "NotFound", issues: "NotFound", git: false, owner: true}
        shown.hidden == false
        after == null
    }
})

feature(
    "a new account makes one repository, two forks and five pipeline runs a day; a higher trust level, and the scope's own, more",
    {
        when() {
            const create = (username, slug) =>
                op(username, "createRepository", {
                    slug,
                    visibility: "public",
                    operationId: "smt-" + username.toLowerCase() + "-" + slug
                })
            const fork = (username, slug) =>
                op(username, "forkRepository", {repositoryId: ids.repositoryId, slug, operationId: "smt-fork-" + slug})
            const run = userId =>
                lib.run("mantle.smithy.SmithyServices.count#PipelineRun", {repositoryId: ids.repositoryId, userId})
            const first = create("SMT_NEW", "one")
            const second = create("SMT_NEW", "two")
            const forks = ["f1", "f2", "f3"].map(slug => fork("SMT_NEW", slug))
            const runs = [1, 2, 3, 4, 5, 6].map(() => run("SMT_NEW").allowed)
            // the tracker's accounts are past their first posts (basic): three repositories a day
            const basic = ["b1", "b2", "b3", "b4"].map(slug => kind(create("SMT_STRANGER", slug)))
            return {
                first,
                second,
                forks,
                runs,
                refusedRun: run("SMT_NEW"),
                basic,
                maintainer: [1, 2, 3, 4, 5, 6, 7].map(() => run("SMT_MAINT").allowed).every(allowed => allowed === true),
                counts: JSON.parse(lib.row("mantle.forum.ForumMemberState", {siteId: SITE, partyId: "SMT_NEW"}).dailyCounts)
            }
        },
        then({first, second, forks, runs, refusedRun, basic, maintainer, counts}) {
            first.repositoryPath == "smtnew/one"
            second.kind == "Tarpit"
            second.reason == "limitReached"
            forks.map(fork => fork.reason || fork.repositoryPath) == ["smtnew/f1", "smtnew/f2", "limitReached"]
            runs == [true, true, true, true, true, false]
            refusedRun.reason == "limitReached"
            basic == [null, null, null, "Tarpit"]
            maintainer == true
            counts == {repository: 1, fork: 2, pipelineRun: 5}
        }
    }
)
