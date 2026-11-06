// The PASS Support app's case and help pages (design-customer-service §8 SupportHome, MyCases, NewCustomerCase, CustomerCase,
// CustomerArticle; impl-customer-service P15, CS-PORTAL, F41, F57–F61, F105, F109): what a customer may read and do of its own
// cases and the organization's published help, as mantle.request.SupportCaseServices' and KnowledgeServices' customer
// services. Every operation first finds the organization the page serves (the support mount's target on a published site with
// a service policy) and checks who asks: a bearer link (ExternalAccess.check: a case's CaseView link, a queue's CaseIntake
// token), or a signed-in account acting for a customer of the organization, as a contact invited for it (ExternalAccessContact;
// a case only their own unless a customer administrator) or as the customer's own party with a verified email (the self
// relationship). Domain matching never grants a customer. The answers are allow-listed projections: a case's customer label of
// its status, its outward messages (no note, internal message, status update or call logged as internal; a staff mail only once
// sent), its files of the customer-shared type, the customer's template values, its customer-visible order and return links,
// its revision and what the page may do; help is the published pages of the Support mount's customer and public knowledge
// sources (an anonymous reader only public ones). Nothing internal is accepted from a page: the queue and type are among the
// mount's offers, the priority, assignee and SLA are the queue's, and the template values are checked for the customer
// audience. Refusals are PASS error kinds (NotFound, AuthenticationRequired, Unprocessable, Conflict, Tarpit), saying nothing
// of a record the asker may not reach. CC0 1.0 Universal plus Grant of Patent License.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const cases = ec.resource.script("component://mr-mantle/service/mantle/request/SupportCases.js")
const templates = () => ec.resource.script("component://mr-mantle/service/mantle/request/CaseTemplates.js")
const access = () => ec.resource.script("component://mr-mantle/service/mantle/party/ExternalAccess.js")
const apps = () => ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
const media = () => ec.resource.script("component://mr-mantle/service/mantle/party/PortalMedia.js")
const knowledge = () => ec.resource.script("component://mr-mantle/service/mantle/request/Knowledge.js")
const time = () => ec.resource.script("component://mr-mantle/service/mantle/work/BusinessTime.js")
const {find, one, rows, call, ms} = lib

const REQUEST = "mantle.request.Request",
    PROFILE = "mantle.request.support.CaseProfile",
    CONTENT = "mantle.request.RequestContent",
    COMM = "mantle.party.communication.CommunicationEvent",
    SETTING = "mantle.request.support.SupportAppSetting",
    PAGE = "moqui.resource.wiki.WikiPage",
    FEEDBACK = "mantle.request.support.ArticleFeedback"
const SHARED = "RqCntCustomerShared"
const openStatuses = ["ReqSubmitted", "ReqReviewed", "ReqInProgress", "ReqWaitingCustomer", "ReqOnHold"]
// the customer's words for a case's status when its workflow's mapping has no customer label
const customerTexts = {
    ReqSubmitted: "Received",
    ReqReviewed: "In review",
    ReqInProgress: "In progress",
    ReqWaitingCustomer: "Waiting for your reply",
    ReqOnHold: "In progress",
    ReqCompleted: "Resolved",
    ReqCancelled: "Cancelled"
}
// message kinds that are never the customer's: a note, an internal message, a status update
const internalTypes = ["Comment", "Message", "StatusUpdate"]
const POST_LIMIT = 30,
    RATE_LIMIT = 30
const dayMs = 86400000

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const now = () => ec.user.nowTimestamp
const nowMs = () => Number(ms(now()))
const L = words => ec.l10n.localize(words)
const dateText = value => (value == null || value === "" ? "" : ec.l10n.format(new Date(Number(ms(value))), "d MMM yyyy HH:mm"))
const dayText = value => (value == null || value === "" ? "" : ec.l10n.format(new Date(Number(ms(value))), "d MMM yyyy"))
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const plain = value =>
    String(value ?? "")
        .replace(/<[^>]*>/g, " ")
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
        .trim()
const fail = (kind, message) => {
    const error = new Error(message)
    error.moquiErrorKind = kind
    throw error
}
const unavailable = () => fail("NotFound", "This page is not available")
// A change at the revision the page showed (design-forum §4.3): required, and a stale one is a Conflict naming the current.
function requireRevision(p, current, noun) {
    if (blank(p.expectedRevision)) fail("Unprocessable", "Reload the page and try again")
    if (String(p.expectedRevision) !== String(current))
        fail(
            "Conflict",
            "This " +
                noun +
                " changed since you opened it (you saw revision " +
                p.expectedRevision +
                "; it is now at revision " +
                current +
                "); look at it again"
        )
}
const signInRequired = () => fail("AuthenticationRequired", "Sign in to continue")
function operationKey(p) {
    const value = String(p.operationId || "")
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(value)) fail("Unprocessable", "Reload the page and try again")
    return value
}
// A refusal of a Mantle rule below the checks, as a page shows it: Mantle's message for the customer's own mistakes, a stale
// revision a Conflict, and a record the asker may not reach not found.
function refused(error) {
    if (error?.moquiErrorKind) throw error
    const first = String(error?.message || "")
        .split("\n")[0]
        .replace(/^(Error: )+/, "")
    const code = error?.reason || /^([A-Z][A-Z0-9_]+): /.exec(first)?.[1]
    if (!code) throw error
    ec.message.clearErrors()
    const message = first.replace(/^[A-Z][A-Z0-9_]+: /, "")
    // a stale revision, and an operation ID used for another request (design-forum §4.3: a different payload conflicts)
    if (["STALE_CASE", "STALE_REVISION", "STALE_ORDER", "OPERATION_KEY_CONFLICT"].includes(code)) fail("Conflict", message)
    if (["RECORD_UNAVAILABLE", "PERMISSION_DENIED", "CUSTOMER_UNAVAILABLE"].includes(code)) unavailable()
    fail("Unprocessable", message)
}
// A post counts against its requester's limit first (the framework's sign-in limits, as a token lookup does).
function throttle(kind, limit = POST_LIMIT) {
    const key = ec.resource.script("component://framework/service/org/moqui/public/Account.js").requesterKey()
    const allowed = ec.service
        .sync()
        .throwOnError(true)
        .name("org.moqui.public.AccountServices.record#Attempt")
        .parameters({input: {key: kind + ":" + key, limit, windowMillis: 600000}})
        .requireNewTransaction(true)
        .call().result.allowed
    if (!allowed) fail("Tarpit", "Too many attempts. Wait a few minutes and try again.")
}
// What a page sends as a map or list: the value, or its JSON text (a form post through a remote frontend).
function jsonOf(value, fallback) {
    if (value == null || value === "") return fallback
    if (typeof value !== "string") return value
    const parsed = lib.json(value, null)
    if (parsed == null || typeof parsed !== "object") fail("Unprocessable", "Reload the page and try again")
    return parsed
}

// ===== the organization, the asker and the mount's offers =====
// The organization the Support app of a published site serves, with Customer Service set up for it.
function served(siteId) {
    const site = siteId && one("mantle.public.PublicSite", {siteId})
    if (!site || site.state !== "published") unavailable()
    const mount = apps().mount(siteId, "support")
    if (!mount?.targetId || !cases.isInternal(mount.targetId) || !cases.policyOf(mount.targetId)) unavailable()
    return mount.targetId
}
// The customers of the organization a signed-in account acts for: its contact grants (with the administrator flag) and its
// own party through the self relationship, each a customer the organization serves. [] for a visitor.
function actingFor(organizationPartyId) {
    if (!ec.user.userId) return []
    return access()
        .actingParties(organizationPartyId, "support", "Customer")
        .filter(row => cases.servedCustomer(row.partyId, organizationPartyId))
        .map(row => Object.assign(row, {name: cases.partyName(row.partyId)}))
}
// Who a request may be for (Shop P6, impl-shop F27; design-customer-service §8 Access): a guest's order link (the SalesOrder
// OrderView capability, orderToken) is the order's customer for that one order only, as a contact or the self relationship
// is for its customers; else the signed-in account's customers (actingFor). {customers, orderId, via}.
function askers(p, organizationPartyId) {
    if (!blank(p.orderToken)) {
        const checked = access().check({
            token: String(p.orderToken),
            scope: "OrderView",
            recordType: "SalesOrder",
            organizationPartyId
        })
        if (!blank(p.orderId) && String(p.orderId) !== checked.recordId) unavailable()
        if (!cases.servedCustomer(checked.partyId, organizationPartyId)) unavailable()
        return {
            customers: [
                {partyId: checked.partyId, administrator: false, via: "orderLink", name: cases.partyName(checked.partyId)}
            ],
            orderId: checked.recordId,
            via: "orderLink"
        }
    }
    if (!ec.user.userId) signInRequired()
    return {customers: actingFor(organizationPartyId), orderId: null, via: "account"}
}
// The queue a store's order's request goes to: its checkout policy's support queue (Commerce P6), when the mount offers it.
function storeQueueOf(orderId, offered) {
    const order = blank(orderId) ? null : one("mantle.order.OrderHeader", {orderId})
    if (!order?.productStoreId) return null
    const queueId = ec.resource
        .script("component://mr-mantle/service/mantle/product/StoreCheckout.js")
        .settingAt(order.productStoreId, "PsstCheckoutSupportQueue")?.settingValue
    return queueId ? offered.find(row => row.requestCategoryId === queueId) || null : null
}
const settingOf = organizationPartyId => cases.currentRow(SETTING, {organizationPartyId})
// The queues the mount offers a signed-in customer: the setting's, else the organization's default queue; each a service queue
// of the organization, with the case types offered there (the setting's among the queue's own).
function offeredQueues(organizationPartyId) {
    const setting = settingOf(organizationPartyId)
    const ids = cases.listOf(setting?.queueIds)
    const queueIds = ids.length ? ids : [cases.policyOf(organizationPartyId)?.defaultCategoryId].filter(Boolean)
    const typeFilter = cases.listOf(setting?.typeEnumIds)
    return queueIds
        .map(requestCategoryId => cases.queueOf(requestCategoryId))
        .filter(queue => queue && queue.organizationPartyId === organizationPartyId)
        .map(queue => {
            const own = cases.listOf(queue.queue.offeredTypeEnumIds)
            const types = (own.length ? own : ["RqtSupport"]).filter(id => !typeFilter.length || typeFilter.includes(id))
            return {requestCategoryId: queue.category.requestCategoryId, queue, types}
        })
        .filter(queue => queue.types.length)
}
// The outside-working-hours notice of a queue (design NewCustomerCase States): when its team's working hours (the queue team's
// schedule calendar, the organization's holidays; P4) have no working time now, when the team next works. Null when the team
// works now or keeps no hours.
function hoursNotice(organizationPartyId, requestCategoryId) {
    const queue = requestCategoryId ? cases.queueOf(requestCategoryId) : null
    const calendarId = time().scheduleCalendarId(queue?.queue.responsibleTeamPartyId)
    if (!calendarId) return null
    const schedule = time().scheduleOf({calendarId, organizationPartyId})
    const at = nowMs()
    const calendar = time().calendarOf(time().forCall(), schedule, at, at + 14 * dayMs)
    if (!calendar.configured || calendar.work.some(([from, thru]) => from <= at && at < thru)) return null
    const next = calendar.work.find(([from]) => from > at)
    const zone = schedule.timeZone || null
    return {
        message: next
            ? L("Our team is away just now. We will reply from") +
              " " +
              time().wallIn(next[0], zone) +
              (zone ? " (" + zone + ")" : "")
            : L("Our team is away just now. We will reply as soon as we are back."),
        nextText: next ? time().wallIn(next[0], zone) : null
    }
}

// ===== a case and what the customer sees of it =====
// The case a page asks for (ExternalAccess.check: a CaseView link, or the signed-in account for its customer: the customer's
// own party, or a contact who filed or reports it, or a customer administrator).
function caseFor(p, organizationPartyId) {
    if (blank(p.requestId) && blank(p.token)) unavailable()
    if (!p.token && !ec.user.userId) signInRequired()
    const checked = access().check({
        token: p.token || null,
        scope: "CaseView",
        recordType: "Request",
        recordId: p.requestId || null,
        organizationPartyId
    })
    const request = one(REQUEST, {requestId: checked.recordId})
    const profile = request ? one(PROFILE, {requestId: checked.recordId}) : null
    if (!profile) unavailable()
    return {checked, request, profile, requestId: request.requestId, customerPartyId: checked.partyId, organizationPartyId}
}
const statusLabel = (profile, statusId) =>
    cases.mappingFor(profile.caseWorkflowId, statusId)?.customerLabel || L(customerTexts[statusId] || "In progress")
// The parties on the customer's side of a case: its customer, and its Customer and Reporter parties that are not staff.
function customerSide(requestId, customerPartyId) {
    const ids = new Set([customerPartyId])
    for (const row of cases.partiesOf(requestId))
        if (["Customer", "Reporter"].includes(row.roleTypeId) && !knowledge().isStaff(row.partyId)) ids.add(row.partyId)
    return ids
}
// A case's outward messages, oldest first: what passed between the organization and the customer's side. A note, an internal
// message or status update, a call logged as internal and a cancelled or bounced message are left out, and a staff mail
// counts once it is sent. A staff sender shows as the organization.
function outwardMessages(theCase) {
    const side = customerSide(theCase.requestId, theCase.customerPartyId)
    const orgName = cases.partyName(theCase.organizationPartyId)
    const out = []
    for (const link of rows("mantle.request.RequestCommEvent", {requestId: theCase.requestId})) {
        const event = one(COMM, {communicationEventId: link.communicationEventId})
        if (!event || internalTypes.includes(event.communicationEventTypeId)) continue
        if (["CeCancelled", "CeBounced", "CeInProgress", "CeReady"].includes(event.statusId)) continue
        if (
            one("mantle.party.communication.CommunicationEventPurpose", {
                communicationEventId: event.communicationEventId,
                purposeEnumId: "CpServiceInternal"
            })
        )
            continue
        const fromCustomer = side.has(event.fromPartyId)
        if (!fromCustomer && !side.has(event.toPartyId)) continue
        if (!fromCustomer && event.emailMessageId) {
            const mail = one("moqui.basic.email.EmailMessage", {emailMessageId: event.emailMessageId})
            if (mail && mail.statusId !== "ES_SENT") continue
        }
        const html = String(event.contentType || "").includes("html")
        out.push({
            messageId: event.communicationEventId,
            fromText: fromCustomer ? cases.partyName(event.fromPartyId) : orgName,
            fromCustomer,
            dateText: dateText(event.entryDate || event.datetimeStarted),
            atMs: Number(ms(event.entryDate || event.datetimeStarted) || 0),
            subject: event.subject || "",
            body: html ? plain(StringUtilities.cleanHtml(event.body || "")) : String(event.body || "")
        })
    }
    return out.sort((a, b) => a.atMs - b.atMs).map(row => (delete row.atMs, row))
}
const sharedFiles = requestId =>
    rows(CONTENT, {requestId})
        .filter(row => row.contentTypeEnumId === SHARED && row.contentLocation)
        .sort((a, b) => Number(ms(a.contentDate) || 0) - Number(ms(b.contentDate) || 0))
        .map(row => ({
            fileId: row.requestContentId,
            filename: String(row.contentLocation).split("/").pop(),
            description: row.description || "",
            dateText: dateText(row.contentDate)
        }))
// The case's template values the customer may read: its customer-visible fields as of the response (P7's contact path).
function customerValues(profile) {
    if (!profile.formResponseId) return []
    const response = call("org.moqui.impl.ScreenServices.get#FormResponse", {formResponseId: profile.formResponseId})
    const fields = templates().formAt(response.formId, response.responseDate, false)
    const answers = response.responseMap || {}
    return templates()
        .customerProjection(fields)
        .filter(field => Object.prototype.hasOwnProperty.call(answers, field.fieldName) && !blank(answers[field.fieldName]))
        .map(field => {
            const raw = answers[field.fieldName]
            const parts = Array.isArray(raw) ? raw.map(String) : String(raw).split(",")
            const shown = field.options?.length
                ? parts.map(part => field.options.find(o => o.key === part)?.text || part).join(", ")
                : String(raw)
            return {title: field.title, valueText: shown}
        })
}
// The case's links the customer may follow: its customer's own sales orders and returns with the organization.
function customerLinks(theCase) {
    const out = []
    for (const link of rows("mantle.request.RequestRecord", {requestId: theCase.requestId})) {
        if (link.recordEntityName === "mantle.order.OrderHeader") {
            const parts = rows("mantle.order.OrderPart", {orderId: link.recordId})
            if (
                parts.length &&
                parts.every(
                    part => part.customerPartyId === theCase.customerPartyId && part.vendorPartyId === theCase.organizationPartyId
                )
            )
                out.push({kind: "order", orderId: link.recordId, text: L("Order") + " " + link.recordId})
        } else if (link.recordEntityName === "mantle.order.return.ReturnHeader") {
            const header = one("mantle.order.return.ReturnHeader", {returnId: link.recordId})
            if (
                header &&
                header.customerPartyId === theCase.customerPartyId &&
                header.vendorPartyId === theCase.organizationPartyId &&
                header.statusId !== "ReturnCreated"
            )
                out.push({kind: "return", returnId: link.recordId, text: L("Return") + " " + (header.displayId || link.recordId)})
        }
    }
    return out
}
function caseCapabilities(theCase) {
    const status = theCase.request.statusId
    const open = openStatuses.includes(status)
    const policy = cases.policyOf(theCase.organizationPartyId)
    const resolvedMs = Number(ms(theCase.request.lastUpdatedStamp) || 0)
    const windowDays = policy?.reopenWindowDays ?? 14
    const reopen = status === "ReqCompleted" && !theCase.profile.closedDate && nowMs() - resolvedMs <= windowDays * dayMs
    return {
        canReply: status !== "ReqCancelled",
        canAddFile: open,
        canReopen: reopen,
        canCancel: open && !!cases.transitionFor(theCase.profile.caseWorkflowId, status, "ReqCancelled"),
        followUpOnReply: status === "ReqCompleted" && !reopen
    }
}
function caseView(theCase) {
    const request = theCase.request
    return {
        requestId: theCase.requestId,
        title: request.requestName || theCase.requestId,
        description: request.description || "",
        statusText: statusLabel(theCase.profile, request.statusId),
        open: openStatuses.includes(request.statusId),
        waitingForCustomer: request.statusId === "ReqWaitingCustomer",
        customerName: cases.partyName(theCase.customerPartyId),
        organizationName: cases.partyName(theCase.organizationPartyId),
        createdText: dateText(request.requestDate),
        updatedText: dateText(request.lastUpdatedStamp),
        revision: cases.revisionOf(theCase.requestId)
    }
}

// ===== SupportHome and help =====
// The sources the help reads for an asker: the mount's spaces' customer and public sources, an anonymous reader (or anyone
// acting for no customer) only the public ones.
function helpSources(organizationPartyId, customer) {
    const spaces = cases.listOf(settingOf(organizationPartyId)?.wikiSpaceIds)
    const audiences = customer ? knowledge().customerAudiences : ["SkaPublic"]
    return knowledge()
        .currentSources([organizationPartyId])
        .filter(source => audiences.includes(source.audienceEnumId) && (!spaces.length || spaces.includes(source.wikiSpaceId)))
}
function articleRow(page) {
    return {wikiPageId: page.wikiPageId, title: String(page.pagePath).split("/").pop(), pagePath: page.pagePath}
}
// The published help a query finds (KnowledgeServices' customer-visible suggestions, F59), or with no query the sources' first
// published pages; only pages of the asker's sources.
function helpArticles(organizationPartyId, customer, query, limit = 10) {
    const sources = helpSources(organizationPartyId, customer)
    if (!sources.length) return []
    const ids = new Set(sources.map(source => source.serviceKnowledgeSourceId))
    if (!blank(query)) {
        const found = knowledge().execute("suggestions", {
            organizationPartyId,
            text: String(query).slice(0, 200),
            customerVisible: true,
            limit: 50
        })
        return Array.from(found.articleList || [])
            .filter(row => ids.has(row.serviceKnowledgeSourceId) && row.published)
            .slice(0, limit)
            .map(row => ({wikiPageId: row.wikiPageId, title: row.title, pagePath: row.pagePath}))
    }
    const out = []
    for (const spaceId of Array.from(new Set(sources.map(source => source.wikiSpaceId)))) {
        const space = one("moqui.resource.wiki.WikiSpace", {wikiSpaceId: spaceId})
        if (!space || space.restrictView === "Y") continue
        const spaceSources = knowledge().currentSources([organizationPartyId], {wikiSpaceId: spaceId})
        for (const page of find(PAGE, {wikiSpaceId: spaceId}).orderBy("pagePath").limit(200).list()) {
            if (out.length >= limit) return out
            if (!page.publishedVersionName || page.restrictView === "Y" || !page.pagePath) continue
            const source = knowledge().sourceOfPage(spaceSources, page)
            if (source && ids.has(source.serviceKnowledgeSourceId)) out.push(articleRow(page))
        }
    }
    return out
}
function getSupportHome(p) {
    const organizationPartyId = served(p.siteId)
    const customers = actingFor(organizationPartyId)
    const queues = customers.length ? offeredQueues(organizationPartyId) : []
    return {
        organizationName: cases.partyName(organizationPartyId),
        signedIn: !!ec.user.userId,
        customers: customers.map(row => ({partyId: row.partyId, name: row.name})),
        query: text(p.query) || "",
        articleList: helpArticles(organizationPartyId, customers.length > 0, p.query),
        hoursNotice: queues.length ? hoursNotice(organizationPartyId, queues[0].requestCategoryId) : null,
        capabilities: {canSeeCases: customers.length > 0, canCreateCase: queues.length > 0, canSeeReturns: customers.length > 0}
    }
}
// A published article of the mount's help (F59: the exact published version, cleaned), for an anonymous reader only a public
// source's; with a nonce for this view's rating.
function articleFor(organizationPartyId, wikiPageId) {
    if (blank(wikiPageId)) unavailable()
    let article
    try {
        article = knowledge().execute("publishedArticle", {wikiPageId, organizationPartyId, customerVisible: true}).article
    } catch (error) {
        ec.message.clearErrors()
        unavailable()
    }
    const customer = actingFor(organizationPartyId).length > 0
    const page = one(PAGE, {wikiPageId: article.wikiPageId})
    const source = knowledge().articleSource(page, [organizationPartyId])
    if (
        !source ||
        !helpSources(organizationPartyId, customer).some(row => row.serviceKnowledgeSourceId === source.serviceKnowledgeSourceId)
    )
        unavailable()
    return {article, source, customer}
}
function getCustomerArticle(p) {
    const organizationPartyId = served(p.siteId)
    const {article, customer} = articleFor(organizationPartyId, p.wikiPageId)
    const url = p.siteId
        ? apps().pageUrl(p.siteId, "support", "/CustomerArticle?wikiPageId=" + encodeURIComponent(article.wikiPageId))
        : null
    return {
        article: {
            wikiPageId: article.wikiPageId,
            title: article.title,
            versionName: article.versionName,
            body: article.body,
            url
        },
        organizationName: cases.partyName(organizationPartyId),
        nonce: ec.user.randomString(32),
        capabilities: {canRate: true, canCreateCase: customer && offeredQueues(organizationPartyId).length > 0}
    }
}
// rate#Article: helpful or not with an optional comment, once per page view (the view's nonce; a repeat answers the first),
// limited per requester; an AfsCustomer ArticleFeedback for the source's organization, which P12's review reads.
function rateArticle(p) {
    throttle("article-rating", RATE_LIMIT)
    const organizationPartyId = served(p.siteId)
    const nonce = String(p.token || "")
    if (!/^[A-Za-z0-9_-]{24,64}$/.test(nonce)) fail("Unprocessable", "Reload the page and try again")
    const {article, source} = articleFor(organizationPartyId, p.wikiPageId)
    const nonceDigest = ec.user.singleUseCodeHash(nonce + ":" + article.wikiPageId)
    const earlier = one(FEEDBACK, {nonceDigest})
    if (earlier)
        return {receipt: {helpful: earlier.helpful === "Y", message: L("Thank you for your answer.")}, alreadyApplied: true}
    const helpful =
        p.helpful === true || p.helpful === "Y" || p.helpful === "true"
            ? "Y"
            : p.helpful === false || p.helpful === "N" || p.helpful === "false"
              ? "N"
              : null
    if (!helpful) fail("Unprocessable", "Say whether the article helped")
    call("create#" + FEEDBACK, {
        wikiPageId: article.wikiPageId,
        versionName: article.versionName,
        helpful,
        comment: text(plain(p.comment))?.substring(0, 2000) || null,
        organizationPartyId: source.organizationPartyId,
        serviceKnowledgeSourceId: source.serviceKnowledgeSourceId,
        sourceEnumId: "AfsCustomer",
        submittedByUserId: ec.user.userId || null,
        submittedByPartyId: ec.user.userAccount?.partyId || null,
        submittedDate: now(),
        statusId: "AfbSubmitted",
        nonceDigest
    })
    return {receipt: {helpful: helpful === "Y", message: L("Thank you for your answer.")}, alreadyApplied: false}
}

// ===== list pages (design-forum §4.3) =====
// A list's page: 30 rows by default, at most 100, newest first by a time with the record's ID as the tie-breaker, after an
// opaque cursor scoped to the list, its filters, the site and the account (a cursor of another list, account or filter, or one
// altered, is refused). The cursor holds the last row's time and ID, signed with the scope.
const PAGE_ROWS = 30,
    PAGE_MAX = 100
const hexOf = value =>
    Array.from(String(value))
        .map(c => c.charCodeAt(0).toString(16).padStart(2, "0"))
        .join("")
const unhex = value => (String(value).match(/../g) || []).map(pair => String.fromCharCode(parseInt(pair, 16))).join("")
const signOf = (scopeKey, payload) =>
    String(lib.hash([scopeKey, payload]))
        .replace(/[^A-Za-z0-9]/g, "")
        .slice(0, 24)
function listPage(p, scope) {
    const limit = blank(p.limit) ? PAGE_ROWS : Number(p.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) fail("Unprocessable", "Ask for 1 to 100 rows")
    const scopeKey = lib.hash({scope, siteId: p.siteId || null, userId: ec.user.userId || null})
    let after = null
    if (!blank(p.cursor)) {
        const parts = /^([0-9a-f]{2,200})\.([A-Za-z0-9]{8,24})$/.exec(String(p.cursor))
        const payload = parts ? unhex(parts[1]) : ""
        const fields = /^([0-9a-z]{1,12})~(.{1,60})$/.exec(payload)
        if (!parts || !fields || signOf(scopeKey, payload) !== parts[2])
            fail("Unprocessable", "This list changed since; open it again")
        after = {at: parseInt(fields[1], 36), id: fields[2]}
    }
    return {
        limit,
        // whether a row comes after the cursor in the list's order (its time descending, then its ID descending)
        isAfter: (at, id) => !after || at < after.at || (at === after.at && String(id) < after.id),
        cursorAt: (at, id) => {
            const payload = Math.max(0, Math.floor(at)).toString(36) + "~" + id
            return hexOf(payload) + "." + signOf(scopeKey, payload)
        }
    }
}

// ===== MyCases =====
// findCustomerCases: a page of the cases the account reaches for its customers (a contact's own, every case of the customer for
// a customer administrator or the customer's own account), the latest change first, with the cursor of the next page.
function findCustomerCases(p) {
    const organizationPartyId = served(p.siteId)
    if (!ec.user.userId) signInRequired()
    const customers = actingFor(organizationPartyId)
    const chosen = blank(p.customerPartyId) ? customers : customers.filter(row => row.partyId === p.customerPartyId)
    const query = text(p.query)?.toLowerCase() || null
    const state = ["open", "resolved", "all"].includes(p.statusCategory) ? p.statusCategory : "all"
    const pg = listPage(p, ["cases", query, state, blank(p.customerPartyId) ? null : String(p.customerPartyId)])
    const userPartyId = ec.user.userAccount?.partyId
    // each case of the chosen customers, with the customer it is listed for
    const customerOf = new Map()
    for (const customer of chosen)
        for (const link of rows("mantle.request.RequestParty", {partyId: customer.partyId, roleTypeId: "Customer"}))
            if (!customerOf.has(link.requestId) && lib.active(link)) customerOf.set(link.requestId, customer)
    const caseList = []
    let nextCursor = null
    if (customerOf.size) {
        const requests = Array.from(
            find(REQUEST)
                .condition("requestId", "in", Array.from(customerOf.keys()))
                .orderBy("-lastUpdatedStamp,-requestId")
                .list()
        )
        for (const request of requests) {
            const updatedMs = Number(ms(request.lastUpdatedStamp) || 0)
            if (!pg.isAfter(updatedMs, request.requestId)) continue
            const profile = one(PROFILE, {requestId: request.requestId})
            if (!profile) continue
            const parties = cases.partiesOf(request.requestId)
            if (cases.roleParty(parties, "OrgInternal") !== organizationPartyId) continue
            const customer = customerOf.get(request.requestId)
            // a contact sees a colleague's case only as a customer administrator (the self account is the customer)
            const own =
                customer.administrator ||
                request.filedByPartyId === userPartyId ||
                parties.some(row => row.partyId === userPartyId && ["Reporter", "Customer"].includes(row.roleTypeId))
            if (!own) continue
            if (state === "open" && !openStatuses.includes(request.statusId)) continue
            if (state === "resolved" && openStatuses.includes(request.statusId)) continue
            if (
                query &&
                !String(request.requestName || "")
                    .toLowerCase()
                    .includes(query) &&
                !String(request.requestId).toLowerCase().includes(query)
            )
                continue
            if (caseList.length === pg.limit) {
                const last = caseList[caseList.length - 1]
                nextCursor = pg.cursorAt(last.updatedMs, last.requestId)
                break
            }
            caseList.push({
                requestId: request.requestId,
                title: request.requestName || request.requestId,
                statusText: statusLabel(profile, request.statusId),
                open: openStatuses.includes(request.statusId),
                needsReply: request.statusId === "ReqWaitingCustomer",
                customerName: customer.name,
                createdText: dayText(request.requestDate),
                updatedText: dayText(request.lastUpdatedStamp),
                updatedMs
            })
        }
    }
    return {
        caseList: caseList.map(row => (delete row.updatedMs, row)),
        nextCursor,
        customers: customers.map(row => ({partyId: row.partyId, name: row.name})),
        capabilities: {canCreateCase: customers.length > 0 && offeredQueues(organizationPartyId).length > 0}
    }
}

// ===== NewCustomerCase =====
const fieldKinds = {
    DBFFT_radio: "radio",
    "DBFFT_drop-down": "select",
    DBFFT_check: "checks",
    "DBFFT_text-line": "text",
    "DBFFT_text-area": "textarea",
    "DBFFT_date-time": "date"
}
const ruleOf = rule => (rule ? {field: rule.field, operator: rule.operator, values: cases.listOf(rule.value)} : null)
// A queue's template for a type, as the customer fills it: its customer-visible fields with their show and require rules.
function templateFields(organizationPartyId, requestCategoryId, requestTypeEnumId) {
    let formId = null
    try {
        formId = templates().forCase(organizationPartyId, requestCategoryId, null, requestTypeEnumId)
    } catch (error) {
        ec.message.clearErrors()
        return {formId: null, fields: []}
    }
    if (!formId) return {formId: null, fields: []}
    return {
        formId,
        fields: templates()
            .customerProjection(templates().formAt(formId, null, false))
            .filter(field => fieldKinds[field.fieldTypeEnumId])
            .map(field => ({
                fieldName: field.fieldName,
                kind: fieldKinds[field.fieldTypeEnumId],
                title: field.title,
                tooltip: field.tooltip || "",
                required: !!field.required,
                options: (field.options || []).map(option => ({key: option.key, text: option.text})),
                show: ruleOf(field.show),
                require: ruleOf(field.require)
            }))
    }
}
function queueView(organizationPartyId, offered) {
    return {
        requestCategoryId: offered.requestCategoryId,
        name: offered.queue.category.description || offered.requestCategoryId,
        types: offered.types.map(typeId => ({
            requestTypeEnumId: typeId,
            text: enumText(typeId),
            fields: templateFields(organizationPartyId, offered.requestCategoryId, typeId).fields
        })),
        hoursNotice: hoursNotice(organizationPartyId, offered.requestCategoryId)
    }
}
// What NewCustomerCase offers: through a queue's form token, that queue's types (the sender gives name and email); signed in,
// the customers the account acts for and the mount's queues with their types and the template fields; the selected order's
// cancel (CustomerOrders.js) and the published help a subject finds.
function getCaseIntake(p) {
    const organizationPartyId = served(p.siteId)
    const suggestions = blank(p.query) ? [] : null
    if (!blank(p.token)) {
        const target = ec.resource.script("component://mr-mantle/service/mantle/request/Channels.js").formTarget(p.token)
        if (!target || target.organizationPartyId !== organizationPartyId) unavailable()
        return {
            mode: "token",
            organizationName: cases.partyName(organizationPartyId),
            queues: [
                {
                    requestCategoryId: target.requestCategoryId,
                    name: one("mantle.request.RequestCategory", {requestCategoryId: target.requestCategoryId})?.description || "",
                    types: target.settings.offeredTypes.map(typeId => ({
                        requestTypeEnumId: typeId,
                        text: enumText(typeId),
                        fields: []
                    })),
                    hoursNotice: hoursNotice(organizationPartyId, target.requestCategoryId)
                }
            ],
            customers: [],
            articleList: suggestions || helpArticles(organizationPartyId, false, p.query, 5),
            capabilities: {canSubmit: true, takesFiles: true, needsSender: true}
        }
    }
    const asked = askers(p, organizationPartyId)
    const customers = asked.customers
    if (!customers.length) unavailable()
    const queues = offeredQueues(organizationPartyId)
    const orderId = asked.orderId || p.orderId
    let order = null
    if (!blank(orderId))
        order = ec.resource
            .script("component://mr-mantle/service/mantle/order/CustomerOrders.js")
            .cancelView(Object.assign({}, p, {orderId}), organizationPartyId, customers)
    // a store's order's request goes to the store's queue first (Shop P6)
    const storeQueue = storeQueueOf(orderId, queues)
    if (storeQueue) queues.sort((a, b) => (a === storeQueue ? -1 : b === storeQueue ? 1 : 0))
    let article = null
    if (!blank(p.wikiPageId))
        try {
            article = {wikiPageId: p.wikiPageId, title: articleFor(organizationPartyId, p.wikiPageId).article.title}
        } catch (error) {
            article = null
        }
    return {
        mode: asked.via === "orderLink" ? "orderLink" : "contact",
        organizationName: cases.partyName(organizationPartyId),
        customers: customers.map(row => ({partyId: row.partyId, name: row.name})),
        queues: queues.map(offered => queueView(organizationPartyId, offered)),
        order,
        article,
        articleList: suggestions || helpArticles(organizationPartyId, true, p.query, 5),
        capabilities: {canSubmit: queues.length > 0, takesFiles: true, needsSender: false}
    }
}
// A staged file kept as a case's file of the customer-shared type.
function keepCaseFile(requestId, staged, description) {
    if (!staged) return null
    const content = call("create#" + CONTENT, {
        requestId,
        contentTypeEnumId: SHARED,
        description: description || staged.filename,
        contentDate: now()
    })
    const location =
        media().contentRoot() + "/request/" + requestId + "/content_" + content.requestContentId + "/" + staged.filename
    media().keep(staged, location)
    call("update#" + CONTENT, {requestContentId: content.requestContentId, contentLocation: location})
    media().unstage(staged)
    return content.requestContentId
}
// create#CustomerCase: a signed-in customer's case in one of the mount's queues and types (the queue's priority, assignment
// and service level; P7's template values for the customer audience; the selected order and the article read linked), or
// through a queue's form token create#IntakeRequest's public form (its limits; a sender the organization does not serve is held
// for review, and the answer reads no case). The same operation answers the first result.
function createCustomerCase(p) {
    throttle("support-case")
    const organizationPartyId = served(p.siteId)
    const key = operationKey(p)
    const name = text(p.requestName)
    const description = text(p.description)
    if (!name || name.length > 255) fail("Unprocessable", "Give your request a subject")
    if (!description) fail("Unprocessable", "Tell us what you need")
    const staged = media().stageGiven(p.file, "file", "support")
    try {
        if (!blank(p.token)) return intakeCase(p, organizationPartyId, key, staged)
        return contactCase(p, organizationPartyId, key, staged)
    } catch (error) {
        media().unstage(staged)
        throw error
    }
}
function intakeCase(p, organizationPartyId, key, staged) {
    const target = ec.resource.script("component://mr-mantle/service/mantle/request/Channels.js").formTarget(p.token)
    if (!target || target.organizationPartyId !== organizationPartyId) unavailable()
    const operation = lib.operation({operationKey: key}, "SupportCaseIntake", organizationPartyId, {
        token: ec.user.singleUseCodeHash(String(p.token)),
        name: p.requestName,
        email: p.emailAddress
    })
    if (operation.old) return lib.previous(operation)
    const out = ec.service
        .sync()
        .name("mantle.request.RequestServices.create#IntakeRequest")
        .parameters({
            token: p.token,
            firstName: p.firstName,
            lastName: p.lastName,
            emailAddress: p.emailAddress,
            requestTypeEnumId: p.requestTypeEnumId || null,
            requestName: p.requestName,
            description: p.description,
            website: p.website || null
        })
        .call()
    if (ec.message.hasError()) {
        const message = ec.message.getErrorsString().split("\n")[0]
        ec.message.clearErrors()
        fail("Unprocessable", message || "Your request could not be sent")
    }
    if (out?.requestId && staged) keepCaseFile(out.requestId, staged, null)
    else media().unstage(staged)
    // the sender is not verified: the answer reads no case
    const result = {
        receipt: {received: true, message: L("Thank you. We have your request and will answer you by email.")},
        alreadyApplied: false
    }
    lib.complete(operation, REQUEST, out?.requestId || "_NA_", result)
    return result
}
function contactCase(p, organizationPartyId, key, staged) {
    const asked = askers(p, organizationPartyId)
    const customers = asked.customers
    // an order link's case is about its one order (Shop P6)
    if (asked.orderId) p = Object.assign({}, p, {orderId: asked.orderId})
    const customer = blank(p.customerPartyId)
        ? customers.length === 1
            ? customers[0]
            : null
        : customers.find(row => row.partyId === p.customerPartyId)
    if (!customer) fail("Unprocessable", customers.length ? "Choose who the request is for" : "This page is not available")
    const offered = offeredQueues(organizationPartyId)
    const queue = blank(p.requestCategoryId)
        ? storeQueueOf(p.orderId, offered) || offered[0]
        : offered.find(row => row.requestCategoryId === p.requestCategoryId)
    if (!queue) fail("Unprocessable", "Choose what your request is about")
    const requestTypeEnumId = blank(p.requestTypeEnumId) ? queue.types[0] : p.requestTypeEnumId
    if (!queue.types.includes(requestTypeEnumId)) fail("Unprocessable", "Choose what your request is about")
    const values = jsonOf(p.templateValues, {})
    const operation = lib.operation({operationKey: key}, "SupportCaseCreate", organizationPartyId, {
        customer: customer.partyId,
        queue: queue.requestCategoryId,
        type: requestTypeEnumId,
        name: p.requestName,
        description: p.description,
        values,
        orderId: p.orderId || null
    })
    if (operation.old) return lib.previous(operation)
    // the template values for the customer audience (P7): an internal field or one the rules hide is refused or dropped
    const template = templateFields(organizationPartyId, queue.requestCategoryId, requestTypeEnumId)
    let checkedValues = null
    if (template.formId) {
        const checked = templates().checkValues(template.formId, values, "customer")
        if (!checked.valid) fail("Unprocessable", checked.errors.map(error => error.message).join("; "))
        checkedValues = checked.values
    }
    // the order a case is about: a sales order of this customer with the organization; its store goes on the case (impl-commerce
    // F37, Shop P6)
    let orderId = null
    let productStoreId = null
    if (!blank(p.orderId)) {
        const parts = rows("mantle.order.OrderPart", {orderId: p.orderId})
        if (
            !parts.length ||
            !parts.every(part => part.customerPartyId === customer.partyId && part.vendorPartyId === organizationPartyId)
        )
            fail("Unprocessable", "Choose one of your orders")
        orderId = String(p.orderId)
        productStoreId = one("mantle.order.OrderHeader", {orderId})?.productStoreId || null
    }
    // the article read before asking (F109): kept in the description and linked to the case
    let cited = null
    if (!blank(p.wikiPageId))
        try {
            cited = articleFor(organizationPartyId, p.wikiPageId).article
        } catch (error) {
            cited = null
        }
    const type = cases.typeOf(organizationPartyId, requestTypeEnumId)
    const userPartyId = ec.user.userAccount?.partyId || null
    const requestId = call("mantle.request.RequestServices.create#Request", {
        requestName: text(p.requestName).substring(0, 255),
        description: (
            text(p.description).substring(0, 20000) + (cited ? "\n\n" + L("Read before asking:") + " " + cited.title : "")
        ).trim(),
        requestTypeEnumId,
        requestCategoryId: queue.requestCategoryId,
        priority: type?.defaultPriority ?? 5,
        statusId: "ReqSubmitted",
        salesChannelEnumId: "ScWeb",
        customerPartyId: customer.partyId,
        productStoreId,
        filedByPartyId: asked.via === "orderLink" ? null : userPartyId
    }).requestId
    call("create#mantle.request.RequestParty", {
        requestId,
        partyId: organizationPartyId,
        roleTypeId: "OrgInternal",
        fromDate: now()
    })
    if (orderId)
        call("create#mantle.request.RequestRecord", {
            requestId,
            recordEntityName: "mantle.order.OrderHeader",
            recordId: orderId,
            linkedByUserId: ec.user.userId,
            linkedDate: now()
        })
    if (cited) call("create#mantle.request.WikiPageRequest", {wikiPageId: cited.wikiPageId, requestId})
    const made = cases.ensureCase({requestId})
    if (!made.isCase) fail("Unprocessable", "Your request could not be filed; contact us another way")
    if (template.formId) templates().record(requestId, template.formId, checkedValues)
    keepCaseFile(requestId, staged, null)
    const result = {
        requestId,
        receipt: {received: true, message: L("Thank you. Your request is filed; we will answer you here and by email.")},
        alreadyApplied: false
    }
    lib.complete(operation, REQUEST, requestId, result)
    return result
}

// ===== CustomerCase =====
function getCustomerCase(p) {
    const organizationPartyId = served(p.siteId)
    const theCase = caseFor(p, organizationPartyId)
    return {
        case: caseView(theCase),
        messageList: outwardMessages(theCase),
        fileList: sharedFiles(theCase.requestId),
        valueList: customerValues(theCase.profile),
        linkList: customerLinks(theCase),
        hoursNotice: openStatuses.includes(theCase.request.statusId)
            ? hoursNotice(organizationPartyId, theCase.request.requestCategoryId)
            : null,
        capabilities: caseCapabilities(theCase),
        via: theCase.checked.via
    }
}
// A customer's message on the case (a web message from the customer's side to the organization, filed on the case so the
// case rules record it: the assignee's notice, the clocks, a reopen within the window or a follow-up case, P4, P8).
function postMessage(theCase, body, subject) {
    const fromPartyId =
        theCase.checked.via === "token" ? theCase.customerPartyId : ec.user.userAccount?.partyId || theCase.customerPartyId
    const communicationEventId = call("create#" + COMM, {
        communicationEventTypeId: "WebSite",
        statusId: "CeReceived",
        fromPartyId,
        toPartyId: theCase.organizationPartyId,
        subject: subject.substring(0, 255),
        body,
        contentType: "text/plain",
        entryDate: now(),
        datetimeStarted: now()
    }).communicationEventId
    call("create#mantle.request.RequestCommEvent", {requestId: theCase.requestId, communicationEventId})
    return communicationEventId
}
function replyCustomerCase(p) {
    throttle("support-reply")
    const organizationPartyId = served(p.siteId)
    const theCase = caseFor(p, organizationPartyId)
    const key = operationKey(p)
    const body = text(plain(p.body))
    if (!body) fail("Unprocessable", "Write your message")
    if (body.length > 20000) fail("Unprocessable", "Your message is too long")
    const operation = lib.operation({operationKey: key}, "SupportCaseReply", organizationPartyId, {
        requestId: theCase.requestId,
        body
    })
    if (operation.old) return lib.previous(operation)
    if (theCase.request.statusId === "ReqCancelled") fail("Unprocessable", "This request was cancelled; open a new one")
    const capabilities = caseCapabilities(theCase)
    const staged = capabilities.canAddFile ? media().stageGiven(p.file, "file", "support") : null
    if (!capabilities.canAddFile && p.file && Number(p.file.size) > 0)
        fail("Unprocessable", "Files can be added while the request is open")
    try {
        const messageId = postMessage(theCase, body, "Re: " + (theCase.request.requestName || theCase.requestId))
        keepCaseFile(theCase.requestId, staged, null)
        const result = {
            messageId,
            receipt: {
                message: capabilities.followUpOnReply
                    ? L("Thank you. This request was closed, so we opened a new one for your message.")
                    : L("Thank you. Your message is sent.")
            },
            alreadyApplied: false
        }
        lib.complete(operation, REQUEST, theCase.requestId, result)
        return result
    } catch (error) {
        media().unstage(staged)
        throw error
    }
}
// request#CaseReopen: a resolved case's customer asks to reopen it with a reason; the message reopens it within the reopen
// window (P8's reply rule), else the page says to open a new request.
function requestCaseReopen(p) {
    throttle("support-reply")
    const organizationPartyId = served(p.siteId)
    const theCase = caseFor(p, organizationPartyId)
    const key = operationKey(p)
    const reason = text(plain(p.reason))
    if (!reason) fail("Unprocessable", "Tell us why the request is not resolved")
    const operation = lib.operation({operationKey: key}, "SupportCaseReopen", organizationPartyId, {
        requestId: theCase.requestId,
        reason
    })
    if (operation.old) return lib.previous(operation)
    if (!caseCapabilities(theCase).canReopen)
        fail("Unprocessable", "This request can no longer be reopened; open a new one and mention this one")
    postMessage(
        theCase,
        L("Please reopen this request:") + " " + reason,
        "Reopen: " + (theCase.request.requestName || theCase.requestId)
    )
    const after = one(REQUEST, {requestId: theCase.requestId})
    const result = {
        statusText: statusLabel(theCase.profile, after.statusId),
        receipt: {message: L("Thank you. We have your request to reopen it.")},
        alreadyApplied: false
    }
    lib.complete(operation, REQUEST, theCase.requestId, result)
    return result
}
// cancel#CustomerCase: the customer withdraws an open case by its workflow's move to Cancelled, resolved as withdrawn, at the
// revision the page showed (a later change is a Conflict); the reason goes on the case as the customer's message.
function cancelCustomerCase(p) {
    throttle("support-reply")
    const organizationPartyId = served(p.siteId)
    const theCase = caseFor(p, organizationPartyId)
    const locked = find(REQUEST, {requestId: theCase.requestId}).forUpdate(true).one()
    theCase.request = locked
    if (locked.statusId === "ReqCancelled")
        return {statusText: statusLabel(theCase.profile, locked.statusId), alreadyApplied: true}
    requireRevision(p, cases.revisionOf(theCase.requestId), "request")
    if (!caseCapabilities(theCase).canCancel) fail("Unprocessable", "This request can no longer be cancelled here")
    const reason = text(plain(p.reason))
    if (reason)
        postMessage(
            theCase,
            L("Cancelled by the customer:") + " " + reason,
            "Cancelled: " + (locked.requestName || theCase.requestId)
        )
    call("update#" + REQUEST, {requestId: theCase.requestId, statusId: "ReqCancelled", requestResolutionEnumId: "RrWithdrawn"})
    return {statusText: statusLabel(theCase.profile, "ReqCancelled"), alreadyApplied: false}
}
// A case's shared file, for the page's download (the transport streams it from its location).
function getCaseFile(p) {
    const organizationPartyId = served(p.siteId)
    const theCase = caseFor(p, organizationPartyId)
    const row = blank(p.fileId) ? null : one(CONTENT, {requestContentId: p.fileId})
    if (!row || row.requestId !== theCase.requestId || row.contentTypeEnumId !== SHARED || !row.contentLocation) unavailable()
    const filename = String(row.contentLocation).split("/").pop()
    return {file: {mimeType: media().typeOf(filename), filename}, location: row.contentLocation}
}

// ===== the Support mount's settings (BOSS ServiceDefaults) =====
// save#SupportAppSetting: the mount's queues (service queues of the organization), case types and knowledge spaces, from a
// date (dated by SupportCases.js startRow). SUPPORT_POLICY_EDIT and the organization.
function saveSetting(p) {
    cases.requirePermission("SUPPORT_POLICY_EDIT")
    const organizationPartyId = cases.requireOrganization(p.organizationPartyId)
    const queueIds = cases.listOf(p.queueIds)
    for (const requestCategoryId of queueIds) {
        const queue = cases.queueOf(requestCategoryId)
        if (!queue || queue.organizationPartyId !== organizationPartyId)
            lib.denied("QUEUE_UNAVAILABLE", "Queue " + requestCategoryId + " is not a service queue of the organization")
    }
    const typeEnumIds = cases.listOf(p.typeEnumIds)
    for (const enumId of typeEnumIds)
        if (one("moqui.basic.Enumeration", {enumId})?.enumTypeId !== "RequestType")
            lib.denied("TYPE_INVALID", enumId + " is not a request type")
    const wikiSpaceIds = cases.listOf(p.wikiSpaceIds)
    for (const wikiSpaceId of wikiSpaceIds)
        if (!one("moqui.resource.wiki.WikiSpace", {wikiSpaceId}))
            lib.denied("SPACE_UNAVAILABLE", "Space " + wikiSpaceId + " does not exist")
    const supportAppSettingId = cases.startRow(
        SETTING,
        "supportAppSettingId",
        {organizationPartyId},
        {
            queueIds: queueIds.join(",") || null,
            typeEnumIds: typeEnumIds.join(",") || null,
            wikiSpaceIds: wikiSpaceIds.join(",") || null,
            changeReason: text(p.changeReason)
        },
        p
    )
    return {supportAppSettingId}
}
function getSetting(p) {
    cases.requirePermission("SUPPORT_POLICY_EDIT")
    const organizationPartyId = cases.requireOrganization(p.organizationPartyId)
    const row = settingOf(organizationPartyId)
    return {
        setting: row ? lib.map(row) : null,
        sites: apps().sitesFor("support", organizationPartyId)
    }
}

// ===== links a notice carries (F60) =====
// A case's page for its customer: a CaseView link on the organization's first published site with the Support app, made by
// an agent of the case's organization (SUPPORT_CASE_EDIT); url null, and no link made, with no site (SupportNotices.js).
function caseLink(p) {
    cases.requirePermission("SUPPORT_CASE_EDIT")
    return ec.resource
        .script("component://mr-mantle/service/mantle/request/SupportNotices.js")
        .caseLink(p.requestId, p.validDays || 60)
}

// The PASS Account hub's Support card (Shop P6, F6): the signed-in account's open cases and returns with the organization
// the site's Support app serves.
function accountCard(p) {
    const organizationPartyId = served(p.siteId)
    if (!ec.user.userId) signInRequired()
    const customers = actingFor(organizationPartyId).map(row => row.partyId)
    const openCases = customers.length
        ? find("mantle.request.Request")
              .condition("customerPartyId", "in", customers)
              .condition("statusId", "in", openStatuses)
              .count()
        : 0
    const returns = customers.length
        ? find("mantle.order.return.ReturnHeader")
              .condition("customerPartyId", "in", customers)
              .condition("vendorPartyId", organizationPartyId)
              .condition("statusId", "not-in", ["ReturnCompleted", "ReturnCancelled"])
              .count()
        : 0
    return {
        title: "Support",
        lines: [
            openCases + (openCases === 1 ? " open case" : " open cases"),
            returns + (returns === 1 ? " open return" : " open returns")
        ],
        url: apps().pageUrl(p.siteId, "support", "/MyCases"),
        links: [
            {text: "My cases", url: apps().pageUrl(p.siteId, "support", "/MyCases")},
            {text: "My returns", url: apps().pageUrl(p.siteId, "support", "/MyReturns")}
        ]
    }
}

const operations = {
    accountCard,
    getSupportHome,
    getCustomerArticle,
    rateArticle,
    findCustomerCases,
    getCaseIntake,
    createCustomerCase,
    getCustomerCase,
    replyCustomerCase,
    requestCaseReopen,
    cancelCustomerCase,
    getCaseFile,
    saveSetting,
    getSetting,
    caseLink
}
const internalOperations = new Set(["saveSetting", "getSetting", "caseLink"])
;({
    // the customer-visible projections of a case, for the customer-visible case summary (CaseSummary.js, P16)
    statusLabel,
    outwardMessages,
    sharedFiles,
    customerLinks,
    customerValues,
    served,
    actingFor,
    // Shop P6 (F27): a guest's order link beside the account's customers
    askers,
    offeredQueues,
    hoursNotice,
    throttle,
    operationKey,
    refused,
    fail,
    requireRevision,
    listPage,
    unavailable,
    signInRequired,
    // the PASS operations check the asker first; Mantle's reads and writes below them run without artifact authorization, and a
    // refusal of a Mantle rule is the page's error kind
    execute(op, input) {
        if (!operations[op]) fail("NotFound", "Unknown support operation")
        const wasDisabled = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](input || {})
        } catch (error) {
            if (internalOperations.has(op)) throw error
            refused(error)
        } finally {
            if (!wasDisabled) ec.artifactExecution.enableAuthz()
        }
    }
})
