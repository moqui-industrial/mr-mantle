// The public projection of an issue and its references in commits (mr-pass plan/design-smithy.md §8.2, §8.4;
// mantle.work.PublicProjectionServices, SmithyIssues.js, mantle.work.GitServices): getIssue answers the fields of §8.2 and
// nothing else of the task, so its notes, time, estimate, priority, internal members and a sibling that is not public do
// not leave; a Reporter also gets the work item's key; "Fixes #1" in a commit on the default branch completes that
// repository's issue 1 and "#2" links issue 2, another repository's issue 1 is left alone, a message with a '<' is read
// as text, and an item a commit names that the reader may not see is a count. Spec-local site, accounts and db
// repositories. Regression suite: these are rules. Run: ./moq test mr-mantle --spec SmithyIssueProjection
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const SITE = "SIP_SITE"
const ids = {}
const issue = (username, issueNumber, repositoryId = ids.repositoryId) =>
    lib.op(username, SITE, "getIssue", {repositoryId, issueNumber})
const PUBLIC_FIELDS = [
    "assignees",
    "author",
    "closedAt",
    "commentCount",
    "confidential",
    "createdAt",
    "discussion",
    "duplicateOfNumber",
    "issueNumber",
    "labels",
    "linkedCommits",
    "linkedMergeRequests",
    "linkedRefs",
    "milestone",
    "reactionCounts",
    "repositoryPath",
    "revision",
    "state",
    "stateReason",
    "title",
    "topic",
    "updatedAt"
]

spec({
    requires: ["git"],
    setupSpec() {
        login(lib.OPERATOR)
        lib.site(SITE)
        Object.assign(ids, lib.tracker(SITE, "SIP", "siptrack"))
        ids.other = lib.createRepository(lib.OPERATOR, {
            siteId: SITE,
            groupId: ids.groupId,
            slug: "other",
            visibility: "public"
        }).repositoryId
        lib.issuesOn(SITE, ids.other)
        lib.file("SIP_AUTHOR", SITE, ids.repositoryId, "Shown")
        lib.file("SIP_STRANGER", SITE, ids.repositoryId, "Linked")
        lib.settled(SITE, "SIP_AUTHOR")
        lib.file("SIP_AUTHOR", SITE, ids.repositoryId, "Kept quiet", {confidential: true})
        lib.settled(SITE, "SIP_STRANGER")
        lib.file("SIP_STRANGER", SITE, ids.other, "Another repository's first")
        ids.task = lib.row("mantle.smithy.SmithyIssue", {repositoryId: ids.repositoryId, issueNumber: 1}).workEffortId
        // what Projects keeps on the task: an estimate and a priority, a note, time with a rate, an internal member
        lib.run("update#mantle.work.effort.WorkEffort", {
            workEffortId: ids.task,
            estimatedWorkTime: 8,
            actualWorkTime: 3,
            priority: 1
        })
        lib.run("mantle.work.TaskServices.add#TaskComment", {workEffortId: ids.task, body: "SIP-INTERNAL-NOTE"})
        lib.make("mantle.work.time.TimeEntry", {
            workEffortId: ids.task,
            partyId: "SIP_MAINT",
            hours: 2.5,
            comments: "SIP-TIME-NOTE"
        })
        lib.make("mantle.work.effort.WorkEffortParty", {
            workEffortId: ids.task,
            partyId: "SIP_MAINT",
            roleTypeId: "Manager",
            fromDate: ec.user.nowTimestamp
        })
        ids.sibling = lib.run("mantle.work.TaskServices.create#Task", {
            rootWorkEffortId: ids.projectId,
            workEffortName: "SIP-INTERNAL-SIBLING",
            visibilityEnumId: "WevWorkGroup",
            parentWorkEffortId: ids.task
        }).workEffortId
    }
})

feature("an issue answers the fields of the projection and nothing else of its task", {
    when() {
        const anyone = issue(null, 1)
        return {anyone, text: JSON.stringify(anyone), reporter: issue("SIP_REPORTER", 1).issue}
    },
    then({anyone, text, reporter}) {
        Object.keys(anyone.issue).sort() == PUBLIC_FIELDS
        anyone.issue.title == "Shown"
        anyone.issue.author == {handle: "sipauthor", displayName: "SIP_AUTHOR", avatarUrl: null, imported: false}
        // no note, time, estimate, member or sibling, by name or by id
        !/SIP-INTERNAL|SIP-TIME|SIP_MAINT|sipmaint|estimated|actualWork|priority|2\.5/.test(text)
        !text.includes(ids.task)
        !text.includes(ids.sibling)
        // a Reporter also has the work item's key and status
        reporter.workItemKey == ids.task
        reporter.statusId == "WeInPlanning"
    }
})

feature(
    "a key names a task only where the repository may: never a sibling's issue, and an internal task only by a member of its project",
    {
        when() {
            // the other repository is linked to this one's project too, as two repositories of a group's project are
            lib.run("mantle.work.GitServices.add#ProjectRepository", {workEffortId: ids.projectId, repositoryId: ids.other})
            const second = lib.row("mantle.smithy.SmithyIssue", {repositoryId: ids.repositoryId, issueNumber: 2}).workEffortId
            const links = () =>
                Array.from(
                    ec.entity
                        .find("mantle.work.effort.WorkEffortGitCommit")
                        .condition("repositoryId", ids.other)
                        .disableAuthz()
                        .list()
                ).map(row => row.workEffortId)
            lib.commit(ids.other, `Fixes ${second} and ${ids.sibling}\n\nTask: ${ids.task}`, {"b.txt": "b\n"})
            lib.settle(ids.other)
            const stranger = links()
            // the operator joins the project: its internal task may be named, a sibling's issue still not
            lib.make("mantle.work.effort.WorkEffortParty", {
                workEffortId: ids.projectId,
                partyId: "EX_JOHN_DOE",
                roleTypeId: "Manager",
                fromDate: ec.user.timestampMillis(ec.user.nowTimestamp) - 1000
            })
            lib.commit(ids.other, `Fixes ${second}. Fixes ${ids.sibling}`, {"c.txt": "c\n"})
            lib.settle(ids.other)
            return {
                stranger,
                member: links(),
                state: issue(null, 2).issue.state,
                sibling: lib.row("mantle.work.effort.WorkEffort", {workEffortId: ids.sibling}).statusId
            }
        },
        then({stranger, member, state, sibling}) {
            stranger == []
            member == [ids.sibling]
            state == "open"
            sibling == "WeComplete"
        }
    }
)

feature("Fixes #1 completes this repository's issue, #2 links, and what the reader may not see is a count", {
    when() {
        // names issue 1 to complete, issue 2, the confidential issue 3 and an internal task; a '<' is text
        const commitId = lib.commit(ids.repositoryId, `Fixes #1 when a < b\n\nSee #2. Closes #3 and ${ids.sibling}.`, {
            "a.txt": "a\n"
        })
        lib.settle(ids.repositoryId)
        const read = repositoryId => issue(null, 1, repositoryId).issue
        const page = username => lib.op(username, SITE, "getCommit", {repositoryId: ids.repositoryId, commitId})
        return {
            commitId,
            fixed: read(ids.repositoryId),
            linked: issue(null, 2).issue,
            elsewhere: read(ids.other),
            confidential: issue("SIP_OWNER", 3).issue.state,
            stranger: page(null),
            owner: page("SIP_OWNER")
        }
    },
    then({commitId, fixed, linked, elsewhere, confidential, stranger, owner}) {
        fixed.state == "closed"
        fixed.stateReason == "completed"
        fixed.linkedCommits.map(link => link.commitId) == [commitId]
        linked.state == "open"
        linked.linkedCommits.map(link => link.repositoryPath) == ["siptrack/code"]
        // only an issue of the pushed repository is completed
        elsewhere.state == "open"
        elsewhere.linkedCommits == []
        // a confidential issue is completed by its commit and named to nobody but its Owners
        confidential == "closed"
        stranger.commit.issueNumbers == [1, 2]
        stranger.linkedIssues.map(row => row.title) == ["Shown", "Linked"]
        stranger.hiddenItemCount == 2
        owner.commit.issueNumbers == [1, 2, 3]
        owner.hiddenItemCount == 1
    }
})
