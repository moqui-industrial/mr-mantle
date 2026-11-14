// Marketing's automations (mantle.marketing.AutomationServices, N of IronStone Marketing design §14.2; design §6 Automations,
// AutomationDetail and EnrollmentDetail, §15.3 the admission and step jobs; impl-marketing P11, §4). A drip sequence of a campaign:
// its topic (a Marketing list of email of the organization), sending profile, enrollment rule and dated steps (Send email, Wait,
// Condition: no loop or jump, at most the policy's automationMaxSteps, ten by default).
//
// - Authoring (MARKETING_SEND_EDIT, the automation's organization): create#Automation, store#EnrollmentRule, store#Steps. A change of
//   the rule, topic, sender or steps raises automationRevision, ends the approval (MarketingApprovals.js supersede) and returns an
//   automation that is not ended to draft; steps are ended and started anew (dated), and a send step's content is a CampaignSend of
//   the automation (status CsAutomation) copied from a template and prepared when the step is stored (MarketingSends.js stepSend).
// - Approval: CampaignServices request#MarketingApproval and decide#MarketingApproval with targetKind automation (automationKind
//   below): asked of a draft, approved to Approved, never self-approved (an automation has no recipient count). Activation is apart
//   from approval (activate#Automation, MARKETING_DISPATCH): the activator is none of its authors nor its approver, at the approval of
//   its current revision, with its problems none and an address for each message's unsubscribe link; pause#Automation and
//   end#Automation are the dispatcher's too. An enrollment admitted earlier keeps the steps in effect at its admission (design §6:
//   editing never rewrites executions); it runs only while the automation is active.
// - The owner (the user's call, Nov 14, 2026; F157): an automation runs as its saved owner, the dispatcher who last activated or
//   resumed it (activatedByUserId; a new activation by another dispatcher makes that person the owner), signed in for each admission
//   and step run and checked again each time (as run#EtlMapping signs in as a mapping's saved owner): the owner can sign in, still
//   holds MARKETING_DISPATCH and works for the automation's organization, and can read every segment the automation names. Its
//   trigger, goal and condition segments may use any of P5's sources, Sales and purchases too, under the owner's own Sales and
//   Commerce access read at run time; eligibility is P5's rule (classifyPeople) with "not available" decided by the owner (P5
//   review). An owner who lost access pauses the automation with the reason (pauseNote), never a run wider or narrower; activation
//   refuses a dispatcher who could not run it (NOT_READY).
// - Triggers (sourceKey, one AutomationSourceEvent per automation and source): a confirmed subscription to the topic (an accepted
//   SubscriptionRequest after the activation, read by a cursor), a newly matched segment member (a difference scan: the first scan
//   after activation records the matches as a baseline, later scans file the new ones), staff enrollment with evidence
//   (enroll#Party), an order placed (the Mantle SECA OrderPlacedRecordAttribution's handler TrackingServices.handle#OrderPlaced files
//   it) and a cart abandoned (the carts Commerce's recovery reads for a store whose sender is the automation, CartRecovery.js
//   automationCarts). A duplicate event finds its row filed and enrolls no one again.
// - Admission (run#AutomationAdmission, admit#SourceEvent): one enrollment per automation, person and source; re-entry once per person
//   (the default) or once per new event after a cooldown, never two active at once; the person classified for the topic now (an
//   accepted, evidenced member, not withdrawn or suppressed), else the event is refused with the reason.
// - Steps (run#AutomationSteps, process#EnrollmentStep, each enrollment in a transaction of its own): before every step the goal and
//   the enrollment are checked again (the campaign closed, the goal met, a topic withdrawal or a suppression end it; a channel's
//   withdrawal, the purpose or the address's solicitation, skips that channel's sends only); a wait is an elapsed time, or days or
//   business days (EventServices get#FutureBusinessDay, the organization's holidays) keeping the local time in the rule's zone, the
//   next valid instant across a daylight-saving gap; a condition matches a segment, else skips the next send step or ends the
//   enrollment; a send step makes the participant a recipient of the step's send and hands it to the ledger through the dispatch's
//   checks (MarketingDispatch.js checkRecipients and handOffRecipient: membership, consent by organization, the suppression split, a
//   withdrawal by anyone at the address, the frequency cap) under the automation's approval, not a decision per participant. Quiet
//   hours and the frequency cap postpone a send (dueNote), never skip consent; a sending profile not ready postpones it; a campaign no
//   longer approved or a sending profile ended or turned transactional pauses the automation (pauseNote). Each step runs once per
//   enrollment (AutomationStepExecution, unique), so a restart never replays a completed send; a run is bounded, so a resume after a
//   pause works through overdue steps under the current caps a page at a time.
// - Reads: find#Automations, get#Automation, preview#Automation (a dry run that sends and stores nothing), find#Enrollments and
//   get#Enrollment for a Marketing reader of the organization who writes, approves or dispatches sends or reads audiences, a
//   participant's name and whole address for an audience reader only (masked otherwise); stop#Enrollment for a dispatcher or an
//   audience editor.
// Refusals carry reason codes (EntityLib.js denied).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const marketingAccess = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingAccess.js")
const approvals = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingApprovals.js")
const eligibility = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingEligibility.js")
const segments = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingSegments.js")
const profiles = ec.resource.script("component://mr-mantle/service/mantle/party/MessageSendingProfiles.js")
const time = ec.resource.script("component://mr-mantle/service/mantle/work/BusinessTime.js")
const sends = () => ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingSends.js").forAutomation
const dispatch = () => ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingDispatch.js")
const carts = () => ec.resource.script("component://mr-mantle/service/mantle/order/CartRecovery.js")
const {find, one, rows, denied, call, ms} = lib

const AUTOMATION = "mantle.marketing.automation.MarketingAutomation"
const STEP = "mantle.marketing.automation.MarketingAutomationStep"
const EVENT = "mantle.marketing.automation.AutomationSourceEvent"
const ENROLLMENT = "mantle.marketing.automation.AutomationEnrollment"
const EXECUTION = "mantle.marketing.automation.AutomationStepExecution"
const SEND = "mantle.marketing.campaign.CampaignSend"
const RECIPIENT = "mantle.marketing.campaign.CampaignRecipient"
const CAMPAIGN = "mantle.marketing.campaign.MarketingCampaign"
const SEGMENT = "mantle.marketing.segment.MarketSegment"
const PROFILE = "mantle.party.MessageSendingProfile"
const SERVICES = "mantle.marketing.AutomationServices."
const nameLimit = 120
const defaultMaxSteps = 10
const limits = {
    automationsPerRun: 50,
    activeAutomations: 1000,
    eventsPerRun: 200,
    enrollmentsPerRun: 200,
    perAutomation: 100,
    pageSize: 20,
    profileRetryMinutes: 60,
    capRetryMinutes: 24 * 60
}
const waitBounds = {AwuMinutes: [1, 525600], AwuHours: [1, 8760], AwuDays: [1, 365], AwuBusinessDays: [1, 260]}
// P12: a form submitted (AtrFormSubmitted: a submission of a Marketing publication of the organization by a known party)
const triggers = ["AtrSubscription", "AtrSegment", "AtrStaff", "AtrOrderPlaced", "AtrCartAbandoned", "AtrFormSubmitted"]
const stepKinds = {send: "AskSendEmail", wait: "AskWait", condition: "AskCondition"}
const editableStatuses = ["MaDraft", "MaAwaitingApproval", "MaApproved", "MaActive", "MaPaused"]
const closedCampaignStatuses = ["MKTG_CAMP_COMPLETED", "MKTG_CAMP_CANCELLED"]
// A classification's reasons that end an enrollment (the topic left or withdrawn, a suppression: design §6) and those that skip only
// the channel's sends (the channel's purpose or the address's solicitation withdrawn, no usable address, no evidence)
const endingReasons = ["NOT_SUBSCRIBED", "UNSUBSCRIBED", "LIST_WITHDRAWN", "PENDING", "SUPPRESSED", "PARTY_UNAVAILABLE"]
const statusColors = {
    MaDraft: "grey-7",
    MaAwaitingApproval: "warning",
    MaApproved: "info",
    MaActive: "positive",
    MaPaused: "warning",
    MaEnded: "grey-7",
    AenActive: "positive",
    AenCompleted: "info",
    AenStopped: "grey-7"
}
const endTexts = {
    COMPLETED: "Completed every step",
    GOAL_MET: "The goal was met",
    CONDITION_NOT_MET: "A condition was not met",
    STOPPED: "Stopped by staff",
    AUTOMATION_ENDED: "The automation ended",
    CAMPAIGN_CLOSED: "The campaign closed"
}
const outcomeTexts = {
    AsoHandedOff: "Handed off",
    AsoSkipped: "Skipped",
    AsoWaiting: "Waiting",
    AsoConditionMet: "Condition met",
    AsoConditionNotMet: "Condition not met"
}
const skipTexts = {
    CONDITION_SKIP: "Skipped by a condition not met",
    FREQUENCY_CAP: "Over the organization's frequency cap",
    DESTINATION_CHANGED: "The address changed",
    NOT_CLASSIFIED: "Could not be checked",
    ALREADY_ENROLLED: "Already enrolled in this automation",
    COOLDOWN: "Enrolled again too soon after the last time",
    NO_STEPS: "The automation has no steps",
    NOT_ELIGIBLE: "Not eligible for the topic",
    PARTY_UNAVAILABLE: "Not a person an automation sends to"
}

const text = value => (value == null ? "" : String(value).trim())
const blank = value => text(value) === ""
const nowMs = () => ms(ec.user.nowTimestamp)
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "")
const organizationName = partyId => (partyId ? one("mantle.party.Organization", {partyId})?.organizationName || partyId : "")
const reasonText = code => (code ? endTexts[code] || skipTexts[code] || eligibility.reasonTexts[code] || code : "")
const label = row => row.automationName || row.marketingAutomationId
const listOf = value =>
    value == null || value === ""
        ? []
        : Array.from(typeof value === "string" ? value.split(",") : value)
              .map(item => text(item))
              .filter(Boolean)

// ===== scope and records =====
// A reader of automations and their enrollments: a Marketing reader who writes, approves or dispatches sends, or an audience reader
// (design §2: AutomationDetail the authors', approvers' and dispatchers', EnrollmentDetail the dispatchers' and audience managers').
function readScope() {
    const userScope = marketingAccess.scope()
    const caps = userScope.capabilities
    if (!caps.anyRead || !(caps.sendEdit || caps.approve || caps.dispatch || caps.audienceRead))
        denied("PERMISSION_DENIED", "Marketing automations are not open to you")
    return userScope
}
const enrollmentScope = readScope
function editScope() {
    const userScope = readScope()
    marketingAccess.requireCapability(userScope, "sendEdit")
    return userScope
}
function dispatchScope() {
    const userScope = readScope()
    marketingAccess.requireCapability(userScope, "dispatch")
    return userScope
}
// An automation of the scope, else RECORD_UNAVAILABLE (missing, another organization's or unowned alike).
function automationOf(userScope, marketingAutomationId, lock = false) {
    const id = text(marketingAutomationId)
    let query = id ? find(AUTOMATION, {marketingAutomationId: id}) : null
    if (query && lock) query = query.forUpdate(true)
    const row = query ? query.one() : null
    if (!row || !marketingAccess.covers(userScope, row.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Automation " + id + " is not available")
    return row
}
function requireRevision(row, expectedRevision) {
    if (blank(expectedRevision))
        denied("REVISION_REQUIRED", "Name the revision of automation " + row.marketingAutomationId + " you read")
    if (ms(expectedRevision) !== ms(row.lastUpdatedStamp))
        denied(
            "STALE_REVISION",
            "Automation " +
                row.marketingAutomationId +
                " changed since it was read; its revision is now " +
                ms(row.lastUpdatedStamp)
        )
}
function requireEditable(row) {
    if (!editableStatuses.includes(row.statusId))
        denied("STATUS_INVALID", "Automation " + row.marketingAutomationId + " has ended")
}
function nameOf(value) {
    const name = text(value)
    if (!name) denied("NAME_REQUIRED", "Give the automation a name")
    if (name.length > nameLimit) denied("VALUE_INVALID", "An automation's name is at most " + nameLimit + " characters")
    return name
}
const maxStepsOf = organizationPartyId =>
    Number(approvals.policyOf(organizationPartyId)?.automationMaxSteps) > 0
        ? Number(approvals.policyOf(organizationPartyId).automationMaxSteps)
        : defaultMaxSteps

// The steps in effect at a time, in order.
const stepsAt = (marketingAutomationId, at = ec.user.nowTimestamp) =>
    rows(STEP, {marketingAutomationId})
        .filter(row => lib.active(row, at))
        .sort((a, b) => Number(a.sequenceNum) - Number(b.sequenceNum))

// A segment an automation may name: of the organization and not archived. Its sources are read as the owner at each run (ownerProblem),
// and activation refuses a dispatcher who cannot read them. The segment row.
function automationSegment(userScope, marketSegmentId, organizationPartyId, what) {
    const segment = segments.segmentOfScope(userScope, marketSegmentId)
    if (segment.ownerPartyId !== organizationPartyId)
        denied("RECORD_UNAVAILABLE", "Segment " + text(marketSegmentId) + " is not available")
    if (segments.archived(segment)) denied("SEGMENT_ARCHIVED", "Segment " + segments.segmentLabel(segment) + " is archived")
    return segment
}
// A store of the organization for an order or cart trigger.
function storeFor(productStoreId, organizationPartyId) {
    if (blank(productStoreId)) return null
    const store = one("mantle.product.store.ProductStore", {productStoreId: text(productStoreId)})
    if (!store || store.organizationPartyId !== organizationPartyId)
        denied("RECORD_UNAVAILABLE", "Store " + text(productStoreId) + " is not available")
    return store
}
function zoneOf(value) {
    const zone = text(value)
    if (!zone) return ec.user.timeZone || null
    if (
        !Array.from(ec.l10n.getAvailableTimeZones() || [])
            .map(String)
            .includes(zone)
    )
        denied("VALUE_INVALID", "Time zone " + zone + " is not known")
    return zone
}

// ===== the owner (the user's call, Nov 14, 2026) =====
// The parties of a set a segment matches now (or of the organization's audience when partyIds is null), as the user signed in: the
// automation's owner in a run, the caller in a simulation. A source the user may not read is refused (SOURCE_UNAVAILABLE).
function segmentMatches(organizationPartyId, marketSegmentId, partyIds) {
    const segment = one(SEGMENT, {marketSegmentId})
    if (!segment || segments.archived(segment)) return new Set()
    const ctx = segments.context(marketingAccess.scope(), organizationPartyId, ec.user.nowTimestamp, partyIds)
    return segments.matchesOf(ctx, segment)
}
// The segments an automation names now: its trigger's, its goal and its current steps' conditions.
const namedSegments = automation =>
    Array.from(
        new Set(
            [automation.triggerEnumId === "AtrSegment" ? automation.triggerSegmentId : null, automation.goalSegmentId]
                .concat(stepsAt(automation.marketingAutomationId).map(step => step.conditionSegmentId))
                .filter(Boolean)
        )
    )
// Why the user signed in could not run an automation as its owner, or null: MARKETING_DISPATCH, the organization, and each segment it
// names read (its sources, its parents') as that user.
function ownerProblem(automation) {
    const userScope = marketingAccess.scope()
    if (!userScope.capabilities.dispatch) return "no longer holds the Marketing dispatch permission"
    if (!marketingAccess.covers(userScope, automation.organizationPartyId))
        return "no longer works for " + organizationName(automation.organizationPartyId)
    for (const marketSegmentId of namedSegments(automation)) {
        const segment = one(SEGMENT, {marketSegmentId})
        if (!segment) continue
        try {
            segments.matchesOf(segments.context(userScope, automation.organizationPartyId, ec.user.nowTimestamp, []), segment)
        } catch (error) {
            return "cannot read segment " + segments.segmentLabel(segment) + " (" + String(error.message).split("\n")[0] + ")"
        }
    }
    return null
}
const ownerText = userId => {
    const account = userId ? one("moqui.security.UserAccount", {userId}) : null
    return account ? account.userFullName || account.username || userId : "its owner"
}
// body(problem) signed in as the automation's owner (activatedByUserId) with authorization off for the run's own writes, the user
// before it put back after; problem is why the owner cannot run it now (null when they can). A user who is the owner already is not
// signed in again.
function asOwner(automation, body) {
    const ownerUserId = automation.activatedByUserId || null
    if (ownerUserId && ec.user.userId === ownerUserId)
        return withoutAuthz(() => body(withoutAuthz(() => ownerProblem(automation))))
    const previous = ec.user.username || null
    const account = ownerUserId ? one("moqui.security.UserAccount", {userId: ownerUserId}) : null
    // the login gate refuses a disabled or terminated account; its error is kept off the run's messages
    let signedIn = false
    ec.message.pushErrors()
    try {
        signedIn = !!account && ec.user.internalLoginUser(account.username) === true && ec.user.userId === ownerUserId
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
    try {
        const problem = !ownerUserId
            ? "has no owner: activate it again"
            : !signedIn
              ? "cannot sign in"
              : withoutAuthz(() => ownerProblem(automation))
        return withoutAuthz(() => body(problem && "Its owner " + ownerText(ownerUserId) + " " + problem))
    } finally {
        // back to the user before the run, or none: an owner never outlives the run
        ec.message.pushErrors()
        try {
            if (previous) {
                if (ec.user.username !== previous) ec.user.internalLoginUser(previous)
            } else if (ec.user.userId) ec.user.logoutUser()
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
}
function withoutAuthz(body) {
    const disabled = ec.artifactExecution.disableAuthz()
    try {
        return body()
    } finally {
        if (!disabled) ec.artifactExecution.enableAuthz()
    }
}
// The automation paused for a change outside its approval (its owner's access, a closed path): its pauseNote says why; a dispatcher
// resumes it (a new activation, that dispatcher its owner).
function pauseFor(automation, note) {
    call("update#" + AUTOMATION, {
        marketingAutomationId: automation.marketingAutomationId,
        statusId: "MaPaused",
        statusId_changeReason: note.slice(0, 250),
        pausedDate: ec.user.nowTimestamp,
        pauseNote: note.slice(0, 250)
    })
}
// One person classified for the automation's topic now, as the user signed in (the owner in a run: P5's "not available" is the
// owner's): {bucket, reasonCode, contactMechId, key, address}.
function classifyFor(automation, partyId) {
    const topic = one("mantle.marketing.contact.ContactList", {contactListId: automation.contactListId})
    if (!topic) return {bucket: "withdrawn", reasonCode: "NOT_SUBSCRIBED"}
    const found = eligibility.classifyPeople({
        organizationPartyId: automation.organizationPartyId,
        list: topic,
        purposeEnumId: automation.purposeEnumId,
        channelEnumId: automation.channelEnumId || "MdcEmail",
        partyIds: [partyId]
    })
    return found.people[0] || {bucket: "unavailable", reasonCode: "PARTY_UNAVAILABLE"}
}

// ===== waits (design §6: elapsed, or days and business days in the rule's zone) =====
// The wall time of an instant in a zone, yyyy-MM-dd HH:mm.
const wallOf = (millis, zone) => time.wallIn(millis, zone)
// The instant a wall time (day, HH:mm) names in a zone; in a daylight-saving gap the next valid instant (the first after it).
function instantOf(day, clock, zone) {
    const wanted = day + " " + clock
    const guess = time.wallTimeIn(day, clock, zone)
    if (wallOf(guess, zone) === wanted) return guess
    // a gap: the first minute whose wall time is after the wanted one, searched over the day
    let low = time.dayStartIn(day, zone),
        high = low + 26 * time.hourMs
    while (high - low > time.minuteMs) {
        const middle = low + Math.floor((high - low) / 2 / time.minuteMs) * time.minuteMs
        if (wallOf(middle, zone) > wanted) high = middle
        else low = middle
    }
    return high
}
// A wait's end from a start (millis): minutes and hours elapsed; days and business days keep the start's local time in the zone.
function waitDue(startMs, step, automation) {
    const amount = Number(step.waitAmount || 0)
    if (step.waitUnitEnumId === "AwuMinutes") return startMs + amount * time.minuteMs
    if (step.waitUnitEnumId === "AwuHours") return startMs + amount * time.hourMs
    const zone = automation.timeZone || ec.user.timeZone || null
    const [day, clock] = wallOf(startMs, zone).split(" ")
    let days = amount
    if (step.waitUnitEnumId === "AwuBusinessDays")
        days = Number(
            call("mantle.work.EventServices.get#FutureBusinessDay", {
                startDate: day,
                businessDays: amount,
                organizationPartyId: automation.organizationPartyId
            }).calendarDays || amount
        )
    return instantOf(time.addDay(day, days), clock, zone) + (startMs % time.minuteMs)
}
// An instant as text in a zone with its offset (design §6: the chosen offset shown before approval).
function zonedText(millis, zone) {
    const shown = ec.l10n.format(new Date(millis), "yyyy-MM-dd HH:mm:ss", null, zone || null)
    const [date, clock] = shown.split(" ")
    const [y, m, d] = date.split("-").map(Number)
    const [hh, mm, ss] = clock.split(":").map(Number)
    const offset = Math.round((Date.UTC(y, m - 1, d, hh, mm, ss) - Math.floor(millis / 1000) * 1000) / time.minuteMs)
    const sign = offset < 0 ? "-" : "+"
    const pad = n => String(Math.floor(Math.abs(n))).padStart(2, "0")
    return shown.slice(0, 16) + " " + sign + pad(offset / 60) + ":" + pad(offset % 60) + (zone ? " " + zone : "")
}
function waitText(step) {
    const unit = enumText(step.waitUnitEnumId).toLowerCase()
    return "Wait " + step.waitAmount + " " + unit
}

// ===== revisions =====
// A material change (the rule, topic, sender or steps): the revision raised, the definition's time moved, the approval ended and an
// automation that is not a draft returned to draft.
function revise(row, values, reason) {
    const newRevision = Number(row.automationRevision || 1) + 1
    const update = Object.assign(
        {
            marketingAutomationId: row.marketingAutomationId,
            automationRevision: newRevision,
            revisedByUserId: ec.user.userId,
            definitionDate: ec.user.nowTimestamp
        },
        values
    )
    if (row.statusId !== "MaDraft") {
        update.statusId = "MaDraft"
        update.statusId_changeReason = reason
    }
    call("update#" + AUTOMATION, update)
    approvals.supersede("automation", row.marketingAutomationId, newRevision)
    return {newRevision, approvalEnded: row.statusId !== "MaDraft"}
}
// The current steps' sends follow the automation's topic and sender.
function syncStepSends(automationId, values) {
    for (const step of stepsAt(automationId))
        if (step.campaignSendId) call("update#" + SEND, Object.assign({campaignSendId: step.campaignSendId}, values))
}

// ===== what approval and activation need =====
function automationProblems(row) {
    const problems = []
    const campaign = one(CAMPAIGN, {marketingCampaignId: row.marketingCampaignId})
    if (!campaign || !sends().approvedCampaignStatuses.includes(campaign.statusId)) problems.push("its campaign is not approved")
    const profile = row.sendingProfileId ? one(PROFILE, {sendingProfileId: row.sendingProfileId}) : null
    if (!profile) problems.push("it needs a sending profile")
    else if (profile.purposeEnumId === "MtpTransactional") problems.push("its sending profile is for transactional messages")
    else if (profile.thruDate != null && ms(profile.thruDate) <= nowMs()) problems.push("its sending profile has ended")
    else if (!profiles.readinessOf(profile).ready) problems.push("its sending profile is not ready")
    const steps = stepsAt(row.marketingAutomationId)
    if (!steps.some(step => step.stepKindEnumId === stepKinds.send)) problems.push("it needs a send step")
    if (steps.length > maxStepsOf(row.organizationPartyId)) problems.push("it has more steps than the policy allows")
    if (row.triggerEnumId === "AtrSegment" && !row.triggerSegmentId) problems.push("its trigger needs a segment")
    if (row.triggerEnumId === "AtrCartAbandoned" && !row.productStoreId) problems.push("its trigger needs a store")
    if (row.triggerEnumId === "AtrFormSubmitted" && !row.formPublicationId) problems.push("its trigger needs a form publication")
    return problems
}
// MarketingApprovals.js targetKinds.automation delegates to this
const automationKind = {
    read: (targetId, lock) => {
        const query = find(AUTOMATION, {marketingAutomationId: targetId})
        return (lock ? query.forUpdate(true) : query).one()
    },
    revision: row => Number(row.automationRevision || 1),
    authors: row => Array.from(new Set([row.createdByUserId, row.revisedByUserId].filter(Boolean))),
    requestable: row => {
        if (row.statusId !== "MaDraft")
            denied("STATUS_INVALID", "Automation " + row.marketingAutomationId + " is " + statusText(row.statusId).toLowerCase())
    },
    problems: row => automationProblems(row),
    requested: row => setStatus(row, "MaAwaitingApproval", "Approval asked by " + (ec.user.username || ec.user.userId)),
    approved: row => setStatus(row, "MaApproved", "Approved by " + (ec.user.username || ec.user.userId)),
    refused: row => setStatus(row, "MaDraft", "Refused by " + (ec.user.username || ec.user.userId))
}
const setStatus = (row, statusId, reason) =>
    call("update#" + AUTOMATION, {marketingAutomationId: row.marketingAutomationId, statusId, statusId_changeReason: reason})
// The authors of the current revision (creator, the maker of its change, the requester) and its approver: activation is apart from
// them (design §5's separation, as a send's release).
function activationParties(row, approval) {
    const ids = new Set(automationKind.authors(row))
    if (approval?.requestDecisionId) {
        const requested = one("mantle.marketing.campaign.MarketingDecision", {marketingDecisionId: approval.requestDecisionId})
        if (requested?.decidedByUserId) ids.add(requested.decidedByUserId)
    }
    if (approval?.decidedByUserId) ids.add(approval.decidedByUserId)
    return ids
}

// ===== create#Automation, store#EnrollmentRule =====
// The trigger's fields checked: {triggerEnumId, triggerSegmentId, productStoreId}.
function triggerFor(userScope, p, organizationPartyId) {
    const triggerEnumId = text(p.triggerEnumId) || "AtrSubscription"
    if (!triggers.includes(triggerEnumId)) denied("VALUE_INVALID", "Choose one of the triggers")
    const segmentId = triggerEnumId === "AtrSegment" && !blank(p.triggerSegmentId) ? text(p.triggerSegmentId) : null
    if (segmentId) automationSegment(userScope, segmentId, organizationPartyId, "Segment")
    const store = ["AtrOrderPlaced", "AtrCartAbandoned"].includes(triggerEnumId)
        ? storeFor(p.productStoreId, organizationPartyId)
        : null
    // P12: a Marketing publication of the organization (RECORD_UNAVAILABLE otherwise)
    let formPublicationId = null
    if (triggerEnumId === "AtrFormSubmitted" && !blank(p.formPublicationId)) {
        const publication = one("mantle.party.FormPublication", {publicationId: text(p.formPublicationId)})
        const marketingForms = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingForms.js")
        if (
            !publication ||
            publication.organizationPartyId !== organizationPartyId ||
            !marketingForms.PUBLICATION_PURPOSES.includes(publication.purposeEnumId)
        )
            denied("RECORD_UNAVAILABLE", "Form publication " + p.formPublicationId + " is not available")
        formPublicationId = publication.publicationId
    }
    return {triggerEnumId, triggerSegmentId: segmentId, productStoreId: store?.productStoreId || null, formPublicationId}
}
function createAutomation(p) {
    const userScope = editScope()
    const s = sends()
    const campaign = s.campaignFor(userScope, p.marketingCampaignId)
    const org = campaign.organizationPartyId
    const topic = s.topicFor(p.contactListId, org)
    const profile = s.profileFor(p.sendingProfileId, org)
    const trigger = triggerFor(userScope, p, org)
    const marketingAutomationId = call("create#" + AUTOMATION, {
        marketingCampaignId: campaign.marketingCampaignId,
        organizationPartyId: org,
        automationName: nameOf(p.automationName),
        description: text(p.description) || null,
        channelEnumId: "MdcEmail",
        contactListId: topic.contactListId,
        purposeEnumId: eligibility.purposeOf(topic),
        sendingProfileId: profile?.sendingProfileId || null,
        triggerEnumId: trigger.triggerEnumId,
        triggerSegmentId: trigger.triggerSegmentId,
        productStoreId: trigger.productStoreId,
        formPublicationId: trigger.formPublicationId,
        reentryEnumId: "ArOnce",
        timeZone: zoneOf(p.timeZone),
        statusId: "MaDraft",
        automationRevision: 1,
        definitionDate: ec.user.nowTimestamp,
        createdByUserId: ec.user.userId,
        revisedByUserId: ec.user.userId,
        createdDate: ec.user.nowTimestamp
    }).marketingAutomationId
    return {marketingAutomationId}
}
// store#EnrollmentRule: the name, description, topic, sender, trigger, goal, re-entry and zone at the revision read; a material change
// (all but the name and description) ends the approval.
function storeEnrollmentRule(p) {
    const userScope = editScope()
    const row = automationOf(userScope, p.marketingAutomationId, true)
    requireEditable(row)
    requireRevision(row, p.expectedRevision)
    const s = sends()
    const org = row.organizationPartyId
    const values = {}
    if (p.automationName != null) values.automationName = nameOf(p.automationName)
    if (p.description != null) values.description = text(p.description) || null
    const material = {}
    if (!blank(p.contactListId) && text(p.contactListId) !== row.contactListId) {
        const topic = s.topicFor(p.contactListId, org)
        material.contactListId = topic.contactListId
        material.purposeEnumId = eligibility.purposeOf(topic)
    }
    if (p.sendingProfileId != null && text(p.sendingProfileId) !== text(row.sendingProfileId))
        material.sendingProfileId = s.profileFor(p.sendingProfileId, org)?.sendingProfileId || null
    if (p.triggerEnumId != null) {
        const trigger = triggerFor(userScope, p, org)
        for (const [field, value] of Object.entries(trigger)) if ((row[field] || null) !== value) material[field] = value
    }
    if (p.goalSegmentId != null) {
        const goalSegmentId = blank(p.goalSegmentId) ? null : text(p.goalSegmentId)
        if (goalSegmentId) automationSegment(userScope, goalSegmentId, org, "Goal segment")
        if (goalSegmentId !== (row.goalSegmentId || null)) material.goalSegmentId = goalSegmentId
    }
    if (p.reentryEnumId != null) {
        const reentryEnumId = text(p.reentryEnumId) || "ArOnce"
        if (!["ArOnce", "ArPerEvent"].includes(reentryEnumId)) denied("VALUE_INVALID", "Re-entry is once, or once per new event")
        const cooldown = reentryEnumId === "ArPerEvent" ? Number(p.reentryCooldownDays || 0) : null
        if (reentryEnumId === "ArPerEvent" && (!Number.isInteger(cooldown) || cooldown < 1 || cooldown > 365))
            denied("VALUE_INVALID", "A re-entry cooldown is a whole number of days from 1 to 365")
        if (reentryEnumId !== row.reentryEnumId) material.reentryEnumId = reentryEnumId
        if (cooldown !== (row.reentryCooldownDays == null ? null : Number(row.reentryCooldownDays)))
            material.reentryCooldownDays = cooldown
    }
    if (p.timeZone != null) {
        const zone = zoneOf(p.timeZone)
        if (zone !== row.timeZone) material.timeZone = zone
    }
    let approvalEnded = false
    if (Object.keys(material).length) {
        approvalEnded = revise(row, Object.assign({}, values, material), "The enrollment rule changed").approvalEnded
        const follow = {}
        if (material.contactListId)
            Object.assign(follow, {contactListId: material.contactListId, purposeEnumId: material.purposeEnumId})
        if (Object.hasOwn(material, "sendingProfileId")) follow.sendingProfileId = material.sendingProfileId
        if (Object.keys(follow).length) syncStepSends(row.marketingAutomationId, follow)
    } else if (Object.keys(values).length)
        call("update#" + AUTOMATION, Object.assign({marketingAutomationId: row.marketingAutomationId}, values))
    return {marketingAutomationId: row.marketingAutomationId, approvalEnded}
}

// ===== store#Steps =====
// The whole ordered set at the revision read: each {kind: send | wait | condition, stepName, messageTemplateId (send), waitAmount and
// waitUnitEnumId (wait), conditionSegmentId and conditionFalseEnumId (condition)}; at most the policy's step count. The steps in
// effect end and the new ones start now; each send step's content is copied from its template now.
function storeSteps(p) {
    const userScope = editScope()
    const row = automationOf(userScope, p.marketingAutomationId, true)
    requireEditable(row)
    requireRevision(row, p.expectedRevision)
    const org = row.organizationPartyId
    const given = Array.from(typeof p.steps === "string" ? lib.json(p.steps, []) || [] : p.steps || [])
    if (!given.length) denied("STEPS_REQUIRED", "An automation needs at least one step")
    const maxSteps = maxStepsOf(org)
    if (given.length > maxSteps) denied("TOO_MANY_STEPS", "An automation has at most " + maxSteps + " steps")
    const s = sends()
    // every step checked before anything is changed
    const checked = given.map((step, index) => {
        const kind = text(step.kind)
        const position = "Step " + (index + 1)
        if (!Object.hasOwn(stepKinds, kind)) denied("VALUE_INVALID", position + " is a send, a wait or a condition")
        const base = {kind, stepName: text(step.stepName).slice(0, nameLimit) || null}
        if (kind === "send") {
            if (blank(step.messageTemplateId)) denied("TEMPLATE_REQUIRED", position + " needs its template")
            return Object.assign(base, {template: s.templateFor(userScope, step.messageTemplateId, org)})
        }
        if (kind === "wait") {
            const unit = text(step.waitUnitEnumId) || "AwuDays"
            const bounds = waitBounds[unit]
            const amount = Number(step.waitAmount)
            if (!bounds) denied("VALUE_INVALID", position + ": a wait is in minutes, hours, days or business days")
            if (!Number.isInteger(amount) || amount < bounds[0] || amount > bounds[1])
                denied("VALUE_INVALID", position + ": wait a whole number from " + bounds[0] + " to " + bounds[1])
            return Object.assign(base, {waitAmount: amount, waitUnitEnumId: unit})
        }
        if (blank(step.conditionSegmentId)) denied("SEGMENT_REQUIRED", position + " needs the segment to match")
        automationSegment(userScope, step.conditionSegmentId, org, "Condition segment")
        const onFalse = text(step.conditionFalseEnumId) || "AcfSkipNextSend"
        if (!["AcfSkipNextSend", "AcfEnd"].includes(onFalse))
            denied("VALUE_INVALID", position + ": a condition not met skips the next send step or ends")
        return Object.assign(base, {conditionSegmentId: text(step.conditionSegmentId), conditionFalseEnumId: onFalse})
    })
    const {newRevision, approvalEnded} = revise(row, {}, "The steps changed")
    const now = ec.user.nowTimestamp
    for (const old of stepsAt(row.marketingAutomationId, now))
        call("update#" + STEP, {automationStepId: old.automationStepId, thruDate: now})
    const current = one(AUTOMATION, {marketingAutomationId: row.marketingAutomationId})
    const made = []
    checked.forEach((step, index) => {
        const values = {
            marketingAutomationId: row.marketingAutomationId,
            sequenceNum: (index + 1) * 10,
            stepKindEnumId: stepKinds[step.kind],
            stepName: step.stepName,
            automationRevision: newRevision,
            fromDate: now
        }
        if (step.kind === "send") {
            values.messageTemplateId = step.template.row.messageTemplateId
            values.campaignSendId = s.stepSend({automation: current, template: step.template, stepName: step.stepName})
        } else if (step.kind === "wait") Object.assign(values, {waitAmount: step.waitAmount, waitUnitEnumId: step.waitUnitEnumId})
        else Object.assign(values, {conditionSegmentId: step.conditionSegmentId, conditionFalseEnumId: step.conditionFalseEnumId})
        const automationStepId = call("create#" + STEP, values).automationStepId
        if (values.campaignSendId) call("update#" + SEND, {campaignSendId: values.campaignSendId, automationStepId})
        made.push(automationStepId)
    })
    return {marketingAutomationId: row.marketingAutomationId, automationStepIdList: made, approvalEnded}
}

// ===== activate#, pause#, end#Automation =====
function activateAutomation(p) {
    const userScope = dispatchScope()
    const row = automationOf(userScope, p.marketingAutomationId, true)
    if (row.statusId === "MaActive")
        return {marketingAutomationId: row.marketingAutomationId, statusId: row.statusId, alreadyActive: true}
    if (!["MaApproved", "MaPaused"].includes(row.statusId))
        denied("STATUS_INVALID", "Automation " + row.marketingAutomationId + " is " + statusText(row.statusId).toLowerCase())
    requireRevision(row, p.expectedRevision)
    const revision = Number(row.automationRevision || 1)
    const approval = approvals.currentApproval("automation", row.marketingAutomationId, revision)
    if (!approval)
        denied("APPROVAL_REQUIRED", "Automation " + row.marketingAutomationId + " is not approved at revision " + revision)
    if (activationParties(row, approval).has(ec.user.userId))
        denied(
            "SELF_DISPATCH",
            "You wrote, submitted or approved automation " + row.marketingAutomationId + "; another dispatcher activates it"
        )
    const problems = automationProblems(row)
    if (problems.length)
        denied("NOT_READY", "Automation " + row.marketingAutomationId + " cannot be activated: " + problems.join(", "))
    // the activator becomes its owner (the user's call, Nov 14): one who could not run it (a segment's source they may not read) is refused
    const ownerIssue = withoutAuthz(() => ownerProblem(row))
    if (ownerIssue)
        denied(
            "NOT_READY",
            "Automation " +
                row.marketingAutomationId +
                " cannot be activated by you: its owner would be you, and you " +
                ownerIssue
        )
    // each message's unsubscribe link needs an address of its own (P9 review): a site that mounts Account or a configured root
    let root = ""
    try {
        root = ec.web ? String(ec.web.getWebappRootUrl(true, null) || "") : ""
    } catch (error) {
        root = ""
    }
    root = root.replace(/\/+$/, "") || row.unsubscribeBaseUrl || ""
    const profile = one(PROFILE, {sendingProfileId: row.sendingProfileId})
    if (!dispatch().unsubscribeLink(row, profile, root).ready)
        denied(
            "NOT_READY",
            "Automation " +
                row.marketingAutomationId +
                " cannot be activated: its unsubscribe link has no address (give the sending profile a site with Account, or its relay a web base URL)"
        )
    // each current send step's communication event (the approved subject and body its rows and tokens name) and link root
    const templates = ec.resource.script("component://mr-mantle/service/mantle/party/MessageTemplates.js")
    for (const step of stepsAt(row.marketingAutomationId)) {
        if (!step.campaignSendId) continue
        const send = one(SEND, {campaignSendId: step.campaignSendId})
        const values = {campaignSendId: send.campaignSendId, unsubscribeBaseUrl: root || null}
        if (!send.communicationEventId)
            values.communicationEventId = call("create#mantle.party.communication.CommunicationEvent", {
                communicationEventTypeId: "Email",
                contactMechTypeEnumId: "CmtEmailAddress",
                statusId: "CeSent",
                fromPartyId: row.organizationPartyId,
                contactListId: send.contactListId,
                subject: send.preparedSubject || null,
                contentType: "text/html",
                body: templates.readText(send.preparedBodyLocation) || null,
                entryDate: ec.user.nowTimestamp,
                datetimeStarted: ec.user.nowTimestamp
            }).communicationEventId
        call("update#" + SEND, values)
    }
    const resumed = row.statusId === "MaPaused"
    call("update#" + AUTOMATION, {
        marketingAutomationId: row.marketingAutomationId,
        statusId: "MaActive",
        statusId_changeReason:
            (resumed ? "Resumed by " : "Activated by ") +
            (ec.user.username || ec.user.userId) +
            (text(p.reason) ? ": " + text(p.reason).slice(0, 200) : ""),
        activatedDate: resumed && row.activatedDate ? row.activatedDate : ec.user.nowTimestamp,
        activatedByUserId: ec.user.userId,
        activationDecisionId: approval.marketingDecisionId,
        unsubscribeBaseUrl: root || null,
        pausedDate: null,
        pauseNote: null,
        // a confirmed subscription counts from the first activation on (never a subscriber from before it)
        admissionCursorDate: row.admissionCursorDate || ec.user.nowTimestamp
    })
    return {marketingAutomationId: row.marketingAutomationId, statusId: "MaActive", resumed}
}
function pauseAutomation(p) {
    const userScope = dispatchScope()
    const row = automationOf(userScope, p.marketingAutomationId, true)
    if (row.statusId !== "MaActive")
        denied("STATUS_INVALID", "Automation " + row.marketingAutomationId + " is " + statusText(row.statusId).toLowerCase())
    const reason = text(p.reason).slice(0, 200)
    call("update#" + AUTOMATION, {
        marketingAutomationId: row.marketingAutomationId,
        statusId: "MaPaused",
        statusId_changeReason: "Paused by " + (ec.user.username || ec.user.userId) + (reason ? ": " + reason : ""),
        pausedDate: ec.user.nowTimestamp,
        pauseNote: reason || "Paused by " + (ec.user.username || ec.user.userId)
    })
    return {marketingAutomationId: row.marketingAutomationId, statusId: "MaPaused", inFlightCount: inFlight(row)}
}
// end#Automation: a dispatcher's for any automation, its author's for one never activated; its active enrollments stop.
function endAutomation(p) {
    const userScope = readScope()
    const row = automationOf(userScope, p.marketingAutomationId, true)
    if (row.statusId === "MaEnded")
        return {marketingAutomationId: row.marketingAutomationId, statusId: row.statusId, stoppedCount: 0}
    const caps = userScope.capabilities
    if (!caps.dispatch && !(caps.sendEdit && !row.activatedDate))
        denied("PERMISSION_DENIED", "Ending an automation that has run is a dispatcher's")
    const reason = text(p.reason)
    if (!reason) denied("REASON_REQUIRED", "Say why it ends")
    call("update#" + AUTOMATION, {
        marketingAutomationId: row.marketingAutomationId,
        statusId: "MaEnded",
        statusId_changeReason: "Ended by " + (ec.user.username || ec.user.userId) + ": " + reason.slice(0, 200),
        endedDate: ec.user.nowTimestamp,
        endReason: reason.slice(0, 200)
    })
    const stoppedCount = find(ENROLLMENT, {marketingAutomationId: row.marketingAutomationId, statusId: "AenActive"}).updateAll({
        statusId: "AenStopped",
        endReasonCode: "AUTOMATION_ENDED",
        endReason: endTexts.AUTOMATION_ENDED,
        endedDate: ec.user.nowTimestamp,
        endedByUserId: ec.user.userId,
        nextDueDate: null
    })
    approvals.supersede("automation", row.marketingAutomationId, Number(row.automationRevision || 1) + 1)
    return {marketingAutomationId: row.marketingAutomationId, statusId: "MaEnded", stoppedCount: Number(stoppedCount || 0)}
}
// The automation's deliveries still with the ledger (queued or retrying): what a pause or end lets finish.
function inFlight(row) {
    const sendIds = rows(SEND, {marketingAutomationId: row.marketingAutomationId}).map(send => send.campaignSendId)
    let count = 0
    for (const campaignSendId of sendIds)
        count += find("mantle.party.MessageDelivery", {sourceEnumId: dispatch().SOURCE})
            .condition("eventKey", "like", dispatch().eventPrefix(campaignSendId) + "%")
            .condition("stateEnumId", "in", ["MdsQueued", "MdsRetry"])
            .count()
    return count
}

// ===== admission =====
// fileEvent: one admission event of an automation, unless one is filed for its source already. {automationSourceEventId, created}.
function fileEvent(automation, fields) {
    const existing = one(EVENT, {marketingAutomationId: automation.marketingAutomationId, sourceKey: fields.sourceKey})
    if (existing) return {automationSourceEventId: existing.automationSourceEventId, created: false}
    const automationSourceEventId = call(
        "create#" + EVENT,
        Object.assign(
            {
                marketingAutomationId: automation.marketingAutomationId,
                triggerEnumId: automation.triggerEnumId,
                filedDate: ec.user.nowTimestamp,
                eventDate: ec.user.nowTimestamp,
                statusEnumId: "AseFiled"
            },
            fields
        )
    ).automationSourceEventId
    return {automationSourceEventId, created: true}
}
// The trigger's new source events of an active automation filed (its cursor moved); the number filed.
function collect(automation) {
    let filed = 0
    const trigger = automation.triggerEnumId
    if (trigger === "AtrSubscription") {
        const since = automation.admissionCursorDate || automation.activatedDate || ec.user.nowTimestamp
        const accepted = Array.from(
            find("mantle.marketing.contact.SubscriptionRequest", {
                contactListId: automation.contactListId,
                statusEnumId: "SrsAccepted"
            })
                .condition("decidedDate", "greater-equals", since)
                .orderBy("decidedDate")
                .limit(limits.eventsPerRun)
                .list()
        )
        let cursor = since
        for (const request of accepted) {
            cursor = request.decidedDate
            // an acceptance of someone already a member is no new subscription
            if (request.reasonCode === "ALREADY_MEMBER" || !request.partyId) continue
            if (
                fileEvent(automation, {
                    sourceKey: "subscription:" + request.subscriptionRequestId,
                    sourceId: request.subscriptionRequestId,
                    partyId: request.partyId,
                    eventDate: request.decidedDate
                }).created
            )
                filed++
        }
        call("update#" + AUTOMATION, {
            marketingAutomationId: automation.marketingAutomationId,
            admissionCursorDate: cursor,
            lastAdmissionDate: ec.user.nowTimestamp,
            admissionNote: null
        })
    } else if (trigger === "AtrSegment") {
        if (!automation.triggerSegmentId) return 0
        let matched
        try {
            matched = segmentMatches(automation.organizationPartyId, automation.triggerSegmentId, null)
        } catch (error) {
            call("update#" + AUTOMATION, {
                marketingAutomationId: automation.marketingAutomationId,
                lastAdmissionDate: ec.user.nowTimestamp,
                admissionNote: "The segment could not be evaluated: " + String(error.message).split("\n")[0].slice(0, 200)
            })
            return 0
        }
        // the first scan after activation records who matches as a baseline: only a later match is newly eligible
        const baseline =
            automation.admissionCursorDate == null || ms(automation.admissionCursorDate) <= ms(automation.activatedDate)
        const seen = new Set(
            rows(EVENT, {marketingAutomationId: automation.marketingAutomationId})
                .filter(row => row.sourceKey.startsWith("segment:"))
                .map(row => row.partyId)
        )
        for (const partyId of Array.from(matched).sort()) {
            if (seen.has(partyId)) continue
            if (!baseline && filed >= limits.eventsPerRun) break
            fileEvent(automation, {
                sourceKey: "segment:" + partyId,
                sourceId: automation.triggerSegmentId,
                partyId,
                statusEnumId: baseline ? "AseBaseline" : "AseFiled",
                processedDate: baseline ? ec.user.nowTimestamp : null
            })
            if (!baseline) filed++
        }
        call("update#" + AUTOMATION, {
            marketingAutomationId: automation.marketingAutomationId,
            admissionCursorDate: new Date(Math.max(nowMs(), (ms(automation.activatedDate) ?? 0) + 1)),
            lastAdmissionDate: ec.user.nowTimestamp,
            admissionNote: null
        })
    } else if (trigger === "AtrFormSubmitted") {
        // P12: the publication's submissions by a known party (an invitation's recipient or a signed-in account) after the cursor
        if (!automation.formPublicationId) return 0
        const since = automation.admissionCursorDate || automation.activatedDate || ec.user.nowTimestamp
        const submitted = Array.from(
            find("mantle.party.FormSubmission", {publicationId: automation.formPublicationId})
                .condition("submittedDate", "greater-equals", since)
                .orderBy("submittedDate")
                .limit(limits.eventsPerRun)
                .list()
        )
        let cursor = since
        for (const submission of submitted) {
            cursor = submission.submittedDate
            if (!submission.partyId) continue
            if (
                fileEvent(automation, {
                    sourceKey: "form:" + submission.formSubmissionId,
                    sourceId: submission.formSubmissionId,
                    partyId: submission.partyId,
                    eventDate: submission.submittedDate
                }).created
            )
                filed++
        }
        call("update#" + AUTOMATION, {
            marketingAutomationId: automation.marketingAutomationId,
            admissionCursorDate: cursor,
            lastAdmissionDate: ec.user.nowTimestamp,
            admissionNote: null
        })
    } else if (trigger === "AtrCartAbandoned") {
        if (!automation.productStoreId) return 0
        for (const cart of carts().automationCarts(automation.productStoreId, limits.eventsPerRun)) {
            // a visit the store's built-in recovery sent for already is never a second recovery
            const builtin = find("mantle.party.MessageDelivery", {
                sourceEnumId: "MdsrcCartRecovery",
                eventKey: carts().keyOf(cart.orderId, cart.windowMs)
            }).count()
            if (builtin) continue
            if (
                fileEvent(automation, {
                    sourceKey: "cart:" + cart.orderId + ":" + cart.windowMs,
                    sourceId: cart.orderId,
                    partyId: cart.partyId,
                    eventDate: cart.lastActivityDate
                }).created
            )
                filed++
            try {
                lib.probe("update#mantle.order.StoreCartAccess", {
                    cartAccessId: cart.cartAccessId,
                    recoveryHandledDate: cart.lastActivityDate
                })
            } catch (error) {
                ec.logger.warn("Cart " + cart.orderId + " not marked handled: " + String(error.message).split("\n")[0])
            }
        }
        call("update#" + AUTOMATION, {
            marketingAutomationId: automation.marketingAutomationId,
            lastAdmissionDate: ec.user.nowTimestamp,
            admissionNote: null
        })
    }
    return filed
}
// admit#SourceEvent: one filed event of an active automation admitted (an enrollment) or refused with its reason; an event of a paused
// automation waits. {admitted, reasonCode, automationEnrollmentId}.
function admitEvent(p) {
    const event = find(EVENT, {automationSourceEventId: text(p.automationSourceEventId)})
        .forUpdate(true)
        .one()
    if (!event || event.statusEnumId !== "AseFiled") return {admitted: false, reasonCode: "NOT_FILED"}
    const automation = one(AUTOMATION, {marketingAutomationId: event.marketingAutomationId})
    const refuse = reasonCode => {
        call("update#" + EVENT, {
            automationSourceEventId: event.automationSourceEventId,
            statusEnumId: "AseRefused",
            reasonCode,
            processedDate: ec.user.nowTimestamp
        })
        return {admitted: false, reasonCode}
    }
    if (!automation || automation.statusId === "MaEnded") return refuse("AUTOMATION_ENDED")
    if (automation.statusId !== "MaActive") return {admitted: false, reasonCode: "NOT_ACTIVE"}
    // as its owner (the user's call, Nov 14): an owner who lost access pauses it and the event waits
    return asOwner(automation, problem => {
        if (problem) {
            pauseFor(automation, problem)
            return {admitted: false, reasonCode: "NOT_ACTIVE"}
        }
        return admitAsOwner(event, automation, refuse)
    })
}
function admitAsOwner(event, automation, refuse) {
    if (!segments.inScopeParties([event.partyId]).has(event.partyId)) return refuse("PARTY_UNAVAILABLE")
    // re-entry: never two active; once per person, or once per new event after the cooldown
    const earlier = Array.from(
        find(ENROLLMENT, {marketingAutomationId: automation.marketingAutomationId, partyId: event.partyId}).forUpdate(true).list()
    )
    if (earlier.some(row => row.statusId === "AenActive")) return refuse("ALREADY_ENROLLED")
    if (earlier.length && automation.reentryEnumId !== "ArPerEvent") return refuse("ALREADY_ENROLLED")
    if (earlier.length) {
        const latest = Math.max(...earlier.map(row => ms(row.admittedDate) ?? 0))
        if (nowMs() - latest < Number(automation.reentryCooldownDays || 0) * time.dayMs) return refuse("COOLDOWN")
    }
    const person = classifyFor(automation, event.partyId)
    if (person.bucket !== "eligible") return refuse(person.reasonCode || "NOT_ELIGIBLE")
    const steps = stepsAt(automation.marketingAutomationId)
    if (!steps.length) return refuse("NO_STEPS")
    const automationEnrollmentId = call("create#" + ENROLLMENT, {
        marketingAutomationId: automation.marketingAutomationId,
        partyId: event.partyId,
        organizationPartyId: automation.organizationPartyId,
        automationSourceEventId: event.automationSourceEventId,
        sourceKey: event.sourceKey,
        triggerEnumId: event.triggerEnumId,
        definitionDate: ec.user.nowTimestamp,
        admittedDate: ec.user.nowTimestamp,
        admittedByUserId: event.filedByUserId || null,
        statusId: "AenActive",
        nextSequenceNum: Number(steps[0].sequenceNum),
        nextDueDate: ec.user.nowTimestamp
    }).automationEnrollmentId
    call("update#" + EVENT, {
        automationSourceEventId: event.automationSourceEventId,
        statusEnumId: "AseAdmitted",
        automationEnrollmentId,
        processedDate: ec.user.nowTimestamp
    })
    return {admitted: true, reasonCode: null, automationEnrollmentId}
}
// run#AutomationAdmission: each active automation's new source events filed, then its filed events admitted, each in a transaction of
// its own; one that fails is logged and the rest go on. As the system. {automations, filed, admitted, refused, failed}.
function runAdmission(p) {
    const totals = {automations: 0, filed: 0, admitted: 0, refused: 0, failed: 0}
    let query = find(AUTOMATION, {statusId: "MaActive"}).orderBy("lastAdmissionDate").limit(limits.automationsPerRun)
    if (!blank(p.marketingAutomationId)) query = query.condition("marketingAutomationId", text(p.marketingAutomationId))
    for (const automation of Array.from(query.list())) asOwner(automation, () => admitFor(automation, totals))
    return totals
}
function admitFor(automation, totals) {
    totals.automations++
    try {
        totals.filed += Number(
            apart(SERVICES + "collect#AdmissionEvents", {marketingAutomationId: automation.marketingAutomationId}).filed || 0
        )
    } catch (error) {
        totals.failed++
        ec.logger.error(
            "Automation " +
                automation.marketingAutomationId +
                ": its events were not read: " +
                String(error.message).split("\n")[0]
        )
    }
    const filed = Array.from(
        find(EVENT, {marketingAutomationId: automation.marketingAutomationId, statusEnumId: "AseFiled"})
            .orderBy("filedDate")
            .limit(limits.eventsPerRun)
            .list()
    )
    for (const event of filed) {
        try {
            const out = apart(SERVICES + "admit#SourceEvent", {automationSourceEventId: event.automationSourceEventId})
            if (out.admitted) totals.admitted++
            else if (out.reasonCode !== "NOT_ACTIVE" && out.reasonCode !== "NOT_FILED") totals.refused++
        } catch (error) {
            totals.failed++
            ec.logger.error(
                "Automation event " + event.automationSourceEventId + " not admitted: " + String(error.message).split("\n")[0]
            )
        }
    }
}
// collect#AdmissionEvents (internal, its own transaction): one active automation's new source events filed.
function collectEvents(p) {
    const automation = find(AUTOMATION, {marketingAutomationId: text(p.marketingAutomationId)})
        .forUpdate(true)
        .one()
    if (!automation || automation.statusId !== "MaActive") return {filed: 0}
    return asOwner(automation, problem => {
        if (!problem) return {filed: collect(automation)}
        pauseFor(automation, problem)
        return {filed: 0}
    })
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

// handle#OrderPlaced (TrackingServices, the SECA OrderPlacedRecordAttribution after the placement commits): the order's admission
// event filed for each active automation of its seller with the order trigger (of its store, or of every store); P20 adds the
// attribution. A failure of one automation is logged and the next goes on; the placement never waits on it. {filedCount}.
function orderPlaced(p) {
    const order = one("mantle.order.OrderHeader", {orderId: text(p.orderId)})
    if (!order) return {filedCount: 0}
    const part = rows("mantle.order.OrderPart", {orderId: order.orderId}).sort((a, b) =>
        String(a.orderPartSeqId).localeCompare(String(b.orderPartSeqId))
    )[0]
    if (!part?.vendorPartyId || !part.customerPartyId) return {filedCount: 0}
    let filedCount = 0
    for (const automation of rows(AUTOMATION, {
        organizationPartyId: part.vendorPartyId,
        triggerEnumId: "AtrOrderPlaced",
        statusId: "MaActive"
    })) {
        if (automation.productStoreId && automation.productStoreId !== order.productStoreId) continue
        try {
            if (
                fileEvent(automation, {
                    sourceKey: "order:" + order.orderId,
                    sourceId: order.orderId,
                    partyId: part.customerPartyId,
                    eventDate: order.placedDate || ec.user.nowTimestamp
                }).created
            )
                filedCount++
        } catch (error) {
            ec.logger.error(
                "Order " +
                    order.orderId +
                    ": automation " +
                    automation.marketingAutomationId +
                    " event not filed: " +
                    String(error.message).split("\n")[0]
            )
        }
    }
    return {filedCount}
}

// enroll#Party (staff enrollment with evidence, design §6): a dispatcher or an audience editor files a person of the organization with
// their evidence and an operation key (a repeat answers the first), and the event is admitted now by the same rule.
function enrollParty(p) {
    const userScope = enrollmentScope()
    const caps = userScope.capabilities
    if (!caps.dispatch && !caps.audienceEdit)
        denied("PERMISSION_DENIED", "Enrolling a person is a dispatcher's or an audience editor's")
    const automation = automationOf(userScope, p.marketingAutomationId)
    if (automation.triggerEnumId !== "AtrStaff")
        denied("TRIGGER_INVALID", "Automation " + automation.marketingAutomationId + " enrolls by its own trigger, not by staff")
    if (automation.statusId !== "MaActive")
        denied(
            "STATUS_INVALID",
            "Automation " + automation.marketingAutomationId + " is " + statusText(automation.statusId).toLowerCase()
        )
    const evidenceText = text(p.evidenceText)
    if (!evidenceText) denied("EVIDENCE_REQUIRED", "Say what the person asked for, and when")
    const operationKey = text(p.operationKey)
    if (!operationKey) denied("OPERATION_KEY_REQUIRED", "An enrollment needs its operation key")
    const partyId = text(p.partyId)
    const party = partyId ? one("mantle.party.Party", {partyId}) : null
    // a person the caller may not see answers as missing (another user's personal contact, disabled, merged)
    if (!party || !segments.inScopeParties([partyId]).has(partyId))
        denied("RECORD_UNAVAILABLE", "Person " + partyId + " is not available")
    const filed = fileEvent(automation, {
        sourceKey: "staff:" + lib.hash([automation.marketingAutomationId, operationKey]).slice(0, 40),
        sourceId: partyId,
        partyId,
        filedByUserId: ec.user.userId,
        evidenceText: evidenceText.slice(0, 2000)
    })
    const event = one(EVENT, {automationSourceEventId: filed.automationSourceEventId})
    if (event.partyId !== partyId) denied("OPERATION_KEY_USED", "That operation key enrolled someone else")
    // admitted now by the same rule, as the automation's owner (admitEvent signs them in and puts the caller back)
    if (event.statusEnumId === "AseFiled") admitEvent({automationSourceEventId: event.automationSourceEventId})
    const after = one(EVENT, {automationSourceEventId: event.automationSourceEventId})
    return {
        automationSourceEventId: after.automationSourceEventId,
        admitted: after.statusEnumId === "AseAdmitted",
        reasonCode: after.reasonCode || null,
        reasonText: after.reasonCode ? reasonText(after.reasonCode) : "",
        automationEnrollmentId: after.automationEnrollmentId || null,
        alreadyFiled: !filed.created
    }
}

// ===== the steps =====
// run#AutomationSteps: the due steps of the active automations' enrollments, at most perAutomation an automation and
// enrollmentsPerRun in all, each enrollment in a transaction of its own, then each new delivery's first attempt. As the system.
function runSteps(p) {
    const totals = {enrollments: 0, handedOff: 0, failed: 0}
    let query = find(AUTOMATION, {statusId: "MaActive"}).limit(limits.activeAutomations)
    if (!blank(p.marketingAutomationId)) query = query.condition("marketingAutomationId", text(p.marketingAutomationId))
    const automations = new Map(Array.from(query.list()).map(row => [row.marketingAutomationId, row]))
    if (!automations.size) return totals
    const attempt = !(p.attempt === false || p.attempt === "false")
    // the most overdue first across every active automation (P11 review: a fixed first page of automations starved the rest), at most
    // perAutomation an automation and enrollmentsPerRun in all
    const due = Array.from(
        find(ENROLLMENT, {statusId: "AenActive"})
            .condition("marketingAutomationId", "in", Array.from(automations.keys()))
            .condition("nextDueDate", "less-equals", ec.user.nowTimestamp)
            .orderBy("nextDueDate")
            .limit(limits.enrollmentsPerRun * 5)
            .selectField("automationEnrollmentId")
            .selectField("marketingAutomationId")
            .list()
    )
    const byAutomation = new Map()
    for (const row of due) {
        const list = byAutomation.get(row.marketingAutomationId) || []
        if (list.length >= limits.perAutomation || totals.enrollments >= limits.enrollmentsPerRun) continue
        list.push(row.automationEnrollmentId)
        byAutomation.set(row.marketingAutomationId, list)
        totals.enrollments++
    }
    // signed in once as the automation's owner, so each enrollment's step does not sign in again
    for (const [marketingAutomationId, enrollmentIds] of byAutomation)
        asOwner(automations.get(marketingAutomationId), () => {
            for (const automationEnrollmentId of enrollmentIds) {
                let out
                try {
                    out = apart(SERVICES + "process#EnrollmentStep", {automationEnrollmentId})
                } catch (error) {
                    totals.failed++
                    ec.logger.error(
                        "Enrollment " + automationEnrollmentId + " step failed: " + String(error.message).split("\n")[0]
                    )
                    continue
                }
                for (const deliveryId of Array.from(out.deliveryIdList || [])) {
                    totals.handedOff++
                    if (!attempt) continue
                    try {
                        apart("mantle.party.MessageServices.attempt#Delivery", {deliveryId})
                    } catch (error) {
                        ec.logger.error("Delivery " + deliveryId + " attempt failed: " + String(error.message).split("\n")[0])
                    }
                }
            }
        })
    return totals
}
// process#EnrollmentStep (internal, its own transaction): one due enrollment's steps run under its lock, until a wait, a
// postponement or its end. {deliveryIdList, statusId}.
function processEnrollment(p) {
    const enrollment = find(ENROLLMENT, {automationEnrollmentId: text(p.automationEnrollmentId)})
        .forUpdate(true)
        .one()
    const deliveryIdList = []
    if (!enrollment || enrollment.statusId !== "AenActive") return {deliveryIdList}
    if (enrollment.nextDueDate != null && ms(enrollment.nextDueDate) > nowMs()) return {deliveryIdList}
    const automation = one(AUTOMATION, {marketingAutomationId: enrollment.marketingAutomationId})
    if (!automation || automation.statusId !== "MaActive") return {deliveryIdList}
    // as its owner (the user's call, Nov 14): an owner who lost access pauses the automation before any step
    return asOwner(automation, problem => {
        if (!problem) return stepAsOwner(enrollment, automation)
        call("update#" + ENROLLMENT, {automationEnrollmentId: enrollment.automationEnrollmentId, dueNote: problem.slice(0, 250)})
        pauseFor(automation, problem)
        return {deliveryIdList, statusId: "AenActive"}
    })
}
function stepAsOwner(enrollment, automation) {
    const deliveryIdList = []
    const now = nowMs()
    let sequenceNum = Number(enrollment.nextSequenceNum || 0)
    let skipNextSend = enrollment.skipNextSend === "Y"
    // every write keeps where the enrollment is and whether a condition skips its next send
    const update = values =>
        call(
            "update#" + ENROLLMENT,
            Object.assign(
                {
                    automationEnrollmentId: enrollment.automationEnrollmentId,
                    nextSequenceNum: sequenceNum,
                    skipNextSend: skipNextSend ? "Y" : "N"
                },
                values
            )
        )
    const end = (statusId, code) => {
        update({
            statusId,
            statusId_changeReason: endTexts[code] || reasonText(code),
            endReasonCode: code,
            endReason: endTexts[code] || reasonText(code),
            endedDate: ec.user.nowTimestamp,
            nextDueDate: null,
            dueNote: null
        })
        return {deliveryIdList, statusId}
    }
    const postpone = (minutes, note) => {
        update({nextDueDate: new Date(now + minutes * time.minuteMs), dueNote: note})
        return {deliveryIdList, statusId: "AenActive"}
    }
    const pauseAutomation = note => {
        update({dueNote: note})
        pauseFor(automation, note)
        return {deliveryIdList, statusId: "AenActive"}
    }
    // a segment the owner can no longer read (a source, a parent, an old step's condition) pauses the automation with the reason
    const matches = (marketSegmentId, what) => {
        try {
            return {
                met: segmentMatches(automation.organizationPartyId, marketSegmentId, [enrollment.partyId]).has(enrollment.partyId)
            }
        } catch (error) {
            return {
                paused: pauseAutomation(
                    "Its owner " +
                        ownerText(automation.activatedByUserId) +
                        " cannot read its " +
                        what +
                        " (" +
                        String(error.message).split("\n")[0] +
                        ")"
                )
            }
        }
    }
    // the campaign: closed ends pending work; no longer approved pauses the automation (a change outside its approval)
    const campaign = one(CAMPAIGN, {marketingCampaignId: automation.marketingCampaignId})
    if (!campaign || closedCampaignStatuses.includes(campaign.statusId)) return end("AenStopped", "CAMPAIGN_CLOSED")
    if (!sends().approvedCampaignStatuses.includes(campaign.statusId))
        return pauseAutomation("Its campaign is no longer approved: renew the campaign's approval, then resume")
    const steps = stepsAt(automation.marketingAutomationId, enrollment.definitionDate)
    const executions = new Map(
        rows(EXECUTION, {automationEnrollmentId: enrollment.automationEnrollmentId}).map(row => [row.automationStepId, row])
    )
    const record = (step, values) => {
        const made = call(
            "create#" + EXECUTION,
            Object.assign(
                {
                    automationEnrollmentId: enrollment.automationEnrollmentId,
                    marketingAutomationId: enrollment.marketingAutomationId,
                    automationStepId: step.automationStepId,
                    sequenceNum: step.sequenceNum,
                    stepKindEnumId: step.stepKindEnumId,
                    executedDate: ec.user.nowTimestamp
                },
                values
            )
        )
        executions.set(step.automationStepId, Object.assign({automationStepExecutionId: made.automationStepExecutionId}, values))
    }
    for (let guard = 0; guard <= steps.length + 1; guard++) {
        const step = steps.find(row => Number(row.sequenceNum) >= sequenceNum)
        const nextOf = current => {
            const following = steps.find(row => Number(row.sequenceNum) > Number(current.sequenceNum))
            return following ? Number(following.sequenceNum) : Number(current.sequenceNum) + 1
        }
        if (!step) return end("AenCompleted", "COMPLETED")
        // a step already run (a wait still running, or a restart after its commit) goes on from its record
        const done = executions.get(step.automationStepId)
        if (done) {
            if (step.stepKindEnumId === stepKinds.wait && done.dueDate != null && ms(done.dueDate) > now) {
                sequenceNum = Number(step.sequenceNum)
                update({nextDueDate: done.dueDate, dueNote: null})
                return {deliveryIdList, statusId: "AenActive"}
            }
            sequenceNum = nextOf(step)
            continue
        }
        // before every step: the goal, then the enrollment (design §6)
        if (automation.goalSegmentId) {
            const goal = matches(automation.goalSegmentId, "goal segment")
            if (goal.paused) return goal.paused
            if (goal.met) return end("AenCompleted", "GOAL_MET")
        }
        const person = classifyFor(automation, enrollment.partyId)
        if (endingReasons.includes(person.reasonCode)) return end("AenStopped", person.reasonCode)
        if (step.stepKindEnumId === stepKinds.wait) {
            const dueMs = waitDue(now, step, automation)
            record(step, {outcomeEnumId: "AsoWaiting", dueDate: new Date(dueMs)})
            if (dueMs > now) {
                sequenceNum = Number(step.sequenceNum)
                update({nextDueDate: new Date(dueMs), dueNote: null, lastStepDate: ec.user.nowTimestamp})
                return {deliveryIdList, statusId: "AenActive"}
            }
            sequenceNum = nextOf(step)
            continue
        }
        if (step.stepKindEnumId === stepKinds.condition) {
            const condition = matches(step.conditionSegmentId, "condition segment")
            if (condition.paused) return condition.paused
            const met = condition.met
            record(step, {outcomeEnumId: met ? "AsoConditionMet" : "AsoConditionNotMet"})
            if (!met && step.conditionFalseEnumId === "AcfEnd") return end("AenCompleted", "CONDITION_NOT_MET")
            if (!met) skipNextSend = true
            sequenceNum = nextOf(step)
            continue
        }
        // a send step
        if (skipNextSend) {
            record(step, {outcomeEnumId: "AsoSkipped", reasonCode: "CONDITION_SKIP", campaignSendId: step.campaignSendId})
            skipNextSend = false
            sequenceNum = nextOf(step)
            continue
        }
        const send = step.campaignSendId ? one(SEND, {campaignSendId: step.campaignSendId}) : null
        const profile = send?.sendingProfileId ? one(PROFILE, {sendingProfileId: send.sendingProfileId}) : null
        if (
            !send ||
            !profile ||
            profile.purposeEnumId === "MtpTransactional" ||
            (profile.thruDate != null && ms(profile.thruDate) <= now)
        )
            return pauseAutomation(
                "Its sending profile ended or is for transactional messages: change the sender and renew the approval"
            )
        const readiness = profiles.readinessOf(profile)
        if (!readiness.ready)
            return postpone(limits.profileRetryMinutes, "The sending profile is not ready: " + readiness.reasons.join("; "))
        const quiet = profiles.quietMinutes(profile, now)
        if (quiet) return postpone(quiet, "Quiet hours of the sending profile")
        if (person.bucket !== "eligible") {
            // the channel withdrawn, no usable address or no evidence: this send skipped, the enrollment goes on
            record(step, {outcomeEnumId: "AsoSkipped", reasonCode: person.reasonCode, campaignSendId: send.campaignSendId})
            sequenceNum = nextOf(step)
            continue
        }
        const candidate = {partyId: enrollment.partyId, contactMechId: person.contactMechId, destinationKey: person.key}
        const verdicts = dispatch().checkRecipients(send, [candidate], () => "participant")
        const verdict = verdicts?.participant
        if (!verdict) return postpone(limits.profileRetryMinutes, "The step could not be checked: it is tried again")
        if (verdict.reasonCode === "FREQUENCY_CAP")
            return postpone(limits.capRetryMinutes, "Over the organization's frequency cap")
        if (!verdict.eligible) {
            if (endingReasons.includes(verdict.reasonCode)) return end("AenStopped", verdict.reasonCode)
            record(step, {outcomeEnumId: "AsoSkipped", reasonCode: verdict.reasonCode, campaignSendId: send.campaignSendId})
            sequenceNum = nextOf(step)
            continue
        }
        const campaignRecipientId = call("create#" + RECIPIENT, {
            campaignSendId: send.campaignSendId,
            preparedRevision: Number(send.preparedRevision || 1),
            partyId: enrollment.partyId,
            contactMechId: person.contactMechId,
            destinationKey: person.key,
            channelEnumId: send.channelEnumId || "MdcEmail",
            selectedDate: ec.user.nowTimestamp,
            tracked: person.tracked ? "Y" : "N",
            executionKey: ec.user.randomString(20).replace(/[^A-Za-z0-9]/g, "x"),
            statusId: "CrsSelected"
        }).campaignRecipientId
        const recipient = one(RECIPIENT, {campaignRecipientId})
        const queued = dispatch().handOffRecipient(recipient, send, verdict)
        record(step, {
            outcomeEnumId: "AsoHandedOff",
            campaignSendId: send.campaignSendId,
            campaignRecipientId,
            messageDeliveryId: queued.deliveryId
        })
        if (queued.created) deliveryIdList.push(queued.deliveryId)
        sequenceNum = nextOf(step)
        update({lastStepDate: ec.user.nowTimestamp, dueNote: null})
    }
    return {deliveryIdList, statusId: "AenActive"}
}
// handle#OrderPlaced files events as the system (no segment is read); the runs sign in as each automation's owner (asOwner).
const asSystem = action => p => ec.artifactExecution.runAsSystem(() => action(p))

// ===== stop#Enrollment =====
function stopEnrollment(p) {
    const userScope = enrollmentScope()
    const caps = userScope.capabilities
    if (!caps.dispatch && !caps.audienceEdit)
        denied("PERMISSION_DENIED", "Stopping an enrollment is a dispatcher's or an audience editor's")
    const enrollment = enrollmentOf(userScope, p.automationEnrollmentId, true)
    if (!blank(p.expectedRevision) && ms(p.expectedRevision) !== ms(enrollment.lastUpdatedStamp))
        denied("STALE_REVISION", "Enrollment " + enrollment.automationEnrollmentId + " changed since it was read")
    if (enrollment.statusId !== "AenActive")
        denied(
            "STATUS_INVALID",
            "Enrollment " + enrollment.automationEnrollmentId + " is " + statusText(enrollment.statusId).toLowerCase()
        )
    const reason = text(p.reason)
    if (!reason) denied("REASON_REQUIRED", "Say why it stops")
    call("update#" + ENROLLMENT, {
        automationEnrollmentId: enrollment.automationEnrollmentId,
        statusId: "AenStopped",
        statusId_changeReason: "Stopped by " + (ec.user.username || ec.user.userId) + ": " + reason.slice(0, 200),
        endReasonCode: "STOPPED",
        endReason: reason.slice(0, 200),
        endedDate: ec.user.nowTimestamp,
        endedByUserId: ec.user.userId,
        nextDueDate: null,
        dueNote: null
    })
    return {automationEnrollmentId: enrollment.automationEnrollmentId, statusId: "AenStopped"}
}
function enrollmentOf(userScope, automationEnrollmentId, lock = false) {
    const id = text(automationEnrollmentId)
    let query = id ? find(ENROLLMENT, {automationEnrollmentId: id}) : null
    if (query && lock) query = query.forUpdate(true)
    const row = query ? query.one() : null
    if (!row || !marketingAccess.covers(userScope, row.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Enrollment " + id + " is not available")
    return row
}

// ===== projections =====
const masked = address => {
    const value = String(address || "")
    const at = value.indexOf("@")
    return at > 0 ? value[0] + "***" + value.slice(at) : value ? value.slice(0, 2) + "***" : ""
}
function automationRow(row, extra = {}) {
    const campaign = one(CAMPAIGN, {marketingCampaignId: row.marketingCampaignId})
    const topic = row.contactListId ? one("mantle.marketing.contact.ContactList", {contactListId: row.contactListId}) : null
    const profile = row.sendingProfileId ? one(PROFILE, {sendingProfileId: row.sendingProfileId}) : null
    const count = statusId => find(ENROLLMENT, {marketingAutomationId: row.marketingAutomationId, statusId}).count()
    const nextDue = Array.from(
        find(ENROLLMENT, {marketingAutomationId: row.marketingAutomationId, statusId: "AenActive"})
            .orderBy("nextDueDate")
            .limit(1)
            .list()
    )[0]
    const skipped = find(EXECUTION, {marketingAutomationId: row.marketingAutomationId, outcomeEnumId: "AsoSkipped"}).count()
    return Object.assign(
        {
            marketingAutomationId: row.marketingAutomationId,
            automationName: label(row),
            description: row.description || "",
            marketingCampaignId: row.marketingCampaignId,
            campaignName: campaign?.campaignName || row.marketingCampaignId,
            organizationPartyId: row.organizationPartyId,
            organizationName: organizationName(row.organizationPartyId),
            channelText: enumText(row.channelEnumId) || "Email",
            contactListId: row.contactListId,
            topicName: topic ? topic.contactListName || topic.contactListId : "",
            sendingProfileId: row.sendingProfileId || null,
            profileName: profile ? profile.profileName || profile.sendingProfileId : "",
            triggerEnumId: row.triggerEnumId,
            triggerText: enumText(row.triggerEnumId),
            statusId: row.statusId,
            statusText: statusText(row.statusId),
            statusColor: statusColors[row.statusId] || "grey-7",
            automationRevision: Number(row.automationRevision || 1),
            activeCount: count("AenActive"),
            completedCount: count("AenCompleted"),
            stoppedCount: count("AenStopped"),
            skippedCount: skipped,
            nextDueText: nextDue?.nextDueDate ? lib.dateText(nextDue.nextDueDate) : "",
            pauseNote: row.pauseNote || "",
            revision: ms(row.lastUpdatedStamp)
        },
        extra
    )
}
function stepRow(step, automation) {
    const send = step.campaignSendId ? one(SEND, {campaignSendId: step.campaignSendId}) : null
    const segment = step.conditionSegmentId ? one(SEGMENT, {marketSegmentId: step.conditionSegmentId}) : null
    const template = step.messageTemplateId
        ? one("mantle.party.MessageTemplate", {messageTemplateId: step.messageTemplateId})
        : null
    const kind = Object.keys(stepKinds).find(key => stepKinds[key] === step.stepKindEnumId)
    const detail =
        kind === "send"
            ? "Subject: " +
              (send?.preparedSubject || "") +
              (template ? " · from " + (template.templateName || template.messageTemplateId) : "")
            : kind === "wait"
              ? waitText(step) +
                (step.waitUnitEnumId === "AwuDays" || step.waitUnitEnumId === "AwuBusinessDays"
                    ? " (" + (automation.timeZone || "the user's zone") + ")"
                    : "")
              : "Matches " +
                (segment ? segments.segmentLabel(segment) : step.conditionSegmentId) +
                ", else " +
                enumText(step.conditionFalseEnumId).toLowerCase()
    return {
        automationStepId: step.automationStepId,
        sequenceNum: Number(step.sequenceNum),
        position: 0,
        kind,
        stepKindText: enumText(step.stepKindEnumId),
        stepName: step.stepName || "",
        detail,
        campaignSendId: step.campaignSendId || null,
        messageTemplateId: step.messageTemplateId || null,
        templateName: template ? template.templateName || template.messageTemplateId : "",
        subject: send?.preparedSubject || "",
        waitAmount: step.waitAmount == null ? null : Number(step.waitAmount),
        waitUnitEnumId: step.waitUnitEnumId || null,
        conditionSegmentId: step.conditionSegmentId || null,
        conditionFalseEnumId: step.conditionFalseEnumId || null
    }
}

// ===== find#Automations, get#Automation =====
function findAutomations(p) {
    const userScope = readScope()
    const ids = marketingAccess.organizationIds(userScope)
    const organizationPartyId = text(p.organizationPartyId)
    if (organizationPartyId && !marketingAccess.covers(userScope, organizationPartyId))
        denied("ORGANIZATION_DENIED", "Organization " + organizationPartyId + " is not available")
    const scoped = organizationPartyId ? [organizationPartyId] : ids
    const canCreate = !!userScope.capabilities.sendEdit
    if (!scoped.length) return Object.assign(lib.pageList([], p, "automationList"), {canCreate})
    let query = find(AUTOMATION).condition("organizationPartyId", "in", scoped)
    const statusId = text(p.statusId)
    if (!statusId || statusId === "open") query = query.condition("statusId", "not-equals", "MaEnded")
    else if (statusId !== "all") query = query.condition("statusId", statusId)
    if (!blank(p.marketingCampaignId)) query = query.condition("marketingCampaignId", text(p.marketingCampaignId))
    if (!blank(p.triggerEnumId)) query = query.condition("triggerEnumId", text(p.triggerEnumId))
    if (p.mine === "Y" || p.mine === true) query = query.condition("createdByUserId", ec.user.userId)
    if (!blank(p.text)) {
        const factory = ec.entity.conditionFactory
        const like = "%" + text(p.text).replace(/[\\%_]/g, c => "\\" + c) + "%"
        query = query.condition(
            factory.makeCondition(
                ["marketingAutomationId", "automationName"].map(field => factory.makeCondition(field, "like", like).ignoreCase()),
                "or"
            )
        )
    }
    const orderByField = text(p.orderByField)
    const allowedOrder = ["automationName", "-automationName", "createdDate", "-createdDate"]
    query = query.orderBy(allowedOrder.includes(orderByField) ? orderByField : "-createdDate")
    const count = query.count()
    const paged = lib.page(query, p, "automationList", count, {noLimitCap: 1000})
    const automationList = paged.rows.map(row => automationRow(row))
    delete paged.rows
    paged.automationList = automationList
    return Object.assign(paged, {canCreate})
}
function getAutomation(p) {
    const userScope = readScope()
    const row = automationOf(userScope, p.marketingAutomationId)
    const caps = userScope.capabilities
    const steps = stepsAt(row.marketingAutomationId).map(step => stepRow(step, row))
    steps.forEach((step, index) => (step.position = index + 1))
    const revision = Number(row.automationRevision || 1)
    const approval = approvals.currentApproval("automation", row.marketingAutomationId, revision)
    const pending = approvals.pendingRequest(approvals.targetKinds.automation, row.marketingAutomationId, revision)
    const authors = automationKind.authors(row).concat(pending?.decidedByUserId ? [pending.decidedByUserId] : [])
    const problems = row.statusId === "MaEnded" ? [] : automationProblems(row)
    const own = approval ? activationParties(row, approval).has(ec.user.userId) : false
    const segmentName = id => {
        const segment = id ? one(SEGMENT, {marketSegmentId: id}) : null
        return segment ? segments.segmentLabel(segment) : ""
    }
    const store = row.productStoreId ? one("mantle.product.store.ProductStore", {productStoreId: row.productStoreId}) : null
    const editable = editableStatuses.includes(row.statusId)
    return {
        automation: automationRow(row, {
            triggerSegmentId: row.triggerSegmentId || null,
            triggerSegmentName: segmentName(row.triggerSegmentId),
            productStoreId: row.productStoreId || null,
            storeName: store ? store.storeName || store.productStoreId : "",
            formPublicationId: row.formPublicationId || null,
            goalSegmentId: row.goalSegmentId || null,
            goalSegmentName: segmentName(row.goalSegmentId),
            reentryEnumId: row.reentryEnumId || "ArOnce",
            reentryText:
                enumText(row.reentryEnumId || "ArOnce") +
                (row.reentryEnumId === "ArPerEvent" ? " (" + row.reentryCooldownDays + " days)" : ""),
            reentryCooldownDays: row.reentryCooldownDays == null ? null : Number(row.reentryCooldownDays),
            timeZone: row.timeZone || "",
            definitionDateText: lib.dateText(row.definitionDate),
            activatedDateText: row.activatedDate ? lib.dateText(row.activatedDate) : "",
            // the owner its runs sign in as (the user's call, Nov 14)
            ownerName:
                row.activatedByUserId && ["MaActive", "MaPaused"].includes(row.statusId) ? ownerText(row.activatedByUserId) : "",
            endedDateText: row.endedDate ? lib.dateText(row.endedDate) : "",
            endReason: row.endReason || "",
            admissionNote: row.admissionNote || "",
            lastAdmissionText: row.lastAdmissionDate ? lib.dateText(row.lastAdmissionDate) : "",
            maxSteps: maxStepsOf(row.organizationPartyId)
        }),
        steps,
        approvalProblems: problems,
        decisions: approvals.decisionRows(approvals.targetKinds.automation, row.marketingAutomationId),
        awaitingApproval: !!pending,
        capabilities: {
            canEdit: !!caps.sendEdit && editable,
            canRequestApproval: !!caps.sendEdit && row.statusId === "MaDraft" && !problems.length,
            canDecide: !!caps.approve && !!pending && !authors.includes(ec.user.userId),
            canActivate: !!caps.dispatch && row.statusId === "MaApproved" && !!approval && !own,
            canResume: !!caps.dispatch && row.statusId === "MaPaused" && !!approval && !own,
            activateSelf: !!caps.dispatch && own,
            canPause: !!caps.dispatch && row.statusId === "MaActive",
            canEnd: row.statusId !== "MaEnded" && (!!caps.dispatch || (!!caps.sendEdit && !row.activatedDate)),
            canEnroll:
                row.triggerEnumId === "AtrStaff" && row.statusId === "MaActive" && (!!caps.dispatch || !!caps.audienceEdit),
            canReadEnrollments: !!(caps.sendEdit || caps.approve || caps.dispatch || caps.audienceRead)
        }
    }
}

// ===== preview#Automation (Simulation) =====
// A dry run (design §6 Simulation): each current step in order from a start (startDate, now by default) with its due time in the
// rule's zone and its offset, and what it would do; for a sample person (partyId, an audience reader's choice) their eligibility, the
// goal and the conditions as the system sees them now, each send's verdict; synthetic otherwise. Nothing is sent or stored.
function previewAutomation(p) {
    const userScope = readScope()
    const row = automationOf(userScope, p.marketingAutomationId)
    const zone = row.timeZone || ec.user.timeZone || null
    let partyId = text(p.partyId) || null
    if (partyId) {
        if (!userScope.capabilities.audienceRead)
            denied("PERMISSION_DENIED", "Simulating a person's run needs the audience permission")
        if (!segments.inScopeParties([partyId]).has(partyId))
            denied("RECORD_UNAVAILABLE", "Person " + partyId + " is not available")
    }
    const findings = []
    const startMs = blank(p.startDate) ? nowMs() : ms(p.startDate)
    const person = partyId ? classifyFor(row, partyId) : null
    if (person && person.bucket !== "eligible") findings.push("Not admitted now: " + reasonText(person.reasonCode))
    const goalMet =
        partyId && row.goalSegmentId ? segmentMatches(row.organizationPartyId, row.goalSegmentId, [partyId]).has(partyId) : false
    if (goalMet) findings.push("The goal is met already: the enrollment would end before its first step")
    const profile = row.sendingProfileId ? one(PROFILE, {sendingProfileId: row.sendingProfileId}) : null
    let at = startMs
    let skipNext = false
    let ended = false
    const stepList = []
    for (const step of stepsAt(row.marketingAutomationId)) {
        const base = stepRow(step, row)
        let action
        let dueMs = at
        if (ended) action = "Not reached"
        else if (step.stepKindEnumId === stepKinds.wait) {
            dueMs = waitDue(at, step, row)
            action = waitText(step) + ": the next step is due " + zonedText(dueMs, zone)
            at = dueMs
        } else if (step.stepKindEnumId === stepKinds.condition) {
            if (!partyId) action = "Depends on the person: when not met, " + enumText(step.conditionFalseEnumId).toLowerCase()
            else {
                const met = segmentMatches(row.organizationPartyId, step.conditionSegmentId, [partyId]).has(partyId)
                action = met ? "Met: continues" : "Not met: " + enumText(step.conditionFalseEnumId).toLowerCase()
                if (!met && step.conditionFalseEnumId === "AcfEnd") ended = true
                if (!met && step.conditionFalseEnumId !== "AcfEnd") skipNext = true
            }
        } else {
            const quiet = profile ? profiles.quietMinutes(profile, at) : 0
            if (skipNext) {
                action = "Skipped by the condition"
                skipNext = false
            } else if (!partyId) action = "Sends " + base.subject + (quiet ? " after the quiet hours" : "")
            else if (person.bucket !== "eligible") action = "Not sent: " + reasonText(person.reasonCode)
            else {
                const send = one(SEND, {campaignSendId: step.campaignSendId})
                const verdict = dispatch().checkRecipients(
                    send,
                    [{partyId, contactMechId: person.contactMechId, destinationKey: person.key}],
                    () => "sample"
                )?.sample
                action = verdict?.eligible
                    ? "Sends " + base.subject + (quiet ? " after the quiet hours" : "")
                    : verdict?.reasonCode === "FREQUENCY_CAP"
                      ? "Postponed: over the frequency cap"
                      : "Not sent: " + reasonText(verdict?.reasonCode || "NOT_CLASSIFIED")
            }
        }
        stepList.push(Object.assign(base, {dueText: zonedText(dueMs, zone), dueMillis: dueMs, action}))
    }
    if (!stepList.length) findings.push("It has no steps yet")
    return {
        stepList,
        findings,
        sampleText: partyId ? "As the person chosen is now" : "Any eligible subscriber",
        timeZone: zone || "",
        eligibleNow: person ? person.bucket === "eligible" : null
    }
}

// ===== find#Enrollments, get#Enrollment =====
function enrollmentRows(list, unmasked, automationName) {
    const names = unmasked ? lib.partyNames(list.map(row => row.partyId)) : {}
    const addresses = new Map()
    for (const row of list) {
        const info = Array.from(
            find("mantle.party.contact.PartyContactMechInfo", {partyId: row.partyId, contactMechTypeEnumId: "CmtEmailAddress"})
                .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                .limit(1)
                .list()
        )[0]
        addresses.set(row.automationEnrollmentId, info?.infoString || "")
    }
    return list.map(row => ({
        automationEnrollmentId: row.automationEnrollmentId,
        marketingAutomationId: row.marketingAutomationId,
        automationName: automationName || "",
        participant: unmasked
            ? names[row.partyId] || row.partyId
            : masked(addresses.get(row.automationEnrollmentId)) || "A participant",
        partyId: unmasked ? row.partyId : null,
        address: unmasked ? addresses.get(row.automationEnrollmentId) : masked(addresses.get(row.automationEnrollmentId)),
        triggerText: enumText(row.triggerEnumId),
        admittedDateText: lib.dateText(row.admittedDate),
        statusId: row.statusId,
        statusText: statusText(row.statusId),
        statusColor: statusColors[row.statusId] || "grey-7",
        nextSequenceNum: row.nextSequenceNum == null ? null : Number(row.nextSequenceNum),
        nextDueText: row.statusId === "AenActive" && row.nextDueDate ? lib.dateText(row.nextDueDate) : "",
        dueNote: row.dueNote || "",
        endReason: row.endReason || "",
        endedDateText: row.endedDate ? lib.dateText(row.endedDate) : ""
    }))
}
function findEnrollments(p) {
    const userScope = enrollmentScope()
    const automation = automationOf(userScope, p.marketingAutomationId)
    let query = find(ENROLLMENT, {marketingAutomationId: automation.marketingAutomationId})
    const statusId = text(p.statusId)
    if (statusId && statusId !== "all") query = query.condition("statusId", statusId)
    query = query.orderBy("-admittedDate")
    const count = query.count()
    const paged = lib.page(query, p, "enrollmentList", count, {noLimitCap: 1000})
    const enrollmentList = enrollmentRows(paged.rows, !!userScope.capabilities.audienceRead, label(automation))
    delete paged.rows
    paged.enrollmentList = enrollmentList
    return paged
}
function getEnrollment(p) {
    const userScope = enrollmentScope()
    const enrollment = enrollmentOf(userScope, p.automationEnrollmentId)
    const automation = one(AUTOMATION, {marketingAutomationId: enrollment.marketingAutomationId})
    const caps = userScope.capabilities
    const unmasked = !!caps.audienceRead
    const event = enrollment.automationSourceEventId
        ? one(EVENT, {automationSourceEventId: enrollment.automationSourceEventId})
        : null
    const steps = stepsAt(enrollment.marketingAutomationId, enrollment.definitionDate)
    const executions = rows(EXECUTION, {automationEnrollmentId: enrollment.automationEnrollmentId}).sort(
        (a, b) => Number(a.sequenceNum) - Number(b.sequenceNum) || (ms(a.executedDate) ?? 0) - (ms(b.executedDate) ?? 0)
    )
    const history = executions.map(row => {
        const step =
            steps.find(item => item.automationStepId === row.automationStepId) ||
            one(STEP, {automationStepId: row.automationStepId})
        const delivery = row.messageDeliveryId ? one("mantle.party.MessageDelivery", {deliveryId: row.messageDeliveryId}) : null
        return {
            automationStepExecutionId: row.automationStepExecutionId,
            sequenceNum: Number(row.sequenceNum),
            stepText:
                (step ? enumText(step.stepKindEnumId) : enumText(row.stepKindEnumId)) +
                (step?.stepName ? ": " + step.stepName : ""),
            executedDateText: lib.dateText(row.executedDate),
            outcomeText: outcomeTexts[row.outcomeEnumId] || row.outcomeEnumId,
            reasonText: row.reasonCode ? reasonText(row.reasonCode) : "",
            dueText: row.dueDate ? zonedText(ms(row.dueDate), automation.timeZone || null) : "",
            campaignSendId: row.campaignSendId || null,
            campaignRecipientId: row.campaignRecipientId || null,
            deliveryText: delivery ? enumText(delivery.stateEnumId) || delivery.stateEnumId : ""
        }
    })
    const pending =
        enrollment.statusId === "AenActive"
            ? steps.filter(
                  step =>
                      Number(step.sequenceNum) >= Number(enrollment.nextSequenceNum || 0) &&
                      !executions.some(row => row.automationStepId === step.automationStepId)
              ).length
            : 0
    const row = enrollmentRows([enrollment], unmasked, label(automation))[0]
    return {
        enrollment: Object.assign(row, {
            organizationPartyId: enrollment.organizationPartyId,
            sourceText: event ? enumText(event.triggerEnumId) + " · " + lib.dateText(event.eventDate) : "",
            evidenceText: unmasked && event?.evidenceText ? event.evidenceText : "",
            definitionDateText: lib.dateText(enrollment.definitionDate),
            goalSegmentName: automation.goalSegmentId
                ? segments.segmentLabel(one(SEGMENT, {marketSegmentId: automation.goalSegmentId}) || {})
                : "",
            pendingStepCount: pending,
            revision: ms(enrollment.lastUpdatedStamp)
        }),
        history,
        capabilities: {canStop: enrollment.statusId === "AenActive" && (!!caps.dispatch || !!caps.audienceEdit)}
    }
}

const operations = {
    find: findAutomations,
    create: createAutomation,
    get: getAutomation,
    storeRule: storeEnrollmentRule,
    storeSteps,
    preview: previewAutomation,
    activate: activateAutomation,
    pause: pauseAutomation,
    end: endAutomation,
    enroll: enrollParty,
    findEnrollments,
    getEnrollment,
    stopEnrollment,
    runAdmission,
    collect: collectEvents,
    admit: admitEvent,
    runSteps,
    process: processEnrollment,
    orderPlaced: asSystem(orderPlaced)
}
;({
    automationKind,
    limits,
    waitDue,
    zonedText,
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown marketing automation operation " + op)
        return operations[op](parameters || {})
    }
})
