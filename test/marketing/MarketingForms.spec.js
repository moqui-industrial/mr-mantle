// Marketing's surveys and form publications (impl-marketing P12; design-marketing §10 SurveyDistribution, Responses, §13 SubmitForm;
// mantle.marketing.MarketingFormServices over MarketingForms.js, the SubmitForm operations of MarketingPortalServices): a content
// author publishes a survey on a site of the organization, refused to a reader, to another organization's author and on another
// organization's site; an invitation needs promotional eligibility: an invitation send's dispatch invites only the topic's consenting
// member, whose own link answers once, while the member without consent gets nothing; a Marketing reader reads the survey's responses
// and summary with the scores of each response's date, never a case's feedback on the same form, and a report reader sees the
// respondents unnamed.
// Standalone: spec-local organizations, users, a site with the Marketing mount, a topic and a profile. Run:
// ./moq test mr-mantle --spec MarketingForms
const lib = ec.resource.script("component://mr-mantle/test/marketing/MarketingSpecLib.js")
const {make, row, rows, system, organization, user, as, run} = lib
const F = "mantle.party.FormDefinitionServices."
const M = "mantle.marketing.MarketingFormServices."
const D = "mantle.marketing.CampaignSendServices."
const C = "mantle.marketing.CampaignServices."
const PORTAL = "mantle.marketing.MarketingPortalServices."
const capture = ec.factory.getTool("MailCapture")
const prefix = "MKF"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const topic = prefix + "_TOPIC"
const profile = prefix + "_PROFILE"
const relay = prefix + "_RELAY"
const site = prefix + "_SITE",
    siteB = prefix + "_SITE_B"
const host = "survey.mkf.example.test"
const users = {}
const ids = {}
const dayMs = 86400000
const ago = days => new Date(Date.now() - days * dayMs)
const addressOf = name => name.toLowerCase() + "@forms.example.test"
const settle = () => ec.factory.waitWorkerPoolEmpty(50)
const entityLib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const revisionOf = campaignSendId =>
    entityLib.ms(row("mantle.marketing.campaign.CampaignSend", {campaignSendId}).lastUpdatedStamp)
const mailTo = address => Array.from(capture.getMessages()).filter(m => Array.from(m.toList || []).includes(address))
const key = () => "mkf" + ec.user.randomString(12).replace(/[^A-Za-z0-9]/g, "x")
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

spec({
    setupSpec() {
        capture.enable()
        system(() => {
            organization(orgA, "Forms A")
            organization(orgB, "Forms B")
            users.author = user(
                prefix,
                "author",
                [orgA],
                ["MARKETING_VIEW", "MARKETING_CAMPAIGN_EDIT", "MARKETING_SEND_EDIT", "MARKETING_CONTENT_EDIT"]
            )
            users.approver = user(prefix, "approver", [orgA], ["MARKETING_VIEW", "MARKETING_APPROVE"])
            users.dispatcher = user(prefix, "dispatcher", [orgA], ["MARKETING_VIEW", "MARKETING_DISPATCH"])
            users.audience = user(prefix, "audience", [orgA], ["MARKETING_AUDIENCE_VIEW"])
            users.analyst = user(prefix, "analyst", [orgA], ["MARKETING_REPORT_VIEW"])
            users.reader = user(prefix, "reader", [orgA], ["MARKETING_VIEW"])
            users.authorB = user(prefix, "authorB", [orgB], ["MARKETING_VIEW", "MARKETING_CONTENT_EDIT"])
            for (const [siteId, hostname, target] of [
                [site, host, orgA],
                [siteB, "b." + host, orgB]
            ]) {
                make("mantle.public.PublicSite", {
                    siteId,
                    name: "Forms site " + siteId,
                    state: "published",
                    registrationMode: "closed",
                    locale: "en",
                    timeZone: "UTC",
                    policyRevision: 1,
                    generation: 1
                })
                make("mantle.public.PublicSiteHost", {hostname, siteId, canonical: "Y"})
                make("mantle.public.PublicSiteApp", {
                    siteId,
                    appMountId: "marketing",
                    app: "marketing",
                    pathPrefix: "/marketing",
                    enabled: "Y",
                    targetId: target
                })
            }
            make("mantle.marketing.contact.ContactList", {
                contactListId: topic,
                contactListName: "Forms topic",
                contactListTypeEnumId: "NEWSLETTER",
                contactMechTypeEnumId: "CmtEmailAddress",
                ownerPartyId: orgA
            })
            for (const name of ["Ann", "Bob"]) {
                const partyId = (ids[name] = prefix + "_" + name.toUpperCase())
                make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson", ownerPartyId: orgA})
                make("mantle.party.Person", {partyId, firstName: name, lastName: "Formspec"})
                make("mantle.party.contact.ContactMech", {
                    contactMechId: partyId + "_EM",
                    contactMechTypeEnumId: "CmtEmailAddress",
                    infoString: addressOf(name)
                })
                make("mantle.party.contact.PartyContactMech", {
                    partyId,
                    contactMechId: partyId + "_EM",
                    contactMechPurposeId: "EmailPrimary",
                    fromDate: ago(30)
                })
                make("mantle.marketing.contact.ContactListParty", {
                    contactListId: topic,
                    partyId,
                    fromDate: ago(20),
                    statusId: "CLPT_ACCEPTED",
                    preferredContactMechId: partyId + "_EM"
                })
                // Bob is on the topic with no consent: no promotional eligibility
                if (name === "Ann")
                    make("mantle.party.PartyConsent", {
                        partyId,
                        contactMechId: partyId + "_EM",
                        contactListId: topic,
                        purposeEnumId: "PcpMarketingEmail",
                        statusId: "PconGranted",
                        consentDate: ago(19),
                        sourceEnumId: "PcsForm",
                        evidenceText: "Spec sign-up"
                    })
            }
            make("moqui.basic.email.EmailServer", {
                emailServerId: relay,
                smtpHost: "relay.mkf.example.test",
                smtpPort: "9",
                webBaseUrl: "https://" + host
            })
            make("moqui.basic.email.EmailAccount", {
                emailAccountId: prefix + "_BOUNCES",
                accountKindEnumId: "EakHosted",
                emailAddress: "bounces@bounce.mkf.example.test",
                statusId: "EasActive"
            })
            make("mantle.party.MessageSendingProfile", {
                sendingProfileId: profile,
                organizationPartyId: orgA,
                profileName: "Forms news",
                channelEnumId: "MdcEmail",
                emailServerId: relay,
                fromAddress: "news@mkf.example.test",
                purposeEnumId: "MtpPromotional",
                trackingPolicyEnumId: "MtrNone",
                bounceDomain: "bounce.mkf.example.test",
                fromDate: ago(30)
            })
            make("mantle.marketing.campaign.MarketingPolicy", {
                organizationPartyId: orgA,
                fromDate: ago(5),
                selfApprovalAllowed: "N"
            })
        })
        ids.campaign = lib.campaign(users.author, orgA)
        system(() =>
            run("update#mantle.marketing.campaign.MarketingCampaign", {
                marketingCampaignId: ids.campaign,
                statusId: "MKTG_CAMP_APPROVED"
            })
        )
        // the survey: a scored choice and a comment, published
        ids.form = as(users.author, F + "create#Form", {
            purposeEnumId: "DbfpSurvey",
            organizationPartyId: orgA,
            description: "Visit survey"
        }).formId
        as(users.author, F + "save#FormField", {
            formId: ids.form,
            newFieldName: "rating",
            title: "How was it?",
            fieldTypeEnumId: "DBFFT_radio",
            isRequired: "Y",
            optionText: "good | Good | 2\nfair | Fair | 1\npoor | Poor | 0"
        })
        as(users.author, F + "save#FormField", {
            formId: ids.form,
            newFieldName: "comment",
            title: "Anything else?",
            fieldTypeEnumId: "DBFFT_text-area"
        })
        as(users.author, F + "publish#Form", {formId: ids.form})
    },
    cleanupSpec() {
        settle()
        capture.reset()
    }
})

feature(
    "a content author publishes a survey on the organization's site; a reader, another organization's author and site are refused",
    {
        when() {
            const store = (username, fields) => as(username, M + "store#Publication", fields)
            const byReader = store(users.reader, {formId: ids.form, accessEnumId: "FpaAnonymous"})
            const byOther = store(users.authorB, {formId: ids.form, accessEnumId: "FpaAnonymous"})
            const otherSite = store(users.author, {formId: ids.form, accessEnumId: "FpaAnonymous", siteId: siteB})
            const made = store(users.author, {
                formId: ids.form,
                accessEnumId: "FpaAnonymous",
                repeatEnumId: "FprMany",
                siteId: site,
                marketingCampaignId: ids.campaign,
                description: "Public visit survey",
                titleText: "How was your visit?"
            })
            ids.anonymous = made.publicationId
            const beforeOpen = visitor("get#Form", {siteId: site, publicationId: made.publicationId})
            const published = as(users.author, M + "publish#Publication", {publicationId: made.publicationId})
            const page = visitor("get#Form", {siteId: site, publicationId: made.publicationId})
            const wrongSite = visitor("get#Form", {siteId: siteB, publicationId: made.publicationId})
            const detail = as(users.author, M + "get#Publication", {publicationId: made.publicationId})
            const association = rows("mantle.marketing.campaign.CampaignAssociation", {
                marketingCampaignId: ids.campaign,
                associationKindEnumId: "CakForm",
                sourceId: made.publicationId
            })
            const readOther = as(users.authorB, M + "get#Publication", {publicationId: made.publicationId})
            return {byReader, byOther, otherSite, made, beforeOpen, published, page, wrongSite, detail, association, readOther}
        },
        then(r) {
            r.byReader.refusal.includes("PERMISSION_DENIED")
            r.byOther.refusal.includes("RECORD_UNAVAILABLE")
            r.otherSite.refusal.includes("SITE_INVALID")
            r.made.refusal === "" && r.made.created === true
            r.beforeOpen.kind === "NotFound"
            r.published.state === "open"
            r.page.form.title === "How was your visit?"
            r.page.form.fields.map(f => f.fieldName).join() === "rating,comment"
            !JSON.stringify(r.page).includes("score")
            r.wrongSite.kind === "NotFound"
            r.detail.publication.pageUrl.includes(host + "/marketing/SubmitForm?publication=" + r.made.publicationId)
            r.detail.publication.campaignName === "Spec campaign"
            r.association.length === 1
            r.readOther.refusal.includes("RECORD_UNAVAILABLE")
        }
    }
)

feature("an invitation needs promotional eligibility: only the consenting member is invited, and their own link answers once", {
    when() {
        const invited = as(users.author, M + "store#Publication", {
            formId: ids.form,
            accessEnumId: "FpaInvited",
            siteId: site,
            marketingCampaignId: ids.campaign,
            description: "Invited visit survey"
        })
        ids.invited = invited.publicationId
        as(users.author, M + "publish#Publication", {publicationId: invited.publicationId})
        const made = as(users.author, M + "create#Invitations", {
            publicationId: invited.publicationId,
            contactListId: topic,
            sendingProfileId: profile
        })
        const campaignSendId = made.campaignSendId
        as(users.author, D + "store#SendContent", {
            campaignSendId,
            expectedRevision: revisionOf(campaignSendId),
            subject: "Tell us, ${firstName}",
            body: "<p>Hello ${firstName}, how was your visit?</p>",
            bodyText: "Hello ${firstName}, how was your visit?",
            variables: [{name: "firstName", label: "First name", fallback: "friend"}]
        })
        const prepared = as(users.author, D + "prepare#Send", {campaignSendId, expectedRevision: revisionOf(campaignSendId)})
        const targetRevision = Number(row("mantle.marketing.campaign.CampaignSend", {campaignSendId}).sendRevision)
        as(users.author, C + "request#MarketingApproval", {targetKind: "send", targetId: campaignSendId, targetRevision})
        as(users.approver, C + "decide#MarketingApproval", {
            targetKind: "send",
            targetId: campaignSendId,
            targetRevision,
            decision: "approve"
        })
        capture.clear()
        const released = as(users.dispatcher, D + "release#Send", {campaignSendId, expectedRevision: revisionOf(campaignSendId)})
        settle()
        system(() => run(D + "dispatch#Send", {campaignSendId}))
        const annMail = mailTo(addressOf("Ann"))[0] || {}
        const token = /SubmitForm\?token=([A-Za-z0-9_%-]+)/.exec(String(annMail.body || ""))?.[1]
        const invitations = rows("mantle.party.FormInvitation", {publicationId: invited.publicationId})
        const page = visitor("get#Form", {siteId: site, token: token ? decodeURIComponent(token) : ""})
        const answer = values =>
            visitor("submit#Form", {siteId: site, token: token ? decodeURIComponent(token) : "", values, operationId: key()})
        const first = answer({rating: "good", comment: "Lovely"})
        const second = answer({rating: "poor"})
        const afterPage = visitor("get#Form", {siteId: site, token: token ? decodeURIComponent(token) : ""})
        const byId = visitor("get#Form", {siteId: site, publicationId: invited.publicationId})
        const submissions = rows("mantle.party.FormSubmission", {publicationId: invited.publicationId})
        const detail = as(users.author, M + "get#Publication", {publicationId: invited.publicationId})
        return {
            made,
            prepared,
            released,
            annMail,
            bobMail: mailTo(addressOf("Bob")),
            token,
            invitations,
            page,
            first,
            second,
            afterPage,
            byId,
            submissions,
            detail
        }
    },
    then(r) {
        r.made.refusal === ""
        r.prepared.refusal === ""
        r.released.refusal === ""
        r.token != null
        String(r.annMail.body).includes("https://" + host + "/marketing/SubmitForm?token=")
        r.bobMail.length === 0
        r.invitations.length === 1 && r.invitations[0].partyId === ids.Ann
        r.page.form.access === "invited" && r.page.form.fields.length === 2
        r.first.receipt.message.length > 0
        r.second.receipt.message === r.first.receipt.message
        r.afterPage.form.answered === true && r.afterPage.form.fields.length === 0
        r.byId.kind === "NotFound"
        r.submissions.length === 1 && r.submissions[0].partyId === ids.Ann
        r.detail.invitationSends.length === 1 &&
            r.detail.invitationSends[0].invited === 1 &&
            r.detail.invitationSends[0].answered === 1
    }
})

feature(
    "a Marketing reader reads the responses and summary with each response's scores, never a case's feedback on the same form",
    {
        when() {
            const answer = values =>
                visitor("submit#Form", {siteId: site, publicationId: ids.anonymous, values, operationId: key()})
            answer({rating: "fair"})
            // later the "good" option is rescored; the invited response keeps its 2
            as(users.author, F + "save#FormField", {
                formId: ids.form,
                fieldName: "rating",
                title: "How was it?",
                fieldTypeEnumId: "DBFFT_radio",
                isRequired: "Y",
                optionText: "good | Good | 5\nfair | Fair | 1\npoor | Poor | 0"
            })
            // a case's feedback on the same form: an invitation of a request with its response, outside every Marketing publication
            const caseResponse = system(() => {
                const formResponseId = run("org.moqui.impl.ScreenServices.create#FormResponse", {
                    formId: ids.form,
                    responseMap: {rating: "poor", comment: "Case text"}
                }).formResponseId
                make("mantle.party.FormInvitation", {
                    formId: ids.form,
                    organizationPartyId: orgA,
                    partyId: ids.Bob,
                    recordEntityName: "mantle.request.Request",
                    recordId: prefix + "_CASE",
                    invitationKey: prefix + ":case",
                    statusEnumId: "FinResponded",
                    formResponseId
                })
                return formResponseId
            })
            const byAudience = as(users.audience, M + "find#Responses", {formId: ids.form})
            const byAnalyst = as(users.analyst, M + "find#Responses", {formId: ids.form})
            const invitedRow = byAudience.rows.find(r => r.publicationId === ids.invited)
            const one = as(users.audience, M + "get#Response", {formResponseId: invitedRow.formResponseId})
            const caseRead = as(users.audience, M + "get#Response", {formResponseId: caseResponse})
            const byReader = as(users.reader, M + "find#Responses", {formId: ids.form})
            const otherOrg = as(users.authorB, M + "get#Response", {formResponseId: invitedRow.formResponseId})
            return {byAudience, byAnalyst, invitedRow, one, caseRead, caseResponse, byReader, otherOrg}
        },
        then(r) {
            r.byAudience.refusal === ""
            r.byAudience.rows.length === 2
            !r.byAudience.rows.some(x => x.formResponseId === r.caseResponse)
            r.invitedRow.respondentText === "Ann Formspec"
            r.invitedRow.scoreText === "2 of 2"
            r.byAudience.stats.answered === 2
            r.byAudience.stats.invited === 1 && r.byAudience.stats.answeredInvitations === 1
            r.byAudience.stats.averageText === "1.5"
            r.byAudience.stats.questions.find(q => q.fieldName === "rating").options.length === 2
            r.byAnalyst.rows.every(x => x.respondentText !== "Ann Formspec")
            r.one.response.answers.find(a => a.title === "How was it?").valueText === "Good"
            r.one.response.scoreText === "2 of 2"
            r.caseRead.refusal.includes("RECORD_UNAVAILABLE")
            // MARKETING_VIEW alone reads no survey response: its purposes are read by audience and report readers
            r.byReader.refusal.includes("PERMISSION_DENIED")
            r.otherOrg.refusal.includes("RECORD_UNAVAILABLE")
        }
    }
)
