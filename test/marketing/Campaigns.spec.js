// Marketing's campaigns (impl-marketing P2; design-marketing §3 Campaigns and CampaignDetail, §12, §14.1, §14.3;
// mantle.marketing.CampaignServices over MarketingCampaigns.js, MarketingCosts.js and MarketingPolicies.js): a campaign is made in an
// organization of the author's scope, its MarketingOrganization row mirrored to organizationPartyId, and another organization's
// author finds none of it; the native flow (start only with the approval of the current revision, completion refused with its
// pending work, cancellation); every write at the revision read; the organization's successor mirrored, refused once it has costs;
// a link to another organization's record refused; a cost manual or one Accounting line, never both, a line counted once and within
// its amount, read with Accounting's own permission and masked without it, corrected by reversal; duplication; the policy at the
// revision read and the vocabulary; the lifecycle participant's moves. Standalone: spec-local organizations, users and records.
// Run: ./moq test mr-mantle --spec Campaigns
const lib = ec.resource.script("component://mr-mantle/test/marketing/MarketingSpecLib.js")
const {make, row, rows, system, organization, user, as, C, revisionOf, campaign} = lib
const prefix = "MKC"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const users = {}
const view = ["MARKETING_VIEW"]
const edit = ["MARKETING_VIEW", "MARKETING_CAMPAIGN_EDIT"]

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Campaigns A")
            organization(orgB, "Campaigns B")
            users.author = user(prefix, "author", [orgA], edit)
            users.finance = user(prefix, "finance", [orgA], edit.concat(["ACCOUNTING_VIEW"]))
            users.authorB = user(prefix, "authorB", [orgB], edit)
            users.reader = user(prefix, "reader", [orgA], view)
            users.configurer = user(prefix, "configurer", [orgA], ["MARKETING_VIEW", "MARKETING_CONFIGURE"])
            users.approver = user(prefix, "approver", [orgA], ["MARKETING_VIEW", "MARKETING_APPROVE"])
            users.operator = user(prefix, "operator", [], ["MARKETING_OWNER_CHANGE"])
            users.mate = user(prefix, "mate", [orgA], edit)
            make("mantle.marketing.contact.ContactList", {
                contactListId: prefix + "_LST_A",
                contactListName: "List A",
                contactListTypeEnumId: "NEWSLETTER",
                ownerPartyId: orgA
            })
            make("mantle.marketing.contact.ContactList", {
                contactListId: prefix + "_LST_B",
                contactListName: "List B",
                contactListTypeEnumId: "NEWSLETTER",
                ownerPartyId: orgB
            })
            make("mantle.marketing.contact.ContactList", {
                contactListId: prefix + "_MBX_A",
                contactListName: "Mailbox A",
                contactListTypeEnumId: "MAILBOX",
                ownerPartyId: orgA
            })
            // Accounting lines of A: a posted ledger debit of 300 and a bill's item of 200, both in USD
            make("mantle.ledger.transaction.AcctgTrans", {
                acctgTransId: prefix + "_AT",
                organizationPartyId: orgA,
                isPosted: "Y",
                amountUomId: "USD",
                transactionDate: new Date()
            })
            make("mantle.ledger.transaction.AcctgTransEntry", {
                acctgTransId: prefix + "_AT",
                acctgTransEntrySeqId: "01",
                debitCreditFlag: "D",
                amount: 300,
                description: "Print ads"
            })
            make("mantle.account.invoice.Invoice", {
                invoiceId: prefix + "_INV",
                invoiceTypeEnumId: "InvoiceSales",
                fromPartyId: orgB,
                toPartyId: orgA,
                statusId: "InvoiceReceived",
                currencyUomId: "USD"
            })
            make("mantle.account.invoice.InvoiceItem", {
                invoiceId: prefix + "_INV",
                invoiceItemSeqId: "01",
                quantity: 1,
                amount: 200,
                description: "Banners"
            })
        })
    }
})

feature(
    "a campaign is made in the author's organization, mirrored to its organization row; another organization's author finds none of it",
    {
        when() {
            const id = campaign(users.author, orgA, {campaignName: "Spring launch"})
            const made = row("mantle.marketing.campaign.MarketingCampaign", {marketingCampaignId: id})
            const organizationRows = rows("mantle.marketing.campaign.MarketingCampaignParty", {
                marketingCampaignId: id,
                roleTypeId: "MarketingOrganization"
            })
            const managerRows = rows("mantle.marketing.campaign.MarketingCampaignParty", {
                marketingCampaignId: id,
                roleTypeId: "MarketingCampaignManager"
            })
            return {
                id,
                made,
                organizationRows,
                managerRows,
                otherOrganization: as(users.author, C + "create#Campaign", {organizationPartyId: orgB, campaignName: "Not mine"}),
                readerCreate: as(users.reader, C + "create#Campaign", {organizationPartyId: orgA, campaignName: "Reader's"}),
                readerGet: as(users.reader, C + "get#Campaign", {marketingCampaignId: id}),
                otherGet: as(users.authorB, C + "get#Campaign", {marketingCampaignId: id}),
                otherFind: as(users.authorB, C + "find#Campaigns", {text: "Spring launch"}),
                ownFind: as(users.reader, C + "find#Campaigns", {text: "spring LAUNCH"})
            }
        },
        then({
            id,
            made,
            organizationRows,
            managerRows,
            otherOrganization,
            readerCreate,
            readerGet,
            otherGet,
            otherFind,
            ownFind
        }) {
            made.organizationPartyId == orgA && made.statusId == "MKTG_CAMP_PLANNED" && made.campaignRevision == 1
            made.createdByUserId == users.author
            organizationRows.length == 1 && organizationRows[0].partyId == orgA
            managerRows.length == 1 && managerRows[0].partyId == users.author
            otherOrganization.refusal.includes("ORGANIZATION_DENIED")
            readerCreate.refusal.includes("PERMISSION_DENIED")
            readerGet.refusal == "" && readerGet.campaign.organizationName == "Campaigns A"
            readerGet.capabilities.canEdit == false
            otherGet.refusal.includes("RECORD_UNAVAILABLE")
            otherFind.campaignList.length == 0
            ownFind.campaignList.map(found => found.marketingCampaignId).includes(id)
        }
    }
)

feature(
    "the native flow: start needs the current revision's approval, completion is refused with its pending work, cancellation ends it",
    {
        when() {
            const id = campaign(users.author, orgA, {campaignName: "Flow"})
            const step = (username, verb, extra = {}) =>
                as(
                    username,
                    C + verb + "#Campaign",
                    Object.assign({marketingCampaignId: id, expectedRevision: revisionOf(id).expectedRevision}, extra)
                )
            const startPlanned = step(users.author, "start")
            const completePlanned = step(users.author, "complete")
            // approved through the approval services
            as(users.author, C + "request#MarketingApproval", {targetId: id})
            as(users.approver, C + "decide#MarketingApproval", {
                targetId: id,
                targetRevision: revisionOf(id).targetRevision,
                decision: "approve"
            })
            const readerStart = step(users.reader, "start")
            const started = step(users.author, "start")
            // a child campaign still open is pending work
            const childId = campaign(users.author, orgA, {campaignName: "Flow child", parentCampaignId: id})
            const completeWithChild = step(users.author, "complete")
            as(users.author, C + "cancel#Campaign", {
                marketingCampaignId: childId,
                expectedRevision: revisionOf(childId).expectedRevision,
                reason: "Merged into the parent"
            })
            const completed = step(users.author, "complete")
            const cancelClosed = step(users.author, "cancel")
            return {
                startPlanned,
                completePlanned,
                readerStart,
                started,
                completeWithChild,
                completed,
                cancelClosed,
                child: revisionOf(childId).row,
                done: revisionOf(id).row
            }
        },
        then({startPlanned, completePlanned, readerStart, started, completeWithChild, completed, cancelClosed, child, done}) {
            startPlanned.refusal.includes("STATUS_INVALID")
            completePlanned.refusal.includes("STATUS_INVALID")
            readerStart.refusal.includes("PERMISSION_DENIED")
            started.refusal == "" && started.statusId == "MKTG_CAMP_INPROGRESS"
            completeWithChild.refusal.includes("PENDING_WORK") && completeWithChild.refusal.includes("1 open related campaigns")
            child.statusId == "MKTG_CAMP_CANCELLED"
            completed.refusal == "" && done.statusId == "MKTG_CAMP_COMPLETED"
            cancelClosed.refusal.includes("CAMPAIGN_CLOSED")
        }
    }
)

feature(
    "every write names the revision it read: none and a stale one are refused; a material change raises the approval revision",
    {
        when() {
            const id = campaign(users.author, orgA, {campaignName: "Revisions"})
            const read = revisionOf(id)
            const none = as(users.author, C + "store#Campaign", {marketingCampaignId: id, campaignSummary: "x"})
            const summary = as(users.author, C + "store#Campaign", {
                marketingCampaignId: id,
                expectedRevision: read.expectedRevision,
                campaignSummary: "Plan"
            })
            const stale = as(users.author, C + "store#Campaign", {
                marketingCampaignId: id,
                expectedRevision: read.expectedRevision,
                campaignSummary: "Late"
            })
            const afterSummary = revisionOf(id)
            const budget = as(users.author, C + "store#CampaignBudget", {
                marketingCampaignId: id,
                expectedRevision: afterSummary.expectedRevision,
                budgetedCost: "1500",
                explanation: "More print"
            })
            const otherStore = as(users.authorB, C + "store#Campaign", {
                marketingCampaignId: id,
                expectedRevision: revisionOf(id).expectedRevision,
                campaignSummary: "B"
            })
            return {none, summary, stale, afterSummary, budget, after: revisionOf(id), otherStore}
        },
        then({none, summary, stale, afterSummary, budget, after, otherStore}) {
            none.refusal.includes("REVISION_REQUIRED")
            summary.refusal == "" && summary.campaignRevision == 1
            stale.refusal.includes("STALE_REVISION")
            // a summary is no material change; the budget is
            afterSummary.targetRevision == 1
            budget.refusal == "" && budget.changed == true && after.targetRevision == 2
            after.row.budgetedCost.toNumber() == 1500
            otherStore.refusal.includes("RECORD_UNAVAILABLE")
        }
    }
)

feature("the organization's successor is mirrored to organizationPartyId; a link of another organization's record is refused", {
    when() {
        system(() =>
            make("mantle.party.PartyRelationship", {
                fromPartyId: users.mate,
                toPartyId: orgB,
                relationshipTypeEnumId: "PrtAgent",
                toRoleTypeId: "OrgInternal",
                fromDate: 0
            })
        )
        // the author of both organizations moves a campaign of A to B
        system(() =>
            make("mantle.party.PartyRelationship", {
                fromPartyId: users.author,
                toPartyId: orgB,
                relationshipTypeEnumId: "PrtAgent",
                toRoleTypeId: "OrgInternal",
                fromDate: 0
            })
        )
        const id = campaign(users.author, orgA, {campaignName: "Moving"})
        const moved = as(users.author, C + "store#CampaignParty", {
            marketingCampaignId: id,
            expectedRevision: revisionOf(id).expectedRevision,
            roleTypeId: "MarketingOrganization",
            partyId: orgB
        })
        const after = revisionOf(id).row
        const organizationRows = rows("mantle.marketing.campaign.MarketingCampaignParty", {
            marketingCampaignId: id,
            roleTypeId: "MarketingOrganization"
        })
        const linked = as(users.author, C + "store#CampaignAssociation", {
            marketingCampaignId: id,
            associationKindEnumId: "CakList",
            sourceId: prefix + "_LST_B"
        })
        const foreign = as(users.author, C + "store#CampaignAssociation", {
            marketingCampaignId: id,
            associationKindEnumId: "CakList",
            sourceId: prefix + "_LST_A"
        })
        const mailbox = as(users.author, C + "store#CampaignAssociation", {
            marketingCampaignId: id,
            associationKindEnumId: "CakList",
            sourceId: prefix + "_MBX_A"
        })
        const event = as(users.author, C + "store#CampaignAssociation", {
            marketingCampaignId: id,
            associationKindEnumId: "CakEvent",
            sourceId: "X"
        })
        const back = as(users.author, C + "store#CampaignParty", {
            marketingCampaignId: id,
            expectedRevision: revisionOf(id).expectedRevision,
            roleTypeId: "MarketingOrganization",
            partyId: orgA
        })
        return {moved, after, organizationRows, linked, foreign, mailbox, event, back}
    },
    then({moved, after, organizationRows, linked, foreign, mailbox, event, back}) {
        moved.refusal == "" && after.organizationPartyId == orgB && after.campaignRevision == 2
        organizationRows.length == 2
        organizationRows
            .filter(found => !found.thruDate)
            .map(found => found.partyId)
            .join() == orgB
        linked.refusal == "" && !!linked.campaignAssociationId
        foreign.refusal.includes("ORGANIZATION_MISMATCH")
        mailbox.refusal.includes("RECORD_UNAVAILABLE")
        event.refusal.includes("KIND_UNAVAILABLE")
        // its links are B's: the organization stays
        back.refusal.includes("ORGANIZATION_IN_USE")
    }
})

feature(
    "a cost is manual or one Accounting line, counted once and within its amount, read with Accounting's permission and masked without it, corrected by reversal",
    {
        when() {
            const id = campaign(users.finance, orgA, {campaignName: "Costs"})
            const other = campaign(users.finance, orgA, {campaignName: "Costs too"})
            const cost = (username, fields, campaignId = id) =>
                as(username, C + "store#CampaignCost", Object.assign({marketingCampaignId: campaignId}, fields))
            const ledger = {acctgTransId: prefix + "_AT", acctgTransEntrySeqId: "01"}
            const both = cost(
                users.finance,
                Object.assign({costSourceEnumId: "CcsManual", amount: "10", description: "x"}, ledger)
            )
            const forbidden = cost(users.author, Object.assign({amount: "100"}, ledger))
            const linked = cost(users.finance, Object.assign({amount: "250", operationKey: prefix + "-K1"}, ledger))
            const retry = cost(users.finance, Object.assign({amount: "250", operationKey: prefix + "-K1"}, ledger))
            const twice = cost(users.finance, Object.assign({amount: "10"}, ledger))
            const exceeds = cost(users.finance, Object.assign({amount: "60"}, ledger), other)
            const rest = cost(users.finance, Object.assign({amount: "50"}, ledger), other)
            const bill = cost(users.finance, {invoiceId: prefix + "_INV", invoiceItemSeqId: "01", amount: "200"})
            const manual = cost(users.author, {amount: "40", description: "Event booth"})
            const reversal = cost(users.author, {reversalOfCostId: manual.campaignCostId})
            const again = cost(users.author, {reversalOfCostId: manual.campaignCostId})
            const recount = cost(users.finance, Object.assign({amount: "250"}, ledger))
            return {
                both,
                forbidden,
                linked,
                retry,
                twice,
                exceeds,
                rest,
                bill,
                manual,
                reversal,
                again,
                recount,
                actual: revisionOf(id).row.actualCost,
                asFinance: as(users.finance, C + "find#CampaignCosts", {marketingCampaignId: id}),
                asReader: as(users.reader, C + "find#CampaignCosts", {marketingCampaignId: id})
            }
        },
        then({
            both,
            forbidden,
            linked,
            retry,
            twice,
            exceeds,
            rest,
            bill,
            manual,
            reversal,
            again,
            recount,
            actual,
            asFinance,
            asReader
        }) {
            both.refusal.includes("COST_SOURCE_INVALID")
            forbidden.refusal.includes("SOURCE_FORBIDDEN")
            linked.refusal == "" &&
                retry.refusal == "" &&
                retry.alreadyApplied == true &&
                retry.campaignCostId == linked.campaignCostId
            twice.refusal.includes("SOURCE_ALREADY_COUNTED")
            // 250 of the line's 300 is the first campaign's: 60 more passes it, 50 does not
            exceeds.refusal.includes("ALLOCATION_EXCEEDS")
            rest.refusal == ""
            bill.refusal == ""
            manual.refusal == "" && reversal.refusal == "" && again.refusal.includes("ALREADY_REVERSED")
            // 250 + 200 + 40 - 40, the line counted once
            recount.refusal.includes("SOURCE_ALREADY_COUNTED")
            actual.toNumber() == 450
            asFinance.costs.length == 4 && asFinance.costs.some(found => found.description.includes("Print ads"))
            asReader.refusal == "" && asReader.summary.actualText.includes("450")
            asReader.costs
                .filter(found => found.costSourceEnumId != "CcsManual")
                .every(found => found.description == "An Accounting line")
        }
    }
)

feature(
    "a campaign duplicates as a new planned campaign; the policy is stored at the revision read; the vocabulary offers each value once",
    {
        when() {
            const id = campaign(users.author, orgA, {campaignName: "Template"})
            as(users.author, C + "store#CampaignAssociation", {
                marketingCampaignId: id,
                associationKindEnumId: "CakList",
                sourceId: prefix + "_LST_A"
            })
            const copy = as(users.author, C + "duplicate#Campaign", {marketingCampaignId: id})
            const copyRow = copy.marketingCampaignId ? revisionOf(copy.marketingCampaignId).row : null
            const copyLinks = rows("mantle.marketing.campaign.CampaignAssociation", {
                marketingCampaignId: copy.marketingCampaignId
            })
            const first = as(users.configurer, C + "store#MarketingPolicy", {
                organizationPartyId: orgA,
                currencyUomId: "USD",
                selfApprovalAllowed: "N"
            })
            const stale = as(users.configurer, C + "store#MarketingPolicy", {organizationPartyId: orgA, currencyUomId: "EUR"})
            const preview = as(users.configurer, C + "preview#MarketingPolicy", {
                organizationPartyId: orgA,
                selfApprovalAllowed: "Y"
            })
            const second = as(users.configurer, C + "store#MarketingPolicy", {
                organizationPartyId: orgA,
                currencyUomId: "EUR",
                expectedPolicyId: first.marketingPolicyId
            })
            const policy = as(users.configurer, C + "get#MarketingPolicy", {organizationPartyId: orgA})
            const authorPolicy = as(users.author, C + "get#MarketingPolicy", {organizationPartyId: orgA})
            const vocabulary = as(users.configurer, C + "store#Vocabulary", {
                organizationPartyId: orgA,
                vocabularyKindEnumId: "MvkUtmSource",
                vocabularyCode: "Newsletter",
                label: "Newsletter"
            })
            const taken = as(users.configurer, C + "store#Vocabulary", {
                organizationPartyId: orgA,
                vocabularyKindEnumId: "MvkUtmSource",
                vocabularyCode: "newsletter"
            })
            const badEnum = as(users.configurer, C + "store#Vocabulary", {
                organizationPartyId: orgA,
                vocabularyKindEnumId: "MvkListType",
                enumId: "MKC_NOT"
            })
            const offered = as(users.reader, C + "find#Vocabulary", {organizationPartyId: orgA})
            return {
                copy,
                copyRow,
                copyLinks,
                first,
                stale,
                preview,
                second,
                policy,
                authorPolicy,
                vocabulary,
                taken,
                badEnum,
                offered
            }
        },
        then({
            copy,
            copyRow,
            copyLinks,
            first,
            stale,
            preview,
            second,
            policy,
            authorPolicy,
            vocabulary,
            taken,
            badEnum,
            offered
        }) {
            copy.refusal == "" && copyRow.campaignName == "Copy of Template" && copyRow.statusId == "MKTG_CAMP_PLANNED"
            copyLinks.length == 1
            first.refusal == "" && stale.refusal.includes("STALE_REVISION")
            preview.refusal == "" && preview.findings.some(found => found.kind == "selfApproval")
            second.refusal == "" && policy.policy.currencyUomId == "EUR" && policy.history.length == 2
            policy.history.filter(found => found.thruDateText).length == 1
            authorPolicy.refusal.includes("PERMISSION_DENIED")
            vocabulary.refusal == "" && taken.refusal.includes("VALUE_TAKEN") && badEnum.refusal.includes("VALUE_INVALID")
            offered.vocabularyList.map(found => found.value).includes("newsletter")
        }
    }
)

feature("the lifecycle participant lists a user's open campaign roles to an owner-change holder and moves them to a colleague", {
    when() {
        const id = campaign(users.author, orgA, {campaignName: "Leaving"})
        const lookup = as(users.operator, C + "find#OwnedCampaignRoles", {userId: users.author})
        const readerLookup = as(users.reader, C + "find#OwnedCampaignRoles", {userId: users.author})
        const resourceId = "MarketingCampaignManager:" + id
        const toOutsider = as(users.operator, C + "transfer#CampaignRole", {
            fromUserId: users.author,
            toUserId: users.authorB,
            campaignResourceId: resourceId
        })
        const readerMove = as(users.reader, C + "transfer#CampaignRole", {
            fromUserId: users.author,
            toUserId: users.mate,
            campaignResourceId: resourceId
        })
        const moved = as(users.operator, C + "transfer#CampaignRole", {
            fromUserId: users.author,
            toUserId: users.mate,
            campaignResourceId: resourceId,
            reason: "Left"
        })
        const managers = rows("mantle.marketing.campaign.MarketingCampaignParty", {
            marketingCampaignId: id,
            roleTypeId: "MarketingCampaignManager"
        })
            .filter(found => !found.thruDate)
            .map(found => found.partyId)
        const notOwned = as(users.operator, C + "transfer#CampaignRole", {
            fromUserId: users.author,
            toUserId: users.mate,
            campaignResourceId: resourceId
        })
        const later = as(users.operator, C + "find#OwnedCampaignRoles", {userId: users.author})
        return {resourceId, lookup, readerLookup, toOutsider, readerMove, moved, managers, notOwned, later}
    },
    then({resourceId, lookup, readerLookup, toOutsider, readerMove, moved, managers, notOwned, later}) {
        lookup.refusal == "" && lookup.resourceList.some(found => found.resourceId == resourceId)
        readerLookup.refusal.includes("PERMISSION_DENIED")
        toOutsider.refusal.includes("NOT_EMPLOYED")
        readerMove.refusal.includes("PERMISSION_DENIED")
        moved.refusal == "" && moved.transferred == true
        managers.join() == users.mate
        notOwned.refusal.includes("RECORD_UNAVAILABLE")
        !later.resourceList.some(found => found.resourceId == resourceId)
    }
})
