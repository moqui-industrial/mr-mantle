// Confidential issues (mr-pass plan/design-smithy.md §8.3, §12.1; SmithyCore.issueAccess, SmithyScope.js): any confirmed
// account files one; it is Not Found to a stranger, a Reporter and a Maintainer, in their lists and counts too; its
// reporter keeps the reporter's fields, their own text and the replies addressed to them, never an "Owners only" post;
// its Owners read all of it and are told of what is filed; a held post of it is in no site moderator's queue, only its
// Owners', and its text is not queued for the classifier; in Projects its task is hidden from the project's manager
// and not from an Owner; an Owner makes it public as it is (a staff post stays staff) or as a new issue. Spec-local site,
// accounts and a db repository. Regression suite: these are rules. Run: ./moq test mr-mantle --spec SmithyConfidential
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const SITE = "SMC_SITE"
const ids = {}
const issue = (username, issueNumber) => lib.op(username, SITE, "getIssue", {repositoryId: ids.repositoryId, issueNumber})
const numbers = (username, more) =>
    (lib.op(username, SITE, "findIssues", {repositoryId: ids.repositoryId, ...more}).issueList || []).map(row => row.issueNumber)
const posts = (username, rootCommEventId) =>
    (lib.op(username, SITE, "getPosts", {rootCommEventId}).postList || []).map(post => post.body.replace(/<[^>]*>/g, "").trim())
const told = postId => {
    const box = lib.row("mantle.forum.ForumOutbox", {communicationEventId: postId, eventType: "post"})
    return Array.from(
        ec.entity.find("mantle.forum.ForumDelivery").condition({outboxId: box.outboxId, channel: "in-app"}).disableAuthz().list()
    )
        .map(row => row.partyId)
        .sort()
}

spec({
    requires: ["git"],
    setupSpec() {
        login(lib.OPERATOR)
        lib.site(SITE)
        Object.assign(ids, lib.tracker(SITE, "SMC", "smctrack"))
        lib.account(SITE, "SMC_MOD", {member: true, siteRole: "moderator"})
        lib.account(SITE, "SMC_NEW", {handle: "smcnew"})
        lib.account(SITE, "SMC_PM", {internal: true})
        // an internal account that is an Owner of the group: a member of the companion project
        lib.account(SITE, "SMC_STAFF_OWNER", {internal: true})
        lib.role(SITE, {groupId: ids.groupId}, "SMC_STAFF_OWNER", "SmrOwner")
        lib.make("mantle.work.effort.WorkEffortParty", {
            workEffortId: ids.projectId,
            partyId: "SMC_PM",
            roleTypeId: "Manager",
            fromDate: ec.user.timestampMillis(ec.user.nowTimestamp) - 1000
        })
        // the manager may ask for a record's timeline, as a Projects user may: the record's own rule then decides
        lib.make("moqui.security.ArtifactGroup", {artifactGroupId: "SMC_TIMELINE", description: "Smithy spec"})
        lib.make("moqui.security.ArtifactGroupMember", {
            artifactGroupId: "SMC_TIMELINE",
            artifactName: "mantle.party.CommunicationServices.get#RecordLinkInfo",
            artifactTypeEnumId: "AT_SERVICE",
            inheritAuthz: "Y"
        })
        lib.make("moqui.security.ArtifactAuthz", {
            artifactAuthzId: "SMC_TIMELINE",
            userGroupId: "SMC_PM",
            artifactGroupId: "SMC_TIMELINE",
            authzTypeEnumId: "AUTHZT_ALWAYS",
            authzActionEnumId: "AUTHZA_ALL"
        })
        lib.make("mantle.forum.ForumPolicy", {siteId: SITE, policyRevision: 1, config: JSON.stringify({classifierEnabled: true})})
    }
})

feature("a confidential issue is Not Found, and in no list or count, for all but its Owners and its reporter", {
    when() {
        ids.secret = lib.file("SMC_AUTHOR", SITE, ids.repositoryId, "A hole", {confidential: true, body: "SMC-SECRET-TEXT"})
        ids.open = lib.file("SMC_STRANGER", SITE, ids.repositoryId, "In the open")
        const classified = root => !!lib.row("mantle.forum.ForumOutbox", {communicationEventId: root, eventType: "classify"})
        return {
            stranger: issue("SMC_STRANGER", 1),
            reporterRole: issue("SMC_REPORTER", 1),
            maintainer: issue("SMC_MAINT", 1),
            author: issue("SMC_AUTHOR", 1),
            owner: issue("SMC_OWNER", 1),
            listed: {
                stranger: numbers("SMC_STRANGER"),
                maintainer: numbers("SMC_MAINT"),
                owner: numbers("SMC_OWNER"),
                author: numbers("SMC_AUTHOR")
            },
            counted: lib.op("SMC_MAINT", SITE, "findIssues", {repositoryId: ids.repositoryId}).counts.open,
            only: {
                owner: numbers("SMC_OWNER", {confidential: "only"}),
                maintainer: lib.op("SMC_MAINT", SITE, "findIssues", {repositoryId: ids.repositoryId, confidential: "only"})
            },
            visibility: lib.row("mantle.work.effort.WorkEffort", {
                workEffortId: lib.row("mantle.smithy.SmithyIssue", {repositoryId: ids.repositoryId, issueNumber: 1}).workEffortId
            }).visibilityEnumId,
            classified: {secret: classified(ids.secret.rootCommEventId), open: classified(ids.open.rootCommEventId)}
        }
    },
    then({stranger, reporterRole, maintainer, author, owner, listed, counted, only, visibility, classified}) {
        stranger.kind == "NotFound"
        reporterRole.kind == "NotFound"
        maintainer.kind == "NotFound"
        // the reporter: exactly the reporter's fields
        Object.keys(author.issue).sort() ==
            [
                "author",
                "closedAt",
                "commentCount",
                "confidential",
                "createdAt",
                "issueNumber",
                "repositoryPath",
                "revision",
                "state",
                "stateReason",
                "title",
                "topic",
                "updatedAt"
            ]
        author.capabilities.canTriage == false
        owner.issue.confidential == true
        owner.issue.labels == []
        owner.capabilities.canSetConfidential == true
        listed == {stranger: [2], maintainer: [2], owner: [2, 1], author: [2, 1]}
        counted == 1
        only.owner == [1]
        only.maintainer.reason == "accessDenied"
        visibility == "WevConfidential"
        // its text is never queued for the classifier; a public issue's is
        classified == {secret: false, open: true}
    }
})

feature(
    "the reporter reads their own text and the replies addressed to them, never an Owners only post, and only they and the Owners are told",
    {
        when() {
            const root = ids.secret.rootCommEventId
            const reply = lib.comment("SMC_OWNER", SITE, root, "SMC-REPLY-TO-REPORTER")
            const staff = lib.comment("SMC_OWNER", SITE, root, "SMC-OWNERS-ONLY", {ownersOnly: true})
            const byReporter = lib.comment("SMC_AUTHOR", SITE, root, "Never", {ownersOnly: true})
            lib.run("mantle.forum.DeliveryWorkerServices.dispatch#Outbox", {})
            const notices = username =>
                (lib.op(username, SITE, "findNotifications", {}).notificationList || []).map(row => row.postId)
            return {
                reply,
                staff,
                byReporter,
                reporter: posts("SMC_AUTHOR", root),
                owner: posts("SMC_OWNER", root),
                stranger: lib.op("SMC_STRANGER", SITE, "getPosts", {rootCommEventId: root}),
                staffPost: lib.op("SMC_AUTHOR", SITE, "getPostLocation", {postId: staff.postId}),
                count: issue("SMC_AUTHOR", 1).issue.commentCount,
                told: {filed: told(root), reply: told(reply.postId), staff: told(staff.postId)},
                notices: {reporter: notices("SMC_AUTHOR"), maintainer: notices("SMC_MAINT")}
            }
        },
        then({reply, staff, byReporter, reporter, owner, stranger, staffPost, count, told, notices}) {
            byReporter.kind == "Unauthorized"
            reporter == ["SMC-SECRET-TEXT", "SMC-REPLY-TO-REPORTER"]
            owner == ["SMC-SECRET-TEXT", "SMC-REPLY-TO-REPORTER", "SMC-OWNERS-ONLY"]
            stranger.kind == "NotFound"
            staffPost.kind == "NotFound"
            count == 1
            // what is filed is told to the Owners (the operator made the group and owns it too), a reply to the reporter,
            // an Owners only post to the other Owners; a Maintainer hears nothing
            told.filed == ["EX_JOHN_DOE", "SMC_OWNER", "SMC_STAFF_OWNER"]
            told.reply == ["EX_JOHN_DOE", "SMC_AUTHOR", "SMC_STAFF_OWNER"]
            told.staff == ["EX_JOHN_DOE", "SMC_STAFF_OWNER"]
            notices.reporter == [reply.postId]
            notices.maintainer == []
        }
    }
)

feature("a held post of a confidential issue is in its Owners' queue only, and is not classified", {
    when() {
        const held = lib.file("SMC_NEW", SITE, ids.repositoryId, "Held and secret", {confidential: true})
        const item = lib.row("mantle.forum.ForumReviewItem", {siteId: SITE, targetType: "post", targetId: held.rootCommEventId})
        const queue = username => (lib.op(username, SITE, "findReviews", {}).reviewList || []).map(row => row.reviewId)
        return {
            held,
            item,
            moderator: {queue: queue("SMC_MOD"), read: lib.op("SMC_MOD", SITE, "getReview", {reviewId: item.reviewId})},
            owner: {queue: queue("SMC_OWNER"), read: lib.op("SMC_OWNER", SITE, "getReview", {reviewId: item.reviewId})},
            classify: lib.row("mantle.forum.ForumOutbox", {communicationEventId: held.rootCommEventId, eventType: "classify"})
        }
    },
    then({held, item, moderator, owner, classify}) {
        held.state == "pending"
        moderator.queue.includes(item.reviewId) == false
        moderator.read.kind == "Unauthorized"
        owner.queue.includes(item.reviewId) == true
        owner.read.post.title == "Held and secret"
        classify == null
    }
})

feature("in Projects the task of a confidential issue is hidden from the project's manager, not from an Owner", {
    when() {
        const task = lib.row("mantle.smithy.SmithyIssue", {repositoryId: ids.repositoryId, issueNumber: 1}).workEffortId
        const visible = username =>
            lib.as(username, () =>
                ec.service.sync().name("mantle.work.ProjectServices.get#VisibleProjectInfo").disableAuthz().call()
            )
        const shown = username =>
            lib.as(username, () =>
                ec.service
                    .sync()
                    .name("mantle.smithy.SmithyIssueServices.get#TaskIssue")
                    .parameter("workEffortId", task)
                    .disableAuthz()
                    .call()
            ).issueNumber
        // as Projects asks it, with authorization on: the record's own rule decides
        const timeline = workEffortId =>
            lib.as("SMC_PM", () => {
                ec.service
                    .sync()
                    .name("mantle.party.CommunicationServices.get#RecordLinkInfo")
                    .parameters({recordEntityName: "mantle.work.effort.WorkEffort", recordId: workEffortId})
                    .call()
                return ec.message.getErrorsString() || ""
            })
        const open = lib.row("mantle.smithy.SmithyIssue", {repositoryId: ids.repositoryId, issueNumber: 2}).workEffortId
        ids.timeline = {hidden: timeline(task), open: timeline(open)}
        return {
            task,
            manager: visible("SMC_PM"),
            owner: visible("SMC_OWNER"),
            shown: {manager: shown("SMC_PM"), owner: shown("SMC_OWNER")}
        }
    },
    then({task, manager, owner, shown}) {
        // and the task's issue is answered to an Owner alone
        shown.manager == null
        shown.owner == 1
        // its timeline (and so its Chatter) is not the manager's either; a public issue's task's is
        ids.timeline.hidden != ""
        ids.timeline.open == ""
        // the manager manages the project and still does not see this task
        manager.managedProjectIds.includes(ids.projectId) == true
        manager.hiddenItemIds.includes(task) == true
        owner.hiddenItemIds.includes(task) == false
    }
})

feature("an Owner makes it public as it is, where a staff post stays staff, or as a new issue", {
    when() {
        const revision = number => issue("SMC_OWNER", number).issue.revision
        const byMaintainer = lib.op("SMC_MAINT", SITE, "setIssueConfidential", {
            repositoryId: ids.repositoryId,
            issueNumber: 2,
            confidential: true,
            expectedRevision: revision(2)
        })
        const opened = lib.op("SMC_OWNER", SITE, "setIssueConfidential", {
            repositoryId: ids.repositoryId,
            issueNumber: 1,
            confidential: false,
            expectedRevision: revision(1)
        })
        lib.settled(SITE, "SMC_OWNER")
        const asNew = lib.op("SMC_OWNER", SITE, "setIssueConfidential", {
            repositoryId: ids.repositoryId,
            issueNumber: 3,
            confidential: false,
            asNewIssue: true,
            title: "What can be said",
            body: "A public account of it",
            expectedRevision: revision(3),
            operationId: "smc-as-new-1"
        })
        return {
            byMaintainer,
            opened,
            asNew,
            stranger: posts("SMC_STRANGER", ids.secret.rootCommEventId),
            kept: issue("SMC_STRANGER", 3),
            made: issue("SMC_STRANGER", asNew.newIssueNumber)
        }
    },
    then({byMaintainer, opened, asNew, stranger, kept, made}) {
        byMaintainer.reason == "accessDenied"
        opened.confidential == false
        stranger == ["SMC-SECRET-TEXT", "SMC-REPLY-TO-REPORTER"]
        asNew.newIssueNumber == 4
        kept.kind == "NotFound"
        made.issue.title == "What can be said"
        made.issue.confidential == false
    }
})

feature(
    "a reply by mail is a comment by its confirmed sender, Owners only when it answers an Owners only post, and nothing for a non-account",
    {
        when() {
            lib.make("mantle.forum.ForumMailRoute", {
                routeId: "SMC_ROUTE",
                siteId: SITE,
                address: "issues@smithy.test",
                enabled: "Y",
                revision: 1,
                createdAt: ec.user.nowTimestamp
            })
            const root = ids.secret.rootCommEventId
            const states = () =>
                Array.from(
                    ec.entity
                        .find("mantle.forum.ForumPostSearch")
                        .condition("rootCommEventId", root)
                        .orderBy("ordinal")
                        .disableAuthz()
                        .list()
                )
            const staffPost = states().find(row => row.visibility == "staff").communicationEventId
            const forum = ec.resource.script("component://mr-mantle/service/mantle/forum/Forum.js")
            const mail = (partyId, from, postId, text) => {
                lib.settled(SITE, partyId)
                const was = ec.artifactExecution.disableAuthz()
                const to = forum.replyAddress(SITE, root, null, partyId, postId)
                if (!was) ec.artifactExecution.enableAuthz()
                return lib.run("mantle.forum.DeliveryServices.process#Inbound", {
                    emailMessageId: null,
                    headers: {
                        "delivered-to": to,
                        "message-id": "<" + ec.user.randomString(16) + "@smithy.test>",
                        "authentication-results": "gw.example.test; dmarc=pass header.from=smithy.test"
                    },
                    fields: {from, subject: "Re: an issue", toList: [to]},
                    bodyPartList: [{contentType: "text/plain; charset=utf-8", contentText: text}]
                }).result
            }
            const before = states().length
            return {
                plain: mail("SMC_AUTHOR", "smc_author@smithy.test", root, "SMC-BY-MAIL"),
                toStaff: mail("SMC_OWNER", "smc_owner@smithy.test", staffPost, "SMC-STAFF-BY-MAIL"),
                // the reporter answers a mail it should never have had: not posted for it
                leaked: mail("SMC_AUTHOR", "smc_author@smithy.test", staffPost, "SMC-NEVER"),
                unknown: mail("SMC_AUTHOR", "nobody@elsewhere.test", root, "SMC-NOBODY"),
                posts: states()
                    .slice(before)
                    .map(row => [row.fromPartyId, row.visibility]),
                reporter: posts("SMC_AUTHOR", root)
            }
        },
        then({plain, toStaff, leaked, unknown, posts, reporter}) {
            plain.result == "posted"
            toStaff.result == "posted"
            leaked.result == "rejected"
            unknown.result == "held"
            posts ==
                [
                    ["SMC_AUTHOR", "approved"],
                    ["SMC_OWNER", "staff"]
                ]
            reporter.includes("SMC-BY-MAIL") == true
            reporter.includes("SMC-STAFF-BY-MAIL") == false
        }
    }
)

feature("a review item on an Owners only post is its Owners', not the site's moderators'", {
    when() {
        const root = ids.open.rootCommEventId
        lib.settled(SITE, "SMC_OWNER")
        const staff = lib.comment("SMC_OWNER", SITE, root, "SMC-STAFF-ON-PUBLIC", {ownersOnly: true})
        const topic = lib.row("mantle.forum.ForumTopic", {rootCommEventId: root})
        lib.make("mantle.forum.ForumReviewItem", {
            reviewId: "SMC_STAFF_ITEM",
            siteId: SITE,
            contactListId: topic.contactListId,
            targetType: "post",
            targetId: staff.postId,
            targetRevision: 1,
            reasonFamily: "flag",
            state: "pending",
            revision: 1,
            createdAt: ec.user.nowTimestamp
        })
        const read = username => lib.op(username, SITE, "getReview", {reviewId: "SMC_STAFF_ITEM"})
        const queue = username => (lib.op(username, SITE, "findReviews", {}).reviewList || []).map(row => row.reviewId)
        return {
            moderator: {read: read("SMC_MOD"), queue: queue("SMC_MOD")},
            owner: read("SMC_OWNER"),
            classify: lib.row("mantle.forum.ForumOutbox", {communicationEventId: staff.postId, eventType: "classify"})
        }
    },
    then({moderator, owner, classify}) {
        moderator.read.kind == "Unauthorized"
        moderator.queue.includes("SMC_STAFF_ITEM") == false
        owner.post.body.includes("SMC-STAFF-ON-PUBLIC") == true
        classify == null
    }
})

feature(
    "a confidential issue's task is in a project of the Owners alone, so Projects' readers give the tracker's manager nothing; a change moves it",
    {
        when() {
            const repo = () => lib.row("mantle.smithy.SmithyRepository", {repositoryId: ids.repositoryId})
            const taskOf = number =>
                lib.row("mantle.work.effort.WorkEffort", {
                    workEffortId: lib.row("mantle.smithy.SmithyIssue", {repositoryId: ids.repositoryId, issueNumber: number})
                        .workEffortId
                })
            // issue 3 is still confidential (issue 1 was made public): its task, with time on it
            const task = taskOf(3)
            lib.make("mantle.work.time.TimeEntry", {workEffortId: task.workEffortId, partyId: "SMC_STAFF_OWNER", hours: 1})
            const read = (username, name, parameters) =>
                lib.as(username, () => ec.service.sync().name(name).parameters(parameters).disableAuthz().call() || {})
            const sees = username => ({
                project: Array.from(
                    read(username, "mantle.work.ProjectServices.get#VisibleProjectInfo", {}).visibleProjectIds
                ).includes(task.rootWorkEffortId),
                items: Array.from(
                    read(username, "mantle.work.ProjectServices.get#WorkItemTree", {workEffortIds: [task.workEffortId]})
                        .workItemList || []
                ).length,
                time: Array.from(
                    read(username, "mantle.work.TimeServices.find#TimeEntries", {workEffortId: task.workEffortId}).rowList || []
                ).length,
                today: JSON.stringify(read(username, "mantle.work.WorkEffortServices.get#UserTodayItems", {})).includes(
                    task.workEffortId
                )
            })
            const seen = {manager: sees("SMC_PM"), owner: sees("SMC_STAFF_OWNER")}
            const members = Array.from(
                ec.entity
                    .find("mantle.work.effort.WorkEffortParty")
                    .condition("workEffortId", task.rootWorkEffortId)
                    .disableAuthz()
                    .list()
            )
                .map(row => row.partyId)
                .sort()
            // issue 2 is public: made confidential it moves to the companion project, and made public again it moves back
            const flip = confidential =>
                lib.op("SMC_OWNER", SITE, "setIssueConfidential", {
                    repositoryId: ids.repositoryId,
                    issueNumber: 2,
                    confidential,
                    expectedRevision: issue("SMC_OWNER", 2).issue.revision
                })
            const start = taskOf(2).rootWorkEffortId
            flip(true)
            const moved = taskOf(2)
            flip(false)
            return {task, companion: repo().confidentialWorkEffortId, seen, members, start, moved, back: taskOf(2)}
        },
        then({task, companion, seen, members, start, moved, back}) {
            task.rootWorkEffortId == companion
            companion != ids.projectId
            // the reporter is on the issue only: no owner party on the task
            task.ownerPartyId == null
            seen.manager == {project: false, items: 0, time: 0, today: false}
            seen.owner.project == true
            seen.owner.items == 1
            seen.owner.time == 1
            // exactly the internal accounts that are Owners (the operator made the group)
            members == ["EX_JOHN_DOE", "SMC_STAFF_OWNER"]
            start == ids.projectId
            moved.rootWorkEffortId == companion
            moved.visibilityEnumId == "WevConfidential"
            moved.ownerPartyId == null
            back.rootWorkEffortId == ids.projectId
            back.visibilityEnumId == "WevGeneral"
        }
    }
)
