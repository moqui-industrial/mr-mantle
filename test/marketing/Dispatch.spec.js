// Marketing's dispatch and delivery (impl-marketing P9; design-marketing §5 SendControl, CampaignDelivery, RecipientDetail, §15.2;
// mantle.marketing.CampaignSendServices over MarketingDispatch.js): a release needs the dispatch permission, a current approval and a
// ready profile, each refused alone, and a second release answers the first; each recipient's message carries the List-Unsubscribe
// header and link, the VERP bounce address and the send's reply-to, and the send completes; a withdrawal, a new suppression and a
// changed address after preparation skip those recipients while the others send, and a new member is never added; the one-person
// team's author releases a self-approved send under the flag, refused at 500 recipients or with the flag off; a single-use list is
// held by one send at a time; a page claimed again after its lease ends hands each recipient off once; pause and cancel stop new
// claims; an uncertain delivery is reconciled by a dispatcher who reviews deliveries, of the send's organization only.
// Standalone: spec-local organizations, users, parties, lists and a profile. Run: ./moq test mr-mantle --spec Dispatch
const lib = ec.resource.script("component://mr-mantle/test/marketing/MarketingSpecLib.js")
const entityLib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {make, row, rows, system, organization, user, as, run} = lib
const D = "mantle.marketing.CampaignSendServices."
const C = "mantle.marketing.CampaignServices."
const SEND = "mantle.marketing.campaign.CampaignSend"
const RECIPIENT = "mantle.marketing.campaign.CampaignRecipient"
const DELIVERY = "mantle.party.MessageDelivery"
const capture = ec.factory.getTool("MailCapture")
const prefix = "MKD"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const topic = prefix + "_TOPIC",
    single = prefix + "_SINGLE"
const profile = prefix + "_PROFILE"
const relay = prefix + "_RELAY"
const linkRoot = "https://news.mkd.example.test"
const users = {}
const ids = {}
const dayMs = 86400000
const ago = days => new Date(Date.now() - days * dayMs)
const members = ["Ann", "Bob", "Cal", "Dan", "Eve"]
ids.Fay = prefix + "_FAY"
const addressOf = name => name.toLowerCase() + "@dispatch.example.test"
const settle = () => ec.factory.waitWorkerPoolEmpty(50)
const revisionOf = campaignSendId => entityLib.ms(row(SEND, {campaignSendId}).lastUpdatedStamp)
const sendRow = campaignSendId => row(SEND, {campaignSendId})
const recipientsOf = campaignSendId => rows(RECIPIENT, {campaignSendId}).filter(r => r.statusId !== "CrsReplaced")
const byStatus = (campaignSendId, statusId) => recipientsOf(campaignSendId).filter(r => r.statusId === statusId)
const mailTo = address => Array.from(capture.getMessages()).filter(m => Array.from(m.toList || []).includes(address))
const deliveriesOf = campaignSendId =>
    Array.from(
        ec.entity
            .find(DELIVERY)
            .condition("eventKey", "like", "CampaignSend:" + campaignSendId + ":%")
            .disableAuthz()
            .list()
    )
// a send of the topic with its own content, prepared, asked and decided by the users given: its id
function approvedSend(fields = {}, author = users.author, approver = users.approver) {
    const made = as(
        author,
        D + "create#Send",
        Object.assign(
            {marketingCampaignId: ids.campaign, sendName: "Dispatch news", contactListId: topic, sendingProfileId: profile},
            fields
        )
    )
    if (made.refusal) throw new Error("create: " + made.refusal)
    const campaignSendId = made.campaignSendId
    const stored = as(author, D + "store#SendContent", {
        campaignSendId,
        expectedRevision: revisionOf(campaignSendId),
        subject: "News for ${firstName}",
        body: "<p>Hello ${firstName}, the news.</p>",
        bodyText: "Hello ${firstName}, the news.",
        variables: [{name: "firstName", label: "First name", fallback: "friend"}]
    })
    if (stored.refusal) throw new Error("content: " + stored.refusal)
    if (fields.replyToAddress) {
        const reply = as(author, D + "store#Send", {
            campaignSendId,
            expectedRevision: revisionOf(campaignSendId),
            replyToAddress: fields.replyToAddress
        })
        if (reply.refusal) throw new Error("reply-to: " + reply.refusal)
    }
    if (fields.scheduledDate) {
        const scheduled = as(author, D + "schedule#Send", {
            campaignSendId,
            expectedRevision: revisionOf(campaignSendId),
            scheduledDate: fields.scheduledDate
        })
        if (scheduled.refusal) throw new Error("schedule: " + scheduled.refusal)
    }
    const prepared = as(author, D + "prepare#Send", {campaignSendId, expectedRevision: revisionOf(campaignSendId)})
    if (prepared.refusal) throw new Error("prepare: " + prepared.refusal)
    const targetRevision = Number(sendRow(campaignSendId).sendRevision)
    const asked = as(author, C + "request#MarketingApproval", {targetKind: "send", targetId: campaignSendId, targetRevision})
    if (asked.refusal) throw new Error("request: " + asked.refusal)
    if (approver) {
        const decided = as(approver, C + "decide#MarketingApproval", {
            targetKind: "send",
            targetId: campaignSendId,
            targetRevision,
            decision: "approve"
        })
        if (decided.refusal) throw new Error("decide: " + decided.refusal)
    }
    return campaignSendId
}
const release = (username, campaignSendId) =>
    as(username, D + "release#Send", {campaignSendId, expectedRevision: revisionOf(campaignSendId)})
// the send's pages handed off now, after any worker the release started
function dispatchNow(campaignSendId, fields = {}) {
    settle()
    return system(() => run(D + "dispatch#Send", Object.assign({campaignSendId}, fields)))
}
function setPolicy(selfApprovalAllowed) {
    system(() => {
        const policy = row("mantle.marketing.campaign.MarketingPolicy", {organizationPartyId: orgA})
        run("update#mantle.marketing.campaign.MarketingPolicy", {
            marketingPolicyId: policy.marketingPolicyId,
            selfApprovalAllowed
        })
    })
}

spec({
    setupSpec() {
        capture.enable()
        system(() => {
            organization(orgA, "Dispatch A")
            organization(orgB, "Dispatch B")
            users.author = user(prefix, "author", [orgA], ["MARKETING_VIEW", "MARKETING_CAMPAIGN_EDIT", "MARKETING_SEND_EDIT"])
            users.approver = user(prefix, "approver", [orgA], ["MARKETING_VIEW", "MARKETING_APPROVE"])
            users.dispatcher = user(prefix, "dispatcher", [orgA], ["MARKETING_VIEW", "MARKETING_DISPATCH"])
            // approves and dispatches: kept from releasing what they approved (release apart from approval, design §5)
            users.approverDispatcher = user(
                prefix,
                "apprdisp",
                [orgA],
                ["MARKETING_VIEW", "MARKETING_APPROVE", "MARKETING_DISPATCH"]
            )
            users.reviewer = user(prefix, "reviewer", [orgA], ["MARKETING_VIEW", "MARKETING_DISPATCH", "MESSAGE_DELIVERY_REVIEW"])
            users.reviewerB = user(
                prefix,
                "reviewerB",
                [orgB],
                ["MARKETING_VIEW", "MARKETING_DISPATCH", "MESSAGE_DELIVERY_REVIEW"]
            )
            users.solo = user(
                prefix,
                "solo",
                [orgA],
                ["MARKETING_VIEW", "MARKETING_SEND_EDIT", "MARKETING_APPROVE", "MARKETING_DISPATCH"]
            )
            for (const [contactListId, contactListName, singleUse] of [
                [topic, "Dispatch topic", "N"],
                [single, "One-time offer", "Y"]
            ])
                make("mantle.marketing.contact.ContactList", {
                    contactListId,
                    contactListName,
                    contactListTypeEnumId: "NEWSLETTER",
                    contactMechTypeEnumId: "CmtEmailAddress",
                    ownerPartyId: orgA,
                    singleUse
                })
            for (const name of members.concat(["Gus"])) {
                const partyId = (ids[name] = prefix + "_" + name.toUpperCase())
                make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson", ownerPartyId: orgA})
                make("mantle.party.Person", {partyId, firstName: name, lastName: "Dispatchspec"})
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
                // Gus joins the topic only after the first preparation
                if (name === "Gus") continue
                for (const contactListId of name === "Ann" ? [topic, single] : [topic]) {
                    make("mantle.marketing.contact.ContactListParty", {
                        contactListId,
                        partyId,
                        fromDate: ago(20),
                        statusId: "CLPT_ACCEPTED",
                        preferredContactMechId: partyId + "_EM"
                    })
                    make("mantle.party.PartyConsent", {
                        partyId,
                        contactMechId: partyId + "_EM",
                        contactListId,
                        purposeEnumId: "PcpMarketingEmail",
                        statusId: "PconGranted",
                        consentDate: ago(19),
                        sourceEnumId: "PcsForm",
                        evidenceText: "Spec sign-up"
                    })
                }
            }
            make("moqui.basic.email.EmailServer", {
                emailServerId: relay,
                smtpHost: "relay.mkd.example.test",
                smtpPort: "9",
                webBaseUrl: linkRoot
            })
            make("moqui.basic.email.EmailAccount", {
                emailAccountId: prefix + "_BOUNCES",
                accountKindEnumId: "EakHosted",
                emailAddress: "bounces@bounce.mkd.example.test",
                statusId: "EasActive"
            })
            make("mantle.party.MessageSendingProfile", {
                sendingProfileId: profile,
                organizationPartyId: orgA,
                profileName: "Dispatch news",
                channelEnumId: "MdcEmail",
                emailServerId: relay,
                fromAddress: "news@mkd.example.test",
                replyToAddress: "profile-reply@mkd.example.test",
                purposeEnumId: "MtpPromotional",
                trackingPolicyEnumId: "MtrNone",
                bounceDomain: "bounce.mkd.example.test",
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
        // the workers a release started finish before the capture is switched back
        settle()
        capture.reset()
    }
})

feature("a release needs dispatch, approval and a ready profile; each message carries its unsubscribe and the send completes", {
    when() {
        const campaignSendId = (ids.first = approvedSend({replyToAddress: "send-reply@mkd.example.test"}, users.author, null))
        const unapproved = release(users.dispatcher, campaignSendId)
        as(users.approverDispatcher, C + "decide#MarketingApproval", {
            targetKind: "send",
            targetId: campaignSendId,
            targetRevision: Number(sendRow(campaignSendId).sendRevision),
            decision: "approve"
        })
        const byApprover = release(users.approverDispatcher, campaignSendId)
        const byAuthor = release(users.author, campaignSendId)
        const byOtherOrganization = release(users.reviewerB, campaignSendId)
        system(() => run("update#moqui.basic.email.EmailServer", {emailServerId: relay, disabled: "Y"}))
        const notReady = release(users.dispatcher, campaignSendId)
        system(() => run("update#moqui.basic.email.EmailServer", {emailServerId: relay, disabled: "N"}))
        capture.clear()
        const released = release(users.dispatcher, campaignSendId)
        const again = as(users.dispatcher, D + "release#Send", {campaignSendId, expectedRevision: 1})
        const dispatched = dispatchNow(campaignSendId)
        const annMail = mailTo(addressOf("Ann"))[0] || {}
        const headers = annMail.headers || {}
        const listUnsubscribe = String(headers["List-Unsubscribe"] || "")
        const listUnsubscribePost = String(headers["List-Unsubscribe-Post"] || "")
        const mail = {
            body: String(annMail.body || ""),
            bodyText: String(annMail.bodyText || ""),
            bounceAddress: String(annMail.bounceAddress || ""),
            replyTo: Array.from(annMail.replyToList || [])
        }
        const shown = as(users.dispatcher, D + "find#Recipients", {campaignSendId})
        const statusRows = rows("mantle.marketing.contact.ContactListCommStatus", {
            communicationEventId: sendRow(campaignSendId).communicationEventId
        })
        return {
            unapproved,
            byApprover,
            byAuthor,
            byOtherOrganization,
            notReady,
            released,
            again,
            dispatched,
            annMail,
            listUnsubscribe,
            listUnsubscribePost,
            mail,
            shown,
            statusRows,
            campaignSendId
        }
    },
    then({
        unapproved,
        byApprover,
        byAuthor,
        byOtherOrganization,
        notReady,
        released,
        again,
        annMail,
        listUnsubscribe,
        listUnsubscribePost,
        mail,
        shown,
        statusRows,
        campaignSendId
    }) {
        unapproved.refusal.includes("STATUS_INVALID")
        byApprover.refusal.includes("SELF_DISPATCH")
        byAuthor.refusal.includes("PERMISSION_DENIED")
        byOtherOrganization.refusal.includes("RECORD_UNAVAILABLE")
        notReady.refusal.includes("NOT_READY")
        released.refusal == ""
        released.released == true
        released.recipientCount == 5
        again.alreadyReleased == true
        again.released == false
        byStatus(campaignSendId, "CrsHandedOff").length == 5
        deliveriesOf(campaignSendId).filter(d => d.stateEnumId == "MdsSent").length == 5
        deliveriesOf(campaignSendId).every(d => d.organizationPartyId == orgA && d.transactional == "N")
        sendRow(campaignSendId).statusId == "CsCompleted"
        annMail.subject == "News for Ann"
        // the link under the relay's configured root, not the root of the releasing request (P9 review)
        listUnsubscribe.startsWith("<" + linkRoot + "/u/")
        mail.body.includes(linkRoot + "/u/")
        listUnsubscribePost == "List-Unsubscribe=One-Click"
        mail.body.includes("Unsubscribe")
        mail.bodyText.includes("Unsubscribe: ")
        mail.bounceAddress.startsWith("bounces+")
        mail.replyTo.includes("send-reply@mkd.example.test")
        statusRows.length == 5
        statusRows.every(r => r.statusId == "CeSent" && r.messageId)
        // a dispatcher without the audience permission sees masked addresses only
        shown.recipientList.length == 5
        shown.unmasked == false
        shown.recipientList.every(r => !r.addressText.includes(addressOf("Ann")) && r.recipientName == "")
    }
})

feature(
    "a withdrawal, a suppression and a changed address after preparation skip those recipients; the others send; no one is added",
    {
        when() {
            const campaignSendId = approvedSend()
            system(() => {
                // Bob withdraws from the topic, Cal's address is suppressed, Dan's address changes, Gus joins the topic, and Fay, who
                // is not on the topic, takes Eve's address (in capitals) and withdraws the purpose (P9 review: anyone's withdrawal at an
                // address blocks it, checked again at dispatch)
                make("mantle.party.Party", {partyId: ids.Fay, partyTypeEnumId: "PtyPerson", ownerPartyId: orgA})
                make("mantle.party.Person", {partyId: ids.Fay, firstName: "Fay", lastName: "Dispatchspec"})
                make("mantle.party.contact.ContactMech", {
                    contactMechId: ids.Fay + "_EM",
                    contactMechTypeEnumId: "CmtEmailAddress",
                    infoString: addressOf("Eve").toUpperCase()
                })
                make("mantle.party.contact.PartyContactMech", {
                    partyId: ids.Fay,
                    contactMechId: ids.Fay + "_EM",
                    contactMechPurposeId: "EmailPrimary",
                    fromDate: ago(0.002)
                })
                make("mantle.party.PartyConsent", {
                    partyId: ids.Fay,
                    contactMechId: ids.Fay + "_EM",
                    purposeEnumId: "PcpMarketingEmail",
                    statusId: "PconWithdrawn",
                    consentDate: ago(0.001),
                    sourceEnumId: "PcsEmailLink"
                })
                make("mantle.party.PartyConsent", {
                    partyId: ids.Bob,
                    contactListId: topic,
                    purposeEnumId: "PcpMarketingEmail",
                    statusId: "PconWithdrawn",
                    consentDate: ago(0.001),
                    sourceEnumId: "PcsEmailLink"
                })
                make("mantle.party.MessageSuppression", {
                    channelEnumId: "MdcEmail",
                    destinationKey: addressOf("Cal"),
                    organizationPartyId: orgA,
                    reasonEnumId: "MsrComplaint",
                    sourceEnumId: "MssStaff",
                    evidenceText: "Spec complaint",
                    fromDate: ago(0.001)
                })
                const dan = row("mantle.party.contact.PartyContactMech", {partyId: ids.Dan, contactMechId: ids.Dan + "_EM"})
                run("update#mantle.party.contact.PartyContactMech", {
                    partyId: ids.Dan,
                    contactMechId: ids.Dan + "_EM",
                    contactMechPurposeId: "EmailPrimary",
                    fromDate: dan.fromDate,
                    thruDate: ago(0.001)
                })
                make("mantle.party.contact.ContactMech", {
                    contactMechId: ids.Dan + "_EM2",
                    contactMechTypeEnumId: "CmtEmailAddress",
                    infoString: "dan.new@dispatch.example.test"
                })
                make("mantle.party.contact.PartyContactMech", {
                    partyId: ids.Dan,
                    contactMechId: ids.Dan + "_EM2",
                    contactMechPurposeId: "EmailPrimary",
                    fromDate: ago(0.001)
                })
                make("mantle.marketing.contact.ContactListParty", {
                    contactListId: topic,
                    partyId: ids.Gus,
                    fromDate: ago(0.001),
                    statusId: "CLPT_ACCEPTED",
                    preferredContactMechId: ids.Gus + "_EM"
                })
                make("mantle.party.PartyConsent", {
                    partyId: ids.Gus,
                    contactListId: topic,
                    purposeEnumId: "PcpMarketingEmail",
                    statusId: "PconGranted",
                    consentDate: ago(0.001),
                    sourceEnumId: "PcsForm"
                })
            })
            capture.clear()
            const released = release(users.dispatcher, campaignSendId)
            dispatchNow(campaignSendId)
            const skipped = Object.fromEntries(byStatus(campaignSendId, "CrsSkipped").map(r => [r.partyId, r.skipReasonCode]))
            // Fay leaves Eve's address again, for the features after
            system(() => {
                const fay = row("mantle.party.contact.PartyContactMech", {partyId: ids.Fay, contactMechId: ids.Fay + "_EM"})
                run("update#mantle.party.contact.PartyContactMech", {
                    partyId: ids.Fay,
                    contactMechId: ids.Fay + "_EM",
                    contactMechPurposeId: "EmailPrimary",
                    fromDate: fay.fromDate,
                    thruDate: ago(0.0001)
                })
            })
            return {campaignSendId, released, skipped}
        },
        then({campaignSendId, released, skipped}) {
            released.recipientCount == 5
            byStatus(campaignSendId, "CrsHandedOff")
                .map(r => r.partyId)
                .sort()
                .join() == [ids.Ann].join()
            skipped[ids.Bob] == "LIST_WITHDRAWN"
            skipped[ids.Eve] == "DESTINATION_WITHDRAWN"
            mailTo(addressOf("Eve")).length == 0
            skipped[ids.Cal] == "SUPPRESSED"
            skipped[ids.Dan] == "DESTINATION_CHANGED"
            recipientsOf(campaignSendId).every(r => r.partyId != ids.Gus)
            mailTo(addressOf("Ann")).length == 1
            mailTo(addressOf("Bob")).length == 0
            mailTo("dan.new@dispatch.example.test").length == 0
            mailTo(addressOf("Gus")).length == 0
            sendRow(campaignSendId).statusId == "CsCompleted"
        }
    }
)

feature(
    "the one-person team's author releases a self-approved send under the flag; refused at 500 recipients or with the flag off",
    {
        when() {
            setPolicy("Y")
            const soloSend = approvedSend({sendName: "Solo news"}, users.solo, users.solo)
            const big = approvedSend({sendName: "Solo big"}, users.solo, users.solo)
            const flagOff = approvedSend({sendName: "Solo flag off"}, users.solo, users.solo)
            // the big send's count at release: 500 with spec rows beside its prepared ones
            system(() => {
                const revision = Number(sendRow(big).preparedRevision)
                const extra = []
                for (let n = recipientsOf(big).length; n < 500; n++)
                    extra.push(
                        ec.entity
                            .makeValue(RECIPIENT)
                            .setAll({
                                campaignSendId: big,
                                preparedRevision: revision,
                                partyId: ids.Gus,
                                destinationKey: "filler" + n + "@dispatch.example.test",
                                executionKey: prefix + "F" + n,
                                statusId: "CrsSelected"
                            })
                            .setSequencedIdPrimary()
                    )
                ec.entity.createBulk(extra)
            })
            const released = release(users.solo, soloSend)
            const atLimit = release(users.solo, big)
            setPolicy("N")
            const off = release(users.solo, flagOff)
            return {soloSend, released, atLimit, off}
        },
        then({soloSend, released, atLimit, off}) {
            released.refusal == ""
            released.selfDispatch == true
            sendRow(soloSend).selfDispatch == "Y"
            atLimit.refusal.includes("SELF_DISPATCH")
            off.refusal.includes("SELF_DISPATCH")
        }
    }
)

feature("a single-use list is held by one send at a time; a cancellation before any hand-off frees it", {
    when() {
        const later = new Date(Date.now() + 7 * dayMs)
        const first = approvedSend({sendName: "Offer one", contactListId: single, scheduledDate: later})
        const second = approvedSend({sendName: "Offer two", contactListId: single, scheduledDate: later})
        const one = release(users.dispatcher, first)
        const held = release(users.dispatcher, second)
        const noReason = as(users.dispatcher, D + "cancel#Send", {campaignSendId: first})
        const cancelled = as(users.dispatcher, D + "cancel#Send", {campaignSendId: first, reason: "Wrong offer"})
        const two = release(users.dispatcher, second)
        return {first, second, one, held, noReason, cancelled, two}
    },
    then({first, second, one, held, noReason, cancelled, two}) {
        one.statusId == "CsScheduled"
        held.refusal.includes("LIST_RESERVED")
        noReason.refusal.includes("REASON_REQUIRED")
        cancelled.statusId == "CsCancelled"
        cancelled.cancelledCount == 1
        byStatus(first, "CrsCancelled").length == 1
        two.statusId == "CsScheduled"
        row("mantle.marketing.contact.ContactList", {contactListId: single}).reservedBySendId == second
    }
})

feature("a page claimed again after its lease ends hands each recipient off once; pause and cancel stop new claims", {
    when() {
        const campaignSendId = approvedSend({sendName: "Lease news", scheduledDate: new Date(Date.now() + 7 * dayMs)})
        release(users.dispatcher, campaignSendId)
        // its time comes: started by the due run's step, then pages claimed by hand
        system(() => {
            run("update#" + SEND, {campaignSendId, scheduledDate: ago(0.001)})
            run(D + "start#DueSend", {campaignSendId})
        })
        const expire = recipientIds =>
            system(() => {
                for (const campaignRecipientId of recipientIds)
                    run("update#" + RECIPIENT, {campaignRecipientId, leaseUntilDate: ago(0.001)})
            })
        const first = system(() => run(D + "claim#RecipientPage", {campaignSendId, pageSize: 2}))
        const firstIds = Array.from(first.campaignRecipientIdList)
        const whileHeld = system(() => run(D + "claim#RecipientPage", {campaignSendId, pageSize: 2}))
        expire(firstIds)
        const second = system(() => run(D + "claim#RecipientPage", {campaignSendId, pageSize: 2}))
        const eligible = {eligible: true, address: null}
        const stale = system(() =>
            run(D + "handOff#Recipient", {campaignRecipientId: firstIds[0], claimKey: first.claimKey, verdict: eligible})
        )
        const handed = system(() =>
            run(D + "handOff#Recipient", {campaignRecipientId: firstIds[0], claimKey: second.claimKey, verdict: eligible})
        )
        // a worker that queued the second recipient's delivery and stopped before recording it
        const stopped = row(RECIPIENT, {campaignRecipientId: firstIds[1]})
        system(() =>
            run("mantle.party.MessageServices.queue#Delivery", {
                eventKey: "CampaignSend:" + campaignSendId + ":" + stopped.executionKey,
                sourceEnumId: "MdsrcCampaignSend",
                recipientPartyId: stopped.partyId,
                templateKey: "MANTLE_CAMPAIGN_SEND",
                organizationPartyId: orgA,
                sendingProfileId: profile,
                transactional: false,
                marketingPurposeEnumId: "PcpMarketingEmail",
                consentContactListId: topic,
                consentOrganizationPartyId: orgA
            })
        )
        expire([firstIds[1]])
        // the next run, a page of one at a time: the stopped worker's recipient (Ann, Eve and Gus are left on the topic; Gus still leased)
        const page = system(() => run(D + "dispatch#Send", {campaignSendId, pageSize: 1, attempt: false}))
        const paused = as(users.dispatcher, D + "pause#Send", {campaignSendId})
        expire(Array.from(whileHeld.campaignRecipientIdList))
        const whilePaused = system(() => run(D + "dispatch#Send", {campaignSendId, attempt: false}))
        const cancelled = as(users.dispatcher, D + "cancel#Send", {campaignSendId, reason: "Spec stop"})
        const afterCancel = system(() => run(D + "dispatch#Send", {campaignSendId, attempt: false}))
        const keys = deliveriesOf(campaignSendId).map(d => d.eventKey)
        return {
            campaignSendId,
            firstIds,
            whileHeld,
            second,
            stale,
            handed,
            stopped,
            page,
            paused,
            whilePaused,
            cancelled,
            afterCancel,
            keys
        }
    },
    then({
        campaignSendId,
        firstIds,
        whileHeld,
        second,
        stale,
        handed,
        stopped,
        page,
        paused,
        whilePaused,
        cancelled,
        afterCancel,
        keys
    }) {
        firstIds.length == 2
        Array.from(whileHeld.campaignRecipientIdList).every(id => !firstIds.includes(id))
        Array.from(second.campaignRecipientIdList).sort().join() == firstIds.slice().sort().join()
        !stale.deliveryId
        handed.created == true
        page.handedOff == 1
        // each key once: the stopped worker's delivery answered, not made again
        new Set(keys).size == keys.length
        keys.length == 2
        keys.filter(key => key.endsWith(":" + stopped.executionKey)).length == 1
        row(RECIPIENT, {campaignRecipientId: firstIds[1]}).statusId == "CrsHandedOff"
        paused.statusId == "CsPaused"
        whilePaused.handedOff == 0
        cancelled.statusId == "CsCancelled"
        cancelled.cancelledCount == 1
        cancelled.handedOffCount == 2
        cancelled.inFlightCount == 2
        afterCancel.handedOff == 0
        byStatus(campaignSendId, "CrsSelected").length == 0
    }
})

feature(
    "an uncertain delivery is reconciled with evidence by a dispatcher who reviews deliveries, of the send's organization only",
    {
        when() {
            const recipient = byStatus(ids.first, "CrsHandedOff").find(r => r.partyId === ids.Eve)
            system(() => run("update#" + DELIVERY, {deliveryId: recipient.messageDeliveryId, stateEnumId: "MdsUncertain"}))
            const reconcile = (username, fields = {}) =>
                as(
                    username,
                    D + "reconcile#Recipient",
                    Object.assign(
                        {
                            campaignRecipientId: recipient.campaignRecipientId,
                            outcome: "sent",
                            providerReference: "relay log 42",
                            evidenceText: "The relay's log shows it accepted",
                            reason: "Confirmed with the provider"
                        },
                        fields
                    )
                )
            const noReview = reconcile(users.dispatcher)
            const otherOrganization = reconcile(users.reviewerB)
            const noEvidence = reconcile(users.reviewer, {evidenceText: ""})
            const done = reconcile(users.reviewer)
            const detail = as(users.reviewer, D + "get#Recipient", {campaignRecipientId: recipient.campaignRecipientId})
            return {
                noReview,
                otherOrganization,
                noEvidence,
                done,
                detail,
                delivery: row(DELIVERY, {deliveryId: recipient.messageDeliveryId})
            }
        },
        then({noReview, otherOrganization, noEvidence, done, detail, delivery}) {
            noReview.refusal.includes("PERMISSION_DENIED")
            otherOrganization.refusal.includes("RECORD_UNAVAILABLE")
            noEvidence.refusal.includes("EVIDENCE_REQUIRED")
            done.refusal == ""
            done.stateEnumId == "MdsSent"
            delivery.resolvedByUserId == users.reviewer
            String(delivery.resolutionNote).includes("relay log 42")
            detail.attemptList.length >= 1
            detail.recipient.resolvedText.includes("relay log 42")
        }
    }
)
