// The count schedule (design-warehouse StockPolicies CountSchedule; impl-warehouse §4 and P10): dated rows of the
// warehouse policy saying when locations or products come due for counting, read by
// mantle.product.InventoryCountServices.find#DueCounts. Its organization and facility are checked by WarehousePolicy.js's
// guard (FacilityScope.js's organizations), its writes take STOCK_POLICY_MANAGE, and a change ends the row in effect and
// starts the next with its fields audit-logged under the reason: history is never rewritten.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const policy = ec.resource.script("component://mr-mantle/service/mantle/facility/WarehousePolicy.js")
const {find, one, rows, denied, call, ms, dateText} = lib

const SCHEDULE = "mantle.facility.CountSchedule"
const fields = [
    "facilityId",
    "locationTypeEnumId",
    "areaId",
    "locationSeqId",
    "productCategoryId",
    "abcClassEnumId",
    "scheduleKindEnumId",
    "frequencyDays",
    "annualMonth",
    "annualDay",
    "countModeEnumId",
    "blindIndicator",
    "assigneePartyId"
]
const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const whole = value => (blank(value) ? null : Number(String(value)))
const iso = value => new Date(ms(value)).toISOString()
const inEffect = (row, at) => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at

function checkEnum(value, enumTypeId, label) {
    if (value && one("moqui.basic.Enumeration", {enumId: value})?.enumTypeId !== enumTypeId)
        denied("POLICY_INVALID", "Choose a valid " + label)
}
// The values a schedule row will hold, checked: a kind with its frequency or annual date; either locations (a facility's
// location type, area or location) or products (a category or an ABC class); zero confirmation counts locations.
function validate(data, organizationPartyId) {
    checkEnum(data.scheduleKindEnumId, "CountScheduleKind", "schedule kind")
    if (!data.scheduleKindEnumId) denied("POLICY_INVALID", "Choose when the count comes due")
    checkEnum(data.locationTypeEnumId, "FacilityLocationType", "location type")
    checkEnum(data.abcClassEnumId, "AbcClass", "ABC class")
    checkEnum(data.countModeEnumId, "CountMode", "count mode")
    if (data.blindIndicator != null && !["Y", "N"].includes(data.blindIndicator))
        denied("POLICY_INVALID", "Choose Inherit, Yes or No for blind counts")
    const products = !blank(data.productCategoryId) || !blank(data.abcClassEnumId)
    const locations = !blank(data.locationTypeEnumId) || !blank(data.areaId) || !blank(data.locationSeqId)
    if (products && locations) denied("POLICY_INVALID", "A schedule counts locations or products, not both")
    if (data.scheduleKindEnumId === "CskPeriodic") {
        if (!Number.isInteger(data.frequencyDays) || data.frequencyDays < 1 || data.frequencyDays > 3660)
            denied("POLICY_INVALID", "Count every 1 to 3660 days")
        data.annualMonth = null
        data.annualDay = null
    } else if (data.scheduleKindEnumId === "CskAnnual") {
        const month = data.annualMonth,
            day = data.annualDay
        if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1)
            denied("POLICY_INVALID", "Choose the month and day of the annual count")
        if (day > new Date(Date.UTC(2024, month, 0)).getUTCDate()) denied("POLICY_INVALID", "That month has no day " + day)
        data.frequencyDays = null
    } else {
        if (products) denied("POLICY_INVALID", "Zero confirmation counts locations, not products")
        data.frequencyDays = null
        data.annualMonth = null
        data.annualDay = null
    }
    if (locations && blank(data.facilityId)) denied("POLICY_INVALID", "Locations are scheduled for a facility")
    if (data.facilityId) {
        const facility = one("mantle.facility.Facility", {facilityId: data.facilityId})
        if (!facility || facility.ownerPartyId !== organizationPartyId)
            denied("POLICY_INVALID", "The facility must belong to the schedule's organization")
    }
    if (
        data.locationSeqId &&
        !one("mantle.facility.FacilityLocation", {facilityId: data.facilityId, locationSeqId: data.locationSeqId})
    )
        denied("POLICY_INVALID", "Location " + data.locationSeqId + " is not in facility " + data.facilityId)
    if (data.productCategoryId && !one("mantle.product.category.ProductCategory", {productCategoryId: data.productCategoryId}))
        denied("POLICY_INVALID", "Category " + data.productCategoryId + " is not available")
    if (data.assigneePartyId && !one("mantle.party.Party", {partyId: data.assigneePartyId}))
        denied("POLICY_INVALID", "Assignee " + data.assigneePartyId + " is not available")
    return data
}
function valuesOf(p, before) {
    const data = Object.assign({}, before ? lib.pick(lib.map(before), fields) : {})
    for (const field of fields) {
        if (p[field] == null) continue
        data[field] = ["frequencyDays", "annualMonth", "annualDay"].includes(field) ? whole(p[field]) : text(p[field])
    }
    if (data.blindIndicator === "") data.blindIndicator = null
    return data
}

// A schedule row added, or one changed (countScheduleId: it ends where the next starts) or ended (endNow).
function store(p) {
    const why = String(p.changeReason || "").trim()
    if (!why) denied("POLICY_INVALID", "Give a reason for the schedule change")
    const before = p.countScheduleId ? one(SCHEDULE, {countScheduleId: p.countScheduleId}) : null
    if (p.countScheduleId && !before) denied("RECORD_UNAVAILABLE", "Count schedule " + p.countScheduleId + " is not available")
    const guarded = policy.execute("guard", {
        organizationPartyId: before?.organizationPartyId || p.organizationPartyId,
        facilityId: before ? before.facilityId : p.facilityId
    })
    if (!guarded.canManage) denied("POLICY_MANAGE_REQUIRED", "Warehouse manager authority is required")
    const organizationPartyId = guarded.organizationPartyId
    find("mantle.party.Party", {partyId: organizationPartyId}).forUpdate(true).one()
    const now = ms(ec.user.nowTimestamp)
    const auditFields = [...fields, "fromDate", "thruDate", "changeReason"]
    ec.context.putAll(Object.fromEntries(auditFields.map(field => [field + "_changeReason", why])))
    if (before) {
        const locked = find(SCHEDULE, {countScheduleId: before.countScheduleId}).forUpdate(true).one()
        if (locked.thruDate != null && ms(locked.thruDate) <= now) denied("POLICY_INVALID", "This schedule has ended")
        if (p.expectedLastUpdatedStamp && ms(p.expectedLastUpdatedStamp) !== ms(locked.lastUpdatedStamp))
            denied("POLICY_CHANGED", "The schedule changed; reload before saving")
    }
    const at = blank(p.fromDate) ? now : ms(p.fromDate)
    if (!Number.isFinite(at) || at < now - 60000) denied("POLICY_INVALID", "Schedule changes take effect now or later")
    if (before && (p.endNow === true || p.endNow === "true" || p.endNow === "Y")) {
        call("update#" + SCHEDULE, {
            countScheduleId: before.countScheduleId,
            thruDate: iso(Math.max(now, ms(before.fromDate))),
            changeReason: why
        })
        return get({countScheduleId: before.countScheduleId})
    }
    if (before && at <= ms(before.fromDate)) denied("POLICY_INVALID", "A change starts after the row it replaces")
    const data = validate(valuesOf(p, before), organizationPartyId)
    if (before) call("update#" + SCHEDULE, {countScheduleId: before.countScheduleId, thruDate: iso(at), changeReason: why})
    const created = call(
        "create#" + SCHEDULE,
        Object.assign({}, data, {
            organizationPartyId,
            fromDate: iso(at),
            thruDate: before?.thruDate && ms(before.thruDate) > at ? before.thruDate : null,
            previousCountScheduleId: before?.countScheduleId || null,
            changeReason: why
        })
    )
    return get({countScheduleId: created.countScheduleId})
}
function get(p) {
    const row = one(SCHEDULE, {countScheduleId: p.countScheduleId})
    return {countScheduleId: row.countScheduleId, schedule: view(row, new Map(), {})}
}
// A row for a screen, with its names and how it comes due.
function view(row, enums, parties) {
    const enumText = id => (id ? enums.get(id) || one("moqui.basic.Enumeration", {enumId: id})?.description || id : null)
    const kind = row.scheduleKindEnumId
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    const dueText =
        kind === "CskPeriodic"
            ? "Every " + row.frequencyDays + " days"
            : kind === "CskAnnual"
              ? "Every year on " + months[Number(row.annualMonth) - 1] + " " + row.annualDay
              : "When stock reaches zero"
    const scopeText =
        [
            row.locationTypeEnumId ? enumText(row.locationTypeEnumId) + " locations" : null,
            row.areaId ? "area " + row.areaId : null,
            row.locationSeqId ? "location " + row.locationSeqId : null,
            row.productCategoryId ? "category " + row.productCategoryId : null,
            row.abcClassEnumId ? "class " + enumText(row.abcClassEnumId) : null
        ]
            .filter(Boolean)
            .join(", ") || "Every location"
    return Object.assign(lib.map(row), {
        dueText,
        scopeText,
        kindText: enumText(kind),
        countModeText: enumText(row.countModeEnumId),
        blindText: row.blindIndicator === "Y" ? "Blind" : row.blindIndicator === "N" ? "Not blind" : "Policy default",
        assigneeName: row.assigneePartyId ? parties[row.assigneePartyId] || row.assigneePartyId : null,
        fromDateText: dateText(row.fromDate),
        thruDateText: dateText(row.thruDate)
    })
}
// The schedule rows of an organization (a facility's and the organization's own) in effect now and to come, or every row
// with includeHistory; any Warehouse policy reader.
function list(p) {
    const guarded = policy.execute("guard", {organizationPartyId: p.organizationPartyId, facilityId: p.facilityId})
    const now = ms(ec.user.nowTimestamp)
    const all = rows(SCHEDULE, {organizationPartyId: guarded.organizationPartyId}).filter(
        row =>
            (guarded.facilityId === "_NA_" || !row.facilityId || row.facilityId === guarded.facilityId) &&
            (p.includeHistory === true || p.includeHistory === "true" || row.thruDate == null || ms(row.thruDate) > now)
    )
    all.sort((a, b) => (a.facilityId || "").localeCompare(b.facilityId || "") || ms(a.fromDate) - ms(b.fromDate))
    const parties = lib.partyNames(all.map(row => row.assigneePartyId))
    return {
        organizationPartyId: guarded.organizationPartyId,
        facilityId: guarded.facilityId === "_NA_" ? null : guarded.facilityId,
        canManage: guarded.canManage,
        schedules: all.map(row => Object.assign(view(row, new Map(), parties), {current: inEffect(row, now)}))
    }
}
const operations = {store, list}
;({
    execute(op, parameters) {
        if (!operations[op]) throw new Error("Unknown count schedule operation " + op)
        return operations[op](parameters)
    }
})
