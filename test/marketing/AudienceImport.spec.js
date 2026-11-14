// Marketing's audience import (impl-marketing P4; design-marketing §4 AudienceImport, §18; mantle.marketing.AudienceServices over
// MarketingAudienceTransfers.js): an audience editor without MARKETING_AUDIENCE_IMPORT is refused, a list supplies no evidence, and
// another organization's list answers as missing; a preview files nothing; a bad row fails alone; a private contact of another user
// is never matched; a withdrawal after the preview survives the apply; a restart applies each good row once; the runs finder answers
// by the audience view and the organization.
// Standalone: spec-local organizations, users, parties and lists.
// Run: ./moq test mr-mantle --spec AudienceImport
const lib = ec.resource.script("component://mr-mantle/test/marketing/MarketingSpecLib.js")
const {make, row, rows, system, organization, user, as} = lib
const prefix = "MKI"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const L = "mantle.marketing.AudienceServices."
const CLP = "mantle.marketing.contact.ContactListParty"
const ITEM = "mantle.marketing.contact.AudienceImportItem"
const REQUEST = "mantle.marketing.contact.SubscriptionRequest"
const users = {}
const party = {}
const importer = ["MARKETING_AUDIENCE_VIEW", "MARKETING_AUDIENCE_EDIT", "MARKETING_AUDIENCE_IMPORT"]
const dayMs = 24 * 60 * 60 * 1000
const ago = days => new Date(Date.now() - days * dayMs)
let listId, restartListId, otherListId, smsListId
const status = (contactListId, partyId) =>
    rows(CLP, {contactListId, partyId}).sort((a, b) => Number(b.fromDate) - Number(a.fromDate))[0]?.statusId ?? null
const items = audienceImportId => Object.fromEntries(rows(ITEM, {audienceImportId}).map(item => [Number(item.rowNumber), item]))
const file = [
    "First Name,Last Name,Email,Evidence",
    "Ana,Audimp,ana.audimp@example.com,",
    "Fay,Audimp,fay.audimp@example.com,Asked at the counter",
    "Bad,Row,not-an-address,",
    "Ana,Again,ANA.audimp@example.com,",
    "Pia,Audimp,pia.audimp@example.com,",
    "Ben,Audimp,ben.audimp@example.com,"
].join("\n")
const evidence = {sourceEnumId: "PcsForm", evidenceDate: ago(3), evidenceText: "Fair sign-up sheet", evidenceColumn: "Evidence"}

function person(name, privateOwnerUserId, address) {
    party[name] = prefix + "_" + name.toUpperCase()
    make("mantle.party.Party", {
        partyId: party[name],
        partyTypeEnumId: "PtyPerson",
        privateOwnerUserId: privateOwnerUserId || null
    })
    make("mantle.party.Person", {partyId: party[name], firstName: name, lastName: "Audimp"})
    make("mantle.party.contact.ContactMech", {
        contactMechId: party[name] + "_EM",
        contactMechTypeEnumId: "CmtEmailAddress",
        infoString: address || name.toLowerCase() + ".audimp@example.com"
    })
    make("mantle.party.contact.PartyContactMech", {
        partyId: party[name],
        contactMechId: party[name] + "_EM",
        contactMechPurposeId: "EmailPrimary",
        fromDate: ago(30)
    })
}
function list(id, organizationPartyId, channel) {
    make("mantle.marketing.contact.ContactList", {
        contactListId: id,
        contactListName: "Import spec " + id,
        contactListTypeEnumId: "NEWSLETTER",
        contactMechTypeEnumId: channel || "CmtEmailAddress",
        ownerPartyId: organizationPartyId
    })
    return id
}

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Import A")
            organization(orgB, "Import B")
            users.importer = user(prefix, "importer", [orgA], importer)
            users.editor = user(prefix, "editor", [orgA], ["MARKETING_AUDIENCE_VIEW", "MARKETING_AUDIENCE_EDIT"])
            users.reader = user(prefix, "reader", [orgA], ["MARKETING_AUDIENCE_VIEW"])
            users.importerB = user(prefix, "importerB", [orgB], importer.concat(["MARKETING_CONSENT_EDIT"]))
            users.other = user(prefix, "other", [orgA], ["MARKETING_VIEW"])
            person("Ana")
            person("Ben")
            // another user's personal contact with an address of the file
            person("Pia", users.other)
            // the importer's own personal contact with Ana's address, before her by id: it never hides the directory contact
            person("Aaa", users.importer, "ana.audimp@example.com")
            // a person with no phone: a file's number with her name is never matched to her by the name alone
            person("Sam")
            listId = list(prefix + "_LIST", orgA)
            restartListId = list(prefix + "_RESTART", orgA)
            otherListId = list(prefix + "_LIST_B", orgB)
            smsListId = list(prefix + "_SMS", orgA, "CmtTelecomNumber")
        })
    }
})

feature(
    "an audience editor without the import permission is refused; a list supplies no evidence; another organization's list is missing",
    {
        when() {
            const parameters = Object.assign({contactListId: listId, fileText: file, fileName: "fair.csv"}, evidence)
            return {
                editor: as(users.editor, L + "preview#AudienceImport", parameters),
                noEvidence: as(users.importer, L + "preview#AudienceImport", {
                    contactListId: listId,
                    fileText: file,
                    fileName: "fair.csv"
                }),
                noDate: as(users.importer, L + "preview#AudienceImport", Object.assign({}, parameters, {evidenceDate: null})),
                accept: as(users.importer, L + "preview#AudienceImport", Object.assign({accept: true}, parameters)),
                otherOrg: as(users.importerB, L + "preview#AudienceImport", parameters),
                ownOrg: as(
                    users.importerB,
                    L + "preview#AudienceImport",
                    Object.assign({}, parameters, {contactListId: otherListId})
                )
            }
        },
        then({editor, noEvidence, noDate, accept, otherOrg, ownOrg}) {
            editor.refusal.includes("PERMISSION_DENIED")
            noEvidence.refusal.includes("EVIDENCE_REQUIRED")
            // an import's evidence is never dated today by default (later than every earlier withdrawal)
            noDate.refusal.includes("EVIDENCE_DATE_REQUIRED")
            accept.refusal.includes("PERMISSION_DENIED")
            otherOrg.refusal.includes("RECORD_UNAVAILABLE")
            ownOrg.refusal == "" && ownOrg.rowCount == 6
            rows(CLP, {contactListId: otherListId}).length == 0
        }
    }
)

feature(
    "a preview files nothing; a bad row fails alone; another user's private contact is never matched; a withdrawal after the preview survives the apply",
    {
        when() {
            const preview = as(
                users.importer,
                L + "preview#AudienceImport",
                Object.assign({contactListId: listId, fileText: file, fileName: "fair.csv"}, evidence)
            )
            const previewed = items(preview.audienceImportId)
            const membersAfterPreview = rows(CLP, {contactListId: listId}).length
            // Ben withdraws all marketing email after the preview (later than the file's evidence)
            system(() =>
                make("mantle.party.PartyConsent", {
                    partyConsentId: prefix + "_BEN_OUT",
                    partyId: party.Ben,
                    contactMechId: party.Ben + "_EM",
                    purposeEnumId: "PcpMarketingEmail",
                    statusId: "PconWithdrawn",
                    consentDate: ago(0.5),
                    sourceEnumId: "PcsEmailLink"
                })
            )
            const stale = as(users.importer, L + "apply#AudienceImport", {
                audienceImportId: preview.audienceImportId,
                expectedRevision: 1
            })
            const applied = as(users.importer, L + "apply#AudienceImport", {
                audienceImportId: preview.audienceImportId,
                expectedRevision: preview.revision
            })
            const current = row("mantle.marketing.contact.AudienceImport", {audienceImportId: preview.audienceImportId})
            const again = as(users.importer, L + "apply#AudienceImport", {
                audienceImportId: preview.audienceImportId,
                expectedRevision: Number(current.lastUpdatedStamp)
            })
            const sms = as(users.importer, L + "preview#AudienceImport", {
                contactListId: smsListId,
                fileText: "First Name,Last Name,Phone\nSam,Audimp,555-123-4567",
                fileName: "sms.csv",
                evidenceText: "Texted JOIN to the store",
                evidenceDate: ago(2)
            })
            return {
                preview,
                previewed,
                membersAfterPreview,
                stale,
                applied,
                again,
                outcome: items(preview.audienceImportId),
                errors: as(users.importer, L + "get#AudienceImportErrors", {audienceImportId: preview.audienceImportId}),
                readerErrors: as(users.reader, L + "get#AudienceImportErrors", {audienceImportId: preview.audienceImportId}),
                readerDetail: as(users.reader, L + "get#AudienceImport", {audienceImportId: preview.audienceImportId}),
                sms,
                smsItems: sms.audienceImportId ? items(sms.audienceImportId) : {}
            }
        },
        then({
            preview,
            previewed,
            membersAfterPreview,
            stale,
            applied,
            again,
            outcome,
            errors,
            readerErrors,
            readerDetail,
            sms,
            smsItems
        }) {
            preview.refusal == ""
            preview.rowCount == 6 &&
                preview.matchCount == 2 &&
                preview.addCount == 2 &&
                preview.excludeCount == 1 &&
                preview.skipCount == 1
            membersAfterPreview == 0
            previewed[1].proposedAction == "match" && previewed[1].matchedPartyId == party.Ana
            previewed[3].exclusionCode == "INVALID_ADDRESS"
            previewed[4].exclusionCode == "DUPLICATE_IN_FILE"
            // Pia's address is another user's personal contact: not matched, a new contact proposed
            previewed[5].proposedAction == "add" && previewed[5].matchedPartyId == null
            previewed[6].proposedAction == "match" && previewed[6].exclusionCode == null
            // no address in full on an item
            previewed[1].addressMasked == "a***@example.com"
            stale.refusal.includes("STALE_REVISION")
            applied.refusal == "" && applied.stateEnumId == "AisComplete"
            applied.pendingCount == 3 && applied.refusedCount == 1 && applied.invalidCount == 1 && applied.skippedCount == 1
            outcome[1].outcome == "pending" && outcome[1].partyId == party.Ana
            outcome[3].outcome == "invalid" && outcome[4].outcome == "skipped"
            // the withdrawal after the preview wins
            outcome[6].outcome == "refused" && outcome[6].reasonCode == "WITHDRAWN"
            status(listId, party.Ben) == null
            // a new directory contact for Fay and for Pia's address, never Pia's personal contact
            outcome[5].partyId != party.Pia && row("mantle.party.Party", {partyId: outcome[5].partyId}).privateOwnerUserId == null
            status(listId, party.Pia) == null
            row("mantle.party.Party", {partyId: outcome[2].partyId}).privateOwnerUserId == null
            // each request names the import's row and its own evidence, the column's or the import's
            rows(REQUEST, {sourceRecordId: preview.audienceImportId + ":2"})[0].evidenceText == "Asked at the counter"
            rows(REQUEST, {sourceRecordId: preview.audienceImportId + ":1"})[0].evidenceText == "Fair sign-up sheet"
            rows(REQUEST, {sourceRecordId: preview.audienceImportId + ":1"})[0].requestKindEnumId == "SrkImport"
            rows(CLP, {contactListId: listId}).length == 3
            // applying again changes nothing
            again.refusal == "" && rows(REQUEST, {contactListId: listId}).length == 4
            // the error rows (the file's every column) for an importer, not for an audience reader
            errors.refusal == "" && errors.rowCount == 2 && errors.fileText.includes("not-an-address")
            readerErrors.refusal.includes("PERMISSION_DENIED")
            readerDetail.refusal == "" && readerDetail.capabilities.canDownloadErrors == false
            // a number is matched by the number, never by a name alone
            sms.refusal == "" && smsItems[1].proposedAction == "add" && smsItems[1].matchedPartyId == null
        }
    }
)

feature("a restart applies only the rows not yet applied, each once; the runs answer by the audience view and the organization", {
    when() {
        const text = [
            "Email,Name",
            "ana.audimp@example.com,Ana",
            "ben2.audimp@example.com,Ben Two",
            "cy.audimp@example.com,Cy"
        ].join("\n")
        const preview = as(users.importer, L + "preview#AudienceImport", {
            contactListId: restartListId,
            fileText: text,
            fileName: "restart.csv",
            evidenceText: "Booth sign-ups",
            evidenceDate: ago(2)
        })
        // an apply that stopped after its first row (marked applied without a request) and is started again
        system(() => {
            lib.run("update#mantle.marketing.contact.AudienceImport", {
                audienceImportId: preview.audienceImportId,
                stateEnumId: "AisApplying"
            })
            lib.run("update#" + ITEM, {
                audienceImportId: preview.audienceImportId,
                rowNumber: 1,
                outcome: "pending",
                attemptCount: 1
            })
        })
        const current = row("mantle.marketing.contact.AudienceImport", {audienceImportId: preview.audienceImportId})
        const restarted = as(users.importer, L + "apply#AudienceImport", {
            audienceImportId: preview.audienceImportId,
            expectedRevision: Number(current.lastUpdatedStamp)
        })
        const runs = username =>
            Array.from(as(username, L + "find#AudienceImportRuns", {targetId: "marketingAudience"}).runList || []).map(
                run => run.runId
            )
        return {
            preview,
            restarted,
            reader: runs(users.reader),
            otherOrg: runs(users.importerB),
            noView: runs(users.other),
            detail: as(users.reader, L + "get#AudienceImport", {audienceImportId: preview.audienceImportId}),
            otherDetail: as(users.importerB, L + "get#AudienceImport", {audienceImportId: preview.audienceImportId})
        }
    },
    then({preview, restarted, reader, otherOrg, noView, detail, otherDetail}) {
        preview.refusal == "" && preview.rowCount == 3
        restarted.refusal == "" && restarted.stateEnumId == "AisComplete"
        rows(REQUEST, {sourceRecordId: preview.audienceImportId + ":1"}).length == 0
        rows(REQUEST, {sourceRecordId: preview.audienceImportId + ":2"}).length == 1
        rows(REQUEST, {sourceRecordId: preview.audienceImportId + ":3"}).length == 1
        reader.includes(preview.audienceImportId)
        !otherOrg.includes(preview.audienceImportId)
        noView.length == 0
        detail.refusal == "" && detail.itemListCount == 3 && detail.audienceImport.fileName == "restart.csv"
        !JSON.stringify(detail).includes("ben2.audimp@example.com")
        otherDetail.refusal.includes("RECORD_UNAVAILABLE")
    }
})
