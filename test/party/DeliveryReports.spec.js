// Comms' bounce intake (impl-marketing P6, F14, F18, F76; design-marketing §15.1 DeliveryReportIntake, §15.2; mantle.party.
// MessageServices process#DeliveryReport over MessageDeliveryReports.js and the framework's read#DeliveryReport): a DSN's hard bounce
// and an abuse report (ARF) each record a receipt fact of the delivery their VERP key names and suppress its address once; a report
// read again, or a second copy of it, changes nothing; a soft bounce suppresses nothing; a later delivered fact never moves a bounce
// back; an unknown key and an unreadable message are recorded and left, and the next report is processed; the edge relay's bounce
// (a sent message turning ES_BOUNCED) is matched by the attempt that sent it.
// Standalone: spec-local organizations, profile, bounce account, deliveries and reports. Run: ./moq test mr-mantle --spec DeliveryReports
const lib = ec.resource.script("component://mr-mantle/test/marketing/MarketingSpecLib.js")
const {make, row, rows, system, organization, user, as} = lib
const M = "mantle.party.MessageServices."
const capture = ec.factory.getTool("MailCapture")
const prefix = "MDR"
const orgA = prefix + "_ORG_A"
const domain = "bounce.reports.example.test"
const ids = {source: "MdsrcSpecReports", template: prefix + "_TPL", relay: prefix + "_RELAY", account: prefix + "_BOUNCES"}
const deliveries = {}
const S = "mantle.party.MessageSuppression"
const blocks = address => rows(S, {destinationKey: address})
let messageSeq = 0

// A report as the bounce account stores it: the message, its trace field, and its parts as files.
function received(deliveredTo, parts, emailAccountId = ids.account) {
    const emailMessageId = prefix + "_MSG" + ++messageSeq
    system(() => {
        make("moqui.basic.email.EmailMessage", {
            emailMessageId,
            emailAccountId,
            statusId: "ES_RECEIVED",
            subject: "Report " + messageSeq,
            fromAddress: "mailer-daemon@mx.example.net",
            toAddresses: deliveredTo,
            headersString: "Delivered-To: " + deliveredTo + "\r\nSubject: Report " + messageSeq,
            receivedDate: ec.user.nowTimestamp
        })
        parts.forEach(([contentType, text], index) => {
            const location = "dbresource://email/spec/" + emailMessageId + "/" + (index + 1)
            ec.resource.getLocationReference(location).putText(text)
            make("moqui.basic.email.EmailMessageAttachment", {
                emailMessageAttachmentId: emailMessageId + "_" + (index + 1),
                emailMessageId,
                attachmentLocation: location,
                contentType,
                fileName: "part-" + (index + 1)
            })
        })
    })
    return emailMessageId
}
const dsn = (recipient, action, status) => [
    "message/delivery-status",
    "Reporting-MTA: dns; mx.example.net\r\n\r\nFinal-Recipient: rfc822; " +
        recipient +
        "\r\nAction: " +
        action +
        "\r\nStatus: " +
        status +
        "\r\nDiagnostic-Code: smtp; " +
        status +
        " <" +
        recipient +
        "> spec\r\n"
]
const arf = mailFrom => [
    "message/feedback-report",
    "Feedback-Type: abuse\r\nVersion: 1\r\nOriginal-Mail-From: <" + mailFrom + ">\r\nOriginal-Rcpt-To: <x@example.net>\r\n"
]
// a delivery's VERP address carries its random key (P6 review)
const keyOf = name => row("mantle.party.MessageDelivery", {deliveryId: deliveries[name]}).bounceKey
const verp = name => "bounces+" + deliveries[name] + "." + keyOf(name) + "@" + domain
const processReport = emailMessageId => system(() => lib.run(M + "process#DeliveryReport", {emailMessageId}))

spec({
    setupSpec() {
        capture.enable()
        system(() => {
            organization(orgA, "Reports A")
            organization(prefix + "_ORG_B", "Reports B")
            // suppression reviewers of each organization, for the receipts (P6 review)
            user(prefix, "reviewerA", [orgA], ["MESSAGE_SUPPRESSION_REVIEW"])
            user(prefix, "reviewerB", [prefix + "_ORG_B"], ["MESSAGE_SUPPRESSION_REVIEW"])
            make("moqui.basic.Enumeration", {
                enumId: ids.source,
                enumTypeId: "MessageDeliverySource",
                description: "Spec report source"
            })
            make("moqui.basic.email.EmailServer", {
                emailServerId: ids.relay,
                smtpHost: "127.0.0.1",
                smtpPort: "9",
                smtpStartTls: "N"
            })
            make("moqui.basic.email.EmailTemplate", {
                emailTemplateId: ids.template,
                emailServerId: ids.relay,
                fromAddress: "notices@reports.example.test",
                subject: "Report spec",
                bodyScreenLocation: "component://framework/screen/ScreenRenderEmail.xml"
            })
            make("moqui.basic.email.EmailAccount", {
                emailAccountId: ids.account,
                accountKindEnumId: "EakHosted",
                emailAddress: "bounces@" + domain,
                statusId: "EasActive"
            })
            // a person's mailbox, which gets bounces of its own mail
            make("moqui.basic.email.EmailAccount", {
                emailAccountId: prefix + "_PERSONAL",
                accountKindEnumId: "EakHosted",
                emailAddress: "someone@" + domain,
                statusId: "EasActive"
            })
            const profile = lib.run(M + "store#SendingProfile", {
                organizationPartyId: orgA,
                profileName: "Reports",
                emailServerId: ids.relay,
                fromAddress: "news@reports.example.test",
                bounceDomain: domain
            })
            for (const name of ["hard", "complaint", "soft", "edge", "later", "forged"]) {
                const partyId = prefix + "_" + name.toUpperCase()
                make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
                deliveries[name] = lib.run(M + "queue#Delivery", {
                    eventKey: "spec:reports-" + name,
                    sourceEnumId: ids.source,
                    recipientPartyId: partyId,
                    toAddress: name + "@reports.example.test",
                    templateKey: ids.template,
                    bodyParameters: {title: "Spec"},
                    sendingProfileId: profile.sendingProfileId,
                    sendNow: true
                }).deliveryId
            }
        })
    },
    cleanupSpec() {
        capture.reset()
    }
})

feature("a hard bounce and a complaint each record their fact and suppress once; a duplicate report changes nothing", {
    when() {
        const hard = received(verp("hard"), [dsn("hard@reports.example.test", "failed", "5.1.1")])
        const first = processReport(hard)
        const again = processReport(hard)
        const copy = processReport(received(verp("hard"), [dsn("hard@reports.example.test", "failed", "5.1.1")]))
        // an abuse report names the delivery by its original envelope sender
        const complaint = processReport(received("abuse-desk@" + domain, [arf(verp("complaint"))]))
        return {first, again, copy, complaint}
    },
    then({first, again, copy, complaint}) {
        first.statusEnumId == "MrsApplied" && first.deliveryId == deliveries.hard && first.receiptEnumId == "MdrHardBounce"
        row("mantle.party.MessageDelivery", {deliveryId: deliveries.hard}).receiptEnumId == "MdrHardBounce"
        // the hand-off state is untouched by the fact
        row("mantle.party.MessageDelivery", {deliveryId: deliveries.hard}).stateEnumId == "MdsSent"
        const hardBlocks = blocks("hard@reports.example.test")
        hardBlocks.length == 1 && hardBlocks[0].reasonEnumId == "MsrHardBounce" && hardBlocks[0].organizationPartyId == null
        again.duplicate == true
        copy.statusEnumId == "MrsNoChange"
        rows("mantle.party.MessageDeliveryReceipt", {deliveryId: deliveries.hard}).length == 1
        complaint.statusEnumId == "MrsApplied" && complaint.receiptEnumId == "MdrComplaint"
        const complaintBlocks = blocks("complaint@reports.example.test")
        complaintBlocks.length == 1 &&
            complaintBlocks[0].reasonEnumId == "MsrComplaint" &&
            complaintBlocks[0].organizationPartyId == orgA
    }
})

feature("a soft bounce suppresses nothing; a later delivered fact never moves a bounce back", {
    when() {
        const soft = processReport(received(verp("soft"), [dsn("soft@reports.example.test", "failed", "4.2.2")]))
        const delivered = processReport(received(verp("hard"), [dsn("hard@reports.example.test", "delivered", "2.0.0")]))
        return {soft, delivered}
    },
    then({soft, delivered}) {
        soft.receiptEnumId == "MdrSoftBounce" && soft.statusEnumId == "MrsApplied"
        blocks("soft@reports.example.test").length == 0
        delivered.receiptEnumId == "MdrDelivered" && delivered.statusEnumId == "MrsApplied"
        rows("mantle.party.MessageDeliveryReceipt", {deliveryId: deliveries.hard}).length == 2
        row("mantle.party.MessageDelivery", {deliveryId: deliveries.hard}).receiptEnumId == "MdrHardBounce"
    }
})

feature(
    "an unknown key and an unreadable message are recorded and left; the next report is processed; the edge's bounce is matched",
    {
        when() {
            const unknown = processReport(received("bounces+NOSUCH9@" + domain, [dsn("x@example.net", "failed", "5.1.1")]))
            const unreadable = processReport(received(verp("later"), [["text/plain", "Out of office"]]))
            const next = processReport(received(verp("later"), [dsn("later@reports.example.test", "failed", "5.7.1")]))
            // the edge relay marks the delivery's sent message bounced itself: its ECA reads it after the write commits
            const attempt = row("mantle.party.MessageDeliveryAttempt", {deliveryId: deliveries.edge})
            system(() =>
                lib.run("update#moqui.basic.email.EmailMessage", {
                    emailMessageId: attempt.emailMessageId,
                    statusId: "ES_BOUNCED",
                    sendError: "550 5.1.1 unknown user"
                })
            )
            // the ECA reads it on a service worker once the update commits: wait for it a moment
            let edge = null
            const until = Date.now() + 5000
            while (!edge && Date.now() < until)
                edge = row("mantle.party.MessageDeliveryReport", {emailMessageId: attempt.emailMessageId})
            const polled = system(() => lib.run(M + "run#DeliveryReports", {}))
            return {unknown, unreadable, next, edge, polled}
        },
        then({unknown, unreadable, next, edge, polled}) {
            unknown.statusEnumId == "MrsUnknownKey"
            unreadable.statusEnumId == "MrsUnreadable"
            next.statusEnumId == "MrsApplied" && next.receiptEnumId == "MdrHardBounce"
            edge != null && edge.statusEnumId == "MrsApplied" && edge.reportKindEnumId == "MrkEdge"
            row("mantle.party.MessageDelivery", {deliveryId: deliveries.edge}).receiptEnumId == "MdrHardBounce"
            blocks("edge@reports.example.test").length == 1
            // nothing left for the poll: each message was read once
            polled.applied == 0
        }
    }
)

// P6 review: anyone can mail the bounce address and delivery ids are a sequence, so a forged report must name the delivery's random
// key; a DSN about another address says nothing of the delivery; a report in another mailbox is its owner's mail, never read
feature("a forged report suppresses nothing: no key, a wrong key, another recipient, another mailbox", {
    when() {
        const forged = name => "bounces+" + deliveries[name] + "@" + domain
        const noKey = processReport(received(forged("forged"), [dsn("forged@reports.example.test", "failed", "5.1.1")]))
        const wrongKey = processReport(
            received("bounces+" + deliveries.forged + ".AAAAAAAAAAAAAAAA@" + domain, [
                dsn("forged@reports.example.test", "failed", "5.1.1")
            ])
        )
        const arfNoKey = processReport(received("abuse-desk@" + domain, [arf(forged("forged"))]))
        const another = processReport(received(verp("forged"), [dsn("victim@reports.example.test", "failed", "5.1.1")]))
        const personalId = received(verp("forged"), [dsn("forged@reports.example.test", "failed", "5.1.1")], prefix + "_PERSONAL")
        const personal = processReport(personalId)
        return {noKey, wrongKey, arfNoKey, another, personal, personalId}
    },
    then({noKey, wrongKey, arfNoKey, another, personal, personalId}) {
        noKey.statusEnumId == "MrsUnknownKey" &&
            wrongKey.statusEnumId == "MrsUnknownKey" &&
            arfNoKey.statusEnumId == "MrsUnknownKey"
        another.statusEnumId == "MrsIgnored" && another.deliveryId == deliveries.forged
        personal.notBounceAccount == true && row("mantle.party.MessageDeliveryReport", {emailMessageId: personalId}) == null
        blocks("forged@reports.example.test").length == 0 && blocks("victim@reports.example.test").length == 0
        rows("mantle.party.MessageDeliveryReceipt", {deliveryId: deliveries.forged}).length == 0
    }
})

// P6 review: the receipts of a delivery are read within the reader's organizations, and a diagnostic's address never shows
feature("a delivery's receipts are its organization's readers', without an address", {
    when() {
        const own = as(prefix + "_REVIEWERA", M + "find#DeliveryReceipts", {deliveryId: deliveries.hard})
        const other = as(prefix + "_REVIEWERB", M + "find#DeliveryReceipts", {deliveryId: deliveries.hard})
        return {own, other}
    },
    then({own, other}) {
        own.refusal == "" && own.receiptList.length == 2
        own.receiptList.every(receipt => !String(receipt.detail).includes("@"))
        other.refusal.includes("RECORD_UNAVAILABLE")
    }
})
