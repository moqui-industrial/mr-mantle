// Commons form publication and invitations (design-drawers-commons §19, crosscut X16; impl-customer-service P13 builds them
// under the owner-contract rule): the publication of a dated DbForm by an organization for a purpose, and the guard that keeps
// a response that answers a FormInvitation as submitted. An app's own services (Customer Service's CaseFeedback.js; later
// Marketing's, Sales' and People's) make the invitations, send them and take their answers; the link is an
// ExternalAccessCapability of the FormInvitation record kind (ExternalAccess.js). Refusals carry reason codes.
// impl-people P16 (F51): a publication takes only the access kinds its form's purpose registration lists (mantle.party.FormPurpose
// accessEnumIds); a purpose that lists none (People's: the interview scorecard, the review, the training assessment, the exit
// interview) is answered only by the respondents an app's service assigns, so it has no publication and no link at all.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, call, denied} = lib

const PUBLICATION = "mantle.party.FormPublication",
    INVITATION = "mantle.party.FormInvitation"
const forms = () => ec.resource.script("component://mr-mantle/service/mantle/party/FormDefinitions.js")

// Whether a form's purpose admits a publication of the access kind (FpaInvited, FpaAnonymous, FpaAccount): refused
// (PUBLICATION_NOT_OFFERED) for a purpose whose registration lists it not, or none.
function requireAccess(formId, accessEnumId) {
    const form = formId ? one("moqui.screen.form.DbForm", {formId}) : null
    const registration = form ? forms().registrationOf(form.purposeEnumId) : null
    if (!registration || !forms().accessKinds(registration).includes(accessEnumId))
        denied("PUBLICATION_NOT_OFFERED", "This form is answered only by the people assigned to it, never by a link")
}
// Whether an invitation of the form may carry a link (an invited recipient's): its purpose admits invited recipients.
function linkAllowed(formId) {
    const form = formId ? one("moqui.screen.form.DbForm", {formId}) : null
    const registration = form ? forms().registrationOf(form.purposeEnumId) : null
    return !!registration && forms().accessKinds(registration).includes("FpaInvited")
}

// The organization's open publication of a form for a purpose, made once (invited recipients, one response each, from now).
function publicationFor(organizationPartyId, formId, purposeEnumId, description = null) {
    requireAccess(formId, "FpaInvited")
    const open = rows(PUBLICATION, {organizationPartyId, formId, purposeEnumId}).find(
        row => row.thruDate == null || Number(lib.ms(row.thruDate)) > Number(lib.ms(ec.user.nowTimestamp))
    )
    if (open) return open.publicationId
    return call("create#" + PUBLICATION, {
        organizationPartyId,
        formId,
        purposeEnumId,
        accessEnumId: "FpaInvited",
        repeatEnumId: "FprOnce",
        description,
        fromDate: ec.user.nowTimestamp,
        createdDate: ec.user.nowTimestamp,
        createdByUserId: ec.user.userId || null
    }).publicationId
}
// open#Publication: the editor of a published form (its purpose's edit permission and organization) offers it from now with an
// access kind its purpose admits (PUBLICATION_NOT_OFFERED otherwise: a private purpose takes no publication), for its
// registered publication purpose, once per form and access kind while open.
function openPublication(p) {
    const definitions = forms()
    const form = definitions.formOf(p.formId)
    const accessEnumId = String(p.accessEnumId || "FpaInvited")
    requireAccess(form.formId, accessEnumId)
    const registration = definitions.registrationOf(form.purposeEnumId)
    if (!definitions.formAt(form.formId, null, false).length) denied("FORM_NOT_PUBLISHED", "Publish the form's questions first")
    const purposeEnumId = registration.publicationPurposeEnumId || null
    const nowMs = Number(lib.ms(ec.user.nowTimestamp))
    const open = rows(PUBLICATION, {organizationPartyId: form.ownerPartyId, formId: form.formId, accessEnumId}).find(
        row => row.thruDate == null || Number(lib.ms(row.thruDate)) > nowMs
    )
    if (open) return {publicationId: open.publicationId}
    return {
        publicationId: call("create#" + PUBLICATION, {
            organizationPartyId: form.ownerPartyId,
            formId: form.formId,
            purposeEnumId,
            accessEnumId,
            repeatEnumId: "FprOnce",
            description: p.description || form.description || null,
            fromDate: ec.user.nowTimestamp,
            createdDate: ec.user.nowTimestamp,
            createdByUserId: ec.user.userId || null
        }).publicationId
    }
}
// The invitation a response answers, or null.
const invitationOf = formResponseId => (formResponseId ? find(INVITATION, {formResponseId}).one() : null)
// The guard (FormPublication.eecas.xml): a write of a response, or of its answers, that answers an invitation is refused.
function guardResponse(formResponseId) {
    if (invitationOf(formResponseId))
        denied("RESPONSE_LOCKED", "Response " + formResponseId + " answers an invitation and is kept as it was submitted")
}
// The invitation's guard (FormPublication.eecas.xml): once an invitation has its response, the link is kept, so unlinking it
// (a change of formResponseId) or deleting the invitation cannot take its response past guardResponse.
function guardInvitation(invitationId, formResponseId, originalFormResponseId, deleting = false) {
    if (originalFormResponseId && (deleting || formResponseId !== originalFormResponseId))
        denied(
            "RESPONSE_LOCKED",
            "Invitation " + invitationId + " has its response " + originalFormResponseId + " and is kept with it"
        )
}
;({
    publicationFor,
    invitationOf,
    guardResponse,
    guardInvitation,
    requireAccess,
    linkAllowed,
    execute(op, parameters) {
        if (op !== "openPublication") throw new Error("Unknown form publication operation " + op)
        const wasDisabled = ec.artifactExecution.disableAuthz()
        try {
            return openPublication(parameters || {})
        } finally {
            if (!wasDisabled) ec.artifactExecution.enableAuthz()
        }
    }
})
