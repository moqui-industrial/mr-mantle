// Smithy's GitHub import (mr-pass plan/design-smithy.md §11 Import, §15.9, §18.2, DG8; SmithyImport.js), on recorded API
// responses (test/smithy/fixtures/github, copied with the test repository's head commit into a directory that
// smithy_github_api names): numbers are kept; GitHub's rate limit holds a run until it resets and the run goes on from
// there; a second run adds nothing; a merged pull request becomes a merged merge request with its review and an anchored
// line comment, and one whose head is not here is kept closed and reported, as is a reaction the forum does not have; a
// placeholder (no member, not discoverable, its login moved off a row of another GitHub id) is claimed by an account that
// signs in through GitHub of the placeholder's host with its id, in a site it is a member of, never by an edit outside a
// sign-in; a private GitHub repository is not imported wider without the Owner's word; the receipt is not of the token;
// a run into an archived repository fails at once; a private repository's GitHub addresses are not there; work as an
// account does not end its sessions. Push mirrors refuse until the framework has them. Never calls GitHub. Regression suite: these are rules. Run: ./moq test mr-mantle --spec SmithyGithubImport
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
        const dots = op("SGI_OWNER", "startGitHubImport", {
            groupId,
            sourceRepository: "acme/..",
            slug: "dots",
            token: "recorded-token",
            operationId: "sgi-start-dots"
        }).reason
        // a private GitHub repository goes into a group wider than private only on the Owner's word (publishPrivate)
        setProperty("smithy_github_api", RECORDED + "private")
        record("private", "0000000000000000000000000000000000000000", {"repos_acme_widgets.json": "repos_acme_widgets_private.json"})
        const privateRefused = start("SGI_OWNER", "p").reason
        // nor while GitHub's rate limit holds the token: what the repository is (private or not) is not known yet
        record("private", "0000000000000000000000000000000000000000", {"repos_acme_widgets.json": "rate-limited.json"})
        const limitedStart = start("SGI_OWNER", "l").reason
        setProperty("smithy_github_api", RECORDED + "limited")
        // a recycled login: an account of another GitHub id had bob's login before
        lib.make("mantle.party.Party", {partyId: "SGI_OLDBOB", partyTypeEnumId: "PtyPerson"})
        lib.make("mantle.smithy.SmithyAccount", {siteId: SITE, partyId: "SGI_OLDBOB", githubLogin: "bob", githubUserId: "999999", placeholder: "Y", revision: 1})
        const started = start("SGI_OWNER", "1")
        // the receipt is of the input without its token: the same operation with another token is the first one's
        const retried = op("SGI_OWNER", "startGitHubImport", {
            groupId,
            sourceRepository: "acme/widgets",
            slug: "widgets",
            token: "another-recorded-token",
            operationId: "sgi-start-1"
        })
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
        const bob = lib.row("mantle.smithy.SmithyAccount", {siteId: SITE, githubLogin: "bob"})
        const people = {
            bob,
            oldBob: lib.row("mantle.smithy.SmithyAccount", {siteId: SITE, partyId: "SGI_OLDBOB"}).githubLogin || null,
            member: !!lib.row("mantle.public.PublicSiteParty", {siteId: SITE, partyId: bob.partyId}),
            discoverability: lib.row("mantle.public.PublicSiteProfile", {siteId: SITE, partyId: bob.partyId}).discoverability
        }
        return {byMaintainer, dots, privateRefused, limitedStart, started, retried, waited, before, again, ended, repo, issue, closed, run, people}
    },
    then({byMaintainer, dots, privateRefused, limitedStart, started, retried, waited, before, again, ended, repo, issue, closed, run, people}) {
        byMaintainer == "accessDenied"
        dots == "nameInvalid"
        privateRefused == "policyRefused"
        limitedStart == "rateLimited"
        retried.importId == started.importId
        // bob is GitHub's 1002 now: a new placeholder, and the old id's row lost the login; it is no member and not
        // discoverable, and is shown as the author of what it wrote
        people.bob.partyId != "SGI_OLDBOB"
        people.bob.githubUserId == "1002"
        people.bob.githubHost == "github.com"
        people.oldBob == null
        people.member == false
        people.discoverability == "hidden"
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
        // written hidden, and shown once Smithy's row and conversation were there
        merged.hiddenDate == null
        lib.row("moqui.resource.GitRepository", {repositoryId: merged.repositoryId}).reviewHiddenDate != null
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
        // the claim the sign-in makes once it linked the id (handle#ExternalLink, in an /sso/ request): proven
        lib.run("mantle.smithy.SmithyImportServices.claim#GithubAccount", {userId: "SGI_CAROL", proven: true})
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
        // what the receipt of a new mirror is of: the input without its secret (its hash would be a guessing oracle)
        const receiptInput = ec.resource.script("component://mr-mantle/service/mantle/smithy/Smithy.js").mirrorReceipt(input)
        const maintainer = op("SGI_MAINT", "storeMirror", input)
        // once the framework has push mirrors (F6) the stored receipt is checked too: its hash is of the input without
        // the secret
        const receipt = lib.row("mantle.forum.ForumOperationReceipt", {siteId: SITE, operationId: "sgi-mirror-1", action: "storeMirror"})
        const forum = ec.resource.script("component://mr-mantle/service/mantle/forum/ForumCore.js")
        const withoutSecret = {...input, siteId: SITE}
        delete withoutSecret.secret
        delete withoutSecret.operationId
        const expected = forum.hash(
            JSON.stringify(Object.fromEntries(Object.entries(withoutSecret).sort(([a], [b]) => a.localeCompare(b))))
        )
        return {
            receiptInput,
            maintainer,
            receiptHashed: receipt ? receipt.payloadHash === expected : null,
            stranger: op("SGI_CAROL", "findMirrors", {repositoryId: repositoryId()})
        }
    },
    then({receiptInput, maintainer, receiptHashed, stranger}) {
        !("secret" in JSON.parse(JSON.stringify(receiptInput)))
        receiptInput.url == "https://github.com/acme/widgets.git"
        maintainer.reason == "notBuilt" || receiptHashed == true
        stranger.reason == "accessDenied"
    }
})

feature("a claim needs a GitHub sign-in of the placeholder's host, in a site the account is a member of; the rule claims only a sign-in's write", {
    when() {
        lib.make("moqui.security.sso.AuthFlow", {authFlowId: "SGI_GHE", authFlowTypeEnumId: "AftOauth", description: "GHE", disabled: "Y"})
        lib.make("moqui.security.sso.OauthFlow", {
            authFlowId: "SGI_GHE",
            clientTypeEnumId: "OctGitHub",
            clientId: "sgi-ghe",
            authorizeUrl: "https://ghe.example.com/login/oauth/authorize",
            tokenUrl: "https://ghe.example.com/login/oauth/access_token",
            userInfoUrl: "https://ghe.example.com/api/v3/user"
        })
        lib.make("moqui.security.sso.AuthFlow", {authFlowId: "SGI_PROXY", authFlowTypeEnumId: "AftOauth", description: "Proxy", disabled: "Y"})
        lib.make("moqui.security.sso.OauthFlow", {
            authFlowId: "SGI_PROXY",
            clientTypeEnumId: "OctGitHub",
            clientId: "sgi-proxy",
            userInfoUrl: "https://proxy.example.com/user"
        })
        const alice = partyOfLogin("alice")
        lib.account(SITE, "SGI_ALICE")
        const link = authFlowId =>
            lib.run("update#moqui.security.UserAccount", {userId: "SGI_ALICE", externalUserId: "1001", externalAuthFlowId: authFlowId})
        // as the sign-in that linked the id claims (proven); whether it records the proof is the flow's to say
        const claim = () =>
            lib.run("mantle.smithy.SmithyImportServices.claim#GithubAccount", {userId: "SGI_ALICE", proven: true}).claimed
        link("SGI_GITHUB")
        const notMember = claim()
        lib.make("mantle.public.PublicSiteParty", {
            siteId: SITE,
            partyId: "SGI_ALICE",
            state: "active",
            role: "member",
            joinedAt: ec.user.nowTimestamp,
            fromDate: ec.user.nowTimestamp,
            revision: 1
        })
        link("SGI_GHE")
        const otherHost = claim()
        link("SGI_PROXY")
        const proxied = claim()
        // an administrator's flow whose user info is another user's public profile would link that user's id
        lib.make("moqui.security.sso.AuthFlow", {authFlowId: "SGI_FORGED", authFlowTypeEnumId: "AftOauth", description: "Forged", disabled: "Y"})
        lib.make("moqui.security.sso.OauthFlow", {
            authFlowId: "SGI_FORGED",
            clientTypeEnumId: "OctGitHub",
            clientId: "sgi-forged",
            userInfoUrl: "https://api.github.com/users/alice"
        })
        link("SGI_FORGED")
        const forged = claim()
        // an edit of the account outside a sign-in (this one) claims nothing by the rule
        link("SGI_GITHUB")
        const afterRule = partyOfLogin("alice")
        return {alice, notMember, otherHost, proxied, forged, afterRule, claimed: claim(), now: partyOfLogin("alice")}
    },
    then({alice, notMember, otherHost, proxied, forged, afterRule, claimed, now}) {
        alice != null
        notMember == 0
        otherHost == 0
        proxied == 0
        forged == 0
        afterRule == alice
        claimed == 1
        now == "SGI_ALICE"
    }
})

feature("work as an account signs it out after without ending its sessions elsewhere", {
    when() {
        lib.set("moqui.security.UserAccount", {userId: "SGI_OWNER"}, {hasLoggedOut: "N"})
        // as a job calls it: no user, authorization off, in a transaction (the restore runs once it commits)
        const ran = lib.as(null, () =>
            lib.privileged(() =>
                ec.transaction.runRequireNew(null, "spec", () =>
                    ec.resource.script("component://mr-mantle/service/mantle/forum/ForumCore.js").asUser("SGI_OWNER", () => ec.user.userId)
                )
            )
        )
        // the restore runs after the commit, on a worker: wait for it a little
        const flagNow = () => lib.row("moqui.security.UserAccount", {userId: "SGI_OWNER"}).hasLoggedOut
        for (const started = Date.now(); flagNow() !== "N" && Date.now() - started < 5000; );
        const flag = flagNow()
        // a real sign-out after the step's (the row changed since): the restore keeps it
        lib.set("moqui.security.UserAccount", {userId: "SGI_OWNER"}, {hasLoggedOut: "Y"})
        lib.run("mantle.forum.ForumServices.restore#SignedIn", {userId: "SGI_OWNER", stamp: ec.user.timestampMillis(ec.user.nowTimestamp) - 86400000})
        const kept = lib.row("moqui.security.UserAccount", {userId: "SGI_OWNER"}).hasLoggedOut
        lib.set("moqui.security.UserAccount", {userId: "SGI_OWNER"}, {hasLoggedOut: "N"})
        return {ran, flag, kept}
    },
    then({ran, flag, kept}) {
        ran == "SGI_OWNER"
        flag == "N"
        kept == "Y"
    }
})

feature("a run into an archived repository fails at once; a private repository's GitHub addresses are not there; the forum's cancel route stays", {
    when() {
        const groupId = lib.row("mantle.smithy.SmithyGroup", {siteId: SITE, groupPath: "acmeco"}).groupId
        setProperty("smithy_github_api", RECORDED + "open")
        const started = op("SGI_OWNER", "startGitHubImport", {
            groupId,
            sourceRepository: "acme/widgets",
            slug: "shelved",
            token: "recorded-token",
            operationId: "sgi-start-shelved"
        })
        lib.set("moqui.resource.GitRepository", {repositoryId: started.repositoryId}, {archivedDate: ec.user.nowTimestamp})
        const out = step(started.importId)
        const run = op("SGI_OWNER", "getGitHubImport", {importId: started.importId}).importRun
        lib.set("mantle.smithy.SmithyRepository", {repositoryId: repositoryId()}, {visibilityEnumId: "SmvPrivate"})
        const hidden = op(null, "resolveRedirect", {path: "/acme/widgets/issues/1"}).targetPath
        // the redirect row of its GitHub address (the exact path) leads nowhere for who may not view it
        const hiddenPage = op(null, "resolveRedirect", {path: "/acme/widgets"}).targetPath
        const shownPage = op("SGI_OWNER", "resolveRedirect", {path: "/acme/widgets"}).targetPath
        // a group's old name (renamed, then made private) leads nowhere for who may not view the group
        lib.make("mantle.smithy.SmithyRedirect", {
            redirectId: "SGI_OLD_GROUP",
            siteId: SITE,
            oldPath: "/old-acmeco",
            targetPath: "/code/acmeco",
            sourceEnumId: "SrsManual",
            createdAt: ec.user.nowTimestamp
        })
        lib.set("mantle.smithy.SmithyGroup", {groupId}, {visibilityEnumId: "SmvPrivate"})
        const hiddenGroup = op(null, "resolveRedirect", {path: "/old-acmeco"}).targetPath
        const shownGroup = op("SGI_OWNER", "resolveRedirect", {path: "/old-acmeco"}).targetPath
        lib.set("mantle.smithy.SmithyGroup", {groupId}, {visibilityEnumId: "SmvPublic"})
        lib.set("mantle.smithy.SmithyRepository", {repositoryId: repositoryId()}, {visibilityEnumId: "SmvPublic"})
        const route = ec.resource
            .script("component://mr-mantle/script/PassRoutes.js")
            .find(([verb, path]) => verb === "POST" && path === "imports/{importId}/cancel")
        return {out, run, hidden, hiddenPage, shownPage, hiddenGroup, shownGroup, route}
    },
    then({out, run, hidden, hiddenPage, shownPage, hiddenGroup, shownGroup, route}) {
        hiddenGroup == null
        shownGroup == "/code/acmeco"
        hiddenPage == null
        shownPage == "/code/acmeco/widgets"
        out.done == true
        run.stage == "failed"
        run.reportList.some(item => item.errorText.startsWith("repositoryArchived"))
        hidden == null
        route[2] == "cancelImport"
    }
})

feature("an account that signed in with GitHub before it joined claims the site's placeholders when its membership becomes active", {
    when() {
        const join = partyId =>
            lib.make("mantle.public.PublicSiteParty", {
                siteId: SITE,
                partyId,
                state: "active",
                role: "member",
                joinedAt: ec.user.nowTimestamp,
                fromDate: ec.user.nowTimestamp,
                revision: 1
            })
        const dj = partyOfLogin("dj")
        const bob = partyOfLogin("bob")
        // dj's account: a sign-in proved its id (the claim it made found no site it was a member of)
        lib.account(SITE, "SGI_DJ")
        lib.run("update#moqui.security.UserAccount", {userId: "SGI_DJ", externalUserId: "1004", externalAuthFlowId: "SGI_GITHUB"})
        const before = lib.run("mantle.smithy.SmithyImportServices.claim#GithubAccount", {userId: "SGI_DJ", proven: true}).claimed
        // bob's id written on an account outside a sign-in: never proven
        lib.account(SITE, "SGI_BOB")
        lib.run("update#moqui.security.UserAccount", {userId: "SGI_BOB", externalUserId: "1002", externalAuthFlowId: "SGI_GITHUB"})
        join("SGI_DJ")
        join("SGI_BOB")
        // the claim runs after the membership's commit, on a worker: wait for it a little
        for (const started = Date.now(); partyOfLogin("dj") !== "SGI_DJ" && Date.now() - started < 5000; )
            ec.entity.find("mantle.smithy.SmithyAccount").condition({siteId: SITE}).disableAuthz().count()
        return {dj, bob, before, djNow: partyOfLogin("dj"), bobNow: partyOfLogin("bob"),
            proof: lib.row("mantle.smithy.SmithyGithubLink", {userId: "SGI_DJ"})}
    },
    then({dj, bob, before, djNow, bobNow, proof}) {
        dj != null
        before == 0
        proof.githubUserId == "1004"
        proof.githubHost == "github.com"
        djNow == "SGI_DJ"
        bobNow == bob
    }
})
