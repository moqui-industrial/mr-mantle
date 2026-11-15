// Marketing's audience eligibility (impl-marketing P5, §1; design-marketing §4 AudiencePreview; mantle.marketing.SegmentServices
// preview#Audience and classify#Recipients over MarketingEligibility.js): a preview over a topic list and another list puts each person
// in exactly one bucket, by precedence, and the buckets sum to the matched total; a duplicate address is chosen deterministically and
// a withdrawal at an address blocks it for everyone there; an untracked recipient stays eligible; rows name people and show addresses
// to an audience reader only, an author seeing counts and masked addresses; a segment on a source the caller cannot read is refused
// with no count; another organization's list is missing and a reader without the preview's permissions is refused.
// Standalone: spec-local organizations, users, parties, lists and consents.
// Run: ./moq test mr-mantle --spec Eligibility
const lib = ec.resource.script("component://mr-mantle/test/marketing/MarketingSpecLib.js")
const entityLib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {make, rows, system, organization, user, as} = lib
const prefix = "MKE"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const Q = "mantle.marketing.SegmentServices."
const users = {}
const party = {}
const topic = prefix + "_TOPIC",
    other = prefix + "_OTHER",
    listB = prefix + "_LIST_B"
const ago = days => new Date(Date.now() - days * 86400000)
// the people and what makes each one's bucket (the expected bucket and reason)
const people = {
    Ann: {email: "ann@eligibility.example", status: "CLPT_ACCEPTED", grant: true, tracking: true, expect: "eligible:ELIGIBLE"},
    Bob: {email: "shared@eligibility.example", status: "CLPT_ACCEPTED", grant: true, expect: "eligible:ELIGIBLE"},
    Cal: {email: "SHARED@eligibility.example ", status: "CLPT_ACCEPTED", grant: true, expect: "duplicate:DUPLICATE_DESTINATION"},
    Dan: {status: "CLPT_ACCEPTED", grant: true, expect: "destination:MISSING_DESTINATION"},
    Eve: {email: "eve@eligibility.example", status: "CLPT_ACCEPTED", grant: true, expect: "suppressed:SUPPRESSED"},
    Fay: {email: "fay@eligibility.example", status: "CLPT_PENDING", expect: "withdrawn:PENDING"},
    Gus: {email: "gus@eligibility.example", status: "CLPT_UNSUBSCRIBED", expect: "withdrawn:UNSUBSCRIBED"},
    Hal: {email: "hal@eligibility.example", status: "CLPT_ACCEPTED", expect: "evidence:MISSING_EVIDENCE"},
    Ivy: {email: "ivy@eligibility.example", otherOnly: true, expect: "withdrawn:NOT_SUBSCRIBED"},
    Jon: {
        email: "jon@eligibility.example",
        status: "CLPT_ACCEPTED",
        grant: true,
        private: true,
        expect: "unavailable:PARTY_UNAVAILABLE"
    },
    Kim: {
        email: "kim@eligibility.example",
        status: "CLPT_ACCEPTED",
        grant: true,
        purposeWithdrawn: true,
        expect: "withdrawn:PURPOSE_WITHDRAWN"
    },
    Lou: {email: "door@eligibility.example", status: "CLPT_UNSUBSCRIBED", expect: "withdrawn:UNSUBSCRIBED"},
    Max: {email: "door@eligibility.example", status: "CLPT_ACCEPTED", grant: true, expect: "withdrawn:DESTINATION_WITHDRAWN"},
    // a legacy member at the withdrawn address: the withdrawal comes before needing evidence (P5 review)
    Ned: {email: "door@eligibility.example", status: "CLPT_ACCEPTED", expect: "withdrawn:DESTINATION_WITHDRAWN"}
}
const bucketsOf = out => Object.fromEntries(Array.from(out.bucketList || []).map(entry => [entry.bucket, entry.count]))

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Eligibility A")
            organization(orgB, "Eligibility B")
            users.audience = user(
                prefix,
                "audience",
                [orgA],
                ["MARKETING_VIEW", "MARKETING_AUDIENCE_VIEW", "MARKETING_AUDIENCE_EDIT"]
            )
            users.author = user(prefix, "author", [orgA], ["MARKETING_VIEW", "MARKETING_SEND_EDIT"])
            users.reader = user(prefix, "reader", [orgA], ["MARKETING_VIEW", "MARKETING_REPORT_VIEW"])
            users.audienceB = user(prefix, "audienceB", [orgB], ["MARKETING_VIEW", "MARKETING_AUDIENCE_VIEW"])
            users.sales = user(
                prefix,
                "sales",
                [orgA],
                ["MARKETING_VIEW", "MARKETING_AUDIENCE_VIEW", "MARKETING_AUDIENCE_EDIT", "SALES_VIEW", "SALES_TEAM_VIEW"]
            )
            for (const [id, name] of [
                [topic, "Spec topic"],
                [other, "Spec other list"]
            ])
                make("mantle.marketing.contact.ContactList", {
                    contactListId: id,
                    contactListName: name,
                    contactListTypeEnumId: "NEWSLETTER",
                    contactMechTypeEnumId: "CmtEmailAddress",
                    ownerPartyId: orgA
                })
            make("mantle.marketing.contact.ContactList", {
                contactListId: listB,
                contactListName: "B's list",
                contactListTypeEnumId: "NEWSLETTER",
                ownerPartyId: orgB
            })
            for (const [name, person] of Object.entries(people)) {
                const id = (party[name] = prefix + "_" + name.toUpperCase())
                make("mantle.party.Party", {
                    partyId: id,
                    partyTypeEnumId: "PtyPerson",
                    ownerPartyId: orgA,
                    privateOwnerUserId: person.private ? users.reader : null
                })
                make("mantle.party.Person", {partyId: id, firstName: name, lastName: "Eligibilityspec"})
                if (person.email) {
                    make("mantle.party.contact.ContactMech", {
                        contactMechId: id + "_EM",
                        contactMechTypeEnumId: "CmtEmailAddress",
                        infoString: person.email
                    })
                    make("mantle.party.contact.PartyContactMech", {
                        partyId: id,
                        contactMechId: id + "_EM",
                        contactMechPurposeId: "EmailPrimary",
                        fromDate: ago(30)
                    })
                }
                make("mantle.marketing.contact.ContactListParty", {
                    contactListId: person.otherOnly ? other : topic,
                    partyId: id,
                    fromDate: ago(20),
                    statusId: person.status || "CLPT_ACCEPTED",
                    preferredContactMechId: person.email ? id + "_EM" : null
                })
                if (person.grant)
                    make("mantle.party.PartyConsent", {
                        partyId: id,
                        contactMechId: person.email ? id + "_EM" : null,
                        contactListId: topic,
                        purposeEnumId: "PcpMarketingEmail",
                        statusId: "PconGranted",
                        consentDate: ago(19),
                        sourceEnumId: "PcsForm",
                        evidenceText: "Spec sign-up"
                    })
                if (person.tracking)
                    make("mantle.party.PartyConsent", {
                        partyId: id,
                        purposeEnumId: "PcpTracking",
                        statusId: "PconGranted",
                        consentDate: ago(19),
                        sourceEnumId: "PcsForm",
                        evidenceText: "Spec tracking"
                    })
                if (person.purposeWithdrawn) {
                    // a global withdrawal, which a later grant scoped to the organization does not undo
                    make("mantle.party.PartyConsent", {
                        partyId: id,
                        purposeEnumId: "PcpMarketingEmail",
                        statusId: "PconWithdrawn",
                        consentDate: ago(10),
                        sourceEnumId: "PcsEmailLink",
                        evidenceText: "All marketing email"
                    })
                    make("mantle.party.PartyConsent", {
                        partyId: id,
                        purposeEnumId: "PcpMarketingEmail",
                        organizationPartyId: orgA,
                        statusId: "PconGranted",
                        consentDate: ago(5),
                        sourceEnumId: "PcsStaff",
                        evidenceText: "Scoped grant"
                    })
                }
            }
            // Max is also on the other list, so a source membership is counted twice but the person once
            make("mantle.marketing.contact.ContactListParty", {
                contactListId: other,
                partyId: party.Max,
                fromDate: ago(20),
                statusId: "CLPT_ACCEPTED"
            })
            make("mantle.party.MessageSuppression", {
                suppressionId: prefix + "_SUP",
                channelEnumId: "MdcEmail",
                destinationKey: "eve@eligibility.example",
                organizationPartyId: orgA,
                reasonEnumId: "MsrComplaint",
                sourceEnumId: "MssStaff",
                evidenceText: "Spec complaint",
                fromDate: ago(3)
            })
        })
    }
})

feature(
    "each person is in one bucket by precedence, the buckets sum to the matched total, and an untracked recipient stays eligible",
    {
        when() {
            const parameters = {topicListId: topic, listIds: [topic, other], pageSize: 50, asOf: new Date(Date.now() - 60000)}
            return {
                out: as(users.audience, Q + "preview#Audience", parameters),
                again: as(users.audience, Q + "preview#Audience", parameters)
            }
        },
        then({out, again}) {
            out.refusal == ""
            out.matchedCount == Object.keys(people).length
            out.membershipCount == Object.keys(people).length + 1
            Object.values(bucketsOf(out)).reduce((sum, count) => sum + count, 0) == out.matchedCount
            bucketsOf(out) ==
                {unavailable: 1, destination: 1, suppressed: 1, withdrawn: 7, evidence: 1, duplicate: 1, eligible: 2}
            // each person exactly once, in the bucket and reason expected; another user's personal contact a row with no name or address
            Array.from(out.recipientList).length == out.matchedCount
            Array.from(out.recipientList).filter(row => row.bucket == "unavailable" && !row.partyId && !row.addressText).length ==
                1
            Object.entries(people).filter(
                ([name, person]) =>
                    !person.private &&
                    Array.from(out.recipientList).filter(
                        row => row.partyId == party[name] && row.bucket + ":" + row.reasonCode == person.expect
                    ).length != 1
            ).length == 0
            // Bob (the lower id) is chosen over Cal at the shared address, the same each time
            Array.from(again.recipientList).find(row => row.partyId == party.Bob).bucket == "eligible"
            again.resultDigest == out.resultDigest && again.previewKey == out.previewKey
            // Ann granted tracking; Bob did not and stays eligible, untracked
            out.eligibleCount == 2 && out.untrackedEligibleCount == 1
            Array.from(out.recipientList).find(row => row.partyId == party.Bob).trackingText == "Untracked"
            // an audience reader sees names and whole addresses, but not another user's personal contact
            out.addressesShown == true
            Array.from(out.recipientList).find(row => row.partyId == party.Ann).addressText == "ann@eligibility.example"
            !Array.from(out.recipientList).some(row => row.partyName.includes("Jon"))
        }
    }
)

feature("an author sees counts and masked addresses with no names; the internal rule answers the same buckets", {
    when() {
        return {
            author: as(users.author, Q + "preview#Audience", {topicListId: topic, listIds: [topic, other], pageSize: 50}),
            audience: as(users.audience, Q + "preview#Audience", {topicListId: topic, listIds: [topic, other], pageSize: 50}),
            rule: system(() => lib.run(Q + "classify#Recipients", {contactListId: topic, partyIdList: Object.values(party)}))
        }
    },
    then({author, audience, rule}) {
        author.refusal == ""
        bucketsOf(author) == bucketsOf(audience)
        author.addressesShown == false
        Array.from(author.recipientList).every(row => !row.partyId && !row.partyName)
        Array.from(author.recipientList).some(row => row.addressText == "a***@eligibility.example")
        !Array.from(author.recipientList).some(row => row.addressText.includes("ann@"))
        rule.bucketCounts.eligible == 2 && rule.bucketCounts.duplicate == 1 && rule.untrackedEligible == 1
    }
})

feature(
    "a segment on a source the caller cannot read gives no count; another organization's list is missing; a reader is refused",
    {
        when() {
            // a segment of the open leads (Sales), stored by an editor who reads Sales
            const made = as(users.sales, Q + "store#Segment", {organizationPartyId: orgA, segmentName: "Spec leads"})
            const stamp = entityLib.ms(
                ec.entity
                    .find("mantle.marketing.segment.MarketSegment")
                    .condition("marketSegmentId", made.marketSegmentId)
                    .disableAuthz()
                    .one().lastUpdatedStamp
            )
            const stored = as(users.sales, Q + "store#SegmentFilter", {
                marketSegmentId: made.marketSegmentId,
                expectedRevision: stamp,
                action: "addCondition",
                fieldKey: "salesLead.openLead",
                operator: "is",
                value: "true"
            })
            const withSegment = {topicListId: topic, segmentIds: [made.marketSegmentId]}
            const before = rows("mantle.marketing.contact.ContactListParty", {contactListId: topic}).length
            return {
                stored,
                sales: as(users.sales, Q + "preview#Audience", withSegment),
                author: as(users.author, Q + "preview#Audience", withSegment),
                otherList: as(users.audience, Q + "preview#Audience", {topicListId: topic, listIds: [listB]}),
                otherTopic: as(users.audience, Q + "preview#Audience", {topicListId: listB}),
                notTheirs: as(users.audienceB, Q + "preview#Audience", {topicListId: topic}),
                reader: as(users.reader, Q + "preview#Audience", {topicListId: topic}),
                readerOwn: as(users.audience, Q + "preview#Audience", {topicListId: topic}),
                before,
                after: rows("mantle.marketing.contact.ContactListParty", {contactListId: topic}).length
            }
        },
        then({stored, sales, author, otherList, otherTopic, notTheirs, reader, readerOwn, before, after}) {
            stored.refusal == ""
            // the Sales reader sees no lead of A with a contact: an empty audience, counted
            sales.refusal == "" && sales.matchedCount == 0
            author.refusal.includes("SOURCE_UNAVAILABLE") && author.matchedCount == null
            otherList.refusal.includes("RECORD_UNAVAILABLE")
            otherTopic.refusal.includes("RECORD_UNAVAILABLE")
            notTheirs.refusal.includes("RECORD_UNAVAILABLE")
            reader.refusal.includes("PERMISSION_DENIED")
            // the same parameters for an audience reader answer
            readerOwn.refusal == "" && readerOwn.matchedCount == Object.keys(people).length - 1
            // a preview subscribes no one
            after == before
        }
    }
)

// P20 review (the user's call of Nov 15): Assist's aggregate-only audience tool
feature("count#Audience answers the buckets and reasons alone, to an audience reader of the organization only", {
    when() {
        const parameters = {topicListId: topic, listIds: [topic, other]}
        return {
            counts: as(users.audience, Q + "count#Audience", parameters),
            preview: as(users.audience, Q + "preview#Audience", Object.assign({pageSize: 50}, parameters)),
            author: as(users.author, Q + "count#Audience", parameters),
            reader: as(users.reader, Q + "count#Audience", parameters),
            notTheirs: as(users.audienceB, Q + "count#Audience", {topicListId: topic})
        }
    },
    then({counts, preview, author, reader, notTheirs}) {
        counts.refusal == ""
        bucketsOf(counts) == bucketsOf(preview)
        counts.matchedCount == preview.matchedCount && counts.eligibleCount == 2 && counts.untrackedEligibleCount == 1
        Array.from(counts.reasonList).reduce((sum, row) => sum + row.count, 0) == counts.matchedCount
        // no row, name, address, party or digest anywhere in the answer
        counts.recipientList == null && counts.resultDigest == null && counts.previewKey == null
        !JSON.stringify(counts).includes("@eligibility.example")
        !Object.values(party).some(partyId => JSON.stringify(counts).includes('"' + partyId + '"'))
        // an author (send edit, no audience permission) and a report reader are refused; another organization's reader finds no list
        author.refusal.includes("PERMISSION_DENIED")
        reader.refusal.includes("PERMISSION_DENIED")
        notTheirs.refusal.includes("RECORD_UNAVAILABLE")
    }
})
