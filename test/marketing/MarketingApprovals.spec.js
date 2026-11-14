// Marketing's approvals (impl-marketing P2, F42, §4 Nov 11; design-marketing §3 Approvals, §12 CampaignDefaults;
// mantle.marketing.CampaignServices request#, decide#MarketingApproval, approve# and refuse#MarketingTarget over
// MarketingApprovals.js), on Purchasing's rules: the approvers of the organization are told, the author not; a decision is bound to
// the revision it was asked at (a stale one refused naming the current one) and made once per draft; a material change ends the
// approval and returns the campaign to review; the author never decides their own, except under the one-person-team flag, for a
// campaign and a send to fewer than 500 recipients, recorded as a self-approval; the topic's handlers decide at the notice's
// revision; another organization's approver and a non-approver are refused. Standalone: spec-local organizations and users.
// Run: ./moq test mr-mantle --spec MarketingApprovals
const lib = ec.resource.script("component://mr-mantle/test/marketing/MarketingSpecLib.js")
const {row, rows, system, organization, user, as, C, revisionOf, campaign} = lib
const approvalsModule = "component://mr-mantle/service/mantle/marketing/MarketingApprovals.js"
const prefix = "MKA"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const users = {}
const CAMPAIGN = "mantle.marketing.campaign.MarketingCampaign"

// The users told of a campaign's approval and whether each notice is still unread.
function notices(marketingCampaignId) {
    const messageIds = rows("moqui.security.user.NotificationMessage", {
        topic: "MarketingCampaignApproval",
        recordEntityName: CAMPAIGN,
        recordId: marketingCampaignId
    }).map(found => found.notificationMessageId)
    const out = {}
    for (const messageId of messageIds)
        for (const found of rows("moqui.security.user.NotificationMessageUser", {notificationMessageId: messageId}))
            out[found.userId] = found.viewedDate ? "read" : "unread"
    return out
}
const decide = (username, id, decision, extra = {}) =>
    as(
        username,
        C + "decide#MarketingApproval",
        Object.assign({targetId: id, targetRevision: revisionOf(id).targetRevision, decision}, extra)
    )
const request = (username, id) => as(username, C + "request#MarketingApproval", {targetId: id})

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Approvals A")
            organization(orgB, "Approvals B")
            users.author = user(prefix, "author", [orgA], ["MARKETING_VIEW", "MARKETING_CAMPAIGN_EDIT"])
            // a one-person team: writes and approves
            users.solo = user(prefix, "solo", [orgA], ["MARKETING_VIEW", "MARKETING_CAMPAIGN_EDIT", "MARKETING_APPROVE"])
            users.approver = user(prefix, "approver", [orgA], ["MARKETING_VIEW", "MARKETING_APPROVE"])
            users.approverB = user(prefix, "approverB", [orgB], ["MARKETING_VIEW", "MARKETING_APPROVE"])
            users.reader = user(prefix, "reader", [orgA], ["MARKETING_VIEW"])
            users.configurer = user(prefix, "configurer", [orgA], ["MARKETING_VIEW", "MARKETING_CONFIGURE"])
        })
    }
})

feature(
    "a request tells the organization's approvers, not the author; a decision at a stale revision is refused, and a draft is decided once",
    {
        when() {
            const id = campaign(users.author, orgA, {campaignName: "Approve me"})
            const noDates = campaign(users.author, orgA, {campaignName: "Not ready", fromDate: null, thruDate: null})
            const notReady = request(users.author, noDates)
            const asked = request(users.author, id)
            const twice = request(users.author, id)
            const told = notices(id)
            const stale = decide(users.approver, id, "approve", {targetRevision: 7})
            const reader = decide(users.reader, id, "approve")
            const other = decide(users.approverB, id, "approve")
            const noReason = decide(users.approver, id, "refuse")
            const approved = decide(users.approver, id, "approve")
            const again = decide(users.approver, id, "approve")
            return {
                asked,
                twice,
                notReady,
                told,
                stale,
                reader,
                other,
                noReason,
                approved,
                again,
                status: revisionOf(id).row.statusId,
                after: notices(id),
                decisions: as(users.reader, C + "get#Decisions", {targetId: id})
            }
        },
        then({asked, twice, notReady, told, stale, reader, other, noReason, approved, again, status, after, decisions}) {
            notReady.refusal.includes("NOT_READY") && notReady.refusal.includes("dates")
            asked.refusal == "" && asked.targetRevision == 1
            twice.refusal.includes("APPROVAL_PENDING")
            told[users.approver] == "unread" && told[users.solo] == "unread"
            told[users.author] == null && told[users.approverB] == null
            stale.refusal.includes("STALE_REVISION") && stale.refusal.includes("revision 1")
            reader.refusal.includes("PERMISSION_DENIED")
            other.refusal.includes("RECORD_UNAVAILABLE")
            noReason.refusal.includes("REASON_REQUIRED")
            approved.refusal == "" && approved.selfApproval == false && status == "MKTG_CAMP_APPROVED"
            again.refusal.includes("ALREADY_DECIDED")
            after[users.approver] == "read" && after[users.solo] == "read"
            decisions.decisions.length == 2 && decisions.decisions[0].decisionText == "Approved"
        }
    }
)

feature("a material change ends the approval: the campaign returns to review, its notices read, and start needs a new approval", {
    when() {
        const id = campaign(users.author, orgA, {campaignName: "Changed"})
        request(users.author, id)
        decide(users.approver, id, "approve")
        const approvedRevision = revisionOf(id).targetRevision
        // a summary is no material change; the budget is
        as(users.author, C + "store#Campaign", {
            marketingCampaignId: id,
            expectedRevision: revisionOf(id).expectedRevision,
            campaignSummary: "Words"
        })
        const afterSummary = revisionOf(id).row.statusId
        const budget = as(users.author, C + "store#CampaignBudget", {
            marketingCampaignId: id,
            expectedRevision: revisionOf(id).expectedRevision,
            budgetedCost: "2500",
            explanation: "Bigger"
        })
        const after = revisionOf(id)
        const start = as(users.author, C + "start#Campaign", {marketingCampaignId: id, expectedRevision: after.expectedRevision})
        const oldDecision = decide(users.approver, id, "approve", {targetRevision: approvedRevision})
        const decisions = as(users.reader, C + "get#Decisions", {targetId: id}).decisions
        const reasked = request(users.author, id)
        const reapproved = decide(users.approver, id, "approve")
        return {approvedRevision, afterSummary, budget, after, start, oldDecision, decisions, reasked, reapproved}
    },
    then({approvedRevision, afterSummary, budget, after, start, oldDecision, decisions, reasked, reapproved}) {
        approvedRevision == 1 && afterSummary == "MKTG_CAMP_APPROVED"
        budget.refusal == "" && after.targetRevision == 2 && after.row.statusId == "MKTG_CAMP_PLANNED"
        start.refusal.includes("STATUS_INVALID")
        oldDecision.refusal.includes("STALE_REVISION")
        decisions.length == 2 && decisions.every(found => found.superseded)
        reasked.refusal == "" && reasked.targetRevision == 2
        reapproved.refusal == ""
    }
})

feature("whoever made a revision's material change does not approve it, the flag off (P2 review)", {
    when() {
        const id = campaign(users.author, orgA, {campaignName: "Revised by an approver"})
        // the one-person team's member raises the budget of a colleague's campaign; the colleague asks
        const budget = as(users.solo, C + "store#CampaignBudget", {
            marketingCampaignId: id,
            expectedRevision: revisionOf(id).expectedRevision,
            budgetedCost: "1800"
        })
        const asked = request(users.author, id)
        const told = notices(id)
        const own = decide(users.solo, id, "approve")
        const other = decide(users.approver, id, "approve")
        return {budget, asked, told, own, other}
    },
    then({budget, asked, told, own, other}) {
        budget.refusal == "" && asked.refusal == "" && asked.targetRevision == 2
        told[users.solo] == null && told[users.approver] == "unread"
        own.refusal.includes("SELF_APPROVAL")
        other.refusal == ""
    }
})

feature(
    "the author never approves their own but under the one-person-team flag, recorded as a self-approval; a send at 500 recipients never",
    {
        when() {
            const id = campaign(users.solo, orgA, {campaignName: "Solo"})
            request(users.solo, id)
            const own = decide(users.solo, id, "approve")
            // the policy's flag on
            as(users.configurer, C + "store#MarketingPolicy", {organizationPartyId: orgA, selfApprovalAllowed: "Y"})
            const self = decide(users.solo, id, "approve")
            // by its kind too: a send of another spec may have the same id (P9)
            const selfRow = rows("mantle.marketing.campaign.MarketingDecision", {
                targetKindEnumId: "MdtCampaign",
                targetId: id,
                decisionEnumId: "MddApproved"
            })[0]
            // a send's rule (P8 sends it): under 500 with the flag on, never at 500, never with the flag off
            const approvals = ec.resource.script(approvalsModule)
            const on = {selfApprovalAllowed: "Y"}
            const rule = {
                under: approvals.selfApprovalAdmits(on, "send", 499),
                at: approvals.selfApprovalAdmits(on, "send", 500),
                unknown: approvals.selfApprovalAdmits(on, "send", null),
                off: approvals.selfApprovalAdmits({selfApprovalAllowed: "N"}, "send", 10),
                none: approvals.selfApprovalAdmits(null, "campaign", null),
                automation: approvals.selfApprovalAdmits(on, "automation", 1)
            }
            return {own, self, selfRow, rule, limit: approvals.selfApprovalLimit}
        },
        then({own, self, selfRow, rule, limit}) {
            own.refusal.includes("SELF_APPROVAL")
            self.refusal == "" && self.selfApproval == true && selfRow.selfApproval == "Y"
            limit == 500
            rule.under == true && rule.at == false && rule.unknown == false
            rule.off == false && rule.none == false && rule.automation == false
        }
    }
)

feature("the topic's handlers decide at the notice's revision; a notice with none or of another record is refused", {
    when() {
        const id = campaign(users.author, orgA, {campaignName: "From the inbox"})
        request(users.author, id)
        const message = {targetKind: "campaign", targetId: id, targetRevision: revisionOf(id).targetRevision}
        const noRevision = as(users.approver, C + "approve#MarketingTarget", {
            recordEntityName: CAMPAIGN,
            recordId: id,
            message: {targetKind: "campaign", targetId: id}
        })
        const otherRecord = as(users.approver, C + "approve#MarketingTarget", {
            recordEntityName: CAMPAIGN,
            recordId: "MKA_X",
            message
        })
        const refused = as(users.approver, C + "refuse#MarketingTarget", {
            recordEntityName: CAMPAIGN,
            recordId: id,
            message,
            reason: "Dates clash"
        })
        return {
            noRevision,
            otherRecord,
            refused,
            status: revisionOf(id).row.statusId,
            last: rows("mantle.marketing.campaign.MarketingDecision", {
                targetKindEnumId: "MdtCampaign",
                targetId: id,
                decisionEnumId: "MddRefused"
            })
        }
    },
    then({noRevision, otherRecord, refused, status, last}) {
        noRevision.refusal.includes("REVISION_REQUIRED")
        otherRecord.refusal.includes("SOURCE_INVALID")
        refused.refusal == "" && refused.decision == "refuse"
        status == "MKTG_CAMP_PLANNED" && last.length == 1 && last[0].reason == "Dates clash"
    }
})
