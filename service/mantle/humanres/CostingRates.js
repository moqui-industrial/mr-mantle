// Labor costing rates (mantle.humanres.RateServices get#CostingRate, find#CostingRates, store#CostingRate, end#CostingRate and
// migrate#ProductionCostRates; IronStone People design PE-23, design-accounting §15 LaborCostingRates; impl-people P10, F34, F61).
//
// A labor costing rate is a RateAmount of the one costing purpose RaprCost: the cost of an hour by position class and work type,
// dated, with its currency, never of a person or a work effort. Labor cost in production, maintenance and project reports is
// approved hours times the costing rate of the entry's class and work type, so no cost reader needs a pay grant, and no person's
// pay rate (a TimeEntry's vendorHourRate, a RaprVendor rate) is ever read here.
//
// get#CostingRate takes over Manufacturing's lookup rules unchanged (mantle/work/ProductionShopFloor.js before P10): the rows in
// effect at the date with no party and no work effort, whose work type and position class match or are empty, the most specific
// first (a work type and a class each count one), then the newest; no currency or rate type narrows it. A class not given is
// the person's (their position in effect at the date: EmplPositionParty, its EmplPosition's class), as production read it. No
// row answers unpriced.
//
// A row may be an organization's (RateAmount.organizationPartyId; the user's call of Nov 11, 2026): the lookup prefers the rows of
// the employer (organizationPartyId given, else the person's employers at the date: a PrtEmployee relationship in effect), by the
// same rules, then the shared rows (no organization), which are every row before P10's review, so production's lookup is
// unchanged where no organization keeps its own. Accounting maintains the rows by organization as it scopes finance
// administration (AccountingPolicy.scope with admin: every internal organization, the active one when chosen); a shared row is
// every organization's, so it is changed only by finance administration working for every organization (no active
// organization chosen) or the system administrator, as a shared pay grade needs PEOPLE_ALL_ORGANIZATIONS. Accounting's readers,
// payroll and those who manage project money read the shared rows and those of their organizations (every organization for
// ACCOUNTING_ADMIN or PEOPLE_ALL_ORGANIZATIONS).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, denied} = lib

const RATE = "mantle.humanres.rate.RateAmount"
const PURPOSE = "RaprCost"
const OLD_PURPOSE = "RaprProductionCost"
const readPermissions = ["ACCOUNTING_ADMIN", "ACCOUNTING_VIEW", "PAYROLL_VIEW", "TIME_ENTRY_RATE"]
const policy = () => ec.resource.script("component://mr-mantle/service/mantle/ledger/AccountingPolicy.js")

const blank = value => value == null || String(value).trim() === ""
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const stamp = value => (value == null ? null : new Date(lib.ms(value)))

// The person's position class at a date: the class of their position in effect then.
function positionClassOf(partyId, at) {
    if (!partyId) return null
    for (const row of rows("mantle.humanres.position.EmplPositionParty", {partyId})) {
        if (!lib.active(row, at)) continue
        const position = one("mantle.humanres.position.EmplPosition", {emplPositionId: row.emplPositionId})
        if (position?.emplPositionClassId) return position.emplPositionClassId
    }
    return null
}

// The person's employers at a date: the organizations of their PrtEmployee relationships in effect then.
function employersOf(partyId, at) {
    if (!partyId) return []
    return Array.from(
        new Set(
            rows("mantle.party.PartyRelationship", {relationshipTypeEnumId: "PrtEmployee", fromPartyId: partyId})
                .filter(row => lib.active(row, at || ec.user.nowTimestamp))
                .map(row => row.toPartyId)
        )
    ).sort()
}

// get#CostingRate: the costing row for a class and work type at a date, the employer's before a shared one, or unpriced.
function costingRate(p) {
    const at = p.onDate || ec.user.nowTimestamp
    const classId = p.emplPositionClassId || positionClassOf(p.partyId, at)
    const workTypeEnumId = p.workTypeEnumId || null
    const organizations = blank(p.organizationPartyId) ? employersOf(p.partyId, at) : [String(p.organizationPartyId)]
    const candidates = rows(RATE, {ratePurposeEnumId: PURPOSE}).filter(
        row =>
            lib.active(row, at) &&
            !row.partyId &&
            !row.workEffortId &&
            (!row.workTypeEnumId || row.workTypeEnumId === workTypeEnumId) &&
            (!row.emplPositionClassId || row.emplPositionClassId === classId)
    )
    const rank = row => (row.workTypeEnumId ? 1 : 0) + (row.emplPositionClassId ? 1 : 0)
    const best = list => list.sort((a, b) => rank(b) - rank(a) || lib.ms(b.fromDate) - lib.ms(a.fromDate))[0] || null
    const found =
        best(candidates.filter(row => row.organizationPartyId && organizations.includes(row.organizationPartyId))) ||
        best(candidates.filter(row => !row.organizationPartyId))
    return {
        priced: !!found,
        rateAmountId: found?.rateAmountId || null,
        rateAmount: found?.rateAmount ?? null,
        rateCurrencyUomId: found?.rateCurrencyUomId || null,
        timePeriodUomId: found?.timePeriodUomId || null,
        emplPositionClassId: classId,
        organizationPartyId: found?.organizationPartyId || null
    }
}

function requireRead() {
    if (!ec.user.userId || !readPermissions.some(permission => ec.user.hasPermission(permission)))
        denied("PERMISSION_DENIED", "Labor costing rates are not available")
}
function requireAdmin() {
    if (!ec.user.userId || !ec.user.hasPermission("ACCOUNTING_ADMIN"))
        denied("PERMISSION_DENIED", "Only finance administration (ACCOUNTING_ADMIN) changes labor costing rates")
}
// The organizations whose rows the reader sees beside the shared ones: every one (all) for the system administrator,
// ACCOUNTING_ADMIN (Accounting's finance administration is every internal organization) or PEOPLE_ALL_ORGANIZATIONS, else the
// user's own organizations.
function readOrganizations() {
    if (
        ec.user.userId &&
        (ec.user.isInGroup("ADMIN") ||
            ec.user.hasPermission("ACCOUNTING_ADMIN") ||
            ec.user.hasPermission("PEOPLE_ALL_ORGANIZATIONS"))
    )
        return {all: true, ids: []}
    const info = ec.user.userId ? lib.call("mantle.party.PartyServices.get#PartyOrganizationInfo") : {}
    return {all: false, ids: Array.from(info?.userOrgIds || [])}
}
// Who changes a row of an organization (organizationPartyId) or a shared one (none): finance administration (ACCOUNTING_ADMIN)
// with the organization in its Accounting scope (AccountingPolicy.scope admin: every internal organization, narrowed to the
// active one when chosen); a shared row with every organization in that scope (no active organization) or the system
// administrator. writeScope answers without refusing, for the lists; requireWrite refuses (PERMISSION_DENIED, ORGANIZATION_DENIED).
function writeScope() {
    if (!ec.user.userId || !ec.user.hasPermission("ACCOUNTING_ADMIN")) return {admin: false, shared: false, ids: []}
    const a = policy().access("admin")
    const allowed = Array.from(a.allowedOrganizationPartyIds || [])
    const shared =
        !!a.capabilities?.systemAdmin ||
        (!a.activeOrganizationPartyId && allowed.length === Array.from(a.organizationPartyIds || []).length)
    return {admin: true, shared, ids: allowed}
}
function mayWrite(scope, organizationPartyId) {
    return scope.admin && (blank(organizationPartyId) ? scope.shared : scope.ids.includes(String(organizationPartyId)))
}
function requireWrite(organizationPartyId) {
    requireAdmin()
    const scope = writeScope()
    if (blank(organizationPartyId)) {
        if (!scope.shared)
            denied(
                "ORGANIZATION_DENIED",
                "A shared labor costing rate is every organization's: change it working for every organization, not one"
            )
        return null
    }
    if (
        !one("mantle.party.PartyRole", {partyId: String(organizationPartyId), roleTypeId: "OrgInternal"}) ||
        !scope.ids.includes(String(organizationPartyId))
    )
        denied("ORGANIZATION_DENIED", "Organization " + organizationPartyId + " is not available")
    return String(organizationPartyId)
}

// A row for a list: its scope, dates, amount and state, as texts in the user's zone.
function display(row, nowMs, canEdit) {
    const from = lib.ms(row.fromDate),
        thru = lib.ms(row.thruDate)
    const ended = thru != null && thru <= nowMs
    const coming = from != null && from > nowMs
    const currency = row.rateCurrencyUomId || null
    const classRow = row.emplPositionClassId
        ? one("mantle.humanres.position.EmplPositionClass", {emplPositionClassId: row.emplPositionClassId})
        : null
    return {
        rateAmountId: row.rateAmountId,
        organizationPartyId: row.organizationPartyId || null,
        organizationText: row.organizationPartyId
            ? one("mantle.party.Organization", {partyId: row.organizationPartyId})?.organizationName || row.organizationPartyId
            : ec.l10n.localize("Every organization"),
        positionText: row.emplPositionClassId ? classRow?.title || row.emplPositionClassId : ec.l10n.localize("Any position"),
        workTypeEnumId: row.workTypeEnumId || null,
        workTypeText: row.workTypeEnumId ? enumText(row.workTypeEnumId) : ec.l10n.localize("Any work"),
        rateTypeEnumId: row.rateTypeEnumId || null,
        rateTypeText: enumText(row.rateTypeEnumId),
        rateAmount: row.rateAmount,
        rateCurrencyUomId: currency,
        amountText:
            row.rateAmount == null
                ? ""
                : (currency ? ec.l10n.formatCurrency(row.rateAmount, currency) : ec.l10n.format(row.rateAmount, "#,##0.00##")) +
                  " / h",
        fromText: from == null ? "" : ec.l10n.format(new Date(from), "MMM d, yyyy"),
        thruText: thru == null ? "" : ec.l10n.format(new Date(thru), "MMM d, yyyy"),
        stateText: ended
            ? ec.l10n.localize("Ended")
            : coming
              ? ec.l10n.localize("From") + " " + ec.l10n.format(new Date(from), "MMM d")
              : ec.l10n.localize("Current"),
        ended,
        coming,
        canChange: !!canEdit && !ended
    }
}

// find#CostingRates: the costing rows the reader sees (the shared ones and those of their organizations; with organizationPartyId
// that organization's and the shared ones), current and coming (ended ones with showEnded), by class then work type; canChange
// by the write scope of each row's organization.
function findRates(p) {
    requireRead()
    const readable = readOrganizations()
    const write = writeScope()
    const nowMs = lib.ms(ec.user.nowTimestamp)
    const only = blank(p.organizationPartyId) ? null : String(p.organizationPartyId)
    if (only && !readable.all && !readable.ids.includes(only))
        denied("ORGANIZATION_DENIED", "Organization " + only + " is not available")
    let query = find(RATE, {ratePurposeEnumId: PURPOSE})
    if (p.emplPositionClassId) query = query.condition("emplPositionClassId", p.emplPositionClassId)
    if (p.workTypeEnumId) query = query.condition("workTypeEnumId", p.workTypeEnumId)
    const found = Array.from(
        query.orderBy("emplPositionClassId").orderBy("workTypeEnumId").orderBy("-fromDate").limit(1000).list()
    )
        .filter(row => !row.partyId && !row.workEffortId)
        .filter(row =>
            !row.organizationPartyId
                ? true
                : only
                  ? row.organizationPartyId === only
                  : readable.all || readable.ids.includes(row.organizationPartyId)
        )
        .map(row => display(row, nowMs, mayWrite(write, row.organizationPartyId)))
        .filter(row => p.showEnded === true || p.showEnded === "Y" || p.showEnded === "true" || !row.ended)
    return {
        rateList: found,
        canEdit: write.admin && (write.shared || write.ids.length > 0),
        canEditShared: mayWrite(write, null),
        canEditOrganization: only ? mayWrite(write, only) : write.admin && write.ids.length > 0
    }
}

// The rows of one scope (organization, class, work type and rate type, no party or work effort).
function scopeRows(organizationPartyId, classId, workTypeEnumId, rateTypeEnumId) {
    return rows(RATE, {
        ratePurposeEnumId: PURPOSE,
        organizationPartyId: organizationPartyId || null,
        emplPositionClassId: classId || null,
        workTypeEnumId: workTypeEnumId || null,
        rateTypeEnumId
    }).filter(row => !row.partyId && !row.workEffortId)
}

// store#CostingRate: a new costing row of an organization (or shared) from fromDate (now when empty), ending the row of the same
// scope in effect then.
function storeRate(p) {
    const organizationPartyId = requireWrite(p.organizationPartyId)
    const classId = blank(p.emplPositionClassId) ? null : String(p.emplPositionClassId)
    const workTypeEnumId = blank(p.workTypeEnumId) ? null : String(p.workTypeEnumId)
    const rateTypeEnumId = blank(p.rateTypeEnumId) ? "RatpStandard" : String(p.rateTypeEnumId)
    if (classId && !one("mantle.humanres.position.EmplPositionClass", {emplPositionClassId: classId}))
        denied("RATE_INVALID", "No position class " + classId)
    if (workTypeEnumId && one("moqui.basic.Enumeration", {enumId: workTypeEnumId})?.enumTypeId !== "WorkType")
        denied("RATE_INVALID", "Not a work type: " + workTypeEnumId)
    if (one("moqui.basic.Enumeration", {enumId: rateTypeEnumId})?.enumTypeId !== "RateType")
        denied("RATE_INVALID", "Not a rate type: " + rateTypeEnumId)
    const amountText = String(p.rateAmount ?? "")
        .trim()
        .replace(/,/g, "")
    if (!/^\d+(\.\d{1,6})?$/.test(amountText)) denied("RATE_INVALID", "The rate is an amount, 0 or more")
    if (
        blank(p.rateCurrencyUomId) ||
        one("moqui.basic.Uom", {uomId: p.rateCurrencyUomId})?.uomTypeEnumId !== "UT_CURRENCY_MEASURE"
    )
        denied("RATE_INVALID", "Choose the rate's currency")
    const nowMs = lib.ms(ec.user.nowTimestamp)
    const fromMs = blank(p.fromDate) ? nowMs : lib.ms(p.fromDate)
    if (fromMs == null || Number.isNaN(fromMs)) denied("RATE_INVALID", "From is a date")
    if (fromMs < nowMs - 60000) denied("RATE_INVALID", "A costing rate starts now or later: history stays as it is")
    const sameScope = scopeRows(organizationPartyId, classId, workTypeEnumId, rateTypeEnumId)
    const current = sameScope.find(row => lib.active(row, fromMs)) || null
    // a change of a row the form read: another change since is refused, naming the row in effect
    if (!blank(p.expectedRateAmountId) && current?.rateAmountId !== String(p.expectedRateAmountId))
        denied(
            "REVISION_CHANGED",
            "The costing rate changed since it was read" + (current ? ": the rate in effect is " + current.rateAmountId : "")
        )
    if (sameScope.some(row => lib.ms(row.fromDate) != null && lib.ms(row.fromDate) > fromMs))
        denied("RATE_COMING", "A later costing rate of this position and work type is coming: change or end it first")
    if (current)
        ec.service
            .sync()
            .name("update#" + RATE)
            .parameters({rateAmountId: current.rateAmountId, thruDate: new Date(fromMs)})
            .disableAuthz()
            .call()
    const out =
        ec.service
            .sync()
            .name("create#" + RATE)
            .parameters({
                ratePurposeEnumId: PURPOSE,
                rateTypeEnumId,
                organizationPartyId,
                emplPositionClassId: classId,
                workTypeEnumId,
                rateCurrencyUomId: p.rateCurrencyUomId,
                timePeriodUomId: "TF_hr",
                rateAmount: toDecimal(amountText),
                fromDate: new Date(fromMs)
            })
            .disableAuthz()
            .call() || {}
    if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
    return {rateAmountId: out.rateAmountId, endedRateAmountId: current?.rateAmountId || null}
}

// end#CostingRate: a costing row ends now (a coming one ends at its start, so it never applies), for one who may change its
// organization's rows (a row of another organization answers as a missing one).
function endRate(p) {
    requireAdmin()
    const row = one(RATE, {rateAmountId: p.rateAmountId || "_NA_"})
    if (!row || row.ratePurposeEnumId !== PURPOSE || row.partyId || row.workEffortId)
        denied("RECORD_UNAVAILABLE", "Costing rate " + p.rateAmountId + " is not available")
    if (row.organizationPartyId && !mayWrite(writeScope(), row.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Costing rate " + p.rateAmountId + " is not available")
    requireWrite(row.organizationPartyId)
    const nowMs = lib.ms(ec.user.nowTimestamp)
    if (row.thruDate != null && lib.ms(row.thruDate) <= nowMs) denied("RATE_ENDED", "The costing rate has ended already")
    const fromMs = lib.ms(row.fromDate)
    ec.service
        .sync()
        .name("update#" + RATE)
        .parameters({rateAmountId: row.rateAmountId, thruDate: fromMs != null && fromMs > nowMs ? row.fromDate : stamp(nowMs)})
        .disableAuthz()
        .call()
    if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
    return {rateAmountId: row.rateAmountId}
}

// migrate#ProductionCostRates: Manufacturing's own costing purpose before P10 (RaprProductionCost) becomes the one purpose: its
// rows are moved to RaprCost and the old value is removed; nothing to do once done, or on a new database. Each row on its own, a
// failure logged and the rest moved.
function migrate() {
    let movedCount = 0,
        failedCount = 0
    for (const row of rows(RATE, {ratePurposeEnumId: OLD_PURPOSE})) {
        try {
            ec.service
                .sync()
                .name("update#" + RATE)
                .parameters({rateAmountId: row.rateAmountId, ratePurposeEnumId: PURPOSE})
                .disableAuthz()
                .requireNewTransaction(true)
                .call()
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
            movedCount++
        } catch (error) {
            failedCount++
            ec.message.clearErrors()
            ec.logger.error("Costing rate " + row.rateAmountId + " was not moved to RaprCost: " + error.message)
        }
    }
    const old = one("moqui.basic.Enumeration", {enumId: OLD_PURPOSE})
    if (old && !failedCount && !find(RATE, {ratePurposeEnumId: OLD_PURPOSE}).count()) {
        try {
            old.delete()
        } catch (error) {
            ec.logger.error("The rate purpose " + OLD_PURPOSE + " was not removed: " + error.message)
        }
    }
    if (movedCount) ec.logger.info("Moved " + movedCount + " production costing rates to the labor costing purpose RaprCost")
    return {movedCount, failedCount}
}

// create#RateAmount and update#RateAmount of a RaprCost row: the same write scope as store#CostingRate (the row's organization, or
// shared), so a generic rate service opens no other organization's costing rates.
function checkWrite(p) {
    requireWrite(p.organizationPartyId)
    return {}
}

const operations = {costingRate, findRates, storeRate, endRate, migrate, checkWrite}
function run(op, p) {
    if (!Object.hasOwn(operations, op)) throw new Error("Unknown costing rate operation " + op)
    return operations[op](p || {})
}
;({execute: run, positionClassOf, employersOf})
