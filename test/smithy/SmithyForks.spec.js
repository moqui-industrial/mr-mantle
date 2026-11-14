// Smithy's forks and the push to review (mr-pass plan/design-smithy.md §9.2, §9.3, §5.5; SmithyReviews.js, SmithyGit.js): who
// may fork is the site's policy, within the account's count of repositories and the name set; a fork names its parent,
// is no wider than it, and narrows when the parent does; a repository with forks is not deleted; a fork is compared
// with its parent, and a merge request from it is opened by who may push to the fork; a commit of a private fork is
// Not Found by its id at the public parent; the push gate holds a push to refs/for/<branch> by an account without
// Developer to a confirmed address, the caps and the day's limit. Spec-local site, accounts and db repositories.
// Regression suite: these are rules. Run: ./moq test mr-mantle --spec SmithyForks
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const SITE = "SMF_SITE"
const ids = {}
const op = (username, operation, input) => lib.op(username, SITE, operation, input)
const fork = (username, repositoryId, more = {}) =>
    op(username, "forkRepository", {repositoryId, operationId: "smf-fork-" + ec.user.randomString(10), ...more})
const repository = (username, repositoryId) => op(username, "getRepository", {repositoryId})
const push = (userId, packBytes, repositoryId = ids.code) =>
    lib.gate("Push", {
        repositoryId,
        userId,
        packBytes,
        forReview: true,
        refUpdates: [{refName: "refs/for/main", forReview: true, targetBranch: "main"}]
    })
const refusedFor = problems => problems.map(problem => (/^([a-zA-Z]+): /.exec(problem) || [])[1] || problem)

spec({
    requires: ["git"],
    setupSpec() {
        login(lib.OPERATOR)
        lib.site(SITE)
        lib.settings(SITE, {forkCreateEnumId: "ScpOperators", defaultMaxRepositories: 2})
        for (const name of ["SMF_STRANGER", "SMF_MEMBER", "SMF_OTHER", "SMF_DEV"]) {
            lib.account(SITE, name, {member: true, handle: name.toLowerCase().replace("_", "")})
            lib.settled(SITE, name)
        }
        lib.account(SITE, "SMF_UNCONFIRMED", {unconfirmed: true})
        ids.groupId = lib.createGroup(lib.OPERATOR, {siteId: SITE, pathSegment: "smfgroup", visibility: "public"}).groupId
        const make = (slug, visibility) => {
            const repositoryId = lib.createRepository(lib.OPERATOR, {
                siteId: SITE,
                groupId: ids.groupId,
                slug,
                visibility
            }).repositoryId
            lib.commit(repositoryId, "Start", {"README.md": "# " + slug + "\n"})
            return repositoryId
        }
        ids.code = make("code", "public")
        ids.inside = make("inside", "members")
        lib.role(SITE, {repositoryId: ids.code}, "SMF_DEV", "SmrDeveloper")
    }
})

feature("who may fork is the site's policy, within the account's count and the name set; a fork names its parent", {
    when() {
        const refused = fork("SMF_STRANGER", ids.code)
        lib.settings(SITE, {forkCreateEnumId: "ScpVerified"})
        const first = fork("SMF_STRANGER", ids.code)
        const taken = fork("SMF_STRANGER", ids.code)
        const second = fork("SMF_STRANGER", ids.code, {slug: "quiet", visibility: "private"})
        const third = fork("SMF_STRANGER", ids.code, {slug: "more"})
        ids.fork = first.repositoryId
        ids.quiet = second.repositoryId
        return {
            refused,
            first,
            taken,
            second,
            third,
            unconfirmed: fork("SMF_UNCONFIRMED", ids.code),
            mine: repository("SMF_STRANGER", first.repositoryId),
            parent: repository(null, ids.code).repository.forkCount,
            parentForOwner: repository("SMF_STRANGER", ids.code).repository.forkCount,
            forks: op(null, "findForks", {repositoryId: ids.code}).repositoryList.map(row => row.repositoryPath),
            hosted: lib.row("moqui.resource.GitRepository", {repositoryId: first.repositoryId})
        }
    },
    then({refused, first, taken, second, third, unconfirmed, mine, parent, parentForOwner, forks, hosted}) {
        refused.reason == "policyRefused"
        first.repositoryPath == "smfstranger/code"
        taken.reason == "nameTaken"
        second.repositoryPath == "smfstranger/quiet"
        // the account's count of personal repositories holds a fork too
        third.reason == "quotaExceeded"
        unconfirmed.reason == "addressUnconfirmed"
        hosted.forkOfRepositoryId == ids.code
        mine.repository.forkOf.repositoryPath == "smfgroup/code"
        mine.repository.visibility == "public"
        mine.repository.features.issues == false
        mine.repository.features.mergeRequests == true
        mine.myRole == "owner"
        // the forks a caller may view: the private one is its owner's
        parent == 1
        parentForOwner == 2
        forks == ["smfstranger/code"]
    }
})

feature(
    "a fork is no wider than its parent and is viewed with it; a private parent is forked by who works in it and not deleted while it has forks",
    {
        when() {
            // a repository that is not public is forked by a Developer of it
            const byMember = fork("SMF_OTHER", ids.inside)
            lib.role(SITE, {repositoryId: ids.inside}, "SMF_MEMBER", "SmrDeveloper")
            const made = fork("SMF_MEMBER", ids.inside, {visibility: "public"})
            const before = repository("SMF_MEMBER", made.repositoryId).repository
            const widen = op("SMF_MEMBER", "setRepositoryVisibility", {
                repositoryId: made.repositoryId,
                visibility: "public",
                expectedRevision: before.revision
            })
            const seenBefore = repository("SMF_OTHER", made.repositoryId)
            lib.set("mantle.smithy.SmithyRepository", {repositoryId: ids.inside}, {visibilityEnumId: "SmvPrivate"})
            const parent = repository(lib.OPERATOR, ids.inside).repository
            const after = repository("SMF_MEMBER", made.repositoryId).repository
            const seenAfter = repository("SMF_OTHER", made.repositoryId)
            // a role on the fork gives nothing the parent does not
            lib.role(SITE, {repositoryId: made.repositoryId}, "SMF_OTHER", "SmrDeveloper")
            const withRole = repository("SMF_OTHER", made.repositoryId)
            // the forker's role on the parent ends: the fork is no longer theirs to see, in git either
            lib.set(
                "mantle.smithy.SmithyRepositoryParty",
                {repositoryId: ids.inside, partyId: "SMF_MEMBER"},
                {thruDate: ec.user.timestampMillis(ec.user.nowTimestamp) - 500}
            )
            return {
                byMember,
                made,
                before,
                widen,
                seenBefore,
                after,
                seenAfter,
                withRole,
                lost: repository("SMF_MEMBER", made.repositoryId),
                git: lib.authz("SMF_MEMBER", made.repositoryId, "VIEW"),
                operator: repository(lib.OPERATOR, made.repositoryId),
                remove: op(lib.OPERATOR, "deleteRepository", {
                    repositoryId: ids.inside,
                    confirmPath: "smfgroup/inside",
                    expectedRevision: parent.revision
                })
            }
        },
        then({byMember, made, before, widen, seenBefore, after, seenAfter, withRole, lost, git, operator, remove}) {
            byMember.reason == "accessDenied"
            made.repositoryPath == "smfmember/inside"
            // asked public, of a members-only parent
            before.visibility == "members"
            widen.reason == "policyRefused"
            seenBefore.repository.repositoryPath == "smfmember/inside"
            // the parent is private now: the fork is seen by who sees the parent
            after.effectiveVisibility == "private"
            after.forkOf.repositoryPath == "smfgroup/inside"
            seenAfter.kind == "NotFound"
            withRole.kind == "NotFound"
            lost.kind == "NotFound"
            git == "AUTHZT_NONE"
            // the repository is kept: an operator sees it
            operator.repository.repositoryPath == "smfmember/inside"
            remove.kind == "Conflict"
        }
    }
)

feature(
    "a fork is compared with its parent; a merge request from it is by who may push to the fork; a private fork's commit is not read at the parent",
    {
        when() {
            const save = (repositoryId, path) =>
                op("SMF_STRANGER", "commitFile", {
                    repositoryId,
                    branch: "main",
                    action: "create",
                    path,
                    content: "From a fork\n",
                    message: "Add " + path,
                    destination: "branch",
                    operationId: "smf-save-" + ec.user.randomString(10)
                })
            const saved = save(ids.fork, "fix.txt")
            const hidden = save(ids.quiet, "secret.txt")
            lib.settled(SITE, "SMF_STRANGER")
            lib.settle(ids.fork)
            const compare = op(null, "getCompare", {
                repositoryId: ids.code,
                base: "main",
                head: "main",
                headRepositoryPath: "smfstranger/code"
            })
            const open = (username, operationId) =>
                op(username, "createMergeRequest", {
                    repositoryId: ids.code,
                    sourceRepositoryId: ids.fork,
                    sourceRef: "main",
                    targetRef: "main",
                    title: "A fix from a fork",
                    body: "As promised",
                    operationId
                })
            const byOther = open("SMF_OTHER", "smf-open-other")
            const opened = open("SMF_STRANGER", "smf-open-mine")
            // a second one from a branch of the fork: who merges it may not delete a branch of somebody else's fork
            const topic = op("SMF_STRANGER", "commitFile", {
                repositoryId: ids.fork,
                branch: "main",
                action: "create",
                path: "topic.txt",
                content: "A topic\n",
                destination: "newBranch",
                newBranchName: "topic",
                operationId: "smf-topic-0001"
            })
            lib.settled(SITE, "SMF_STRANGER")
            const second = op("SMF_STRANGER", "createMergeRequest", {
                repositoryId: ids.code,
                sourceRepositoryId: ids.fork,
                sourceRef: "topic",
                targetRef: "main",
                title: "A topic",
                operationId: "smf-open-topic"
            })
            const revisionOf = () =>
                op(lib.OPERATOR, "getMergeRequest", {repositoryId: ids.code, mergeRequestNum: second.mergeRequestNum})
                    .mergeRequest.revision
            const flag = username =>
                op(username, "updateMergeRequest", {
                    repositoryId: ids.code,
                    mergeRequestNum: second.mergeRequestNum,
                    deleteSourceBranch: true,
                    expectedRevision: revisionOf()
                })
            const flagByDeveloper = flag("SMF_DEV")
            const flagByAuthor = flag("SMF_STRANGER")
            const mergedTopic = op("SMF_DEV", "mergeMergeRequest", {
                repositoryId: ids.code,
                mergeRequestNum: second.mergeRequestNum,
                deleteSourceBranch: true,
                expectedRevision: revisionOf()
            })
            const branchesOf = () =>
                op("SMF_STRANGER", "findRefs", {repositoryId: ids.fork, refType: "branch", namesOnly: true}).refList.map(
                    ref => ref.name
                )
            const forkBranches = branchesOf()
            // a third, merged by one who is a Developer of the target and of the fork: the fork's branch goes, by Smithy's
            // roles (the account holds no right of the git host's own on the fork)
            op("SMF_STRANGER", "commitFile", {
                repositoryId: ids.fork,
                branch: "main",
                action: "create",
                path: "gone.txt",
                content: "Goes\n",
                destination: "newBranch",
                newBranchName: "gone",
                operationId: "smf-gone-0001"
            })
            lib.settled(SITE, "SMF_STRANGER")
            const third = op("SMF_STRANGER", "createMergeRequest", {
                repositoryId: ids.code,
                sourceRepositoryId: ids.fork,
                sourceRef: "gone",
                targetRef: "main",
                title: "Gone after",
                operationId: "smf-open-gone"
            })
            lib.role(SITE, {repositoryId: ids.code}, "SMF_STRANGER", "SmrDeveloper")
            const mergedGone = op("SMF_STRANGER", "mergeMergeRequest", {
                repositoryId: ids.code,
                mergeRequestNum: third.mergeRequestNum,
                deleteSourceBranch: true,
                expectedRevision: op(lib.OPERATOR, "getMergeRequest", {
                    repositoryId: ids.code,
                    mergeRequestNum: third.mergeRequestNum
                }).mergeRequest.revision
            })
            const branchesAfter = branchesOf()
            return {
                mergedGone,
                branchesAfter,
                saved,
                hidden,
                compare,
                byOther,
                opened,
                topic,
                flagByDeveloper,
                flagByAuthor,
                mergedTopic,
                forkBranches,
                read: op(null, "getMergeRequest", {repositoryId: ids.code, mergeRequestNum: opened.mergeRequestNum}),
                hosted: lib.row("moqui.resource.GitMergeRequest", {
                    repositoryId: ids.code,
                    mergeRequestNum: opened.mergeRequestNum
                }),
                // by its id: the fork's own commit at the fork, the merge request's at the parent, the private fork's nowhere else
                atFork: op(null, "getCommit", {repositoryId: ids.fork, commitId: saved.commitId}),
                atParent: op(null, "getCommit", {repositoryId: ids.code, commitId: saved.commitId}),
                privateAtParent: op(null, "getCommit", {repositoryId: ids.code, commitId: hidden.commitId}),
                privateAtFork: op("SMF_STRANGER", "getCommit", {repositoryId: ids.quiet, commitId: hidden.commitId})
            }
        },
        then({
            saved,
            hidden,
            compare,
            byOther,
            opened,
            topic,
            flagByDeveloper,
            flagByAuthor,
            mergedTopic,
            forkBranches,
            mergedGone,
            branchesAfter,
            read,
            hosted,
            atFork,
            atParent,
            privateAtParent,
            privateAtFork
        }) {
            mergedGone.state == "merged"
            branchesAfter.includes("topic")
            !branchesAfter.includes("gone")
            topic.branch == "topic"
            // the fork's branch is its owner's: only the author says it goes, and a merger with no role there deletes nothing
            flagByDeveloper.reason == "accessDenied"
            flagByAuthor.revision > 0
            mergedTopic.state == "merged"
            forkBranches.includes("topic")
            saved.destination == "branch"
            compare.aheadBy == 1
            compare.commitList.map(commit => commit.summary) == ["Add fix.txt"]
            // the account wrote and brought the commit: its handle is told
            compare.commitList[0].authorHandle == "smfstranger"
            byOther.reason == "accessDenied"
            opened.state == "published"
            read.mergeRequest.sourceRepositoryPath == "smfstranger/code"
            read.mergeRequest.headCommitId == saved.commitId
            hosted.sourceRepositoryId == ids.fork
            // it started hidden in the git host, and is shown once its text passed the gate
            hosted.hiddenDate == null
            atFork.commit.summary == "Add fix.txt"
            atFork.refList.map(ref => ref.name).includes("main")
            atParent.commit.summary == "Add fix.txt"
            privateAtFork.commit.summary == "Add secret.txt"
            privateAtParent.kind == "NotFound"
        }
    }
)

feature(
    "the push gate holds a push to review to a confirmed address, a repository that takes merge requests, the caps and the day's limit",
    {
        when() {
            // the day as the gate keeps it, read again after the push it decides: a run across midnight UTC sets it again
            const dayNow = () => ec.resource.script("component://mr-mantle/service/mantle/forum/ForumCore.js").dayKey()
            let day
            let limited
            const fine = push("SMF_OTHER", 1000)
            const large = push("SMF_OTHER", 60 * 1048576)
            const developer = push("SMF_DEV", 60 * 1048576)
            do {
                day = dayNow()
                lib.set(
                    "mantle.forum.ForumMemberState",
                    {siteId: SITE, partyId: "SMF_OTHER"},
                    {dayKey: day, dailyCounts: JSON.stringify({mergeRequest: 10})}
                )
                limited = push("SMF_OTHER", 1000)
            } while (dayNow() !== day)
            // a push to a topic the account has no merge request open for opens one more; the one it has open takes a push
            const topic = (userId, pushOptions) =>
                lib.gate("Push", {
                    repositoryId: ids.code,
                    userId,
                    packBytes: 1000,
                    forReview: true,
                    pushOptions,
                    refUpdates: [{refName: "refs/for/main", forReview: true, targetBranch: "main"}]
                })
            lib.make("moqui.resource.GitMergeRequest", {
                mergeRequestId: "SMF_PUSHED",
                repositoryId: ids.code,
                mergeRequestNum: 900,
                title: "Pushed",
                sourceRef: "refs/merge-requests/900/head",
                targetRef: "main",
                statusId: "GmrOpen",
                authorUserId: "SMF_OTHER",
                pushedForReview: "Y",
                hiddenDate: ec.user.nowTimestamp
            })
            const sameTopic = topic("SMF_OTHER", [])
            const otherTopic = topic("SMF_OTHER", ["topic=second"])
            const mine = push("SMF_STRANGER", 1000)
            lib.set("mantle.smithy.SmithyRepository", {repositoryId: ids.code}, {mergeRequestsEnabled: "N"})
            let closed
            try {
                closed = push("SMF_STRANGER", 1000)
            } finally {
                lib.set("mantle.smithy.SmithyRepository", {repositoryId: ids.code}, {mergeRequestsEnabled: "Y"})
            }
            return {
                fine,
                large,
                developer,
                limited,
                sameTopic,
                otherTopic,
                mine,
                closed,
                unconfirmed: push("SMF_UNCONFIRMED", 1000),
                unseen: push("SMF_OTHER", 1000, ids.quiet),
                day
            }
        },
        then({fine, large, developer, limited, sameTopic, otherTopic, mine, closed, unconfirmed, unseen}) {
            fine == []
            refusedFor(large) == ["quotaExceeded"]
            // a Developer could push a branch: a push for review is held as one, to the repository's own limit
            developer == []
            refusedFor(limited) == ["limitReached"]
            // at the day's limit: a push to the merge request it has open is taken, one that names another topic opens another
            sameTopic == []
            refusedFor(otherTopic) == ["limitReached"]
            mine == []
            closed.length == 1
            unconfirmed.length == 1
            unconfirmed[0].includes("confirmed email address")
            unseen == ["Repository not found"]
        }
    }
)
