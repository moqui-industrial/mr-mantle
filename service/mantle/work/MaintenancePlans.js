// Preventive maintenance plans and their due projection (mantle.work.MaintenancePlanServices; IronStone Maintenance design §5.1,
// Plans and PlanDetail, MT-05; impl-maintenance P13). A plan (MaintenanceSchedule) is one piece of equipment's or one facility's,
// with dated terms (MaintenanceScheduleTerm) carrying one trigger, calendar or meter; a term field left empty takes the value of
// the equipment model's maintenance default the plan follows (ProductMaintenance), and the plan says where each value came from.
//
// - Authority (permissions, never a group): MAINTENANCE_VIEW reads the plans of the caller's maintenance organizations;
//   MAINTENANCE_PLAN or MAINTENANCE_SUPERVISE makes, changes, activates and ends them. A plan's organization is its target's (an
//   asset's internal owner, else its facility's; a facility's owner or nearest owning ancestor, MaintenanceAccess.js). A missing
//   plan and one outside the scope are refused alike (RECORD_UNAVAILABLE).
// - States: Draft (its terms changed in place), Active (a change of its terms ends the term in effect and starts the next from
//   the effective time, with a reason; the work done under the earlier term stays as it was) and Ended (with a reason).
//   Activation needs the target's time zone (Facility.timeZone, inherited, F16: no server zone is assumed) and the trigger's terms
//   complete. A procedure is optional (the user's call, Nov 12): one named, by the plan or its model default, must qualify
//   (approved, in effect, applicable to the target, of the plan's organization); with none, P14 makes an ad hoc work order with
//   the plan's name and estimate (estimatedWorkTime, hours). A change of a plan whose target has moved to another organization is
//   refused (TARGET_MOVED); it may still be ended.
// - The due projection (design §5.1), read as of a time, changes nothing:
//   - a calendar plan's obligations fall on its local first due date and time in the target's zone and every interval after it
//     (fixed cadence) or one interval after the last completion (completion cadence); months and years keep the first date's
//     day, clamped to a short month's last day and back to the day after it (the 31st, the 30th of April, the 31st of May); the
//     local wall time holds across a daylight-saving change. A due date on a weekend or holiday is planned on the next business
//     day (EventServices.get#NextBusinessDay, over the organization's WepHoliday events and the term's People holiday calendar,
//     impl-maintenance F64) when the term asks for business days, and the due date stays the obligation. A completion covers the
//     earliest obligation not yet covered that falls before the next one after it, and only once it is later than the obligation one
//     interval before the first (an older one, such as a model default's record from before the plan, covers nothing);
//     obligations past and not covered are overdue.
//   - a meter plan reads a counting meter of the equipment's model: its baseline is the later of the plan's baseline and the
//     reading taken in the last counted completion that took one; the usage since then sums the valid readings across a reset; the next threshold is
//     the baseline plus the increment. A reading older than the plan's maximum age (30 days unless set), or none at all, leaves
//     the due unknown, never "not due".
//   - a completion counts only when its work order (MaintenanceWorkOrder.maintenanceScheduleId) is complete or closed, or, for
//     equipment work under a model default, its AssetMaintenance of that default is completed; a planned or cancelled one counts
//     for nothing. A reading AssetServices' create#AssetMaintenance made from a planned interval (a synthetic threshold: no
//     reason, a maintenance record not completed) is no observation. EquipmentServices.get#AssetMaintenanceNeeded is the
//     baseline's helper and is not called (impl-maintenance F11).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const maintenanceAccess = ec.resource.script("component://mr-mantle/service/mantle/work/MaintenanceAccess.js")
const resources = ec.resource.script("component://mr-mantle/service/mantle/product/MaintenanceResources.js")
const procedures = ec.resource.script("component://mr-mantle/service/mantle/work/MaintenanceProcedures.js")
const {find, one, rows, denied, call, ms} = lib

const SCHEDULE = "mantle.work.maintenance.MaintenanceSchedule"
const TERM = "mantle.work.maintenance.MaintenanceScheduleTerm"
const ORDER = "mantle.work.maintenance.MaintenanceWorkOrder"
const WORK = "mantle.work.effort.WorkEffort"
const ASSET = "mantle.product.asset.Asset"
const FACILITY = "mantle.facility.Facility"
const METER = "mantle.product.maintenance.AssetMeter"
const PRODUCT_METER = "mantle.product.maintenance.ProductMeter"
const PRODUCT_MAINTENANCE = "mantle.product.maintenance.ProductMaintenance"
const ASSET_MAINTENANCE = "mantle.product.maintenance.AssetMaintenance"
const CATEGORY = "mantle.work.effort.WorkEffortCategory"

const statusNames = {MschDraft: "Draft", MschActive: "Active", MschEnded: "Ended"}
const calendarUnits = {TF_day: ["day", "days"], TF_wk: ["week", "weeks"], TF_mon: ["month", "months"], TF_yr: ["year", "years"]}
const completedStatuses = ["WeComplete", "WeClosed"]
const defaultMaxAgeDays = 30
const dayMs = 24 * 60 * 60 * 1000
// obligations walked at most per projection, and plans read at most by find#MaintenanceDue
const obligationCap = 2000
const dueScheduleCap = 500
const defaultTime = "08:00"

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const flag = value => value === true || value === "true" || value === "Y"
const number = value => (blank(value) ? null : Number(String(value)))
const numberText = value => (value == null ? "" : String(Math.round(Number(value) * 1000) / 1000))
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const uomText = uomId => (uomId ? one("moqui.basic.Uom", {uomId})?.abbreviation || uomId : "")
const nowMs = () => ms(ec.user.nowTimestamp)
const unavailable = id => denied("RECORD_UNAVAILABLE", "Maintenance plan " + (id || "") + " is not available")

// ===== scope =====
function signedIn() {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in to use maintenance plans")
}
// A reader of plans: MAINTENANCE_VIEW (a write permission alone reads nothing).
function readScope() {
    signedIn()
    const userScope = maintenanceAccess.scope()
    if (!userScope.capabilities.view) denied("PERMISSION_DENIED", "Maintenance view is required")
    return userScope
}
// A planner of plans: MAINTENANCE_PLAN or MAINTENANCE_SUPERVISE.
function writeScope() {
    signedIn()
    const userScope = maintenanceAccess.scope()
    if (!userScope.capabilities.plan && !userScope.capabilities.supervise)
        denied("PERMISSION_DENIED", "A maintenance planner or supervisor keeps the plans")
    return userScope
}
const canWrite = userScope => !!(userScope.capabilities.plan || userScope.capabilities.supervise)
// A list's scope (impl-maintenance F83): a holder of every organization who has chosen an active internal organization lists that
// organization's plans; anyone else's scope is as it is.
function listScope(userScope) {
    if (userScope.organizationPartyIds != null) return userScope
    const info = ec.service.sync().name("mantle.party.PartyServices.get#PartyOrganizationInfo").disableAuthz().call() || {}
    const active = userScope.activeOrganizationPartyId || info.activeOrgId || null
    if (!active || !one("mantle.party.PartyRole", {partyId: active, roleTypeId: "OrgInternal"})) return userScope
    return Object.assign({}, userScope, {organizationPartyIds: [active]})
}
// A plan the caller may reach, locked when asked.
function scheduleOf(userScope, maintenanceScheduleId, lock = false) {
    const id = text(maintenanceScheduleId)
    if (!id) unavailable(id)
    let query = find(SCHEDULE, {maintenanceScheduleId: id})
    if (lock) query = query.forUpdate(true)
    const schedule = query.one()
    if (!schedule || !maintenanceAccess.covers(userScope, schedule.organizationPartyId)) unavailable(id)
    return schedule
}
function requireRevision(schedule, expectedRevision) {
    if (blank(expectedRevision)) return
    if (Number(expectedRevision) !== Number(schedule.revision || 0))
        denied(
            "RECORD_CHANGED",
            "Plan " + schedule.maintenanceScheduleId + " was changed (now revision " + (schedule.revision || 0) + "); reload it"
        )
}

// ===== target =====
// The plan's target: one piece of equipment (not stock) or one facility of the caller's scope, with its organization, its time
// zone (inherited, null when none in its ancestry), its name and, for equipment, its model.
function targetOf(userScope, assetId, facilityId) {
    if (assetId && facilityId) denied("TARGET_INVALID", "A plan is for one piece of equipment or one facility")
    if (assetId) {
        const asset = one(ASSET, {assetId})
        if (!asset || !asset.assetTypeEnumId || resources.stockTypes.includes(asset.assetTypeEnumId))
            denied("RECORD_UNAVAILABLE", "Equipment " + assetId + " is not available")
        const organizationPartyId = maintenanceAccess.assetOrganization(assetId)
        if (userScope && !maintenanceAccess.covers(userScope, organizationPartyId))
            denied("RECORD_UNAVAILABLE", "Equipment " + assetId + " is not available")
        return {
            assetId,
            facilityId: null,
            organizationPartyId,
            productId: asset.productId || null,
            name: asset.assetName || assetId,
            zone: asset.facilityId ? resources.facilityTimeZone(asset.facilityId) : null
        }
    }
    if (facilityId) {
        const facility = one(FACILITY, {facilityId})
        const organizationPartyId = facility ? maintenanceAccess.facilityOrganization(facilityId) : null
        if (!facility || (userScope && !maintenanceAccess.covers(userScope, organizationPartyId)))
            denied("RECORD_UNAVAILABLE", "Facility " + facilityId + " is not available")
        return {
            assetId: null,
            facilityId,
            organizationPartyId,
            productId: null,
            name: facility.facilityName || facilityId,
            zone: resources.facilityTimeZone(facilityId)
        }
    }
    denied("TARGET_REQUIRED", "Choose the equipment or the facility the plan is for")
}
const scheduleTarget = schedule => targetOf(null, schedule.assetId, schedule.facilityId)

// ===== terms =====
const termFields = [
    "triggerEnumId",
    "cadenceEnumId",
    "intervalQuantity",
    "intervalUomId",
    "firstDueLocal",
    "productMeterId",
    "baselineValue",
    "baselineDate",
    "maxReadingAgeDays",
    "businessDaysOnly",
    "holidayCategoryId",
    "leadDays",
    "templateWorkEffortId",
    "maintenanceTypeEnumId",
    "teamPartyId",
    "estimatedWorkTime"
]
const numericTermFields = ["intervalQuantity", "baselineValue", "maxReadingAgeDays", "leadDays", "estimatedWorkTime"]
function termsOf(maintenanceScheduleId) {
    return rows(TERM, {maintenanceScheduleId}).sort((a, b) => ms(b.fromDate) - ms(a.fromDate))
}
// The term in effect at a time: the latest begun and not ended; for a plan not yet begun (a draft, a term from later), its first.
function termAt(maintenanceScheduleId, at = nowMs()) {
    const terms = termsOf(maintenanceScheduleId)
    return (
        terms.find(row => ms(row.fromDate) <= at && (row.thruDate == null || ms(row.thruDate) > at)) ||
        terms.find(row => row.thruDate == null) ||
        terms[0] ||
        null
    )
}
// The term's values with the model default's where it leaves one empty, and the origin of each ("plan", "model default" or none).
function resolve(schedule, term) {
    const defaults = schedule.productMaintenanceId
        ? one(PRODUCT_MAINTENANCE, {productMaintenanceId: schedule.productMaintenanceId})
        : null
    const origin = {}
    const value = (field, own, inherited) => {
        if (!blank(own)) {
            origin[field] = "plan"
            return own
        }
        if (!blank(inherited)) {
            origin[field] = "model default"
            return inherited
        }
        origin[field] = null
        return null
    }
    const t = term || {}
    const productMeterId = value("productMeterId", t.productMeterId, defaults?.intervalProductMeterId)
    const triggerEnumId = t.triggerEnumId || (productMeterId ? "MstMeter" : "MstCalendar")
    return {
        triggerEnumId,
        meter: triggerEnumId === "MstMeter",
        cadenceEnumId: t.cadenceEnumId || "MscFixed",
        intervalQuantity: number(value("intervalQuantity", t.intervalQuantity, defaults?.intervalQuantity)),
        intervalUomId: value("intervalUomId", t.intervalUomId, defaults?.intervalProductMeterId ? null : defaults?.intervalUomId),
        productMeterId: triggerEnumId === "MstMeter" ? productMeterId : null,
        templateWorkEffortId: value("templateWorkEffortId", t.templateWorkEffortId, defaults?.templateWorkEffortId),
        maintenanceTypeEnumId: value("maintenanceTypeEnumId", t.maintenanceTypeEnumId, defaults?.maintenanceTypeEnumId),
        firstDueLocal: text(t.firstDueLocal),
        baselineValue: number(t.baselineValue),
        baselineDate: t.baselineDate ? ms(t.baselineDate) : null,
        maxReadingAgeDays: number(t.maxReadingAgeDays) ?? defaultMaxAgeDays,
        businessDaysOnly: flag(t.businessDaysOnly),
        holidayCategoryId: text(t.holidayCategoryId),
        leadDays: number(t.leadDays) ?? 0,
        teamPartyId: text(t.teamPartyId),
        estimatedWorkTime: number(t.estimatedWorkTime),
        defaults,
        origin
    }
}
// A first due date as entered: yyyy-MM-dd, with HH:mm or not (the default time then), as the local text kept on the term.
function localDueText(value) {
    // the whole text: a date, and a time of day with no zone or offset (the target's zone applies), seconds zero when given
    const found = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2})(?::00(?:\.0+)?)?)?$/.exec(String(value || "").trim())
    if (!found) denied("DATE_INVALID", "Enter the first due date as yyyy-MM-dd HH:mm, the local time of the target")
    const day = found[1]
    const [y, m, d] = day.split("-").map(Number)
    const check = new Date(Date.UTC(y, m - 1, d))
    if (check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) denied("DATE_INVALID", "Enter the first due date as a date")
    const time = found[2] ? String(found[2]).padStart(2, "0") + ":" + found[3] : defaultTime
    if (Number(time.slice(0, 2)) > 23 || Number(time.slice(3)) > 59) denied("DATE_INVALID", "Enter a time of day")
    return day + " " + time
}
// The term a write asks for: its fields checked for what they are (complete terms are activation's), the empty ones left null.
function termFrom(p, target) {
    const term = {}
    for (const field of termFields) term[field] = blank(p[field]) ? null : p[field]
    if (
        term.triggerEnumId &&
        !one("moqui.basic.Enumeration", {enumId: term.triggerEnumId, enumTypeId: "MaintenanceScheduleTrigger"})
    )
        denied("VALUE_INVALID", "Choose calendar or meter")
    if (
        term.cadenceEnumId &&
        !one("moqui.basic.Enumeration", {enumId: term.cadenceEnumId, enumTypeId: "MaintenanceScheduleCadence"})
    )
        denied("VALUE_INVALID", "Choose how the dates follow")
    if (term.intervalUomId && !Object.hasOwn(calendarUnits, term.intervalUomId))
        denied("VALUE_INVALID", "Choose days, weeks, months or years")
    for (const field of numericTermFields) {
        if (term[field] == null) continue
        const value = Number(String(term[field]))
        if (!Number.isFinite(value) || value < 0 || (field !== "baselineValue" && field !== "leadDays" && value === 0))
            denied("VALUE_INVALID", "Enter a positive number")
        if (["maxReadingAgeDays", "leadDays"].includes(field) && !Number.isInteger(value))
            denied("VALUE_INVALID", "Enter a whole number of days")
    }
    if (term.firstDueLocal) term.firstDueLocal = localDueText(term.firstDueLocal)
    if (term.baselineDate && ms(term.baselineDate) > nowMs() + 60000)
        denied("DATE_FUTURE", "A baseline reading is taken now or earlier")
    term.businessDaysOnly = flag(term.businessDaysOnly) ? "Y" : null
    if (term.holidayCategoryId) {
        const calendar = one(CATEGORY, {workEffortCategoryId: term.holidayCategoryId})
        if (
            !calendar ||
            calendar.categoryTypeEnumId !== "WcatHoliday" ||
            (calendar.ownerPartyId && calendar.ownerPartyId !== target.organizationPartyId)
        )
            denied("VALUE_INVALID", "Choose a holiday calendar of the organization or a shared one")
    }
    // a procedure named is a maintenance procedure of the plan's organization (whether it qualifies is activation's finding)
    if (term.templateWorkEffortId) {
        const found = procedures.procedureOf(term.templateWorkEffortId)
        if (!found || found.organizationPartyId !== target.organizationPartyId)
            denied("VALUE_INVALID", "Choose a maintenance procedure of the organization")
    }
    if (
        term.maintenanceTypeEnumId &&
        !one("moqui.basic.Enumeration", {enumId: term.maintenanceTypeEnumId, enumTypeId: "MaintenanceType"})
    )
        denied("VALUE_INVALID", "Choose a maintenance type")
    if (term.teamPartyId) {
        const team = one("mantle.party.Party", {partyId: term.teamPartyId})
        if (
            !team ||
            team.ownerPartyId !== target.organizationPartyId ||
            !one("mantle.party.PartyRole", {partyId: term.teamPartyId, roleTypeId: "OrgTeam"})
        )
            denied("VALUE_INVALID", "Choose a team of the organization")
    }
    if (term.productMeterId) {
        if (!target.assetId) denied("METER_INVALID", "A facility's plan is by the calendar")
        const meter = one(PRODUCT_METER, {productMeterId: term.productMeterId})
        if (!meter || meter.productId !== target.productId) denied("METER_INVALID", "Choose a meter of the equipment's model")
    }
    if (term.triggerEnumId === "MstMeter" && !target.assetId) denied("METER_INVALID", "A facility's plan is by the calendar")
    return term
}
const sameTerm = (a, b) =>
    termFields.every(field => {
        const left = a?.[field] ?? null
        const right = b?.[field] ?? null
        if (left == null || right == null) return left == null && right == null
        if (field === "baselineDate") return ms(left) === ms(right)
        if (numericTermFields.includes(field)) return Number(String(left)) === Number(String(right))
        return String(left) === String(right)
    })

// ===== activation =====
// What keeps a plan from activation (each {code, text}); none when it may be activated.
function findingsOf(schedule, term, target) {
    const found = []
    const add = (code, message) => found.push({code, text: message})
    const r = resolve(schedule, term)
    if (!target.zone) add("ZONE_REQUIRED", "Set the time zone of " + target.name + "'s facility or a facility above it")
    // a procedure is optional (the user's call, Nov 12: with none, P14 makes an ad hoc work order with the plan's name and
    // estimate); one named, by the plan or its model default, must qualify
    if (r.templateWorkEffortId) {
        const refusal = procedureRefusal(r.templateWorkEffortId, schedule.organizationPartyId, target)
        if (refusal) add("PROCEDURE_NOT_QUALIFIED", refusal)
    }
    if (r.meter) {
        if (!target.assetId) add("METER_INVALID", "A facility's plan is by the calendar")
        else {
            const meter = r.productMeterId ? one(PRODUCT_METER, {productMeterId: r.productMeterId}) : null
            if (!meter || meter.productId !== target.productId)
                add("METER_REQUIRED", "Choose a counting meter of the equipment's model")
            else if (meter.isCumulative !== "Y")
                add("METER_NOT_COUNTING", "The meter does not count up; a plan needs a counting meter")
        }
        if (!(r.intervalQuantity > 0)) add("INTERVAL_REQUIRED", "Enter the increment of the meter")
        if (r.baselineValue == null || r.baselineDate == null)
            add("BASELINE_REQUIRED", "Enter the baseline reading and when it was taken")
    } else {
        if (
            !(r.intervalQuantity > 0) ||
            !Number.isInteger(r.intervalQuantity) ||
            !Object.hasOwn(calendarUnits, r.intervalUomId || "")
        )
            add("INTERVAL_REQUIRED", "Enter the interval as a whole number of days, weeks, months or years")
        if (!r.firstDueLocal) add("FIRST_DUE_REQUIRED", "Enter the first due date")
    }
    return found
}
// Why a procedure does not qualify for the plan's work, or null: a maintenance procedure of the organization, approved, in
// effect now and applicable to the target (P6's check).
function procedureRefusal(templateWorkEffortId, organizationPartyId, target) {
    const found = procedures.procedureOf(templateWorkEffortId)
    if (!found) return "The procedure is not a maintenance procedure"
    if (found.organizationPartyId !== organizationPartyId) return "The procedure is another organization's"
    if (found.root.statusId === "WeClosed") return "The procedure is retired"
    if (found.root.statusId !== "WeApproved") return "The procedure is not approved"
    if (!procedures.effectiveAt(found.root, found.policy, nowMs())) return "The procedure is not in effect now"
    const refused = procedures.applicabilityRefusal(found.policy, targetForApplicability(target))
    return refused ? "The procedure does not apply: " + refused.charAt(0).toLowerCase() + refused.slice(1) : null
}
function targetForApplicability(target) {
    if (target.assetId) {
        const asset = one(ASSET, {assetId: target.assetId})
        return {assetId: asset.assetId, productId: asset.productId || null, classEnumId: asset.classEnumId || null}
    }
    const facility = one(FACILITY, {facilityId: target.facilityId})
    return {facilityId: facility.facilityId, facilityTypeEnumId: facility.facilityTypeEnumId || null}
}

// ===== calendar arithmetic =====
// Local days are yyyy-MM-dd text and wall times HH:mm; an instant is the local day and time read in the zone.
const dayParts = day => day.split("-").map(Number)
const dayOfUtc = date =>
    [date.getUTCFullYear(), String(date.getUTCMonth() + 1).padStart(2, "0"), String(date.getUTCDate()).padStart(2, "0")].join("-")
const daysInMonth = (year, monthIndex) => new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
const weekday = day => {
    const [y, m, d] = dayParts(day)
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}
const addDays = (day, count) => {
    const [y, m, d] = dayParts(day)
    return dayOfUtc(new Date(Date.UTC(y, m - 1, d + count)))
}
// The day count intervals after an anchor day; months and years from the anchor's day, clamped to a short month's last day.
function stepDay(anchorDay, quantity, uomId, count) {
    const [y, m, d] = dayParts(anchorDay)
    if (uomId === "TF_day") return addDays(anchorDay, quantity * count)
    if (uomId === "TF_wk") return addDays(anchorDay, 7 * quantity * count)
    const months = (uomId === "TF_yr" ? 12 : 1) * quantity * count
    const total = m - 1 + months
    const year = y + Math.floor(total / 12)
    const monthIndex = ((total % 12) + 12) % 12
    const day = Math.min(d, daysInMonth(year, monthIndex))
    return [year, String(monthIndex + 1).padStart(2, "0"), String(day).padStart(2, "0")].join("-")
}
const instantIn = (day, time, zone) =>
    ms(ec.l10n.parseTimestamp(day + " " + time + ":00.000", "yyyy-MM-dd HH:mm:ss.SSS", null, zone))
const localText = (millis, zone) => ec.l10n.format(new Date(Number(millis)), "yyyy-MM-dd HH:mm", null, zone)
// The first business day on or after a local day (EventServices.get#NextBusinessDay asked from the day before): weekends, the
// organization's WepHoliday events and the term's holiday calendar (People's HolidayCalendars, F64) skipped.
function businessDayFrom(day, organizationPartyId, holidayCategoryId) {
    const out = call("mantle.work.EventServices.get#NextBusinessDay", {
        startDate: addDays(day, -1),
        organizationPartyId,
        workEffortCategoryIds: holidayCategoryId ? [holidayCategoryId] : null
    })
    return lib.calendarDateText(out.nextDayDate)
}

// ===== completions and readings =====
// The completions that count for a plan, oldest first: its work orders complete or closed (at their actual completion), and for
// equipment under a model default, that default's completed AssetMaintenance records no counted work order carries (at their
// maintenance date). Each with the AssetMaintenance and the work it carries, for the reading taken in it.
function completionsOf(schedule) {
    const found = []
    const carried = new Set()
    const orders = rows(ORDER, {maintenanceScheduleId: schedule.maintenanceScheduleId})
    for (const order of orders) {
        if (order.assetMaintenanceId) carried.add(order.assetMaintenanceId)
        const root = one(WORK, {workEffortId: order.workEffortId})
        if (!root || !completedStatuses.includes(root.statusId)) continue
        const at = ms(root.actualCompletionDate) ?? ms(root.lastUpdatedStamp)
        found.push({at, workEffortId: root.workEffortId, assetMaintenanceId: order.assetMaintenanceId || null})
    }
    if (schedule.assetId && schedule.productMaintenanceId) {
        const records = rows(ASSET_MAINTENANCE, {
            assetId: schedule.assetId,
            productMaintenanceId: schedule.productMaintenanceId,
            statusId: "AsMntCompleted"
        })
        for (const record of records) {
            if (carried.has(record.assetMaintenanceId) || record.maintenanceDate == null) continue
            found.push({at: ms(record.maintenanceDate), workEffortId: null, assetMaintenanceId: record.assetMaintenanceId})
        }
    }
    return found.filter(row => row.at != null).sort((a, b) => a.at - b.at)
}
// A meter's valid observations of the equipment up to a time, oldest first: a reading with a reason (record#MaintenanceMeter's),
// or a reading of a completed maintenance record (the baseline's); a reading create#AssetMaintenance made from a maintenance
// record's planned interval that is not completed is a synthetic threshold and no observation.
function readingsOf(assetId, productMeterId, at) {
    const all = Array.from(
        find(METER, {assetId, productMeterId}).condition("readingDate", "less-equals", new Date(at)).orderBy("readingDate").list()
    )
    const statuses = {}
    return all
        .filter(row => {
            if (row.readingReasonEnumId || !row.assetMaintenanceId) return true
            if (!Object.hasOwn(statuses, row.assetMaintenanceId))
                statuses[row.assetMaintenanceId] =
                    one(ASSET_MAINTENANCE, {assetMaintenanceId: row.assetMaintenanceId})?.statusId || null
            return statuses[row.assetMaintenanceId] === "AsMntCompleted"
        })
        .map(row => ({
            at: ms(row.readingDate),
            value: Number(String(row.meterValue)),
            reset: row.readingReasonEnumId === "AmrReset",
            workEffortId: row.workEffortId || null,
            assetMaintenanceId: row.assetMaintenanceId || null
        }))
}
// The reading a completion took: one taken in its work (a step of its tree) or of its maintenance record, the latest.
function completionReading(completion, readings) {
    const treeIds = completion.workEffortId
        ? new Set(
              [completion.workEffortId].concat(
                  Array.from(find(WORK, {rootWorkEffortId: completion.workEffortId}).selectField("workEffortId").list()).map(
                      row => row.workEffortId
                  )
              )
          )
        : new Set()
    const taken = readings.filter(
        row =>
            (row.workEffortId && treeIds.has(row.workEffortId)) ||
            (completion.assetMaintenanceId && row.assetMaintenanceId === completion.assetMaintenanceId)
    )
    return taken.length ? taken[taken.length - 1] : null
}

// ===== the due projection =====
// The due of a plan as of a time: its state (due, overdue, upcoming, unknown, or not projected), the dates or meter values that
// decide it, and the lines that explain it.
function dueOf(schedule, at = nowMs()) {
    const term = termAt(schedule.maintenanceScheduleId, at)
    const target = scheduleTarget(schedule)
    const r = resolve(schedule, term)
    const due = {
        maintenanceScheduleId: schedule.maintenanceScheduleId,
        trigger: r.meter ? "meter" : "calendar",
        triggerText: enumText(r.triggerEnumId),
        timeZone: target.zone?.timeZone || null,
        timeZoneText: target.zone ? target.zone.timeZone + (target.zone.inherited ? " (inherited)" : "") : "",
        explanation: [],
        state: "unknown",
        stateText: "Unknown",
        reasonCode: null
    }
    // the completions counted as of the time
    const completions = completionsOf(schedule).filter(row => row.at <= at)
    const last = completions.length ? completions[completions.length - 1] : null
    due.lastCompletionText = last ? lib.dateText(new Date(last.at)) : ""
    due.lastCompletionWorkEffortId = last?.workEffortId || null
    due.completionCount = completions.length
    try {
        if (r.meter) meterDue(due, schedule, r, target, completions, at)
        else calendarDue(due, schedule, r, target, completions, at)
    } catch (error) {
        const code = lib.reasonCode(error)
        if (!code) throw error
        due.state = "unknown"
        due.stateText = "Unknown"
        due.reasonCode = code
        due.explanation.push(String(error.message).replace(/^[A-Z][A-Z0-9_]+: /, ""))
    }
    due.stateColor = {due: "warning", overdue: "negative", upcoming: "positive", unknown: "grey-8"}[due.state] || "grey-8"
    return due
}
// Not projected: a term the projection cannot read, named.
const unprojected = (code, message) => denied(code, message)

function calendarDue(due, schedule, r, target, completions, at) {
    if (!target.zone) unprojected("ZONE_REQUIRED", "No time zone is set for " + target.name + ": no due date is projected")
    if (
        !(r.intervalQuantity > 0) ||
        !Number.isInteger(r.intervalQuantity) ||
        !Object.hasOwn(calendarUnits, r.intervalUomId || "")
    )
        unprojected("INTERVAL_REQUIRED", "The interval is not set")
    if (!r.firstDueLocal) unprojected("FIRST_DUE_REQUIRED", "The first due date is not set")
    const zone = target.zone.timeZone
    const anchorDay = r.firstDueLocal.slice(0, 10)
    const time = r.firstDueLocal.slice(11, 16) || defaultTime
    const unit = calendarUnits[r.intervalUomId][r.intervalQuantity === 1 ? 0 : 1]
    const everyText = "Every " + (r.intervalQuantity === 1 ? unit : r.intervalQuantity + " " + unit)
    due.intervalText = everyText
    let dueDay
    let overdueCount = 0
    if (r.cadenceEnumId === "MscCompletion") {
        const last = completions.length ? completions[completions.length - 1] : null
        dueDay = last ? stepDay(localText(last.at, zone).slice(0, 10), r.intervalQuantity, r.intervalUomId, 1) : anchorDay
        due.explanation.push(
            everyText +
                " after the last completion" +
                (last ? ", done " + localText(last.at, zone) : "; none yet, so the first due date " + r.firstDueLocal) +
                " (" +
                zone +
                ")"
        )
    } else {
        // the obligations from the anchor, each a count of intervals after it; a completion covers the earliest one not yet covered
        // that falls before the next obligation after it
        const obligations = []
        const obligation = count => {
            while (obligations.length <= count)
                obligations.push(
                    instantIn(stepDay(anchorDay, r.intervalQuantity, r.intervalUomId, obligations.length), time, zone)
                )
            return obligations[count]
        }
        // how many obligations fall at or before a moment
        const passedBy = moment => {
            let count = 0
            while (count < obligationCap && obligation(count) <= moment) count++
            return count
        }
        // a completion counts once it is later than the obligation one interval before the first: an older one (a model default's
        // record from before the plan) covers nothing
        const window = instantIn(stepDay(anchorDay, r.intervalQuantity, r.intervalUomId, -1), time, zone)
        let covered = 0
        for (const completion of completions) if (completion.at > window && covered <= passedBy(completion.at)) covered++
        dueDay = stepDay(anchorDay, r.intervalQuantity, r.intervalUomId, covered)
        overdueCount = Math.max(0, passedBy(at) - covered)
        due.explanation.push(everyText + " from " + r.firstDueLocal + " (" + zone + "), on fixed dates")
    }
    const dueMs = instantIn(dueDay, time, zone)
    const [, , anchorDate] = dayParts(anchorDay)
    const clamped =
        ["TF_mon", "TF_yr"].includes(r.intervalUomId) && dayParts(dueDay)[2] < anchorDate && r.cadenceEnumId !== "MscCompletion"
    due.dueDate = new Date(dueMs)
    due.dueDateText = dueDay + " " + time + " " + zone
    due.overdueCount = overdueCount
    // the planned day: the next business day when the due day is not one (the due date stays the obligation)
    let plannedDay = dueDay
    if (r.businessDaysOnly) plannedDay = businessDayFrom(dueDay, schedule.organizationPartyId, r.holidayCategoryId)
    due.plannedDate = new Date(instantIn(plannedDay, time, zone))
    due.plannedDateText = plannedDay + " " + time + " " + zone
    due.moved = plannedDay !== dueDay
    due.generateFromText = r.leadDays ? addDays(plannedDay, -r.leadDays) : plannedDay
    due.explanation.push(
        due.lastCompletionText
            ? "Last completion " +
                  due.lastCompletionText +
                  (due.lastCompletionWorkEffortId ? " (work order " + due.lastCompletionWorkEffortId + ")" : "")
            : "No completion yet"
    )
    due.explanation.push(
        "Next due " + due.dueDateText + (clamped ? " (the " + ordinal(anchorDate) + " falls in a shorter month)" : "")
    )
    if (due.moved)
        due.explanation.push(
            "Planned for " +
                plannedDay +
                ": " +
                dueDay +
                (weekday(dueDay) % 6 === 0 ? " is a weekend day" : " is a holiday") +
                "; the due date stays " +
                dueDay
        )
    if (r.leadDays) due.explanation.push("Work is made " + r.leadDays + " days ahead, from " + due.generateFromText)
    if (overdueCount > 1) due.explanation.push(overdueCount + " due dates have passed without a completion")
    due.state = dueMs <= at ? "overdue" : due.generateFromText <= localText(at, zone).slice(0, 10) ? "due" : "upcoming"
    due.stateText = {overdue: "Overdue", due: "Due", upcoming: "Not due yet"}[due.state]
}
// A meter's unit as shown with its values: its Uom's abbreviation ("1450 hr"), its type's default unit's, else (a count with no
// unit) its name ("500 starts").
function meterUnit(meter) {
    if (!meter) return ""
    const uomId =
        meter.meterUomId ||
        one("mantle.product.maintenance.ProductMeterType", {productMeterTypeId: meter.productMeterTypeId})?.defaultUomId
    return uomText(uomId) || String(meter.meterName || "").toLowerCase()
}
const ordinal = n => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : {1: "st", 2: "nd", 3: "rd"}[n % 10] || "th")

function meterDue(due, schedule, r, target, completions, at) {
    if (!target.assetId) unprojected("METER_INVALID", "A facility's plan is by the calendar")
    const meter = r.productMeterId ? one(PRODUCT_METER, {productMeterId: r.productMeterId}) : null
    if (!meter || meter.productId !== target.productId)
        unprojected("METER_REQUIRED", "No counting meter of the equipment's model is chosen")
    if (meter.isCumulative !== "Y") unprojected("METER_NOT_COUNTING", "The meter does not count up")
    if (!(r.intervalQuantity > 0)) unprojected("INTERVAL_REQUIRED", "The increment is not set")
    const unit = meterUnit(meter)
    const withUnit = value => numberText(value) + (unit ? " " + unit : "")
    due.meterName = meter.meterName || enumText(meter.productMeterTypeId) || meter.productMeterId
    due.unitText = unit
    due.increment = r.intervalQuantity
    due.intervalText = "Every " + withUnit(r.intervalQuantity)
    const readings = readingsOf(target.assetId, meter.productMeterId, at)
    // the baseline: the later of the plan's own and the reading the last counted completion that took one took (a completion before
    // the plan's baseline, such as a model default's record from before the plan, does not move it back)
    let baseline = null
    for (let index = completions.length - 1; index >= 0 && !baseline; index--) {
        const reading = completionReading(completions[index], readings)
        if (reading)
            baseline = {
                value: reading.value,
                at: reading.at,
                source: completions[index].workEffortId
                    ? "the completion of work order " + completions[index].workEffortId
                    : "a completed maintenance record"
            }
    }
    if (r.baselineValue != null && r.baselineDate != null && (!baseline || baseline.at < r.baselineDate))
        baseline = {value: r.baselineValue, at: r.baselineDate, source: "the plan's baseline"}
    const origin =
        r.origin.intervalQuantity === "model default"
            ? " (the model default)"
            : r.defaults?.intervalQuantity != null && r.origin.intervalQuantity === "plan"
              ? " (this plan; the model default is " + withUnit(Number(String(r.defaults.intervalQuantity))) + ")"
              : ""
    due.explanation.push(due.meterName + ": every " + withUnit(r.intervalQuantity) + origin)
    if (!baseline) unprojected("BASELINE_REQUIRED", "No baseline reading: record a reading or set the plan's baseline")
    due.baselineValue = baseline.value
    due.baselineText = withUnit(baseline.value) + " on " + lib.dateText(new Date(baseline.at)) + ", " + baseline.source
    due.explanation.push("Baseline " + due.baselineText)
    // the usage since the baseline, across a reset (a lower value from then on)
    let usage = 0
    let previous = baseline.value
    let lastReading = {value: baseline.value, at: baseline.at}
    for (const reading of readings) {
        if (reading.at <= baseline.at) continue
        if (!reading.reset && reading.value >= previous) usage += reading.value - previous
        previous = reading.value
        lastReading = reading
    }
    const remaining = r.intervalQuantity - usage
    due.lastReadingValue = lastReading.value
    due.lastReadingText = withUnit(lastReading.value) + " on " + lib.dateText(new Date(lastReading.at))
    due.readingAgeDays = Math.floor((at - lastReading.at) / dayMs)
    due.usage = usage
    due.remaining = remaining
    due.nextThreshold = lastReading.value + remaining
    due.nextThresholdText = withUnit(due.nextThreshold)
    due.maxReadingAgeDays = r.maxReadingAgeDays
    due.explanation.push("Last accepted reading " + due.lastReadingText)
    due.explanation.push(
        "Next threshold " + due.nextThresholdText + (remaining > 0 ? ", " + withUnit(remaining) + " to go" : ", reached")
    )
    if (due.readingAgeDays > r.maxReadingAgeDays) {
        due.state = "unknown"
        due.stateText = "Unknown: stale reading"
        due.reasonCode = "READING_STALE"
        due.explanation.push("Reading older than " + r.maxReadingAgeDays + " days: request a reading before the due is known")
        return
    }
    due.state = remaining <= 0 ? "due" : "upcoming"
    due.stateText = remaining <= 0 ? "Due" : "Not due yet"
}

// ===== rows =====
function nameOf(entityName, field, id, nameField) {
    return id ? one(entityName, {[field]: id})?.[nameField] || id : ""
}
// A plan for a list or a record header: names, its terms' texts and its due (a due that cannot be read is named, not raised).
function rowOf(schedule, at = nowMs(), known = null) {
    const term = termAt(schedule.maintenanceScheduleId, at)
    const r = resolve(schedule, term)
    let due = known
    if (!due)
        try {
            due = dueOf(schedule, at)
        } catch (error) {
            ec.logger.error("Maintenance plan " + schedule.maintenanceScheduleId + " due: " + error.message)
            due = {state: "unknown", stateText: "Not read", stateColor: "grey-8", explanation: ["The due could not be read"]}
        }
    const procedure = r.templateWorkEffortId ? one(WORK, {workEffortId: r.templateWorkEffortId}) : null
    const names = lib.partyNames([schedule.organizationPartyId, r.teamPartyId])
    return {
        maintenanceScheduleId: schedule.maintenanceScheduleId,
        scheduleName: schedule.scheduleName || schedule.maintenanceScheduleId,
        statusId: schedule.statusId,
        statusText: statusNames[schedule.statusId] || schedule.statusId,
        statusColor: {MschDraft: "grey-8", MschActive: "positive", MschEnded: "grey-6"}[schedule.statusId] || "grey-8",
        organizationPartyId: schedule.organizationPartyId,
        organizationName: names[schedule.organizationPartyId] || schedule.organizationPartyId || "",
        assetId: schedule.assetId || null,
        facilityId: schedule.facilityId || null,
        targetName: schedule.assetId
            ? nameOf(ASSET, "assetId", schedule.assetId, "assetName")
            : nameOf(FACILITY, "facilityId", schedule.facilityId, "facilityName"),
        targetKind: schedule.assetId ? "Equipment" : "Facility",
        productMaintenanceId: schedule.productMaintenanceId || null,
        defaultText: r.defaults ? r.defaults.description || r.defaults.productMaintenanceId : "",
        templateWorkEffortId: r.templateWorkEffortId,
        procedureName: procedure?.workEffortName || r.templateWorkEffortId || "",
        teamPartyId: r.teamPartyId,
        teamName: r.teamPartyId ? names[r.teamPartyId] || r.teamPartyId : "",
        triggerEnumId: r.triggerEnumId,
        triggerText: enumText(r.triggerEnumId),
        intervalText: due.intervalText || "",
        nextDueText: due.trigger === "meter" ? due.nextThresholdText || "" : due.dueDateText || "",
        dataAgeText: due.readingAgeDays != null ? due.readingAgeDays + " days" : "",
        dueState: due.state,
        dueStateText: due.stateText,
        dueStateColor: due.stateColor,
        revision: Number(schedule.revision || 0)
    }
}
function termRow(term, schedule) {
    const r = resolve(schedule, term)
    const fromMs = ms(term.fromDate)
    return {
        fromDate: term.fromDate,
        fromText: lib.dateText(term.fromDate),
        thruText: term.thruDate ? lib.dateText(term.thruDate) : "",
        inForce: fromMs <= nowMs() && (term.thruDate == null || ms(term.thruDate) > nowMs()),
        triggerText: enumText(r.triggerEnumId),
        intervalText:
            r.intervalQuantity == null
                ? ""
                : r.meter
                  ? (
                        numberText(r.intervalQuantity) +
                        " " +
                        meterUnit(r.productMeterId ? one(PRODUCT_METER, {productMeterId: r.productMeterId}) : null)
                    ).trim()
                  : r.intervalQuantity +
                    " " +
                    (calendarUnits[r.intervalUomId]?.[r.intervalQuantity === 1 ? 0 : 1] || r.intervalUomId || ""),
        procedureName: nameOf(WORK, "workEffortId", r.templateWorkEffortId, "workEffortName"),
        changeReason: term.changeReason || "",
        changedByName: term.changedByUserId
            ? one("moqui.security.UserAccount", {userId: term.changedByUserId})?.userFullName || term.changedByUserId
            : ""
    }
}

// ===== find#MaintenanceSchedules =====
// The plans of the caller's scope, found in the query before paging: by name or id, organization, equipment, facility (with those
// inside it), equipment model, state (open: draft and active, by default; all; or one), and the trigger, procedure or team of the
// term in effect. Each row with its target, procedure, interval, next due and data age, and its state.
function findSchedules(p) {
    const userScope = listScope(readScope())
    let query = find(SCHEDULE)
    if (userScope.organizationPartyIds != null)
        query = query.condition("organizationPartyId", "in", Array.from(userScope.organizationPartyIds).concat(["_NA_"]))
    if (text(p.organizationPartyId))
        query = query.condition(
            "organizationPartyId",
            maintenanceAccess.requireOrganization(userScope, text(p.organizationPartyId))
        )
    if (text(p.assetId)) query = query.condition("assetId", text(p.assetId))
    if (text(p.facilityId)) query = query.condition("facilityId", "in", resources.subtreeIds(text(p.facilityId), null))
    if (text(p.productId)) {
        const assetIds = Array.from(
            find(ASSET, {productId: text(p.productId)})
                .selectField("assetId")
                .limit(1000)
                .list()
        ).map(row => row.assetId)
        query = query.condition("assetId", "in", assetIds.concat(["_NA_"]))
    }
    const status = text(p.statusId) || "open"
    const statusIds = {open: ["MschDraft", "MschActive"], draft: ["MschDraft"], active: ["MschActive"], ended: ["MschEnded"]}[
        status
    ]
    if (statusIds) query = query.condition("statusId", "in", statusIds)
    else if (status !== "all") query = query.condition("statusId", status)
    const termFilter = {
        triggerEnumId: text(p.triggerEnumId),
        templateWorkEffortId: text(p.templateWorkEffortId),
        teamPartyId: text(p.teamPartyId)
    }
    if (Object.values(termFilter).some(Boolean)) {
        let terms = find(TERM).condition("thruDate", "is-null", null)
        for (const [field, value] of Object.entries(termFilter)) if (value) terms = terms.condition(field, value)
        const ids = Array.from(terms.selectField("maintenanceScheduleId").limit(5000).list()).map(
            row => row.maintenanceScheduleId
        )
        query = query.condition("maintenanceScheduleId", "in", ids.concat(["_NA_"]))
    }
    if (text(p.text)) {
        const factory = ec.entity.conditionFactory
        const like = "%" + String(text(p.text)).replace(/[\\%_]/g, character => "\\" + character) + "%"
        query = query.condition(
            factory.makeCondition(
                ["maintenanceScheduleId", "scheduleName"].map(field => factory.makeCondition(field, "like", like).ignoreCase()),
                "or"
            )
        )
    }
    const count = query.count()
    const paged = lib.page(query.orderBy(["scheduleName", "maintenanceScheduleId"]), p, "scheduleList", count)
    const at = nowMs()
    return {
        scheduleList: paged.rows.map(schedule => rowOf(schedule, at)),
        scheduleListCount: count,
        scheduleListPageIndex: paged.pageIndex,
        scheduleListPageSize: paged.pageSize,
        scheduleListPageMaxIndex: paged.pageMaxIndex,
        scheduleListPageRangeLow: paged.pageRangeLow,
        scheduleListPageRangeHigh: paged.pageRangeHigh
    }
}

// ===== get#MaintenanceSchedule =====
// One plan the caller reads: its row, its term in effect with each value and its origin, its terms' history, its due (as of a time,
// now when empty), what keeps it from activation and what the caller may do.
function getSchedule(p) {
    const userScope = readScope()
    const schedule = scheduleOf(userScope, p.maintenanceScheduleId)
    const at = blank(p.asOfDate) ? nowMs() : ms(p.asOfDate)
    const term = termAt(schedule.maintenanceScheduleId, at)
    const target = scheduleTarget(schedule)
    const r = resolve(schedule, term)
    const writer = canWrite(userScope)
    const findings = schedule.statusId === "MschDraft" ? findingsOf(schedule, term, target) : []
    const meter = r.productMeterId ? one(PRODUCT_METER, {productMeterId: r.productMeterId}) : null
    const values = {
        triggerEnumId: r.triggerEnumId,
        cadenceEnumId: r.cadenceEnumId,
        intervalQuantity: r.intervalQuantity,
        intervalUomId: r.intervalUomId,
        firstDueLocal: r.firstDueLocal,
        productMeterId: r.productMeterId,
        meterName: meter ? meter.meterName || meter.productMeterId : "",
        baselineValue: r.baselineValue,
        meterUnitText: meterUnit(meter),
        estimatedWorkTime: r.estimatedWorkTime,
        baselineDate: r.baselineDate == null ? null : new Date(r.baselineDate),
        baselineDateText: r.baselineDate == null ? "" : lib.dateText(new Date(r.baselineDate)),
        maxReadingAgeDays: r.maxReadingAgeDays,
        businessDaysOnly: r.businessDaysOnly ? "Y" : "N",
        holidayCategoryId: r.holidayCategoryId,
        holidayCalendarName: nameOf(CATEGORY, "workEffortCategoryId", r.holidayCategoryId, "description"),
        leadDays: r.leadDays,
        templateWorkEffortId: r.templateWorkEffortId,
        maintenanceTypeEnumId: r.maintenanceTypeEnumId,
        maintenanceTypeText: enumText(r.maintenanceTypeEnumId),
        teamPartyId: r.teamPartyId,
        cadenceText: enumText(r.cadenceEnumId),
        intervalOrigin: r.origin.intervalQuantity,
        meterOrigin: r.origin.productMeterId,
        procedureOrigin: r.origin.templateWorkEffortId,
        typeOrigin: r.origin.maintenanceTypeEnumId
    }
    // the term as stored (empty where the model default applies), for the edit form
    const stored = {}
    for (const field of termFields) stored[field] = term ? (term[field] ?? null) : null
    return {
        schedule: Object.assign(rowOf(schedule, at), {
            timeZoneText: target.zone ? target.zone.timeZone + (target.zone.inherited ? " (inherited)" : "") : "",
            fromText: schedule.fromDate ? lib.dateText(schedule.fromDate) : "",
            thruText: schedule.thruDate ? lib.dateText(schedule.thruDate) : "",
            endReason: schedule.endReason || ""
        }),
        term: values,
        storedTerm: stored,
        terms: termsOf(schedule.maintenanceScheduleId).map(row => termRow(row, schedule)),
        due: dueOf(schedule, at),
        findings,
        canEdit: writer && schedule.statusId !== "MschEnded",
        canActivate: writer && schedule.statusId === "MschDraft" && findings.length === 0,
        canEnd: writer && schedule.statusId !== "MschEnded"
    }
}

// ===== store#MaintenanceSchedule =====
// A new plan (a draft) or a change of one at its revision: its name and terms (a draft's in place; an active plan's from the
// effective time, now when empty and never before the term in effect began, with a reason), or an action: activate (from a draft,
// after the findings) or end (with a reason). MAINTENANCE_PLAN or MAINTENANCE_SUPERVISE in the target's organization.
function storeSchedule(p) {
    const userScope = writeScope()
    const id = text(p.maintenanceScheduleId)
    if (!id) return createSchedule(userScope, p)
    const schedule = scheduleOf(userScope, id, true)
    requireRevision(schedule, p.expectedRevision)
    if (schedule.statusId === "MschEnded") denied("PLAN_ENDED", "Plan " + id + " has ended")
    const action = text(p.action)
    const revision = Number(schedule.revision || 0) + 1
    const now = ec.user.nowTimestamp
    // a plan keeps its organization: once its target has moved to another, it is ended, not changed or activated
    const target = action === "end" ? null : scheduleTarget(schedule)
    if (target && target.organizationPartyId !== schedule.organizationPartyId)
        denied("TARGET_MOVED", target.name + " now belongs to another organization; end this plan and make one there")
    if (action === "activate") {
        if (schedule.statusId !== "MschDraft") denied("PLAN_NOT_DRAFT", "Plan " + id + " is already active")
        const findings = findingsOf(schedule, termAt(id), target)
        if (findings.length) denied(findings[0].code, findings.map(row => row.text).join("; "))
        call("update#" + SCHEDULE, {maintenanceScheduleId: id, statusId: "MschActive", fromDate: now, revision})
        return {maintenanceScheduleId: id, statusId: "MschActive", revision}
    }
    if (action === "end") {
        const reason = text(p.changeReason)
        if (!reason) denied("REASON_REQUIRED", "Give the reason the plan ends")
        for (const row of termsOf(id))
            if (row.thruDate == null) call("update#" + TERM, {maintenanceScheduleId: id, fromDate: row.fromDate, thruDate: now})
        call("update#" + SCHEDULE, {
            maintenanceScheduleId: id,
            statusId: "MschEnded",
            thruDate: now,
            endReason: reason,
            statusId_changeReason: reason,
            revision
        })
        return {maintenanceScheduleId: id, statusId: "MschEnded", revision}
    }
    if (action) throw new Error("Unknown maintenance plan action " + action)
    // a change of the name and the terms; a call that names no term field changes the name alone
    const termGiven = termFields.some(field => !blank(p[field]))
    const wanted = termGiven ? termFrom(p, target) : null
    const current = termAt(id)
    const name = text(p.scheduleName)
    let changed = false
    if (name && name !== schedule.scheduleName) changed = true
    if (termGiven && !sameTerm(wanted, current)) {
        changed = true
        if (schedule.statusId === "MschDraft" && current) {
            call(
                "update#" + TERM,
                Object.assign(
                    {
                        maintenanceScheduleId: id,
                        fromDate: current.fromDate,
                        changedByUserId: ec.user.userId,
                        changeReason: text(p.changeReason)
                    },
                    wanted
                )
            )
        } else {
            const reason = text(p.changeReason)
            if (!reason) denied("REASON_REQUIRED", "Give the reason the terms change")
            const effective = blank(p.effectiveDate) ? nowMs() : ms(p.effectiveDate)
            if (current && effective <= ms(current.fromDate))
                denied(
                    "DATE_INVALID",
                    "The change takes effect after the terms in effect began, " + lib.dateText(current.fromDate)
                )
            if (effective < nowMs() - 60000) denied("DATE_INVALID", "A change takes effect now or later")
            // a term already planned from a later time is never cut short before it begins
            const planned = termsOf(id).find(row => ms(row.fromDate) >= effective)
            if (planned)
                denied(
                    "DATE_INVALID",
                    "A change is already planned from " + lib.dateText(planned.fromDate) + "; take effect after it"
                )
            const from = new Date(effective)
            for (const row of termsOf(id))
                if (row.thruDate == null || ms(row.thruDate) > effective)
                    call("update#" + TERM, {maintenanceScheduleId: id, fromDate: row.fromDate, thruDate: from})
            call(
                "create#" + TERM,
                Object.assign(
                    {maintenanceScheduleId: id, fromDate: from, changedByUserId: ec.user.userId, changeReason: reason},
                    wanted
                )
            )
        }
    }
    if (changed) call("update#" + SCHEDULE, {maintenanceScheduleId: id, scheduleName: name || schedule.scheduleName, revision})
    return {maintenanceScheduleId: id, statusId: schedule.statusId, revision: changed ? revision : Number(schedule.revision || 0)}
}
const createFields = ["scheduleName", "assetId", "facilityId", "productMaintenanceId"].concat(termFields)
function requestHash(p) {
    return lib.hash(
        createFields.map(field => {
            const value = p[field]
            if (value == null) return ""
            if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value)
            const millis = ms(value)
            return Number.isFinite(millis) ? String(millis) : String(value)
        })
    )
}
function createSchedule(userScope, p) {
    const operationKey = text(p.operationKey)
    const hash = requestHash(p)
    if (operationKey) {
        if (operationKey.length > 60) denied("OPERATION_KEY_INVALID", "An operation key has at most 60 characters")
        const earlier = Array.from(find(SCHEDULE, {operationKey}).limit(1).list())[0]
        if (earlier) {
            if (earlier.operationHash !== hash) denied("OPERATION_KEY_CONFLICT", "The operation key was used for another plan")
            scheduleOf(userScope, earlier.maintenanceScheduleId)
            return {
                maintenanceScheduleId: earlier.maintenanceScheduleId,
                statusId: earlier.statusId,
                revision: Number(earlier.revision || 0),
                repeated: true
            }
        }
    }
    const target = targetOf(userScope, text(p.assetId), text(p.facilityId))
    const productMaintenanceId = text(p.productMaintenanceId)
    let defaults = null
    if (productMaintenanceId) {
        defaults = one(PRODUCT_MAINTENANCE, {productMaintenanceId})
        if (!target.assetId || !defaults || defaults.productId !== target.productId)
            denied("VALUE_INVALID", "Choose a maintenance default of the equipment's model")
    }
    const term = termFrom(p, target)
    // the trigger is kept on the term: the model default's when the plan names none
    if (!term.triggerEnumId)
        term.triggerEnumId = term.productMeterId || defaults?.intervalProductMeterId ? "MstMeter" : "MstCalendar"
    if (term.triggerEnumId === "MstMeter" && !target.assetId) denied("METER_INVALID", "A facility's plan is by the calendar")
    const now = ec.user.nowTimestamp
    const name =
        text(p.scheduleName) ||
        (defaults?.description ? target.name + ": " + defaults.description : target.name + " preventive maintenance")
    const created = call("create#" + SCHEDULE, {
        scheduleName: name,
        organizationPartyId: target.organizationPartyId,
        assetId: target.assetId,
        facilityId: target.facilityId,
        productMaintenanceId,
        statusId: "MschDraft",
        revision: 1,
        createdByUserId: ec.user.userId,
        createdDate: now,
        operationKey,
        operationHash: operationKey ? hash : null
    })
    call(
        "create#" + TERM,
        Object.assign(
            {maintenanceScheduleId: created.maintenanceScheduleId, fromDate: now, changedByUserId: ec.user.userId},
            term
        )
    )
    return {maintenanceScheduleId: created.maintenanceScheduleId, statusId: "MschDraft", revision: 1, repeated: false}
}

// ===== get#MaintenanceDue and find#MaintenanceDue =====
function getDue(p) {
    const userScope = readScope()
    const schedule = scheduleOf(userScope, p.maintenanceScheduleId)
    return {due: dueOf(schedule, blank(p.asOfDate) ? nowMs() : ms(p.asOfDate))}
}
// The due of the scope's active plans (one organization's, one piece of equipment's or one facility's and those inside it) as of
// a time, through a horizon (a calendar due after it is left out; a meter's is always listed), of a state when asked (due, overdue,
// unknown, upcoming, or "attention": due, overdue and unknown). A plan whose due cannot be read is named in failures and the rest
// are listed.
function findDue(p) {
    const userScope = listScope(readScope())
    const at = blank(p.asOfDate) ? nowMs() : ms(p.asOfDate)
    const horizon = blank(p.thruDate) ? null : ms(p.thruDate)
    let query = find(SCHEDULE, {statusId: "MschActive"})
    if (userScope.organizationPartyIds != null)
        query = query.condition("organizationPartyId", "in", Array.from(userScope.organizationPartyIds).concat(["_NA_"]))
    if (text(p.organizationPartyId))
        query = query.condition(
            "organizationPartyId",
            maintenanceAccess.requireOrganization(userScope, text(p.organizationPartyId))
        )
    if (text(p.assetId)) query = query.condition("assetId", text(p.assetId))
    if (text(p.facilityId)) query = query.condition("facilityId", "in", resources.subtreeIds(text(p.facilityId), null))
    const schedules = Array.from(query.orderBy("maintenanceScheduleId").limit(dueScheduleCap).list())
    const wanted = text(p.state)
    const states = wanted === "attention" ? ["due", "overdue", "unknown"] : wanted ? [wanted] : null
    const dueList = []
    const failures = []
    for (const schedule of schedules) {
        try {
            const due = dueOf(schedule, at)
            const row = rowOf(schedule, at, due)
            if (states && !states.includes(due.state)) continue
            if (horizon != null && due.trigger === "calendar" && due.dueDate && ms(due.dueDate) > horizon) continue
            dueList.push(Object.assign(row, {due}))
        } catch (error) {
            ec.logger.error("Maintenance plan " + schedule.maintenanceScheduleId + " due: " + error.message)
            failures.push({maintenanceScheduleId: schedule.maintenanceScheduleId, message: error.message})
        }
    }
    const order = {overdue: 0, due: 1, unknown: 2, upcoming: 3}
    dueList.sort(
        (a, b) =>
            (order[a.dueState] ?? 9) - (order[b.dueState] ?? 9) ||
            (ms(a.due.dueDate) ?? Infinity) - (ms(b.due.dueDate) ?? Infinity)
    )
    return Object.assign(lib.pageList(dueList, p, "dueList"), {failures})
}

const operations = {findSchedules, getSchedule, storeSchedule, getDue, findDue}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown maintenance plan operation " + op)
        return operations[op](parameters || {})
    },
    dueOf,
    stepDay,
    // a plan a reader of the scope may open (MAINTENANCE_VIEW in its organization; RECORD_UNAVAILABLE): Maintenance's record check
    requireSchedule: (userScope, maintenanceScheduleId) => {
        if (!userScope.capabilities.view) denied("PERMISSION_DENIED", "Maintenance view is required")
        return scheduleOf(userScope, maintenanceScheduleId)
    }
})
