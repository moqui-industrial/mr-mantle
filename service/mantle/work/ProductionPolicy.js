// Manufacturing's production policy and reason codes (design-manufacturing ProductionSettings and ReasonCodes;
// impl-manufacturing P4): dated ProductionPolicy rows of an organization (its default) and of its facilities (a plant's
// override), resolved field by field with the source of each value, and dated ProductionReason rows. A change ends the row
// in effect and starts the next, never earlier than now, so what a run read at its release stays what it reads later.
// Reading takes PRODUCTION_VIEW or PRODUCTION_POLICY_EDIT, writing PRODUCTION_POLICY_EDIT, each in the user's
// organizations (FacilityScope.js). The production guards read the policy through effective() and runPolicy(), which
// check no permission. Artifact authorization being disabled widens nothing here.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const {find, one, rows, call, denied, access, ms, map} = lib

const POLICY = "mantle.work.production.ProductionPolicy",
    REASON = "mantle.work.production.ProductionReason",
    FACILITY = "mantle.facility.Facility"
const ALL = "_NA_"
const blank = value => value == null || String(value).trim() === ""
const iso = value => new Date(value).toISOString()
const current = (row, at) => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at
const yesNo = value => (value === "Y" ? "Yes" : value === "N" ? "No" : "")
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")

// ===== the policy fields =====
// Each field: its group (the ProductionSettings form), label, kind (an enumeration type, indicator, percent, days, hours or
// calendar) and built-in default, Mantle's behavior with no row. The flags that change an existing Mantle service default
// to N (impl-manufacturing §2).
const fields = [
    {
        name: "consumptionMethodEnumId",
        group: "consumption",
        label: "Consumption",
        kind: "ProductionConsumption",
        default: "PcmManual"
    },
    {
        name: "issuePointEnumId",
        group: "consumption",
        label: "Issue point",
        kind: "ProductionIssuePoint",
        default: "PipOperationStart"
    },
    {name: "overConsumePercent", group: "consumption", label: "Over-consumption tolerance", kind: "percent", default: 0},
    {name: "overProducePercent", group: "consumption", label: "Overproduction tolerance", kind: "percent", default: 0},
    {name: "substituteApproval", group: "consumption", label: "Substitutes need approval", kind: "indicator", default: "Y"},
    {name: "outputInspection", group: "consumption", label: "Inspect output", kind: "indicator", default: "N"},
    {name: "firstPieceInspection", group: "consumption", label: "First-piece inspection", kind: "indicator", default: "N"},
    {name: "completeOnFinalReceipt", group: "consumption", label: "Complete on final receipt", kind: "indicator", default: "N"},
    {name: "strictRelease", group: "consumption", label: "Strict release", kind: "indicator", default: "N"},
    {
        name: "timeLogEnforcementEnumId",
        group: "timeAndCost",
        label: "Time logging",
        kind: "ProductionTimeLog",
        default: "PtlOptional"
    },
    {
        name: "machineRuntimeEnumId",
        group: "timeAndCost",
        label: "Machine runtime",
        kind: "ProductionMachineRuntime",
        default: "PmrNotRecorded"
    },
    {name: "workTypeEnumId", group: "timeAndCost", label: "Work type", kind: "WorkType", default: null},
    {name: "pieceRate", group: "timeAndCost", label: "Record pieces on time", kind: "indicator", default: "N"},
    {name: "laborCostSync", group: "timeAndCost", label: "Labor cost from approved time", kind: "indicator", default: "N"},
    {name: "estimateRefresh", group: "timeAndCost", label: "Propose estimate refresh", kind: "indicator", default: "N"},
    {name: "closeApproval", group: "timeAndCost", label: "Cost close needs review", kind: "indicator", default: "N"},
    {name: "planningHorizonDays", group: "planning", label: "Planning horizon", kind: "days", default: 90},
    {name: "timeFenceDays", group: "planning", label: "Time fence", kind: "days", default: 0},
    {
        name: "shortageReleaseEnumId",
        group: "planning",
        label: "Shortage release",
        kind: "ProductionShortageRelease",
        default: "PsrAllUsable"
    },
    {name: "calendarId", group: "planning", label: "Work calendar", kind: "calendar", default: null},
    {
        name: "leadTimeBasisEnumId",
        group: "planning",
        label: "Lead time basis",
        kind: "ProductionLeadTimeBasis",
        default: "PltEntered"
    },
    {name: "freshnessLimitHours", group: "planning", label: "Plan freshness limit", kind: "hours", default: 24}
]
const fieldNames = fields.map(field => field.name)
const groupLabels = {consumption: "Consumption", timeAndCost: "Time and cost", planning: "Planning"}

function valueText(field, value) {
    if (value == null || value === "") return field.kind === "calendar" ? "None" : field.kind === "WorkType" ? "None" : ""
    if (field.kind === "indicator") return yesNo(value)
    if (field.kind === "percent") return String(Number(String(value))) + "%"
    if (field.kind === "days") return String(value) + (Number(String(value)) === 1 ? " day" : " days")
    if (field.kind === "hours") return String(value) + (Number(String(value)) === 1 ? " hour" : " hours")
    if (field.kind === "calendar") return one("mantle.work.calendar.Calendar", {calendarId: value})?.calendarName || value
    return enumText(value)
}

// ===== scope =====
// The organization and facility a read or change is for, in the user's organizations: the given organization, else the
// facility's owner, else the run's, else the active organization, else the user's first. A facility must be the
// organization's.
function scopeOf(p) {
    const userScope = facilityScope.scope()
    if (!ec.user.userId || (!userScope.systemAdmin && ec.user.hasPermission("PROJECT_CLIENT")))
        denied("PERMISSION_DENIED", "The production policy is not available")
    const run = blank(p.workEffortId) ? null : one("mantle.work.effort.WorkEffort", {workEffortId: p.workEffortId})
    if (!blank(p.workEffortId) && (!run || run.purposeEnumId !== "WepProductionRun"))
        denied("RECORD_UNAVAILABLE", "Production run " + p.workEffortId + " is not available")
    const facilityId = !blank(p.facilityId) && p.facilityId !== ALL ? p.facilityId : run?.facilityId || null
    const facility = facilityId ? one(FACILITY, {facilityId}) : null
    if (facilityId && !facility) denied("RECORD_UNAVAILABLE", "Facility " + facilityId + " is not available")
    const organizationPartyId =
        str(p.organizationPartyId) ||
        run?.ownerPartyId ||
        facility?.ownerPartyId ||
        userScope.activeOrganizationPartyId ||
        userScope.memberPartyIds[0]
    if (
        !organizationPartyId ||
        !one("mantle.party.PartyRole", {partyId: organizationPartyId, roleTypeId: "OrgInternal"}) ||
        !facilityScope.owns(userScope, organizationPartyId)
    )
        denied("RECORD_UNAVAILABLE", "Organization " + (organizationPartyId || "") + " is not available")
    if (facility && facility.ownerPartyId !== organizationPartyId)
        denied("RECORD_UNAVAILABLE", "Facility " + facilityId + " is not the organization's")
    if (run && (run.ownerPartyId !== organizationPartyId || !facilityScope.owns(userScope, run.ownerPartyId)))
        denied("RECORD_UNAVAILABLE", "Production run " + p.workEffortId + " is not available")
    return {organizationPartyId, facility, run, canEdit: access.has("PRODUCTION_POLICY_EDIT")}
}
function str(value) {
    return blank(value) ? null : String(value)
}
function requireRead() {
    if (!access.has("PRODUCTION_VIEW") && !access.has("PRODUCTION_POLICY_EDIT"))
        denied("PERMISSION_DENIED", "PRODUCTION_VIEW is required")
}
function requireEdit() {
    if (!access.has("PRODUCTION_POLICY_EDIT")) denied("PERMISSION_DENIED", "PRODUCTION_POLICY_EDIT is required")
}
function dateOf(value, label) {
    if (blank(value)) return ms(ec.user.nowTimestamp)
    const at = ms(value)
    if (!Number.isFinite(at)) denied("POLICY_INVALID", "Choose a valid " + label)
    return at
}

// ===== resolution =====
// The facility and those above it (parentFacilityId) of the same owner, the topmost first; at most eight levels.
function facilityChain(organizationPartyId, facility) {
    const chain = []
    let current = facility
    while (current && current.ownerPartyId === organizationPartyId && chain.length < 8) {
        if (chain.some(row => row.facilityId === current.facilityId)) break
        chain.unshift(current)
        current = current.parentFacilityId ? one(FACILITY, {facilityId: current.parentFacilityId}) : null
    }
    return chain
}
// The policy in effect at a time for an organization at a facility: the built-in defaults, then the organization's row, then
// each facility's row from the topmost down; an empty field inherits. Each value set by a row names its source.
// Internal: it checks no permission.
function effective(organizationPartyId, facilityId, at) {
    const when = at == null || at === "" ? ms(ec.user.nowTimestamp) : ms(at)
    const policy = Object.fromEntries(fields.map(field => [field.name, field.default])),
        sources = {}
    if (!organizationPartyId) return {policy, sources}
    const facility = facilityId && facilityId !== ALL ? one(FACILITY, {facilityId}) : null
    const chain = facilityChain(organizationPartyId, facility)
    const scopeIds = [ALL, ...chain.map(row => row.facilityId)]
    const all = Array.from(find(POLICY, {organizationPartyId}).condition("facilityId", "in", scopeIds).list()).filter(row =>
        current(row, when)
    )
    for (const scopeId of scopeIds) {
        const row = all.filter(policyRow => policyRow.facilityId === scopeId).sort((a, b) => ms(b.fromDate) - ms(a.fromDate))[0]
        if (!row) continue
        const scopeFacility = chain.find(each => each.facilityId === scopeId)
        for (const name of fieldNames) {
            if (row[name] == null || row[name] === "") continue
            policy[name] = row[name]
            sources[name] = {
                level: scopeId === ALL ? "organization" : "facility",
                facilityId: scopeId,
                facilityName: scopeFacility ? scopeFacility.facilityName || scopeId : null,
                fromDate: row.fromDate,
                thruDate: row.thruDate,
                changeReason: row.changeReason
            }
        }
    }
    return {policy, sources}
}
// The policy a run keeps: as of its release time (its owner, at its facility), or now for a draft. Internal.
function runPolicy(run) {
    return effective(run.ownerPartyId, run.facilityId, run.productionReleaseDate || ec.user.nowTimestamp).policy
}
// The scrap allowance of a material line: how much of the stock unit issue#ProductionMaterial may issue beyond the line's
// quantity, the run's over-consumption tolerance (as of its release) of the line's quantity; zero with no policy.
function overConsumeAllowance(run, line) {
    const percent = toDecimal(runPolicy(run).overConsumePercent ?? 0)
    if (percent.compare(0) <= 0) return toDecimal(0)
    return toDecimal(line.stockQuantity ?? 0)
        .multiply(percent)
        .divide(toDecimal(100), 6, "HALF_UP")
}

function sourceText(source) {
    if (!source) return "Built-in default"
    return source.level === "organization" ? "Organization default" : "Plant override: " + (source.facilityName || "")
}
function historyRow(row, at) {
    const set = fields.filter(field => row[field.name] != null && row[field.name] !== "")
    return Object.assign(map(row), {
        fromDateText: lib.dateText(row.fromDate),
        thruDateText: lib.dateText(row.thruDate),
        inEffect: current(row, at),
        summary: set.length ? set.map(field => field.label + " " + valueText(field, row[field.name])).join(", ") : "Nothing set"
    })
}
// get#ProductionPolicy: the policy in effect at the scope and date with each value's source, the row set at the exact
// scope, its history, and whether the user may change it.
function resolve(p) {
    requireRead()
    const scope = scopeOf(p)
    const facilityId = scope.facility?.facilityId || ALL
    const at = !blank(p.asOfDate)
        ? dateOf(p.asOfDate, "policy date")
        : scope.run?.productionReleaseDate
          ? ms(scope.run.productionReleaseDate)
          : ms(ec.user.nowTimestamp)
    const resolved = effective(scope.organizationPartyId, facilityId, at)
    const exact = rows(POLICY, {organizationPartyId: scope.organizationPartyId, facilityId}).sort(
        (a, b) => ms(b.fromDate) - ms(a.fromDate)
    )
    const configured = exact.find(row => current(row, at))
    const traceRows = fields.map(field => {
        const source = resolved.sources[field.name]
        return {
            field: field.name,
            group: field.group,
            groupLabel: groupLabels[field.group],
            fieldLabel: field.label,
            value: resolved.policy[field.name],
            valueText: valueText(field, resolved.policy[field.name]),
            level: source ? source.level : "default",
            sourceFacilityId: source?.facilityId === ALL ? null : source?.facilityId || null,
            sourceText: sourceText(source),
            fromDate: source?.fromDate || null,
            fromDateText: source ? lib.dateText(source.fromDate) : "",
            changeReason: source?.changeReason || null
        }
    })
    const configuredPolicy = configured ? map(configured) : {}
    return {
        organizationPartyId: scope.organizationPartyId,
        organizationName:
            one("mantle.party.Organization", {partyId: scope.organizationPartyId})?.organizationName || scope.organizationPartyId,
        facilityId: facilityId === ALL ? null : facilityId,
        facilityName: scope.facility ? scope.facility.facilityName || scope.facility.facilityId : null,
        workEffortId: scope.run?.workEffortId || null,
        asOfDate: iso(at),
        policy: resolved.policy,
        sources: resolved.sources,
        traceRows,
        configuredPolicy,
        expectedFromDate: configured ? configured.fromDate : null,
        history: exact.map(row => historyRow(row, at)),
        canEdit: scope.canEdit
    }
}

// ===== the change =====
const percentFields = fields.filter(field => field.kind === "percent").map(field => field.name),
    countFields = fields.filter(field => ["days", "hours"].includes(field.kind)).map(field => field.name)
function validate(data) {
    for (const field of fields) {
        const value = data[field.name]
        if (value == null) continue
        if (field.kind === "indicator") {
            if (!["Y", "N"].includes(value)) denied("POLICY_INVALID", "Choose Inherit, Yes or No for " + field.label)
        } else if (percentFields.includes(field.name)) {
            const number = Number(String(value))
            if (!Number.isFinite(number) || number < 0 || number > 100)
                denied("POLICY_INVALID", field.label + " is a percentage from 0 to 100")
        } else if (countFields.includes(field.name)) {
            const number = Number(String(value))
            if (!Number.isInteger(number) || number < 0 || number > 3650)
                denied("POLICY_INVALID", field.label + " is a whole number from 0 to 3650")
        } else if (field.kind === "calendar") {
            if (!one("mantle.work.calendar.Calendar", {calendarId: value}))
                denied("POLICY_INVALID", "Calendar " + value + " is not available")
        } else if (one("moqui.basic.Enumeration", {enumId: value})?.enumTypeId !== field.kind) {
            denied("POLICY_INVALID", "Choose a valid " + field.label.toLowerCase())
        }
    }
}
// store#ProductionPolicy: a dated change at the organization (no facility) or a facility of it. The new row holds the values
// of the row in effect at its start with the changes (a given empty value inherits again); the row in effect there ends
// at its start, and it ends where a later row starts. Refuses a stale expectedFromDate (POLICY_CHANGED), a start before now
// and a second row at the same time (POLICY_INVALID).
function store(p) {
    requireEdit()
    const scope = scopeOf(p)
    const why = String(p.changeReason || "").trim()
    if (!why) denied("POLICY_INVALID", "Give a reason for the policy change")
    const now = ms(ec.user.nowTimestamp)
    const key = {organizationPartyId: scope.organizationPartyId, facilityId: scope.facility?.facilityId || ALL}
    find("mantle.party.Party", {partyId: scope.organizationPartyId}).forUpdate(true).one()
    const all = rows(POLICY, key).sort((a, b) => ms(a.fromDate) - ms(b.fromDate))
    const inEffect = all.filter(row => current(row, now)).at(-1)
    if (ms(p.expectedFromDate) !== (inEffect ? ms(inEffect.fromDate) : null))
        denied("POLICY_CHANGED", "The production policy changed; reload before saving")
    const at = blank(p.fromDate) ? Math.max(now, (inEffect ? ms(inEffect.fromDate) : 0) + 1) : dateOf(p.fromDate, "start")
    if (at < now) denied("POLICY_INVALID", "Policy changes take effect now or later")
    if (all.some(row => ms(row.fromDate) === at)) denied("POLICY_INVALID", "A production policy already starts at this time")
    const before = all.filter(row => ms(row.fromDate) < at && (row.thruDate == null || ms(row.thruDate) > at)).at(-1),
        after = all.find(row => ms(row.fromDate) > at)
    const data = Object.fromEntries(fieldNames.map(name => [name, before ? (before[name] ?? null) : null]))
    // with a policy group (one ProductionSettings form) only that group's fields change
    if (!blank(p.policyGroup) && !Object.hasOwn(groupLabels, p.policyGroup)) denied("POLICY_INVALID", "Unknown policy group")
    const changing = fields.filter(field => blank(p.policyGroup) || field.group === p.policyGroup).map(field => field.name)
    for (const name of changing) if (Object.keys(p).includes(name)) data[name] = blank(p[name]) ? null : p[name]
    validate(data)
    ec.context.putAll(
        Object.fromEntries(["fromDate", "thruDate", ...fieldNames, "changeReason"].map(name => [name + "_changeReason", why]))
    )
    const fromDate = iso(at)
    if (before) call("update#" + POLICY, Object.assign({}, key, {fromDate: iso(ms(before.fromDate)), thruDate: fromDate}))
    call(
        "create#" + POLICY,
        Object.assign({}, key, data, {fromDate, thruDate: after ? iso(ms(after.fromDate)) : null, changeReason: why})
    )
    return resolve({organizationPartyId: scope.organizationPartyId, facilityId: key.facilityId, asOfDate: fromDate})
}

// ===== reason codes =====
const reasonFields = ["reasonName", "reasonCategoryEnumId", "equipmentFault", "plannedStop", "approvalThreshold", "sequenceNum"]
// The row of a reason in effect at a time, else null. Internal: what a later phase's event checks and copies (an active
// reason of the run's owner, its category and flags as of the event).
function activeReason(organizationPartyId, reasonCode, at = ec.user.nowTimestamp) {
    if (!organizationPartyId || blank(reasonCode)) return null
    const when = ms(at)
    return rows(REASON, {organizationPartyId, reasonCode}).find(row => current(row, when)) || null
}
function reasonRow(row, inEffect, at, historyCount) {
    return Object.assign(map(row), {
        active: !!inEffect,
        activeText: inEffect ? "Active" : ms(row.fromDate) > at ? "Starts " + lib.dateText(row.fromDate) : "Inactive",
        categoryText: enumText(row.reasonCategoryEnumId),
        equipmentFaultText: yesNo(row.equipmentFault || "N"),
        plannedStopText: yesNo(row.plannedStop || "N"),
        approvalThresholdText: row.approvalThreshold == null ? "" : String(Number(String(row.approvalThreshold))),
        fromDateText: lib.dateText(row.fromDate),
        thruDateText: lib.dateText(row.thruDate),
        expectedFromDate: inEffect ? row.fromDate : null,
        historyCount
    })
}
// find#ProductionReasons: each reason code of the organization as of a date, with its row in effect (or, for an inactive
// one, its latest row), by category; inactive codes only with includeInactive.
function findReasons(p) {
    requireRead()
    const scope = scopeOf({organizationPartyId: p.organizationPartyId})
    const at = dateOf(p.asOfDate, "date")
    let query = find(REASON, {organizationPartyId: scope.organizationPartyId})
    if (!blank(p.reasonCategoryEnumId)) query = query.condition("reasonCategoryEnumId", p.reasonCategoryEnumId)
    const all = Array.from(query.orderBy("reasonCode").limit(2000).list())
    const byCode = new Map()
    for (const row of all) {
        if (!byCode.has(row.reasonCode)) byCode.set(row.reasonCode, [])
        byCode.get(row.reasonCode).push(row)
    }
    const reasons = []
    for (const [reasonCode, codeRows] of byCode) {
        const sorted = codeRows.sort((a, b) => ms(b.fromDate) - ms(a.fromDate))
        const inEffect = sorted.find(row => current(row, at))
        if (!inEffect && p.includeInactive !== true && p.includeInactive !== "true") continue
        reasons.push(reasonRow(inEffect || sorted[0], inEffect, at, sorted.length))
    }
    reasons.sort(
        (a, b) =>
            Number(String(a.sequenceNum ?? 999999)) - Number(String(b.sequenceNum ?? 999999)) ||
            String(a.reasonCode).localeCompare(String(b.reasonCode))
    )
    const history = blank(p.reasonCode)
        ? []
        : (byCode.get(p.reasonCode) || []).map(row => reasonRow(row, current(row, at) ? row : null, at, 0))
    return {organizationPartyId: scope.organizationPartyId, reasons, history, canEdit: scope.canEdit}
}
// One reason's change, checked before anything is written: the code, the values of the row in effect with the changes, and
// for a deactivation the row in effect to end. Refuses a stale expectedFromDate (REASON_CHANGED), a new code without a
// name or category, an invalid value (REASON_INVALID) and deactivating an inactive code (REASON_INACTIVE).
function reasonPlan(organizationPartyId, given, now) {
    const reasonCode = String(given.reasonCode || "").trim()
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(reasonCode)) denied("REASON_INVALID", "A reason code is 1 to 40 letters, digits, - or _")
    const all = rows(REASON, {organizationPartyId, reasonCode}).sort((a, b) => ms(a.fromDate) - ms(b.fromDate))
    const inEffect = all.filter(row => current(row, now)).at(-1)
    if (
        Object.keys(given).includes("expectedFromDate") &&
        ms(given.expectedFromDate) !== (inEffect ? ms(inEffect.fromDate) : null)
    )
        denied("REASON_CHANGED", "Reason " + reasonCode + " changed; reload before saving")
    const at = blank(given.fromDate) ? Math.max(now, (inEffect ? ms(inEffect.fromDate) : 0) + 1) : ms(given.fromDate)
    if (!Number.isFinite(at) || at < now) denied("REASON_INVALID", "Reason changes take effect now or later")
    if (all.some(row => ms(row.fromDate) === at)) denied("REASON_INVALID", "A change of " + reasonCode + " already starts then")
    const deactivate = given.active === "N" || given.active === false
    if (deactivate) {
        if (!inEffect) denied("REASON_INACTIVE", "Reason " + reasonCode + " is not active")
        return {reasonCode, deactivate, inEffect, at}
    }
    const latest = inEffect || all.at(-1)
    const data = Object.fromEntries(reasonFields.map(name => [name, latest ? (latest[name] ?? null) : null]))
    for (const name of reasonFields) if (Object.keys(given).includes(name)) data[name] = blank(given[name]) ? null : given[name]
    if (blank(data.reasonName)) denied("REASON_INVALID", "Give reason " + reasonCode + " a name")
    if (one("moqui.basic.Enumeration", {enumId: data.reasonCategoryEnumId})?.enumTypeId !== "ProductionReasonCategory")
        denied("REASON_INVALID", "Choose a category for reason " + reasonCode)
    for (const flag of ["equipmentFault", "plannedStop"])
        if (data[flag] != null && !["Y", "N"].includes(data[flag])) denied("REASON_INVALID", "Choose Yes or No for " + flag)
    if (data.approvalThreshold != null) {
        const threshold = Number(String(data.approvalThreshold))
        if (!Number.isFinite(threshold) || threshold < 0) denied("REASON_INVALID", "An approval threshold is zero or more")
    }
    if (data.sequenceNum != null && !Number.isInteger(Number(String(data.sequenceNum))))
        denied("REASON_INVALID", "A sequence is a whole number")
    const after = all.find(row => ms(row.fromDate) > at)
    const before = all.filter(row => ms(row.fromDate) < at && (row.thruDate == null || ms(row.thruDate) > at)).at(-1)
    return {reasonCode, deactivate, before, after, data, at}
}
// store#ProductionReasons: each reason given, on its own: a new code, a change (a dated row that ends the one in effect) or
// a deactivation (the row in effect ends; nothing is deleted). Every row is checked before any is written; a refused row is
// named in the results and the others are kept. Refuses the save when no row could be stored.
function storeReasons(p) {
    requireEdit()
    const scope = scopeOf({organizationPartyId: p.organizationPartyId})
    const why = String(p.changeReason || "").trim()
    if (!why) denied("REASON_INVALID", "Give a reason for the change")
    const given = Array.from(p.reasons || []).map(row => (row?.getMap ? row.getMap() : Object.assign({}, row)))
    if (!given.length) denied("REASON_INVALID", "Give at least one reason")
    find("mantle.party.Party", {partyId: scope.organizationPartyId}).forUpdate(true).one()
    const now = ms(ec.user.nowTimestamp)
    const plans = given.map(row => {
        try {
            return {plan: reasonPlan(scope.organizationPartyId, row, now)}
        } catch (error) {
            return {reasonCode: row.reasonCode || null, error}
        }
    })
    const codes = plans.filter(entry => entry.plan).map(entry => entry.plan.reasonCode)
    const results = []
    ec.context.putAll(
        Object.fromEntries(["fromDate", "thruDate", ...reasonFields, "changeReason"].map(name => [name + "_changeReason", why]))
    )
    for (const entry of plans) {
        if (entry.error || codes.indexOf(entry.plan.reasonCode) !== codes.lastIndexOf(entry.plan.reasonCode)) {
            const error = entry.error || {
                reason: "REASON_INVALID",
                message: "Reason " + entry.plan.reasonCode + " is given twice"
            }
            results.push({
                reasonCode: entry.reasonCode || entry.plan?.reasonCode,
                resultCode: "REFUSED",
                errorCode: lib.reasonCode(error) || "REASON_INVALID",
                message: String(error.message || error)
            })
            continue
        }
        const plan = entry.plan,
            key = {organizationPartyId: scope.organizationPartyId, reasonCode: plan.reasonCode}
        if (plan.deactivate) {
            call(
                "update#" + REASON,
                Object.assign({}, key, {fromDate: iso(ms(plan.inEffect.fromDate)), thruDate: iso(plan.at), changeReason: why})
            )
            results.push({reasonCode: plan.reasonCode, resultCode: "DEACTIVATED", thruDate: iso(plan.at)})
            continue
        }
        if (plan.before)
            call("update#" + REASON, Object.assign({}, key, {fromDate: iso(ms(plan.before.fromDate)), thruDate: iso(plan.at)}))
        call(
            "create#" + REASON,
            Object.assign({}, key, plan.data, {
                fromDate: iso(plan.at),
                thruDate: plan.after ? iso(ms(plan.after.fromDate)) : null,
                changeReason: why
            })
        )
        results.push({reasonCode: plan.reasonCode, resultCode: plan.before ? "CHANGED" : "STORED", fromDate: iso(plan.at)})
    }
    const refused = results.filter(result => result.resultCode === "REFUSED")
    if (refused.length === results.length) throw new Error(refused[0].message)
    for (const result of refused) ec.message.addMessage(result.message, "warning")
    return {organizationPartyId: scope.organizationPartyId, results}
}

const operations = {resolve, store, findReasons, storeReasons}
;({
    fields,
    effective,
    runPolicy,
    overConsumeAllowance,
    activeReason,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown production policy operation " + op)
        return operations[op](parameters)
    }
})
