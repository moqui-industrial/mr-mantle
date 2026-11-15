// A party's engagement (impl-marketing P19; design-marketing §10 Customer360 and ContactDetail; mantle.marketing.MarketingWorkspaceServices
// get#Engagement over MarketingEngagement.js): each source answers only with its own permission and is left out without it, never
// answered as zero; another organization's lists, sends and campaigns never show; opens and clicks show only while the person allows
// tracking, the send itself staying; registrations are the events managers'; a caller who reads nothing of Marketing, an organization
// outside the scope and another user's personal contact are refused.
// Standalone: spec-local organizations, users, a person and their records, made as the system.
// Run: ./moq test mr-mantle --spec Engagement
const lib = ec.resource.script("component://mr-mantle/test/marketing/MarketingSpecLib.js")
const {make, system, organization, user, as} = lib
const W = "mantle.marketing.MarketingWorkspaceServices.get#Engagement"
const prefix = "MKEN"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const pat = prefix + "_PAT"
const users = {}
const now = Date.now()
const code = out => (/([A-Z][A-Z0-9_]+):/.exec(out.refusal || "") || [])[1] || (out.refusal ? "ERROR" : "")
const source = (out, key) => (out.sources || []).find(found => found.sourceKey === key) || null
const keys = out => (out.sources || []).map(found => found.sourceKey)

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Engagement A")
            organization(orgB, "Engagement B")
            users.reader = user(prefix, "reader", [orgA], ["MARKETING_VIEW"])
            users.audience = user(prefix, "audience", [orgA], ["MARKETING_VIEW", "MARKETING_AUDIENCE_VIEW"])
            users.events = user(prefix, "events", [orgA], ["MARKETING_VIEW", "MARKETING_EVENT_MANAGE"])
            users.other = user(prefix, "other", [orgB], ["MARKETING_VIEW", "MARKETING_AUDIENCE_VIEW", "MARKETING_EVENT_MANAGE"])
            users.outsider = user(prefix, "outsider", [orgA], ["MARKETING_SEND_EDIT"])
            make("mantle.party.Party", {partyId: pat, partyTypeEnumId: "PtyPerson"})
            make("mantle.party.Person", {partyId: pat, firstName: "Pat", lastName: "Engaged"})
            for (const [org, suffix] of [
                [orgA, "A"],
                [orgB, "B"]
            ]) {
                const campaignId = prefix + "_CAMP_" + suffix
                make("mantle.marketing.campaign.MarketingCampaign", {
                    marketingCampaignId: campaignId,
                    organizationPartyId: org,
                    campaignName: "Campaign " + suffix,
                    statusId: "MKTG_CAMP_INPROGRESS"
                })
                make("mantle.marketing.campaign.CampaignSend", {
                    campaignSendId: prefix + "_SEND_" + suffix,
                    marketingCampaignId: campaignId,
                    organizationPartyId: org,
                    sendName: "Newsletter " + suffix,
                    statusId: "CsCompleted"
                })
                make("mantle.marketing.campaign.CampaignRecipient", {
                    campaignRecipientId: prefix + "_RCPT_" + suffix,
                    campaignSendId: prefix + "_SEND_" + suffix,
                    partyId: pat,
                    statusId: "CrsHandedOff",
                    tracked: "Y",
                    selectedDate: new Date(now - 3600000)
                })
                make("mantle.marketing.contact.ContactList", {
                    contactListId: prefix + "_LIST_" + suffix,
                    contactListName: "List " + suffix,
                    ownerPartyId: org
                })
                make("mantle.marketing.contact.ContactListParty", {
                    contactListId: prefix + "_LIST_" + suffix,
                    partyId: pat,
                    fromDate: new Date(now - 86400000),
                    statusId: "CLPT_ACCEPTED"
                })
                make("mantle.work.registration.EventRegistrationPolicy", {
                    registrationPolicyId: prefix + "_OFFER_" + suffix,
                    organizationPartyId: org,
                    publicTitle: "Open evening " + suffix,
                    occurrenceStart: new Date(now + 86400000)
                })
                make("mantle.work.registration.EventRegistration", {
                    registrationId: prefix + "_REG_" + suffix,
                    registrationPolicyId: prefix + "_OFFER_" + suffix,
                    attendeePartyId: pat,
                    statusId: "EvrConfirmed",
                    marketingCampaignId: campaignId,
                    createdDate: new Date(now - 7200000)
                })
            }
            // an open and a click on A's newsletter; Pat allows tracking in A
            for (const [kind, minutes] of [
                ["MteOpen", 30],
                ["MteClick", 20]
            ])
                make("mantle.marketing.tracking.MarketingTrackingEvent", {
                    trackingEventId: prefix + "_" + kind,
                    organizationPartyId: orgA,
                    eventKindEnumId: kind,
                    campaignRecipientId: prefix + "_RCPT_A",
                    campaignSendId: prefix + "_SEND_A",
                    eventDate: new Date(now - minutes * 60000)
                })
            lib.run("mantle.party.ConsentServices.record#PartyConsent", {
                partyId: pat,
                purposeEnumId: "PcpTracking",
                statusId: "PconGranted",
                organizationPartyId: orgA,
                sourceEnumId: "PcsStaff",
                consentDate: new Date(now - 86400000)
            })
        })
    }
})

// P19 review: that the person was sent a campaign or registered for it is person-level; a campaign reader alone gets no source, and
// an events manager's campaigns come from the registrations alone
feature("a source without its permission is left out, never answered as zero; campaigns only from the sources the caller reads", {
    when() {
        return {
            reader: as(users.reader, W, {partyId: pat}),
            events: as(users.events, W, {partyId: pat}),
            audience: as(users.audience, W, {partyId: pat}),
            outsider: as(users.outsider, W, {partyId: pat})
        }
    },
    then({reader, events, audience, outsider}) {
        reader.refusal == ""
        keys(reader) == []
        reader.omittedSources ==
            ["campaigns", "memberships", "sends", "engagement", "submissions", "registrations", "promotionUse", "consent"]
        reader.partyName == "Pat Engaged"
        source(events, "campaigns").rows.map(row => row.campaignName + ": " + row.howText) == ["Campaign A: registered"]
        source(audience, "campaigns").rows.map(row => row.campaignName + ": " + row.howText) == ["Campaign A: sent"]
        code(outsider) == "PERMISSION_DENIED"
    }
})

feature(
    "an audience reader sees their organization's lists, sends, opens and consent; a withdrawal of tracking removes the opens, not the send",
    {
        when() {
            const before = as(users.audience, W, {partyId: pat})
            system(() =>
                lib.run("mantle.party.ConsentServices.record#PartyConsent", {
                    partyId: pat,
                    purposeEnumId: "PcpTracking",
                    statusId: "PconWithdrawn",
                    organizationPartyId: orgA,
                    sourceEnumId: "PcsStaff"
                })
            )
            return {before, after: as(users.audience, W, {partyId: pat})}
        },
        then({before, after}) {
            before.refusal == ""
            source(before, "memberships").rows.map(row => row.name + ": " + row.statusText) == ["List A: Accepted"]
            source(before, "sends").rows.map(row => row.sendName) == ["Newsletter A"]
            source(before, "engagement").rows.map(row => row.openCount + " open, " + row.clickCount + " click") ==
                ["1 open, 1 click"]
            source(before, "consent").rows.some(row => row.purposeText == "Tracking" && row.granted)
            before.omittedSources.includes("registrations") && !keys(before).includes("registrations")
            source(after, "sends").count == 1
            source(after, "engagement").count == 0
        }
    }
)

feature(
    "another organization's engagement never shows: its user sees its own records, is refused another organization; events managers see places",
    {
        when() {
            return {
                other: as(users.other, W, {partyId: pat}),
                otherAsksA: as(users.other, W, {partyId: pat, organizationPartyId: orgA}),
                events: as(users.events, W, {partyId: pat}),
                missing: as(users.audience, W, {partyId: prefix + "_NOBODY"})
            }
        },
        then({other, otherAsksA, events, missing}) {
            other.refusal == ""
            source(other, "sends").rows.map(row => row.sendName) == ["Newsletter B"]
            source(other, "memberships").rows.map(row => row.name) == ["List B"]
            source(other, "campaigns").rows.map(row => row.campaignName) == ["Campaign B"]
            source(other, "registrations").rows.map(row => row.title) == ["Open evening B"]
            code(otherAsksA) == "ORGANIZATION_DENIED"
            source(events, "registrations").rows.map(row => `${row.title} ${row.roleText} ${row.statusText}`) ==
                ["Open evening A Attendee Confirmed"]
            !keys(events).includes("sends")
            code(missing) == "RECORD_UNAVAILABLE"
        }
    }
)
