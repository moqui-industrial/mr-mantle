/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * The confirmed address (mr-pass plan/design-smithy.md §5.5, D17): a public account's current email address has a
 * moqui.security.public.VerifiedAddress row with verifiedAt; an internal account (one in a user group besides
 * ALL_USERS, as ForumCore.internalParty tells them apart), whose address its organization gave it, needs only to have
 * one. Every Smithy write and every push by a Smithy role needs it.
 * Entity access is privileged here: the caller has checked who asks.
 */
/* Whether the account of userId (the signed-in one when not given) has a confirmed address. */
function confirmed(userId) {
    const id = userId || ec.user.userId
    if (!id) return false
    const account = ec.entity.find("moqui.security.UserAccount").condition("userId", id).disableAuthz().one()
    const email = String(account?.emailAddress || "").toLowerCase()
    if (!email) return false
    if (
        account.partyId &&
        ec.resource.script("component://mr-mantle/service/mantle/forum/ForumCore.js").internalParty(account.partyId)
    )
        return true
    return Array.from(ec.entity.find("moqui.security.public.VerifiedAddress").condition("userId", id).disableAuthz().list()).some(
        row => !!row.verifiedAt && String(row.emailAddress || "").toLowerCase() === email
    )
}
/* Refuses a signed-in account without a confirmed address (addressUnconfirmed). */
function requireConfirmed() {
    if (confirmed()) return
    const e = new Error("addressUnconfirmed: Confirm your email address to continue")
    e.moquiErrorKind = "Unauthorized"
    throw e
}
;({confirmed, requireConfirmed})
