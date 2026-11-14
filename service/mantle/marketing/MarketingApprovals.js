// Marketing's approvals (mantle.marketing.CampaignServices; IronStone Marketing design §3 Approvals, §12 CampaignDefaults, §14.1
// MarketingDecision; impl-marketing P2, F42, §4 Nov 11), on Purchasing's rules (PurchaseApprovals.js): a decision is bound to the
// revision of its target it was asked at, a material change of the target supersedes the earlier revision's requests and
// decisions, and the author never decides their own draft but under the one-person team's flag.
//
// - A target is a campaign (P2), a send (P8) or an automation (P11): targetKinds below says how each is read, its revision, its
//   author, its organization, its recipients and what an approval or a refusal does to it. P2 builds the campaign; the other two
//   are added by their phases (KIND_UNAVAILABLE until then).
// - request: the author asks for approval at the target's current revision (APPROVAL_PENDING when one is pending at it); the
//   holders of MARKETING_APPROVE who work for its organization are told (the kind's topic), the author left out where they may
//   not decide. A failure to notify is logged and the request stays.
// - decide: a holder of MARKETING_APPROVE in the target's organization approves or refuses (a refusal needs its reason,
//   REASON_REQUIRED) the pending request at the revision named: a revision that is not the current one STALE_REVISION (naming
//   it), none pending APPROVAL_NOT_REQUESTED, one already decided ALREADY_DECIDED (the request read locked, so two concurrent
//   decisions decide once), the author SELF_APPROVAL unless the organization's MarketingPolicy has the one-person-team flag on
//   and, for a send, it has fewer than 500 recipients; such a decision is recorded as a self-approval (selfApproval Y).
// - supersede: a material change of a target (CampaignServices: a campaign's organization, parent, dates, currency, budget or
//   manager) marks the earlier revision's live requests and decisions superseded and reads their notices.
// - decisions: a target's requests and decisions, newest first, for a reader of its organization.
//
// Refusals carry reason codes (EntityLib.js denied).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const marketingAccess = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingAccess.js")
const {find, one, rows, denied, call} = lib

const DECISION = "mantle.marketing.campaign.MarketingDecision"
const CAMPAIGN = "mantle.marketing.campaign.MarketingCampaign"
const POLICY = "mantle.marketing.campaign.MarketingPolicy"
// the user's call (§4 Nov 11): under the one-person-team flag an author approves their own send to fewer than this many recipients
const selfApprovalLimit = 500

const text = value => (value == null ? "" : String(value).trim())
const nowMs = () => lib.ms(ec.user.nowTimestamp)
const partyName = partyId => (partyId ? lib.partyNames([partyId])[partyId] || partyId : "")
const organizationName = partyId => (partyId ? one("mantle.party.Organization", {partyId})?.organizationName || partyId : "")

// ===== policy =====
// The organization's MarketingPolicy in effect at a date (now by default), or null: none means the defaults (no self-approval, a
// manager required).
function policyOf(organizationPartyId, date = ec.user.nowTimestamp) {
    if (!organizationPartyId) return null
    return (
        rows(POLICY, {organizationPartyId})
            .filter(row => lib.active(row, date))
            .sort((a, b) => (lib.ms(b.fromDate) ?? 0) - (lib.ms(a.fromDate) ?? 0))[0] || null
    )
}
// Whether the author may decide their own draft (the one-person team's flag, §4 Nov 11): with the flag on, a campaign (which
// sends nothing itself: each of its sends is approved on its own) and a send to fewer than 500 recipients; never with the flag off,
// never a send of 500 or more (or of an unknown count), never an automation (its steps send without a count).
function selfApprovalAdmits(policy, kindKey, recipientCount) {
    if (policy?.selfApprovalAllowed !== "Y") return false
    if (kindKey === "campaign") return true
    if (kindKey === "send") return recipientCount != null && Number(recipientCount) < selfApprovalLimit
    return false
}

// ===== targets =====
const campaignStatusText = {
    MKTG_CAMP_PLANNED: "Planned",
    MKTG_CAMP_APPROVED: "Approved",
    MKTG_CAMP_INPROGRESS: "In progress",
    MKTG_CAMP_COMPLETED: "Completed",
    MKTG_CAMP_CANCELLED: "Cancelled"
}
// What approval needs of a campaign (design §3: organization, dates, budget currency, responsible parties); the problems found.
function campaignProblems(campaign, policy) {
    const problems = []
    if (marketingAccess.unowned(campaign.organizationPartyId)) problems.push("it belongs to no organization")
    if (!campaign.fromDate || !campaign.thruDate) problems.push("it needs its dates")
    else if (lib.ms(campaign.thruDate) <= lib.ms(campaign.fromDate)) problems.push("it ends before it starts")
    if ((campaign.budgetedCost != null || campaign.estimatedCost != null) && !campaign.costUomId)
        problems.push("its budget needs a currency")
    if (policy?.managerRequired !== "N") {
        const managers = rows("mantle.marketing.campaign.MarketingCampaignParty", {
            marketingCampaignId: campaign.marketingCampaignId,
            roleTypeId: "MarketingCampaignManager"
        }).filter(row => lib.active(row))
        if (!managers.length) problems.push("it needs a manager")
    }
    return problems
}
// Each kind of target: its decision target enum, topic, how it is read and what a decision does to it.
const targetKinds = {
    campaign: {
        name: "Campaign",
        enumId: "MdtCampaign",
        topic: "MarketingCampaignApproval",
        entity: CAMPAIGN,
        read: (targetId, lock) => {
            const query = find(CAMPAIGN, {marketingCampaignId: targetId})
            return (lock ? query.forUpdate(true) : query).one()
        },
        revision: row => Number(row.campaignRevision || 1),
        organization: row => row.organizationPartyId,
        authors: row => [row.createdByUserId].filter(Boolean),
        label: row => row.campaignName || row.marketingCampaignId,
        recipientCount: () => null,
        // approval is asked of a planned campaign only
        requestable: row => {
            if (row.statusId !== "MKTG_CAMP_PLANNED")
                denied(
                    "STATUS_INVALID",
                    "Campaign " + row.marketingCampaignId + " is " + (campaignStatusText[row.statusId] || row.statusId)
                )
        },
        problems: (row, policy) => campaignProblems(row, policy),
        approved: row =>
            call("update#" + CAMPAIGN, {
                marketingCampaignId: row.marketingCampaignId,
                statusId: "MKTG_CAMP_APPROVED",
                statusId_changeReason: "Approved by " + (ec.user.username || ec.user.userId)
            }),
        refused: () => {},
        linkFields: row => ({marketingCampaignId: row.marketingCampaignId})
    }
    // send (P8) and automation (P11) join here
}
const kindOf = kindKey => {
    if (!Object.hasOwn(targetKinds, kindKey)) denied("KIND_UNAVAILABLE", "Approval of " + kindKey + " is not available")
    return targetKinds[kindKey]
}
const kindByEnum = enumId => Object.entries(targetKinds).find(([, kind]) => kind.enumId === enumId)?.[0] || null

// A target the caller may act on in their scope: missing or outside it RECORD_UNAVAILABLE, a reader's scope.
function targetOf(userScope, kindKey, targetId, lock = false) {
    const kind = kindOf(kindKey)
    const row = targetId ? kind.read(targetId, lock) : null
    if (!row || !marketingAccess.covers(userScope, kind.organization(row)))
        denied("RECORD_UNAVAILABLE", kind.name + " " + (targetId || "") + " is not available")
    return {kind, row}
}

// The live (not superseded) rows of a target.
function liveRows(kind, targetId) {
    return Array.from(
        find(DECISION, {targetKindEnumId: kind.enumId, targetId})
            .condition("supersededDate", "is-null", null)
            .orderBy("-decisionDate")
            .list()
    )
}
// The live request at a revision with no decision yet, or null.
function pendingRequest(kind, targetId, revision) {
    const live = liveRows(kind, targetId)
    const decided = new Set(live.filter(row => row.requestDecisionId).map(row => row.requestDecisionId))
    return (
        live.find(
            row =>
                row.decisionEnumId === "MddRequested" &&
                Number(row.targetRevision) === revision &&
                !decided.has(row.marketingDecisionId)
        ) || null
    )
}
// The live approval of a target at its revision, or null: what a campaign's start needs (CampaignServices).
function currentApproval(kindKey, targetId, revision) {
    const kind = kindOf(kindKey)
    return (
        liveRows(kind, targetId).find(row => row.decisionEnumId === "MddApproved" && Number(row.targetRevision) === revision) ||
        null
    )
}

// ===== notices =====
// The holders of MARKETING_APPROVE who work for the organization (an agent or employee), enabled.
function approvers(organizationPartyId) {
    const groupIds = rows("moqui.security.UserGroupPermission", {userPermissionId: "MARKETING_APPROVE"})
        .filter(row => lib.active(row))
        .map(row => row.userGroupId)
    if (!groupIds.length || !organizationPartyId) return []
    const userIds = new Set()
    for (const member of Array.from(find("moqui.security.UserGroupMember").condition("userGroupId", "in", groupIds).list())) {
        if (!lib.active(member) || userIds.has(member.userId)) continue
        const account = one("moqui.security.UserAccount", {userId: member.userId})
        if (!account?.partyId || account.disabled === "Y") continue
        const works = find("mantle.party.PartyRelationship")
            .condition({fromPartyId: account.partyId, toPartyId: organizationPartyId})
            .condition("relationshipTypeEnumId", "in", ["PrtAgent", "PrtEmployee"])
            .list()
        if (Array.from(works).some(row => lib.active(row))) userIds.add(member.userId)
    }
    return Array.from(userIds)
}
// Reads every unread notice of the kind's topic on the target, so they leave each approver's list (a decision, a supersession).
function clearNotices(kind, targetId) {
    const messageIds = rows("moqui.security.user.NotificationMessage", {
        topic: kind.topic,
        recordEntityName: kind.entity,
        recordId: targetId
    }).map(row => row.notificationMessageId)
    if (!messageIds.length) return
    for (const user of Array.from(
        find("moqui.security.user.NotificationMessageUser")
            .condition("notificationMessageId", "in", messageIds)
            .condition("viewedDate", "is-null", null)
            .list()
    ))
        call("update#moqui.security.user.NotificationMessageUser", {
            notificationMessageId: user.notificationMessageId,
            userId: user.userId,
            viewedDate: ec.user.nowTimestamp
        })
}
// Tells the approvers of the target's organization; the author left out unless they may decide their own. The number told.
function notify(kindKey, kind, row, revision, policy, authorIds) {
    try {
        const selfAllowed = selfApprovalAdmits(policy, kindKey, kind.recipientCount(row))
        const userIds = approvers(kind.organization(row)).filter(userId => selfAllowed || !authorIds.includes(userId))
        if (!userIds.length) return 0
        const targetId = row[Object.keys(kind.linkFields(row))[0]]
        ec.makeNotificationMessage()
            .topic(kind.topic)
            .message(
                Object.assign(
                    {
                        targetKind: kindKey,
                        targetId,
                        targetRevision: revision,
                        targetName: kind.label(row),
                        organizationPartyId: kind.organization(row),
                        organizationName: organizationName(kind.organization(row))
                    },
                    kind.linkFields(row)
                )
            )
            .record(kind.entity, targetId)
            .actorUserId(ec.user.userId)
            .userIds(userIds)
            .send()
        return userIds.length
    } catch (error) {
        ec.logger.error("Marketing approval notice of " + kindKey + " " + kind.label(row) + " was not sent: " + error.message)
        return 0
    }
}

// ===== request#MarketingApproval =====
function request(p) {
    const userScope = marketingAccess.scope()
    const kindKey = text(p.targetKind) || "campaign"
    const kind = kindOf(kindKey)
    // the author's: the edit permission of the kind (P2: a campaign)
    marketingAccess.requireCapability(userScope, kindKey === "campaign" ? "campaignEdit" : "sendEdit")
    const targetId = text(p.targetId)
    const {row} = targetOf(userScope, kindKey, targetId, true)
    kind.requestable(row)
    const revision = kind.revision(row)
    if (p.targetRevision != null && p.targetRevision !== "" && Number(p.targetRevision) !== revision)
        denied("STALE_REVISION", kind.name + " " + targetId + " is at revision " + revision + "; review it again")
    const policy = policyOf(kind.organization(row))
    const problems = kind.problems(row, policy)
    if (problems.length) denied("NOT_READY", kind.name + " " + targetId + " cannot be approved yet: " + problems.join(", "))
    if (pendingRequest(kind, targetId, revision))
        denied("APPROVAL_PENDING", kind.name + " " + targetId + " already awaits approval at revision " + revision)
    const marketingDecisionId = call("create#" + DECISION, {
        targetKindEnumId: kind.enumId,
        targetId,
        targetRevision: revision,
        organizationPartyId: kind.organization(row),
        decisionEnumId: "MddRequested",
        recipientCount: kind.recipientCount(row),
        marketingPolicyId: policy?.marketingPolicyId || null,
        policyFromDate: policy?.fromDate || null,
        decisionDate: ec.user.nowTimestamp,
        decidedByUserId: ec.user.userId,
        decidedByPartyId: ec.user.userAccount?.partyId || null,
        reason: text(p.reason) || null
    }).marketingDecisionId
    const authorIds = Array.from(new Set(kind.authors(row).concat([ec.user.userId])))
    const notifiedCount = notify(kindKey, kind, row, revision, policy, authorIds)
    return {marketingDecisionId, targetRevision: revision, notifiedCount}
}

// ===== decide#MarketingApproval =====
function decide(p) {
    const userScope = marketingAccess.scope()
    marketingAccess.requireCapability(userScope, "approve")
    const kindKey = text(p.targetKind) || "campaign"
    const kind = kindOf(kindKey)
    const decision = text(p.decision)
    if (!["approve", "refuse"].includes(decision)) denied("DECISION_INVALID", "Approve or refuse")
    const reason = text(p.reason)
    if (decision === "refuse" && !reason) denied("REASON_REQUIRED", "A refusal needs its reason")
    const targetId = text(p.targetId)
    // the target read locked: two decisions of one draft at once decide once
    const {row} = targetOf(userScope, kindKey, targetId, true)
    const revision = kind.revision(row)
    if (p.targetRevision == null || p.targetRevision === "")
        denied("REVISION_REQUIRED", "Name the revision of " + kind.name.toLowerCase() + " " + targetId + " you reviewed")
    if (Number(p.targetRevision) !== revision)
        denied("STALE_REVISION", kind.name + " " + targetId + " is at revision " + revision + "; review it again")
    const pending = pendingRequest(kind, targetId, revision)
    if (!pending) {
        const decided = liveRows(kind, targetId).some(
            row => row.requestDecisionId && Number(row.targetRevision) === revision && row.decisionEnumId !== "MddRequested"
        )
        if (decided) denied("ALREADY_DECIDED", kind.name + " " + targetId + " revision " + revision + " is already decided")
        denied("APPROVAL_NOT_REQUESTED", kind.name + " " + targetId + " does not await approval")
    }
    const policy = policyOf(kind.organization(row))
    const recipientCount = kind.recipientCount(row)
    const authorIds = Array.from(new Set(kind.authors(row).concat([pending.decidedByUserId].filter(Boolean))))
    const own = authorIds.includes(ec.user.userId)
    if (own && !selfApprovalAdmits(policy, kindKey, recipientCount))
        denied(
            "SELF_APPROVAL",
            "You wrote or submitted " + kind.name.toLowerCase() + " " + targetId + "; another approver decides it"
        )
    if (decision === "approve") {
        const problems = kind.problems(row, policy)
        if (problems.length) denied("NOT_READY", kind.name + " " + targetId + " cannot be approved: " + problems.join(", "))
    }
    const marketingDecisionId = call("create#" + DECISION, {
        targetKindEnumId: kind.enumId,
        targetId,
        targetRevision: revision,
        organizationPartyId: kind.organization(row),
        decisionEnumId: decision === "approve" ? "MddApproved" : "MddRefused",
        requestDecisionId: pending.marketingDecisionId,
        selfApproval: own ? "Y" : "N",
        recipientCount,
        marketingPolicyId: policy?.marketingPolicyId || null,
        policyFromDate: policy?.fromDate || null,
        decisionDate: ec.user.nowTimestamp,
        decidedByUserId: ec.user.userId,
        decidedByPartyId: ec.user.userAccount?.partyId || null,
        reason: reason || null
    }).marketingDecisionId
    if (decision === "approve") kind.approved(row)
    else kind.refused(row)
    clearNotices(kind, targetId)
    return {marketingDecisionId, decision, targetRevision: revision, selfApproval: own}
}
// The topics' handlers (approve#MarketingTarget, refuse#MarketingTarget): decide at the revision the notice names; a notice with none
// is refused (REVISION_REQUIRED), one of another record too (SOURCE_INVALID).
function decideNotice(p, decision) {
    const message = p.message || {}
    const kindKey = text(message.targetKind)
    const kind = kindOf(kindKey)
    if (text(p.recordEntityName) && text(p.recordEntityName) !== kind.entity)
        denied("SOURCE_INVALID", "This notice is not of a marketing " + kindKey)
    if (text(message.targetId) && text(message.targetId) !== text(p.recordId))
        denied("SOURCE_INVALID", "This notice names another record")
    if (message.targetRevision == null || message.targetRevision === "")
        denied("REVISION_REQUIRED", "The notice names no revision; open the record to decide")
    return decide({
        targetKind: kindKey,
        targetId: text(p.recordId),
        targetRevision: message.targetRevision,
        decision,
        reason: p.reason
    })
}
const approveNotice = p => decideNotice(p, "approve")
const refuseNotice = p => decideNotice(p, "refuse")

// ===== supersede (a material change) =====
// Marks the live requests and decisions of revisions before the target's new one superseded and reads their notices; the count.
function supersede(kindKey, targetId, newRevision) {
    const kind = kindOf(kindKey)
    let count = 0
    for (const row of liveRows(kind, targetId)) {
        if (Number(row.targetRevision) >= newRevision) continue
        call("update#" + DECISION, {marketingDecisionId: row.marketingDecisionId, supersededDate: ec.user.nowTimestamp})
        count++
    }
    if (count) clearNotices(kind, targetId)
    return count
}

// ===== get#Decisions =====
const decisionText = {MddRequested: "Approval requested", MddApproved: "Approved", MddRefused: "Refused"}
// A target's requests and decisions, newest first (as of a date for a print: rows decided by then), each with who and why.
function decisions(p) {
    const userScope = marketingAccess.scope()
    if (!userScope.capabilities.anyRead) denied("PERMISSION_DENIED", "Marketing is not open to you")
    const kindKey = text(p.targetKind) || "campaign"
    const kind = kindOf(kindKey)
    const targetId = text(p.targetId)
    const {row} = targetOf(userScope, kindKey, targetId)
    return {decisions: decisionRows(kind, targetId, p.asOf), targetRevision: kind.revision(row)}
}
function decisionRows(kind, targetId, asOf) {
    const asOfMs = asOf ? lib.ms(asOf) : null
    const found = rows(DECISION, {targetKindEnumId: kind.enumId, targetId})
        .filter(row => asOfMs == null || (lib.ms(row.decisionDate) ?? 0) <= asOfMs)
        .sort((a, b) => (lib.ms(b.decisionDate) ?? 0) - (lib.ms(a.decisionDate) ?? 0))
    const names = lib.partyNames(found.map(row => row.decidedByPartyId))
    return found.map(row => {
        const superseded = !!row.supersededDate && (asOfMs == null || lib.ms(row.supersededDate) <= asOfMs)
        return {
            marketingDecisionId: row.marketingDecisionId,
            decisionEnumId: row.decisionEnumId,
            decisionText:
                (decisionText[row.decisionEnumId] || row.decisionEnumId) + (row.selfApproval === "Y" ? " (self-approval)" : ""),
            targetRevision: row.targetRevision,
            selfApproval: row.selfApproval === "Y",
            decisionDateText: lib.dateText(row.decisionDate),
            decidedByName: names[row.decidedByPartyId] || row.decidedByUserId || "",
            reason: row.reason || "",
            superseded,
            supersededDateText: superseded ? lib.dateText(row.supersededDate) : "",
            stateText: superseded ? "Ended by a later change" : "Current"
        }
    })
}
// The approvals awaiting a decision in the organizations named, by kind (Home's card and attention): the live requests with no
// decision, at their target's current revision.
function pendingRows(organizationPartyIds) {
    if (!organizationPartyIds.length) return []
    const live = Array.from(
        find(DECISION)
            .condition("organizationPartyId", "in", organizationPartyIds)
            .condition("supersededDate", "is-null", null)
            .list()
    )
    const decided = new Set(live.filter(row => row.requestDecisionId).map(row => row.requestDecisionId))
    return live.filter(row => row.decisionEnumId === "MddRequested" && !decided.has(row.marketingDecisionId))
}

const operations = {request, decide, approveNotice, refuseNotice, decisions}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown marketing approval operation " + op)
        return operations[op](parameters || {})
    },
    selfApprovalLimit,
    selfApprovalAdmits,
    policyOf,
    targetKinds,
    kindByEnum,
    currentApproval,
    pendingRequest,
    pendingRows,
    supersede,
    decisionRows,
    campaignProblems,
    approvers
})
