// Resource outages (IronStone Maintenance design §6 Downtime, §3 WorkDowntime and the completion disposition, §7.1; MT-07, MT-10;
// impl-maintenance P5, F14): the one availability fact of a resource, ResourceUnavailability of kind RukActual, which Manufacturing's
// equipment-fault downtime and Maintenance both record, and which only end#ResourceUnavailability ends.
//
// - record: an actual outage of an asset (equipment, not stock) or a facility, from fromDate (now when empty), or the resource's
//   open outage linked (linked true): one open outage a resource. Two entry points, each checked by data, never by a caller:
//   Manufacturing's, an equipment-fault ProductionDowntime of the asset (sourceProductionDowntimeId) that the user may operate
//   (PRODUCTION_OPERATE or PRODUCTION_SUPERVISE in the stop's organization, as store#ProductionDowntime checked); and
//   Maintenance's, MAINTENANCE_SUPERVISE or MAINTENANCE_RESOURCE_EDIT on a resource of the user's maintenance scope, or
//   MAINTENANCE_EXECUTE on work assigned to the user that targets the resource (workEffortId, with its step). A work order names
//   the outage it recorded or linked (MaintenanceWorkOrder.resourceUnavailabilityId). A fault is recorded although bookings of the
//   resource exist: they are kept and answered (affectedBookingIds) for their owners; the notices are P16's.
// - correct: a supervisor's or resource administrator's correction, with its reason: a new row with the corrected interval, reason
//   and note, and the row it corrects kept with its values, superseded by the new one (the work orders' links move to it). A
//   superseded row is history: every read of current availability leaves it out.
// - end: the only restoration, a supervisor's or resource administrator's, with the disposition (available, or usable with
//   restrictions) and the readiness evidence, once every work order linked to the outage is done (OPEN_WORK names the others):
//   two work orders on one resource cannot each end the other's. Closing the production downtime, completing a work order and
//   cancelling one restore nothing.
// - find: the outages of the user's maintenance scope (a work or resource read), newest first, with their production and work
//   context, corrections, restoration and readiness; a resource's correction chain.
// Every write names the revision it read (REVISION_CHANGED).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const maintenanceAccess = ec.resource.script("component://mr-mantle/service/mantle/work/MaintenanceAccess.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const {find, one, call, denied, ms} = lib

const OUTAGE = "mantle.work.effort.ResourceUnavailability"
const ORDER = "mantle.work.maintenance.MaintenanceWorkOrder"
const WORK = "mantle.work.effort.WorkEffort"
const ASSET = "mantle.product.asset.Asset"
const FACILITY = "mantle.facility.Facility"
const DOWNTIME = "mantle.work.production.ProductionDowntime"
const REASON_TYPE = "ResourceUnavailabilityReason"

const stockTypes = ["AstTpInventory", "AstTpSupplies"]
const openWork = ["WeInPlanning", "WeApproved", "WeInProgress", "WeOnHold"]
const restoreDispositions = ["MdispAvailable", "MdispRestricted"]
const productionPermissions = ["PRODUCTION_OPERATE", "PRODUCTION_SUPERVISE"]
// a start or end may be a few minutes ahead of the server's clock (a phone's clock), never more
const clockSlackMs = 5 * 60 * 1000
const facilityDepth = 12
const chainLimit = 50

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const factory = () => ec.entity.conditionFactory
const nowMs = () => ms(ec.user.nowTimestamp)
const dateText = value => (value == null || value === "" ? "" : lib.dateText(value))
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "")
const ids = list => Array.from(new Set(list.filter(Boolean)))

// ===== reads every caller shares =====
// The conditions of a row in force: not superseded by a correction.
const inForce = query => query.condition("supersededByUnavailabilityId", "is-null", null)
// The open actual outage of a resource in force, or null.
function openOutage(resource, lock = false) {
    const conditions = resource.assetId ? {assetId: resource.assetId} : {facilityId: resource.facilityId}
    return (
        Array.from(
            inForce(find(OUTAGE, conditions))
                .condition("unavailabilityKindEnumId", "RukActual")
                .condition("thruDate", "is-null", null)
                .orderBy("fromDate")
                .forUpdate(lock)
                .limit(1)
                .list()
        )[0] || null
    )
}
// The row in force of a correction chain (itself when it was not corrected).
function current(resourceUnavailabilityId) {
    let row = resourceUnavailabilityId ? one(OUTAGE, {resourceUnavailabilityId}) : null
    for (let guard = 0; row?.supersededByUnavailabilityId && guard < chainLimit; guard++)
        row = one(OUTAGE, {resourceUnavailabilityId: row.supersededByUnavailabilityId}) || row
    return row
}
// The work orders linked to an outage (MaintenanceWorkOrder.resourceUnavailabilityId), with their roots.
function linkedWork(resourceUnavailabilityId) {
    if (!ec.entity.isEntityDefined(ORDER)) return []
    const links = Array.from(find(ORDER, {resourceUnavailabilityId}).selectField("workEffortId").list()).map(
        row => row.workEffortId
    )
    const rootIds = ids(links)
    if (!rootIds.length) return []
    return Array.from(find(WORK).condition("workEffortId", "in", rootIds).list())
}

// ===== the resource and the caller's authority =====
function requireReason(enumId) {
    const reason = blank(enumId) ? null : one("moqui.basic.Enumeration", {enumId, enumTypeId: REASON_TYPE})
    if (!reason) denied("REASON_INVALID", "Reason " + (enumId || "") + " is not a downtime reason")
    return reason
}
function requireInterval(fromDate, thruDate) {
    const limit = nowMs() + clockSlackMs
    if (ms(fromDate) > limit) denied("INTERVAL_INVALID", "An outage cannot start in the future")
    if (thruDate != null && ms(thruDate) < ms(fromDate)) denied("INTERVAL_INVALID", "An outage cannot end before it starts")
    if (thruDate != null && ms(thruDate) > limit) denied("INTERVAL_INVALID", "An outage cannot end in the future")
}
// Exactly one resource: equipment (an asset that is not stock) or a facility, locked when asked.
function resourceOf(p, lock) {
    const assetId = text(p.assetId)
    const facilityId = text(p.facilityId)
    if (!!assetId === !!facilityId) denied("RESOURCE_REQUIRED", "Name the equipment or the facility, one of them")
    if (assetId) {
        const asset = find(ASSET, {assetId}).forUpdate(lock).one()
        if (!asset || !asset.assetTypeEnumId || stockTypes.includes(asset.assetTypeEnumId))
            denied("ASSET_INVALID", "Equipment " + assetId + " is not available")
        return {assetId, facilityId: null, asset, name: asset.assetName || assetId}
    }
    const facility = find(FACILITY, {facilityId}).forUpdate(lock).one()
    if (!facility) denied("RECORD_UNAVAILABLE", "Facility " + facilityId + " is not available")
    return {assetId: null, facilityId, facility, name: facility.facilityName || facilityId}
}
// Manufacturing's entry: the equipment-fault stop of the asset that recorded the outage, of an organization the user operates.
function productionAuthority(p, resource) {
    const stop = one(DOWNTIME, {productionDowntimeId: p.sourceProductionDowntimeId})
    if (!stop || !resource.assetId || stop.assetId !== resource.assetId || stop.equipmentFault !== "Y")
        denied("SOURCE_INVALID", "Downtime " + p.sourceProductionDowntimeId + " is no equipment fault of " + resource.name)
    if (!productionPermissions.some(lib.access.has) || !facilityScope.owns(facilityScope.scope(), stop.organizationPartyId))
        denied("PERMISSION_DENIED", "Downtime " + stop.productionDowntimeId + " is not one you may report")
    const home = resource.asset.facilityId ? one(FACILITY, {facilityId: resource.asset.facilityId}) : null
    return {organizationPartyId: home?.ownerPartyId || resource.asset.ownerPartyId || null, work: null}
}
// A work order of the scope whose target is the resource, with the step named (in its tree).
function workOf(userScope, p, resource) {
    const found = maintenanceAccess.requireWork(userScope, text(p.workEffortId))
    const order = one(ORDER, {workEffortId: found.rootWorkEffortId})
    if (!order || found.rootWorkEffortId !== text(p.workEffortId))
        denied("WORK_INVALID", "Work " + p.workEffortId + " is not a maintenance work order")
    const root = one(WORK, {workEffortId: order.workEffortId})
    const targets = resource.assetId
        ? order.assetId === resource.assetId
        : !order.assetId && root.facilityId === resource.facilityId
    if (!targets) denied("WORK_INVALID", "Work order " + order.workEffortId + " is not work on " + resource.name)
    let stepId = text(p.stepWorkEffortId)
    if (stepId) {
        const step = one(WORK, {workEffortId: stepId})
        if (!step || step.rootWorkEffortId !== order.workEffortId)
            denied("STEP_INVALID", "Step " + stepId + " is not a step of work order " + order.workEffortId)
    }
    return {order, root, stepId}
}
// Maintenance's entry: a supervisor or resource administrator of the resource's organization, or the technician assigned to the
// work on it.
function maintenanceAuthority(p, resource) {
    const userScope = maintenanceAccess.scope()
    const caps = userScope.capabilities
    if (!(caps.supervise || caps.resourceEdit || caps.execute))
        denied("PERMISSION_DENIED", "Maintenance supervise, resource edit or execute is required")
    const organizationPartyId = resource.assetId
        ? maintenanceAccess.requireAsset(userScope, resource.assetId).organizationPartyId
        : maintenanceAccess.requireFacility(userScope, resource.facilityId).organizationPartyId
    const work = blank(p.workEffortId) ? null : workOf(userScope, p, resource)
    if (!(caps.supervise || caps.resourceEdit)) {
        if (!work) denied("WORK_REQUIRED", "A technician records an outage from the work assigned to them")
        if (!maintenanceAccess.assignment(userScope, work.order.workEffortId).step)
            denied("NOT_ASSIGNED", "Work order " + work.order.workEffortId + " is not assigned to you")
    }
    return {organizationPartyId, work, userScope}
}
function requireStaff(userScope) {
    const caps = userScope.capabilities
    if (!(caps.supervise || caps.resourceEdit))
        denied("PERMISSION_DENIED", "A maintenance supervisor or resource administrator restores and corrects outages")
}
// An outage of the caller's maintenance scope, locked when asked (a missing one and one outside the scope alike).
function outageOf(userScope, resourceUnavailabilityId, lock = false) {
    const row = blank(resourceUnavailabilityId) ? null : find(OUTAGE, {resourceUnavailabilityId}).forUpdate(lock).one()
    if (!row || !maintenanceAccess.covers(userScope, row.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Outage " + (resourceUnavailabilityId || "") + " is not available")
    return row
}
function requireRevision(row, expectedRevision) {
    if (blank(expectedRevision) || Number(expectedRevision) !== Number(row.revision || 0))
        denied(
            "REVISION_CHANGED",
            "Outage " + row.resourceUnavailabilityId + " changed (now revision " + (row.revision || 0) + "); reload it"
        )
}
function requireInForce(row) {
    if (row.supersededByUnavailabilityId)
        denied(
            "OUTAGE_CORRECTED",
            "Outage " + row.resourceUnavailabilityId + " was corrected by " + row.supersededByUnavailabilityId
        )
}
// A work order's link to the outage, unless it names an outage still open.
function linkWork(workEffortId, resourceUnavailabilityId) {
    const order = one(ORDER, {workEffortId})
    if (!order || order.resourceUnavailabilityId === resourceUnavailabilityId) return
    const linkedNow = order.resourceUnavailabilityId ? current(order.resourceUnavailabilityId) : null
    if (linkedNow && linkedNow.thruDate == null && linkedNow.resourceUnavailabilityId !== resourceUnavailabilityId) return
    call("update#" + ORDER, {workEffortId, resourceUnavailabilityId})
}

// The bookings of the resource over the outage, kept and answered by id only (no title or attendee): an asset's
// WorkEffortAssetAssign and a facility's WorkEffortFacility bookings of events not cancelled, not denied, ending after it starts.
function affectedBookings(resource, fromDate, thruDate) {
    const f = factory()
    const overlap = [
        f.makeCondition("statusId", "not-in", ["WeCancelled"], true),
        f.makeCondition(
            [
                f.makeCondition("estimatedCompletionDate", "is-null", null),
                f.makeCondition("estimatedCompletionDate", "greater", fromDate)
            ],
            "or"
        )
    ]
    if (thruDate != null) overlap.push(f.makeCondition("estimatedStartDate", "less", thruDate))
    const found = resource.assetId
        ? find("mantle.work.effort.WorkEffortAndAssetBooking", {assetId: resource.assetId})
              .condition(f.makeCondition("bookingStatusId", "not-equals", "WeaaRequestDenied", true))
              .condition(
                  f.makeCondition(
                      [
                          f.makeCondition("bookingThruDate", "is-null", null),
                          f.makeCondition("bookingThruDate", "greater", fromDate)
                      ],
                      "or"
                  )
              )
        : find("mantle.work.effort.WorkEffortAndFacilityBooking", {facilityId: resource.facilityId}).condition(
              f.makeCondition("bookingStatusId", "not-equals", "WefRequestDenied", true)
          )
    return ids(
        Array.from(found.condition(f.makeCondition(overlap, "and")).selectField("workEffortId").limit(200).list()).map(
            row => row.workEffortId
        )
    )
}

// ===== record#ResourceUnavailability =====
function record(p) {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in to record an outage")
    if ((p.unavailabilityKindEnumId || "RukActual") !== "RukActual")
        denied("KIND_INVALID", "Only an actual outage is recorded here; planned blocks are Blackouts'")
    const resource = resourceOf(p, true)
    const production = !blank(p.sourceProductionDowntimeId)
    const authority = production ? productionAuthority(p, resource) : maintenanceAuthority(p, resource)
    const reason = requireReason(text(p.unavailabilityReasonEnumId) || (production ? "RurEquipmentFault" : null))
    const fromDate = p.fromDate || ec.user.nowTimestamp
    const thruDate = p.thruDate || null
    requireInterval(fromDate, thruDate)
    const work = authority.work
    if (thruDate == null) {
        const open = openOutage(resource)
        if (open) {
            if (work) linkWork(work.order.workEffortId, open.resourceUnavailabilityId)
            return answerOf(open, true, resource)
        }
    } else if (!production) requireStaff(authority.userScope)
    const ended = thruDate != null
    const created = call("create#" + OUTAGE, {
        unavailabilityKindEnumId: "RukActual",
        assetId: resource.assetId,
        facilityId: resource.facilityId,
        organizationPartyId: authority.organizationPartyId,
        fromDate,
        thruDate,
        description: text(p.description),
        sourceProductionDowntimeId: production ? p.sourceProductionDowntimeId : null,
        unavailabilityReasonEnumId: reason.enumId,
        plannedOutage: reason.optionIndicator === "Y" ? "Y" : "N",
        workEffortId: work?.order.workEffortId || null,
        stepWorkEffortId: work?.stepId || null,
        revision: 1,
        createdByUserId: ec.user.userId,
        createdDate: ec.user.nowTimestamp,
        endedByUserId: ended ? ec.user.userId : null,
        endedDate: ended ? ec.user.nowTimestamp : null
    })
    const row = one(OUTAGE, {resourceUnavailabilityId: created.resourceUnavailabilityId})
    if (work && !ended) linkWork(work.order.workEffortId, row.resourceUnavailabilityId)
    return answerOf(row, false, resource)
}
function answerOf(row, linked, resource) {
    const bookings = row.thruDate == null ? affectedBookings(resource, row.fromDate, null) : []
    return {
        resourceUnavailabilityId: row.resourceUnavailabilityId,
        linked,
        revision: Number(row.revision || 0),
        affectedBookingIds: bookings,
        affectedBookingCount: bookings.length
    }
}

// ===== correct#ResourceUnavailability =====
function correct(p) {
    const userScope = maintenanceAccess.scope()
    requireStaff(userScope)
    const row = outageOf(userScope, p.resourceUnavailabilityId, true)
    requireInForce(row)
    requireRevision(row, p.expectedRevision)
    const changeReason = text(p.changeReason)
    if (!changeReason) denied("REASON_REQUIRED", "A correction needs its reason")
    const fromDate = p.fromDate || row.fromDate
    if (row.thruDate == null && p.thruDate) denied("OUTAGE_OPEN", "An open outage is ended by restoring the resource")
    const thruDate = row.thruDate == null ? null : p.thruDate || row.thruDate
    requireInterval(fromDate, thruDate)
    const reason = requireReason(text(p.unavailabilityReasonEnumId) || row.unavailabilityReasonEnumId || "RurEquipmentFault")
    const created = call("create#" + OUTAGE, {
        unavailabilityKindEnumId: row.unavailabilityKindEnumId,
        assetId: row.assetId,
        facilityId: row.facilityId,
        organizationPartyId: row.organizationPartyId,
        fromDate,
        thruDate,
        description: p.description == null ? row.description || null : text(p.description),
        sourceProductionDowntimeId: row.sourceProductionDowntimeId || null,
        unavailabilityReasonEnumId: reason.enumId,
        plannedOutage: reason.optionIndicator === "Y" ? "Y" : "N",
        workEffortId: row.workEffortId || null,
        stepWorkEffortId: row.stepWorkEffortId || null,
        revision: 1,
        createdByUserId: row.createdByUserId,
        createdDate: row.createdDate,
        endedByUserId: row.endedByUserId || null,
        endedDate: row.endedDate || null,
        dispositionEnumId: row.dispositionEnumId || null,
        endComments: row.endComments || null,
        originalUnavailabilityId: row.originalUnavailabilityId || row.resourceUnavailabilityId,
        correctionOfUnavailabilityId: row.resourceUnavailabilityId,
        changeReason,
        correctedByUserId: ec.user.userId,
        correctedDate: ec.user.nowTimestamp
    })
    call("update#" + OUTAGE, {
        resourceUnavailabilityId: row.resourceUnavailabilityId,
        supersededByUnavailabilityId: created.resourceUnavailabilityId,
        revision: Number(row.revision || 0) + 1
    })
    // the work orders' links follow the row in force
    if (ec.entity.isEntityDefined(ORDER))
        for (const order of Array.from(find(ORDER, {resourceUnavailabilityId: row.resourceUnavailabilityId}).list()))
            call("update#" + ORDER, {
                workEffortId: order.workEffortId,
                resourceUnavailabilityId: created.resourceUnavailabilityId
            })
    return {
        resourceUnavailabilityId: created.resourceUnavailabilityId,
        correctedUnavailabilityId: row.resourceUnavailabilityId,
        revision: 1
    }
}

// ===== end#ResourceUnavailability =====
// What keeps an outage from being ended now: the open work orders linked to it.
function restoreBlockers(row) {
    return linkedWork(row.resourceUnavailabilityId)
        .filter(root => openWork.includes(root.statusId))
        .map(root => ({
            workEffortId: root.workEffortId,
            blocker: "Work order " + root.workEffortId + " is " + statusText(root.statusId).toLowerCase(),
            detail: root.workEffortName || ""
        }))
}
function end(p) {
    const userScope = maintenanceAccess.scope()
    requireStaff(userScope)
    const row = outageOf(userScope, p.resourceUnavailabilityId, true)
    requireInForce(row)
    if (row.unavailabilityKindEnumId !== "RukActual") denied("KIND_INVALID", "A planned block is not restored here")
    if (row.thruDate != null) denied("OUTAGE_ENDED", "Outage " + row.resourceUnavailabilityId + " has ended")
    requireRevision(row, p.expectedRevision)
    const disposition = text(p.dispositionEnumId)
    if (!disposition) denied("DISPOSITION_REQUIRED", "Say whether the resource is available, or usable with restrictions")
    if (!restoreDispositions.includes(disposition))
        denied("DISPOSITION_INVALID", "A restored resource is available, or usable with restrictions")
    const thruDate = p.thruDate || ec.user.nowTimestamp
    requireInterval(row.fromDate, thruDate)
    const blockers = restoreBlockers(row)
    if (blockers.length)
        denied("OPEN_WORK", blockers.map(blocker => blocker.blocker).join("; ") + ": finish or cancel it before restoring")
    call("update#" + OUTAGE, {
        resourceUnavailabilityId: row.resourceUnavailabilityId,
        thruDate,
        endedByUserId: ec.user.userId,
        endedDate: ec.user.nowTimestamp,
        dispositionEnumId: disposition,
        endComments: text(p.endComments),
        revision: Number(row.revision || 0) + 1
    })
    return {
        resourceUnavailabilityId: row.resourceUnavailabilityId,
        resultCode: "RESTORED",
        revision: Number(row.revision || 0) + 1
    }
}

// ===== find#ResourceUnavailability =====
function subtreeIds(facilityId) {
    const found = new Set([facilityId])
    let frontier = [facilityId]
    for (let depth = 0; frontier.length && depth < facilityDepth; depth++) {
        const children = Array.from(find(FACILITY).condition("parentFacilityId", "in", frontier).selectField("facilityId").list())
            .map(row => row.facilityId)
            .filter(id => !found.has(id))
        for (const id of children) found.add(id)
        frontier = children
    }
    return Array.from(found)
}
// A list's scope (F83, as the work orders'): every organization narrowed to the active one when one is chosen.
function listScope(userScope) {
    if (userScope.organizationPartyIds != null) return userScope.organizationPartyIds
    const active = userScope.activeOrganizationPartyId
    if (!active || !one("mantle.party.PartyRole", {partyId: active, roleTypeId: "OrgInternal"})) return null
    return [active]
}
// The resource conditions of a facility: the facility and those inside it, and the equipment located there.
function facilityCondition(facilityId) {
    const facilityIds = subtreeIds(facilityId)
    const assetIds = Array.from(find(ASSET).condition("facilityId", "in", facilityIds).selectField("assetId").list()).map(
        row => row.assetId
    )
    const f = factory()
    const either = [f.makeCondition("facilityId", "in", facilityIds)]
    if (assetIds.length) either.push(f.makeCondition("assetId", "in", assetIds))
    return f.makeCondition(either, "or")
}
function scopedQuery(organizationPartyIds, p) {
    const f = factory()
    let query = find(OUTAGE).orderBy("-fromDate").orderBy("-resourceUnavailabilityId")
    if (organizationPartyIds)
        query = query.condition("organizationPartyId", "in", organizationPartyIds.length ? organizationPartyIds : ["_NA_"])
    if (!blank(p.organizationPartyId)) query = query.condition("organizationPartyId", p.organizationPartyId)
    query = query.condition("unavailabilityKindEnumId", text(p.unavailabilityKindEnumId) || "RukActual")
    if (!blank(p.resourceUnavailabilityId)) query = query.condition("resourceUnavailabilityId", p.resourceUnavailabilityId)
    else if (!(p.includeCorrected === true || p.includeCorrected === "true")) query = inForce(query)
    if (!blank(p.assetId)) query = query.condition("assetId", p.assetId)
    if (!blank(p.facilityId)) query = query.condition(facilityCondition(p.facilityId))
    if (!blank(p.unavailabilityReasonEnumId)) query = query.condition("unavailabilityReasonEnumId", p.unavailabilityReasonEnumId)
    if (p.planned === "Y" || p.planned === "true" || p.planned === true) query = query.condition("plannedOutage", "Y")
    if (p.planned === "N" || p.planned === "false" || p.planned === false)
        query = query.condition(f.makeCondition("plannedOutage", "not-equals", "Y", true))
    if (p.open === true || p.open === "true" || p.open === "Y") query = query.condition("thruDate", "is-null", null)
    if (p.open === false || p.open === "false" || p.open === "N") query = query.condition("thruDate", "is-not-null", null)
    if (p.source === "production") query = query.condition("sourceProductionDowntimeId", "is-not-null", null)
    if (p.source === "work") query = query.condition("workEffortId", "is-not-null", null)
    if (!blank(p.workEffortId)) {
        const linked = one(ORDER, {workEffortId: p.workEffortId})?.resourceUnavailabilityId
        const either = [f.makeCondition("workEffortId", "equals", p.workEffortId)]
        if (linked) either.push(f.makeCondition("resourceUnavailabilityId", "equals", linked))
        query = query.condition(f.makeCondition(either, "or"))
    }
    if (p.thruDate) query = query.condition("fromDate", "less", p.thruDate)
    if (p.fromDate)
        query = query.condition(
            f.makeCondition(
                [f.makeCondition("thruDate", "is-null", null), f.makeCondition("thruDate", "greater", p.fromDate)],
                "or"
            )
        )
    return query
}
function durationText(minutes) {
    const days = Math.floor(minutes / 1440)
    const hours = Math.floor((minutes % 1440) / 60)
    if (days) return days + " d " + hours + " h"
    return hours ? hours + " h " + (minutes % 60) + " min" : minutes + " min"
}
// The rows of a page with their display text, the names read once per page.
function displayRows(list, userScope) {
    const cache = new Map()
    const cached = (key, read) => {
        if (!cache.has(key)) cache.set(key, read())
        return cache.get(key)
    }
    const userName = userId =>
        cached("u" + userId, () => {
            const account = userId ? one("moqui.security.UserAccount", {userId}) : null
            return account ? account.userFullName || account.username || userId : ""
        })
    const facilityName = facilityId =>
        cached("f" + facilityId, () => (facilityId ? one(FACILITY, {facilityId})?.facilityName || facilityId : ""))
    const caps = userScope.capabilities
    const staff = !!(caps.supervise || caps.resourceEdit)
    const at = nowMs()
    return list.map(row => {
        const asset = row.assetId ? cached("a" + row.assetId, () => one(ASSET, {assetId: row.assetId})) : null
        const open = row.thruDate == null
        const superseded = !!row.supersededByUnavailabilityId
        const minutes = Math.max(0, Math.round(((open ? at : ms(row.thruDate)) - ms(row.fromDate)) / 60000))
        const stop = row.sourceProductionDowntimeId ? one(DOWNTIME, {productionDowntimeId: row.sourceProductionDowntimeId}) : null
        const stopCount = find(DOWNTIME, {resourceUnavailabilityId: row.resourceUnavailabilityId}).count()
        const stopReason = stop
            ? Array.from(
                  find("mantle.work.production.ProductionReason", {
                      organizationPartyId: stop.organizationPartyId,
                      reasonCode: stop.reasonCode
                  })
                      .orderBy("-fromDate")
                      .limit(1)
                      .list()
              )[0]?.reasonName || stop.reasonCode
            : ""
        const run = stop?.workEffortId ? one(WORK, {workEffortId: stop.workEffortId}) : null
        const work = linkedWork(row.resourceUnavailabilityId)
        if (row.workEffortId && !work.some(root => root.workEffortId === row.workEffortId)) {
            const source = one(WORK, {workEffortId: row.workEffortId})
            if (source) work.unshift(source)
        }
        const blockers = open && !superseded ? restoreBlockers(row) : []
        const bookings =
            open && !superseded
                ? affectedBookings(row.assetId ? {assetId: row.assetId} : {facilityId: row.facilityId}, row.fromDate, null)
                : []
        const reasonId = row.unavailabilityReasonEnumId || (row.sourceProductionDowntimeId ? "RurEquipmentFault" : null)
        return {
            resourceUnavailabilityId: row.resourceUnavailabilityId,
            resourceType: row.assetId ? "asset" : "facility",
            assetId: row.assetId || null,
            facilityId: row.facilityId || null,
            resourceName: asset ? asset.assetName || asset.assetId : facilityName(row.facilityId),
            locationName: asset?.facilityId ? facilityName(asset.facilityId) : "",
            organizationPartyId: row.organizationPartyId || null,
            fromDate: row.fromDate,
            fromText: dateText(row.fromDate),
            thruDate: row.thruDate || null,
            thruText: dateText(row.thruDate),
            open,
            elapsedMinutes: minutes,
            elapsedText: open ? "Down " + durationText(minutes) : durationText(minutes),
            unavailabilityReasonEnumId: reasonId,
            reasonText: enumText(reasonId),
            planned: row.plannedOutage === "Y",
            plannedText: row.plannedOutage === "Y" ? "Planned" : "Unplanned",
            description: row.description || "",
            productionDowntimeId: row.sourceProductionDowntimeId || null,
            productionText: stop
                ? [facilityName(stop.facilityId), stopReason, run ? run.workEffortName || run.workEffortId : ""]
                      .filter(Boolean)
                      .join(" · ") + (stopCount > 1 ? " (" + stopCount + " stops)" : "")
                : "",
            sourceText: stop ? "Production stop" : row.workEffortId ? "Work order" : "Recorded in Maintenance",
            workList: work.map(root => ({
                workEffortId: root.workEffortId,
                workEffortName: root.workEffortName || root.workEffortId,
                statusText: statusText(root.statusId),
                open: openWork.includes(root.statusId)
            })),
            workText: work
                .map(root => root.workEffortId + " " + (root.workEffortName || "") + " (" + statusText(root.statusId) + ")")
                .join(", "),
            createdByName: userName(row.createdByUserId),
            createdText: dateText(row.createdDate),
            endedByName: userName(row.endedByUserId),
            endedText: dateText(row.endedDate),
            dispositionEnumId: row.dispositionEnumId || null,
            dispositionText: enumText(row.dispositionEnumId),
            endComments: row.endComments || "",
            revision: Number(row.revision || 0),
            superseded,
            supersededByUnavailabilityId: row.supersededByUnavailabilityId || null,
            correctionOfUnavailabilityId: row.correctionOfUnavailabilityId || null,
            correctedByName: userName(row.correctedByUserId),
            correctedText: dateText(row.correctedDate),
            changeReason: row.changeReason || "",
            stateText: superseded ? "Corrected" : open ? "Out of service" : "Restored",
            stateColor: superseded ? "grey-8" : open ? "negative" : "positive",
            restoredText:
                open || superseded
                    ? ""
                    : "Restored " + dateText(row.thruDate) + (row.endedByUserId ? " by " + userName(row.endedByUserId) : ""),
            affectedBookingCount: bookings.length,
            restoreBlockers: blockers,
            restoreBlockerText: blockers.map(blocker => blocker.blocker).join("; "),
            canRestore: staff && open && !superseded && !blockers.length && row.unavailabilityKindEnumId === "RukActual",
            canCorrect: staff && !superseded
        }
    })
}
// A row's correction chain, from the first record to the row in force.
function chainOf(row) {
    const chain = [row]
    let at = row
    for (let guard = 0; at.correctionOfUnavailabilityId && guard < chainLimit; guard++) {
        at = one(OUTAGE, {resourceUnavailabilityId: at.correctionOfUnavailabilityId})
        if (!at) break
        chain.unshift(at)
    }
    at = chain[chain.length - 1]
    for (let guard = 0; at.supersededByUnavailabilityId && guard < chainLimit; guard++) {
        at = one(OUTAGE, {resourceUnavailabilityId: at.supersededByUnavailabilityId})
        if (!at) break
        chain.push(at)
    }
    return chain
}
function readScope() {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in to read outages")
    const userScope = maintenanceAccess.scope()
    if (!(userScope.capabilities.workRead || userScope.capabilities.resourceRead))
        denied("PERMISSION_DENIED", "Maintenance work or resource view is required")
    return userScope
}
function findOutages(p) {
    const userScope = readScope()
    if (!blank(p.workEffortId)) maintenanceAccess.requireWork(userScope, p.workEffortId)
    const build = () => scopedQuery(listScope(userScope), p)
    const paged = lib.page(build(), p, "outageList", build().count())
    const result = Object.assign({}, paged, {rows: undefined, outageList: displayRows(paged.rows, userScope)})
    result.history = []
    if (!blank(p.resourceUnavailabilityId)) {
        const row = outageOf(userScope, p.resourceUnavailabilityId)
        result.history = displayRows(chainOf(row), userScope)
    }
    const caps = userScope.capabilities
    result.canRecord = !!(caps.supervise || caps.resourceEdit || caps.execute)
    result.canRestore = !!(caps.supervise || caps.resourceEdit)
    return result
}

// ===== for the other maintenance services =====
// Home's count of the resources down now in the scope (a facility with those inside it and the equipment there).
function downCount(userScope, filters) {
    return scopedQuery(listScope(userScope), {
        organizationPartyId: filters.organizationPartyId,
        facilityId: filters.facilityId,
        open: true
    }).count()
}
// A work order's outage: the row in force it recorded or linked, and whether it is open.
function workOutage(order) {
    const row = order?.resourceUnavailabilityId ? current(order.resourceUnavailabilityId) : null
    if (!row) return null
    return {
        resourceUnavailabilityId: row.resourceUnavailabilityId,
        open: row.thruDate == null,
        text:
            row.thruDate == null
                ? "Out of service since " + dateText(row.fromDate) + " (" + enumText(row.unavailabilityReasonEnumId) + ")"
                : "Restored " + dateText(row.thruDate)
    }
}

;({
    openOutage,
    current,
    record,
    correct,
    end,
    findOutages,
    downCount,
    workOutage,
    execute: (op, p) => {
        const operations = {record, correct, end, find: findOutages}
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown resource outage operation " + op)
        return operations[op](p || {})
    }
})
