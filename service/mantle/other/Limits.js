/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * Mantle's count limits (MoquiConf.xml, the mantle element, where each default is written): a whole number, 0 for no
 * limit. One that is missing or not a whole number is refused rather than guessed, and logged naming the setting; the
 * readiness provider mantle.limits (LimitsServices.check#Limits) shows each one that is not a count, so an operator sees
 * it before the calls it bounds fail. */
const NAMES = [
    "shop-payment-calls",
    "shop-payment-forms",
    "shop-renewal-resumes",
    "marketing-reservations-per-offer",
    "marketing-tickets-per-address",
    "forum-drafts-per-member",
    "forum-draft-days",
    "forum-report-exports-per-day",
    "forum-owner-invitations-per-day",
    "forum-archive-reads-per-day"
]
/* Why the setting is not a count, or null. */
function problem(name) {
    const text = ec.factory.getConfValue("mantle@" + name)
    const value = Number(text)
    if (text == null || String(text).trim() === "") return "mantle@" + name + " is not set: a whole number, 0 for no limit"
    if (!Number.isInteger(value) || value < 0)
        return "mantle@" + name + " is not a count (" + String(text).slice(0, 40) + "): a whole number, 0 for no limit"
    return null
}
function limit(name) {
    const refusal = problem(name)
    if (refusal) {
        ec.logger.error("Mantle's limit " + refusal)
        throw new Error(refusal)
    }
    const value = Number(ec.factory.getConfValue("mantle@" + name))
    return value === 0 ? Infinity : value
}
/* The readiness checks: one for each count limit that is not a count, named by its setting; one ready check otherwise. */
function checks() {
    const failed = NAMES.map(name => [name, problem(name)]).filter(([, refusal]) => refusal)
    if (!failed.length)
        return [{checkKey: "mantle.limits", title: "Mantle's count limits", state: "ready", reasonCode: null, message: "Every count limit is a whole number"}]
    return failed.map(([name, refusal]) => {
        ec.logger.error("Mantle's limit " + refusal)
        return {checkKey: "mantle.limits." + name, title: "mantle@" + name, state: "failed", reasonCode: "LIMIT_INVALID", message: refusal}
    })
}
;({NAMES, limit, checks})
