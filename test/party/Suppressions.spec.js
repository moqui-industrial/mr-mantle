// Comms' suppressions (impl-marketing P3, F13, F16; design-marketing §4 Suppressions; mantle.party.MessageServices over
// MessageSuppressions.js and the ledger's attempt in MessageDeliveries.js): a suppressed destination is refused at the ledger's
// attempt however its address is typed, another destination still sent; a new subscription does not end a suppression; ending
// one needs MESSAGE_SUPPRESSION_REVIEW and new evidence, and the row stays; a Marketing audience editor adds a block for an
// organization of their scope only, and reads another organization's not at all.
// Standalone: spec-local organizations, users, parties, template and source. Run: ./moq test mr-mantle --spec Suppressions
const lib = ec.resource.script("component://mr-mantle/test/marketing/MarketingSpecLib.js")
const {make, row, rows, system, organization, user, as} = lib
const M = "mantle.party.MessageServices."
const capture = ec.factory.getTool("MailCapture")
const prefix = "MSP"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const ids = {source: "MdsrcSpecSuppress", template: prefix + "_TPL", buyer: prefix + "_BUYER"}
const users = {}
let blockId, listId
// the spec's own blocks among those found (a demo instance holds others)
const ownBlocks = found => Array.from(found.suppressionList).filter(block => /suppress\.example\.test$/.test(block.destinationText))

spec({
    setupSpec() {
        capture.enable()
        system(() => {
            organization(orgA, "Suppressions A")
            organization(orgB, "Suppressions B")
            users.editor = user(
                prefix,
                "editor",
                [orgA],
                ["MARKETING_AUDIENCE_VIEW", "MARKETING_AUDIENCE_EDIT", "MARKETING_CONSENT_EDIT"]
            )
            users.editorB = user(prefix, "editorB", [orgB], ["MARKETING_AUDIENCE_VIEW", "MARKETING_AUDIENCE_EDIT"])
            users.configurer = user(prefix, "configurer", [orgA], ["MARKETING_VIEW", "MARKETING_CONFIGURE"])
            users.reviewer = user(prefix, "reviewer", [], ["MESSAGE_SUPPRESSION_REVIEW"])
            make("moqui.basic.Enumeration", {
                enumId: ids.source,
                enumTypeId: "MessageDeliverySource",
                description: "Spec suppression source"
            })
            make("moqui.basic.email.EmailServer", {
                emailServerId: prefix + "_SMTP",
                smtpHost: "127.0.0.1",
                smtpPort: "9",
                smtpStartTls: "N"
            })
            make("moqui.basic.email.EmailTemplate", {
                emailTemplateId: ids.template,
                emailServerId: prefix + "_SMTP",
                fromAddress: "notices@suppress.example.test",
                subject: "Suppression spec",
                bodyScreenLocation: "component://framework/screen/ScreenRenderEmail.xml"
            })
            make("mantle.party.Party", {partyId: ids.buyer, partyTypeEnumId: "PtyPerson"})
            make("mantle.party.Person", {partyId: ids.buyer, firstName: "Suppression", lastName: "Buyer"})
            make("mantle.party.contact.ContactMech", {
                contactMechId: ids.buyer + "_EM",
                contactMechTypeEnumId: "CmtEmailAddress",
                infoString: "blocked@suppress.example.test"
            })
            make("mantle.party.contact.PartyContactMech", {
                partyId: ids.buyer,
                contactMechId: ids.buyer + "_EM",
                contactMechPurposeId: "EmailPrimary",
                fromDate: new Date(Date.now() - 86400000)
            })
            listId = prefix + "_LIST"
            make("mantle.marketing.contact.ContactList", {
                contactListId: listId,
                contactListName: "Suppression news",
                contactListTypeEnumId: "NEWSLETTER",
                ownerPartyId: orgA,
                contactMechTypeEnumId: "CmtEmailAddress"
            })
        })
    },
    cleanupSpec() {
        capture.reset()
    }
})

feature("a suppressed destination is refused at the ledger's attempt, however it is typed; another is sent", {
    when() {
        const added = system(() =>
            lib.run(M + "store#Suppression", {
                destination: "Blocked@Suppress.example.test ",
                reasonEnumId: "MsrHardBounce",
                sourceEnumId: "MssReport",
                sourceRef: "spec-dsn-1",
                evidenceText: "550 5.1.1 user unknown"
            })
        )
        blockId = added.suppressionId
        const queue = (eventKey, toAddress) =>
            system(() =>
                lib.run(M + "queue#Delivery", {
                    eventKey,
                    sourceEnumId: ids.source,
                    recipientPartyId: ids.buyer,
                    toAddress,
                    templateKey: ids.template,
                    bodyParameters: {title: "Spec notice"},
                    sendNow: true
                })
            )
        capture.clear()
        const blocked = queue("spec:suppressed-1", "BLOCKED@suppress.example.test")
        const open = queue("spec:open-1", "open@suppress.example.test")
        return {
            added,
            again: system(() =>
                lib.run(M + "store#Suppression", {
                    destination: "blocked@suppress.example.test",
                    reasonEnumId: "MsrHardBounce",
                    evidenceText: "A second report"
                })
            ),
            blocked,
            open,
            attempt: row("mantle.party.MessageDeliveryAttempt", {deliveryId: blocked.deliveryId}),
            sent: capture.count()
        }
    },
    then({added, again, blocked, open, attempt, sent}) {
        added.created == true
        row("mantle.party.MessageSuppression", {suppressionId: blockId}).destinationKey == "blocked@suppress.example.test"
        again.created == false && again.suppressionId == blockId
        blocked.stateEnumId == "MdsSuppressed"
        attempt.outcome == "suppressed"
        open.stateEnumId == "MdsSent"
        sent == 1
    }
})

feature("a new subscription does not end a suppression; ending needs the review permission and new evidence", {
    when() {
        const subscribed = as(users.editor, "mantle.marketing.AudienceServices.request#Subscriptions", {
            contactListId: listId,
            partyIdList: [ids.buyer],
            accept: true,
            evidenceText: "Re-subscribed at the counter"
        })
        const end = {
            action: "end",
            suppressionId: blockId,
            evidenceText: "The mailbox exists again: a test message was delivered"
        }
        return {
            subscribed,
            active: system(() =>
                lib.run(M + "check#Suppressions", {destinationList: ["blocked@suppress.example.test"], organizationPartyId: orgA})
            ),
            editorEnd: as(users.editor, M + "store#Suppression", end),
            noEvidence: as(users.reviewer, M + "store#Suppression", {action: "end", suppressionId: blockId}),
            ended: as(users.reviewer, M + "store#Suppression", end),
            after: system(() => lib.run(M + "check#Suppressions", {destinationList: ["blocked@suppress.example.test"]}))
        }
    },
    then({subscribed, active, editorEnd, noEvidence, ended, after}) {
        subscribed.refusal == ""
        Array.from(subscribed.results)[0].outcome == "accepted" && Array.from(subscribed.results)[0].suppressed == true
        Array.from(active.suppressed).length == 1
        editorEnd.refusal.includes("PERMISSION_DENIED")
        noEvidence.refusal.includes("EVIDENCE_REQUIRED")
        ended.refusal == "" && ended.ended == true
        Array.from(after.suppressed).length == 0
        // the row and its source stay, with the reviewer's evidence
        row("mantle.party.MessageSuppression", {suppressionId: blockId}).sourceRef == "spec-dsn-1"
        !!row("mantle.party.MessageSuppression", {suppressionId: blockId}).endEvidenceText
    }
})

feature("an audience editor blocks for an organization of their scope only, and reads no other organization's block", {
    when() {
        const block = (username, organizationPartyId) =>
            as(username, M + "store#Suppression", {
                destination: "complaint@suppress.example.test",
                organizationPartyId,
                reasonEnumId: "MsrComplaint",
                evidenceText: "Marked our newsletter as spam"
            })
        const mine = block(users.editor, orgA)
        return {
            mine,
            theirs: block(users.editor, orgB),
            everyone: block(users.editor, null),
            foundA: as(users.editor, M + "find#Suppressions", {state: "all"}),
            foundB: as(users.editorB, M + "find#Suppressions", {state: "all"}),
            configurer: as(users.configurer, M + "find#Suppressions", {state: "all"}),
            otherOrg: as(users.editorB, M + "find#Suppressions", {organizationPartyId: orgA})
        }
    },
    then({mine, theirs, everyone, foundA, foundB, configurer, otherOrg}) {
        mine.refusal == "" && mine.created == true
        theirs.refusal.includes("ORGANIZATION_DENIED")
        everyone.refusal.includes("ORGANIZATION_DENIED")
        // A's editor: A's block and the provider-level one; B's editor: the provider-level one alone (the spec's blocks only)
        ownBlocks(foundA).length == 2
        ownBlocks(foundB).length == 1
        ownBlocks(foundB)[0].organizationText == "Every organization"
        // a configurer without the audience read sees the addresses masked
        Array.from(configurer.suppressionList).every(block => block.destinationText.includes("***@"))
        otherOrg.refusal.includes("ORGANIZATION_DENIED")
    }
})
