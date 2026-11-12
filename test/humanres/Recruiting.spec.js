// People's recruiting (mantle.humanres.RecruitingServices, Recruiting.js; impl-people P16, design-people §5, PE-04, PE-24): an
// opening only on an approved active seat of its employer (a planned seat and another employer's refused), changed by a
// recruiter with PEOPLE_RECRUIT_EDIT and not another employer's; applications to an open opening alone, a second open one of
// the same person flagged as a possible duplicate; a bulk stage change names its failure and moves the rest, Interview needs
// an interview and Hired is never a stage change; an interview is a private event with a video call link and its panel's
// scorecards, each panel member answering their own once and reading their own scorecard only, never another opening's
// candidates, their interviews on My interviews; an application by mail once, from the opening's plus tag when the rule's owner
// is its recruiting owner, with its resume, and nothing from a rule of anyone else.
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
                board: run(state.recruiter.userId, R + "find#Applications", {jobOpeningId: state.openingId})
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
            danProjection: run(state.recruiterB.userId, R + "get#InterviewProjection", {checkOnly: true})
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
            ec.resource.getLocationReference(r.files[0].contentLocation).getText().includes("five years in retail")
        }
    }
)
