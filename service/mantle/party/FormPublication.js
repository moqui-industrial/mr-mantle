// Commons form publication and invitations (design-drawers-commons §19, crosscut X16; impl-customer-service P13 builds them
// under the owner-contract rule): the publication of a dated DbForm by an organization for a purpose, and the guard that keeps
// a response that answers a FormInvitation as submitted. An app's own services (Customer Service's CaseFeedback.js; later
// Marketing's, Sales' and People's) make the invitations, send them and take their answers; the link is an
// ExternalAccessCapability of the FormInvitation record kind (ExternalAccess.js). Refusals carry reason codes.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, call, denied} = lib

const PUBLICATION = "mantle.party.FormPublication",
    INVITATION = "mantle.party.FormInvitation"

// The organization's open publication of a form for a purpose, made once (invited recipients, one response each, from now).
function publicationFor(organizationPartyId, formId, purposeEnumId, description = null) {
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
;({publicationFor, invitationOf, guardResponse, guardInvitation})
