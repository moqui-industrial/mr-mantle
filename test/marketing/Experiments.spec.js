// Marketing's experiments (impl-marketing P10; design-marketing §5 ExperimentDetail; mantle.marketing.CampaignSendServices over
// MarketingExperiments.js): a variant's change ends the send's approval; identical variants and a sample too small are refused at
// preparation; the two samples are equal and disjoint from each other and the remainder, and the same audience prepared again assigns
// everyone alike; the release sends the samples only, each recipient its one variant, the send then "Sample sent"; a test of a variant
// enters no result; with no observation the decision stays undecided, and a tie too; the winner is chosen by a dispatcher with a reason
// after the observation period, and released to the remainder once (a second release answers the first, whatever its key), leaving
// out a person who withdrew since and never mailing anyone twice; another organization's experiment is refused.
// Standalone: spec-local organizations, users, parties, a topic and a profile. Run: ./moq test mr-mantle --spec Experiments
const lib = ec.resource.script("component://mr-mantle/test/marketing/MarketingSpecLib.js")
const entityLib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const experimentsModule = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingExperiments.js")
const {make, row, rows, system, organization, user, as, run} = lib
const D = "mantle.marketing.CampaignSendServices."
const C = "mantle.marketing.CampaignServices."
const SEND = "mantle.marketing.campaign.CampaignSend"
const RECIPIENT = "mantle.marketing.campaign.CampaignRecipient"
const EXPERIMENT = "mantle.marketing.campaign.CampaignExperiment"
const capture = ec.factory.getTool("MailCapture")
const prefix = "MKX"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const topic = prefix + "_TOPIC"
const profile = prefix + "_PROFILE"
const relay = prefix + "_RELAY"
const testAddress = "tester@mkx.example.test"
const users = {}
const ids = {}
const dayMs = 86400000
const ago = days => new Date(Date.now() - days * dayMs)
const members = ["Ada", "Ben", "Cy", "Di", "Ed", "Flo", "Gil", "Hal", "Ivy", "Jo"]
const addressOf = name => name.toLowerCase() + "@experiment.example.test"
const settle = () => ec.factory.waitWorkerPoolEmpty(50)
const revisionOf = campaignSendId => entityLib.ms(row(SEND, {campaignSendId}).lastUpdatedStamp)
const sendRow = campaignSendId => row(SEND, {campaignSendId})
const current = campaignSendId => rows(RECIPIENT, {campaignSendId}).filter(r => r.statusId !== "CrsReplaced")
const experimentOf = campaignSendId => rows(EXPERIMENT, {campaignSendId}).find(r => r.endedDate == null)
const mailTo = address => Array.from(capture.getMessages()).filter(m => Array.from(m.toList || []).includes(address))
// the send's live recipients by address: {address: variant id, or "held"}
const assignmentOf = campaignSendId =>
    Object.fromEntries(current(campaignSendId).map(r => [r.destinationKey, r.campaignExperimentVariantId || "held"]))
const prepare = (username, campaignSendId) =>
    as(username, D + "prepare#Send", {campaignSendId, expectedRevision: revisionOf(campaignSendId)})
function approve(campaignSendId) {
    const targetRevision = Number(sendRow(campaignSendId).sendRevision)
    const asked = as(users.author, C + "request#MarketingApproval", {
        targetKind: "send",
        targetId: campaignSendId,
        targetRevision
    })
    if (asked.refusal) throw new Error("request: " + asked.refusal)
    const decided = as(users.approver, C + "decide#MarketingApproval", {
        targetKind: "send",
        targetId: campaignSendId,
        targetRevision,
        decision: "approve"
    })
    if (decided.refusal) throw new Error("decide: " + decided.refusal)
}

spec({
    setupSpec() {
        capture.enable()
        system(() => {
            organization(orgA, "Experiment A")
            organization(orgB, "Experiment B")
            users.author = user(prefix, "author", [orgA], ["MARKETING_VIEW", "MARKETING_CAMPAIGN_EDIT", "MARKETING_SEND_EDIT"])
            users.approver = user(prefix, "approver", [orgA], ["MARKETING_VIEW", "MARKETING_APPROVE"])
            users.dispatcher = user(prefix, "dispatcher", [orgA], ["MARKETING_VIEW", "MARKETING_DISPATCH"])
            users.dispatcherB = user(prefix, "dispatcherB", [orgB], ["MARKETING_VIEW", "MARKETING_DISPATCH"])
            make("mantle.marketing.contact.ContactList", {
                contactListId: topic,
                contactListName: "Experiment topic",
                contactListTypeEnumId: "NEWSLETTER",
                contactMechTypeEnumId: "CmtEmailAddress",
                ownerPartyId: orgA,
                singleUse: "N"
            })
            for (const name of members) {
                const partyId = (ids[name] = prefix + "_" + name.toUpperCase())
                make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson", ownerPartyId: orgA})
                make("mantle.party.Person", {partyId, firstName: name, lastName: "Experimentspec"})
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
                smtpHost: "relay.mkx.example.test",
                smtpPort: "9",
                webBaseUrl: "https://news.mkx.example.test"
            })
            make("moqui.basic.email.EmailAccount", {
                emailAccountId: prefix + "_BOUNCES",
                accountKindEnumId: "EakHosted",
                emailAddress: "bounces@bounce.mkx.example.test",
                statusId: "EasActive"
            })
            make("mantle.party.MessageSendingProfile", {
                sendingProfileId: profile,
                organizationPartyId: orgA,
                profileName: "Experiment news",
                channelEnumId: "MdcEmail",
                emailServerId: relay,
                fromAddress: "news@mkx.example.test",
                purposeEnumId: "MtpPromotional",
                trackingPolicyEnumId: "MtrNone",
                bounceDomain: "bounce.mkx.example.test",
                fromDate: ago(30)
            })
            make("mantle.marketing.campaign.MarketingPolicy", {
                organizationPartyId: orgA,
                fromDate: ago(5),
                selfApprovalAllowed: "N",
                testAddresses: testAddress
            })
        })
        ids.campaign = lib.campaign(users.author, orgA)
        system(() =>
            run("update#mantle.marketing.campaign.MarketingCampaign", {
                marketingCampaignId: ids.campaign,
                statusId: "MKTG_CAMP_APPROVED"
            })
        )
    },
    cleanupSpec() {
        settle()
        capture.reset()
    }
})

feature("variants are content of the send; samples equal, disjoint and stable; identical variants and a small sample refused", {
    when() {
        const made = as(users.author, D + "create#Send", {
            marketingCampaignId: ids.campaign,
            sendName: "Subject test",
            contactListId: topic,
            sendingProfileId: profile
        })
        const campaignSendId = (ids.send = made.campaignSendId)
        as(users.author, D + "store#SendContent", {
            campaignSendId,
            expectedRevision: revisionOf(campaignSendId),
            subject: "News for ${firstName}",
            body: "<p>Hello ${firstName}, the news.</p>",
            bodyText: "Hello ${firstName}, the news.",
            variables: [{name: "firstName", label: "First name", fallback: "friend"}]
        })
        const reader = as(users.dispatcher, D + "store#Experiment", {
            campaignSendId,
            expectedRevision: revisionOf(campaignSendId),
            samplePercent: 40
        })
        const setUp = as(users.author, D + "store#Experiment", {
            campaignSendId,
            expectedRevision: revisionOf(campaignSendId),
            samplePercent: 40,
            observationHours: 1
        })
        const [variantA, variantB] = rows("mantle.marketing.campaign.CampaignExperimentVariant", {
            campaignExperimentId: setUp.campaignExperimentId
        }).sort((a, b) => a.sequenceNum - b.sequenceNum)
        ids.variantA = variantA.campaignExperimentVariantId
        ids.variantB = variantB.campaignExperimentVariantId
        const same = prepare(users.author, campaignSendId)
        const scripted = as(users.author, D + "store#ExperimentVariant", {
            campaignSendId,
            campaignExperimentVariantId: ids.variantB,
            expectedRevision: revisionOf(campaignSendId),
            subject: "Last chance, ${firstName}",
            body: "<p>Hello<script>alert(1)</script></p>"
        })
        const storedB = as(users.author, D + "store#ExperimentVariant", {
            campaignSendId,
            campaignExperimentVariantId: ids.variantB,
            expectedRevision: revisionOf(campaignSendId),
            variantName: "Urgent",
            subject: "Last chance, ${firstName}"
        })
        const bRow = row("mantle.marketing.campaign.CampaignExperimentVariant", {campaignExperimentVariantId: ids.variantB})
        // a 10% sample of ten gives each variant no one
        as(users.author, D + "store#Experiment", {
            campaignSendId,
            expectedRevision: revisionOf(campaignSendId),
            samplePercent: 10
        })
        const small = prepare(users.author, campaignSendId)
        as(users.author, D + "store#Experiment", {
            campaignSendId,
            expectedRevision: revisionOf(campaignSendId),
            samplePercent: 40
        })
        const prepared = prepare(users.author, campaignSendId)
        const first = assignmentOf(campaignSendId)
        const again = prepare(users.author, campaignSendId)
        const second = assignmentOf(campaignSendId)
        approve(campaignSendId)
        const approvedStatus = sendRow(campaignSendId).statusId
        // a variant's change ends the approval and returns the send to draft
        const changed = as(users.author, D + "store#ExperimentVariant", {
            campaignSendId,
            campaignExperimentVariantId: ids.variantB,
            expectedRevision: revisionOf(campaignSendId),
            subject: "Last call, ${firstName}"
        })
        const afterChange = sendRow(campaignSendId)
        // the setup is the send's as approved: storing it unchanged keeps the approval, a new observation period ends it (P10 review)
        prepare(users.author, campaignSendId)
        approve(campaignSendId)
        const unchanged = as(users.author, D + "store#Experiment", {
            campaignSendId,
            expectedRevision: revisionOf(campaignSendId),
            observationHours: 1
        })
        const unchangedStatus = sendRow(campaignSendId).statusId
        const observed = as(users.author, D + "store#Experiment", {
            campaignSendId,
            expectedRevision: revisionOf(campaignSendId),
            observationHours: 3
        })
        const observedStatus = sendRow(campaignSendId).statusId
        as(users.author, D + "store#Experiment", {
            campaignSendId,
            expectedRevision: revisionOf(campaignSendId),
            observationHours: 1
        })
        const shown = as(users.author, D + "get#Send", {campaignSendId})
        return {
            unchanged,
            unchangedStatus,
            observed,
            observedStatus,
            reader,
            setUp,
            same,
            scripted,
            storedB,
            bRow,
            small,
            prepared,
            first,
            again,
            second,
            approvedStatus,
            changed,
            afterChange,
            shown
        }
    },
    then({
        unchanged,
        unchangedStatus,
        observed,
        observedStatus,
        reader,
        setUp,
        same,
        scripted,
        storedB,
        bRow,
        small,
        prepared,
        first,
        again,
        second,
        approvedStatus,
        changed,
        afterChange,
        shown
    }) {
        reader.refusal.includes("PERMISSION_DENIED")
        setUp.refusal == ""
        same.refusal.includes("VARIANTS_SAME")
        scripted.refusal != ""
        storedB.refusal == ""
        // only the subject is the variant's own: its body is the send's
        bRow.subject == "Last chance, ${firstName}" && bRow.bodyLocation == null && bRow.variantName == "Urgent"
        small.refusal.includes("SAMPLE_TOO_SMALL")
        prepared.refusal == ""
        prepared.eligibleCount == 10 && prepared.sampleCount == 4 && prepared.remainderCount == 6
        Object.values(first).filter(v => v == ids.variantA).length == 2
        Object.values(first).filter(v => v == ids.variantB).length == 2
        Object.values(first).filter(v => v == "held").length == 6
        Object.keys(first).length == 10
        // the same audience prepared again assigns everyone alike
        again.refusal == ""
        JSON.stringify(second) == JSON.stringify(first)
        approvedStatus == "CsApproved"
        changed.refusal == "" && changed.approvalEnded == true
        afterChange.statusId == "CsDraft"
        unchanged.refusal == "" && unchanged.approvalEnded == false && unchangedStatus == "CsApproved"
        observed.refusal == "" && observed.approvalEnded == true && observedStatus == "CsDraft"
        shown.experiment.exists == true && shown.experiment.samplePercent == 40
        shown.experiment.variants.length == 2
        shown.approvalProblems.some(problem => problem.includes("prepared"))
    }
})

feature(
    "the release sends each sample its one variant; a test enters no result; with no observations the decision stays undecided",
    {
        when() {
            const campaignSendId = ids.send
            prepare(users.author, campaignSendId)
            ids.assignment = assignmentOf(campaignSendId)
            approve(campaignSendId)
            const tested = as(users.author, D + "test#Send", {
                campaignSendId,
                toAddress: testAddress,
                campaignExperimentVariantId: ids.variantB
            })
            const testSubject = String((mailTo(testAddress)[0] || {}).subject || "")
            const beforeRelease = as(users.author, D + "get#Experiment", {campaignSendId})
            capture.clear()
            const released = as(users.dispatcher, D + "release#Send", {
                campaignSendId,
                expectedRevision: revisionOf(campaignSendId)
            })
            settle()
            system(() => run(D + "dispatch#Send", {campaignSendId}))
            const status = sendRow(campaignSendId).statusId
            // a second release of the send answers the first while its sample is sent (P10 review)
            const releasedAgain = as(users.dispatcher, D + "release#Send", {
                campaignSendId,
                expectedRevision: revisionOf(campaignSendId)
            })
            const mails = Object.fromEntries(
                members.map(name => [addressOf(name), mailTo(addressOf(name)).map(m => String(m.subject || ""))])
            )
            const shown = as(users.dispatcher, D + "get#Experiment", {campaignSendId})
            const early = as(users.dispatcher, D + "choose#ExperimentWinner", {
                campaignSendId,
                campaignExperimentVariantId: ids.variantB,
                expectedRevision: entityLib.ms(experimentOf(campaignSendId).lastUpdatedStamp),
                reason: "Too soon"
            })
            const tie = experimentsModule.compare([
                {variantId: "A", observed: 3, denominator: 10},
                {variantId: "B", observed: 3, denominator: 10}
            ])
            const lead = experimentsModule.compare([
                {variantId: "A", observed: 3, denominator: 10},
                {variantId: "B", observed: 5, denominator: 10}
            ])
            return {tested, testSubject, beforeRelease, released, releasedAgain, status, mails, shown, early, tie, lead}
        },
        then({tested, testSubject, beforeRelease, released, releasedAgain, status, mails, shown, early, tie, lead}) {
            tested.refusal == ""
            testSubject == "[TEST] Last call, Alex"
            // a test is no recipient and no result
            beforeRelease.variantList.every(v => v.assignedCount == 2 && v.acceptedCount == 0)
            released.refusal == "" && released.recipientCount == 4
            status == "CsSampleSent"
            releasedAgain.refusal == "" && releasedAgain.alreadyReleased == true && releasedAgain.recipientCount == 4
            // each sample recipient got one message of its variant; the remainder got none
            Object.entries(ids.assignment).every(([address, variant]) =>
                variant == "held"
                    ? mails[address].length == 0
                    : mails[address].length == 1 &&
                      mails[address][0].startsWith(variant == ids.variantB ? "Last call," : "News for")
            )
            shown.variantList.every(v => v.assignedCount == 2 && v.acceptedCount == 2 && v.clicksText == "0")
            shown.remainder.heldCount == 6
            shown.decision.decided == false && shown.experiment.winnerVariantId == null
            shown.capabilities.canChoose == false
            early.refusal.includes("OBSERVATION_OPEN")
            tie.decided == false && tie.leaderVariantId == null
            lead.decided == true && lead.leaderVariantId == "B"
        }
    }
)

feature("a dispatcher chooses the winner with a reason; its release reaches the remainder once, leaving out who withdrew since", {
    when() {
        const campaignSendId = ids.send
        // the observation period (one hour) passed: the release two hours ago
        system(() => run("update#" + SEND, {campaignSendId, releasedDate: new Date(Date.now() - 2 * 3600000)}))
        const revision = () => entityLib.ms(experimentOf(campaignSendId).lastUpdatedStamp)
        const byAuthor = as(users.author, D + "choose#ExperimentWinner", {
            campaignSendId,
            campaignExperimentVariantId: ids.variantB,
            expectedRevision: revision(),
            reason: "More opens"
        })
        const otherOrganization = as(users.dispatcherB, D + "get#Experiment", {campaignSendId})
        const noReason = as(users.dispatcher, D + "choose#ExperimentWinner", {
            campaignSendId,
            campaignExperimentVariantId: ids.variantB,
            expectedRevision: revision()
        })
        const unreleased = as(users.dispatcher, D + "release#ExperimentWinner", {campaignSendId})
        const chosen = as(users.dispatcher, D + "choose#ExperimentWinner", {
            campaignSendId,
            campaignExperimentVariantId: ids.variantB,
            expectedRevision: revision(),
            reason: "The urgent subject read better in replies"
        })
        // one of the remainder withdraws from the topic before the release
        const remainder = Object.entries(ids.assignment)
            .filter(([, variant]) => variant == "held")
            .map(([address]) => address)
        const leaver = members.find(name => addressOf(name) == remainder[0])
        system(() =>
            make("mantle.party.PartyConsent", {
                partyId: ids[leaver],
                contactListId: topic,
                purposeEnumId: "PcpMarketingEmail",
                statusId: "PconWithdrawn",
                consentDate: ago(0.001),
                sourceEnumId: "PcsEmailLink"
            })
        )
        capture.clear()
        // a release naming another winner than the one chosen is refused (P10 review)
        const wrongWinner = as(users.dispatcher, D + "release#ExperimentWinner", {
            campaignSendId,
            campaignExperimentVariantId: ids.variantA
        })
        const released = as(users.dispatcher, D + "release#ExperimentWinner", {
            campaignSendId,
            campaignExperimentVariantId: ids.variantB,
            operationKey: "first"
        })
        settle()
        system(() => run(D + "dispatch#Send", {campaignSendId}))
        const again = as(users.dispatcher, D + "release#ExperimentWinner", {
            campaignSendId,
            campaignExperimentVariantId: ids.variantB,
            operationKey: "second"
        })
        const againOther = as(users.dispatcher, D + "release#ExperimentWinner", {
            campaignSendId,
            campaignExperimentVariantId: ids.variantA,
            operationKey: "third"
        })
        settle()
        const mails = Object.fromEntries(remainder.map(address => [address, mailTo(address).map(m => String(m.subject || ""))]))
        const sampleMails = Object.entries(ids.assignment)
            .filter(([, variant]) => variant != "held")
            .reduce((sum, [address]) => sum + mailTo(address).length, 0)
        const leaverRow = current(campaignSendId).find(r => r.destinationKey == remainder[0])
        const rechosen = as(users.dispatcher, D + "choose#ExperimentWinner", {
            campaignSendId,
            campaignExperimentVariantId: ids.variantA,
            expectedRevision: revision(),
            reason: "Changed my mind"
        })
        return {
            byAuthor,
            otherOrganization,
            noReason,
            unreleased,
            chosen,
            wrongWinner,
            released,
            again,
            againOther,
            mails,
            sampleMails,
            leaver: remainder[0],
            leaverRow,
            rechosen,
            status: sendRow(campaignSendId).statusId,
            experiment: experimentOf(campaignSendId)
        }
    },
    then({
        byAuthor,
        otherOrganization,
        noReason,
        unreleased,
        chosen,
        wrongWinner,
        released,
        again,
        againOther,
        mails,
        sampleMails,
        leaver,
        leaverRow,
        rechosen,
        status,
        experiment
    }) {
        byAuthor.refusal.includes("PERMISSION_DENIED")
        otherOrganization.refusal.includes("RECORD_UNAVAILABLE")
        noReason.refusal.includes("REASON_REQUIRED")
        unreleased.refusal.includes("WINNER_REQUIRED")
        chosen.refusal == "" && chosen.winnerVariantId == ids.variantB
        experiment.winnerReason == "The urgent subject read better in replies"
        released.refusal == "" && released.releasedCount == 5 && released.droppedCount == 1
        // a second release, with another key, answers the first and sends nothing more
        again.refusal == "" && again.alreadyReleased == true && again.releasedCount == 5
        // a call naming the other variant is refused before the release and after it, never answered as released
        wrongWinner.refusal.includes("WINNER_CHANGED") && againOther.refusal.includes("WINNER_CHANGED")
        leaverRow.statusId == "CrsSkipped" && leaverRow.skipReasonCode == "AUDIENCE_LEFT"
        mails[leaver].length == 0
        Object.entries(mails).every(
            ([address, subjects]) => address == leaver || (subjects.length == 1 && subjects[0].startsWith("Last call,"))
        )
        // no sample recipient was mailed again
        sampleMails == 0
        status == "CsCompleted"
        rechosen.refusal.includes("WINNER_RELEASED")
    }
})
