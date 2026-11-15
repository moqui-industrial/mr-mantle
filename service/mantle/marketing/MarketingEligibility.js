// Marketing's audience eligibility (mantle.marketing.SegmentServices preview#Audience and classify#Recipients; IronStone Marketing
// design §4 AudiencePreview, §14.2 Q; impl-marketing P5, §1: the rule P8 prepares a send with and P11 admits with). Every send
// selects a subscription topic, a Marketing list (never a mailbox) of an organization; its lists and segments find the people, and
// each person is then put in exactly one bucket, by precedence:
//
//   1. unavailable: the party is missing, disabled, merged or another user's personal contact;
//   2. destination: no address of the topic's channel, or not a valid one;
//   3. suppressed: an active block of the address for the organization or every one (Comms' suppressions as the ledger applies them
//      to a promotional delivery: MessageSuppressions.js suppressedOf, not transactional);
//   4. withdrawn: not an accepted member of the topic (none, pending, unsubscribed), the topic's consent withdrawn, the purpose
//      withdrawn (by its organization-scoped row, or a global one, which a scoped grant never undoes: P3), the address's
//      solicitation refused, or another person at the same address withdrawn (any withdrawal on a destination blocks it);
//   5. evidence: an accepted member with no evidenced grant (no granted consent of the topic or of the purpose): a legacy member
//      needs review, never silently grandfathered;
//   6. duplicate: another eligible person has the same normalized address in the organization and channel; one is chosen
//      deterministically (the lowest party id), the others are duplicates, each keeping its source memberships for explanation;
//   7. eligible, flagged untracked when the person has not granted tracking (PcpTracking): untracked is no exclusion.
//
// The buckets partition the matched people, so their counts sum to the matched total. Consent, membership and addresses are read as
// of the time asked. A preview is no send authority and subscribes no one: its identity (previewKey, from what was asked, and
// resultDigest, from who is eligible) is what P8 prepares from and compares.
//
// Who may preview: a Marketing reader who manages audiences, writes sends or dispatches them (design §2 AudiencePreview: A, U, D),
// in the topic's organization (PERMISSION_DENIED, RECORD_UNAVAILABLE). Rows name a person and show the whole address only to an
// audience reader (MARKETING_AUDIENCE_VIEW); anyone else sees counts and rows with the address masked and no name or id. A segment
// whose filter needs a source the caller cannot read is refused before any count (SOURCE_UNAVAILABLE).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const marketingAccess = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingAccess.js")
const suppressions = ec.resource.script("component://mr-mantle/service/mantle/party/MessageSuppressions.js")
const segments = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingSegments.js")
const {find, one, denied} = lib
const {rowsIn} = segments

const LIST = "mantle.marketing.contact.ContactList"
const CLP = "mantle.marketing.contact.ContactListParty"
const POLICY = "mantle.marketing.contact.ContactListPolicy"
const listTypes = ["MARKETING", "NEWSLETTER", "ANNOUNCEMENT"]
const accepted = ["CLPT_ACCEPTED", "CLPT_IN_USE"]
const sourceCap = 20
const buckets = [
    {bucket: "unavailable", label: "Not available", color: "grey-7"},
    {bucket: "destination", label: "No valid address", color: "warning"},
    {bucket: "suppressed", label: "Suppressed", color: "negative"},
    {bucket: "withdrawn", label: "Withdrawn or not subscribed", color: "grey-7"},
    {bucket: "evidence", label: "Needs evidence", color: "warning"},
    {bucket: "duplicate", label: "Duplicate address", color: "grey-7"},
    {bucket: "eligible", label: "Eligible", color: "positive"}
]
const reasonTexts = {
    PARTY_UNAVAILABLE: "Inactive, merged or private",
    MISSING_DESTINATION: "No address of the channel",
    INVALID_DESTINATION: "Not a valid address",
    SUPPRESSED: "Address suppressed",
    NOT_SUBSCRIBED: "Not on the topic list",
    PENDING: "Waiting for confirmation",
    UNSUBSCRIBED: "Unsubscribed",
    LIST_WITHDRAWN: "Withdrew from the list",
    PURPOSE_WITHDRAWN: "Withdrew the purpose",
    SOLICITATION_REFUSED: "Refused solicitation at this address",
    DESTINATION_WITHDRAWN: "Another person at this address withdrew",
    MISSING_EVIDENCE: "Legacy member with no evidence",
    DUPLICATE_DESTINATION: "Same address as another recipient",
    ELIGIBLE: "Eligible"
}
const channelOfList = list => (list.contactMechTypeEnumId === "CmtTelecomNumber" ? "MdcSms" : "MdcEmail")
const channelTexts = {MdcEmail: "Email", MdcSms: "SMS"}

const text = value => (value == null ? "" : String(value).trim())
const blank = value => value == null || value === ""
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const idOrder = (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)
const listOf = value =>
    value == null
        ? []
        : Array.from(
              new Set((typeof value === "string" ? value.split(",") : Array.from(value)).map(item => text(item)).filter(Boolean))
          )
const newestFirst = (a, b) =>
    (lib.ms(b.consentDate) ?? 0) - (lib.ms(a.consentDate) ?? 0) || idOrder(String(b.partyConsentId), String(a.partyConsentId))
const purposeOf = list => {
    const policy =
        Array.from(find(POLICY, {contactListId: list.contactListId}).orderBy("-fromDate").list()).find(row => lib.active(row)) ||
        null
    return policy?.purposeEnumId || (list.contactMechTypeEnumId === "CmtTelecomNumber" ? "PcpSms" : "PcpMarketingEmail")
}
const archivedList = list => list.archivedDate != null && lib.ms(list.archivedDate) <= lib.ms(ec.user.nowTimestamp)

// The text of a phone number and its key (a + and its digits), or null.
function phoneOf(contactMechId) {
    const number = one("mantle.party.contact.TelecomNumber", {contactMechId})
    if (!number) return null
    const shown = [number.countryCode ? "+" + number.countryCode : null, number.areaCode, number.contactNumber]
        .filter(Boolean)
        .join(" ")
    const digits = shown.replace(/\D/g, "")
    return {address: shown, key: digits.length >= 7 ? "+" + digits : null}
}
// The consent state of a purpose for an address in an organization, from a party's rows newest first: withdrawn when its latest
// global row or its latest row of the organization withdraws; granted when not withdrawn and the organization's row (else the global
// one) grants.
function purposeState(consents, purposeEnumId, contactMechId, organizationPartyId) {
    const applies = row =>
        !row.contactListId &&
        row.purposeEnumId === purposeEnumId &&
        (!row.contactMechId || row.contactMechId === contactMechId) &&
        (!row.organizationPartyId || row.organizationPartyId === organizationPartyId)
    const relevant = consents.filter(applies)
    const global = relevant.find(row => !row.organizationPartyId) || null
    const scoped = relevant.find(row => row.organizationPartyId === organizationPartyId) || null
    const withdrawn = global?.statusId === "PconWithdrawn" || scoped?.statusId === "PconWithdrawn"
    return {withdrawn, granted: !withdrawn && (scoped || global)?.statusId === "PconGranted"}
}

// ===== the rule: classify#Recipients =====
// People classified for a topic as of a time: {rows: [{partyId, bucket, reasonCode, contactMechId, address, destinationKey,
// tracked}], counts: {bucket: n}, untrackedEligible}. o: organizationPartyId, list (the topic's row), purposeEnumId, channelEnumId,
// partyIds, asOf. No permission: the caller has checked who asks and for what (preview#Audience here; P8's prepare, P11's admission).
// classifyPeople puts each person of a set in buckets 1 to 5 on their own; settle applies the rules across people (a withdrawal at
// an address, the duplicates) to every person classified, so a send's paged evaluation (evaluateSend) classifies page by page and
// settles once, with the same result as one call over everyone.
function classify(o) {
    const found = classifyPeople(o)
    return summarize(settle(found.people), found)
}
function classifyPeople(o) {
    const org = o.organizationPartyId
    const topic = o.list
    const asOf = o.asOf || ec.user.nowTimestamp
    const asOfMs = lib.ms(asOf)
    const channel = o.channelEnumId || channelOfList(topic)
    const mechType = channel === "MdcSms" ? "CmtTelecomNumber" : "CmtEmailAddress"
    const purposeEnumId = o.purposeEnumId || purposeOf(topic)
    const partyIds = Array.from(new Set(Array.from(o.partyIds || []))).sort(idOrder)
    // P9: the dispatch's recheck runs with no user and gives its own (disabled or merged only: who the preparer could see was settled
    // at preparation)
    const available = o.availableOf ? o.availableOf(partyIds) : segments.inScopeParties(partyIds)
    // the topic's membership in effect at the time, the latest row of each party
    const memberships = new Map()
    for (const row of rowsIn(CLP, "partyId", partyIds, {contactListId: topic.contactListId}, query =>
        query.conditionDate("fromDate", "thruDate", asOf).orderBy("-fromDate")
    ))
        if (!memberships.has(row.partyId)) memberships.set(row.partyId, row)
    // the addresses of the channel in effect at the time
    const addresses = new Map()
    for (const info of rowsIn(
        "mantle.party.contact.PartyContactMechInfo",
        "partyId",
        partyIds,
        {contactMechTypeEnumId: mechType},
        query => query.conditionDate("fromDate", "thruDate", asOf).orderBy("fromDate")
    )) {
        if (!addresses.has(info.partyId)) addresses.set(info.partyId, [])
        addresses.get(info.partyId).push(info)
    }
    const consents = new Map()
    for (const row of rowsIn("mantle.party.PartyConsent", "partyId", partyIds)) {
        if ((lib.ms(row.consentDate) ?? 0) > asOfMs) continue
        if (!consents.has(row.partyId)) consents.set(row.partyId, [])
        consents.get(row.partyId).push(row)
    }
    for (const list of consents.values()) list.sort(newestFirst)
    // each party's destination: the membership's address when it is still theirs, else the primary, else the first
    const preferred = mechType === "CmtTelecomNumber" ? ["PhoneMobile", "PhonePrimary"] : ["EmailPrimary"]
    const people = partyIds.map(partyId => {
        const membership = memberships.get(partyId) || null
        const infos = addresses.get(partyId) || []
        const info =
            infos.find(row => membership?.preferredContactMechId && row.contactMechId === membership.preferredContactMechId) ||
            infos.find(row => preferred.includes(row.contactMechPurposeId)) ||
            infos[0] ||
            null
        let address = null,
            key = null
        if (info) {
            if (mechType === "CmtTelecomNumber") {
                const phone = phoneOf(info.contactMechId)
                address = phone?.address || null
                key = phone?.key || null
            } else {
                address = info.infoString || null
                key = suppressions.normalize("MdcEmail", address)
            }
        }
        return {partyId, membership, info, address, key, consents: consents.get(partyId) || []}
    })
    const blocked = suppressions.suppressedOf(channel, people.map(person => person.key).filter(Boolean), org, false)
    const blockedKeys = new Set(blocked.suppressed)
    // buckets 1 to 5, each person on their own
    for (const person of people) {
        const set = (bucket, reasonCode) => Object.assign(person, {bucket, reasonCode})
        if (!available.has(person.partyId)) {
            set("unavailable", "PARTY_UNAVAILABLE")
            continue
        }
        if (!person.info || !person.address) {
            set("destination", "MISSING_DESTINATION")
            continue
        }
        if (!person.key) {
            set("destination", "INVALID_DESTINATION")
            continue
        }
        if (blockedKeys.has(person.key)) {
            set("suppressed", "SUPPRESSED")
            person.suppressionText = enumText(blocked.reasons[person.key])
            continue
        }
        const listRow = person.consents.find(
            row =>
                row.contactListId === topic.contactListId &&
                (!row.contactMechId || row.contactMechId === person.info.contactMechId)
        )
        const purpose = purposeState(person.consents, purposeEnumId, person.info.contactMechId, org)
        const status = person.membership?.statusId || null
        const withdrawal = purpose.withdrawn
            ? "PURPOSE_WITHDRAWN"
            : listRow?.statusId === "PconWithdrawn"
              ? "LIST_WITHDRAWN"
              : person.info.allowSolicitation === "N"
                ? "SOLICITATION_REFUSED"
                : status && !accepted.includes(status) && status !== "CLPT_PENDING"
                  ? "UNSUBSCRIBED"
                  : null
        person.withdrew = !!withdrawal
        if (withdrawal) {
            set("withdrawn", withdrawal)
            continue
        }
        if (!status) {
            set("withdrawn", "NOT_SUBSCRIBED")
            continue
        }
        if (status === "CLPT_PENDING") {
            set("withdrawn", "PENDING")
            continue
        }
        const listGranted =
            listRow?.statusId === "PconGranted" && (!listRow.purposeEnumId || listRow.purposeEnumId === purposeEnumId)
        if (!listGranted && !purpose.granted) {
            set("evidence", "MISSING_EVIDENCE")
            continue
        }
        person.tracked = purposeState(person.consents, "PcpTracking", person.info.contactMechId, org).granted
        set("eligible", "ELIGIBLE")
    }
    // only what settle and the rows need is kept of each person
    return {
        people: people.map(person => ({
            partyId: person.partyId,
            bucket: person.bucket,
            reasonCode: person.reasonCode,
            withdrew: !!person.withdrew,
            contactMechId: person.info?.contactMechId || null,
            address: person.address,
            key: person.key,
            tracked: !!person.tracked,
            suppressionText: person.suppressionText || ""
        })),
        purposeEnumId,
        channelEnumId: channel
    }
}
// The rules across people, over every person classified (in any order): a withdrawal of anyone at an address blocks it for
// everyone there, ahead of needing evidence (P5 review); then the duplicates, the lowest party id at an address chosen.
function settle(people) {
    people.sort((a, b) => idOrder(a.partyId, b.partyId))
    // 4 again, by destination: a withdrawal of anyone at an address blocks it for everyone there, ahead of needing evidence (P5
    // review); then 6, the duplicates
    const withdrawnKeys = new Set(people.filter(person => person.withdrew && person.key).map(person => person.key))
    const chosen = new Map()
    for (const person of people) {
        if (person.bucket !== "eligible" && person.bucket !== "evidence") continue
        if (withdrawnKeys.has(person.key)) {
            Object.assign(person, {bucket: "withdrawn", reasonCode: "DESTINATION_WITHDRAWN", tracked: false})
            continue
        }
        if (person.bucket !== "eligible") continue
        // people are in party id order, so the first at an address is the lowest id: the one chosen
        if (chosen.has(person.key))
            Object.assign(person, {bucket: "duplicate", reasonCode: "DUPLICATE_DESTINATION", duplicateOf: chosen.get(person.key)})
        else chosen.set(person.key, person.partyId)
    }
    return people
}
function summarize(people, found) {
    const counts = Object.fromEntries(buckets.map(entry => [entry.bucket, 0]))
    const reasons = {}
    let untrackedEligible = 0
    for (const person of people) {
        counts[person.bucket] += 1
        reasons[person.reasonCode] = (reasons[person.reasonCode] || 0) + 1
        if (person.bucket === "eligible" && !person.tracked) untrackedEligible += 1
    }
    return {
        rows: people.map(person => ({
            partyId: person.partyId,
            bucket: person.bucket,
            reasonCode: person.reasonCode,
            contactMechId: person.contactMechId || null,
            address: person.address,
            destinationKey: person.key,
            tracked: person.bucket === "eligible" ? !!person.tracked : false,
            suppressionText: person.suppressionText || "",
            duplicateOf: person.duplicateOf || null
        })),
        counts,
        reasons,
        untrackedEligible,
        purposeEnumId: found.purposeEnumId,
        channelEnumId: found.channelEnumId
    }
}
function classifyRecipients(p) {
    // internal: the caller has checked who asks and the topic
    const list = one(LIST, {contactListId: text(p.contactListId)})
    if (!list || !listTypes.includes(list.contactListTypeEnumId))
        denied("RECORD_UNAVAILABLE", "List " + text(p.contactListId) + " is not available")
    const result = classify({
        organizationPartyId: list.ownerPartyId,
        list,
        purposeEnumId: text(p.purposeEnumId) || null,
        partyIds: listOf(p.partyIdList),
        asOf: blank(p.asOf) ? null : new Date(lib.ms(p.asOf))
    })
    return {recipientList: result.rows, bucketCounts: result.counts, untrackedEligible: result.untrackedEligible}
}

// ===== preview#Audience =====
function previewScope() {
    const userScope = marketingAccess.scope()
    const caps = userScope.capabilities
    if (!caps.anyRead || !(caps.audienceRead || caps.sendEdit || caps.dispatch))
        denied("PERMISSION_DENIED", "Previewing an audience needs Marketing's audience, send or dispatch permission")
    return userScope
}
// A Marketing list of the scope and organization, else RECORD_UNAVAILABLE.
function listOfScope(userScope, contactListId, organizationPartyId) {
    const row = one(LIST, {contactListId})
    if (
        !row ||
        !listTypes.includes(row.contactListTypeEnumId) ||
        !marketingAccess.covers(userScope, row.ownerPartyId) ||
        (organizationPartyId && row.ownerPartyId !== organizationPartyId)
    )
        denied("RECORD_UNAVAILABLE", "List " + contactListId + " is not available")
    return row
}
function segmentOf(userScope, marketSegmentId, organizationPartyId) {
    const row = segments.segmentOfScope(userScope, marketSegmentId)
    if (row.ownerPartyId !== organizationPartyId) denied("RECORD_UNAVAILABLE", "Segment " + marketSegmentId + " is not available")
    if (segments.archived(row)) denied("SEGMENT_ARCHIVED", "Segment " + segments.segmentLabel(row) + " is archived")
    return row
}
// The members of a list in effect at the time, every state (the buckets tell them apart); a list past the cap is refused, never cut
// short, so an exclusion list is applied whole (P5 review).
const listMembers = (list, asOf) =>
    segments
        .bounded(
            find(CLP, {contactListId: list.contactListId})
                .conditionDate("fromDate", "thruDate", asOf)
                .selectField("partyId")
                .distinct(true)
                .limit(segments.universeCap + 1)
                .list(),
            "List " + (list.contactListName || list.contactListId)
        )
        .map(row => row.partyId)
function previewAudience(p) {
    const userScope = previewScope()
    const caps = userScope.capabilities
    const topic = listOfScope(userScope, text(p.topicListId), null)
    if (archivedList(topic)) denied("LIST_ARCHIVED", "List " + (topic.contactListName || topic.contactListId) + " is archived")
    const org = topic.ownerPartyId
    const channel = channelOfList(topic)
    if (text(p.channelEnumId) && text(p.channelEnumId) !== channel)
        denied(
            "CHANNEL_MISMATCH",
            "The topic " + (topic.contactListName || topic.contactListId) + " is a list of " + channelTexts[channel]
        )
    const purposeEnumId = text(p.purposeEnumId) || purposeOf(topic)
    if (!one("moqui.basic.Enumeration", {enumId: purposeEnumId, enumTypeId: "PartyConsentPurpose"}))
        denied("PURPOSE_INVALID", "Unknown consent purpose " + purposeEnumId)
    const asOf = blank(p.asOf) ? ec.user.nowTimestamp : new Date(lib.ms(p.asOf))
    if (!Number.isFinite(lib.ms(asOf))) denied("DATE_INVALID", "The time of the preview is a date")
    const listIds = listOf(p.listIds)
    const segmentIds = listOf(p.segmentIds)
    const excludeListIds = listOf(p.excludeListIds)
    const excludeSegmentIds = listOf(p.excludeSegmentIds)
    if (listIds.length + segmentIds.length + excludeListIds.length + excludeSegmentIds.length > sourceCap)
        denied("TOO_MANY_SOURCES", "A preview takes at most " + sourceCap + " lists and segments")
    if (!listIds.length && !segmentIds.length) listIds.push(topic.contactListId)
    // every source checked before anything is counted: the organization's lists and segments, each readable
    const lists = listIds.map(id => listOfScope(userScope, id, org))
    const segmentRows = segmentIds.map(id => segmentOf(userScope, id, org))
    const excludeLists = excludeListIds.map(id => listOfScope(userScope, id, org))
    const excludeSegments = excludeSegmentIds.map(id => segmentOf(userScope, id, org))
    const ctx = segments.context(userScope, org, asOf)
    const sourcesOf = new Map()
    const add = (partyId, label) => {
        if (!sourcesOf.has(partyId)) sourcesOf.set(partyId, [])
        if (!sourcesOf.get(partyId).includes(label)) sourcesOf.get(partyId).push(label)
    }
    let memberships = 0
    for (const list of lists)
        for (const partyId of listMembers(list, asOf)) {
            memberships += 1
            add(partyId, list.contactListName || list.contactListId)
        }
    for (const segment of segmentRows)
        for (const partyId of segments.matchesOf(ctx, segment)) {
            memberships += 1
            add(partyId, segments.segmentLabel(segment))
        }
    const excluded = new Set()
    for (const list of excludeLists) for (const partyId of listMembers(list, asOf)) excluded.add(partyId)
    for (const segment of excludeSegments) for (const partyId of segments.matchesOf(ctx, segment)) excluded.add(partyId)
    let excludedCount = 0
    for (const partyId of excluded) if (sourcesOf.delete(partyId)) excludedCount += 1
    if (sourcesOf.size > segments.universeCap)
        denied("AUDIENCE_TOO_LARGE", "The audience is larger than " + segments.universeCap + " people; narrow it")
    const result = classify({
        organizationPartyId: org,
        list: topic,
        purposeEnumId,
        channelEnumId: channel,
        partyIds: Array.from(sourcesOf.keys()),
        asOf
    })
    // the rows: names and addresses for an audience reader; for anyone else the address masked and no name or party
    const order = Object.fromEntries(buckets.map((entry, index) => [entry.bucket, index]))
    const shown = text(p.bucket)
    const all = result.rows
        .filter(row => !shown || row.bucket === shown)
        .sort((a, b) => order[a.bucket] - order[b.bucket] || idOrder(a.partyId, b.partyId))
    const paged = lib.pageList(all, p, "recipientList")
    const names = caps.audienceRead ? lib.partyNames(paged.recipientList.map(row => row.partyId)) : {}
    const bucketOf = Object.fromEntries(buckets.map(entry => [entry.bucket, entry]))
    // a person the caller may not see (another user's personal contact, an inactive party) is a count and a reason only
    paged.recipientList = paged.recipientList.map((row, index) => {
        const named = caps.audienceRead && row.bucket !== "unavailable"
        return {
            rowKey: named ? row.partyId : "R" + (paged.recipientListPageIndex * paged.recipientListPageSize + index + 1),
            partyId: named ? row.partyId : null,
            partyName: named ? names[row.partyId] || row.partyId : "",
            addressText:
                row.address && row.bucket !== "unavailable" ? (named ? row.address : suppressions.mask(row.address)) : "",
            bucket: row.bucket,
            bucketText: bucketOf[row.bucket].label,
            bucketColor: bucketOf[row.bucket].color,
            reasonCode: row.reasonCode,
            reasonText: reasonTexts[row.reasonCode] + (row.suppressionText ? ": " + row.suppressionText : ""),
            trackingText: row.bucket === "eligible" ? (row.tracked ? "Tracked" : "Untracked") : "",
            sourcesText: (sourcesOf.get(row.partyId) || []).join(", ")
        }
    })
    const matched = result.rows.length
    const request = {
        organizationPartyId: org,
        topicListId: topic.contactListId,
        listIds: listIds.slice().sort(),
        segmentIds: segmentIds.slice().sort(),
        excludeListIds: excludeListIds.slice().sort(),
        excludeSegmentIds: excludeSegmentIds.slice().sort(),
        channelEnumId: channel,
        purposeEnumId,
        asOf: lib.ms(asOf)
    }
    const eligibleRows = result.rows.filter(row => row.bucket === "eligible")
    return Object.assign(paged, {
        topic: {
            contactListId: topic.contactListId,
            contactListName: topic.contactListName || topic.contactListId,
            organizationPartyId: org,
            organizationName: one("mantle.party.Organization", {partyId: org})?.organizationName || org
        },
        channelEnumId: channel,
        channelText: channelTexts[channel],
        purposeEnumId,
        purposeText: enumText(purposeEnumId),
        asOf,
        asOfText: lib.dateText(asOf),
        matchedCount: matched,
        membershipCount: memberships,
        excludedCount,
        eligibleCount: result.counts.eligible,
        untrackedEligibleCount: result.untrackedEligible,
        bucketList: buckets.map(entry => Object.assign({count: result.counts[entry.bucket]}, entry)),
        reasonList: Object.entries(result.reasons)
            .map(([reasonCode, count]) => ({reasonCode, reasonText: reasonTexts[reasonCode], count}))
            .sort((a, b) => b.count - a.count),
        addressesShown: !!caps.audienceRead,
        previewKey: lib.hash(request),
        // by the address's record, not its text: the digest is an unkeyed hash an author holds, and must not confirm a guessed
        // address (an address changed is a new contact mech, so the digest still moves with it; P5 review)
        resultDigest: digestOf(eligibleRows)
    })
}

// ===== a send's audience, in pages (P8; the user's call of Nov 14) =====
// The 5,000-person cap stays for an interactive evaluation and preview; a send's audience is evaluated in pages over the universe
// narrowed to its topic's members (only an accepted member of the topic is ever eligible): each page of members, in party id order,
// is matched against the send's lists and segments (a segment over that page only: a party's match does not depend on who else is
// evaluated) less its exclusions, and classified; the rules across people are settled once over every page. A person of the
// selection who is not on the topic is never eligible, so is read only when they hold an address a page may send to (their
// withdrawal blocks it, as in the preview: P8 review). The eligible people are those a preview of the same audience finds eligible,
// with the same resultDigest; the counts are of the topic's members and those sharers (the other people of a source who are not
// members, whom a preview counts as not subscribed, are not read). o: userScope, topic (the list
// row), purposeEnumId, lists, segments, excludeLists, excludeSegments (rows the caller checked), asOf, pageSize (500; at most
// 1,000). {rows: the eligible, in party id order, counts, untrackedEligible, matchedCount, resultDigest, pages}.
function evaluateSend(o) {
    const topic = o.topic
    const org = topic.ownerPartyId
    const asOf = o.asOf || ec.user.nowTimestamp
    const pageSize = Math.max(1, Math.min(1000, Number(o.pageSize) || 500))
    const channel = channelOfList(topic)
    const purposeEnumId = o.purposeEnumId || purposeOf(topic)
    const listIds = (o.lists || []).map(list => list.contactListId)
    const excludeListIds = (o.excludeLists || []).map(list => list.contactListId)
    const onTopicOnly = !listIds.length && !(o.segments || []).length
    // a segment's own refusals (a source the caller cannot read, a cycle) before any page is counted
    for (const segment of (o.segments || []).concat(o.excludeSegments || []))
        segments.matchesOf(segments.context(o.userScope, org, asOf, []), segment)
    const memberOf = (ids, partyIds) =>
        ids.length
            ? new Set(
                  rowsIn(CLP, "partyId", partyIds, {}, query =>
                      query.condition("contactListId", "in", ids).conditionDate("fromDate", "thruDate", asOf)
                  ).map(row => row.partyId)
              )
            : new Set()
    const classifyOf = partyIds =>
        classifyPeople({organizationPartyId: org, list: topic, purposeEnumId, channelEnumId: channel, partyIds, asOf}).people
    // The people not on the topic who hold one of the addresses (key -> a contact mech of it) and are in the selection (a source
    // list's member or a segment's match, less the exclusions), each once, classified: they are never eligible (not subscribed or
    // withdrawn), and settle blocks an address one of them withdrew at. An email address is matched by its text in any case.
    const sharersSeen = new Set()
    const sharersOf = keys => {
        if (onTopicOnly) return []
        const factory = ec.entity.conditionFactory
        const candidates = new Set()
        const entries = Array.from(keys.entries())
        for (let start = 0; start < entries.length; start += 200) {
            const batch = entries.slice(start, start + 200)
            const byAddress =
                channel === "MdcEmail"
                    ? batch.map(([key]) => factory.makeCondition("infoString", "equals", key).ignoreCase())
                    : []
            const byMech = batch.map(([, contactMechId]) => contactMechId).filter(Boolean)
            if (byMech.length) byAddress.push(factory.makeCondition("contactMechId", "in", byMech))
            if (!byAddress.length) continue
            for (const info of Array.from(
                find("mantle.party.contact.PartyContactMechInfo")
                    .condition("contactMechTypeEnumId", channel === "MdcSms" ? "CmtTelecomNumber" : "CmtEmailAddress")
                    .condition(factory.makeCondition(byAddress, "or"))
                    .conditionDate("fromDate", "thruDate", asOf)
                    .selectField("partyId")
                    .list()
            ))
                if (!sharersSeen.has(info.partyId)) candidates.add(info.partyId)
        }
        if (!candidates.size) return []
        // a member of the topic (in any state) is classified in its own page
        for (const partyId of memberOf([topic.contactListId], Array.from(candidates))) candidates.delete(partyId)
        for (const partyId of candidates) sharersSeen.add(partyId)
        if (!candidates.size) return []
        const ids = Array.from(candidates)
        const ctx = segments.context(o.userScope, org, asOf, ids)
        const included = memberOf(listIds, ids)
        for (const segment of o.segments || []) for (const partyId of segments.matchesOf(ctx, segment)) included.add(partyId)
        for (const partyId of memberOf(excludeListIds, ids)) included.delete(partyId)
        for (const segment of o.excludeSegments || [])
            for (const partyId of segments.matchesOf(ctx, segment)) included.delete(partyId)
        return included.size ? classifyOf(Array.from(included)) : []
    }
    const people = []
    let lastPartyId = null,
        pages = 0
    for (;;) {
        let query = find(CLP, {contactListId: topic.contactListId})
            .conditionDate("fromDate", "thruDate", asOf)
            .selectField("partyId")
            .distinct(true)
            .orderBy("partyId")
            .limit(pageSize)
        if (lastPartyId != null) query = query.condition("partyId", "greater", lastPartyId)
        const page = Array.from(query.list()).map(row => row.partyId)
        if (!page.length) break
        pages += 1
        lastPartyId = page[page.length - 1]
        const ctx = segments.context(o.userScope, org, asOf, page)
        let included
        if (onTopicOnly) included = new Set(page)
        else {
            included = memberOf(listIds, page)
            for (const segment of o.segments || []) for (const partyId of segments.matchesOf(ctx, segment)) included.add(partyId)
        }
        for (const partyId of memberOf(excludeListIds, page)) included.delete(partyId)
        for (const segment of o.excludeSegments || [])
            for (const partyId of segments.matchesOf(ctx, segment)) included.delete(partyId)
        if (included.size) {
            const found = classifyOf(Array.from(included))
            people.push(...found)
            // the people of the selection who are not on the topic at the addresses this page may send to (P8 review): a
            // withdrawal of theirs blocks the address as the preview's does (F147, F155: anyone matched at the address)
            const keys = new Map()
            for (const person of found)
                if ((person.bucket === "eligible" || person.bucket === "evidence") && person.key)
                    keys.set(person.key, person.contactMechId)
            if (keys.size) people.push(...sharersOf(keys))
        }
        if (page.length < pageSize) break
    }
    const result = summarize(settle(people), {purposeEnumId, channelEnumId: channel})
    const eligibleRows = result.rows.filter(row => row.bucket === "eligible")
    return {
        rows: eligibleRows,
        counts: result.counts,
        untrackedEligible: result.untrackedEligible,
        matchedCount: result.rows.length,
        resultDigest: digestOf(eligibleRows),
        purposeEnumId,
        channelEnumId: channel,
        pages
    }
}
// The digest of who is eligible: by the address's record, not its text (P5 review).
const digestOf = eligibleRows => lib.hash(eligibleRows.map(row => [row.partyId, row.contactMechId, row.tracked]))

// ===== count#Audience (P20 review; the user's call of Nov 15: Assist's aggregate-only audience tool) =====
// preview#Audience's counts alone, for an audience reader (MARKETING_AUDIENCE_VIEW) of the topic's organization: the matched,
// membership, excluded and eligible counts, each bucket and reason with its count; never a name, an address, a party id, the rows or
// the preview's digests. Counts are shown as they are: the reader may open the same people in Audience preview.
function countAudience(p) {
    const userScope = marketingAccess.scope()
    if (!userScope.capabilities.anyRead || !userScope.capabilities.audienceRead)
        denied("PERMISSION_DENIED", "Counting an audience needs Marketing's audience permission")
    const found = previewAudience(Object.assign({}, p, {bucket: null, pageIndex: 0, pageSize: 1}))
    return {
        topic: found.topic,
        channelText: found.channelText,
        purposeText: found.purposeText,
        asOfText: found.asOfText,
        matchedCount: found.matchedCount,
        membershipCount: found.membershipCount,
        excludedCount: found.excludedCount,
        eligibleCount: found.eligibleCount,
        untrackedEligibleCount: found.untrackedEligibleCount,
        bucketList: found.bucketList.map(entry => ({bucket: entry.bucket, label: entry.label, count: entry.count})),
        reasonList: found.reasonList.map(entry => ({reasonCode: entry.reasonCode, reasonText: entry.reasonText, count: entry.count}))
    }
}
const operations = {previewAudience, classifyRecipients, countAudience}
;({
    buckets,
    reasonTexts,
    // P15: a purpose's state from a party's consents (tracking consent when an event comes, MarketingTracking.js)
    purposeState,
    classify,
    classifyPeople,
    evaluateSend,
    purposeOf,
    channelOfList,
    listTypes,
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown eligibility operation " + op)
        return operations[op](parameters || {})
    }
})
