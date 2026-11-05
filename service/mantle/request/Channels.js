// Support channels (design-customer-service §3 ChannelSessions, §9 ChannelRouting, CaseDetail's Reply publicly in forum;
// impl-customer-service P6, CS-CHANNELS, F10, F11, F12, F61, F62, F79, F84; SupportChannelEntities.xml). How mail, a queue's
// public form, the forum and chat reach a service queue, each on the case rule of SupportCases.js (a request from a customer
// the organization serves, or its contact, in one of its queues is a case; F62, F79), with the queue's ServiceRoute saying
// what arrives (type, priority, the unknown-sender and automatic-mail policies, the acknowledgement and its text).
// - Mail: the Comms rule ErActCreateRequest's value names the queue (create#RequestFromEmail calls mailIntake). A message
//   joins the request its verified message references name (In-Reply-To, References, the thread), else the case its
//   subject's token names ([Request 123]) when the sender is that case's customer or contact; never a guessed id for another
//   sender. An automatic message (Auto-Submitted other than no, Precedence bulk, junk, list or auto_reply, X-Autoreply) is
//   ignored or attached to its case only, per route, never a case and never acknowledged. A new message from a customer's
//   address is a case, timed by its received date (the profile's intake time, the clocks' start: F84); from staff, from a
//   party that is no customer, or from an unknown address it is held for review (a plain request in the queue, no Customer
//   party), or ignored when the route's (else the policy's) unknown-sender rule says so. A new case is acknowledged once,
//   through send#IntakeConfirmation with the route's text block, and the acknowledgement is never a response (P4).
// - The public form: the queue's intake token is an ExternalAccessCapability on its RequestCategory (the RequestCategory
//   kind of ExternalAccess.js, scope CaseIntake, no outside party: F61); create#IntakeRequest takes it, with its limits per
//   queue. The form page is the Support app's (P15); Projects' /r/<token> stays a project's.
// - The forum: a route from a PASS site and category to a queue, type and template; create#CaseFromTopic files a Submitted
//   case there on channel ScForum (F12).
// - Calls: log#CaseCall records a call on a case (a Phone event; an internal one or one that reached no one is no response).
// - Held requests: review#HeldRequest makes a held request a case (its sender a customer) or dismisses it.
// Every operation checks its own permission and organization; the intake paths run for the mail rules, the form and the
// forum with no user permission, as their Mantle services always have. Refusals carry reason codes (EntityLib.denied).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const cases = ec.resource.script("component://mr-mantle/service/mantle/request/SupportCases.js")
const {find, one, rows, call, denied, access, ms} = lib

const ROUTE = "mantle.request.support.ServiceRoute",
    REQUEST = "mantle.request.Request",
    PARTY = "mantle.request.RequestParty",
    CATEGORY = "mantle.request.RequestCategory",
    PROFILE = "mantle.request.support.CaseProfile",
    MESSAGE = "moqui.basic.email.EmailMessage",
    REQUEST_MAIL = "mantle.request.RequestEmailMessage",
    COMM = "mantle.party.communication.CommunicationEvent",
    R = "mantle.request.RequestServices."
const routeChannels = ["SrcEmail", "SrcWebForm", "SrcForum", "SrcChat"]
const autoPolicies = ["SagAttach", "SagIgnore"]
const unknownPolicies = ["SusReview", "SusIgnore"]
const callOutcomes = ["CcoReached", "CcoFollowUp", "CcoNoAnswer", "CcoVoicemail"]
const intakeScope = "CaseIntake"
const formHourlyLimit = 30
const addressHourlyLimit = 5

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const truthy = value => value === true || value === "Y" || value === "true"
const now = () => ec.user.nowTimestamp
const L = words => ec.l10n.localize(words)
const listOf = value =>
    value == null
        ? []
        : (typeof value === "string" ? value.split(",") : Array.from(value))
              .map(String)
              .map(s => s.trim())
              .filter(Boolean)
const plain = html =>
    String(html || "")
        .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n\n")
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .trim()
const escape = words =>
    String(words == null ? "" : words)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")

// ===== routes =====
// The routes in effect of a queue and channel, or of an organization (every queue), the latest first.
const currentRoutes = (conditions, date) => cases.currentRows(ROUTE, conditions, date)
// The route a message, form, chat or topic arrives by: for mail the queue's row for the account, else its row for any account.
function routeFor(channelEnumId, requestCategoryId, emailAccountId) {
    if (!requestCategoryId) return null
    const found = currentRoutes({channelEnumId, requestCategoryId})
    if (channelEnumId === "SrcEmail")
        return (
            found.find(row => emailAccountId && row.emailAccountId === emailAccountId) ||
            found.find(row => !row.emailAccountId) ||
            null
        )
    return found[0] || null
}
// The forum route of a PASS site's category: the one naming the category, else the site's route for any category.
function forumRoute(siteId, forumContactListId) {
    if (!siteId) return null
    const found = currentRoutes({channelEnumId: "SrcForum", siteId}).filter(row => cases.queueOf(row.requestCategoryId))
    return (
        found.find(row => forumContactListId && row.forumContactListId === forumContactListId) ||
        found.find(row => !row.forumContactListId) ||
        null
    )
}
// The queue a mail rule's value names: a service queue (a RequestCategory with an owner and a current ServiceQueue row) that
// is not a project's id; a project keeps Projects' intake (impl-projects F6).
function queueOfValue(value) {
    const id = text(value)
    if (!id) return null
    const project = one("mantle.work.effort.WorkEffort", {workEffortId: id})
    if (project?.workEffortTypeEnumId === "WetProject") return null
    return cases.queueOf(id) ? id : null
}
function routeKey(row) {
    return [
        row.channelEnumId,
        row.requestCategoryId,
        row.emailAccountId || "",
        row.siteId || "",
        row.forumContactListId || ""
    ].join("|")
}

// save#ServiceRoute (design ChannelRouting RouteEdit): a queue's route from its date, ending the route it replaces (the same
// channel, queue and account, or site and category); with end, ends it. Needs SUPPORT_POLICY_EDIT and the queue's organization.
function saveRoute(p) {
    cases.requirePermission("SUPPORT_POLICY_EDIT")
    const existing = p.serviceRouteId ? one(ROUTE, {serviceRouteId: p.serviceRouteId}) : null
    if (p.serviceRouteId && !existing) denied("ROUTE_UNAVAILABLE", "Route " + p.serviceRouteId + " is not available")
    const requestCategoryId = text(p.requestCategoryId) || existing?.requestCategoryId
    const queue = cases.queueOf(requestCategoryId)
    if (!queue) denied("QUEUE_UNAVAILABLE", "Choose a service queue")
    const organizationPartyId = cases.requireOrganization(queue.organizationPartyId)
    if (existing && existing.organizationPartyId !== organizationPartyId)
        denied("ROUTE_UNAVAILABLE", "Route " + p.serviceRouteId + " is not available")
    const fromDate = p.fromDate || now()
    if (truthy(p.end)) {
        if (!existing) denied("ROUTE_UNAVAILABLE", "Choose the route to end")
        existing.set("thruDate", fromDate)
        existing.set("changeReason", text(p.changeReason))
        existing.update()
        return {serviceRouteId: existing.serviceRouteId}
    }
    const channelEnumId = text(p.channelEnumId) || existing?.channelEnumId
    if (!routeChannels.includes(channelEnumId))
        denied("CHANNEL_INVALID", "Choose the channel: mail, the public form, the forum or chat")
    const values = {
        organizationPartyId,
        channelEnumId,
        requestCategoryId,
        emailAccountId: null,
        siteId: null,
        forumContactListId: null
    }
    if (channelEnumId === "SrcEmail" && text(p.emailAccountId)) {
        const account = one("moqui.basic.email.EmailAccount", {emailAccountId: p.emailAccountId})
        if (!account || account.statusId === "EasRemoved")
            denied("ACCOUNT_UNAVAILABLE", "Mail account " + p.emailAccountId + " is not available")
        values.emailAccountId = account.emailAccountId
    }
    if (channelEnumId === "SrcForum") {
        const site = text(p.siteId) ? one("mantle.public.PublicSite", {siteId: p.siteId}) : null
        if (!site) denied("SITE_REQUIRED", "Choose the forum's site")
        values.siteId = site.siteId
        if (text(p.forumContactListId)) {
            const category = one("mantle.forum.ForumCategory", {contactListId: p.forumContactListId})
            if (!category || category.siteId !== site.siteId)
                denied("FORUM_CATEGORY_UNAVAILABLE", "Choose a forum category of the site")
            values.forumContactListId = category.contactListId
        }
        // one queue per site and category: another queue's route for it is refused
        const clash = currentRoutes({channelEnumId: "SrcForum", siteId: site.siteId}).find(
            row =>
                (row.forumContactListId || "") === (values.forumContactListId || "") &&
                row.requestCategoryId !== requestCategoryId &&
                row.serviceRouteId !== existing?.serviceRouteId
        )
        if (clash)
            denied(
                "ROUTE_EXISTS",
                "The forum category already files into " +
                    (one(CATEGORY, {requestCategoryId: clash.requestCategoryId})?.description || clash.requestCategoryId)
            )
    }
    const typeId = text(p.requestTypeEnumId)
    if (typeId) {
        if (one("moqui.basic.Enumeration", {enumId: typeId})?.enumTypeId !== "RequestType")
            denied("TYPE_UNKNOWN", typeId + " is not a request type")
        const offered = listOf(queue.queue.offeredTypeEnumIds)
        if (offered.length && !offered.includes(typeId))
            denied(
                "TYPE_NOT_OFFERED",
                "The queue " + (queue.category.description || requestCategoryId) + " does not take this type"
            )
    }
    const priority = blank(p.defaultPriority) ? null : Number(p.defaultPriority)
    if (priority != null && !(priority >= 1 && priority <= 9))
        denied("PRIORITY_INVALID", "A priority is 1 (highest) to 9 (lowest)")
    const unknownSenderEnumId = text(p.unknownSenderEnumId)
    if (unknownSenderEnumId && !unknownPolicies.includes(unknownSenderEnumId))
        denied("SENDER_POLICY_INVALID", unknownSenderEnumId + " is not an unknown-sender rule")
    const autoGeneratedEnumId = text(p.autoGeneratedEnumId) || "SagAttach"
    if (!autoPolicies.includes(autoGeneratedEnumId))
        denied("AUTO_POLICY_INVALID", autoGeneratedEnumId + " is not an automatic-mail rule")
    const ackTextBlockId = text(p.ackTextBlockId)
    if (ackTextBlockId && !one("moqui.basic.email.EmailTextBlock", {emailTextBlockId: ackTextBlockId}))
        denied("TEXT_BLOCK_UNAVAILABLE", "Text block " + ackTextBlockId + " is not available")
    const replyEmailIdentityId = text(p.replyEmailIdentityId)
    if (replyEmailIdentityId) {
        const identity = one("moqui.basic.email.EmailIdentity", {emailIdentityId: replyEmailIdentityId})
        if (!identity || (values.emailAccountId && identity.emailAccountId !== values.emailAccountId))
            denied("IDENTITY_UNAVAILABLE", "Choose an identity of the route's mail account")
    }
    const count = (value, max, code) => {
        if (blank(value)) return null
        const number = Math.floor(Number(value))
        if (!(number >= 1 && number <= max)) denied(code, "Choose a number from 1 to " + max)
        return number
    }
    Object.assign(values, {
        requestTypeEnumId: typeId,
        templateFormId: text(p.templateFormId),
        defaultPriority: priority,
        unknownSenderEnumId,
        autoGeneratedEnumId,
        acknowledge: truthy(p.acknowledge) ? "Y" : "N",
        ackTextBlockId,
        replyEmailIdentityId,
        rateLimitPerHour: count(p.rateLimitPerHour, 1000, "RATE_LIMIT_INVALID"),
        tokenValidDays: count(p.tokenValidDays, 366, "TOKEN_DAYS_INVALID"),
        changeReason: text(p.changeReason)
    })
    // the row it replaces: the one named, and any other in effect with the same channel, queue and account or site and category
    const key = routeKey(values)
    for (const row of currentRoutes({channelEnumId, requestCategoryId}, fromDate))
        if (row.serviceRouteId === existing?.serviceRouteId || routeKey(row) === key) {
            row.set("thruDate", fromDate)
            row.update()
        }
    const out = call("create#" + ROUTE, Object.assign(values, {fromDate, thruDate: p.thruDate || null}))
    return {serviceRouteId: out.serviceRouteId}
}

// ===== mail =====
function headerValue(headers, name) {
    let found = null
    for (const line of String(headers || "").split(/\r?\n/)) {
        if (found != null) {
            if (/^[ \t]/.test(line)) {
                found += " " + line.trim()
                continue
            }
            break
        }
        const colon = line.indexOf(":")
        if (colon > 0 && line.substring(0, colon).trim().toLowerCase() === name.toLowerCase())
            found = line.substring(colon + 1).trim()
    }
    return found
}
const SYSTEM_SENDER = /^(mailer-daemon|postmaster|no[-_.]?reply|do[-_.]?not[-_.]?reply|bounces?)([+@-]|$)/i
// Why a message is automatic (an autoresponder's, a list's, a bounce), or null for a person's.
function automaticReason(message) {
    const headers = message.headersString
    for (const name of ["X-Autoreply", "X-Autorespond"]) if (headerValue(headers, name) != null) return "the mail has " + name
    const submitted = String(headerValue(headers, "Auto-Submitted") || "").toLowerCase()
    if (submitted && submitted !== "no") return "the mail has Auto-Submitted: " + submitted
    const precedence = String(headerValue(headers, "Precedence") || "").toLowerCase()
    if (["bulk", "junk", "list", "auto_reply"].includes(precedence)) return "the mail has Precedence: " + precedence
    if (SYSTEM_SENDER.test(String(message.fromAddress || "").trim())) return "a system sender"
    return null
}
// The party of an address: a user account's party first, else a person or organization with the address in effect, not
// disabled and not anyone's personal contact; null for an unknown address.
function partyOfAddress(address) {
    const email = String(address || "")
        .trim()
        .toLowerCase()
    if (!email.includes("@")) return null
    const user = rows("moqui.security.UserAccount", {emailAddress: email}).find(row => row.partyId)
    const infos = Array.from(
        find("mantle.party.contact.PartyContactMechInfo", {infoString: email}).conditionDate("fromDate", "thruDate", now()).list()
    )
    if (user?.partyId) {
        const own = infos.find(info => info.partyId === user.partyId)
        return {partyId: user.partyId, contactMechId: own?.contactMechId || null}
    }
    for (const info of infos) {
        const party = one("mantle.party.PartyDetail", {partyId: info.partyId})
        if (!party || party.disabled === "Y" || party.privateOwnerUserId) continue
        return {partyId: info.partyId, contactMechId: info.contactMechId}
    }
    return null
}
// Who a sender is to the organization: a customer it serves (or a contact of one: the customer is the case's), staff (an
// internal party, or one who works for an internal organization), another known party, or unknown.
function senderOf(address, organizationPartyId) {
    const found = partyOfAddress(address)
    if (!found) return {kind: "unknown", address: text(address)}
    const partyId = found.partyId
    if (cases.isInternal(partyId) || cases.organizationsOf(partyId).length) return Object.assign({kind: "staff"}, found)
    const served = cases.customerSidesOf(partyId).filter(id => cases.servedCustomer(id, organizationPartyId))
    if (served.length)
        return Object.assign({kind: "customer", customerPartyId: served.includes(partyId) ? partyId : served[0]}, found)
    return Object.assign({kind: "other"}, found)
}
// The request a message answers by its verified references: a message its In-Reply-To or References name, its parent or its
// thread's first message is on a request (as find#EmailRequest).
function referencedRequest(message) {
    const ids = new Set(
        [message.parentEmailMessageId, message.rootEmailMessageId].filter(id => id && id !== message.emailMessageId)
    )
    const referenced = String(message.inReplyTo || "")
        .split(/\s+/)
        .concat(String(message.referencesHeader || "").split(/\s+/))
        .map(id => id.trim())
        .filter(id => /^<[^<>\s]+>$/.test(id))
    if (referenced.length)
        for (const row of find(MESSAGE)
            .condition("messageId", "in", Array.from(new Set(referenced)).slice(0, 50))
            .selectField("emailMessageId")
            .list())
            if (row.emailMessageId !== message.emailMessageId) ids.add(row.emailMessageId)
    if (!ids.size) return null
    const link = Array.from(find(REQUEST_MAIL).condition("emailMessageId", "in", Array.from(ids)).list())[0]
    return link && one(REQUEST, {requestId: link.requestId}) ? link.requestId : null
}
// The case a subject's token names ([Request 123], [Case 123]), only for a sender who is that case's customer, reporter or a
// contact of its customer, and only a case of the organization: a guessed id authorizes no one.
function tokenCase(subject, sender, organizationPartyId) {
    const match = /\[(?:Case|Request)\s+([A-Za-z0-9_-]{1,40})\]/i.exec(String(subject || ""))
    if (!match || !sender?.partyId) return null
    const requestId = match[1]
    if (!one(PROFILE, {requestId})) return null
    const parties = cases.currentRows(PARTY, {requestId})
    if (!parties.some(row => row.roleTypeId === "OrgInternal" && row.partyId === organizationPartyId)) return null
    const customerPartyId = parties.find(row => row.roleTypeId === "Customer")?.partyId
    const verified =
        parties.some(row => ["Customer", "Reporter"].includes(row.roleTypeId) && row.partyId === sender.partyId) ||
        (customerPartyId && cases.customerSidesOf(sender.partyId).includes(customerPartyId))
    return verified ? requestId : null
}
// What a message to a queue makes, as decided before anything is written (mailIntake applies it; preview#ServiceRoute shows
// it): join (the request its thread or verified token names), case (a customer's), held (for review) or ignore, with why.
function resolveMail(message, queue, route) {
    const organizationPartyId = queue.organizationPartyId
    const automatic = automaticReason(message)
    const autoPolicy = route?.autoGeneratedEnumId || "SagAttach"
    const sender = senderOf(message.fromAddress, organizationPartyId)
    const decision = {automatic, autoPolicy, sender, organizationPartyId, requestCategoryId: queue.category.requestCategoryId}
    if (automatic && autoPolicy === "SagIgnore")
        return Object.assign(decision, {action: "ignore", reason: "An automatic message, ignored by the route: " + automatic})
    const referenced = referencedRequest(message)
    if (referenced) return Object.assign(decision, {action: "join", requestId: referenced, threadBy: "reference"})
    const token = tokenCase(message.subject, sender, organizationPartyId)
    if (token) return Object.assign(decision, {action: "join", requestId: token, threadBy: "token"})
    if (automatic)
        return Object.assign(decision, {action: "ignore", reason: "An automatic message on no case, made nothing: " + automatic})
    if (sender.kind === "customer") return Object.assign(decision, {action: "case", customerPartyId: sender.customerPartyId})
    if (sender.kind === "unknown") {
        const policy = route?.unknownSenderEnumId || cases.policyOf(organizationPartyId)?.unknownSenderEnumId || "SusReview"
        if (policy === "SusIgnore")
            return Object.assign(decision, {action: "ignore", reason: "An unknown sender, ignored by the policy"})
        return Object.assign(decision, {action: "held", reason: "An unknown sender: held for review"})
    }
    return Object.assign(decision, {
        action: "held",
        reason:
            sender.kind === "staff"
                ? "From staff: held for review, not a case"
                : "From a party that is no customer: held for review"
    })
}
// Whether a rule may file into the queue: the route names the rule's account, or the rule's owner works for the queue's
// organization (as a project takes only its intake account or a rule owner on the project).
function mayFile(route, emailAccountId, ruleOwnerUserId, organizationPartyId) {
    if (route?.emailAccountId && route.emailAccountId === emailAccountId) return true
    const ownerPartyId = ruleOwnerUserId ? one("moqui.security.UserAccount", {userId: ruleOwnerUserId})?.partyId : null
    if (ownerPartyId && cases.organizationsOf(ownerPartyId).includes(organizationPartyId)) return true
    const account = emailAccountId ? one("moqui.basic.email.EmailAccount", {emailAccountId}) : null
    const accountOwner = account?.ownerUserId ? one("moqui.security.UserAccount", {userId: account.ownerUserId})?.partyId : null
    return !!accountOwner && cases.organizationsOf(accountOwner).includes(organizationPartyId)
}
// A person for an unknown address held for review: no Customer role, so the request is no case until an agent accepts it.
function reviewPerson(message) {
    const address = String(message.fromAddress || "")
        .trim()
        .toLowerCase()
    const name =
        String(message.fromName || "")
            .replace(/["']/g, "")
            .trim() || address.split("@")[0]
    const parts = name.split(/\s+/)
    const firstName = parts.length > 1 ? parts.slice(0, -1).join(" ") : parts[0]
    const lastName = parts.length > 1 ? parts[parts.length - 1] : "@" + address.split("@")[1]
    const partyId = call("mantle.party.PartyServices.create#Person", {
        firstName: firstName.substring(0, 60),
        lastName: lastName.substring(0, 60)
    }).partyId
    const contactMechId = call("mantle.party.ContactServices.create#EmailAddress", {
        partyId,
        emailAddress: address,
        contactMechPurposeId: "EmailPrimary"
    }).contactMechId
    return {partyId, contactMechId}
}
function noteHeld(requestId, reason) {
    call("create#mantle.request.RequestNote", {requestId, noteDate: now(), noteText: L("Held for review") + ": " + L(reason)})
}
function recordRouteError(route, error) {
    if (!route) return
    try {
        ec.service
            .sync()
            .name("update#" + ROUTE)
            .parameters({
                serviceRouteId: route.serviceRouteId,
                lastErrorText: String(error).substring(0, 255),
                lastErrorDate: now()
            })
            .requireNewTransaction(true)
            .call()
    } catch (failure) {
        ec.logger.error("Route " + route.serviceRouteId + ": its last error was not kept: " + failure)
    }
}
// mailIntake: create#RequestFromEmail for a rule whose value names a queue. handled false: the rule may not file into the
// queue, and create#RequestFromEmail goes on as for no project.
function mailIntake(p) {
    const message = one(MESSAGE, {emailMessageId: p.emailMessageId})
    const queue = cases.queueOf(p.requestCategoryId)
    if (!message || !queue) return {handled: false}
    const emailAccountId = p.emailAccountId || message.emailAccountId || null
    const route = routeFor("SrcEmail", p.requestCategoryId, emailAccountId)
    if (!mayFile(route, emailAccountId, p.ruleOwnerUserId, queue.organizationPartyId)) {
        ec.logger.warn(
            "Email " +
                p.emailMessageId +
                ": the rule of " +
                (p.ruleOwnerUserId || "nobody") +
                " on account " +
                emailAccountId +
                " may not file into queue " +
                p.requestCategoryId
        )
        return {handled: false}
    }
    const decision = resolveMail(message, queue, route)
    const result = {
        handled: true,
        action: decision.action,
        requestId: null,
        created: false,
        joined: false,
        held: false,
        reason: decision.reason || null
    }
    try {
        if (decision.action === "ignore") {
            ec.logger.info("Email " + p.emailMessageId + " to queue " + p.requestCategoryId + ": " + decision.reason)
            return result
        }
        if (decision.action === "join") {
            call(R + "file#RequestEmail", {
                requestId: decision.requestId,
                emailMessageId: p.emailMessageId,
                automatic: !!decision.automatic
            })
            return Object.assign(result, {requestId: decision.requestId, joined: true})
        }
        const sender = decision.sender.partyId ? decision.sender : reviewPerson(message)
        const typeId = route?.requestTypeEnumId || listOf(queue.queue.offeredTypeEnumIds)[0] || "RqtSupport"
        const created = call(R + "create#Request", {
            requestName:
                String(message.subject || "")
                    .trim()
                    .substring(0, 255) || L("(no subject)"),
            description: String(message.bodyText || plain(message.body))
                .trim()
                .substring(0, 20000),
            statusId: "ReqSubmitted",
            requestTypeEnumId: typeId,
            requestCategoryId: p.requestCategoryId,
            priority: route?.defaultPriority ?? 5,
            salesChannelEnumId: "ScEmail",
            requestDate: message.receivedDate || message.messageDate || now(),
            filedByPartyId: sender.partyId,
            customerPartyId: decision.action === "case" ? decision.customerPartyId : null,
            emailContactMechId: sender.contactMechId || null
        })
        const requestId = created.requestId
        call(R + "file#RequestEmail", {requestId, emailMessageId: p.emailMessageId})
        if (decision.action === "held") {
            noteHeld(requestId, decision.reason)
            return Object.assign(result, {requestId, created: true, held: true})
        }
        // one acknowledgement of a new case, from the message's account, in its thread (never for a reply, a held or an
        // automatic message)
        if (route?.acknowledge === "Y" && emailAccountId)
            call(R + "send#IntakeConfirmation", {
                requestId,
                emailAccountId,
                parentEmailMessageId: p.emailMessageId,
                emailTextBlockId: route.ackTextBlockId || null,
                emailIdentityId: route.replyEmailIdentityId || null
            })
        return Object.assign(result, {requestId, created: true})
    } catch (error) {
        recordRouteError(route, error?.message || error)
        throw error
    }
}

// preview#ServiceRoute (design ChannelRouting RouteTest): what a message to the queue would make, written nowhere.
function previewRoute(p) {
    if (!access.has("SUPPORT_POLICY_EDIT") && !access.has("SUPPORT_CASE_MANAGE"))
        denied("PERMISSION_DENIED", "SUPPORT_POLICY_EDIT or SUPPORT_CASE_MANAGE is required")
    const queue = cases.queueOf(p.requestCategoryId)
    if (!queue) denied("QUEUE_UNAVAILABLE", "Choose a service queue")
    cases.requireOrganization(queue.organizationPartyId)
    const channelEnumId = p.channelEnumId || "SrcEmail"
    const route = routeFor(channelEnumId, queue.category.requestCategoryId, text(p.emailAccountId))
    const message = {
        emailMessageId: null,
        fromAddress: text(p.fromAddress),
        fromName: null,
        subject: text(p.subject),
        inReplyTo: text(p.inReplyTo),
        referencesHeader: text(p.referencesHeader),
        headersString: text(p.headersString)
    }
    if (!message.fromAddress) denied("SENDER_REQUIRED", "Give the sender's address to test")
    const decision = resolveMail(message, queue, route)
    const sender = decision.sender
    const policy = cases.policyOf(queue.organizationPartyId)
    const joined = decision.requestId ? one(REQUEST, {requestId: decision.requestId}) : null
    const outcomes = {
        join: "Adds the message to " + (joined?.requestName ? "“" + joined.requestName + "”" : "request " + decision.requestId),
        case: "Makes a case in " + (queue.category.description || queue.category.requestCategoryId),
        held:
            "Holds it for review in " +
            (queue.category.description || queue.category.requestCategoryId) +
            ": " +
            (decision.reason || ""),
        ignore: "Makes nothing: " + (decision.reason || "")
    }
    return {
        preview: {
            outcome: decision.action,
            outcomeText: outcomes[decision.action],
            serviceRouteId: route?.serviceRouteId || null,
            routeText: route ? routeText(route) : "No route: the queue's defaults (attach automatic mail, no acknowledgement)",
            requestId: decision.requestId || null,
            threadBy: decision.threadBy || null,
            automatic: decision.automatic || null,
            senderKind: sender.kind,
            senderPartyId: sender.partyId || null,
            senderName: sender.partyId ? cases.partyName(sender.partyId) : sender.address || "",
            customerPartyId: decision.customerPartyId || null,
            customerName: decision.customerPartyId ? cases.partyName(decision.customerPartyId) : "",
            requestTypeEnumId: route?.requestTypeEnumId || listOf(queue.queue.offeredTypeEnumIds)[0] || "RqtSupport",
            priority: route?.defaultPriority ?? 5,
            acknowledged: decision.action === "case" && route?.acknowledge === "Y",
            unknownSenderEnumId: route?.unknownSenderEnumId || policy?.unknownSenderEnumId || "SusReview"
        }
    }
}
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
function routeText(route) {
    const parts = [enumText(route.channelEnumId)]
    if (route.emailAccountId)
        parts.push(
            one("moqui.basic.email.EmailAccount", {emailAccountId: route.emailAccountId})?.emailAddress || route.emailAccountId
        )
    if (route.siteId) parts.push(one("mantle.public.PublicSite", {siteId: route.siteId})?.name || route.siteId)
    return parts.filter(Boolean).join(" · ")
}

// ===== the queue's public form (F10, F61) =====
// create#IntakeToken / remove#IntakeToken for a queue: the token an ExternalAccessCapability on the queue's RequestCategory
// (scope CaseIntake), its life the web form route's (else 60 days); a new one revokes the queue's earlier tokens.
const externalAccess = () => ec.resource.script("component://mr-mantle/service/mantle/party/ExternalAccess.js")
function createToken(p) {
    const ea = externalAccess()
    ea.requireIssuer("RequestCategory", p.requestCategoryId)
    ea.revokeActive("RequestCategory", p.requestCategoryId, intakeScope, null)
    const route = routeFor("SrcWebForm", p.requestCategoryId)
    const made = ea.create({
        recordType: "RequestCategory",
        recordId: p.requestCategoryId,
        scopes: intakeScope,
        validDays: route?.tokenValidDays || 60
    })
    return {token: made.token, url: made.url, capabilityId: made.capabilityId, thruDate: made.thruDate}
}
function removeToken(p) {
    const ea = externalAccess()
    ea.requireIssuer("RequestCategory", p.requestCategoryId)
    ea.revokeActive("RequestCategory", p.requestCategoryId, intakeScope, null)
    return {}
}
// The queue a public form's token names, with the form's settings (the queue's offered types, its web form route, the
// limits), or null for a token that is not a queue's in effect.
function formTarget(token) {
    let checked = null
    try {
        checked = externalAccess().check({recordType: "RequestCategory", scope: intakeScope, token})
    } catch (error) {
        return null
    }
    const queue = cases.queueOf(checked?.recordId)
    if (!queue) return null
    const route = routeFor("SrcWebForm", queue.category.requestCategoryId)
    const offered = listOf(queue.queue.offeredTypeEnumIds)
    const types = offered.length ? offered : [route?.requestTypeEnumId || "RqtSupport"]
    return {
        requestCategoryId: queue.category.requestCategoryId,
        organizationPartyId: queue.organizationPartyId,
        route,
        hourlyLimit: route?.rateLimitPerHour || formHourlyLimit,
        addressLimit: addressHourlyLimit,
        settings: {
            defaultType: route?.requestTypeEnumId && types.includes(route.requestTypeEnumId) ? route.requestTypeEnumId : types[0],
            offeredTypes: types,
            accountId: route?.emailAccountId || null,
            publicForm: {captcha: "N", files: "Y", maxMb: 10, maxFiles: 5, confirm: route?.acknowledge === "Y" ? "Y" : "N"}
        }
    }
}
// The request a queue's public form makes (create#IntakeRequest has checked the fields and the limits): a case for a
// customer the organization serves, found by the address; else held for review (a person made with no Customer role), or
// nothing when the route's unknown-sender rule ignores it. Its files and acknowledgement are create#IntakeRequest's.
function formRequest(p) {
    const target = p.target
    const sender = senderOf(p.emailAddress, target.organizationPartyId)
    const isCase = sender.kind === "customer"
    if (sender.kind === "unknown") {
        const policy =
            target.route?.unknownSenderEnumId || cases.policyOf(target.organizationPartyId)?.unknownSenderEnumId || "SusReview"
        if (policy === "SusIgnore") return {requestId: null, ignored: true}
    }
    const party = sender.partyId
        ? sender
        : (() => {
              const partyId = call("mantle.party.PartyServices.create#Person", {
                  firstName: p.firstName,
                  lastName: p.lastName
              }).partyId
              const contactMechId = call("mantle.party.ContactServices.create#EmailAddress", {
                  partyId,
                  emailAddress: p.emailAddress,
                  contactMechPurposeId: "EmailPrimary"
              }).contactMechId
              return {partyId, contactMechId}
          })()
    const requestId = call(R + "create#Request", {
        requestName: p.requestName,
        description: p.description,
        statusId: "ReqSubmitted",
        requestTypeEnumId: p.requestTypeEnumId,
        requestCategoryId: target.requestCategoryId,
        priority: target.route?.defaultPriority ?? 5,
        salesChannelEnumId: "ScWeb",
        filedByPartyId: party.partyId,
        customerPartyId: isCase ? sender.customerPartyId : null,
        emailContactMechId: party.contactMechId || null
    }).requestId
    if (!isCase)
        noteHeld(
            requestId,
            sender.kind === "staff"
                ? "From staff: held for review, not a case"
                : "A sender the public form could not match to a customer"
        )
    return {requestId, isCase}
}

// ===== the forum (F12) =====
// What create#CaseFromTopic files: with a route for the topic's site and category, a Submitted case in the route's queue on
// channel ScForum, its type the route's, the poster its customer (given the Customer role when it has none; an internal
// poster stays a plain request); with none, the request as before (a draft in the category PASS passes).
function forumIntake(p) {
    const route = forumRoute(p.siteId, p.forumContactListId)
    if (!route) return {routed: false}
    const queue = cases.queueOf(route.requestCategoryId)
    const posterPartyId = p.posterPartyId
    let customerPartyId = null
    if (posterPartyId && !cases.isInternal(posterPartyId) && !cases.organizationsOf(posterPartyId).length) {
        if (!one("mantle.party.PartyRole", {partyId: posterPartyId, roleTypeId: "Customer"}))
            call("create#mantle.party.PartyRole", {partyId: posterPartyId, roleTypeId: "Customer"})
        customerPartyId = posterPartyId
    }
    return {
        routed: true,
        serviceRouteId: route.serviceRouteId,
        requestCategoryId: route.requestCategoryId,
        requestTypeEnumId: route.requestTypeEnumId || listOf(queue?.queue?.offeredTypeEnumIds)[0] || "RqtSupport",
        priority: route.defaultPriority ?? 5,
        customerPartyId,
        statusId: "ReqSubmitted",
        salesChannelEnumId: "ScForum"
    }
}

// ===== calls (design ChannelSessions LogCall) =====
// log#CaseCall: a call on a case, as a Phone communication event filed on it: in from or out to the case's contact (its
// Reporter, else its customer, or the one given: the customer or a contact of it), when, how long, the summary and the
// outcome; an internal call is not customer-visible (CpServiceInternal) and, with one that reached no one, never a response.
function logCall(p) {
    cases.requirePermission("SUPPORT_CASE_EDIT")
    const theCase = cases.caseOf(p.requestId)
    const summary = text(p.summary)
    if (!summary) denied("SUMMARY_REQUIRED", "Say what the call was about")
    const direction = p.direction === "in" ? "in" : p.direction === "out" || blank(p.direction) ? "out" : null
    if (!direction) denied("DIRECTION_INVALID", "A call is in or out")
    const outcome = text(p.outcomeEnumId) || "CcoReached"
    if (!callOutcomes.includes(outcome)) denied("OUTCOME_INVALID", outcome + " is not a call outcome")
    const customerPartyId = theCase.customerPartyId
    const reporterPartyId = theCase.parties.find(row => row.roleTypeId === "Reporter")?.partyId || null
    const contactPartyId = text(p.contactPartyId) || reporterPartyId || customerPartyId
    const isContact =
        contactPartyId === customerPartyId ||
        contactPartyId === reporterPartyId ||
        cases.customerSidesOf(contactPartyId).includes(customerPartyId)
    if (!contactPartyId || !isContact) denied("CONTACT_UNAVAILABLE", "Choose the customer or one of its contacts")
    const agentPartyId = ec.user.userAccount?.partyId || null
    if (!agentPartyId) denied("AGENT_REQUIRED", "Logging a call needs a user with a party")
    const startMs = ms(p.occurredDate) ?? Number(ms(now()))
    if (startMs > Number(ms(now())) + 60000) denied("DATE_INVALID", "A call is logged after it happened")
    const minutes = blank(p.durationMinutes) ? 0 : Number(p.durationMinutes)
    if (!(minutes >= 0 && minutes <= 24 * 60)) denied("DURATION_INVALID", "A call lasts 0 to 1440 minutes")
    const out = direction === "out"
    const body = "<p>" + escape(summary).replace(/\n/g, "<br>") + "</p>"
    const communicationEventId = call("create#" + COMM, {
        communicationEventTypeId: "Phone",
        contactMechTypeEnumId: "CmtTelecomNumber",
        statusId: out ? "CeSent" : "CeReceived",
        fromPartyId: out ? agentPartyId : contactPartyId,
        toPartyId: out ? contactPartyId : agentPartyId,
        entryDate: now(),
        datetimeStarted: new Date(startMs),
        datetimeEnded: new Date(startMs + Math.round(minutes * 60000)),
        subject: (L(out ? "Call to" : "Call from") + " " + cases.partyName(contactPartyId)).substring(0, 255),
        contentType: "text/html",
        body,
        reasonEnumId: outcome
    }).communicationEventId
    call("create#mantle.party.communication.CommunicationEventPurpose", {
        communicationEventId,
        purposeEnumId: "CpCustomerService"
    })
    if (truthy(p.internal))
        call("create#mantle.party.communication.CommunicationEventPurpose", {
            communicationEventId,
            purposeEnumId: "CpServiceInternal"
        })
    // filed on the case last, so its rules (the customer's reply, the first response) see the purposes
    call("create#mantle.request.RequestCommEvent", {requestId: theCase.requestId, communicationEventId})
    return {communicationEventId}
}

// ===== held requests (design ChannelRouting; F62) =====
// The requests held in the organization's queues: Submitted, in a service queue, with no case profile, newest first.
function heldRequests(organizationPartyIds, limit = 50) {
    const queueIds = Array.from(
        find(CATEGORY)
            .condition("ownerPartyId", "in", organizationPartyIds.length ? organizationPartyIds : ["_NONE_"])
            .selectField("requestCategoryId")
            .list()
    )
        .map(row => row.requestCategoryId)
        .filter(id => cases.queueOf(id))
    if (!queueIds.length) return []
    return Array.from(
        find(REQUEST)
            .condition("requestCategoryId", "in", queueIds)
            .condition("statusId", "ReqSubmitted")
            .orderBy("-requestDate")
            .limit(limit * 2)
            .list()
    )
        .filter(row => !one(PROFILE, {requestId: row.requestId}))
        .slice(0, limit)
}
// review#HeldRequest: accept a held request as a case (its sender, or the customer given, the customer: the sender takes the
// Customer role when it is neither staff nor another organization's), or dismiss it (Cancelled). Needs SUPPORT_CASE_EDIT and
// the queue's organization; refuses a request that is not held (NOT_HELD).
function reviewHeld(p) {
    cases.requirePermission("SUPPORT_CASE_EDIT")
    const request = find(REQUEST, {requestId: p.requestId}).forUpdate(true).one()
    const queue = request ? cases.queueOf(request.requestCategoryId) : null
    if (!queue) denied("RECORD_UNAVAILABLE", "Request " + (p.requestId || "") + " is not available")
    const organizationPartyId = cases.requireOrganization(queue.organizationPartyId)
    if (one(PROFILE, {requestId: request.requestId}) || request.statusId !== "ReqSubmitted")
        denied("NOT_HELD", "Request " + request.requestId + " is not held for review")
    if (p.decision === "dismiss") {
        request.set("statusId", "ReqCancelled")
        request.set("requestResolutionEnumId", "RrRejected")
        request.update()
        call("create#mantle.request.RequestNote", {
            requestId: request.requestId,
            noteDate: now(),
            noteText: L("Dismissed in review") + (text(p.reason) ? ": " + text(p.reason) : "")
        })
        return {requestId: request.requestId, isCase: false, statusId: "ReqCancelled"}
    }
    if (p.decision !== "accept") denied("DECISION_INVALID", "Accept or dismiss the request")
    const reporterPartyId = cases
        .currentRows(PARTY, {requestId: request.requestId})
        .find(row => row.roleTypeId === "Reporter")?.partyId
    let customerPartyId = text(p.customerPartyId)
    if (!customerPartyId) {
        if (!reporterPartyId || cases.isInternal(reporterPartyId) || cases.organizationsOf(reporterPartyId).length)
            denied("CUSTOMER_REQUIRED", "Choose the customer this request is from")
        if (!one("mantle.party.PartyRole", {partyId: reporterPartyId, roleTypeId: "Customer"}))
            call("create#mantle.party.PartyRole", {partyId: reporterPartyId, roleTypeId: "Customer"})
        customerPartyId = reporterPartyId
    }
    if (!cases.servedCustomer(customerPartyId, organizationPartyId))
        denied("CUSTOMER_UNAVAILABLE", "Customer " + customerPartyId + " is not available")
    call("create#" + PARTY, {requestId: request.requestId, partyId: customerPartyId, roleTypeId: "Customer", fromDate: now()})
    const made = cases.ensureCase({requestId: request.requestId})
    if (!made.isCase) denied("NOT_A_CASE", "Request " + request.requestId + " is not a case: " + (made.reason || ""))
    return {requestId: request.requestId, isCase: true, statusId: request.statusId}
}

// work with artifact authorization off (each operation checks its own permission and organization)
function runInternal(work) {
    const wasDisabled = ec.artifactExecution.disableAuthz()
    try {
        return work()
    } finally {
        if (!wasDisabled) ec.artifactExecution.enableAuthz()
    }
}

const operations = {saveRoute, previewRoute, mailIntake, createToken, removeToken, logCall, reviewHeld}
;({
    // for create#RequestFromEmail, create#IntakeRequest, create#CaseFromTopic and Customer Service's reads
    queueOfValue,
    formTarget,
    formRequest: p => runInternal(() => formRequest(p)),
    forumIntake: p => runInternal(() => forumIntake(p)),
    currentRoutes,
    routeFor,
    routeText,
    heldRequests,
    automaticReason,
    // each operation checks its own permission and organization, and reads and writes with artifact authorization off
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown support channel operation " + op)
        return runInternal(() => operations[op](parameters))
    }
})
