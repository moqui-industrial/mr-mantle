// Work centers (design-manufacturing §6 and §12 M5, crosscut CX-WORKCENTER; impl-manufacturing P3): the WorkCenter extension
// of a facility (store#WorkCenter, which also makes a new FcTpLine under its plant), its dated capacities and alternates,
// and the read of one center for FacilityDetail. Writes need METHOD_RESOURCES and the facility's organization
// (MethodPolicy.scope); reads need a production or method read permission and the facility in the user's facility scope.
// The rates stay Routings.js's (store#WorkCenterRate, with its separate cost authority); a rate is read here only with cost
// read and left out otherwise. Facility.capacity is the facility's people capacity and is never written here.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, ms, denied, dateText} = lib
const policy = ec.resource.script("component://mr-mantle/service/mantle/product/MethodPolicy.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")

const FACILITY = "mantle.facility.Facility"
const CENTER = "mantle.work.production.WorkCenter"
const CAPACITY = "mantle.work.production.WorkCenterCapacity"
const ALTERNATE = "mantle.work.production.WorkCenterAlternate"
const RATE = "mantle.work.production.WorkCenterRate"
const readPermissions = ["PRODUCTION_VIEW", "METHOD_VIEW", "METHOD_EDIT", "METHOD_APPROVE", "METHOD_RESOURCES"]
const capacityBases = ["WccbRate", "WccbSlots"]
const timeUnits = ["TF_ms", "TF_s", "TF_min", "TF_hr", "TF_day"]

const blank = value => value == null || String(value).trim() === ""
const text = value => (value == null ? null : String(value))
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const uomText = uomId => (uomId ? one("moqui.basic.Uom", {uomId})?.abbreviation || uomId : "")
const facilityName = facility => (facility ? facility.facilityName || facility.facilityId : "")
const now = () => ec.user.nowTimestamp
const iso = value => new Date(ms(value)).toISOString()
const dateValue = value => (blank(value) ? null : iso(value))
// The start of a new dated row: now or later; a day given as today (its midnight is past) starts now.
function startOf(value) {
    const start = dateValue(value)
    if (!start || ms(start) >= ms(now())) return start || iso(now())
    const day = date => ec.l10n.format(new Date(ms(date)), "yyyy-MM-dd")
    if (day(start) === day(now())) return iso(now())
    throw new Error("A dated change starts now or later")
}
// a row in effect now or ahead (not ended before now)
const current = row => row.thruDate == null || ms(row.thruDate) > ms(now())

// ===== scope =====
// The reader's scope: a production or method read permission, and the organizations whose facilities they work in.
function readScope() {
    if (!readPermissions.some(lib.access.has)) denied("PERMISSION_DENIED", "Production or method read is required")
    const userScope = facilityScope.scope()
    const methods = policy.capabilities()
    return Object.assign(userScope, {
        costRead: methods.costRead,
        canEdit: methods.resources,
        canEditRate: methods.resources && methods.costWrite,
        canApproveRate: methods.resources && methods.costApprove
    })
}
// A facility of the reader's organizations, refused like a missing one otherwise.
function facilityOf(userScope, facilityId) {
    const facility = blank(facilityId) ? null : one(FACILITY, {facilityId})
    if (!facility || !facilityScope.owns(userScope, facility.ownerPartyId))
        denied("RECORD_UNAVAILABLE", "Facility " + (facilityId || "") + " is not available")
    return facility
}
// The writer's scope for a facility: METHOD_RESOURCES in the facility's organization (a given organization must be it).
function writeScope(facility, p) {
    const organizationPartyId = p.organizationPartyId || facility.ownerPartyId
    const methodScope = policy.scope({organizationPartyId}, "resources")
    policy.facility(facility.facilityId, methodScope)
    return methodScope
}
// A work center of the writer's organization, locked for the change.
function centerFor(facilityId, p) {
    const facility = one(FACILITY, {facilityId: facilityId || "_NA_"})
    if (!facility) denied("RECORD_UNAVAILABLE", "Work center " + (facilityId || "") + " is not available")
    const methodScope = writeScope(facility, p)
    const center = find(CENTER, {facilityId}).forUpdate(true).one()
    if (!center) denied("WORK_CENTER_REQUIRED", "Make " + facilityName(facility) + " a work center first")
    return {facility, center, methodScope}
}
function percent(value, label) {
    if (value == null || value === "") return
    const number = toDecimal(value)
    if (number.compare(0) < 0 || number.compare(100) > 0) throw new Error(label + " must be between zero and 100")
}

// ===== store#WorkCenter =====
// The WorkCenter extension of a facility, or with no facility a new production line (FcTpLine) of facilityName under the
// plant, owned by the plant's owner. The plant is a facility of the same organization (by default the facility's parent);
// the calendar is the organization's; efficiency and the OEE target are percentages; the scheduling policy is a
// WorkCenterSchedulingPolicy. Changes are audit-logged with the change reason.
function center(p) {
    const why = policy.reason(p)
    const plant = blank(p.plantFacilityId) ? null : one(FACILITY, {facilityId: p.plantFacilityId})
    if (!blank(p.plantFacilityId) && !plant) denied("RECORD_UNAVAILABLE", "Plant " + p.plantFacilityId + " is not available")
    let facility = blank(p.facilityId) ? null : one(FACILITY, {facilityId: p.facilityId})
    if (!blank(p.facilityId) && !facility) throw new Error("Work center facility is not in the method organization")
    if (!facility && !plant) throw new Error("Choose a facility, or a plant for a new line")
    const methodScope = writeScope(facility || plant, p)
    if (plant) policy.facility(plant.facilityId, methodScope)
    if (!facility) {
        if (blank(p.facilityName)) throw new Error("Name the new line")
        const created = lib.call("create#" + FACILITY, {
            facilityTypeEnumId: "FcTpLine",
            facilityName: String(p.facilityName).trim(),
            parentFacilityId: plant.facilityId,
            ownerPartyId: plant.ownerPartyId
        })
        facility = one(FACILITY, {facilityId: created.facilityId})
    }
    if (plant && plant.facilityId === facility.facilityId) throw new Error("A work center is not its own plant")
    const old = one(CENTER, {facilityId: facility.facilityId})
    const fields = ["plantFacilityId", "calendarId", "efficiencyPercent", "oeeTargetPercent", "schedulingPolicyEnumId"]
    const data = Object.assign(old ? policy.pick(lib.map(old), fields) : {}, policy.pick(p, fields))
    if (!old && blank(data.plantFacilityId) && facility.parentFacilityId) data.plantFacilityId = facility.parentFacilityId
    percent(data.efficiencyPercent, "Work-center percentages")
    percent(data.oeeTargetPercent, "Work-center percentages")
    if (!blank(data.calendarId)) {
        const calendar = one("mantle.work.calendar.Calendar", {calendarId: data.calendarId})
        if (!calendar || calendar.ownerPartyId !== methodScope.organizationPartyId)
            throw new Error("Calendar is not in the work-center organization")
    }
    if (!blank(data.schedulingPolicyEnumId)) {
        const found = one("moqui.basic.Enumeration", {enumId: data.schedulingPolicyEnumId})
        if (!found || found.enumTypeId !== "WorkCenterSchedulingPolicy") throw new Error("Choose a scheduling policy")
    }
    if (!blank(data.plantFacilityId) && data.plantFacilityId !== plant?.facilityId)
        policy.facility(data.plantFacilityId, methodScope)
    policy.audit([...Object.keys(data), "changeReason"], why)
    lib.call(
        (old ? "update#" : "create#") + CENTER,
        Object.assign({}, data, {facilityId: facility.facilityId, changeReason: why})
    )
    return {workCenter: Object.assign({facilityId: facility.facilityId}, data), facilityId: facility.facilityId}
}

// ===== store#WorkCenterCapacity =====
// A new dated capacity, or with workCenterCapacityId the end of one (only its thruDate changes). A rate is a positive
// quantity in a unit per a positive time; slots a whole number of at least one. A new row ends the row of the same basis,
// product and product type in effect at its start.
function capacity(p) {
    const why = policy.reason(p)
    if (!blank(p.workCenterCapacityId)) {
        const row = one(CAPACITY, {workCenterCapacityId: p.workCenterCapacityId})
        if (!row) denied("RECORD_UNAVAILABLE", "Capacity " + p.workCenterCapacityId + " is not available")
        centerFor(row.facilityId, p)
        return {workCenterCapacity: endRow(CAPACITY, "workCenterCapacityId", row, p.thruDate, why)}
    }
    const {facility} = centerFor(p.facilityId, p)
    const basis = p.capacityBasisEnumId || (p.parallelSlots != null && p.parallelSlots !== "" ? "WccbSlots" : "WccbRate")
    if (!capacityBases.includes(basis)) throw new Error("Choose a quantity per time or parallel slots")
    const data = {
        facilityId: facility.facilityId,
        capacityBasisEnumId: basis,
        productId: blank(p.productId) ? null : p.productId,
        productTypeEnumId: blank(p.productTypeEnumId) ? null : p.productTypeEnumId
    }
    if (data.productId && data.productTypeEnumId) throw new Error("Choose a product or a product type, not both")
    if (data.productId && !one("mantle.product.Product", {productId: data.productId}))
        denied("RECORD_UNAVAILABLE", "Product " + data.productId + " is not available")
    if (basis === "WccbSlots") {
        const slots = Number(p.parallelSlots)
        if (!Number.isInteger(slots) || slots < 1) throw new Error("Parallel slots are a whole number of at least one")
        data.parallelSlots = slots
    } else {
        if (blank(p.quantity) || toDecimal(p.quantity).compare(0) <= 0) throw new Error("The capacity quantity must be positive")
        if (blank(p.perDuration) || toDecimal(p.perDuration).compare(0) <= 0)
            throw new Error("The capacity time must be positive")
        if (!timeUnits.includes(p.durationUomId || "TF_hr")) throw new Error("Choose a time unit for the capacity")
        policy.unit(p.quantityUomId)
        Object.assign(data, {
            quantity: p.quantity,
            quantityUomId: p.quantityUomId,
            perDuration: p.perDuration,
            durationUomId: p.durationUomId || "TF_hr"
        })
    }
    const fromDate = startOf(p.fromDate)
    const thruDate = dateValue(p.thruDate)
    if (thruDate && ms(thruDate) <= ms(fromDate)) throw new Error("The capacity end must follow its start")
    // the row of the same kind in effect at the start ends there; one starting later bounds this one
    const same = rows(CAPACITY, {
        facilityId: data.facilityId,
        capacityBasisEnumId: basis,
        productId: data.productId,
        productTypeEnumId: data.productTypeEnumId
    })
    if (same.some(row => ms(row.fromDate) === ms(fromDate))) throw new Error("A capacity of this kind already starts then")
    const next = same.filter(row => ms(row.fromDate) > ms(fromDate)).sort((a, b) => ms(a.fromDate) - ms(b.fromDate))[0]
    const fields = Object.keys(data).concat(["fromDate", "thruDate", "changeReason"])
    policy.audit(fields, why)
    for (const row of same)
        if (ms(row.fromDate) < ms(fromDate) && (row.thruDate == null || ms(row.thruDate) > ms(fromDate)))
            lib.call("update#" + CAPACITY, {
                workCenterCapacityId: row.workCenterCapacityId,
                thruDate: fromDate,
                changeReason: why
            })
    const bounded = next && (!thruDate || ms(thruDate) > ms(next.fromDate)) ? iso(next.fromDate) : thruDate
    const created = lib.call("create#" + CAPACITY, Object.assign(data, {fromDate, thruDate: bounded, changeReason: why}))
    return {workCenterCapacity: capacityRow(one(CAPACITY, {workCenterCapacityId: created.workCenterCapacityId}))}
}

// ===== store#WorkCenterAlternate =====
// A new dated alternate, or with workCenterAlternateId the end of one. The alternate is another work center of the same
// organization; one already in effect for the same product is refused.
function alternate(p) {
    const why = policy.reason(p)
    if (!blank(p.workCenterAlternateId)) {
        const row = one(ALTERNATE, {workCenterAlternateId: p.workCenterAlternateId})
        if (!row) denied("RECORD_UNAVAILABLE", "Alternate " + p.workCenterAlternateId + " is not available")
        centerFor(row.facilityId, p)
        return {workCenterAlternate: endRow(ALTERNATE, "workCenterAlternateId", row, p.thruDate, why)}
    }
    const {facility, methodScope} = centerFor(p.facilityId, p)
    const other = blank(p.alternateFacilityId) ? null : one(FACILITY, {facilityId: p.alternateFacilityId})
    if (!other || !one(CENTER, {facilityId: other.facilityId}) || other.ownerPartyId !== methodScope.organizationPartyId)
        denied("RECORD_UNAVAILABLE", "Alternate work center " + (p.alternateFacilityId || "") + " is not available")
    if (other.facilityId === facility.facilityId) throw new Error("A work center is not its own alternate")
    const productId = blank(p.productId) ? null : p.productId
    if (productId && !one("mantle.product.Product", {productId}))
        denied("RECORD_UNAVAILABLE", "Product " + productId + " is not available")
    const fromDate = startOf(p.fromDate)
    const thruDate = dateValue(p.thruDate)
    if (thruDate && ms(thruDate) <= ms(fromDate)) throw new Error("The alternate's end must follow its start")
    const overlapping = rows(ALTERNATE, {facilityId: facility.facilityId, alternateFacilityId: other.facilityId, productId}).some(
        row => (row.thruDate == null || ms(row.thruDate) > ms(fromDate)) && (!thruDate || ms(row.fromDate) < ms(thruDate))
    )
    if (overlapping) throw new Error(facilityName(other) + " is already an alternate then")
    const data = {
        facilityId: facility.facilityId,
        alternateFacilityId: other.facilityId,
        productId,
        sequenceNum: blank(p.sequenceNum) ? null : Number(p.sequenceNum),
        qualification: blank(p.qualification) ? null : String(p.qualification).trim(),
        fromDate,
        thruDate,
        changeReason: why
    }
    policy.audit(Object.keys(data), why)
    const created = lib.call("create#" + ALTERNATE, data)
    return {workCenterAlternate: alternateRow(one(ALTERNATE, {workCenterAlternateId: created.workCenterAlternateId}))}
}
// The end of a dated row: thruDate (now by default), not before its start and not later than the end it has.
function endRow(entity, idField, row, thruDate, why) {
    const end = dateValue(thruDate) || iso(now())
    if (ms(end) < ms(row.fromDate)) throw new Error("The end must not be before the start")
    if (row.thruDate != null && ms(row.thruDate) <= ms(end)) throw new Error("This row has already ended")
    policy.audit(["thruDate", "changeReason"], why)
    lib.call("update#" + entity, {[idField]: row[idField], thruDate: end, changeReason: why})
    const updated = one(entity, {[idField]: row[idField]})
    return entity === CAPACITY ? capacityRow(updated) : alternateRow(updated)
}

// ===== get#WorkCenter =====
function productText(productId) {
    if (!productId) return ""
    const product = one("mantle.product.Product", {productId})
    return product ? (product.pseudoId || product.productId) + " " + (product.productName || "") : productId
}
function capacityRow(row) {
    const basisText =
        row.capacityBasisEnumId === "WccbSlots"
            ? row.parallelSlots + " parallel " + (Number(row.parallelSlots) === 1 ? "slot" : "slots")
            : String(row.quantity) +
              " " +
              uomText(row.quantityUomId) +
              " per " +
              (String(row.perDuration) === "1" ? "" : String(row.perDuration) + " ") +
              uomText(row.durationUomId)
    return {
        workCenterCapacityId: row.workCenterCapacityId,
        facilityId: row.facilityId,
        capacityBasisEnumId: row.capacityBasisEnumId,
        basisName: enumText(row.capacityBasisEnumId),
        capacityText: basisText,
        productId: row.productId || null,
        productTypeEnumId: row.productTypeEnumId || null,
        appliesToText: row.productId
            ? productText(row.productId).trim()
            : row.productTypeEnumId
              ? enumText(row.productTypeEnumId)
              : "Every product",
        quantity: text(row.quantity),
        quantityUomId: row.quantityUomId || null,
        perDuration: text(row.perDuration),
        durationUomId: row.durationUomId || null,
        parallelSlots: row.parallelSlots == null ? null : Number(row.parallelSlots),
        fromDate: row.fromDate,
        thruDate: row.thruDate || null,
        fromText: dateText(row.fromDate),
        thruText: dateText(row.thruDate),
        inEffect: lib.active(row),
        changeReason: row.changeReason || ""
    }
}
function alternateRow(row) {
    const other = one(FACILITY, {facilityId: row.alternateFacilityId})
    return {
        workCenterAlternateId: row.workCenterAlternateId,
        facilityId: row.facilityId,
        alternateFacilityId: row.alternateFacilityId,
        alternateName: facilityName(other),
        productId: row.productId || null,
        appliesToText: row.productId ? productText(row.productId).trim() : "Every product",
        sequenceNum: row.sequenceNum == null ? null : Number(row.sequenceNum),
        qualification: row.qualification || "",
        fromDate: row.fromDate,
        thruDate: row.thruDate || null,
        fromText: dateText(row.fromDate),
        thruText: dateText(row.thruDate),
        inEffect: lib.active(row),
        changeReason: row.changeReason || ""
    }
}
function rateRow(row) {
    return {
        workCenterRateId: row.workCenterRateId,
        componentTypeEnumId: row.componentTypeEnumId,
        componentText: enumText(row.componentTypeEnumId),
        rateAmount: text(row.rateAmount),
        priceUomId: row.priceUomId,
        rateText: row.rateAmount == null ? "" : ec.l10n.formatCurrency(row.rateAmount, row.priceUomId) + " an hour",
        state: row.state,
        stateText: row.state === "approved" ? "Approved" : "Draft",
        fromDate: row.fromDate,
        thruDate: row.thruDate || null,
        fromText: dateText(row.fromDate),
        thruText: dateText(row.thruDate),
        inEffect: row.state === "approved" && lib.active(row),
        changeReason: row.changeReason || ""
    }
}
// One facility of the reader's for FacilityDetail's Work center tab: whether it is a work center, its extension with names,
// its capacities and alternates now and ahead (every one with includeEnded), its rates only with cost read (omitted, not
// empty, without it), its people capacity (Facility.capacity, shown apart), and what the user may change.
function read(p) {
    const userScope = readScope()
    const facility = facilityOf(userScope, p.facilityId)
    const center = one(CENTER, {facilityId: facility.facilityId})
    const methodScope = lib.check(() => writeScope(facility, {}))
    const canEdit = userScope.canEdit && methodScope.allowed
    const result = {
        isWorkCenter: !!center,
        facilityId: facility.facilityId,
        facilityName: facilityName(facility),
        peopleCapacity: facility.capacity == null ? null : text(facility.capacity),
        costRead: !!userScope.costRead,
        canEdit,
        canEditRate: canEdit && userScope.canEditRate,
        canApproveRate: canEdit && userScope.canApproveRate
    }
    if (!center) return Object.assign(result, {workCenter: null, capacityList: [], alternateList: []})
    const plantId = center.plantFacilityId || facility.parentFacilityId
    const plant = plantId ? one(FACILITY, {facilityId: plantId}) : null
    const calendar = center.calendarId ? one("mantle.work.calendar.Calendar", {calendarId: center.calendarId}) : null
    const keep = row => p.includeEnded === true || p.includeEnded === "true" || current(row)
    const byStart = (a, b) => ms(a.fromDate) - ms(b.fromDate)
    Object.assign(result, {
        workCenter: {
            facilityId: facility.facilityId,
            plantFacilityId: center.plantFacilityId || null,
            plantName: plant && facilityScope.owns(userScope, plant.ownerPartyId) ? facilityName(plant) : "",
            calendarId: center.calendarId || null,
            calendarName: calendar ? calendar.calendarName || calendar.calendarId : "",
            efficiencyPercent: text(center.efficiencyPercent),
            oeeTargetPercent: text(center.oeeTargetPercent),
            schedulingPolicyEnumId: center.schedulingPolicyEnumId || null,
            schedulingPolicyText: enumText(center.schedulingPolicyEnumId),
            changeReason: center.changeReason || ""
        },
        capacityList: rows(CAPACITY, {facilityId: facility.facilityId}).filter(keep).sort(byStart).map(capacityRow),
        alternateList: rows(ALTERNATE, {facilityId: facility.facilityId})
            .filter(keep)
            .sort((a, b) => Number(a.sequenceNum ?? 999) - Number(b.sequenceNum ?? 999) || byStart(a, b))
            .map(alternateRow)
    })
    // the rates only for a reader of costs; without it the field is not in the answer
    if (userScope.costRead)
        result.rateList = rows(RATE, {facilityId: facility.facilityId})
            .filter(keep)
            .sort((a, b) => String(a.componentTypeEnumId).localeCompare(String(b.componentTypeEnumId)) || byStart(a, b))
            .map(rateRow)
    return result
}

const operations = {center, capacity, alternate, read}
;({
    readScope,
    facilityOf,
    capacityRow,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown work center operation " + op)
        return operations[op](parameters)
    }
})
