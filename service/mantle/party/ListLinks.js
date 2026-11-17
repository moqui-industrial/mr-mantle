// A list link's own reach (SEC-PSS-44; mantle.marketing.contact.ContactListToken, ConsentServices.xml): a link expires after
// its list's linkValidDays (365 when the list sets none); it unsubscribes, and it subscribes again only a list it unsubscribed
// itself, within a day of that (the page's undo). Any other subscription by a link is refused: it needs the preference
// page's sign-in. The lists a link unsubscribed are kept on its row (unsubscribedListIds, unsubscribedDate).
const DEFAULT_LINK_DAYS = 365
const UNDO_MS = 86400000

const toMillis = value => {
    if (value == null || value === "") return null
    if (typeof value === "number") return value
    if (value instanceof Date) return value.getTime()
    const number = Number(value)
    return Number.isNaN(number) ? new Date(String(value)).getTime() : number
}
const idsOf = tokenRow =>
    String(tokenRow?.unsubscribedListIds || "")
        .split(",")
        .filter(Boolean)

// The days a new link of the list works.
function linkDays(list) {
    const days = Number(list?.linkValidDays)
    return Number.isFinite(days) && days > 0 ? days : DEFAULT_LINK_DAYS
}
// Whether the link may subscribe the party again to this list: the link unsubscribed it, less than a day ago.
function undoable(tokenRow, contactListId) {
    const at = toMillis(tokenRow?.unsubscribedDate)
    if (at == null || toMillis(ec.user.nowTimestamp) - at > UNDO_MS) return false
    return idsOf(tokenRow).includes(String(contactListId))
}
// Note on the link's row (the caller updates it) the lists it unsubscribed now, and the lists it subscribed again (no
// longer to undo).
function note(tokenRow, unsubscribedIds, resubscribedIds = []) {
    if (!tokenRow || (!unsubscribedIds.length && !resubscribedIds.length)) return
    const kept = idsOf(tokenRow).filter(id => !resubscribedIds.includes(id) && !unsubscribedIds.includes(id))
    tokenRow.set("unsubscribedListIds", kept.concat(unsubscribedIds.map(String)).join(",") || null)
    if (unsubscribedIds.length) tokenRow.set("unsubscribedDate", ec.user.nowTimestamp)
}

;({linkDays, undoable, note, DEFAULT_LINK_DAYS})
