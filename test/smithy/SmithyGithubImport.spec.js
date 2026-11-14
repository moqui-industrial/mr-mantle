// Smithy's GitHub import (mr-pass plan/design-smithy.md §11 Import, §15.9, §18.2, DG8; SmithyImport.js), on recorded API
// responses (test/smithy/fixtures/github, copied with the test repository's head commit into a directory that
// smithy_github_api names): numbers are kept; GitHub's rate limit holds a run until it resets and the run goes on from
// there; a second run adds nothing; a merged pull request becomes a merged merge request with its review and an anchored
// line comment, and one whose head is not here is kept closed and reported, as is a reaction the forum does not have; a
// placeholder is claimed by an account that signs in through GitHub with its id. Push mirrors refuse until the framework
// has them. Never calls GitHub. Regression suite: these are rules. Run: ./moq test mr-mantle --spec SmithyGithubImport
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const SITE = "SGI_SITE"
const FIXTURES = "component://mr-mantle/test/smithy/fixtures/github/"
const RECORDED = "runtime://tmp/smithy-github-import/"
const NAMES = [
    "repos_acme_widgets.json",
    "repos_acme_widgets_issues_state_all_sort_created_direction_desc_per_page_1.json",
    "repos_acme_widgets_labels_per_page_100_page_1.json",
    "repos_acme_widgets_milestones_state_all_per_page_100_page_1.json",
    "repos_acme_widgets_issues_state_all_sort_created_direction_asc_per_page_100_page_1.json",
    "repos_acme_widgets_issues_state_all_sort_created_direction_asc_per_page_100_page_2.json",
    "repos_acme_widgets_pulls_state_all_sort_created_direction_asc_per_page_100_page_1.json",
    "repos_acme_widgets_pulls_2_reviews_per_page_100_page_1.json",
    "repos_acme_widgets_pulls_4_reviews_per_page_100_page_1.json",
    "repos_acme_widgets_issues_comments_sort_created_direction_asc_per_page_100_page_1.json",
    "repos_acme_widgets_pulls_comments_sort_created_direction_asc_per_page_100_page_1.json",
    "repos_acme_widgets_issues_1_reactions_per_page_100_page_1.json",
    "repos_acme_widgets_issues_comments_5001_reactions_per_page_100_page_1.json"
]
const op = (username, operation, input) => lib.op(username, SITE, operation, input)
const rows = (entity, fields) => Array.from(ec.entity.find(entity).condition(fields).disableAuthz().list())
/* The recorded responses in a directory, with the head commit in place of @HEAD@; overrides: a name to another file. */
function record(dir, head, overrides = {}) {
    for (const name of NAMES) {
        const text = ec.resource
            .getLocationText(FIXTURES + (overrides[name] || name), false)
            .split("@HEAD@")
            .join(head)
        ec.resource.getLocationReference(RECORDED + dir + "/" + name).putText(text)
    }
}
const step = importId =>
    lib.as("SGI_OWNER", () => lib.run("mantle.smithy.SmithyImportServices.run#Import", {importId, budget: 50}))
/* Steps until the run ends or waits. */
function steps(importId) {
    let out = null
    for (let k = 0; k < 20; k++) {
        out = step(importId)
        if (out.done || out.waitingUntil) return out
    }
    return out
}
const repositoryId = () => lib.row("mantle.smithy.SmithyRepository", {repositoryPath: "acmeco/widgets"}).repositoryId
const issueRow = number => lib.row("mantle.smithy.SmithyIssue", {repositoryId: repositoryId(), issueNumber: number})
const requestRow = number => lib.row("moqui.resource.GitMergeRequest", {repositoryId: repositoryId(), mergeRequestNum: number})
const handleOf = partyId => lib.row("mantle.public.PublicSiteProfile", {siteId: SITE, partyId})?.handle || null
const partyOfLogin = login => lib.row("mantle.smithy.SmithyAccount", {siteId: SITE, githubLogin: login})?.partyId || null
/* The posts of a record topic in order: their text, or a state line. */
const posts = root =>
    rows("mantle.forum.ForumPostState", {rootCommEventId: root})
        .sort((left, right) => Number(left.ordinal) - Number(right.ordinal))
        .map(state =>
            lib.row("mantle.party.communication.CommunicationEvent", {communicationEventId: state.communicationEventId})
        )

spec({
    setupSpec() {
        login(lib.OPERATOR)
        lib.site(SITE)
        for (const name of ["SGI_OWNER", "SGI_MAINT"]) {
            lib.account(SITE, name, {handle: name.toLowerCase().replace("_", "")})
            lib.settled(SITE, name)
        }
        const groupId = lib.createGroup(lib.OPERATOR, {siteId: SITE, pathSegment: "acmeco", visibility: "public"}).groupId
        lib.role(SITE, {groupId}, "SGI_OWNER", "SmrOwner")
        lib.role(SITE, {groupId}, "SGI_MAINT", "SmrMaintainer")
    },
    cleanupSpec() {
        setProperty("smithy_github_api", "")
    }
})

feature("numbers are kept; the rate limit holds a run until it resets, and the run goes on from there", {
    when() {
        const groupId = lib.row("mantle.smithy.SmithyGroup", {siteId: SITE, groupPath: "acmeco"}).groupId
        setProperty("smithy_github_api", RECORDED + "limited")
        record("limited", "0000000000000000000000000000000000000000")
        const start = (username, key) =>
            op(username, "startGitHubImport", {
                groupId,
                sourceRepository: "acme/widgets",
                slug: "widgets",
                token: "recorded-token",
                operationId: "sgi-start-" + key
            })
        const byMaintainer = start("SGI_MAINT", "m").reason
        const started = start("SGI_OWNER", "1")
        // the code the pull requests were made from: main, and the branch of the merged one
        lib.commit(started.repositoryId, "Start", {"README.md": "# Widgets\n"})
        const head = lib.run("org.moqui.git.GitServices.commit#GitFiles", {
            repositoryId: started.repositoryId,
            message: "Say hello",
            fileMap: {"README.md": "# Widgets\nHello\n"},
            newBranch: "feature"
        }).commitId
        lib.settle(started.repositoryId)
        record("limited", head, {
            "repos_acme_widgets_issues_state_all_sort_created_direction_asc_per_page_100_page_2.json": "rate-limited.json"
        })
        record("open", head)
        const waited = steps(started.importId)
        const held = lib.row("mantle.smithy.SmithyImportRun", {importId: started.importId})
        const before = {stage: held.statusId, issue1: !!issueRow(1), issue3: !!issueRow(3)}
        const again = step(started.importId)
        // the limit resets
        setProperty("smithy_github_api", RECORDED + "open")
        lib.set("mantle.smithy.SmithyImportRun", {importId: started.importId}, {waitingUntil: null})
        const ended = steps(started.importId)
        const repo = lib.row("mantle.smithy.SmithyRepository", {repositoryId: started.repositoryId})
        const issue = op(null, "getIssue", {repositoryId: started.repositoryId, issueNumber: 1}).issue
        const closed = op(null, "getIssue", {repositoryId: started.repositoryId, issueNumber: 3}).issue
        const run = op("SGI_OWNER", "getGitHubImport", {importId: started.importId}).importRun
        return {byMaintainer, started, waited, before, again, ended, repo, issue, closed, run}
    },
    then({byMaintainer, started, waited, before, again, ended, repo, issue, closed, run}) {
        byMaintainer == "accessDenied"
        started.importId != null
        waited.waitingUntil != null
        before.stage == "SmiIssues"
        before.issue1 == true
        before.issue3 == false
        again.requests == 0
        again.waitingUntil != null
        ended.done == true
        ended.stage == "done"
        rows("mantle.smithy.SmithyIssue", {repositoryId: started.repositoryId})
            .map(row => Number(row.issueNumber))
            .sort()
            .join() == "1,3"
        rows("moqui.resource.GitMergeRequest", {repositoryId: started.repositoryId})
            .map(row => Number(row.mergeRequestNum))
            .sort()
            .join() == "2,4"
        // what is filed now takes a number past GitHub's
        Number(repo.nextIssueNumber) == 5
        repo.importedHistory == "Y"
        repo.issuesEnabled == "Y"
        issue.title == "Widgets <b>break</b> on resize"
        issue.state == "open"
        issue.author.handle == "bob"
        issue.author.imported == true
        JSON.stringify(issue.labels).includes("bug")
        JSON.stringify(issue.milestone).includes("v1.0")
        // a login that is no valid handle (two letters) is gh-<login>
        issue.assignees
            .map(person => person.handle)
            .sort()
            .join() == "alice,gh-dj"
        closed.state == "closed"
        closed.stateReason == "notPlanned"
        run.stage == "done"
        run.counts.issue.imported == 2
        run.counts.pull.imported == 2
        run.counts.comment.imported == 2
        run.repositoryPath == "acmeco/widgets"
        // the token was dropped with the run's end
        lib.row("mantle.smithy.SmithyImportRun", {importId: started.importId}).tokenRemoteId == null
    }
})

feature("a second run adds nothing", {
    when() {
        const id = repositoryId()
        const groupId = lib.row("mantle.smithy.SmithyGroup", {siteId: SITE, groupPath: "acmeco"}).groupId
        const counted = () => ({
            issues: rows("mantle.smithy.SmithyIssue", {repositoryId: id}).length,
            requests: rows("moqui.resource.GitMergeRequest", {repositoryId: id}).length,
            posts: rows("mantle.smithy.SmithyIssue", {repositoryId: id})
                .map(row => row.rootCommEventId)
                .concat(rows("mantle.smithy.SmithyMergeRequest", {repositoryId: id}).map(row => row.rootCommEventId))
                .reduce((total, root) => total + rows("mantle.forum.ForumPostState", {rootCommEventId: root}).length, 0),
            people: rows("mantle.smithy.SmithyAccount", {siteId: SITE, placeholder: "Y"}).length
        })
        const before = counted()
        const started = op("SGI_OWNER", "startGitHubImport", {
            groupId,
            repositoryId: id,
            sourceRepository: "acme/widgets",
            token: "recorded-token",
            operationId: "sgi-start-2"
        })
        const ended = steps(started.importId)
        return {before, after: counted(), ended, run: op("SGI_OWNER", "getGitHubImport", {importId: started.importId}).importRun}
    },
    then({before, after, ended, run}) {
        ended.done == true
        JSON.stringify(after) == JSON.stringify(before)
        before.posts > 8
        run.counts.issue.source == 2
        run.counts.issue.imported == 0
        run.counts.pull.imported == 0
    }
})

feature("a pull request is a merged merge request with its review and anchored line comment; what was not carried is reported", {
    when() {
        const id = repositoryId()
        const merged = requestRow(2)
        const smithy = lib.row("mantle.smithy.SmithyMergeRequest", {mergeRequestId: merged.mergeRequestId})
        const view = op(null, "getMergeRequest", {repositoryId: id, mergeRequestNum: 2}).mergeRequest
        const anchors = rows("mantle.party.communication.CommunicationEventGitAnchor", {mergeRequestId: merged.mergeRequestId})
        const reply = posts(smithy.rootCommEventId).find(post => post.body.includes("Quiet is fine"))
        const issue1 = issueRow(1)
        const comment = posts(issue1.rootCommEventId).find(post => post.body.includes("I see it too"))
        const run = rows("mantle.smithy.SmithyImportRun", {repositoryId: id}).sort((left, right) =>
            String(left.importId).localeCompare(String(right.importId))
        )[0]
        return {
            merged,
            view,
            lines: posts(smithy.rootCommEventId).map(post => post.body.replace(/<[^>]*>/g, "").trim()),
            anchors,
            reply,
            kept: requestRow(4),
            reactions: rows("mantle.forum.ForumReaction", {communicationEventId: issue1.rootCommEventId}).map(
                row => row.reactionKey
            ),
            thanks: rows("mantle.forum.ForumReaction", {communicationEventId: comment.communicationEventId}).map(
                row => row.reactionKey
            ),
            report: op("SGI_OWNER", "getGitHubImport", {importId: run.importId}).importRun,
            // its GitHub addresses, whose owner/name is not its path here: an issue's, and a pull request's by the number
            // GitHub gave both
            oldIssue: op(null, "resolveRedirect", {path: "/acme/widgets/issues/1"}).targetPath,
            oldPull: lib.run("mantle.smithy.SmithySiteServices.resolve#Redirect", {siteId: SITE, path: "/Acme/Widgets/issues/2"})
                .targetPath
        }
    },
    then({merged, view, lines, anchors, reply, kept, reactions, thanks, report, oldIssue, oldPull}) {
        oldIssue == "/code/acmeco/widgets/-/issues/1"
        oldPull == "/code/acmeco/widgets/-/merge-requests/2"
        merged.statusId == "GmrMerged"
        merged.mergeCommitId == merged.headCommitId
        view.state == "merged"
        view.author.handle == "carol"
        view.author.imported == true
        lines.join("|") == "Adds a greeting. Fixes nothing.|merged|Looks good|approved|Thanks!|Say it louder?|Quiet is fine."
        anchors.length == 1
        anchors[0].path == "README.md"
        Number(anchors[0].newLine) == 2
        anchors[0].outdated == "N"
        anchors[0].lineText == "Hello"
        reply.parentCommEventId == anchors[0].communicationEventId
        // its head is not here: kept closed, without commits, and reported
        kept.statusId == "GmrClosed"
        kept.headCommitId == null
        report.reportList.some(item => item.sourceType == "pull" && item.errorText.startsWith("headNotFetched"))
        report.notCarried.reactions.rocket == 1
        report.notCarried.never.length > 3
        reactions.join() == "like"
        thanks.join() == "thanks"
    }
})

feature("an account that signs in through GitHub with a placeholder's id takes its records", {
    when() {
        lib.make("moqui.security.sso.AuthFlow", {
            authFlowId: "SGI_GITHUB",
            authFlowTypeEnumId: "AftOauth",
            description: "GitHub",
            disabled: "Y"
        })
        lib.make("moqui.security.sso.OauthFlow", {authFlowId: "SGI_GITHUB", clientTypeEnumId: "OctGitHub", clientId: "sgi"})
        lib.account(SITE, "SGI_CAROL", {handle: "sgicarol"})
        const placeholder = partyOfLogin("carol")
        // the sign-in's account sync links the provider's id
        lib.run("update#moqui.security.UserAccount", {
            userId: "SGI_CAROL",
            externalUserId: "1003",
            externalAuthFlowId: "SGI_GITHUB"
        })
        lib.run("mantle.smithy.SmithyImportServices.claim#GithubAccount", {userId: "SGI_CAROL"})
        const merged = requestRow(2)
        return {
            placeholder,
            issue: issueRow(3),
            smithy: lib.row("mantle.smithy.SmithyMergeRequest", {mergeRequestId: merged.mergeRequestId}),
            merged,
            account: lib.row("mantle.smithy.SmithyAccount", {siteId: SITE, partyId: "SGI_CAROL"}),
            gone: handleOf(placeholder),
            view: op(null, "getIssue", {repositoryId: repositoryId(), issueNumber: 3}).issue,
            again: lib.run("mantle.smithy.SmithyImportServices.claim#GithubAccount", {userId: "SGI_CAROL"}).claimed
        }
    },
    then({placeholder, issue, smithy, merged, account, gone, view, again}) {
        placeholder != null
        issue.reporterPartyId == "SGI_CAROL"
        smithy.authorPartyId == "SGI_CAROL"
        merged.authorUserId == "SGI_CAROL"
        account.githubLogin == "carol"
        account.githubUserId == "1003"
        gone == null
        view.author.handle == "sgicarol"
        view.author.imported == false
        again == 0
    }
})

feature("push mirrors are a Maintainer's, and refused until the framework has them", {
    when() {
        const input = {
            repositoryId: repositoryId(),
            url: "https://github.com/acme/widgets.git",
            secret: "s",
            operationId: "sgi-mirror-1"
        }
        return {
            maintainer: op("SGI_MAINT", "storeMirror", input),
            stranger: op("SGI_CAROL", "findMirrors", {repositoryId: repositoryId()})
        }
    },
    then({maintainer, stranger}) {
        maintainer.reason == "notBuilt"
        stranger.reason == "accessDenied"
    }
})
