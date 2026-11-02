// This software is in the public domain under CC0 1.0 Universal plus a
// Grant of Patent License.
//
// To the extent possible under law, the author(s) have dedicated all
// copyright and related and neighboring rights to this software to the
// public domain worldwide. This software is distributed without any
// warranty.
//
// You should have received a copy of the CC0 Public Domain Dedication
// along with this software (see the LICENSE.md file). If not, see
// <http://creativecommons.org/publicdomain/zero/1.0/>.

// Shared helpers of the X12 modules (plan/payments-shipping-edi.md E1; X12.js for the envelope and lifecycle,
// X12Documents.js for the business mappings): the connection and its profile, segment text, element values, X12 number
// and date forms, and the body parse on the framework's EdiHandler. Ported in part from the Java Moqui mantle-edi
// component (github.com/moqui/mantle-edi, 1.1.5, commit 134acb6): the X12 date and time forms and the element positions
// of its services. Nothing here authorizes or writes.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, denied, ms} = lib

const E = {
    CONNECTION: "mantle.edi.EdiConnection",
    PROFILE: "mantle.edi.EdiProfile",
    PROFILE_DOC: "mantle.edi.EdiProfileDocument",
    PROFILE_CODE: "mantle.edi.EdiProfileCode",
    LOCATION: "mantle.edi.EdiLocation",
    CONTROL: "mantle.edi.EdiControlSequence",
    INTERCHANGE: "mantle.edi.EdiInterchange",
    GROUP: "mantle.edi.EdiGroup",
    DOCUMENT: "mantle.edi.EdiDocument",
    MESSAGE: "moqui.service.message.SystemMessage",
    REMOTE: "moqui.service.message.SystemMessageRemote",
    STORE: "mantle.product.store.ProductStore"
}
const IN = "EdiDirIn",
    OUT = "EdiDirOut"
const SERVICES = "mantle.edi.EdiServices."
// X12 has no release character; EdiHandler's default "?" would drop question marks from the data, so the parse and the
// generation use a character that never occurs in X12 text.
const NO_ESCAPE = "\u0000"
// The interchange control version (ISA12) of the X12 4010 envelope, the only one taken.
const ISA_VERSION = "00401"

const blank = value => value == null || String(value).trim() === ""
const text = value => (value == null ? "" : Array.isArray(value) ? value.join(":") : String(value))

// The connection a remote is, with its remote, profile, product store and scope; null when the remote has none.
function connection(systemMessageRemoteId) {
    if (blank(systemMessageRemoteId)) return null
    const conn = one(E.CONNECTION, {systemMessageRemoteId})
    if (!conn) return null
    const remote = one(E.REMOTE, {systemMessageRemoteId})
    const profile = conn.ediProfileId ? one(E.PROFILE, {ediProfileId: conn.ediProfileId}) : null
    const store = conn.productStoreId ? one(E.STORE, {productStoreId: conn.productStoreId}) : null
    return {
        conn,
        remote,
        profile,
        store,
        systemMessageRemoteId,
        organizationPartyId: store?.organizationPartyId || null,
        partnerPartyId: conn.partnerPartyId || null,
        usageCode: remote?.usageCode || "",
        separators: {
            segment: remote?.segmentTerminator || "~",
            element: remote?.elementSeparator || "*",
            component: remote?.componentDelimiter || ":"
        }
    }
}
// The profile's document for a transaction set and direction, or null when the profile does not take or send it.
function profileDocument(c, transactionSetId, directionEnumId) {
    if (!c?.profile) return null
    return one(E.PROFILE_DOC, {ediProfileId: c.profile.ediProfileId, transactionSetId, directionEnumId})
}
// A profile's crosswalk of one code type: {ediCode: row}.
function codes(c, codeTypeEnumId) {
    const out = {}
    if (!c?.profile) return out
    for (const row of rows(E.PROFILE_CODE, {ediProfileId: c.profile.ediProfileId, codeTypeEnumId})) out[row.ediCode] = row
    return out
}
// The X12 code for a Mantle value of a code type (the first by code), or null.
function codeFor(c, codeTypeEnumId, internalValue) {
    const found = Object.values(codes(c, codeTypeEnumId))
        .filter(row => row.internalValue === internalValue)
        .sort((a, b) => String(a.ediCode).localeCompare(String(b.ediCode)))
    return found[0] || null
}

// Segments of X12 text split at the terminator, each {id, elements (element 0 the ID), text, start, end}, start and
// end the offsets of the segment in the text (end at its terminator). Line breaks after a terminator are not part of
// the next segment.
function segmentsOf(textIn, separators) {
    const out = []
    let start = 0
    const source = String(textIn)
    while (start < source.length) {
        while (start < source.length && (source[start] === "\r" || source[start] === "\n")) start++
        if (start >= source.length) break
        let end = source.indexOf(separators.segment, start)
        if (end < 0) end = source.length
        const segmentText = source.slice(start, end)
        if (segmentText.trim() !== "") {
            const elements = segmentText.split(separators.element)
            out.push({id: elements[0].trim(), elements, text: segmentText, start, end})
        }
        start = end + 1
    }
    return out
}
// An element's text, "" when absent; a composite's components joined by its delimiter.
function el(segment, position) {
    const value = segment?.elements?.[position]
    return value == null ? "" : text(value).trim()
}
// Parse a transaction set's text (ST to SE) on its grammar: {st, errors}, errors EdiHandler's segment errors.
function parseSet(documentText, separators, grammarLocation) {
    const edi = new EdiHandler(ec)
        .loadEnvelope(grammarLocation)
        .loadBody(grammarLocation)
        .setChars(separators.segment, separators.element, separators.component, NO_ESCAPE)
    const root = edi.parseText(String(documentText))
    return {st: root.ST ? root.ST[0] : null, errors: Array.from(edi.getSegmentErrors() || [])}
}
// The children of a parsed segment with an ID, as a list.
const kids = (segment, id) => (segment && segment[id] ? Array.from(segment[id]) : [])

// X12 number forms. R is a decimal with an optional point; N0 an integer; N2 an integer with two implied decimals.
const isR = value => /^-?(\d+\.?\d*|\.\d+)$/.test(value)
const isN = value => /^-?\d+$/.test(value)
function fromN2(value) {
    const negative = value.startsWith("-")
    const digits = value.replace(/^-/, "").padStart(3, "0")
    return toDecimal((negative ? "-" : "") + digits.slice(0, -2) + "." + digits.slice(-2))
}
// A decimal as plain text without trailing zeros.
function decimalText(value) {
    let out = String(toDecimal(value ?? 0))
    if (/e/i.test(out)) out = String(toDecimal(value).toNumber())
    if (out.includes(".")) out = out.replace(/0+$/, "").replace(/\.$/, "")
    return out === "-0" ? "0" : out
}
// An amount as N2 (two implied decimals). One with more than two decimal places is refused, not rounded.
function toN2(value) {
    const plain = decimalText(value)
    const negative = plain.startsWith("-")
    const [whole, fraction = ""] = plain.replace(/^-/, "").split(".")
    if (fraction.length > 2) denied("AMOUNT_PRECISION", "Amount " + plain + " has more than two decimal places")
    const digits = (whole + fraction.padEnd(2, "0")).replace(/^0+(?=\d)/, "")
    return (negative ? "-" : "") + digits
}
// An element value fit to send: no separator, terminator, control or no-break space characters, at most max long.
function clean(value, separators, max) {
    let out = text(value)
    for (const ch of [separators.segment, separators.element, separators.component]) out = out.split(ch).join(" ")
    out = out
        .replace(/[\u0000-\u001f\u007f ]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    return max && out.length > max ? out.slice(0, max).trim() : out
}
// A date or stamp in an X12 form (yyyyMMdd, yyMMdd, HHmm), in the user's time zone.
function x12Date(value, pattern = "yyyyMMdd") {
    if (value == null || value === "") return ""
    return ec.l10n.format(new Date(ms(value)), pattern)
}
// An X12 date (CCYYMMDD) as a timestamp at noon, as mantle-edi read them; null for one that is not a date.
function parseDate(value) {
    if (!/^\d{8}$/.test(value)) return null
    return ec.l10n.parseTimestamp(value + " 12:00", "yyyyMMdd HH:mm")
}
function validDate(value) {
    if (!/^\d{8}$/.test(value) && !/^\d{6}$/.test(value)) return false
    const full = value.length === 6 ? "20" + value : value
    const [year, month, day] = [Number(full.slice(0, 4)), Number(full.slice(4, 6)), Number(full.slice(6, 8))]
    const date = new Date(Date.UTC(year, month - 1, day))
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}
function validTime(value) {
    if (!/^\d{4}(\d{2}(\d{1,2})?)?$/.test(value)) return false
    return (
        Number(value.slice(0, 2)) < 24 && Number(value.slice(2, 4)) < 60 && (value.length < 6 || Number(value.slice(4, 6)) < 60)
    )
}
// The reason code of a failure: the first "CODE:" in its text (a refusal thrown through a service call keeps it).
function codeOf(error, fallback = "FAILED") {
    const textOf = String(error?.message ?? error ?? "")
    if (error?.reason) return error.reason
    const match = /\b([A-Z][A-Z0-9]*_[A-Z0-9_]+):/.exec(textOf)
    return match ? match[1] : fallback
}
const clip = (value, max = 1000) => (String(value ?? "").length > max ? String(value).slice(0, max) + "..." : String(value ?? ""))
const json = value => JSON.stringify(value ?? null)
const parseJson = value => lib.json(value, {})
// The inbound purchase order a business record came from: the newest applied 850 of the order.
function purchaseOrderOf(orderId) {
    if (blank(orderId)) return null
    const docs = rows(E.DOCUMENT, {orderId, directionEnumId: IN, transactionSetId: "850", statusId: "EdocApplied"})
    return docs.sort((a, b) => String(b.ediDocumentId).localeCompare(String(a.ediDocumentId)))[0] || null
}

;({
    lib,
    E,
    IN,
    OUT,
    SERVICES,
    NO_ESCAPE,
    ISA_VERSION,
    find,
    one,
    rows,
    denied,
    blank,
    text,
    connection,
    profileDocument,
    codes,
    codeFor,
    segmentsOf,
    el,
    parseSet,
    kids,
    isR,
    isN,
    fromN2,
    toN2,
    decimalText,
    clean,
    x12Date,
    parseDate,
    validDate,
    validTime,
    codeOf,
    clip,
    json,
    parseJson,
    purchaseOrderOf
})
