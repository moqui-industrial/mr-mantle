// Commons' form publication (mantle.party.FormPublicationServices store#, preview#, close#Publication, create#Invitations,
// accept#Submission; FormPublication.js; impl-marketing P12, F20, F70): a publication opens only a published form, by an access kind its
// purpose admits; a draft or closed one takes no answer; an answer naming a field the form does not have, or answering a question its
// rules hide, is refused; a page's request key makes one submission (the same answers answer the first, others are refused); an
// invitation answers once and its response, like a public one, is kept as submitted; a response reads its form, and its options'
// scores, as of its submission.
// Standalone: a spec-local purpose registration (its own permission, invited and public access, every field customer-visible), an
// organization, an employed editor; answers sent as an anonymous visitor. Marketing's wrappers are test/marketing/MarketingForms.
// Run: ./moq test mr-mantle --spec FormPublications
const prefix = "FORM_PUBS_SPEC"
const org = prefix + "_ORG",
    since = "2001-01-01T00:00:00Z"
const F = "mantle.party.FormDefinitionServices."
const P = "mantle.party.FormPublicationServices."
const PURPOSE = "DbfpFormPubsSpec",
    PUBLICATION_PURPOSE = "FppFormPubsSpec",
    PERMISSION = "FORM_PUBS_SPEC_EDIT"
const forms = ec.resource.script("component://mr-mantle/service/mantle/party/FormDefinitions.js")
const state = {}
const key = () => "fps" + ec.user.randomString(12).replace(/[^A-Za-z0-9]/g, "x")

function run(username, service, parameters = {}) {
    if (username) login(username)
    else logout()
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
const visitor = parameters => run(null, P + "accept#Submission", parameters)
const one = (entity, fields) => ec.entity.find(entity).condition(fields).disableAuthz().one()
const count = (entity, fields) => ec.entity.find(entity).condition(fields).disableAuthz().count()

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        call("create#moqui.basic.Enumeration", {
            enumId: PURPOSE,
            enumTypeId: "DbFormPurpose",
            description: "Form publications spec"
        })
        call("create#moqui.basic.Enumeration", {
            enumId: PUBLICATION_PURPOSE,
            enumTypeId: "FormPublicationPurpose",
            description: "Spec"
        })
        call("create#moqui.security.UserPermission", {userPermissionId: PERMISSION, description: "Form publications spec edit"})
        call("create#mantle.party.FormPurpose", {
            purposeEnumId: PURPOSE,
            publicationPurposeEnumId: PUBLICATION_PURPOSE,
            editPermission: PERMISSION,
            viewPermission: PERMISSION,
            accessEnumIds: "FpaInvited,FpaAnonymous",
            formNoun: "form",
            fieldAudienceEnumId: "CfaCustomer"
        })
        call("create#mantle.party.Party", {partyId: org, partyTypeEnumId: "PtyOrganization", ownerPartyId: org})
        call("create#mantle.party.Organization", {partyId: org, organizationName: "Form Publications Spec"})
        call("create#mantle.party.PartyRole", {partyId: org, roleTypeId: "OrgInternal"})
        const partyId = prefix + "_EDITOR"
        call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
        call("create#mantle.party.Person", {partyId, firstName: "Publications", lastName: "Editor"})
        call("mantle.humanres.EmploymentServices.create#Employment", {fromPartyId: partyId, toPartyId: org, fromDate: since})
        // the editor holds the purpose's permission; the outsider, employed by the same organization, does not
        for (const [kind, permissions] of [
            ["EDITOR", [PERMISSION]],
            ["OUTSIDER", []]
        ]) {
            const userPartyId = prefix + "_" + kind
            if (kind !== "EDITOR") {
                call("create#mantle.party.Party", {partyId: userPartyId, partyTypeEnumId: "PtyPerson"})
                call("create#mantle.party.Person", {partyId: userPartyId, firstName: "Publications", lastName: kind})
                call("mantle.humanres.EmploymentServices.create#Employment", {
                    fromPartyId: userPartyId,
                    toPartyId: org,
                    fromDate: since
                })
            }
            const id = (state[kind.toLowerCase()] = prefix + "_U_" + kind)
            call("create#moqui.security.UserGroup", {userGroupId: id, description: "Form publications " + kind})
            for (const userPermissionId of permissions)
                call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId, fromDate: since})
            call("create#moqui.security.UserAccount", {
                userId: id,
                username: id,
                partyId: userPartyId,
                currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
                passwordHashType: "SHA"
            })
            call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: since})
        }
        call("create#mantle.party.Party", {partyId: prefix + "_GUEST", partyTypeEnumId: "PtyPerson"})
        call("create#mantle.party.Person", {partyId: prefix + "_GUEST", firstName: "Invited", lastName: "Guest"})
        // the form: a scored choice, a text it shows only for "yes", and an optional comment
        state.formId = run(state.editor, F + "create#Form", {
            purposeEnumId: PURPOSE,
            organizationPartyId: org,
            description: "Visit"
        }).formId
        run(state.editor, F + "save#FormField", {
            formId: state.formId,
            newFieldName: "liked",
            title: "Did you like it?",
            fieldTypeEnumId: "DBFFT_radio",
            isRequired: "Y",
            optionText: "yes | Yes | 2\nno | No | 0"
        })
        run(state.editor, F + "save#FormField", {formId: state.formId, newFieldName: "what", title: "What did you like?"})
        run(state.editor, F + "save#FormCondition", {
            formId: state.formId,
            sourceFieldName: "liked",
            operator: "equals",
            value: "yes",
            targetFieldName: "what",
            effect: "show"
        })
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
        ec.artifactExecution.enableAuthz()
    }
})

feature("a publication opens only a published form by an access kind its purpose admits; a draft or closed one takes no answer", {
    when() {
        const formId = state.formId
        const notOffered = code(run(state.editor, P + "store#Publication", {formId, accessEnumId: "FpaAccount"}))
        const early = code(
            run(state.editor, P + "store#Publication", {formId, accessEnumId: "FpaAnonymous", fromDate: ec.user.nowTimestamp})
        )
        const draft = run(state.editor, P + "store#Publication", {formId, accessEnumId: "FpaAnonymous", description: "Draft"})
        const draftAnswer = code(visitor({publicationId: draft.publicationId, requestKey: key(), values: {liked: "no"}}))
        const published = run(state.editor, F + "publish#Form", {formId})
        const fields = forms.formAt(formId, null, false)
        const opened = run(state.editor, P + "store#Publication", {
            publicationId: draft.publicationId,
            fromDate: ec.user.nowTimestamp,
            titleText: "Tell us about your visit",
            introText: "Two questions."
        })
        state.publicationId = draft.publicationId
        const preview = run(state.editor, P + "preview#Publication", {publicationId: draft.publicationId})
        const outsider = code(
            run(state.outsider, P + "store#Publication", {publicationId: draft.publicationId, description: "Mine"})
        )
        // a second publication, closed at once
        const other = run(state.editor, P + "store#Publication", {
            formId,
            accessEnumId: "FpaAnonymous",
            fromDate: ec.user.nowTimestamp
        })
        const closed = run(state.editor, P + "close#Publication", {publicationId: other.publicationId})
        const closedAnswer = code(visitor({publicationId: other.publicationId, requestKey: key(), values: {liked: "no"}}))
        return {notOffered, early, draft, draftAnswer, published, fields, opened, preview, outsider, closed, closedAnswer}
    },
    then(r) {
        r.notOffered === "PUBLICATION_NOT_OFFERED"
        r.early === "FORM_NOT_PUBLISHED"
        r.draft.error === "" && r.draft.created === true
        r.draftAnswer === "PUBLICATION_CLOSED"
        r.published.error === ""
        // every field of the purpose is customer-visible; the choice carries its scores
        r.fields.every(f => f.audienceEnumId === "CfaCustomer")
        r.fields
            .find(f => f.fieldName === "liked")
            .options.map(o => o.score)
            .join() === "2,0"
        r.opened.error === ""
        r.preview.publication.state === "open"
        r.preview.page.title === "Tell us about your visit"
        r.preview.page.fields.map(f => f.fieldName).join() === "liked,what"
        // the page never carries a score
        !JSON.stringify(r.preview.page).includes('"score"')
        r.outsider === "RECORD_UNAVAILABLE"
        r.closed.closed === true
        r.closedAnswer === "PUBLICATION_CLOSED"
    }
})

feature("an unknown field, and an answer to a question its rules hide, are refused; a valid answer is kept", {
    when() {
        const publicationId = state.publicationId
        const before = count("mantle.party.FormSubmission", {publicationId})
        const unknown = code(
            visitor({publicationId, requestKey: key(), values: {liked: "yes", what: "The garden", injected: "x"}})
        )
        const hidden = code(visitor({publicationId, requestKey: key(), values: {liked: "no", what: "Sneaked in"}}))
        const missing = code(visitor({publicationId, requestKey: key(), values: {}}))
        const after = count("mantle.party.FormSubmission", {publicationId})
        const good = visitor({publicationId, requestKey: key(), values: {liked: "yes", what: "The garden"}})
        const submission = one("mantle.party.FormSubmission", {formSubmissionId: good.formSubmissionId})
        const answers = Array.from(
            ec.entity
                .find("moqui.screen.form.FormResponseAnswer")
                .condition({formResponseId: good.formResponseId})
                .disableAuthz()
                .list()
        )
        // the public response is kept as submitted, as an invited one is
        const locked = code(
            run("john.doe", "org.moqui.impl.ScreenServices.update#FormResponse", {
                formResponseId: good.formResponseId,
                responseMap: {liked: "no"}
            })
        )
        state.firstResponse = good
        return {before, unknown, hidden, missing, after, good, submission, answers, locked}
    },
    then(r) {
        r.unknown === "FIELD_UNKNOWN"
        r.hidden === "FIELD_HIDDEN"
        r.missing === "FORM_VALUES_INVALID"
        r.after === r.before
        r.good.error === "" && r.good.alreadyApplied === false
        r.submission.statusEnumId === "FsbAccepted" && r.submission.partyId == null && r.submission.invitationId == null
        r.answers.length === 2
        r.locked === "RESPONSE_LOCKED"
    }
})

feature("one request key makes one submission: the same answers answer the first, other answers are refused", {
    when() {
        const publicationId = state.publicationId
        const requestKey = key()
        const first = visitor({publicationId, requestKey, values: {liked: "no"}})
        const again = visitor({publicationId, requestKey, values: {liked: "no"}})
        const changed = code(visitor({publicationId, requestKey, values: {liked: "yes", what: "Changed my mind"}}))
        return {first, again, changed, kept: count("mantle.party.FormSubmission", {formResponseId: first.formResponseId})}
    },
    then(r) {
        r.first.alreadyApplied === false
        r.again.alreadyApplied === true && r.again.formSubmissionId === r.first.formSubmissionId
        r.again.formResponseId === r.first.formResponseId
        r.changed === "REQUEST_KEY_REUSED"
        r.kept === 1
    }
})

feature("an invitation answers once: a second answer from the same invitation is refused, and its response is kept", {
    when() {
        const formId = state.formId
        const invited = run(state.editor, P + "store#Publication", {
            formId,
            accessEnumId: "FpaInvited",
            fromDate: ec.user.nowTimestamp
        })
        const made = run(state.editor, P + "create#Invitations", {
            publicationId: invited.publicationId,
            recipients: [
                {
                    partyId: prefix + "_GUEST",
                    emailAddress: "guest@formpubs.example.test",
                    invitationKey: "fps:" + invited.publicationId
                }
            ]
        })
        const repeated = run(state.editor, P + "create#Invitations", {
            publicationId: invited.publicationId,
            recipients: [{partyId: prefix + "_GUEST", invitationKey: "fps:" + invited.publicationId}]
        })
        const invitationId = made.invitationIds[0]
        const withoutInvitation = code(visitor({publicationId: invited.publicationId, requestKey: key(), values: {liked: "no"}}))
        const first = visitor({
            publicationId: invited.publicationId,
            invitationId,
            requestKey: key(),
            values: {liked: "yes", what: "All"}
        })
        const second = code(
            visitor({publicationId: invited.publicationId, invitationId, requestKey: key(), values: {liked: "no"}})
        )
        const invitation = one("mantle.party.FormInvitation", {invitationId})
        const submission = one("mantle.party.FormSubmission", {formSubmissionId: first.formSubmissionId})
        return {made, repeated, withoutInvitation, first, second, invitation, submission}
    },
    then(r) {
        r.made.createdCount === 1
        r.repeated.createdCount === 0 && r.repeated.invitationIds[0] === r.made.invitationIds[0]
        r.withoutInvitation === "INVITATION_REQUIRED"
        r.first.error === ""
        r.second === "ALREADY_ANSWERED"
        r.invitation.statusEnumId === "FinResponded" && r.invitation.formResponseId === r.first.formResponseId
        r.submission.partyId === prefix + "_GUEST"
    }
})

feature("a response reads its form and its options' scores as of its submission after an option changes", {
    when() {
        const formId = state.formId
        const response = state.firstResponse
        const submitted = one("mantle.party.FormSubmission", {formSubmissionId: response.formSubmissionId}).submittedDate
        // later: the choice's "yes" relabelled and rescored, from now
        const changed = run(state.editor, F + "save#FormField", {
            formId,
            fieldName: "liked",
            title: "Did you like it?",
            fieldTypeEnumId: "DBFFT_radio",
            isRequired: "Y",
            optionText: "yes | Loved it | 5\nno | No | 0"
        })
        const map = {liked: "yes", what: "The garden"}
        const then = forms.answersOf(formId, submitted, map).find(a => a.fieldName === "liked")
        const now = forms.answersOf(formId, null, map).find(a => a.fieldName === "liked")
        return {
            changed,
            thenText: then.displayText,
            nowText: now.displayText,
            thenScore: forms.scoreOf(formId, "liked", "yes", submitted),
            nowScore: forms.scoreOf(formId, "liked", "yes", null)
        }
    },
    then(r) {
        r.changed.error === ""
        r.thenText === "Yes"
        r.nowText === "Loved it"
        r.thenScore === 2
        r.nowScore === 5
    }
})
