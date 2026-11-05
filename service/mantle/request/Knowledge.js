// Service knowledge (design-customer-service §3 CaseDetail Knowledge, §6 Knowledge, ArticleFeedback, CaseToArticle, §9
// KnowledgeSources; impl-customer-service P12, CS-KNOWLEDGE, F15, F59; SupportKnowledgeEntities.xml). Articles are Commons
// wiki pages with their own view and update rules; an organization's ServiceKnowledgeSource rows say which spaces (or parts
// of one, by page path) its service desk suggests and sends, for which audience and in which language. A source never widens
// access: on an agent's surface a page is offered only when the wiki lets the user view it (get#WikiViewScope), and on a
// customer-visible surface only a published page of a customer or public source, never an internal source's, a draft or a
// restricted page. A published article is read by the exact-published-version rule of the forum's site pages (F59):
// get#PublishedWikiPageText with no version asked, the version it answers checked against the page's published version, and
// the text cleaned (StringUtilities.cleanHtml). Feedback is reviewed by a knowledge author into a task (made, or one given
// linked) on the page, never a change of the article; a batch names each failure and goes on. An article from a case is a
// redacted, unpublished draft in a source's draft space, linked to the case by WikiPageRequest. Refusals carry reason codes.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const cases = ec.resource.script("component://mr-mantle/service/mantle/request/SupportCases.js")
const {find, one, rows, call, denied, access, ms} = lib

const SOURCE = "mantle.request.support.ServiceKnowledgeSource",
    FEEDBACK = "mantle.request.support.ArticleFeedback",
    PAGE = "moqui.resource.wiki.WikiPage",
    SPACE = "moqui.resource.wiki.WikiSpace",
    PAGE_REQUEST = "mantle.request.WikiPageRequest",
    PAGE_TASK = "mantle.work.effort.WikiPageWorkEffort",
    PARTY = "mantle.request.RequestParty"
const audiences = ["SkaInternal", "SkaCustomer", "SkaPublic"]
const customerAudiences = ["SkaCustomer", "SkaPublic"]
const decisions = ["AfdImprove", "AfdNoChange", "AfdDismissed"]
// words a subject is matched on: three letters or more, not these
const stopWords = new Set(
    "the and for with that this from have has had not are was were you your our can cant does doesnt dont how what when why who where wont will into out about after before".split(
        " "
    )
)

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const yn = (value, fallback = "N") => (value === true || value === "Y" || value === "true" ? "Y" : blank(value) ? fallback : "N")
const truthy = value => value === true || value === "Y" || value === "true"
const now = () => ec.user.nowTimestamp
const listOf = value =>
    value == null
        ? []
        : (typeof value === "string" ? value.split(",") : Array.from(value))
              .map(String)
              .map(s => s.trim())
              .filter(Boolean)
const language = locale => (blank(locale) ? null : String(locale).split(/[_-]/)[0].toLowerCase())
const plain = html =>
    String(html || "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
        .replace(/<[^>]*>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
const pageTitle = page => {
    const path = String(page?.pagePath || "")
    return path ? path.slice(path.lastIndexOf("/") + 1) : one(SPACE, {wikiSpaceId: page?.wikiSpaceId})?.description || ""
}

// ===== access =====
function requirePermission(permission) {
    if (!access.has(permission)) denied("PERMISSION_DENIED", permission + " is required")
}
const isInternal = partyId => !!partyId && !!one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
// A party on the service desk's side: an internal organization, or a person who works for one (an agent who files a case is its
// Reporter, never the customer's side).
const isStaff = partyId =>
    isInternal(partyId) ||
    rows("mantle.party.PartyRelationship", {fromPartyId: partyId})
        .filter(
            row =>
                lib.active(row) &&
                ["PrtEmployee", "PrtAgent", "PrtMember", "PrtRepresentative"].includes(row.relationshipTypeEnumId)
        )
        .some(row => isInternal(row.toPartyId))
function requireOrganization(organizationPartyId) {
    if (
        !organizationPartyId ||
        !isInternal(organizationPartyId) ||
        !facilityScope.owns(facilityScope.scope(), organizationPartyId)
    )
        denied("RECORD_UNAVAILABLE", "Organization " + (organizationPartyId || "") + " is not available")
    return String(organizationPartyId)
}
// The organizations the user works for (null: every one, for a system administrator or FACILITY_ALL_ORGANIZATIONS).
const userOrganizations = () => facilityScope.scope().organizationPartyIds
// A case of one of the user's organizations; a missing request, one that is not a case and another organization's are
// refused alike (RECORD_UNAVAILABLE).
function caseOf(requestId) {
    const unavailable = () => denied("RECORD_UNAVAILABLE", "Case " + (requestId || "") + " is not available")
    if (blank(requestId)) unavailable()
    const profile = one("mantle.request.support.CaseProfile", {requestId})
    const request = profile ? one("mantle.request.Request", {requestId}) : null
    if (!request) unavailable()
    const parties = rows(PARTY, {requestId}).filter(row => lib.active(row))
    const roleOf = roleTypeId => parties.find(row => row.roleTypeId === roleTypeId)?.partyId || null
    const organizationPartyId = roleOf("OrgInternal")
    if (!organizationPartyId || !facilityScope.owns(facilityScope.scope(), organizationPartyId)) unavailable()
    return {
        request,
        parties,
        requestId: String(requestId),
        organizationPartyId,
        customerPartyId: roleOf("Customer"),
        contactPartyId: roleOf("Reporter")
    }
}
// What the user may view by the wiki's rules (the spaces and the restricted pages hidden from them).
function viewScope() {
    const out = ec.service.sync().name("org.moqui.impl.WikiServices.get#WikiViewScope").call() || {}
    return {spaceIds: new Set(Array.from(out.viewSpaceIdList || [])), hidden: new Set(Array.from(out.hiddenPageIdList || []))}
}
const pageAccess = wikiPageId =>
    ec.service.sync().name("org.moqui.impl.WikiServices.get#WikiPageAccess").parameters({wikiPageId}).call() || {}
const spaceAccess = wikiSpaceId =>
    ec.service.sync().name("org.moqui.impl.WikiServices.get#WikiPageAccess").parameters({wikiSpaceId}).call() || {}

// ===== sources =====
// The current sources (a draft has no from date) of some organizations (null: every one), by priority.
function currentSources(organizationPartyIds, conditions = {}) {
    let query = find(SOURCE, conditions)
        .condition(ec.entity.conditionFactory.makeCondition("fromDate", "is-not-null", null))
        .conditionDate("fromDate", "thruDate", now())
    if (organizationPartyIds)
        query = query.condition("organizationPartyId", "in", organizationPartyIds.length ? organizationPartyIds : ["_NONE_"])
    return Array.from(query.list()).sort(
        (a, b) =>
            (a.sequenceNum ?? 99) - (b.sequenceNum ?? 99) ||
            String(a.serviceKnowledgeSourceId).localeCompare(b.serviceKnowledgeSourceId)
    )
}
const prefixOf = source => String(source.pagePathPrefix || "").replace(/^\/+|\/+$/g, "")
const covers = (source, page) => {
    if (source.wikiSpaceId !== page.wikiSpaceId) return false
    const prefix = prefixOf(source)
    const path = String(page.pagePath || "")
    return !prefix || path === prefix || path.startsWith(prefix + "/")
}
// The source a page belongs to among the given ones: of its space, the longest matching prefix (of equal ones an internal
// source, else the first by priority, so a page two sources claim alike is never taken for a customer article).
function sourceOfPage(sources, page) {
    let best = null
    for (const source of sources) {
        if (!covers(source, page)) continue
        const length = prefixOf(source).length,
            bestLength = best ? prefixOf(best).length : -1
        if (
            length > bestLength ||
            (length === bestLength && source.audienceEnumId === "SkaInternal" && best.audienceEnumId !== "SkaInternal")
        )
            best = source
    }
    return best
}
// The source an article is in for an organization (or any organization), or null.
function articleSource(page, organizationPartyIds) {
    return page ? sourceOfPage(currentSources(organizationPartyIds, {wikiSpaceId: page.wikiSpaceId}), page) : null
}

// save#ServiceKnowledgeSource: a source from its date (now, a date, or none for a draft), ending the one it replaces; with
// end, ends it.
function saveSource(p) {
    requirePermission("SUPPORT_POLICY_EDIT")
    const old = p.serviceKnowledgeSourceId ? one(SOURCE, {serviceKnowledgeSourceId: p.serviceKnowledgeSourceId}) : null
    if (p.serviceKnowledgeSourceId && !old)
        denied("RECORD_UNAVAILABLE", "Source " + p.serviceKnowledgeSourceId + " is not available")
    const organizationPartyId = requireOrganization(old?.organizationPartyId || p.organizationPartyId)
    if (old && p.organizationPartyId && p.organizationPartyId !== old.organizationPartyId)
        denied("SOURCE_ORGANIZATION", "A source stays its organization's")
    if (truthy(p.end)) {
        if (!old) denied("RECORD_UNAVAILABLE", "Choose the source to end")
        old.set("thruDate", p.fromDate || now())
        old.set("changeReason", text(p.changeReason))
        old.update()
        return {serviceKnowledgeSourceId: old.serviceKnowledgeSourceId}
    }
    const wikiSpaceId = text(p.wikiSpaceId) || old?.wikiSpaceId
    // only a wiki space the user may view (a source never names a space hidden from its editor)
    if (!wikiSpaceId || !one(SPACE, {wikiSpaceId}) || !spaceAccess(wikiSpaceId).canView)
        denied("SPACE_UNAVAILABLE", "Choose a wiki space you may read")
    const audienceEnumId = p.audienceEnumId || old?.audienceEnumId || "SkaInternal"
    if (!audiences.includes(audienceEnumId)) denied("AUDIENCE_INVALID", audienceEnumId + " is not an audience")
    // an internal source in a space with a public address would publish agents' notes on the public site (F-P12-2)
    if (audienceEnumId === "SkaInternal" && !blank(one(SPACE, {wikiSpaceId})?.publicPageUrl))
        denied(
            "INTERNAL_PUBLIC_SPACE",
            "A space with a public address holds customer articles; put internal ones in a space of their own"
        )
    const localeLanguage = language(p.localeLanguage ?? old?.localeLanguage)
    if (!localeLanguage || !/^[a-z]{2,3}$/.test(localeLanguage))
        denied("LANGUAGE_REQUIRED", "Choose the language of the source's pages")
    const reviewTeamPartyId = p.reviewTeamPartyId == null ? old?.reviewTeamPartyId || null : text(p.reviewTeamPartyId)
    if (reviewTeamPartyId) {
        const team = one("mantle.party.Party", {partyId: reviewTeamPartyId})
        if (
            !team ||
            team.ownerPartyId !== organizationPartyId ||
            !one("mantle.party.PartyRole", {partyId: reviewTeamPartyId, roleTypeId: "OrgTeam"})
        )
            denied("TEAM_UNAVAILABLE", "The review team must be a team of the organization")
    }
    const draftWikiSpaceId = p.draftWikiSpaceId == null ? old?.draftWikiSpaceId || null : text(p.draftWikiSpaceId)
    if (draftWikiSpaceId && (!one(SPACE, {wikiSpaceId: draftWikiSpaceId}) || !spaceAccess(draftWikiSpaceId).canView))
        denied("SPACE_UNAVAILABLE", "Choose a draft space you may read")
    const requestCategoryId = p.requestCategoryId == null ? old?.requestCategoryId || null : text(p.requestCategoryId)
    if (requestCategoryId && cases.queueOf(requestCategoryId)?.organizationPartyId !== organizationPartyId)
        denied("QUEUE_UNAVAILABLE", "Choose a service queue of the organization")
    // a field not given keeps the edited row's value; an empty one clears it
    const pick = (field, fallback = null) => (p[field] == null ? (old ? (old[field] ?? fallback) : fallback) : p[field])
    const values = {
        wikiSpaceId,
        pagePathPrefix: text(pick("pagePathPrefix"))?.replace(/^\/+|\/+$/g, "") || null,
        audienceEnumId,
        localeLanguage,
        requestCategoryId,
        productCategoryId: text(pick("productCategoryId")),
        sequenceNum: blank(pick("sequenceNum")) ? 10 : Number(pick("sequenceNum")),
        allowSuggestions: yn(pick("allowSuggestions"), "Y"),
        reviewTeamPartyId,
        draftWikiSpaceId,
        draftParentPath: text(pick("draftParentPath"))?.replace(/^\/+|\/+$/g, "") || null,
        changeReason: text(p.changeReason)
    }
    // the row replaced: the one edited, else the current one of the same space and path
    const draft = truthy(p.draft)
    const fromDate = draft ? null : p.fromDate || now()
    if (!draft) {
        const replaced = old
            ? [old]
            : currentSources([organizationPartyId], {wikiSpaceId}).filter(row => prefixOf(row) === (values.pagePathPrefix || ""))
        for (const row of replaced)
            if (row.fromDate && (!row.thruDate || ms(row.thruDate) > ms(fromDate))) {
                row.set("thruDate", fromDate)
                row.update()
            }
    }
    const created = call(
        "create#" + SOURCE,
        Object.assign({organizationPartyId}, values, {fromDate, thruDate: p.thruDate || null})
    )
    return {serviceKnowledgeSourceId: created.serviceKnowledgeSourceId}
}

// ===== suggestions =====
const wordsOf = value =>
    Array.from(
        new Set(
            String(value || "")
                .toLowerCase()
                .normalize("NFD")
                .replace(/[̀-ͯ]/g, "")
                .split(/[^a-z0-9]+/)
                .filter(word => word.length >= 3 && !stopWords.has(word))
        )
    ).slice(0, 8)
const pathWords = path =>
    String(path || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
// The requester's language: given, else the case's contact's or customer's user account locale.
function requesterLanguage(p, theCase) {
    if (!blank(p.localeLanguage)) return language(p.localeLanguage)
    for (const partyId of [p.contactPartyId, theCase?.contactPartyId, p.customerPartyId, theCase?.customerPartyId]) {
        if (!partyId) continue
        const account = rows("moqui.security.UserAccount", {partyId}).find(row => row.locale)
        if (account) return language(account.locale)
    }
    return null
}
// find#ArticleSuggestions: the articles of the organization's sources a subject matches, the requester's language first,
// then by the queue or product category the source is for, the words matched and the source's priority.
function suggestions(p) {
    const customerVisible = truthy(p.customerVisible)
    const theCase = p.requestId ? caseOf(p.requestId) : null
    const organizationPartyId = theCase?.organizationPartyId || p.organizationPartyId
    // an agent's surface is the organization's; a customer-visible one shows only what any customer of it could read
    if (!customerVisible) requireOrganization(organizationPartyId)
    else if (!organizationPartyId || !isInternal(organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Organization " + (organizationPartyId || "") + " is not available")
    // a page's own source is found among all the current ones (an internal part not suggested still keeps its pages from a
    // broader customer source); only the sources suggested, and on a customer-visible surface only customer and public ones,
    // are offered
    const allSources = currentSources([organizationPartyId])
    const sources = allSources.filter(source => source.allowSuggestions !== "N")
    const offered = customerVisible ? sources.filter(source => customerAudiences.includes(source.audienceEnumId)) : sources
    const requesterLanguageCode = requesterLanguage(p, theCase)
    const words = wordsOf(blank(p.text) && theCase ? theCase.request.requestName : p.text)
    const result = {articleList: [], requesterLanguage: requesterLanguageCode, configured: sources.length > 0}
    if (!offered.length || !words.length) return result
    const requestCategoryId = p.requestCategoryId || theCase?.request.requestCategoryId || null
    const linked = new Set(theCase ? rows(PAGE_REQUEST, {requestId: theCase.requestId}).map(row => row.wikiPageId) : [])
    const scope = customerVisible ? null : viewScope()
    const factory = ec.entity.conditionFactory
    const found = new Map()
    for (const spaceId of Array.from(new Set(offered.map(source => source.wikiSpaceId)))) {
        const space = one(SPACE, {wikiSpaceId: spaceId})
        if (!space) continue
        if (customerVisible ? space.restrictView === "Y" : !scope.spaceIds.has(spaceId)) continue
        const spaceSources = allSources.filter(source => source.wikiSpaceId === spaceId)
        const pages = find(PAGE, {wikiSpaceId: spaceId})
            .condition(
                factory.makeCondition(
                    words.map(word => factory.makeCondition("pagePath", "like", "%" + word + "%").ignoreCase()),
                    "or"
                )
            )
            .orderBy("pagePath")
            .limit(100)
            .list()
        for (const page of pages) {
            if (!page.pagePath || found.has(page.wikiPageId)) continue
            if (customerVisible ? page.restrictView === "Y" || !page.publishedVersionName : scope.hidden.has(page.wikiPageId))
                continue
            // the page's own source: a page under a more specific source of the space belongs to that one
            const source = sourceOfPage(spaceSources, page)
            if (!source || !offered.includes(source)) continue
            const haystack = pathWords(page.pagePath)
            const score = words.filter(word => haystack.includes(word)).length
            if (!score) continue
            found.set(page.wikiPageId, {page, source, space, score})
        }
    }
    const audienceText = enumId => one("moqui.basic.Enumeration", {enumId})?.description || enumId
    const ranked = Array.from(found.values()).sort(
        (a, b) =>
            (b.source.localeLanguage === requesterLanguageCode) - (a.source.localeLanguage === requesterLanguageCode) ||
            (b.source.requestCategoryId && b.source.requestCategoryId === requestCategoryId) -
                (a.source.requestCategoryId && a.source.requestCategoryId === requestCategoryId) ||
            (!!p.productCategoryId && b.source.productCategoryId === p.productCategoryId) -
                (!!p.productCategoryId && a.source.productCategoryId === p.productCategoryId) ||
            b.score - a.score ||
            (a.source.sequenceNum ?? 99) - (b.source.sequenceNum ?? 99) ||
            String(a.page.pagePath).localeCompare(String(b.page.pagePath))
    )
    const limit = Math.max(1, Math.min(Number(p.limit || 10), 50))
    result.articleList = ranked.slice(0, limit).map(({page, source, space, score}) => ({
        wikiPageId: page.wikiPageId,
        wikiSpaceId: page.wikiSpaceId,
        pagePath: page.pagePath,
        title: pageTitle(page),
        spaceName: space.description || space.wikiSpaceId,
        serviceKnowledgeSourceId: source.serviceKnowledgeSourceId,
        audienceEnumId: source.audienceEnumId,
        audienceText: audienceText(source.audienceEnumId),
        internal: source.audienceEnumId === "SkaInternal",
        localeLanguage: source.localeLanguage,
        inRequesterLanguage: !!requesterLanguageCode && source.localeLanguage === requesterLanguageCode,
        published: !!page.publishedVersionName,
        publishedVersionName: page.publishedVersionName || null,
        score,
        linked: linked.has(page.wikiPageId)
    }))
    return result
}

// ===== published articles (F59) =====
// get#PublishedArticle: a published article by the exact-published-version rule, its text cleaned. On a customer-visible
// surface (the default) only a page of a current customer or public source (of the organization when one is given), not
// restricted, in a space not restricted; a draft, an internal source's page and a page in no source are unavailable alike.
// For an agent (customerVisible false) a page of a source of the user's organizations that the wiki lets them view.
function publishedArticle(p) {
    const customerVisible = p.customerVisible == null || truthy(p.customerVisible)
    const unavailable = () => denied("ARTICLE_UNAVAILABLE", "This article is not available")
    let page = p.wikiPageId ? one(PAGE, {wikiPageId: p.wikiPageId}) : null
    if (!page && p.wikiSpaceId) page = find(PAGE, {wikiSpaceId: p.wikiSpaceId, pagePath: p.pagePath || null}).one()
    if (!page || !page.publishedVersionName) unavailable()
    const space = one(SPACE, {wikiSpaceId: page.wikiSpaceId})
    const organizationIds = customerVisible ? (p.organizationPartyId ? [p.organizationPartyId] : null) : userOrganizations()
    const source = articleSource(page, organizationIds)
    if (!source || !space) unavailable()
    if (
        customerVisible &&
        (!customerAudiences.includes(source.audienceEnumId) || page.restrictView === "Y" || space.restrictView === "Y")
    )
        unavailable()
    if (!customerVisible && !pageAccess(page.wikiPageId).canView) unavailable()
    // the published version itself, read with no version asked so a non-published one is never exposed
    const wasDisabled = ec.artifactExecution.disableAuthz()
    let out
    try {
        out = ec.service
            .sync()
            .name("org.moqui.impl.WikiServices.get#PublishedWikiPageText")
            .parameters({wikiSpaceId: page.wikiSpaceId, pagePath: page.pagePath, versionName: null})
            .call()
    } finally {
        if (!wasDisabled) ec.artifactExecution.enableAuthz()
    }
    if (ec.message.hasError()) {
        ec.message.clearErrors()
        unavailable()
    }
    if (!out?.versionName || out.versionName !== page.publishedVersionName) unavailable()
    return {
        article: {
            wikiPageId: page.wikiPageId,
            wikiSpaceId: page.wikiSpaceId,
            pagePath: page.pagePath,
            title: pageTitle(page),
            versionName: page.publishedVersionName,
            body: StringUtilities.cleanHtml(out.pageText || ""),
            localeLanguage: source.localeLanguage,
            audienceEnumId: source.audienceEnumId,
            organizationPartyId: source.organizationPartyId
        }
    }
}
// get#ArticlePublicLink: the published URL of an article an agent sends a customer (Send to customer): a page of a customer
// or public source of the user's organizations, published and not restricted, at its space's publicPageUrl (the Support
// app's CustomerArticle once P15 builds it). A draft (ARTICLE_NOT_PUBLISHED), an internal or unsourced article
// (ARTICLE_INTERNAL) and a space with no public address (NO_PUBLIC_URL) are refused.
function publicLink(p) {
    const page = p.wikiPageId ? one(PAGE, {wikiPageId: p.wikiPageId}) : null
    if (!page || !pageAccess(page.wikiPageId).canView) denied("ARTICLE_UNAVAILABLE", "This article is not available")
    if (p.requestId) caseOf(p.requestId)
    const source = articleSource(page, userOrganizations())
    const space = one(SPACE, {wikiSpaceId: page.wikiSpaceId})
    if (!source || !customerAudiences.includes(source.audienceEnumId) || page.restrictView === "Y" || space?.restrictView === "Y")
        denied("ARTICLE_INTERNAL", pageTitle(page) + " is an internal article; it is not sent to customers")
    if (!page.publishedVersionName) denied("ARTICLE_NOT_PUBLISHED", pageTitle(page) + " is a draft; publish it before sending it")
    if (blank(space.publicPageUrl))
        denied("NO_PUBLIC_URL", "The space " + (space.description || space.wikiSpaceId) + " has no public address")
    let url = ec.resource.expand(String(space.publicPageUrl), "", {
        pagePath: page.pagePath,
        versionName: page.publishedVersionName,
        wikiPageId: page.wikiPageId,
        wikiSpaceId: page.wikiSpaceId
    })
    if (url.startsWith("/") && ec.web) {
        try {
            url = String(ec.web.getWebappRootUrl("webroot", null, true, false) || "").replace(/\/+$/, "") + url
        } catch (error) {
            ec.logger.warn("Article " + page.wikiPageId + ": the link stays relative: " + error.message)
        }
    }
    return {url, title: pageTitle(page), versionName: page.publishedVersionName}
}

// ===== feedback =====
// record#ArticleFeedback: an agent's report on an article read for a case (helpful or not, a plain-text comment), on the
// version given or the published one. Needs SUPPORT_CASE_EDIT, the case of the user's organization and a page of its
// sources the wiki lets the user view.
function recordFeedback(p) {
    requirePermission("SUPPORT_CASE_EDIT")
    const theCase = p.requestId ? caseOf(p.requestId) : null
    const page = p.wikiPageId ? one(PAGE, {wikiPageId: p.wikiPageId}) : null
    if (!page || !pageAccess(page.wikiPageId).canView) denied("ARTICLE_UNAVAILABLE", "This article is not available")
    const source = articleSource(page, theCase ? [theCase.organizationPartyId] : userOrganizations())
    if (!source) denied("ARTICLE_UNAVAILABLE", "This article is not in a knowledge source of yours")
    if (blank(p.helpful)) denied("HELPFUL_REQUIRED", "Say whether the article helped")
    const created = call("create#" + FEEDBACK, {
        wikiPageId: page.wikiPageId,
        versionName: text(p.versionName) || page.publishedVersionName || null,
        helpful: yn(p.helpful),
        comment: text(plain(p.comment))?.substring(0, 4000) || null,
        requestId: theCase?.requestId || null,
        organizationPartyId: source.organizationPartyId,
        serviceKnowledgeSourceId: source.serviceKnowledgeSourceId,
        sourceEnumId: "AfsAgent",
        submittedByUserId: ec.user.userId,
        submittedByPartyId: ec.user.userAccount?.partyId || null,
        submittedDate: now(),
        statusId: "AfbSubmitted"
    })
    return {articleFeedbackId: created.articleFeedbackId}
}
// make#ArticleTask: a task on a page for its review team (WikiPageWorkEffort; RequestWorkEffort when a case is given). The
// callers check the permission.
function makeTask(p) {
    const page = one(PAGE, {wikiPageId: p.wikiPageId})
    if (!page) denied("ARTICLE_UNAVAILABLE", "This article is not available")
    const out = call("mantle.work.TaskServices.create#Task", {
        workEffortName: String(p.workEffortName || pageTitle(page)).substring(0, 255),
        description: p.description || null,
        purposeEnumId: "WepTask",
        priority: 5,
        estimatedCompletionDate: p.dueDate || null,
        assignToPartyId: p.assigneePartyId || null,
        requestId: p.requestId || null
    })
    call("create#" + PAGE_TASK, {wikiPageId: page.wikiPageId, workEffortId: out.workEffortId})
    return {workEffortId: out.workEffortId}
}
const outcomeOf = {
    RECORD_UNAVAILABLE: "Forbidden",
    PERMISSION_DENIED: "Forbidden",
    ALREADY_REVIEWED: "AlreadyReviewed",
    TASK_UNAVAILABLE: "Failed"
}
// review#ArticleFeedback: the decision on each feedback given (Improve makes one task per article, or links the task given;
// No change and Dismissed take none), each in its own transaction: one of another organization (Forbidden), one already
// reviewed (AlreadyReviewed) or one that fails is named and the others are reviewed. The article itself is never changed.
// With an operation key a retry answers the first result.
function reviewFeedback(p) {
    requirePermission("SUPPORT_KNOWLEDGE_EDIT")
    const ids = Array.from(new Set(listOf(p.articleFeedbackIds))).slice(0, 200)
    if (!ids.length) denied("SELECTION_REQUIRED", "Select the feedback first")
    const decisionEnumId = p.decisionEnumId || "AfdImprove"
    if (!decisions.includes(decisionEnumId)) denied("DECISION_INVALID", decisionEnumId + " is not a review decision")
    let linkedTask = null
    if (p.workEffortId) {
        linkedTask = one("mantle.work.effort.WorkEffort", {workEffortId: p.workEffortId})
        if (!linkedTask || linkedTask.workEffortTypeEnumId !== "WetTask")
            denied("TASK_UNAVAILABLE", "Task " + p.workEffortId + " is not available")
    }
    const organizations = userOrganizations()
    const request = {
        ids,
        decisionEnumId,
        note: p.reviewNote || null,
        assigneePartyId: p.assigneePartyId || null,
        workEffortId: p.workEffortId || null
    }
    const op = p.operationKey ? lib.operation(p, "ArticleFeedbackReview", (organizations || [])[0] || "_NA_", request) : null
    const earlier = op ? lib.previous(op) : null
    if (earlier) return earlier
    const results = []
    const tasks = new Map()
    const fail = (articleFeedbackId, error) => {
        const message = String(error.message || error).replace(/^(Error: )+/, "")
        const code = lib.reasonCode({message}) || (/([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+):/.exec(message) || [])[1]
        results.push({
            articleFeedbackId,
            outcome: outcomeOf[code] || "Failed",
            message: message.split("\n")[0]
        })
    }
    for (const articleFeedbackId of ids) {
        try {
            // the feedback, its task and its link in one transaction (review#ArticleFeedbackItem), so a failure leaves neither
            const feedback = one(FEEDBACK, {articleFeedbackId})
            const out = lib.probe("mantle.request.KnowledgeServices.review#ArticleFeedbackItem", {
                articleFeedbackId,
                articleFeedbackIds: ids,
                decisionEnumId,
                reviewNote: p.reviewNote || null,
                assigneePartyId: p.assigneePartyId || null,
                dueDate: p.dueDate || null,
                workEffortId: linkedTask?.workEffortId || (feedback ? tasks.get(feedback.wikiPageId) : null) || null
            })
            if (out.workEffortId && feedback) tasks.set(feedback.wikiPageId, out.workEffortId)
            results.push({articleFeedbackId, outcome: "Done", message: "", workEffortId: out.workEffortId || null})
        } catch (error) {
            ec.logger.warn("Article feedback " + articleFeedbackId + " was not reviewed: " + (error.message || error))
            fail(articleFeedbackId, error)
        }
    }
    const result = {
        results,
        doneCount: results.filter(row => row.outcome === "Done").length,
        failedCount: results.filter(row => row.outcome !== "Done").length,
        workEffortIds: Array.from(new Set(results.map(row => row.workEffortId).filter(Boolean)))
    }
    if (op) lib.complete(op, FEEDBACK, ids[0], result)
    return result
}

// review#ArticleFeedbackItem: one feedback of review#ArticleFeedback, in its own transaction: refused when of another
// organization (RECORD_UNAVAILABLE) or reviewed already (ALREADY_REVIEWED); for AfdImprove the task given (an earlier one of
// the batch, or the one to link) linked to the page, else one made with the batch's comments on the page; the feedback
// reviewed.
function reviewFeedbackItem(p) {
    requirePermission("SUPPORT_KNOWLEDGE_EDIT")
    const {articleFeedbackId, decisionEnumId} = p
    const organizations = userOrganizations()
    const feedback = one(FEEDBACK, {articleFeedbackId})
    if (!feedback || !feedback.organizationPartyId || (organizations && !organizations.includes(feedback.organizationPartyId)))
        denied("RECORD_UNAVAILABLE", "Feedback " + articleFeedbackId + " is not available")
    if (feedback.statusId === "AfbReviewed") denied("ALREADY_REVIEWED", "Feedback " + articleFeedbackId + " was reviewed already")
    let workEffortId = null
    if (decisionEnumId === "AfdImprove") {
        workEffortId = p.workEffortId || null
        if (!workEffortId) {
            const page = one(PAGE, {wikiPageId: feedback.wikiPageId})
            const source = page ? articleSource(page, [feedback.organizationPartyId]) : null
            const batch = listOf(p.articleFeedbackIds)
            const comments = rows(FEEDBACK, {wikiPageId: feedback.wikiPageId, statusId: "AfbSubmitted"})
                .filter(row => batch.includes(row.articleFeedbackId) && row.comment)
                .map(row => "- " + (row.helpful === "Y" ? "Helpful: " : "Not helpful: ") + row.comment)
            workEffortId = makeTask({
                wikiPageId: feedback.wikiPageId,
                workEffortName: "Improve article: " + pageTitle(page),
                description: [p.reviewNote, comments.join("\n")].filter(Boolean).join("\n\n") || null,
                assigneePartyId: p.assigneePartyId || source?.reviewTeamPartyId || null,
                dueDate: p.dueDate || null
            }).workEffortId
        } else if (!one(PAGE_TASK, {wikiPageId: feedback.wikiPageId, workEffortId}))
            call("create#" + PAGE_TASK, {wikiPageId: feedback.wikiPageId, workEffortId})
    }
    call("update#" + FEEDBACK, {
        articleFeedbackId,
        statusId: "AfbReviewed",
        decisionEnumId,
        reviewNote: text(plain(p.reviewNote))?.substring(0, 4000) || null,
        reviewedByUserId: ec.user.userId,
        reviewedDate: now(),
        workEffortId
    })
    return {workEffortId}
}

// ===== suggest an edit (F15) =====
// suggest#ArticleEdit: an agent who may not edit the page files a task on it for its source's review team, with what should
// change (an editor saves a draft version and asks for its review through request#WikiPageReview instead). Needs
// SUPPORT_CASE_EDIT and a page of the user's organizations' sources the wiki lets them view.
function suggestEdit(p) {
    requirePermission("SUPPORT_CASE_EDIT")
    const theCase = p.requestId ? caseOf(p.requestId) : null
    const page = p.wikiPageId ? one(PAGE, {wikiPageId: p.wikiPageId}) : null
    if (!page || !pageAccess(page.wikiPageId).canView) denied("ARTICLE_UNAVAILABLE", "This article is not available")
    const source = articleSource(page, theCase ? [theCase.organizationPartyId] : userOrganizations())
    if (!source) denied("ARTICLE_UNAVAILABLE", "This article is not in a knowledge source of yours")
    const note = text(plain(p.note))
    if (!note) denied("NOTE_REQUIRED", "Say what should change")
    return makeTask({
        wikiPageId: page.wikiPageId,
        workEffortName: "Suggested edit: " + pageTitle(page),
        description: note.substring(0, 4000),
        assigneePartyId: source.reviewTeamPartyId || null,
        requestId: theCase?.requestId || null
    })
}

// ===== an article from a case =====
// The parties outside the service desk on a case: its parties of any role and the senders and recipients of its emails that
// are not staff.
function outsideParties(theCase) {
    const ids = theCase.parties.map(row => row.partyId)
    for (const row of rows("mantle.request.RequestCommEvent", {requestId: theCase.requestId})) {
        const event = one("mantle.party.communication.CommunicationEvent", {communicationEventId: row.communicationEventId})
        if (event) ids.push(event.fromPartyId, event.toPartyId)
    }
    return Array.from(new Set(ids.filter(Boolean))).filter(partyId => !isStaff(partyId))
}
// The personal data of a case, to take out of an article: the names of the parties outside the service desk on it (first,
// last and full), their ids, email addresses, phone numbers and street addresses; the records it is linked to but its
// products (orders, returns, invoices, shipments...); the customer's own orders, returns and invoices; and any email address
// or phone number by its shape.
function personalTerms(theCase) {
    const terms = []
    const add = (kind, value) => {
        const term = text(value)
        if (term && term.length >= 3 && !terms.some(row => row.term.toLowerCase() === term.toLowerCase()))
            terms.push({kind, term})
    }
    const partyIds = outsideParties(theCase)
    for (const partyId of partyIds) {
        add("name", partyId)
        const person = one("mantle.party.Person", {partyId})
        if (person) {
            add("name", [person.firstName, person.middleName, person.lastName].filter(Boolean).join(" "))
            add("name", [person.firstName, person.lastName].filter(Boolean).join(" "))
            add("name", person.firstName)
            add("name", person.lastName)
            add("name", person.nickname)
        }
        add("name", one("mantle.party.Organization", {partyId})?.organizationName)
        for (const row of rows("mantle.party.contact.PartyContactMech", {partyId})) {
            const mech = one("mantle.party.contact.ContactMech", {contactMechId: row.contactMechId})
            if (mech?.infoString) add(mech.contactMechTypeEnumId === "CmtEmailAddress" ? "email" : "contact", mech.infoString)
            const phone = one("mantle.party.contact.TelecomNumber", {contactMechId: row.contactMechId})
            if (phone?.contactNumber) add("phone", [phone.areaCode, phone.contactNumber].filter(Boolean).join(""))
            if (phone?.contactNumber) add("phone", phone.contactNumber)
            const address = one("mantle.party.contact.PostalAddress", {contactMechId: row.contactMechId})
            if (address?.address1) add("address", address.address1)
            if (address?.address2) add("address", address.address2)
            if (address?.postalCode) add("address", address.postalCode)
        }
    }
    const keep = ["mantle.product.Product", "mantle.product.category.ProductCategory", "mantle.party.Party", PAGE]
    for (const link of rows("mantle.request.RequestRecord", {requestId: theCase.requestId}))
        if (link.recordId && !keep.includes(link.recordEntityName)) add("order", link.recordId)
    // the customer's own orders, returns and invoices (the most recent), an id quoted in a message though not linked
    const customerIds = Array.from(
        new Set(theCase.parties.filter(row => row.roleTypeId === "Customer").map(row => row.partyId))
    ).filter(partyId => !isStaff(partyId))
    const recent = (entity, field, idField, orderBy) =>
        customerIds.length
            ? Array.from(
                  find(entity).condition(field, "in", customerIds).selectField(idField).orderBy(orderBy).limit(200).list()
              ).map(row => row[idField])
            : []
    for (const id of recent("mantle.order.OrderPart", "customerPartyId", "orderId", "-orderId")) add("order", id)
    for (const id of recent("mantle.order.return.ReturnHeader", "customerPartyId", "returnId", "-returnId")) add("order", id)
    for (const id of recent("mantle.account.invoice.Invoice", "toPartyId", "invoiceId", "-invoiceId")) add("order", id)
    return terms.sort((a, b) => b.term.length - a.term.length)
}
const placeholders = {
    name: "[customer]",
    email: "[email]",
    contact: "[contact]",
    phone: "[phone]",
    address: "[address]",
    order: "[order]"
}
const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
// The text with the case's personal data replaced, and what was taken out (kind and count).
function redact(value, terms) {
    let out = String(value || "")
    const removed = {}
    const replace = (pattern, kind, test = () => true) => {
        out = out.replace(pattern, found => {
            if (!test(found)) return found
            removed[kind] = (removed[kind] || 0) + 1
            return placeholders[kind]
        })
    }
    // an email address first (a name in it is part of the address)
    replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "email")
    // a term as a whole word (a last name inside another word stays)
    for (const {kind, term} of terms)
        replace(new RegExp((/^\w/.test(term) ? "\\b" : "") + escapeRegExp(term) + (/\w$/.test(term) ? "\\b" : ""), "gi"), kind)
    // a phone number: seven digits or more, not a date
    replace(/\+?\d[\d ().-]{6,}\d/g, "phone", found => found.replace(/\D/g, "").length >= 7 && !/^\d{4}-\d{2}-\d{2}$/.test(found))
    return {text: out, removed: Object.entries(removed).map(([kind, count]) => ({kind, count}))}
}
// The messages of a case and what each is for an article: outward (an email of the service desk to the customer or the
// contact), customer (an email of the customer or the contact), or internal (a note, an email among staff or to anyone else
// such as a supplier): an internal one is never offered or taken.
function caseMessages(theCase) {
    const customerSide = new Set(
        theCase.parties
            .filter(row => ["Customer", "Reporter"].includes(row.roleTypeId) && !isStaff(row.partyId))
            .map(row => row.partyId)
    )
    const ids = rows("mantle.request.RequestCommEvent", {requestId: theCase.requestId}).map(row => row.communicationEventId)
    if (!ids.length) return []
    return Array.from(
        find("mantle.party.communication.CommunicationEvent")
            .condition("communicationEventId", "in", ids)
            .orderBy("entryDate")
            .list()
    ).map(event => ({
        event,
        kind:
            event.communicationEventTypeId !== "Email"
                ? "internal"
                : customerSide.has(event.fromPartyId)
                  ? "customer"
                  : customerSide.has(event.toPartyId) && isStaff(event.fromPartyId)
                    ? "outward"
                    : "internal"
    }))
}
// create#ArticleFromCase: a draft article from a case's answer in a source's draft space of the case's organization: the
// title and the text given (or the chosen outward and customer messages' text), with the case's personal data taken out,
// written as a new page that is not published, and linked to the case (WikiPageRequest). With preview it answers the
// redacted text and what was taken out, and writes nothing. Needs SUPPORT_KNOWLEDGE_EDIT, the case of the user's
// organization, and a draft space the user may add pages to (SPACE_UNAVAILABLE); refuses an internal message
// (INTERNAL_MESSAGE), a missing title (TITLE_REQUIRED) or text (TEXT_REQUIRED), and a page already at the path (PAGE_EXISTS).
function articleFromCase(p) {
    requirePermission("SUPPORT_KNOWLEDGE_EDIT")
    const theCase = caseOf(p.requestId)
    const sources = currentSources([theCase.organizationPartyId]).filter(source => source.draftWikiSpaceId)
    const draftSpaces = Array.from(new Set(sources.map(source => source.draftWikiSpaceId)))
    const wikiSpaceId = text(p.wikiSpaceId) || draftSpaces[0] || null
    const source = sources.find(row => row.draftWikiSpaceId === wikiSpaceId)
    const preview = truthy(p.preview)
    if (!wikiSpaceId || !source) denied("SPACE_UNAVAILABLE", "Choose a draft space of the organization's knowledge sources")
    if (!preview) {
        const spaceRights = spaceAccess(wikiSpaceId)
        if (!spaceRights.canUpdate) denied("SPACE_UNAVAILABLE", "You may not add pages to " + wikiSpaceId)
    }
    const chosen = listOf(p.communicationEventIds)
    const messages = caseMessages(theCase)
    const picked = []
    for (const id of chosen) {
        const message = messages.find(row => row.event.communicationEventId === id)
        if (!message) denied("RECORD_UNAVAILABLE", "Message " + id + " is not on case " + theCase.requestId)
        if (message.kind === "internal") denied("INTERNAL_MESSAGE", "An internal note or message is never put in an article")
        picked.push(message)
    }
    const title = text(p.title) || text(theCase.request.requestName)
    const sourceText =
        text(p.body) ||
        picked
            .map(row => plain(row.event.body))
            .filter(Boolean)
            .join("\n\n")
    if (!sourceText) denied("TEXT_REQUIRED", "Write the article, or choose the answers it is made from")
    const terms = personalTerms(theCase)
    const titleOut = redact(title || "", terms)
    const bodyOut = redact(sourceText, terms)
    const removed = {}
    for (const row of titleOut.removed.concat(bodyOut.removed)) removed[row.kind] = (removed[row.kind] || 0) + row.count
    const removedList = Object.entries(removed).map(([kind, count]) => ({kind, count}))
    // a page name has letters, digits, spaces and . , ' - _ : ( ) ! ? only (update#WikiPage)
    const pageName = titleOut.text
        .replace(/[^\w.\-,':()!? ]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .substring(0, 100)
    if (!pageName) denied("TITLE_REQUIRED", "The article needs a title")
    if (preview) return {pageName, text: bodyOut.text, removedList, wikiSpaceId}
    const parentPath = source.draftParentPath || ""
    const pagePath = (parentPath ? parentPath + "/" : "") + pageName
    if (find(PAGE, {wikiSpaceId, pagePath}).one())
        denied("PAGE_EXISTS", "There is a page " + pagePath + " already; choose another title")
    const space = one(SPACE, {wikiSpaceId})
    const html = /\.html?$/i.test(String(space?.rootPageLocation || ""))
    const escape = value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    const pageText = html
        ? "<h1>" +
          escape(pageName) +
          "</h1>\n" +
          bodyOut.text
              .split(/\n{2,}/)
              .map(part => "<p>" + escape(part).replace(/\n/g, "<br>") + "</p>")
              .join("\n")
        : "# " + pageName + "\n\n" + bodyOut.text + "\n"
    const written = call("org.moqui.impl.WikiServices.update#WikiPage", {
        wikiSpaceId,
        parentPath,
        pageName,
        wikiType: html ? "html" : "md",
        pageText,
        versionNote: "Drafted from a case"
    })
    // a new page has no published version; an article drafted here stays unpublished until Commons' review publishes it
    const page = one(PAGE, {wikiPageId: written.wikiPageId})
    if (page?.publishedVersionName) call("update#" + PAGE, {wikiPageId: page.wikiPageId, publishedVersionName: null})
    if (!one(PAGE_REQUEST, {wikiPageId: written.wikiPageId, requestId: theCase.requestId}))
        call("create#" + PAGE_REQUEST, {wikiPageId: written.wikiPageId, requestId: theCase.requestId})
    return {wikiPageId: written.wikiPageId, wikiSpaceId, pagePath: written.pagePath || pagePath, removedList}
}

const operations = {
    saveSource,
    suggestions,
    publishedArticle,
    publicLink,
    recordFeedback,
    makeTask,
    reviewFeedback,
    reviewFeedbackItem,
    suggestEdit,
    articleFromCase
}
;({
    // for Customer Service's reads: the sources, a page's source, the messages of a case and the personal data found
    currentSources,
    articleSource,
    sourceOfPage,
    caseMessages: requestId => caseMessages(caseOf(requestId)),
    personalTerms: requestId => personalTerms(caseOf(requestId)),
    customerAudiences,
    isStaff,
    // each operation checks its own permission and organization, and reads and writes with artifact authorization off (the
    // wiki's own rules are asked as the user: get#WikiViewScope, get#WikiPageAccess)
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown knowledge operation " + op)
        const wasDisabled = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](parameters)
        } finally {
            if (!wasDisabled) ec.artifactExecution.enableAuthz()
        }
    }
})
