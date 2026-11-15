// Marketing's list merge (impl-marketing P4; design-marketing §4 AudienceMerge; mantle.marketing.AudienceServices preview#ListMerge,
// merge#Lists over MarketingListMerge.js): membership links only, never a party merge; an acceptance is carried with its evidence for
// the same purpose, anything else waits for confirmation (pending stays pending; consent of another topic is not carried); a member
// withdrawn from a source or from the target is not carried; the source rows stay; a list of another organization is refused; a
// merge whose lists changed since the preview is refused, and a retry answers the first result.
// Standalone: spec-local organizations, users, parties and lists.
// Run: ./moq test mr-mantle --spec ListMerge
const lib = ec.resource.script("component://mr-mantle/test/marketing/MarketingSpecLib.js")
const {make, row, rows, system, organization, user, as} = lib
const prefix = "MKM"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const L = "mantle.marketing.AudienceServices."
const CLP = "mantle.marketing.contact.ContactListParty"
const users = {}
const party = {}
const lists = {}
const dayMs = 24 * 60 * 60 * 1000
const ago = days => new Date(Date.now() - days * dayMs)
const status = (contactListId, partyId) =>
    rows(CLP, {contactListId, partyId}).sort((a, b) => Number(b.fromDate) - Number(a.fromDate))[0]?.statusId ?? null
const partyCount = () => ec.entity.find("mantle.party.Party").disableAuthz().count()
const decisions = preview =>
    Object.fromEntries(Array.from(preview.memberList || []).map(member => [member.partyId, member.decision]))

function member(contactListId, name, statusId, granted) {
    make(CLP, {
        contactListId,
        partyId: party[name],
        fromDate: ago(20),
        statusId,
        preferredContactMechId: party[name] + "_EM",
        revision: 1
    })
    if (granted)
        make("mantle.party.PartyConsent", {
            partyConsentId: prefix + "_" + contactListId + "_" + name,
            partyId: party[name],
            contactMechId: party[name] + "_EM",
            contactListId,
            purposeEnumId: "PcpMarketingEmail",
            statusId: "PconGranted",
            consentDate: ago(15),
            sourceEnumId: "PcsForm",
            evidenceText: name + " signed the form"
        })
}

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Merge A")
            organization(orgB, "Merge B")
            users.consent = user(
                prefix,
                "consent",
                [orgA],
                ["MARKETING_AUDIENCE_VIEW", "MARKETING_AUDIENCE_EDIT", "MARKETING_CONSENT_EDIT"]
            )
            users.reader = user(prefix, "reader", [orgA], ["MARKETING_AUDIENCE_VIEW"])
            for (const name of ["Ana", "Ben", "Cyd", "Dee", "Eve"]) {
                party[name] = prefix + "_" + name.toUpperCase()
                make("mantle.party.Party", {partyId: party[name], partyTypeEnumId: "PtyPerson"})
                make("mantle.party.Person", {partyId: party[name], firstName: name, lastName: "Mergespec"})
                make("mantle.party.contact.ContactMech", {
                    contactMechId: party[name] + "_EM",
                    contactMechTypeEnumId: "CmtEmailAddress",
                    infoString: name.toLowerCase() + ".mergespec@example.com"
                })
                make("mantle.party.contact.PartyContactMech", {
                    partyId: party[name],
                    contactMechId: party[name] + "_EM",
                    contactMechPurposeId: "EmailPrimary",
                    fromDate: ago(30)
                })
            }
            for (const [key, organizationPartyId] of [
                ["A", orgA],
                ["B", orgA],
                ["C", orgA],
                ["T", orgA],
                ["X", orgB]
            ]) {
                lists[key] = prefix + "_LIST_" + key
                make("mantle.marketing.contact.ContactList", {
                    contactListId: lists[key],
                    contactListName: "Merge spec " + key,
                    contactListTypeEnumId: "NEWSLETTER",
                    contactMechTypeEnumId: "CmtEmailAddress",
                    ownerPartyId: organizationPartyId
                })
            }
            // C is of another topic: its policy's purpose is not the target's
            make("mantle.marketing.contact.ContactListPolicy", {
                contactListId: lists.C,
                fromDate: ago(60),
                confirmationRequired: "Y",
                purposeEnumId: "PcpPhone"
            })
            member(lists.A, "Ana", "CLPT_ACCEPTED", true)
            member(lists.A, "Ben", "CLPT_PENDING", false)
            member(lists.C, "Cyd", "CLPT_ACCEPTED", true)
            member(lists.A, "Dee", "CLPT_ACCEPTED", true)
            member(lists.B, "Dee", "CLPT_UNSUBSCRIBED", false)
            member(lists.A, "Eve", "CLPT_ACCEPTED", true)
            member(lists.T, "Eve", "CLPT_UNSUBSCRIBED", false)
        })
    }
})

feature(
    "a merge links members as their consent allows: no party merged, pending stays pending, another topic's consent not carried",
    {
        when() {
            const selection = {contactListId: lists.T, sourceListIdList: [lists.A, lists.B, lists.C]}
            const reader = as(users.reader, L + "preview#ListMerge", selection)
            const otherOrg = as(users.consent, L + "preview#ListMerge", {contactListId: lists.T, sourceListIdList: [lists.X]})
            const preview = as(users.consent, L + "preview#ListMerge", selection)
            const partiesBefore = partyCount()
            const noReason = as(
                users.consent,
                L + "merge#Lists",
                Object.assign({previewKey: preview.previewKey, operationKey: prefix + "-1"}, selection)
            )
            const merged = as(
                users.consent,
                L + "merge#Lists",
                Object.assign(
                    {previewKey: preview.previewKey, reasonText: "One spring list", operationKey: prefix + "-1"},
                    selection
                )
            )
            const retry = as(
                users.consent,
                L + "merge#Lists",
                Object.assign(
                    {previewKey: preview.previewKey, reasonText: "One spring list", operationKey: prefix + "-1"},
                    selection
                )
            )
            const stale = as(
                users.consent,
                L + "merge#Lists",
                Object.assign({previewKey: preview.previewKey, reasonText: "Again", operationKey: prefix + "-2"}, selection)
            )
            return {reader, otherOrg, preview, partiesBefore, partiesAfter: partyCount(), noReason, merged, retry, stale}
        },
        then({reader, otherOrg, preview, partiesBefore, partiesAfter, noReason, merged, retry, stale}) {
            reader.refusal.includes("PERMISSION_DENIED")
            otherOrg.refusal.includes("RECORD_UNAVAILABLE")
            preview.refusal == ""
            decisions(preview)[party.Ana] == "accepted"
            decisions(preview)[party.Ben] == "pending"
            decisions(preview)[party.Cyd] == "pending"
            decisions(preview)[party.Dee] == "conflict"
            decisions(preview)[party.Eve] == "kept"
            preview.carriedCount == 3 && preview.conflictCount == 2
            noReason.refusal.includes("REASON_REQUIRED")
            merged.refusal == ""
            merged.acceptedCount == 1 && merged.pendingCount == 2 && merged.skippedCount == 2
            status(lists.T, party.Ana) == "CLPT_ACCEPTED"
            status(lists.T, party.Ben) == "CLPT_PENDING"
            // Cyd's grant was for another topic: asked again on the target, no grant carried
            status(lists.T, party.Cyd) == "CLPT_PENDING"
            rows("mantle.party.PartyConsent", {partyId: party.Cyd, contactListId: lists.T}).length == 0
            status(lists.T, party.Dee) == null
            status(lists.T, party.Eve) == "CLPT_UNSUBSCRIBED"
            // membership links only: no party made or merged, the source rows kept, the requests naming their source list
            partiesAfter == partiesBefore
            rows("mantle.party.Party", {partyId: party.Ana})[0].mergedToPartyId == null
            status(lists.A, party.Ana) == "CLPT_ACCEPTED" && status(lists.A, party.Ben) == "CLPT_PENDING"
            rows("mantle.marketing.contact.SubscriptionRequest", {contactListId: lists.T, partyId: party.Ana})[0]
                .requestKindEnumId == "SrkMerge"
            rows("mantle.marketing.contact.SubscriptionRequest", {contactListId: lists.T, partyId: party.Ana})[0]
                .sourceRecordId == lists.A
            // a retry answers the first result; the lists changed since the preview refuse another merge
            retry.refusal == "" && retry.alreadyApplied == true && retry.acceptedCount == 1
            stale.refusal.includes("STALE_PREVIEW")
        }
    }
)
