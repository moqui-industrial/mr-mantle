// Saved replies on a case (design-customer-service §9 SavedReplies ReplyPreview, §3 CaseDetail, Cases BulkCaseAction;
// impl-customer-service P5, CS-REPLIES, D24; SupportAssignmentEntities.xml). A saved reply is a Comms text block (the
// framework's moqui.basic.email.EmailTextBlock: the user's own, or shared with a group the user is in now: a team's group or
// the service-wide one) with its SavedReply facts (organization, language, variables) and SavedReplyAction rows. preview
// resolves its variables for the case ({{customerName}} and the others of `variables`; one it does not know, or one with no
// value on the case, is an error, never an empty promise), names the recipient (the case's contact, else its customer, by
// their email) and says of each action whether it may run on the case now and why not. apply runs the actions and the
// reply on the case in one transaction (the case changes commit together or not at all) after the agent confirmed: the
// actions through the case services' own rules, then the reply as a draft in the user's service mailbox sent through the
// mail client (send#EmailDraft, filed on the case once it is sent, ES_SENT, so a sent reply meets first response and a
// failed one does not, P4). The message keeps its pending or failed state by its emailMessageId; the operation key answers a
// retry with the first result, and a retry of one whose send failed sends that same message again, never a second reply.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, call, denied, access, ms} = lib

const BLOCK = "moqui.basic.email.EmailTextBlock",
    REPLY = "mantle.request.support.SavedReply",
    ACTION = "mantle.request.support.SavedReplyAction",
    REQUEST = "mantle.request.Request",
    MESSAGE = "moqui.basic.email.EmailMessage"
let casesModule = null
const cases = () =>
    casesModule || (casesModule = ec.resource.script("component://mr-mantle/service/mantle/request/SupportCases.js"))
const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const partyName = partyId => (partyId ? lib.partyNames([partyId])[partyId] || partyId : "")
const escapeHtml = value =>
    String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
const textOf = html =>
    String(html || "")
        .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n")
        .replace(/<[^>]*>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
        .trim()
const variablePattern = /\{\{\s*([^{}\s]*)\s*\}\}/g
// the variables a saved reply may use, each with its value on a case
const variables = {
    customerName: c => partyName(c.customerPartyId),
    contactName: c => partyName(c.contactPartyId),
    contactFirstName: c => (c.contactPartyId ? one("mantle.party.Person", {partyId: c.contactPartyId})?.firstName || null : null),
    caseId: c => c.requestId,
    caseSubject: c => c.request.requestName,
    queueName: c =>
        c.request.requestCategoryId
            ? one("mantle.request.RequestCategory", {requestCategoryId: c.request.requestCategoryId})?.description
            : null,
    organizationName: c => partyName(c.organizationPartyId),
    agentName: () => partyName(ec.user.userAccount?.partyId) || ec.user.userAccount?.userFullName || null,
    statusLabel: c =>
        cases().mappingFor(c.profile.caseWorkflowId, c.request.statusId)?.customerLabel ||
        one("moqui.basic.StatusItem", {statusId: c.request.statusId})?.description
}
const variableNames = Object.keys(variables)

// The variables a text uses.
const usedIn = value => Array.from(String(value || "").matchAll(variablePattern)).map(match => match[1])
// The text with the case's values put in (HTML-escaped for a body), and the errors of any variable it does not know or that
// has no value on the case.
function resolve(value, theCase, html) {
    const errors = []
    const resolved = String(value || "").replace(variablePattern, (all, name) => {
        if (!variables[name]) {
            errors.push({reasonCode: "UNSUPPORTED_VARIABLE", name, message: "{{" + name + "}} is not a variable a reply may use"})
            return all
        }
        const found = variables[name](theCase)
        if (blank(found)) {
            errors.push({reasonCode: "UNRESOLVED_VARIABLE", name, message: "{{" + name + "}} has no value on this case"})
            return all
        }
        return html ? escapeHtml(found) : String(found)
    })
    return {text: resolved, errors}
}

// ===== the saved reply and the case =====
// A text block the user may use (their own, or shared with a group they are in now), with its saved reply facts and actions;
// another organization's or a disabled reply is not offered on the case (REPLY_UNAVAILABLE).
function replyOf(emailTextBlockId, organizationPartyId) {
    const unavailable = () => denied("REPLY_UNAVAILABLE", "Saved reply " + (emailTextBlockId || "") + " is not available")
    const block = emailTextBlockId ? one(BLOCK, {emailTextBlockId}) : null
    if (!block) unavailable()
    const mine = block.ownerUserId === ec.user.userId
    const shared =
        !!block.userGroupId &&
        find("moqui.security.UserGroupMember", {userId: ec.user.userId, userGroupId: block.userGroupId})
            .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
            .count() > 0
    if (!mine && !shared) unavailable()
    const facts = one(REPLY, {emailTextBlockId})
    if (facts?.disabled === "Y") unavailable()
    if (facts?.organizationPartyId && organizationPartyId && facts.organizationPartyId !== organizationPartyId) unavailable()
    const actions = rows(ACTION, {emailTextBlockId}).sort((a, b) => (a.sequenceNum ?? 0) - (b.sequenceNum ?? 0))
    return {block, facts, actions}
}
// Whether a party works on the service side (an internal organization, or a person who works for one).
const isStaff = partyId => !!partyId && (cases().isInternal(partyId) || cases().organizationsOf(partyId).length > 0)
// The case for a reply: its request, profile and parties, and its contact (the Reporter, when not staff; else the customer).
function caseFor(requestId, lock) {
    const theCase = cases().caseOf(requestId, lock)
    const reporter = cases().roleParty(theCase.parties, "Reporter")
    theCase.contactPartyId = reporter && !isStaff(reporter) ? reporter : theCase.customerPartyId
    return theCase
}
// The email of a party: its primary one, else any current one.
function emailOf(partyId) {
    if (!partyId) return null
    const mechs = rows("mantle.party.contact.PartyContactMech", {partyId}).filter(row => lib.active(row))
    if (!mechs.length) return null
    const addresses = Array.from(
        find("mantle.party.contact.ContactMech")
            .condition(
                "contactMechId",
                "in",
                mechs.map(row => row.contactMechId)
            )
            .condition("contactMechTypeEnumId", "CmtEmailAddress")
            .list()
    )
    const primary = mechs.find(
        row => row.contactMechPurposeId === "EmailPrimary" && addresses.some(mech => mech.contactMechId === row.contactMechId)
    )
    const chosen = primary ? addresses.find(mech => mech.contactMechId === primary.contactMechId) : addresses[0]
    return text(chosen?.infoString)
}
// Who the reply goes to: the case's contact, else its customer, by email (one recipient: no address list of other parties).
function recipientsOf(theCase) {
    for (const partyId of [theCase.contactPartyId, theCase.customerPartyId]) {
        const address = emailOf(partyId)
        if (address) return [{partyId, name: partyName(partyId), address}]
    }
    return []
}
// The thread the reply joins: the case's latest mail the user may read, so each case keeps its own thread.
function threadOf(theCase) {
    const eventIds = rows("mantle.request.RequestCommEvent", {requestId: theCase.requestId}).map(row => row.communicationEventId)
    const events = eventIds.length
        ? Array.from(
              find("mantle.party.communication.CommunicationEvent")
                  .condition("communicationEventId", "in", eventIds)
                  .condition("emailMessageId", "is-not-null", null)
                  .orderBy("-entryDate")
                  .limit(20)
                  .list()
          )
        : []
    const ids = events.map(row => row.emailMessageId)
    if (theCase.profile.emailMessageId) ids.push(theCase.profile.emailMessageId)
    if (!ids.length) return null
    const accessMap = lib.call("org.moqui.mail.EmailClientServices.get#EmailAccountAccess").accessMap || {}
    for (const emailMessageId of ids) {
        const message = one(MESSAGE, {emailMessageId})
        if (message && accessMap[message.emailAccountId]) return message
    }
    return null
}
// The account the reply is sent from: the one named (that the user may send from), else the user's of the case's
// organization, else their first; none is refused when sending.
function senderAccount(emailAccountId, organizationPartyId) {
    const sendable = Array.from(lib.call("org.moqui.mail.EmailClientServices.get#EmailAccountAccess").accountList || []).filter(
        account => account.canSend
    )
    const account = !blank(emailAccountId)
        ? sendable.find(row => row.emailAccountId === emailAccountId)
        : sendable.find(row => row.ownerPartyId === organizationPartyId) || sendable[0]
    return account || null
}
// The delivery of a reply's message: pending (waiting or sending), sent, failed (in the Outbox with its error) or cancelled.
function deliveryOf(emailMessageId) {
    const message = emailMessageId ? one(MESSAGE, {emailMessageId}) : null
    if (!message) return {deliveryStatus: null, statusId: null, sendError: null}
    const statusId = message.statusId
    const deliveryStatus =
        statusId === "ES_SENT" || statusId === "ES_VIEWED"
            ? "sent"
            : statusId === "ES_BOUNCED" || statusId === "ES_CANCELLED"
              ? "failed"
              : message.sendError
                ? "failed"
                : "pending"
    return {deliveryStatus, statusId, sendError: message.sendError || null}
}

// ===== the actions =====
// Whether an action may run on the case now, by the case services' rules: {allowed, reasonCode, message}.
function actionCheck(action, theCase) {
    const refuse = (reasonCode, message) => ({allowed: false, reasonCode, message})
    const mine = !theCase.assigneePartyId || theCase.assigneePartyId === ec.user.userAccount?.partyId
    const queue = cases().queueOf(theCase.request.requestCategoryId)?.queue || null
    switch (action.actionEnumId) {
        case "SraSetStatus": {
            if (action.statusId === theCase.request.statusId) return {allowed: true, reasonCode: null, message: "Already so"}
            const move = cases().transitionFor(theCase.profile.caseWorkflowId, theCase.request.statusId, action.statusId)
            if (!move) return refuse("TRANSITION_NOT_ALLOWED", "The case does not move from its status to this one")
            if (move.manageRequired === "Y" && !access.has("SUPPORT_CASE_MANAGE"))
                return refuse("PERMISSION_DENIED", "This move needs a service manager")
            if (move.reasonRequired === "Y" && !text(action.noteText))
                return refuse("REASON_REQUIRED", "This move needs a reason, which the reply does not give")
            return {allowed: true, reasonCode: null, message: ""}
        }
        case "SraAddTag":
            if (one("moqui.basic.Enumeration", {enumId: action.tagEnumId})?.enumTypeId !== "RequestTag")
                return refuse("TAG_UNKNOWN", "Not a case tag")
            return {allowed: true, reasonCode: null, message: ""}
        case "SraAssign":
        case "SraAssignSelf": {
            const partyId = action.actionEnumId === "SraAssignSelf" ? ec.user.userAccount?.partyId : action.assigneePartyId
            if (!mine && !access.has("SUPPORT_CASE_MANAGE"))
                return refuse("PERMISSION_DENIED", "The case is another agent's: a service manager reassigns it")
            const checked = lib.check(() => cases().checkAssignee(partyId, queue, theCase.organizationPartyId))
            return checked.allowed
                ? {allowed: true, reasonCode: null, message: ""}
                : refuse(checked.reasonCode, partyName(partyId) + " cannot be assigned this case")
        }
        case "SraSetPriority":
            if (!(Number(action.priority) >= 1 && Number(action.priority) <= 9))
                return refuse("PRIORITY_INVALID", "A priority is 1 (highest) to 9 (lowest)")
            if (!mine && !access.has("SUPPORT_CASE_MANAGE"))
                return refuse("PERMISSION_DENIED", "The case is another agent's: a service manager changes it")
            return {allowed: true, reasonCode: null, message: ""}
        case "SraAddNote":
            return text(action.noteText)
                ? {allowed: true, reasonCode: null, message: ""}
                : refuse("NOTE_REQUIRED", "The note has no text")
        default:
            return refuse("ACTION_UNKNOWN", (action.actionEnumId || "") + " is not a saved reply action")
    }
}
// An action as a sentence.
function actionText(action) {
    switch (action.actionEnumId) {
        case "SraSetStatus":
            return (
                "Set the status to " +
                (one("moqui.basic.StatusItem", {statusId: action.statusId})?.description || action.statusId)
            )
        case "SraAddTag":
            return "Add the tag " + enumText(action.tagEnumId)
        case "SraAssign":
            return "Assign to " + partyName(action.assigneePartyId)
        case "SraAssignSelf":
            return "Assign to me"
        case "SraSetPriority":
            return "Set the priority to " + action.priority
        case "SraAddNote":
            return "Add an internal note"
        default:
            return enumText(action.actionEnumId)
    }
}
// Run one action on the case (each through the case services, which check again).
function runAction(action, theCase) {
    const requestId = theCase.requestId
    switch (action.actionEnumId) {
        case "SraSetStatus":
            if (action.statusId !== one(REQUEST, {requestId}).statusId)
                cases().transitionCase({
                    requestId,
                    toStatusId: action.statusId,
                    resolutionEnumId: action.resolutionEnumId || null,
                    reason: action.noteText || null
                })
            return
        case "SraAddTag":
            cases().setTags({requestId, tagEnumIds: [action.tagEnumId], mode: "add"})
            return
        case "SraAssign":
        case "SraAssignSelf":
            cases().updateCase({
                requestId,
                assigneePartyId: action.actionEnumId === "SraAssignSelf" ? ec.user.userAccount?.partyId : action.assigneePartyId
            })
            return
        case "SraSetPriority":
            cases().updateCase({requestId, priority: action.priority})
            return
        case "SraAddNote":
            call("mantle.request.RequestServices.add#RequestComment", {
                requestId,
                body: String(action.noteText).trim(),
                contentType: "text/plain"
            })
            return
    }
}

// ===== preview#SavedReply =====
// The reply as it would go on the case: subject and body with the case's values, the variable errors, the recipient, the
// actions each with whether it may run now, the mailbox it goes from, and the case's revision to apply it at.
function previewOf(p, theCase) {
    const {block, facts, actions} = replyOf(p.emailTextBlockId, theCase.organizationPartyId)
    const body = resolve(p.bodyHtml != null && p.bodyHtml !== "" ? p.bodyHtml : block.bodyHtml, theCase, true)
    const thread = threadOf(theCase)
    const subjectSource =
        text(p.subject) ||
        text(facts?.subject) ||
        (thread?.subject ? "Re: " + String(thread.subject).replace(/^re:\s*/i, "") : null)
    const subject = resolve(subjectSource || "{{caseSubject}} (case {{caseId}})", theCase, false)
    const recipients = recipientsOf(theCase)
    const account = senderAccount(p.emailAccountId, theCase.organizationPartyId)
    const errors = body.errors.concat(subject.errors)
    if (!recipients.length)
        errors.push({
            reasonCode: "RECIPIENT_REQUIRED",
            name: null,
            message: partyName(theCase.contactPartyId || theCase.customerPartyId) + " has no email address"
        })
    if (!account) errors.push({reasonCode: "SEND_ACCOUNT_REQUIRED", name: null, message: "You have no mailbox to send from"})
    const actionList = actions.map(action =>
        Object.assign(
            {
                savedReplyActionId: action.savedReplyActionId,
                sequenceNum: action.sequenceNum,
                actionEnumId: action.actionEnumId,
                text: actionText(action)
            },
            actionCheck(action, theCase)
        )
    )
    return {
        requestId: theCase.requestId,
        caseRevision: theCase.revision,
        emailTextBlockId: block.emailTextBlockId,
        title: block.title || "",
        subject: subject.text,
        bodyHtml: body.text,
        bodyText: textOf(body.text),
        errors,
        recipients,
        emailAccountId: account?.emailAccountId || null,
        fromAddress: account?.emailAddress || null,
        threadEmailMessageId: thread?.emailMessageId || null,
        actions: actionList,
        canApply: !errors.length && actionList.every(action => action.allowed),
        canApplyActions: actionList.length > 0 && actionList.every(action => action.allowed)
    }
}
function preview(p) {
    if (!access.has("SUPPORT_CASE_EDIT")) denied("PERMISSION_DENIED", "SUPPORT_CASE_EDIT is required")
    return previewOf(p, caseFor(p.requestId, false))
}

// ===== apply#SavedReply =====
function apply(p) {
    if (!access.has("SUPPORT_CASE_EDIT")) denied("PERMISSION_DENIED", "SUPPORT_CASE_EDIT is required")
    const send = !(p.send === false || p.send === "N" || p.send === "false")
    const theCase = caseFor(p.requestId, true)
    const operation = lib.operation(p, "SavedReplyApply", theCase.organizationPartyId, {
        requestId: theCase.requestId,
        emailTextBlockId: p.emailTextBlockId,
        bodyHash: lib.hash(String(p.bodyHtml || "")),
        subject: p.subject || null,
        send
    })
    if (operation.old) {
        // a retry: the first result; a reply whose send failed is sent again by its message ID, never a second reply. The
        // case's lock serializes retries; the message is read, not locked: its filing after the send locks it and then files
        // on this case, so a lock here would wait on the filing while the filing waits on the case.
        const earlier = lib.previous(operation)
        if (earlier.emailMessageId) {
            const message = one(MESSAGE, {emailMessageId: earlier.emailMessageId})
            if (message?.statusId === "ES_READY" && message.sendError)
                call("org.moqui.mail.EmailClientServices.send#Draft", {emailMessageId: earlier.emailMessageId})
            Object.assign(earlier, deliveryOf(earlier.emailMessageId), {
                retried: message?.statusId === "ES_READY" && !!message.sendError
            })
        }
        return earlier
    }
    cases().checkRevision(theCase, p.caseRevision)
    const shown = previewOf(p, theCase)
    const errors = send
        ? shown.errors
        : shown.errors.filter(row => !["RECIPIENT_REQUIRED", "SEND_ACCOUNT_REQUIRED"].includes(row.reasonCode))
    if (errors.length) denied(errors[0].reasonCode, errors[0].message)
    const refused = shown.actions.find(action => !action.allowed)
    if (refused) denied(refused.reasonCode || "ACTION_NOT_ALLOWED", refused.text + ": " + refused.message)
    if (!send && !shown.actions.length) denied("NOTHING_TO_APPLY", "The reply has no action and is not sent")
    // the actions, in order, in this transaction with the reply
    const {actions} = replyOf(p.emailTextBlockId, theCase.organizationPartyId)
    for (const action of actions) runAction(action, theCase)
    let emailMessageId = null
    let delivery = {deliveryStatus: null, statusId: null, sendError: null}
    if (send) {
        const draft = call("org.moqui.mail.EmailClientServices.save#Draft", {
            emailAccountId: shown.emailAccountId,
            toAddresses: shown.recipients.map(row => row.address).join(", "),
            subject: shown.subject,
            body: shown.bodyHtml,
            parentEmailMessageId: shown.threadEmailMessageId || null
        })
        emailMessageId = draft.emailMessageId
        call("mantle.party.CommunicationServices.send#EmailDraft", {
            emailMessageId,
            recordEntityName: REQUEST,
            recordId: theCase.requestId
        })
        delivery = deliveryOf(emailMessageId)
    }
    const result = Object.assign(
        {
            requestId: theCase.requestId,
            emailTextBlockId: p.emailTextBlockId,
            emailMessageId,
            recipients: shown.recipients,
            actionsApplied: shown.actions.map(action => action.text),
            revision: cases().revisionOf(theCase.requestId)
        },
        delivery
    )
    lib.complete(operation, emailMessageId ? MESSAGE : REQUEST, emailMessageId || theCase.requestId, result)
    return Object.assign(result, {alreadyApplied: false, retried: false})
}

const operations = {preview, apply}
;({
    variableNames,
    usedIn,
    resolve,
    deliveryOf,
    actionText,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown saved reply operation " + op)
        const wasDisabled = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](parameters || {})
        } finally {
            if (!wasDisabled) ec.artifactExecution.enableAuthz()
        }
    }
})
