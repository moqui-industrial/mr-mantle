/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * The confirmed address (mr-pass plan/design-smithy.md §5.5, D17), the one place that reads it.
 * A userId is always given: none answers false. currentVerified() and currentConfirmed() ask of the signed-in account.
 * - verified(userId): the account's current email address has a moqui.security.public.VerifiedAddress row with
 *   verifiedAt: it answered the mail sent to that address. A changed address needs a fresh one. What the forum, the
 *   Account hub, the store's topics and the outside-party self access ask.
 * - confirmed(userId): verified, or an internal account (one in a user group besides ALL_USERS, as
 *   ForumCore.internalParty tells them apart), whose address its organization gave it and which needs only to have
 *   one. Every Smithy write and every push by a Smithy role needs it.
 * Addresses are compared without case or surrounding space. Entity access is privileged here: the caller has checked
 * who asks.
 */
const address = value =>
    String(value || "")
        .trim()
        .toLowerCase()
/* The account of a userId; none for no id, which never stands for the signed-in user. */
const accountOf = userId =>
    typeof userId === "string" && userId
        ? ec.entity.find("moqui.security.UserAccount").condition("userId", userId).disableAuthz().one()
        : null
/* Whether an account row's current address has its verified row. */
function verifiedAccount(account) {
    const email = address(account?.emailAddress)
    if (!email) return false
    return Array.from(
        ec.entity.find("moqui.security.public.VerifiedAddress").condition("userId", account.userId).disableAuthz().list()
    ).some(row => !!row.verifiedAt && address(row.emailAddress) === email)
}
/* Whether the account of userId has verified its current email address; false for no id. */
const verified = userId => verifiedAccount(accountOf(userId))
/* Whether the account of userId has a confirmed address; false for no id. */
function confirmed(userId) {
    const account = accountOf(userId)
    if (!address(account?.emailAddress)) return false
    return internal(account.partyId) || verifiedAccount(account)
}
function internal(partyId) {
    if (!partyId) return false
    const was = ec.artifactExecution.disableAuthz()
    try {
        return ec.resource.script("component://mr-mantle/service/mantle/forum/ForumCore.js").internalParty(partyId)
    } finally {
        if (!was) ec.artifactExecution.enableAuthz()
    }
}
/* The same of the signed-in account; false with no sign-in. */
const currentVerified = () => verified(ec.user.userId)
const currentConfirmed = () => confirmed(ec.user.userId)
/* Refuses a signed-in account without a confirmed address (addressUnconfirmed). */
function requireConfirmed() {
    if (currentConfirmed()) return
    const e = new Error("addressUnconfirmed: Confirm your email address to continue")
    e.moquiErrorKind = "Unauthorized"
    throw e
}
;({verified, confirmed, currentVerified, currentConfirmed, requireConfirmed})
