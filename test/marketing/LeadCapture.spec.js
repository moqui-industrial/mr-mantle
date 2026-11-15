// Marketing's lead rules and the Sales handoff (impl-marketing P13; design-marketing §10 Leads, LeadRules, §15.3 Capture handoff;
// mantle.marketing.MarketingFormServices over MarketingLeads.js, Sales' store#LeadIntake): a content author routes a lead form to a
// sales team of the organization (a reader, another organization's author and another organization's team refused) and the form opens
// only with its rule; a visitor's answer posted twice is one capture and one lead in the team's queue with the publication's campaign,
// a second answer with the same email joins it (Sales' duplicate policy), an unpublished or unmapped answer never reaches Sales, and
// nothing subscribes the visitor; a failed handoff keeps the answer and the job's retry makes the one lead, an operator's reprocess
// needing the permission and a reason; a lead takes only a campaign of its organization and a tracking code of its campaign.
// Standalone: spec-local organizations, users, sales teams and sources, a site with the Marketing mount and a campaign. Run:
// ./moq test mr-mantle --spec LeadCapture
const lib = ec.resource.script("component://mr-mantle/test/marketing/MarketingSpecLib.js")
const {make, row, rows, system, organization, user, as, run} = lib
const F = "mantle.party.FormDefinitionServices."
const M = "mantle.marketing.MarketingFormServices."
const PORTAL = "mantle.marketing.MarketingPortalServices."
const SALES = "mantle.sales.OpportunityServices."
const prefix = "MKL"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const site = prefix + "_SITE"
const host = "leads.mkl.example.test"
const users = {}
const ids = {}
const settle = () => ec.factory.waitWorkerPoolEmpty(50)
const key = () => "mkl" + ec.user.randomString(12).replace(/[^A-Za-z0-9]/g, "x")
const INTAKE = "mantle.sales.opportunity.SalesLeadIntake"
const CAPTURE = "mantle.marketing.lead.MarketingLeadCapture"
// a PASS operation's service as an anonymous visitor: its result, or the error's kind
function visitor(service, input) {
    logout()
    ec.message.pushErrors()
    try {
        return ec.service
            .sync()
            .throwOnError(true)
            .name(PORTAL + service)
            .parameters({input})
            .requireNewTransaction(true)
            .call().result
    } catch (error) {
        return {kind: error.moquiErrorKind || "Error", error: String(error.message).split("\n")[0]}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        login(lib.OPERATOR)
    }
}
const answer = (values, operationId = key()) =>
    visitor("submit#Form", {siteId: site, publicationId: ids.publication, values, operationId})
// the capture job, as the system
const runJob = () => system(() => run(M + "run#LeadCaptures", {}))
function team(kind, organizationPartyId) {
    const partyId = prefix + "_TEAM_" + kind.toUpperCase()
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: organizationPartyId})
    make("mantle.party.Organization", {partyId, organizationName: "Team " + kind})
    make("mantle.party.PartyRole", {partyId, roleTypeId: "SalesTeam"})
    make("mantle.party.PartyRelationship", {
        partyRelationshipId: partyId + "_OF",
        relationshipTypeEnumId: "PrtSalesTeamOf",
        fromPartyId: partyId,
        fromRoleTypeId: "SalesTeam",
        toPartyId: organizationPartyId,
        toRoleTypeId: "OrgInternal",
        fromDate: 0
    })
    return partyId
}
const leadEmail = name => name.toLowerCase() + "@buyer.mkl.example.test"
const capturesOf = formSubmissionId => rows(CAPTURE, {sourceId: formSubmissionId})
const submissionOf = operationId =>
    rows("mantle.party.FormSubmission", {publicationId: ids.publication}).filter(
        row => row.requestKey === ec.user.singleUseCodeHash("form-submission:" + ids.publication + ":" + operationId)
    )

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Leads A")
            organization(orgB, "Leads B")
            users.author = user(prefix, "author", [orgA], ["MARKETING_VIEW", "MARKETING_CONTENT_EDIT", "MARKETING_CAMPAIGN_EDIT"])
            users.reader = user(prefix, "reader", [orgA], ["MARKETING_VIEW"])
            users.authorB = user(
                prefix,
                "authorB",
                [orgB],
                ["MARKETING_VIEW", "MARKETING_CONTENT_EDIT", "MARKETING_CAMPAIGN_EDIT"]
            )
            users.rep = user(prefix, "rep", [orgA], ["SALES_VIEW", "SALES_OPPORTUNITY_EDIT", "SALES_TEAM_VIEW"])
            ids.east = team("east", orgA)
            ids.north = team("north", orgB)
            ids.source = prefix + "_SRC_WEB"
            make("moqui.basic.DataSource", {dataSourceId: ids.source, dataSourceTypeEnumId: "WEB_SITE", description: "Lead form"})
            make("mantle.sales.opportunity.SalesLeadSourceBinding", {
                dataSourceId: ids.source,
                organizationPartyId: orgA,
                fromDate: 0
            })
            make("mantle.public.PublicSite", {
                siteId: site,
                name: "Leads site",
                state: "published",
                registrationMode: "closed",
                locale: "en",
                timeZone: "UTC",
                policyRevision: 1,
                generation: 1
            })
            make("mantle.public.PublicSiteHost", {hostname: host, siteId: site, canonical: "Y"})
            make("mantle.public.PublicSiteApp", {
                siteId: site,
                appMountId: "marketing",
                app: "marketing",
                pathPrefix: "/marketing",
                enabled: "Y",
                targetId: orgA
            })
        })
        ids.campaign = lib.campaign(users.author, orgA, {campaignName: "Racking launch"})
        ids.campaignB = lib.campaign(users.authorB, orgB, {campaignName: "North launch"})
        system(() => {
            for (const marketingCampaignId of [ids.campaign, ids.campaignB])
                run("update#mantle.marketing.campaign.MarketingCampaign", {marketingCampaignId, statusId: "MKTG_CAMP_APPROVED"})
            make("mantle.marketing.tracking.TrackingCode", {
                trackingCodeId: prefix + "_TC",
                marketingCampaignId: ids.campaign,
                fromDate: 0
            })
            make("mantle.marketing.tracking.TrackingCode", {
                trackingCodeId: prefix + "_TC_B",
                marketingCampaignId: ids.campaignB,
                fromDate: 0
            })
        })
        // the lead form: name, company, email, a budget (never mapped) and the interest (a choice), published; a phone question left a
        // draft
        ids.form = as(users.author, F + "create#Form", {
            purposeEnumId: "DbfpLead",
            organizationPartyId: orgA,
            description: "Racking quote"
        }).formId
        const field = (newFieldName, title, fieldTypeEnumId, more = {}) =>
            as(users.author, F + "save#FormField", Object.assign({formId: ids.form, newFieldName, title, fieldTypeEnumId}, more))
        field("fullName", "Your name", "DBFFT_text-line", {isRequired: "Y"})
        field("company", "Company", "DBFFT_text-line")
        field("email", "Email", "DBFFT_text-line", {isRequired: "Y"})
        field("budget", "Budget", "DBFFT_text-line")
        field("interest", "Interested in", "DBFFT_radio", {optionText: "demo | A demo\nquote | A quote"})
        as(users.author, F + "publish#Form", {formId: ids.form})
        field("phone", "Phone", "DBFFT_text-line")
        ids.publication = as(users.author, M + "store#Publication", {
            formId: ids.form,
            accessEnumId: "FpaAnonymous",
            repeatEnumId: "FprMany",
            siteId: site,
            marketingCampaignId: ids.campaign,
            titleText: "Ask for a quote"
        }).publicationId
    },
    cleanupSpec() {
        settle()
    }
})

feature("a content author routes a lead form to a sales team of the organization, and it opens only with its rule", {
    when() {
        const rule = fields =>
            Object.assign(
                {
                    publicationId: ids.publication,
                    teamPartyId: ids.east,
                    dataSourceId: ids.source,
                    nameFieldName: "fullName",
                    organizationFieldName: "company",
                    emailFieldName: "email",
                    phoneFieldName: "phone",
                    noteFieldNames: "interest",
                    noticeText: "Our sales team will call you about your quote."
                },
                fields
            )
        const unrouted = as(users.author, M + "publish#Publication", {publicationId: ids.publication})
        const byReader = as(users.reader, M + "store#LeadRule", rule())
        const byOther = as(users.authorB, M + "store#LeadRule", rule())
        const otherTeam = as(users.author, M + "store#LeadRule", rule({teamPartyId: ids.north}))
        const unknown = as(users.author, M + "store#LeadRule", rule({noteFieldNames: "interest,secret"}))
        const unmapped = as(
            users.author,
            M + "store#LeadRule",
            rule({nameFieldName: "", organizationFieldName: "", emailFieldName: "", phoneFieldName: ""})
        )
        const made = as(users.author, M + "store#LeadRule", rule())
        ids.rule = made.leadRuleId
        const twice = as(users.author, M + "store#LeadRule", rule())
        const published = as(users.author, M + "publish#Publication", {publicationId: ids.publication})
        const page = visitor("get#Form", {siteId: site, publicationId: ids.publication})
        const listed = as(users.author, M + "find#LeadRules", {publicationId: ids.publication})
        const listedByReader = as(users.reader, M + "find#LeadRules", {})
        const preview = as(users.author, M + "preview#LeadRule", {leadRuleId: ids.rule})
        return {
            unrouted,
            byReader,
            byOther,
            otherTeam,
            unknown,
            unmapped,
            made,
            twice,
            published,
            page,
            listed,
            listedByReader,
            preview
        }
    },
    then(r) {
        r.unrouted.refusal.includes("NOT_READY")
        r.byReader.refusal.includes("PERMISSION_DENIED")
        r.byOther.refusal.includes("RECORD_UNAVAILABLE")
        r.otherTeam.refusal.includes("TEAM_UNAVAILABLE")
        r.unknown.refusal.includes("FIELD_UNKNOWN")
        r.unmapped.refusal.includes("MAPPING_REQUIRED")
        r.made.refusal === "" && r.made.created === true
        r.twice.refusal.includes("RULE_EXISTS")
        r.published.refusal === "" && r.published.state === "open"
        r.page.form.notice === "Our sales team will call you about your quote."
        r.page.form.fields.map(f => f.fieldName).join() === "fullName,company,email,budget,interest"
        r.listed.ruleList.length === 1 && r.listed.ruleList[0].teamName === "Team east"
        r.listed.ruleList[0].campaignName === "Racking launch"
        r.listedByReader.refusal.includes("PERMISSION_DENIED")
        // the author reads no audience: the preview's sample is made of the questions, its queue the rule's team
        r.preview.preview.queueText === "Team east" && r.preview.preview.sampleText === "A sample answer"
    }
})

feature(
    "an answer posted twice is one lead in the team's queue; an unpublished or unmapped answer never reaches Sales; nothing subscribes",
    {
        when() {
            const requestsBefore = rows("mantle.marketing.contact.SubscriptionRequest", {}).length
            const consentsBefore = rows("mantle.party.PartyConsent", {}).length
            const operationId = key()
            const values = {
                fullName: "Pat Buyer",
                company: "Acme Storage",
                email: leadEmail("Pat"),
                budget: "Secret 90k",
                interest: "quote"
            }
            const first = answer(values, operationId)
            const again = answer(values, operationId)
            settle()
            const submissions = submissionOf(operationId)
            const captures = capturesOf(submissions[0]?.formSubmissionId)
            const intakes = rows(INTAKE, {sourceId: submissions[0]?.formResponseId})
            const lead = intakes[0]
                ? row("mantle.sales.opportunity.SalesOpportunity", {salesOpportunityId: intakes[0].salesOpportunityId})
                : null
            const queue = intakes[0]
                ? rows("mantle.sales.opportunity.SalesOpportunityParty", {
                      salesOpportunityId: intakes[0].salesOpportunityId,
                      partyId: ids.east
                  })
                : []
            const job = runJob()
            // a second answer with the same email: its own capture, joining the lead
            const second = answer({fullName: "Pat Buyer", email: leadEmail("Pat"), interest: "demo"})
            settle()
            const allCaptures = rows(CAPTURE, {leadRuleId: ids.rule})
            const counts = as(users.reader, M + "get#LeadHandoffs", {marketingCampaignId: ids.campaign})
            const readerCaptures = as(users.reader, M + "find#LeadCaptures", {leadRuleId: ids.rule})
            const countsB = as(users.authorB, M + "get#LeadHandoffs", {marketingCampaignId: ids.campaign})
            // nothing subscribes the visitor or records a consent
            const requests = rows("mantle.marketing.contact.SubscriptionRequest", {}).length - requestsBefore
            const consents = rows("mantle.party.PartyConsent", {}).length - consentsBefore
            const mech = rows("mantle.party.contact.ContactMech", {infoString: leadEmail("pat")})
            return {
                first,
                again,
                submissions,
                captures,
                intakes,
                lead,
                queue,
                job,
                second,
                allCaptures,
                counts,
                readerCaptures,
                countsB,
                requests,
                consents,
                mech
            }
        },
        then(r) {
            r.first.receipt.message && r.again.receipt.message
            r.submissions.length === 1 && r.captures.length === 1
            r.captures[0].statusEnumId === "MlcHandedOff" && r.captures[0].duplicate === "N"
            r.intakes.length === 1 && r.intakes[0].teamPartyId === ids.east
            r.intakes[0].organizationPartyId === orgA && r.intakes[0].marketingCampaignId === ids.campaign
            r.intakes[0].submittedName === "Pat Buyer" && r.intakes[0].submittedEmail === leadEmail("pat")
            r.intakes[0].dataSourceId === ids.source && r.intakes[0].verifiedDate == null
            // the draft phone question is not published: nothing for it reaches Sales; the budget is not mapped
            r.intakes[0].submittedPhone == null
            r.lead.description === "Interested in: A quote" && !String(r.lead.description).includes("90k")
            r.lead.marketingCampaignId === ids.campaign && r.queue.length === 1
            r.job.captured === 0 && r.job.handedOff === 0
            r.allCaptures.length === 2
            r.allCaptures.filter(c => c.duplicate === "Y").length === 1
            r.allCaptures.every(c => c.salesOpportunityId === r.lead.salesOpportunityId)
            r.counts.handoffs.newLeads === 1 && r.counts.handoffs.joined === 1 && r.counts.handoffs.failed === 0
            // a reader without Sales sees the handoffs, never the lead
            r.readerCaptures.captureList.length === 2 && r.readerCaptures.captureList.every(c => c.salesOpportunityId == null)
            r.countsB.refusal.includes("RECORD_UNAVAILABLE")
            r.requests === 0 && r.consents === 0 && r.mech.length === 0
        }
    }
)

feature(
    "a failed handoff keeps the answer and the job's retry makes the one lead; a reprocess needs the permission and a reason",
    {
        when() {
            const relationship = prefix + "_TEAM_EAST_OF"
            system(() =>
                run("update#mantle.party.PartyRelationship", {
                    partyRelationshipId: relationship,
                    thruDate: new Date(Date.now() - 60000)
                })
            )
            const operationId = key()
            answer({fullName: "Sam Fails", email: leadEmail("sam"), interest: "demo"}, operationId)
            settle()
            const submission = submissionOf(operationId)[0]
            const failed = capturesOf(submission.formSubmissionId)
            const response = row("moqui.screen.form.FormResponse", {formResponseId: submission.formResponseId})
            const notDue = runJob()
            system(() => run("update#mantle.party.PartyRelationship", {partyRelationshipId: relationship, thruDate: null}))
            // its time comes: the job hands it off
            system(() =>
                run("update#" + CAPTURE, {leadCaptureId: failed[0].leadCaptureId, nextAttemptDate: new Date(Date.now() - 1000)})
            )
            const retried = runJob()
            const after = capturesOf(submission.formSubmissionId)
            const intakes = rows(INTAKE, {sourceId: submission.formResponseId})
            const byReader = as(users.reader, M + "process#LeadCaptures", {
                leadCaptureIds: [failed[0].leadCaptureId],
                reason: "Team back"
            })
            const noReason = as(users.author, M + "process#LeadCaptures", {leadCaptureIds: [failed[0].leadCaptureId]})
            const again = as(users.author, M + "process#LeadCaptures", {
                leadCaptureIds: [failed[0].leadCaptureId],
                reason: "Team back"
            })
            const byOther = as(users.authorB, M + "process#LeadCaptures", {
                leadCaptureIds: [failed[0].leadCaptureId],
                reason: "Mine"
            })
            return {failed, response, notDue, retried, after, intakes, byReader, noReason, again, byOther}
        },
        then(r) {
            r.failed.length === 1 && r.failed[0].statusEnumId === "MlcFailed"
            r.failed[0].errorText.includes("TEAM_UNAVAILABLE") && r.failed[0].nextAttemptDate != null
            r.response != null
            r.notDue.handedOff === 0 && r.notDue.captured === 0
            r.retried.handedOff === 1
            r.after.length === 1 && r.after[0].statusEnumId === "MlcHandedOff" && Number(r.after[0].attemptCount) === 2
            r.intakes.length === 1 && r.intakes[0].teamPartyId === ids.east
            r.byReader.refusal.includes("PERMISSION_DENIED")
            r.noReason.refusal.includes("REASON_REQUIRED")
            r.again.refusal === "" && r.again.unchanged === 1 && r.again.handedOff === 0
            r.byOther.refusal === "" && r.byOther.unavailable === 1
        }
    }
)

feature("a lead takes a campaign of its organization and a tracking code of that campaign only", {
    when() {
        const create = fields =>
            as(
                users.rep,
                SALES + "create#Opportunity",
                Object.assign({typeEnumId: "SotLead", organizationPartyId: orgA, opportunityName: "Phone inquiry"}, fields)
            )
        const otherCampaign = create({marketingCampaignId: ids.campaignB})
        const otherCode = create({marketingCampaignId: ids.campaign, trackingCodeId: prefix + "_TC_B"})
        const made = create({marketingCampaignId: ids.campaign, trackingCodeId: prefix + "_TC"})
        const tracking = rows("mantle.sales.opportunity.SalesOpportunityTracking", {salesOpportunityId: made.salesOpportunityId})
        const codes = as(users.author, "mantle.marketing.TrackingServices.find#TrackingLinks", {
            marketingCampaignId: ids.campaign
        })
        const codesB = as(users.author, "mantle.marketing.TrackingServices.find#TrackingLinks", {
            marketingCampaignId: ids.campaignB
        })
        return {otherCampaign, otherCode, made, tracking, codes, codesB}
    },
    then(r) {
        r.otherCampaign.refusal.includes("CAMPAIGN_INVALID")
        r.otherCode.refusal.includes("TRACKING_INVALID")
        r.made.refusal === "" && r.tracking.length === 1 && r.tracking[0].trackingCodeId === prefix + "_TC"
        r.codes.trackingLinkList.map(c => c.trackingCodeId).join() === prefix + "_TC"
        r.codesB.refusal.includes("RECORD_UNAVAILABLE")
    }
})
