// The forum inside Smithy (mr-pass plan/design-smithy.md §12.5, §15.7; plans/Dogfood.md §6.1, §6.4; SmithyForum.js
// setScopeForum and convertTopicToIssue, SmithyScope.js categoryView, Forum.js scopeOf, ForumCore.js sanctioned): a group's
// category is its forum when its Owner turns it on, and a repository's subcategory is under it; a read with a scope
// (scopeContactListId) gives the scope's subtree only, and a topic of another category is Not Found in it; the category
// is no wider than its group: a private group's is Not Found to a stranger and to a site moderator with no role through
// every scoped read, and in no unscoped one, while a Guest of the group reads and posts; a narrowed group narrows its
// category; a topic of the scope becomes an issue of a repository of it, by a Reporter, and stays linked to it; and a
// silence its Owner sets in a group's category refuses an issue in that group's repositories and not elsewhere.
// Spec-local site, groups, db repositories and accounts. Regression suite: these are rules.
// Run: ./moq test mr-mantle --spec SmithyForumScope
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const SITE = "SFS_SITE"
const ids = {}
const op = (username, operation, input) => lib.op(username, SITE, operation, input)
const kind = out => out.kind || null
const revisionOf = (entity, key) => Number(lib.row("mantle.smithy." + entity, key).revision || 1)
/* A topic by an account whose last post is long ago; gives its root. */
function topic(username, contactListId, title, body) {
    lib.settled(SITE, username)
    const out = op(username, "publishPost", {contactListId, title, body, operationId: "sfs-" + ec.user.randomString(12)})
    if (out.kind) throw new Error("No topic: " + out.message)
    return out.rootCommEventId
}
const titles = out => (out.topicList || []).map(row => row.title).sort()
/* Every scoped read of the forum as a user: the kind of each refusal, or what it found. */
const scoped = (username, scopeContactListId, rootCommEventId) => ({
    topics: kind(op(username, "findTopics", {scopeContactListId})),
    categories: kind(op(username, "findCategories", {scopeContactListId})),
    search: kind(op(username, "searchForum", {query: "SFSWORD", scopeContactListId})),
    tags: kind(op(username, "findTags", {scopeContactListId})),
    feed: kind(op(null, "getFeed", {format: "rss", scopeContactListId})),
    topic: kind(op(username, "getTopic", {rootCommEventId, scopeContactListId}))
})

spec({
    requires: ["git"],
    setupSpec() {
        login(lib.OPERATOR)
        lib.site(SITE)
        lib.make("mantle.public.PublicSiteHost", {siteId: SITE, hostname: "sfs.example.test", canonical: "Y"})
        Object.assign(ids, lib.tracker(SITE, "SFS", "sfsgroup"))
        lib.account(SITE, "SFS_MOD", {member: true, siteRole: "moderator"})
        // a private group whose Owner is the tracker's, with one Guest
        ids.privateGroup = lib.createGroup(lib.OPERATOR, {siteId: SITE, pathSegment: "sfsprivate", visibility: "private"}).groupId
        lib.role(SITE, {groupId: ids.privateGroup}, "SFS_OWNER", "SmrOwner")
        lib.role(SITE, {groupId: ids.privateGroup}, "SFS_REPORTER", "SmrGuest")
        // another public group with a tracker of its own
        ids.otherGroup = lib.createGroup(lib.OPERATOR, {siteId: SITE, pathSegment: "sfsother", visibility: "public"}).groupId
        ids.otherRepository = lib.createRepository(lib.OPERATOR, {
            siteId: SITE,
            groupId: ids.otherGroup,
            slug: "code",
            visibility: "public"
        }).repositoryId
        lib.issuesOn(SITE, ids.otherRepository)
        lib.role(SITE, {groupId: ids.otherGroup}, "SFS_OWNER", "SmrOwner")
        // a category of the site that is no group's
        ids.outside = lib.make("mantle.marketing.contact.ContactList", {
            contactListTypeEnumId: "MAILBOX",
            contactListName: "General",
            isPublic: "N",
            postingEnumId: "ClpAnyUser"
        }).contactListId
        lib.make("mantle.forum.ForumCategory", {
            contactListId: ids.outside,
            siteId: SITE,
            slug: ids.outside,
            sequenceNum: 0,
            publicationState: "published",
            visibility: "public",
            mode: "discussion",
            policyRevision: 1
        })
    }
})

feature("an Owner turns a group's forum on and a repository's under it; a scoped read gives the subtree only", {
    when() {
        const before = op(null, "getGroup", {groupId: ids.groupId}).forum
        const revision = revisionOf("SmithyGroup", {groupId: ids.groupId})
        const notOwner = op("SFS_MAINT", "setScopeForum", {groupId: ids.groupId, enabled: true, expectedRevision: revision})
        // a repository's forum is inside its group's
        const early = op("SFS_OWNER", "setScopeForum", {
            repositoryId: ids.repositoryId,
            enabled: true,
            expectedRevision: revisionOf("SmithyRepository", {repositoryId: ids.repositoryId})
        })
        const group = op("SFS_OWNER", "setScopeForum", {groupId: ids.groupId, enabled: true, expectedRevision: revision})
        const repository = op("SFS_OWNER", "setScopeForum", {
            repositoryId: ids.repositoryId,
            enabled: true,
            expectedRevision: revisionOf("SmithyRepository", {repositoryId: ids.repositoryId})
        })
        Object.assign(ids, {groupCategory: group.contactListId, repositoryCategory: repository.contactListId})
        ids.groupTopic = topic("SFS_AUTHOR", ids.groupCategory, "SFS in the group", "SFSWORD of the group")
        ids.repositoryTopic = topic("SFS_AUTHOR", ids.repositoryCategory, "SFS in the repository", "SFSWORD of the repository")
        ids.outsideTopic = topic("SFS_AUTHOR", ids.outside, "SFS outside", "SFSWORD of the site")
        const feed = op(null, "getFeed", {format: "rss", scopeContactListId: ids.groupCategory}).body
        return {
            before,
            notOwner,
            early,
            group,
            category: lib.row("mantle.forum.ForumCategory", {contactListId: ids.groupCategory}),
            child: lib.row("mantle.forum.ForumCategory", {contactListId: ids.repositoryCategory}),
            views: [
                op(null, "getGroup", {groupId: ids.groupId}).forum,
                op(null, "getRepository", {repositoryId: ids.repositoryId}).forum
            ],
            all: titles(op(null, "findTopics", {})),
            inGroup: titles(op(null, "findTopics", {scopeContactListId: ids.groupCategory})),
            inRepository: titles(op(null, "findTopics", {scopeContactListId: ids.repositoryCategory})),
            categoryOutside: kind(op(null, "findTopics", {scopeContactListId: ids.groupCategory, contactListId: ids.outside})),
            categories: (op(null, "findCategories", {scopeContactListId: ids.groupCategory}).categoryList || [])
                .map(row => row.contactListId)
                .sort(),
            search: titles(op(null, "searchForum", {query: "SFSWORD", scopeContactListId: ids.repositoryCategory})),
            feed: ["SFS in the group", "SFS in the repository", "SFS outside"].map(title => feed.includes(title)),
            feedLink: feed.includes("https://sfs.example.test/code/sfsgroup/-/forum/t/" + ids.groupTopic),
            topicInside: kind(op(null, "getTopic", {rootCommEventId: ids.groupTopic, scopeContactListId: ids.groupCategory})),
            topicOutside: kind(op(null, "getTopic", {rootCommEventId: ids.outsideTopic, scopeContactListId: ids.groupCategory})),
            topicAbove: kind(op(null, "getTopic", {rootCommEventId: ids.groupTopic, scopeContactListId: ids.repositoryCategory}))
        }
    },
    then({
        before,
        notOwner,
        early,
        group,
        category,
        child,
        views,
        all,
        inGroup,
        inRepository,
        categoryOutside,
        categories,
        search,
        feed,
        feedLink,
        topicInside,
        topicOutside,
        topicAbove
    }) {
        // made with the group, and not a forum until its Owner says
        before.enabled == false
        before.contactListId == null
        notOwner.reason == "accessDenied"
        early.reason == "policyRefused"
        group.enabled == true
        category.publicationState == "published"
        category.visibility == "public"
        child.parentContactListId == ids.groupCategory
        views.map(view => view.enabled) == [true, true]
        views.map(view => view.contactListId) == [ids.groupCategory, ids.repositoryCategory]
        all == ["SFS in the group", "SFS in the repository", "SFS outside"]
        inGroup == ["SFS in the group", "SFS in the repository"]
        inRepository == ["SFS in the repository"]
        categoryOutside == "NotFound"
        categories == [ids.groupCategory, ids.repositoryCategory].sort()
        search == ["SFS in the repository"]
        feed == [true, true, false]
        feedLink == true
        topicInside == null
        topicOutside == "NotFound"
        topicAbove == "NotFound"
    }
})

feature(
    "a private group's category is Not Found to a stranger through every scoped read; a Guest reads and posts; a narrowed group narrows its category",
    {
        when() {
            const on = op("SFS_OWNER", "setScopeForum", {
                groupId: ids.privateGroup,
                enabled: true,
                expectedRevision: revisionOf("SmithyGroup", {groupId: ids.privateGroup})
            })
            const root = topic("SFS_REPORTER", on.contactListId, "SFS private words", "SFSWORD kept private")
            // the other group's forum is on while it is public, then the group is members only
            const other = op("SFS_OWNER", "setScopeForum", {
                groupId: ids.otherGroup,
                enabled: true,
                expectedRevision: revisionOf("SmithyGroup", {groupId: ids.otherGroup})
            })
            const open = kind(op(null, "findTopics", {scopeContactListId: other.contactListId}))
            op("SFS_OWNER", "updateGroup", {groupId: ids.otherGroup, visibility: "members", expectedRevision: other.revision})
            return {
                category: lib.row("mantle.forum.ForumCategory", {contactListId: on.contactListId}).visibility,
                stranger: scoped("SFS_STRANGER", on.contactListId, root),
                moderator: scoped("SFS_MOD", on.contactListId, root),
                guest: scoped("SFS_REPORTER", on.contactListId, root),
                guestTopics: titles(op("SFS_REPORTER", "findTopics", {scopeContactListId: on.contactListId})),
                // and in no read without a scope
                unscoped: {
                    topics: titles(op("SFS_STRANGER", "findTopics", {})).includes("SFS private words"),
                    categories: (op("SFS_STRANGER", "findCategories", {}).categoryList || []).some(
                        row => row.contactListId === on.contactListId
                    ),
                    search: titles(op("SFS_STRANGER", "searchForum", {query: "kept private"})).length,
                    topic: kind(op("SFS_STRANGER", "getTopic", {rootCommEventId: root})),
                    reply: kind(
                        op("SFS_STRANGER", "publishPost", {
                            rootCommEventId: root,
                            body: "Let me in",
                            operationId: "sfs-stranger-reply"
                        })
                    )
                },
                open,
                narrowed: lib.row("mantle.forum.ForumCategory", {contactListId: other.contactListId}).visibility,
                closed: kind(op(null, "findTopics", {scopeContactListId: other.contactListId})),
                member: kind(op("SFS_STRANGER", "findTopics", {scopeContactListId: other.contactListId}))
            }
        },
        then({category, stranger, moderator, guest, guestTopics, unscoped, open, narrowed, closed, member}) {
            category == "category"
            const hidden = {
                topics: "NotFound",
                categories: "NotFound",
                search: "NotFound",
                tags: "NotFound",
                feed: "NotFound",
                topic: "NotFound"
            }
            stranger == hidden
            // a site moderator who may not view the group reads nothing of its forum
            moderator == hidden
            // the feed is the public's, and a private scope has none
            guest == {topics: null, categories: null, search: null, tags: null, feed: "NotFound", topic: null}
            guestTopics == ["SFS private words"]
            unscoped == {topics: false, categories: false, search: 0, topic: "NotFound", reply: "NotFound"}
            open == null
            narrowed == "members"
            closed == "NotFound"
            // a member of the site reads a members only group's forum
            member == null
        }
    }
)

feature("a topic of the scope becomes an issue of a repository of it, by a Reporter, and stays linked to it", {
    when() {
        const rootPost = ids.groupTopic
        const input = {
            repositoryId: ids.repositoryId,
            rootCommEventId: ids.groupTopic,
            postIds: [rootPost],
            title: "SFS from the forum"
        }
        const stranger = op("SFS_STRANGER", "convertTopicToIssue", {...input, operationId: "sfs-convert-1"})
        lib.settled(SITE, "SFS_REPORTER")
        const made = op("SFS_REPORTER", "convertTopicToIssue", {...input, operationId: "sfs-convert-2"})
        const issue = op("SFS_REPORTER", "getIssue", {repositoryId: ids.repositoryId, issueNumber: made.issueNumber}).issue
        const text = (op("SFS_REPORTER", "getPosts", {rootCommEventId: issue.topic.rootCommEventId}).postList || [])
            .map(post => post.body)
            .join(" ")
        const record = lib.row("mantle.smithy.SmithyIssue", {
            repositoryId: ids.repositoryId,
            issueNumber: made.issueNumber
        }).rootCommEventId
        return {
            stranger,
            made,
            issue,
            text,
            // the conversation of a record, and a topic of another forum, do not become issues here
            ofRecord: op("SFS_REPORTER", "convertTopicToIssue", {
                ...input,
                rootCommEventId: record,
                postIds: [record],
                operationId: "sfs-convert-3"
            }),
            outside: op("SFS_REPORTER", "convertTopicToIssue", {
                ...input,
                rootCommEventId: ids.outsideTopic,
                postIds: [ids.outsideTopic],
                operationId: "sfs-convert-4"
            }),
            links: op("SFS_STRANGER", "getTopicLinks", {rootCommEventId: ids.groupTopic}).linkList,
            topic: op(null, "getTopic", {rootCommEventId: ids.groupTopic}).topic
        }
    },
    then({stranger, made, issue, text, ofRecord, outside, links, topic}) {
        stranger.reason == "accessDenied"
        made.issueNumber >= 1
        issue.title == "SFS from the forum"
        issue.discussion.rootCommEventId == ids.groupTopic
        text.includes("SFSWORD of the group") == true
        text.includes("@sfsauthor") == true
        ofRecord.kind == "Unprocessable"
        outside.kind == "Unprocessable"
        links.map(link => link.sourceType + " " + link.path) == ["issue /code/sfsgroup/code/-/issues/" + made.issueNumber]
        // the topic stays
        topic.rootCommEventId == ids.groupTopic
    }
})

feature("a silence its Owner sets in a group's category refuses an issue in that group and not elsewhere", {
    when() {
        const silence = (username, operationId) =>
            op(username, "setSanction", {
                contactListId: ids.groupCategory,
                targetPartyId: "SFS_AUTHOR",
                kind: "silence",
                reason: "Off topic again and again",
                operationId
            })
        const maintainer = silence("SFS_MAINT", "sfs-silence-1")
        const owner = silence("SFS_OWNER", "sfs-silence-2")
        lib.settled(SITE, "SFS_AUTHOR")
        // the repository's conversations are in its own category, which is under the group's
        const here = lib.file("SFS_AUTHOR", SITE, ids.repositoryId, "SFS silenced here")
        const elsewhere = lib.file("SFS_AUTHOR", SITE, ids.otherRepository, "SFS heard elsewhere")
        return {
            maintainer,
            owner,
            here,
            elsewhere,
            topic: kind(
                op("SFS_AUTHOR", "publishPost", {
                    contactListId: ids.repositoryCategory,
                    title: "SFS more",
                    body: "More",
                    operationId: "sfs-silenced-topic"
                })
            ),
            log: (op("SFS_OWNER", "findActions", {scopeContactListId: ids.groupCategory}).actionList || [])
                .map(action => action.action)
                .includes("silence")
        }
    },
    then({maintainer, owner, here, elsewhere, topic, log}) {
        maintainer.kind == "Unauthorized"
        !!owner.sanctionId == true
        here.kind == "Unauthorized"
        here.reason == "accessDenied"
        elsewhere.issueNumber >= 1
        topic == "Unauthorized"
        log == true
    }
})
