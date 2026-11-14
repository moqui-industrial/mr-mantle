// Marketing's sends (impl-marketing P8; design-marketing §5 Sends, SendDetail, Compose; mantle.marketing.CampaignSendServices over
// MarketingSends.js): an author makes a send from a template, whose content becomes the send's own; a required variable no recipient
// gives blocks preparation; the audience is evaluated in pages (the user's call of Nov 14) with the preview's result; a change of the
// content, sender, audience or schedule ends the approval and returns the send to draft; an empty eligible audience cannot be
// approved; a test goes to the policy's allowlist only, marked TEST, refused at a suppressed address, and enters no count; the
// prepared body is what a later read returns after the template changes; another organization's send, template and a
// transactional profile are refused.
// Standalone: spec-local organizations, users, parties, lists, a profile and a template. Run: ./moq test mr-mantle --spec Sends
const lib = ec.resource.script("component://mr-mantle/test/marketing/MarketingSpecLib.js")
const entityLib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {make, row, rows, system, organization, user, as, run} = lib
const D = "mantle.marketing.CampaignSendServices."
const C = "mantle.marketing.CampaignServices."
const M = "mantle.party.MessageServices."
const SEND = "mantle.marketing.campaign.CampaignSend"
const RECIPIENT = "mantle.marketing.campaign.CampaignRecipient"
const capture = ec.factory.getTool("MailCapture")
const prefix = "MKN"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const topic = prefix + "_TOPIC",
    excluded = prefix + "_EXCLUDED",
    empty = prefix + "_EMPTY",
    listB = prefix + "_LIST_B"
const profile = prefix + "_PROFILE",
    notices = prefix + "_NOTICES",
    profileB = prefix + "_PROFILE_B"
const users = {}
const ids = {}
const dayMs = 86400000
const ago = days => new Date(Date.now() - days * dayMs)
// the topic's members: five eligible, one pending
const members = ["Ann", "Bob", "Cal", "Dan", "Eve"]
const revisionOf = campaignSendId => entityLib.ms(row(SEND, {campaignSendId}).lastUpdatedStamp)
const sendRow = campaignSendId => row(SEND, {campaignSendId})
const selected = campaignSendId => rows(RECIPIENT, {campaignSendId, statusId: "CrsSelected"}).length
const testsTo = address => Array.from(capture.getMessages()).filter(m => Array.from(m.toList || []).includes(address))
// a send prepared, asked and approved at its current revision: the approval's decision id
function approve(campaignSendId) {
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
    return decided.marketingDecisionId
}
const newSend = (fields = {}) =>
    as(
        users.author,
        D + "create#Send",
        Object.assign(
            {
                marketingCampaignId: ids.campaign,
                sendName: "Spring news",
                contactListId: topic,
                messageTemplateId: ids.template,
                sendingProfileId: profile
            },
            fields
        )
    )

spec({
    setupSpec() {
        capture.enable()
        system(() => {
            organization(orgA, "Sends A")
            organization(orgB, "Sends B")
            users.author = user(
                prefix,
                "author",
                [orgA],
                ["MARKETING_VIEW", "MARKETING_CAMPAIGN_EDIT", "MARKETING_SEND_EDIT", "MESSAGE_TEMPLATE_VIEW"]
            )
            users.editor = user(prefix, "editor", [orgA], ["MESSAGE_TEMPLATE_VIEW", "MESSAGE_TEMPLATE_EDIT"])
            users.approver = user(prefix, "approver", [orgA], ["MARKETING_VIEW", "MARKETING_APPROVE"])
            users.reader = user(prefix, "reader", [orgA], ["MARKETING_VIEW"])
            users.solo = user(prefix, "solo", [orgA], ["MARKETING_VIEW", "MARKETING_SEND_EDIT", "MARKETING_APPROVE"])
            users.authorB = user(prefix, "authorB", [orgB], ["MARKETING_VIEW", "MARKETING_SEND_EDIT", "MESSAGE_TEMPLATE_VIEW"])
            for (const [contactListId, contactListName, ownerPartyId] of [
                [topic, "Spring topic", orgA],
                [excluded, "Opted out of spring", orgA],
                [empty, "Nobody yet", orgA],
                [listB, "B's topic", orgB]
            ])
                make("mantle.marketing.contact.ContactList", {
                    contactListId,
                    contactListName,
                    contactListTypeEnumId: "NEWSLETTER",
                    contactMechTypeEnumId: "CmtEmailAddress",
                    ownerPartyId
                })
            for (const name of members.concat(["Fay"])) {
                const partyId = (ids[name] = prefix + "_" + name.toUpperCase())
                make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson", ownerPartyId: orgA})
                make("mantle.party.Person", {partyId, firstName: name, lastName: "Sendspec"})
                make("mantle.party.contact.ContactMech", {
                    contactMechId: partyId + "_EM",
                    contactMechTypeEnumId: "CmtEmailAddress",
                    infoString: name.toLowerCase() + "@sends.example.test"
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
                    statusId: name === "Fay" ? "CLPT_PENDING" : "CLPT_ACCEPTED",
                    preferredContactMechId: partyId + "_EM"
                })
                if (name !== "Fay")
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
            // an explicit segment of Ann, Bob and Fay (Fay pending on the topic)
            make("mantle.marketing.segment.MarketSegment", {
                marketSegmentId: prefix + "_SEG",
                segmentName: "Spring regulars",
                segmentKindEnumId: "MskExplicit",
                ownerPartyId: orgA
            })
            for (const name of ["Ann", "Bob", "Fay"])
                make("mantle.marketing.segment.MarketSegmentParty", {
                    marketSegmentId: prefix + "_SEG",
                    partyId: ids[name],
                    roleTypeId: "_NA_",
                    memberKindEnumId: "MspInclude",
                    fromDate: ago(10)
                })
            make("mantle.marketing.contact.ContactListParty", {
                contactListId: excluded,
                partyId: ids.Eve,
                fromDate: ago(10),
                statusId: "CLPT_ACCEPTED"
            })
            // a ready promotional profile of A, a transactional one, and B's
            make("moqui.basic.email.EmailServer", {
                emailServerId: prefix + "_RELAY",
                smtpHost: "relay.mkn.example.test",
                smtpPort: "9"
            })
            make("moqui.basic.email.EmailAccount", {
                emailAccountId: prefix + "_BOUNCES",
                accountKindEnumId: "EakHosted",
                emailAddress: "bounces@bounce.mkn.example.test",
                statusId: "EasActive"
            })
            for (const [sendingProfileId, organizationPartyId, purposeEnumId] of [
                [profile, orgA, "MtpPromotional"],
                [notices, orgA, "MtpTransactional"],
                [profileB, orgB, "MtpPromotional"]
            ])
                make("mantle.party.MessageSendingProfile", {
                    sendingProfileId,
                    organizationPartyId,
                    profileName: sendingProfileId,
                    channelEnumId: "MdcEmail",
                    emailServerId: prefix + "_RELAY",
                    fromAddress: "news@mkn.example.test",
                    purposeEnumId,
                    trackingPolicyEnumId: "MtrNone",
                    bounceDomain: "bounce.mkn.example.test",
                    fromDate: ago(30)
                })
            // the policy's test allowlist; one of its addresses suppressed
            make("mantle.marketing.campaign.MarketingPolicy", {
                organizationPartyId: orgA,
                fromDate: ago(5),
                testAddresses: "tester@mkn.example.test\nblocked@mkn.example.test"
            })
            make("mantle.party.MessageSuppression", {
                suppressionId: prefix + "_SUP",
                channelEnumId: "MdcEmail",
                destinationKey: "blocked@mkn.example.test",
                organizationPartyId: orgA,
                reasonEnumId: "MsrComplaint",
                sourceEnumId: "MssStaff",
                evidenceText: "Spec complaint",
                fromDate: ago(3)
            })
        })
        // an approved campaign of A
        ids.campaign = lib.campaign(users.author, orgA)
        system(() =>
            run("update#mantle.marketing.campaign.MarketingCampaign", {
                marketingCampaignId: ids.campaign,
                statusId: "MKTG_CAMP_APPROVED"
            })
        )
        // a published promotional template of A, with a required variable no recipient gives
        const made = as(users.editor, M + "create#Template", {
            organizationPartyId: orgA,
            templateName: "Spring letter",
            purposeEnumId: "MtpPromotional"
        })
        ids.template = made.messageTemplateId
        const templateRevision = () =>
            entityLib.ms(row("mantle.party.MessageTemplate", {messageTemplateId: ids.template}).lastUpdatedStamp)
        as(users.editor, M + "store#TemplateContent", {
            messageTemplateId: ids.template,
            expectedRevision: templateRevision(),
            subject: "Spring for ${firstName}",
            body: "<p>Dear ${firstName}, ${offer}</p>",
            bodyText: "Dear ${firstName}, ${offer}",
            variables: [
                {name: "firstName", label: "First name", fallback: "friend"},
                {name: "offer", label: "Offer", required: true}
            ]
        })
        const draft = row("mantle.party.MessageTemplateContent", {messageTemplateId: ids.template, contentSeqId: "001"})
        as(users.editor, M + "publish#Template", {
            messageTemplateId: ids.template,
            expectedRevision: entityLib.ms(draft.lastUpdatedStamp),
            reason: "Spring"
        })
    },
    cleanupSpec() {
        capture.reset()
    }
})

feature("a send made from a template has its content; a required variable no recipient gives blocks preparation", {
    when() {
        const made = newSend()
        ids.send = made.campaignSendId
        const blocked = as(users.author, D + "prepare#Send", {campaignSendId: ids.send, expectedRevision: revisionOf(ids.send)})
        const fixed = as(users.author, D + "store#SendContent", {
            campaignSendId: ids.send,
            expectedRevision: revisionOf(ids.send),
            variables: [
                {name: "firstName", label: "First name", fallback: "friend"},
                {name: "offer", label: "Offer", fallback: "a spring discount"}
            ]
        })
        const privateLink = as(users.author, D + "store#SendContent", {
            campaignSendId: ids.send,
            expectedRevision: revisionOf(ids.send),
            body: '<p>See <a href="/qapps/Marketing/Home">this</a></p>'
        })
        const stale = as(users.author, D + "prepare#Send", {campaignSendId: ids.send, expectedRevision: 1})
        return {made, blocked, fixed, privateLink, stale, got: as(users.author, D + "get#Send", {campaignSendId: ids.send})}
    },
    then({made, blocked, fixed, privateLink, stale, got}) {
        made.refusal == ""
        got.send.statusId == "CsDraft"
        got.content.subject == "Spring for ${firstName}"
        got.content.body.includes("${offer}")
        blocked.refusal.includes("VARIABLE_UNKNOWN")
        fixed.refusal == ""
        privateLink.refusal.includes("PRIVATE_LINK")
        stale.refusal.includes("STALE_REVISION")
        got.capabilities.canRequestApproval == false
    }
})

feature("the audience is evaluated in pages with the preview's eligible people; a stale preview is refused", {
    when() {
        const preview = as(users.author, "mantle.marketing.SegmentServices.preview#Audience", {topicListId: topic, pageSize: 50})
        const stale = as(users.author, D + "prepare#Send", {
            campaignSendId: ids.send,
            expectedRevision: revisionOf(ids.send),
            resultDigest: "not-the-preview"
        })
        // a page of two: three pages for six members
        const prepared = as(users.author, D + "prepare#Send", {
            campaignSendId: ids.send,
            expectedRevision: revisionOf(ids.send),
            resultDigest: preview.resultDigest,
            pageSize: 2
        })
        const again = as(users.author, D + "prepare#Send", {campaignSendId: ids.send, expectedRevision: revisionOf(ids.send)})
        const recipients = rows(RECIPIENT, {campaignSendId: ids.send})
        // a segment source, a page at a time: the segment matched within each page, as the preview matches it over the whole
        const bySegment = newSend({sendName: "Regulars", segmentIds: [prefix + "_SEG"]})
        as(users.author, D + "store#SendContent", {
            campaignSendId: bySegment.campaignSendId,
            expectedRevision: revisionOf(bySegment.campaignSendId),
            variables: [
                {name: "firstName", label: "First name", fallback: "friend"},
                {name: "offer", label: "Offer", fallback: "news"}
            ]
        })
        const segmentPreview = as(users.author, "mantle.marketing.SegmentServices.preview#Audience", {
            topicListId: topic,
            segmentIds: [prefix + "_SEG"],
            pageSize: 50
        })
        const segmentPrepared = as(users.author, D + "prepare#Send", {
            campaignSendId: bySegment.campaignSendId,
            expectedRevision: revisionOf(bySegment.campaignSendId),
            resultDigest: segmentPreview.resultDigest,
            pageSize: 2
        })
        return {preview, stale, prepared, again, recipients, segmentPreview, segmentPrepared}
    },
    then({preview, stale, prepared, again, recipients, segmentPreview, segmentPrepared}) {
        segmentPreview.eligibleCount == 2
        segmentPrepared.refusal == ""
        segmentPrepared.eligibleCount == 2
        segmentPrepared.resultDigest == segmentPreview.resultDigest
        preview.eligibleCount == 5
        stale.refusal.includes("PREVIEW_STALE")
        prepared.refusal == ""
        prepared.pages == 3
        prepared.eligibleCount == 5
        prepared.resultDigest == preview.resultDigest
        prepared.bucketCounts.withdrawn == 1
        again.refusal == ""
        // the second preparation replaced the first's rows, which stay
        recipients.filter(r => r.statusId == "CrsSelected").length == 5
        recipients.filter(r => r.statusId == "CrsReplaced").length == 5
        new Set(recipients.map(r => r.executionKey)).size == 10
    }
})

feature("a withdrawal at a shared address by a source's person who is not on the topic blocks it, as in the preview", {
    when() {
        // a second topic of Hal and Jo; a source list of Hal and Ivy, who is not on the topic, shares Hal's address (in another
        // case) and withdrew the purpose
        const topic2 = prefix + "_TOPIC2",
            source = prefix + "_SOURCE"
        system(() => {
            for (const contactListId of [topic2, source])
                make("mantle.marketing.contact.ContactList", {
                    contactListId,
                    contactListName: contactListId,
                    contactListTypeEnumId: "NEWSLETTER",
                    contactMechTypeEnumId: "CmtEmailAddress",
                    ownerPartyId: orgA
                })
            for (const [name, address, onTopic] of [
                ["Hal", "hal@sends.example.test", true],
                ["Jo", "jo@sends.example.test", true],
                ["Ivy", "HAL@sends.example.test", false]
            ]) {
                const partyId = (ids[name] = prefix + "_" + name.toUpperCase())
                make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson", ownerPartyId: orgA})
                make("mantle.party.Person", {partyId, firstName: name, lastName: "Sendspec"})
                make("mantle.party.contact.ContactMech", {
                    contactMechId: partyId + "_EM",
                    contactMechTypeEnumId: "CmtEmailAddress",
                    infoString: address
                })
                make("mantle.party.contact.PartyContactMech", {
                    partyId,
                    contactMechId: partyId + "_EM",
                    contactMechPurposeId: "EmailPrimary",
                    fromDate: ago(30)
                })
                if (onTopic) {
                    make("mantle.marketing.contact.ContactListParty", {
                        contactListId: topic2,
                        partyId,
                        fromDate: ago(20),
                        statusId: "CLPT_ACCEPTED",
                        preferredContactMechId: partyId + "_EM"
                    })
                    make("mantle.party.PartyConsent", {
                        partyId,
                        contactMechId: partyId + "_EM",
                        contactListId: topic2,
                        purposeEnumId: "PcpMarketingEmail",
                        statusId: "PconGranted",
                        consentDate: ago(19),
                        sourceEnumId: "PcsForm",
                        evidenceText: "Spec sign-up"
                    })
                } else
                    make("mantle.party.PartyConsent", {
                        partyId,
                        contactMechId: partyId + "_EM",
                        purposeEnumId: "PcpMarketingEmail",
                        statusId: "PconWithdrawn",
                        consentDate: ago(2),
                        sourceEnumId: "PcsForm",
                        evidenceText: "Spec withdrawal"
                    })
                if (name !== "Jo")
                    make("mantle.marketing.contact.ContactListParty", {
                        contactListId: source,
                        partyId,
                        fromDate: ago(20),
                        statusId: "CLPT_ACCEPTED"
                    })
            }
            make("mantle.marketing.contact.ContactListParty", {
                contactListId: source,
                partyId: ids.Jo,
                fromDate: ago(20),
                statusId: "CLPT_ACCEPTED"
            })
        })
        const made = newSend({sendName: "Shared address", contactListId: topic2, listIds: [source]})
        as(users.author, D + "store#SendContent", {
            campaignSendId: made.campaignSendId,
            expectedRevision: revisionOf(made.campaignSendId),
            variables: [
                {name: "firstName", label: "First name", fallback: "friend"},
                {name: "offer", label: "Offer", fallback: "news"}
            ]
        })
        const preview = as(users.author, "mantle.marketing.SegmentServices.preview#Audience", {
            topicListId: topic2,
            listIds: [source],
            pageSize: 50
        })
        const prepared = as(users.author, D + "prepare#Send", {
            campaignSendId: made.campaignSendId,
            expectedRevision: revisionOf(made.campaignSendId),
            resultDigest: preview.resultDigest,
            pageSize: 1
        })
        const recipients = rows(RECIPIENT, {campaignSendId: made.campaignSendId, statusId: "CrsSelected"}).map(r => r.partyId)
        return {preview, prepared, recipients}
    },
    then({preview, prepared, recipients}) {
        preview.eligibleCount == 1
        prepared.refusal == ""
        prepared.eligibleCount == 1
        prepared.resultDigest == preview.resultDigest
        recipients.length == 1
        recipients[0] == ids.Jo
    }
})

feature("a change of the content, sender, audience or schedule ends the approval and returns the send to draft", {
    when() {
        const outcomes = {}
        const changes = {
            content: () => ({service: "store#SendContent", fields: {subject: "Spring is here, ${firstName}"}}),
            sender: () => ({service: "store#Send", fields: {replyToAddress: "reply@mkn.example.test"}}),
            audience: () => ({service: "store#Send", fields: {excludeListIds: [excluded]}}),
            schedule: () => ({service: "schedule#Send", fields: {scheduledDate: new Date(Date.now() + 3 * dayMs)}})
        }
        for (const [name, change] of Object.entries(changes)) {
            const decisionId = approve(ids.send)
            const approvedState = sendRow(ids.send).statusId
            // an approved send's files are not changed through its files panel (P8 review)
            const approvedFiles = as(users.author, D + "check#SendAccess", {campaignSendId: ids.send})
            const {service, fields} = change()
            const out = as(
                users.author,
                D + service,
                Object.assign({campaignSendId: ids.send, expectedRevision: revisionOf(ids.send)}, fields)
            )
            outcomes[name] = {
                approvedState,
                approvedCanEdit: approvedFiles.canEdit,
                draftCanEdit: as(users.author, D + "check#SendAccess", {campaignSendId: ids.send}).canEdit,
                refusal: out.refusal,
                approvalEnded: out.approvalEnded,
                state: sendRow(ids.send).statusId,
                superseded: !!row("mantle.marketing.campaign.MarketingDecision", {marketingDecisionId: decisionId}).supersededDate
            }
        }
        // the excluded list took Eve out; a holder of approval who made the revision's change is its author
        const soloChange = as(users.solo, D + "store#Send", {
            campaignSendId: ids.send,
            expectedRevision: revisionOf(ids.send),
            replyToAddress: "solo@mkn.example.test"
        })
        const prepared = as(users.solo, D + "prepare#Send", {campaignSendId: ids.send, expectedRevision: revisionOf(ids.send)})
        const own = as(users.solo, C + "request#MarketingApproval", {
            targetKind: "send",
            targetId: ids.send,
            targetRevision: Number(sendRow(ids.send).sendRevision)
        })
        const self = as(users.solo, C + "decide#MarketingApproval", {
            targetKind: "send",
            targetId: ids.send,
            targetRevision: Number(sendRow(ids.send).sendRevision),
            decision: "approve"
        })
        const other = as(users.approver, C + "decide#MarketingApproval", {
            targetKind: "send",
            targetId: ids.send,
            targetRevision: Number(sendRow(ids.send).sendRevision),
            decision: "refuse",
            reason: "Not yet"
        })
        return {outcomes, soloChange, prepared, own, self, other, state: sendRow(ids.send).statusId}
    },
    then({outcomes, soloChange, prepared, own, self, other, state}) {
        soloChange.refusal == ""
        Object.values(outcomes).every(o => o.approvedState == "CsApproved")
        Object.values(outcomes).every(o => o.approvedCanEdit === false && o.draftCanEdit === true)
        Object.values(outcomes)
            .map(o => o.refusal)
            .join("") == ""
        Object.values(outcomes).every(o => o.approvalEnded === true && o.state == "CsDraft" && o.superseded)
        prepared.eligibleCount == 4
        own.refusal == ""
        // an author never approves their own send with the one-person flag off; a refusal returns it to draft
        self.refusal.includes("SELF_APPROVAL")
        other.refusal == ""
        state == "CsDraft"
    }
})

feature("an empty eligible audience is prepared and cannot be approved", {
    when() {
        const made = newSend({sendName: "Nobody", contactListId: empty})
        const fixVariables = as(users.author, D + "store#SendContent", {
            campaignSendId: made.campaignSendId,
            expectedRevision: revisionOf(made.campaignSendId),
            variables: [
                {name: "firstName", label: "First name", fallback: "friend"},
                {name: "offer", label: "Offer", fallback: "news"}
            ]
        })
        const prepared = as(users.author, D + "prepare#Send", {
            campaignSendId: made.campaignSendId,
            expectedRevision: revisionOf(made.campaignSendId)
        })
        const asked = as(users.author, C + "request#MarketingApproval", {
            targetKind: "send",
            targetId: made.campaignSendId,
            targetRevision: Number(sendRow(made.campaignSendId).sendRevision)
        })
        return {fixVariables, prepared, asked}
    },
    then({fixVariables, prepared, asked}) {
        fixVariables.refusal == ""
        prepared.refusal == ""
        prepared.eligibleCount == 0
        asked.refusal.includes("NOT_READY")
        asked.refusal.includes("no eligible recipient")
    }
})

feature("a test goes to the allowlist only, marked TEST, refused at a suppressed address, and enters no count", {
    when() {
        capture.clear()
        const before = {
            selected: selected(ids.send),
            eligible: sendRow(ids.send).eligibleCount,
            state: sendRow(ids.send).statusId
        }
        const sent = as(users.author, D + "test#Send", {
            campaignSendId: ids.send,
            toAddress: "Tester@mkn.example.test",
            note: "Check"
        })
        const outside = as(users.author, D + "test#Send", {campaignSendId: ids.send, toAddress: "ann@sends.example.test"})
        const suppressed = as(users.author, D + "test#Send", {campaignSendId: ids.send, toAddress: "blocked@mkn.example.test"})
        const reader = as(users.reader, D + "test#Send", {campaignSendId: ids.send, toAddress: "tester@mkn.example.test"})
        // a delivery of the test source to an address off the test list (none but test#Send queues one) is refused at its attempt
        const offList = system(() =>
            run(M + "queue#Delivery", {
                sourceEnumId: "MdsrcCampaignSendTest",
                eventKey: "CampaignSendTest:" + ids.send + ":offlist",
                recipientPartyId: ids.Ann,
                channelEnumId: "MdcEmail",
                templateKey: "MANTLE_CAMPAIGN_SEND_TEST",
                toAddress: "ann@sends.example.test",
                organizationPartyId: orgA,
                sendingProfileId: profile,
                transactional: false,
                bodyParameters: {campaignSendId: ids.send},
                sendNow: true
            })
        )
        const message = testsTo("tester@mkn.example.test")[0] || {}
        const delivery = row("mantle.party.MessageDelivery", {deliveryId: sent.deliveryId}) || {}
        return {
            before,
            sent,
            outside,
            suppressed,
            reader,
            offList,
            offListMails: testsTo("ann@sends.example.test").length,
            message,
            delivery,
            after: {selected: selected(ids.send), eligible: sendRow(ids.send).eligibleCount, state: sendRow(ids.send).statusId},
            blockedMails: testsTo("blocked@mkn.example.test").length
        }
    },
    then({before, sent, outside, suppressed, reader, offList, offListMails, message, delivery, after, blockedMails}) {
        offList.stateEnumId == "MdsSuppressed"
        offListMails == 0
        sent.refusal == ""
        sent.stateEnumId == "MdsSent"
        String(message.subject).startsWith("[TEST] Spring is here, Alex")
        String(message.body).includes("TEST: not sent to the audience. Check")
        message.bounceAddress?.startsWith("bounces+")
        delivery.sendingProfileId == profile
        delivery.transactional == "N"
        JSON.parse(delivery.consentJson).test == true
        outside.refusal.includes("TEST_ADDRESS_NOT_ALLOWED")
        suppressed.refusal == ""
        suppressed.stateEnumId == "MdsSuppressed"
        blockedMails == 0
        reader.refusal.includes("PERMISSION_DENIED")
        after == before
    }
})

feature("the prepared body is what a later read returns after the template and the content change", {
    when() {
        const before = as(users.author, D + "get#Send", {campaignSendId: ids.send})
        // the template's next content published
        const templateRevision = entityLib.ms(
            row("mantle.party.MessageTemplate", {messageTemplateId: ids.template}).lastUpdatedStamp
        )
        as(users.editor, M + "store#TemplateContent", {
            messageTemplateId: ids.template,
            expectedRevision: templateRevision,
            body: "<p>Summer for ${firstName}, ${offer}</p>"
        })
        const draft = rows("mantle.party.MessageTemplateContent", {messageTemplateId: ids.template}).find(c => c.fromDate == null)
        const published = as(users.editor, M + "publish#Template", {
            messageTemplateId: ids.template,
            expectedRevision: entityLib.ms(draft.lastUpdatedStamp),
            reason: "Summer"
        })
        const afterTemplate = as(users.author, D + "get#Send", {campaignSendId: ids.send})
        const changed = as(users.author, D + "store#SendContent", {
            campaignSendId: ids.send,
            expectedRevision: revisionOf(ids.send),
            body: "<p>A new body for ${firstName}</p>"
        })
        const afterChange = as(users.author, D + "get#Send", {campaignSendId: ids.send})
        const preview = as(users.author, D + "preview#Send", {campaignSendId: ids.send, prepared: true})
        return {before, published, afterTemplate, changed, afterChange, preview}
    },
    then({before, published, afterTemplate, changed, afterChange, preview}) {
        published.refusal == ""
        before.prepared.body.includes("Dear ${firstName}, ${offer}")
        afterTemplate.prepared.body == before.prepared.body
        afterTemplate.content.body == before.content.body
        changed.refusal == ""
        afterChange.content.body.includes("A new body")
        afterChange.prepared.body == before.prepared.body
        afterChange.prepared.current == false
        afterChange.send.preparedStale == true
        preview.prepared == true
        preview.safeBody.includes("Dear Alex, a spring discount")
    }
})

feature("another organization's send and template, a transactional profile and a reader's write are refused", {
    when() {
        return {
            otherSend: as(users.authorB, D + "get#Send", {campaignSendId: ids.send}),
            otherCampaign: as(users.authorB, D + "create#Send", {
                marketingCampaignId: ids.campaign,
                sendName: "Borrowed",
                contactListId: topic
            }),
            template: as(users.author, D + "create#Send", {
                marketingCampaignId: ids.campaign,
                sendName: "Template of B",
                contactListId: topic,
                messageTemplateId: prefix + "_NOPE"
            }),
            transactional: newSend({sendName: "Notices", sendingProfileId: notices}),
            otherProfile: newSend({sendName: "B's profile", sendingProfileId: profileB}),
            otherTopic: newSend({sendName: "B's topic", contactListId: listB}),
            reader: as(users.reader, D + "create#Send", {
                marketingCampaignId: ids.campaign,
                sendName: "Reader",
                contactListId: topic
            }),
            readerGet: as(users.reader, D + "get#Send", {campaignSendId: ids.send}),
            find: as(users.authorB, D + "find#Sends", {statusId: "all"})
        }
    },
    then(out) {
        out.otherSend.refusal.includes("RECORD_UNAVAILABLE")
        out.otherCampaign.refusal.includes("RECORD_UNAVAILABLE")
        out.template.refusal.includes("TEMPLATE_UNAVAILABLE")
        out.transactional.refusal.includes("PROFILE_PURPOSE")
        out.otherProfile.refusal.includes("RECORD_UNAVAILABLE")
        out.otherTopic.refusal.includes("RECORD_UNAVAILABLE")
        out.reader.refusal.includes("PERMISSION_DENIED")
        out.readerGet.refusal == ""
        out.readerGet.capabilities.canEdit == false
        Array.from(out.find.sendList).length == 0
    }
})
