// The one outbound delivery ledger (design-crosscut CX-DELIVERY, X8; mr-pass impl-shop P6, F24; mantle.party.MessageServices
// over MessageDeliveries.js): one delivery per event, recipient, channel and template, sent once whatever the retries; the
// consent snapshot taken at the hand-off (a transactional notice's, a marketing message's granted or not, which suppresses
// it); a retryable outcome waits for the job, and an uncertain one is kept for review and never sent again on its own.
// Standalone: spec-local parties, templates and source. Run: ./moq test mr-mantle --spec DeliveryLedger
const M = "mantle.party.MessageServices."
const capture = ec.factory.getTool("MailCapture")
const ids = {source: "MdsrcSpecLedger", sent: "MDL_SENT", down: "MDL_DOWN", buyer: "MDL_BUYER", reader: "MDL_READER"}
const one = (entity, fields) => ec.entity.find(entity).condition(fields).disableAuthz().one()
const list = (entity, fields) => Array.from(ec.entity.find(entity).condition(fields).disableAuthz().list())
const queue = values =>
    call(
        M + "queue#Delivery",
        Object.assign({sourceEnumId: ids.source, templateKey: ids.sent, bodyParameters: {title: "Spec notice"}}, values)
    )

spec({
    setupSpec() {
        capture.enable()
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        call("create#moqui.basic.Enumeration", {
            enumId: ids.source,
            enumTypeId: "MessageDeliverySource",
            description: "Spec ledger source"
        })
        call("create#moqui.basic.email.EmailServer", {
            emailServerId: "MDL_SMTP",
            smtpHost: "127.0.0.1",
            smtpPort: "9",
            smtpStartTls: "N"
        })
        // a server no one can reach: a send to it is retryable (nothing was sent)
        call("create#moqui.basic.email.EmailServer", {
            emailServerId: "MDL_NOWHERE",
            smtpHost: "mail.nowhere.invalid",
            smtpPort: "25",
            smtpStartTls: "N"
        })
        for (const [emailTemplateId, emailServerId] of [
            [ids.sent, "MDL_SMTP"],
            [ids.down, "MDL_NOWHERE"]
        ])
            call("create#moqui.basic.email.EmailTemplate", {
                emailTemplateId,
                emailServerId,
                fromAddress: "notices@ledger.example.test",
                subject: "Ledger " + emailTemplateId,
                bodyScreenLocation: "component://framework/screen/ScreenRenderEmail.xml"
            })
        for (const partyId of [ids.buyer, ids.reader]) {
            call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
            call("create#mantle.party.Person", {partyId, firstName: "Ledger", lastName: partyId})
        }
        call("mantle.party.ConsentServices.store#PartyConsent", {
            partyId: ids.reader,
            purposeEnumId: "PcpMarketingEmail",
            statusId: "PconGranted"
        })
    },
    cleanupSpec() {
        ec.artifactExecution.enableAuthz()
        capture.reset()
    }
})

feature("one delivery per event and recipient, sent once; a transactional notice's consent snapshot", {
    when() {
        capture.clear()
        const key = {eventKey: "spec:order-1", recipientPartyId: ids.buyer, toAddress: "buyer@ledger.example.test"}
        const first = queue(Object.assign({sendNow: true}, key))
        const again = queue(Object.assign({sendNow: true}, key))
        const tried = call(M + "attempt#Delivery", {deliveryId: first.deliveryId})
        return {first, again, tried, rows: list("mantle.party.MessageDelivery", {eventKey: key.eventKey}), sent: capture.count()}
    },
    then({first, again, tried, rows, sent}) {
        first.created == true && first.stateEnumId == "MdsSent"
        again.created == false && again.deliveryId == first.deliveryId
        tried.stateEnumId == "MdsSent"
        rows.length == 1
        sent == 1
        JSON.parse(rows[0].consentJson).transactional == true
        rows[0].providerMessageId != null
    }
})

feature("a marketing message is sent only with its consent, which its snapshot keeps", {
    when() {
        const marketing = {transactional: false, marketingPurposeEnumId: "PcpMarketingEmail", sendNow: true}
        const without = queue(
            Object.assign(
                {eventKey: "spec:news-1", recipientPartyId: ids.buyer, toAddress: "buyer@ledger.example.test"},
                marketing
            )
        )
        const granted = queue(
            Object.assign(
                {eventKey: "spec:news-1", recipientPartyId: ids.reader, toAddress: "reader@ledger.example.test"},
                marketing
            )
        )
        return {
            without: one("mantle.party.MessageDelivery", {deliveryId: without.deliveryId}),
            granted: one("mantle.party.MessageDelivery", {deliveryId: granted.deliveryId})
        }
    },
    then({without, granted}) {
        without.stateEnumId == "MdsSuppressed"
        JSON.parse(without.consentJson).granted == false
        granted.stateEnumId == "MdsSent"
        JSON.parse(granted.consentJson).granted == true
    }
})

feature("a retryable outcome waits for the job; an uncertain one is kept for review and never resent", {
    when() {
        capture.disable()
        const retry = queue({
            eventKey: "spec:order-2",
            recipientPartyId: ids.buyer,
            toAddress: "buyer@ledger.example.test",
            templateKey: ids.down,
            sendNow: true
        })
        capture.enable()
        const waiting = one("mantle.party.MessageDelivery", {deliveryId: retry.deliveryId})
        // a sent notice the provider later reports it cannot confirm
        const sent = queue({
            eventKey: "spec:order-3",
            recipientPartyId: ids.buyer,
            toAddress: "buyer@ledger.example.test",
            sendNow: true
        })
        call(M + "record#DeliveryReceipt", {
            deliveryId: sent.deliveryId,
            out: {deliveryOutcome: "uncertain", sendError: "The provider lost the session"}
        })
        capture.clear()
        const job = call(M + "run#Deliveries", {limit: 50})
        const uncertain = one("mantle.party.MessageDelivery", {deliveryId: sent.deliveryId})
        const resolved = call(M + "resolve#Delivery", {
            deliveryId: sent.deliveryId,
            outcome: "sent",
            note: "The provider's log shows it"
        })
        return {
            waiting,
            job,
            uncertain,
            resent: capture.count(),
            resolved,
            attempts: list("mantle.party.MessageDeliveryAttempt", {deliveryId: sent.deliveryId})
        }
    },
    then({waiting, job, uncertain, resent, resolved, attempts}) {
        waiting.stateEnumId == "MdsRetry"
        waiting.nextAttemptDate != null
        waiting.lastError != null
        uncertain.stateEnumId == "MdsUncertain"
        resent == 0
        resolved.stateEnumId == "MdsSent"
        attempts.length == 2
    }
})

// The framework's mail queue (org.moqui.admin.OperationServices; mr-boss impl-admin P12): the ledger answers for the stored
// messages its attempts made, so the queue offers no retry beside the ledger's own and reconciles an uncertain one through it.
feature("the mail queue leaves the ledger's messages to the ledger, and reconciles an uncertain one through it", {
    when() {
        const O = "org.moqui.admin.OperationServices."
        const outcome = emailMessageId => call(O + "find#MailOutcomes", {emailMessageId, state: "all"}).outcomeList[0]
        capture.disable()
        const waiting = queue({
            eventKey: "spec:order-9",
            recipientPartyId: ids.buyer,
            toAddress: "buyer@ledger.example.test",
            templateKey: ids.down,
            sendNow: true
        })
        capture.enable()
        capture.clear()
        const attempt = one("mantle.party.MessageDeliveryAttempt", {deliveryId: waiting.deliveryId, attemptSeqId: "001"})
        const listed = outcome(attempt.emailMessageId)
        const retried = call(O + "retry#MailOutcome", {emailMessageId: attempt.emailMessageId, expectedRevision: listed.revision})
        // the same hand-off lost part way: the delivery and its message are uncertain
        call("update#mantle.party.MessageDelivery", {deliveryId: waiting.deliveryId, stateEnumId: "MdsUncertain"})
        call("update#moqui.basic.email.EmailMessage", {emailMessageId: attempt.emailMessageId, sendOutcome: "uncertain"})
        const uncertain = outcome(attempt.emailMessageId)
        const again = call(O + "retry#MailOutcome", {
            emailMessageId: attempt.emailMessageId,
            expectedRevision: uncertain.revision
        })
        const settled = call(O + "reconcile#MailOutcome", {
            emailMessageId: attempt.emailMessageId,
            resolution: "delivered",
            reason: "The provider's log shows it",
            expectedRevision: uncertain.revision
        })
        // a forum notice (a stored message of a site's notice template) is the forum worker's, which tries it again itself
        call("create#mantle.public.PublicSite", {siteId: "MDL_FORUM_SITE"})
        call("create#mantle.forum.ForumMailSettings", {siteId: "MDL_FORUM_SITE", templateId: ids.sent})
        call("create#moqui.basic.email.EmailMessage", {
            emailMessageId: "MDL_FORUM_NOTICE",
            statusId: "ES_READY",
            emailTemplateId: ids.sent,
            sendOutcome: "retryable",
            sendError: "451 try again later"
        })
        const forum = outcome("MDL_FORUM_NOTICE")
        const forumRetried = call(O + "retry#MailOutcome", {emailMessageId: "MDL_FORUM_NOTICE", expectedRevision: forum.revision})
        call("delete#mantle.forum.ForumMailSettings", {siteId: "MDL_FORUM_SITE"})
        return {
            listed,
            retried,
            uncertain,
            again,
            settled,
            forum,
            forumRetried,
            sends: capture.count(),
            delivery: one("mantle.party.MessageDelivery", {deliveryId: waiting.deliveryId}),
            message: one("moqui.basic.email.EmailMessage", {emailMessageId: attempt.emailMessageId})
        }
    },
    then(r) {
        r.listed.ownerKind === "registered"
        r.listed.ownerKey === "mantleDeliveryLedger"
        r.listed.ownerRef === r.delivery.deliveryId
        r.listed.state === "retryable"
        r.listed.retryEligible === false
        r.listed.abandonEligible === false
        r.retried.applied === false
        r.retried.reasonCode === "OWNER_RETRIES"
        r.uncertain.reconcileEligible === true
        r.again.reasonCode === "RECONCILE_REQUIRED"
        r.settled.applied === true
        // the ledger's own record is the ledger's (resolve#Delivery); the stored message is never marked Sent by a person:
        // it keeps what the transport left, with the settlement beside it
        r.delivery.stateEnumId === "MdsSent"
        r.settled.state === "settled"
        r.message.statusId === "ES_READY"
        r.message.sendOutcome === "uncertain"
        r.message.sendSettlement === "delivered"
        r.forum.ownerKey === "forumDeliveries"
        r.forum.retryEligible === false
        r.forumRetried.reasonCode === "OWNER_RETRIES"
        r.sends === 0
    }
})
