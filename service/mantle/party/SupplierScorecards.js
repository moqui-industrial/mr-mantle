// Supplier performance (mantle.party.SupplierServices; design-purchasing §11 Scorecards, ScorecardDetail, §12
// ScorecardPolicies; impl-purchasing P15, §4): an organization's dated scorecard policy, criteria and actions
// (PURCHASE_POLICY_EDIT), the evaluation of its suppliers over a period (SUPPLIER_SCORECARD_EDIT), each a record of its own
// with its measures and evidence, and the risks it keeps about a supplier (SUPPLIER_PROFILE_EDIT). Each write checks its
// permission and that the organization is one of the user's (FacilityScope.js). The buying policy's supplier check reads
// responseOf() and the quote comparison onTimeOf(), which check no permission. Disabled artifact authorization widens
// nothing here.
//
// The measures (§4, design §18): on-time delivery counts each receipt of a line against its first acknowledged date, else
// its required date (or the required date alone, by policy), weighted by the quantity received; quality is the received
// quantity less what was rejected at receipt and what the receipt's inspections disposed as scrap, rework or return to
// supplier (an undecided inspection leaves its receipt out); price variance is the billed amount's absolute difference from
// the ordered price over the ordered amount, in the order's currency and unit; RFQ response counts the invitations sent (the
// first email that went) answered by the RFQ's response date. Fewer eligible receipts than the minimum sample is
// Insufficient data, which draws no response.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const {find, one, rows, call, denied, access, ms, map} = lib

const POLICY = "mantle.party.supplier.SupplierScorecardPolicy",
    CRITERION = "mantle.party.supplier.SupplierScorecardCriterion",
    ACTION = "mantle.party.supplier.SupplierScorecardAction",
    SCORECARD = "mantle.party.supplier.SupplierScorecard",
    MEASURE = "mantle.party.supplier.SupplierScorecardMeasure",
    EVIDENCE = "mantle.party.supplier.SupplierScorecardEvidence",
    RISK = "mantle.party.supplier.SupplierRisk",
    RECEIPT = "mantle.product.receipt.AssetReceipt",
    INSPECTION = "mantle.product.quality.QualityInspection",
    AUDIT = "moqui.entity.EntityAuditLog"
const dayMs = 86400000
const evidenceCap = 2000
// the built-in policy and criteria: Mantle's behavior with no row
const policyDefaults = {periodDays: 90, minimumSample: 5, dueDateBasisEnumId: "SddbAcknowledged"}
const metrics = [
    {metricEnumId: "SsmOnTime", label: "On-time delivery", weight: 40, target: 95, floor: 70, unit: "%"},
    {metricEnumId: "SsmQuality", label: "Quality acceptance", weight: 30, target: 99, floor: 90, unit: "%"},
    {metricEnumId: "SsmPriceVariance", label: "Price variance", weight: 20, target: 0, floor: 10, unit: "%", lowerBetter: true},
    {metricEnumId: "SsmResponse", label: "RFQ response", weight: 10, target: 100, floor: 50, unit: "%"}
]
const metricOf = metricEnumId => metrics.find(metric => metric.metricEnumId === metricEnumId) || null
const effectRank = {SseWarn: 1, SseReview: 2, SseBlock: 3}
// defective dispositions of inspected stock: the rest (release, use as is, quarantine) keep it good or still held
const defectiveDispositions = ["QdScrap", "QdReturnSupplier", "QdRework"]
const undecidedInspection = ["QiDraft", "QiSubmitted"]
const readPermissions = [
    "SUPPLIER_SCORECARD_EDIT",
    "PURCHASE_POLICY_EDIT",
    "PURCHASE_ORDER_EDIT",
    "PURCHASE_APPROVE",
    "PURCHASE_ORDER_APPROVE",
    "SUPPLIER_PROFILE_EDIT"
]

const blank = value => value == null || String(value).trim() === ""
const iso = value => new Date(value).toISOString()
const now = () => ms(ec.user.nowTimestamp)
const current = (row, at) => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at
const dec = value => toDecimal(value ?? 0)
const zero = () => toDecimal(0)
const plain = (value, scale = 1) => (value == null ? null : ec.l10n.format(dec(value), scale ? "0." + "0".repeat(scale) : "0"))
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const dayOf = value => (value == null ? null : ec.l10n.format(new Date(ms(value)), "yyyy-MM-dd"))
// an audit-logged timestamp's text (epoch milliseconds, or a date and time) as milliseconds, or null
function stampOf(text) {
    if (blank(text)) return null
    const value = ms(text)
    if (Number.isFinite(value)) return value
    const parsed = Date.parse(String(text).trim().replace(" ", "T"))
    return Number.isFinite(parsed) ? parsed : null
}
function partyName(partyId) {
    if (!partyId) return ""
    return lib.partyNames([partyId])[partyId] || partyId
}
function numberOf(value, label, low, high, integer) {
    if (blank(value)) return null
    const number = Number(String(value))
    if (!Number.isFinite(number) || number < low || number > high || (integer && !Number.isInteger(number)))
        denied("POLICY_INVALID", label + " is " + (integer ? "a whole number" : "a number") + " from " + low + " to " + high)
    return number
}

// ===== scope =====
// The organization a read or change is for, in the user's organizations: the given one, else the active one, else the
// user's first. It must be an internal organization.
function scopeOf(p) {
    const userScope = facilityScope.scope()
    if (!ec.user.userId || (!userScope.systemAdmin && ec.user.hasPermission("PROJECT_CLIENT")))
        denied("PERMISSION_DENIED", "Supplier performance is not available")
    const organizationPartyId = blank(p.organizationPartyId)
        ? userScope.activeOrganizationPartyId || userScope.memberPartyIds[0] || null
        : String(p.organizationPartyId)
    if (
        !organizationPartyId ||
        !one("mantle.party.PartyRole", {partyId: organizationPartyId, roleTypeId: "OrgInternal"}) ||
        !facilityScope.owns(userScope, organizationPartyId)
    )
        denied("RECORD_UNAVAILABLE", "Organization " + (organizationPartyId || "") + " is not available")
    return organizationPartyId
}
function requireAny(permissions) {
    if (!permissions.some(permission => access.has(permission)))
        denied("PERMISSION_DENIED", permissions.join(" or ") + " is required")
}
// A supplier the organization may evaluate or keep a risk about: a Supplier-role party, not another user's private contact,
// owned by the organization or shared.
function supplierOf(organizationPartyId, supplierPartyId) {
    const party = blank(supplierPartyId) ? null : one("mantle.party.Party", {partyId: supplierPartyId})
    const owner = party?.ownerPartyId
    if (
        !party ||
        (party.privateOwnerUserId && party.privateOwnerUserId !== ec.user.userId) ||
        !one("mantle.party.PartyRole", {partyId: supplierPartyId, roleTypeId: "Supplier"}) ||
        (owner && owner !== "_NA_" && owner !== organizationPartyId)
    )
        denied("SUPPLIER_UNAVAILABLE", "Supplier " + (supplierPartyId || "") + " is not available")
    return party
}

// ===== the policy, criteria and actions in effect =====
function inEffect(entity, conditions, at) {
    return rows(entity, conditions)
        .filter(row => current(row, at))
        .sort((a, b) => ms(b.fromDate) - ms(a.fromDate))
}
// The scorecard policy of an organization at a time: the defaults with the row in effect's values, and that row.
function policyAt(organizationPartyId, at = now()) {
    const row = inEffect(POLICY, {organizationPartyId}, at)[0] || null
    const policy = Object.assign({}, policyDefaults)
    if (row) for (const name of Object.keys(policyDefaults)) if (!blank(row[name])) policy[name] = row[name]
    policy.periodDays = Number(policy.periodDays)
    policy.minimumSample = Number(policy.minimumSample)
    return {policy, row}
}
// Each measure's weight, target and floor at a time: the criterion row in effect, else the built-in.
function criteriaAt(organizationPartyId, at = now()) {
    const all = rows(CRITERION, {organizationPartyId})
    return metrics.map(metric => {
        const row =
            all
                .filter(each => each.metricEnumId === metric.metricEnumId && current(each, at))
                .sort((a, b) => ms(b.fromDate) - ms(a.fromDate))[0] || null
        return {
            metricEnumId: metric.metricEnumId,
            label: metric.label,
            lowerBetter: !!metric.lowerBetter,
            weight: row && row.weight != null ? dec(row.weight) : dec(metric.weight),
            target: row && row.targetValue != null ? dec(row.targetValue) : dec(metric.target),
            floor: row && row.floorValue != null ? dec(row.floorValue) : dec(metric.floor),
            row
        }
    })
}
function actionsAt(organizationPartyId, at = now()) {
    return inEffect(ACTION, {organizationPartyId}, at)
}
function severityRank(enumId) {
    return enumId ? Number(one("moqui.basic.Enumeration", {enumId})?.sequenceNum ?? 0) : 0
}
function actionText(action) {
    const parts = []
    if (action.scoreBelow != null) parts.push("score below " + plain(action.scoreBelow, 0))
    if (action.riskSeverityEnumId) parts.push("a risk of " + enumText(action.riskSeverityEnumId).toLowerCase() + " or higher")
    return enumText(action.effectEnumId) + " on " + (parts.join(" or ") || "nothing")
}

// get#ScorecardPolicy: the organization's scorecard basis in effect, each measure's criterion with its source, the actions
// in effect and starting later, the policy's rows and whether the user may change them.
function getPolicy(p) {
    requireAny(readPermissions)
    const organizationPartyId = scopeOf(p)
    const at = now()
    const {policy, row} = policyAt(organizationPartyId, at)
    const criteria = criteriaAt(organizationPartyId, at)
    const actions = rows(ACTION, {organizationPartyId})
        .filter(action => (ms(action.thruDate) ?? Infinity) > at)
        .sort((a, b) => ms(a.fromDate) - ms(b.fromDate))
    return {
        organizationPartyId,
        organizationName: partyName(organizationPartyId),
        policy: Object.assign({}, policy, {dueDateBasisText: enumText(policy.dueDateBasisEnumId)}),
        policyFromDate: row ? row.fromDate : null,
        policyFromDateText: row ? lib.dateText(row.fromDate) : "",
        expectedFromDate: row ? row.fromDate : null,
        configuredPolicy: row ? map(row) : {},
        criterionRows: criteria.map(criterion => ({
            metricEnumId: criterion.metricEnumId,
            metricText: criterion.label,
            weight: plain(criterion.weight, 0),
            targetValue: plain(criterion.target, 1),
            floorValue: plain(criterion.floor, 1),
            directionText: criterion.lowerBetter ? "Lower is better" : "Higher is better",
            sourceText: criterion.row ? "Since " + lib.dateText(criterion.row.fromDate) : "Built-in",
            fromDate: criterion.row ? criterion.row.fromDate : null
        })),
        actionRows: actions.map(action =>
            Object.assign(map(action), {
                effectText: enumText(action.effectEnumId),
                severityText: enumText(action.riskSeverityEnumId),
                scoreBelowText: action.scoreBelow == null ? "" : plain(action.scoreBelow, 0),
                ruleText: actionText(action),
                fromDateText: lib.dateText(action.fromDate),
                thruDateText: lib.dateText(action.thruDate),
                inEffect: current(action, at)
            })
        ),
        history: rows(POLICY, {organizationPartyId})
            .sort((a, b) => ms(b.fromDate) - ms(a.fromDate))
            .map(each =>
                Object.assign(map(each), {
                    fromDateText: lib.dateText(each.fromDate),
                    thruDateText: lib.dateText(each.thruDate),
                    dueDateBasisText: enumText(each.dueDateBasisEnumId),
                    inEffect: current(each, at)
                })
            ),
        canEdit: access.has("PURCHASE_POLICY_EDIT")
    }
}

// ===== dated changes =====
// The time a change starts: the given start (now or later), else now, after the row in effect started. Refuses a start in
// the past and a second row at the same time.
function changeStart(p, inEffectRow, all) {
    const at = blank(p.fromDate) ? Math.max(now(), (inEffectRow ? ms(inEffectRow.fromDate) : 0) + 1) : ms(p.fromDate)
    if (!Number.isFinite(at)) denied("POLICY_INVALID", "Choose a valid start")
    if (at < now() - 1000) denied("POLICY_INVALID", "Changes take effect now or later")
    if (all.some(row => ms(row.fromDate) === at)) denied("POLICY_INVALID", "A row already starts at this time")
    return at
}
function reasonOf(p) {
    const why = String(p.changeReason || "").trim()
    if (!why) denied("POLICY_INVALID", "Give a reason for the change")
    return why
}
function logReason(fields, why) {
    ec.context.putAll(Object.fromEntries(fields.map(name => [name + "_changeReason", why])))
}
function lockOrganization(organizationPartyId) {
    find("mantle.party.Party", {partyId: organizationPartyId}).forUpdate(true).one()
}

// store#ScorecardPolicy: a dated change of the period, minimum sample and due-date basis; the row in effect ends where the
// new one starts, and fields not given carry over. Refuses a stale expectedFromDate (POLICY_CHANGED) and invalid values.
function storePolicy(p) {
    requireAny(["PURCHASE_POLICY_EDIT"])
    const organizationPartyId = scopeOf(p)
    const why = reasonOf(p)
    lockOrganization(organizationPartyId)
    const key = {organizationPartyId}
    const all = rows(POLICY, key).sort((a, b) => ms(a.fromDate) - ms(b.fromDate))
    const inEffectRow = all.filter(row => current(row, now())).at(-1) || null
    if (Object.keys(p).includes("expectedFromDate") && ms(p.expectedFromDate) !== (inEffectRow ? ms(inEffectRow.fromDate) : null))
        denied("POLICY_CHANGED", "The scorecard policy changed; reload before saving")
    const at = changeStart(p, inEffectRow, all)
    const before = all.filter(row => ms(row.fromDate) < at && (row.thruDate == null || ms(row.thruDate) > at)).at(-1),
        after = all.find(row => ms(row.fromDate) > at)
    const data = {
        periodDays: before?.periodDays ?? null,
        minimumSample: before?.minimumSample ?? null,
        dueDateBasisEnumId: before?.dueDateBasisEnumId ?? null
    }
    if (Object.keys(p).includes("periodDays")) data.periodDays = numberOf(p.periodDays, "The period", 1, 730, true)
    if (Object.keys(p).includes("minimumSample"))
        data.minimumSample = numberOf(p.minimumSample, "The minimum sample", 1, 1000, true)
    if (Object.keys(p).includes("dueDateBasisEnumId")) {
        data.dueDateBasisEnumId = blank(p.dueDateBasisEnumId) ? null : String(p.dueDateBasisEnumId)
        if (
            data.dueDateBasisEnumId &&
            one("moqui.basic.Enumeration", {enumId: data.dueDateBasisEnumId})?.enumTypeId !== "ScorecardDueDateBasis"
        )
            denied("POLICY_INVALID", "Choose a due-date basis")
    }
    logReason(["fromDate", "thruDate", "periodDays", "minimumSample", "dueDateBasisEnumId", "changeReason"], why)
    const fromDate = iso(at)
    if (before) call("update#" + POLICY, {organizationPartyId, fromDate: iso(ms(before.fromDate)), thruDate: fromDate})
    call(
        "create#" + POLICY,
        Object.assign({}, key, data, {
            fromDate,
            thruDate: after ? iso(ms(after.fromDate)) : null,
            changeReason: why,
            changedByUserId: ec.user.userId
        })
    )
    return getPolicy({organizationPartyId})
}

// store#ScorecardCriterion: a dated change of one measure's weight, target and floor (a value not given carries over from
// the row in effect, else the built-in). Refuses an unknown measure, a weight outside 0 to 100, a rate outside 0 to 100 and
// a target on the wrong side of the floor (CRITERION_INVALID).
function storeCriterion(p) {
    requireAny(["PURCHASE_POLICY_EDIT"])
    const organizationPartyId = scopeOf(p)
    const metric = metricOf(p.metricEnumId)
    if (!metric) denied("CRITERION_INVALID", "Choose a measure")
    const why = reasonOf(p)
    lockOrganization(organizationPartyId)
    const key = {organizationPartyId, metricEnumId: metric.metricEnumId}
    const all = rows(CRITERION, key).sort((a, b) => ms(a.fromDate) - ms(b.fromDate))
    const inEffectRow = all.filter(row => current(row, now())).at(-1) || null
    const at = changeStart(p, inEffectRow, all)
    const before = all.filter(row => ms(row.fromDate) < at && (row.thruDate == null || ms(row.thruDate) > at)).at(-1),
        after = all.find(row => ms(row.fromDate) > at)
    const pick = (name, fallback) => (Object.keys(p).includes(name) && !blank(p[name]) ? p[name] : (before?.[name] ?? fallback))
    let weight, target, floor
    try {
        weight = numberOf(pick("weight", metric.weight), "The weight", 0, 100, false)
        target = numberOf(pick("targetValue", metric.target), "The target", 0, 100, false)
        floor = numberOf(pick("floorValue", metric.floor), "The floor", 0, 100, false)
    } catch (error) {
        denied("CRITERION_INVALID", String(error.message).replace(/^POLICY_INVALID: /, ""))
    }
    if (metric.lowerBetter ? target >= floor : target <= floor)
        denied(
            "CRITERION_INVALID",
            metric.label + (metric.lowerBetter ? ": the target is below the floor" : ": the target is above the floor")
        )
    logReason(["fromDate", "thruDate", "weight", "targetValue", "floorValue", "changeReason"], why)
    const fromDate = iso(at)
    if (before) call("update#" + CRITERION, Object.assign({}, key, {fromDate: iso(ms(before.fromDate)), thruDate: fromDate}))
    call(
        "create#" + CRITERION,
        Object.assign({}, key, {
            fromDate,
            thruDate: after ? iso(ms(after.fromDate)) : null,
            weight,
            targetValue: target,
            floorValue: floor,
            changeReason: why,
            changedByUserId: ec.user.userId
        })
    )
    return getPolicy({organizationPartyId})
}

// store#ScorecardAction: a new response rule (a score band, a risk severity or both, and its effect), a change of one (the
// rule ends and the next starts with the changes), or its end (end Y). Refuses a rule with neither band (ACTION_INVALID), a
// score outside 0 to 100, an unknown effect or severity, and another organization's rule (ACTION_UNAVAILABLE).
function storeAction(p) {
    requireAny(["PURCHASE_POLICY_EDIT"])
    const organizationPartyId = scopeOf(p)
    const why = reasonOf(p)
    lockOrganization(organizationPartyId)
    let existing = null
    if (!blank(p.scorecardActionId)) {
        existing = one(ACTION, {scorecardActionId: p.scorecardActionId})
        if (!existing || existing.organizationPartyId !== organizationPartyId)
            denied("ACTION_UNAVAILABLE", "Response rule " + p.scorecardActionId + " is not available")
        if (ms(existing.thruDate) != null && ms(existing.thruDate) <= now())
            denied("ACTION_UNAVAILABLE", "Response rule " + p.scorecardActionId + " has ended")
    }
    const fields = ["fromDate", "thruDate", "scoreBelow", "riskSeverityEnumId", "effectEnumId", "description", "changeReason"]
    logReason(fields, why)
    const at = blank(p.fromDate) ? now() : ms(p.fromDate)
    if (!Number.isFinite(at) || at < now() - 1000) denied("ACTION_INVALID", "Changes take effect now or later")
    if (existing && (p.end === "Y" || p.end === true)) {
        call("update#" + ACTION, {
            scorecardActionId: existing.scorecardActionId,
            thruDate: iso(Math.max(at, ms(existing.fromDate))),
            changeReason: why
        })
        return getPolicy({organizationPartyId})
    }
    const value = name => (Object.keys(p).includes(name) ? (blank(p[name]) ? null : p[name]) : (existing?.[name] ?? null))
    let scoreBelow = value("scoreBelow")
    try {
        scoreBelow = numberOf(scoreBelow, "The score", 0, 100, false)
    } catch (error) {
        denied("ACTION_INVALID", String(error.message).replace(/^POLICY_INVALID: /, ""))
    }
    const riskSeverityEnumId = value("riskSeverityEnumId"),
        effectEnumId = value("effectEnumId")
    if (scoreBelow == null && !riskSeverityEnumId) denied("ACTION_INVALID", "Give a score band or a risk severity")
    if (!effectRank[effectEnumId]) denied("ACTION_INVALID", "Choose what the rule does")
    if (riskSeverityEnumId && one("moqui.basic.Enumeration", {enumId: riskSeverityEnumId})?.enumTypeId !== "SupplierRiskSeverity")
        denied("ACTION_INVALID", "Choose a risk severity")
    if (existing)
        call("update#" + ACTION, {
            scorecardActionId: existing.scorecardActionId,
            thruDate: iso(Math.max(at, ms(existing.fromDate))),
            changeReason: why
        })
    const created = call("create#" + ACTION, {
        organizationPartyId,
        fromDate: iso(existing ? Math.max(at, ms(existing.fromDate)) : at),
        thruDate: blank(p.thruDate) ? null : iso(ms(p.thruDate)),
        scoreBelow,
        riskSeverityEnumId,
        effectEnumId,
        description: value("description"),
        changeReason: why,
        changedByUserId: ec.user.userId
    })
    return Object.assign(getPolicy({organizationPartyId}), {scorecardActionId: created.scorecardActionId})
}

// ===== risks =====
// store#SupplierRisk: a new risk of a supplier (severity, category and its evidence required), a change of one (audit-logged
// with the reason) or its end (end Y: thruDate now). Refuses an unknown severity or category (RISK_INVALID), an end before
// the start, a supplier the organization may not work with (SUPPLIER_UNAVAILABLE) and another organization's risk
// (RISK_UNAVAILABLE).
function storeRisk(p) {
    requireAny(["SUPPLIER_PROFILE_EDIT"])
    const organizationPartyId = scopeOf(p)
    let existing = null
    if (!blank(p.supplierRiskId)) {
        existing = one(RISK, {supplierRiskId: p.supplierRiskId})
        if (!existing || existing.organizationPartyId !== organizationPartyId)
            denied("RISK_UNAVAILABLE", "Risk " + p.supplierRiskId + " is not available")
    }
    const supplierPartyId = existing ? existing.supplierPartyId : p.supplierPartyId
    supplierOf(organizationPartyId, supplierPartyId)
    const why = String(p.changeReason || "").trim()
    if (existing && !why) denied("RISK_INVALID", "Give a reason for the change")
    logReason(
        [
            "severityEnumId",
            "categoryEnumId",
            "ownerPartyId",
            "fromDate",
            "thruDate",
            "description",
            "responseText",
            "changeReason"
        ],
        why || "Recorded"
    )
    if (existing && (p.end === "Y" || p.end === true)) {
        call("update#" + RISK, {
            supplierRiskId: existing.supplierRiskId,
            thruDate: ec.user.nowTimestamp,
            changeReason: why,
            changedByUserId: ec.user.userId
        })
        return {supplierRiskId: existing.supplierRiskId}
    }
    const value = name =>
        Object.keys(p).includes(name) && p[name] !== undefined ? (blank(p[name]) ? null : p[name]) : (existing?.[name] ?? null)
    const data = {
        severityEnumId: value("severityEnumId"),
        categoryEnumId: value("categoryEnumId"),
        ownerPartyId: value("ownerPartyId"),
        description: value("description"),
        responseText: value("responseText"),
        supplierScorecardId: value("supplierScorecardId"),
        fromDate: value("fromDate") ?? (existing ? existing.fromDate : ec.user.nowTimestamp),
        thruDate: value("thruDate")
    }
    if (one("moqui.basic.Enumeration", {enumId: data.severityEnumId || "_NA_"})?.enumTypeId !== "SupplierRiskSeverity")
        denied("RISK_INVALID", "Choose the risk's severity")
    if (one("moqui.basic.Enumeration", {enumId: data.categoryEnumId || "_NA_"})?.enumTypeId !== "SupplierRiskCategory")
        denied("RISK_INVALID", "Choose the risk's category")
    if (blank(data.description)) denied("RISK_INVALID", "Describe the risk and its evidence")
    if (data.thruDate != null && ms(data.thruDate) <= ms(data.fromDate)) denied("RISK_INVALID", "A risk ends after it starts")
    if (data.ownerPartyId && !one("mantle.party.Party", {partyId: data.ownerPartyId}))
        denied("RISK_INVALID", "Choose the risk's owner")
    if (data.supplierScorecardId) {
        const scorecard = one(SCORECARD, {supplierScorecardId: data.supplierScorecardId})
        if (!scorecard || scorecard.organizationPartyId !== organizationPartyId || scorecard.supplierPartyId !== supplierPartyId)
            denied("RISK_INVALID", "The evaluation is not this supplier's")
    }
    if (existing) {
        call(
            "update#" + RISK,
            Object.assign({supplierRiskId: existing.supplierRiskId}, data, {changeReason: why, changedByUserId: ec.user.userId})
        )
        return {supplierRiskId: existing.supplierRiskId}
    }
    const created = call(
        "create#" + RISK,
        Object.assign({organizationPartyId, supplierPartyId}, data, {changeReason: why || null, changedByUserId: ec.user.userId})
    )
    return {supplierRiskId: created.supplierRiskId}
}

// ===== the evaluation =====
// A line's first acknowledged date: the first value its promised date was set to (OrderItem.promisedDate is audit-logged),
// else its promised date now when the log has none.
function firstPromiseOf(orderId, orderItemSeqId, item) {
    const logged = Array.from(
        find(AUDIT, {changedEntityName: "mantle.order.OrderItem", changedFieldName: "promisedDate", pkPrimaryValue: orderId})
            .condition("pkSecondaryValue", orderItemSeqId)
            .orderBy("changedDate")
            .list()
    )
    for (const row of logged) {
        const at = stampOf(row.newValueText)
        if (at != null) return at
    }
    return ms(item?.promisedDate)
}
// The placed purchase orders of the organization from the supplier (never a quote that was not placed).
function ordersOf(organizationPartyId, supplierPartyId) {
    return Array.from(
        find("mantle.order.OrderHeaderAndPart", {customerPartyId: organizationPartyId, vendorPartyId: supplierPartyId})
            .condition("placedDate", "is-not-null", null)
            .selectField("orderId")
            .selectField("orderPartSeqId")
            .selectField("currencyUomId")
            .selectField("estimatedDeliveryDate")
            .limit(5000)
            .list()
    )
}
function chunks(list, size = 500) {
    const out = []
    for (let index = 0; index < list.length; index += size) out.push(list.slice(index, index + size))
    return out
}
// The evidence and measures of a supplier over [from, thru] (an event at the end of the period, now by default, counts), under
// the policy and criteria.
function measure(organizationPartyId, supplierPartyId, from, thru, policy, criteria) {
    const orders = ordersOf(organizationPartyId, supplierPartyId)
    const orderById = Object.fromEntries(orders.map(order => [order.orderId, order]))
    const orderIds = Object.keys(orderById)
    const evidence = []
    const missing = []
    const items = {}
    // a line's first acknowledged date, read once per line (a line may have several receipts)
    const firstPromises = {}
    const firstPromiseOfLine = (orderId, orderItemSeqId, item) => {
        const key = orderId + ":" + orderItemSeqId
        if (!(key in firstPromises)) firstPromises[key] = firstPromiseOf(orderId, orderItemSeqId, item)
        return firstPromises[key]
    }
    const itemOf = (orderId, orderItemSeqId) => {
        const key = orderId + ":" + orderItemSeqId
        if (!(key in items)) items[key] = one("mantle.order.OrderItem", {orderId, orderItemSeqId})
        return items[key]
    }
    // the receipts of the period
    const receipts = []
    for (const ids of chunks(orderIds))
        for (const receipt of find(RECEIPT)
            .condition("orderId", "in", ids)
            .condition("receivedDate", "greater-equals", new Date(from))
            .condition("receivedDate", "less-equals", new Date(thru))
            .orderBy("receivedDate")
            .list())
            receipts.push(receipt)
    const totals = Object.fromEntries(
        metrics.map(metric => [metric.metricEnumId, {numerator: zero(), denominator: zero(), eligible: 0, excluded: 0}])
    )
    // on-time delivery: each receipt against its line's due date, by quantity
    for (const receipt of receipts) {
        const item = itemOf(receipt.orderId, receipt.orderItemSeqId)
        const quantity = dec(receipt.quantityAccepted).add(dec(receipt.quantityRejected))
        const firstPromise =
            policy.dueDateBasisEnumId === "SddbRequired"
                ? null
                : firstPromiseOfLine(receipt.orderId, receipt.orderItemSeqId, item)
        const due = firstPromise ?? ms(item?.requiredByDate)
        const row = {
            metricEnumId: "SsmOnTime",
            orderId: receipt.orderId,
            orderItemSeqId: receipt.orderItemSeqId,
            assetReceiptId: receipt.assetReceiptId,
            dueDate: due == null ? null : new Date(due),
            dueBasisText: firstPromise != null ? "First acknowledged" : due != null ? "Required" : "",
            promisedDate: item?.promisedDate || null,
            eventDate: receipt.receivedDate,
            quantity
        }
        const total = totals.SsmOnTime
        if (due == null || quantity.compare(0) <= 0) {
            row.excludedReason = due == null ? "No acknowledged or required date" : "Nothing received"
            total.excluded++
        } else {
            const onTime = dayOf(receipt.receivedDate) <= dayOf(due)
            row.numerator = onTime ? quantity : zero()
            row.denominator = quantity
            if (!onTime) row.exceptionText = "Late: received " + dayOf(receipt.receivedDate) + ", due " + dayOf(due)
            total.numerator = total.numerator.add(row.numerator)
            total.denominator = total.denominator.add(quantity)
            total.eligible++
        }
        evidence.push(row)
    }
    // quality: each receipt's received quantity less the rejected and defective dispositions of its inspections
    for (const receipt of receipts) {
        const received = dec(receipt.quantityAccepted).add(dec(receipt.quantityRejected))
        const inspections = rows(INSPECTION, {assetReceiptId: receipt.assetReceiptId}).filter(
            row => row.statusId !== "QiCancelled"
        )
        const row = {
            metricEnumId: "SsmQuality",
            orderId: receipt.orderId,
            orderItemSeqId: receipt.orderItemSeqId,
            assetReceiptId: receipt.assetReceiptId,
            qualityInspectionId: inspections[0]?.qualityInspectionId || null,
            eventDate: receipt.receivedDate,
            quantity: received
        }
        const total = totals.SsmQuality
        if (received.compare(0) <= 0) {
            row.excludedReason = "Nothing received"
            total.excluded++
        } else if (inspections.some(inspection => undecidedInspection.includes(inspection.statusId))) {
            row.excludedReason = "Inspection not decided yet"
            total.excluded++
        } else {
            let defective = dec(receipt.quantityRejected)
            for (const inspection of inspections) {
                const disposed = rows("mantle.product.quality.QualityInspectionDisposition", {
                    qualityInspectionId: inspection.qualityInspectionId
                })
                    .filter(disposition => defectiveDispositions.includes(disposition.dispositionEnumId))
                    .reduce((sum, disposition) => sum.add(dec(disposition.quantity)), zero())
                // a rejected result not disposed yet counts as rejected
                const rejected = dec(inspection.quantityRejected)
                defective = defective.add(disposed.compare(rejected) >= 0 ? disposed : rejected)
            }
            if (defective.compare(received) > 0) defective = received
            row.numerator = received.subtract(defective)
            row.denominator = received
            if (defective.compare(0) > 0) row.exceptionText = "Rejected or defective: " + plain(defective, 0)
            total.numerator = total.numerator.add(row.numerator)
            total.denominator = total.denominator.add(received)
            total.eligible++
        }
        evidence.push(row)
    }
    // price variance: the order lines billed in the period, the billed price against the ordered one
    for (const ids of chunks(orderIds)) {
        const billings = Array.from(find("mantle.order.OrderItemBilling").condition("orderId", "in", ids).list())
        const invoices = {}
        for (const billing of billings) {
            invoices[billing.invoiceId] ??= one("mantle.account.invoice.Invoice", {invoiceId: billing.invoiceId})
            const invoice = invoices[billing.invoiceId]
            const billedAt = ms(invoice?.invoiceDate)
            if (!invoice || billedAt == null || billedAt < from || billedAt > thru) continue
            if (["InvoiceCancelled"].includes(invoice.statusId)) continue
            const item = itemOf(billing.orderId, billing.orderItemSeqId)
            const invoiceItem = one("mantle.account.invoice.InvoiceItem", {
                invoiceId: billing.invoiceId,
                invoiceItemSeqId: billing.invoiceItemSeqId
            })
            const quantity = dec(billing.quantity)
            const row = {
                metricEnumId: "SsmPriceVariance",
                orderId: billing.orderId,
                orderItemSeqId: billing.orderItemSeqId,
                assetReceiptId: billing.assetReceiptId || null,
                invoiceId: billing.invoiceId,
                eventDate: invoice.invoiceDate,
                quantity
            }
            const total = totals.SsmPriceVariance
            const order = orderById[billing.orderId]
            if (!item || !invoiceItem || quantity.compare(0) <= 0 || dec(item.unitAmount).compare(0) <= 0) {
                row.excludedReason = "No ordered price or billed quantity"
                total.excluded++
            } else if (invoice.currencyUomId && order?.currencyUomId && invoice.currencyUomId !== order.currencyUomId) {
                row.excludedReason = "Billed in " + invoice.currencyUomId + ", ordered in " + order.currencyUomId
                total.excluded++
            } else {
                const ordered = quantity.multiply(dec(item.unitAmount))
                const billed = quantity.multiply(dec(invoiceItem.amount))
                let difference = billed.subtract(ordered)
                if (difference.compare(0) < 0) difference = zero().subtract(difference)
                row.numerator = difference
                row.denominator = ordered
                if (difference.compare(0) > 0) row.exceptionText = "Billed price differs from the ordered price"
                total.numerator = total.numerator.add(difference)
                total.denominator = total.denominator.add(ordered)
                total.eligible++
            }
            evidence.push(row)
        }
    }
    // RFQ response: the invitations first sent in the period, answered by the RFQ's response date
    const quotes = Array.from(
        find("mantle.order.OrderHeaderAndPart", {
            customerPartyId: organizationPartyId,
            vendorPartyId: supplierPartyId,
            supplierQuote: "Y"
        })
            .selectField("orderId")
            .limit(2000)
            .list()
    )
    for (const quote of quotes) {
        const sentAt = firstSentOf(quote.orderId)
        if (sentAt == null || sentAt < from || sentAt > thru) continue
        const link = rows("mantle.request.RequestItemOrder", {orderId: quote.orderId})[0]
        const rfq = link ? one("mantle.request.Request", {requestId: link.requestId}) : null
        const answered = Array.from(
            find(AUDIT, {
                changedEntityName: "mantle.order.OrderHeader",
                changedFieldName: "statusId",
                pkPrimaryValue: quote.orderId
            })
                .condition("newValueText", "OrderProposed")
                .orderBy("changedDate")
                .limit(1)
                .list()
        )[0]
        const answeredAt = answered ? ms(answered.changedDate) : null
        const dueAt = ms(rfq?.responseRequiredDate)
        const onTime = answeredAt != null && (dueAt == null || dayOf(answeredAt) <= dayOf(dueAt))
        const row = {
            metricEnumId: "SsmResponse",
            orderId: quote.orderId,
            requestId: rfq?.requestId || null,
            dueDate: dueAt == null ? null : new Date(dueAt),
            dueBasisText: dueAt == null ? "" : "Response date",
            eventDate: answeredAt == null ? null : new Date(answeredAt),
            quantity: toDecimal(1),
            numerator: onTime ? toDecimal(1) : zero(),
            denominator: toDecimal(1),
            exceptionText: answeredAt == null ? "Not answered" : onTime ? null : "Answered late"
        }
        const total = totals.SsmResponse
        total.numerator = total.numerator.add(row.numerator)
        total.denominator = total.denominator.add(1)
        total.eligible++
        evidence.push(row)
    }
    // the measures, each scored between its floor and target, and the weighted score of those with evidence
    const missingText = {
        SsmOnTime: "No receipt with a due date in the period",
        SsmQuality: "No decided receipt in the period",
        SsmPriceVariance: "No billed order line in the period",
        SsmResponse: "No RFQ invitation sent in the period"
    }
    let weighted = zero(),
        weights = zero()
    const measureRows = criteria.map(criterion => {
        const total = totals[criterion.metricEnumId]
        const out = {
            metricEnumId: criterion.metricEnumId,
            numerator: total.numerator,
            denominator: total.denominator,
            eligibleCount: total.eligible,
            excludedCount: total.excluded,
            weight: criterion.weight,
            targetValue: criterion.target,
            floorValue: criterion.floor,
            criterionFromDate: criterion.row ? criterion.row.fromDate : null,
            measureValue: null,
            score: null,
            missingText: null
        }
        if (total.denominator.compare(0) <= 0) {
            out.missingText = missingText[criterion.metricEnumId]
            if (criterion.weight.compare(0) > 0) missing.push(criterion.label + ": " + out.missingText.toLowerCase())
            return out
        }
        const value = total.numerator.multiply(100).divide(total.denominator, 4, "HALF_UP")
        const span = criterion.target.subtract(criterion.floor)
        let fraction = value.subtract(criterion.floor).divide(span, 6, "HALF_UP")
        if (fraction.compare(0) < 0) fraction = zero()
        if (fraction.compare(1) > 0) fraction = toDecimal(1)
        out.measureValue = value
        out.score = fraction.multiply(100)
        if (criterion.weight.compare(0) > 0) {
            weighted = weighted.add(out.score.multiply(criterion.weight))
            weights = weights.add(criterion.weight)
        }
        return out
    })
    const eligibleCount = totals.SsmOnTime.eligible
    const insufficient = eligibleCount < policy.minimumSample
    if (insufficient) missing.unshift(eligibleCount + " eligible receipts of the " + policy.minimumSample + " the policy needs")
    if (evidence.length > evidenceCap) missing.push("Only the first " + evidenceCap + " evidence rows are kept")
    return {
        evidence: evidence.slice(0, evidenceCap),
        measureRows,
        eligibleCount,
        insufficient,
        score: weights.compare(0) > 0 ? weighted.divide(weights, 2, "HALF_UP") : null,
        missingDataText: missing.join("; ") || null
    }
}
// When a quote order's invitation first went (its first sent email to the supplier), or null.
function firstSentOf(orderId) {
    const ids = rows("mantle.order.OrderEmailMessage", {orderId})
        .filter(row => row.roleTypeId === "Supplier")
        .map(row => row.emailMessageId)
    if (!ids.length) return null
    const sent = Array.from(
        find("moqui.basic.email.EmailMessage").condition("emailMessageId", "in", ids).condition("statusId", "ES_SENT").list()
    )
        .map(row => ms(row.sentDate || row.lastUpdatedStamp))
        .filter(value => value != null)
    return sent.length ? Math.min(...sent) : null
}
// The response a scored evaluation draws: the most severe action in effect whose band its score is below.
function scoreResponse(organizationPartyId, score, at) {
    if (score == null) return null
    return (
        actionsAt(organizationPartyId, at)
            .filter(action => action.scoreBelow != null && dec(score).compare(dec(action.scoreBelow)) < 0)
            .sort((a, b) => effectRank[b.effectEnumId] - effectRank[a.effectEnumId])[0] || null
    )
}
// The period of an evaluation: the given one, else the policy's days to now. Refuses a period that ends before it starts
// or is longer than two years (PERIOD_INVALID).
function periodOf(p, policy) {
    const thru = blank(p.periodThruDate) ? now() : ms(p.periodThruDate)
    const from = blank(p.periodFromDate) ? thru - policy.periodDays * dayMs : ms(p.periodFromDate)
    if (!Number.isFinite(from) || !Number.isFinite(thru) || thru <= from)
        denied("PERIOD_INVALID", "Choose a period that ends after it starts")
    if (thru - from > 731 * dayMs) denied("PERIOD_INVALID", "A period is at most two years")
    return {from, thru}
}
// evaluate#OneSupplierScorecard: one supplier's evaluation, a record of its own with its measures and evidence. A
// recalculation of the same period names the evaluation it follows, which stays.
function evaluateOne(p) {
    requireAny(["SUPPLIER_SCORECARD_EDIT"])
    const organizationPartyId = scopeOf(p)
    supplierOf(organizationPartyId, p.supplierPartyId)
    const at = now()
    const {policy, row: policyRow} = policyAt(organizationPartyId, at)
    const {from, thru} = periodOf(p, policy)
    const criteria = criteriaAt(organizationPartyId, at)
    const result = measure(organizationPartyId, p.supplierPartyId, from, thru, policy, criteria)
    const response = result.insufficient ? null : scoreResponse(organizationPartyId, result.score, at)
    const previous =
        Array.from(
            find(SCORECARD, {organizationPartyId, supplierPartyId: p.supplierPartyId})
                .condition("periodFromDate", new Date(from))
                .condition("periodThruDate", new Date(thru))
                .orderBy("-evaluatedDate")
                .limit(1)
                .list()
        )[0] || null
    const created = call("create#" + SCORECARD, {
        organizationPartyId,
        supplierPartyId: p.supplierPartyId,
        periodFromDate: new Date(from),
        periodThruDate: new Date(thru),
        policyFromDate: policyRow ? policyRow.fromDate : null,
        dueDateBasisEnumId: policy.dueDateBasisEnumId,
        minimumSample: policy.minimumSample,
        eligibleCount: result.eligibleCount,
        resultEnumId: result.insufficient ? "SsrInsufficient" : "SsrScored",
        score: result.score,
        missingDataText: result.missingDataText,
        scorecardActionId: response ? response.scorecardActionId : null,
        effectEnumId: response ? response.effectEnumId : null,
        previousScorecardId: previous ? previous.supplierScorecardId : null,
        operationKey: blank(p.operationKey) ? null : String(p.operationKey),
        evaluatedDate: ec.user.nowTimestamp,
        evaluatedByUserId: ec.user.userId
    })
    const supplierScorecardId = created.supplierScorecardId
    for (const measureRow of result.measureRows) call("create#" + MEASURE, Object.assign({supplierScorecardId}, measureRow))
    result.evidence.forEach((row, index) =>
        call("create#" + EVIDENCE, Object.assign({supplierScorecardId, evidenceSeqId: String(index + 1).padStart(5, "0")}, row))
    )
    return {
        supplierScorecardId,
        resultEnumId: result.insufficient ? "SsrInsufficient" : "SsrScored",
        score: result.score,
        effectEnumId: response ? response.effectEnumId : null,
        previousScorecardId: previous ? previous.supplierScorecardId : null
    }
}
// The suppliers of the organization with a receipt or a sent invitation in the period, when none are named.
function suppliersInPeriod(organizationPartyId, from, thru) {
    const receiptOrders = Array.from(
        find(RECEIPT)
            .condition("receivedDate", "greater-equals", new Date(from))
            .condition("receivedDate", "less-equals", new Date(thru))
            .condition("orderId", "is-not-null", null)
            .selectField("orderId")
            .distinct(true)
            .limit(5000)
            .list()
    ).map(row => row.orderId)
    const suppliers = new Set()
    for (const ids of chunks(receiptOrders))
        for (const part of find("mantle.order.OrderPart", {customerPartyId: organizationPartyId})
            .condition("orderId", "in", ids)
            .list())
            if (part.vendorPartyId) suppliers.add(part.vendorPartyId)
    return Array.from(suppliers).sort().slice(0, 500)
}
// evaluate#SupplierScorecard: an evaluation of each supplier given (or of every supplier with a receipt in the period), each
// in its own transaction: a supplier that fails is named with its reason and the others go on. A retry with the same
// operation key answers the first result.
function evaluate(p) {
    requireAny(["SUPPLIER_SCORECARD_EDIT"])
    const organizationPartyId = scopeOf(p)
    const {policy} = policyAt(organizationPartyId)
    const {from, thru} = periodOf(p, policy)
    let supplierPartyIds =
        Array.isArray(p.supplierPartyIds) || (p.supplierPartyIds && typeof p.supplierPartyIds !== "string")
            ? Array.from(p.supplierPartyIds)
            : String(p.supplierPartyIds || p.supplierPartyId || "").split(",")
    supplierPartyIds = [...new Set(supplierPartyIds.map(id => String(id).trim()).filter(Boolean))]
    // the request as asked: a period or supplier list left to its default (now, the period's suppliers) is hashed as not
    // given, so a retry later answers the first result instead of a key conflict
    const request = {
        organizationPartyId,
        supplierPartyIds: supplierPartyIds.slice().sort(),
        periodFromDate: blank(p.periodFromDate) ? null : ms(p.periodFromDate),
        periodThruDate: blank(p.periodThruDate) ? null : ms(p.periodThruDate)
    }
    const operation = blank(p.operationKey) ? null : lib.operation(p, "SupplierScorecard", organizationPartyId, request)
    if (operation?.old) return lib.previous(operation)
    if (!supplierPartyIds.length) supplierPartyIds = suppliersInPeriod(organizationPartyId, from, thru)
    const resultRows = supplierPartyIds.map(supplierPartyId => {
        const row = {supplierPartyId, supplierName: partyName(supplierPartyId)}
        try {
            const out = lib.probe("mantle.party.SupplierServices.evaluate#OneSupplierScorecard", {
                organizationPartyId,
                supplierPartyId,
                periodFromDate: new Date(from),
                periodThruDate: new Date(thru),
                operationKey: operation ? operation.operationKey : null
            })
            Object.assign(row, {
                supplierScorecardId: out.supplierScorecardId,
                resultEnumId: out.resultEnumId,
                resultText: enumText(out.resultEnumId),
                scoreText: out.score == null ? "" : plain(out.score, 1),
                effectText: enumText(out.effectEnumId),
                errorText: null
            })
        } catch (error) {
            ec.logger.error(
                "Scorecard of supplier " + supplierPartyId + " for " + organizationPartyId + " failed: " + error.message
            )
            Object.assign(row, {
                supplierScorecardId: null,
                resultEnumId: null,
                resultText: "Not evaluated",
                errorText: String(error.message)
            })
        }
        return row
    })
    const result = {
        organizationPartyId,
        periodFromDate: iso(from),
        periodThruDate: iso(thru),
        resultRows,
        evaluatedCount: resultRows.filter(row => row.supplierScorecardId).length,
        failedCount: resultRows.filter(row => !row.supplierScorecardId).length
    }
    if (operation) lib.complete(operation, SCORECARD, null, result)
    return result
}

// ===== for the buying policy and the quote comparison (no permission check) =====
// The response a supplier's performance draws for the organization at a time: the latest evaluation's (a scored one only)
// and that of each active risk at or above an action's severity, the most severe first. Null when nothing responds, and
// at once when the organization has no action at all (Mantle's behavior with no row).
function responseOf(organizationPartyId, supplierPartyId, at) {
    if (!organizationPartyId || !supplierPartyId) return null
    const when = at == null ? now() : ms(at)
    const actions = actionsAt(organizationPartyId, when)
    if (!actions.length) return null
    const responses = []
    const latest = Array.from(
        find(SCORECARD, {organizationPartyId, supplierPartyId})
            .condition("evaluatedDate", "less-equals", new Date(when))
            .orderBy("-evaluatedDate")
            .limit(1)
            .list()
    )[0]
    // the response the evaluation drew, while the rule that drew it is in effect (ending or changing it lifts it)
    if (
        latest &&
        latest.resultEnumId === "SsrScored" &&
        latest.effectEnumId &&
        actions.some(action => action.scorecardActionId === latest.scorecardActionId)
    )
        responses.push({
            effectEnumId: latest.effectEnumId,
            supplierScorecardId: latest.supplierScorecardId,
            message:
                partyName(supplierPartyId) +
                " scored " +
                plain(latest.score, 1) +
                " in the evaluation of " +
                lib.dateText(latest.evaluatedDate)
        })
    const risks = rows(RISK, {organizationPartyId, supplierPartyId}).filter(risk => current(risk, when))
    for (const risk of risks) {
        const rank = severityRank(risk.severityEnumId)
        for (const action of actions.filter(
            action => action.riskSeverityEnumId && rank >= severityRank(action.riskSeverityEnumId)
        ))
            responses.push({
                effectEnumId: action.effectEnumId,
                supplierRiskId: risk.supplierRiskId,
                message:
                    partyName(supplierPartyId) +
                    " has a " +
                    enumText(risk.severityEnumId).toLowerCase() +
                    " " +
                    enumText(risk.categoryEnumId).toLowerCase() +
                    " risk: " +
                    (risk.description || "")
            })
    }
    if (!responses.length) return null
    responses.sort((a, b) => effectRank[b.effectEnumId] - effectRank[a.effectEnumId])
    return Object.assign({}, responses[0], {
        result: responses[0].effectEnumId === "SseBlock" ? "STOP" : "WARN",
        reviewNeeded: responses.some(response => response.effectEnumId !== "SseWarn"),
        message: [...new Set(responses.map(response => response.message))].join("; ")
    })
}
// A supplier's on-time rate from its latest evaluation for the organization, with the sample, or null when never
// evaluated.
function onTimeOf(organizationPartyId, supplierPartyId) {
    if (!organizationPartyId || !supplierPartyId) return null
    const latest = Array.from(
        find(SCORECARD, {organizationPartyId, supplierPartyId}).orderBy("-evaluatedDate").limit(1).list()
    )[0]
    if (!latest) return null
    const onTime = one(MEASURE, {supplierScorecardId: latest.supplierScorecardId, metricEnumId: "SsmOnTime"})
    const rate = onTime?.measureValue == null ? null : dec(onTime.measureValue)
    const sample = Number(onTime?.eligibleCount ?? 0)
    return {
        supplierScorecardId: latest.supplierScorecardId,
        rate: rate == null ? null : plain(rate, 1),
        insufficient: latest.resultEnumId === "SsrInsufficient",
        text:
            rate == null
                ? "No receipts to " + lib.dateText(latest.periodThruDate)
                : plain(rate, 0) +
                  "% on time · " +
                  sample +
                  (sample === 1 ? " receipt" : " receipts") +
                  (latest.resultEnumId === "SsrInsufficient" ? ", insufficient data" : "") +
                  " to " +
                  lib.dateText(latest.periodThruDate)
    }
}

const operations = {getPolicy, storePolicy, storeCriterion, storeAction, storeRisk, evaluate, evaluateOne}
;({
    metrics,
    responseOf,
    onTimeOf,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown supplier scorecard operation " + op)
        return operations[op](parameters || {})
    }
})
