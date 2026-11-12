// People's reviews and goals (mantle.humanres.ReviewServices: store#ReviewTemplate, store#Cycle, start#Cycle, find#Reviews,
// get#Review, store#Assessment, submit#Feedback, change#ReviewState with the PeopleReviewStep handlers, store#ReviewNote,
// get#ReviewRelease, check#ReviewAccess, find#Goals, store#Goal; impl-people P20, design-people §11, §15, PE-16): a template and a
// cycle are a development editor's; starting makes one review per person, each on its own, the person with no manager named; each
// step is answered once (the reviewer's on the review form) and locked; feedback is asked and read by who asked; a private note is
// its author's alone: absent from the person's answer before and after release, from the release, the notices and a new
// reviewer's answer; finalizing waits for HR's approval (a refusal returns the assessment), the release is stored once and the
// person acknowledges it; a leaver's waiting steps are routed again with People's decisions; a goal is in no task list.
// Standalone: spec-local organizations, people, employments, a review form, groups and users, with artifact authorization disabled
// (the rules are the services' own checks).
// Run: ./moq test mr-mantle --spec Reviews
const prefix = "PEOPLE_REV_SPEC"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    since = "2001-01-01T00:00:00Z"
const R = "mantle.humanres.ReviewServices."
const REVIEW = "mantle.humanres.ability.PerformanceReview"
const state = {}

function run(username, service, parameters = {}) {
    login(username)
    ec.artifactExecution.disableAuthz()
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(service).parameters(parameters).requireNewTransaction(true).call() || {}
        return Object.assign({}, out, {error: ec.message.hasError() ? ec.message.getErrorsString() : ""})
    } catch (error) {
        return {error: String(error.message || error)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}
const code = out => (out.error ? /[A-Z][A-Z0-9_]{3,}(?=:)/.exec(out.error)?.[0] || out.error : "")
const read = (entity, conditions) => Array.from(ec.entity.find(entity).condition(conditions).disableAuthz().list())
function organization(partyId, name) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
// a person employed by (or an agent of) the organization, with an account holding the permissions
function user(kind, organizationPartyId, permissions, agent = false) {
    const partyId = prefix + "_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Rev", lastName: kind})
    if (agent)
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtAgent",
            fromPartyId: partyId,
            toPartyId: organizationPartyId,
            fromDate: since
        })
    else
        call("mantle.humanres.EmploymentServices.create#Employment", {
            fromPartyId: partyId,
            toPartyId: organizationPartyId,
            fromDate: since
        })
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Review " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    call("create#moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA"
    })
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: since})
    return {userId: id, partyId}
}
const manages = (manager, report) =>
    call("create#mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtManager",
        fromPartyId: manager.partyId,
        toPartyId: report.partyId,
        fromDate: since
    })
const reviewOf = partyId => read(REVIEW, {reviewCycleId: state.cycleId, partyId})[0]
// the text of every notice of the spec's reviews (titles and messages), to find what must not be in them
function noticeText() {
    const reviewIds = read(REVIEW, {reviewCycleId: state.cycleId}).map(row => row.performanceReviewId)
    return Array.from(
        ec.entity
            .find("moqui.security.user.NotificationMessage")
            .condition("topic", "in", ["PeopleReviewUpdate", "PeopleReviewStep"])
            .condition("recordId", "in", reviewIds)
            .disableAuthz()
            .list()
    )
        .map(row => String(row.messageJson || "") + " " + String(row.titleText || ""))
        .join(" | ")
}
const anaNote = "Ana was late to two stocktakes"
const boNote = "Bo asked about a transfer"

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(orgA, "Review Spec A")
        organization(orgB, "Review Spec B")
        const self = ["PEOPLE_SELF_SERVICE"]
        const manager = ["PEOPLE_SELF_SERVICE", "PEOPLE_TEAM_VIEW", "PEOPLE_REQUEST_APPROVE"]
        state.ana = user("ANA", orgA, self)
        state.bo = user("BO", orgA, self)
        state.cy = user("CY", orgA, self)
        state.max = user("MAX", orgA, manager)
        state.nia = user("NIA", orgA, manager)
        state.dev = user("DEV", orgA, ["PEOPLE_DEVELOP_VIEW", "PEOPLE_DEVELOP_EDIT"], true)
        state.devB = user("DEVB", orgB, ["PEOPLE_DEVELOP_VIEW", "PEOPLE_DEVELOP_EDIT"], true)
        state.hr = user("HR", orgA, ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT", "PEOPLE_REQUEST_APPROVE"], true)
        // Max manages Ana and Bo, Nia manages Max; Cy and Nia have no manager
        manages(state.max, state.ana)
        manages(state.max, state.bo)
        manages(state.nia, state.max)
        // the employer's published review form, built by the development editor (the review purpose admits PEOPLE_DEVELOP_EDIT)
        const F = "mantle.party.FormDefinitionServices."
        state.formId = run(state.dev.userId, F + "create#Form", {
            purposeEnumId: "DbfpReview",
            organizationPartyId: orgA,
            description: "Review spec assessment"
        }).formId
        run(state.dev.userId, F + "save#FormField", {
            formId: state.formId,
            newFieldName: "goalsMet",
            title: "Goals met",
            fieldTypeEnumId: "DBFFT_radio",
            isRequired: "Y",
            optionText: "1 | Not yet\n2 | Met"
        })
        run(state.dev.userId, F + "save#FormField", {
            formId: state.formId,
            newFieldName: "strengths",
            title: "Strengths",
            fieldTypeEnumId: "DBFFT_text-area"
        })
        run(state.dev.userId, F + "publish#Form", {formId: state.formId})
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature("a template and a cycle are a development editor's; a start makes one review per person, the one with no manager named", {
    when() {
        const template = parameters =>
            run(state.dev.userId, R + "store#ReviewTemplate", Object.assign({organizationPartyId: orgA}, parameters))
        const out = {
            notEditor: code(run(state.ana.userId, R + "store#ReviewTemplate", {organizationPartyId: orgA, templateName: "Mine"})),
            otherEmployer: code(
                run(state.devB.userId, R + "store#ReviewTemplate", {organizationPartyId: orgA, templateName: "Theirs"})
            ),
            badForm: code(template({templateName: "Wrong form", managerFormId: "NOT_A_FORM"}))
        }
        const made = template({
            templateName: "Review spec annual",
            selfAssessment: "Y",
            feedbackAllowed: "Y",
            approvalRequired: "Y",
            managerFormId: state.formId
        })
        state.templateId = made.reviewTemplateId
        out.template = code(made)
        const cycle = parameters =>
            run(
                state.dev.userId,
                R + "store#Cycle",
                Object.assign(
                    {
                        organizationPartyId: orgA,
                        cycleName: "Review spec 2026",
                        reviewTemplateId: state.templateId,
                        periodFromDate: "2026-01-01",
                        periodThruDate: "2026-12-31",
                        selfDueDate: "2027-01-15",
                        managerDueDate: "2027-01-31"
                    },
                    parameters
                )
            )
        out.badDates = code(cycle({periodThruDate: "2025-12-31"}))
        out.otherCycle = code(run(state.devB.userId, R + "store#Cycle", {organizationPartyId: orgA, cycleName: "Theirs"}))
        const stored = cycle({})
        state.cycleId = stored.reviewCycleId
        out.cycle = code(stored)
        out.preview = run(state.dev.userId, R + "start#Cycle", {reviewCycleId: state.cycleId, preview: true})
        out.reviewsAfterPreview = read(REVIEW, {reviewCycleId: state.cycleId}).length
        out.notStarter = code(run(state.max.userId, R + "start#Cycle", {reviewCycleId: state.cycleId}))
        out.started = run(state.dev.userId, R + "start#Cycle", {reviewCycleId: state.cycleId})
        out.again = run(state.dev.userId, R + "start#Cycle", {reviewCycleId: state.cycleId})
        out.changeStarted = code(run(state.dev.userId, R + "store#Cycle", {reviewCycleId: state.cycleId, cycleName: "Renamed"}))
        out.templateInUse = code(template({reviewTemplateId: state.templateId, templateName: "Renamed"}))
        out.cycles = run(state.dev.userId, R + "find#Cycles", {})
        out.cyclesB = run(state.devB.userId, R + "find#Cycles", {})
        out.anaTodo = run(state.ana.userId, R + "find#Reviews", {})
        out.maxTodo = run(state.max.userId, R + "find#Reviews", {})
        out.noticeToAna = read("moqui.security.user.NotificationMessageByUser", {
            userId: state.ana.userId,
            topic: "PeopleReviewUpdate"
        }).length
        return out
    },
    then(out) {
        out.notEditor == "PERMISSION_DENIED" && out.otherEmployer == "ORGANIZATION_DENIED" && out.badForm == "FORM_UNAVAILABLE"
        out.template == "" && out.badDates == "DATES_INVALID" && out.otherCycle == "ORGANIZATION_DENIED" && out.cycle == ""
        out.preview.participants.length == 5 && out.reviewsAfterPreview == 0
        out.preview.participants.find(row => row.partyId == state.ana.partyId).managerPartyId == state.max.partyId
        out.preview.participants.find(row => row.partyId == state.cy.partyId).problem != ""
        out.notStarter == "PERMISSION_DENIED"
        out.started.startedCount == 3 && out.started.failedCount == 2
        out.started.failures.every(row => row.code == "NO_REVIEWER") &&
            out.started.failures.some(row => row.personName.includes("CY"))
        out.again.startedCount == 0 && out.again.failedCount == 2
        out.changeStarted == "CYCLE_STARTED" && out.templateInUse == "TEMPLATE_IN_USE"
        out.cycles.cycles[0].reviewCount == 3 &&
            out.cycles.cycles[0].statusEnumId == "RcsActive" &&
            out.cyclesB.cycles.length == 0
        out.anaTodo.reviews.length == 1 && out.anaTodo.reviews[0].todoText == "Your self assessment"
        // Max assesses Ana and Bo, and his own review asks his self assessment
        out.maxTodo.reviews.length == 3 && out.maxTodo.reviews.filter(row => row.todoText == "Assess").length == 2
        out.noticeToAna == 1
    }
})

feature("each step is answered once and locked; feedback is read by who asked; a private note is its author's alone", {
    when() {
        state.anaReview = reviewOf(state.ana.partyId).performanceReviewId
        state.boReview = reviewOf(state.bo.partyId).performanceReviewId
        const id = {performanceReviewId: state.anaReview}
        const out = {
            self: run(state.ana.userId, R + "store#Assessment", Object.assign({summary: "I ran the spring stocktake"}, id)),
            selfAgain: code(run(state.ana.userId, R + "store#Assessment", Object.assign({summary: "Again"}, id))),
            notHers: code(run(state.bo.userId, R + "store#Assessment", Object.assign({summary: "Hers"}, id))),
            noteByAna: code(run(state.ana.userId, R + "store#ReviewNote", Object.assign({noteText: "Mine"}, id))),
            note: run(state.max.userId, R + "store#ReviewNote", Object.assign({noteText: anaNote}, id)),
            askByAna: code(
                run(
                    state.ana.userId,
                    R + "change#ReviewState",
                    Object.assign({action: "requestFeedback", partyId: state.bo.partyId}, id)
                )
            ),
            askSelf: code(
                run(
                    state.max.userId,
                    R + "change#ReviewState",
                    Object.assign({action: "requestFeedback", partyId: state.ana.partyId}, id)
                )
            ),
            ask: run(
                state.max.userId,
                R + "change#ReviewState",
                Object.assign({action: "requestFeedback", partyId: state.bo.partyId}, id)
            ),
            askAgain: code(
                run(
                    state.max.userId,
                    R + "change#ReviewState",
                    Object.assign({action: "requestFeedback", partyId: state.bo.partyId}, id)
                )
            )
        }
        out.feedback = run(state.bo.userId, R + "submit#Feedback", Object.assign({summary: "Ana helps new starters"}, id))
        out.noValues = code(run(state.max.userId, R + "store#Assessment", Object.assign({summary: "Good year"}, id)))
        out.badValues = code(
            run(state.max.userId, R + "store#Assessment", Object.assign({values: {goalsMet: "7"}, summary: "Good"}, id))
        )
        out.badRating = code(
            run(
                state.max.userId,
                R + "store#Assessment",
                Object.assign({values: {goalsMet: "2"}, summary: "Good", ratingEnumId: "PrfRtNope"}, id)
            )
        )
        out.manager = run(
            state.max.userId,
            R + "store#Assessment",
            Object.assign(
                {
                    values: {goalsMet: "2", strengths: "Calm on busy days"},
                    summary: "A good year",
                    ratingEnumId: "PrfRtFreqExceed"
                },
                id
            )
        )
        out.anaView = run(state.ana.userId, R + "get#Review", id)
        out.boView = run(state.bo.userId, R + "get#Review", id)
        out.maxView = run(state.max.userId, R + "get#Review", id)
        out.devView = run(state.dev.userId, R + "get#Review", id)
        out.devBView = code(run(state.devB.userId, R + "get#Review", id))
        out.cyView = code(run(state.cy.userId, R + "get#Review", id))
        out.invitation = read("mantle.party.FormInvitation", {
            recordEntityName: "mantle.humanres.ability.PerformanceReviewStep"
        }).length
        return out
    },
    then(out) {
        out.self.statusEnumId == "RssSubmitted" && out.selfAgain == "ALREADY_SUBMITTED" && out.notHers == "RECORD_UNAVAILABLE"
        out.noteByAna == "PERMISSION_DENIED" && out.note.performanceNoteId && out.note.error == ""
        out.askByAna == "PERMISSION_DENIED" &&
            out.askSelf == "PARTY_INVALID" &&
            out.ask.error == "" &&
            out.askAgain == "ALREADY_ASKED"
        out.feedback.statusEnumId == "RssSubmitted"
        out.noValues == "ASSESSMENT_REQUIRED" && out.badValues == "FORM_VALUES_INVALID" && out.badRating == "VALUE_INVALID"
        out.manager.statusEnumId == "RssSubmitted" && out.invitation == 1
        // the person: her own self assessment, the reviewer's assessment's state only, no feedback, no rating, no note
        out.anaView.isSelf && out.anaView.notes.length == 0 && out.anaView.review.ratingText == ""
        out.anaView.steps.length == 2 && out.anaView.steps[0].summary == "I ran the spring stocktake"
        out.anaView.steps[1].statusEnumId == "RssSubmitted" &&
            out.anaView.steps[1].summary == null &&
            out.anaView.steps[1].answers.length == 0
        !JSON.stringify(out.anaView).includes(anaNote) && !JSON.stringify(out.anaView).includes("A good year")
        // the giver: their own feedback alone
        out.boView.steps.length == 1 && out.boView.steps[0].summary == "Ana helps new starters"
        // the reviewer: every step with the form's answers, the rating, their own note
        out.maxView.steps.length == 3 &&
            out.maxView.review.ratingText == "Frequently exceeds" &&
            out.maxView.notes[0].noteText == anaNote
        out.maxView.steps[1].answersText.includes("Goals met: Met")
        // development: every step, no note (not theirs); another employer and a colleague not asked: not available
        out.devView.steps.length == 3 && out.devView.notes.length == 0 && !JSON.stringify(out.devView).includes(anaNote)
        out.devBView == "RECORD_UNAVAILABLE" && out.cyView == "RECORD_UNAVAILABLE"
    }
})

feature(
    "finalizing waits for HR's approval, a refusal returns it; the release is stored once without the notes; the person acknowledges",
    {
        when() {
            const id = {performanceReviewId: state.anaReview}
            const act = (who, action, extra = {}) => run(who.userId, R + "change#ReviewState", Object.assign({action}, id, extra))
            const out = {earlyRelease: code(act(state.max, "release")), finalize: act(state.max, "finalize")}
            out.selfDecides = code(act(state.max, "approve"))
            out.anaDecides = code(act(state.ana, "approve"))
            const notice = () =>
                Array.from(
                    ec.entity
                        .find("moqui.security.user.NotificationMessage")
                        .condition({topic: "PeopleReviewStep", recordId: state.anaReview})
                        .orderBy("-sentDate")
                        .disableAuthz()
                        .list()
                ).map(row => JSON.parse(String(row.messageJson || "{}")))[0]
            // P20 review: the review's reviewer never decides its approval, though they became the reviewer after it was asked
            const reassign = (partyId, reason) =>
                run(state.dev.userId, R + "change#ReviewState", Object.assign({action: "reassign", partyId, reason}, id))
            out.toHr = reassign(state.hr.partyId, "HR covers")
            out.reviewerDecides = code(
                run(state.hr.userId, R + "approve#ReviewStep", {
                    recordEntityName: REVIEW,
                    recordId: state.anaReview,
                    message: notice()
                })
            )
            out.toMax = reassign(state.max.partyId, "Max is back")
            // P20 review: no note is filed on a review before release (it would reach the person then)
            const event = () =>
                call("create#mantle.party.communication.CommunicationEvent", {
                    communicationEventTypeId: "Comment",
                    statusId: "CeSent",
                    fromPartyId: state.max.partyId,
                    subject: "Between us",
                    body: "Ana's numbers look soft",
                    entryDate: ec.user.nowTimestamp
                }).communicationEventId
            const fileNote = () =>
                run(state.max.userId, "mantle.party.CommunicationServices.link#CommunicationEventRecord", {
                    communicationEventId: event(),
                    recordEntityName: REVIEW,
                    recordId: state.anaReview
                })
            out.noteBefore = code(fileNote())
            const first = notice()
            out.noticeTitle = first?.subjectText || ""
            out.refused = run(state.hr.userId, R + "refuse#ReviewStep", {
                recordEntityName: REVIEW,
                recordId: state.anaReview,
                message: first,
                reason: "Say more about the stocktakes"
            })
            out.afterRefusal = run(state.max.userId, R + "get#Review", id)
            out.reassess = run(
                state.max.userId,
                R + "store#Assessment",
                Object.assign(
                    {values: {goalsMet: "2"}, summary: "A good year; the stocktakes ran clean", ratingEnumId: "PrfRtFreqExceed"},
                    id
                )
            )
            out.finalizeAgain = act(state.max, "finalize")
            out.approved = run(state.hr.userId, R + "approve#ReviewStep", {
                recordEntityName: REVIEW,
                recordId: state.anaReview,
                message: notice()
            })
            out.beforeRelease = run(state.ana.userId, R + "get#Review", id)
            out.anaRelease = code(act(state.ana, "release"))
            out.released = act(state.max, "release")
            out.releasedAgain = code(act(state.max, "release"))
            out.release = run(state.ana.userId, R + "get#ReviewRelease", id)
            out.boRelease = code(run(state.bo.userId, R + "get#ReviewRelease", id))
            out.afterRelease = run(state.ana.userId, R + "get#Review", id)
            out.noteAfterRelease = fileNote()
            out.confidential = run("john.doe", "mantle.party.CommunicationServices.check#ConfidentialRecordType", {
                recordEntityName: REVIEW
            }).confidential
            out.noteAfter = code(run(state.max.userId, R + "store#ReviewNote", Object.assign({noteText: "Too late"}, id)))
            out.files = run(state.ana.userId, R + "check#ReviewAccess", id)
            out.boFiles = run(state.bo.userId, R + "check#ReviewAccess", id)
            out.recordLink = run(state.ana.userId, "mantle.party.CommunicationServices.get#RecordLinkInfo", {
                recordEntityName: REVIEW,
                recordId: state.anaReview
            })
            out.acknowledged = act(state.ana, "acknowledge", {comment: "Thanks"})
            out.notices = noticeText()
            return out
        },
        then(out) {
            out.earlyRelease == "REVIEW_CLOSED" && out.finalize.statusEnumId == "PrvApproval"
            out.selfDecides == "SELF_APPROVAL" && out.anaDecides == "PERMISSION_DENIED"
            out.toHr.error == "" && out.reviewerDecides == "SELF_APPROVAL" && out.toMax.error == ""
            out.noteBefore == "REVIEW_NOT_RELEASED"
            !out.noticeTitle.includes("Rev ANA") &&
                out.noticeTitle.includes("Review spec 2026") &&
                out.refused.statusEnumId == "PrvInProgress"
            out.afterRefusal.steps.find(row => row.stepKindEnumId == "RskManager").returnReason == "Say more about the stocktakes"
            out.reassess.statusEnumId == "RssSubmitted" && out.finalizeAgain.statusEnumId == "PrvApproval"
            out.approved.statusEnumId == "PrvFinalized"
            out.beforeRelease.review.ratingText == "" && out.beforeRelease.steps[1].summary == null
            out.anaRelease == "PERMISSION_DENIED" &&
                out.released.statusEnumId == "PrvReleased" &&
                out.releasedAgain == "REVIEW_CLOSED"
            // the release: the reviewer's assessment and rating, never the note or the feedback (the template keeps it the reviewer's)
            out.release.printHtml.includes("the stocktakes ran clean") && out.release.printHtml.includes("Frequently exceeds")
            !out.release.printHtml.includes(anaNote) && !out.release.printHtml.includes("Ana helps new starters")
            out.boRelease == "RECORD_UNAVAILABLE"
            // after release the person reads the assessment and rating, still no note and no feedback
            out.afterRelease.review.ratingText == "Frequently exceeds" && out.afterRelease.steps.length == 2
            out.afterRelease.steps[1].summary.includes("ran clean") && out.afterRelease.notes.length == 0
            !JSON.stringify(out.afterRelease).includes(anaNote) && !JSON.stringify(out.afterRelease).includes("new starters")
            // nor the approval's decisions or the refusal's reason, which were the reviewer's and HR's
            out.afterRelease.approval == null && out.afterRelease.steps.every(row => row.returnReason == "")
            !JSON.stringify(out.afterRelease).includes("Say more about the stocktakes")
            // once released a note is filed, and its notices are their named recipients' alone (ConfidentialRecordType)
            out.noteAfterRelease.error == "" && out.confidential == true
            out.noteAfter == "REVIEW_CLOSED" && out.files.recordVisible && !out.files.canEdit && !out.boFiles.recordVisible
            out.recordLink.recordVisible && out.acknowledged.statusEnumId == "PrvAcknowledged"
            // no notice holds a note, a summary or a rating
            out.notices.length > 0 &&
                !out.notices.includes(anaNote) &&
                !out.notices.includes("ran clean") &&
                !out.notices.includes("exceeds")
        }
    }
)

feature("a new reviewer reads no earlier reviewer's note; a leaver's steps are routed again; a goal is in no task list", {
    when() {
        const id = {performanceReviewId: state.boReview}
        const out = {note: code(run(state.max.userId, R + "store#ReviewNote", Object.assign({noteText: boNote}, id)))}
        // Max asks Cy and Ana for feedback on Bo's review; Cy gives it, Ana's waits
        const ask = partyId =>
            run(state.max.userId, R + "change#ReviewState", Object.assign({action: "requestFeedback", partyId}, id))
        ask(state.cy.partyId)
        ask(state.ana.partyId)
        out.cyFeedback = run(state.cy.userId, R + "submit#Feedback", Object.assign({summary: "Bo keeps the stockroom tidy"}, id))
        // the instance administrator subscribed to every review notice, as Tools offers: a review notice is its recipients' alone
        const subscription = {topic: "PeopleReviewUpdate", userId: "EX_JOHN_DOE"}
        ec.entity
            .makeValue("moqui.security.user.NotificationTopicUser")
            .setAll(subscription)
            .set("allNotifications", "Y")
            .create()
        out.reassignByMax = code(
            run(
                state.max.userId,
                R + "change#ReviewState",
                Object.assign({action: "reassign", partyId: state.nia.partyId, reason: "Cover"}, id)
            )
        )
        out.reassign = run(
            state.dev.userId,
            R + "change#ReviewState",
            Object.assign({action: "reassign", partyId: state.nia.partyId, reason: "Max is away"}, id)
        )
        ec.entity.find("moqui.security.user.NotificationTopicUser").condition(subscription).deleteAll()
        out.subscriberTold = read("moqui.security.user.NotificationMessageByUser", {
            userId: "EX_JOHN_DOE",
            topic: "PeopleReviewUpdate"
        }).length
        out.niaTold = read("moqui.security.user.NotificationMessageByUser", {
            userId: state.nia.userId,
            topic: "PeopleReviewUpdate"
        }).length
        out.niaView = run(state.nia.userId, R + "get#Review", id)
        // the feedback Max asked for is the review's: Nia withdraws the one still waiting
        const anaStep = out.niaView.steps.find(row => row.stepKindEnumId == "RskFeedback" && row.partyId == state.ana.partyId)
        out.niaWithdraws = run(
            state.nia.userId,
            R + "change#ReviewState",
            Object.assign(
                {action: "cancelFeedback", performanceReviewStepId: anaStep?.performanceReviewStepId, reason: "Not needed"},
                id
            )
        )
        out.maxView = code(run(state.max.userId, R + "get#Review", id))
        out.niaOwned = run(state.nia.userId, "mantle.humanres.PeopleApprovalServices.find#OwnedApprovals", {
            userId: state.nia.userId
        })
        // Nia leaves Retail: People's decisions and her reviews are routed again (P6's separation calls the same re-route)
        const employment = read("mantle.party.PartyRelationship", {
            fromPartyId: state.nia.partyId,
            toPartyId: orgA,
            relationshipTypeEnumId: "PrtEmployee"
        })[0]
        call("update#mantle.party.PartyRelationship", {
            partyRelationshipId: employment.partyRelationshipId,
            thruDate: new Date(Date.now() - 60000)
        })
        ec.resource.script("component://mr-mantle/service/mantle/humanres/Approvals.js").reroute(orgA)
        out.boAfter = read(REVIEW, {performanceReviewId: state.boReview})[0]
        out.boManagerStep = read("mantle.humanres.ability.PerformanceReviewStep", {
            performanceReviewId: state.boReview,
            stepKindEnumId: "RskManager"
        })[0]
        out.maxReview = reviewOf(state.max.partyId)
        out.maxBack = run(state.max.userId, R + "get#Review", id)
        // goals: Ana's own, and one Max sets for her under it; a colleague neither reads nor sets them
        out.own = run(state.ana.userId, R + "store#Goal", {
            title: "Cut stock errors",
            measureText: "Count errors",
            targetValue: "2",
            unitText: "errors",
            thruDate: "2027-06-30"
        })
        out.set = run(state.max.userId, R + "store#Goal", {
            partyId: state.ana.partyId,
            title: "Lead a stocktake",
            parentWorkEffortId: out.own.workEffortId,
            performanceReviewId: state.anaReview
        })
        out.colleague = code(run(state.bo.userId, R + "store#Goal", {partyId: state.ana.partyId, title: "Hers"}))
        out.badPercent = code(
            run(state.ana.userId, R + "store#Goal", {workEffortId: out.own.workEffortId, percentComplete: "140"})
        )
        out.progress = run(state.ana.userId, R + "store#Goal", {
            workEffortId: out.own.workEffortId,
            actualValue: "3",
            percentComplete: "40"
        })
        out.mine = run(state.ana.userId, R + "find#Goals", {})
        out.team = run(state.max.userId, R + "find#Goals", {show: "team"})
        out.byReview = run(state.max.userId, R + "find#Goals", {performanceReviewId: state.anaReview})
        out.boReads = code(run(state.bo.userId, R + "find#Goals", {partyId: state.ana.partyId}))
        out.goalLink = run(state.bo.userId, "mantle.party.CommunicationServices.get#RecordLinkInfo", {
            recordEntityName: "mantle.work.effort.WorkEffort",
            recordId: out.own.workEffortId
        })
        out.goalLinkAna = run(state.ana.userId, "mantle.party.CommunicationServices.get#RecordLinkInfo", {
            recordEntityName: "mantle.work.effort.WorkEffort",
            recordId: out.own.workEffortId
        })
        out.work = read("mantle.work.effort.WorkEffort", {workEffortId: out.own.workEffortId})[0]
        // P20 review: the id lookup (the record-link pickers' source) answers no goal, not even to its person
        out.lookup = run(state.ana.userId, "mantle.GeneralServices.lookup#ById", {lookupId: out.own.workEffortId})
        out.myTasks = run(state.ana.userId, "mantle.work.TaskServices.get#MyTasks", {})
        out.dav = run(state.ana.userId, "mantle.work.CalendarDavServices.get#TaskObjectTags", {})
        out.dueWork = run(state.ana.userId, "mantle.humanres.PeopleServices.find#DueWork", {kinds: "myTask"})
        out.closed = run(state.max.userId, R + "store#Goal", {
            workEffortId: out.set.workEffortId,
            close: true,
            outcomeEnumId: "GloMet"
        })
        out.changeClosed = code(run(state.ana.userId, R + "store#Goal", {workEffortId: out.set.workEffortId, title: "Again"}))
        return out
    },
    then(out) {
        out.note == "" && out.reassignByMax == "PERMISSION_DENIED" && out.reassign.error == ""
        // the new reviewer reads the steps, the assessment to do, and none of Max's notes; Max no longer reads the review
        out.niaView.isReviewer &&
            out.niaView.notes.length == 0 &&
            !JSON.stringify(out.niaView).includes(boNote) &&
            out.niaView.canAssess
        out.maxView == "RECORD_UNAVAILABLE"
        // the user's call of Nov 12, 2026: the feedback submitted on the review passes to the new reviewer (it belongs to the
        // review), and they withdraw the feedback still waiting that Max asked for
        out.cyFeedback.statusEnumId == "RssSubmitted"
        out.niaView.steps.some(row => row.stepKindEnumId == "RskFeedback" && row.summary == "Bo keeps the stockroom tidy")
        out.niaWithdraws.error == ""
        // the reassignment told Nia, and the subscriber to every review notice nothing (directOnly)
        out.niaTold > 0 && out.subscriberTold == 0
        out.niaOwned.resourceList.some(row => row.resourceId == "review:" + state.boReview && !row.transferable)
        // after Nia left: Bo's review goes back to the manager of his line (Max), Max's own waits with no reviewer
        out.boAfter.managerPartyId == state.max.partyId && out.boManagerStep.partyId == state.max.partyId
        out.maxReview.managerPartyId == null
        out.maxBack.isReviewer && out.maxBack.notes.length == 1 && out.maxBack.notes[0].noteText == boNote
        out.own.workEffortId &&
            out.set.workEffortId &&
            out.colleague == "RECORD_UNAVAILABLE" &&
            out.badPercent == "PERCENT_INVALID"
        out.progress.error == "" && out.mine.goals.length == 2 && out.team.goals.length == 2 && out.byReview.goals.length == 1
        out.mine.goals.find(row => row.workEffortId == out.own.workEffortId).progressText == "3 of 2 errors"
        out.boReads == "RECORD_UNAVAILABLE" && !out.goalLink.recordVisible && out.goalLinkAna.recordVisible
        out.work.workEffortTypeEnumId == "WetGoal" && out.work.purposeEnumId == "WepGoal" && out.work.rootWorkEffortId == null
        // in no task list: My tasks, the phone's Tasks collection, People's own tasks
        !Array.from(out.myTasks.taskList || []).some(row =>
            [out.own.workEffortId, out.set.workEffortId].includes(row.workEffortId)
        )
        !Array.from(out.dav.objectList || []).some(row => [out.own.workEffortId, out.set.workEffortId].includes(row.workEffortId))
        !JSON.stringify(out.dueWork).includes(out.own.workEffortId)
        out.lookup.error == "" && out.lookup.workEffort == null && out.lookup.workEffortId == null
        out.closed.statusId == "WeComplete" && out.changeClosed == "GOAL_CLOSED"
    }
})
