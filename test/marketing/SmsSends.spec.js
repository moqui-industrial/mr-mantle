// Marketing's text message sends (impl-marketing P22; design-marketing §5 NewSend and Compose, §12 SendingProfiles; MessageSms.js,
// the SMS branches of MessageSendingProfiles.js, MessageDeliveries.js, MarketingSends.js and MarketingDispatch.js): an SMS profile is
// bound to one of the organization's messaging numbers and ready only with its messaging bridge; no SMS send without a ready SMS
// profile; no text without PcpSms on the topic, with the segments and cost estimate shown before approval; Mantle's sms-consent
// answer (the framework asks it for the system's dispatch too) says no for a number whose consent is with another organization only;
// a STOP withdraws and suppresses once, a START ends neither, and the next preparation leaves the person out; an uncertain text is
// never handed off again; an automation of a list of phone numbers takes Send SMS steps, never Send email. The provider: the framework's Telnyx adapter at a closed loopback port, so a hand-off is refused before it
// is taken (a retryable outcome, its place in the number's day given back) and nothing leaves the machine; the provider's own
// answers are moqui-channels' tests.
// Standalone: spec-local organizations, users, numbers, parties, lists and profiles. Run: ./moq test mr-mantle --spec SmsSends
const lib = ec.resource.script("component://mr-mantle/test/marketing/MarketingSpecLib.js")
const entityLib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {make, row, rows, system, organization, user, as, run} = lib
const D = "mantle.marketing.CampaignSendServices."
const C = "mantle.marketing.CampaignServices."
const M = "mantle.party.MessageServices."
const SEND = "mantle.marketing.campaign.CampaignSend"
const RECIPIENT = "mantle.marketing.campaign.CampaignRecipient"
const DELIVERY = "mantle.party.MessageDelivery"
const prefix = "MKSMS"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const topic = prefix + "_TOPIC",
    emailTopic = prefix + "_EMAIL_TOPIC"
const bridge = prefix + "_BRIDGE"
// our numbers: orgA's with messaging, orgA's without, and one no organization has
const OURS = "+15550007100",
    BARE = "+15550007101",
    STRAY = "+15550007102"
const numbers = {Ann: "+15550107111", Bob: "+15550107112", Cal: "+15550107113"}
const users = {}
const ids = {}
const dayMs = 86400000
const ago = days => new Date(Date.now() - days * dayMs)
const revisionOf = campaignSendId => entityLib.ms(row(SEND, {campaignSendId}).lastUpdatedStamp)
const sendRow = campaignSendId => row(SEND, {campaignSendId})
const recipientsOf = campaignSendId => rows(RECIPIENT, {campaignSendId}).filter(r => r.statusId !== "CrsReplaced")
const deliveriesOf = campaignSendId =>
    Array.from(
        ec.entity
            .find(DELIVERY)
            .condition("eventKey", "like", "CampaignSend:" + campaignSendId + ":%")
            .disableAuthz()
            .list()
    )
const settle = () => ec.factory.waitWorkerPoolEmpty(50)
const today = () => new Date().toISOString().slice(0, 10)
const promoCount = () => Number(row("moqui.call.SmsSendCount", {counterKey: "promo:" + OURS, dayDate: today()})?.sentCount || 0)
const consentRows = (partyId, statusId) =>
    rows("mantle.party.PartyConsent", {partyId, purposeEnumId: "PcpSms", statusId}).filter(r => !r.contactListId)
const stopBlocks = destinationKey =>
    rows("mantle.party.MessageSuppression", {channelEnumId: "MdcSms", destinationKey, reasonEnumId: "MsrSmsStop"})
function phone(partyId, number, organizationPartyId = null) {
    const contactMechId = partyId + "_TN"
    make("mantle.party.contact.ContactMech", {contactMechId, contactMechTypeEnumId: "CmtTelecomNumber"})
    make("mantle.party.contact.TelecomNumber", {
        contactMechId,
        countryCode: "1",
        areaCode: number.slice(2, 5),
        contactNumber: number.slice(5, 8) + "-" + number.slice(8)
    })
    make("mantle.party.contact.PartyContactMech", {
        partyId,
        contactMechId,
        contactMechPurposeId: organizationPartyId ? "PhonePrimary" : "PhoneMobile",
        fromDate: ago(30)
    })
    return contactMechId
}
// a keyword the framework keeps (as SmsServices receive#Sms does for a text from theirs): its SmsOptOut row
const keyword = (theirs, word) =>
    system(() => run("org.moqui.call.SmsServices.note#SmsKeyword", {ourNumber: OURS, theirNumber: theirs, keyword: word}))
// an SMS send of the topic with its text, prepared and approved: its id
function approvedSend(name) {
    const made = as(users.author, D + "create#Send", {
        marketingCampaignId: ids.campaign,
        sendName: name,
        contactListId: topic,
        sendingProfileId: ids.smsProfile
    })
    if (made.refusal) throw new Error("create: " + made.refusal)
    const campaignSendId = made.campaignSendId
    const stored = as(users.author, D + "store#SendContent", {
        campaignSendId,
        expectedRevision: revisionOf(campaignSendId),
        bodyText: "Hi ${firstName}, 20% off this weekend at Sms Spec.",
        variables: [{name: "firstName", label: "First name", fallback: "friend"}]
    })
    if (stored.refusal) throw new Error("content: " + stored.refusal)
    const prepared = as(users.author, D + "prepare#Send", {campaignSendId, expectedRevision: revisionOf(campaignSendId)})
    if (prepared.refusal) throw new Error("prepare: " + prepared.refusal)
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
    return campaignSendId
}

spec({
    stepwise: true,
    setupSpec() {
        system(() => {
            organization(orgA, "Sms Spec A")
            organization(orgB, "Sms Spec B")
            users.author = user(
                prefix,
                "author",
                [orgA],
                [
                    "MARKETING_VIEW",
                    "MARKETING_CAMPAIGN_EDIT",
                    "MARKETING_SEND_EDIT",
                    "MESSAGE_TEMPLATE_VIEW",
                    "MESSAGE_TEMPLATE_EDIT"
                ]
            )
            users.approver = user(prefix, "approver", [orgA], ["MARKETING_VIEW", "MARKETING_APPROVE"])
            users.dispatcher = user(prefix, "dispatcher", [orgA], ["MARKETING_VIEW", "MARKETING_DISPATCH"])
            users.configurer = user(prefix, "configurer", [orgA], ["MARKETING_VIEW", "MESSAGE_SENDING_CONFIGURE"])
            // the messaging bridge: the framework's Telnyx adapter at a closed loopback port (nothing is taken)
            make("moqui.chat.ChatBridge", {
                chatBridgeId: bridge,
                typeEnumId: "CbtSms",
                adapterName: "sms",
                name: "Sms spec",
                statusId: "CbsConnected",
                configJson: JSON.stringify({apiKey: "spec-key", apiBaseUrl: "http://127.0.0.1:9", allowInternalAddresses: true})
            })
            make("moqui.call.PhoneNumber", {phoneNumber: OURS, messagingBridgeId: bridge, description: "Sms spec texts"})
            make("moqui.call.PhoneNumber", {phoneNumber: BARE, description: "Sms spec, no messaging"})
            make("moqui.call.PhoneNumber", {phoneNumber: STRAY, messagingBridgeId: bridge})
            phone(orgA, OURS, orgA)
            make("mantle.party.contact.ContactMech", {contactMechId: orgA + "_TN2", contactMechTypeEnumId: "CmtTelecomNumber"})
            make("mantle.party.contact.TelecomNumber", {
                contactMechId: orgA + "_TN2",
                countryCode: "1",
                areaCode: "555",
                contactNumber: "000-7101"
            })
            make("mantle.party.contact.PartyContactMech", {
                partyId: orgA,
                contactMechId: orgA + "_TN2",
                contactMechPurposeId: "PhoneWork",
                fromDate: ago(30)
            })
            for (const [contactListId, contactListName, mech] of [
                [topic, "Weekend texts", "CmtTelecomNumber"],
                [emailTopic, "Weekend email", "CmtEmailAddress"]
            ])
                make("mantle.marketing.contact.ContactList", {
                    contactListId,
                    contactListName,
                    contactListTypeEnumId: "NEWSLETTER",
                    contactMechTypeEnumId: mech,
                    ownerPartyId: orgA
                })
            // Ann and Bob are members of the topic; Ann granted PcpSms on it, Bob none; Cal granted PcpSms with orgB only
            for (const name of ["Ann", "Bob", "Cal"]) {
                const partyId = (ids[name] = prefix + "_" + name.toUpperCase())
                make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson", ownerPartyId: orgA})
                make("mantle.party.Person", {partyId, firstName: name, lastName: "Smsspec"})
                const mech = phone(partyId, numbers[name])
                if (name === "Cal") {
                    make("mantle.party.PartyConsent", {
                        partyId,
                        purposeEnumId: "PcpSms",
                        organizationPartyId: orgB,
                        statusId: "PconGranted",
                        consentDate: ago(10),
                        sourceEnumId: "PcsForm",
                        evidenceText: "Spec sign-up with B"
                    })
                    continue
                }
                make("mantle.marketing.contact.ContactListParty", {
                    contactListId: topic,
                    partyId,
                    fromDate: ago(20),
                    statusId: "CLPT_ACCEPTED",
                    preferredContactMechId: mech
                })
                if (name === "Ann")
                    make("mantle.party.PartyConsent", {
                        partyId,
                        contactMechId: mech,
                        contactListId: topic,
                        purposeEnumId: "PcpSms",
                        statusId: "PconGranted",
                        consentDate: ago(19),
                        sourceEnumId: "PcsForm",
                        evidenceText: "Spec text sign-up"
                    })
            }
            make("mantle.party.MessageSendingProfile", {
                sendingProfileId: prefix + "_EMAIL",
                organizationPartyId: orgA,
                profileName: "Sms spec email",
                channelEnumId: "MdcEmail",
                fromAddress: "news@mksms.example.test",
                purposeEnumId: "MtpPromotional",
                bounceDomain: "bounce.mksms.example.test",
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
    },
    cleanupSpec() {
        settle()
        system(() => {
            ec.entity.find("moqui.call.SmsOptOut").condition("phoneNumber", OURS).disableAuthz().deleteAll()
            ec.entity
                .find("moqui.call.PhoneNumber")
                .condition("phoneNumber", "in", [OURS, BARE, STRAY])
                .disableAuthz()
                .deleteAll()
        })
    }
})

feature("an SMS profile is bound to one of the organization's messaging numbers and ready only with its messaging bridge", {
    when() {
        const store = number =>
            as(users.configurer, M + "store#SendingProfile", {
                organizationPartyId: orgA,
                profileName: "Weekend texts " + number,
                channelEnumId: "MdcSms",
                fromPhoneNumber: number,
                purposeEnumId: "MtpPromotional",
                segmentCost: "0.0079",
                segmentCostUomId: "USD"
            })
        const stray = store(STRAY)
        const made = store(OURS)
        ids.smsProfile = made.sendingProfileId
        const listed = as(users.configurer, M + "find#SendingProfiles", {organizationPartyId: orgA, channelEnumId: "MdcSms"})
        const checked = as(users.configurer, M + "check#SendingProfile", {sendingProfileId: ids.smsProfile})
        // a profile bound to the number with no messaging bridge (made as the data would be, since the store refuses it)
        system(() =>
            make("mantle.party.MessageSendingProfile", {
                sendingProfileId: prefix + "_BARE",
                organizationPartyId: orgA,
                profileName: "Sms spec bare",
                channelEnumId: "MdcSms",
                fromPhoneNumber: BARE,
                purposeEnumId: "MtpPromotional",
                fromDate: ago(30)
            })
        )
        const bare = as(users.configurer, M + "check#SendingProfile", {sendingProfileId: prefix + "_BARE"})
        const numbers = JSON.parse(JSON.stringify(listed.numberOptions || []))
            .map(option => option.value)
            .join(",")
        return {stray, made, numbers, checked, bare}
    },
    then(r) {
        // a number no organization of the profile's has is refused; one of its messaging numbers is taken
        r.stray.refusal.includes("NUMBER_INVALID")
        r.made.refusal == ""
        r.numbers == OURS
        r.checked.ready == true
        r.bare.ready == false
        JSON.stringify(r.bare.reasons).includes("no messaging bridge")
    }
})

feature("no SMS send without a ready SMS profile, and an email profile never sends a text", {
    when() {
        const create = (sendingProfileId, contactListId = topic) =>
            as(users.author, D + "create#Send", {
                marketingCampaignId: ids.campaign,
                sendName: "Texts",
                contactListId,
                sendingProfileId
            })
        return {
            noProfile: create(null),
            notReady: create(prefix + "_BARE"),
            emailProfile: create(prefix + "_EMAIL"),
            smsOnEmailTopic: create(ids.smsProfile, emailTopic),
            made: create(ids.smsProfile)
        }
    },
    then(r) {
        r.noProfile.refusal.includes("CHANNEL_UNAVAILABLE")
        r.notReady.refusal.includes("CHANNEL_UNAVAILABLE")
        r.emailProfile.refusal.includes("PROFILE_CHANNEL")
        r.smsOnEmailTopic.refusal.includes("PROFILE_CHANNEL")
        r.made.refusal == ""
        sendRow(r.made.campaignSendId).channelEnumId == "MdcSms"
    }
})

feature("no text without PcpSms on the topic; the segments and cost estimate are shown before approval", {
    when() {
        const campaignSendId = (ids.first = approvedSend("Weekend texts"))
        const read = as(users.approver, D + "get#Send", {campaignSendId})
        const recipients = recipientsOf(campaignSendId)
        // a delivery queued for Bob anyway (as the ledger would get one) is refused at the attempt, before any hand-off
        const before = promoCount()
        const bob = system(() =>
            run(M + "queue#Delivery", {
                eventKey: prefix + ":bob",
                sourceEnumId: "MdsrcCampaignSend",
                recipientPartyId: ids.Bob,
                toAddress: numbers.Bob,
                channelEnumId: "MdcSms",
                templateKey: "MANTLE_CAMPAIGN_SEND",
                organizationPartyId: orgA,
                sendingProfileId: ids.smsProfile,
                transactional: false,
                marketingPurposeEnumId: "PcpSms",
                consentContactListId: topic,
                consentOrganizationPartyId: orgA,
                sendNow: true
            })
        )
        return {read, recipients, bob, countUnchanged: promoCount() === before}
    },
    then(r) {
        r.read.refusal == ""
        r.recipients.length == 1
        r.recipients[0].partyId == ids.Ann
        r.recipients[0].destinationKey == numbers.Ann
        r.read.smsEstimate.encoding == "GSM-7"
        r.read.smsEstimate.segmentCount == 1
        r.read.smsEstimate.estimateText.includes("1 segment")
        r.read.smsEstimate.estimateText.includes("for 1 recipient")
        r.bob.stateEnumId == "MdsSuppressed"
        r.countUnchanged == true
    }
})

feature(
    "the dispatch, as the system, passes Mantle's sms-consent and hands the text to the framework; a refused hand-off is retried",
    {
        when() {
            const campaignSendId = ids.first
            const released = as(users.dispatcher, D + "release#Send", {
                campaignSendId,
                expectedRevision: revisionOf(campaignSendId)
            })
            settle()
            system(() => run(D + "dispatch#Send", {campaignSendId}))
            settle()
            // the ledger's job, as it runs every minute
            system(() => run(M + "run#Deliveries", {}))
            const delivery = deliveriesOf(campaignSendId)[0] || {}
            const attempts = rows("mantle.party.MessageDeliveryAttempt", {deliveryId: delivery.deliveryId})
            return {released, delivery, attempts, promo: promoCount()}
        },
        then(r) {
            r.released.refusal == ""
            // the consent hook said yes (no consentRequired) and the provider was not reached: retryable, its count given back
            r.delivery.toAddress == numbers.Ann
            r.delivery.channelEnumId == "MdcSms"
            r.delivery.stateEnumId == "MdsRetry"
            r.attempts.length == 1
            r.attempts[0].outcome == "retryable"
            r.promo == 0
        }
    }
)

feature("an uncertain text is never handed off again", {
    when() {
        const delivery = deliveriesOf(ids.first)[0]
        // the provider's answer lost (what moqui-channels' adapter answers then): the delivery waits for review
        system(() =>
            run("update#" + DELIVERY, {deliveryId: delivery.deliveryId, stateEnumId: "MdsUncertain", nextAttemptDate: ago(1)})
        )
        system(() => run(M + "run#Deliveries", {}))
        return {
            delivery: row(DELIVERY, {deliveryId: delivery.deliveryId}),
            attempts: rows("mantle.party.MessageDeliveryAttempt", {deliveryId: delivery.deliveryId})
        }
    },
    then(r) {
        r.delivery.stateEnumId == "MdsUncertain"
        r.attempts.length == 1
    }
})

feature("Mantle's sms-consent answers no for a number with consent to another organization only", {
    when() {
        const ask = (fromNumber, toNumber) =>
            system(() => run("mantle.party.MessageSmsServices.check#SmsConsent", {fromNumber, toNumber})).consent
        return {
            ann: ask(OURS, numbers.Ann),
            cal: ask(OURS, numbers.Cal),
            bob: ask(OURS, numbers.Bob),
            stray: ask(STRAY, numbers.Ann)
        }
    },
    then(r) {
        r.ann == true
        r.cal == false
        r.bob == false
        // a number no organization owns
        r.stray == false
    }
})

feature("a STOP withdraws and suppresses once, a START ends neither, and the next preparation leaves the person out", {
    when() {
        keyword(numbers.Ann, "STOP")
        keyword(numbers.Ann, "STOP")
        const afterStop = {withdrawals: consentRows(ids.Ann, "PconWithdrawn").length, blocks: stopBlocks(numbers.Ann).length}
        keyword(numbers.Ann, "START")
        const afterStart = {
            withdrawals: consentRows(ids.Ann, "PconWithdrawn").length,
            activeBlocks: stopBlocks(numbers.Ann).filter(block => block.thruDate == null).length
        }
        const consent = system(() =>
            run("mantle.party.MessageSmsServices.check#SmsConsent", {fromNumber: OURS, toNumber: numbers.Ann})
        ).consent
        const next = as(users.author, D + "create#Send", {
            marketingCampaignId: ids.campaign,
            sendName: "Next weekend",
            contactListId: topic,
            sendingProfileId: ids.smsProfile
        })
        as(users.author, D + "store#SendContent", {
            campaignSendId: next.campaignSendId,
            expectedRevision: revisionOf(next.campaignSendId),
            bodyText: "Next weekend too."
        })
        const prepared = as(users.author, D + "prepare#Send", {
            campaignSendId: next.campaignSendId,
            expectedRevision: revisionOf(next.campaignSendId)
        })
        return {afterStop, afterStart, consent, prepared, withdrawal: consentRows(ids.Ann, "PconWithdrawn")[0] || {}}
    },
    then(r) {
        r.afterStop.withdrawals == 1
        r.afterStop.blocks == 1
        r.withdrawal.organizationPartyId == orgA
        r.withdrawal.sourceEnumId == "PcsSmsReply"
        r.afterStart.withdrawals == 1
        r.afterStart.activeBlocks == 1
        r.consent == false
        r.prepared.refusal == ""
        r.prepared.eligibleCount == 0
    }
})

feature(
    "an automation of a list of phone numbers takes Send SMS steps, its text a template's text alternative, never Send email",
    {
        when() {
            const A = "mantle.marketing.AutomationServices."
            const template = as(users.author, M + "create#Template", {
                organizationPartyId: orgA,
                templateName: "Weekend text",
                purposeEnumId: "MtpPromotional"
            }).messageTemplateId
            as(users.author, M + "store#TemplateContent", {
                messageTemplateId: template,
                expectedRevision: entityLib.ms(
                    row("mantle.party.MessageTemplate", {messageTemplateId: template}).lastUpdatedStamp
                ),
                subject: "Weekend",
                body: "<p>Weekend</p>",
                bodyText: "Hi ${firstName}, see you this weekend.",
                variables: [{name: "firstName", label: "First name", fallback: "friend"}]
            })
            const content = row("mantle.party.MessageTemplateContent", {messageTemplateId: template, contentSeqId: "001"})
            as(users.author, M + "publish#Template", {
                messageTemplateId: template,
                expectedRevision: entityLib.ms(content.lastUpdatedStamp),
                reason: "Weekend"
            })
            const made = as(users.author, A + "create#Automation", {
                marketingCampaignId: ids.campaign,
                automationName: "Weekend texts",
                contactListId: topic,
                sendingProfileId: ids.smsProfile
            })
            const revision = () =>
                entityLib.ms(
                    row("mantle.marketing.automation.MarketingAutomation", {marketingAutomationId: made.marketingAutomationId})
                        .lastUpdatedStamp
                )
            const email = as(users.author, A + "store#Steps", {
                marketingAutomationId: made.marketingAutomationId,
                expectedRevision: revision(),
                steps: [{kind: "send", stepName: "Hello", messageTemplateId: template}]
            })
            const sms = as(users.author, A + "store#Steps", {
                marketingAutomationId: made.marketingAutomationId,
                expectedRevision: revision(),
                steps: [{kind: "sms", stepName: "Hello", messageTemplateId: template}]
            })
            const step =
                rows("mantle.marketing.automation.MarketingAutomationStep", {
                    marketingAutomationId: made.marketingAutomationId
                })[0] || {}
            const stepSend = step.campaignSendId ? sendRow(step.campaignSendId) : {}
            return {made, email, sms, step, stepSend}
        },
        then(r) {
            r.made.refusal == ""
            row("mantle.marketing.automation.MarketingAutomation", {marketingAutomationId: r.made.marketingAutomationId})
                .channelEnumId == "MdcSms"
            r.email.refusal.includes("CHANNEL_INVALID")
            r.sms.refusal == ""
            r.step.stepKindEnumId == "AskSendSms"
            r.stepSend.channelEnumId == "MdcSms"
            r.stepSend.preparedSubject == null
        }
    }
)
