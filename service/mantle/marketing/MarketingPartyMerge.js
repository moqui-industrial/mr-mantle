// Marketing's part of a party merge (mantle.party.DuplicateServices merge#Parties; IronStone Marketing design §10, crosscut X15;
// impl-marketing P19, F82), on Sales P3's pattern: PartyMerge.js rules() asks refusals() before anything changes, and merge#Parties
// calls move() after its own moves, both reading and writing without the caller's entity filters (the guards decided who merges).
//
// What refuses a merge, each naming the record (a refusal fails merge#Parties with its reason code):
// - ENROLLMENT_ACTIVE: an automation enrollment of the merged party that is still active (stop it, or let it end, first);
// - ENROLLMENT_CONFLICT: an ended enrollment of the merged party in an automation the kept party was enrolled in by the same source
//   (one enrollment per automation, person and source: the two cannot be one person's);
// - REGISTRATION_ACTIVE: an event registration whose attendee or buyer is the merged party, in a live state (held, pending,
//   confirmed, waitlisted, under review) on an occurrence that has not ended (cancel or move it, or wait for the event, first),
//   except in a verified account's claim of the person a public reservation made (EventRegistrationClaims.js, the system's merge);
// - RECIPIENT_PENDING: a recipient of the merged party still waiting in a send that is not finished (it would reach the kept
//   party a second time).
// What moves, never silently lost:
// - list memberships (ContactListParty): moved; where both parties have a current row on one list (and role), the more
//   restrictive state is kept on the kept party's row (an unsubscription, a pending unsubscription or a rejection over a live
//   membership; the user's call, F82) and the merged party's row moves ended, as history;
// - consent (PartyConsent): the whole history moves; where the merged party had withdrawn a purpose (for an organization or
//   every one, at an address or for the party) that the kept party's later grant would undo, a withdrawal is recorded for the
//   kept party (source PcsMerge) at each of its addresses that is the same address (an email ignoring case, a phone by its
//   parts), and where the kept party's own withdrawal would be undone by the merged party's later grant, again for the kept
//   party, so a withdrawal always wins whichever side it was on; the unsubscribe link tokens move;
// - explicit segment members (MarketSegmentParty): moved; on a collision an exclusion wins over an inclusion, and a current row
//   over the kept party's ended one; a list membership or campaign person meeting a row of the same key starts a millisecond later;
// - subscription requests, audience import rows, campaign recipients (and with them their tracking events and tokens, which name
//   the recipient), automation source events and ended enrollments, campaign people, list send statuses, event registrations
//   (attendee and buyer), reservations, attendance facts and form submissions (lead captures name the submission): their party
//   field moves.
// Suppressions are by address (MessageSuppression.destinationKey) and follow the address, not the party. The ledger's deliveries,
// Commons' invitations and ExternalAccess capabilities stay their owners' (impl-marketing §7, F82).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const eligibility = () => ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingEligibility.js")

const CLP = "mantle.marketing.contact.ContactListParty"
const CONSENT = "mantle.party.PartyConsent"
const SEGMENT_PARTY = "mantle.marketing.segment.MarketSegmentParty"
const ENROLLMENT = "mantle.marketing.automation.AutomationEnrollment"
const REGISTRATION = "mantle.work.registration.EventRegistration"
const POLICY = "mantle.work.registration.EventRegistrationPolicy"
const RECIPIENT = "mantle.marketing.campaign.CampaignRecipient"
const SEND = "mantle.marketing.campaign.CampaignSend"

// ===== tables =====
// A list membership's restrictiveness: a withdrawal outranks a live membership; between live states the kept party's stands.
const membershipRank = {
    CLPT_UNSUBSCRIBED: 3,
    CLPT_UNSUBS_PENDING: 2,
    CLPT_REJECTED: 2,
    CLPT_INVALID: 1
}
const liveRegistrationStatuses = ["EvrHeld", "EvrPending", "EvrConfirmed", "EvrWaitlisted", "EvrReview"]
const waitingRecipientStatuses = ["CrsSelected", "CrsHeld"]
const finishedSendStatuses = ["CsCompleted", "CsCompletedFailures", "CsCancelled"]
// The rows whose party field moves as it is (entity, field).
const partyFields = [
    ["mantle.marketing.contact.SubscriptionRequest", "partyId"],
    ["mantle.marketing.contact.AudienceImportItem", "partyId"],
    ["mantle.marketing.contact.AudienceImportItem", "matchedPartyId"],
    ["mantle.marketing.contact.ContactListCommStatus", "partyId"],
    ["mantle.marketing.contact.ContactListToken", "partyId"],
    [RECIPIENT, "partyId"],
    ["mantle.marketing.automation.AutomationSourceEvent", "partyId"],
    [ENROLLMENT, "partyId"],
    [REGISTRATION, "attendeePartyId"],
    [REGISTRATION, "buyerPartyId"],
    ["mantle.work.registration.EventReservation", "buyerPartyId"],
    ["mantle.work.registration.EventAttendance", "attendeePartyId"],
    ["mantle.party.FormSubmission", "partyId"]
]

// ===== reads (no entity filters, no artifact authorization) =====
function query(entityName, conditions) {
    let found = ec.entity.find(entityName).disableAuthz()
    for (const [field, value] of Object.entries(conditions || {}))
        found = Array.isArray(value) ? found.condition(field, "in", value) : found.condition(field, value)
    return found
}
const listOf = (entityName, conditions) => Array.from(query(entityName, conditions).list())
const ms = value => lib.ms(value)
const nowMs = () => ms(ec.user.nowTimestamp)
const current = row => (ms(row.fromDate) ?? -Infinity) <= nowMs() && (ms(row.thruDate) ?? Infinity) > nowMs()
function refuse(reason, message) {
    const error = new Error(reason + ": " + message)
    error.reason = reason
    throw error
}

// ===== refusals (PartyMerge.js rules) =====
// options.liveRegistrations: a verified account's claim of the person a public reservation made for its address
// (EventRegistrationClaims.js, the system's merge only, PartyMerge.js): the live registrations move with the person, so
// REGISTRATION_ACTIVE does not refuse it (the owner's call of Nov 16, 2026, SEC-PSS-61).
function refusals(fromPartyId, toPartyId, options = {}) {
    const active = query(ENROLLMENT, {partyId: fromPartyId, statusId: "AenActive"}).one()
    if (active)
        refuse(
            "ENROLLMENT_ACTIVE",
            "Party " +
                fromPartyId +
                " has the active automation enrollment " +
                active.automationEnrollmentId +
                "; stop it or let it end before merging"
        )
    for (const enrollment of listOf(ENROLLMENT, {partyId: fromPartyId})) {
        const same = query(ENROLLMENT, {
            partyId: toPartyId,
            marketingAutomationId: enrollment.marketingAutomationId,
            sourceKey: enrollment.sourceKey
        }).one()
        if (same)
            refuse(
                "ENROLLMENT_CONFLICT",
                "Parties " +
                    fromPartyId +
                    " and " +
                    toPartyId +
                    " were both enrolled in automation " +
                    enrollment.marketingAutomationId +
                    " by the same source (" +
                    enrollment.automationEnrollmentId +
                    ")"
            )
    }
    for (const field of options.liveRegistrations ? [] : ["attendeePartyId", "buyerPartyId"])
        for (const registration of listOf(REGISTRATION, {[field]: fromPartyId, statusId: liveRegistrationStatuses})) {
            const policy = query(POLICY, {registrationPolicyId: registration.registrationPolicyId}).one()
            const end = ms(policy?.occurrenceEnd) ?? ms(policy?.occurrenceStart)
            if (end == null || end > nowMs())
                refuse(
                    "REGISTRATION_ACTIVE",
                    "Party " +
                        fromPartyId +
                        " has the event registration " +
                        registration.registrationId +
                        " for an occurrence that has not ended; cancel it or wait for the event before merging"
                )
        }
    const waiting = listOf(RECIPIENT, {partyId: fromPartyId, statusId: waitingRecipientStatuses})
    if (waiting.length) {
        const sendIds = Array.from(new Set(waiting.map(row => row.campaignSendId)))
        const unfinished = query(SEND, {campaignSendId: sendIds})
            .condition("statusId", "not-in", finishedSendStatuses)
            .orderBy("campaignSendId")
            .one()
        if (unfinished)
            refuse(
                "RECIPIENT_PENDING",
                "Party " +
                    fromPartyId +
                    " is a recipient waiting in send " +
                    unfinished.campaignSendId +
                    "; merge once it is sent or cancelled"
            )
    }
}

// ===== addresses =====
// The kept party's addresses that are the merged party's address: the same contact mechanism when the merge attached it, and the
// kept party's current ones of the same kind and value (an email ignoring case, a phone number by its parts).
function keptAddresses(fromContactMechId, toAddresses) {
    if (!fromContactMechId) return []
    const mech = query("mantle.party.contact.ContactMech", {contactMechId: fromContactMechId}).one()
    if (!mech) return []
    const phoneOf = contactMechId => {
        const phone = query("mantle.party.contact.TelecomNumber", {contactMechId}).one()
        return phone ? [phone.countryCode || "", phone.areaCode || "", phone.contactNumber || ""].join("|") : null
    }
    const fromPhone = mech.contactMechTypeEnumId === "CmtTelecomNumber" ? phoneOf(fromContactMechId) : null
    const fromInfo = String(mech.infoString || "")
        .trim()
        .toLowerCase()
    return toAddresses
        .filter(
            address =>
                address.contactMechId === fromContactMechId ||
                (address.contactMechTypeEnumId === mech.contactMechTypeEnumId &&
                    (fromPhone ? phoneOf(address.contactMechId) === fromPhone : !!fromInfo && address.info === fromInfo))
        )
        .map(address => address.contactMechId)
}
function addressesOf(partyId) {
    const ids = listOf("mantle.party.contact.PartyContactMech", {partyId})
        .filter(current)
        .map(row => row.contactMechId)
    if (!ids.length) return []
    return listOf("mantle.party.contact.ContactMech", {contactMechId: Array.from(new Set(ids))}).map(mech => ({
        contactMechId: mech.contactMechId,
        contactMechTypeEnumId: mech.contactMechTypeEnumId,
        info: String(mech.infoString || "")
            .trim()
            .toLowerCase()
    }))
}

// ===== moves (merge#Parties) =====
// Creates a moved row whose primary key holds fromDate; where the kept party has a row of the same key (two parties added in one
// transaction share its timestamp), the moved row starts a millisecond later rather than being dropped (P19 review: never lost).
function createMoved(entityName, copy) {
    for (let tries = 0; tries < 1000; tries++) {
        if (!query(entityName, copy.getPrimaryKeys()).one()) {
            copy.create()
            return
        }
        copy.set("fromDate", new Date((ms(copy.fromDate) ?? 0) + 1))
    }
    throw new Error("No free key to move a row of " + entityName)
}
const newestFirst = (a, b) =>
    (ms(b.consentDate) ?? 0) - (ms(a.consentDate) ?? 0) ||
    String(b.partyConsentId).length - String(a.partyConsentId).length ||
    (String(b.partyConsentId) > String(a.partyConsentId) ? 1 : -1)
const consentsOf = partyId => listOf(CONSENT, {partyId}).sort(newestFirst)

// The list memberships: each row moves; a current row meeting the kept party's current row on the same list and role keeps the
// more restrictive state there, and moves ended. {moved, kept}
function moveMemberships(fromPartyId, toPartyId) {
    const group = row => row.contactListId + "|" + (row.roleTypeId || "")
    const keptCurrent = new Map(
        listOf(CLP, {partyId: toPartyId})
            .filter(current)
            .map(row => [group(row), row])
    )
    let moved = 0
    let kept = 0
    for (const row of listOf(CLP, {partyId: fromPartyId})) {
        const keptRow = current(row) ? keptCurrent.get(group(row)) : null
        const copy = row.cloneValue()
        copy.set("partyId", toPartyId)
        if (keptRow) {
            if ((membershipRank[row.statusId] || 0) > (membershipRank[keptRow.statusId] || 0)) {
                keptRow.set("statusId", row.statusId)
                keptRow.set("revision", Math.max(Number(keptRow.revision || 0), Number(row.revision || 0)) + 1)
                keptRow.update()
                kept++
            }
            copy.set("thruDate", ec.user.nowTimestamp)
        }
        createMoved(CLP, copy)
        row.delete()
        moved++
    }
    return {moved, kept}
}
// The withdrawn consent keys of one party's history (purpose, address, organization), as purposeState reads them.
function withdrawnKeys(consents) {
    const keys = new Map()
    for (const row of consents) {
        if (row.contactListId) continue
        const key = [row.purposeEnumId, row.contactMechId || "", row.organizationPartyId || ""].join("|")
        if (!keys.has(key))
            keys.set(key, {
                purposeEnumId: row.purposeEnumId,
                contactMechId: row.contactMechId || null,
                organizationPartyId: row.organizationPartyId || null
            })
    }
    const states = eligibility()
    return Array.from(keys.values()).filter(
        key => states.purposeState(consents, key.purposeEnumId, key.contactMechId, key.organizationPartyId).withdrawn
    )
}
// The consent history, then a withdrawal for the kept party wherever either party's withdrawal would be undone by the other's later
// grant (P19 review: the kept party's own withdrawal too, so a withdrawal wins whichever side it was on). {moved, kept}
function moveConsents(fromPartyId, toPartyId) {
    const fromConsents = consentsOf(fromPartyId)
    const withdrawn = withdrawnKeys(fromConsents)
    const keptWithdrawn = withdrawnKeys(consentsOf(toPartyId))
    const states = eligibility()
    let moved = 0
    for (const row of fromConsents) {
        row.set("partyId", toPartyId)
        row.update()
        moved++
    }
    if (!withdrawn.length && !keptWithdrawn.length) return {moved, kept: 0}
    const toAddresses = addressesOf(toPartyId)
    const toConsents = consentsOf(toPartyId)
    let kept = 0
    // each withdrawal of the merged party at the party, or at each of the kept party's addresses that is the withdrawn address (an
    // address the kept party does not have keeps its withdrawal on the moved rows); each of the kept party's as it was
    const targets = withdrawn
        .flatMap(key =>
            (key.contactMechId ? keptAddresses(key.contactMechId, toAddresses) : [null]).map(contactMechId =>
                Object.assign({}, key, {contactMechId})
            )
        )
        .concat(keptWithdrawn)
    const done = new Set()
    for (const key of targets) {
        const doneKey = [key.purposeEnumId, key.contactMechId || "", key.organizationPartyId || ""].join("|")
        if (done.has(doneKey)) continue
        done.add(doneKey)
        const contactMechId = key.contactMechId
        if (states.purposeState(toConsents, key.purposeEnumId, contactMechId, key.organizationPartyId).withdrawn) continue
        ec.service
            .sync()
            .name("mantle.party.ConsentServices.record#PartyConsent")
            .parameters({
                partyId: toPartyId,
                purposeEnumId: key.purposeEnumId,
                statusId: "PconWithdrawn",
                contactMechId,
                organizationPartyId: key.organizationPartyId,
                sourceEnumId: "PcsMerge",
                evidenceText: "Withdrawn before party " + fromPartyId + " was merged into party " + toPartyId,
                comments: "Kept at the party merge: a withdrawal wins"
            })
            .disableAuthz()
            .call()
        kept++
    }
    return {moved, kept}
}
// The explicit segment members: moved; on a collision (the same segment and role) an exclusion wins. {moved}
function moveSegmentMembers(fromPartyId, toPartyId) {
    let moved = 0
    for (const row of listOf(SEGMENT_PARTY, {partyId: fromPartyId})) {
        const copy = row.cloneValue()
        copy.set("partyId", toPartyId)
        const keptRow = query(SEGMENT_PARTY, copy.getPrimaryKeys()).one()
        if (!keptRow) copy.create()
        else if (
            current(row) &&
            ((row.memberKindEnumId === "MspExclude" && keptRow.memberKindEnumId !== "MspExclude") || !current(keptRow))
        ) {
            // an exclusion wins; a current membership replaces the kept party's ended one (P19 review: never lost)
            keptRow.set("memberKindEnumId", row.memberKindEnumId)
            keptRow.set("fromDate", row.fromDate)
            keptRow.set("thruDate", row.thruDate)
            keptRow.update()
        }
        row.delete()
        moved++
    }
    return {moved}
}
// Marketing's rows of the merged party, after merge#Parties' own moves: {memberships, membershipsKept, consents, consentsKept,
// segmentMembers, records}
function move(fromPartyId, toPartyId) {
    const memberships = moveMemberships(fromPartyId, toPartyId)
    const consents = moveConsents(fromPartyId, toPartyId)
    const segments = moveSegmentMembers(fromPartyId, toPartyId)
    let records = 0
    for (const [entityName, field] of partyFields)
        for (const row of listOf(entityName, {[field]: fromPartyId})) {
            row.set(field, toPartyId)
            row.update()
            records++
        }
    for (const row of listOf("mantle.marketing.campaign.MarketingCampaignParty", {partyId: fromPartyId})) {
        const copy = row.cloneValue()
        copy.set("partyId", toPartyId)
        createMoved("mantle.marketing.campaign.MarketingCampaignParty", copy)
        row.delete()
        records++
    }
    return {
        memberships: memberships.moved,
        membershipsKept: memberships.kept,
        consents: consents.moved,
        consentsKept: consents.kept,
        segmentMembers: segments.moved,
        records
    }
}

;({refusals, move})
