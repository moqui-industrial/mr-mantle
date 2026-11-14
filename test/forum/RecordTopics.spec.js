// The conversation of a record: a ForumTopic of kind record, an issue's (mr-pass plan/design-smithy.md §12.1, §6.1;
// ForumCore.js topic and recordAccess, SmithyScope.js, RecordPosts.js). It is in no topic list, search or feed of the forum,
// in no internal thread read, party communication list or search document; the topic actions, an accepted answer, a
// case and a tag are refused for it, while a reader's own actions (read, react, history) take it under the record's
// rule; a site moderator who may not view a private repository does not moderate its conversation, and its Owner does;
// Markdown is rendered and cleaned as a post is, its source kept, and an edit keeps the format; #n and @handle are
// linked for a reader who may see them, never inside code. Spec-local site, accounts and db repositories. Regression
// suite: these are rules. Run: ./moq test mr-mantle --spec RecordTopics
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const SITE = "RTX_SITE"
const ids = {}
const refusal = (username, operation, input) => lib.op(username, SITE, operation, input).kind || null

spec({
    requires: ["git"],
    setupSpec() {
        login(lib.OPERATOR)
        lib.site(SITE)
        Object.assign(ids, lib.tracker(SITE, "RTX", "rtxtrack"))
        lib.account(SITE, "RTX_MOD", {member: true, siteRole: "moderator"})
        lib.account(SITE, "RTX_UNCONFIRMED", {unconfirmed: true})
        ids.first = lib.file("RTX_AUTHOR", SITE, ids.repositoryId, "RTXUNIQUE title", {body: "RTXUNIQUE words"})
        // a private repository of a private group, with one issue by its Owner
        ids.privateGroup = lib.createGroup(lib.OPERATOR, {siteId: SITE, pathSegment: "rtxprivate", visibility: "private"}).groupId
        ids.privateRepository = lib.createRepository(lib.OPERATOR, {
            siteId: SITE,
            groupId: ids.privateGroup,
            slug: "code"
        }).repositoryId
        lib.issuesOn(SITE, ids.privateRepository)
        lib.role(SITE, {groupId: ids.privateGroup}, "RTX_OWNER", "SmrOwner")
        lib.role(SITE, {groupId: ids.privateGroup}, "RTX_REPORTER", "SmrGuest")
        lib.settled(SITE, "RTX_OWNER")
        ids.hidden = lib.file("RTX_OWNER", SITE, ids.privateRepository, "Inside")
    }
})

feature("a record topic is in no topic list, search, feed, internal thread, party list or search document", {
    when() {
        const root = ids.first.rootCommEventId
        const thread = lib.as("RTX_AUTHOR", () =>
            ec.service
                .sync()
                .name("mantle.party.CommunicationServices.get#InternalThreadMessages")
                .parameters({rootCommEventIdList: [root]})
                .disableAuthz()
                .call()
        )
        return {
            topics: (lib.op("RTX_AUTHOR", SITE, "findTopics", {}).topicList || []).map(topic => topic.rootCommEventId),
            search: lib.op("RTX_AUTHOR", SITE, "searchForum", {query: "RTXUNIQUE"}),
            feed: JSON.stringify(lib.op(null, SITE, "getFeed", {format: "rss"})),
            thread: Object.keys(thread.threadMap || {}),
            party: Array.from(
                lib.run("mantle.party.CommunicationServices.find#PartyCommunicationEvents", {partyId: "RTX_AUTHOR"}).commEventList
            ).map(row => row.communicationEventId),
            document: lib.run("mantle.request.PeopleCaseServices.get#CaseDocumentData", {
                dataDocumentId: "MantleCommunicationEvent",
                document: {communicationEventId: root, subject: "RTXUNIQUE title"}
            }).document,
            // and it is read where it belongs
            read: lib.op(null, SITE, "getTopic", {rootCommEventId: root}).topic
        }
    },
    then({topics, search, feed, thread, party, document, read}) {
        topics == []
        search.topicList == []
        feed.includes("RTXUNIQUE") == false
        thread == []
        party == []
        // marked as a confidential case's message is: the document's condition leaves it out of the index
        document.confidentialCase == "Y"
        read.kind == "record"
        read.category == null
    }
})

feature(
    "the topic actions, an answer, a case, a tag and a new topic's draft are refused for a record; a reader's own actions take it",
    {
        when() {
            const root = ids.first.rootCommEventId
            const revision = lib.op(lib.OPERATOR, SITE, "getTopic", {rootCommEventId: root}).topic.revision
            lib.settled(SITE, "RTX_AUTHOR")
            return {
                pin: refusal(lib.OPERATOR, "applyTopicAction", {
                    rootCommEventId: root,
                    action: "pin",
                    reason: "No",
                    expectedRevision: revision
                }),
                answer: refusal(lib.OPERATOR, "acceptAnswer", {rootCommEventId: root, postId: root, expectedRevision: revision}),
                aCase: refusal(lib.OPERATOR, "createCaseFromTopic", {
                    rootCommEventId: root,
                    postIds: [root],
                    reason: "No",
                    operationId: "rtx-case-1"
                }),
                tagged: refusal("RTX_AUTHOR", "publishPost", {
                    rootCommEventId: root,
                    body: "Tagged",
                    tags: ["x"],
                    operationId: "rtx-tags-1"
                }),
                draft: refusal("RTX_AUTHOR", "storeDraft", {rootCommEventId: root, mode: "new", body: "x", expectedRevision: 0}),
                links: lib.op(null, SITE, "getTopicLinks", {rootCommEventId: root}).linkList,
                // a reader's own: where a post is, a reaction, its history; an account with no confirmed address reacts to nothing
                location: lib.op(null, SITE, "getPostLocation", {postId: root}).kind,
                reaction: lib.op("RTX_STRANGER", SITE, "setReaction", {postId: root, reactionKey: "like", active: true})
                    .reactions,
                unconfirmed: lib.op("RTX_UNCONFIRMED", SITE, "setReaction", {postId: root, reactionKey: "like", active: true})
                    .reason,
                history: lib.op(null, SITE, "getPostHistory", {postId: root}).revisionList.length
            }
        },
        then({pin, answer, aCase, tagged, draft, links, location, reaction, unconfirmed, history}) {
            pin == "Unprocessable"
            answer == "Unprocessable"
            aCase == "Unprocessable"
            tagged == "Unprocessable"
            draft == "Unprocessable"
            links == []
            location == "record"
            reaction == {like: 1}
            unconfirmed == "addressUnconfirmed"
            history == 1
        }
    }
)

feature("a site moderator who may not view a private repository does not moderate its conversation; its Owner does", {
    when() {
        const root = ids.hidden.rootCommEventId
        const flagged = lib.op("RTX_REPORTER", SITE, "flagPost", {
            postId: root,
            reason: "Look at this",
            operationId: "rtx-flag-1"
        })
        const read = username => lib.op(username, SITE, "getReview", {reviewId: flagged.reviewId})
        return {
            flagged,
            item: lib.row("mantle.forum.ForumReviewItem", {reviewId: flagged.reviewId}),
            moderator: read("RTX_MOD"),
            moderatorTopic: refusal("RTX_MOD", "getTopic", {rootCommEventId: root}),
            owner: read("RTX_OWNER")
        }
    },
    then({flagged, item, moderator, moderatorTopic, owner}) {
        flagged.state == "pending"
        // the item is in the scope's category: the private group's own
        item.contactListId == lib.row("mantle.smithy.SmithyGroup", {groupId: ids.privateGroup}).contactListId
        moderator.kind == "Unauthorized"
        moderatorTopic == "NotFound"
        owner.post.title == "Inside"
    }
})

feature(
    "Markdown is rendered and cleaned, its source kept and an edit keeps the format; #n and @handle are linked outside code",
    {
        when() {
            const root = ids.first.rootCommEventId
            const source =
                "A **bold** word, see #1 and @rtxowner and #99\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n```\ncode #1\n```\n"
            const posted = lib.comment("RTX_STRANGER", SITE, root, source, {sourceFormat: "markdown"})
            const body = () =>
                lib.op(null, SITE, "getPosts", {rootCommEventId: root}).postList.find(post => post.postId == posted.postId).body
            const first = body()
            const edited = lib.op("RTX_STRANGER", SITE, "updatePost", {
                postId: posted.postId,
                body: "Now *slanted*",
                expectedRevision: 1
            })
            const revisions = Array.from(
                ec.entity
                    .find("mantle.forum.ForumPostRevision")
                    .condition("communicationEventId", posted.postId)
                    .orderBy("revision")
                    .disableAuthz()
                    .list()
            )
            return {
                posted,
                first,
                edited,
                second: body(),
                revisions: revisions.map(row => [row.sourceFormat, row.sourceText]),
                editable: lib.op("RTX_STRANGER", SITE, "getEditablePost", {postId: posted.postId}).draft,
                preview: lib.op("RTX_STRANGER", SITE, "previewPost", {
                    body: "_x_ <img src=x onerror=alert(1)>",
                    sourceFormat: "markdown"
                }).body,
                source
            }
        },
        then({posted, first, edited, second, revisions, editable, preview, source}) {
            posted.state == "published"
            first.includes("<strong>bold</strong>")
            // a script and a javascript: link do not survive the cleaning
            !/<script|javascript:|alert\(1\)<\/script/i.test(first)
            // fenced code is code, and a reference inside it is left as text
            first.search(/<pre><code>code #1\s*<\/code><\/pre>/) >= 0
            first.includes('<a href="/code/rtxtrack/code/-/issues/1">#1</a>')
            first.includes('<a href="/code/rtxowner">@rtxowner</a>')
            // an issue that is not there stays text
            first.includes("#99") && !first.includes("issues/99")
            edited.revision == 2
            second.includes("<em>slanted</em>")
            revisions ==
                [
                    ["markdown", source],
                    ["markdown", "Now *slanted*"]
                ]
            editable.sourceFormat == "markdown"
            editable.body == "Now *slanted*"
            preview.includes("<em>x</em>") && !/onerror/i.test(preview)
        }
    }
)
