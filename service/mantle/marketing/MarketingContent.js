// Marketing's content: a campaign's planned content and its blog posts (mantle.marketing.MarketingContentServices, T of IronStone
// Marketing design §14.2; design §8 Content, ContentDetail, BlogPosts, BlogPostDetail, §14.1 CampaignContent, §18 the blog post;
// impl-marketing P14). CC0 1.0 Universal plus Grant of Patent License.
//
// - A campaign's content (CampaignContent) is a dated, typed link to a blog post, a landing or site page, a wiki page or a campaign
//   file, with its use and intended date. The content and its publication stay with their owner: linking publishes nothing, a
//   planned date is no release instruction, and the publication state shown is read from the owner (the post's publish date and
//   its page's published wiki version, the site page's binding and window, the wiki page's published version), never written here.
//   A Marketing reader of the campaign's organization reads the links; MARKETING_CONTENT_EDIT writes them. A source is linked only
//   when the caller may read it: a post or wiki page the wiki lets them view, a site page of the campaign's organization (a Shop
//   page through its store's, a landing page through its marketing mount's), a file of the campaign. Another organization's record
//   answers as missing (RECORD_UNAVAILABLE).
// - Blog posts are the framework's WikiBlog: listed over the wiki spaces get#UserWikiSpaces answers (and pages the user may view);
//   written through org.moqui.resource.WikiServices create#WikiBlog and update#WikiBlog as built, after this module checks
//   MARKETING_CONTENT_EDIT and the wiki's write access to the post's space (get#WikiPageAccess canUpdate), which create#WikiBlog
//   from an existing page and the baseline's raw category writes did not. A post's body is its wiki page, written and reviewed
//   in Commons Knowledge; the page's published version is what a public blog shows.
// - Newsletter assembly (design §8 ContentDetail Distribution): a send may name a blog category (CampaignSend.postCategoryId); its
//   preparation takes the category's approved posts as of then (published: a publish date reached and a published page version),
//   records each with the version it read (CampaignSendPost) and adds them to the prepared body. A send sets neither
//   WikiBlog.publishDate nor a page's published version, and WikiBlogCategory.sentDate is not its record.
// Refusals carry reason codes (EntityLib.js denied).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const marketingAccess = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingAccess.js")
const publicApps = () => ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
const {find, one, rows, denied, call, ms} = lib

const CONTENT = "mantle.marketing.campaign.CampaignContent"
const CAMPAIGN = "mantle.marketing.campaign.MarketingCampaign"
const ASSET = "mantle.marketing.campaign.CampaignAsset"
const SEND = "mantle.marketing.campaign.CampaignSend"
const SEND_POST = "mantle.marketing.campaign.CampaignSendPost"
const LIST_EMAIL = "mantle.marketing.contact.ContactListEmail"
const BLOG = "moqui.resource.wiki.WikiBlog"
const BLOG_VIEW = "mantle.marketing.content.BlogPostView"
const BLOG_CATEGORY = "moqui.resource.wiki.WikiBlogCategory"
const PAGE_CATEGORY = "moqui.resource.wiki.WikiPageCategory"
const WIKI_PAGE = "moqui.resource.wiki.WikiPage"
const SPACE = "moqui.resource.wiki.WikiSpace"
const REVIEW = "moqui.resource.wiki.WikiPageReview"
const SITE_PAGE = "mantle.public.PublicSitePage"
const SITE_APP = "mantle.public.PublicSiteApp"
const WIKI = "org.moqui.resource.WikiServices."
const D = "mantle.marketing.CampaignSendServices."
const openCampaignStatuses = ["MKTG_CAMP_PLANNED", "MKTG_CAMP_APPROVED", "MKTG_CAMP_INPROGRESS"]
const kinds = {CckBlogPost: "Blog post", CckSitePage: "Landing page", CckWikiPage: "Wiki page", CckFile: "File"}
const limits = {useText: 255, metaDescription: 160, posts: 10, categoryPosts: 1000, sends: 50}

const text = value => (value == null ? "" : String(value).trim())
const blank = value => text(value) === ""
const nowMs = () => ms(ec.user.nowTimestamp)
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "")
const userText = userId => (userId ? one("moqui.security.UserAccount", {userId})?.userFullName || userId : "")
// Text for HTML and for the locked renderer: markup escaped, and $ and # too, so a post's words never read as an expression.
const esc = value =>
    String(value ?? "").replace(
        /[&<>"'$#]/g,
        c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", $: "&#36;", "#": "&#35;"})[c]
    )
const plain = value =>
    String(value ?? "")
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
const likeText = term => "%" + String(term).replace(/[\\%_]/g, c => "\\" + c) + "%"

// ===== scope =====
function readScope() {
    const userScope = marketingAccess.scope()
    marketingAccess.requireCapability(userScope, "anyRead")
    return userScope
}
function editScope() {
    const userScope = readScope()
    marketingAccess.requireCapability(userScope, "contentEdit")
    return userScope
}
function campaignOf(userScope, marketingCampaignId) {
    const row = marketingCampaignId ? one(CAMPAIGN, {marketingCampaignId}) : null
    if (!row || !marketingAccess.covers(userScope, row.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Campaign " + (marketingCampaignId || "") + " is not available")
    return row
}
function contentOf(userScope, campaignContentId, lock = false) {
    const row = campaignContentId ? find(CONTENT, {campaignContentId}).forUpdate(lock).one() : null
    if (!row || !marketingAccess.covers(userScope, row.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Content link " + (campaignContentId || "") + " is not available")
    return row
}

// ===== the wiki's own access rule =====
function wikiAccess(parameters) {
    return (
        ec.service
            .sync()
            .name(WIKI + "get#WikiPageAccess")
            .parameters(parameters)
            .disableAuthz()
            .call() || {}
    )
}
const spaceAccess = wikiSpaceId => (wikiSpaceId ? wikiAccess({wikiSpaceId}) : {})
const pageAccess = wikiPageId => (wikiPageId ? wikiAccess({wikiPageId}) : {})
// The spaces the user may view (get#UserWikiSpaces), by id.
function viewableSpaces() {
    const out = ec.service
        .sync()
        .name(WIKI + "get#UserWikiSpaces")
        .parameters({userId: ec.user.userId})
        .disableAuthz()
        .call()
    return new Map(Array.from(out?.wikiSpaceAndUserList || []).map(space => [space.wikiSpaceId, space]))
}
// A post the user may view: its WikiBlog and page (their page's view rule), else RECORD_UNAVAILABLE.
function postOf(wikiBlogId) {
    const blog = wikiBlogId ? one(BLOG, {wikiBlogId}) : null
    const page = blog?.wikiPageId ? one(WIKI_PAGE, {wikiPageId: blog.wikiPageId}) : null
    if (!blog || !page || !pageAccess(page.wikiPageId).canView)
        denied("RECORD_UNAVAILABLE", "Blog post " + (wikiBlogId || "") + " is not available")
    return {blog, page}
}
// A write into a post's or a new post's space: MARKETING_CONTENT_EDIT (the caller's scope) and the wiki's update right there.
function requireSpaceWrite(wikiSpaceId) {
    const found = spaceAccess(wikiSpaceId)
    if (!found.canView) denied("RECORD_UNAVAILABLE", "Space " + (wikiSpaceId || "") + " is not available")
    if (!found.canUpdate) denied("SPACE_WRITE_DENIED", "You may not change pages of the space " + wikiSpaceId)
}
// A write of a post (its metadata, its categories) or a new post made from a page: the space's write right and the page's own (a
// page restricted on its own is changed only by a user it admits; P14 review R2).
function requirePageWrite(page) {
    requireSpaceWrite(page.wikiSpaceId)
    if (!pageAccess(page.wikiPageId).canUpdate) denied("SPACE_WRITE_DENIED", "You may not change the page " + page.pagePath)
}
function publicBlogLink(space, blog) {
    const base = text(space?.publicBlogUrl)
    return /^https:\/\/[^\s"'<>]+$/i.test(base) ? base.replace(/\/+$/, "") + "/" + encodeURIComponent(blog.wikiBlogId) : null
}
// The latest review of a page: its state in words, or "".
function reviewOf(wikiPageId) {
    const review = Array.from(find(REVIEW, {wikiPageId}).orderBy("-requestedDate").limit(1).list())[0]
    return review ? statusText(review.statusId) : ""
}

// ===== the owner's publication, read only =====
// A blog post's: published from its publish date with its page's published version; public through the space's blog address when
// the space is not restricted.
function postPublication(blog, page) {
    const space = one(SPACE, {wikiSpaceId: page.wikiSpaceId})
    const published = !!page.publishedVersionName
    const due = ms(blog.publishDate) != null && ms(blog.publishDate) <= nowMs()
    const state = published && due ? "published" : published ? "scheduled" : "draft"
    const restricted = space?.restrictView === "Y" || page.restrictView === "Y"
    return {
        state,
        stateText: {published: "Published", scheduled: "Publishes " + lib.dateText(blog.publishDate), draft: "Draft"}[state],
        stateColor: {published: "positive", scheduled: "info", draft: "warning"}[state],
        publishedVersionName: page.publishedVersionName || null,
        reviewText: reviewOf(page.wikiPageId),
        restricted,
        publicUrl: state === "published" && !restricted ? publicBlogLink(space, blog) : null,
        publicText: restricted
            ? "A private space: not public"
            : state === "published"
              ? "Public on the space's blog"
              : "Not public yet"
    }
}
// A site page's: its binding's version in its window.
function sitePagePublication(page) {
    const at = nowMs()
    const live = !!page.versionName && (ms(page.fromDate) ?? -Infinity) <= at && (ms(page.thruDate) ?? Infinity) > at
    const withdrawn = !live && !!page.versionName && ms(page.thruDate) != null && ms(page.thruDate) <= at
    const mount = one(SITE_APP, {siteId: page.siteId, appMountId: page.appMountId})
    const state = live ? "published" : withdrawn ? "withdrawn" : page.scheduledFromDate ? "scheduled" : "draft"
    return {
        state,
        stateText: {published: "Published", withdrawn: "Withdrawn", scheduled: "Waiting to publish", draft: "Draft"}[state],
        stateColor: {published: "positive", withdrawn: "grey", scheduled: "info", draft: "warning"}[state],
        publishedVersionName: live ? page.versionName : null,
        reviewText: "",
        restricted: false,
        publicUrl: live && mount ? publicApps().pageUrl(page.siteId, mount.app, "/pages/" + page.routePath) : null,
        publicText: live ? "Public on the site" : "Not public"
    }
}
function wikiPagePublication(page) {
    const space = one(SPACE, {wikiSpaceId: page.wikiSpaceId})
    const restricted = space?.restrictView === "Y" || page.restrictView === "Y"
    return {
        state: page.publishedVersionName ? "published" : "draft",
        stateText: page.publishedVersionName ? "Published version" : "No published version",
        stateColor: page.publishedVersionName ? "positive" : "warning",
        publishedVersionName: page.publishedVersionName || null,
        reviewText: reviewOf(page.wikiPageId),
        restricted,
        publicUrl: null,
        publicText: restricted ? "A private space: not public" : "In the wiki"
    }
}
const filePublication = () => ({
    state: "file",
    stateText: "Campaign file",
    stateColor: "grey",
    publishedVersionName: null,
    reviewText: "",
    restricted: true,
    publicUrl: null,
    publicText: "A staff file: never public"
})
// A link's source: its title, publication and where it opens, as the caller may read it (unavailable: the source is no longer
// readable to them, named so).
function sourceView(row) {
    try {
        if (row.contentKindEnumId === "CckBlogPost") {
            const {blog, page} = postOf(row.wikiBlogId)
            return Object.assign({title: blog.title || blog.wikiBlogId, sourceId: blog.wikiBlogId}, postPublication(blog, page))
        }
        if (row.contentKindEnumId === "CckSitePage") {
            const page = one(SITE_PAGE, {sitePageId: row.sitePageId})
            if (!page) throw new Error("missing")
            return Object.assign({title: page.title || page.routePath, sourceId: page.sitePageId}, sitePagePublication(page))
        }
        if (row.contentKindEnumId === "CckWikiPage") {
            const page = one(WIKI_PAGE, {wikiPageId: row.wikiPageId})
            if (!page || !pageAccess(page.wikiPageId).canView) throw new Error("unavailable")
            return Object.assign({title: page.pagePath, sourceId: page.wikiPageId}, wikiPagePublication(page))
        }
        const asset = one(ASSET, {campaignAssetId: row.campaignAssetId})
        if (!asset) throw new Error("missing")
        const name = String(asset.contentLocation || "")
            .split("/")
            .pop()
        return Object.assign({title: asset.description || name, sourceId: asset.campaignAssetId}, filePublication())
    } catch (error) {
        ec.message.clearErrors()
        return {
            title: "Not available to you",
            sourceId: null,
            state: "unavailable",
            stateText: "Not available",
            stateColor: "grey",
            publicText: "",
            publicUrl: null
        }
    }
}
// The record a link of a kind names, checked for the caller and the campaign: the link's source fields.
function sourceFields(userScope, campaign, kind, sourceId) {
    const id = text(sourceId)
    if (!id) denied("SOURCE_REQUIRED", "Choose the content to link")
    const unavailable = what => denied("RECORD_UNAVAILABLE", what + " " + id + " is not available")
    if (kind === "CckBlogPost") {
        const {blog} = postOf(id)
        return {wikiBlogId: blog.wikiBlogId, wikiPageId: blog.wikiPageId}
    }
    if (kind === "CckWikiPage") {
        const page = one(WIKI_PAGE, {wikiPageId: id})
        if (!page || !pageAccess(id).canView) unavailable("Page")
        return {wikiPageId: id}
    }
    if (kind === "CckSitePage") {
        const page = one(SITE_PAGE, {sitePageId: id})
        const mount = page?.appMountId ? one(SITE_APP, {siteId: page.siteId, appMountId: page.appMountId}) : null
        let owner = null
        if (mount?.app === "marketing") owner = mount.targetId
        else if (mount?.app === "shop")
            owner = one("mantle.product.store.ProductStore", {productStoreId: mount.targetId})?.organizationPartyId || null
        // another organization's page answers as a missing one
        if (!owner || owner !== campaign.organizationPartyId) unavailable("Page")
        return {sitePageId: id}
    }
    if (kind === "CckFile") {
        const asset = one(ASSET, {campaignAssetId: id})
        if (!asset || asset.marketingCampaignId !== campaign.marketingCampaignId) unavailable("File")
        return {campaignAssetId: id}
    }
    denied("KIND_UNAVAILABLE", "A campaign links a blog post, a landing page, a wiki page or a file")
}

// ===== find#CampaignContent, get#CampaignContent =====
function contentRow(row, campaigns = {}) {
    if (!(row.marketingCampaignId in campaigns))
        campaigns[row.marketingCampaignId] = one(CAMPAIGN, {marketingCampaignId: row.marketingCampaignId})
    const campaign = campaigns[row.marketingCampaignId]
    const source = sourceView(row)
    return {
        campaignContentId: row.campaignContentId,
        marketingCampaignId: row.marketingCampaignId,
        campaignName: campaign?.campaignName || row.marketingCampaignId,
        contentKindEnumId: row.contentKindEnumId,
        kindText: kinds[row.contentKindEnumId] || row.contentKindEnumId,
        title: source.title,
        sourceId: source.sourceId,
        wikiBlogId: row.wikiBlogId || null,
        sitePageId: row.sitePageId || null,
        wikiPageId: row.wikiPageId || null,
        campaignAssetId: row.campaignAssetId || null,
        useText: row.useText || "",
        intendedDate: row.intendedDate || null,
        intendedDateText: lib.dateText(row.intendedDate),
        fromDateText: lib.dateText(row.fromDate),
        thruDateText: lib.dateText(row.thruDate),
        current: lib.active(row),
        stateText: source.stateText,
        stateColor: source.stateColor,
        publicText: source.publicText,
        publicUrl: source.publicUrl || null,
        lastUpdatedStamp: row.lastUpdatedStamp
    }
}
function findContent(p) {
    const userScope = readScope()
    const ids = marketingAccess.organizationIds(userScope)
    const factory = ec.entity.conditionFactory
    const build = () => {
        let query = find(CONTENT).condition("organizationPartyId", "in", ids.length ? ids : ["-"])
        if (!blank(p.marketingCampaignId)) query = query.condition("marketingCampaignId", text(p.marketingCampaignId))
        if (!blank(p.contentKindEnumId)) query = query.condition("contentKindEnumId", text(p.contentKindEnumId))
        if (!blank(p.wikiBlogId)) query = query.condition("wikiBlogId", text(p.wikiBlogId))
        if (!blank(p.sitePageId)) query = query.condition("sitePageId", text(p.sitePageId))
        if (!(p.includeEnded === true || p.includeEnded === "true"))
            query = query.condition(
                factory.makeCondition(
                    [
                        factory.makeCondition("thruDate", "is-null", null),
                        factory.makeCondition("thruDate", "greater", ec.user.nowTimestamp)
                    ],
                    "or"
                )
            )
        if (!blank(p.term)) query = query.condition(factory.makeCondition("useText", "like", likeText(text(p.term))).ignoreCase())
        return query
    }
    const count = build().count()
    const found = lib.page(build().orderBy("-intendedDate").orderBy("-fromDate"), p, "contentRows", count)
    const campaigns = {}
    const contents = found.rows.map(row => contentRow(row, campaigns))
    return {
        contents,
        contentsCount: count,
        contentsPageIndex: found.pageIndex,
        contentsPageSize: found.pageSize,
        contentsPageMaxIndex: found.pageMaxIndex,
        contentsPageRangeLow: found.pageRangeLow,
        contentsPageRangeHigh: found.pageRangeHigh
    }
}
// The sends that carry a link's content: drafted from it, and (a blog post) prepared with it.
function distributionOf(row) {
    const ids = new Set(rows(SEND, {campaignContentId: row.campaignContentId}).map(send => send.campaignSendId))
    if (row.wikiBlogId)
        for (const post of Array.from(find(SEND_POST, {wikiBlogId: row.wikiBlogId}).limit(limits.sends).list()))
            ids.add(post.campaignSendId)
    return Array.from(ids)
        .map(campaignSendId => one(SEND, {campaignSendId}))
        .filter(send => send && send.organizationPartyId === row.organizationPartyId)
        .slice(0, limits.sends)
        .map(send => {
            const post = row.wikiBlogId
                ? Array.from(
                      find(SEND_POST, {campaignSendId: send.campaignSendId, wikiBlogId: row.wikiBlogId})
                          .orderBy("-preparedRevision")
                          .limit(1)
                          .list()
                  )[0]
                : null
            return {
                campaignSendId: send.campaignSendId,
                sendName: send.sendName || send.campaignSendId,
                topicName:
                    one("mantle.marketing.contact.ContactList", {contactListId: send.contactListId})?.contactListName || "",
                statusText: statusText(send.statusId),
                scheduledDateText: lib.dateText(send.scheduledDate),
                categoryName: send.postCategoryId
                    ? one(PAGE_CATEGORY, {wikiPageCategoryId: send.postCategoryId})?.categoryName || ""
                    : "",
                versionText: post
                    ? "Version " + String(post.versionName || "").slice(0, 10) + ", prepared " + lib.dateText(post.preparedDate)
                    : ""
            }
        })
}
function getContent(p) {
    const userScope = readScope()
    const row = contentOf(userScope, text(p.campaignContentId))
    const out = contentRow(row)
    const source = sourceView(row)
    return {
        content: Object.assign(out, {
            publishedVersionName: source.publishedVersionName || null,
            reviewText: source.reviewText || "",
            restricted: !!source.restricted,
            organizationPartyId: row.organizationPartyId,
            createdByText: userText(row.createdByUserId),
            canEdit: !!userScope.capabilities.contentEdit,
            canDraftSend: !!userScope.capabilities.sendEdit && ["CckBlogPost", "CckSitePage"].includes(row.contentKindEnumId)
        }),
        distribution: distributionOf(row)
    }
}

// ===== store#CampaignContent =====
// add a link (campaign, kind, source, use, intended date), update its use and intended date (at its stamp), or end it. A current
// link of the same source to the campaign is answered again. Linking publishes nothing.
function storeContent(p) {
    const userScope = editScope()
    const action = text(p.action) || (blank(p.campaignContentId) ? "add" : "update")
    const useText = text(p.useText)
    if (useText.length > limits.useText) denied("VALUE_INVALID", "A use has at most " + limits.useText + " characters")
    if (action === "add") {
        const campaign = campaignOf(userScope, text(p.marketingCampaignId))
        if (!openCampaignStatuses.includes(campaign.statusId))
            denied(
                "CAMPAIGN_CLOSED",
                "Campaign " + campaign.marketingCampaignId + " is " + statusText(campaign.statusId).toLowerCase()
            )
        const kind = text(p.contentKindEnumId)
        const fields = sourceFields(userScope, campaign, kind, p.sourceId)
        const existing = rows(
            CONTENT,
            Object.assign({marketingCampaignId: campaign.marketingCampaignId, contentKindEnumId: kind}, fields)
        ).find(link => lib.active(link))
        if (existing) return {campaignContentId: existing.campaignContentId, created: false}
        const made = call(
            "create#" + CONTENT,
            Object.assign(
                {
                    marketingCampaignId: campaign.marketingCampaignId,
                    organizationPartyId: campaign.organizationPartyId,
                    contentKindEnumId: kind,
                    useText: useText || null,
                    intendedDate: blank(p.intendedDate) ? null : p.intendedDate,
                    fromDate: ec.user.nowTimestamp,
                    createdByUserId: ec.user.userId
                },
                fields
            )
        )
        return {campaignContentId: made.campaignContentId, created: true}
    }
    const row = contentOf(userScope, text(p.campaignContentId), true)
    if (!lib.active(row)) denied("RECORD_ENDED", "Content link " + row.campaignContentId + " has ended")
    if (!blank(p.expectedLastUpdatedStamp) && ms(p.expectedLastUpdatedStamp) !== ms(row.lastUpdatedStamp))
        denied("REVISION_STALE", "Changed by someone else since it was read; reload")
    if (action === "end") {
        call("update#" + CONTENT, {campaignContentId: row.campaignContentId, thruDate: ec.user.nowTimestamp})
        return {campaignContentId: row.campaignContentId, created: false}
    }
    if (action !== "update") denied("ACTION_INVALID", "Add, update or end")
    call("update#" + CONTENT, {
        campaignContentId: row.campaignContentId,
        useText: p.useText != null ? useText || null : row.useText,
        intendedDate: p.intendedDate !== undefined ? (blank(p.intendedDate) ? null : p.intendedDate) : row.intendedDate
    })
    return {campaignContentId: row.campaignContentId, created: false}
}

// ===== find#BlogPosts, get#BlogPost =====
function categoriesOf(wikiBlogId) {
    return rows(BLOG_CATEGORY, {wikiBlogId}).map(row => ({
        wikiPageCategoryId: row.wikiPageCategoryId,
        categoryName: one(PAGE_CATEGORY, {wikiPageCategoryId: row.wikiPageCategoryId})?.categoryName || row.wikiPageCategoryId,
        sentDateText: lib.dateText(row.sentDate)
    }))
}
function postRow(blog, page, spaces, userScope) {
    const space = spaces.get(page.wikiSpaceId) || one(SPACE, {wikiSpaceId: page.wikiSpaceId})
    const publication = postPublication(blog, page)
    const ids = marketingAccess.organizationIds(userScope)
    const uses = ids.length
        ? find(CONTENT, {wikiBlogId: blog.wikiBlogId})
              .condition("organizationPartyId", "in", ids)
              .condition("thruDate", "is-null", null)
              .count()
        : 0
    return {
        wikiBlogId: blog.wikiBlogId,
        title: blog.title || blog.wikiBlogId,
        author: blog.author || "",
        summary: blog.summary || "",
        publishDateText: lib.dateText(blog.publishDate),
        wikiSpaceId: page.wikiSpaceId,
        spaceName: space?.description || page.wikiSpaceId,
        wikiPageId: page.wikiPageId,
        pagePath: page.pagePath,
        categoriesText: categoriesOf(blog.wikiBlogId)
            .map(category => category.categoryName)
            .join(", "),
        campaignUses: Number(uses),
        stateText: publication.stateText,
        stateColor: publication.stateColor,
        publicUrl: publication.publicUrl
    }
}
function findPosts(p) {
    const userScope = readScope()
    const spaces = viewableSpaces()
    let spaceIds = Array.from(spaces.keys())
    if (!blank(p.wikiSpaceId)) spaceIds = spaceIds.filter(id => id === text(p.wikiSpaceId))
    const empty = {
        posts: [],
        postsCount: 0,
        postsPageIndex: 0,
        postsPageSize: 20,
        postsPageMaxIndex: 0,
        postsPageRangeLow: 0,
        postsPageRangeHigh: 0
    }
    if (!spaceIds.length) return empty
    const factory = ec.entity.conditionFactory
    // a page restricted on its own is listed for a user it lets view it
    const allowedPages = ec.user.userId
        ? Array.from(find("moqui.resource.wiki.WikiPageUser", {userId: ec.user.userId, allowView: "Y"}).list()).map(
              row => row.wikiPageId
          )
        : []
    const visible = [
        factory.makeCondition("restrictView", "is-null", null),
        factory.makeCondition("restrictView", "not-equals", "Y")
    ]
    if (allowedPages.length) visible.push(factory.makeCondition("wikiPageId", "in", allowedPages))
    let blogIds = null
    if (!blank(p.wikiPageCategoryId))
        blogIds = Array.from(
            find(BLOG_CATEGORY, {wikiPageCategoryId: text(p.wikiPageCategoryId)})
                .limit(limits.categoryPosts)
                .list()
        ).map(row => row.wikiBlogId)
    if (!blank(p.marketingCampaignId)) {
        const campaign = campaignOf(userScope, text(p.marketingCampaignId))
        const linked = rows(CONTENT, {marketingCampaignId: campaign.marketingCampaignId, contentKindEnumId: "CckBlogPost"})
            .filter(row => lib.active(row))
            .map(row => row.wikiBlogId)
        blogIds = blogIds ? blogIds.filter(id => linked.includes(id)) : linked
    }
    if (blogIds && !blogIds.length) return empty
    const build = () => {
        let query = find(BLOG_VIEW).condition("wikiSpaceId", "in", spaceIds).condition(factory.makeCondition(visible, "or"))
        if (blogIds) query = query.condition("wikiBlogId", "in", blogIds)
        if (!blank(p.term)) query = query.condition(factory.makeCondition("title", "like", likeText(text(p.term))).ignoreCase())
        if (!blank(p.author))
            query = query.condition(factory.makeCondition("author", "like", likeText(text(p.author))).ignoreCase())
        if (!blank(p.fromDate)) query = query.condition("publishDate", "greater-equals", p.fromDate)
        if (!blank(p.thruDate)) query = query.condition("publishDate", "less", p.thruDate)
        return query
    }
    const count = build().count()
    const found = lib.page(build().orderBy("-publishDate").orderBy("wikiBlogId"), p, "postRows", count)
    const posts = found.rows.map(row => postRow(row, row, spaces, userScope))
    return {
        posts,
        postsCount: count,
        postsPageIndex: found.pageIndex,
        postsPageSize: found.pageSize,
        postsPageMaxIndex: found.pageMaxIndex,
        postsPageRangeLow: found.pageRangeLow,
        postsPageRangeHigh: found.pageRangeHigh
    }
}
function getPost(p) {
    const userScope = readScope()
    const {blog, page} = postOf(text(p.wikiBlogId))
    const access = spaceAccess(page.wikiSpaceId)
    const pageWrite = pageAccess(page.wikiPageId)
    const space = one(SPACE, {wikiSpaceId: page.wikiSpaceId})
    const history = ec.service
        .sync()
        .name(WIKI + "get#WikiPageHistory")
        .parameters({wikiPageId: page.wikiPageId})
        .disableAuthz()
        .call()
    ec.message.clearErrors()
    const current = Array.from(history?.versionList || [])[0]
    const ids = marketingAccess.organizationIds(userScope)
    const campaigns = {}
    const uses = ids.length
        ? Array.from(
              find(CONTENT, {wikiBlogId: blog.wikiBlogId})
                  .condition("organizationPartyId", "in", ids)
                  .orderBy("-fromDate")
                  .limit(50)
                  .list()
          )
              .filter(row => lib.active(row))
              .map(row => Object.assign(contentRow(row, campaigns), {distribution: distributionOf(row)}))
        : []
    return {
        post: Object.assign(postRow(blog, page, new Map(), userScope), postPublication(blog, page), {
            metaKeywords: blog.metaKeywords || "",
            metaDescription: blog.metaDescription || "",
            publishDate: blog.publishDate || null,
            smallImageLocation: blog.smallImageLocation ? true : false,
            currentVersionName: current?.versionName || null,
            spaceRestricted: space?.restrictView === "Y",
            canEdit: !!userScope.capabilities.contentEdit && !!access.canUpdate && !!pageWrite.canUpdate,
            lastUpdatedStamp: blog.lastUpdatedStamp
        }),
        categories: categoriesOf(blog.wikiBlogId),
        campaignUses: uses
    }
}

// ===== store#BlogPost =====
// A new post in a space the user may write (its text, which create#WikiBlog makes a page of, or an existing page of the space) or a
// post's metadata; through create#WikiBlog and update#WikiBlog as built, which refuse a title outside their characters.
function storePost(p) {
    editScope()
    const metaDescription = p.metaDescription != null ? text(p.metaDescription) : null
    if (metaDescription && metaDescription.length > limits.metaDescription)
        denied("VALUE_INVALID", "A meta description has at most " + limits.metaDescription + " characters")
    const fields = {}
    for (const name of ["title", "author", "summary", "metaKeywords"]) if (p[name] != null) fields[name] = text(p[name])
    if (metaDescription != null) fields.metaDescription = metaDescription
    if (!blank(p.publishDate)) fields.publishDate = p.publishDate
    if (blank(p.wikiBlogId)) {
        const wikiSpaceId = text(p.wikiSpaceId)
        requireSpaceWrite(wikiSpaceId)
        if (!fields.title) denied("TITLE_REQUIRED", "Give the post a title")
        const parameters = Object.assign({wikiSpaceId}, fields)
        if (!blank(p.wikiPageId)) {
            const page = one(WIKI_PAGE, {wikiPageId: text(p.wikiPageId)})
            if (!page || page.wikiSpaceId !== wikiSpaceId || !pageAccess(page.wikiPageId).canView)
                denied("RECORD_UNAVAILABLE", "Page " + text(p.wikiPageId) + " is not a page of the space")
            requirePageWrite(page)
            parameters.wikiPageId = page.wikiPageId
        } else if (!blank(p.blogText)) parameters.blogText = String(p.blogText)
        else denied("BODY_REQUIRED", "Write the post's text, or choose a page of the space")
        const out = ec.service
            .sync()
            .name(WIKI + "create#WikiBlog")
            .parameters(parameters)
            .disableAuthz()
            .call()
        if (ec.message.hasError()) return {}
        return {wikiBlogId: out.wikiBlogId, created: true}
    }
    const {blog, page} = postOf(text(p.wikiBlogId))
    requirePageWrite(page)
    if (!blank(p.expectedLastUpdatedStamp) && ms(p.expectedLastUpdatedStamp) !== ms(blog.lastUpdatedStamp))
        denied("REVISION_STALE", "Changed by someone else since it was read; reload")
    if (fields.title === "") denied("TITLE_REQUIRED", "Give the post a title")
    ec.service
        .sync()
        .name(WIKI + "update#WikiBlog")
        .parameters(Object.assign({wikiBlogId: blog.wikiBlogId}, fields))
        .disableAuthz()
        .call()
    return {wikiBlogId: blog.wikiBlogId, created: false}
}

// ===== add#BlogCategory, remove#BlogCategory =====
// A category write checks MARKETING_CONTENT_EDIT and the wiki's write access to the post's space before the entity write.
function categoryWrite(p) {
    editScope()
    const {blog, page} = postOf(text(p.wikiBlogId))
    requirePageWrite(page)
    const category = blank(p.wikiPageCategoryId) ? null : one(PAGE_CATEGORY, {wikiPageCategoryId: text(p.wikiPageCategoryId)})
    if (!category) denied("CATEGORY_UNKNOWN", "Choose a category")
    return {
        blog,
        category,
        existing: one(BLOG_CATEGORY, {wikiBlogId: blog.wikiBlogId, wikiPageCategoryId: category.wikiPageCategoryId})
    }
}
function addCategory(p) {
    const {blog, category, existing} = categoryWrite(p)
    if (!existing) call("create#" + BLOG_CATEGORY, {wikiBlogId: blog.wikiBlogId, wikiPageCategoryId: category.wikiPageCategoryId})
    return {added: !existing}
}
function removeCategory(p) {
    const {blog, category, existing} = categoryWrite(p)
    if (existing) call("delete#" + BLOG_CATEGORY, {wikiBlogId: blog.wikiBlogId, wikiPageCategoryId: category.wikiPageCategoryId})
    return {removed: !!existing}
}

// ===== create#ContentSend =====
// A draft send of the link's campaign drafted from its content (design §8 ContentDetail Distribution, BlogPostDetail CampaignUse):
// for a blog post, a newsletter taking the approved posts of a blog category at its preparation (the category given, else the
// topic list's newsletter category, else the post's first); for a landing page, its public link (a published page only). The send
// is an ordinary one (create#Send's own checks: MARKETING_SEND_EDIT, the topic, profile and template of the organization), approved
// and released as every send.
function createContentSend(p) {
    const userScope = editScope()
    marketingAccess.requireCapability(userScope, "sendEdit")
    const row = contentOf(userScope, text(p.campaignContentId))
    if (!lib.active(row)) denied("RECORD_ENDED", "Content link " + row.campaignContentId + " has ended")
    let postCategoryId = null
    let subject, body
    if (row.contentKindEnumId === "CckBlogPost") {
        const {blog} = postOf(row.wikiBlogId)
        const listCategory = blank(p.contactListId)
            ? null
            : rows(LIST_EMAIL, {contactListId: text(p.contactListId), emailTypeEnumId: "CONT_EMAIL_TEMPLATE"}).find(
                  binding => lib.active(binding) && binding.wikiPageCategoryId
              )?.wikiPageCategoryId
        postCategoryId = text(p.postCategoryId) || listCategory || categoriesOf(blog.wikiBlogId)[0]?.wikiPageCategoryId || null
        if (!postCategoryId || !one(PAGE_CATEGORY, {wikiPageCategoryId: postCategoryId}))
            denied("CATEGORY_REQUIRED", "Put the post in a blog category first: a newsletter takes a category's approved posts")
        subject = blog.title || "News"
        body = "<p>" + esc(plain(blog.summary) || blog.title || "") + "</p>"
    } else if (row.contentKindEnumId === "CckSitePage") {
        const page = one(SITE_PAGE, {sitePageId: row.sitePageId})
        const publication = page ? sitePagePublication(page) : null
        if (!publication?.publicUrl) denied("PAGE_NOT_PUBLISHED", "Publish the page first: a send links its public address")
        subject = page.seoTitle || page.title || "News"
        body = '<p><a href="' + esc(publication.publicUrl) + '">' + esc(page.title || page.routePath) + "</a></p>"
    } else denied("KIND_UNAVAILABLE", "A send is drafted from a blog post or a landing page")
    const made = ec.service
        .sync()
        .name(D + "create#Send")
        .parameters({
            marketingCampaignId: row.marketingCampaignId,
            sendName: text(p.sendName) || subject,
            contactListId: p.contactListId,
            sendingProfileId: p.sendingProfileId || null
        })
        .call()
    if (ec.message.hasError()) return {}
    const campaignSendId = made.campaignSendId
    call("update#" + SEND, {campaignSendId, postCategoryId, campaignContentId: row.campaignContentId})
    const send = one(SEND, {campaignSendId})
    ec.service
        .sync()
        .name(D + "store#SendContent")
        .parameters({campaignSendId, expectedRevision: ms(send.lastUpdatedStamp), subject, body})
        .call()
    return {campaignSendId}
}

// ===== newsletter assembly (prepare#Send, MarketingSends.js) =====
// The approved public posts of a category as of a time: a publish date reached and a published page version, in a space and on a
// page with no view restriction (a private space's post never reaches a recipient by its category: Marketing cannot publish a
// private space by linking it, design §8 Knowledge; P14 review R1), newest first, at most ten; POSTS_NONE when there is none.
// {posts, html, text} for the prepared body.
function postsFor(wikiPageCategoryId, asOf) {
    const at = ms(asOf)
    const ids = Array.from(find(BLOG_CATEGORY, {wikiPageCategoryId}).limit(limits.categoryPosts).list()).map(
        row => row.wikiBlogId
    )
    const factory = ec.entity.conditionFactory
    const privateSpaces = ids.length
        ? Array.from(find(SPACE).condition("restrictView", "Y").selectField("wikiSpaceId").list()).map(row => row.wikiSpaceId)
        : []
    let query = ids.length
        ? find(BLOG_VIEW)
              .condition("wikiBlogId", "in", ids)
              .condition("publishedVersionName", "is-not-null", null)
              .condition("publishDate", "less-equals", asOf)
              .condition(
                  factory.makeCondition(
                      [
                          factory.makeCondition("restrictView", "is-null", null),
                          factory.makeCondition("restrictView", "not-equals", "Y")
                      ],
                      "or"
                  )
              )
        : null
    if (query && privateSpaces.length) query = query.condition("wikiSpaceId", "not-in", privateSpaces)
    const posts = query
        ? Array.from(query.orderBy("-publishDate").limit(limits.posts).list()).filter(row => ms(row.publishDate) <= at)
        : []
    if (!posts.length)
        denied(
            "POSTS_NONE",
            "The newsletter's blog category has no approved public post yet: publish a post's page version in a public space first"
        )
    const views = posts.map(post => ({post, url: publicBlogLink(one(SPACE, {wikiSpaceId: post.wikiSpaceId}), post)}))
    const html =
        '<div class="newsletter-posts">' +
        views
            .map(
                ({post, url}) =>
                    "<h2>" +
                    esc(post.title || "") +
                    "</h2>" +
                    (plain(post.summary) ? "<p>" + esc(plain(post.summary)) + "</p>" : "") +
                    (url ? '<p><a href="' + esc(url) + '">Read more</a></p>' : "")
            )
            .join("") +
        "</div>"
    const textPart = views
        .map(({post, url}) => [post.title || "", plain(post.summary), url || ""].filter(Boolean).join("\n").replace(/[$#]/g, " "))
        .join("\n\n")
    return {posts, html, text: textPart}
}
// The posts a preparation took, each with the page version it read (an earlier preparation of the same revision replaced).
function recordPosts(campaignSendId, preparedRevision, assembled, asOf) {
    find(SEND_POST, {campaignSendId, preparedRevision}).deleteAll()
    assembled.posts.forEach((post, index) =>
        call("create#" + SEND_POST, {
            campaignSendId,
            preparedRevision,
            wikiBlogId: post.wikiBlogId,
            wikiPageId: post.wikiPageId,
            versionName: post.publishedVersionName,
            title: post.title || null,
            publishDate: post.publishDate,
            sequenceNum: index + 1,
            preparedDate: asOf
        })
    )
}

// ===== a landing page's optional review (impl-marketing §4 Nov 14, P15) =====
// The page kind of Marketing's approvals (MarketingApprovals.js targetKinds.page): a landing page of a Marketing mount, its
// organization the mount's, its revision the count of its text's saved versions (WikiPageHistory), so a save after a request makes
// the request stale; its author whoever saved the current version. A review publishes nothing: publish#SitePage stays the content
// grant's act with or without one.
const HISTORY = "moqui.resource.wiki.WikiPageHistory"
const pageHistory = row =>
    row?.wikiPageId
        ? Array.from(
              find(HISTORY, {wikiPageId: row.wikiPageId})
                  .condition("versionName", "is-not-null", null)
                  .orderBy("-historySeqId")
                  .list()
          )
        : []
const pageKind = {
    read: (sitePageId, lock) => {
        let query = sitePageId ? find(SITE_PAGE, {sitePageId}) : null
        if (query && lock) query = query.forUpdate(true)
        const page = query ? query.one() : null
        const mount = page?.appMountId ? one(SITE_APP, {siteId: page.siteId, appMountId: page.appMountId}) : null
        if (!page || !mount || mount.app !== "marketing" || !mount.targetId) return null
        return {
            sitePageId: page.sitePageId,
            siteId: page.siteId,
            title: page.title || page.routePath || page.sitePageId,
            routePath: page.routePath,
            wikiPageId: page.wikiPageId,
            publishedVersionName: page.versionName || null,
            organizationPartyId: mount.targetId
        }
    },
    revision: row => pageHistory(row).length,
    versionName: row => pageHistory(row)[0]?.versionName || null,
    authors: row => [pageHistory(row)[0]?.userId].filter(Boolean),
    requestable: row => {
        if (!pageHistory(row).length) denied("NOT_READY", "Landing page " + row.sitePageId + " has no saved text to review")
    }
}
// get#PageReview: a landing page's review for a Marketing reader of its mount's organization: its state at the current text version
// (approved, asked, refused or not reviewed), the decisions, and whether the caller may ask (MARKETING_CONTENT_EDIT, none pending) or
// decide (MARKETING_APPROVE, not their own text or request unless the one-person-team flag admits it).
function pageReview(p) {
    const userScope = readScope()
    const approvals = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingApprovals.js")
    const kind = approvals.targetKinds.page
    const row = blank(p.sitePageId) ? null : pageKind.read(text(p.sitePageId))
    if (!row || !marketingAccess.covers(userScope, row.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Landing page " + text(p.sitePageId) + " is not available")
    const revision = pageKind.revision(row)
    const versionName = pageKind.versionName(row)
    const short = name => (name == null ? "" : String(name).length > 12 ? String(name).slice(0, 10) : String(name))
    const pending = revision ? approvals.pendingRequest(kind, row.sitePageId, revision) : null
    const approved = revision ? approvals.currentApproval("page", row.sitePageId, revision) : null
    const decisions = approvals.decisionRows(kind, row.sitePageId, null).slice(0, 20)
    const latest = decisions.find(entry => Number(entry.targetRevision) === revision && !entry.superseded) || null
    const authorIds = pageKind.authors(row).concat([pending?.decidedByUserId].filter(Boolean))
    const own = authorIds.includes(ec.user.userId)
    const caps = userScope.capabilities
    const stateText = approved
        ? "Approved at version " + short(versionName)
        : pending
          ? "Review asked at version " + short(versionName)
          : latest?.decisionEnumId === "MddRefused"
            ? "Refused at version " + short(versionName) + (latest.reason ? ": " + latest.reason : "")
            : revision
              ? "Not reviewed at version " + short(versionName)
              : "No text saved yet"
    return {
        review: {
            sitePageId: row.sitePageId,
            title: row.title,
            revision,
            versionName,
            versionShort: short(versionName),
            stateText,
            stateColor: approved
                ? "positive"
                : pending
                  ? "warning"
                  : latest?.decisionEnumId === "MddRefused"
                    ? "negative"
                    : "grey-8",
            pending: !!pending,
            approved: !!approved,
            publishedIsReviewed: !!approved && row.publishedVersionName === versionName
        },
        decisions,
        capabilities: {
            canRequest: !!caps.contentEdit && revision > 0 && !pending && !approved,
            canDecide:
                !!caps.approve &&
                !!pending &&
                (!own || approvals.selfApprovalAdmits(approvals.policyOf(row.organizationPartyId), "page", null))
        }
    }
}

const operations = {
    pageReview,
    findContent,
    getContent,
    storeContent,
    findPosts,
    getPost,
    storePost,
    addCategory,
    removeCategory,
    createContentSend
}
;({
    kinds,
    postsFor,
    recordPosts,
    pageKind,
    // each operation checks the caller's Marketing scope and permission (and the wiki's own rule for a post), and reads and writes
    // with artifact authorization off
    execute(op, parameters) {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown marketing content operation " + op)
        const wasDisabled = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](parameters || {})
        } finally {
            if (!wasDisabled) ec.artifactExecution.enableAuthz()
        }
    }
})
