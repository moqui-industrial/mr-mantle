// The links customer notices carry to the Support app (impl-customer-service P15, F60; design-customer-service §8 Notices): a
// case's CustomerCase page and a return's CustomerReturn page, each a bearer link (ExternalAccess.create: a CaseView or ReturnRma
// capability) on the organization's first published site with the Support app, built by PublicApps.sitesFor and pageUrl.
// - caseLink: the case's link, or {url: null} when the organization has no Support site (no capability is made then).
// - addCaseLink: an agent's mail on a case (P5's apply#SavedReply, CaseDetail's Chatter through Comms Compose: both through
//   mantle.party.CommunicationServices.send#EmailDraft) gains the case's link before it is sent, when every recipient is on
//   the case's customer side (its customer, and its Customer and Reporter parties that are not staff), the sender may work
//   cases (SUPPORT_CASE_EDIT) and the mail has no link yet; with no Support site it goes without and the omission is logged.
// - sendReturnDecision: the customer told of a return decision (authorized, an exception approved or refused) by mail from the
//   organization, with the return's link; never the decision's reason, amount or approver. Only for an organization Customer
//   Service is set up for (a service policy) and a return the customer sees (not an agent's draft); without a Support site the
//   mail goes without the link, logged. Run on commit of the decision (ReturnPolicies.js), in its own transaction: a failure is
//   logged and changes nothing.
// CC0 1.0 Universal plus Grant of Patent License.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const cases = ec.resource.script("component://mr-mantle/service/mantle/request/SupportCases.js")
const access = () => ec.resource.script("component://mr-mantle/service/mantle/party/ExternalAccess.js")
const apps = () => ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
const {find, one, rows, call} = lib

const MESSAGE = "moqui.basic.email.EmailMessage",
    HEADER = "mantle.order.return.ReturnHeader",
    TEMPLATE = "MANTLE_RETURN_DECISION_EMAIL"
const blank = value => value == null || String(value).trim() === ""
const L = words => ec.l10n.localize(words)
const encode = value =>
    String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
const supportSite = organizationPartyId => apps().sitesFor("support", organizationPartyId)[0] || null

// The current email addresses of a party, lower case.
function emailsOf(partyId) {
    if (!partyId) return []
    const mechs = rows("mantle.party.contact.PartyContactMech", {partyId}).filter(row => lib.active(row))
    if (!mechs.length) return []
    return Array.from(
        find("mantle.party.contact.ContactMech")
            .condition(
                "contactMechId",
                "in",
                mechs.map(row => row.contactMechId)
            )
            .condition("contactMechTypeEnumId", "CmtEmailAddress")
            .list()
    )
        .map(mech => String(mech.infoString || "").trim())
        .filter(Boolean)
}
// A party's primary email, else any current one.
function emailOf(partyId) {
    if (!partyId) return null
    const mechs = rows("mantle.party.contact.PartyContactMech", {partyId}).filter(row => lib.active(row))
    const addresses = mechs.length
        ? Array.from(
              find("mantle.party.contact.ContactMech")
                  .condition(
                      "contactMechId",
                      "in",
                      mechs.map(row => row.contactMechId)
                  )
                  .condition("contactMechTypeEnumId", "CmtEmailAddress")
                  .list()
          )
        : []
    const primary = mechs.find(
        row => row.contactMechPurposeId === "EmailPrimary" && addresses.some(mech => mech.contactMechId === row.contactMechId)
    )
    const chosen = primary ? addresses.find(mech => mech.contactMechId === primary.contactMechId) : addresses[0]
    return blank(chosen?.infoString) ? null : String(chosen.infoString).trim()
}
// The addresses of a mail's To, Cc and Bcc, lower case.
const addressesOf = message =>
    [message.toAddresses, message.ccAddresses, message.bccAddresses]
        .flatMap(list => String(list || "").split(/[,;]/))
        .map(part => (/<([^>]+)>/.exec(part)?.[1] || part).trim().toLowerCase())
        .filter(Boolean)

// ===== a case's link =====
// The case's CustomerCase link for its customer; {url: null} with no Support site of its organization. The caller checks the
// asker's permission; caseOf checks the case is of the user's organizations.
function caseLink(requestId, validDays = 60) {
    const theCase = cases.caseOf(requestId)
    if (!supportSite(theCase.organizationPartyId)) return {url: null, thruDate: null}
    const made = access().create({recordType: "Request", recordId: theCase.requestId, scopes: "CaseView", validDays})
    return {url: made.url, thruDate: made.thruDate}
}
// The parties on the customer's side of a case: its customer, and its Customer and Reporter parties that are not staff.
function customerSide(theCase) {
    const ids = new Set([theCase.customerPartyId].filter(Boolean))
    for (const row of theCase.parties)
        if (
            ["Customer", "Reporter"].includes(row.roleTypeId) &&
            !cases.isInternal(row.partyId) &&
            !cases.organizationsOf(row.partyId).length
        )
            ids.add(row.partyId)
    return ids
}
// An agent's draft on a case, before send#EmailDraft sends it: the case's link appended when every recipient is on the
// customer's side. Answers what it did: {added, reason}; never throws (a failure is logged and the mail goes as written).
function addCaseLink(emailMessageId, requestId) {
    const wasDisabled = ec.artifactExecution.disableAuthz()
    try {
        const message = one(MESSAGE, {emailMessageId})
        if (!message || message.statusId !== "ES_DRAFT") return {added: false, reason: "NOT_DRAFT"}
        if (!one("mantle.request.support.CaseProfile", {requestId})) return {added: false, reason: "NOT_CASE"}
        if (String(message.body || "").includes("/CustomerCase?token=")) return {added: false, reason: "HAS_LINK"}
        if (!lib.access.has("SUPPORT_CASE_EDIT")) return {added: false, reason: "PERMISSION"}
        const theCase = cases.caseOf(requestId)
        const recipients = addressesOf(message)
        const side = new Set()
        for (const partyId of customerSide(theCase)) for (const address of emailsOf(partyId)) side.add(address.toLowerCase())
        // a mail to anyone else (a supplier, a colleague) carries no customer link
        if (!recipients.length || !recipients.every(address => side.has(address))) return {added: false, reason: "RECIPIENTS"}
        const link = caseLink(requestId)
        if (!link.url) {
            ec.logger.warn(
                "Case " +
                    requestId +
                    ": its organization has no published site with the Support app; the reply goes without its link"
            )
            return {added: false, reason: "NO_SITE"}
        }
        const words = L("Follow this request and reply online:")
        const values = {
            emailMessageId,
            body:
                String(message.body || "") +
                '<p class="support-link">' +
                encode(words) +
                ' <a href="' +
                encode(link.url) +
                '">' +
                encode(L("Your request")) +
                "</a></p>"
        }
        if (!blank(message.bodyText)) values.bodyText = String(message.bodyText) + "\n\n" + words + " " + link.url
        call("update#" + MESSAGE, values)
        return {added: true, url: link.url}
    } catch (error) {
        ec.message.clearErrors()
        ec.logger.error(
            "Case " + requestId + ": the Support link was not added to message " + emailMessageId + ": " + error.message
        )
        return {added: false, reason: "ERROR"}
    } finally {
        if (!wasDisabled) ec.artifactExecution.enableAuthz()
    }
}

// ===== a return decision's notice =====
const decisionTexts = {
    authorized: "is authorized. Send the goods back as the return's page says",
    exceptionApproved: "is accepted as an exception to our return policy. We will tell you what to do next",
    exceptionRefused: "cannot be accepted as requested. Reply to this email or contact support and we will help"
}
// The address the notice goes from: the organization's email, else its first shared mailbox, else no-reply at the site's host.
function senderOf(organizationPartyId, url) {
    const own = emailOf(organizationPartyId)
    if (own) return own
    const account = rows("moqui.basic.email.EmailAccount", {ownerPartyId: organizationPartyId}).find(row => row.emailAddress)
    if (account) return account.emailAddress
    const host = /^https?:\/\/([^/:]+)/.exec(String(url || ""))?.[1]
    return host ? "no-reply@" + host : null
}
// send#ReturnDecisionNotice: {returnId, decision}; answers {sent, emailMessageId, url, reason}.
function sendReturnDecision(p) {
    const wasDisabled = ec.artifactExecution.disableAuthz()
    try {
        const decision = String(p.decision || "")
        if (!decisionTexts[decision]) return {sent: false, reason: "DECISION_INVALID"}
        const header = blank(p.returnId) ? null : one(HEADER, {returnId: p.returnId})
        if (!header || ["ReturnCreated", "ReturnCancelled"].includes(header.statusId)) return {sent: false, reason: "NOT_SHOWN"}
        const organizationPartyId = header.vendorPartyId
        if (!cases.isInternal(organizationPartyId) || !cases.policyOf(organizationPartyId))
            return {sent: false, reason: "NOT_SERVICE"}
        const to = emailOf(header.customerPartyId)
        if (!to) {
            ec.logger.warn("Return " + header.returnId + ": the customer has no email address; no decision notice sent")
            return {sent: false, reason: "NO_ADDRESS"}
        }
        let url = null
        if (supportSite(organizationPartyId)) {
            const expires = Number(lib.ms(header.authorizationExpireDate) || 0)
            url = access().create({
                recordType: "ReturnHeader",
                recordId: header.returnId,
                scopes: "ReturnRma",
                thruDate: expires > Date.now() ? new Date(expires + 30 * 86400000) : null,
                validDays: 90
            }).url
        } else
            ec.logger.warn(
                "Return " +
                    header.returnId +
                    ": its organization has no published site with the Support app; the decision notice goes without its link"
            )
        const organizationName = cases.partyName(organizationPartyId)
        const fromAddress = senderOf(organizationPartyId, url)
        if (!fromAddress) {
            ec.logger.warn("Return " + header.returnId + ": the organization has no email address to send from; no notice sent")
            return {sent: false, reason: "NO_SENDER"}
        }
        const reference = header.displayId || header.returnId
        const subject = L("Your return") + " " + reference + " · " + organizationName
        const body =
            "<p>" +
            encode(L("Hello") + " " + cases.partyName(header.customerPartyId) + ",") +
            "</p><p>" +
            encode(
                L("Your return") +
                    " " +
                    reference +
                    " " +
                    L("with") +
                    " " +
                    organizationName +
                    " " +
                    L(decisionTexts[decision]) +
                    "."
            ) +
            "</p>" +
            (url ? '<p><a href="' + encode(url) + '">' + encode(L("See your return")) + "</a></p>" : "")
        let emailMessageId = null,
            error = null
        ec.message.pushErrors()
        try {
            const out =
                ec.service
                    .sync()
                    .name("org.moqui.impl.EmailServices.send#EmailTemplate")
                    .parameters({
                        emailTemplateId: TEMPLATE,
                        toAddresses: to,
                        bodyParameters: {subject, fromAddress, fromName: organizationName},
                        body
                    })
                    .requireNewTransaction(true)
                    .disableAuthz()
                    .call() || {}
            if (ec.message.hasError()) error = ec.message.getErrorsString()
            else emailMessageId = out.emailMessageId || null
        } catch (thrown) {
            error = thrown.message
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
        if (error) ec.logger.error("Return " + header.returnId + ": the decision notice was not sent: " + error)
        return {sent: !error && !!emailMessageId, emailMessageId, url, reason: error ? "SEND_FAILED" : null}
    } catch (error) {
        ec.message.clearErrors()
        ec.logger.error("Return " + (p.returnId || "") + ": the decision notice was not sent: " + error.message)
        return {sent: false, reason: "ERROR"}
    } finally {
        if (!wasDisabled) ec.artifactExecution.enableAuthz()
    }
}
// The decision's notice queued to go once the decision commits (a rolled back decision sends nothing).
function queueReturnDecision(returnId, decision) {
    try {
        ec.service
            .special()
            .name("mantle.order.ReturnPolicyServices.send#ReturnDecisionNotice")
            .parameters({returnId, decision})
            .registerOnCommit()
    } catch (error) {
        ec.logger.error("Return " + returnId + ": the decision notice was not queued: " + error.message)
    }
}
;({caseLink, addCaseLink, sendReturnDecision, queueReturnDecision})
