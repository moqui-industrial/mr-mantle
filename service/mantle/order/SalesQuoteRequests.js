// Sales' requests for quote (mantle.order.SalesQuoteServices, Q of IronStone Sales design §12.1; design §5 QuoteRequests and
// QuoteRequestDetail, §6's chargeable repair handoff; impl-sales P8, SAL-QUOTE, SAL-MAIL-INTAKE).
//
// - An RFQ is a native Request of type RqtQuote (never a table of its own): its selling organization the current OrgInternal
//   RequestParty, the customer and contact its Customer and Contact rows, its owner and team its SalesRepresentative and SalesTeam
//   rows; its lines are RequestItems, the message it came in by is on it (RequestEmailMessage or RequestCommEvent, its files as
//   RequestContent), and the quotes made from it are linked line by line (RequestItemOrder). Access is SalesAccess.js
//   quoteRequestOf: a Sales reader sees the RFQs assigned to them or a team of theirs, a holder of SALES_TEAM_VIEW the organization's;
//   a change needs SALES_QUOTE_EDIT; one outside the scope answers RECORD_UNAVAILABLE.
// - It comes in by the createQuoteRequest mail rule action (mail to the RFQ address, the team by the rule's value or the plus tag, as
//   createLead's), by "Create RFQ" on a message in Comms or by a staff entry; one message (by its Message-ID, or the chat or internal
//   message's communication event) makes one RFQ. Mail from anyone makes a request, never a party: the sender is matched to an account
//   or a contact of one of the organization, else kept only on the message.
// - The RFQ rules: RequestTriageNotice and complete#RequestFromWork leave RqtQuote out (F31, F63); the case rules need no guard.
// - create#QuoteFromRequest makes one draft quote (SalesQuotes.js createQuote and storeLine, so every quote rule holds) from the
//   selected lines, linked to them, atomically; its operation key answers a retry with the first quote; the RFQ's revision (the
//   latest stamp of the request, its lines and parties) must be the one the caller read. A first quote puts the RFQ In progress and
//   never completes it. A warranty claim (RqtWarranty, Customer Service's) whose current decision is a chargeable repair is accepted
//   as a source without changing it: its decision, diagnosis, fault text and conversation are never read into the quote or answered.
// - decline#QuoteRequest records the reason and cancels the RFQ; it tells the requester only when the caller confirms the recipient
//   preview#QuoteRequestDecline showed, from the mailbox the RFQ came in by.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const salesAccess = ec.resource.script("component://mr-mantle/service/mantle/sales/SalesAccess.js")
const settings = ec.resource.script("component://mr-mantle/service/mantle/sales/SalesSettings.js")
const intake = () => ec.resource.script("component://mr-mantle/service/mantle/sales/SalesIntake.js")
const quotes = () => ec.resource.script("component://mr-mantle/service/mantle/order/SalesQuotes.js")
const {find, one, rows, denied, call, ms} = lib

const REQUEST = "mantle.request.Request"
const ITEM = "mantle.request.RequestItem"
const PARTY = "mantle.request.RequestParty"
const ITEM_ORDER = "mantle.request.RequestItemOrder"
const EMAIL_LINK = "mantle.request.RequestEmailMessage"
const EVENT_LINK = "mantle.request.RequestCommEvent"
const ORDER = "mantle.order.OrderHeader"
const DECISION = "mantle.request.support.WarrantyDecision"
const rfqType = salesAccess.quoteRequestType
const repairType = "RqtWarranty"
const roles = salesAccess.quoteRequestRoles
const states = {
    awaiting: ["ReqSubmitted", "ReqReviewed"],
    quoted: ["ReqInProgress"],
    open: ["ReqSubmitted", "ReqReviewed", "ReqInProgress"],
    declined: ["ReqCancelled"],
    completed: ["ReqCompleted"],
    all: null
}
const openStatuses = states.open
const closedStatuses = ["ReqCompleted", "ReqCancelled"]
const channelTexts = {ScEmail: "Mail", ScChat: "Chat", ScPhone: "Phone", ScWeb: "Web"}
const repairLimit = 200

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const L = value => ec.l10n.localize(value)
const dayText = value => (value == null || value === "" ? "" : ec.l10n.format(new Date(ms(value)), "d MMM yyyy"))
const moneyText = (value, currencyUomId) =>
    value == null || !currencyUomId
        ? ""
        : ec.l10n.formatCurrency(ec.l10n.roundCurrency(toDecimal(value), currencyUomId), currencyUomId)
const quantityText = value => (value == null ? "" : String(Number(String(value))))
const likeText = value => "%" + String(value).replace(/[\\%_]/g, character => "\\" + character) + "%"
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "")
const partyName = partyId => (partyId ? lib.partyNames([partyId])[partyId] || partyId : "")
const productName = productId => {
    const product = productId ? one("mantle.product.Product", {productId}) : null
    return product ? product.productName || product.productId : ""
}
const flag = value => value === true || value === "true" || value === "Y"

function decimal(value, label) {
    let number
    try {
        number = toDecimal(value)
    } catch (_) {
        number = null
    }
    if (number == null || number.compare(0) <= 0) denied("QUANTITY_INVALID", "Enter a positive " + label)
    return number
}
function dateOf(value, label) {
    if (blank(value)) return null
    const millis = ms(value)
    if (!Number.isFinite(millis)) denied("DATE_INVALID", label + " is not a date")
    return new Date(millis)
}
// The revision of a request: the latest stamp of the request, its lines and its parties, so a change of any of them is seen.
function revisionOf(requestId) {
    const stamps = [one(REQUEST, {requestId})?.lastUpdatedStamp]
        .concat(rows(ITEM, {requestId}).map(row => row.lastUpdatedStamp))
        .concat(rows(PARTY, {requestId}).map(row => row.lastUpdatedStamp))
    return String(stamps.reduce((max, stamp) => Math.max(max, ms(stamp) ?? 0), 0))
}
function requireRevision(requestId, given) {
    const current = revisionOf(requestId)
    if (blank(given)) denied("REVISION_REQUIRED", "Reload the request and try again (revision " + current + ")")
    if (String(given).trim() !== current)
        denied("REVISION_CHANGED", "Request " + requestId + " changed since you read it; its current revision is " + current)
}
function requireOpen(request) {
    if (!openStatuses.includes(request.statusId))
        denied("REQUEST_CLOSED", "Request " + request.requestId + " is " + statusText(request.statusId))
}
// a dated RequestParty row, ended (never deleted) when replaced
function addParty(requestId, partyId, roleTypeId) {
    if (!partyId) return
    if (rows(PARTY, {requestId, partyId, roleTypeId}).some(row => lib.active(row))) return
    call("create#" + PARTY, {requestId, partyId, roleTypeId, fromDate: ec.user.nowTimestamp})
}
function endParties(requestId, roleTypeId, keepPartyId) {
    for (const row of rows(PARTY, {requestId, roleTypeId}))
        if (lib.active(row) && row.partyId !== keepPartyId)
            call("update#" + PARTY, {
                requestId,
                partyId: row.partyId,
                roleTypeId,
                fromDate: row.fromDate,
                thruDate: ec.user.nowTimestamp
            })
}
// The scope of an organization for a caller with no user (the mail rule): its accounts and the shared ones, nothing else.
const organizationScope = organizationPartyId => ({
    capabilities: {anyRead: true},
    organizationPartyIds: [organizationPartyId],
    partyId: null
})
// The account (and contact) an address belongs to in an organization: a person who is a current contact of exactly one account of
// it, else an account with that address; none when it is nobody's or several's. Never makes a party.
function senderOf(scope, address) {
    const email = text(address)?.toLowerCase()
    if (!email) return {}
    const mechIds = Array.from(
        find("mantle.party.contact.ContactMech")
            .condition("contactMechTypeEnumId", "CmtEmailAddress")
            .condition(ec.entity.conditionFactory.makeCondition("infoString", "equals", email).ignoreCase())
            .selectField("contactMechId")
            .limit(20)
            .list()
    ).map(row => row.contactMechId)
    if (!mechIds.length) return {}
    const partyIds = Array.from(
        new Set(
            Array.from(find("mantle.party.contact.PartyContactMech").condition("contactMechId", "in", mechIds).list())
                .filter(row => lib.active(row))
                .map(row => row.partyId)
        )
    )
    const contacts = []
    const accounts = []
    for (const partyId of partyIds) {
        const account = salesAccess.accountOf(scope, partyId)
        if (account) accounts.push(partyId)
        else
            for (const found of salesAccess.contactAccounts(scope, partyId))
                contacts.push({contactPartyId: partyId, customerPartyId: found.party.partyId})
    }
    if (contacts.length === 1) return contacts[0]
    if (!contacts.length && accounts.length === 1) return {customerPartyId: accounts[0]}
    return {}
}
// The customer and contact of a new RFQ: the ones given, checked (an account of the organization or a shared one, a contact of it),
// else those of the sender's address.
function customerOf(scope, organizationPartyId, p, address) {
    let customerPartyId = text(p.customerPartyId)
    let contactPartyId = text(p.contactPartyId)
    if (!customerPartyId && !contactPartyId) return senderOf(scope, address)
    if (customerPartyId) {
        const account = salesAccess.requireAccount(scope, customerPartyId)
        if (account.organizationPartyId && account.organizationPartyId !== organizationPartyId)
            denied("CUSTOMER_INVALID", "The customer is an account of another organization")
    }
    if (contactPartyId) {
        const of = salesAccess.contactAccounts(scope, contactPartyId).map(row => row.party.partyId)
        if (!customerPartyId && of.length === 1) customerPartyId = of[0]
        if (!customerPartyId || !of.includes(customerPartyId))
            denied("CONTACT_INVALID", "The contact is not a contact of the customer")
    }
    return {customerPartyId, contactPartyId}
}

// ===== the source message =====
// The message an RFQ comes from, read as the caller may read it before anything is written (a message of a mailbox, a room or a
// thread they may not read answers as a missing one), with the request it already made, if any.
function asUser(name, parameters) {
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(name).parameters(parameters).call() || {}
        return ec.message.hasError() ? null : out
    } catch (error) {
        return null
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}
// The RFQs a mail message already made: those of the same Message-ID (the same mail delivered twice or to two mailboxes) on an
// RqtQuote request.
function requestsOfEmail(message) {
    const ids = [message.emailMessageId]
    if (message.messageId)
        for (const row of find("moqui.basic.email.EmailMessage")
            .condition(ec.entity.conditionFactory.makeCondition("messageId", "equals", String(message.messageId)).ignoreCase())
            .selectField("emailMessageId")
            .limit(50)
            .list())
            ids.push(row.emailMessageId)
    const found = []
    for (const link of find(EMAIL_LINK)
        .condition("emailMessageId", "in", Array.from(new Set(ids)))
        .list()) {
        const request = one(REQUEST, {requestId: link.requestId})
        if (request?.requestTypeEnumId === rfqType && !found.some(row => row.requestId === request.requestId)) found.push(request)
    }
    return found
}
const requestOfEmail = message => requestsOfEmail(message)[0] || null
function requestsOfEvent(communicationEventId) {
    const found = []
    for (const link of rows(EVENT_LINK, {communicationEventId})) {
        const request = one(REQUEST, {requestId: link.requestId})
        if (request?.requestTypeEnumId === rfqType && !found.some(row => row.requestId === request.requestId)) found.push(request)
    }
    return found
}
function sourceOf(p) {
    if (!blank(p.emailMessageId)) {
        const emailMessageId = text(p.emailMessageId)
        if (!asUser("org.moqui.mail.EmailClientServices.get#Thread", {emailMessageId}))
            denied("RECORD_UNAVAILABLE", "Message " + emailMessageId + " is not available")
        const message = one("moqui.basic.email.EmailMessage", {emailMessageId})
        return {
            kind: "email",
            message,
            existing: requestsOfEmail(message),
            channel: "ScEmail",
            name: intake().subjectName(message.subject),
            description: String(message.bodyText || intake().plainText(message.body) || "").substring(0, 20000) || null,
            address: message.fromAddress || null,
            receivedDate: message.receivedDate || message.messageDate || null
        }
    }
    if (!blank(p.communicationEventId)) {
        const communicationEventId = text(p.communicationEventId)
        const thread = asUser("mantle.party.CommunicationServices.get#InternalThread", {communicationEventId})
        const message = Array.from(thread?.messageList || []).find(item => item.communicationEventId === communicationEventId)
        if (!message) denied("RECORD_UNAVAILABLE", "Message " + communicationEventId + " is not available")
        return {
            kind: "event",
            communicationEventId,
            existing: requestsOfEvent(communicationEventId),
            channel: null,
            name: String(message.subject || thread.subject || "").trim() || null,
            description:
                String(message.body || "")
                    .replace(/<[^>]*>/g, " ")
                    .trim()
                    .substring(0, 20000) || null,
            address: null,
            receivedDate: null
        }
    }
    if (!blank(p.chatRoomId)) {
        const found = asUser("mantle.party.CommunicationServices.findOrCreate#ChatCommunicationEvent", {
            chatRoomId: p.chatRoomId,
            eventSeq: p.eventSeq
        })
        if (!found?.communicationEventId)
            denied("RECORD_UNAVAILABLE", "Message " + p.chatRoomId + ":" + p.eventSeq + " is not available")
        const body = String(found.chatMessage?.bodyText || "").trim()
        return {
            kind: "event",
            communicationEventId: found.communicationEventId,
            existing: requestsOfEvent(found.communicationEventId),
            channel: "ScChat",
            name:
                body
                    .split(/\r?\n/)
                    .map(line => line.trim())
                    .find(Boolean)
                    ?.substring(0, 100) || null,
            description: body.substring(0, 20000) || null,
            address: null,
            receivedDate: null
        }
    }
    return null
}
// The message on the new RFQ: a mail with its conversation event and files (file#RequestEmail), a chat or internal message by its
// event; in an error frame of its own, so a filing that fails leaves the RFQ made and is logged.
function fileSource(requestId, source) {
    ec.message.pushErrors()
    try {
        if (source.kind === "email")
            call("mantle.request.RequestServices.file#RequestEmail", {requestId, emailMessageId: source.message.emailMessageId})
        else if (!one(EVENT_LINK, {requestId, communicationEventId: source.communicationEventId}))
            call("create#" + EVENT_LINK, {requestId, communicationEventId: source.communicationEventId})
    } catch (error) {
        ec.logger.error("Request for quote " + requestId + " was made but its message was not filed on it: " + error.message)
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}

// ===== create#QuoteRequest =====
// The lines of a new or changed RFQ: a product the organization may sell (or none, a described line), a quantity, a description
// and a required date.
function itemValues(organizationPartyId, customerPartyId, p) {
    const productId = text(p.productId)
    if (productId) {
        if (!one("mantle.product.Product", {productId})) denied("PRODUCT_REQUIRED", "Product " + productId + " is not available")
        const usable = call("mantle.product.ProductServices.check#ProductUsable", {
            productId,
            usage: "Sell",
            quantity: toDecimal(1),
            vendorPartyId: organizationPartyId,
            customerPartyId: customerPartyId || null
        })
        if (!usable.usable) denied("PRODUCT_NOT_USABLE", usable.reason || productId + " is not usable for selling")
    }
    const description = text(p.description)
    if (!productId && !description) denied("ITEM_REQUIRED", "Give the line a product or a description")
    return {
        productId,
        quantity: blank(p.quantity) ? toDecimal(1) : decimal(p.quantity, "quantity"),
        description: description ? description.substring(0, 255) : null,
        requiredByDate: dateOf(p.requiredByDate, "Required by")
    }
}
function nextItemSeqId(requestId) {
    const last = rows(ITEM, {requestId}).reduce((max, row) => Math.max(max, Number(row.requestItemSeqId) || 0), 0)
    return String(last + 1).padStart(2, "0")
}
// The owner and team of a new RFQ by a user: themselves (when they work for the organization) on the team given (a current team of
// the organization; one of theirs unless SALES_TEAM_MANAGE) or their only team there.
function assignmentOf(userScope, organizationPartyId, teamPartyId) {
    const ownerPartyId = settings.worksFor(userScope.partyId, organizationPartyId) ? userScope.partyId : null
    const mine = salesAccess
        .memberTeams(userScope.partyId)
        .filter(partyId => salesAccess.teamOrganization(partyId) === organizationPartyId)
    if (teamPartyId) {
        const team = settings.teamRow(teamPartyId)
        if (!team || team.organizationPartyId !== organizationPartyId || !settings.inEffect(team.relationship))
            denied("TEAM_UNAVAILABLE", "Choose a current team of the organization")
        if (!userScope.capabilities.teamManage && !mine.includes(teamPartyId))
            denied("TEAM_UNAVAILABLE", "Choose one of your teams")
    }
    const team = teamPartyId || (mine.length === 1 ? mine[0] : null)
    if (!ownerPartyId && !team) denied("TEAM_REQUIRED", "Choose the team the request is for")
    return {ownerPartyId, teamPartyId: team}
}
// A new RFQ: the request, its parties and lines, and the message it came from filed on it. The organization is the caller's (or
// the rule's team's); the source message makes at most one RFQ.
function makeRequest(organizationPartyId, assignment, parties, values, items, source) {
    const created = call("mantle.request.RequestServices.create#Request", {
        requestTypeEnumId: rfqType,
        statusId: "ReqSubmitted",
        requestName: (text(values.requestName) || L("Request for quote")).substring(0, 255),
        description: text(values.description) ? String(values.description).substring(0, 20000) : null,
        requestDate: values.requestDate || ec.user.nowTimestamp,
        responseRequiredDate: values.responseRequiredDate || null,
        salesChannelEnumId: values.channel || null,
        filedByPartyId: ec.user.userAccount?.partyId || null
    })
    const requestId = created.requestId
    addParty(requestId, organizationPartyId, roles.organization)
    addParty(requestId, parties.customerPartyId, roles.customer)
    addParty(requestId, parties.contactPartyId, roles.contact)
    addParty(requestId, assignment.ownerPartyId, roles.owner)
    addParty(requestId, assignment.teamPartyId, roles.team)
    items.forEach((item, index) =>
        call(
            "create#" + ITEM,
            Object.assign({requestId, requestItemSeqId: String(index + 1).padStart(2, "0"), statusId: "ReqSubmitted"}, item)
        )
    )
    if (source) fileSource(requestId, source)
    return requestId
}
function createQuoteRequest(p) {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in to make a request for quote")
    const userScope = salesAccess.scope()
    salesAccess.requireCapability(userScope, "anyRead")
    salesAccess.requireCapability(userScope, "quoteEdit")
    const organizationPartyId = text(p.organizationPartyId) || salesAccess.defaultOrganization(userScope)
    if (!organizationPartyId) denied("ORGANIZATION_DENIED", "Choose the selling organization")
    if (!salesAccess.isInternal(organizationPartyId))
        denied("ORGANIZATION_DENIED", "Organization " + organizationPartyId + " is not available")
    salesAccess.requireOrganization(userScope, organizationPartyId)
    // the message first, as the caller may read it, before anything is written
    // the request the message already made: one the caller sees (whichever was made first), else REQUEST_TAKEN naming none
    const source = sourceOf(p)
    if (source?.existing?.length) {
        const seen = source.existing.find(request => salesAccess.quoteRequestOf(userScope, request.requestId))
        if (!seen) denied("REQUEST_TAKEN", "This message is already a request for quote you cannot open")
        return {requestId: seen.requestId, alreadyApplied: true}
    }
    const parties = customerOf(userScope, organizationPartyId, p, source?.address)
    const assignment = assignmentOf(userScope, organizationPartyId, text(p.teamPartyId))
    const items = Array.from(p.items || []).map(item => itemValues(organizationPartyId, parties.customerPartyId, item))
    const requestId = makeRequest(
        organizationPartyId,
        assignment,
        parties,
        {
            requestName: text(p.requestName) || source?.name,
            description: text(p.description) || source?.description,
            responseRequiredDate: dateOf(p.responseRequiredDate, "Response wanted by"),
            requestDate: source?.receivedDate || null,
            channel: source?.channel || text(p.salesChannelEnumId)
        },
        items,
        source
    )
    return {requestId, alreadyApplied: false}
}

// ===== create#QuoteRequestFromEmail: the createQuoteRequest mail rule action =====
function quoteRequestFromEmail(p) {
    const wasDisabled = ec.artifactExecution.disableAuthz()
    try {
        const emailMessageId = text(p.emailMessageId)
        const message = emailMessageId ? one("moqui.basic.email.EmailMessage", {emailMessageId}) : null
        if (!message) denied("RECORD_UNAVAILABLE", "Email message " + (emailMessageId || "") + " is not available")
        // the rule's owner makes quotes (SALES_QUOTE_EDIT), as createLead's owner makes leads (the user's call of Nov 13, P6)
        if (!intake().userHolds(text(p.ruleOwnerUserId), "SALES_QUOTE_EDIT"))
            denied("RULE_NOT_ALLOWED", "The rule's owner may not take requests for quote (SALES_QUOTE_EDIT is required)")
        const existing = requestOfEmail(message)
        if (existing) return {requestId: existing.requestId, alreadyApplied: true, stopProcessing: true}
        const team = intake().intakeTeam(message, p.value, p.ruleOwnerUserId)
        if (!team)
            denied("TEAM_UNAVAILABLE", "No sales team takes requests for quote at the addresses of message " + emailMessageId)
        const parties = senderOf(organizationScope(team.organizationPartyId), message.fromAddress)
        const requestId = makeRequest(
            team.organizationPartyId,
            {ownerPartyId: null, teamPartyId: team.teamPartyId},
            parties,
            {
                requestName: intake().subjectName(message.subject),
                description: String(message.bodyText || intake().plainText(message.body) || "").substring(0, 20000),
                requestDate: message.receivedDate || message.messageDate || null,
                channel: "ScEmail"
            },
            [],
            {kind: "email", message}
        )
        return {requestId, alreadyApplied: false, stopProcessing: true}
    } finally {
        if (!wasDisabled) ec.artifactExecution.enableAuthz()
    }
}

// ===== store#QuoteRequestItem, assign#QuoteRequest =====
function storeQuoteRequestItem(p) {
    const userScope = salesAccess.scope()
    const rfq = salesAccess.requireQuoteRequest(userScope, text(p.requestId), true)
    const requestId = rfq.request.requestId
    requireOpen(rfq.request)
    requireRevision(requestId, p.requestRevision)
    const requestItemSeqId = text(p.requestItemSeqId)
    if (requestItemSeqId) {
        const item = one(ITEM, {requestId, requestItemSeqId})
        if (!item) denied("ITEM_UNAVAILABLE", "Line " + requestItemSeqId + " is not on request " + requestId)
        if (flag(p.cancel)) {
            call("update#" + ITEM, {requestId, requestItemSeqId, statusId: "ReqCancelled"})
            return {requestId, requestItemSeqId, requestRevision: revisionOf(requestId)}
        }
        const values = itemValues(
            rfq.organizationPartyId,
            rfq.customerPartyId,
            Object.assign(
                {
                    productId: item.productId,
                    description: item.description,
                    quantity: item.quantity,
                    requiredByDate: item.requiredByDate
                },
                Object.fromEntries(
                    ["productId", "description", "quantity", "requiredByDate"]
                        .filter(key => p[key] != null)
                        .map(key => [key, p[key]])
                )
            )
        )
        call("update#" + ITEM, Object.assign({requestId, requestItemSeqId, statusId: "ReqSubmitted"}, values))
        return {requestId, requestItemSeqId, requestRevision: revisionOf(requestId)}
    }
    const values = itemValues(rfq.organizationPartyId, rfq.customerPartyId, p)
    const seqId = nextItemSeqId(requestId)
    call("create#" + ITEM, Object.assign({requestId, requestItemSeqId: seqId, statusId: "ReqSubmitted"}, values))
    return {requestId, requestItemSeqId: seqId, requestRevision: revisionOf(requestId)}
}
// The owner, team, customer, contact, name and wanted date of an RFQ: the owner one who works for the organization (the caller or,
// unless SALES_TEAM_MANAGE, a member of a team of theirs), the team a current team of it (one of theirs unless SALES_TEAM_MANAGE),
// the customer an account of it or a shared one and the contact one of its contacts.
function updateQuoteRequest(p) {
    const userScope = salesAccess.scope()
    const rfq = salesAccess.requireQuoteRequest(userScope, text(p.requestId), true)
    const requestId = rfq.request.requestId
    const organizationPartyId = rfq.organizationPartyId
    requireOpen(rfq.request)
    requireRevision(requestId, p.requestRevision)
    const manage = !!userScope.capabilities.teamManage
    const mine = salesAccess
        .memberTeams(userScope.partyId)
        .filter(partyId => salesAccess.teamOrganization(partyId) === organizationPartyId)
    const ownerPartyId = text(p.ownerPartyId)
    if (ownerPartyId && ownerPartyId !== rfq.ownerPartyId) {
        if (!settings.worksFor(ownerPartyId, organizationPartyId))
            denied("OWNER_INVALID", "The owner must be a person who works for the organization")
        if (
            !manage &&
            ownerPartyId !== userScope.partyId &&
            !mine.some(team => salesAccess.memberTeams(ownerPartyId).includes(team))
        )
            denied("OWNER_INVALID", "Choose yourself or a member of one of your teams")
        endParties(requestId, roles.owner, ownerPartyId)
        addParty(requestId, ownerPartyId, roles.owner)
    }
    const teamPartyId = text(p.teamPartyId)
    if (teamPartyId && teamPartyId !== rfq.teamPartyId) {
        const team = settings.teamRow(teamPartyId)
        if (!team || team.organizationPartyId !== organizationPartyId || !settings.inEffect(team.relationship))
            denied("TEAM_UNAVAILABLE", "Choose a current team of the organization")
        if (!manage && !mine.includes(teamPartyId)) denied("TEAM_UNAVAILABLE", "Choose one of your teams")
        endParties(requestId, roles.team, teamPartyId)
        addParty(requestId, teamPartyId, roles.team)
    }
    if (!blank(p.customerPartyId) || !blank(p.contactPartyId)) {
        const parties = customerOf(userScope, organizationPartyId, p, null)
        if (parties.customerPartyId && parties.customerPartyId !== rfq.customerPartyId) {
            endParties(requestId, roles.customer, parties.customerPartyId)
            addParty(requestId, parties.customerPartyId, roles.customer)
        }
        if (parties.contactPartyId !== rfq.contactPartyId) {
            endParties(requestId, roles.contact, parties.contactPartyId)
            addParty(requestId, parties.contactPartyId, roles.contact)
        }
    }
    const changes = {}
    if (p.requestName != null && text(p.requestName)) changes.requestName = text(p.requestName).substring(0, 255)
    if (p.description != null) changes.description = text(p.description)
    if (p.responseRequiredDate != null) changes.responseRequiredDate = dateOf(p.responseRequiredDate, "Response wanted by")
    if (Object.keys(changes).length) call("update#" + REQUEST, Object.assign({requestId}, changes))
    return {requestId, requestRevision: revisionOf(requestId)}
}

// ===== the chargeable repair source =====
// A warranty claim a Sales caller may make a quote from: of an organization of their scope, open, and its current decision (the
// newest at the claim's revision not superseded) a chargeable repair (a charge estimate above zero), or already the source of a
// quote; for a Sales reader who makes quotes (SALES_QUOTE_EDIT) or reads the organization's (SALES_TEAM_VIEW). Customer Service's
// claim itself stays out of reach: nothing of it but the customer and the lines' products and quantities is answered.
function repairSourceOf(userScope, requestId) {
    if (!requestId || !userScope.capabilities.anyRead) return null
    if (!userScope.capabilities.quoteEdit && !userScope.capabilities.teamRead) return null
    const request = one(REQUEST, {requestId})
    if (!request || request.requestTypeEnumId !== repairType) return null
    const parties = salesAccess.requestParties(requestId)
    const organizationPartyId = parties.find(row => row.roleTypeId === "OrgInternal")?.partyId || null
    if (!organizationPartyId || !salesAccess.covers(userScope, organizationPartyId)) return null
    const quoted = quoteIdsOf(requestId).length > 0
    if (!quoted) {
        if (closedStatuses.includes(request.statusId)) return null
        const revision = Number(String(request.claimRevision ?? 0))
        const current = rows(DECISION, {requestId})
            .filter(row => !row.supersededDate && Number(String(row.sourceRevision ?? 0)) === revision)
            .sort((a, b) => ms(b.decisionDate) - ms(a.decisionDate))[0]
        const chargeable = current?.chargeEstimate != null && toDecimal(String(current.chargeEstimate)).compare(toDecimal(0)) > 0
        if (!chargeable) return null
    }
    return {
        request,
        parties,
        organizationPartyId,
        customerPartyId: parties.find(row => row.roleTypeId === "Customer")?.partyId || null,
        contactPartyId: null,
        canEdit: !!userScope.capabilities.quoteEdit,
        repair: true
    }
}
// The RFQ or the repair source the caller may make a quote from, or a refusal (RECORD_UNAVAILABLE).
function sourceRequest(userScope, requestId, edit) {
    const rfq = salesAccess.quoteRequestOf(userScope, requestId)
    const found = rfq ? Object.assign(rfq, {repair: false}) : repairSourceOf(userScope, requestId)
    if (!found) denied("RECORD_UNAVAILABLE", "Request " + (requestId || "") + " is not available")
    if (edit) salesAccess.requireCapability(userScope, "quoteEdit")
    return found
}
// The quotes made from a request's lines (RequestItemOrder to an order of purpose SalesQuote), newest first.
function quoteIdsOf(requestId) {
    const orderIds = Array.from(new Set(rows(ITEM_ORDER, {requestId}).map(row => row.orderId)))
    if (!orderIds.length) return []
    return Array.from(find(ORDER).condition("orderId", "in", orderIds).orderBy("-entryDate").list())
        .filter(order => order.orderPurposeEnumId === salesAccess.quotePurpose)
        .map(order => order.orderId)
}

// ===== create#QuoteFromRequest =====
function createQuoteFromRequest(p) {
    const userScope = salesAccess.scope()
    const source = sourceRequest(userScope, text(p.requestId), true)
    const requestId = source.request.requestId
    const selected = Array.from(p.items || []).length
        ? Array.from(p.items).map(item => Object.assign({}, item))
        : Array.from(p.requestItemSeqIdList || []).map(requestItemSeqId => ({requestItemSeqId}))
    const request = {
        requestId,
        items: selected.map(item => ({
            requestItemSeqId: String(item.requestItemSeqId || ""),
            productId: text(item.productId),
            quantity: blank(item.quantity) ? null : String(item.quantity),
            unitAmount: blank(item.unitAmount) ? null : String(item.unitAmount),
            overrideReason: text(item.overrideReason)
        }))
    }
    const operation = lib.operation(p, "SalesQuoteFromRequest", source.organizationPartyId, request)
    if (operation.old) return lib.previous(operation)
    if (!source.repair) requireOpen(source.request)
    else if (closedStatuses.includes(source.request.statusId))
        denied("REQUEST_CLOSED", "Request " + requestId + " is " + statusText(source.request.statusId))
    requireRevision(requestId, p.requestRevision)
    if (!request.items.length) denied("ITEMS_REQUIRED", "Choose the lines to quote")
    if (!source.customerPartyId) denied("CUSTOMER_REQUIRED", "Set the request's customer first")
    const lines = []
    for (const wanted of request.items) {
        const item = wanted.requestItemSeqId ? one(ITEM, {requestId, requestItemSeqId: wanted.requestItemSeqId}) : null
        if (!item || item.statusId === "ReqCancelled")
            denied("ITEM_UNAVAILABLE", "Line " + (wanted.requestItemSeqId || "") + " is not an open line of request " + requestId)
        if (lines.some(line => line.item.requestItemSeqId === item.requestItemSeqId))
            denied("ITEM_UNAVAILABLE", "Line " + item.requestItemSeqId + " is chosen twice")
        const productId = wanted.productId || item.productId
        if (!productId) denied("ITEM_PRODUCT_REQUIRED", "Choose the product of line " + item.requestItemSeqId + " first")
        lines.push({item, productId, quantity: wanted.quantity || item.quantity || "1", wanted})
    }
    // the quote by the quote rules themselves (the seller, customer, contact and store checks; the caller its owner)
    const contactOk =
        source.contactPartyId &&
        salesAccess.contactAccounts(userScope, source.contactPartyId).some(row => row.party.partyId === source.customerPartyId)
    const created = quotes().execute("createQuote", {
        organizationPartyId: source.organizationPartyId,
        customerPartyId: source.customerPartyId,
        contactPartyId: contactOk ? source.contactPartyId : null,
        salesOpportunityId: text(p.salesOpportunityId),
        currencyUomId: text(p.currencyUomId),
        // a repair's quote names nothing of the claim; an RFQ's carries its name
        orderName: source.repair ? L("Repair estimate") : source.request.requestName || null,
        validThruDate: p.validThruDate || null,
        // Sales P10 (P8's review): an RFQ's quote is its team's, so the RFQ's team sees it; the maker stays its owner
        requestTeamPartyId: source.repair ? null : source.teamPartyId || null
    })
    let orderRevision = created.orderRevision
    for (const line of lines) {
        const stored = quotes().execute("storeLine", {
            orderId: created.orderId,
            orderRevision,
            productId: line.productId,
            quantity: line.quantity,
            unitAmount: line.wanted.unitAmount,
            overrideReason: line.wanted.overrideReason,
            // an RFQ's line keeps its description and date; a repair's never its fault text
            itemDescription: source.repair ? null : line.item.description || null,
            requiredByDate: source.repair ? null : line.item.requiredByDate || null
        })
        orderRevision = stored.orderRevision
        call("create#" + ITEM_ORDER, {
            requestId,
            requestItemSeqId: line.item.requestItemSeqId,
            orderId: created.orderId,
            orderItemSeqId: stored.orderItemSeqId,
            quantity: toDecimal(String(line.quantity))
        })
    }
    // a first quote puts an RFQ in progress; it never completes it, and a repair's claim is Customer Service's
    if (!source.repair && states.awaiting.includes(source.request.statusId))
        call("update#" + REQUEST, {requestId, statusId: "ReqInProgress"})
    const result = {orderId: created.orderId, orderRevision, requestId}
    lib.complete(operation, ORDER, created.orderId, result)
    // a repair's quote tells Customer Service (the user's call of Nov 13, 2026)
    if (source.repair) notifyRepairQuoted(source, created.orderId)
    return Object.assign({alreadyApplied: false}, result)
}

// ===== preview#QuoteRequestDecline, decline#QuoteRequest =====
// Whether Sales may answer from a mailbox as the system: it is an RFQ intake mailbox (an enabled createQuoteRequest rule runs on it,
// its owner holding SALES_QUOTE_EDIT), whose mail Sales answers as send#IntakeConfirmation does a project's, or the caller may send
// from it themselves. Reading a mailbox (which Create RFQ needs) is not sending from it.
function mailboxAnswers(account) {
    if (!account || account.statusId === "EasRemoved") return false
    const intakeRule = rows("moqui.basic.email.EmailRule", {emailAccountId: account.emailAccountId}).some(rule => {
        if (rule.enabled === "N") return false
        let actions
        try {
            actions = JSON.parse(rule.actionsJson || "[]")
        } catch (_) {
            return false
        }
        return (
            Array.isArray(actions) &&
            actions.some(action => text(action?.action) === "createQuoteRequest") &&
            intake().userHolds(rule.ownerUserId, "SALES_QUOTE_EDIT")
        )
    })
    if (intakeRule) return true
    const access = asUser("org.moqui.mail.EmailClientServices.get#EmailAccountAccess", {emailAccountId: account.emailAccountId})
    return !!access?.account?.canSend
}
// The mailbox an RFQ came in by (its first received message's account, still active, one Sales may answer from: mailboxAnswers)
// and the address to tell: that message's sender (its Reply-To, else From), else the contact's or the customer's email.
function declineTarget(rfq) {
    const links = rows(EMAIL_LINK, {requestId: rfq.request.requestId})
    const messages = links
        .map(link => one("moqui.basic.email.EmailMessage", {emailMessageId: link.emailMessageId}))
        .filter(message => message && message.statusId === "ES_RECEIVED")
        .sort((a, b) => (ms(a.receivedDate) ?? 0) - (ms(b.receivedDate) ?? 0))
    const first = messages[0] || null
    const account = first?.emailAccountId ? one("moqui.basic.email.EmailAccount", {emailAccountId: first.emailAccountId}) : null
    let toAddress = first ? text(first.replyToAddresses) || text(first.fromAddress) : null
    if (!toAddress)
        for (const partyId of [rfq.contactPartyId, rfq.customerPartyId].filter(Boolean)) {
            const mechIds = rows("mantle.party.contact.PartyContactMech", {partyId})
                .filter(row => lib.active(row))
                .map(row => row.contactMechId)
            const mech = mechIds.length
                ? Array.from(
                      find("mantle.party.contact.ContactMech")
                          .condition("contactMechId", "in", mechIds)
                          .condition("contactMechTypeEnumId", "CmtEmailAddress")
                          .list()
                  )[0]
                : null
            if (mech?.infoString) {
                toAddress = mech.infoString
                break
            }
        }
    const usable = mailboxAnswers(account) ? account : null
    return {parent: first, account: usable, toAddress: toAddress ? String(toAddress).split(",")[0].trim().toLowerCase() : null}
}
function defaultDeclineText(rfq) {
    return ec.resource.expand(
        "Thank you for your request for a quote (${requestName}). We are not able to quote it this time.",
        "",
        {requestName: rfq.request.requestName || rfq.request.requestId}
    )
}
function previewDecline(p) {
    const userScope = salesAccess.scope()
    const rfq = salesAccess.requireQuoteRequest(userScope, text(p.requestId), true)
    requireOpen(rfq.request)
    const target = declineTarget(rfq)
    const canNotify = !!(target.account && target.toAddress)
    return {
        canNotify,
        toAddress: target.toAddress || "",
        fromAddress: target.account?.emailAddress || "",
        subject: target.parent
            ? "Re: " + String(target.parent.subject || rfq.request.requestName || "").replace(/^re:\s*/i, "")
            : "",
        messageText: defaultDeclineText(rfq),
        notifyText: canNotify
            ? ec.resource.expand("The requester is told at ${to}, from ${from}", "", {
                  to: target.toAddress,
                  from: target.account.emailAddress
              })
            : L(
                  "The requester cannot be told from here: the request came in by no mailbox Sales answers from, or has no address; tell them yourself"
              )
    }
}
// The decline mail, a draft of the RFQ's mailbox answering its first message, sent and filed on the RFQ's conversation; a send
// that does not go waits in the mailbox's Outbox (logged), never the decline's failure.
function sendDecline(rfq, target, messageText) {
    const account = target.account
    const identities = rows("moqui.basic.email.EmailIdentity", {emailAccountId: account.emailAccountId})
    const identity = identities.find(row => row.isDefault === "Y") || identities[0] || null
    const parent = target.parent
    const escape = value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    const drafts = Array.from(
        find("moqui.basic.email.EmailFolder", {emailAccountId: account.emailAccountId, folderKindEnumId: "EfkDrafts"}).list()
    )[0]
    const references = parent
        ? []
              .concat(String(parent.referencesHeader || "").split(/\s+/), parent.messageId ? [parent.messageId] : [])
              .filter(Boolean)
        : []
    const subject = parent
        ? /^re:/i.test(parent.subject || "")
            ? parent.subject
            : "Re: " + (parent.subject || rfq.request.requestName || "")
        : rfq.request.requestName || L("Request for quote")
    const draft = ec.entity.makeValue("moqui.basic.email.EmailMessage")
    draft.setSequencedIdPrimary()
    draft.setFields(
        {
            statusId: "ES_DRAFT",
            emailAccountId: account.emailAccountId,
            emailFolderId: drafts ? drafts.emailFolderId : null,
            emailIdentityId: identity ? identity.emailIdentityId : null,
            emailServerId: account.emailServerId,
            fromAddress: identity?.emailAddress || account.emailAddress,
            fromName: identity ? (identity.displayName ?? null) : (account.accountName ?? null),
            toAddresses: target.toAddress,
            subject,
            contentType: "text/html",
            isRead: "Y",
            messageDate: ec.user.nowTimestamp,
            body: String(messageText)
                .split(/\n\s*\n/)
                .map(paragraph => "<p>" + escape(paragraph.trim()) + "</p>")
                .join(""),
            bodyText: String(messageText),
            snippet: String(messageText).substring(0, 137),
            parentEmailMessageId: parent ? parent.emailMessageId : null,
            rootEmailMessageId: parent ? parent.rootEmailMessageId || parent.emailMessageId : null,
            inReplyTo: parent?.messageId || null,
            referencesHeader: references.length ? references.join(" ") : null,
            hasAttachment: "N"
        },
        true,
        null,
        null
    )
    draft.create()
    const emailMessageId = draft.emailMessageId
    fileSource(rfq.request.requestId, {kind: "email", message: draft})
    ec.message.pushErrors()
    try {
        const sent = ec.service
            .sync()
            .name("org.moqui.mail.EmailClientServices.deliver#DraftMessage")
            .parameters({emailMessageId, fromStatusIdList: ["ES_DRAFT"]})
            .disableAuthz()
            .call()
        if (ec.message.hasError())
            ec.logger.warn("Decline of request " + rfq.request.requestId + ": not sent: " + ec.message.getErrorsString())
        else if (!sent?.sent)
            ec.logger.warn("Decline of request " + rfq.request.requestId + " waits in the Outbox: " + (sent?.sendError || ""))
    } catch (error) {
        ec.logger.error("Decline of request " + rfq.request.requestId + ": not sent: " + error.message)
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
    return emailMessageId
}
function declineQuoteRequest(p) {
    const userScope = salesAccess.scope()
    const rfq = salesAccess.requireQuoteRequest(userScope, text(p.requestId), true)
    const requestId = rfq.request.requestId
    requireOpen(rfq.request)
    requireRevision(requestId, p.requestRevision)
    const reason = text(p.reason)
    if (!reason) denied("REASON_REQUIRED", "Give the reason for declining")
    let emailMessageId = null
    if (flag(p.notify)) {
        const target = declineTarget(rfq)
        if (!target.account || !target.toAddress)
            denied("NOTIFY_UNAVAILABLE", "The requester cannot be told from here; decline without telling them")
        // only the recipient the preview showed: a changed one is previewed again
        if (
            String(p.toAddress || "")
                .trim()
                .toLowerCase() !== target.toAddress
        )
            denied("RECIPIENT_CHANGED", "Preview the decline again: the requester's address is " + target.toAddress)
        // the mailbox's draft is written as the system, after the checks above (the caller need not send from that mailbox)
        const wasDisabled = ec.artifactExecution.disableAuthz()
        try {
            emailMessageId = sendDecline(rfq, target, text(p.messageText) || defaultDeclineText(rfq))
        } finally {
            if (!wasDisabled) ec.artifactExecution.enableAuthz()
        }
    }
    call("create#mantle.request.RequestNote", {
        requestId,
        noteDate: ec.user.nowTimestamp,
        noteText: L("Declined") + ": " + reason,
        userId: ec.user.userId
    })
    call("update#" + REQUEST, {requestId, statusId: "ReqCancelled", requestResolutionEnumId: "RrRejected"})
    return {requestId, notified: !!emailMessageId, emailMessageId}
}

// ===== find#QuoteRequests =====
function rowOf(found, names) {
    const request = found.request
    const now = ms(ec.user.nowTimestamp)
    const due = ms(request.responseRequiredDate)
    // the quotes the caller may open: an unreadable one gives no id, title, amount or count
    const quoteIds = quoteIdsOf(request.requestId).filter(orderId => salesAccess.quoteOf(found.scope, orderId))
    return {
        requestId: request.requestId,
        requestName: found.repair
            ? L("Chargeable repair") + " · " + productName(firstProduct(request.requestId))
            : request.requestName || request.requestId,
        kind: found.repair ? "repair" : "rfq",
        statusId: request.statusId,
        statusText: found.repair ? L("Repair to quote") : statusText(request.statusId),
        customerPartyId: salesAccess.accountOf(found.scope, found.customerPartyId) ? found.customerPartyId : null,
        customerName: found.customerPartyId ? names[found.customerPartyId] || "" : "",
        ownerName: found.ownerPartyId ? names[found.ownerPartyId] || "" : "",
        teamName: found.teamPartyId ? names[found.teamPartyId] || "" : "",
        organizationName: names[found.organizationPartyId] || found.organizationPartyId,
        receivedText: dayText(request.requestDate),
        dueText: dayText(request.responseRequiredDate),
        overdue: due != null && due < now && openStatuses.includes(request.statusId),
        sourceText: found.repair ? L("Customer Service") : L(channelTexts[request.salesChannelEnumId] || "Staff entry"),
        quoteCount: quoteIds.length,
        quoteId: quoteIds[0] || null
    }
}
const firstProduct = requestId =>
    rows(ITEM, {requestId})
        .filter(row => row.statusId !== "ReqCancelled" && row.productId)
        .sort((a, b) => String(a.requestItemSeqId).localeCompare(String(b.requestItemSeqId)))[0]?.productId || null
function findQuoteRequests(p) {
    const userScope = salesAccess.scope()
    salesAccess.requireCapability(userScope, "anyRead")
    const organizationPartyId = text(p.organizationPartyId)
    if (organizationPartyId) salesAccess.requireOrganization(userScope, organizationPartyId)
    const organizations = organizationPartyId ? [organizationPartyId] : userScope.organizationPartyIds
    const kind = text(p.kind) === "repair" ? "repair" : "rfq"
    const factory = ec.entity.conditionFactory
    let query = find("mantle.request.RequestAndParty")
        .condition("requestTypeEnumId", kind === "repair" ? repairType : rfqType)
        .condition("roleTypeId", roles.organization)
        .condition("thruDate", "is-null", null)
    let none = organizations != null && !organizations.length
    if (organizations != null && organizations.length) query = query.condition("partyId", "in", Array.from(organizations))
    if (kind === "rfq") {
        let ids = salesAccess.assignedQuoteRequestIds(userScope)
        const narrow = found => {
            ids = ids == null ? found : ids.filter(id => found.includes(id))
        }
        const withRole = (roleTypeId, partyId) =>
            Array.from(
                find(PARTY, {roleTypeId, partyId}).condition("thruDate", "is-null", null).selectField("requestId").list()
            ).map(row => row.requestId)
        const ownerPartyId = flag(p.mine) ? userScope.partyId : text(p.ownerPartyId)
        if (ownerPartyId) narrow(withRole(roles.owner, ownerPartyId))
        if (text(p.teamPartyId)) narrow(withRole(roles.team, text(p.teamPartyId)))
        if (text(p.customerPartyId)) narrow(withRole(roles.customer, text(p.customerPartyId)))
        if (ids != null) {
            if (!ids.length) none = true
            else query = query.condition("requestId", "in", ids)
        }
        const state = text(p.state) || "open"
        if (!Object.hasOwn(states, state)) denied("STATE_INVALID", "Choose a state")
        if (states[state]) query = query.condition("statusId", "in", states[state])
        if (flag(p.overdue)) {
            query = query.condition("responseRequiredDate", "less", new Date(ms(ec.user.nowTimestamp)))
            query = query.condition("statusId", "in", openStatuses)
        }
    } else query = query.condition("statusId", "not-in", closedStatuses)
    // a claim's name is Customer Service's (often its fault): a repair is found by its id alone, and never sorted by its name
    const term = text(p.text)
    if (term)
        query = query.condition(
            factory.makeCondition(
                (kind === "repair" ? ["requestId"] : ["requestId", "requestName"]).map(field =>
                    factory.makeCondition(field, "like", likeText(term)).ignoreCase()
                ),
                "or"
            )
        )
    query = query.selectField("requestId").selectField("requestDate").selectField("responseRequiredDate").distinct(true)
    const orderBy = text(p.orderByField)
    const sort =
        orderBy &&
        (kind === "repair" ? /^[-+^]?requestDate$/ : /^[-+^]?(requestName|requestDate|responseRequiredDate)$/).test(orderBy)
            ? [orderBy, "requestId"]
            : ["-requestDate", "requestId"]
    let pageRows
    let paged
    if (kind === "repair") {
        // the claims of the scope whose decision asks for a quote, read one by one (bounded) and paged here
        const candidates = none ? [] : Array.from(query.orderBy(sort).limit(repairLimit).list())
        const sources = candidates.map(row => repairSourceOf(userScope, row.requestId)).filter(Boolean)
        paged = lib.pageList(sources, p, "quoteRequestList")
        pageRows = Array.from(paged.quoteRequestList)
    } else {
        const count = none ? 0 : query.count()
        const found = lib.page(
            none ? query.condition("requestId", "_NONE_") : query.orderBy(sort),
            p,
            "quoteRequestList",
            count,
            {
                noLimitCap: 1000
            }
        )
        paged = found
        pageRows = found.rows.map(row => salesAccess.quoteRequestOf(userScope, row.requestId)).filter(Boolean)
    }
    const names = lib.partyNames(
        pageRows.flatMap(found => [found.customerPartyId, found.ownerPartyId, found.teamPartyId, found.organizationPartyId])
    )
    const quoteRequestList = pageRows.map(found => rowOf(Object.assign({scope: userScope}, found), names))
    return Object.assign(
        {quoteRequestList},
        Object.fromEntries(
            Object.entries(paged).filter(([key]) => key.startsWith("quoteRequestList") && key !== "quoteRequestList")
        )
    )
}

// ===== get#QuoteRequest =====
// An RFQ (or a chargeable repair source) as the caller may see it, else requestFound false: its facts, lines and the quotes made from
// it, what the caller may do and its revision. A repair source answers its customer and its lines' products and quantities alone.
function getQuoteRequest(p) {
    const userScope = salesAccess.scope()
    const requestId = text(p.requestId)
    const rfq = salesAccess.quoteRequestOf(userScope, requestId)
    const found = rfq ? Object.assign(rfq, {repair: false}) : repairSourceOf(userScope, requestId)
    if (!found) return {requestFound: false}
    const request = found.request
    const repair = found.repair
    const open = openStatuses.includes(request.statusId) || (repair && !closedStatuses.includes(request.statusId))
    const items = rows(ITEM, {requestId}).sort((a, b) => String(a.requestItemSeqId).localeCompare(String(b.requestItemSeqId)))
    const links = rows(ITEM_ORDER, {requestId})
    const quoteIds = quoteIdsOf(requestId)
    const quoteRows = quoteIds.map(orderId => {
        const order = one(ORDER, {orderId})
        const seen = !!salesAccess.quoteOf(userScope, orderId)
        // a quote of another assignment: that a line was quoted, never its title or total
        return {
            orderId,
            orderName: seen ? order.orderName || orderId : L("A quote you cannot open"),
            statusText: statusText(order.statusId),
            totalText: seen ? moneyText(order.grandTotal ?? 0, order.currencyUomId) : "",
            entryText: dayText(order.entryDate),
            canOpen: seen
        }
    })
    const seenIds = quoteRows.filter(row => row.canOpen).map(row => row.orderId)
    const names = lib.partyNames([
        found.customerPartyId,
        found.contactPartyId,
        found.ownerPartyId,
        found.teamPartyId,
        found.organizationPartyId
    ])
    const account = salesAccess.accountOf(userScope, found.customerPartyId)
    const canEdit = found.canEdit && open
    const itemRows = items.map(item => {
        const quotedIn = Array.from(
            new Set(links.filter(link => link.requestItemSeqId === item.requestItemSeqId).map(link => link.orderId))
        )
        return {
            requestItemSeqId: item.requestItemSeqId,
            productId: item.productId || null,
            productName: productName(item.productId),
            description: repair ? "" : item.description || "",
            quantity: item.quantity,
            quantityText: quantityText(item.quantity),
            requiredByDate: repair ? null : item.requiredByDate,
            requiredByText: repair ? "" : dayText(item.requiredByDate),
            cancelled: item.statusId === "ReqCancelled",
            statusText: item.statusId === "ReqCancelled" ? L("Removed") : quotedIn.length ? L("Quoted") : L("Open"),
            quotedText: quotedIn.filter(orderId => seenIds.includes(orderId)).join(", ")
        }
    })
    const repairName = L("Chargeable repair") + (firstProduct(requestId) ? " · " + productName(firstProduct(requestId)) : "")
    return {
        requestFound: true,
        quoteRequest: {
            requestId,
            kind: repair ? "repair" : "rfq",
            repair,
            requestName: repair ? repairName : request.requestName || requestId,
            description: repair ? "" : request.description || "",
            statusId: request.statusId,
            statusText: repair ? L("Repair to quote") : statusText(request.statusId),
            organizationPartyId: found.organizationPartyId,
            organizationName: names[found.organizationPartyId] || found.organizationPartyId,
            customerPartyId: account ? found.customerPartyId : null,
            customerName: found.customerPartyId ? names[found.customerPartyId] || "" : "",
            contactPartyId: repair ? null : found.contactPartyId,
            contactName: repair ? "" : names[found.contactPartyId] || "",
            ownerPartyId: repair ? null : found.ownerPartyId,
            ownerName: repair ? "" : names[found.ownerPartyId] || "",
            teamPartyId: repair ? null : found.teamPartyId,
            teamName: repair ? "" : names[found.teamPartyId] || "",
            receivedText: dayText(request.requestDate),
            dueText: repair ? "" : dayText(request.responseRequiredDate),
            responseRequiredDate: repair ? null : request.responseRequiredDate,
            sourceText: repair ? L("Customer Service") : L(channelTexts[request.salesChannelEnumId] || "Staff entry"),
            requestRevision: revisionOf(requestId),
            open,
            canEdit: canEdit && !repair,
            canQuote: canEdit && !!found.customerPartyId && itemRows.some(row => !row.cancelled && row.productId),
            canDecline: canEdit && !repair,
            quoteHint: !found.customerPartyId
                ? L("Set the customer before making a quote")
                : !itemRows.some(row => !row.cancelled && row.productId)
                  ? L("Give a line a product before making a quote")
                  : ""
        },
        items: itemRows,
        quotes: quoteRows
    }
}

// ===== check#QuoteRequestAccess =====
// Whether the caller sees an RFQ and may change it: the record visibility of get#RecordLinkInfo and RecordFiles for an RqtQuote
// request and its files, in every app; a call with no user sees none.
function quoteRequestAccess(p) {
    if (!ec.user.userId) return {recordVisible: false, canEdit: false}
    const found = salesAccess.quoteRequestOf(salesAccess.scope(), text(p.requestId))
    return {recordVisible: !!found, canEdit: !!found?.canEdit && openStatuses.includes(found.request.statusId)}
}

// ===== the chargeable repair's notices (the user's call of Nov 13, 2026) =====
// Both ways, each title naming the claim, its customer and product or the quote, never the fault text, diagnosis, decision or an
// amount: Customer Service's chargeable decision tells the organization's default Sales team (SalesRepairToQuote), and a repair's
// quote tells the claim's assignee, else its queue's team or fallback assignee (SalesRepairQuoted). Never a failure of the decision
// or the quote: an error is logged.
const toSalesTopic = "SalesRepairToQuote"
const toServiceTopic = "SalesRepairQuoted"
const activeUserIds = partyId =>
    partyId
        ? rows("moqui.security.UserAccount", {partyId})
              .filter(row => row.disabled !== "Y")
              .map(row => row.userId)
        : []
// The organization's default Sales team: its SalesPolicy in effect (Sales P9, SalesApprovals.js policyOf), else none.
function defaultTeamOf(organizationPartyId) {
    if (!organizationPartyId) return null
    return (
        ec.resource.script("component://mr-mantle/service/mantle/order/SalesApprovals.js").policyOf(organizationPartyId)
            ?.defaultTeamPartyId || null
    )
}
// notify#RepairToQuote: after a warranty decision (decide#WarrantyClaim's commit), a chargeable one current on an open claim tells
// the current members of the organization's default team who would see it under "Repairs to quote" (SALES_QUOTE_EDIT or
// SALES_TEAM_VIEW, working for the organization).
function notifyRepairToQuote(p) {
    let sentCount = 0
    const wasDisabled = ec.artifactExecution.disableAuthz()
    ec.message.pushErrors()
    try {
        const decision = text(p.warrantyDecisionId) ? one(DECISION, {warrantyDecisionId: text(p.warrantyDecisionId)}) : null
        if (!decision || decision.supersededDate) return {sentCount}
        if (decision.chargeEstimate == null || toDecimal(String(decision.chargeEstimate)).compare(toDecimal(0)) <= 0)
            return {sentCount}
        const request = one(REQUEST, {requestId: decision.requestId})
        if (!request || request.requestTypeEnumId !== repairType || closedStatuses.includes(request.statusId)) return {sentCount}
        const parties = salesAccess.requestParties(request.requestId)
        const organizationPartyId = parties.find(row => row.roleTypeId === "OrgInternal")?.partyId || null
        const teamPartyId = defaultTeamOf(organizationPartyId)
        const team = teamPartyId ? settings.teamRow(teamPartyId) : null
        if (!team || team.organizationPartyId !== organizationPartyId || !settings.inEffect(team.relationship)) {
            ec.logger.info("Repair claim " + request.requestId + " to quote: the organization has no default Sales team to tell")
            return {sentCount}
        }
        const memberIds = Array.from(
            new Set(
                rows("mantle.party.PartyRelationship", {relationshipTypeEnumId: "PrtSalesTeamMember", toPartyId: teamPartyId})
                    .filter(row => lib.active(row))
                    .map(row => row.fromPartyId)
            )
        ).filter(partyId => settings.worksFor(partyId, organizationPartyId))
        const userIds = memberIds
            .flatMap(activeUserIds)
            .filter(userId => intake().userHolds(userId, "SALES_QUOTE_EDIT") || intake().userHolds(userId, "SALES_TEAM_VIEW"))
        if (!userIds.length) return {sentCount}
        ec.makeNotificationMessage()
            .topic(toSalesTopic)
            .message({
                requestId: request.requestId,
                customerName: partyName(parties.find(row => row.roleTypeId === "Customer")?.partyId),
                productName: productName(firstProduct(request.requestId)) || L("a product")
            })
            .userIds(Array.from(new Set(userIds)))
            .send()
        sentCount = userIds.length
    } catch (error) {
        ec.logger.error("Warranty decision " + (p.warrantyDecisionId || "") + ": Sales was not told: " + error.message)
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        if (!wasDisabled) ec.artifactExecution.enableAuthz()
    }
    return {sentCount}
}
// A repair's quote made: the claim's assignee is told, else the members of its service queue's team, else the queue's fallback
// assignee; not the user who made it.
function notifyRepairQuoted(source, orderId) {
    ec.message.pushErrors()
    try {
        const requestId = source.request.requestId
        const assigneePartyId = source.parties.find(row => row.roleTypeId === "Assignee")?.partyId || null
        let partyIds = assigneePartyId ? [assigneePartyId] : []
        if (!partyIds.length) {
            const cases = ec.resource.script("component://mr-mantle/service/mantle/request/SupportCases.js")
            const queue = cases.queueOf(source.request.requestCategoryId)?.queue || null
            if (queue?.responsibleTeamPartyId)
                partyIds = cases.teamMembers(queue.responsibleTeamPartyId).map(row => row.fromPartyId)
            if (!partyIds.length && queue?.fallbackAssigneePartyId) partyIds = [queue.fallbackAssigneePartyId]
        }
        const userIds = Array.from(new Set(partyIds.flatMap(activeUserIds))).filter(userId => userId !== ec.user.userId)
        if (!userIds.length) return
        ec.makeNotificationMessage()
            .topic(toServiceTopic)
            .message({
                requestId,
                orderId,
                customerName: partyName(source.customerPartyId),
                madeByName: partyName(ec.user.userAccount?.partyId) || ec.user.username || ""
            })
            .record(REQUEST, requestId)
            .userIds(userIds)
            .send()
    } catch (error) {
        ec.logger.error("Repair quote " + orderId + ": Customer Service was not told: " + error.message)
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}

// ===== the chargeable repair's quotes, for Customer Service =====
// The quotes made from a warranty claim's lines (Warranty.js get, after Customer Service's own check of the claim): each one's state,
// total and validity, never its lines' prices or the Sales assignment.
function quotesOfRequest(requestId) {
    return quoteIdsOf(requestId).map(orderId => {
        const order = one(ORDER, {orderId})
        const part = Array.from(find("mantle.order.OrderPart", {orderId}).orderBy("orderPartSeqId").list())[0]
        return {
            orderId,
            statusText: statusText(order.statusId),
            totalText: moneyText(order.grandTotal ?? 0, order.currencyUomId),
            validThruText: dayText(part?.validThruDate),
            entryText: dayText(order.entryDate)
        }
    })
}

const operations = {
    findQuoteRequests,
    getQuoteRequest,
    createQuoteRequest,
    quoteRequestFromEmail,
    storeQuoteRequestItem,
    updateQuoteRequest,
    createQuoteFromRequest,
    previewDecline,
    declineQuoteRequest,
    quoteRequestAccess,
    notifyRepairToQuote
}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown sales quote request operation " + op)
        return operations[op](parameters || {})
    },
    // for Warranty.js get (Customer Service's claim), never a service's parameters
    quotesOfRequest
})
