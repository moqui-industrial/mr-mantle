// Smithy's issues (mr-pass plan/design-smithy.md §8, §12.2, §15.4; SmithyIssues.js): a number comes from the repository's
// counter; the public state follows the task's status both ways, with its line in the conversation; a label, an assignee
// and a milestone are a Reporter's and a title its author's; an account with no confirmed address, or silenced, files
// and comments nothing; a held first post is its author's and its moderators' until it is approved; a public task of a
// Smithy tracker's project becomes an issue, a task of a project that is only linked to a repository never, and a task
// that is no longer public is Not Found below a Reporter. Spec-local site, accounts and a db repository. Regression
// suite: these are rules. Run: ./moq test mr-mantle --spec SmithyIssues
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const SITE = "SMI_SITE"
const ids = {}
const issue = (username, issueNumber) => lib.op(username, SITE, "getIssue", {repositoryId: ids.repositoryId, issueNumber})
const write = (username, operation, issueNumber, more) =>
    lib.op(username, SITE, operation, {
        repositoryId: ids.repositoryId,
        issueNumber,
        expectedRevision: issue(lib.OPERATOR, issueNumber).issue.revision,
        ...more
    })
const task = issueNumber =>
    lib.row("mantle.work.effort.WorkEffort", {
        workEffortId: lib.row("mantle.smithy.SmithyIssue", {repositoryId: ids.repositoryId, issueNumber}).workEffortId
    })

spec({
    requires: ["git"],
    setupSpec() {
        login(lib.OPERATOR)
        lib.site(SITE)
        Object.assign(ids, lib.tracker(SITE, "SMI", "smitrack"))
        lib.account(SITE, "SMI_UNCONFIRMED", {unconfirmed: true})
        lib.account(SITE, "SMI_SILENCED")
        lib.sanction(SITE, "SMI_SILENCED", "silence")
        lib.account(SITE, "SMI_NEW", {handle: "sminew"})
    }
})

feature("two issues take two numbers from the repository's counter, and a repeat of an operation answers its first", {
    when() {
        const input = {repositoryId: ids.repositoryId, title: "First", body: "One **bold** word", operationId: "smi-first-1"}
        const first = lib.op("SMI_AUTHOR", SITE, "createIssue", input)
        lib.settled(SITE, "SMI_AUTHOR")
        const again = lib.op("SMI_AUTHOR", SITE, "createIssue", input)
        // a title is plain text: a '<' is kept as typed
        const second = lib.file("SMI_STRANGER", SITE, ids.repositoryId, "Second <b> a < b")
        const forProjects = workEffortId => lib.run("mantle.smithy.SmithyIssueServices.get#TaskIssue", {workEffortId})
        return {
            first,
            again,
            second,
            next: lib.row("mantle.smithy.SmithyRepository", {repositoryId: ids.repositoryId}).nextIssueNumber,
            read: issue(null, 1),
            key: task(1).workEffortId,
            second2: issue(null, 2).issue.title,
            forProjects: forProjects(task(1).workEffortId),
            list: lib.op(null, SITE, "findIssues", {repositoryId: ids.repositoryId})
        }
    },
    then({first, again, second, next, read, key, list, second2, forProjects}) {
        second2 == "Second <b> a < b"
        // what Projects shows of a task's issue
        forProjects.issueNumber == 1
        forProjects.repositoryPath == "smitrack/code"
        forProjects.confidential == false
        forProjects.rootCommEventId == first.rootCommEventId
        first.issueNumber == 1
        first.state == "published"
        again.issueNumber == 1
        second.issueNumber == 2
        Number(next) == 3
        // the task of the repository's project, numbered by the project's own sequence
        key == ids.projectId + "-1"
        read.issue.title == "First"
        read.issue.state == "open"
        read.issue.author.handle == "smiauthor"
        read.capabilities.canComment == false
        list.issueList.map(row => row.issueNumber) == [2, 1]
        list.counts == {open: 2, closed: 0}
    }
})

feature("closing and reopening follow the task's status both ways, each a line in the conversation", {
    when() {
        const stranger = write("SMI_STRANGER", "setIssueState", 1, {state: "closed"})
        const closed = write("SMI_AUTHOR", "setIssueState", 1, {state: "closed", reason: "notPlanned"})
        const closedTask = task(1).statusId
        // in Projects: the task is reopened and completed there
        lib.run("mantle.work.TaskServices.set#TaskStatus", {workEffortId: task(1).workEffortId, statusId: "WeInPlanning"})
        const reopened = issue(null, 1).issue.state
        lib.run("mantle.work.TaskServices.set#TaskStatus", {workEffortId: task(1).workEffortId, statusId: "WeComplete"})
        const completed = issue(null, 1).issue
        const lines = lib
            .op(null, SITE, "getPosts", {rootCommEventId: completed.topic.rootCommEventId})
            .postList.filter(post => post.postKind == "event")
            .map(post => post.body)
        const duplicate = write("SMI_REPORTER", "setIssueState", 2, {state: "closed", reason: "duplicate", duplicateOfNumber: 1})
        return {stranger, closed, closedTask, reopened, completed, lines, duplicate, of: issue(null, 2).issue.duplicateOfNumber}
    },
    then({stranger, closed, closedTask, reopened, completed, lines, duplicate, of}) {
        // closing another account's issue is a Reporter's
        stranger.reason == "accessDenied"
        closed.stateReason == "notPlanned"
        closedTask == "WeCancelled"
        reopened == "open"
        completed.state == "closed"
        completed.stateReason == "completed"
        completed.commentCount == 0
        lines == ["closed as not planned", "reopened", "closed as completed"]
        duplicate.stateReason == "duplicate"
        of == 1
    }
})

feature("a label, an assignee and a milestone are a Reporter's, a label's making a Maintainer's, and a title its author's", {
    when() {
        const made = lib.op("SMI_MAINT", SITE, "storeLabel", {
            repositoryId: ids.repositoryId,
            name: "bug",
            color: "red",
            operationId: "smi-label-1"
        })
        const byReporter = lib.op("SMI_REPORTER", SITE, "storeLabel", {
            repositoryId: ids.repositoryId,
            name: "nope",
            operationId: "smi-label-2"
        })
        const milestone = lib.op("SMI_MAINT", SITE, "storeMilestone", {
            repositoryId: ids.repositoryId,
            name: "1.0",
            operationId: "smi-ms-1"
        })
        return {
            byReporter,
            labelled: write("SMI_REPORTER", "setIssueLabels", 2, {labelIds: [made.labelId]}),
            byAuthor: write("SMI_STRANGER", "setIssueLabels", 2, {labelIds: [made.labelId]}),
            assigned: write("SMI_REPORTER", "setIssueAssignees", 2, {assigneeHandles: ["smimaint"]}),
            planned: write("SMI_REPORTER", "setIssueMilestone", 2, {milestoneId: milestone.milestoneId}),
            renamed: write("SMI_STRANGER", "updateIssue", 2, {title: "Second, renamed"}),
            byOther: write("SMI_AUTHOR", "updateIssue", 2, {title: "Not mine"}),
            read: issue(null, 2).issue,
            labels: lib.op(null, SITE, "findLabels", {repositoryId: ids.repositoryId}).labelList,
            byLabel: lib.op(null, SITE, "findIssues", {repositoryId: ids.repositoryId, state: "all", labelIds: [made.labelId]})
                .issueList
        }
    },
    then({byReporter, labelled, byAuthor, assigned, planned, renamed, byOther, read, labels, byLabel}) {
        byReporter.reason == "accessDenied"
        labelled.labels.map(label => label.name) == ["bug"]
        byAuthor.reason == "accessDenied"
        assigned.assignees.map(profile => profile.handle) == ["smimaint"]
        planned.milestone.name == "1.0"
        renamed.kind == null
        byOther.reason == "accessDenied"
        read.title == "Second, renamed"
        read.labels == [{labelId: labels[0].labelId, name: "bug", color: "red"}]
        labels[0].openIssueCount == 0
        byLabel.map(row => row.issueNumber) == [2]
    }
})

feature("an account with no confirmed address, and a silenced one, file and comment nothing", {
    when() {
        const root = issue(null, 1).issue.topic.rootCommEventId
        lib.settled(SITE, "SMI_STRANGER")
        return {
            fileUnconfirmed: lib.file("SMI_UNCONFIRMED", SITE, ids.repositoryId, "Never"),
            fileSilenced: lib.file("SMI_SILENCED", SITE, ids.repositoryId, "Never"),
            noteUnconfirmed: lib.comment("SMI_UNCONFIRMED", SITE, root, "Never"),
            noteSilenced: lib.comment("SMI_SILENCED", SITE, root, "Never"),
            noted: lib.comment("SMI_STRANGER", SITE, root, "A comment"),
            count: issue(null, 1).issue.commentCount
        }
    },
    then({fileUnconfirmed, fileSilenced, noteUnconfirmed, noteSilenced, noted, count}) {
        fileUnconfirmed.reason == "addressUnconfirmed"
        fileSilenced.reason == "accessDenied"
        noteUnconfirmed.reason == "addressUnconfirmed"
        noteSilenced.reason == "accessDenied"
        noted.state == "published"
        count == 1
    }
})

feature("a first post is held: the issue is its author's and its moderators' until an Owner approves it", {
    when() {
        const held = lib.file("SMI_NEW", SITE, ids.repositoryId, "Held")
        const before = {
            author: issue("SMI_NEW", held.issueNumber),
            stranger: issue("SMI_STRANGER", held.issueNumber),
            maintainer: issue("SMI_MAINT", held.issueNumber),
            listed: lib.op("SMI_STRANGER", SITE, "findIssues", {repositoryId: ids.repositoryId}).counts.open,
            mine: lib.op("SMI_NEW", SITE, "findIssues", {repositoryId: ids.repositoryId}).counts.open
        }
        // an Owner's comment that mentions a stranger while the issue is held tells that stranger nothing
        lib.settled(SITE, "SMI_OWNER")
        const mention = lib.comment("SMI_OWNER", SITE, held.rootCommEventId, "What does @smistranger think")
        lib.run("mantle.forum.DeliveryWorkerServices.dispatch#Outbox", {})
        const box = lib.row("mantle.forum.ForumOutbox", {communicationEventId: mention.postId, eventType: "post"})
        before.told = Array.from(
            ec.entity.find("mantle.forum.ForumDelivery").condition("outboxId", box.outboxId).disableAuthz().list()
        ).map(row => row.partyId)
        const item = lib.row("mantle.forum.ForumReviewItem", {siteId: SITE, targetType: "post", targetId: held.rootCommEventId})
        const decide = username =>
            lib.op(username, SITE, "decideReview", {
                reviewId: item.reviewId,
                decision: "approved",
                reason: "Fine",
                expectedRevision: Number(item.revision)
            })
        const byMaintainer = decide("SMI_MAINT")
        const byOwner = decide("SMI_OWNER")
        return {held, before, item, byMaintainer, byOwner, after: issue("SMI_STRANGER", held.issueNumber)}
    },
    then({held, before, item, byMaintainer, byOwner, after}) {
        held.state == "pending"
        before.author.pending == true
        before.stranger.kind == "NotFound"
        before.maintainer.kind == "NotFound"
        before.told.includes("SMI_STRANGER") == false
        // in a stranger's list and count it is not there; in its author's it is
        before.listed == 0
        before.mine == 1
        // the review item is in the scope's category, and a Maintainer is no moderator of it
        item.contactListId == lib.row("mantle.smithy.SmithyGroup", {groupId: ids.groupId}).contactListId
        item.reasonFamily == "first-post"
        byMaintainer.kind == "Unauthorized"
        byOwner.state == "approved"
        after.issue.title == "Held"
    }
})

feature("a public task of the tracker's project becomes an issue; one of a project only linked to the repository never", {
    when() {
        const make = (rootWorkEffortId, workEffortName, visibilityEnumId) =>
            lib.run("mantle.work.TaskServices.create#Task", {
                rootWorkEffortId,
                workEffortName,
                visibilityEnumId,
                description: "From Projects"
            }).workEffortId
        const numberOf = workEffortId => lib.row("mantle.smithy.SmithyIssue", {workEffortId})?.issueNumber ?? null
        const shown = make(ids.projectId, "Made in Projects", "WevGeneral")
        const internal = make(ids.projectId, "Internal", "WevWorkGroup")
        // a client's project, linked to the repository in Projects
        const other = lib.run("mantle.work.ProjectServices.create#Project", {
            workEffortId: "SMIX",
            workEffortName: "Linked"
        }).workEffortId
        lib.run("mantle.work.GitServices.add#ProjectRepository", {workEffortId: other, repositoryId: ids.repositoryId})
        const linked = make(other, "Shared with a client", "WevGeneral")
        const number = Number(numberOf(shown))
        const publicRead = issue(null, number)
        lib.run("update#mantle.work.effort.WorkEffort", {workEffortId: shown, visibilityEnumId: "WevWorkGroup"})
        return {
            number,
            publicRead,
            internal: numberOf(internal),
            linked: numberOf(linked),
            leftStranger: issue("SMI_STRANGER", number),
            leftReporter: issue("SMI_REPORTER", number)
        }
    },
    then({number, publicRead, internal, linked, leftStranger, leftReporter}) {
        number > 3
        publicRead.issue.title == "Made in Projects"
        internal == null
        linked == null
        // the task left WevGeneral: Not Found below a Reporter, and its number is kept
        leftStranger.kind == "NotFound"
        leftReporter.issue.issueNumber == number
    }
})

feature("an edit is counted and ruled as a new post is; an archived repository and the day's limit refuse", {
    when() {
        const root = issue(null, 1).issue.topic.rootCommEventId
        lib.settled(SITE, "SMI_STRANGER")
        const posted = lib.comment("SMI_STRANGER", SITE, root, "Plain at first")
        const edit = body => lib.op("SMI_STRANGER", SITE, "updatePost", {postId: posted.postId, body, expectedRevision: 1})
        lib.make("mantle.forum.ForumRule", {
            ruleId: "SMI_HOLD",
            siteId: SITE,
            ruleType: "word",
            pattern: "smiholdword",
            action: "approve",
            enabled: "Y",
            priority: 1,
            revision: 1
        })
        const links = edit(Array.from({length: 11}, (_, index) => '<a href="https://x.test/' + index + '">x</a>').join(" "))
        const ruled = edit("Now with smiholdword in it")
        const renamed = write("SMI_STRANGER", "updateIssue", 2, {title: "A smiholdword title"})
        // the day's limit of issues at the account's trust level
        lib.set(
            "mantle.forum.ForumMemberState",
            {siteId: SITE, partyId: "SMI_AUTHOR"},
            {
                dayKey: String(ec.user.nowTimestamp).slice(0, 10),
                dailyCounts: JSON.stringify({issue: 10}),
                lastPostedAt: null
            }
        )
        const limited = lib.file("SMI_AUTHOR", SITE, ids.repositoryId, "One too many")
        lib.set("moqui.resource.GitRepository", {repositoryId: ids.repositoryId}, {archivedDate: ec.user.nowTimestamp})
        lib.settled(SITE, "SMI_STRANGER")
        const archived = {
            file: lib.file("SMI_STRANGER", SITE, ids.repositoryId, "Too late"),
            note: lib.comment("SMI_STRANGER", SITE, root, "Too late")
        }
        lib.set("moqui.resource.GitRepository", {repositoryId: ids.repositoryId}, {archivedDate: null})
        return {links, ruled, renamed, limited, archived}
    },
    then({links, ruled, renamed, limited, archived}) {
        links.kind == "Unprocessable"
        ruled.kind == "Unprocessable"
        renamed.kind == "Unprocessable"
        limited.kind == "Tarpit"
        limited.reason == "limitReached"
        archived.file.reason == "repositoryArchived"
        archived.note.reason == "repositoryArchived"
    }
})

feature("a label and a milestone are their repository's: a sibling of the same project neither lists nor changes them", {
    when() {
        // a second repository of the group that shares the first one's project
        lib.set("mantle.smithy.SmithyGroup", {groupId: ids.groupId}, {workEffortId: ids.projectId})
        const sibling = lib.createRepository(lib.OPERATOR, {
            siteId: SITE,
            groupId: ids.groupId,
            slug: "sibling",
            visibility: "public"
        }).repositoryId
        const shared = lib.issuesOn(SITE, sibling)
        const label = lib.op(null, SITE, "findLabels", {repositoryId: ids.repositoryId}).labelList[0]
        const milestone = lib.op(null, SITE, "findMilestones", {repositoryId: ids.repositoryId, state: "all"}).milestoneList[0]
        const before = issue(null, 2).issue.labels.length
        return {
            shared,
            label,
            labels: lib.op(null, SITE, "findLabels", {repositoryId: sibling}).labelList,
            milestones: lib.op(null, SITE, "findMilestones", {repositoryId: sibling, state: "all"}).milestoneList,
            rename: lib.op("SMI_MAINT", SITE, "storeLabel", {
                repositoryId: sibling,
                labelId: label.labelId,
                name: "taken",
                expectedRevision: label.revision
            }),
            remove: lib.op("SMI_MAINT", SITE, "deleteLabel", {repositoryId: sibling, labelId: label.labelId}),
            plan: lib.op("SMI_MAINT", SITE, "storeMilestone", {
                repositoryId: sibling,
                milestoneId: milestone.milestoneId,
                name: "2.0",
                expectedRevision: milestone.revision
            }),
            before,
            after: issue(null, 2).issue.labels.length,
            described: lib.op("SMI_MAINT", SITE, "storeLabel", {
                repositoryId: sibling,
                name: "docs",
                description: "About the docs",
                operationId: "smi-label-9"
            }),
            own: () => lib.op(null, SITE, "findLabels", {repositoryId: sibling}).labelList
        }
    },
    then({shared, label, labels, milestones, rename, remove, plan, before, after, described, own}) {
        shared == ids.projectId
        label.name == "bug"
        labels == []
        milestones == []
        rename.kind == "NotFound"
        remove.kind == "NotFound"
        plan.kind == "NotFound"
        before == 1
        after == 1
        described.kind == null
        own().map(row => [row.name, row.description, row.editable]) == [["docs", "About the docs", true]]
    }
})
