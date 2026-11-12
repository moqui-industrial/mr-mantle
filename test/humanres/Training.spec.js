// People's training (mantle.humanres.DevelopmentServices: store#TrainingClass, store#Training, find#Training, get#Training,
// enroll#Training, decide#Enrollment, mark#TrainingAttendance, complete#Training, get#TrainingCertificate; impl-people P19,
// design-people §10 Training and TrainingDetail, §15, PE-14): a course granting a qualification and a session of it (a WepTraining
// event, private, its trainer an attendee) are a development editor's, another employer's and a self-service employee refused; a
// place the person asks for waits for their manager (the person decides nothing), a development editor's enrollment is made at once,
// and the seats, the trainer and a second place are refused; the trainer marks attendance and assesses once the session started: a
// failed assessment is kept and the person stays enrolled, the passing one completes the place, grants the qualification once (a
// completion retried answers the first) and issues the certificate, stored and read back by the person alone of the people; the
// trainer reads their session's assessments and no other session's, the person their own outcome without the answers; a cancelled
// session cancels the places and supersedes a waiting approval. P19 review: the session's event is changed on the session alone
// (Commons' EventServices refuse its organizer, and no one puts it in a calendar); a place is approved before the session starts,
// and the person is told the decision (PeopleTrainingDecision, no reason); a trainer who left the employer reads the session as
// anyone else; a development editor builds a training assessment form. Follow-up 3: a session's room through the resource booking
// (a clash Busy, a blackout refused, moved and cancelled with it) and its time off its people's capacity, once with leave.
// Standalone: spec-local organizations, people, employments, a qualification type, an assessment form, groups and users, with
// artifact authorization disabled (the rules are the services' own checks).
// Run: ./moq test mr-mantle --spec Training
const prefix = "PEOPLE_TRN_SPEC"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    since = "2001-01-01T00:00:00Z",
    hour = 60 * 60 * 1000
const D = "mantle.humanres.DevelopmentServices."
const ENROLLMENT = "mantle.humanres.ability.PersonTraining"
const QUALIFICATION = "mantle.humanres.ability.PartyQualification"
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
// a person employed by the organization, with an account holding the permissions
function user(kind, organizationPartyId, permissions) {
    const partyId = prefix + "_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Train", lastName: kind})
    call("mantle.humanres.EmploymentServices.create#Employment", {
        fromPartyId: partyId,
        toPartyId: organizationPartyId,
        fromDate: since
    })
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Training " + kind})
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
const at = offsetHours => new Date(state.now + offsetHours * hour)
// a session's time moved, as time passing would move it (the services refuse a start in the past)
const moveSession = (workEffortId, startHours, endHours) =>
    call("update#mantle.work.effort.WorkEffort", {
        workEffortId,
        estimatedStartDate: at(startHours),
        estimatedCompletionDate: at(endHours)
    })

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        state.now = ec.user.timestampMillis(ec.user.nowTimestamp)
        organization(orgA, "Training Spec A")
        organization(orgB, "Training Spec B")
        const self = ["PEOPLE_SELF_SERVICE"]
        state.ana = user("ANA", orgA, self)
        state.bo = user("BO", orgA, self)
        state.cy = user("CY", orgA, self)
        state.trainer = user("TIA", orgA, self)
        state.max = user("MAX", orgA, ["PEOPLE_SELF_SERVICE", "PEOPLE_TEAM_VIEW", "PEOPLE_REQUEST_APPROVE"])
        state.dev = user("DEV", orgA, ["PEOPLE_DEVELOP_VIEW", "PEOPLE_DEVELOP_EDIT"])
        state.devB = user("DEVB", orgB, ["PEOPLE_DEVELOP_VIEW", "PEOPLE_DEVELOP_EDIT"])
        state.hr = user("HR", orgA, ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"])
        state.config = user("CONFIG", orgA, ["PEOPLE_CONFIGURE"])
        // Max manages Ana, Bo and Cy: their places go to him
        for (const report of [state.ana, state.bo, state.cy])
            call("create#mantle.party.PartyRelationship", {
                relationshipTypeEnumId: "PrtManager",
                fromPartyId: state.max.partyId,
                toPartyId: report.partyId,
                fromDate: since
            })
        state.typeId = prefix + "_QT_FIRSTAID"
        call("create#moqui.basic.Enumeration", {
            enumId: state.typeId,
            enumTypeId: "QualificationType",
            parentEnumId: "QualCertification",
            description: "Train spec first aid certificate"
        })
        // the employer's published training assessment (the form rules are FormDefinitions')
        const F = "mantle.party.FormDefinitionServices."
        state.formId = run(state.config.userId, F + "create#Form", {
            purposeEnumId: "DbfpTrainingAssessment",
            organizationPartyId: orgA,
            description: "Train spec first aid assessment"
        }).formId
        run(state.config.userId, F + "save#FormField", {
            formId: state.formId,
            newFieldName: "practical",
            title: "Practical",
            fieldTypeEnumId: "DBFFT_radio",
            isRequired: "Y",
            optionText: "1 | Not yet\n2 | Competent"
        })
        run(state.config.userId, F + "save#FormField", {
            formId: state.formId,
            newFieldName: "notes",
            title: "Notes",
            fieldTypeEnumId: "DBFFT_text-area"
        })
        run(state.config.userId, F + "publish#Form", {formId: state.formId})
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature("a course and its session are a development editor's: a WepTraining event, private, its trainer an attendee", {
    when() {
        const course = parameters =>
            run(state.dev.userId, D + "store#TrainingClass", Object.assign({organizationPartyId: orgA}, parameters))
        const out = {
            restricted: code(course({title: "Papers", qualificationTypeEnumId: "QualWorkPermit"})),
            validity: code(course({title: "First aid", qualificationTypeEnumId: state.typeId, validityMonths: "300"})),
            notEditor: code(run(state.ana.userId, D + "store#TrainingClass", {organizationPartyId: orgA, title: "Mine"})),
            otherEmployer: code(run(state.devB.userId, D + "store#TrainingClass", {organizationPartyId: orgA, title: "Theirs"}))
        }
        const made = course({
            title: "Train spec first aid",
            qualificationTypeEnumId: state.typeId,
            validityMonths: "24",
            assessmentRequired: "Y"
        })
        state.classId = made.trainingClassId
        const session = parameters =>
            run(
                state.dev.userId,
                D + "store#Training",
                Object.assign(
                    {
                        trainingClassId: state.classId,
                        startDate: at(24),
                        endDate: at(27),
                        capacity: "3",
                        trainerPartyId: state.trainer.partyId
                    },
                    parameters
                )
            )
        out.past = code(session({startDate: at(-48), endDate: at(-45)}))
        out.noForm = code(session({}))
        out.trainerElsewhere = code(session({trainerPartyId: state.devB.partyId, assessmentFormId: state.formId}))
        out.otherSession = code(
            run(state.devB.userId, D + "store#Training", {trainingClassId: state.classId, startDate: at(24), endDate: at(27)})
        )
        const scheduled = session({assessmentFormId: state.formId, location: "Room 2"})
        state.sessionId = scheduled.workEffortId
        out.scheduled = code(scheduled)
        state.otherSessionId = session({assessmentFormId: state.formId, trainerPartyId: state.dev.partyId}).workEffortId
        out.event = ec.entity
            .find("mantle.work.effort.WorkEffort")
            .condition("workEffortId", state.sessionId)
            .disableAuthz()
            .one()
        out.trainerOn = read("mantle.work.effort.WorkEffortParty", {
            workEffortId: state.sessionId,
            partyId: state.trainer.partyId
        }).length
        // P19 review: the organizer (the scheduler) sees the event and changes it only on the session; the trainer (an attendee)
        // puts it in no calendar
        out.eventAccess = run(state.dev.userId, "mantle.work.EventServices.check#EventAccess", {workEffortId: state.sessionId})
        out.eventMoved = run(state.dev.userId, "mantle.work.EventServices.update#EventOccurrence", {
            workEffortId: state.sessionId,
            start: at(30),
            end: at(33)
        }).error
        const calendarId = call("create#mantle.work.calendar.Calendar", {
            calendarName: "Train spec Tia's",
            calendarKindEnumId: "CalkPersonal",
            ownerPartyId: state.trainer.partyId
        }).calendarId
        out.calendarAdd = run(state.trainer.userId, "mantle.work.CalendarServices.add#CalendarEvent", {
            calendarId,
            workEffortId: state.sessionId
        }).error
        // P19 review: a development editor builds a training assessment form, not every People purpose's
        const F = "mantle.party.FormDefinitionServices."
        out.devForm = run(state.dev.userId, F + "create#Form", {
            purposeEnumId: "DbfpTrainingAssessment",
            organizationPartyId: orgA,
            description: "Train spec development's assessment"
        })
        // (P20: the review purpose admits a development editor too; an exit interview stays the People administrator's)
        out.devReviewForm = code(
            run(state.dev.userId, F + "create#Form", {
                purposeEnumId: "DbfpExitInterview",
                organizationPartyId: orgA,
                description: "Train spec exit interview"
            })
        )
        out.anaList = run(state.ana.userId, D + "find#Training", {})
        out.devBList = run(state.devB.userId, D + "find#Training", {show: "all"})
        out.devList = run(state.dev.userId, D + "find#Training", {})
        return out
    },
    then(out) {
        out.restricted == "TYPE_RESTRICTED" && out.validity == "VALIDITY_INVALID"
        out.notEditor == "PERMISSION_DENIED" && out.otherEmployer == "ORGANIZATION_DENIED"
        out.past == "DATE_PAST" && out.noForm == "FORM_REQUIRED" && out.trainerElsewhere == "NOT_EMPLOYED"
        out.otherSession == "RECORD_UNAVAILABLE" && out.scheduled == ""
        out.event.purposeEnumId == "WepTraining" && out.event.visibilityEnumId == "WevRestricted"
        out.event.location == "Room 2" && out.trainerOn == 1
        out.eventAccess.canView && !out.eventAccess.canEdit && out.eventAccess.managedBy
        out.eventMoved.includes("is changed on its People training session")
        out.calendarAdd.includes("not put in a calendar")
        out.devForm.formId && out.devForm.error == "" && out.devReviewForm == "PERMISSION_DENIED"
        // a self-service employee of the employer sees the session and may ask a place; another employer's development sees nothing
        const anaLine = out.anaList.sessions.find(row => row.workEffortId == state.sessionId)
        anaLine.canRequest &&
            anaLine.seatsText == "0 of 3 taken" &&
            anaLine.qualificationText.startsWith("Train spec first aid certificate")
        !out.anaList.canSchedule
        out.devBList.sessions.length == 0
        out.devList.canSchedule && out.devList.classes.some(row => row.trainingClassId == state.classId)
        out.devList.sessions.length == 2
    }
})

feature(
    "a place the person asks for waits for their manager; development enrolls at once; seats, the trainer and a second place",
    {
        when() {
            const enroll = (who, parameters = {}) =>
                run(who.userId, D + "enroll#Training", Object.assign({workEffortId: state.sessionId}, parameters))
            const asked = enroll(state.ana, {reason: "First aider for the floor", operationKey: "TRN-ANA-1"})
            state.anaTraining = asked.personTrainingId
            const out = {
                asked: asked.statusEnumId,
                retried: enroll(state.ana, {operationKey: "TRN-ANA-1"}),
                again: code(enroll(state.ana)),
                otherPerson: code(enroll(state.bo, {partyId: state.cy.partyId})),
                trainer: code(enroll(state.dev, {partyId: state.trainer.partyId})),
                own: code(run(state.ana.userId, D + "decide#Enrollment", {personTrainingId: state.anaTraining})),
                hrDecides: code(run(state.hr.userId, D + "decide#Enrollment", {personTrainingId: state.anaTraining}))
            }
            out.approverView = run(state.max.userId, D + "get#Training", {personTrainingId: state.anaTraining})
            out.approved = run(state.max.userId, D + "decide#Enrollment", {personTrainingId: state.anaTraining})
            out.boEnrolled = enroll(state.dev, {partyId: state.bo.partyId})
            state.boTraining = out.boEnrolled.personTrainingId
            // the third seat is asked for, so a fourth person finds the session full
            const cyAsked = enroll(state.cy)
            state.cyTraining = cyAsked.personTrainingId
            out.full = code(
                run(state.dev.userId, D + "enroll#Training", {workEffortId: state.sessionId, partyId: state.hr.partyId})
            )
            out.anaOn = read("mantle.work.effort.WorkEffortParty", {
                workEffortId: state.sessionId,
                partyId: state.ana.partyId
            }).length
            out.anaReminder = read("mantle.work.effort.WorkEffortReminder", {
                workEffortId: state.sessionId,
                partyId: state.ana.partyId
            })
            out.due = run(state.ana.userId, D + "find#Training", {show: "due"})
            // P19 review: Ana is told her place was approved, by the course and day, never her reason
            out.notices = Array.from(
                ec.entity
                    .find("moqui.security.user.NotificationMessage")
                    .condition({topic: "PeopleTrainingDecision", recordId: state.anaTraining})
                    .disableAuthz()
                    .list()
            ).map(row => String(row.messageJson || "") + " " + String(row.titleText || ""))
            return out
        },
        then(out) {
            out.asked == "PtsRequested" && out.retried.repeated && out.retried.personTrainingId == state.anaTraining
            out.again == "ALREADY_ENROLLED" && out.otherPerson == "PERMISSION_DENIED" && out.trainer == "TRAINER_ENROLLED"
            out.own == "PERMISSION_DENIED" && out.hrDecides == "RECORD_UNAVAILABLE"
            // the approver reads the place they decide, its reason, and no one else's
            out.approverView.enrollments.length == 1 && out.approverView.enrollments[0].canDecide
            out.approverView.enrollments[0].reason == "First aider for the floor"
            out.approved.statusEnumId == "PtsEnrolled" && out.boEnrolled.statusEnumId == "PtsEnrolled"
            out.full == "SESSION_FULL"
            out.anaOn == 1 && out.anaReminder.length == 1 && out.anaReminder[0].offsetMinutes == 1440
            out.due.sessions.length == 1 && out.due.sessions[0].myStatusText == "Enrolled"
            out.notices.length == 1 && out.notices[0].includes("approved") && out.notices[0].includes("Train spec first aid")
            !out.notices[0].includes("First aider for the floor")
        }
    }
)

feature(
    "the trainer marks attendance and assesses: a failure kept, the pass grants once with its certificate, a retry answers it",
    {
        when() {
            const T = state.trainer.userId
            const out = {
                notStarted: code(run(T, D + "mark#TrainingAttendance", {personTrainingId: state.anaTraining, attended: "Y"}))
            }
            moveSession(state.sessionId, -3, -1)
            // P19 review: Cy's place, still waiting, is not approved once the session started
            out.lateApproval = code(run(state.max.userId, D + "decide#Enrollment", {personTrainingId: state.cyTraining}))
            // a refusal still follows, its reason Max's and Cy's, and Cy is told the outcome alone
            out.lateRefusal = run(state.max.userId, D + "decide#Enrollment", {
                personTrainingId: state.cyTraining,
                decision: "refuse",
                reason: "Covering the store that day"
            })
            out.cyNotice = Array.from(
                ec.entity
                    .find("moqui.security.user.NotificationMessage")
                    .condition({topic: "PeopleTrainingDecision", recordId: state.cyTraining})
                    .disableAuthz()
                    .list()
            ).map(row => String(row.messageJson || "") + " " + String(row.titleText || ""))
            out.hrMarks = code(
                run(state.hr.userId, D + "mark#TrainingAttendance", {personTrainingId: state.anaTraining, attended: "Y"})
            )
            out.tooLong = code(
                run(T, D + "mark#TrainingAttendance", {personTrainingId: state.anaTraining, attended: "Y", attendedHours: "5"})
            )
            out.marked = run(T, D + "mark#TrainingAttendance", {personTrainingId: state.anaTraining, attended: "Y"})
            out.boAbsent = run(T, D + "mark#TrainingAttendance", {personTrainingId: state.boTraining, attended: "N"})
            out.boAssessed = code(run(T, D + "complete#Training", {personTrainingId: state.boTraining, outcome: "pass"}))
            out.noAnswers = code(run(T, D + "complete#Training", {personTrainingId: state.anaTraining, outcome: "pass"}))
            out.badAnswers = code(
                run(T, D + "complete#Training", {personTrainingId: state.anaTraining, outcome: "pass", values: {notes: "Fine"}})
            )
            out.failed = run(T, D + "complete#Training", {
                personTrainingId: state.anaTraining,
                outcome: "fail",
                score: "40",
                evidence: "Missed the recovery position",
                values: {practical: "1", notes: "Practise the recovery position"}
            })
            out.passed = run(T, D + "complete#Training", {
                personTrainingId: state.anaTraining,
                outcome: "pass",
                score: "85",
                values: {practical: "2"}
            })
            out.retried = run(state.dev.userId, D + "complete#Training", {
                personTrainingId: state.anaTraining,
                outcome: "pass",
                values: {practical: "2"}
            })
            out.failLater = code(
                run(T, D + "complete#Training", {personTrainingId: state.anaTraining, outcome: "fail", values: {practical: "1"}})
            )
            out.qualifications = read(QUALIFICATION, {partyId: state.ana.partyId, qualificationTypeEnumId: state.typeId})
            out.check = run(state.ana.userId, D + "check#Qualifications", {
                partyId: state.ana.partyId,
                qualificationTypeEnumId: state.typeId
            })
            out.enrollment = read(ENROLLMENT, {personTrainingId: state.anaTraining})[0]
            out.certificate = run(state.ana.userId, D + "get#TrainingCertificate", {personTrainingId: state.anaTraining})
            out.boCertificate = code(run(state.bo.userId, D + "get#TrainingCertificate", {personTrainingId: state.anaTraining}))
            out.locked = read("mantle.party.FormInvitation", {recordEntityName: ENROLLMENT, recordId: state.anaTraining})
            return out
        },
        then(out) {
            out.lateApproval == "SESSION_CLOSED" && out.lateRefusal.statusEnumId == "PtsRefused"
            out.cyNotice.length == 1 && out.cyNotice[0].includes("refused") && !out.cyNotice[0].includes("Covering the store")
            out.notStarted == "SESSION_NOT_STARTED" && out.hrMarks == "RECORD_UNAVAILABLE" && out.tooLong == "HOURS_INVALID"
            out.marked.attendedFlag == "Y" && out.boAbsent.attendedFlag == "N" && out.boAssessed == "ATTENDANCE_REQUIRED"
            out.noAnswers == "ASSESSMENT_REQUIRED" && out.badAnswers == "FORM_VALUES_INVALID"
            // the failure is kept and the place stays enrolled; the pass completes it and grants the qualification once
            out.failed.resultEnumId == "TrrFailed" && out.failed.statusEnumId == "PtsEnrolled" && !out.failed.partyQualificationId
            out.passed.resultEnumId == "TrrPassed" && out.passed.statusEnumId == "PtsCompleted" && !out.passed.repeated
            out.retried.repeated && out.retried.partyQualificationId == out.passed.partyQualificationId
            out.retried.personTrainingResultId == out.passed.personTrainingResultId
            out.failLater == "ALREADY_COMPLETED"
            out.qualifications.length == 1 && out.qualifications[0].verificationStatusId == "QlVerVerified"
            // valid for the course's 24 months
            const months = (ec.user.timestampMillis(out.qualifications[0].thruDate) - state.now) / (24 * hour * 30.4)
            months > 23 && months < 25
            out.check.results[0].state == "qualified"
            out.enrollment.certificateHtmlLocation && out.enrollment.certificateIssuedDate
            out.certificate.printHtml.includes("Train spec first aid") && out.certificate.printHtml.includes("Train ANA")
            !out.certificate.printHtml.includes("recovery position")
            out.boCertificate == "RECORD_UNAVAILABLE"
            // each assessment's answers kept as a response its invitation locks
            out.locked.length == 2 && out.locked.every(row => row.formResponseId && row.partyId == state.ana.partyId)
        }
    }
)

feature(
    "the trainer reads their session's assessments alone; the person their own outcome; a cancellation supersedes a request",
    {
        when() {
            const get = (who, workEffortId) => run(who.userId, D + "get#Training", {workEffortId})
            const out = {
                trainer: get(state.trainer, state.sessionId),
                trainerOther: get(state.trainer, state.otherSessionId),
                ana: get(state.ana, state.sessionId),
                devB: code(get(state.devB, state.sessionId)),
                dev: get(state.dev, state.sessionId)
            }
            // a place waiting in the other session, then the session cancelled
            const waiting = run(state.ana.userId, D + "enroll#Training", {workEffortId: state.otherSessionId})
            out.cancelReader = code(
                run(state.trainer.userId, D + "store#Training", {workEffortId: state.otherSessionId, cancel: "true"})
            )
            out.cancelled = run(state.dev.userId, D + "store#Training", {
                workEffortId: state.otherSessionId,
                cancel: "true",
                reason: "Room closed"
            })
            out.waiting = read(ENROLLMENT, {personTrainingId: waiting.personTrainingId})[0]
            out.approval = read("mantle.humanres.approval.PeopleApproval", {
                sourceEntityName: ENROLLMENT,
                sourceId: waiting.personTrainingId
            })[0]
            out.cancelledLine = run(state.ana.userId, D + "find#Training", {show: "past"}).sessions.find(
                row => row.workEffortId == state.otherSessionId
            )
            // P19 review: Tia leaves the employer; she no longer reads her session's places and assessments
            for (const row of read("mantle.party.PartyRelationship", {fromPartyId: state.trainer.partyId, toPartyId: orgA}))
                call("update#mantle.party.PartyRelationship", {
                    partyRelationshipId: row.partyRelationshipId,
                    thruDate: new Date(state.now - hour)
                })
            out.trainerLeft = code(get(state.trainer, state.sessionId))
            out.trainerLeftList = run(state.trainer.userId, D + "find#Training", {show: "training"}).sessions.length
            return out
        },
        then(out) {
            out.trainer.isTrainer && out.trainer.enrollments.length == 3
            // P19 review: why Cy's place was refused is development's and hers, not the trainer's
            out.trainer.enrollments.find(row => row.personTrainingId == state.cyTraining).decisionReason == ""
            out.dev.enrollments.find(row => row.personTrainingId == state.cyTraining).decisionReason ==
                "Covering the store that day"
            out.trainer.results.length == 2 &&
                out.trainer.results.some(row => row.answersText.includes("Practise the recovery position"))
            // the trainer of one session reads another's as any employee of the employer: their own place alone, no assessment
            !out.trainerOther.isTrainer && out.trainerOther.enrollments.length == 0 && out.trainerOther.results.length == 0
            // the person: their own place and outcomes, never the assessor's answers or evidence
            out.ana.enrollments.length == 1 && out.ana.enrollments[0].hasCertificate
            out.ana.results.length == 2 && out.ana.results.every(row => row.evidence == null && row.answersText == "")
            out.ana.results.some(row => row.resultText == "Passed" && row.scoreText == "85")
            out.devB == "RECORD_UNAVAILABLE"
            out.dev.results.some(row => row.evidence == "Missed the recovery position")
            out.cancelReader == "PERMISSION_DENIED" && out.cancelled.workEffortId == state.otherSessionId
            out.waiting.statusEnumId == "PtsCancelled" && out.approval.statusId == "PapSuperseded"
            out.cancelledLine.stateText == "Cancelled"
            out.trainerLeft == "RECORD_UNAVAILABLE" && out.trainerLeftList == 0
        }
    }
)

feature(
    "follow-up 3: a session's room is booked through the resource booking (a clash Busy, a blackout refused), moved and cancelled with it; its time is off its people's capacity, once with leave",
    {
        when() {
            const room = prefix + "_ROOM"
            call("create#mantle.facility.Facility", {
                facilityId: room,
                facilityTypeEnumId: "FcTpRoom",
                facilityName: "Train spec classroom",
                bookable: "Y",
                ownerPartyId: orgA
            })
            call("create#mantle.facility.Facility", {
                facilityId: prefix + "_STORE",
                facilityTypeEnumId: "FcTpRoom",
                facilityName: "Train spec store room",
                ownerPartyId: orgA
            })
            // a weekday four days or more out, its hours in the user's zone
            let dayText = null
            for (let offset = 4; !dayText; offset++) {
                const text = ec.l10n.format(new Date(state.now + offset * 24 * hour), "yyyy-MM-dd")
                const weekday = new Date(text + "T12:00:00Z").getUTCDay()
                if (weekday >= 1 && weekday <= 5) dayText = text
            }
            const on = hhmm => ec.l10n.parseTimestamp(dayText + " " + hhmm + ":00.000", "yyyy-MM-dd HH:mm:ss.SSS")
            // someone else's meeting in the room 08:00 to 09:00 (john.doe's, which the scheduler may not see)
            const meeting = call("mantle.work.EventServices.create#Event", {
                workEffortName: "Train spec board meeting",
                visibilityEnumId: "WevRestricted",
                estimatedStartDate: on("08:00"),
                estimatedCompletionDate: on("09:00")
            }).workEffortId
            call("mantle.work.EventServices.book#Resource", {workEffortId: meeting, facilityId: room})
            // the room blacked out 14:00 to 16:00
            call("create#mantle.work.effort.ResourceUnavailability", {
                unavailabilityKindEnumId: "RukPlanned",
                facilityId: room,
                organizationPartyId: orgA,
                fromDate: on("14:00"),
                thruDate: on("16:00"),
                unavailabilityReasonEnumId: "RurClosure",
                plannedOutage: "Y",
                description: "Train spec painting",
                revision: 1
            })
            const zoe = user("ZOE", orgA, ["PEOPLE_SELF_SERVICE"])
            const coach = user("COACH", orgA, ["PEOPLE_SELF_SERVICE"])
            const schedule = (from, to, extra = {}) =>
                run(
                    state.dev.userId,
                    D + "store#Training",
                    Object.assign(
                        {
                            trainingClassId: state.classId,
                            startDate: on(from),
                            endDate: on(to),
                            capacity: "4",
                            trainerPartyId: coach.partyId,
                            assessmentFormId: state.formId,
                            facilityId: room
                        },
                        extra
                    )
                )
            const bookingsOf = workEffortId => read("mantle.work.effort.WorkEffortFacility", {workEffortId})
            const event = workEffortId => read("mantle.work.effort.WorkEffort", {workEffortId})[0]
            const out = {
                clash: schedule("08:30", "10:00"),
                notBookable: code(schedule("10:00", "12:00", {facilityId: prefix + "_STORE"}))
            }
            const booked = schedule("10:00", "12:00")
            const id = booked.workEffortId
            out.booked = booked.error
            out.bookedRows = bookingsOf(id).map(row => row.facilityId + " " + row.statusId)
            out.bookedPlace = event(id).location
            out.line = run(state.dev.userId, D + "get#Training", {workEffortId: id}).session
            // on Commons' booking services only the session's organizer books for it (check#EventAccess canBook, impl-maintenance
            // F356): its trainer, an attendee, is refused
            out.directCancel = run(coach.userId, "mantle.work.EventServices.cancel#ResourceBooking", {
                workEffortId: id,
                facilityId: room
            }).error
            // Zoe enrolled, with time off 11:00 to 13:00 that day: the session's last hour is counted once, as leave
            run(state.dev.userId, D + "enroll#Training", {workEffortId: id, partyId: zoe.partyId})
            call("mantle.work.EventServices.create#Event", {
                workEffortName: "Train spec dentist",
                workEffortTypeEnumId: "WetTimeOff",
                estimatedStartDate: on("11:00"),
                estimatedCompletionDate: on("13:00"),
                assignToPartyId: zoe.partyId
            })
            // availability for dispatch and staffing takes training off (lessTraining); a timesheet's expected hours do not (the
            // user's call of Nov 12, 2026: training is worked time)
            const capacityDay = (partyId, lessTraining = true) =>
                call("mantle.work.ResourceServices.get#PartyCapacity", {
                    partyId,
                    fromDate: dayText,
                    thruDate: dayText,
                    lessTraining
                }).capacityList[0].dayList[0]
            out.zoe = capacityDay(zoe.partyId)
            out.coach = capacityDay(coach.partyId)
            out.coachWorked = capacityDay(coach.partyId, false)
            out.coachExpected = call("mantle.work.TimesheetServices.get#WeekDays", {
                dayList: [dayText],
                policy: {dayHours: 8, workDays: [1, 2, 3, 4, 5]},
                partyId: coach.partyId
            }).weekDayList[0]

            // moved into the meeting or the blackout: refused, the session as it was; moved to 12:00 to 14:00: the room kept
            const revision = () => run(state.dev.userId, D + "get#Training", {workEffortId: id}).session.revision
            const move = (from, to) =>
                run(state.dev.userId, D + "store#Training", {
                    workEffortId: id,
                    startDate: on(from),
                    endDate: on(to),
                    expectedRevision: revision()
                })
            out.intoMeeting = move("08:00", "10:00").error
            out.intoBlackout = code(move("13:00", "15:00"))
            out.unmoved = ec.l10n.format(event(id).estimatedStartDate, "HH:mm")
            out.moved = move("12:00", "14:00").error
            out.movedRows = bookingsOf(id).map(row => row.facilityId + " " + row.statusId)
            // off site: the room let go and the place the text
            out.offSite = run(state.dev.userId, D + "store#Training", {
                workEffortId: id,
                facilityId: "",
                location: "Fire station yard",
                expectedRevision: revision()
            }).error
            out.offSiteRows = bookingsOf(id).length
            out.offSitePlace = event(id).location
            // back in the room, then the session cancelled: its booking with it, and its time no longer off
            run(state.dev.userId, D + "store#Training", {workEffortId: id, facilityId: room, expectedRevision: revision()})
            out.again = bookingsOf(id).length
            out.cancelled = run(state.dev.userId, D + "store#Training", {workEffortId: id, cancel: "true"}).error
            out.cancelledRows = bookingsOf(id).length
            out.coachAfter = capacityDay(coach.partyId)
            return out
        },
        then(out) {
            code(out.clash) == "ROOM_UNAVAILABLE"
            out.clash.error.includes("Busy") && !out.clash.error.includes("board meeting")
            out.notBookable == "ROOM_UNAVAILABLE"
            out.booked == ""
            out.bookedRows == [prefix + "_ROOM WefAssigned"]
            out.bookedPlace == "Train spec classroom"
            out.line.roomName == "Train spec classroom" &&
                out.line.roomStatus == "booked" &&
                out.line.facilityId == prefix + "_ROOM"
            out.directCancel.includes("Only the organizer")
            // Zoe: two hours of leave, the session's one hour not under it; the coach: the session's two hours
            out.zoe.leave == 2 && out.zoe.training == 1 && out.zoe.capacity == out.zoe.base - 3
            out.coach.leave == 0 && out.coach.training == 2 && out.coach.capacity == out.coach.base - 2
            // without lessTraining (a timesheet's expected hours) the coach's whole day is expected
            out.coachWorked.training == 0 && out.coachWorked.capacity == out.coachWorked.base
            out.coachExpected.expected == out.coach.base
            out.intoMeeting.includes("ROOM_UNAVAILABLE") &&
                out.intoMeeting.includes("Busy") &&
                !out.intoMeeting.includes("board meeting")
            out.intoBlackout == "ROOM_UNAVAILABLE"
            out.unmoved == "10:00"
            out.moved == ""
            out.movedRows == [prefix + "_ROOM WefAssigned"]
            out.offSite == "" && out.offSiteRows == 0 && out.offSitePlace == "Fire station yard"
            out.again == 1
            out.cancelled == "" && out.cancelledRows == 0
            out.coachAfter.training == 0 && out.coachAfter.capacity == out.coachAfter.base
        }
    }
)
