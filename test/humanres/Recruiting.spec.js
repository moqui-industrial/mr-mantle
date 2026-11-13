// People's recruiting (mantle.humanres.RecruitingServices, Recruiting.js; impl-people P16, design-people §5, PE-04, PE-24): an
// opening only on an approved active seat of its employer (a planned seat and another employer's refused), changed by a
// recruiter with PEOPLE_RECRUIT_EDIT and not another employer's; applications to an open opening alone, a second open one of
// the same person flagged as a possible duplicate; a bulk stage change names its failure and moves the rest, Interview needs
// an interview and Hired is never a stage change; an interview is a private event with a video call link and its panel's
// scorecards, each panel member answering their own once and reading their own scorecard only, never another opening's
// candidates, their interviews on My interviews; an application by mail once, from the opening's plus tag when the rule's owner
// is its recruiting owner, with its resume, and nothing from a rule of anyone else. P16 review: a panel member reads of the
// application only the applicant's name, the opening, their own interviews and scorecard and the files a recruiter shared with the
// panel, never its record host; their self-service My interviews (the user's call of Nov 12, 2026); scorecard answers opted out
// of AI on the entity; an application from a chat message once, by a recruiter, never from their own message; an owner who left
// files no mail, and their openings are handed over through People's lifecycle participant. P17 (the user's call of Nov 12, 2026):
// an applicant's resume is shared with the interview panel when attached (by a recruiter, by mail), another file only when a
// recruiter shares it, and the recruiter can stop sharing the resume. Follow-up 3: an interview's room through the resource booking
// (a clash Busy, a blackout refused, moved, changed and cancelled with it).
// Standalone: spec-local organizations, people, employments, positions, a published scorecard, groups and users, artifact
// authorization disabled (the rules are the services' own checks). The form rules are FormDefinitions'.
// Run: ./moq test mr-mantle --spec Recruiting
const prefix = "PEOPLE_RECRUIT_SPEC"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    since = "2001-01-01T00:00:00Z"
const R = "mantle.humanres.RecruitingServices."
const APPLICATION = "mantle.humanres.employment.EmploymentApplication"
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
// a block as the user, artifact authorization off (the services' own checks)
function as(username, action) {
    login(username)
    ec.artifactExecution.disableAuthz()
    try {
        return action()
    } finally {
        ec.message.clearErrors()
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}
const code = out => (out.error ? /[A-Z][A-Z0-9_]{3,}(?=:)/.exec(out.error)?.[0] || out.error : "")
const application = id => ec.entity.find(APPLICATION).condition("employmentApplicationId", id).disableAuthz().one()
function organization(partyId, name) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
// a person employed by the organization, with an account holding the permissions
function user(kind, organizationPartyId, permissions) {
    const partyId = prefix + "_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Recruit", lastName: kind})
    call("mantle.humanres.EmploymentServices.create#Employment", {
        fromPartyId: partyId,
        toPartyId: organizationPartyId,
        fromDate: since
    })
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Recruiting " + kind})
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
function seat(id, organizationPartyId, statusId) {
    call("create#mantle.humanres.position.EmplPosition", {
        emplPositionId: prefix + "_" + id,
        organizationPartyId,
        statusId,
        description: "Seat " + id,
        fromDate: since
    })
    return prefix + "_" + id
}
// the next weekday at 10:00, a week out, in milliseconds
const nextWeek = () => {
    const [y, m, d] = ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd").split("-").map(Number)
    const day = new Date(Date.UTC(y, m - 1, d + 7)).toISOString().slice(0, 10)
    return ec.l10n.parseTimestamp(day + " 10:00:00.000", "yyyy-MM-dd HH:mm:ss.SSS")
}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(orgA, "Recruiting Spec A")
        organization(orgB, "Recruiting Spec B")
        state.recruiter = user("RECRUITER", orgA, ["PEOPLE_RECRUIT_VIEW", "PEOPLE_RECRUIT_EDIT"])
        state.reader = user("READER", orgA, ["PEOPLE_RECRUIT_VIEW"])
        state.recruiterB = user("RECRUITER_B", orgB, ["PEOPLE_RECRUIT_VIEW", "PEOPLE_RECRUIT_EDIT"])
        state.config = user("CONFIG", orgA, ["PEOPLE_CONFIGURE"])
        state.ana = user("ANA", orgA, ["PEOPLE_SELF_SERVICE"])
        state.ben = user("BEN", orgA, ["PEOPLE_SELF_SERVICE"])
        state.owner = user("OWNER", orgA, ["PEOPLE_RECRUIT_VIEW", "PEOPLE_RECRUIT_EDIT"])
        state.active = seat("ACTIVE", orgA, "EmpsActive")
        state.active2 = seat("ACTIVE2", orgA, "EmpsActive")
        state.planned = seat("PLANNED", orgA, "EmpsPlanned")
        state.seatB = seat("B", orgB, "EmpsActive")
        // the employer's published interview scorecard (the form rules are FormDefinitions')
        const F = "mantle.party.FormDefinitionServices."
        state.formId = run(state.config.userId, F + "create#Form", {
            purposeEnumId: "DbfpInterviewScorecard",
            organizationPartyId: orgA,
            description: "Spec scorecard"
        }).formId
        run(state.config.userId, F + "save#FormField", {
            formId: state.formId,
            newFieldName: "overall",
            title: "Overall",
            fieldTypeEnumId: "DBFFT_radio",
            isRequired: "Y",
            optionText: "1 | No hire\n2 | Hire"
        })
        run(state.config.userId, F + "save#FormField", {
            formId: state.formId,
            newFieldName: "evidence",
            title: "Evidence",
            fieldTypeEnumId: "DBFFT_text-area"
        })
        run(state.config.userId, F + "publish#Form", {formId: state.formId})
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
        ec.artifactExecution.enableAuthz()
    }
})

feature("an opening only on an approved active seat of its employer, changed by its recruiter alone", {
    when() {
        const store = (who, values) => run(who.userId, R + "store#Opening", values)
        const planned = code(
            store(state.recruiter, {organizationPartyId: orgA, title: "Planned", emplPositionIds: state.planned})
        )
        const other = code(store(state.recruiter, {organizationPartyId: orgA, title: "B's seat", emplPositionIds: state.seatB}))
        const reader = code(store(state.reader, {organizationPartyId: orgA, title: "Reader's", emplPositionIds: state.active}))
        const draft = store(state.recruiter, {
            organizationPartyId: orgA,
            title: "Sales associate",
            emplPositionIds: state.active,
            intakePlusTag: "spec-sales"
        })
        state.openingId = draft.jobOpeningId
        const draftApplication = code(
            run(state.recruiter.userId, R + "create#Application", {
                jobOpeningId: draft.jobOpeningId,
                firstName: "Early",
                lastName: "Bird"
            })
        )
        const opened = store(state.recruiter, {jobOpeningId: draft.jobOpeningId, action: "open", scorecardFormId: state.formId})
        const second = store(state.recruiter, {
            organizationPartyId: orgA,
            title: "Merchandiser",
            emplPositionIds: state.active2,
            action: "open"
        })
        state.secondOpeningId = second.jobOpeningId
        const tagTaken = code(
            store(state.recruiter, {
                organizationPartyId: orgA,
                title: "Again",
                emplPositionIds: state.active,
                intakePlusTag: "spec-sales"
            })
        )
        return {
            planned,
            other,
            reader,
            draft,
            draftApplication,
            opened,
            second,
            tagTaken,
            otherEmployer: code(store(state.recruiterB, {jobOpeningId: draft.jobOpeningId, title: "Mine"})),
            listedB: run(state.recruiterB.userId, R + "find#Openings", {}),
            listedA: run(state.reader.userId, R + "find#Openings", {})
        }
    },
    then(r) {
        r.planned == "POSITION_NOT_APPROVED"
        r.other == "POSITION_UNAVAILABLE"
        r.reader == "PERMISSION_DENIED"
        r.draft.error == ""
        r.draftApplication == "OPENING_CLOSED"
        r.opened.error == ""
        r.second.error == ""
        r.tagTaken == "TAG_TAKEN"
        r.otherEmployer == "RECORD_UNAVAILABLE"
        r.listedB.openings.length == 0
        r.listedA.openings.find(row => row.jobOpeningId == state.openingId).stateText == "Open"
        r.listedA.openings.find(row => row.jobOpeningId == state.openingId).canEdit == false
        r.listedA.openings.find(row => row.jobOpeningId == state.openingId).positionsText == "Seat ACTIVE"
    }
})

feature(
    "a possible duplicate is flagged; a bulk stage change names its failure; Interview needs an interview, Hired never moves",
    {
        when() {
            const create = values =>
                run(state.recruiter.userId, R + "create#Application", Object.assign({jobOpeningId: state.openingId}, values))
            const first = create({
                firstName: "Cara",
                lastName: "Candidate",
                emailAddress: "cara.spec@example.test",
                referredByEnumId: "EarbInternet"
            })
            const again = create({firstName: "Cara", lastName: "Candidate", emailAddress: "cara.spec@example.test"})
            const dan = create({firstName: "Dan", lastName: "Candidate", emailAddress: "dan.spec@example.test"})
            const other = run(state.recruiter.userId, R + "create#Application", {
                jobOpeningId: state.secondOpeningId,
                firstName: "Eve",
                lastName: "Other"
            })
            state.cara = first.employmentApplicationId
            state.dan = dan.employmentApplicationId
            state.eve = other.employmentApplicationId
            run(state.recruiter.userId, R + "change#ApplicationStage", {
                employmentApplicationId: again.employmentApplicationId,
                statusId: "EaWithdrawn"
            })
            const bulk = run(state.recruiter.userId, R + "change#ApplicationStage", {
                employmentApplicationIds: [state.cara, again.employmentApplicationId, state.dan],
                statusId: "EaScreening",
                reason: "First read"
            })
            return {
                first,
                again,
                bulk,
                hired: run(state.recruiter.userId, R + "change#ApplicationStage", {
                    employmentApplicationIds: [state.cara],
                    statusId: "EaHired"
                }),
                interview: run(state.recruiter.userId, R + "change#ApplicationStage", {
                    employmentApplicationIds: [state.cara],
                    statusId: "EaInterview"
                }),
                byReader: code(
                    run(state.reader.userId, R + "change#ApplicationStage", {
                        employmentApplicationIds: [state.cara],
                        statusId: "EaReceived"
                    })
                ),
                role: ec.entity
                    .find("mantle.party.PartyRole")
                    .condition({partyId: first.applicantPartyId, roleTypeId: "Applicant"})
                    .disableAuthz()
                    .count(),
                account: ec.entity
                    .find("moqui.security.UserAccount")
                    .condition("partyId", first.applicantPartyId)
                    .disableAuthz()
                    .count(),
                board: run(state.recruiter.userId, R + "find#Applications", {jobOpeningId: state.openingId}),
                // People acceptance (PeopleReviewWalk): a person who is only an applicant is found by their employer's
                // recruiters alone, in universal search too, never by another employer's recruiter or a self-service employee
                hidden: Object.fromEntries(
                    [
                        ["recruiter", state.recruiter],
                        ["recruiterB", state.recruiterB],
                        ["ana", state.ana]
                    ].map(([who, account]) => [
                        who,
                        as(account.userId, () =>
                            Array.from(
                                ec.resource
                                    .script("component://mr-mantle/service/mantle/humanres/Recruiting.js")
                                    .hiddenApplicants([first.applicantPartyId, state.ben.partyId])
                            )
                        )
                    ])
                ),
                found: (() => {
                    ec.search.indexDocuments(ec.entity.getDataDocuments("MantleParty", {partyId: first.applicantPartyId}))
                    const search = account =>
                        as(account.userId, () =>
                            Array.from(
                                ec.service
                                    .sync()
                                    .name("mantle.search.UniversalSearchServices.search#Universal")
                                    .parameters({q: "Candidate", entityType: "MantleParty", limit: 100, highlight: false})
                                    .call()?.results || []
                            ).some(result => result.id == first.applicantPartyId)
                        )
                    return {recruiter: search(state.recruiter), ana: search(state.ana)}
                })()
            }
        },
        then(r) {
            r.first.error == ""
            r.first.duplicateOfApplicationId == null
            r.again.applicantPartyId == r.first.applicantPartyId
            r.again.duplicateOfApplicationId == state.cara
            r.bulk.changedIds.length == 2
            r.bulk.failures.length == 1
            r.bulk.failures[0].code == "APPLICATION_CLOSED"
            r.bulk.failures[0].applicantName == "Cara Candidate"
            application(state.cara).statusId == "EaScreening"
            application(state.dan).statusId == "EaScreening"
            r.hired.failures[0].code == "HIRED_BY_OFFER"
            r.interview.failures[0].code == "INTERVIEW_REQUIRED"
            r.byReader == "PERMISSION_DENIED"
            r.role == 1
            r.account == 0
            r.board.applications
                .map(row => row.employmentApplicationId)
                .sort()
                .join(",") == [state.cara, state.dan].sort().join(",")
            r.board.stages.find(stage => stage.statusId == "EaScreening").count == 2
            r.hidden.recruiter.length == 0
            r.hidden.recruiterB == [r.first.applicantPartyId] && r.hidden.ana == [r.first.applicantPartyId]
            r.found.recruiter && !r.found.ana
        }
    }
)

feature("an interview's panel each answer their own scorecard once and read no one else's, nor another opening's candidates", {
    when() {
        const scheduled = run(state.recruiter.userId, R + "schedule#Interview", {
            employmentApplicationId: state.cara,
            startDate: nextWeek(),
            durationMinutes: 45,
            panelPartyIds: [state.ana.partyId, state.ben.partyId].join(","),
            videoCall: true,
            inviteCandidate: true
        })
        const event = ec.entity
            .find("mantle.work.effort.WorkEffort")
            .condition("workEffortId", scheduled.workEffortId)
            .disableAuthz()
            .one()
        const anaCard = scheduled.invitationIds?.[0]
        const benCard = scheduled.invitationIds?.[1]
        const answered = run(state.ana.userId, R + "submit#Scorecard", {
            invitationId: anaCard,
            values: {overall: "2", evidence: "Clear, warm and specific"}
        })
        return {
            scheduled,
            event,
            notOnPanel: code(
                run(state.recruiter.userId, R + "schedule#Interview", {
                    employmentApplicationId: state.dan,
                    startDate: nextWeek(),
                    panelPartyIds: state.recruiterB.partyId
                })
            ),
            answered,
            again: code(run(state.ana.userId, R + "submit#Scorecard", {invitationId: anaCard, values: {overall: "1"}})),
            othersCard: code(run(state.ben.userId, R + "submit#Scorecard", {invitationId: anaCard, values: {overall: "1"}})),
            missing: code(
                run(state.ben.userId, R + "submit#Scorecard", {invitationId: benCard, values: {evidence: "No overall"}})
            ),
            anaView: run(state.ana.userId, R + "get#Application", {employmentApplicationId: state.cara}),
            benView: run(state.ben.userId, R + "get#Application", {employmentApplicationId: state.cara}),
            recruiterView: run(state.recruiter.userId, R + "get#Application", {employmentApplicationId: state.cara}),
            otherCandidate: code(run(state.ana.userId, R + "get#Application", {employmentApplicationId: state.eve})),
            board: code(run(state.ana.userId, R + "find#Applications", {})),
            projection: run(state.ana.userId, R + "get#InterviewProjection", {}),
            calendar: run(state.ana.userId, R + "find#Interviews", {}),
            danProjection: run(state.recruiterB.userId, R + "get#InterviewProjection", {checkOnly: true}),
            // the record host (notes, files) is the recruiters': a panel member reads none of it
            anaRecord: run(state.ana.userId, R + "check#ApplicationAccess", {employmentApplicationId: state.cara}),
            readerRecord: run(state.reader.userId, R + "check#ApplicationAccess", {employmentApplicationId: state.cara}),
            // the scorecard's text is opted out of AI on the entity too (FormResponseAnswer.valueText)
            aiAnswer: run("john.doe", "org.moqui.agent.AiTaskServices.propose#AiFieldValue", {
                entityName: "moqui.screen.form.FormResponseAnswer",
                recordId: "_NA_",
                fieldName: "valueText"
            })
        }
    },
    then(r) {
        r.scheduled.workEffortId != null
        r.scheduled.invitationIds.length == 2
        r.scheduled.callPath.startsWith("/call/")
        r.event.visibilityEnumId == "WevRestricted"
        String(r.event.location).includes("/call/")
        application(state.cara).statusId == "EaInterview"
        r.notOnPanel == "PANEL_INVALID"
        r.answered.error == ""
        r.again == "ALREADY_ANSWERED"
        r.othersCard == "RECORD_UNAVAILABLE"
        r.missing == "FORM_VALUES_INVALID"
        r.anaView.application.access == "panel"
        r.anaView.application.myScorecards.length == 1
        r.anaView.application.myScorecards[0].answered == true
        r.anaView.application.interviews[0].scorecards.length == 1
        r.anaView.application.emailAddress == null
        r.anaView.application.stageText == ""
        r.anaView.application.sourceText == null
        r.anaView.application.files.length == 0
        r.anaView.application.sharedFiles.length == 0
        r.anaRecord.recordVisible == false
        r.readerRecord.recordVisible == true
        r.aiAnswer.error.includes("opted out of AI")
        r.benView.application.interviews[0].scorecards.length == 1
        r.benView.application.interviews[0].scorecards[0].answered == false
        !JSON.stringify(r.benView.application).includes("Clear, warm and specific")
        r.recruiterView.application.interviews[0].scorecards.length == 2
        JSON.stringify(r.recruiterView.application).includes("Clear, warm and specific")
        r.otherCandidate == "RECORD_UNAVAILABLE"
        r.board == "PERMISSION_DENIED"
        r.projection.admitted == true
        r.projection.eventList.length == 1
        r.projection.eventList[0].summary == "Interview · Sales associate"
        r.calendar.eventList.length == 1
        r.calendar.eventList[0].title == "Cara Candidate · Sales associate"
        r.danProjection.admitted == false
    }
})

feature(
    "an application by mail once, from the opening's plus tag on its owner's rule, with its resume; no other rule files one",
    {
        when() {
            const resume = "dbresource://spec/recruiting/" + prefix + "/resume.txt"
            ec.resource.getLocationReference(resume).putText("Gil Mailer, five years in retail")
            const emailMessageId = call("create#moqui.basic.email.EmailMessage", {
                statusId: "ES_RECEIVED",
                subject: "Application for the sales associate opening",
                fromAddress: "gil.spec@example.test",
                fromName: "Gil Mailer",
                toAddresses: "jobs+spec-sales@example.test",
                receivedDate: ec.user.nowTimestamp
            }).emailMessageId
            call("create#moqui.basic.email.EmailMessageAttachment", {
                emailMessageId,
                fileName: "resume.txt",
                attachmentLocation: resume,
                isInline: "N"
            })
            const intake = ruleOwner =>
                run("john.doe", R + "create#ApplicationFromEmail", {emailMessageId, ruleOwnerUserId: ruleOwner})
            const refused = intake(state.reader.userId)
            const made = intake(state.recruiter.userId)
            const again = intake(state.recruiter.userId)
            const files = Array.from(
                ec.entity
                    .find("mantle.humanres.employment.EmploymentApplicationContent")
                    .condition("employmentApplicationId", made.employmentApplicationId || "_NA_")
                    .disableAuthz()
                    .list()
            )
            return {
                refused,
                made,
                again,
                files,
                row: made.employmentApplicationId ? application(made.employmentApplicationId) : null
            }
        },
        then(r) {
            r.refused.created == false
            r.refused.reason == "RULE_NOT_ALLOWED"
            r.made.created == true
            r.again.created == false
            r.again.employmentApplicationId == r.made.employmentApplicationId
            r.row.jobOpeningId == state.openingId
            r.row.statusId == "EaReceived"
            r.row.referredByEnumId == "EarbEmail"
            r.files.length == 1
            r.files[0].contentTypeEnumId == "EactResume"
            r.files[0].panelShared == "Y"
            ec.resource.getLocationReference(r.files[0].contentLocation).getText().includes("five years in retail")
        }
    }
)

feature(
    "a panel member's self-service: My interviews, their own interview and only the files a recruiter shared with the panel",
    {
        when() {
            const resume = "dbresource://spec/recruiting/" + prefix + "/cara-resume.txt"
            ec.resource.getLocationReference(resume).putText("Cara Candidate, store lead")
            const fileId = call("create#mantle.humanres.employment.EmploymentApplicationContent", {
                employmentApplicationId: state.cara,
                contentTypeEnumId: "EactResume",
                description: "cara-resume.txt",
                contentLocation: resume,
                contentDate: ec.user.nowTimestamp
            }).applicationContentId
            const file = who => run(who.userId, R + "get#ApplicationFile", {applicationContentId: fileId})
            const before = code(file(state.ben))
            const byReader = code(
                run(state.reader.userId, R + "share#ApplicationContent", {applicationContentId: fileId, shared: true})
            )
            const shared = run(state.recruiter.userId, R + "share#ApplicationContent", {
                applicationContentId: fileId,
                shared: true
            })
            const anaList = run(state.ana.userId, R + "find#MyInterviews", {})
            const benList = run(state.ben.userId, R + "find#MyInterviews", {})
            const workEffortId = benList.interviews?.[0]?.workEffortId
            return {
                before,
                byReader,
                shared,
                after: file(state.ben),
                recruiterFile: file(state.reader),
                otherEmployer: code(file(state.recruiterB)),
                anaList,
                benList,
                benInterview: run(state.ben.userId, R + "get#MyInterview", {workEffortId}),
                notOnPanel: code(run(state.recruiter.userId, R + "get#MyInterview", {workEffortId})),
                otherEmployerInterview: code(run(state.recruiterB.userId, R + "get#MyInterview", {workEffortId})),
                benView: run(state.ben.userId, R + "get#Application", {employmentApplicationId: state.cara}),
                recruiterView: run(state.recruiter.userId, R + "get#Application", {employmentApplicationId: state.cara})
            }
        },
        then(r) {
            r.before == "RECORD_UNAVAILABLE"
            r.byReader == "PERMISSION_DENIED"
            r.shared.shared == true
            r.after.error == ""
            ec.resource.getLocationReference(r.after.location).getText().includes("store lead")
            r.recruiterFile.error == ""
            r.otherEmployer == "RECORD_UNAVAILABLE"
            r.anaList.interviews.length == 1
            r.anaList.interviews[0].answered == true
            r.anaList.toAnswerCount == 0
            r.benList.toAnswerCount == 1
            r.benList.interviews[0].applicantName == "Cara Candidate"
            r.benList.interviews[0].openingTitle == "Sales associate"
            r.benInterview.interview.applicantName == "Cara Candidate"
            r.benInterview.interview.sharedFiles.map(row => row.description).join(",") == "cara-resume.txt"
            r.benInterview.interview.scorecard.answered == false
            r.benInterview.interview.location.includes("/call/")
            !JSON.stringify(r.benInterview).includes("Clear, warm and specific")
            !JSON.stringify(r.benInterview).includes("Screening") &&
                !JSON.stringify(r.benInterview).includes("Interview scheduled")
            r.notOnPanel == "RECORD_UNAVAILABLE"
            r.otherEmployerInterview == "RECORD_UNAVAILABLE"
            r.benView.application.sharedFiles.length == 1
            r.recruiterView.application.files.find(row => row.description == "cara-resume.txt").panelShared == true
        }
    }
)

feature(
    "an application from a chat message once, by a recruiter, never from their own message; an owner who left files no mail and their opening is handed over",
    {
        when() {
            // Ben, an employee, asks in a room with the recruiter for the opening by its plus tag
            login(state.ben.userId)
            ec.artifactExecution.disableAuthz()
            const room = call("org.moqui.chat.ChatServices.create#Room", {
                roomTypeEnumId: "CrtPrivate",
                roomName: "Recruiting spec chat",
                memberUserIdList: [state.recruiter.userId, state.reader.userId]
            })
            const sent = call("org.moqui.chat.ChatServices.send#Message", {
                chatRoomId: room.chatRoomId,
                body: "I would like to apply for +spec-sales, I know the store well"
            })
            login(state.recruiter.userId)
            ec.artifactExecution.disableAuthz()
            const own = call("org.moqui.chat.ChatServices.send#Message", {
                chatRoomId: room.chatRoomId,
                body: "Thanks, +spec-sales"
            })
            login("john.doe")
            ec.artifactExecution.disableAuthz()
            const parameters = {chatRoomId: room.chatRoomId, eventSeq: sent.eventSeq}
            const made = run(state.recruiter.userId, R + "create#ApplicationFromChat", parameters)
            const again = run(state.recruiter.userId, R + "create#ApplicationFromChat", parameters)
            const byReader = code(run(state.reader.userId, R + "create#ApplicationFromChat", parameters))
            const notMember = code(run(state.recruiterB.userId, R + "create#ApplicationFromChat", parameters))
            const fromOwn = code(
                run(state.recruiter.userId, R + "create#ApplicationFromChat", {
                    chatRoomId: room.chatRoomId,
                    eventSeq: own.eventSeq
                })
            )
            // an opening the owner owns, its mail after the owner left, and its hand-over through People's lifecycle participant
            const opening = run(state.recruiter.userId, R + "store#Opening", {
                organizationPartyId: orgA,
                title: "Stock lead",
                emplPositionIds: state.active,
                ownerPartyId: state.owner.partyId,
                intakePlusTag: "spec-owner",
                action: "open"
            })
            const owned = run("john.doe", "mantle.humanres.PeopleApprovalServices.find#OwnedApprovals", {
                userId: state.owner.userId
            })
            const employment = ec.entity
                .find("mantle.party.PartyRelationship")
                .condition({fromPartyId: state.owner.partyId, toPartyId: orgA, relationshipTypeEnumId: "PrtEmployee"})
                .disableAuthz()
                .one()
            call("update#mantle.party.PartyRelationship", {
                partyRelationshipId: employment.partyRelationshipId,
                thruDate: ec.user.nowTimestamp
            })
            const emailMessageId = call("create#moqui.basic.email.EmailMessage", {
                statusId: "ES_RECEIVED",
                subject: "Stock lead",
                fromAddress: "hal.spec@example.test",
                fromName: "Hal Mailer",
                toAddresses: "jobs+spec-owner@example.test",
                receivedDate: ec.user.nowTimestamp
            }).emailMessageId
            const leftMail = run("john.doe", R + "create#ApplicationFromEmail", {
                emailMessageId,
                ruleOwnerUserId: state.owner.userId
            })
            const transfer = to =>
                run("john.doe", "mantle.humanres.PeopleApprovalServices.transfer#ApprovalOwner", {
                    fromUserId: state.owner.userId,
                    toUserId: to,
                    approvalResourceId: "opening:" + opening.jobOpeningId,
                    reason: "Left"
                })
            const elsewhere = code(transfer(state.recruiterB.userId))
            const handed = transfer(state.recruiter.userId)
            return {
                made,
                again,
                byReader,
                notMember,
                fromOwn,
                owned,
                leftMail,
                elsewhere,
                handed,
                openingId: opening.jobOpeningId,
                row: made.employmentApplicationId ? application(made.employmentApplicationId) : null
            }
        },
        then(r) {
            r.made.error == ""
            r.made.created == true
            r.row.jobOpeningId == state.openingId
            r.row.applyingPartyId == state.ben.partyId
            r.row.comments.startsWith("I would like to apply")
            r.again.created == false
            r.again.employmentApplicationId == r.made.employmentApplicationId
            r.byReader == "PERMISSION_DENIED"
            r.notMember == "RECORD_UNAVAILABLE"
            r.fromOwn == "NOT_AN_APPLICANT"
            r.owned.resourceList.some(row => row.resourceId == "opening:" + r.openingId && row.transferable)
            r.leftMail.reason == "RULE_NOT_ALLOWED"
            r.elsewhere == "NOT_EMPLOYED"
            r.handed.error == ""
            ec.entity.find("mantle.humanres.recruitment.JobOpening").condition("jobOpeningId", r.openingId).disableAuthz().one()
                .ownerPartyId == state.recruiter.partyId
        }
    }
)

feature(
    "an applicant's resume is shared with the panel when attached, another file only when shared; the recruiter unshares it",
    {
        when() {
            const attach = (contentTypeEnumId, description) =>
                run(state.recruiter.userId, R + "create#ApplicationContent", {
                    employmentApplicationId: state.dan,
                    contentTypeEnumId,
                    description
                }).applicationContentId
            const resumeId = attach("EactResume", "dan-resume.pdf")
            const letterId = attach("EactCoverLetter", "dan-letter.pdf")
            const row = id =>
                ec.entity
                    .find("mantle.humanres.employment.EmploymentApplicationContent")
                    .condition("applicationContentId", id)
                    .disableAuthz()
                    .one()
            const shared = {resume: row(resumeId).panelShared, letter: row(letterId).panelShared}
            const unshared = run(state.recruiter.userId, R + "share#ApplicationContent", {
                applicationContentId: resumeId,
                shared: false
            })
            return {shared, unshared, after: row(resumeId).panelShared}
        },
        then(r) {
            r.shared.resume == "Y"
            r.shared.letter == "N"
            r.unshared.shared == false
            r.after == "N"
        }
    }
)

// Commons calendar editors (Nov 12, 2026): an interview's event is People's (the EventManager PeopleInterview). Its recruiter,
// the event's organizer, sees it on Commons' screens and changes it only here (change#Interview, cancel#Interview); a panel
// member puts it in no calendar of their own, whose editors and CalDAV would change it there
feature("an interview's event changes only through recruiting: the organizer refused on Commons, the panel refused a calendar", {
    when() {
        const E = "mantle.work.EventServices."
        const scheduled = run(state.recruiter.userId, R + "schedule#Interview", {
            employmentApplicationId: state.cara,
            startDate: nextWeek(),
            durationMinutes: 45,
            panelPartyIds: state.ana.partyId,
            location: "Room 4"
        })
        const workEffortId = scheduled.workEffortId
        const event = () =>
            ec.entity.find("mantle.work.effort.WorkEffort").condition("workEffortId", workEffortId).disableAuthz().one()
        const anaCalendarId = call("create#mantle.work.calendar.Calendar", {
            calendarName: "Recruit spec Ana's",
            calendarKindEnumId: "CalkPersonal",
            ownerPartyId: state.ana.partyId
        }).calendarId
        const startMs = Number(String(event().estimatedStartDate))
        const out = {
            scheduled,
            access: run(state.recruiter.userId, E + "check#EventAccess", {workEffortId}),
            moved: run(state.recruiter.userId, E + "update#EventOccurrence", {
                workEffortId,
                start: ec.l10n.format(new Date(startMs + 3600000), "yyyy-MM-dd HH:mm"),
                end: ec.l10n.format(new Date(startMs + 7200000), "yyyy-MM-dd HH:mm")
            }).error,
            cancelledOnCommons: run(state.recruiter.userId, E + "cancel#EventOccurrence", {workEffortId}).error,
            anaAdd: run(state.ana.userId, "mantle.work.CalendarServices.add#CalendarEvent", {
                calendarId: anaCalendarId,
                workEffortId
            }).error,
            readerChange: code(run(state.reader.userId, R + "change#Interview", {workEffortId, durationMinutes: 30})),
            otherChange: code(run(state.recruiterB.userId, R + "change#Interview", {workEffortId, durationMinutes: 30})),
            before: event()
        }
        out.changed = run(state.recruiter.userId, R + "change#Interview", {
            workEffortId,
            startDate: new Date(startMs + 3600000),
            durationMinutes: 30,
            location: "Room 5"
        })
        out.after = event()
        out.cancelled = run(state.recruiter.userId, R + "cancel#Interview", {workEffortId, reason: "The candidate asked"})
        out.afterCancel = event()
        out.again = code(run(state.recruiter.userId, R + "cancel#Interview", {workEffortId}))
        out.startMs = startMs
        return out
    },
    then(r) {
        r.scheduled.error == ""
        r.access.canView && !r.access.canEdit && r.access.isOrganizer
        r.access.managedBy == "its application's interviews in People"
        r.moved.includes("is changed on its application's interviews in People")
        r.cancelledOnCommons.includes("is changed on its application's interviews in People")
        r.anaAdd.includes("not put in a calendar")
        r.readerChange == "PERMISSION_DENIED"
        r.otherChange == "RECORD_UNAVAILABLE"
        Number(String(r.before.estimatedStartDate)) == r.startMs && r.before.location == "Room 4"
        r.changed.error == ""
        Number(String(r.after.estimatedStartDate)) == r.startMs + 3600000
        Number(String(r.after.estimatedCompletionDate)) == r.startMs + 3600000 + 30 * 60000
        r.after.location == "Room 5"
        r.cancelled.error == ""
        r.afterCancel.statusId == "WeCancelled"
        r.again == "INTERVIEW_CANCELLED"
    }
})

// F358 (People follow-up 1, Nov 12, 2026): an interview's invitations go once its schedule, change or cancel commits, as the
// system, in a transaction of their own (send#InterviewInvitations, by tx-commit rules). Sent inside the change's transaction, a
// failing send marked it rollback-only, so the change was undone while the screen said it was made. Its review: a send that leaves
// an attendee untold (here the candidate, emailed from the organizer's address, which the recruiter does not have yet) is recorded
// on the interview, shown to its recruiters alone, and a recruiter sends again, telling only who was missed
feature(
    "an interview's invitations go once its change commits; a failed send is recorded for its recruiters, who send it again",
    {
        when() {
            const scheduled = run(state.recruiter.userId, R + "schedule#Interview", {
                employmentApplicationId: state.cara,
                startDate: nextWeek(),
                durationMinutes: 45,
                panelPartyIds: state.ana.partyId,
                location: "Room 6",
                inviteCandidate: true
            })
            const workEffortId = scheduled.workEffortId
            const candidateId = application(state.cara).applyingPartyId
            const partyRow = partyId => () =>
                ec.entity
                    .find("mantle.work.effort.WorkEffortParty")
                    .condition({workEffortId, partyId})
                    .disableAuthz()
                    .useCache(false)
                    .one() || {}
            const anaRow = partyRow(state.ana.partyId)
            const caraRow = partyRow(candidateId)
            const event = () =>
                ec.entity.find("mantle.work.effort.WorkEffort").condition("workEffortId", workEffortId).disableAuthz().one()
            const interview = () =>
                ec.entity
                    .find("mantle.humanres.recruitment.ApplicationInterview")
                    .condition("workEffortId", workEffortId)
                    .disableAuthz()
                    .useCache(false)
                    .one()
            const row = username =>
                (run(username, R + "get#Application", {employmentApplicationId: state.cara}).application?.interviews || []).find(
                    item => item.workEffortId == workEffortId
                ) || {}
            ec.factory.waitWorkerPoolEmpty(50)
            const invited = anaRow()
            const failed = interview()
            // the change in a transaction of its own, read before it commits: nothing has been sent yet
            let inside = null
            ec.transaction.runRequireNew(null, "Recruit spec change", () => {
                login(state.recruiter.userId)
                ec.artifactExecution.disableAuthz()
                try {
                    ec.service
                        .sync()
                        .name(R + "change#Interview")
                        .parameters({workEffortId, location: "Room 7"})
                        .call()
                    inside = {error: ec.message.hasError() ? ec.message.getErrorsString() : "", digest: anaRow().invitationDigest}
                } finally {
                    login("john.doe")
                    ec.artifactExecution.disableAuthz()
                }
            })
            ec.factory.waitWorkerPoolEmpty(50)
            const told = anaRow()
            const changed = event()
            const recruiterView = row(state.recruiter.userId)
            const panelView = row(state.ana.userId)
            // Send again, once the recruiter has an address to send from: the candidate alone is told
            const account = {userId: state.recruiter.userId}
            call("update#moqui.security.UserAccount", Object.assign({emailAddress: "recruiter.spec@example.test"}, account))
            const other = code(run(state.recruiterB.userId, R + "send#InterviewInvitations", {workEffortId}))
            const again = run(state.recruiter.userId, R + "send#InterviewInvitations", {workEffortId})
            call("update#moqui.security.UserAccount", Object.assign({emailAddress: null}, account))
            const notInterview = code(
                run(state.recruiter.userId, R + "send#InterviewInvitations", {workEffortId: "RECRUIT_SPEC_NONE"})
            )
            return {
                scheduled,
                invited,
                failed,
                inside,
                told,
                changed,
                recruiterView,
                panelView,
                other,
                again,
                sent: interview(),
                anaAfter: anaRow(),
                cara: caraRow(),
                notInterview
            }
        },
        then(r) {
            r.scheduled.error == ""
            r.invited.invitationSentDate != null && r.invited.invitationDigest.length > 0
            r.failed.invitationSendStatus == "failed" && r.failed.invitationSendError.includes("Cara Candidate")
            r.failed.invitationSendError.includes("no email address of the organizer to send from")
            r.inside.error == "" && r.inside.digest == r.invited.invitationDigest
            r.changed.location == "Room 7"
            r.told.invitationDigest != r.invited.invitationDigest
            r.recruiterView.invitationsFailed == true && r.recruiterView.invitationProblemText.includes("Cara Candidate")
            r.panelView.invitationsFailed == false && r.panelView.invitationProblemText == ""
            r.other == "RECORD_UNAVAILABLE"
            r.again.error == "" && r.again.invitationsSent == true && r.again.invitationProblem == null
            r.sent.invitationSendStatus == "sent" && r.sent.invitationSendError == null
            r.cara.invitationSentDate != null
            // Ana, told already, is not told again
            String(r.anaAfter.invitationSentDate) == String(r.told.invitationSentDate)
            r.notInterview == "RECORD_UNAVAILABLE"
        }
    }
)

// Commons calendar review (Nov 12, 2026): a cancelled interview's video call link takes no one more. The recruiter who scheduled
// it revokes it with the framework's revoke#CallLink (its guests removed at once); another recruiter of the employer closes it as
// the system (the link revoked, so its token and its guests are refused, and its guests' credentials ended for the call's minute
// job)
feature("a cancelled interview's video call link is closed, by the recruiter who made it or another of the employer", {
    when() {
        const schedule = () =>
            run(state.recruiter.userId, R + "schedule#Interview", {
                employmentApplicationId: state.cara,
                startDate: nextWeek(),
                durationMinutes: 30,
                panelPartyIds: state.ana.partyId,
                videoCall: true
            })
        const linkIdOf = workEffortId =>
            ec.entity
                .find("mantle.humanres.recruitment.ApplicationInterview")
                .condition("workEffortId", workEffortId)
                .disableAuthz()
                .one().callLinkId
        const guestOf = callLinkId =>
            call("create#moqui.call.CallGuest", {
                callLinkId,
                displayName: "Recruit spec candidate",
                credentialHash: "recruit-spec-" + callLinkId,
                credentialExpiry: new Date(Number(String(ec.user.nowTimestamp)) + 4 * 3600000),
                createdDate: ec.user.nowTimestamp
            }).callGuestId
        const tokenValid = scheduled =>
            call("org.moqui.call.CallServices.check#CallLinkToken", {token: String(scheduled.callPath).split("/").pop()}).valid
        const row = (entity, field, id) => ec.entity.find(entity).condition(field, id).disableAuthz().one()
        const out = {}
        const colleague = user("RECRUITER_2", orgA, ["PEOPLE_RECRUIT_VIEW", "PEOPLE_RECRUIT_EDIT"])
        for (const [key, canceller] of [
            ["mine", state.recruiter],
            ["other", colleague]
        ]) {
            const scheduled = schedule()
            const callLinkId = linkIdOf(scheduled.workEffortId)
            const callGuestId = guestOf(callLinkId)
            const validBefore = tokenValid(scheduled)
            const cancelled = run(canceller.userId, R + "cancel#Interview", {workEffortId: scheduled.workEffortId})
            out[key] = {
                scheduled,
                validBefore,
                cancelled,
                validAfter: tokenValid(scheduled),
                link: row("moqui.call.CallLink", "callLinkId", callLinkId),
                guest: row("moqui.call.CallGuest", "callGuestId", callGuestId),
                nowMs: Number(String(ec.user.nowTimestamp))
            }
        }
        return out
    },
    then({mine, other}) {
        mine.scheduled.error == "" && mine.validBefore == true
        mine.cancelled.error == ""
        mine.link.revokedDate != null
        mine.guest.revokedDate != null
        mine.validAfter == false
        other.scheduled.error == "" && other.validBefore == true
        other.cancelled.error == ""
        other.link.revokedDate != null
        Number(String(other.guest.credentialExpiry)) <= other.nowMs
        other.validAfter == false
    }
})

feature(
    "follow-up 3: an interview's room is booked through the resource booking (a clash Busy, a blackout refused), moved, changed and cancelled with it",
    {
        when() {
            const room = prefix + "_ROOM"
            const annex = prefix + "_ANNEX"
            for (const [facilityId, facilityName] of [
                [room, "Recruit spec room"],
                [annex, "Recruit spec annex"]
            ])
                call("create#mantle.facility.Facility", {
                    facilityId,
                    facilityTypeEnumId: "FcTpRoom",
                    facilityName,
                    bookable: "Y",
                    ownerPartyId: orgA
                })
            const base = Number(String(nextWeek()))
            const at = hours => new Date(base + hours * 3600000)
            // john.doe's meeting in the room 12:00 to 13:00, which the recruiter may not see; the annex blacked out 15:00 to 17:00
            const meeting = call("mantle.work.EventServices.create#Event", {
                workEffortName: "Recruit spec board meeting",
                visibilityEnumId: "WevRestricted",
                estimatedStartDate: at(2),
                estimatedCompletionDate: at(3)
            }).workEffortId
            call("mantle.work.EventServices.book#Resource", {workEffortId: meeting, facilityId: room})
            call("create#mantle.work.effort.ResourceUnavailability", {
                unavailabilityKindEnumId: "RukPlanned",
                facilityId: annex,
                organizationPartyId: orgA,
                fromDate: at(5),
                thruDate: at(7),
                unavailabilityReasonEnumId: "RurClosure",
                plannedOutage: "Y",
                description: "Recruit spec painting",
                revision: 1
            })
            const interviews = () =>
                ec.entity
                    .find("mantle.humanres.recruitment.ApplicationInterview")
                    .condition("employmentApplicationId", state.cara)
                    .disableAuthz()
                    .count()
            const bookings = workEffortId =>
                Array.from(
                    ec.entity
                        .find("mantle.work.effort.WorkEffortFacility")
                        .condition("workEffortId", workEffortId)
                        .disableAuthz()
                        .list()
                ).map(row => row.facilityId + " " + row.statusId)
            const event = workEffortId =>
                ec.entity.find("mantle.work.effort.WorkEffort").condition("workEffortId", workEffortId).disableAuthz().one()
            const schedule = (hours, facilityId) =>
                run(state.recruiter.userId, R + "schedule#Interview", {
                    employmentApplicationId: state.cara,
                    startDate: at(hours),
                    durationMinutes: 60,
                    panelPartyIds: state.ana.partyId,
                    facilityId
                })
            const change = (workEffortId, parameters) =>
                run(state.recruiter.userId, R + "change#Interview", Object.assign({workEffortId}, parameters))
            const before = interviews()
            const out = {clash: schedule(2.5, room)}
            out.clashKept = interviews() == before
            const booked = schedule(3, room)
            const id = booked.workEffortId
            out.booked = booked.error
            out.bookedRows = bookings(id)
            out.place = event(id).location
            out.row = (
                run(state.recruiter.userId, R + "get#Application", {employmentApplicationId: state.cara}).application
                    .interviews || []
            ).find(row => row.workEffortId == id)
            // on Commons' booking services only the interview's organizer books for it (check#EventAccess canBook,
            // impl-maintenance F356): a panel member, an attendee, is refused
            out.direct = run(state.ana.userId, "mantle.work.EventServices.book#Resource", {
                workEffortId: id,
                facilityId: annex
            }).error
            out.intoMeeting = change(id, {startDate: at(2)}).error
            out.intoBlackout = code(change(id, {startDate: at(5), facilityId: annex}))
            out.unchanged = [Number(String(event(id).estimatedStartDate)) == at(3).getTime(), bookings(id)]
            out.annex = change(id, {startDate: at(4), facilityId: annex}).error
            out.annexRows = bookings(id)
            out.annexPlace = event(id).location
            out.cancelled = run(state.recruiter.userId, R + "cancel#Interview", {workEffortId: id}).error
            out.cancelledRows = bookings(id)
            return out
        },
        then(out) {
            code(out.clash) == "ROOM_UNAVAILABLE"
            out.clash.error.includes("Busy") && !out.clash.error.includes("board meeting")
            out.clashKept == true
            out.booked == ""
            out.bookedRows == [prefix + "_ROOM WefAssigned"]
            out.place == "Recruit spec room"
            out.row.roomName == "Recruit spec room" && out.row.roomStatus == "booked"
            out.direct.includes("Only the organizer")
            out.intoMeeting.includes("ROOM_UNAVAILABLE") &&
                out.intoMeeting.includes("Busy") &&
                !out.intoMeeting.includes("board meeting")
            out.intoBlackout == "ROOM_UNAVAILABLE"
            out.unchanged == [true, [prefix + "_ROOM WefAssigned"]]
            out.annex == ""
            out.annexRows == [prefix + "_ANNEX WefAssigned"]
            out.annexPlace == "Recruit spec annex"
            out.cancelled == "" && out.cancelledRows.length == 0
        }
    }
)
