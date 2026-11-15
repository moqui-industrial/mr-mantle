// Marketing's experiments (mantle.marketing.CampaignSendServices; IronStone Marketing design §5 ExperimentDetail, §14.1
// CampaignExperiment, CampaignExperimentVariant; impl-marketing P10). An experiment compares two variants of a send's content on equal
// samples of its prepared audience; the rest (the remainder) is held until a person chooses the winner and a dispatcher releases it.
//
// - Setup (store#Experiment, store#ExperimentVariant): a draft (or awaiting, or approved) send's editor sets the total sample percent
//   (1 to 90, split equally between the two variants), the measure shown and the observation period; each variant changes parts of the
//   send's content (subject, preheader, body, text: a part left as the send's is the send's), checked as the send's content is
//   (MessageTemplates.js checkContent, PRIVATE_LINK). The setup and the variants are content of the send: a change of the sample or of
//   a variant raises the send's revision, ends its approval and returns it to draft (MarketingSends.js revise), so an approval always
//   covers both variants as prepared.
// - Preparation (prepare#Send calls prepare): the variants' contents checked (they must differ: VARIANTS_SAME) and kept as resources of
//   their own beside the send's; every eligible person assigned once, by their normalized address under the experiment's own seed (a
//   stable order: the same audience prepared again gives the same assignment), to variant A's sample, variant B's or the remainder,
//   the samples equal and the three disjoint (SAMPLE_TOO_SMALL when a variant or the remainder would get no one). A sample recipient's
//   variant is on its CampaignRecipient and never changes; the remainder is held (CrsHeld) and never claimed by the dispatch.
// - Release (release#Send, MarketingDispatch.js): the samples go out as any send's recipients do, each checked again just before its
//   hand-off; the limits and the one-person-team count read the whole prepared audience. Once the samples settle the send is "Sample
//   sent".
// - The winner (choose#ExperimentWinner): a dispatcher chooses a variant with a reason once the observation period from the sample's
//   sending has passed (OBSERVATION_OPEN); nothing chooses one by itself: a tie, no observations or incomplete tracking stay
//   undecided (compare). Chosen again until it is released.
// - The winner's release (release#ExperimentWinner): MARKETING_DISPATCH, the send's current approval and readiness (as release#Send),
//   apart from the authors and the approver but under the one-person-team flag (the whole audience under 500). The remainder is
//   checked against the send's audience as it is now (the lists and segments less the exclusions, evaluated again: someone it no
//   longer admits is left out, AUDIENCE_LEFT; no one new is added) and against what the send already sent (ALREADY_SENT), then
//   selected with the winner's variant for the dispatch, which checks each again just before (consent, suppression, a withdrawal at the
//   address, a changed address). One release: a second answers the first, whatever key it names.
// - Results (get#Experiment): per variant the assigned, accepted and confirmed delivered counts from the ledger, the tracking-enabled
//   share, and unique clicks and conversions "not available" until tracking (P15) and attribution (P20) record them; a test message
//   (test#Send of a variant) is a delivery of its own source and counts nowhere.
// Refusals carry reason codes (EntityLib.js denied).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const marketingAccess = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingAccess.js")
const approvals = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingApprovals.js")
const templates = ec.resource.script("component://mr-mantle/service/mantle/party/MessageTemplates.js")
const sends = () => ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingSends.js").forExperiments
const dispatch = () => ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingDispatch.js").forExperiments
const {find, one, rows, denied, call, ms} = lib

const EXPERIMENT = "mantle.marketing.campaign.CampaignExperiment"
const VARIANT = "mantle.marketing.campaign.CampaignExperimentVariant"
const RECIPIENT = "mantle.marketing.campaign.CampaignRecipient"
const SEND = "mantle.marketing.campaign.CampaignSend"
const D = "mantle.party.MessageDelivery"
const measures = ["MxmUniqueClickRate", "MxmConversionRate"]
const defaults = {measureEnumId: "MxmUniqueClickRate", observationHours: 24}
const bounds = {samplePercent: [1, 90], observationHours: [1, 720]}
const nameLimit = 60
const editableStatuses = ["CsDraft", "CsAwaitingApproval", "CsApproved"]
// a winner is chosen once the sample has gone out, and released while the send still sends or waits for it
const choosableStatuses = ["CsSending", "CsPaused", "CsSampleSent"]
const releasableStatuses = ["CsSending", "CsSampleSent"]
const previewLimit = 2000
const chunk = 500

const text = value => (value == null ? "" : String(value).trim())
const blank = value => text(value) === ""
const nowMs = () => ms(ec.user.nowTimestamp)
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const userName = userId => {
    const partyId = userId ? one("moqui.security.UserAccount", {userId})?.partyId : null
    return partyId ? lib.partyNames([partyId])[partyId] || userId : userId || ""
}
const slices = (values, size = chunk) => {
    const out = []
    for (let start = 0; start < values.length; start += size) out.push(values.slice(start, start + size))
    return out
}
// A whole number within its bounds, else VALUE_INVALID naming them.
function wholeNumber(value, [low, high], what) {
    const number = Number(text(value))
    if (!Number.isInteger(number) || number < low || number > high)
        denied("VALUE_INVALID", what + " is a whole number from " + low + " to " + high)
    return number
}

// ===== the experiment and its variants =====
// The send's live experiment (none removed), else null.
function liveOf(campaignSendId, lock = false) {
    let query = find(EXPERIMENT, {campaignSendId}).condition("endedDate", "is-null", null)
    if (lock) query = query.forUpdate(true)
    return Array.from(query.orderBy("-createdDate").limit(1).list())[0] || null
}
const variantsOf = campaignExperimentId => Array.from(find(VARIANT, {campaignExperimentId}).orderBy("sequenceNum").list())
// A variant of the send's live experiment, else null (a variant of a removed experiment is no longer the send's).
function liveVariant(row, campaignExperimentVariantId) {
    const experiment = liveOf(row.campaignSendId)
    const variant = experiment ? one(VARIANT, {campaignExperimentVariantId: text(campaignExperimentVariantId)}) : null
    return variant && variant.campaignExperimentId === experiment.campaignExperimentId ? variant : null
}
function variantOf(row, campaignExperimentVariantId) {
    const variant = liveVariant(row, campaignExperimentVariantId)
    if (!variant) denied("RECORD_UNAVAILABLE", "Variant " + text(campaignExperimentVariantId) + " is not one of this send's")
    return variant
}
const variantLabel = variant => "Variant " + variant.variantLabel + (variant.variantName ? ": " + variant.variantName : "")
// labelsOf (the delivery rows): {campaignExperimentVariantId: "Variant A: name"}.
function labelsOf(variantIds) {
    const ids = Array.from(new Set(variantIds.filter(Boolean)))
    const labels = {}
    if (ids.length)
        for (const variant of Array.from(find(VARIANT).condition("campaignExperimentVariantId", "in", ids).list()))
            labels[variant.campaignExperimentVariantId] = variantLabel(variant)
    return labels
}

// ===== content =====
const variablesOf = row => lib.json(row.variablesJson, []) || []
// A variant's content as it is now, by location (MarketingSends.js render's shape): its own parts over the send's draft; or, prepared,
// what was prepared with the send at its preparation's revision (else the draft).
function variantContent(row, variant, prepared) {
    if (prepared && variant.preparedBodyLocation && Number(variant.preparedRevision) === Number(row.preparedRevision))
        return {
            subject: variant.preparedSubject || "",
            preheader: variant.preparedPreheader || "",
            bodyLocation: variant.preparedBodyLocation,
            bodyTextLocation: variant.preparedTextLocation,
            variables: lib.json(row.preparedVariablesJson, []) || []
        }
    return {
        subject: blank(variant.subject) ? row.subject || "" : variant.subject,
        preheader: blank(variant.preheader) ? row.preheader || "" : variant.preheader,
        bodyLocation: variant.bodyLocation || row.bodyLocation,
        bodyTextLocation: variant.bodyTextLocation || row.bodyTextLocation,
        variables: variablesOf(row)
    }
}
// The prepared content a recipient of the variant receives (build#CampaignDelivery), or null when it was not prepared with the send's
// current preparation (the build then suppresses the delivery).
function preparedVariantContent(row, campaignExperimentVariantId) {
    const variant = one(VARIANT, {campaignExperimentVariantId: text(campaignExperimentVariantId)})
    const experiment = variant ? one(EXPERIMENT, {campaignExperimentId: variant.campaignExperimentId}) : null
    if (!experiment || experiment.campaignSendId !== row.campaignSendId) return null
    if (!variant.preparedBodyLocation || Number(variant.preparedRevision) !== Number(row.preparedRevision)) return null
    return variantContent(row, variant, true)
}
// A variant's parts as text: {subject, preheader, body, bodyText}.
function textsOf(row, variant) {
    const content = variantContent(row, variant, false)
    return {
        subject: content.subject || "",
        preheader: content.preheader || "",
        body: templates.readText(content.bodyLocation),
        bodyText: templates.readText(content.bodyTextLocation)
    }
}
const sameTexts = (a, b) =>
    a.subject === b.subject && a.preheader === b.preheader && a.body === b.body && a.bodyText === b.bodyText
// The parts a variant changes, in words.
function changedParts(variant) {
    const parts = []
    if (!blank(variant.subject)) parts.push("subject")
    if (!blank(variant.preheader)) parts.push("preheader")
    if (variant.bodyLocation) parts.push("body")
    if (variant.bodyTextLocation) parts.push("text")
    return parts.length ? parts.join(", ") : "none: the send's content"
}

// ===== what approval needs (MarketingSends.js sendProblems) =====
function problemsOf(row) {
    const experiment = liveOf(row.campaignSendId)
    if (!experiment) return []
    const variants = variantsOf(experiment.campaignExperimentId)
    if (variants.length !== 2) return ["its experiment needs two variants"]
    const problems = []
    if (sameTexts(textsOf(row, variants[0]), textsOf(row, variants[1])))
        problems.push("its two variants are the same: change variant B's subject or content")
    if (
        sends().preparedCurrent(row) &&
        variants.some(variant => Number(variant.preparedRevision) !== Number(row.preparedRevision))
    )
        problems.push("its variants need to be prepared with it")
    return problems
}

// ===== preparation (prepare#Send) =====
// A 32-bit hash of a text (FNV-1a with a final mix): the stable order of the assignment.
function hashOf(value) {
    let hash = 0x811c9dc5
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index)
        hash = Math.imul(hash, 0x01000193) >>> 0
    }
    hash ^= hash >>> 16
    hash = Math.imul(hash, 0x85ebca6b) >>> 0
    hash ^= hash >>> 13
    hash = Math.imul(hash, 0xc2b2ae35) >>> 0
    hash ^= hash >>> 16
    return hash >>> 0
}
// The assignment: each eligible person by their normalized address, in the order of the experiment's seeded hash, the first share to
// variant A, the next equal share to B, the rest the remainder. {variantOf: Map(destinationKey -> variant id, absent for the
// remainder), perVariant, sampleCount, remainderCount}.
function assign(experiment, variants, recipients) {
    const total = recipients.length
    const perVariant = Math.floor(Math.floor((total * Number(experiment.samplePercent)) / 100) / 2)
    if (perVariant < 1 || total - 2 * perVariant < 1)
        denied(
            "SAMPLE_TOO_SMALL",
            "A " +
                experiment.samplePercent +
                "% sample of " +
                total +
                " eligible recipients gives a variant or the remainder no one: raise the sample or widen the audience"
        )
    const seed = experiment.campaignExperimentId + ":"
    const ordered = recipients
        .map(recipient => ({key: recipient.destinationKey, order: hashOf(seed + recipient.destinationKey)}))
        .sort((a, b) => a.order - b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    const variantOf = new Map()
    ordered.forEach((entry, index) => {
        if (index < perVariant) variantOf.set(entry.key, variants[0].campaignExperimentVariantId)
        else if (index < 2 * perVariant) variantOf.set(entry.key, variants[1].campaignExperimentVariantId)
    })
    return {variantOf, perVariant, sampleCount: 2 * perVariant, remainderCount: total - 2 * perVariant}
}
// prepare#Send's part: the variants checked and prepared beside the send's content, the eligible people assigned.
function prepare(row, experiment, content, revision, recipients) {
    const s = sends()
    const variants = variantsOf(experiment.campaignExperimentId)
    if (variants.length !== 2) denied("EXPERIMENT_INCOMPLETE", "The send's experiment needs two variants")
    const texts = variants.map(variant => textsOf(row, variant))
    if (sameTexts(texts[0], texts[1]))
        denied("VARIANTS_SAME", "Variant B is the same as variant A: change its subject or content before preparing")
    texts.forEach((value, index) => {
        if (!value.subject) denied("SUBJECT_REQUIRED", variantLabel(variants[index]) + " has no subject")
        if (!value.body.trim() && !value.bodyText.trim()) denied("BODY_REQUIRED", variantLabel(variants[index]) + " has no body")
        templates.checkContent(Object.assign({variables: content.variables}, value))
        s.checkLinks(value.body)
    })
    const assigned = assign(experiment, variants, recipients)
    variants.forEach((variant, index) => {
        const files = s.writeFiles(
            row.campaignSendId,
            "prepared-r" + revision + "-" + variant.variantLabel.toLowerCase(),
            texts[index].body,
            texts[index].bodyText
        )
        call("update#" + VARIANT, {
            campaignExperimentVariantId: variant.campaignExperimentVariantId,
            preparedRevision: revision,
            preparedSubject: texts[index].subject,
            preparedPreheader: texts[index].preheader || null,
            preparedBodyLocation: files.bodyLocation,
            preparedTextLocation: files.bodyTextLocation,
            sampleCount: assigned.perVariant
        })
    })
    call("update#" + EXPERIMENT, {
        campaignExperimentId: experiment.campaignExperimentId,
        sampleCount: assigned.sampleCount,
        remainderCount: assigned.remainderCount
    })
    return assigned
}

// ===== store#Experiment =====
function storeExperiment(p) {
    const s = sends()
    const userScope = s.editScope()
    const row = s.sendOf(userScope, p.campaignSendId, true)
    s.requireEditable(row)
    s.requireRevision(row, p.expectedRevision)
    if (row.channelEnumId !== "MdcEmail") denied("CHANNEL_UNAVAILABLE", "An experiment compares emails")
    const existing = liveOf(row.campaignSendId, true)
    const action = text(p.action) || "store"
    if (action === "remove") {
        if (!existing) denied("RECORD_UNAVAILABLE", "Send " + row.campaignSendId + " has no experiment")
        call("update#" + EXPERIMENT, {
            campaignExperimentId: existing.campaignExperimentId,
            endedDate: ec.user.nowTimestamp,
            endedByUserId: ec.user.userId
        })
        s.revise(row, {}, "Experiment removed")
        return {campaignExperimentId: existing.campaignExperimentId, approvalEnded: row.statusId !== "CsDraft"}
    }
    if (action !== "store") denied("ACTION_INVALID", "Set up or remove the experiment")
    const measureEnumId = blank(p.measureEnumId) ? existing?.measureEnumId || defaults.measureEnumId : text(p.measureEnumId)
    if (!measures.includes(measureEnumId)) denied("VALUE_INVALID", "Choose the measure")
    const observationHours = blank(p.observationHours)
        ? Number(existing?.observationHours || defaults.observationHours)
        : wholeNumber(p.observationHours, bounds.observationHours, "The observation period in hours")
    if (!existing) {
        if (blank(p.samplePercent)) denied("VALUE_INVALID", "Give the total sample percent")
        const samplePercent = wholeNumber(p.samplePercent, bounds.samplePercent, "The total sample percent")
        const campaignExperimentId = call("create#" + EXPERIMENT, {
            campaignSendId: row.campaignSendId,
            organizationPartyId: row.organizationPartyId,
            samplePercent,
            measureEnumId,
            observationHours,
            createdByUserId: ec.user.userId,
            createdDate: ec.user.nowTimestamp
        }).campaignExperimentId
        for (const [variantLabel, sequenceNum] of [
            ["A", 1],
            ["B", 2]
        ])
            call("create#" + VARIANT, {campaignExperimentId, variantLabel, sequenceNum})
        s.revise(row, {}, "Experiment set up")
        return {campaignExperimentId, approvalEnded: row.statusId !== "CsDraft"}
    }
    const samplePercent = blank(p.samplePercent)
        ? Number(existing.samplePercent)
        : wholeNumber(p.samplePercent, bounds.samplePercent, "The total sample percent")
    call("update#" + EXPERIMENT, {
        campaignExperimentId: existing.campaignExperimentId,
        samplePercent,
        measureEnumId,
        observationHours
    })
    // the setup is the send's as approved (who receives what, and when a winner may be chosen and released): any change of it ends
    // the approval (P10 review); storing the same values changes nothing
    const material =
        samplePercent !== Number(existing.samplePercent) ||
        measureEnumId !== existing.measureEnumId ||
        observationHours !== Number(existing.observationHours || defaults.observationHours)
    if (material) s.revise(row, {}, "Experiment setup changed")
    return {campaignExperimentId: existing.campaignExperimentId, approvalEnded: material && row.statusId !== "CsDraft"}
}

// ===== store#ExperimentVariant =====
// A part given that equals the send's is the send's (no part of the variant's own); any other is the variant's.
function storeVariant(p) {
    const s = sends()
    const userScope = s.editScope()
    const row = s.sendOf(userScope, p.campaignSendId, true)
    s.requireEditable(row)
    s.requireRevision(row, p.expectedRevision)
    const variant = variantOf(row, p.campaignExperimentVariantId)
    const base = {
        subject: row.subject || "",
        preheader: row.preheader || "",
        body: templates.readText(row.bodyLocation),
        bodyText: templates.readText(row.bodyTextLocation)
    }
    const current = textsOf(row, variant)
    const next = {
        subject: p.subject != null ? text(p.subject) : current.subject,
        preheader: p.preheader != null ? text(p.preheader) : current.preheader,
        body: p.body != null ? String(p.body) : current.body,
        bodyText: p.bodyText != null ? String(p.bodyText) : current.bodyText
    }
    templates.checkContent(Object.assign({variables: variablesOf(row)}, next))
    s.checkLinks(next.body)
    const values = {campaignExperimentVariantId: variant.campaignExperimentVariantId}
    if (p.variantName != null) {
        const name = text(p.variantName)
        if (name.length > nameLimit) denied("VALUE_INVALID", "A variant's name is at most " + nameLimit + " characters")
        values.variantName = name || null
    }
    const material = !sameTexts(current, next)
    if (material) {
        values.subject = next.subject === base.subject ? null : next.subject
        values.preheader = next.preheader === base.preheader ? null : next.preheader
        const ownBody = next.body === base.body ? null : next.body
        const ownText = next.bodyText === base.bodyText ? null : next.bodyText
        const files =
            ownBody != null || ownText
                ? s.writeFiles(row.campaignSendId, "variant-" + variant.variantLabel.toLowerCase(), ownBody || "", ownText || "")
                : {}
        values.bodyLocation = ownBody != null ? files.bodyLocation : null
        values.bodyTextLocation = ownText ? files.bodyTextLocation : null
    }
    call("update#" + VARIANT, values)
    if (material) s.revise(row, {}, variantLabel(variant) + " changed")
    return {
        campaignExperimentVariantId: variant.campaignExperimentVariantId,
        approvalEnded: material && row.statusId !== "CsDraft"
    }
}

// ===== the state, the observation and the results =====
// When the sample started going out (the release, or its schedule if later), and the observation's end.
function observationOf(row, experiment) {
    if (!row.releasedDate) return {started: false}
    const start = Math.max(ms(row.releasedDate), row.scheduledDate ? ms(row.scheduledDate) : 0)
    const end = start + Number(experiment.observationHours || defaults.observationHours) * 3600000
    return {started: true, start, end, open: nowMs() < end, endText: lib.dateText(new Date(end))}
}
function stateOf(row, experiment, observation) {
    if (experiment.winnerReleasedDate) return "Winner released to the remainder"
    if (row.statusId === "CsCancelled") return "Cancelled"
    if (editableStatuses.includes(row.statusId)) return "Not sent yet"
    if (row.statusId === "CsScheduled") return "Sample scheduled"
    if (row.statusId === "CsPaused") return "Paused"
    if (observation.started && observation.open) return "Observing the sample until " + observation.endText
    if (experiment.winnerVariantId) return "Winner chosen; waiting for its release"
    return row.statusId === "CsSampleSent" ? "Ready for a winner" : "Sending the sample"
}
// The decision shown, never acted on: undecided when a variant has no observation or no denominator, or the rates tie; else the
// variant leading on the measure (informational: no claim of significance, and a person still chooses).
function compare(observations) {
    if (observations.some(entry => entry.observed == null))
        return {decided: false, leaderVariantId: null, reasonText: "No observations: they are counted once tracking records them"}
    if (observations.some(entry => !Number(entry.denominator)))
        return {decided: false, leaderVariantId: null, reasonText: "No accepted, tracking-enabled recipient in a variant yet"}
    const rates = observations.map(entry => Number(entry.observed) / Number(entry.denominator))
    const best = Math.max(...rates)
    const leaders = observations.filter((entry, index) => rates[index] === best)
    if (leaders.length > 1) return {decided: false, leaderVariantId: null, reasonText: "A tie: the variants measure the same"}
    return {decided: true, leaderVariantId: leaders[0].variantId, reasonText: "Leading on the measure (no claim of significance)"}
}
// Unique clicks of a variant's tracking-enabled sample: the recipients with a non-automated click of a personalized link (P15).
const observedOf = (variant, tracked) =>
    ec.resource
        .script("component://mr-mantle/service/mantle/marketing/MarketingTracking.js")
        .uniqueClickers(tracked.map(recipient => recipient.campaignRecipientId))
// The deliveries of recipients (ids of the ledger), counted: {accepted, delivered, failed, suppressed}.
function deliveryTotals(deliveryIds) {
    const totals = {accepted: 0, delivered: 0, failed: 0, suppressed: 0}
    for (const ids of slices(deliveryIds)) {
        const base = () => find(D).condition("deliveryId", "in", ids)
        totals.accepted += base().condition("stateEnumId", "MdsSent").count()
        totals.delivered += base().condition("receiptEnumId", "MdrDelivered").count()
        totals.failed += base().condition("stateEnumId", "MdsFailed").count()
        totals.suppressed += base().condition("stateEnumId", "MdsSuppressed").count()
    }
    return totals
}
const live = ["CrsSelected", "CrsHandedOff", "CrsSkipped", "CrsCancelled", "CrsHeld"]
// Each variant's sample at the current preparation, with its deliveries, and the remainder's.
function resultsOf(row, experiment, variants) {
    const revision = Number(row.preparedRevision || 0)
    const variantRows = variants.map(variant => {
        const recipients = Array.from(
            find(RECIPIENT, {
                campaignSendId: row.campaignSendId,
                campaignExperimentVariantId: variant.campaignExperimentVariantId
            })
                .condition("preparedRevision", revision)
                .condition("experimentRemainder", "is-null", null)
                .condition("statusId", "in", live)
                .selectField("campaignRecipientId")
                .selectField("statusId")
                .selectField("tracked")
                .selectField("messageDeliveryId")
                .list()
        )
        const tracked = recipients.filter(recipient => recipient.tracked === "Y")
        const totals = deliveryTotals(recipients.map(recipient => recipient.messageDeliveryId).filter(Boolean))
        const trackedTotals = deliveryTotals(tracked.map(recipient => recipient.messageDeliveryId).filter(Boolean))
        const assigned = recipients.length
        const uniqueClicks = observedOf(variant, tracked)
        return {
            campaignExperimentVariantId: variant.campaignExperimentVariantId,
            variantLabel: variant.variantLabel,
            variantName: variant.variantName || "",
            labelText: variantLabel(variant),
            assignedCount: assigned,
            handedOffCount: recipients.filter(recipient => recipient.statusId === "CrsHandedOff").length,
            skippedCount: recipients.filter(recipient => recipient.statusId === "CrsSkipped").length,
            acceptedCount: totals.accepted,
            deliveredCount: totals.delivered,
            failedCount: totals.failed + totals.suppressed,
            untrackedCount: assigned - tracked.length,
            trackedAcceptedCount: trackedTotals.accepted,
            coverageText: assigned
                ? tracked.length + " of " + assigned + " (" + Math.round((tracked.length * 100) / assigned) + "%)"
                : "",
            uniqueClicks,
            clicksText: String(uniqueClicks),
            conversionsText: "Not available",
            denominatorText: trackedTotals.accepted + " accepted with tracking",
            winner: experiment.winnerVariantId === variant.campaignExperimentVariantId
        }
    })
    const remainder = {}
    for (const statusId of live)
        remainder[statusId] = find(RECIPIENT, {campaignSendId: row.campaignSendId, statusId, experimentRemainder: "Y"})
            .condition("preparedRevision", revision)
            .count()
    return {variantRows, remainder}
}

// ===== summaryOf (get#Send's Experiment box), get#Experiment =====
function summaryOf(userScope, row) {
    const experiment = liveOf(row.campaignSendId)
    const canSetUp =
        !!userScope.capabilities.sendEdit && editableStatuses.includes(row.statusId) && row.channelEnumId === "MdcEmail"
    if (!experiment) return {exists: false, canSetUp}
    const observation = observationOf(row, experiment)
    const variants = variantsOf(experiment.campaignExperimentId)
    const winner = variants.find(variant => variant.campaignExperimentVariantId === experiment.winnerVariantId)
    return {
        exists: true,
        canSetUp: false,
        campaignExperimentId: experiment.campaignExperimentId,
        samplePercent: Number(experiment.samplePercent),
        measureText: enumText(experiment.measureEnumId),
        observationHours: Number(experiment.observationHours || defaults.observationHours),
        stateText: stateOf(row, experiment, observation),
        sampleCount: experiment.sampleCount == null ? null : Number(experiment.sampleCount),
        remainderCount: experiment.remainderCount == null ? null : Number(experiment.remainderCount),
        winnerText: winner ? variantLabel(winner) : "",
        variants: variants.map(variant => ({
            campaignExperimentVariantId: variant.campaignExperimentVariantId,
            labelText: variantLabel(variant),
            subject: variantContent(row, variant, false).subject || "",
            changedText: changedParts(variant)
        }))
    }
}
function getExperiment(p) {
    const s = sends()
    const userScope = s.readScope()
    const row = s.sendOf(userScope, p.campaignSendId)
    const caps = userScope.capabilities
    const experiment = liveOf(row.campaignSendId)
    const editable = !!caps.sendEdit && editableStatuses.includes(row.statusId)
    const send = {
        campaignSendId: row.campaignSendId,
        sendName: s.label(row),
        statusId: row.statusId,
        statusText: s.statusText(row.statusId),
        organizationPartyId: row.organizationPartyId,
        sendRevision: Number(row.sendRevision || 1),
        revision: ms(row.lastUpdatedStamp),
        eligibleCount: s.preparedCurrent(row) ? Number(row.eligibleCount || 0) : null,
        subject: row.subject || ""
    }
    const measureOptions = measures.map(enumId => ({value: enumId, label: enumText(enumId)}))
    if (!experiment)
        return {
            send,
            measureOptions,
            experiment: null,
            variantList: [],
            remainder: {},
            decision: {},
            releasePreview: {},
            capabilities: {canEdit: false, canSetUp: editable && row.channelEnumId === "MdcEmail"}
        }
    const variants = variantsOf(experiment.campaignExperimentId)
    const observation = observationOf(row, experiment)
    const results = resultsOf(row, experiment, variants)
    const decision = compare(
        results.variantRows.map(entry => ({
            variantId: entry.campaignExperimentVariantId,
            observed: entry.uniqueClicks,
            denominator: entry.trackedAcceptedCount
        }))
    )
    const leader = results.variantRows.find(entry => entry.campaignExperimentVariantId === decision.leaderVariantId)
    const winner = variants.find(variant => variant.campaignExperimentVariantId === experiment.winnerVariantId)
    const released = !!experiment.winnerReleasedDate
    const canChoose =
        !!caps.dispatch && !released && choosableStatuses.includes(row.statusId) && observation.started && !observation.open
    let canRelease = false,
        releaseSelf = false
    if (caps.dispatch && !released && winner && releasableStatuses.includes(row.statusId)) {
        const approval = approvals.currentApproval("send", row.campaignSendId, Number(row.sendRevision || 1))
        if (approval) {
            releaseSelf = dispatch().releaseParties(row, approval).has(ec.user.userId)
            canRelease =
                !releaseSelf ||
                approvals.selfApprovalAdmits(approvals.policyOf(row.organizationPartyId), "send", Number(row.eligibleCount || 0))
        }
    }
    const variantList = variants.map(variant => {
        const texts = textsOf(row, variant)
        const shown = results.variantRows.find(entry => entry.campaignExperimentVariantId === variant.campaignExperimentVariantId)
        return Object.assign({}, shown, {
            subject: texts.subject,
            preheader: texts.preheader,
            body: editable ? texts.body : "",
            bodyText: editable ? texts.bodyText : "",
            changedText: changedParts(variant),
            prepared: !!variant.preparedBodyLocation && Number(variant.preparedRevision) === Number(row.preparedRevision),
            preparedSubject: variant.preparedSubject || ""
        })
    })
    return {
        send,
        measureOptions,
        experiment: {
            campaignExperimentId: experiment.campaignExperimentId,
            samplePercent: Number(experiment.samplePercent),
            measureEnumId: experiment.measureEnumId,
            measureText: enumText(experiment.measureEnumId),
            observationHours: Number(experiment.observationHours || defaults.observationHours),
            stateText: stateOf(row, experiment, observation),
            sampleCount: experiment.sampleCount == null ? null : Number(experiment.sampleCount),
            remainderCount: experiment.remainderCount == null ? null : Number(experiment.remainderCount),
            observationStarted: observation.started,
            observationOpen: !!observation.open,
            observationEndText: observation.endText || "",
            winnerVariantId: experiment.winnerVariantId || null,
            winnerText: winner ? variantLabel(winner) : "",
            winnerReason: experiment.winnerReason || "",
            winnerChosenByName: experiment.winnerChosenByUserId ? userName(experiment.winnerChosenByUserId) : "",
            winnerChosenDateText: experiment.winnerChosenDate ? lib.dateText(experiment.winnerChosenDate) : "",
            released,
            winnerReleasedDateText: experiment.winnerReleasedDate ? lib.dateText(experiment.winnerReleasedDate) : "",
            winnerReleasedByName: experiment.winnerReleasedByUserId ? userName(experiment.winnerReleasedByUserId) : "",
            winnerReleaseCount: Number(experiment.winnerReleaseCount || 0),
            winnerDroppedCount: Number(experiment.winnerDroppedCount || 0),
            winnerSelfDispatch: experiment.winnerSelfDispatch === "Y",
            revision: ms(experiment.lastUpdatedStamp)
        },
        variantList,
        remainder: {
            heldCount: results.remainder.CrsHeld,
            waitingCount: results.remainder.CrsSelected,
            handedOffCount: results.remainder.CrsHandedOff,
            skippedCount: results.remainder.CrsSkipped,
            cancelledCount: results.remainder.CrsCancelled
        },
        decision: Object.assign({}, decision, {leaderText: leader ? leader.labelText : ""}),
        releasePreview: canRelease && p.withReleasePreview !== false ? releasePreviewOf(row) : {},
        capabilities: {
            canEdit: editable,
            canSetUp: false,
            canRemove: editable,
            canChoose,
            canRelease,
            releaseSelf,
            canTest: !!caps.sendEdit && !!row.sendingProfileId
        }
    }
}
// What the winner's release would leave out now, of up to previewLimit held recipients: those whose consent, suppression or address
// changed since (the dispatch's check), and those the send already sent. The audience itself is evaluated again at the release.
function releasePreviewOf(row) {
    const held = Array.from(
        find(RECIPIENT, {campaignSendId: row.campaignSendId, statusId: "CrsHeld"})
            .condition("preparedRevision", Number(row.preparedRevision || 0))
            .orderBy("campaignRecipientId")
            .limit(previewLimit)
            .selectField("campaignRecipientId")
            .list()
    ).map(recipient => recipient.campaignRecipientId)
    let excluded = 0,
        checked = 0
    for (const ids of slices(held)) {
        const verdicts = dispatch().checkPage(row.campaignSendId, ids)
        if (!verdicts) break
        checked += ids.length
        excluded += ids.filter(id => !verdicts[id]?.eligible).length
    }
    const heldCount = find(RECIPIENT, {campaignSendId: row.campaignSendId, statusId: "CrsHeld"})
        .condition("preparedRevision", Number(row.preparedRevision || 0))
        .count()
    return {heldCount, checkedCount: checked, excludedSinceCount: excluded, eligibleNowCount: heldCount - excluded}
}

// ===== choose#ExperimentWinner =====
function chooseWinner(p) {
    const s = sends()
    const userScope = dispatch().dispatchScope()
    const row = s.sendOf(userScope, p.campaignSendId, true)
    const experiment = liveOf(row.campaignSendId, true)
    if (!experiment) denied("RECORD_UNAVAILABLE", "Send " + row.campaignSendId + " has no experiment")
    if (experiment.winnerReleasedDate) denied("WINNER_RELEASED", "The winner is released already: it no longer changes")
    if (blank(p.expectedRevision)) denied("REVISION_REQUIRED", "Name the revision of the experiment you read")
    if (ms(p.expectedRevision) !== ms(experiment.lastUpdatedStamp))
        denied(
            "STALE_REVISION",
            "The experiment changed since it was read; its revision is now " + ms(experiment.lastUpdatedStamp)
        )
    if (!choosableStatuses.includes(row.statusId))
        denied(
            "STATUS_INVALID",
            "Send " + row.campaignSendId + " is " + s.statusText(row.statusId).toLowerCase() + ": its sample is not out"
        )
    const observation = observationOf(row, experiment)
    if (!observation.started || observation.open)
        denied(
            "OBSERVATION_OPEN",
            "The sample is observed until " + (observation.endText || "it goes out") + ": choose after that"
        )
    const variant = variantOf(row, p.campaignExperimentVariantId)
    const reason = text(p.reason)
    if (!reason) denied("REASON_REQUIRED", "Give the reason for the winner")
    call("update#" + EXPERIMENT, {
        campaignExperimentId: experiment.campaignExperimentId,
        winnerVariantId: variant.campaignExperimentVariantId,
        winnerVariantId_changeReason: reason.slice(0, 255),
        winnerReason: reason.slice(0, 255),
        winnerChosenByUserId: ec.user.userId,
        winnerChosenDate: ec.user.nowTimestamp
    })
    return {campaignExperimentId: experiment.campaignExperimentId, winnerVariantId: variant.campaignExperimentVariantId}
}

// ===== release#ExperimentWinner =====
function releaseWinner(p) {
    const s = sends()
    const d = dispatch()
    const userScope = d.dispatchScope()
    const row = s.sendOf(userScope, p.campaignSendId, true)
    const experiment = liveOf(row.campaignSendId, true)
    if (!experiment) denied("RECORD_UNAVAILABLE", "Send " + row.campaignSendId + " has no experiment")
    // the winner the caller read (P10 review): a release never sends a variant other than the one named, nor answers as released a
    // call that names another (a choice made again since it was read)
    const named = text(p.campaignExperimentVariantId)
    if (named && experiment.winnerVariantId && named !== experiment.winnerVariantId)
        denied(
            "WINNER_CHANGED",
            "The winner is " +
                variantLabel(one(VARIANT, {campaignExperimentVariantId: experiment.winnerVariantId})) +
                (experiment.winnerReleasedDate ? ", released already" : " now: read it again before releasing")
        )
    // one release: a second answers the first, whatever key it names
    if (experiment.winnerReleasedDate)
        return {
            campaignSendId: row.campaignSendId,
            released: false,
            alreadyReleased: true,
            releasedCount: Number(experiment.winnerReleaseCount || 0),
            droppedCount: Number(experiment.winnerDroppedCount || 0),
            selfDispatch: experiment.winnerSelfDispatch === "Y",
            statusId: row.statusId
        }
    if (!experiment.winnerVariantId) denied("WINNER_REQUIRED", "Choose the winner first")
    if (!releasableStatuses.includes(row.statusId))
        denied("STATUS_INVALID", "Send " + row.campaignSendId + " is " + s.statusText(row.statusId).toLowerCase())
    const revision = Number(row.sendRevision || 1)
    const approval = approvals.currentApproval("send", row.campaignSendId, revision)
    if (!approval) denied("APPROVAL_REQUIRED", "Send " + row.campaignSendId + " is not approved at revision " + revision)
    const problems = s.sendProblems(row)
    if (problems.length) denied("NOT_READY", "The winner cannot be released: " + problems.join(", "))
    const policy = approvals.policyOf(row.organizationPartyId)
    const own = d.releaseParties(row, approval).has(ec.user.userId)
    if (own && !approvals.selfApprovalAdmits(policy, "send", Number(row.eligibleCount || 0)))
        denied(
            "SELF_DISPATCH",
            "You wrote, submitted or approved send " + row.campaignSendId + "; another dispatcher releases its winner"
        )
    const held = Array.from(
        find(RECIPIENT, {campaignSendId: row.campaignSendId, statusId: "CrsHeld"})
            .condition("preparedRevision", Number(row.preparedRevision || 0))
            .selectField("campaignRecipientId")
            .selectField("partyId")
            .selectField("destinationKey")
            .list()
    )
    // who the send's audience admits now (its lists and segments less the exclusions, as the releasing dispatcher): a held person it
    // no longer finds is left out; no one is added
    const admitted = new Set(
        s
            .evaluateAudience(userScope, row, {lenient: true})
            .rows.map(recipient => recipient.partyId + "|" + recipient.destinationKey)
    )
    // what the send sent already, by person and by address: never a second message of it
    const sentParties = new Set(),
        sentKeys = new Set()
    for (const recipient of Array.from(
        find(RECIPIENT, {campaignSendId: row.campaignSendId, statusId: "CrsHandedOff"})
            .selectField("partyId")
            .selectField("destinationKey")
            .list()
    )) {
        sentParties.add(recipient.partyId)
        sentKeys.add(recipient.destinationKey)
    }
    const alreadySent = [],
        left = [],
        released = []
    for (const recipient of held) {
        if (sentParties.has(recipient.partyId) || sentKeys.has(recipient.destinationKey))
            alreadySent.push(recipient.campaignRecipientId)
        else if (!admitted.has(recipient.partyId + "|" + recipient.destinationKey)) left.push(recipient.campaignRecipientId)
        else released.push(recipient.campaignRecipientId)
    }
    const now = ec.user.nowTimestamp
    const update = (ids, values) => {
        for (const part of slices(ids))
            find(RECIPIENT, {campaignSendId: row.campaignSendId, statusId: "CrsHeld"})
                .condition("campaignRecipientId", "in", part)
                .updateAll(values)
    }
    update(alreadySent, {statusId: "CrsSkipped", skipReasonCode: "ALREADY_SENT", skipDate: now})
    update(left, {statusId: "CrsSkipped", skipReasonCode: "AUDIENCE_LEFT", skipDate: now})
    update(released, {
        statusId: "CrsSelected",
        campaignExperimentVariantId: experiment.winnerVariantId,
        claimKey: null,
        leaseUntilDate: null
    })
    const winner = one(VARIANT, {campaignExperimentVariantId: experiment.winnerVariantId})
    call("update#" + EXPERIMENT, {
        campaignExperimentId: experiment.campaignExperimentId,
        winnerReleasedDate: now,
        winnerReleasedByUserId: ec.user.userId,
        winnerReleaseCount: released.length,
        winnerDroppedCount: alreadySent.length + left.length,
        winnerSelfDispatch: own ? "Y" : "N"
    })
    const reasonNote = text(p.reason) ? ": " + text(p.reason).slice(0, 200) : ""
    if (row.statusId === "CsSampleSent")
        call("update#" + SEND, {
            campaignSendId: row.campaignSendId,
            statusId: "CsSending",
            statusId_changeReason:
                variantLabel(winner) +
                " released to " +
                released.length +
                " by " +
                (ec.user.username || ec.user.userId) +
                (own ? " (one-person team)" : "") +
                reasonNote,
            completedDate: null
        })
    d.dispatchAfterCommit(row.campaignSendId)
    return {
        campaignSendId: row.campaignSendId,
        released: true,
        alreadyReleased: false,
        releasedCount: released.length,
        droppedCount: alreadySent.length + left.length,
        selfDispatch: own,
        statusId: "CsSending"
    }
}

const operations = {
    store: storeExperiment,
    storeVariant,
    get: getExperiment,
    choose: chooseWinner,
    releaseWinner
}
;({
    liveOf,
    liveVariant,
    variantOf,
    variantContent,
    preparedVariantContent,
    labelsOf,
    problemsOf,
    prepare,
    summaryOf,
    compare,
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown campaign experiment operation " + op)
        return operations[op](parameters || {})
    }
})
