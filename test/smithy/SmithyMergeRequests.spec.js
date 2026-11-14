// Smithy's merge requests (mr-pass plan/design-smithy.md §9.1, §5.3, §8.4, §15.5; SmithyReviews.js): a Developer opens one
// from a branch and anyone who views the repository reads it; its number is its own sequence, apart from the issues'; a
// viewer's review is a comment and a decision is a Developer's, never the author's own; a line comment is a post of the
// conversation with its anchor, read beside the comments Projects wrote before; a merge into a protected branch is a
// Maintainer's and into any other a Developer's; Fixes #n completes its issue on the merge; a held first text hides the
// merge request from all but its author and its moderators, in the git host too; !n and #n link what the reader may
// see; a private repository's merge request is Not Found. Spec-local site, accounts and db repositories. Regression
// suite: these are rules. Run: ./moq test mr-mantle --spec SmithyMergeRequests
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const SITE = "SMQ_SITE"
const ids = {}
const op = (username, operation, input) => lib.op(username, SITE, operation, {repositoryId: ids.repositoryId, ...input})
const request = (username, mergeRequestNum) => op(username, "getMergeRequest", {mergeRequestNum})
const revision = mergeRequestNum => request(lib.OPERATOR, mergeRequestNum).mergeRequest.revision
const hosted = mergeRequestNum =>
    lib.row("moqui.resource.GitMergeRequest", {repositoryId: ids.repositoryId, mergeRequestNum})
const branch = (repositoryId, name, path) =>
    lib.run("org.moqui.git.GitServices.commit#GitFiles", {
        repositoryId,
        message: "Add " + path,
        fileMap: {[path]: "one\ntwo\nthree\n"},
        branch: "main",
        newBranch: name
    })
const open = (username, sourceRef, more = {}) =>
    op(username, "createMergeRequest", {sourceRef, title: "Merge " + sourceRef, operationId: "smq-open-" + sourceRef, ...more})

spec({
    requires: ["git"],
    setupSpec() {
        login(lib.OPERATOR)
        lib.site(SITE)
        Object.assign(ids, lib.tracker(SITE, "SMQ", "smqgroup"))
        for (const name of ["SMQ_DEV", "SMQ_NEW"]) lib.account(SITE, name, {handle: name.toLowerCase().replace("_", "")})
        lib.settled(SITE, "SMQ_DEV")
        lib.role(SITE, {repositoryId: ids.repositoryId}, "SMQ_DEV", "SmrDeveloper")
        lib.commit(ids.repositoryId, "Start", {"README.md": "# Code\n"})
        for (const name of ["feature", "second", "third", "fourth"]) branch(ids.repositoryId, name, name + ".txt")
        lib.run("org.moqui.git.GitServices.create#GitRef", {repositoryId: ids.repositoryId, refName: "staging", refType: "branch"})
        // main changes through a merge request; staging has no rule
        lib.run("org.moqui.git.GitServices.store#GitBranchRule", {
            repositoryId: ids.repositoryId,
            refPattern: "main",
            requireMergeRequest: "Y",
            allowForcePush: "N",
            allowDelete: "N"
        })
        // a private repository of the same group, with a merge request of its own
        ids.privateId = lib.createRepository(lib.OPERATOR, {siteId: SITE, groupId: ids.groupId, slug: "inner", visibility: "private"}).repositoryId
        lib.commit(ids.privateId, "Start", {"README.md": "# Inner\n"})
        branch(ids.privateId, "quiet", "quiet.txt")
    }
})

feature("a Developer opens a merge request from a branch; its number is apart from the issues', and any viewer reads it", {
    when() {
        const issue = lib.file("SMQ_AUTHOR", SITE, ids.repositoryId, "A bug")
        lib.settled(SITE, "SMQ_AUTHOR")
        const byStranger = open("SMQ_STRANGER", "feature")
        const opened = open("SMQ_DEV", "feature", {body: "Fixes #" + issue.issueNumber + " with **care**"})
        const again = open("SMQ_DEV", "feature", {body: "Fixes #" + issue.issueNumber + " with **care**"})
        const twice = op("SMQ_DEV", "createMergeRequest", {sourceRef: "feature", title: "Again", operationId: "smq-open-twice"})
        return {
            issue,
            byStranger,
            opened,
            again,
            twice,
            read: request(null, 1),
            mine: request("SMQ_DEV", 1),
            list: op(null, "findMergeRequests", {}),
            unconfirmed: lib.op(null, SITE, "createMergeRequest", {repositoryId: ids.repositoryId, sourceRef: "second", title: "x", operationId: "smq-nobody-1"})
        }
    },
    then({issue, byStranger, opened, again, twice, read, mine, list, unconfirmed}) {
        // opening needs push to the source: a stranger has none on a branch of the repository itself
        byStranger.reason == "accessDenied"
        unconfirmed.kind == "AuthenticationRequired"
        issue.issueNumber == 1
        opened.mergeRequestNum == 1
        opened.state == "published"
        again.mergeRequestNum == 1
        twice.kind == "Conflict"
        read.mergeRequest.title == "Merge feature"
        read.mergeRequest.state == "open"
        read.mergeRequest.author.handle == "smqdev"
        read.mergeRequest.sourceRef == "feature"
        read.mergeRequest.targetRef == "main"
        read.mergeRequest.fetchRef == "refs/merge-requests/1/head"
        read.mergeRequest.agreementState == "off"
        read.agreement.required == false
        read.pending == false
        // the branch rule of main: a merge is a Maintainer's
        read.branchRules.protected == true
        read.branchRules.mergeRole == "maintainer"
        read.capabilities.canComment == false
        mine.capabilities.canEdit == true
        mine.capabilities.canApprove == false
        mine.capabilities.canMerge == false
        // the issue its text names after Fixes, to complete on the merge
        read.linkedIssues.map(link => [link.issueNumber, link.completeOnMerge]) == [[1, true]]
        list.counts == {open: 1, merged: 0, closed: 0}
        list.mergeRequestList.map(row => row.mergeRequestNum) == [1]
    }
})

feature("a viewer's review is a comment; a decision is a Developer's and never the author's own", {
    when() {
        const review = (username, decision, more = {}) =>
            op(username, "submitReview", {mergeRequestNum: 1, decision, operationId: "smq-review-" + username + decision, ...more})
        const comment = review("SMQ_STRANGER", "comment", {body: "Looks **plausible**"})
        lib.settled(SITE, "SMQ_STRANGER")
        return {
            comment,
            strangerApproves: review("SMQ_STRANGER", "approve"),
            strangerAsks: review("SMQ_STRANGER", "request_changes"),
            reporterApproves: review("SMQ_REPORTER", "approve"),
            authorApproves: review("SMQ_DEV", "approve"),
            unconfirmed: review("SMQ_UNCONFIRMED_NONE", "comment", {body: "x"}),
            maintainerApproves: review("SMQ_MAINT", "approve", {body: "Good"}),
            read: request("SMQ_STRANGER", 1)
        }
    },
    then({comment, strangerApproves, strangerAsks, reporterApproves, authorApproves, maintainerApproves, read}) {
        comment.state == "published"
        comment.reviewerState == "commented"
        strangerApproves.reason == "accessDenied"
        strangerAsks.reason == "accessDenied"
        reporterApproves.reason == "accessDenied"
        authorApproves.reason == "accessDenied"
        maintainerApproves.reviewerState == "approved"
        maintainerApproves.approvalCount == 1
        read.mergeRequest.approvalCount == 1
        read.reviewerList.map(reviewer => [reviewer.handle, reviewer.state]).sort() ==
            [
                ["smqmaint", "approved"],
                ["smqstranger", "commented"]
            ]
        // two summaries are comments; the approval is a line of the conversation
        read.mergeRequest.commentCount >= 2
    }
})

feature("a line comment is a post with its anchor, read beside the comments Projects wrote before", {
    when() {
        const line = op("SMQ_STRANGER", "createReviewComment", {
            mergeRequestNum: 1,
            path: "feature.txt",
            newLine: 2,
            body: "Why two?",
            operationId: "smq-line-0001"
        })
        lib.settled(SITE, "SMQ_STRANGER")
        const elsewhere = op("SMQ_STRANGER", "createReviewComment", {
            mergeRequestNum: 1,
            path: "feature.txt",
            newLine: 99,
            body: "No such line",
            operationId: "smq-line-0002"
        })
        lib.settled(SITE, "SMQ_DEV")
        const reply = op("SMQ_DEV", "createReviewComment", {mergeRequestNum: 1, threadId: line.threadId, body: "Because", operationId: "smq-line-0003"})
        // a thread as Projects wrote them before the merge request had a conversation: a Comment event filed on it
        const mergeRequestId = hosted(1).mergeRequestId
        const old = lib.make("mantle.party.communication.CommunicationEvent", {
            communicationEventTypeId: "Comment",
            statusId: "CeSent",
            fromPartyId: "SMQ_MAINT",
            entryDate: ec.user.nowTimestamp,
            contentType: "text/markdown",
            body: "An *older* note"
        }).communicationEventId
        lib.make("mantle.party.communication.CommunicationEventRecord", {
            communicationEventId: old,
            recordEntityName: "moqui.resource.GitMergeRequest",
            recordId: mergeRequestId
        })
        lib.make("mantle.party.communication.CommunicationEventGitAnchor", {
            communicationEventId: old,
            mergeRequestId,
            repositoryId: ids.repositoryId,
            path: "feature.txt",
            newLine: 1,
            outdated: "N"
        })
        // Projects' own comment on the merge request is now a post of the conversation
        lib.settled(SITE, "SMQ_MAINT")
        const fromProjects = lib.service("SMQ_MAINT", "mantle.work.GitServices.create#ReviewComment", {
            mergeRequestId,
            body: "From Projects",
            path: "feature.txt",
            newLine: 3
        })
        const threads = username => op(username, "getMergeRequestChanges", {mergeRequestNum: 1, withDiffs: true})
        const resolved = op("SMQ_DEV", "resolveReviewThread", {mergeRequestNum: 1, threadId: line.threadId, resolved: true})
        return {
            line,
            elsewhere,
            reply,
            old,
            fromProjects,
            resolved,
            anchor: lib.row("mantle.party.communication.CommunicationEventGitAnchor", {communicationEventId: line.postId}),
            post: lib.row("mantle.forum.ForumPostState", {communicationEventId: line.postId}),
            stranger: threads("SMQ_STRANGER"),
            developer: threads("SMQ_DEV"),
            projects: lib.run("mantle.work.GitServices.get#ReviewThreads", {mergeRequestId}).threadList
        }
    },
    then({line, elsewhere, reply, old, fromProjects, resolved, anchor, post, stranger, developer, projects}) {
        line.state == "published"
        elsewhere.kind == "Unprocessable"
        reply.threadId == line.threadId
        anchor.path == "feature.txt"
        Number(anchor.newLine) == 2
        anchor.lineText == "two"
        // a post of the merge request's conversation, as any comment is
        post.rootCommEventId == request(lib.OPERATOR, 1).mergeRequest.topic.rootCommEventId
        resolved.resolved == true
        stranger.fileList.map(file => file.path) == ["feature.txt"]
        stranger.commitList.length == 1
        stranger.commitList[0].signed == null
        stranger.fileDiffList.length == 1
        // a viewer reads the threads of posts; the team's older notes are a Developer's
        stranger.threadList.map(thread => thread.newLine) == [2, 3]
        stranger.threadList[0].postList.map(entry => entry.author.handle) == ["smqstranger", "smqdev"]
        stranger.threadList[0].resolved == true
        developer.threadList.map(thread => thread.newLine) == [1, 2, 3]
        fromProjects.refused != true
        lib.row("mantle.forum.ForumPostState", {communicationEventId: fromProjects.communicationEventId}) != null
        // Projects' read has both shapes, each said
        projects.map(thread => [Number(thread.newLine), thread.isPost, thread.commentList.length]) ==
            [
                [1, false, 1],
                [2, true, 2],
                [3, true, 1]
            ]
        projects[0].commentList[0].communicationEventId == old
        projects[1].commentList[0].bodyFormat == "html"
    }
})

feature("a merge into a protected branch is a Maintainer's, into any other a Developer's; Fixes #n completes its issue", {
    when() {
        const merge = (username, mergeRequestNum, more = {}) =>
            op(username, "mergeMergeRequest", {mergeRequestNum, expectedRevision: revision(mergeRequestNum), ...more})
        const byDeveloper = merge("SMQ_DEV", 1)
        const stale = merge("SMQ_MAINT", 1, {expectedHeadCommitId: "0".repeat(40)})
        const byMaintainer = merge("SMQ_MAINT", 1)
        const toStaging = open("SMQ_DEV", "second", {targetRef: "staging"})
        const byReporter = merge("SMQ_REPORTER", toStaging.mergeRequestNum)
        const own = merge("SMQ_DEV", toStaging.mergeRequestNum)
        return {
            byDeveloper,
            stale,
            byMaintainer,
            toStaging,
            byReporter,
            own,
            merged: request(null, 1),
            role: request(null, toStaging.mergeRequestNum).branchRules.mergeRole,
            issue: lib.op(null, SITE, "getIssue", {repositoryId: ids.repositoryId, issueNumber: 1}).issue,
            reopened: op("SMQ_DEV", "setMergeRequestState", {mergeRequestNum: 1, state: "open", expectedRevision: revision(1)}),
            list: op(null, "findMergeRequests", {state: "merged"})
        }
    },
    then({byDeveloper, stale, byMaintainer, toStaging, byReporter, own, merged, role, issue, reopened, list}) {
        byDeveloper.reason == "accessDenied"
        stale.kind == "Conflict"
        byMaintainer.state == "merged"
        merged.mergeRequest.state == "merged"
        merged.mergeRequest.mergedBy == "smqmaint"
        // the issue its text fixed is closed by the merge
        issue.state == "closed"
        toStaging.mergeRequestNum == 2
        role == "developer"
        byReporter.reason == "accessDenied"
        own.state == "merged"
        reopened.kind == "Conflict"
        list.counts == {open: 0, merged: 2, closed: 0}
    }
})

feature("a held first text hides the merge request from all but its author and its moderators, in the git host too", {
    when() {
        // an account with no role and no approved contribution proposes an edit: its text waits for a moderator
        const proposed = op("SMQ_NEW", "commitFile", {
            branch: "main",
            action: "create",
            path: "docs/new.md",
            content: "A first page\n",
            message: "Add a page\n\nSee !1 and #2, and #1.",
            operationId: "smq-propose-1"
        })
        const number = proposed.mergeRequestNum
        const before = {
            author: request("SMQ_NEW", number),
            stranger: request("SMQ_STRANGER", number),
            anonymous: request(null, number),
            maintainer: request("SMQ_MAINT", number),
            owner: request("SMQ_OWNER", number),
            changes: op("SMQ_STRANGER", "getMergeRequestChanges", {mergeRequestNum: number}),
            authorChanges: op("SMQ_NEW", "getMergeRequestChanges", {mergeRequestNum: number, withDiffs: true}),
            listed: op("SMQ_STRANGER", "findMergeRequests", {}).counts.open,
            mine: op("SMQ_NEW", "findMergeRequests", {}).counts.open,
            hidden: !!hosted(number).hiddenDate,
            merge: op("SMQ_OWNER", "mergeMergeRequest", {mergeRequestNum: number, expectedRevision: revision(number)})
        }
        const item = lib.row("mantle.forum.ForumReviewItem", {
            siteId: SITE,
            targetType: "post",
            targetId: before.author.mergeRequest.topic.rootCommEventId
        })
        const decided = lib.op("SMQ_OWNER", SITE, "decideReview", {
            reviewId: item.reviewId,
            decision: "approved",
            reason: "Fine",
            expectedRevision: Number(item.revision)
        })
        const posts = lib.op("SMQ_STRANGER", SITE, "getPosts", {rootCommEventId: before.author.mergeRequest.topic.rootCommEventId})
        return {proposed, before, decided, after: request("SMQ_STRANGER", number), hiddenAfter: !!hosted(number).hiddenDate, posts}
    },
    then({proposed, before, decided, after, hiddenAfter, posts}) {
        proposed.destination == "proposal"
        proposed.mergeRequestNum == 3
        before.author.pending == true
        before.author.mergeRequest.pushedForReview == true
        before.stranger.kind == "NotFound"
        before.anonymous.kind == "NotFound"
        before.changes.kind == "NotFound"
        // its author reads what it changes while it waits
        before.authorChanges.fileList.map(file => file.path) == ["docs/new.md"]
        before.authorChanges.commitList.length == 1
        // a Maintainer is no moderator of the scope; an Owner is
        before.maintainer.kind == "NotFound"
        before.owner.pending == true
        before.listed == 0
        before.mine == 1
        before.hidden == true
        before.merge.kind == "Conflict"
        decided.state == "approved"
        after.mergeRequest.title == "Add a page"
        after.pending == false
        hiddenAfter == false
        // !1 is the merge request 1; #2 has no issue, so it is the merge request 2; #1 is the issue
        const html = JSON.stringify(posts)
        html.includes("/code/smqgroup/code/-/merge-requests/1")
        html.includes("/code/smqgroup/code/-/merge-requests/2")
        html.includes("/code/smqgroup/code/-/issues/1")
    }
})

feature("a private repository's merge request is Not Found to one who may not view the repository", {
    when() {
        const opened = lib.op(lib.OPERATOR, SITE, "createMergeRequest", {
            repositoryId: ids.privateId,
            sourceRef: "quiet",
            title: "Quiet work",
            operationId: "smq-private-1"
        })
        const of = (username, operation, input) => lib.op(username, SITE, operation, input)
        return {
            opened,
            stranger: of("SMQ_STRANGER", "getMergeRequest", {repositoryId: ids.privateId, mergeRequestNum: 1}),
            list: of("SMQ_STRANGER", "findMergeRequests", {repositoryId: ids.privateId}),
            maintainer: of("SMQ_MAINT", "getMergeRequest", {repositoryId: ids.privateId, mergeRequestNum: 1}),
            group: of("SMQ_STRANGER", "findMergeRequests", {groupId: ids.groupId, state: "all"}),
            groupOwner: of("SMQ_OWNER", "findMergeRequests", {groupId: ids.groupId, state: "all"}),
            comment: lib.comment("SMQ_STRANGER", SITE, opened.rootCommEventId, "Let me in")
        }
    },
    then({opened, stranger, list, maintainer, group, groupOwner, comment}) {
        opened.mergeRequestNum == 1
        stranger.kind == "NotFound"
        list.kind == "NotFound"
        comment.kind == "NotFound"
        maintainer.mergeRequest.title == "Quiet work"
        // a group's list is of the repositories the caller may view
        group.mergeRequestList.map(row => row.repositoryPath).includes("smqgroup/inner") == false
        group.mergeRequestList.length == 3
        groupOwner.mergeRequestList.length == 4
    }
})

feature("a draft and a missing required check do not merge; a text the gate refuses outright leaves the merge request closed and hidden", {
    when() {
        const merge = number => op("SMQ_MAINT", "mergeMergeRequest", {mergeRequestNum: number, expectedRevision: revision(number)})
        const drafted = open("SMQ_DEV", "third", {draft: true})
        const asDraft = merge(drafted.mergeRequestNum)
        op("SMQ_DEV", "updateMergeRequest", {mergeRequestNum: drafted.mergeRequestNum, draft: false, expectedRevision: revision(drafted.mergeRequestNum)})
        lib.set("moqui.resource.GitBranchRule", {branchRuleId: lib.row("moqui.resource.GitBranchRule", {repositoryId: ids.repositoryId}).branchRuleId}, {
            requiredStatusContexts: "ci/build"
        })
        const unchecked = merge(drafted.mergeRequestNum)
        // an account that is silenced on the site opens one through the git host (as Projects would): its text is refused
        lib.account(SITE, "SMQ_SILENCED", {handle: "smqsilenced"})
        lib.role(SITE, {repositoryId: ids.repositoryId}, "SMQ_SILENCED", "SmrDeveloper")
        lib.sanction(SITE, "SMQ_SILENCED", "silence")
        const made = lib.service("SMQ_SILENCED", "org.moqui.git.GitReviewServices.create#MergeRequest", {
            repositoryId: ids.repositoryId,
            sourceRef: "fourth",
            targetRef: "staging",
            title: "From a silenced account"
        })
        const row = lib.row("moqui.resource.GitMergeRequest", {repositoryId: ids.repositoryId, sourceRef: "fourth"})
        return {
            asDraft,
            unchecked,
            made,
            row,
            smithy: lib.row("mantle.smithy.SmithyMergeRequest", {mergeRequestId: row.mergeRequestId}),
            owner: request("SMQ_OWNER", row.mergeRequestNum)
        }
    },
    then({asDraft, unchecked, row, smithy, owner}) {
        asDraft.kind == "Conflict"
        unchecked.reason == "checksRequired"
        row.statusId == "GmrClosed"
        row.hiddenDate != null
        smithy == null
        owner.kind == "NotFound"
    }
})
