// Marketing's dispatch and delivery (mantle.marketing.CampaignSendServices; IronStone Marketing design §5 SendDetail's SendControl,
// CampaignDelivery and RecipientDetail, §15.2 Durable dispatch and recovery, §15.3 the due dispatch; impl-marketing P9, §4). A send's
// intent and selection are Marketing's (CampaignSend, CampaignRecipient); every attempt, receipt, retry and uncertain outcome is a row
// of Comms' delivery ledger (MessageDeliveries.js, X8): Marketing keeps no attempt store and retries nothing itself.
//
// - Release (release#Send): MARKETING_DISPATCH on a send of the scope that is approved at its current revision (a current
//   MarketingDecision), prepared at it with an eligible recipient, of an approved campaign, from a ready promotional sending profile,
//   within the policy's audience limit. Release is apart from approval: the releaser is none of the send's authors (its creator, the
//   maker of its revision, the requester) nor its approver, except under the one-person-team flag with fewer than 500 recipients
//   counted at the release (SELF_DISPATCH; recorded as selfDispatch, §4 Nov 11). A single-use topic or source list is reserved for the
//   send (LIST_RESERVED, LIST_USED). A second release answers the first (alreadyReleased). A send scheduled for later is Scheduled
//   until its time, else Sending, its first page handed off on a service worker once the release commits. A paused send is resumed by
//   a release, under the same rule.
// - Dispatch (run#DueSends, the run_MarketingDueSends job, and dispatch#Send for one send): a page of recipients at a time is claimed
//   under a lease (claimKey, leaseUntilDate) in a transaction of its own; the page is checked again together (the topic's membership,
//   consent and suppression by MarketingEligibility.js's rule, the address against the one prepared, a withdrawal by anyone who holds
//   the address now, the policy's frequency cap; a page that cannot be checked waits for a later run), then
//   each recipient is handed to the ledger in a transaction of its own as a promotional delivery of source MdsrcCampaignSend, keyed by
//   the send and the recipient's execution key, naming the organization, the profile and the topic's consent within the organization,
//   or skipped with its reason. One recipient's failure never stops the next. A page claimed again after a lease ends hands each
//   recipient off once: the ledger answers the delivery it holds for the key, and an uncertain delivery is never sent again. A
//   campaign no longer approved or a profile no longer ready stops the run (the send stays Sending, dispatchNote says why).
// - The message (build#CampaignDelivery, the ledger's build before each attempt): the prepared content with the recipient's own values,
//   a List-Unsubscribe header and link from a token made for the sending profile's site (its Account Email preferences page, F56, F75;
//   else the server's /u/ page under a configured root, unsubscribeLink), the attachments copied at preparation, the send's reply-to;
//   suppressed when the recipient left the topic, the address changed or the link has no address.
// - Completion: once no recipient waits and no handed-off delivery is queued, retrying or uncertain, the send is Completed (with
//   failures when a delivery failed); a single-use list is then consumed. ContactListCommStatus rows follow the deliveries' Message-IDs.
// - Pause and cancel (pause#Send, cancel#Send): new claims stop; what the ledger holds already may finish (inFlightCount says how much).
//   Cancel with nothing handed off frees a single-use list.
// - Recovery: retry#Recipients asks the ledger to try again the recipients whose delivery failed after its retryable tries, if they
//   are still eligible; reconcile#Recipient records a dispatcher's evidence on an uncertain delivery through the ledger's
//   resolve#Delivery (MESSAGE_DELIVERY_REVIEW, the delivery's organization). Neither ever repeats an uncertain send blindly.
// - Reads: find#Recipients and get#Recipient for a reader of the send (a Marketing reader of its organization who writes, approves or
//   dispatches sends); a person's name and whole address for an audience reader (MARKETING_AUDIENCE_VIEW), masked otherwise; no token,
//   body or provider diagnostic address in any answer.
// Refusals carry reason codes (EntityLib.js denied).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const marketingAccess = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingAccess.js")
const approvals = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingApprovals.js")
const eligibility = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingEligibility.js")
const templates = ec.resource.script("component://mr-mantle/service/mantle/party/MessageTemplates.js")
const profiles = ec.resource.script("component://mr-mantle/service/mantle/party/MessageSendingProfiles.js")
const suppressions = ec.resource.script("component://mr-mantle/service/mantle/party/MessageSuppressions.js")
const ledger = ec.resource.script("component://mr-mantle/service/mantle/party/MessageDeliveries.js")
const sends = () => ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingSends.js").forDispatch
// P10: a send's experiment (a sample recipient's variant, the remainder held for the winner)
const experiments = () => ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingExperiments.js")
const {find, one, rows, denied, call, ms} = lib

const SEND = "mantle.marketing.campaign.CampaignSend"
const RECIPIENT = "mantle.marketing.campaign.CampaignRecipient"
const CAMPAIGN = "mantle.marketing.campaign.MarketingCampaign"
const LIST = "mantle.marketing.contact.ContactList"
const CLP = "mantle.marketing.contact.ContactListParty"
const PROFILE = "mantle.party.MessageSendingProfile"
const D = "mantle.party.MessageDelivery"
const ATTEMPT = "mantle.party.MessageDeliveryAttempt"
const SOURCE = "MdsrcCampaignSend"
const TEMPLATE_KEY = "MANTLE_CAMPAIGN_SEND"
const limits = {pageSize: 100, maxPageSize: 500, pagesPerRun: 20, sendsPerRun: 20, leaseMinutes: 15, sweepRows: 2000}
const releasedStatuses = ["CsScheduled", "CsSending", "CsPaused", "CsSampleSent", "CsCompleted", "CsCompletedFailures"]
const stoppableStatuses = ["CsScheduled", "CsSending"]
const openDeliveryStates = ["MdsQueued", "MdsRetry", "MdsUncertain"]
const accepted = ["CLPT_ACCEPTED", "CLPT_IN_USE"]
const recipientTexts = {
    CrsSelected: "Waiting to be handed off",
    CrsHandedOff: "Handed off",
    CrsSkipped: "Skipped at dispatch",
    CrsCancelled: "Not sent: cancelled",
    CrsReplaced: "Replaced by a later preparation",
    CrsHeld: "Held for the winner"
}
// a dispatch's own skip reasons beside the eligibility's (MarketingEligibility.js reasonTexts)
const skipTexts = {
    DESTINATION_CHANGED: "The address changed since approval",
    FREQUENCY_CAP: "Over the organization's frequency cap",
    NOT_CLASSIFIED: "Could not be checked",
    // P10: left out at the winner's release
    AUDIENCE_LEFT: "No longer in the send's audience at the winner's release",
    ALREADY_SENT: "Sent this send already"
}

const text = value => (value == null ? "" : String(value).trim())
const blank = value => text(value) === ""
const nowMs = () => ms(ec.user.nowTimestamp)
const eventPrefix = campaignSendId => "CampaignSend:" + campaignSendId + ":"
const eventKeyOf = recipient => eventPrefix(recipient.campaignSendId) + recipient.executionKey
// a remote server's diagnostic often names the address: never in an answer
const noAddress = value => String(value || "").replace(/[^\s<>()\[\];:,"']+@[^\s<>()\[\];:,"']+/g, "[address]")
const reasonText = code => (code ? skipTexts[code] || eligibility.reasonTexts[code] || code : "")
// The unsubscribe link (P9 review): a sending profile's site that mounts Account gives its Email preferences page; else the server's
// /u/ page under a configured root, never a request's Host: the profile's relay's web base URL, else the send template's web host or
// its relay's web base URL, else the conf webapp's root kept at the release (ec.web.getWebappRootUrl, which takes a request's Host
// only when a root-screen pattern of the deployment names it). Every token is made with that root, so create#UnsubscribeToken never
// falls back to a site the recipient belongs to (another organization's, F75).
const publicApps = () => ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
function unsubscribeLink(row, profile, releaseRoot) {
    const serverBase = emailServerId =>
        emailServerId ? text(one("moqui.basic.email.EmailServer", {emailServerId})?.webBaseUrl) : ""
    let root = serverBase(profile?.emailServerId)
    if (!root) {
        const template = one("moqui.basic.email.EmailTemplate", {emailTemplateId: TEMPLATE_KEY})
        root = template?.webHostName ? "https://" + text(template.webHostName) : serverBase(template?.emailServerId)
    }
    if (!root) root = text(releaseRoot)
    const siteId = profile?.siteId && publicApps().mount(profile.siteId, "account") ? profile.siteId : null
    return {siteId, baseUrl: root.replace(/\/+$/, "") || null, ready: !!siteId || !!root}
}

// ===== the send of the scope, the control =====
function dispatchScope() {
    const userScope = sends().readScope()
    marketingAccess.requireCapability(userScope, "dispatch")
    return userScope
}
// Who reads a send's delivery: a Marketing reader who writes, approves or dispatches sends (design §2: Sends is theirs).
function readerScope() {
    const userScope = sends().readScope()
    const caps = userScope.capabilities
    if (!(caps.sendEdit || caps.approve || caps.dispatch)) denied("PERMISSION_DENIED", "A send's delivery is not open to you")
    return userScope
}
// The authors of the current revision (creator, the maker of its change, the requester) and its approver: release is apart from them.
function releaseParties(row, approval) {
    const kind = approvals.targetKinds.send
    const ids = new Set(kind.authors(row))
    if (approval?.requestDecisionId) {
        const requested = one("mantle.marketing.campaign.MarketingDecision", {marketingDecisionId: approval.requestDecisionId})
        if (requested?.decidedByUserId) ids.add(requested.decidedByUserId)
    }
    if (approval?.decidedByUserId) ids.add(approval.decidedByUserId)
    return ids
}
const preparedCount = row =>
    find(RECIPIENT, {campaignSendId: row.campaignSendId, preparedRevision: Number(row.preparedRevision || 0)})
        .condition("statusId", "in", ["CrsSelected", "CrsHandedOff", "CrsSkipped", "CrsHeld"])
        .count()
// The deliveries of a send in the ledger, counted by state (one query by the send's event key).
function deliveryCounts(campaignSendId) {
    const counts = {MdsQueued: 0, MdsRetry: 0, MdsSent: 0, MdsFailed: 0, MdsUncertain: 0, MdsSuppressed: 0}
    for (const state of Object.keys(counts))
        counts[state] = find(D, {sourceEnumId: SOURCE, stateEnumId: state})
            .condition("eventKey", "like", eventPrefix(campaignSendId) + "%")
            .count()
    return counts
}
function recipientCounts(row) {
    const counts = {}
    for (const statusId of ["CrsSelected", "CrsHandedOff", "CrsSkipped", "CrsCancelled", "CrsHeld"])
        counts[statusId] = find(RECIPIENT, {campaignSendId: row.campaignSendId, statusId})
            .condition("preparedRevision", Number(row.preparedRevision || 0))
            .count()
    return counts
}
// controlOf (get#Send's delivery box and control): the counts and what the caller may do now.
function controlOf(userScope, row) {
    const caps = userScope.capabilities
    const released = releasedStatuses.includes(row.statusId) || (row.statusId === "CsCancelled" && row.releasedDate != null)
    const recipients = released ? recipientCounts(row) : null
    const deliveries = released ? deliveryCounts(row.campaignSendId) : null
    const delivery = released
        ? {
              released: true,
              releasedDateText: row.releasedDate ? lib.dateText(row.releasedDate) : "",
              releasedByName: row.releasedByUserId ? userName(row.releasedByUserId) : "",
              selfDispatch: row.selfDispatch === "Y",
              releasedCount: Number(row.releasedCount || 0),
              waitingCount: recipients.CrsSelected,
              handedOffCount: recipients.CrsHandedOff,
              skippedCount: recipients.CrsSkipped,
              cancelledCount: recipients.CrsCancelled,
              heldCount: recipients.CrsHeld,
              sentCount: deliveries.MdsSent,
              failedCount: deliveries.MdsFailed,
              uncertainCount: deliveries.MdsUncertain,
              suppressedCount: deliveries.MdsSuppressed,
              inFlightCount: deliveries.MdsQueued + deliveries.MdsRetry,
              completedDateText: row.completedDate ? lib.dateText(row.completedDate) : "",
              cancelledDateText: row.cancelledDate ? lib.dateText(row.cancelledDate) : "",
              cancelReason: row.cancelReason || "",
              dispatchNote: row.dispatchNote || ""
          }
        : {released: false}
    let canRelease = false,
        releaseSelf = false
    if (caps.dispatch && ["CsApproved", "CsPaused"].includes(row.statusId)) {
        const approval = approvals.currentApproval("send", row.campaignSendId, Number(row.sendRevision || 1))
        if (approval) {
            const own = releaseParties(row, approval).has(ec.user.userId)
            // P10: preparedCount reads the samples and the held remainder alike (a paused experiment's resume counts the whole audience)
            const count = row.statusId === "CsPaused" ? resumeCount(row) : preparedCount(row)
            releaseSelf = own
            canRelease = !own || approvals.selfApprovalAdmits(approvals.policyOf(row.organizationPartyId), "send", count)
        }
    }
    return {
        delivery,
        capabilities: {
            canRelease: canRelease && row.statusId === "CsApproved",
            canResume: canRelease && row.statusId === "CsPaused",
            releaseSelf,
            canPause: !!caps.dispatch && stoppableStatuses.includes(row.statusId),
            canCancel:
                (!!caps.dispatch &&
                    ["CsApproved", "CsScheduled", "CsSending", "CsPaused", "CsSampleSent"].includes(row.statusId)) ||
                (!!caps.sendEdit && ["CsDraft", "CsAwaitingApproval", "CsApproved"].includes(row.statusId)),
            canRetry: !!caps.dispatch && released && row.statusId !== "CsCancelled" && (deliveries?.MdsFailed || 0) > 0,
            canReconcile: !!caps.dispatch && ec.user.hasPermission("MESSAGE_DELIVERY_REVIEW"),
            canReadDelivery: released
        }
    }
}
const userName = userId => {
    const partyId = userId ? one("moqui.security.UserAccount", {userId})?.partyId : null
    return partyId ? lib.partyNames([partyId])[partyId] || userId : userId || ""
}

// ===== release#Send =====
function releaseSend(p) {
    const userScope = dispatchScope()
    const row = sends().sendOf(userScope, p.campaignSendId, true)
    const first = () => ({
        campaignSendId: row.campaignSendId,
        released: false,
        alreadyReleased: true,
        statusId: row.statusId,
        recipientCount: Number(row.releasedCount || 0),
        selfDispatch: row.selfDispatch === "Y"
    })
    // a second release answers the first, whatever stamp it names
    if (["CsScheduled", "CsSending", "CsSampleSent", "CsCompleted", "CsCompletedFailures"].includes(row.statusId)) return first()
    if (row.statusId === "CsPaused") return resumeSend(userScope, row)
    if (row.statusId !== "CsApproved")
        denied("STATUS_INVALID", "Send " + row.campaignSendId + " is " + sends().statusText(row.statusId).toLowerCase())
    sends().requireRevision(row, p.expectedRevision)
    const revision = Number(row.sendRevision || 1)
    const approval = approvals.currentApproval("send", row.campaignSendId, revision)
    if (!approval) denied("APPROVAL_REQUIRED", "Send " + row.campaignSendId + " is not approved at revision " + revision)
    const problems = sends().sendProblems(row)
    if (problems.length) denied("NOT_READY", "Send " + row.campaignSendId + " cannot be released: " + problems.join(", "))
    const count = find(RECIPIENT, {
        campaignSendId: row.campaignSendId,
        statusId: "CrsSelected",
        preparedRevision: revision
    }).count()
    if (!count) denied("EMPTY_AUDIENCE", "Send " + row.campaignSendId + " has no eligible recipient to release to")
    // P10: an experiment's release sends its samples; the remainder held for the winner counts toward the limits all the same
    const held = find(RECIPIENT, {campaignSendId: row.campaignSendId, statusId: "CrsHeld", preparedRevision: revision}).count()
    const total = count + held
    const policy = approvals.policyOf(row.organizationPartyId)
    if (policy?.audienceLimit != null && total > Number(policy.audienceLimit))
        denied(
            "AUDIENCE_LIMIT",
            "The send has " + total + " recipients, over the organization's limit of " + policy.audienceLimit
        )
    // apart from approval: an author or the approver releases only under the one-person-team flag, under 500 counted now
    const own = releaseParties(row, approval).has(ec.user.userId)
    if (own && !approvals.selfApprovalAdmits(policy, "send", total))
        denied(
            "SELF_DISPATCH",
            "You wrote, submitted or approved send " + row.campaignSendId + "; another dispatcher releases it"
        )
    // the single-use lists among its topic and sources, reserved for it (each refusal names the list)
    const audience = lib.json(row.audienceJson, {}) || {}
    for (const contactListId of Array.from(new Set([row.contactListId].concat(Array.from(audience.listIds || []))))) {
        const list = one(LIST, {contactListId})
        if (list?.singleUse !== "Y") continue
        const reserved = call("mantle.marketing.AudienceServices.reserve#SingleUseList", {
            contactListId,
            sendId: row.campaignSendId
        })
        if (!reserved.reserved)
            denied(
                reserved.reasonCode || "LIST_RESERVED",
                "The single-use list " +
                    (list.contactListName || contactListId) +
                    " is " +
                    (reserved.reasonCode === "LIST_USED" ? "used already" : "held by another send")
            )
    }
    // each message's unsubscribe link needs an address of its own: a site that mounts Account or a configured root (P9 review)
    let root = ""
    try {
        root = ec.web ? String(ec.web.getWebappRootUrl(true, null) || "") : ""
    } catch (error) {
        root = ""
    }
    const profile = row.sendingProfileId ? one(PROFILE, {sendingProfileId: row.sendingProfileId}) : null
    if (!unsubscribeLink(row, profile, root).ready)
        denied(
            "NOT_READY",
            "Send " +
                row.campaignSendId +
                " cannot be released: its unsubscribe link has no address (give the sending profile a site with Account, or its relay a web base URL)"
        )
    // the send's communication event: the approved subject and body, which each recipient's row and token name (F8)
    const prepared = sends().preparedContent(row)
    const communicationEventId = call("create#mantle.party.communication.CommunicationEvent", {
        communicationEventTypeId: "Email",
        contactMechTypeEnumId: "CmtEmailAddress",
        statusId: "CeSent",
        fromPartyId: row.organizationPartyId,
        contactListId: row.contactListId,
        subject: prepared.subject || null,
        contentType: "text/html",
        body: templates.readText(prepared.bodyLocation) || null,
        entryDate: ec.user.nowTimestamp,
        datetimeStarted: ec.user.nowTimestamp
    }).communicationEventId
    const later = row.scheduledDate != null && ms(row.scheduledDate) > nowMs()
    const statusId = later ? "CsScheduled" : "CsSending"
    call("update#" + SEND, {
        campaignSendId: row.campaignSendId,
        statusId,
        statusId_changeReason:
            (later ? "Released for " + lib.dateText(row.scheduledDate) : "Released") +
            " by " +
            (ec.user.username || ec.user.userId) +
            (own ? " (one-person team)" : "") +
            (text(p.reason) ? ": " + text(p.reason).slice(0, 200) : ""),
        releasedDate: ec.user.nowTimestamp,
        releasedByUserId: ec.user.userId,
        releaseDecisionId: approval.marketingDecisionId,
        selfDispatch: own ? "Y" : "N",
        releasedCount: count,
        communicationEventId,
        unsubscribeBaseUrl: root.replace(/\/+$/, "") || null,
        dispatchNote: null
    })
    if (!later) dispatchAfterCommit(row.campaignSendId)
    return {
        campaignSendId: row.campaignSendId,
        released: true,
        alreadyReleased: false,
        statusId,
        recipientCount: count,
        selfDispatch: own
    }
}
// The count a paused send's resume is admitted by: what was released, or (P10 review) the whole prepared audience when larger, so an
// experiment's samples never stand for its held or released remainder under the one-person team's flag.
const resumeCount = row => Math.max(Number(row.releasedCount || 0), preparedCount(row))
// a paused send resumed by a dispatcher, under release's rule
function resumeSend(userScope, row) {
    const approval = approvals.currentApproval("send", row.campaignSendId, Number(row.sendRevision || 1))
    if (!approval) denied("APPROVAL_REQUIRED", "Send " + row.campaignSendId + " is no longer approved")
    const own = releaseParties(row, approval).has(ec.user.userId)
    if (own && !approvals.selfApprovalAdmits(approvals.policyOf(row.organizationPartyId), "send", resumeCount(row)))
        denied("SELF_DISPATCH", "You wrote, submitted or approved send " + row.campaignSendId + "; another dispatcher resumes it")
    call("update#" + SEND, {
        campaignSendId: row.campaignSendId,
        statusId: "CsSending",
        statusId_changeReason: "Resumed by " + (ec.user.username || ec.user.userId),
        pausedDate: null
    })
    dispatchAfterCommit(row.campaignSendId)
    return {
        campaignSendId: row.campaignSendId,
        released: false,
        resumed: true,
        alreadyReleased: true,
        statusId: "CsSending",
        recipientCount: Number(row.releasedCount || 0),
        selfDispatch: row.selfDispatch === "Y"
    }
}
// The send's first page on a service worker once the release commits (never inside the request); the job does the rest.
function dispatchAfterCommit(campaignSendId) {
    try {
        ec.service
            .special()
            .name("mantle.marketing.CampaignSendServices.dispatch#Send")
            .parameters({campaignSendId})
            .registerOnCommit()
    } catch (error) {
        ec.logger.warn("Send " + campaignSendId + ": its dispatch waits for the job: " + String(error.message).split("\n")[0])
    }
}

// ===== run#DueSends, dispatch#Send =====
// The released sends whose time has come start sending; each sending send hands off its pages. {started, dispatched, handedOff,
// skipped, failed, completed}.
function runDue(p) {
    const now = ec.user.nowTimestamp
    let started = 0
    for (const row of Array.from(
        find(SEND, {statusId: "CsScheduled"})
            .condition("scheduledDate", "less-equals", now)
            .orderBy("scheduledDate")
            .limit(limits.sendsPerRun)
            .list()
    )) {
        try {
            apart("mantle.marketing.CampaignSendServices.start#DueSend", {campaignSendId: row.campaignSendId})
            started++
        } catch (error) {
            ec.logger.error("Send " + row.campaignSendId + " could not start: " + String(error.message).split("\n")[0])
        }
    }
    const totals = {started, dispatched: 0, handedOff: 0, skipped: 0, failed: 0, completed: 0}
    for (const row of Array.from(
        find(SEND, {statusId: "CsSending"})
            .orderBy("lastDispatchDate")
            .limit(Number(p.sendLimit) || limits.sendsPerRun)
            .list()
    )) {
        try {
            const out = dispatchSend({campaignSendId: row.campaignSendId, pageSize: p.pageSize, attempt: p.attempt})
            totals.dispatched++
            totals.handedOff += out.handedOff
            totals.skipped += out.skipped
            totals.failed += out.failed
            if (out.completed) totals.completed++
        } catch (error) {
            ec.logger.error("Send " + row.campaignSendId + " dispatch failed: " + String(error.message).split("\n")[0])
        }
    }
    return totals
}
// start#DueSend: a scheduled send whose time has come, under its lock.
function startDue(p) {
    const row = find(SEND, {campaignSendId: text(p.campaignSendId)})
        .forUpdate(true)
        .one()
    if (!row || row.statusId !== "CsScheduled" || (row.scheduledDate != null && ms(row.scheduledDate) > nowMs())) return {}
    call("update#" + SEND, {campaignSendId: row.campaignSendId, statusId: "CsSending", statusId_changeReason: "Its time came"})
    return {}
}
// A service in a transaction of its own; its errors thrown, the caller's kept apart.
function apart(name, parameters) {
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(name).parameters(parameters).disableAuthz().requireNewTransaction(true).call() || {}
        if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
        return out
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}
// dispatch#Send: one sending send's pages, then its completion. {handedOff, skipped, failed, stopped, completed}.
function dispatchSend(p) {
    const campaignSendId = text(p.campaignSendId)
    const pageSize = Math.min(limits.maxPageSize, Math.max(1, Number(p.pageSize) || limits.pageSize))
    const attempt = !(p.attempt === false || p.attempt === "false")
    const totals = {handedOff: 0, skipped: 0, failed: 0, stopped: false, completed: false}
    for (let pageNumber = 0; pageNumber < limits.pagesPerRun; pageNumber++) {
        let claim
        try {
            claim = apart("mantle.marketing.CampaignSendServices.claim#RecipientPage", {campaignSendId, pageSize})
        } catch (error) {
            ec.logger.error("Send " + campaignSendId + ": a page could not be claimed: " + String(error.message).split("\n")[0])
            break
        }
        if (claim.stopNote) {
            totals.stopped = true
            break
        }
        const ids = Array.from(claim.campaignRecipientIdList || [])
        if (!ids.length) break
        const verdicts = checkPage(campaignSendId, ids)
        // a page that could not be checked waits for its lease to end and a later run (P9 review)
        if (!verdicts) {
            totals.stopped = true
            break
        }
        const created = []
        for (const campaignRecipientId of ids) {
            try {
                const out = apart("mantle.marketing.CampaignSendServices.handOff#Recipient", {
                    campaignRecipientId,
                    claimKey: claim.claimKey,
                    verdict: verdicts[campaignRecipientId] || {reasonCode: "NOT_CLASSIFIED"}
                })
                if (out.stopped) {
                    totals.stopped = true
                    break
                }
                if (out.deliveryId) {
                    totals.handedOff++
                    if (out.created) created.push(out.deliveryId)
                } else if (out.skipReasonCode) totals.skipped++
            } catch (error) {
                totals.failed++
                ec.logger.error(
                    "Send " +
                        campaignSendId +
                        " recipient " +
                        campaignRecipientId +
                        " not handed off: " +
                        String(error.message).split("\n")[0]
                )
            }
        }
        // each new delivery's first attempt, in a transaction of its own; a later one is the ledger's job (run#Deliveries)
        if (attempt)
            for (const deliveryId of created)
                try {
                    apart("mantle.party.MessageServices.attempt#Delivery", {deliveryId})
                } catch (error) {
                    ec.logger.error("Delivery " + deliveryId + " attempt failed: " + String(error.message).split("\n")[0])
                }
        if (totals.stopped) break
    }
    try {
        totals.completed = !!apart("mantle.marketing.CampaignSendServices.sweep#Send", {campaignSendId}).completed
    } catch (error) {
        ec.logger.error("Send " + campaignSendId + " could not be swept: " + String(error.message).split("\n")[0])
    }
    return totals
}
// claim#RecipientPage: the send still sending and due, its campaign approved and its profile ready (else stopNote, nothing claimed);
// a page of the recipients waiting whose lease is free, claimed under a new key until the lease ends.
function claimPage(p) {
    const row = find(SEND, {campaignSendId: text(p.campaignSendId)})
        .forUpdate(true)
        .one()
    if (!row || row.statusId !== "CsSending") return {stopNote: "Not sending"}
    if (row.scheduledDate != null && ms(row.scheduledDate) > nowMs()) return {stopNote: "Not due"}
    const stop = note => {
        call("update#" + SEND, {campaignSendId: row.campaignSendId, dispatchNote: note, lastDispatchDate: ec.user.nowTimestamp})
        return {stopNote: note}
    }
    const campaign = one(CAMPAIGN, {marketingCampaignId: row.marketingCampaignId})
    if (!campaign || !sends().approvedCampaignStatuses.includes(campaign.statusId))
        return stop("Its campaign is no longer approved: nothing is handed off until it is")
    const profile = row.sendingProfileId ? one(PROFILE, {sendingProfileId: row.sendingProfileId}) : null
    const readiness = profile ? profiles.readinessOf(profile) : null
    if (!readiness?.ready) return stop("Its sending profile is not ready: " + (readiness ? readiness.reasons.join("; ") : "none"))
    const now = ec.user.nowTimestamp
    const factory = ec.entity.conditionFactory
    const waiting = Array.from(
        find(RECIPIENT, {campaignSendId: row.campaignSendId, statusId: "CrsSelected"})
            .condition("preparedRevision", Number(row.preparedRevision || 0))
            .condition(
                factory.makeCondition(
                    [
                        factory.makeCondition("leaseUntilDate", "is-null", null),
                        factory.makeCondition("leaseUntilDate", "less", now)
                    ],
                    "or"
                )
            )
            .orderBy("campaignRecipientId")
            .limit(Number(p.pageSize) || limits.pageSize)
            .forUpdate(true)
            .list()
    )
    if (!waiting.length) {
        if (row.dispatchNote) call("update#" + SEND, {campaignSendId: row.campaignSendId, dispatchNote: null})
        return {campaignRecipientIdList: []}
    }
    const claimKey = ec.user.randomString(16).replace(/[^A-Za-z0-9]/g, "x")
    const leaseUntilDate = new Date(nowMs() + limits.leaseMinutes * 60000)
    for (const recipient of waiting)
        call("update#" + RECIPIENT, {campaignRecipientId: recipient.campaignRecipientId, claimKey, leaseUntilDate})
    call("update#" + SEND, {campaignSendId: row.campaignSendId, lastDispatchDate: now, dispatchNote: null})
    return {claimKey, campaignRecipientIdList: waiting.map(recipient => recipient.campaignRecipientId)}
}
// The addresses (keys) a withdrawal blocks for a page: a recipient's own, or another person's who holds one of the page's addresses
// now (an email by its text in any case, or the same contact mech), classified for the topic as the recipients are (P5's rule:
// anyone's withdrawal at an address blocks it for everyone there; settle's, over the people at the address rather than the selection).
function sharedWithdrawals(row, people, classifyOf) {
    const withdrawn = new Set(people.filter(person => person.withdrew && person.key).map(person => person.key))
    const keys = new Map()
    for (const person of people) if (person.key && !person.withdrew) keys.set(person.key, person.contactMechId)
    if (!keys.size) return withdrawn
    const sms = row.channelEnumId === "MdcSms"
    const own = new Set(people.map(person => person.partyId))
    const factory = ec.entity.conditionFactory
    const others = new Set()
    const entries = Array.from(keys.entries())
    for (let start = 0; start < entries.length; start += 200) {
        const batch = entries.slice(start, start + 200)
        const byAddress = sms ? [] : batch.map(([key]) => factory.makeCondition("infoString", "equals", key).ignoreCase())
        const byMech = batch.map(([, contactMechId]) => contactMechId).filter(Boolean)
        if (byMech.length) byAddress.push(factory.makeCondition("contactMechId", "in", byMech))
        if (!byAddress.length) continue
        for (const info of Array.from(
            find("mantle.party.contact.PartyContactMechInfo")
                .condition("contactMechTypeEnumId", sms ? "CmtTelecomNumber" : "CmtEmailAddress")
                .condition(factory.makeCondition(byAddress, "or"))
                .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                .selectField("partyId")
                .list()
        ))
            if (!own.has(info.partyId)) others.add(info.partyId)
    }
    if (others.size)
        for (const person of classifyOf(Array.from(others)).people)
            if (person.withdrew && person.key && keys.has(person.key)) withdrawn.add(person.key)
    return withdrawn
}
// The page checked together, just before its hand-offs: each recipient's verdict {eligible, reasonCode, address}. The topic's
// membership, consent, suppression and solicitation by MarketingEligibility.js's rule as of now (disabled and merged parties not
// available; whom the preparer could see was settled at preparation), the address the one prepared (DESTINATION_CHANGED), and the
// policy's frequency cap (FREQUENCY_CAP: the organization's promotional deliveries to the person in its days). A new segment match is
// never added: only the prepared recipients are read. A withdrawal by another person who holds the address now (P5's
// DESTINATION_WITHDRAWN, settled at preparation over the selection) is checked again over everyone at it, the stricter way (P9 review).
// null when the page could not be checked: nothing is skipped, its lease ends and a later run checks it again.
function checkPage(campaignSendId, ids) {
    const row = one(SEND, {campaignSendId})
    const recipients = Array.from(find(RECIPIENT).condition("campaignRecipientId", "in", ids).list())
    const topic = one(LIST, {contactListId: row.contactListId})
    const verdicts = {}
    if (!topic) {
        for (const recipient of recipients) verdicts[recipient.campaignRecipientId] = {reasonCode: "NOT_SUBSCRIBED"}
        return verdicts
    }
    let classified, withdrawnKeys
    try {
        const classifyOf = partyIds =>
            eligibility.classifyPeople({
                organizationPartyId: row.organizationPartyId,
                list: topic,
                purposeEnumId: row.purposeEnumId,
                channelEnumId: row.channelEnumId,
                partyIds,
                availableOf: partyIds => {
                    const found = new Map()
                    for (const party of Array.from(find("mantle.party.Party").condition("partyId", "in", partyIds).list()))
                        if (party.disabled !== "Y" && !party.mergedToPartyId) found.set(party.partyId, party)
                    return found
                }
            })
        classified = classifyOf(recipients.map(recipient => recipient.partyId))
        withdrawnKeys = sharedWithdrawals(row, classified.people, classifyOf)
    } catch (error) {
        // nothing is skipped on an error: the page's lease ends and a later run checks it again
        ec.logger.error("Send " + campaignSendId + ": a page could not be checked: " + String(error.message).split("\n")[0])
        return null
    }
    const people = new Map(classified.people.map(person => [person.partyId, person]))
    const policy = approvals.policyOf(row.organizationPartyId)
    const capped = new Map()
    if (policy?.frequencyCapCount != null && policy?.frequencyCapDays != null) {
        const since = new Date(nowMs() - Number(policy.frequencyCapDays) * 86400000)
        for (const delivery of Array.from(
            find(D, {sourceEnumId: SOURCE, organizationPartyId: row.organizationPartyId})
                .condition(
                    "recipientPartyId",
                    "in",
                    recipients.map(recipient => recipient.partyId)
                )
                .condition("stateEnumId", "in", ["MdsQueued", "MdsRetry", "MdsSent", "MdsUncertain"])
                .condition("createdDate", "greater-equals", since)
                .selectField("recipientPartyId")
                .selectField("eventKey")
                .list()
        ))
            if (!String(delivery.eventKey || "").startsWith(eventPrefix(campaignSendId)))
                capped.set(delivery.recipientPartyId, (capped.get(delivery.recipientPartyId) || 0) + 1)
    }
    for (const recipient of recipients) {
        const person = people.get(recipient.partyId)
        let verdict
        if (!person) verdict = {reasonCode: "NOT_CLASSIFIED"}
        else if (["unavailable", "suppressed", "withdrawn"].includes(person.bucket)) verdict = {reasonCode: person.reasonCode}
        // the address chosen now is not the one approved: skipped for review, never sent to a substitute (design §5)
        else if (person.contactMechId !== recipient.contactMechId || person.key !== recipient.destinationKey)
            verdict = {reasonCode: "DESTINATION_CHANGED"}
        // another person at the address withdrew (P5's rule, settled at preparation, checked again: P9 review)
        else if (withdrawnKeys.has(person.key)) verdict = {reasonCode: "DESTINATION_WITHDRAWN"}
        else if (person.bucket !== "eligible" && person.bucket !== "duplicate") verdict = {reasonCode: person.reasonCode}
        else if (capped.has(recipient.partyId) && capped.get(recipient.partyId) >= Number(policy.frequencyCapCount))
            verdict = {reasonCode: "FREQUENCY_CAP"}
        else verdict = {eligible: true, reasonCode: null, address: person.address}
        verdicts[recipient.campaignRecipientId] = verdict
    }
    return verdicts
}
// handOff#Recipient: one recipient under its lock and its page's claim: still waiting and the send still sending, then handed to the
// ledger (an existing delivery for its key answered, never a second) and its list row stored, or skipped with its verdict's reason.
function handOff(p) {
    const recipient = find(RECIPIENT, {campaignRecipientId: text(p.campaignRecipientId)})
        .forUpdate(true)
        .one()
    if (!recipient || recipient.statusId !== "CrsSelected" || recipient.claimKey !== text(p.claimKey)) return {}
    const row = one(SEND, {campaignSendId: recipient.campaignSendId})
    if (!row || row.statusId !== "CsSending") {
        call("update#" + RECIPIENT, {campaignRecipientId: recipient.campaignRecipientId, claimKey: null, leaseUntilDate: null})
        return {stopped: true}
    }
    const verdict = p.verdict || {}
    if (!verdict.eligible) {
        call("update#" + RECIPIENT, {
            campaignRecipientId: recipient.campaignRecipientId,
            statusId: "CrsSkipped",
            skipReasonCode: text(verdict.reasonCode) || "NOT_CLASSIFIED",
            skipDate: ec.user.nowTimestamp,
            leaseUntilDate: null
        })
        return {skipReasonCode: text(verdict.reasonCode) || "NOT_CLASSIFIED"}
    }
    const queued = call("mantle.party.MessageServices.queue#Delivery", {
        eventKey: eventKeyOf(recipient),
        sourceEnumId: SOURCE,
        recipientPartyId: recipient.partyId,
        toAddress: verdict.address || null,
        channelEnumId: row.channelEnumId || "MdcEmail",
        templateKey: TEMPLATE_KEY,
        organizationPartyId: row.organizationPartyId,
        sendingProfileId: row.sendingProfileId,
        transactional: false,
        marketingPurposeEnumId: row.purposeEnumId,
        consentContactListId: row.contactListId,
        consentOrganizationPartyId: row.organizationPartyId,
        consentContactMechId: recipient.contactMechId
    })
    if (row.communicationEventId && recipient.contactMechId)
        call("store#mantle.marketing.contact.ContactListCommStatus", {
            contactListId: row.contactListId,
            communicationEventId: row.communicationEventId,
            contactMechId: recipient.contactMechId,
            partyId: recipient.partyId,
            statusId: "CeReady"
        })
    call("update#" + RECIPIENT, {
        campaignRecipientId: recipient.campaignRecipientId,
        statusId: "CrsHandedOff",
        messageDeliveryId: queued.deliveryId,
        handedOffDate: ec.user.nowTimestamp,
        leaseUntilDate: null
    })
    return {deliveryId: queued.deliveryId, created: !!queued.created}
}
// sweep#Send: the list rows of sent deliveries given their Message-IDs; a sending send with no recipient waiting and no delivery
// queued, retrying or uncertain completed (with failures when one failed), its single-use lists consumed. {completed}.
function sweep(p) {
    const row = find(SEND, {campaignSendId: text(p.campaignSendId)})
        .forUpdate(true)
        .one()
    if (!row) return {completed: false}
    if (row.communicationEventId) {
        const pending = Array.from(
            find("mantle.marketing.contact.ContactListCommStatus", {
                communicationEventId: row.communicationEventId,
                statusId: "CeReady"
            })
                .limit(limits.sweepRows)
                .list()
        )
        if (pending.length) {
            const byMech = new Map(pending.map(status => [status.contactMechId, status]))
            const handed = Array.from(
                find(RECIPIENT, {campaignSendId: row.campaignSendId, statusId: "CrsHandedOff"})
                    .condition("contactMechId", "in", Array.from(byMech.keys()))
                    .list()
            )
            const deliveries = new Map(
                handed.length
                    ? Array.from(
                          find(D, {stateEnumId: "MdsSent"})
                              .condition("deliveryId", "in", handed.map(recipient => recipient.messageDeliveryId).filter(Boolean))
                              .list()
                      ).map(delivery => [delivery.deliveryId, delivery])
                    : []
            )
            for (const recipient of handed) {
                const delivery = deliveries.get(recipient.messageDeliveryId)
                if (!delivery?.providerMessageId) continue
                try {
                    call("update#mantle.marketing.contact.ContactListCommStatus", {
                        contactListId: row.contactListId,
                        communicationEventId: row.communicationEventId,
                        contactMechId: recipient.contactMechId,
                        messageId: delivery.providerMessageId,
                        statusId: "CeSent"
                    })
                } catch (error) {
                    ec.message.clearErrors()
                    ec.logger.warn(
                        "Send " + row.campaignSendId + ": a list row was not updated: " + String(error.message).split("\n")[0]
                    )
                }
            }
        }
    }
    if (row.statusId !== "CsSending") return {completed: false}
    const waiting = find(RECIPIENT, {campaignSendId: row.campaignSendId, statusId: "CrsSelected"})
        .condition("preparedRevision", Number(row.preparedRevision || 0))
        .count()
    if (waiting) return {completed: false}
    const counts = deliveryCounts(row.campaignSendId)
    if (openDeliveryStates.some(state => counts[state] > 0)) return {completed: false}
    // P10: an experiment's sample settled while its remainder waits for the winner: Sample sent, not completed
    const held = find(RECIPIENT, {campaignSendId: row.campaignSendId, statusId: "CrsHeld"})
        .condition("preparedRevision", Number(row.preparedRevision || 0))
        .count()
    if (held) {
        call("update#" + SEND, {
            campaignSendId: row.campaignSendId,
            statusId: "CsSampleSent",
            statusId_changeReason: "The sample is sent; " + held + " recipients wait for the winner"
        })
        return {completed: false, sampleSent: true}
    }
    const failed = counts.MdsFailed > 0
    call("update#" + SEND, {
        campaignSendId: row.campaignSendId,
        statusId: failed ? "CsCompletedFailures" : "CsCompleted",
        statusId_changeReason: failed ? counts.MdsFailed + " deliveries failed" : "Every recipient handed off and settled",
        completedDate: ec.user.nowTimestamp
    })
    if (row.communicationEventId)
        call("update#mantle.party.communication.CommunicationEvent", {
            communicationEventId: row.communicationEventId,
            datetimeEnded: ec.user.nowTimestamp
        })
    singleUseLists(row, true)
    return {completed: true}
}
// The single-use lists the send holds, consumed (it reached someone) or freed (nothing was handed off).
function singleUseLists(row, consume) {
    for (const list of Array.from(find(LIST, {reservedBySendId: row.campaignSendId}).list()))
        try {
            call("mantle.marketing.AudienceServices.release#SingleUseList", {
                contactListId: list.contactListId,
                sendId: row.campaignSendId,
                consume
            })
        } catch (error) {
            ec.message.clearErrors()
            ec.logger.error(
                "Send " + row.campaignSendId + ": single-use list " + list.contactListId + " not released: " + error.message
            )
        }
}

// ===== pause#Send, cancel#Send =====
function pauseSend(p) {
    const userScope = dispatchScope()
    const row = sends().sendOf(userScope, p.campaignSendId, true)
    if (row.statusId === "CsPaused")
        return {campaignSendId: row.campaignSendId, statusId: row.statusId, inFlightCount: inFlight(row)}
    if (!stoppableStatuses.includes(row.statusId))
        denied("STATUS_INVALID", "Send " + row.campaignSendId + " is " + sends().statusText(row.statusId).toLowerCase())
    call("update#" + SEND, {
        campaignSendId: row.campaignSendId,
        statusId: "CsPaused",
        statusId_changeReason:
            "Paused by " + (ec.user.username || ec.user.userId) + (text(p.reason) ? ": " + text(p.reason).slice(0, 200) : ""),
        pausedDate: ec.user.nowTimestamp
    })
    return {campaignSendId: row.campaignSendId, statusId: "CsPaused", inFlightCount: inFlight(row)}
}
const inFlight = row => {
    const counts = deliveryCounts(row.campaignSendId)
    return counts.MdsQueued + counts.MdsRetry
}
function cancelSend(p) {
    const userScope = sends().readScope()
    const caps = userScope.capabilities
    const row = sends().sendOf(userScope, p.campaignSendId, true)
    if (row.statusId === "CsCancelled")
        return {campaignSendId: row.campaignSendId, statusId: row.statusId, inFlightCount: inFlight(row)}
    const byDispatcher =
        !!caps.dispatch && ["CsApproved", "CsScheduled", "CsSending", "CsPaused", "CsSampleSent"].includes(row.statusId)
    const byAuthor = !!caps.sendEdit && ["CsDraft", "CsAwaitingApproval", "CsApproved"].includes(row.statusId)
    if (!byDispatcher && !byAuthor) {
        if (!caps.dispatch && !caps.sendEdit)
            denied("PERMISSION_DENIED", "Cancelling a send needs Marketing's send or dispatch permission")
        denied("STATUS_INVALID", "Send " + row.campaignSendId + " is " + sends().statusText(row.statusId).toLowerCase())
    }
    const reason = text(p.reason)
    if (!reason) denied("REASON_REQUIRED", "A cancellation needs its reason")
    // P10: an experiment's remainder held for the winner is not sent either
    const cancelledCount = find(RECIPIENT, {campaignSendId: row.campaignSendId})
        .condition("statusId", "in", ["CrsSelected", "CrsHeld"])
        .updateAll({statusId: "CrsCancelled", leaseUntilDate: null})
    call("update#" + SEND, {
        campaignSendId: row.campaignSendId,
        statusId: "CsCancelled",
        statusId_changeReason: "Cancelled by " + (ec.user.username || ec.user.userId) + ": " + reason.slice(0, 200),
        cancelledDate: ec.user.nowTimestamp,
        cancelReason: reason.slice(0, 255)
    })
    const handedOffCount = find(RECIPIENT, {campaignSendId: row.campaignSendId, statusId: "CrsHandedOff"}).count()
    // a single-use list is freed when nothing was handed off, else used
    singleUseLists(row, handedOffCount > 0)
    return {
        campaignSendId: row.campaignSendId,
        statusId: "CsCancelled",
        cancelledCount,
        handedOffCount,
        inFlightCount: inFlight(row)
    }
}

// ===== find#Recipients, get#Recipient =====
const deliveryStateTexts = ledger.stateTexts
// The rows of a send's recipients (the current preparation), filtered in the query: state (waiting, handedOff, skipped, cancelled, or a
// delivery's: sent, failed, uncertain, inFlight, suppressed), reason, text (part of the address, for an audience reader); paged.
function findRecipients(p) {
    const userScope = readerScope()
    const row = sends().sendOf(userScope, p.campaignSendId)
    const unmasked = !!userScope.capabilities.audienceRead
    let query = find(RECIPIENT, {campaignSendId: row.campaignSendId}).condition(
        "preparedRevision",
        Number(row.preparedRevision || 0)
    )
    const state = text(p.state)
    const recipientStates = {
        waiting: "CrsSelected",
        handedOff: "CrsHandedOff",
        skipped: "CrsSkipped",
        cancelled: "CrsCancelled",
        held: "CrsHeld"
    }
    const deliveryStates = {
        sent: ["MdsSent"],
        failed: ["MdsFailed"],
        uncertain: ["MdsUncertain"],
        inFlight: ["MdsQueued", "MdsRetry"],
        suppressed: ["MdsSuppressed"]
    }
    if (recipientStates[state]) query = query.condition("statusId", recipientStates[state])
    else if (deliveryStates[state]) {
        const deliveryIds = Array.from(
            find(D, {sourceEnumId: SOURCE})
                .condition("eventKey", "like", eventPrefix(row.campaignSendId) + "%")
                .condition("stateEnumId", "in", deliveryStates[state])
                .selectField("deliveryId")
                .limit(5000)
                .list()
        ).map(delivery => delivery.deliveryId)
        query = query.condition("messageDeliveryId", "in", deliveryIds.length ? deliveryIds : ["_none_"])
    } else query = query.condition("statusId", "in", ["CrsSelected", "CrsHandedOff", "CrsSkipped", "CrsCancelled", "CrsHeld"])
    if (!blank(p.skipReasonCode)) query = query.condition("skipReasonCode", text(p.skipReasonCode))
    if (!blank(p.text) && unmasked) {
        const like =
            "%" +
            text(p.text)
                .toLowerCase()
                .replace(/[\\%_]/g, c => "\\" + c) +
            "%"
        query = query.condition(ec.entity.conditionFactory.makeCondition("destinationKey", "like", like).ignoreCase())
    }
    query = query.orderBy("campaignRecipientId")
    const count = query.count()
    const paged = lib.page(query, p, "recipientList", count, {noLimitCap: 5000})
    const recipientList = recipientRows(paged.rows, unmasked)
    delete paged.rows
    paged.recipientList = recipientList
    return Object.assign(paged, {unmasked, summary: controlOf(userScope, row).delivery})
}
function recipientRows(recipientRows, unmasked) {
    const deliveryIds = recipientRows.map(recipient => recipient.messageDeliveryId).filter(Boolean)
    const deliveries = new Map(
        deliveryIds.length
            ? Array.from(find(D).condition("deliveryId", "in", deliveryIds).list()).map(delivery => [
                  delivery.deliveryId,
                  delivery
              ])
            : []
    )
    const names = unmasked ? lib.partyNames(recipientRows.map(recipient => recipient.partyId)) : {}
    // P10: each recipient's variant, by its label
    const variantLabels = experiments().labelsOf(recipientRows.map(recipient => recipient.campaignExperimentVariantId))
    return recipientRows.map(recipient => {
        const delivery = deliveries.get(recipient.messageDeliveryId) || null
        const address = recipient.destinationKey || ""
        return {
            campaignRecipientId: recipient.campaignRecipientId,
            recipientName: unmasked ? names[recipient.partyId] || "" : "",
            addressText: unmasked ? address : suppressions.mask(address),
            statusId: recipient.statusId,
            statusText: recipientTexts[recipient.statusId] || recipient.statusId,
            deliveryStateEnumId: delivery?.stateEnumId || null,
            deliveryStateText: delivery ? deliveryStateTexts[delivery.stateEnumId] || delivery.stateEnumId : "",
            attempts: delivery ? Number(delivery.attempts || 0) : 0,
            receiptText: delivery?.receiptEnumId
                ? one("moqui.basic.Enumeration", {enumId: delivery.receiptEnumId})?.description || ""
                : "",
            reasonText: recipient.skipReasonCode ? reasonText(recipient.skipReasonCode) : noAddress(delivery?.lastError || ""),
            handedOffDateText: recipient.handedOffDate ? lib.dateText(recipient.handedOffDate) : "",
            sentDateText: delivery?.sentDate ? lib.dateText(delivery.sentDate) : "",
            uncertain: delivery?.stateEnumId === "MdsUncertain",
            retryable: delivery?.stateEnumId === "MdsFailed" && lastOutcome(delivery) === "retryable",
            variantText: recipient.campaignExperimentVariantId
                ? (variantLabels[recipient.campaignExperimentVariantId] || "") +
                  (recipient.experimentRemainder === "Y" ? " (winner, to the remainder)" : "")
                : recipient.experimentRemainder === "Y"
                  ? "Remainder"
                  : ""
        }
    })
}
const lastOutcome = delivery =>
    one(ATTEMPT, {deliveryId: delivery.deliveryId, attemptSeqId: String(Number(delivery.attempts || 0)).padStart(3, "0")})
        ?.outcome || null
// A recipient of the scope's send (RECORD_UNAVAILABLE otherwise).
function recipientOf(userScope, campaignRecipientId, lock = false) {
    let query = blank(campaignRecipientId) ? null : find(RECIPIENT, {campaignRecipientId: text(campaignRecipientId)})
    if (query && lock) query = query.forUpdate(true)
    const recipient = query ? query.one() : null
    const row = recipient ? one(SEND, {campaignSendId: recipient.campaignSendId}) : null
    if (!recipient || !row || !marketingAccess.covers(userScope, row.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Recipient " + text(campaignRecipientId) + " is not available")
    return {recipient, row}
}
function getRecipient(p) {
    const userScope = readerScope()
    const {recipient, row} = recipientOf(userScope, p.campaignRecipientId)
    const unmasked = !!userScope.capabilities.audienceRead
    const [shown] = recipientRows([recipient], unmasked)
    const delivery = recipient.messageDeliveryId ? one(D, {deliveryId: recipient.messageDeliveryId}) : null
    const consent = delivery ? lib.json(delivery.consentJson, {}) || {} : {}
    const attemptList = delivery
        ? Array.from(find(ATTEMPT, {deliveryId: delivery.deliveryId}).orderBy("attemptSeqId").list()).map(attempt => ({
              attemptSeqId: attempt.attemptSeqId,
              attemptDateText: lib.dateText(attempt.attemptDate),
              outcome: attempt.outcome,
              providerMessageId: attempt.providerMessageId || "",
              error: noAddress(attempt.error || "")
          }))
        : []
    const receiptList = delivery
        ? Array.from(
              find("mantle.party.MessageDeliveryReceipt", {deliveryId: delivery.deliveryId}).orderBy("receiptDate").list()
          ).map(receipt => ({
              receiptText: one("moqui.basic.Enumeration", {enumId: receipt.receiptEnumId})?.description || receipt.receiptEnumId,
              receiptDateText: lib.dateText(receipt.receiptDate),
              detail: noAddress(receipt.detail || "")
          }))
        : []
    const caps = userScope.capabilities
    return {
        recipient: Object.assign(shown, {
            campaignSendId: row.campaignSendId,
            sendName: sends().label(row),
            topicName: one(LIST, {contactListId: row.contactListId})?.contactListName || row.contactListId,
            partyId: unmasked ? recipient.partyId : null,
            selectedDateText: lib.dateText(recipient.selectedDate),
            preparedRevision: Number(recipient.preparedRevision || 0),
            tracked: recipient.tracked === "Y",
            skipReasonCode: recipient.skipReasonCode || null,
            consentText: delivery
                ? consent.transactional
                    ? "Transactional"
                    : (consent.granted ? "Consent granted" : "No consent") + (consent.at ? " at " + consent.at : "")
                : "",
            deliveryId: delivery?.deliveryId || null,
            deliveryStateText: delivery ? deliveryStateTexts[delivery.stateEnumId] || delivery.stateEnumId : "",
            providerMessageId: delivery?.providerMessageId || "",
            resolvedText: delivery?.resolvedDate
                ? "Resolved " +
                  lib.dateText(delivery.resolvedDate) +
                  " by " +
                  userName(delivery.resolvedByUserId) +
                  (delivery.resolutionNote ? ": " + noAddress(delivery.resolutionNote) : "")
                : "",
            revision: delivery ? ms(delivery.lastUpdatedStamp) : null
        }),
        attemptList,
        receiptList,
        capabilities: {
            canReconcile:
                !!caps.dispatch && ec.user.hasPermission("MESSAGE_DELIVERY_REVIEW") && delivery?.stateEnumId === "MdsUncertain",
            canRetry: !!caps.dispatch && shown.retryable && row.statusId !== "CsCancelled"
        }
    }
}

// ===== retry#Recipients, reconcile#Recipient =====
// The recipients chosen (or every one of the send whose delivery failed after its retryable tries), each still eligible, asked of the
// ledger again (requeue#Delivery, then one attempt); an uncertain delivery is never among them. {retriedCount, results}.
function retryRecipients(p) {
    const userScope = dispatchScope()
    const row = sends().sendOf(userScope, p.campaignSendId, true)
    if (!["CsSending", "CsPaused", "CsSampleSent", "CsCompleted", "CsCompletedFailures"].includes(row.statusId))
        denied("STATUS_INVALID", "Send " + row.campaignSendId + " is " + sends().statusText(row.statusId).toLowerCase())
    const chosen = Array.from(
        new Set(
            Array.from(p.campaignRecipientIdList || [])
                .map(text)
                .filter(Boolean)
        )
    ).slice(0, 1000)
    let query = find(RECIPIENT, {campaignSendId: row.campaignSendId, statusId: "CrsHandedOff"})
    if (chosen.length) query = query.condition("campaignRecipientId", "in", chosen)
    const handed = Array.from(query.limit(1000).list())
    const deliveries = new Map(
        handed.length
            ? Array.from(
                  find(D, {stateEnumId: "MdsFailed"})
                      .condition("deliveryId", "in", handed.map(recipient => recipient.messageDeliveryId).filter(Boolean))
                      .list()
              ).map(delivery => [delivery.deliveryId, delivery])
            : []
    )
    const candidates = handed.filter(recipient => {
        const delivery = deliveries.get(recipient.messageDeliveryId)
        return delivery && lastOutcome(delivery) === "retryable"
    })
    const verdicts =
        (candidates.length
            ? checkPage(
                  row.campaignSendId,
                  candidates.map(recipient => recipient.campaignRecipientId)
              )
            : {}) || {}
    const results = []
    const requeued = []
    for (const recipient of candidates) {
        const verdict = verdicts[recipient.campaignRecipientId] || {}
        if (!verdict.eligible) {
            results.push({
                campaignRecipientId: recipient.campaignRecipientId,
                retried: false,
                reasonText: verdict.reasonCode ? reasonText(verdict.reasonCode) : "Could not be checked"
            })
            continue
        }
        try {
            const out = call("mantle.party.MessageServices.requeue#Delivery", {deliveryId: recipient.messageDeliveryId})
            if (out.requeued) requeued.push(recipient.messageDeliveryId)
            results.push({
                campaignRecipientId: recipient.campaignRecipientId,
                retried: !!out.requeued,
                reasonText: out.requeued ? "" : "Not failed"
            })
        } catch (error) {
            ec.message.clearErrors()
            results.push({
                campaignRecipientId: recipient.campaignRecipientId,
                retried: false,
                reasonText: "Could not be queued again"
            })
        }
    }
    for (const id of chosen)
        if (!candidates.some(recipient => recipient.campaignRecipientId === id))
            results.push({campaignRecipientId: id, retried: false, reasonText: "Not a retryable failure"})
    if (requeued.length && ["CsCompletedFailures", "CsSampleSent"].includes(row.statusId))
        call("update#" + SEND, {
            campaignSendId: row.campaignSendId,
            statusId: "CsSending",
            statusId_changeReason: "Failures tried again by " + (ec.user.username || ec.user.userId),
            completedDate: null
        })
    // the ledger's attempts once this commits (each in its own transaction), and the send swept again
    if (requeued.length) dispatchAfterCommit(row.campaignSendId)
    for (const deliveryId of requeued)
        try {
            ec.service.special().name("mantle.party.MessageServices.attempt#Delivery").parameters({deliveryId}).registerOnCommit()
        } catch (error) {
            ec.logger.warn("Delivery " + deliveryId + " waits for the ledger's job: " + String(error.message).split("\n")[0])
        }
    return {campaignSendId: row.campaignSendId, retriedCount: requeued.length, results}
}
// A dispatcher's evidence on an uncertain delivery, recorded through the ledger's resolve#Delivery (as the dispatcher: its permission
// and the delivery's organization): sent (the provider shows it went out), failed, or retry (the investigation shows it never went).
function reconcileRecipient(p) {
    const userScope = dispatchScope()
    const {recipient, row} = recipientOf(userScope, p.campaignRecipientId, true)
    const outcome = text(p.outcome)
    if (!["sent", "failed", "retry"].includes(outcome)) denied("OUTCOME_INVALID", "Choose sent, failed or retry")
    const evidence = text(p.evidenceText)
    const reason = text(p.reason)
    if (!evidence) denied("EVIDENCE_REQUIRED", "Give the provider's record or what the investigation found")
    if (!reason) denied("REASON_REQUIRED", "Give the reason for the outcome")
    const delivery = recipient.messageDeliveryId ? one(D, {deliveryId: recipient.messageDeliveryId}) : null
    if (!delivery || delivery.stateEnumId !== "MdsUncertain")
        denied("NOT_UNCERTAIN", "Only an uncertain delivery is reconciled; a failure is retried instead")
    if (!blank(p.expectedRevision) && ms(p.expectedRevision) !== ms(delivery.lastUpdatedStamp))
        denied("STALE_REVISION", "Delivery " + delivery.deliveryId + " changed since it was read")
    const note = [
        "Reconciled from send " + row.campaignSendId,
        text(p.providerReference) ? "provider reference " + text(p.providerReference).slice(0, 200) : null,
        "evidence: " + evidence.slice(0, 1000),
        "reason: " + reason.slice(0, 1000)
    ]
        .filter(Boolean)
        .join("; ")
    ec.message.pushErrors()
    let out
    try {
        out =
            ec.service
                .sync()
                .name("mantle.party.MessageServices.resolve#Delivery")
                .parameters({deliveryId: delivery.deliveryId, outcome, note})
                .call() || {}
        if (ec.message.hasError()) {
            const message = ec.message.getErrorsString()
            const code = lib.reasonCode({message}) || "PERMISSION_DENIED"
            denied(code, message.replace(/^[A-Z_]+:\s*/, ""))
        }
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
    if (outcome === "retry")
        try {
            ec.service
                .special()
                .name("mantle.party.MessageServices.attempt#Delivery")
                .parameters({deliveryId: delivery.deliveryId})
                .registerOnCommit()
        } catch (error) {
            ec.logger.warn("Delivery " + delivery.deliveryId + " waits for the ledger's job")
        }
    dispatchAfterCommit(row.campaignSendId)
    return {campaignRecipientId: recipient.campaignRecipientId, stateEnumId: out.stateEnumId}
}

// ===== build#CampaignDelivery (the ledger's MdsrcCampaignSend) =====
// One recipient's message before each attempt: suppressed when the recipient, its send or its organization does not hold, the
// recipient left the topic or the address changed since approval; else the prepared content with their values, the unsubscribe
// header and link, the attachments and the reply-to.
function buildDelivery(p) {
    const delivery = one(D, {deliveryId: text(p.deliveryId)})
    if (!delivery) return {suppress: "The delivery is gone"}
    const key = String(delivery.eventKey || "")
    const match = /^CampaignSend:([^:]+):(.+)$/.exec(key)
    const recipient = match ? one(RECIPIENT, {executionKey: match[2]}) : null
    const row = recipient ? one(SEND, {campaignSendId: recipient.campaignSendId}) : null
    if (!recipient || !row || row.campaignSendId !== match[1] || row.organizationPartyId !== delivery.organizationPartyId)
        return {suppress: "The send is not available"}
    if (recipient.partyId !== delivery.recipientPartyId) return {suppress: "The recipient is not the delivery's"}
    // still on the topic: an accepted member now
    const membership = Array.from(
        find(CLP, {contactListId: row.contactListId, partyId: recipient.partyId})
            .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
            .orderBy("-fromDate")
            .list()
    )[0]
    if (!membership || !accepted.includes(membership.statusId)) return {suppress: "No longer on the topic"}
    // the address approved, still the person's
    const mech = recipient.contactMechId
        ? one("mantle.party.contact.ContactMech", {contactMechId: recipient.contactMechId})
        : null
    const current =
        mech &&
        Array.from(
            find("mantle.party.contact.PartyContactMech", {partyId: recipient.partyId, contactMechId: recipient.contactMechId})
                .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                .list()
        ).length > 0
    if (!current || suppressions.normalize("MdcEmail", mech.infoString) !== recipient.destinationKey)
        return {suppress: "The address changed since approval"}
    const s = sends()
    // P10: a recipient of an experiment gets its variant's prepared content (a sample's, or the winner's for the remainder)
    let prepared = s.preparedContent(row)
    if (recipient.campaignExperimentVariantId) {
        prepared = experiments().preparedVariantContent(row, recipient.campaignExperimentVariantId)
        if (!prepared) return {suppress: "The recipient's variant was not prepared with the send"}
    } else if (recipient.experimentRemainder === "Y") return {suppress: "The recipient waits for the winner"}
    const rendered = s.render(prepared, s.recipientValues(recipient.partyId))
    const profile = row.sendingProfileId ? one(PROFILE, {sendingProfileId: row.sendingProfileId}) : null
    const where = unsubscribeLink(row, profile, row.unsubscribeBaseUrl)
    if (!where.ready) return {suppress: "The unsubscribe link has no address"}
    const link = call("mantle.party.ConsentServices.create#UnsubscribeToken", {
        contactListId: row.contactListId,
        partyId: recipient.partyId,
        contactMechId: recipient.contactMechId,
        communicationEventId: row.communicationEventId || null,
        purposeEnumId: row.purposeEnumId || null,
        siteId: where.siteId,
        baseUrl: where.baseUrl
    })
    const url = link.unsubscribeUrl
    const topicName = one(LIST, {contactListId: row.contactListId})?.contactListName || "this list"
    const encode = value => WebUtilities.encodeHtml(String(value == null ? "" : value))
    let body = rendered.body || ""
    if (rendered.preheader)
        body =
            '<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">' + encode(rendered.preheader) + "</div>" + body
    if (body && !body.includes(url))
        body +=
            '<p style="font-size:12px;color:#666666">You receive this email because you subscribed to ' +
            encode(topicName) +
            '. <a href="' +
            encode(url) +
            '">Unsubscribe</a></p>'
    let bodyText = rendered.bodyText || ""
    if (bodyText && !bodyText.includes(url))
        bodyText += "\n\n--\nYou receive this email because you subscribed to " + topicName + ". Unsubscribe: " + url + "\n"
    const attachments = []
    for (const file of lib.json(row.preparedAttachmentsJson, []) || []) {
        const stream = ec.resource.getLocationStream(file.location)
        if (!stream) return {suppress: "An attachment of the prepared send is gone"}
        try {
            attachments.push({fileName: file.fileName, contentType: file.contentType, contentBytes: stream.readAllBytes()})
        } finally {
            stream.close()
        }
    }
    return {
        bodyParameters: {},
        toAddress: mech.infoString,
        subject: rendered.subject,
        body: body || null,
        bodyText: bodyText || null,
        extraHeaders: link.listUnsubscribeHeaders,
        ...(attachments.length ? {attachments} : {}),
        ...(row.replyToAddress ? {replyToAddresses: row.replyToAddress} : {})
    }
}

// ===== the delivery report (CampaignDelivery's CSV and print) =====
// Every recipient row of a send (up to 5,000), addresses masked by permission, no token or body: find#Recipients with every row.
const report = p => findRecipients(Object.assign({}, p, {pageNoLimit: "true"}))

const operations = {
    release: releaseSend,
    runDue,
    startDue,
    dispatch: dispatchSend,
    claimPage,
    handOff,
    sweep,
    pause: pauseSend,
    cancel: cancelSend,
    findRecipients,
    getRecipient,
    retry: retryRecipients,
    reconcile: reconcileRecipient,
    build: buildDelivery,
    report
}
;({
    controlOf,
    limits,
    SOURCE,
    // P10: what the winner's release (MarketingExperiments.js) shares
    forExperiments: {dispatchScope, releaseParties, dispatchAfterCommit, checkPage, reasonText, deliveryCounts, eventPrefix},
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown campaign dispatch operation " + op)
        return operations[op](parameters || {})
    }
})
