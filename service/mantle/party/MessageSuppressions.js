/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * Comms' suppressions (mantle.party.MessageServices find#Suppressions, store#Suppression, check#Suppressions; design-marketing §4
 * Suppressions, §14.1 MessageSuppression; impl-marketing P3, F13, F16; an owner contract written into design-drawers-commons): a
 * destination of a channel that no delivery of the ledger may reach, for every organization or one, apart from list membership and
 * consent.
 *
 * - A destination is kept normalized (an email address trimmed and in lower case), so a block holds however the address is typed.
 * - Who reads: a holder of MESSAGE_SUPPRESSION_REVIEW or CONTACT_ADMIN every block; a Marketing audience reader
 *   (MARKETING_AUDIENCE_VIEW) or configurer (MARKETING_CONFIGURE) the blocks of every organization and of the organizations of their
 *   Marketing scope. The address is shown to a reviewer, a contact administrator and an audience reader; anyone else sees it
 *   masked. Another organization's block is left out, so its reasons and sources are not told.
 * - Who adds: a reviewer or contact administrator any block; a Marketing audience editor (MARKETING_AUDIENCE_EDIT) a block of an
 *   organization of their scope; a run with no user (the bounce intake, P6) any. Evidence is required; an active block of the same
 *   destination, organization and reason is answered, never doubled.
 * - Who ends: a holder of MESSAGE_SUPPRESSION_REVIEW alone, with new evidence; the row stays, with its source and the reviewer's
 *   evidence. A subscription never ends one.
 * - What a block stops (the user's call, Nov 14): a hard bounce every delivery to the address; any other reason (a complaint, a
 *   staff block, repeated soft failures) promotional deliveries only (a list's, a campaign's, a topic's: the ledger's deliveries
 *   that are not transactional), never a transactional notice (an order's confirmation, a password reset, a system notice).
 * - check: the active blocks of destinations for an organization (its own and every organization's), of every delivery or, for a
 *   transactional one, those that stop every delivery; for the ledger's attempt and the audience services; no permission
 *   (internal).
 * Refusals carry reason codes (EntityLib.js denied): PERMISSION_DENIED, ORGANIZATION_DENIED, RECORD_UNAVAILABLE,
 * EVIDENCE_REQUIRED, DESTINATION_INVALID.
 */
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const marketingAccess = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingAccess.js")
const {find, one, denied, call} = lib
const access = lib.access
const S = "mantle.party.MessageSuppression"
// P22: a text message's number too, kept in E.164 (+ and its digits)
const channels = {MdcEmail: "Email", MdcSms: "Text message"}
// the reasons that stop every delivery, transactional notices too (the user's call, Nov 14); any other stops promotional ones only
const blocksEveryDelivery = ["MsrHardBounce"]
const text = value => (value == null ? "" : String(value).trim())

// The normalized destination of a channel, or null when it is not one.
function normalize(channelEnumId, destination) {
    const value = text(destination).toLowerCase()
    if (!value) return null
    if ((channelEnumId || "MdcEmail") === "MdcEmail") return /^[^\s@]+@[^\s@]+$/.test(value) ? value : null
    // P22: a phone number written with its country code (+1 555 123 4567), kept as + and its digits
    if (channelEnumId === "MdcSms") {
        const number = value.replace(/[\s().-]/g, "")
        return /^\+[1-9]\d{6,14}$/.test(number) ? number : null
    }
    return value
}
// An address shown masked: its first character and its domain.
function mask(destination) {
    const value = text(destination)
    const at = value.indexOf("@")
    if (at < 1) return value ? value[0] + "***" : ""
    return value[0] + "***" + value.slice(at)
}
const isReviewer = () => access.has("MESSAGE_SUPPRESSION_REVIEW")
const isContactAdmin = () => access.has("CONTACT_ADMIN")
// What the caller may do: every organization's blocks (all), the organizations of their Marketing scope otherwise, whether they
// read, add and end, and whether they see the address.
function scopeOf() {
    const all = !ec.user.userId || isReviewer() || isContactAdmin() || access.systemAdmin()
    const marketing = all ? null : marketingAccess.scope()
    const caps = marketing?.capabilities || {}
    const read = all || !!(caps.audienceView || caps.configure)
    return {
        all,
        read,
        add: all || !!caps.audienceEdit,
        end: !ec.user.userId || isReviewer(),
        unmasked: all || !!caps.audienceView,
        organizationPartyIds: all ? null : read ? marketingAccess.organizationIds(marketing) : [],
        marketing
    }
}
const covers = (scope, organizationPartyId) =>
    scope.all || !organizationPartyId || scope.organizationPartyIds.includes(organizationPartyId)
const active = (row, at = ec.user.nowTimestamp) => lib.active(row, at)
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const organizationName = partyId => (partyId ? one("mantle.party.Organization", {partyId})?.organizationName || partyId : "")

function display(row, scope) {
    const isActive = active(row)
    return {
        suppressionId: row.suppressionId,
        channelEnumId: row.channelEnumId,
        channelText: channels[row.channelEnumId] || enumText(row.channelEnumId),
        destinationText: scope.unmasked ? row.destinationKey : mask(row.destinationKey),
        organizationPartyId: row.organizationPartyId || null,
        organizationText: row.organizationPartyId ? organizationName(row.organizationPartyId) : "Every organization",
        reasonEnumId: row.reasonEnumId,
        reasonText: enumText(row.reasonEnumId),
        sourceEnumId: row.sourceEnumId,
        sourceText: enumText(row.sourceEnumId),
        sourceRef: scope.unmasked ? row.sourceRef || null : null,
        evidenceText: row.evidenceText || "",
        fromDate: row.fromDate,
        fromText: lib.dateText(row.fromDate),
        thruText: lib.dateText(row.thruDate),
        endEvidenceText: row.endEvidenceText || "",
        active: isActive,
        stateText: isActive ? "Active" : "Ended",
        stateColor: isActive ? "negative" : "grey-7",
        canEnd: scope.end && isActive
    }
}

// find#Suppressions: the blocks the caller may read, filtered in the query, newest first, a page at a time.
function findSuppressions(p) {
    const scope = scopeOf()
    if (!scope.read) denied("PERMISSION_DENIED", "Reading suppressions needs the audience or suppression review permission")
    const factory = ec.entity.conditionFactory
    let query = find(S).orderBy("-fromDate").orderBy("-suppressionId")
    if (!scope.all) {
        const ids = scope.organizationPartyIds
        query = query.condition(
            factory.makeCondition(
                [factory.makeCondition("organizationPartyId", "equals", null)].concat(
                    ids.length ? [factory.makeCondition("organizationPartyId", "in", ids)] : []
                ),
                "or"
            )
        )
    }
    if (text(p.organizationPartyId)) {
        if (!covers(scope, p.organizationPartyId)) denied("ORGANIZATION_DENIED", "That organization is not available")
        query = query.condition("organizationPartyId", p.organizationPartyId)
    }
    if (text(p.channelEnumId)) query = query.condition("channelEnumId", p.channelEnumId)
    if (text(p.reasonEnumId)) query = query.condition("reasonEnumId", p.reasonEnumId)
    // the destination searched only by a reader who sees it, so a masked reader cannot find an address by guessing
    if (text(p.text) && scope.unmasked)
        query = query.condition(
            factory.makeCondition("destinationKey", "like", "%" + text(p.text).toLowerCase() + "%").ignoreCase()
        )
    const state = text(p.state) || "active"
    const now = ec.user.nowTimestamp
    if (state === "active")
        query = query
            .condition(factory.makeCondition("fromDate", "less-equals", now))
            .condition(
                factory.makeCondition(
                    [factory.makeCondition("thruDate", "equals", null), factory.makeCondition("thruDate", "greater", now)],
                    "or"
                )
            )
    else if (state === "ended") query = query.condition(factory.makeCondition("thruDate", "less-equals", now))
    const count = query.count()
    const found = lib.page(query, p, "suppressionList", count)
    found.suppressionList = found.rows.map(row => display(row, scope))
    // the organizations a block may be added for: every internal one for a reviewer or administrator, the scope's otherwise
    const organizationIds = scope.all
        ? Array.from(find("mantle.party.PartyRole", {roleTypeId: "OrgInternal"}).selectField("partyId").limit(100).list()).map(
              row => row.partyId
          )
        : scope.organizationPartyIds
    const organizationOptions = (scope.add ? organizationIds : []).map(partyId => ({
        value: partyId,
        label: organizationName(partyId)
    }))
    return Object.assign(found, {
        canAdd: scope.add,
        canEnd: scope.end,
        unmasked: scope.unmasked,
        everyOrganization: scope.all,
        organizationOptions
    })
}

// store#Suppression: add a block with its evidence, or end one (MESSAGE_SUPPRESSION_REVIEW, new evidence).
function storeSuppression(p) {
    const scope = scopeOf()
    const action = text(p.action) || "add"
    if (action === "end") {
        if (!scope.end) denied("PERMISSION_DENIED", "Ending a suppression needs MESSAGE_SUPPRESSION_REVIEW")
        const row = find(S, {suppressionId: text(p.suppressionId)})
            .forUpdate(true)
            .one()
        if (!row) denied("RECORD_UNAVAILABLE", "Suppression " + text(p.suppressionId) + " is not available")
        if (!active(row)) denied("ALREADY_ENDED", "Suppression " + row.suppressionId + " has ended")
        if (!text(p.evidenceText)) denied("EVIDENCE_REQUIRED", "Give the new evidence that ends this suppression")
        call("update#" + S, {
            suppressionId: row.suppressionId,
            thruDate: ec.user.nowTimestamp,
            endedByUserId: ec.user.userId || null,
            endEvidenceText: text(p.evidenceText)
        })
        return {suppressionId: row.suppressionId, created: false, ended: true}
    }
    if (action !== "add") throw new Error("Choose add or end")
    if (!scope.add) denied("PERMISSION_DENIED", "Adding a suppression needs the audience edit or suppression review permission")
    const channelEnumId = text(p.channelEnumId) || "MdcEmail"
    if (!channels[channelEnumId]) denied("CHANNEL_INVALID", "Suppressions are kept for email and text messages")
    const destinationKey = normalize(channelEnumId, p.destination)
    if (!destinationKey)
        denied(
            "DESTINATION_INVALID",
            channelEnumId === "MdcSms"
                ? "Give the phone number with its country code, as +15551234567"
                : "Give the email address to suppress"
        )
    const organizationPartyId = text(p.organizationPartyId) || null
    // a Marketing editor blocks for an organization of their scope; every organization's block is a reviewer's or administrator's
    if (!scope.all) {
        if (!organizationPartyId) denied("ORGANIZATION_DENIED", "Choose the organization the suppression is for")
        if (!covers(scope, organizationPartyId)) denied("ORGANIZATION_DENIED", "That organization is not available")
    }
    if (!text(p.evidenceText)) denied("EVIDENCE_REQUIRED", "Give the evidence of the suppression")
    const reasonEnumId = text(p.reasonEnumId) || "MsrStaff"
    const sourceEnumId = text(p.sourceEnumId) || (ec.user.userId ? "MssStaff" : "MssReport")
    for (const [enumId, type] of [
        [reasonEnumId, "MessageSuppressionReason"],
        [sourceEnumId, "MessageSuppressionSource"]
    ])
        if (!one("moqui.basic.Enumeration", {enumId, enumTypeId: type})) denied("VALUE_INVALID", "Unknown " + type + " " + enumId)
    return addBlock({
        channelEnumId,
        destinationKey,
        organizationPartyId,
        reasonEnumId,
        sourceEnumId,
        sourceRef: text(p.sourceRef).slice(0, 255) || null,
        evidenceText: text(p.evidenceText),
        // a block's own dates are a reviewer's or the intake's: anyone else's starts now and lasts until a reviewer ends it
        fromDate: (scope.end && p.fromDate) || ec.user.nowTimestamp,
        thruDate: (scope.end && p.thruDate) || null,
        createdByUserId: ec.user.userId || null
    })
}
// A block made, or the active one of the same destination, organization and reason answered (never doubled).
function addBlock(values) {
    const {channelEnumId, destinationKey, reasonEnumId, organizationPartyId} = values
    const existing = Array.from(find(S, {channelEnumId, destinationKey, reasonEnumId, organizationPartyId}).list()).find(row =>
        active(row)
    )
    if (existing) return {suppressionId: existing.suppressionId, created: false, ended: false}
    const made = call("create#" + S, values)
    return {suppressionId: made.suppressionId, created: true, ended: false}
}
// The bounce intake's block (impl-marketing P6, MessageDeliveryReports.js): internal, whoever's run it is (a report read in a
// user's session too), from a delivery or abuse report, starting now; never doubled.
function addFromIntake(p) {
    const channelEnumId = text(p.channelEnumId) || "MdcEmail"
    const destinationKey = normalize(channelEnumId, p.destination)
    if (!destinationKey) return null
    return addBlock({
        channelEnumId,
        destinationKey,
        organizationPartyId: text(p.organizationPartyId) || null,
        reasonEnumId: text(p.reasonEnumId) || "MsrHardBounce",
        // P22: a STOP reply's source (MssSmsReply), else a delivery or abuse report
        sourceEnumId: text(p.sourceEnumId) || "MssReport",
        sourceRef: text(p.sourceRef).slice(0, 255) || null,
        evidenceText: text(p.evidenceText) || "Delivery report",
        fromDate: ec.user.nowTimestamp,
        thruDate: null,
        createdByUserId: null
    })
}

// The active blocks of destinations for an organization (its own and every organization's): {suppressed: [destinationKey],
// reasons: {destinationKey: reasonEnumId}}. For a transactional delivery only the blocks that stop every delivery (a hard bounce).
function suppressedOf(channelEnumId, destinations, organizationPartyId, transactional = false) {
    const keys = Array.from(
        new Set(
            Array.from(destinations || [])
                .map(value => normalize(channelEnumId, value))
                .filter(Boolean)
        )
    )
    if (!keys.length) return {suppressed: [], reasons: {}}
    const reasons = {}
    for (const row of find(S)
        .condition("channelEnumId", channelEnumId || "MdcEmail")
        .condition("destinationKey", "in", keys)
        .list()) {
        if (!active(row)) continue
        if (row.organizationPartyId && row.organizationPartyId !== organizationPartyId) continue
        if (transactional && !blocksEveryDelivery.includes(row.reasonEnumId)) continue
        if (!reasons[row.destinationKey]) reasons[row.destinationKey] = row.reasonEnumId
    }
    return {suppressed: Object.keys(reasons), reasons}
}
function checkSuppressions(p) {
    return suppressedOf(
        text(p.channelEnumId) || "MdcEmail",
        p.destinationList,
        text(p.organizationPartyId) || null,
        p.transactional === true || p.transactional === "true" || p.transactional === "Y"
    )
}

const operations = {find: findSuppressions, store: storeSuppression, check: checkSuppressions}
;({
    normalize,
    mask,
    suppressedOf,
    blocksEveryDelivery,
    addFromIntake,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown suppression operation " + op)
        return operations[op](parameters || {})
    }
})
