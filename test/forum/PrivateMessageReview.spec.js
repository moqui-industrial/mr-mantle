// A private message reaches a site's staff only through a participant's report (plans/Security-Review-Medium.md
// SEC-PFS-83; mr-pass plan/design-forum.md: staff do not browse private messages): a site rule that would flag or hold a
// post files a review item for a topic of a category, never for a private conversation's post or its edit; a
// participant's report still files one. ForumCore.js gate, Forum.js publishPost and updatePost. Spec-local site and
// accounts, through the PASS authority as a page's call arrives. Run: ./moq test mr-mantle --spec PrivateMessageReview
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const SITE = "PMR_SITE"
const ids = {}
const operationId = () => "pmr-" + ec.user.randomString(16)
const reviewsOf = postId =>
    Array.from(
        ec.entity.find("mantle.forum.ForumReviewItem").condition({siteId: SITE, targetType: "post", targetId: postId}).disableAuthz().list()
    )

spec({
    setupSpec() {
        login(lib.OPERATOR)
        lib.site(SITE)
        lib.account(SITE, "PMR_OWNER", {member: true, siteRole: "owner", handle: "pmrowner"})
        lib.account(SITE, "PMR_ANN", {member: true, handle: "pmrann"})
        lib.account(SITE, "PMR_BEN", {member: true, handle: "pmrben"})
        for (const partyId of ["PMR_OWNER", "PMR_ANN", "PMR_BEN"]) lib.settled(SITE, partyId)
        ids.category = lib.make("mantle.marketing.contact.ContactList", {
            contactListTypeEnumId: "MAILBOX",
            contactListName: "PMR general",
            isPublic: "N",
            postingEnumId: "ClpAnyUser"
        }).contactListId
        lib.make("mantle.forum.ForumCategory", {
            contactListId: ids.category,
            siteId: SITE,
            slug: "general",
            sequenceNum: 0,
            publicationState: "published",
            visibility: "public",
            mode: "discussion",
            policyRevision: 1
        })
        // the owner's rule that matches every post
        ids.rule = lib.op("PMR_OWNER", SITE, "storeRule", {
            ruleType: "regex",
            pattern: "[\\s\\S]",
            action: "flag",
            operationId: operationId()
        }).ruleId
        // and one that holds a word for approval
        ids.approveRule = lib.op("PMR_OWNER", SITE, "storeRule", {
            ruleType: "word",
            pattern: "pmrhold",
            action: "approve",
            operationId: operationId()
        }).ruleId
    }
})

feature("a rule flags a category's post for review, never a private message or its edit", {
    when() {
        const topic = lib.op("PMR_BEN", SITE, "publishPost", {
            contactListId: ids.category,
            title: "Public hello",
            body: "<p>Hello everyone</p>",
            operationId: operationId()
        })
        lib.settled(SITE, "PMR_ANN")
        const conversation = lib.op("PMR_ANN", SITE, "createConversation", {
            participantHandles: ["pmrben"],
            title: "Between us",
            body: "<p>Our private words</p>",
            operationId: operationId()
        })
        const edited = lib.op("PMR_ANN", SITE, "updatePost", {
            postId: conversation.rootCommEventId,
            body: "<p>Our private words, changed</p>",
            expectedRevision: 1
        })
        ids.privatePost = conversation.rootCommEventId
        return {
            topic,
            conversation,
            edited,
            topicReviews: reviewsOf(topic.rootCommEventId),
            privateReviews: reviewsOf(conversation.rootCommEventId)
        }
    },
    then({topic, conversation, edited, topicReviews, privateReviews}) {
        ids.rule != null
        topic.kind == null
        topicReviews.length == 1
        topicReviews[0].reasonFamily == "rule"
        conversation.kind == null
        edited.kind == null
        privateReviews.length == 0
    }
})

feature("an approve rule holds a category's post, never a private reply, and a reply held as spam files no review", {
    when() {
        lib.settled(SITE, "PMR_BEN")
        const held = lib.op("PMR_BEN", SITE, "publishPost", {
            contactListId: ids.category,
            title: "Held hello",
            body: "<p>pmrhold in public</p>",
            operationId: operationId()
        })
        lib.settled(SITE, "PMR_BEN")
        const reply = lib.op("PMR_BEN", SITE, "publishPost", {
            rootCommEventId: ids.privatePost,
            body: "<p>pmrhold between us</p>",
            operationId: operationId()
        })
        lib.settled(SITE, "PMR_BEN")
        // a mailed reply the gateway marked as spam
        const spam = lib.privileged(() =>
            lib.run("mantle.forum.DeliveryServices.post#Inbound", {
                input: {
                    siteId: SITE,
                    username: "PMR_BEN",
                    rootCommEventId: ids.privatePost,
                    body: "<p>Buy now</p>",
                    mailVerdict: {spam: true, reason: "X-Spam-Flag: YES"},
                    operationId: operationId()
                }
            }).result
        )
        const state = postId => lib.row("mantle.forum.ForumPostState", {communicationEventId: postId})
        return {
            held,
            heldReviews: reviewsOf(held.rootCommEventId),
            reply,
            replyReviews: reviewsOf(reply.postId),
            spam,
            spamState: spam?.postId ? state(spam.postId) : null,
            spamReviews: spam?.postId ? reviewsOf(spam.postId) : []
        }
    },
    then({held, heldReviews, reply, replyReviews, spam, spamState, spamReviews}) {
        held.kind == null
        heldReviews.map(review => review.reasonFamily).includes("rule")
        reply.kind == null
        replyReviews.length == 0
        spam.postId != null
        spamState.visibility == "pending"
        spamReviews.length == 0
    }
})

feature("a participant's report still files a private message's review", {
    when() {
        const reported = lib.op("PMR_BEN", SITE, "flagPost", {
            postId: ids.privatePost,
            reason: "Harassment",
            operationId: operationId()
        })
        return {reported, reviews: reviewsOf(ids.privatePost)}
    },
    then({reported, reviews}) {
        reported.reviewId != null
        reviews.map(review => review.reasonFamily) == ["flag"]
    }
})
