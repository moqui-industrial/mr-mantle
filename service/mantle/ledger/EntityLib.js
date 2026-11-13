// Shared helpers of the finance modules (ledger and account): entity reads without artifact authorization (each module
// checks its own permissions first), service calls and probes, values for screens and fingerprints, refusals with
// reason codes, privacy-respecting party names, paging, and operation keys. Nothing here authorizes.
const access = ec.resource.script("component://mr-mantle/service/mantle/product/ProductAccess.js")
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const map = row => (row?.getMap ? row.getMap() : Object.assign({}, row || {}))
// a Date's own millis: its text has none, so Date.parse of it would move it to the start of its second
const ms = value =>
    value == null || value === ""
        ? null
        : value instanceof Date
          ? value.getTime()
          : /^-?\d+$/.test(String(value))
            ? Number(value)
            : Date.parse(String(value))
const active = (row, date = ec.user.nowTimestamp) =>
    (ms(row.fromDate) ?? -Infinity) <= ms(date) && (ms(row.thruDate) ?? Infinity) > ms(date)
const pick = (row, fields) => Object.fromEntries(fields.filter(key => row[key] !== undefined).map(key => [key, row[key]]))
const hash = value => ec.user.singleUseCodeHash(JSON.stringify(value))
// A refusal a caller tests by its code: the message starts with the code (callers read "CODE: message" from a service's
// errors) and error.reason holds it.
function denied(reason, message) {
    const error = new Error(reason + ": " + message)
    error.reason = reason
    throw error
}
// The reason code of a refusal: error.reason, else the CODE of a "CODE: message" text.
function reasonCode(error) {
    if (error?.reason) return error.reason
    const match = /^([A-Z][A-Z0-9_]+):/.exec(String(error?.message ?? error ?? ""))
    return match ? match[1] : null
}
// Whether a check passes, without failing the caller: {allowed} and, when refused, its reasonCode.
function check(test) {
    try {
        test()
        return {allowed: true, reasonCode: null}
    } catch (error) {
        return {allowed: false, reasonCode: reasonCode(error) || "PERMISSION_DENIED"}
    }
}
const call = (name, parameters = {}) => {
    const out = ec.service.sync().name(name).parameters(parameters).disableAuthz().call() || {}
    if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
    return out
}
// Expected independent failures use a separate transaction and error frame.
function probe(name, parameters) {
    ec.message.pushErrors()
    try {
        const result = ec.service.sync().name(name).parameters(parameters).disableAuthz().requireNewTransaction(true).call() || {}
        if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
        return result
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}
// Parsed JSON text, or the fallback for empty or unreadable text.
function json(text, fallback = null) {
    if (text == null || text === "") return fallback
    try {
        return JSON.parse(String(text))
    } catch (error) {
        ec.logger.error("Unreadable JSON: " + error.message)
        return fallback
    }
}
// An amount rounded to its currency, as a decimal.
function money(value, currencyUomId) {
    return ec.l10n.roundCurrency(toDecimal(value ?? 0), currencyUomId)
}
// A positive amount entered for a currency, refused when not a number, not positive (AMOUNT_INVALID) or finer than the
// currency's precision (CURRENCY_PRECISION).
function amount(value, currencyUomId) {
    let decimal
    try {
        decimal = toDecimal(value)
    } catch (_) {
        denied("AMOUNT_INVALID", "Enter a positive amount")
    }
    if (!decimal || decimal.compare(0) <= 0) denied("AMOUNT_INVALID", "Enter a positive amount")
    if (!decimal.eq(ec.l10n.roundCurrency(decimal, currencyUomId)))
        denied("CURRENCY_PRECISION", "The amount exceeds the currency's precision")
    return decimal
}
// A date or stamp as display text in the user's time zone: the day alone at midnight, else with the time.
function dateText(value) {
    if (value == null || value === "") return ""
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value)
    const text = ec.l10n.format(new Date(ms(value)), "yyyy-MM-dd HH:mm")
    return text.endsWith(" 00:00") ? text.slice(0, 10) : text
}
// A SQL DATE is a calendar value, not a timestamp in the viewing user's zone.
function calendarDateText(value) {
    if (value == null || value === "") return ""
    const text = String(value)
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
    const date = new Date(ms(value))
    if (!Number.isFinite(date.getTime())) throw new Error("A calendar date is required")
    return [
        date.getUTCFullYear(),
        String(date.getUTCMonth() + 1).padStart(2, "0"),
        String(date.getUTCDate()).padStart(2, "0")
    ].join("-")
}
// The book day of a record: its calendar day when it has one, else the day of its timestamp in the user's zone, the rule
// create#Invoice and the apply services date a document and an application by.
function bookDay(day, stamp) {
    if (day != null && day !== "") return calendarDateText(day)
    if (stamp == null || stamp === "") return ""
    return ec.l10n.format(new Date(ms(stamp)), "yyyy-MM-dd")
}
// A row for a screen: a plain map with <field>Text for each date and stamp, since JSON drops their types. Not for
// fingerprints, which use map.
function display(row) {
    const out = map(row)
    for (const field of Object.keys(out)) {
        if (!/(Date|Stamp)$/.test(field) || out[field] == null) continue
        try {
            out[field + "Text"] = field === "accountingDate" ? calendarDateText(out[field]) : dateText(out[field])
        } catch (error) {
            ec.logger.error("Accounting date " + field + ": " + error.message)
            out[field + "Text"] = ""
        }
    }
    if (out.accountingDate && out.transactionDate) out.transactionDateText = calendarDateText(out.accountingDate)
    return out
}
// Names of the parties the user may see, by party ID, read in one query; a party another user keeps private is left out.
function partyNames(ids) {
    const unique = [...new Set(ids.filter(Boolean))]
    if (!unique.length) return {}
    const names = {}
    for (const row of find("mantle.party.PartyDetail").condition("partyId", "in", unique).list()) {
        if (row.privateOwnerUserId && row.privateOwnerUserId !== ec.user.userId && !access.systemAdmin()) continue
        names[row.partyId] =
            row.organizationName || [row.firstName, row.middleName, row.lastName].filter(Boolean).join(" ") || row.partyId
    }
    return names
}
// One page of a query, with the page fields a form-list reads, both plain and prefixed by field. With options.noLimitCap, a
// request with pageNoLimit (a form-list's export) gets every row on one page, up to that cap.
function page(query, p, field = "records", recordCount, options = {}) {
    const noLimit = options.noLimitCap && (p.pageNoLimit === true || p.pageNoLimit === "true")
    const pageSize = noLimit
        ? Math.max(1, Math.min(recordCount, options.noLimitCap))
        : Math.min(100, Math.max(1, Number(p.pageSize) || 20))
    const pageMaxIndex = Math.max(0, Math.ceil(recordCount / pageSize) - 1)
    const pageIndex = Math.min(pageMaxIndex, Math.max(0, Number(p.pageIndex) || 0))
    const result = {
        recordCount,
        pageSize,
        pageIndex,
        pageMaxIndex,
        pageRangeLow: recordCount ? pageIndex * pageSize + 1 : 0,
        pageRangeHigh: Math.min(recordCount, (pageIndex + 1) * pageSize)
    }
    result.rows = Array.from(
        query
            .offset(pageIndex * pageSize)
            .limit(pageSize)
            .list()
    )
    result[field] = result.rows
    result[field + "Count"] = recordCount
    for (const key of ["PageSize", "PageIndex", "PageMaxIndex", "PageRangeLow", "PageRangeHigh"])
        result[field + key] = result[key[0].toLowerCase() + key.slice(1)]
    return result
}
// One page of a list built in memory, with the same page fields as page; with options.noLimitCap, a request with
// pageNoLimit (an export) gets every row on one page, up to that cap. options.pageIndex names another page parameter.
function pageList(list, p, field, options = {}) {
    const noLimit = options.noLimitCap && (p.pageNoLimit === true || p.pageNoLimit === "true")
    const pageSize = noLimit
        ? Math.max(1, Math.min(list.length, options.noLimitCap))
        : Math.min(100, Math.max(1, Number(p.pageSize) || 20))
    const pageMaxIndex = Math.max(0, Math.ceil(list.length / pageSize) - 1)
    const requested = options.pageIndex != null ? options.pageIndex : p.pageIndex
    const pageIndex = Math.min(pageMaxIndex, Math.max(0, Number(requested) || 0))
    return {
        [field]: list.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize),
        [field + "Count"]: list.length,
        [field + "PageIndex"]: pageIndex,
        [field + "PageSize"]: pageSize,
        [field + "PageMaxIndex"]: pageMaxIndex,
        [field + "PageRangeLow"]: list.length ? pageIndex * pageSize + 1 : 0,
        [field + "PageRangeHigh"]: Math.min(list.length, (pageIndex + 1) * pageSize)
    }
}
// Operation keys (PostingOperation): begin checks the key is the caller's for the same request, finish records the
// result, and previous answers a retry with the first result.
const operationEntity = "mantle.ledger.transaction.PostingOperation"
function operation(p, type, organizationPartyId, request) {
    const operationKey = String(p.operationKey || "")
    if (!operationKey || operationKey.length > 40)
        denied("OPERATION_KEY_REQUIRED", "An operation key of at most 40 characters is required")
    const requestHash = hash(request)
    const old = one(operationEntity, {operationKey})
    if (
        old &&
        (old.operationType !== type ||
            old.organizationPartyId !== organizationPartyId ||
            old.userId !== ec.user.userId ||
            old.requestHash !== requestHash)
    )
        denied("OPERATION_KEY_CONFLICT", "Operation key was used for another request")
    return {operationKey, requestHash, old, operationType: type, organizationPartyId}
}
function complete(op, resultEntityName, resultId, result) {
    call("create#" + operationEntity, {
        operationKey: op.operationKey,
        operationType: op.operationType,
        organizationPartyId: op.organizationPartyId,
        userId: ec.user.userId,
        submittedDate: ec.user.nowTimestamp,
        completedDate: ec.user.nowTimestamp,
        requestHash: op.requestHash,
        status: "complete",
        resultEntityName,
        resultId,
        resultJson: JSON.stringify(result)
    })
}
function previous(op) {
    return op.old ? Object.assign(json(op.old.resultJson, {}), {alreadyApplied: true}) : null
}
;({
    access,
    find,
    one,
    rows,
    map,
    ms,
    active,
    pick,
    hash,
    denied,
    reasonCode,
    check,
    call,
    probe,
    json,
    money,
    amount,
    dateText,
    calendarDateText,
    bookDay,
    display,
    partyNames,
    page,
    pageList,
    operationEntity,
    operation,
    complete,
    previous
})
