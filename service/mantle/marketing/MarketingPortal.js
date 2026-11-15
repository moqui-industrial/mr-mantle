// PASS Marketing: public subscription and its confirmation (mantle.marketing.MarketingPortalServices, P of IronStone Marketing design
// §14.2; design §13.1, §13 Subscribe and VerifySubscription, EmailPreferences' Marketing context; impl-marketing P7, F24, F25, F26,
// F43). CC0 1.0 Universal plus Grant of Patent License.
//
// - Every operation first finds the organization the page serves: the marketing mount's target on a published site, an internal
//   organization. A list is offered there only by an explicit public offer: its policy in effect has publicOffer Y, this site
//   and an open interval, the list is a Marketing list of that organization (not a mailbox, not archived, of email). The legacy
//   ContactList.isPublic publishes nothing. Anything else answers the same NotFound.
// - request#Subscription: the address, an optional display name, the offered topics and the consent box, with PASS's request key.
//   A public subscriber is a party (F43): the address's directory party when there is one (never a personal contact), else a new
//   person with that address; which one is never said. Each topic is filed through the audience's one evidenced path
//   (MarketingAudiences.js fileOne: pending, never clearing a withdrawal or a suppression) as one public request
//   (SubscriptionRequest rows sharing requestGroupId), and a verification message is queued on Comms' ledger as a transactional
//   delivery from a ready transactional sending profile of the organization, with the published confirmation template the list's
//   policy names, attempted once the request commits (its answer never waits on the mail). The answer is the same neutral receipt whatever happened: a new party or a matched one, a member already, a refusal,
//   a limit reached. Limits: requests per client, per site and per address (over: the receipt, nothing recorded) and
//   verification messages per address (over: the request kept, no message).
// - The confirmation link: each attempt of the verification message makes its own token (SubscriptionRequestToken keeps its
//   digest only, never the token), ending with the request (seven days). get#SubscriptionRequest is read only, so a mail
//   scanner's fetch changes nothing; verify#Subscription is a POST that accepts exactly the request's topics for its address
//   (the person's own act, renewing a withdrawn purpose, F120), once: a replay answers the first result, and a withdrawal
//   after the request is never undone by it (the request's evidence predates it). Every token lookup counts against the
//   requester's limit.
// - The PASS Account Email preferences page's Marketing context (AccountHub.js asks preferencesContext and changeTopics): the
//   sending organization's offered topics with the recipient's state; a topic turned on files a public request for the
//   recipient's address (a verified account's own address is accepted at once, as a checkout's is).
// - Answers are allow-listed projections; addresses are masked; tokens never leave the verification message.
// - P12: get#Form and submit#Form (the SubmitForm page): a Marketing publication answered on its own site, open, of the organization
//   the site serves (a public one by its id, an invited one by its link's token: ExternalAccess, scope MarketingSurvey); anything else
//   the same NotFound. The form is the publication's as of now on the server (its customer-visible questions and rules); an answer
//   goes through Commons' accept#Submission (unknown, internal and hidden fields refused, each value of its type, the request key's one
//   submission, an invitation answered once). A submission past the client's or site's limit, an oversized one, or one with a field
//   the page never offered answers the same neutral receipt and keeps nothing; a value the visitor can fix (a required answer, an
//   answer to a question its rules hide) answers what to fix. The
//   subscription choice is separate: a public request of the publication's list for the address typed beside it, with its own
//   verification message (as Subscribe's), after the answer is kept and never inferred from an answer.
// - P13: a lead form's page shows its rule's notice; its answer, once kept, is captured and handed to Sales after the request commits,
//   apart from the answer (MarketingLeads.js), with values only from the publication, the rule and Marketing's own verification.
// - P14: get#Page (the Page page): a landing page of the site's marketing mount, the site page services' published version in its
//   window as clean HTML, in parts between the components it embeds by id (a list offered on the site, a form publication), each of
//   which the page renders through its own operation; a draft, withdrawn or unknown page the same NotFound.
// - P16: get#Event (the Event page and a landing page's event component): a published registration offer of the organization on this
//   site for an occurrence still to come (mantle.work EventRegistrations.js publicView: the title, description, dates in the offer's
//   zone, where or online, ticket prices and advisory availability, terms); a draft, closed, past or another site's offer, or a
//   cancelled event, the same NotFound. Read only; no attendee, room, budget, campaign or call link is in the answer.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const audiences = () => ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingAudiences.js").audience
const apps = () => ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
const templates = () => ec.resource.script("component://mr-mantle/service/mantle/party/MessageTemplates.js")
const profiles = () => ec.resource.script("component://mr-mantle/service/mantle/party/MessageSendingProfiles.js")
const {find, one, rows, ms, call} = lib

const LIST = "mantle.marketing.contact.ContactList"
const CLP = "mantle.marketing.contact.ContactListParty"
const POLICY = "mantle.marketing.contact.ContactListPolicy"
const REQUEST = "mantle.marketing.contact.SubscriptionRequest"
const TOKEN = "mantle.marketing.contact.SubscriptionRequestToken"
const SOURCE = "MdsrcSubscriptionVerify"
const limits = {
    topics: 10,
    address: 254,
    name: 100,
    requestDays: 7,
    clientRequests: 30,
    siteRequests: 1000,
    addressRequests: 5,
    addressMails: 3,
    tokenLookups: 100,
    // P12: the SubmitForm page's limits and sizes
    formClient: 30,
    formSite: 1000,
    formPayloadChars: 65536
}
const MINUTES_10 = 600000
const HOUR = 3600000
const DAY = 86400000
const RECEIPT =
    "Thank you. If this address can receive our email, a message is on its way to it: open the link in that message to confirm. " +
    "Nothing is sent to you before you confirm."

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const nowMs = () => Number(ms(ec.user.nowTimestamp))
const L = words => ec.l10n.localize(words)
const fail = (kind, message) => {
    const error = new Error(message)
    error.moquiErrorKind = kind
    throw error
}
const unavailable = () => fail("NotFound", "This page is not available")
const yes = value =>
    value === true ||
    ["y", "yes", "true", "on", "1"].includes(
        String(value ?? "")
            .trim()
            .toLowerCase()
    )
const emailPattern =
    /^[^\s@<>()[\],;:"\\]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/
const masked = email => {
    const [local, domain] = String(email || "").split("@")
    return domain ? local.slice(0, 1) + "***@" + domain : ""
}
const organizationName = partyId => (partyId ? one("mantle.party.Organization", {partyId})?.organizationName || "" : "")
const listOf = value =>
    value == null
        ? []
        : (typeof value === "string" ? value.split(",") : Array.from(value)).map(item => text(item)).filter(Boolean)
const esc = value =>
    String(value ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[c])

// A limit's count (the framework's attempt buckets, as the sign-in limits): whether this one is still allowed.
function allowed(key, limit, windowMillis) {
    return !!ec.service
        .sync()
        .throwOnError(true)
        .name("org.moqui.public.AccountServices.record#Attempt")
        .parameters({input: {key, limit, windowMillis}})
        .requireNewTransaction(true)
        .call().result.allowed
}
const requester = () => ec.resource.script("component://framework/service/org/moqui/public/Account.js").requesterKey()
const addressKey = address => ec.user.singleUseCodeHash("mkt-address:" + address)
// A token lookup counts against the requester's limit first.
function throttleLookup() {
    if (!allowed("mkt-token:" + requester(), limits.tokenLookups, MINUTES_10))
        fail("Tarpit", "RATE_LIMITED: Too many attempts. Wait a few minutes and try again.")
}

// ===== the organization and its offers =====
// The organization the Marketing app of a published site serves (the marketing mount's target, an internal organization).
function served(siteId) {
    const site = siteId && one("mantle.public.PublicSite", {siteId})
    if (!site || site.state !== "published") unavailable()
    const mount = apps().mount(siteId, "marketing")
    if (!mount?.targetId || !one("mantle.party.PartyRole", {partyId: mount.targetId, roleTypeId: "OrgInternal"})) unavailable()
    return mount.targetId
}
// The list's offer on a site for an organization: {list, policy} while it is offered there, else null.
function offerOf(contactListId, siteId, organizationPartyId) {
    const list = contactListId ? one(LIST, {contactListId}) : null
    const audience = audiences()
    if (
        !list ||
        list.ownerPartyId !== organizationPartyId ||
        !audience.listTypes.includes(list.contactListTypeEnumId) ||
        (list.contactMechTypeEnumId || "CmtEmailAddress") !== "CmtEmailAddress" ||
        audience.archived(list)
    )
        return null
    const policy = audience.currentPolicy(list.contactListId)
    if (!policy || policy.publicSiteId !== siteId || !audience.offerState(policy).offered) return null
    return {list, policy}
}
// The lists offered on a site for its organization, by name.
function offersOf(siteId, organizationPartyId) {
    const ids = [
        ...new Set(
            Array.from(find(POLICY, {publicSiteId: siteId, publicOffer: "Y"}).list())
                .filter(row => lib.active(row))
                .map(row => row.contactListId)
        )
    ]
    return ids
        .map(id => offerOf(id, siteId, organizationPartyId))
        .filter(Boolean)
        .sort((a, b) => String(a.list.contactListName || "").localeCompare(String(b.list.contactListName || "")))
}
const topicView = ({list, policy}) => ({
    contactListId: list.contactListId,
    name: list.contactListName || list.contactListId,
    description: list.description || "",
    channelText: L("Email"),
    consentText: policy.evidenceText || L("Yes, send me") + " " + (list.contactListName || "") + "."
})

// One topic's request decided and recorded in this transaction (file#SubscriptionRequest, internal): its result.
function fileHere(list, policy, request, partyId) {
    return call("mantle.marketing.AudienceServices.file#SubscriptionRequest", {
        contactListId: list.contactListId,
        partyId,
        request
    }).result
}
// Work in a transaction of its own, committed before what follows reads it (the ledger's attempt and build run in their own).
const apart = (label, work) => ec.transaction.runRequireNew(null, label, work)

// ===== the subscriber =====
// The party a public request names for an address: the first directory party (by id) with it as a current email address,
// not merged, disabled or anyone's personal contact; else a new person with that address. Never said which.
function subscriberOf(address, displayName) {
    const cf = ec.entity.conditionFactory
    const infos = Array.from(
        find("mantle.party.contact.PartyContactMechInfo")
            .condition("contactMechTypeEnumId", "CmtEmailAddress")
            .condition(cf.makeCondition("infoString", "equals", address, false, true))
            .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
            .orderBy("partyId")
            .limit(50)
            .list()
    )
    for (const info of infos) {
        const party = one("mantle.party.Party", {partyId: info.partyId})
        if (party && party.disabled !== "Y" && !party.mergedToPartyId && !party.privateOwnerUserId)
            return {partyId: party.partyId, contactMechId: info.contactMechId}
    }
    const partyId = call("create#mantle.party.Party", {partyTypeEnumId: "PtyPerson"}).partyId
    call("create#mantle.party.Person", {partyId, firstName: displayName || null})
    const contactMechId = call("create#mantle.party.contact.ContactMech", {
        contactMechTypeEnumId: "CmtEmailAddress",
        infoString: address
    }).contactMechId
    call("create#mantle.party.contact.PartyContactMech", {
        partyId,
        contactMechId,
        contactMechPurposeId: "EmailPrimary",
        fromDate: ec.user.nowTimestamp
    })
    return {partyId, contactMechId}
}

// ===== the verification message =====
// The organization's sending profile for a verification: a ready email profile for transactional mail (purpose transactional, or
// none set). A verification is transactional: a promotional profile never sends it (P7 review), so with none the request is kept,
// nothing is sent, and the app's readiness names the missing profile.
function profileFor(organizationPartyId) {
    return (
        Array.from(find("mantle.party.MessageSendingProfile", {organizationPartyId, channelEnumId: "MdcEmail"}).list())
            .filter(
                row =>
                    (!row.purposeEnumId || row.purposeEnumId === "MtpTransactional") &&
                    lib.active(row) &&
                    profiles().readinessOf(row).ready
            )
            .sort((a, b) => String(a.sendingProfileId).localeCompare(String(b.sendingProfileId)))[0] || null
    )
}
// The published confirmation template a policy names: its EmailTemplate's Comms template of the organization, in use, with a
// published content. {template, content} or null.
function confirmationOf(policy, organizationPartyId) {
    const emailTemplateId = text(policy?.confirmEmailTemplateId)
    if (!emailTemplateId) return null
    const template = one("mantle.party.MessageTemplate", {emailTemplateId})
    if (!template || template.organizationPartyId !== organizationPartyId || template.channelEnumId !== "MdcEmail") return null
    if (template.thruDate != null && ms(template.thruDate) <= nowMs()) return null
    const content = templates().currentOf(templates().contentsOf(template.messageTemplateId))
    return content ? {template, content} : null
}
// Queue a public request's verification message (a transactional delivery of the ledger): the deliveryId, or null when the
// organization has no ready transactional profile or the topics' policies no published confirmation. Its attempt runs on a
// service worker once the request commits (attempt#VerificationDelivery), never inside the request (P7 review): a request that
// sends and one that does not (a member already, a refusal, the mail limit) take the same time to answer.
function queueVerification(group, rowsOfGroup, organizationPartyId, address) {
    const profile = profileFor(organizationPartyId)
    const confirmation = rowsOfGroup
        .map(row => confirmationOf(audiences().currentPolicy(row.contactListId), organizationPartyId))
        .find(Boolean)
    if (!profile || !confirmation) {
        ec.logger.warn(
            "Subscription request " +
                group +
                ": no verification sent, the organization " +
                organizationPartyId +
                " has " +
                (!profile ? "no ready transactional sending profile" : "no published confirmation template on the topics")
        )
        return null
    }
    const queued = call("mantle.party.MessageServices.queue#Delivery", {
        eventKey: "mkt-verify:" + group,
        sourceEnumId: SOURCE,
        recipientPartyId: rowsOfGroup[0].partyId,
        toAddress: address,
        channelEnumId: "MdcEmail",
        templateKey: confirmation.template.emailTemplateId,
        siteId: rowsOfGroup[0].siteId || null,
        organizationPartyId,
        sendingProfileId: profile.sendingProfileId,
        transactional: true
    })
    if (queued.deliveryId && queued.created)
        ec.service
            .special()
            .name("mantle.marketing.MarketingPortalServices.attempt#VerificationDelivery")
            .parameters({deliveryId: queued.deliveryId})
            .registerOnCommit()
    return queued.deliveryId || null
}
// attempt#VerificationDelivery (after a request commits, on a service worker): one attempt of a verification delivery; a later
// one is the ledger's job (run#Deliveries). Any other delivery is left alone.
function attemptVerification(p) {
    const delivery = one("mantle.party.MessageDelivery", {deliveryId: text(p.deliveryId)})
    if (!delivery || delivery.sourceEnumId !== SOURCE) return {}
    ec.message.pushErrors()
    try {
        ec.service
            .sync()
            .name("mantle.party.MessageServices.attempt#Delivery")
            .parameters({deliveryId: delivery.deliveryId})
            .disableAuthz()
            .requireNewTransaction(true)
            .call()
        if (ec.message.hasError())
            ec.logger.error("Verification delivery " + delivery.deliveryId + " attempt failed: " + ec.message.getErrorsString())
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
    return {}
}
// build#VerificationDelivery (the ledger's source, before each attempt): the confirmation template's content (its declared
// variables' fallbacks and the topics' names; nothing the visitor typed), with the confirmation link this attempt makes; a
// request decided or expired is suppressed.
function buildVerification(p) {
    const delivery = one("mantle.party.MessageDelivery", {deliveryId: text(p.deliveryId)})
    const group = delivery ? String(delivery.eventKey || "").replace(/^mkt-verify:/, "") : null
    const rowsOfGroup = group ? rows(REQUEST, {requestGroupId: group}) : []
    if (!rowsOfGroup.length) return {suppress: "The subscription request is gone"}
    const first = rowsOfGroup[0]
    if (first.expireDate != null && ms(first.expireDate) <= nowMs()) return {suppress: "The subscription request expired"}
    if (!rowsOfGroup.some(row => row.statusEnumId === "SrsPending")) return {suppress: "The subscription request is decided"}
    const template = one("mantle.party.MessageTemplate", {emailTemplateId: delivery.templateKey})
    const content = template ? templates().currentOf(templates().contentsOf(template.messageTemplateId)) : null
    if (!template || template.organizationPartyId !== delivery.organizationPartyId || !content)
        return {suppress: "The confirmation template is not published"}
    const names = rowsOfGroup
        .filter(row => row.statusEnumId === "SrsPending")
        .map(row => one(LIST, {contactListId: row.contactListId})?.contactListName || row.contactListId)
    const rendered = templates().render(content, {listName: names.join(", ")})
    const token = ec.user.randomString(40).replace(/[^A-Za-z0-9_-]/g, "")
    call("create#" + TOKEN, {
        tokenDigest: ec.user.singleUseCodeHash(token),
        requestGroupId: group,
        createdDate: ec.user.nowTimestamp,
        thruDate: first.expireDate || null
    })
    const url = apps().pageUrl(first.siteId, "marketing", "/VerifySubscription?token=" + encodeURIComponent(token))
    if (!url) return {suppress: "The site has no Marketing page to confirm on"}
    const body =
        (rendered.body || "") +
        '<p><a href="' +
        esc(url) +
        '">' +
        esc(L("Confirm my subscription")) +
        "</a></p><p><small>" +
        esc(L("The link opens a page where you confirm; opening it alone changes nothing.")) +
        "</small></p>"
    const bodyText =
        (rendered.bodyText || String(rendered.body || "").replace(/<[^>]*>/g, "")).trim() +
        "\n\n" +
        L("Confirm my subscription") +
        ": " +
        url +
        "\n"
    return {bodyParameters: {}, subject: rendered.subject || L("Please confirm your subscription"), body, bodyText}
}

// ===== get#Publication =====
// getPublication: the site's offered topics (or the one named), with the consent wording each shows.
function getPublication(p) {
    const organizationPartyId = served(p.siteId)
    const named = text(p.contactListId)
    const offers = named
        ? [offerOf(named, p.siteId, organizationPartyId)].filter(Boolean)
        : offersOf(p.siteId, organizationPartyId)
    if (!offers.length) unavailable()
    return {organizationName: organizationName(organizationPartyId), topics: offers.map(topicView)}
}

// ===== request#Subscription =====
// The request a public page or the preferences page files: each topic through fileOne, one group; then the verification message
// (unless the address's message limit is reached). Internal to this module.
function fileGroup({siteId, organizationPartyId, offers, subscriber, address, requestKey, evidenceText, sourceEnumId}) {
    const audience = audiences()
    const expireDate = new Date(nowMs() + limits.requestDays * DAY)
    let group = null
    const outcomes = []
    for (const {list, policy} of offers) {
        const result = audience.fileApart(
            list,
            policy,
            {
                requestKindEnumId: "SrkPublic",
                sourceEnumId,
                evidenceDate: ec.user.nowTimestamp,
                evidenceText: evidenceText(list, policy),
                contactMechId: subscriber.contactMechId,
                accept: false,
                extra: {siteId, requestKey, expireDate, requestGroupId: group}
            },
            subscriber.partyId
        )
        outcomes.push(result)
        if (!group && result.subscriptionRequestId) {
            group = result.subscriptionRequestId
            const first = group
            apart("Error marking the subscription request", () =>
                call("update#" + REQUEST, {subscriptionRequestId: first, requestGroupId: first})
            )
        }
    }
    const waiting = group ? rows(REQUEST, {requestGroupId: group}).filter(row => row.statusEnumId === "SrsPending") : []
    if (waiting.length && allowed("mkt-mail:" + addressKey(address), limits.addressMails, DAY)) {
        const deliveryId = queueVerification(group, waiting, organizationPartyId, address)
        if (deliveryId)
            for (const row of waiting)
                call("update#" + REQUEST, {subscriptionRequestId: row.subscriptionRequestId, verificationDeliveryId: deliveryId})
    }
    return {group, outcomes}
}
// requestSubscription: the neutral receipt, whatever happened.
function requestSubscription(p) {
    const receipt = {receipt: {message: L(RECEIPT)}}
    const organizationPartyId = served(p.siteId)
    const address = String(p.emailAddress || "")
        .trim()
        .toLowerCase()
    if (!address || address.length > limits.address || !emailPattern.test(address))
        fail("Unprocessable", "VALUE_INVALID[emailAddress]: Enter your email address")
    const displayName = text(p.displayName)
    if (displayName && (displayName.length > limits.name || /[\r\n<>]/.test(displayName)))
        fail("Unprocessable", "VALUE_INVALID[displayName]: Enter a shorter name, without line breaks or angle brackets")
    const asked = [...new Set(listOf(p.contactListIds))]
    if (!asked.length) fail("Unprocessable", "VALUE_INVALID[contactListIds]: Choose what you want to receive")
    if (asked.length > limits.topics) unavailable()
    if (!yes(p.consent)) fail("Unprocessable", "VALUE_INVALID[consent]: Tick the box to say you want to receive it")
    const operationId = String(p.operationId || "")
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(operationId)) fail("Unprocessable", "Reload the page and try again")
    // every topic offered on this site, else the same NotFound
    const offers = asked.map(id => offerOf(id, p.siteId, organizationPartyId))
    if (offers.some(offer => !offer)) unavailable()
    // the limits: over any, the receipt and nothing recorded
    if (
        !allowed("mkt-client:" + requester(), limits.clientRequests, MINUTES_10) ||
        !allowed("mkt-site:" + p.siteId, limits.siteRequests, HOUR) ||
        !allowed("mkt-request:" + addressKey(address), limits.addressRequests, HOUR)
    )
        return receipt
    // a repeat of the request key answers the first request
    const requestKey = ec.user.singleUseCodeHash("mkt-request:" + p.siteId + ":" + address + ":" + operationId)
    if (find(REQUEST, {requestKey}).count() > 0) return receipt
    // the party committed first: each topic is filed in a transaction of its own, and the verification's build in another
    const subscriber = apart("Error making the subscriber", () => subscriberOf(address, displayName))
    const site = one("mantle.public.PublicSite", {siteId: p.siteId})
    fileGroup({
        siteId: p.siteId,
        organizationPartyId,
        offers,
        subscriber,
        address,
        requestKey,
        sourceEnumId: "PcsForm",
        evidenceText: (list, policy) =>
            (policy.evidenceText || "Subscribe to " + (list.contactListName || list.contactListId)) +
            " (the subscribe page of site " +
            (site?.name || p.siteId) +
            ", the consent box ticked)"
    })
    return receipt
}

// ===== get#SubscriptionRequest and verify#Subscription =====
// The public request a confirmation token names on this site, while it stands: {group, rows}; else the same NotFound.
function requestOfToken(siteId, token) {
    throttleLookup()
    const value = text(token)
    if (!value || !/^[A-Za-z0-9_-]{20,80}$/.test(value)) unavailable()
    const found = one(TOKEN, {tokenDigest: ec.user.singleUseCodeHash(value)})
    if (!found || (found.thruDate != null && ms(found.thruDate) <= nowMs())) unavailable()
    const rowsOfGroup = rows(REQUEST, {requestGroupId: found.requestGroupId}).sort((a, b) =>
        String(a.subscriptionRequestId).localeCompare(String(b.subscriptionRequestId))
    )
    const first = rowsOfGroup[0]
    if (!first || first.siteId !== siteId || (first.expireDate != null && ms(first.expireDate) <= nowMs())) unavailable()
    return {group: found.requestGroupId, rows: rowsOfGroup}
}
const addressOf = contactMechId =>
    contactMechId ? one("mantle.party.contact.ContactMech", {contactMechId})?.infoString || "" : ""
const confirmedOf = row => row.verifiedDate != null
// The request's view: the masked address, the topics and their consent wording, and its state.
function requestView(organizationPartyId, rowsOfGroup) {
    const decided = rowsOfGroup.every(row => row.statusEnumId !== "SrsPending")
    const confirmed = rowsOfGroup.some(confirmedOf)
    return {
        organizationName: organizationName(organizationPartyId),
        maskedAddress: masked(addressOf(rowsOfGroup[0].contactMechId)),
        topics: rowsOfGroup.map(row => {
            const list = one(LIST, {contactListId: row.contactListId})
            return {
                name: list?.contactListName || row.contactListId,
                description: list?.description || "",
                consentText: audiences().currentPolicy(row.contactListId)?.evidenceText || ""
            }
        }),
        state: decided ? (confirmed ? "confirmed" : "closed") : "pending",
        expiresText: lib.dateText(rowsOfGroup[0].expireDate),
        canConfirm: !decided
    }
}
// getSubscriptionRequest: read only (a scanner's fetch changes nothing).
function getSubscriptionRequest(p) {
    const organizationPartyId = served(p.siteId)
    const found = requestOfToken(p.siteId, p.token)
    if (found.rows.some(row => row.organizationPartyId !== organizationPartyId)) unavailable()
    return requestView(organizationPartyId, found.rows)
}
// verifySubscription: the request's topics accepted for its address, once.
function verifySubscription(p) {
    const organizationPartyId = served(p.siteId)
    const found = requestOfToken(p.siteId, p.token)
    if (found.rows.some(row => row.organizationPartyId !== organizationPartyId)) unavailable()
    // one confirmation at a time: the group's first row locked, its rows read again under the lock
    find(REQUEST, {subscriptionRequestId: found.group}).forUpdate(true).one()
    const current = rows(REQUEST, {requestGroupId: found.group})
    const audience = audiences()
    for (const row of current.filter(item => item.statusEnumId === "SrsPending")) {
        const list = one(LIST, {contactListId: row.contactListId})
        const offer = offerOf(row.contactListId, p.siteId, organizationPartyId)
        // a topic no longer offered is refused, the others go on
        if (!offer) {
            call("update#" + REQUEST, {
                subscriptionRequestId: row.subscriptionRequestId,
                statusEnumId: "SrsRefused",
                reasonCode: "OFFER_CLOSED",
                decidedDate: ec.user.nowTimestamp
            })
            continue
        }
        // in this transaction, under the group's lock
        fileHere(
            list,
            offer.policy,
            {
                subscriptionRequestId: row.subscriptionRequestId,
                requestKindEnumId: row.requestKindEnumId,
                sourceEnumId: "PcsEmailLink",
                // the request's own evidence date: a withdrawal after the request is never undone by its confirmation
                evidenceDate: row.evidenceDate,
                evidenceText: "Confirmed by the subscription link: " + (row.evidenceText || ""),
                contactMechId: row.contactMechId,
                accept: true,
                byPerson: true
            },
            row.partyId
        )
    }
    const after = rows(REQUEST, {requestGroupId: found.group}).sort((a, b) =>
        String(a.subscriptionRequestId).localeCompare(String(b.subscriptionRequestId))
    )
    const view = requestView(organizationPartyId, after)
    const accepted = after.filter(row => row.statusEnumId === "SrsAccepted").length
    return Object.assign(view, {
        receipt: {
            message: accepted
                ? L("Thank you. Your subscription is confirmed.")
                : L("Nothing was changed. To subscribe, ask again from the subscribe page.")
        }
    })
}

// ===== P12: get#Form and submit#Form (the SubmitForm page) =====
const forms = () => ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingForms.js")
const publications = () => ec.resource.script("component://mr-mantle/service/mantle/party/FormPublication.js")
const PUBLICATION = "mantle.party.FormPublication"
const FORM_RECEIPT = "Thank you. Your answer is recorded."
// P13: a lead form's rule, its notice and the capture of its answers (MarketingLeads.js)
const leads = () => ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingLeads.js")
// The open Marketing publications of a site for its organization (readiness).
const openFormsOf = (siteId, organizationPartyId) =>
    rows(PUBLICATION, {siteId, organizationPartyId}).filter(
        row => forms().PUBLICATION_PURPOSES.includes(row.purposeEnumId) && publications().stateOf(row) === "open"
    ).length
// The publication a page answers on this site, while it is open: by its link's token (an invited one: {publication, invitation}) or
// by its id (a public or an account one); anything else the same NotFound.
function publicationOfPage(p, organizationPartyId) {
    let row = null,
        invitation = null
    if (!blank(p.token)) {
        // the link's check (its lookup counts against the requester's limit there); its own NotFound ("This link ...") is the
        // page's one, so a forged token and a good one of a closed or another site's publication answer alike (P12 review R2)
        let checked
        try {
            checked = ec.resource.script("component://mr-mantle/service/mantle/party/ExternalAccess.js").check({
                token: p.token,
                scope: "MarketingSurvey",
                recordType: "FormInvitation",
                organizationPartyId
            })
        } catch (error) {
            if (error?.moquiErrorKind !== "NotFound") throw error
            unavailable()
        }
        invitation = one("mantle.party.FormInvitation", {invitationId: checked.recordId})
        row = invitation ? one(PUBLICATION, {publicationId: invitation.publicationId}) : null
        if (!row || row.accessEnumId !== "FpaInvited") unavailable()
    } else {
        row = blank(p.publicationId) ? null : one(PUBLICATION, {publicationId: text(p.publicationId)})
        if (!row || !["FpaAnonymous", "FpaAccount"].includes(row.accessEnumId)) unavailable()
    }
    if (
        !forms().PUBLICATION_PURPOSES.includes(row.purposeEnumId) ||
        row.organizationPartyId !== organizationPartyId ||
        row.siteId !== p.siteId ||
        publications().stateOf(row) !== "open" ||
        // P16 review: an event offer's registration questions are answered with a registration (P17), never on this page alone
        row.contextEntityName === "mantle.work.registration.EventRegistrationPolicy"
    )
        unavailable()
    const form = one("moqui.screen.form.DbForm", {formId: row.formId})
    if (!form || !forms().PURPOSES.includes(form.purposeEnumId) || form.ownerPartyId !== organizationPartyId) unavailable()
    return {row, form, invitation}
}
// The subscription choice a publication offers beside its answers: its list while it is offered on the site, else none.
function subscriptionOffer(row, organizationPartyId) {
    return row.subscriptionListId ? offerOf(row.subscriptionListId, row.siteId, organizationPartyId) : null
}
function formReceipt(row) {
    return {receipt: {message: row.completionMessage || L(FORM_RECEIPT)}}
}
// getForm: the page's form, read only: its heading, introduction, questions and rules as of now, the subscription choice, and for an
// invitation already answered or an account's once policy already answered the receipt in place of the questions.
function getForm(p) {
    const organizationPartyId = served(p.siteId)
    const {row, form, invitation} = publicationOfPage(p, organizationPartyId)
    const accountPartyId = ec.user.userAccount?.partyId || null
    const needsAccount = row.accessEnumId === "FpaAccount" && !accountPartyId
    const answered =
        !!invitation?.formResponseId ||
        (row.accessEnumId === "FpaAccount" &&
            row.repeatEnumId === "FprOnce" &&
            !!accountPartyId &&
            find("mantle.party.FormSubmission", {publicationId: row.publicationId, partyId: accountPartyId}).count() > 0)
    const offer = subscriptionOffer(row, organizationPartyId)
    return {
        form: {
            publicationId: row.accessEnumId === "FpaInvited" ? null : row.publicationId,
            title: row.titleText || form.description || "",
            intro: row.introText || "",
            organizationName: organizationName(organizationPartyId),
            access: row.accessEnumId === "FpaInvited" ? "invited" : row.accessEnumId === "FpaAccount" ? "account" : "anyone",
            needsAccount,
            answered,
            fields: answered || needsAccount ? [] : publications().pageFields(row.formId),
            subscription:
                offer && !answered ? {name: offer.list.contactListName || "", consentText: topicView(offer).consentText} : null,
            // P13: a lead form's notice of the follow-up (its current rule's words)
            notice: row.purposeEnumId === "FppLead" && !answered ? leads().noticeOf(row.publicationId) : null
        },
        receipt: answered ? formReceipt(row).receipt : null
    }
}
// The values a page sends: a map, or its JSON text (a form post through a remote frontend); null for one that is not.
function formValuesOf(value) {
    if (value == null || value === "") return {}
    if (typeof value === "string") {
        if (value.length > limits.formPayloadChars) return null
        const parsed = lib.json(value, null)
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null
    }
    return Object.assign({}, value)
}
// submitForm: the answer kept through accept#Submission, then the subscription choice apart; the neutral receipt.
function submitForm(p) {
    const organizationPartyId = served(p.siteId)
    const {row, invitation} = publicationOfPage(p, organizationPartyId)
    const receipt = formReceipt(row)
    const operationId = String(p.operationId || "")
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(operationId)) fail("Unprocessable", "Reload the page and try again")
    // the limits and the size: over any, the receipt and nothing kept
    const values = formValuesOf(p.values)
    if (
        !values ||
        JSON.stringify(values).length > limits.formPayloadChars ||
        !allowed("mkt-form-client:" + requester(), limits.formClient, MINUTES_10) ||
        !allowed("mkt-form-site:" + p.siteId, limits.formSite, HOUR)
    )
        return receipt
    const accountPartyId = ec.user.userAccount?.partyId || null
    if (row.accessEnumId === "FpaAccount" && !accountPartyId) fail("AuthenticationRequired", "Sign in to answer this form")
    let accepted
    try {
        // Commons' accept#Submission's rule, in this operation's transaction
        accepted = publications().acceptSubmission({
            publicationId: row.publicationId,
            values,
            requestKey: operationId,
            invitationId: invitation?.invitationId || null,
            partyId: row.accessEnumId === "FpaAccount" ? accountPartyId : null,
            siteId: p.siteId
        })
    } catch (error) {
        const code = lib.reasonCode(error)
        ec.message.clearErrors()
        // what the page never offers (an unknown or hidden field, an oversized value): refused with the same receipt, nothing kept
        if (["FIELD_UNKNOWN", "VALUE_TOO_LONG"].includes(code)) return receipt
        // a question its rules hide: a visitor without JavaScript sees every question, so the page says what to fix; nothing kept
        if (code === "FIELD_HIDDEN")
            fail("Unprocessable", "Leave unanswered the questions that do not apply to your other answers")
        if (code === "ALREADY_ANSWERED") return receipt
        if (code === "PUBLICATION_CLOSED" || code === "INVITATION_REQUIRED") unavailable()
        if (code === "FORM_VALUES_INVALID")
            fail(
                "Unprocessable",
                String(error.message)
                    .replace(/^FORM_VALUES_INVALID: /, "")
                    .split("\n")[0]
            )
        if (code === "REQUEST_KEY_REUSED" || code === "REQUEST_KEY_INVALID")
            fail("Unprocessable", "Reload the page and try again")
        throw error
    }
    if (!accepted.alreadyApplied) applySubmissionEffects(row, accepted.formSubmissionId, organizationPartyId, p)
    return receipt
}
// The effects after an answer is kept, each apart and replay-safe (a repeat of the request key does not run them again): the
// subscription choice as a public request with its own verification message (Subscribe's path, its address limit). Recorded on the
// submission; a failure is logged and the answer stands.
function applySubmissionEffects(row, formSubmissionId, organizationPartyId, p) {
    const notes = []
    let failed = false
    try {
        const offer = subscriptionOffer(row, organizationPartyId)
        if (offer && yes(p.subscribe)) {
            const address = String(p.subscriptionEmail || "")
                .trim()
                .toLowerCase()
            if (!address || address.length > limits.address || !emailPattern.test(address))
                notes.push("subscription: no valid address")
            else if (!allowed("mkt-request:" + addressKey(address), limits.addressRequests, HOUR))
                notes.push("subscription: address limit")
            else {
                const subscriber = apart("Error making the subscriber", () => subscriberOf(address, null))
                const site = one("mantle.public.PublicSite", {siteId: row.siteId})
                fileGroup({
                    siteId: row.siteId,
                    organizationPartyId,
                    offers: [offer],
                    subscriber,
                    address,
                    requestKey: ec.user.singleUseCodeHash("mkt-form-subscription:" + formSubmissionId),
                    sourceEnumId: "PcsForm",
                    evidenceText: (list, policy) =>
                        (policy.evidenceText || "Subscribe to " + (list.contactListName || list.contactListId)) +
                        " (the subscription choice beside form " +
                        row.publicationId +
                        " on site " +
                        (site?.name || row.siteId) +
                        ", ticked)"
                })
                notes.push("subscription: requested")
            }
        }
    } catch (error) {
        failed = true
        notes.push("subscription failed")
        ec.logger.error(
            "Form submission " +
                formSubmissionId +
                ": the subscription choice failed: " +
                String(error?.message || error).split("\n")[0]
        )
        ec.message.clearErrors()
    }
    // P13: a lead form's answer is captured and handed to Sales after it commits, on a service worker in a transaction of its own
    // (MarketingLeads.js capture#FormSubmission), never as part of the answer; the capture job takes up one this misses
    if (row.purposeEnumId === "FppLead") {
        try {
            leads().captureAfterCommit(formSubmissionId)
            notes.push("lead: handed to the capture")
        } catch (error) {
            failed = true
            notes.push("lead capture failed")
            ec.logger.error(
                "Form submission " +
                    formSubmissionId +
                    ": its lead capture was not queued: " +
                    String(error?.message || error).split("\n")[0]
            )
            ec.message.clearErrors()
        }
    }
    try {
        publications().recordEffects(formSubmissionId, failed, notes.join("; "))
    } catch (error) {
        ec.logger.error(
            "Form submission " +
                formSubmissionId +
                ": its effects not recorded: " +
                String(error?.message || error).split("\n")[0]
        )
        ec.message.clearErrors()
    }
}

// ===== P14: get#Page (a landing page of the marketing mount) =====
const sitePages = () => ec.resource.script("component://mr-mantle/service/mantle/public/SitePages.js")
const routePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*){0,5}$/
// An embedded component: a paragraph of its own naming a list offered on the site or a form publication by its id, "[[subscribe
// ID]]" or "[[form ID]]" in the page's text (no expression, no markup); at most five a page, the rest left out.
const embedPattern = /<p>\s*\[\[(subscribe|form|event)\s+([A-Za-z0-9_-]{1,40})\]\]\s*<\/p>/g
const embedLimit = 5
// The site's marketing mount row (its appMountId), the one served.
const marketingMountOf = siteId =>
    Array.from(find("mantle.public.PublicSiteApp", {siteId, app: "marketing", enabled: "Y"}).list())[0] || null
// A page's parts in order: its clean HTML (the site page services' markdown, cleaned) between the embedded components it names. The
// page renders each component through its own operation (getMarketingPublication, getMarketingForm), which answers only a list
// offered or a form open on this site, so naming a draft or another organization's record shows nothing.
function pageParts(body) {
    const parts = []
    let at = 0,
        embeds = 0,
        match
    embedPattern.lastIndex = 0
    while ((match = embedPattern.exec(body)) !== null) {
        if (match.index > at) parts.push({kind: "html", html: body.slice(at, match.index)})
        if (embeds++ < embedLimit)
            parts.push(
                match[1] === "subscribe"
                    ? {kind: "subscribe", contactListId: match[2]}
                    : match[1] === "event"
                      ? {kind: "event", registrationPolicyId: match[2]}
                      : {kind: "form", publicationId: match[2]}
            )
        at = match.index + match[0].length
    }
    if (at < body.length) parts.push({kind: "html", html: body.slice(at)})
    return parts
}
// getPage: a published landing page of the site's marketing mount at a route, as a visitor reads it (the site page services'
// get#SitePage: the binding's exact published version in its window); a draft, withdrawn, scheduled or unknown page, or a site
// without the mount, the same NotFound.
function getPage(p) {
    served(p.siteId)
    const mount = marketingMountOf(p.siteId)
    const routePath = String(p.routePath || "").replace(/^\/+|\/+$/g, "")
    if (!mount || !routePattern.test(routePath)) unavailable()
    let found
    try {
        found = sitePages().execute("getSitePage", {
            siteId: p.siteId,
            appMountId: mount.appMountId,
            routePath,
            locale: text(p.locale)
        })
    } catch (error) {
        ec.message.clearErrors()
        unavailable()
    }
    const page = found.page
    return {
        page: {
            sitePageId: page.sitePageId,
            title: page.title || page.routePath,
            seoTitle: page.seoTitle || null,
            description: page.seoDescription || null,
            socialImageUrl: page.socialImageUrl || null,
            locale: page.locale ? String(page.locale).replace(/_/g, "-") : null,
            routePath: page.routePath,
            url: page.url,
            version: page.version,
            parts: pageParts(String(page.body || ""))
        }
    }
}
// ===== P16: get#Event (a published registration offer: the Event page and a landing page's event component) =====
const registrations = () => ec.resource.script("component://mr-mantle/service/mantle/work/EventRegistrations.js")
function getEvent(p) {
    const organizationPartyId = served(p.siteId)
    const view = registrations().publicView(p.registrationPolicyId, p.siteId, organizationPartyId)
    if (!view) unavailable()
    return {event: view}
}

// The landing pages live on a site's marketing mount now (readiness).
const livePagesOf = siteId => {
    const mount = marketingMountOf(siteId)
    if (!mount) return 0
    const at = nowMs()
    return rows("mantle.public.PublicSitePage", {siteId, appMountId: mount.appMountId}).filter(
        row => !!row.versionName && (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at
    ).length
}

// ===== check#MarketingAppReadiness =====
// The Marketing app's checks of a site (PublicApps.js): its target an internal organization, a list offered there (a mount with
// no published record is named), a ready transactional sending profile, a published confirmation template on each offered list, and the
// site's canonical host, from which every link is made.
function appReadiness(p) {
    const organization = !!p.targetId && !!one("mantle.party.PartyRole", {partyId: p.targetId, roleTypeId: "OrgInternal"})
    const offers = organization ? offersOf(p.siteId, p.targetId) : []
    return {
        checks: [
            {name: "organization", ready: organization},
            // P12: a list offered or a form publication open on the site; P14: or a landing page published there; P16: or an
            // event's registration offer
            {
                name: "published list, form, page or event",
                ready:
                    offers.length > 0 ||
                    (organization &&
                        (openFormsOf(p.siteId, p.targetId) > 0 ||
                            livePagesOf(p.siteId) > 0 ||
                            registrations().liveOffersOf(p.siteId, p.targetId) > 0))
            },
            {name: "transactional sending profile", ready: organization && !!profileFor(p.targetId)},
            {
                name: "confirmation template",
                // P12: each offered list's (a site offering only forms needs none)
                ready: organization && offers.every(offer => !!confirmationOf(offer.policy, p.targetId))
            },
            {name: "canonical host", ready: !!apps().pageUrl(p.siteId, p.app || "marketing", "/")}
        ]
    }
}

// ===== the email preferences page's Marketing context (AccountHub.js) =====
// The organization's offered topics on a site with the party's state on each: {organizationName, topics: [{contactListId, name,
// description, channelText, state (subscribed, pending, unsubscribed, none)}]}, or null when the site offers none of its lists.
function preferencesContext(siteId, organizationPartyId, partyId) {
    if (!siteId || !organizationPartyId) return null
    const mount = apps().mount(siteId, "marketing")
    if (!mount || mount.targetId !== organizationPartyId) return null
    const offers = offersOf(siteId, organizationPartyId)
    if (!offers.length) return null
    const audience = audiences()
    return {
        organizationPartyId,
        organizationName: organizationName(organizationPartyId),
        topics: offers.map(offer => {
            const latest = partyId
                ? Array.from(
                      find(CLP, {contactListId: offer.list.contactListId, partyId})
                          .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                          .orderBy("-fromDate")
                          .list()
                  )[0]
                : null
            const state = !latest
                ? "none"
                : audience.subscribed.includes(latest.statusId)
                  ? "subscribed"
                  : latest.statusId === "CLPT_PENDING"
                    ? "pending"
                    : "unsubscribed"
            return Object.assign(topicView(offer), {state})
        })
    }
}
// Topics turned on from the preferences page: for the party's address (the link's, or the account's), each still offered; a
// verified account's own address accepted at once (its sign-in proves the address, as a checkout's does), else a public request
// with its verification message. {requested, accepted}.
function changeTopics({siteId, organizationPartyId, partyId, contactMechId, contactListIds, verifiedAccount}) {
    const offers = listOf(contactListIds)
        .slice(0, limits.topics)
        .map(id => offerOf(id, siteId, organizationPartyId))
        .filter(Boolean)
    if (!offers.length || !partyId || !contactMechId) return {requested: 0, accepted: 0}
    const address = String(addressOf(contactMechId)).toLowerCase()
    if (!address) return {requested: 0, accepted: 0}
    const site = one("mantle.public.PublicSite", {siteId})
    const evidence = list =>
        "Turned on " +
        (list.contactListName || list.contactListId) +
        " on the email preferences of site " +
        (site?.name || siteId)
    if (verifiedAccount) {
        let accepted = 0
        for (const {list, policy} of offers) {
            const result = audiences().fileApart(
                list,
                policy,
                {
                    requestKindEnumId: "SrkPublic",
                    sourceEnumId: "PcsForm",
                    evidenceDate: ec.user.nowTimestamp,
                    evidenceText: evidence(list) + " (signed in, the account's verified address)",
                    contactMechId,
                    accept: true,
                    byPerson: true,
                    extra: {siteId}
                },
                partyId
            )
            if (result.outcome === "accepted" || result.outcome === "existing") accepted++
        }
        return {requested: 0, accepted}
    }
    if (!allowed("mkt-request:" + addressKey(address), limits.addressRequests, HOUR)) return {requested: 0, accepted: 0}
    fileGroup({
        siteId,
        organizationPartyId,
        offers,
        subscriber: {partyId, contactMechId},
        address,
        requestKey: null,
        sourceEnumId: "PcsEmailLink",
        evidenceText: list => evidence(list) + " (by the link of a message to this address)"
    })
    return {requested: offers.length, accepted: 0}
}

// ===== the checkout's store-news choice (StoreTopics.js, impl-shop §7, F26) =====
// fileCheckout: the buyer's choice of the store's news list filed through the audience's evidenced path, source PcsCheckout:
// pending until the receipt's link (or a verified sign-in) confirms it, or accepted at once for a verified account. {outcome}.
function fileCheckout(p) {
    const list = one(LIST, {contactListId: text(p.contactListId)})
    if (!list) throw new Error("No news list " + p.contactListId)
    const accept = yes(p.accept)
    // in the opt-in's own transaction (apply#CheckoutOptIn), which sees the checkout's party
    const result = fileHere(
        list,
        audiences().currentPolicy(list.contactListId),
        {
            requestKindEnumId: "SrkCheckout",
            sourceEnumId: "PcsCheckout",
            evidenceDate: ec.user.nowTimestamp,
            evidenceText: text(p.evidenceText) || "Checkout",
            sourceRecordId: text(p.sourceRecordId),
            contactMechId: text(p.contactMechId),
            accept,
            byPerson: true
        },
        text(p.partyId)
    )
    return {outcome: result.outcome, reasonCode: result.reasonCode || null}
}

const operations = {
    getPublication,
    requestSubscription,
    getSubscriptionRequest,
    verifySubscription,
    appReadiness,
    buildVerification,
    attemptVerification,
    fileCheckout,
    getForm,
    submitForm,
    getPage,
    getEvent
}
const internalOperations = new Set(["appReadiness", "buildVerification", "attemptVerification", "fileCheckout"])
;({
    served,
    offersOf,
    preferencesContext,
    changeTopics,
    limits,
    // the PASS operations check the site and the asker first; Mantle's reads and writes below them run without artifact
    // authorization (as SalesPortal.js), and a refusal below them is never shown as itself
    execute(op, input) {
        if (!operations[op]) fail("NotFound", "Unknown marketing portal operation")
        const wasDisabled = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](input || {})
        } catch (error) {
            if (internalOperations.has(op) || error?.moquiErrorKind) throw error
            ec.logger.error("Marketing portal " + op + " failed: " + String(error?.message || error).split("\n")[0])
            ec.message.clearErrors()
            fail("Unavailable", "This is not available right now. Try again later.")
        } finally {
            if (!wasDisabled) ec.artifactExecution.enableAuthz()
        }
    }
})
