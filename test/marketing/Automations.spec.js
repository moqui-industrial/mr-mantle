// Marketing's automations (impl-marketing P11; design-marketing §6 AutomationDetail, EnrollmentDetail, §15.3;
// mantle.marketing.AutomationServices over MarketingAutomations.js): an automation is approved and activated apart, and a
// duplicate admission event enrolls once; a completed send step is not replayed after a restart, and a pause holds a due step that
// a resume sends; a withdrawal stops an enrollment while a channel's withdrawal skips only that channel's sends; a goal met ends an
// enrollment and a stopped one does not resume; a day wait across a daylight-saving gap lands on the next valid instant and a
// business-day wait skips the weekend; another organization's automation is missing; an order placed files its admission event
// once; an automation runs as its owner (the user's call, Nov 14): a Sales lead segment admits under an owner with Sales access, a
// dispatcher without it cannot activate it, and the owner losing the permission pauses the run.
// Standalone: spec-local organizations, users, parties, a topic, a template and a profile. Run:
// ./moq test mr-mantle --spec Automations
const lib = ec.resource.script("component://mr-mantle/test/marketing/MarketingSpecLib.js")
const entityLib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {make, row, rows, system, organization, user, as, run} = lib
const A = "mantle.marketing.AutomationServices."
const C = "mantle.marketing.CampaignServices."
const M = "mantle.party.MessageServices."
const AUTOMATION = "mantle.marketing.automation.MarketingAutomation"
const ENROLLMENT = "mantle.marketing.automation.AutomationEnrollment"
const EXECUTION = "mantle.marketing.automation.AutomationStepExecution"
const EVENT = "mantle.marketing.automation.AutomationSourceEvent"
const capture = ec.factory.getTool("MailCapture")
const prefix = "MKO"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const topic = prefix + "_TOPIC"
const profile = prefix + "_PROFILE"
const relay = prefix + "_RELAY"
const users = {}
const ids = {}
const dayMs = 86400000
const ago = days => new Date(Date.now() - days * dayMs)
const addressOf = name => name.toLowerCase() + "@automation.example.test"
const settle = () => ec.factory.waitWorkerPoolEmpty(50)
const revisionOf = marketingAutomationId => entityLib.ms(row(AUTOMATION, {marketingAutomationId}).lastUpdatedStamp)
const enrollmentOf = (marketingAutomationId, name) => row(ENROLLMENT, {marketingAutomationId, partyId: ids[name]})
const executionsOf = automationEnrollmentId => rows(EXECUTION, {automationEnrollmentId})
const mailTo = name => Array.from(capture.getMessages()).filter(m => Array.from(m.toList || []).includes(addressOf(name)))
const admit = marketingAutomationId => system(() => run(A + "run#AutomationAdmission", {marketingAutomationId}))
const steps = marketingAutomationId => {
    settle()
    return system(() => run(A + "run#AutomationSteps", {marketingAutomationId}))
}
// a person of A with a primary address, a member of the topic with a grant when member is true
function person(name, member) {
    const partyId = (ids[name] = prefix + "_" + name.toUpperCase())
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson", ownerPartyId: orgA})
    make("mantle.party.Person", {partyId, firstName: name, lastName: "Automationspec"})
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
    if (!member) return
    make("mantle.marketing.contact.ContactListParty", {
        contactListId: topic,
        partyId,
        fromDate: ago(20),
        statusId: "CLPT_ACCEPTED",
        preferredContactMechId: partyId + "_EM"
    })
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
// a draft automation of the campaign with its steps (welcome, wait two days, follow-up by default): its id
function draft(fields = {}, stepList = null) {
    const made = as(
        users.author,
        A + "create#Automation",
        Object.assign(
            {marketingCampaignId: ids.campaign, automationName: "Welcome", contactListId: topic, sendingProfileId: profile},
            fields
        )
    )
    if (made.refusal) throw new Error("create: " + made.refusal)
    const stored = as(users.author, A + "store#Steps", {
        marketingAutomationId: made.marketingAutomationId,
        expectedRevision: revisionOf(made.marketingAutomationId),
        steps: stepList || [
            {kind: "send", stepName: "Welcome", messageTemplateId: ids.template},
            {kind: "wait", waitAmount: 2, waitUnitEnumId: "AwuDays"},
            {kind: "send", stepName: "Follow-up", messageTemplateId: ids.template}
        ]
    })
    if (stored.refusal) throw new Error("steps: " + stored.refusal)
    return made.marketingAutomationId
}
const targetRevision = marketingAutomationId => Number(row(AUTOMATION, {marketingAutomationId}).automationRevision)
function approve(marketingAutomationId) {
    const asked = as(users.author, C + "request#MarketingApproval", {
        targetKind: "automation",
        targetId: marketingAutomationId,
        targetRevision: targetRevision(marketingAutomationId)
    })
    if (asked.refusal) throw new Error("request: " + asked.refusal)
    const decided = as(users.approver, C + "decide#MarketingApproval", {
        targetKind: "automation",
        targetId: marketingAutomationId,
        targetRevision: targetRevision(marketingAutomationId),
        decision: "approve"
    })
    if (decided.refusal) throw new Error("decide: " + decided.refusal)
}
const activate = (username, marketingAutomationId) =>
    as(username, A + "activate#Automation", {marketingAutomationId, expectedRevision: revisionOf(marketingAutomationId)})
function active(fields, stepList) {
    const marketingAutomationId = draft(fields, stepList)
    approve(marketingAutomationId)
    const out = activate(users.dispatcher, marketingAutomationId)
    if (out.refusal) throw new Error("activate: " + out.refusal)
    return marketingAutomationId
}
// a person subscribed now through the evidenced path, accepted
function subscribe(name) {
    const out = as(users.audience, "mantle.marketing.AudienceServices.request#Subscriptions", {
        contactListId: topic,
        partyIdList: [ids[name]],
        evidenceText: "Asked at the spec's counter",
        accept: true
    })
    if (out.refusal) throw new Error("subscribe: " + out.refusal)
}
// the enrollment's next step made due now
function dueNow(automationEnrollmentId, fields = {}) {
    system(() => run("update#" + ENROLLMENT, Object.assign({automationEnrollmentId, nextDueDate: ago(0.001)}, fields)))
}

spec({
    setupSpec() {
        capture.enable()
        system(() => {
            organization(orgA, "Automation A")
            organization(orgB, "Automation B")
            users.author = user(
                prefix,
                "author",
                [orgA],
                ["MARKETING_VIEW", "MARKETING_CAMPAIGN_EDIT", "MARKETING_SEND_EDIT", "MESSAGE_TEMPLATE_VIEW"]
            )
            users.editor = user(prefix, "editor", [orgA], ["MESSAGE_TEMPLATE_VIEW", "MESSAGE_TEMPLATE_EDIT"])
            users.approver = user(prefix, "approver", [orgA], ["MARKETING_VIEW", "MARKETING_APPROVE"])
            users.dispatcher = user(prefix, "dispatcher", [orgA], ["MARKETING_VIEW", "MARKETING_DISPATCH"])
            users.approverDispatcher = user(
                prefix,
                "apprdisp",
                [orgA],
                ["MARKETING_VIEW", "MARKETING_APPROVE", "MARKETING_DISPATCH"]
            )
            users.dispatcherB = user(prefix, "dispatcherB", [orgB], ["MARKETING_VIEW", "MARKETING_DISPATCH"])
            // a dispatcher who also reads the organization's Sales pipeline: an automation's owner with Sales facts
            users.salesDispatcher = user(
                prefix,
                "salesdisp",
                [orgA],
                ["MARKETING_VIEW", "MARKETING_DISPATCH", "SALES_VIEW", "SALES_TEAM_VIEW"]
            )
            users.audience = user(
                prefix,
                "audience",
                [orgA],
                ["MARKETING_VIEW", "MARKETING_AUDIENCE_VIEW", "MARKETING_AUDIENCE_EDIT", "MARKETING_CONSENT_EDIT"]
            )
            users.reader = user(prefix, "reader", [orgA], ["MARKETING_VIEW"])
            // writes and approves: under the one-person-team flag, which never admits an automation's own approval
            users.solo = user(
                prefix,
                "solo",
                [orgA],
                ["MARKETING_VIEW", "MARKETING_SEND_EDIT", "MARKETING_APPROVE", "MESSAGE_TEMPLATE_VIEW"]
            )
            make("mantle.marketing.campaign.MarketingPolicy", {
                organizationPartyId: orgA,
                fromDate: ago(5),
                selfApprovalAllowed: "Y"
            })
            make("mantle.marketing.contact.ContactList", {
                contactListId: topic,
                contactListName: "Automation topic",
                contactListTypeEnumId: "NEWSLETTER",
                contactMechTypeEnumId: "CmtEmailAddress",
                ownerPartyId: orgA
            })
            for (const name of ["Ann", "Kim", "Lee", "Mia", "Nia"]) person(name, true)
            for (const name of ["Hal", "Ivy", "Jon"]) person(name, false)
            // Kim meets the goal: an explicit segment of Kim alone
            make("mantle.marketing.segment.MarketSegment", {
                marketSegmentId: prefix + "_GOAL",
                segmentName: "Bought already",
                ownerPartyId: orgA,
                segmentKindEnumId: "MskExplicit"
            })
            make("mantle.marketing.segment.MarketSegmentParty", {
                marketSegmentId: prefix + "_GOAL",
                partyId: ids.Kim,
                roleTypeId: "_NA_",
                fromDate: ago(5),
                memberKindEnumId: "MspInclude"
            })
            // a rule segment reading Sales' leads: read as the automation's owner, under the owner's Sales access
            make("mantle.marketing.segment.MarketSegment", {
                marketSegmentId: prefix + "_SALES",
                segmentName: "Open leads",
                ownerPartyId: orgA,
                segmentKindEnumId: "MskRule"
            })
            make("mantle.marketing.segment.MarketSegmentFilter", {
                marketSegmentId: prefix + "_SALES",
                fromDate: ago(5),
                filterJson: JSON.stringify({
                    match: "all",
                    conditions: [{source: "salesLead", field: "openLead", operator: "is", value: true}]
                })
            })
            make("moqui.basic.email.EmailServer", {
                emailServerId: relay,
                smtpHost: "relay.mko.example.test",
                smtpPort: "9",
                webBaseUrl: "https://news.mko.example.test"
            })
            make("moqui.basic.email.EmailAccount", {
                emailAccountId: prefix + "_BOUNCES",
                accountKindEnumId: "EakHosted",
                emailAddress: "bounces@bounce.mko.example.test",
                statusId: "EasActive"
            })
            make("mantle.party.MessageSendingProfile", {
                sendingProfileId: profile,
                organizationPartyId: orgA,
                profileName: "Automation news",
                channelEnumId: "MdcEmail",
                emailServerId: relay,
                fromAddress: "news@mko.example.test",
                purposeEnumId: "MtpPromotional",
                trackingPolicyEnumId: "MtrNone",
                bounceDomain: "bounce.mko.example.test",
                fromDate: ago(30)
            })
        })
        ids.campaign = lib.campaign(users.author, orgA)
        system(() =>
            run("update#mantle.marketing.campaign.MarketingCampaign", {
                marketingCampaignId: ids.campaign,
                statusId: "MKTG_CAMP_APPROVED"
            })
        )
        const made = as(users.editor, M + "create#Template", {
            organizationPartyId: orgA,
            templateName: "Welcome letter",
            purposeEnumId: "MtpPromotional"
        })
        ids.template = made.messageTemplateId
        as(users.editor, M + "store#TemplateContent", {
            messageTemplateId: ids.template,
            expectedRevision: entityLib.ms(
                row("mantle.party.MessageTemplate", {messageTemplateId: ids.template}).lastUpdatedStamp
            ),
            subject: "Welcome, ${firstName}",
            body: "<p>Hello ${firstName}, welcome.</p>",
            bodyText: "Hello ${firstName}, welcome.",
            variables: [{name: "firstName", label: "First name", fallback: "friend"}]
        })
        const content = row("mantle.party.MessageTemplateContent", {messageTemplateId: ids.template, contentSeqId: "001"})
        as(users.editor, M + "publish#Template", {
            messageTemplateId: ids.template,
            expectedRevision: entityLib.ms(content.lastUpdatedStamp),
            reason: "Welcome"
        })
    },
    cleanupSpec() {
        settle()
        capture.reset()
    }
})

feature("an automation is approved and activated apart; a duplicate admission event enrolls once and step one goes once", {
    when() {
        const id = (ids.welcome = draft())
        const unapproved = activate(users.dispatcher, id)
        const selfApproval = as(users.author, C + "request#MarketingApproval", {
            targetKind: "automation",
            targetId: id,
            targetRevision: targetRevision(id)
        })
        const authorDecision = as(users.author, C + "decide#MarketingApproval", {
            targetKind: "automation",
            targetId: id,
            targetRevision: targetRevision(id),
            decision: "approve"
        })
        // the solo author's own automation is never self-approved, whatever the flag
        const soloId = as(users.solo, A + "create#Automation", {
            marketingCampaignId: ids.campaign,
            automationName: "Solo",
            contactListId: topic,
            sendingProfileId: profile
        }).marketingAutomationId
        as(users.solo, A + "store#Steps", {
            marketingAutomationId: soloId,
            expectedRevision: revisionOf(soloId),
            steps: [{kind: "send", messageTemplateId: ids.template}]
        })
        as(users.solo, C + "request#MarketingApproval", {
            targetKind: "automation",
            targetId: soloId,
            targetRevision: targetRevision(soloId)
        })
        const ownDecision = as(users.solo, C + "decide#MarketingApproval", {
            targetKind: "automation",
            targetId: soloId,
            targetRevision: targetRevision(soloId),
            decision: "approve"
        })
        as(users.approverDispatcher, C + "decide#MarketingApproval", {
            targetKind: "automation",
            targetId: id,
            targetRevision: targetRevision(id),
            decision: "approve"
        })
        const byApprover = activate(users.approverDispatcher, id)
        const byAuthor = activate(users.author, id)
        const byOtherOrganization = activate(users.dispatcherB, id)
        const activated = activate(users.dispatcher, id)
        const again = activate(users.dispatcher, id)
        // Hal subscribes after the activation (Ann was a member before it); the admission runs twice
        subscribe("Hal")
        const first = admit(id)
        const second = admit(id)
        capture.clear()
        const ran = steps(id)
        const hal = enrollmentOf(id, "Hal")
        return {
            unapproved,
            selfApproval,
            authorDecision,
            ownDecision,
            byApprover,
            byAuthor,
            byOtherOrganization,
            activated,
            again,
            first,
            second,
            ran,
            hal,
            annEnrollments: rows(ENROLLMENT, {marketingAutomationId: id, partyId: ids.Ann}).length,
            halEvents: rows(EVENT, {marketingAutomationId: id, partyId: ids.Hal}).length,
            halMail: mailTo("Hal"),
            halUnsubscribe: String((mailTo("Hal")[0]?.headers || {})["List-Unsubscribe"] || ""),
            halExecutions: executionsOf(hal.automationEnrollmentId)
        }
    },
    then(r) {
        r.unapproved.refusal.includes("STATUS_INVALID")
        r.selfApproval.refusal == ""
        r.authorDecision.refusal.includes("PERMISSION_DENIED")
        r.ownDecision.refusal.includes("SELF_APPROVAL")
        r.byApprover.refusal.includes("SELF_DISPATCH")
        r.byAuthor.refusal.includes("PERMISSION_DENIED")
        r.byOtherOrganization.refusal.includes("RECORD_UNAVAILABLE")
        r.activated.refusal == "" && r.activated.statusId == "MaActive"
        r.again.alreadyActive == true
        r.first.admitted == 1 && r.second.admitted == 0
        r.annEnrollments == 0
        r.halEvents == 1
        r.hal.statusId == "AenActive" && Number(r.hal.nextSequenceNum) == 20
        entityLib.ms(r.hal.nextDueDate) > Date.now() + 1.9 * dayMs
        r.ran.handedOff == 1
        r.halMail.length == 1
        String(r.halMail[0].subject) == "Welcome, Hal"
        r.halUnsubscribe.startsWith("<https://news.mko.example.test/")
        r.halExecutions
            .map(e => e.outcomeEnumId)
            .sort()
            .join(",") == "AsoHandedOff,AsoWaiting"
    }
})

feature("a completed send step is not replayed after a restart; a pause holds a due step and a resume sends it", {
    when() {
        const id = ids.welcome
        const hal = enrollmentOf(id, "Hal")
        // a run that read the enrollment before step one's commit comes back to it
        dueNow(hal.automationEnrollmentId, {nextSequenceNum: 10})
        capture.clear()
        steps(id)
        const replayMail = mailTo("Hal").length
        const afterRestart = enrollmentOf(id, "Hal")
        // the wait ends while the automation is paused: nothing goes; resumed, the follow-up goes once
        const wait = executionsOf(hal.automationEnrollmentId).find(e => e.outcomeEnumId === "AsoWaiting")
        system(() => run("update#" + EXECUTION, {automationStepExecutionId: wait.automationStepExecutionId, dueDate: ago(0.002)}))
        dueNow(hal.automationEnrollmentId)
        const paused = as(users.dispatcher, A + "pause#Automation", {marketingAutomationId: id, reason: "Checking the copy"})
        steps(id)
        const pausedMail = mailTo("Hal").length
        const resumed = activate(users.dispatcher, id)
        steps(id)
        return {
            replayMail,
            afterRestart,
            sendRows: executionsOf(hal.automationEnrollmentId).filter(e => e.outcomeEnumId === "AsoHandedOff").length,
            paused,
            pausedMail,
            resumed,
            followUp: mailTo("Hal").length,
            completed: enrollmentOf(id, "Hal")
        }
    },
    then(r) {
        r.replayMail == 0
        r.afterRestart.statusId == "AenActive" && Number(r.afterRestart.nextSequenceNum) == 20
        r.paused.refusal == "" && r.paused.statusId == "MaPaused"
        r.pausedMail == 0
        r.resumed.refusal == "" && r.resumed.resumed == true
        r.followUp == 1
        r.sendRows == 2
        r.completed.statusId == "AenCompleted" && r.completed.endReasonCode == "COMPLETED"
    }
})

feature("a withdrawal stops an enrollment; a channel's withdrawal skips only that channel's sends", {
    when() {
        const id = ids.welcome
        subscribe("Ivy")
        subscribe("Jon")
        admit(id)
        system(() => {
            // Ivy withdraws from the topic; Jon's address refuses solicitation (the email channel only)
            make("mantle.party.PartyConsent", {
                partyId: ids.Ivy,
                contactListId: topic,
                purposeEnumId: "PcpMarketingEmail",
                statusId: "PconWithdrawn",
                consentDate: new Date(),
                sourceEnumId: "PcsEmailLink"
            })
            const jon = row("mantle.party.contact.PartyContactMech", {partyId: ids.Jon, contactMechId: ids.Jon + "_EM"})
            run("update#mantle.party.contact.PartyContactMech", {
                partyId: ids.Jon,
                contactMechId: ids.Jon + "_EM",
                contactMechPurposeId: "EmailPrimary",
                fromDate: jon.fromDate,
                allowSolicitation: "N"
            })
        })
        capture.clear()
        steps(id)
        const jon = enrollmentOf(id, "Jon")
        return {
            ivy: enrollmentOf(id, "Ivy"),
            jon,
            jonSteps: executionsOf(jon.automationEnrollmentId)
                .map(e => e.outcomeEnumId + ":" + (e.reasonCode || ""))
                .sort(),
            ivyMail: mailTo("Ivy").length,
            jonMail: mailTo("Jon").length
        }
    },
    then(r) {
        r.ivy.statusId == "AenStopped" && r.ivy.endReasonCode == "LIST_WITHDRAWN"
        r.ivyMail == 0
        r.jon.statusId == "AenActive" && Number(r.jon.nextSequenceNum) == 20
        r.jonSteps.join(",") == "AsoSkipped:SOLICITATION_REFUSED,AsoWaiting:"
        r.jonMail == 0
    }
})

feature("a goal met ends an enrollment; a stopped enrollment does not resume; staff enroll with evidence", {
    when() {
        const id = (ids.staff = active({automationName: "Staff welcome", triggerEnumId: "AtrStaff"}))
        as(users.author, A + "store#EnrollmentRule", {
            marketingAutomationId: id,
            expectedRevision: revisionOf(id),
            goalSegmentId: prefix + "_GOAL"
        })
        approve(id)
        activate(users.dispatcher, id)
        const enroll = (username, name, key, evidenceText = "Asked at the spring fair") =>
            as(username, A + "enroll#Party", {marketingAutomationId: id, partyId: ids[name], evidenceText, operationKey: key})
        const byAuthor = enroll(users.author, "Kim", "k1")
        const noEvidence = enroll(users.audience, "Kim", "k1", "")
        const kim = enroll(users.audience, "Kim", "k1")
        const kimAgain = enroll(users.audience, "Kim", "k1")
        const lee = enroll(users.audience, "Lee", "l1")
        const leeEnrollment = enrollmentOf(id, "Lee")
        const stopped = as(users.audience, A + "stop#Enrollment", {
            automationEnrollmentId: leeEnrollment.automationEnrollmentId,
            reason: "Asked to leave"
        })
        capture.clear()
        steps(id)
        system(() => run(A + "process#EnrollmentStep", {automationEnrollmentId: leeEnrollment.automationEnrollmentId}))
        const stopAgain = as(users.audience, A + "stop#Enrollment", {
            automationEnrollmentId: leeEnrollment.automationEnrollmentId,
            reason: "Again"
        })
        const leeNewKey = enroll(users.audience, "Lee", "l2")
        return {
            byAuthor,
            noEvidence,
            kim,
            kimAgain,
            lee,
            stopped,
            stopAgain,
            leeNewKey,
            kimEnrollment: enrollmentOf(id, "Kim"),
            leeAfter: row(ENROLLMENT, {automationEnrollmentId: leeEnrollment.automationEnrollmentId}),
            leeSteps: executionsOf(leeEnrollment.automationEnrollmentId).length,
            mail: mailTo("Kim").length + mailTo("Lee").length
        }
    },
    then(r) {
        r.byAuthor.refusal.includes("PERMISSION_DENIED")
        r.noEvidence.refusal.includes("EVIDENCE_REQUIRED")
        r.kim.refusal == "" && r.kim.admitted == true
        r.kimAgain.alreadyFiled == true && r.kimAgain.automationEnrollmentId == r.kim.automationEnrollmentId
        r.lee.admitted == true
        r.stopped.refusal == "" && r.stopped.statusId == "AenStopped"
        r.kimEnrollment.statusId == "AenCompleted" && r.kimEnrollment.endReasonCode == "GOAL_MET"
        r.leeAfter.statusId == "AenStopped" && r.leeSteps == 0
        r.stopAgain.refusal.includes("STATUS_INVALID")
        r.leeNewKey.admitted == false && r.leeNewKey.reasonCode == "ALREADY_ENROLLED"
        r.mail == 0
    }
})

feature("a day wait across a daylight-saving gap lands on the next valid instant; business days skip the weekend; scope", {
    when() {
        const id = draft({automationName: "Zoned", timeZone: "America/New_York"}, [
            {kind: "send", messageTemplateId: ids.template},
            {kind: "wait", waitAmount: 1, waitUnitEnumId: "AwuDays"},
            {kind: "send", messageTemplateId: ids.template},
            {kind: "wait", waitAmount: 1, waitUnitEnumId: "AwuBusinessDays"},
            {kind: "send", messageTemplateId: ids.template}
        ])
        // Saturday 7 March 2026, 02:30 in New York (EST): the next day's 02:30 does not exist
        const gap = as(users.author, A + "preview#Automation", {
            marketingAutomationId: id,
            startDate: new Date(Date.UTC(2026, 2, 7, 7, 30))
        })
        // Friday 13 March 2026, 10:00 EDT: one business day is Monday's 10:00
        const weekend = as(users.author, A + "preview#Automation", {
            marketingAutomationId: id,
            startDate: new Date(Date.UTC(2026, 2, 12, 14, 0))
        })
        const salesGoal = as(users.author, A + "store#EnrollmentRule", {
            marketingAutomationId: id,
            expectedRevision: revisionOf(id),
            goalSegmentId: prefix + "_SALES"
        })
        return {
            gapWait: gap.stepList[1],
            weekendWait: weekend.stepList[3],
            weekendDay: weekend.stepList[1],
            salesGoal,
            otherOrganization: as(users.dispatcherB, A + "get#Automation", {marketingAutomationId: id}),
            readerFind: as(users.reader, A + "find#Automations", {}),
            readerStore: as(users.reader, A + "store#Steps", {
                marketingAutomationId: id,
                expectedRevision: revisionOf(id),
                steps: []
            }),
            mine: as(users.author, A + "find#Automations", {}).automationList.map(a => a.marketingAutomationId)
        }
    },
    then(r) {
        r.gapWait.dueMillis == Date.UTC(2026, 2, 8, 7, 0)
        r.gapWait.dueText.startsWith("2026-03-08 03:00 -04:00")
        r.weekendDay.dueMillis == Date.UTC(2026, 2, 13, 14, 0)
        r.weekendWait.dueMillis == Date.UTC(2026, 2, 16, 14, 0)
        r.salesGoal.refusal == ""
        r.otherOrganization.refusal.includes("RECORD_UNAVAILABLE")
        r.readerFind.refusal.includes("PERMISSION_DENIED")
        r.readerStore.refusal.includes("PERMISSION_DENIED")
        r.mine.includes(ids.welcome)
    }
})

feature("an order placed files its admission event once, and its customer is enrolled", {
    when() {
        const id = active({automationName: "Thank you", triggerEnumId: "AtrOrderPlaced"}, [
            {kind: "send", stepName: "Thanks", messageTemplateId: ids.template}
        ])
        system(() => {
            make("mantle.order.OrderHeader", {orderId: prefix + "_ORD", statusId: "OrderPlaced", placedDate: ago(0.001)})
            make("mantle.order.OrderPart", {
                orderId: prefix + "_ORD",
                orderPartSeqId: "01",
                vendorPartyId: orgA,
                customerPartyId: ids.Mia
            })
        })
        const first = system(() => run("mantle.marketing.TrackingServices.handle#OrderPlaced", {orderId: prefix + "_ORD"}))
        const again = system(() => run("mantle.marketing.TrackingServices.handle#OrderPlaced", {orderId: prefix + "_ORD"}))
        admit(id)
        capture.clear()
        steps(id)
        return {first, again, mia: enrollmentOf(id, "Mia"), mail: mailTo("Mia").length}
    },
    then(r) {
        r.first.filedCount == 1 && r.again.filedCount == 0
        r.mia.statusId == "AenCompleted" && r.mia.sourceKey == "order:" + prefix + "_ORD"
        r.mail == 1
    }
})

feature(
    "an automation runs as its owner: a Sales lead segment admits under an owner with Sales access; losing it pauses the run",
    {
        when() {
            const id = draft({automationName: "Leads", triggerEnumId: "AtrSegment", triggerSegmentId: prefix + "_SALES"}, [
                {kind: "send", stepName: "Hello", messageTemplateId: ids.template}
            ])
            approve(id)
            // the activator becomes its owner: a dispatcher who cannot read Sales could not run it
            const withoutSales = activate(users.dispatcher, id)
            const activated = activate(users.salesDispatcher, id)
            admit(id) // the baseline: no open lead yet
            system(() => {
                make("mantle.sales.opportunity.SalesOpportunity", {
                    salesOpportunityId: prefix + "_LEAD",
                    opportunityName: "Nia's lead",
                    organizationPartyId: orgA,
                    typeEnumId: "SotLead",
                    statusId: "SalesOppOpen"
                })
                make("mantle.sales.opportunity.SalesOpportunityParty", {
                    salesOpportunityId: prefix + "_LEAD",
                    partyId: ids.Nia,
                    roleTypeId: "Contact",
                    fromDate: ago(0.01)
                })
            })
            const admitted = admit(id)
            const nia = enrollmentOf(id, "Nia")
            // the owner loses the Sales read: the next run pauses the automation with the reason, and nothing is sent
            system(() => {
                for (const userPermissionId of ["SALES_VIEW", "SALES_TEAM_VIEW"])
                    run("update#moqui.security.UserGroupPermission", {
                        userGroupId: users.salesDispatcher,
                        userPermissionId,
                        fromDate: 0,
                        thruDate: ago(0.001)
                    })
            })
            capture.clear()
            steps(id)
            return {
                withoutSales,
                activated,
                admitted,
                nia,
                owner: row(AUTOMATION, {marketingAutomationId: id}).activatedByUserId,
                after: row(AUTOMATION, {marketingAutomationId: id}),
                niaAfter: nia ? row(ENROLLMENT, {automationEnrollmentId: nia.automationEnrollmentId}) : null,
                niaSteps: nia ? executionsOf(nia.automationEnrollmentId).length : -1,
                mail: mailTo("Nia").length,
                signedInAfter: ec.user.username
            }
        },
        then(r) {
            r.withoutSales.refusal.includes("NOT_READY") && r.withoutSales.refusal.includes("Sales leads")
            r.activated.refusal == "" && r.owner == users.salesDispatcher
            r.admitted.admitted == 1
            r.nia != null && r.nia.triggerEnumId == "AtrSegment"
            r.after.statusId == "MaPaused" && r.after.pauseNote.includes("cannot read segment Open leads")
            r.niaAfter.statusId == "AenActive" && r.niaSteps == 0
            r.mail == 0
            r.signedInAfter != users.salesDispatcher
        }
    }
)

// P18 (the user's call, Nov 15): the registration and attendance triggers on an event offer of the organization
feature("a confirmed registration and its attendance each file one admission event; another organization's offer is refused", {
    when() {
        const offerOf = (key, organizationPartyId) => {
            const workEffortId = prefix + "_EV_" + key
            make("mantle.work.effort.WorkEffort", {
                workEffortId,
                workEffortTypeEnumId: "WetEvent",
                workEffortName: "Automation event " + key,
                statusId: "WeInPlanning",
                estimatedStartDate: ago(-2),
                estimatedCompletionDate: ago(-2.1)
            })
            make("mantle.work.registration.RegistrationEvent", {workEffortId, organizationPartyId, createdDate: new Date()})
            const registrationPolicyId = prefix + "_OFFER_" + key
            make("mantle.work.registration.EventRegistrationPolicy", {
                registrationPolicyId,
                workEffortId,
                organizationPartyId,
                occurrenceStart: ago(-2),
                occurrenceEnd: ago(-2.1),
                statusId: "ErpPublished",
                publicTitle: "Automation offer " + key
            })
            return registrationPolicyId
        }
        const offers = system(() => ({a: offerOf("A", orgA), b: offerOf("B", orgB)}))
        const refused = as(users.author, A + "create#Automation", {
            marketingCampaignId: ids.campaign,
            automationName: "Other organization's event",
            contactListId: topic,
            sendingProfileId: profile,
            triggerEnumId: "AtrRegistered",
            registrationPolicyId: offers.b
        })
        const oneStep = [{kind: "send", stepName: "Thanks for coming", messageTemplateId: ids.template}]
        const registered = active(
            {automationName: "After registering", triggerEnumId: "AtrRegistered", registrationPolicyId: offers.a},
            oneStep
        )
        const attended = active(
            {automationName: "After attending", triggerEnumId: "AtrAttended", registrationPolicyId: offers.a},
            oneStep
        )
        // Kim's place confirmed and checked in after the activations; a waitlisted place files nothing
        const registrationId = prefix + "_REG_KIM"
        system(() => {
            make("mantle.work.registration.EventRegistration", {
                registrationId,
                registrationPolicyId: offers.a,
                attendeePartyId: ids.Kim,
                buyerPartyId: ids.Kim,
                statusId: "EvrConfirmed",
                confirmedDate: new Date(),
                createdDate: new Date()
            })
            make("mantle.work.registration.EventRegistration", {
                registrationId: prefix + "_REG_LEE",
                registrationPolicyId: offers.a,
                attendeePartyId: ids.Lee,
                statusId: "EvrWaitlisted",
                createdDate: new Date()
            })
            make("mantle.work.registration.EventAttendance", {
                registrationId,
                registrationPolicyId: offers.a,
                organizationPartyId: orgA,
                attendeePartyId: ids.Kim,
                methodEnumId: "EamCode",
                checkInDate: new Date()
            })
        })
        for (const id of [registered, attended, registered, attended]) admit(id)
        return {
            refused,
            registeredEvents: rows(EVENT, {marketingAutomationId: registered}),
            attendedEvents: rows(EVENT, {marketingAutomationId: attended}),
            registeredKim: enrollmentOf(registered, "Kim"),
            attendedKim: enrollmentOf(attended, "Kim"),
            offer: row(AUTOMATION, {marketingAutomationId: registered}).registrationPolicyId == offers.a,
            registrationId
        }
    },
    then(r) {
        r.refused.refusal.includes("RECORD_UNAVAILABLE")
        r.registeredEvents.length == 1 && r.registeredEvents[0].sourceKey == "registered:" + r.registrationId
        r.attendedEvents.length == 1 && r.attendedEvents[0].sourceKey == "attended:" + r.registrationId
        r.registeredKim != null && r.registeredKim.triggerEnumId == "AtrRegistered"
        r.attendedKim != null && r.attendedKim.triggerEnumId == "AtrAttended"
        r.offer
    }
})
