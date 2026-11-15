// Marketing's content (impl-marketing P14; design-marketing §8 Content, ContentDetail, BlogPosts, BlogPostDetail;
// mantle.marketing.MarketingContentServices over MarketingContent.js): a link of a draft post to a campaign publishes nothing and
// another organization's author reaches neither the link nor the campaign, nor another's private post; a category write is refused
// without write access to the post's space (and without MARKETING_CONTENT_EDIT); a newsletter drafted from a post takes the
// category's approved posts at its preparation, recording the version each read, and leaves the post's publish date, its page's
// published version and the category's sent date alone. Standalone: spec-local organizations, users, wiki spaces and a list.
// Run: ./moq test mr-mantle --spec MarketingContent
const lib = ec.resource.script("component://mr-mantle/test/marketing/MarketingSpecLib.js")
const entityLib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {make, row, rows, system, organization, user, as, campaign} = lib
const T = "mantle.marketing.MarketingContentServices."
const D = "mantle.marketing.CampaignSendServices."
const WIKI = "org.moqui.resource.WikiServices."
const prefix = "MKCT"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const space = prefix + "S",
    privateSpace = prefix + "P",
    topic = prefix + "_TOPIC",
    category = prefix + "_NEWS"
const users = {}
const ids = {}
const code = out => (/([A-Z][A-Z0-9_]+):/.exec(out.refusal || "") || [])[1] || (out.refusal ? "ERROR" : "")

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Content A")
            organization(orgB, "Content B")
            const authorPermissions = [
                "MARKETING_VIEW",
                "MARKETING_CAMPAIGN_EDIT",
                "MARKETING_SEND_EDIT",
                "MARKETING_CONTENT_EDIT"
            ]
            users.author = user(prefix, "author", [orgA], authorPermissions)
            users.author2 = user(prefix, "author2", [orgA], authorPermissions)
            users.reader = user(prefix, "reader", [orgA], ["MARKETING_VIEW"])
            users.authorB = user(prefix, "authorB", [orgB], authorPermissions)
            // the blog space: anyone views it, its writers are named (restrictUpdate); a private space only its writer views
            for (const [wikiSpaceId, description, restrictView] of [
                [space, "Content blog", "N"],
                [privateSpace, "Private drafts", "Y"]
            ])
                lib.run(WIKI + "create#WikiSpace", {
                    wikiSpaceId,
                    description,
                    restrictView,
                    restrictUpdate: "Y",
                    addCreator: false
                })
            for (const wikiSpaceId of [space, privateSpace])
                make("moqui.resource.wiki.WikiSpaceUser", {wikiSpaceId, userId: users.author, allowView: "Y", allowUpdate: "Y"})
            make("moqui.resource.wiki.WikiSpaceUser", {
                wikiSpaceId: space,
                userId: users.authorB,
                allowView: "Y",
                allowUpdate: "Y"
            })
            make("moqui.resource.wiki.WikiPageCategory", {wikiPageCategoryId: category, categoryName: "Garden news"})
            make("mantle.marketing.contact.ContactList", {
                contactListId: topic,
                contactListName: "Content topic",
                contactListTypeEnumId: "NEWSLETTER",
                contactMechTypeEnumId: "CmtEmailAddress",
                ownerPartyId: orgA
            })
        })
        ids.campaign = campaign(users.author, orgA, {campaignName: "Spring content"})
        const post = as(users.author, T + "store#BlogPost", {
            wikiSpaceId: space,
            title: "Pruning roses",
            author: "Content author",
            summary: "When and how to prune.",
            blogText: "<p>Prune in early spring.</p>",
            publishDate: new Date(Date.now() - 86400000)
        })
        if (post.refusal) throw new Error("post: " + post.refusal)
        ids.post = post.wikiBlogId
        const hidden = as(users.author, T + "store#BlogPost", {
            wikiSpaceId: privateSpace,
            title: "Unannounced sale",
            blogText: "<p>Not yet.</p>"
        })
        if (hidden.refusal) throw new Error("hidden: " + hidden.refusal)
        ids.hidden = hidden.wikiBlogId
    },
    cleanupSpec() {
        login("john.doe")
    }
})

feature("a link of a draft post publishes nothing; another organization's author and another's private post are kept out", {
    when() {
        const before = row("moqui.resource.wiki.WikiBlog", {wikiBlogId: ids.post})
        const link = as(users.author, T + "store#CampaignContent", {
            marketingCampaignId: ids.campaign,
            contentKindEnumId: "CckBlogPost",
            sourceId: ids.post,
            useText: "Newsletter article"
        })
        ids.link = link.campaignContentId
        const again = as(users.author, T + "store#CampaignContent", {
            marketingCampaignId: ids.campaign,
            contentKindEnumId: "CckBlogPost",
            sourceId: ids.post
        })
        const after = row("moqui.resource.wiki.WikiBlog", {wikiBlogId: ids.post})
        const page = row("moqui.resource.wiki.WikiPage", {wikiPageId: after.wikiPageId})
        const read = as(users.reader, T + "get#CampaignContent", {campaignContentId: ids.link})
        const listed = as(users.author, T + "find#BlogPosts", {marketingCampaignId: ids.campaign})
        const readerEdits = as(users.reader, T + "store#CampaignContent", {
            marketingCampaignId: ids.campaign,
            contentKindEnumId: "CckBlogPost",
            sourceId: ids.post
        })
        const otherOrg = as(users.authorB, T + "store#CampaignContent", {
            marketingCampaignId: ids.campaign,
            contentKindEnumId: "CckBlogPost",
            sourceId: ids.post
        })
        const otherRead = as(users.authorB, T + "get#CampaignContent", {campaignContentId: ids.link})
        const otherFind = as(users.authorB, T + "find#CampaignContent", {})
        const privatePost = as(users.author2, T + "store#CampaignContent", {
            marketingCampaignId: ids.campaign,
            contentKindEnumId: "CckBlogPost",
            sourceId: ids.hidden
        })
        const privateList = as(users.author2, T + "find#BlogPosts", {})
        return {
            before,
            link,
            again,
            after,
            page,
            read,
            listed,
            readerEdits,
            otherOrg,
            otherRead,
            otherFind,
            privatePost,
            privateList
        }
    },
    then(r) {
        r.link.refusal == "" && r.link.created === true
        r.again.campaignContentId == r.link.campaignContentId && r.again.created === false
        r.page.publishedVersionName == null
        entityLib.ms(r.after.publishDate) == entityLib.ms(r.before.publishDate)
        r.read.content.stateText == "Draft" && r.read.content.publicUrl == null
        r.read.content.title == "Pruning roses"
        r.listed.posts.map(p => p.wikiBlogId).join() == ids.post
        code(r.readerEdits) == "PERMISSION_DENIED"
        code(r.otherOrg) == "RECORD_UNAVAILABLE"
        code(r.otherRead) == "RECORD_UNAVAILABLE"
        r.otherFind.contents.length == 0
        code(r.privatePost) == "RECORD_UNAVAILABLE"
        !r.privateList.posts.some(p => p.wikiBlogId == ids.hidden)
    }
})

feature("a category write needs MARKETING_CONTENT_EDIT and write access to the post's space", {
    when() {
        const parameters = {wikiBlogId: ids.post, wikiPageCategoryId: category}
        const noSpaceWrite = as(users.author2, T + "add#BlogCategory", parameters)
        const reader = as(users.reader, T + "add#BlogCategory", parameters)
        const added = as(users.author, T + "add#BlogCategory", parameters)
        const removedByOther = as(users.author2, T + "remove#BlogCategory", parameters)
        const kept = rows("moqui.resource.wiki.WikiBlogCategory", {wikiBlogId: ids.post}).length
        const removed = as(users.author, T + "remove#BlogCategory", parameters)
        const left = rows("moqui.resource.wiki.WikiBlogCategory", {wikiBlogId: ids.post}).length
        // back in the category for the newsletter
        as(users.author, T + "add#BlogCategory", parameters)
        return {noSpaceWrite, reader, added, removedByOther, kept, removed, left}
    },
    then(r) {
        code(r.noSpaceWrite) == "SPACE_WRITE_DENIED"
        code(r.reader) == "PERMISSION_DENIED"
        r.added.refusal == "" && r.added.added === true
        code(r.removedByOther) == "SPACE_WRITE_DENIED"
        r.kept == 1
        r.removed.removed === true
        r.left == 0
    }
})

feature("a newsletter takes the category's approved posts at preparation and leaves their publication and sent date alone", {
    when() {
        const blog = row("moqui.resource.wiki.WikiBlog", {wikiBlogId: ids.post})
        const versionName = system(() => {
            const version = ec.service
                .sync()
                .name(WIKI + "get#WikiPageHistory")
                .parameters({wikiPageId: blog.wikiPageId})
                .call().versionList[0].versionName
            ec.service
                .sync()
                .name(WIKI + "set#PublishedVersion")
                .parameters({wikiPageId: blog.wikiPageId, publishedVersionName: version})
                .call()
            return version
        })
        const drafted = as(users.author, T + "create#ContentSend", {
            campaignContentId: ids.link,
            contactListId: topic,
            sendName: "Garden newsletter"
        })
        const send = row("mantle.marketing.campaign.CampaignSend", {campaignSendId: drafted.campaignSendId})
        const prepared = as(users.author, D + "prepare#Send", {
            campaignSendId: drafted.campaignSendId,
            expectedRevision: entityLib.ms(send.lastUpdatedStamp)
        })
        const after = row("mantle.marketing.campaign.CampaignSend", {campaignSendId: drafted.campaignSendId})
        const body = system(() => String(ec.resource.getLocationReference(after.preparedBodyLocation).getText()))
        const posts = rows("mantle.marketing.campaign.CampaignSendPost", {campaignSendId: drafted.campaignSendId})
        const blogAfter = row("moqui.resource.wiki.WikiBlog", {wikiBlogId: ids.post})
        const page = row("moqui.resource.wiki.WikiPage", {wikiPageId: blog.wikiPageId})
        const sent = row("moqui.resource.wiki.WikiBlogCategory", {wikiBlogId: ids.post, wikiPageCategoryId: category})
        const distribution = as(users.author, T + "get#CampaignContent", {campaignContentId: ids.link}).distribution
        return {after, versionName, drafted, send, prepared, body, posts, blog, blogAfter, page, sent, distribution}
    },
    then(r) {
        r.drafted.refusal == ""
        r.send.postCategoryId == category && r.send.campaignContentId == ids.link
        r.prepared.refusal == ""
        r.body.includes("Pruning roses") && r.body.includes("When and how to prune.")
        r.posts.length == 1 && r.posts[0].wikiBlogId == ids.post && r.posts[0].versionName == r.versionName
        entityLib.ms(r.blogAfter.publishDate) == entityLib.ms(r.blog.publishDate)
        r.page.publishedVersionName == r.versionName
        r.sent.sentDate == null
        r.distribution.some(d => d.campaignSendId == r.drafted.campaignSendId && d.versionText.startsWith("Version"))
    }
})
