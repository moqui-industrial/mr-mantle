// Marketing's list merge (mantle.marketing.AudienceServices preview#ListMerge, merge#Lists; IronStone Marketing design §4
// AudienceMerge; impl-marketing P4): the members of source lists consolidated into a target list of the same organization and
// channel, as membership links only. It is never a party merge (the parties stay as they are; Mantle's merge#Parties and its guards
// are Customer360's, P19).
//
// - Who: MARKETING_AUDIENCE_EDIT and the lists' organization; carrying an acceptance needs MARKETING_CONSENT_EDIT too, as
//   request#Subscriptions: without it every carried member waits for confirmation on the target.
// - What is carried, each through request#Subscriptions' own filing (a SubscriptionRequest of kind List merge whose source record is
//   the source list, decided when applied): a member accepted on a source list of the target's purpose, with a grant of that list
//   as its evidence, is accepted on the target with that grant's evidence and date; a source of another purpose, a legacy member
//   with no evidence, or a pending one is filed pending (target-list consent is asked for on its own; evidence of another topic is
//   not a grant). Nothing pending or withdrawn is promoted: a member withdrawn from any source, or from the target, is not carried,
//   and a withdrawal later than the carried evidence is refused WITHDRAWN when applied (later withdrawals win over the preview).
// - The source rows are kept, so sends and attribution keep their lists; the sources are archived only when asked.
// - The preview has a key (the lists' and their memberships' stamps); merge#Lists names it and is refused STALE_PREVIEW when the
//   lists changed, and its operation key answers a retry with the first result.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const suppressions = ec.resource.script("component://mr-mantle/service/mantle/party/MessageSuppressions.js")
const audiences = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingAudiences.js")
const {find, one, denied} = lib
const audience = audiences.audience

const CLP = "mantle.marketing.contact.ContactListParty"
const CONSENT = "mantle.party.PartyConsent"
const subscribed = ["CLPT_ACCEPTED", "CLPT_IN_USE"]
const withdrawnStates = ["CLPT_UNSUBSCRIBED", "CLPT_UNSUBS_PENDING"]
const maxSources = 10
const maxMembers = 2000
const decisionTexts = {
    accepted: "Accepted with the source's evidence",
    pending: "Pending confirmation on the target",
    existing: "Already on the target",
    kept: "Unsubscribed from the target: not carried",
    conflict: "Withdrawn from a source: not carried",
    skipped: "Not carried"
}

const text = value => (value == null ? "" : String(value).trim())
const yes = value => value === true || value === "true" || value === "Y"
const listOf = value =>
    value == null
        ? []
        : (typeof value === "string" ? value.split(",") : Array.from(value)).map(item => text(item)).filter(Boolean)
const currentRows = contactListId =>
    Array.from(find(CLP, {contactListId}).conditionDate("fromDate", "thruDate", ec.user.nowTimestamp).orderBy("-fromDate").list())

// The target and sources of the scope, of one organization and channel, else refused.
function listsOf(userScope, p) {
    const target = audience.listOfScope(userScope, p.contactListId)
    audience.requireOpen(target)
    const sourceIds = [...new Set(listOf(p.sourceListIdList))]
    if (!sourceIds.length)
        denied("SOURCES_REQUIRED", "Choose the lists to merge into " + (target.contactListName || target.contactListId))
    if (sourceIds.length > maxSources) denied("TOO_MANY_SOURCES", "Merge at most " + maxSources + " lists at a time")
    const sources = sourceIds.map(id => {
        if (id === target.contactListId) denied("SOURCE_IS_TARGET", "A list is not merged into itself")
        const source = audience.listOfScope(userScope, id)
        if (source.ownerPartyId !== target.ownerPartyId)
            denied("LIST_MISMATCH", "Lists of one organization are merged: " + (source.contactListName || id) + " is another's")
        if ((source.contactMechTypeEnumId || "CmtEmailAddress") !== (target.contactMechTypeEnumId || "CmtEmailAddress"))
            denied("LIST_MISMATCH", "Lists of one channel are merged: " + (source.contactListName || id) + " is another's")
        return source
    })
    return {target, sources}
}
// The stamps a preview is keyed by: each list's revision, its membership rows' count and their latest change.
function fingerprint(lists) {
    return lists.map(list => {
        const memberRows = Array.from(find(CLP, {contactListId: list.contactListId}).list())
        return [
            list.contactListId,
            lib.ms(list.lastUpdatedStamp),
            memberRows.length,
            Math.max(0, ...memberRows.map(row => lib.ms(row.lastUpdatedStamp) || 0))
        ]
    })
}
// The latest grant of a source list's consent for the party, when no withdrawal of it is later.
function sourceGrant(consents, contactListId) {
    const ofList = consents
        .filter(row => row.contactListId === contactListId)
        .sort((a, b) => (lib.ms(b.consentDate) ?? 0) - (lib.ms(a.consentDate) ?? 0))
    return ofList[0]?.statusId === "PconGranted" ? ofList[0] : null
}
// Every member's decision, deterministic by party.
function decide(userScope, target, sources) {
    const targetPolicy = audience.currentPolicy(target.contactListId)
    const targetPurpose = audience.purposeOf(target, targetPolicy)
    const targetRows = new Map()
    for (const row of currentRows(target.contactListId)) if (!targetRows.has(row.partyId)) targetRows.set(row.partyId, row)
    const byParty = new Map()
    for (const source of sources) {
        const samePurpose = audience.purposeOf(source, audience.currentPolicy(source.contactListId)) === targetPurpose
        for (const row of currentRows(source.contactListId)) {
            if (!byParty.has(row.partyId)) byParty.set(row.partyId, [])
            const states = byParty.get(row.partyId)
            if (!states.some(state => state.source.contactListId === source.contactListId))
                states.push({source, row, samePurpose})
        }
    }
    if (byParty.size > maxMembers) denied("MERGE_TOO_LARGE", "Merge lists of at most " + maxMembers + " members at a time")
    const canAccept = !!userScope.capabilities.consentEdit
    const decisions = []
    for (const partyId of [...byParty.keys()].sort()) {
        const states = byParty.get(partyId)
        const targetRow = targetRows.get(partyId) || null
        const consents = lib.rows(CONSENT, {partyId})
        let decision
        let carried = null
        let grant = null
        if (targetRow && (subscribed.includes(targetRow.statusId) || targetRow.statusId === "CLPT_PENDING")) decision = "existing"
        else if (targetRow && withdrawnStates.includes(targetRow.statusId)) decision = "kept"
        else if (states.some(state => withdrawnStates.includes(state.row.statusId))) decision = "conflict"
        else {
            // an accepted source with a grant of its own and the target's purpose first, then any accepted, then a pending one
            const accepted = states.filter(state => subscribed.includes(state.row.statusId))
            const granted = accepted
                .map(state => ({state, grant: state.samePurpose ? sourceGrant(consents, state.source.contactListId) : null}))
                .find(found => found.grant)
            if (granted && canAccept) {
                decision = "accepted"
                carried = granted.state
                grant = granted.grant
            } else if (accepted.length || states.some(state => state.row.statusId === "CLPT_PENDING")) {
                decision = "pending"
                carried = granted?.state || accepted[0] || states.find(state => state.row.statusId === "CLPT_PENDING")
            } else decision = "skipped"
        }
        decisions.push({partyId, states, targetRow, decision, carried, grant})
    }
    return decisions
}
function addressMasked(contactMechId) {
    const address = contactMechId ? audience.addressText(contactMechId) : ""
    return address ? suppressions.mask(address) : ""
}
function previewOf(p) {
    const userScope = audience.audienceScope("audienceEdit")
    const {target, sources} = listsOf(userScope, p)
    const archiveSources = yes(p.archiveSources)
    const decisions = decide(userScope, target, sources)
    const previewKey = String(
        lib.hash([
            target.contactListId,
            sources.map(source => source.contactListId).sort(),
            archiveSources,
            fingerprint([target].concat(sources))
        ])
    )
    return {userScope, target, sources, archiveSources, decisions, previewKey}
}

// ===== preview#ListMerge =====
function previewListMerge(p) {
    const preview = previewOf(p)
    const names = lib.partyNames(preview.decisions.map(found => found.partyId))
    const totals = {accepted: 0, pending: 0, existing: 0, kept: 0, conflict: 0, skipped: 0}
    const memberList = preview.decisions.map(found => {
        totals[found.decision]++
        return {
            partyId: found.partyId,
            partyName: names[found.partyId] || found.partyId,
            addressMasked: addressMasked(
                found.carried?.row.preferredContactMechId ||
                    found.targetRow?.preferredContactMechId ||
                    found.states[0]?.row.preferredContactMechId
            ),
            sourceText: found.states
                .map(
                    state =>
                        (state.source.contactListName || state.source.contactListId) +
                        ": " +
                        (audiences.statusTexts[state.row.statusId] || state.row.statusId)
                )
                .join(" · "),
            targetText: found.targetRow
                ? audiences.statusTexts[found.targetRow.statusId] || found.targetRow.statusId
                : "Not on the list",
            decision: found.decision,
            decisionText: decisionTexts[found.decision],
            conflict: ["kept", "conflict"].includes(found.decision)
        }
    })
    const paged = lib.pageList(memberList, p, "memberList")
    return Object.assign(paged, {
        previewKey: preview.previewKey,
        targetListId: preview.target.contactListId,
        targetName: preview.target.contactListName || preview.target.contactListId,
        sourceNames: preview.sources.map(source => source.contactListName || source.contactListId),
        archiveSources: preview.archiveSources,
        totals,
        carriedCount: totals.accepted + totals.pending,
        conflictCount: totals.kept + totals.conflict,
        canAccept: !!preview.userScope.capabilities.consentEdit
    })
}

// ===== merge#Lists =====
function mergeLists(p) {
    const reasonText = text(p.reasonText)
    if (!reasonText) denied("REASON_REQUIRED", "Give the reason for the merge")
    const userScope = audience.audienceScope("audienceEdit")
    const {target, sources} = listsOf(userScope, p)
    const request = {
        target: target.contactListId,
        sources: sources.map(source => source.contactListId).sort(),
        previewKey: text(p.previewKey),
        archive: yes(p.archiveSources)
    }
    const op = lib.operation(p, "MarketingListMerge", target.ownerPartyId, request)
    const previous = lib.previous(op)
    if (previous) return previous
    const preview = previewOf(p)
    if (!text(p.previewKey)) denied("PREVIEW_REQUIRED", "Preview the merge first")
    if (preview.previewKey !== text(p.previewKey))
        denied(
            "STALE_PREVIEW",
            "The lists changed since the preview; preview the merge again (its key is now " + preview.previewKey + ")"
        )
    const policy = audience.currentPolicy(target.contactListId)
    const results = []
    for (const found of preview.decisions) {
        if (!["accepted", "pending"].includes(found.decision)) {
            results.push({partyId: found.partyId, outcome: "skipped", reasonCode: found.decision.toUpperCase()})
            continue
        }
        const source = found.carried.source
        const sourceName = source.contactListName || source.contactListId
        const accept = found.decision === "accepted"
        const filed = audience.fileApart(
            target,
            policy,
            {
                requestKindEnumId: "SrkMerge",
                sourceEnumId: accept ? found.grant.sourceEnumId || "PcsStaff" : "PcsStaff",
                evidenceDate: accept ? found.grant.consentDate : found.carried.row.fromDate,
                evidenceText: accept
                    ? "Merged from list " +
                      sourceName +
                      ": " +
                      (found.grant.evidenceText || "its subscription") +
                      " · " +
                      reasonText
                    : "Merged from list " +
                      sourceName +
                      " (" +
                      (audiences.statusTexts[found.carried.row.statusId] || found.carried.row.statusId) +
                      " there) · " +
                      reasonText,
                sourceRecordId: source.contactListId,
                contactMechId: found.carried.row.preferredContactMechId || null,
                accept
            },
            found.partyId
        )
        results.push(Object.assign({sourceListId: source.contactListId}, filed))
    }
    let archivedCount = 0
    const archiveRefusals = []
    if (preview.archiveSources)
        for (const source of sources) {
            const current = one("mantle.marketing.contact.ContactList", {contactListId: source.contactListId})
            if (audience.archived(current)) continue
            // a source held by a send (LIST_RESERVED) stays open, named; the merge stands
            const archived = lib.check(() =>
                lib.probe("mantle.marketing.AudienceServices.archive#List", {
                    contactListId: source.contactListId,
                    expectedRevision: lib.ms(current.lastUpdatedStamp),
                    reason: "Merged into " + (target.contactListName || target.contactListId) + ": " + reasonText
                })
            )
            if (archived.allowed) archivedCount++
            else archiveRefusals.push({contactListId: source.contactListId, reasonCode: archived.reasonCode})
        }
    const count = outcome => results.filter(result => result.outcome === outcome).length
    const out = {
        targetListId: target.contactListId,
        acceptedCount: count("accepted"),
        pendingCount: count("pending"),
        existingCount: count("existing"),
        refusedCount: count("refused"),
        skippedCount: count("skipped"),
        archivedCount,
        archiveRefusals,
        refusals: results
            .filter(result => result.outcome === "refused")
            .map(result => ({partyId: result.partyId, reasonCode: result.reasonCode}))
    }
    lib.complete(op, "mantle.marketing.contact.ContactList", target.contactListId, out)
    return out
}

const operations = {previewListMerge, mergeLists}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown list merge operation " + op)
        return operations[op](parameters || {})
    }
})
