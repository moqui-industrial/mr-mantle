// The survey builder's form definitions (mantle.party.FormDefinitionServices, FormDefinitions.js; impl-people P16, F51, F62): a
// form of a registered purpose is built only with the permission its purpose's registration names (mantle.party.FormPurpose),
// for an organization of the user's for it: People's interview scorecard by a PEOPLE_CONFIGURE holder of the employer, refused
// to a SUPPORT_POLICY_EDIT holder, whose case feedback form the People holder may not make; another employer's holder is
// refused the form and the employer; a form with no field does not publish. A form of a People purpose takes no publication,
// public or by invitation, and its invitations carry no link, while a case feedback form takes an invited publication and no
// public one. find#Forms lists each user the purposes they read: the People holder's scorecard, never the feedback form. P16
// review: a form of a purpose the user does not read is refused as a missing one, and Customer Service's purposes are built only
// through their own services (the case rules), never the generic ones, whatever the user holds.
// Standalone: spec-local organizations, people, employments, groups and users, artifact authorization disabled (the rules are
// the services' own checks). Customer Service's own form rules are CaseFeedback's and SupportTemplates' specs.
// Run: ./moq test mr-mantle --spec FormDefinitions
const prefix = "FORM_DEFS_SPEC"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    since = "2001-01-01T00:00:00Z"
const F = "mantle.party.FormDefinitionServices."
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
function organization(partyId, name) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
// a person employed by the organization, with an account holding the permissions
function user(kind, organizationPartyId, permissions) {
    const partyId = prefix + "_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Forms", lastName: kind})
    call("mantle.humanres.EmploymentServices.create#Employment", {
        fromPartyId: partyId,
        toPartyId: organizationPartyId,
        fromDate: since
    })
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Form definitions " + kind})
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
    return id
}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(orgA, "Form Definitions Spec A")
        organization(orgB, "Form Definitions Spec B")
        state.people = user("PEOPLE", orgA, ["PEOPLE_CONFIGURE"])
        state.support = user("SUPPORT", orgA, ["SUPPORT_POLICY_EDIT", "SUPPORT_CASE_EDIT"])
        state.peopleB = user("PEOPLE_B", orgB, ["PEOPLE_CONFIGURE"])
        state.recruiter = user("RECRUITER", orgA, ["PEOPLE_RECRUIT_VIEW"])
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
        ec.artifactExecution.enableAuthz()
    }
})

feature(
    "a scorecard is built and published by its purpose's permission holder; another purpose's holder and another employer are refused",
    {
        when() {
            const made = run(state.people, F + "create#Form", {
                purposeEnumId: "DbfpInterviewScorecard",
                organizationPartyId: orgA,
                description: "Store interview"
            })
            const formId = made.formId
            state.formId = formId
            const empty = code(run(state.people, F + "publish#Form", {formId}))
            const rating = run(state.people, F + "save#FormField", {
                formId,
                title: "Overall",
                fieldTypeEnumId: "DBFFT_radio",
                isRequired: "Y",
                optionText: "1 | 1 - No hire\n2 | 2 - Lean no\n3 | 3 - Lean yes\n4 | 4 - Hire"
            })
            const evidence = run(state.people, F + "save#FormField", {
                formId,
                title: "Evidence",
                fieldTypeEnumId: "DBFFT_text-area"
            })
            const published = run(state.people, F + "publish#Form", {formId})
            const read = run(state.recruiter, F + "get#Form", {formId})
            return {
                made,
                empty,
                rating,
                evidence,
                published,
                read,
                otherPurpose: code(run(state.support, F + "save#FormField", {formId, title: "Theirs"})),
                otherPurposeRead: code(run(state.support, F + "get#Form", {formId})),
                feedbackByPeople: code(
                    run(state.people, F + "create#Form", {
                        purposeEnumId: "DbfpCaseFeedback",
                        organizationPartyId: orgA,
                        description: "Not mine"
                    })
                ),
                otherEmployer: code(run(state.peopleB, F + "save#FormField", {formId, title: "Theirs"})),
                otherEmployerCreate: code(
                    run(state.peopleB, F + "create#Form", {
                        purposeEnumId: "DbfpInterviewScorecard",
                        organizationPartyId: orgA,
                        description: "A's"
                    })
                ),
                unregistered: code(
                    run(state.people, F + "create#Form", {
                        purposeEnumId: "DbfpUnknownSpec",
                        organizationPartyId: orgA,
                        description: "None"
                    })
                ),
                readerEdits: code(run(state.recruiter, F + "save#FormField", {formId, title: "Mine"}))
            }
        },
        then(r) {
            r.made.error == ""
            r.empty == "FORM_INVALID"
            r.rating.error == ""
            r.evidence.error == ""
            r.published.error == ""
            r.published.publishedFieldNames.length == 2
            r.read.error == ""
            r.read.form.purposeText == "Interview scorecard"
            r.read.form.fields.map(field => field.title).join(",") == "Overall,Evidence"
            r.read.form.canEdit == false
            r.read.form.editFields == null
            r.otherPurpose == "RECORD_UNAVAILABLE"
            r.otherPurposeRead == "RECORD_UNAVAILABLE"
            r.feedbackByPeople == "PERMISSION_DENIED"
            r.otherEmployer == "RECORD_UNAVAILABLE"
            r.otherEmployerCreate == "RECORD_UNAVAILABLE"
            r.unregistered == "PURPOSE_UNAVAILABLE"
            r.readerEdits == "PERMISSION_DENIED"
        }
    }
)

feature("a People form takes no publication and its invitations no link; a case feedback form an invited publication only", {
    when() {
        const feedback = run(state.support, "mantle.request.CaseFeedbackServices.create#FeedbackForm", {
            organizationPartyId: orgA,
            description: "Spec feedback",
            scale: 5
        })
        run(state.support, "mantle.request.CaseFeedbackServices.publish#FeedbackForm", {formId: feedback.formId})
        const P = "mantle.party.FormPublicationServices.open#Publication"
        const publications = ec.resource.script("component://mr-mantle/service/mantle/party/FormPublication.js")
        return {
            scorecardPublic: code(run(state.people, P, {formId: state.formId, accessEnumId: "FpaAnonymous"})),
            scorecardInvited: code(run(state.people, P, {formId: state.formId, accessEnumId: "FpaInvited"})),
            scorecardLink: publications.linkAllowed(state.formId),
            feedbackPublic: code(run(state.support, P, {formId: feedback.formId, accessEnumId: "FpaAnonymous"})),
            feedbackInvited: run(state.support, P, {formId: feedback.formId, accessEnumId: "FpaInvited"}),
            feedbackLink: publications.linkAllowed(feedback.formId),
            peopleList: run(state.people, F + "find#Forms", {
                purposeEnumIds: ["DbfpInterviewScorecard", "DbfpReview", "DbfpTrainingAssessment", "DbfpExitInterview"],
                organizationPartyId: orgA
            }),
            peopleFeedbackList: code(run(state.people, F + "find#Forms", {purposeEnumIds: ["DbfpCaseFeedback"]})),
            supportList: run(state.support, F + "find#Forms", {purposeEnumIds: ["DbfpCaseFeedback"], organizationPartyId: orgA}),
            feedbackFormId: feedback.formId,
            // the case rules (every field customer-visible, the rating) are CaseFeedback's: the generic services refuse the purpose
            genericField: code(
                run(state.support, F + "save#FormField", {
                    formId: feedback.formId,
                    title: "Internal",
                    audienceEnumId: "CfaInternal"
                })
            ),
            genericCreate: code(
                run(state.support, F + "create#Form", {
                    purposeEnumId: "DbfpCaseFeedback",
                    organizationPartyId: orgA,
                    description: "Generic"
                })
            )
        }
    },
    then(r) {
        r.scorecardPublic == "PUBLICATION_NOT_OFFERED"
        r.scorecardInvited == "PUBLICATION_NOT_OFFERED"
        r.scorecardLink == false
        r.feedbackPublic == "PUBLICATION_NOT_OFFERED"
        r.feedbackInvited.error == ""
        r.feedbackInvited.publicationId != null
        r.feedbackLink == true
        r.peopleList.error == ""
        r.peopleList.forms.map(form => form.formId).join(",") == state.formId
        r.peopleList.purposes.length == 4
        r.peopleList.purposes.every(purpose => purpose.canEdit)
        r.peopleFeedbackList == "PERMISSION_DENIED"
        r.supportList.forms.map(form => form.formId).join(",") == r.feedbackFormId
        r.genericField == "PURPOSE_UNAVAILABLE"
        r.genericCreate == "PURPOSE_UNAVAILABLE"
    }
})
