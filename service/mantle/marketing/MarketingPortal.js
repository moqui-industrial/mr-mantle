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
// The list's offer on a site for an organization: {list, policy} while it is offered there, else null. A list of email only, unless
// withText (P22 review: the email preferences page shows a text message topic, which it lets its member leave and never turns on).
function offerOf(contactListId, siteId, organizationPartyId, withText = false) {
    const list = contactListId ? one(LIST, {contactListId}) : null
    const audience = audiences()
    if (
        !list ||
        list.ownerPartyId !== organizationPartyId ||
        !audience.listTypes.includes(list.contactListTypeEnumId) ||
        !(
            (list.contactMechTypeEnumId || "CmtEmailAddress") === "CmtEmailAddress" ||
            (withText && list.contactMechTypeEnumId === "CmtTelecomNumber")
        ) ||
        audience.archived(list)
    )
        return null
    const policy = audience.currentPolicy(list.contactListId)
    if (!policy || policy.publicSiteId !== siteId || !audience.offerState(policy).offered) return null
    return {list, policy}
}
// The lists offered on a site for its organization, by name (of email only, unless withText).
function offersOf(siteId, organizationPartyId, withText = false) {
    const ids = [
        ...new Set(
            Array.from(find(POLICY, {publicSiteId: siteId, publicOffer: "Y"}).list())
                .filter(row => lib.active(row))
                .map(row => row.contactListId)
        )
    ]
    return ids
        .map(id => offerOf(id, siteId, organizationPartyId, withText))
        .filter(Boolean)
        .sort((a, b) => String(a.list.contactListName || "").localeCompare(String(b.list.contactListName || "")))
}
// P22: a topic of text messages (a list of phone numbers) is named as one; the email preferences page lets its member leave it, and
// never turns it on (a text message topic is joined with a phone number's own evidence, where it is offered)
const topicView = ({list, policy}) => ({
    contactListId: list.contactListId,
    name: list.contactListName || list.contactListId,
    description: list.description || "",
    channelEnumId: list.contactMechTypeEnumId === "CmtTelecomNumber" ? "MdcSms" : "MdcEmail",
    channelText: list.contactMechTypeEnumId === "CmtTelecomNumber" ? L("Text messages") : L("Email"),
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
    return newPersonOf(address, displayName)
}
// A new person with the name and address typed, never a directory party that has the address: for an address nobody has confirmed
// (a public reservation's buyer and attendees, SEC-PSS-61).
function newPersonOf(address, displayName) {
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

// ===== P17: Register and Registration (reserve, complete, pay, read and cancel a registration) =====
const placesOf = () => ec.resource.script("component://mr-mantle/service/mantle/work/EventRegistrationPlaces.js")
const payments = () => ec.resource.script("component://mr-mantle/service/mantle/work/EventRegistrationPayments.js")
const access = () => ec.resource.script("component://mr-mantle/service/mantle/party/ExternalAccess.js")
const RESERVATION = "mantle.work.registration.EventReservation"
const REG_POLICY = "mantle.work.registration.EventRegistrationPolicy"
const regLimits = {client: 10, site: 500, address: 5, payloadChars: 65536}
// SEC-PSS-88: an offer's reservations a day for one requester and for one buyer address (each up to the ticket's places), and the
// tickets a day for one attendee address, from Mantle's conf (mantle@marketing-reservations-per-offer, -tickets-per-address)
function confLimit(selector, fallback) {
    const value = Number(ec.factory.getConfValue(selector))
    return Number.isFinite(value) && value > 0 ? value : fallback
}
// A refusal of the registration services answered as the page's kind: what the visitor can fix (a value, the hold, the places
// left, changed terms) with its own words; anything about another record the one NotFound.
function asPage(work) {
    try {
        return work()
    } catch (error) {
        if (error?.moquiErrorKind) throw error
        const code = lib.reasonCode(error)
        const words = String(error?.message || error)
            .split("\n")[0]
            .replace(/^(?:Error: )+/, "")
            .replace(/^[A-Z][A-Z0-9_]+(\[[A-Za-z0-9_ ]+\])?: /, "")
        ec.message.clearErrors()
        const field = /^VALUE_INVALID\[([A-Za-z0-9_ ]+)\]/.exec(String(error?.message || "").replace(/^(?:Error: )+/, ""))?.[1]
        if (code === "VALUE_INVALID")
            fail("Unprocessable", "VALUE_INVALID" + (field ? "[" + field.replace(/ /g, "") + "]" : "") + ": " + words)
        if (["HOLD_EXPIRED", "CAPACITY_UNAVAILABLE", "TERMS_CHANGED", "ORDER_PLACED", "PRICE_CHANGED"].includes(code))
            fail("Conflict", code + ": " + words)
        if (["NOT_DUE", "NOT_COMPLETED", "FORM_VALUES_INVALID"].includes(code)) fail("Unprocessable", code + ": " + words)
        if (code === "FIELD_HIDDEN")
            fail("Unprocessable", "Leave unanswered the questions that do not apply to your other answers")
        if (["OPERATION_CONFLICT", "REQUEST_KEY_INVALID", "REQUEST_KEY_REUSED", "FIELD_UNKNOWN", "VALUE_TOO_LONG"].includes(code))
            fail("Unprocessable", "Reload the page and try again")
        if (["PROVIDER_UNAVAILABLE", "TAX_UNAVAILABLE"].includes(code)) fail("Unavailable", words)
        if (["OFFER_UNAVAILABLE", "PUBLICATION_CLOSED", "RECORD_UNAVAILABLE"].includes(code)) unavailable()
        throw error
    }
}
const jsonOf = value =>
    typeof value === "string" ? (value.length > regLimits.payloadChars ? null : lib.json(value, null)) : (value ?? null)
// The reservation a page reaches (scope RegistrationView or RegistrationCancel): by its capability's token, by the signed-in buyer's
// own verified account (the self relationship), or for the provider's return by its reference and key, which read its state alone;
// on this site, of the organization the site serves. {reservation, policy, via}. Anything else the one NotFound.
// A signed-in account whose verified address is the reservation's typed buyer or attendee address claims those people first
// (EventRegistrationClaims.js, SEC-PSS-61), by the token or by the reservation's reference, as Shop claims guest purchases.
const claims = () => ec.resource.script("component://mr-mantle/service/mantle/work/EventRegistrationClaims.js")
// a reservation of this site's offers, claimed by the signed-in account when it may
function claimOn(reservationId, siteId, organizationPartyId) {
    if (!ec.user.userAccount || !reservationId) return
    const found = one(RESERVATION, {reservationId})
    const policy = found ? one(REG_POLICY, {registrationPolicyId: found.registrationPolicyId}) : null
    if (policy && policy.siteId === siteId && policy.organizationPartyId === organizationPartyId) claims().claim(reservationId)
}
function reach(p, scope = "RegistrationView") {
    const organizationPartyId = served(p.siteId)
    let reservationId = null,
        via = null
    if (!blank(p.token)) {
        try {
            reservationId = access().check({token: p.token, scope, recordType: "EventRegistration", organizationPartyId}).recordId
        } catch (error) {
            if (error?.moquiErrorKind !== "NotFound") throw error
            unavailable()
        }
        via = "token"
    } else if (!blank(p.reference) && !blank(p.key)) {
        throttleLookup()
        const row = one(RESERVATION, {reservationId: text(p.reference)})
        if (!row || !row.returnKeyDigest || row.returnKeyDigest !== ec.user.singleUseCodeHash(String(p.key))) unavailable()
        reservationId = row.reservationId
        via = "return"
    } else if (!blank(p.reservationId) && ec.user.userAccount) {
        claimOn(text(p.reservationId), p.siteId, organizationPartyId)
        try {
            reservationId = access().check({
                recordType: "EventRegistration",
                recordId: text(p.reservationId),
                scope,
                organizationPartyId
            }).recordId
        } catch (error) {
            if (error?.moquiErrorKind !== "NotFound") throw error
            unavailable()
        }
        via = "account"
    } else unavailable()
    if (via === "token") claimOn(reservationId, p.siteId, organizationPartyId)
    const reservation = one(RESERVATION, {reservationId})
    const policy = reservation ? one(REG_POLICY, {registrationPolicyId: reservation.registrationPolicyId}) : null
    if (!policy || policy.siteId !== p.siteId || policy.organizationPartyId !== organizationPartyId) unavailable()
    return {reservation, policy, via, organizationPartyId}
}
// A reservation's view for Register and Registration: the event's public facts, its state, each place (attendee, ticket, state), the
// payment and refunds, the terms accepted, what may be done; the questions while it is not completed. Never another attendee's
// answers, an entry code (shown only by showTicket), the order's lines or anything internal. A return's view is its state alone.
function registrationView(reservation, policy, via, extra = {}) {
    const P = placesOf()
    const facts = registrations().publicFacts(policy)
    const state = P.stateOfReservation(reservation, policy)
    const base = {
        reference: reservation.reservationId,
        title: facts.title,
        whenText: facts.whenText,
        state: state.state,
        stateText: L(
            {
                confirmed: "Confirmed",
                pending: "Payment received, awaiting the organizer's confirmation",
                held: state.completed ? "Held: payment due" : "Held: complete your registration",
                waitlisted: "On the waitlist",
                review: "Payment received after the hold ended: the organizer will refund it or offer a place",
                cancelled: "Cancelled",
                expired: "The hold ended"
            }[state.state] || state.state
        ),
        payment: payments().paymentView(reservation.reservationId)
    }
    if (via === "return") return Object.assign(base, {limited: true}, extra)
    const all = P.placesOf(reservation.reservationId)
    const workEffort = one("mantle.work.effort.WorkEffort", {workEffortId: policy.workEffortId})
    const confirmedAny = all.some(row => row.statusId === "EvrConfirmed")
    const publication = !state.completed ? P.questionsOf(policy) : null
    const occurrenceStarted = (facts.startMs ?? Infinity) <= nowMs()
    // what the accepted terms' cancellation rule allows each live place now (follow-up 1)
    const cancelTerms = new Map(
        all.filter(row => P.LIVE_STATES.includes(row.statusId)).map(row => [row.registrationId, P.cancelTermsOf(row, policy)])
    )
    const terms =
        reservation.termsRevision != null
            ? one("mantle.work.registration.EventRegistrationTerms", {
                  registrationPolicyId: policy.registrationPolicyId,
                  termsRevision: Number(reservation.termsRevision)
              })
            : null
    return Object.assign(
        base,
        {
            limited: false,
            organizationName: organizationName(policy.organizationPartyId),
            where: facts.where,
            completed: state.completed,
            paymentDue: state.paymentDue,
            // what is due before Pay (the tickets' prices now, before tax) and its key, which Pay sends back (P17 review)
            ...(state.paymentDue
                ? (() => {
                      const quote = payments().quoteOf(reservation.reservationId, policy)
                      return {amountDueText: payments().quoteText(quote), priceKey: quote ? quote.priceKey : ""}
                  })()
                : {amountDueText: "", priceKey: ""}),
            holdEndsText:
                state.holdEndsMs != null && Number.isFinite(state.holdEndsMs) ? lib.dateText(new Date(state.holdEndsMs)) : "",
            places: all.map(row => ({
                registrationId: row.registrationId,
                // the name typed, never the stored name of the party an address matched (SEC-PSS-41, SEC-PSS-61)
                attendeeName: row.attendeeName || "",
                ticketName: P.ticketName(row.ticketTypeId),
                statusId: row.statusId,
                stateText: L(P.stateTexts[row.statusId] || row.statusId),
                canShowCode: row.statusId === "EvrConfirmed",
                canCancel: !!cancelTerms.get(row.registrationId)?.allowed,
                refundText: row.refundStatusEnumId
                    ? L(
                          {
                              ErfRequested: "Refund requested",
                              ErfPending: "Refund pending",
                              ErfRefunded: "Refunded",
                              ErfFailed: "Refund pending with the organizer",
                              ErfNone: "Nothing to refund"
                          }[row.refundStatusEnumId] || ""
                      )
                    : ""
            })),
            // the link to join goes to confirmed registrants only, never to a pending or waitlisted place
            joinUrl: confirmedAny && workEffort?.infoUrl ? workEffort.infoUrl : null,
            canCancel: !occurrenceStarted && [...cancelTerms.values()].some(decision => decision.allowed),
            cancellationTerms: (terms ? terms.cancellationTerms : policy.cancellationTerms) || "",
            // the rule in words: the accepted revision's once completed, else the offer's now (which completing accepts)
            cancelRule: registrations().cancelRuleText(terms || policy),
            termsAccepted: terms ? terms.termsText || "" : "",
            // while it is not completed: the terms to accept and the questions (each attendee's or the buyer's once)
            terms: !state.completed ? policy.termsText || "" : "",
            consentText: !state.completed ? policy.consentText || "" : "",
            termsRevision: Number(policy.termsRevision || 0),
            needsTerms: !state.completed && P.hasTerms(policy),
            questionScope: policy.questionScopeEnumId === "ErqBuyer" ? "buyer" : "attendee",
            fields: publication ? publications().pageFields(publication.formId) : []
        },
        extra
    )
}
// The party a public reservation's buyer is (SEC-PSS-61, the owner's decision of Nov 16, 2026): a signed-in visitor's own party when
// the address typed is their account's verified address and the account reaches its own records (ExternalAccess selfOf, the
// account's way back to the reservation); anyone else a new person with the name and address typed, never the directory party
// that has the address, which an unconfirmed address would hand the reservation, its order and its capability.
function buyerOf(address, name) {
    const account = ec.user.userAccount
    const own =
        account?.partyId &&
        String(account.emailAddress || "")
            .trim()
            .toLowerCase() === address &&
        access().selfOf(account.partyId)
    if (!own) return newPersonOf(address, name)
    const cf = ec.entity.conditionFactory
    const info = find("mantle.party.contact.PartyContactMechInfo")
        .condition("partyId", account.partyId)
        .condition("contactMechTypeEnumId", "CmtEmailAddress")
        .condition(cf.makeCondition("infoString", "equals", address, false, true))
        .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
        .orderBy("contactMechId")
        .one()
    return {partyId: account.partyId, contactMechId: info?.contactMechId || null}
}
// reserveRegistration: places asked of a published, open offer on this site for a buyer (a name and an address), held or waitlisted
// together, or refused when there are not enough; PASS's request key answers a repeat with the first. A request past the client's,
// site's or address's limit is refused alike and holds nothing. The reservation's capability (view and cancel) is answered once.
function reserveRegistration(p) {
    const organizationPartyId = served(p.siteId)
    const offer = registrations().publicView(p.registrationPolicyId, p.siteId, organizationPartyId)
    if (!offer || !offer.registrationOpen) unavailable()
    const operationId = String(p.operationId || "")
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(operationId)) fail("Unprocessable", "Reload the page and try again")
    const buyer = asPage(() => placesOf().personInput({name: p.buyerName, email: p.buyerEmail}, "buyer", true))
    const policyId = String(p.registrationPolicyId)
    const earlier = one(RESERVATION, {registrationPolicyId: policyId, requestKey: operationId})
    if (!earlier) {
        if (
            !allowed("mkt-reg-client:" + requester(), regLimits.client, MINUTES_10) ||
            !allowed("mkt-reg-site:" + p.siteId, regLimits.site, HOUR) ||
            !allowed("mkt-reg-address:" + addressKey(buyer.address), regLimits.address, HOUR)
        )
            fail("Tarpit", "RATE_LIMITED: Too many registrations from here. Wait a few minutes and try again.")
        const perOffer = confLimit("mantle@marketing-reservations-per-offer", 20)
        if (
            !allowed("mkt-reg-offer:" + policyId + ":" + requester(), perOffer, DAY) ||
            !allowed("mkt-reg-offer-address:" + policyId + ":" + addressKey(buyer.address), perOffer, DAY)
        )
            fail("Tarpit", "RATE_LIMITED: You have made as many registrations for this event as one person may today.")
    }
    const lines = jsonOf(p.lines)
    if (!Array.isArray(lines)) fail("Unprocessable", "VALUE_INVALID[lines]: Choose at least one place")
    const party = earlier
        ? {partyId: earlier.buyerPartyId, contactMechId: earlier.emailContactMechId}
        : apart("Error making the buyer", () => buyerOf(buyer.address, buyer.name))
    const out = asPage(() =>
        placesOf().reserve({
            registrationPolicyId: policyId,
            lines,
            buyer: Object.assign({}, party, {name: buyer.name}),
            requestKey: operationId,
            sourceEnumId: "ErsPublic",
            siteId: p.siteId
        })
    )
    const reservation = one(RESERVATION, {reservationId: out.reservationId})
    const policy = one(REG_POLICY, {registrationPolicyId: policyId})
    // the capability once, to the request that made the reservation (a repeat gets none: the first page keeps it)
    const made = out.replay
        ? null
        : access().create({
              recordType: "EventRegistration",
              recordId: reservation.reservationId,
              scopes: ["RegistrationView", "RegistrationCancel"],
              validDays: 366
          })
    return {
        registration: registrationView(reservation, policy, "token", {buyerName: buyer.name}),
        token: made ? made.token : null,
        replay: out.replay
    }
}
// completeRegistration: the attendees, the answers and the terms of a reservation the capability reaches.
function completeRegistration(p) {
    const {reservation, policy, via} = reach(p)
    if (via === "return") unavailable()
    const attendees = jsonOf(p.attendees)
    const answers = jsonOf(p.answers)
    if ((p.attendees != null && !Array.isArray(attendees)) || (p.answers != null && !Array.isArray(answers)))
        fail("Unprocessable", "Reload the page and try again")
    // each typed attendee address is mailed a ticket: a bounded number a day for one address (SEC-PSS-88), counted once, when
    // the reservation is completed
    if (!reservation.completedDate) {
        const perAddress = confLimit("mantle@marketing-tickets-per-address", 10)
        const addresses = new Set(
            (attendees || [])
                .map(attendee => String(attendee?.email || "").trim().toLowerCase())
                .filter(Boolean)
        )
        for (const address of addresses)
            if (!allowed("mkt-reg-ticket:" + addressKey(address), perAddress, DAY))
                fail("Tarpit", "RATE_LIMITED: An attendee's address has been sent as many tickets as it may today.")
    }
    asPage(() =>
        placesOf().complete(reservation, {
            attendees: attendees || [],
            answers: answers || [],
            acceptTerms: yes(p.acceptTerms),
            termsRevision: p.termsRevision,
            requestKey: p.operationId,
            // the attendees' addresses are typed, not confirmed: each a new person (SEC-PSS-61)
            typedAddresses: true
        })
    )
    return {registration: registrationView(one(RESERVATION, {reservationId: reservation.reservationId}), policy, via)}
}
// startRegistrationPayment: the hosted payment step for a completed reservation's held places (the provider's page or form); a
// repeat answers the same attempt, never a second charge or seat.
function startRegistrationPayment(p) {
    const {reservation, policy, via} = reach(p)
    if (via === "return") unavailable()
    // the price the page showed (registrationView's priceKey): a change since is refused with the new amount (P17 review)
    const priceKey = String(p.priceKey || "")
    if (!/^[A-Za-z0-9]{8,64}$/.test(priceKey)) fail("Unprocessable", "Reload the page and try again")
    // follow-up 5: the frontend's visitor key, whose digest the ticket order keeps only where Marketing allows it
    const out = asPage(() => payments().startPayment(reservation.reservationId, priceKey, p.visitorKey))
    delete out.returnKey
    return {
        registration: registrationView(one(RESERVATION, {reservationId: reservation.reservationId}), policy, via),
        payment: out
    }
}
// getRegistrationPaymentForm (the user's call, Nov 15): for a pending payment whose provider page takes a posted form token (Accept
// Hosted), the page's address and a fresh token for Register's relay to post at once; by the capability or the buyer's account
// only (never the return key), while its places are held. Nothing confirms from it: the provider's return reads the state and the
// verified result decides.
function getRegistrationPaymentForm(p) {
    const {reservation, policy, via} = reach(p)
    if (via === "return") unavailable()
    const form = asPage(() => payments().paymentForm(reservation.reservationId, organizationName(policy.organizationPartyId)))
    return {form}
}
// getRegistration: the reservation's state with its payment looked up (bounded) and its order placed once paid; showTicket (with a
// fresh operationId) shows one confirmed place's entry code with its QR: the code of its current revision, the same each time
// (follow-up 1), the showing recorded.
function getRegistration(p) {
    const {reservation, policy, via} = reach(p)
    if (reservation.paymentId) payments().refresh(reservation.reservationId, yes(p.returned) ? "return" : "page")
    const fresh = one(RESERVATION, {reservationId: reservation.reservationId})
    let ticket = null
    if (!blank(p.showTicket) && via !== "return") {
        const operationId = String(p.operationId || "")
        if (!/^[A-Za-z0-9_-]{8,64}$/.test(operationId)) fail("Unprocessable", "Reload the page and try again")
        const row = one("mantle.work.registration.EventRegistration", {registrationId: text(p.showTicket)})
        if (!row || row.reservationId !== fresh.reservationId || row.statusId !== "EvrConfirmed") unavailable()
        if (
            find("mantle.work.registration.EventRegistrationAction", {
                registrationId: row.registrationId,
                operationKey: operationId
            }).count()
        )
            fail("Unprocessable", "Reload the page to show the code again")
        const issued = placesOf().issueCode(row.registrationId, "EraTicketShown", operationId)
        if (issued)
            ticket = {
                registrationId: row.registrationId,
                code: issued.code,
                qrSvg: ec.resource.barcodeSvg("QR", issued.code, {moduleWidth: 1.2}) || ""
            }
    }
    return {registration: registrationView(fresh, policy, via, ticket ? {ticket} : {})}
}
// cancelRegistration: the buyer's cancellation of the reservation's live places (or the ones named) before the occurrence starts,
// confirmed and with PASS's request key, as the cancellation rule of the accepted terms allows (follow-up 1): a confirmed place until
// the rule's deadline for its refund percentage, after it with no refund where the rule allows that, else not online; a place never
// confirmed in full. Each seat released once, a paid place's refund handed to Accounting and shown pending. When none of the places
// may be cancelled online, CANCELLATION_CLOSED and nothing changes.
function cancelRegistrationPublic(p) {
    const {reservation, policy, via} = reach(p, "RegistrationCancel")
    if (via === "return") unavailable()
    const operationId = String(p.operationId || "")
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(operationId)) fail("Unprocessable", "Reload the page and try again")
    if (!yes(p.confirm)) fail("Unprocessable", "VALUE_INVALID[confirm]: Confirm that you want to cancel")
    const facts = registrations().publicFacts(policy)
    if ((facts.startMs ?? Infinity) <= nowMs())
        fail("Conflict", "CANCELLATION_CLOSED: The event has started; contact the organizer")
    const named = listOf(p.registrationIds)
    const live = placesOf()
        .placesOf(reservation.reservationId)
        .filter(row => placesOf().LIVE_STATES.includes(row.statusId) && (!named.length || named.includes(row.registrationId)))
    const reason = String(p.reason || "")
        .trim()
        .slice(0, 200)
    const decisions = new Map(live.map(row => [row.registrationId, placesOf().cancelTermsOf(row, policy)]))
    const allowed = live.filter(row => decisions.get(row.registrationId).allowed)
    if (live.length && (!allowed.length || (named.length && allowed.length < live.length)))
        fail("Conflict", "CANCELLATION_CLOSED: The cancellation deadline has passed; contact the organizer")
    if (allowed.length)
        placesOf().cancelPlaces(
            allowed.map(row => row.registrationId),
            "Cancelled by the buyer" + (reason ? ": " + reason : ""),
            null,
            // the percentage the rule gave when the buyer asked (decided before the lock, at the same moment)
            row => decisions.get(row.registrationId)?.refundPercent ?? 100
        )
    return {registration: registrationView(one(RESERVATION, {reservationId: reservation.reservationId}), policy, via)}
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
    // P22 review: its text message topics too, to leave (changeTopics still takes lists of email only)
    const offers = offersOf(siteId, organizationPartyId, true)
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
    getEvent,
    reserveRegistration,
    completeRegistration,
    startRegistrationPayment,
    getRegistrationPaymentForm,
    getRegistration,
    cancelRegistration: cancelRegistrationPublic
}
const internalOperations = new Set(["appReadiness", "buildVerification", "attemptVerification", "fileCheckout"])
;({
    served,
    subscriberOf,
    newPersonOf,
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
