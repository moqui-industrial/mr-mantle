/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * Comms' text messages (mantle.party.MessageSmsServices; design-marketing §12 SendingProfiles, §5 Compose's SMS counter; impl-marketing
 * P22, F57, F72-F74): the ledger's SMS channel rests on the framework's C4-SMS (org.moqui.SmsServices.send#SmsMessage, mr-moqui
 * docs/interfaces/SMS.md), never a Marketing adapter.
 *
 * - Numbers: a TelecomNumber in E.164 from its own country code, else by the deployment's rules (VoicePolicy homeCountryCode, through
 *   CallHandlingServices normalize#PhoneNumber); never a guessed country. An organization's messaging numbers are its current telecom
 *   numbers that are one of our numbers (moqui.call.PhoneNumber) with a messaging bridge.
 * - An SMS sending profile is bound to one of those numbers (fromPhoneNumber) and is ready only while the number is the organization's
 *   and its messaging bridge is there and enabled (smsChecks, for MessageSendingProfiles.js readinessOf).
 * - The estimate before approval: the text's encoding (GSM-7, else UCS-2), its characters, its segments (160 or 70 alone, 153 or 67
 *   each when split) and the profile's configured cost a segment times the segments.
 * - The sms-consent answer (check#SmsConsent; registered in Mantle's MoquiConf.xml screen-facade shell-providers, so the framework asks
 *   it for every sender, a campaign's dispatch running as the system included; mr-moqui docs/tools/Comms.md "Provider hooks"): the hook
 *   carries the two numbers only, so the topic is the ledger's to check (MessageDeliveries.js consentOf); this answers yes only when a
 *   party holding toNumber has PcpSms granted with an organization that owns fromNumber (its organization's row, else the global one,
 *   or one of its topics' latest rows; no global or organization withdrawal) and the number has no SMS suppression of every
 *   organization or that one; no otherwise.
 * - STOP (note#SmsKeyword, the EECA SmsOptOut.eecas.xml on the framework's moqui.call.SmsOptOut): a STOP to one of an organization's
 *   numbers withdraws PcpSms with that organization for every party holding the number (once: a party already withdrawn there is left)
 *   and adds an SMS suppression of the number for it (never doubled). A START ends neither: new consent needs new evidence.
 * Reads and writes are the authority's own (authorization disabled); only Mantle services and the framework's hook call these.
 */
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, call, ms} = lib
const suppressions = ec.resource.script("component://mr-mantle/service/mantle/party/MessageSuppressions.js")
const NUMBER = "moqui.call.PhoneNumber"
const BRIDGE = "moqui.chat.ChatBridge"
const text = value => (value == null ? "" : String(value).trim())
const blank = value => text(value) === ""
const fixRoutes = {profile: "marketingSendingProfiles", numbers: "voiceNumbers"}

// ===== numbers =====
// A number written by a person in E.164 by the deployment's rules, or null.
function e164Text(value) {
    const raw = text(value)
    if (!raw) return null
    if (/^\+[1-9]\d{6,14}$/.test(raw.replace(/[\s().-]/g, ""))) return raw.replace(/[\s().-]/g, "")
    ec.message.pushErrors()
    try {
        const out =
            ec.service
                .sync()
                .name("org.moqui.call.CallHandlingServices.normalize#PhoneNumber")
                .parameter("phoneNumber", raw)
                .disableAuthz()
                .call() || {}
        return out.number || null
    } catch (error) {
        return null
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}
// A TelecomNumber (or a row with its countryCode, areaCode and contactNumber) in E.164: its own country code, else the deployment's.
function e164Of(number) {
    if (!number) return null
    const local = text(number.areaCode) + text(number.contactNumber)
    const digits = local.replace(/\D/g, "")
    if (digits.length < 4) return null
    const country = text(number.countryCode).replace(/\D/g, "")
    if (country) {
        const found = "+" + country + digits
        return /^\+[1-9]\d{6,14}$/.test(found) ? found : null
    }
    if (local.trim().startsWith("+")) return e164Text(local)
    return e164Text(digits)
}
// The parties with a current telecom number that is phoneNumber (E.164): candidates by its last seven digits, as stored or written
// 123-4567 (much of Mantle's data has the dash), kept when the whole number is it.
function partiesWith(phoneNumber) {
    const digits = text(phoneNumber).replace(/\D/g, "")
    if (digits.length < 7) return []
    const factory = ec.entity.conditionFactory
    const last7 = digits.slice(-7)
    const written = [last7].concat(["-", " ", "."].map(sep => last7.slice(0, 3) + sep + last7.slice(3)))
    const found = new Set()
    for (const row of Array.from(
        find("mantle.party.contact.PartyContactMechTelecomNumber")
            .condition(
                factory.makeCondition(
                    written.map(form => factory.makeCondition("contactNumber", "like", "%" + form + "%")),
                    "or"
                )
            )
            .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
            .limit(500)
            .list()
    ))
        if (e164Of(row) === phoneNumber) found.add(row.partyId)
    return Array.from(found)
}
const internal = partyId => find("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"}).count() > 0
// The internal organizations that own one of our numbers: those with it as a current telecom number.
const ownersOf = phoneNumber => partiesWith(phoneNumber).filter(internal)
// One of our numbers with a messaging bridge that is there and not disabled: {phoneNumber, bridge, problem}.
function messagingOf(phoneNumber) {
    const number = phoneNumber ? one(NUMBER, {phoneNumber}) : null
    if (!number) return {problem: "It is not one of our numbers (System, Voice, Numbers)"}
    if (blank(number.messagingBridgeId)) return {problem: "The number has no messaging bridge (System, Voice, Numbers)"}
    const bridge = one(BRIDGE, {chatBridgeId: number.messagingBridgeId})
    if (!bridge) return {problem: "The number's messaging bridge is not there"}
    if (bridge.statusId === "CbsDisabled") return {problem: "The number's messaging bridge is disabled"}
    return {phoneNumber, description: number.description || null, bridge}
}
// The organization's messaging numbers (its current telecom numbers that are ours with a messaging bridge): [{value, label}].
function organizationNumbers(organizationPartyId) {
    if (!organizationPartyId) return []
    const out = []
    for (const row of Array.from(
        find("mantle.party.contact.PartyContactMechTelecomNumber", {partyId: organizationPartyId})
            .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
            .list()
    )) {
        const number = e164Of(row)
        if (!number || out.some(option => option.value === number)) continue
        const messaging = messagingOf(number)
        if (!messaging.problem)
            out.push({value: number, label: number + (messaging.description ? " (" + messaging.description + ")" : "")})
    }
    return out
}

// ===== the SMS profile's readiness (MessageSendingProfiles.js readinessOf) =====
// add(checkKey, title, state, message, fixRoute) for each check of an SMS profile beside "In effect".
function smsChecks(profile, add) {
    const number = text(profile.fromPhoneNumber)
    if (!number) {
        add("number", "Messaging number", "blocked", "Choose one of the organization's messaging numbers", fixRoutes.profile)
        return
    }
    const messaging = messagingOf(number)
    if (messaging.problem) add("number", "Messaging number", "blocked", messaging.problem, fixRoutes.numbers)
    else if (!ownersOf(number).includes(profile.organizationPartyId))
        add(
            "number",
            "Messaging number",
            "blocked",
            number + " is not one of the organization's numbers: add it to the organization's contact information",
            fixRoutes.profile
        )
    else
        add(
            "number",
            "Messaging number",
            messaging.bridge.statusId === "CbsConnected" ? "ready" : "warning",
            messaging.bridge.statusId === "CbsConnected"
                ? "Texts go from " + number + " through " + (messaging.bridge.name || messaging.bridge.chatBridgeId)
                : "Texts go from " +
                      number +
                      " through " +
                      (messaging.bridge.name || messaging.bridge.chatBridgeId) +
                      ", not connected yet",
            messaging.bridge.statusId === "CbsConnected" ? null : fixRoutes.numbers
        )
    add("optOut", "Opt-out", "ready", "A reply of STOP withdraws consent and suppresses the number")
}

// ===== the estimate before approval =====
// GSM 03.38's basic set, and its extension (two characters each)
const gsmBasic =
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
const gsmExtension = "^{}\\[~]|€\f"
// A text's encoding, characters and segments: {encoding, characterCount, segmentCount}.
function segmentsOf(body) {
    const value = String(body == null ? "" : body)
    let gsm = true,
        septets = 0
    for (const ch of value) {
        if (gsmBasic.includes(ch)) septets += 1
        else if (gsmExtension.includes(ch)) septets += 2
        else {
            gsm = false
            break
        }
    }
    if (gsm)
        return {
            encoding: "GSM-7",
            characterCount: septets,
            segmentCount: !septets ? 0 : septets <= 160 ? 1 : Math.ceil(septets / 153)
        }
    // UCS-2: UTF-16 code units (a character outside the basic plane takes two)
    const units = value.length
    return {encoding: "UCS-2", characterCount: units, segmentCount: !units ? 0 : units <= 70 ? 1 : Math.ceil(units / 67)}
}
// The estimate of a text from a profile: its segments, and the cost of a message and of recipients when the profile has a cost a
// segment. {encoding, characterCount, segmentCount, segmentCost, currencyUomId, messageCost, totalCost, estimateText}.
function estimate(body, profile, recipientCount) {
    const found = segmentsOf(body)
    const cost = profile && profile.segmentCost != null && text(profile.segmentCost) !== "" ? toNumber(profile.segmentCost) : null
    const messageCost = cost == null ? null : Math.round(cost * found.segmentCount * 10000) / 10000
    const count = recipientCount == null ? null : Number(recipientCount)
    const totalCost = messageCost == null || count == null ? null : Math.round(messageCost * count * 100) / 100
    const currency = profile?.segmentCostUomId || null
    const money = value => (currency ? ec.l10n.formatCurrency(value, currency) : String(value))
    const parts = [
        found.characterCount + " characters",
        found.encoding,
        found.segmentCount + (found.segmentCount === 1 ? " segment" : " segments")
    ]
    if (messageCost != null) parts.push(money(messageCost) + " a message")
    if (totalCost != null) parts.push(money(totalCost) + " for " + count + (count === 1 ? " recipient" : " recipients"))
    return Object.assign({}, found, {
        segmentCost: cost,
        currencyUomId: currency,
        messageCost,
        totalCost,
        estimateText: parts.join(", ")
    })
}
// The words a promotional text ends with, so the person knows how to stop it (carrier rules); added when the text has no STOP.
const optOutLine = () => ec.l10n.localize("Reply STOP to opt out")
const withOptOut = body => {
    const value = text(body)
    if (!value) return value
    return /\bSTOP\b/i.test(value) ? value : value + "\n" + optOutLine()
}

// ===== the sms-consent answer =====
// The PcpSms state of a party with an organization from its rows newest first: withdrawn when its latest global row or its latest row
// of the organization withdraws; granted when not withdrawn and the organization's row (else the global one) grants, or the latest
// row of one of the organization's topics (a list it owns) grants.
function smsConsentWith(partyId, organizationPartyId) {
    const all = Array.from(
        find("mantle.party.PartyConsent", {partyId, purposeEnumId: "PcpSms"})
            .orderBy("-consentDate")
            .orderBy("-partyConsentId")
            .list()
    ).filter(row => (ms(row.consentDate) ?? 0) <= ms(ec.user.nowTimestamp))
    const rows = all.filter(row => !row.contactListId)
    const global = rows.find(row => !row.organizationPartyId) || null
    const scoped = rows.find(row => row.organizationPartyId === organizationPartyId) || null
    if (global?.statusId === "PconWithdrawn" || scoped?.statusId === "PconWithdrawn") return {withdrawn: true, granted: false}
    if ((scoped || global)?.statusId === "PconGranted") return {withdrawn: false, granted: true}
    const latestOfList = new Map()
    for (const row of all) if (row.contactListId && !latestOfList.has(row.contactListId)) latestOfList.set(row.contactListId, row)
    for (const [contactListId, row] of latestOfList)
        if (
            row.statusId === "PconGranted" &&
            one("mantle.marketing.contact.ContactList", {contactListId})?.ownerPartyId === organizationPartyId
        )
            return {withdrawn: false, granted: true}
    return {withdrawn: false, granted: false}
}
// check#SmsConsent: {consent} for a promotional text from fromNumber to toNumber.
function consent(p) {
    const from = e164Text(p.fromNumber)
    const to = e164Text(p.toNumber)
    if (!from || !to) return {consent: false}
    const owners = ownersOf(from)
    if (!owners.length) return {consent: false}
    const holders = partiesWith(to)
    for (const org of owners) {
        if (suppressions.suppressedOf("MdcSms", [to], org, false).suppressed.length) continue
        if (holders.some(partyId => smsConsentWith(partyId, org).granted)) return {consent: true}
    }
    return {consent: false}
}

// ===== STOP =====
// note#SmsKeyword: a STOP to ourNumber from theirNumber (the framework's SmsOptOut row) withdraws PcpSms with each organization that
// owns ourNumber for each party holding theirNumber, once, and suppresses theirNumber for it. {withdrawnCount, suppressedCount}.
function noteKeyword(p) {
    if (text(p.optedOut) !== "Y" || text(p.lastKeyword) !== "STOP") return {withdrawnCount: 0, suppressedCount: 0}
    const ours = e164Text(p.ourNumber)
    const theirs = e164Text(p.theirNumber)
    if (!ours || !theirs) return {withdrawnCount: 0, suppressedCount: 0}
    let withdrawnCount = 0,
        suppressedCount = 0
    const evidence = "Replied STOP to " + ours
    for (const org of ownersOf(ours)) {
        for (const partyId of partiesWith(theirs)) {
            if (smsConsentWith(partyId, org).withdrawn) continue
            call("mantle.party.ConsentServices.record#PartyConsent", {
                partyId,
                purposeEnumId: "PcpSms",
                statusId: "PconWithdrawn",
                organizationPartyId: org,
                sourceEnumId: "PcsSmsReply",
                evidenceText: evidence,
                updateSolicitation: false
            })
            withdrawnCount++
        }
        const block = suppressions.addFromIntake({
            channelEnumId: "MdcSms",
            destination: theirs,
            organizationPartyId: org,
            reasonEnumId: "MsrSmsStop",
            sourceEnumId: "MssSmsReply",
            sourceRef: ours,
            evidenceText: evidence
        })
        if (block?.created) suppressedCount++
    }
    return {withdrawnCount, suppressedCount}
}

;({
    e164Of,
    e164Text,
    partiesWith,
    ownersOf,
    organizationNumbers,
    smsChecks,
    segmentsOf,
    estimate,
    withOptOut,
    consent,
    noteKeyword,
    execute: (op, parameters) => {
        const operations = {consent, noteKeyword, estimate: p => estimate(p.body, null, null)}
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown text message operation " + op)
        return operations[op](parameters || {})
    }
})
