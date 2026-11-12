// Manufacturing's production downtime and its maintenance (design-manufacturing Downtime, EquipmentDetail, §12 M6, D24,
// review Y3; impl-manufacturing P11): store#ProductionDowntime opens, closes, approves and corrects a reason-coded stop
// of a work center, with its optional equipment, run and operation; an equipment fault with an asset records or links the
// asset's one open outage (mantle.work.ResourceBookingServices.record#ResourceUnavailability) in the same transaction.
// find#ProductionDowntime reads the stops of the user's organizations with their display text, and a stop's correction
// chain. request#ProductionMaintenance asks for corrective maintenance of the equipment: an AssetMaintenance (AsMntCreated,
// MntTpCorrective) and, when wanted, an intake Request (RqtMaintenance) linked to the stop, the equipment, the maintenance
// and the stopped work. Closing a stop changes only the stop: the request, the maintenance and the outage stay open, and no
// person timer starts. A correction keeps the row it corrects, with its interval and its reporter, and makes a new row.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const {find, one, rows, call, denied, access, dateText, ms} = lib

const DOWNTIME = "mantle.work.production.ProductionDowntime",
    OUTAGE = "mantle.work.effort.ResourceUnavailability",
    REASON = "mantle.work.production.ProductionReason",
    CENTER = "mantle.work.production.WorkCenter",
    FACILITY = "mantle.facility.Facility",
    ASSET = "mantle.product.asset.Asset",
    WORK = "mantle.work.effort.WorkEffort",
    MAINTENANCE = "mantle.product.maintenance.AssetMaintenance",
    REQUEST = "mantle.request.Request"
// the reason categories of a stop: downtime (a fault, a changeover) and a hold (waiting for material, an operator, quality)
const stopCategories = ["PrcDowntime", "PrcHold"]
const stockTypes = ["AstTpInventory", "AstTpSupplies"]
// a stop's start or end may be a few minutes ahead of the server's clock (a phone's clock), never more
const clockSlackMs = 5 * 60 * 1000
const readPermissions = ["PRODUCTION_VIEW", "PRODUCTION_OPERATE", "PRODUCTION_SUPERVISE"]
const reportPermissions = ["PRODUCTION_OPERATE", "PRODUCTION_SUPERVISE"]
const statusColors = {PdtOpen: "negative", PdtClosed: "positive", PdtCorrected: "grey-8"}

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "")
const facilityName = facility => (facility ? facility.facilityName || facility.facilityId : "")
const nowMs = () => ms(ec.user.nowTimestamp)
const outages = () => ec.resource.script("component://mr-mantle/service/mantle/work/ResourceOutages.js")
const canReport = () => reportPermissions.some(access.has)

// ===== the records a stop names =====
// A work center of the user's organizations; a missing one and one outside the scope are refused alike.
function centerOf(userScope, facilityId) {
    const facility = blank(facilityId) ? null : one(FACILITY, {facilityId})
    if (!facility || !facilityScope.owns(userScope, facility.ownerPartyId))
        denied("RECORD_UNAVAILABLE", "Work center " + (facilityId || "") + " is not available")
    if (!one(CENTER, {facilityId})) denied("CENTER_INVALID", facilityName(facility) + " is not a work center")
    return facility
}
// Equipment (an asset that is not stock) at a facility of the stop's organization.
function equipmentOf(userScope, assetId, organizationPartyId) {
    const asset = blank(assetId) ? null : one(ASSET, {assetId})
    const home = asset?.facilityId ? one(FACILITY, {facilityId: asset.facilityId}) : null
    if (!asset || !home || !facilityScope.owns(userScope, home.ownerPartyId))
        denied("RECORD_UNAVAILABLE", "Equipment " + (assetId || "") + " is not available")
    if (!asset.assetTypeEnumId || stockTypes.includes(asset.assetTypeEnumId))
        denied("ASSET_INVALID", "Asset " + assetId + " is stock, not equipment")
    if (organizationPartyId && home.ownerPartyId !== organizationPartyId)
        denied("ASSET_INVALID", "Equipment " + assetId + " is another organization's")
    return asset
}
// The run and operation a stop names: an operation is a child of its run (release makes them), and the run is a production
// run of the stop's organization.
function workOf(userScope, organizationPartyId, workEffortId, operationWorkEffortId) {
    if (blank(workEffortId) && blank(operationWorkEffortId)) return {run: null, operation: null}
    const operation = blank(operationWorkEffortId) ? null : one(WORK, {workEffortId: operationWorkEffortId})
    const runId = blank(workEffortId) ? operation?.rootWorkEffortId || operation?.parentWorkEffortId : workEffortId
    if (operation && (!runId || (operation.parentWorkEffortId !== runId && operation.rootWorkEffortId !== runId)))
        denied("OPERATION_INVALID", "Operation " + operationWorkEffortId + " is not an operation of run " + (runId || ""))
    const production = ec.resource.script("component://mr-mantle/service/mantle/work/Production.js")
    const run = production.runOf(userScope, runId)
    if (run.ownerPartyId !== organizationPartyId)
        denied("RUN_INVALID", "Run " + run.workEffortId + " is not a run of the work center's organization")
    return {run, operation}
}
// The organization's stop reason in effect at the stop's start: a downtime or hold reason.
function reasonOf(organizationPartyId, reasonCode, at) {
    const policy = ec.resource.script("component://mr-mantle/service/mantle/work/ProductionPolicy.js")
    const reason = policy.activeReason(organizationPartyId, text(reasonCode), at)
    if (!reason) denied("REASON_INVALID", "Reason " + (reasonCode || "") + " is not an active reason")
    if (!stopCategories.includes(reason.reasonCategoryEnumId))
        denied("REASON_INVALID", "Reason " + reasonCode + " is not a downtime or hold reason")
    return reason
}
// A stop's interval: it started, and ends after it starts and not after now.
function checkInterval(fromDate, thruDate) {
    const limit = nowMs() + clockSlackMs
    if (ms(fromDate) > limit) denied("INTERVAL_INVALID", "A stop cannot start in the future")
    if (thruDate != null && ms(thruDate) < ms(fromDate)) denied("INTERVAL_INVALID", "A stop cannot end before it starts")
    if (thruDate != null && ms(thruDate) > limit) denied("INTERVAL_INVALID", "A stop cannot end in the future")
}
// A stop of the user's organizations, locked when asked.
function downtimeOf(userScope, productionDowntimeId, lock = false) {
    const row = blank(productionDowntimeId) ? null : find(DOWNTIME, {productionDowntimeId}).forUpdate(lock).one()
    const facility = row?.facilityId ? one(FACILITY, {facilityId: row.facilityId}) : null
    if (
        !row ||
        !facilityScope.owns(userScope, row.organizationPartyId) ||
        !facility ||
        !facilityScope.owns(userScope, facility.ownerPartyId)
    )
        denied("RECORD_UNAVAILABLE", "Downtime " + (productionDowntimeId || "") + " is not available")
    return row
}
function requireRevision(row, expectedRevision) {
    if (blank(expectedRevision) || Number(expectedRevision) !== Number(row.revision || 0))
        denied("REVISION_CHANGED", "Downtime " + row.productionDowntimeId + " changed; reload it")
}
function requireNotCorrected(row) {
    if (row.statusId === "PdtCorrected")
        denied(
            "DOWNTIME_CORRECTED",
            "Downtime " + row.productionDowntimeId + " was corrected by " + (row.supersededByDowntimeId || "a later row")
        )
}
// An equipment fault of an asset: its one open outage, recorded or linked in this transaction (review Y3). Any other reason,
// or no asset, records none.
function outageOf(row) {
    if (row.equipmentFault !== "Y" || !row.assetId || row.resourceUnavailabilityId) return null
    const out = call("mantle.work.ResourceBookingServices.record#ResourceUnavailability", {
        assetId: row.assetId,
        fromDate: row.fromDate,
        description: row.description || null,
        sourceProductionDowntimeId: row.productionDowntimeId
    })
    call("update#" + DOWNTIME, {
        productionDowntimeId: row.productionDowntimeId,
        resourceUnavailabilityId: out.resourceUnavailabilityId
    })
    return {resourceUnavailabilityId: out.resourceUnavailabilityId, linked: !!out.linked}
}
// The approval a stop needs (design Downtime "supervisors may correct and approve"; ReasonCodes' approval threshold): an
// ended stop longer than the threshold, in minutes, of the reason row in effect at its start; an open one waits for its end.
const thresholdOf = reason =>
    reason.approvalThreshold == null || String(reason.approvalThreshold) === "" ? null : Number(String(reason.approvalThreshold))
function approvalOf(threshold, fromDate, thruDate) {
    if (threshold == null || thruDate == null) return "N"
    return (ms(thruDate) - ms(fromDate)) / 60000 > Number(String(threshold)) ? "Y" : "N"
}
// What a change answers: the stop's id, state and revision, its outage and whether maintenance is suggested.
function answerOf(productionDowntimeId, resultCode, outage, extra = {}) {
    const row = one(DOWNTIME, {productionDowntimeId})
    return Object.assign(
        {
            resultCode,
            productionDowntimeId,
            statusId: row.statusId,
            revision: Number(row.revision || 0),
            facilityId: row.facilityId,
            assetId: row.assetId || null,
            workEffortId: row.workEffortId || null,
            operationWorkEffortId: row.operationWorkEffortId || null,
            reasonCode: row.reasonCode,
            equipmentFault: row.equipmentFault === "Y",
            approvalRequired: row.approvalRequired === "Y" && !row.approvedByUserId,
            resourceUnavailabilityId: row.resourceUnavailabilityId || null,
            outageLinked: !!outage?.linked,
            // only an equipment fault of a machine suggests maintenance (design Downtime Actions)
            suggestMaintenance: row.equipmentFault === "Y" && !!row.assetId && !row.assetMaintenanceId
        },
        extra
    )
}

// ===== store#ProductionDowntime =====
function open(userScope, p) {
    const facility = centerOf(userScope, p.facilityId)
    const organizationPartyId = facility.ownerPartyId
    const asset = blank(p.assetId) ? null : equipmentOf(userScope, p.assetId, organizationPartyId)
    const work = workOf(userScope, organizationPartyId, p.workEffortId, p.operationWorkEffortId)
    const fromDate = p.fromDate || ec.user.nowTimestamp
    const thruDate = p.thruDate || null
    checkInterval(fromDate, thruDate)
    const reason = reasonOf(organizationPartyId, p.reasonCode, fromDate)
    const created = call("create#" + DOWNTIME, {
        organizationPartyId,
        facilityId: facility.facilityId,
        assetId: asset?.assetId || null,
        workEffortId: work.run?.workEffortId || null,
        operationWorkEffortId: work.operation?.workEffortId || null,
        statusId: thruDate ? "PdtClosed" : "PdtOpen",
        reasonCode: reason.reasonCode,
        reasonCategoryEnumId: reason.reasonCategoryEnumId,
        equipmentFault: reason.equipmentFault === "Y" ? "Y" : "N",
        plannedStop: reason.plannedStop === "Y" ? "Y" : "N",
        approvalThreshold: thresholdOf(reason),
        approvalRequired: approvalOf(thresholdOf(reason), fromDate, thruDate),
        fromDate,
        thruDate,
        description: text(p.description),
        revision: 1,
        reportedByUserId: ec.user.userId,
        reportedDate: ec.user.nowTimestamp,
        closedByUserId: thruDate ? ec.user.userId : null,
        closedDate: thruDate ? ec.user.nowTimestamp : null
    })
    const outage = outageOf(one(DOWNTIME, {productionDowntimeId: created.productionDowntimeId}))
    return answerOf(created.productionDowntimeId, thruDate ? "RECORDED" : "OPENED", outage)
}
// The end of an open stop; nothing else changes (its request, maintenance and outage stay open, and no timer starts).
function close(userScope, p) {
    const row = downtimeOf(userScope, p.productionDowntimeId, true)
    requireNotCorrected(row)
    if (row.statusId !== "PdtOpen") denied("DOWNTIME_CLOSED", "Downtime " + row.productionDowntimeId + " has ended")
    requireRevision(row, p.expectedRevision)
    const thruDate = p.thruDate || ec.user.nowTimestamp
    checkInterval(row.fromDate, thruDate)
    call("update#" + DOWNTIME, {
        productionDowntimeId: row.productionDowntimeId,
        statusId: "PdtClosed",
        thruDate,
        approvalRequired: approvalOf(row.approvalThreshold, row.fromDate, thruDate),
        closedByUserId: ec.user.userId,
        closedDate: ec.user.nowTimestamp,
        revision: Number(row.revision || 0) + 1
    })
    return answerOf(row.productionDowntimeId, "CLOSED", null)
}
// A supervisor's correction: a new row with the corrected interval, reason, equipment and note, which keeps the reporter,
// the report date, the work, the maintenance and the outage; the row it corrects keeps its own values and is marked
// Corrected. A correction to an equipment fault of an asset records or links its outage; one away from it leaves the
// outage to Maintenance (end#ResourceUnavailability).
function correct(userScope, p) {
    const row = downtimeOf(userScope, p.productionDowntimeId, true)
    requireNotCorrected(row)
    requireRevision(row, p.expectedRevision)
    const changeReason = text(p.changeReason)
    if (!changeReason) denied("REASON_REQUIRED", "A correction needs its reason")
    const fromDate = p.fromDate || row.fromDate
    const thruDate = p.thruDate || row.thruDate || null
    checkInterval(fromDate, thruDate)
    const reason = reasonOf(row.organizationPartyId, blank(p.reasonCode) ? row.reasonCode : p.reasonCode, fromDate)
    const assetId = blank(p.assetId) ? row.assetId || null : equipmentOf(userScope, p.assetId, row.organizationPartyId).assetId
    const created = call("create#" + DOWNTIME, {
        organizationPartyId: row.organizationPartyId,
        facilityId: row.facilityId,
        assetId,
        workEffortId: row.workEffortId || null,
        operationWorkEffortId: row.operationWorkEffortId || null,
        statusId: thruDate ? "PdtClosed" : "PdtOpen",
        reasonCode: reason.reasonCode,
        reasonCategoryEnumId: reason.reasonCategoryEnumId,
        equipmentFault: reason.equipmentFault === "Y" ? "Y" : "N",
        plannedStop: reason.plannedStop === "Y" ? "Y" : "N",
        approvalThreshold: thresholdOf(reason),
        approvalRequired: approvalOf(thresholdOf(reason), fromDate, thruDate),
        fromDate,
        thruDate,
        description: p.description == null ? row.description || null : text(p.description),
        revision: 1,
        reportedByUserId: row.reportedByUserId,
        reportedDate: row.reportedDate,
        closedByUserId: thruDate ? row.closedByUserId || ec.user.userId : null,
        closedDate: thruDate ? row.closedDate || ec.user.nowTimestamp : null,
        originalDowntimeId: row.originalDowntimeId || row.productionDowntimeId,
        correctionOfDowntimeId: row.productionDowntimeId,
        correctedByUserId: ec.user.userId,
        correctedDate: ec.user.nowTimestamp,
        changeReason,
        resourceUnavailabilityId: assetId === row.assetId ? row.resourceUnavailabilityId || null : null,
        assetMaintenanceId: row.assetMaintenanceId || null,
        requestId: row.requestId || null
    })
    call("update#" + DOWNTIME, {
        productionDowntimeId: row.productionDowntimeId,
        statusId: "PdtCorrected",
        supersededByDowntimeId: created.productionDowntimeId,
        revision: Number(row.revision || 0) + 1
    })
    const outage = outageOf(one(DOWNTIME, {productionDowntimeId: created.productionDowntimeId}))
    return answerOf(created.productionDowntimeId, "CORRECTED", outage, {correctedDowntimeId: row.productionDowntimeId})
}
// A supervisor's approval of an ended stop longer than its reason's threshold; nothing else changes.
function approve(userScope, p) {
    const row = downtimeOf(userScope, p.productionDowntimeId, true)
    requireNotCorrected(row)
    requireRevision(row, p.expectedRevision)
    if (row.statusId !== "PdtClosed") denied("DOWNTIME_OPEN", "Downtime " + row.productionDowntimeId + " has not ended")
    if (row.approvalRequired !== "Y")
        denied("APPROVAL_NOT_REQUIRED", "Downtime " + row.productionDowntimeId + " needs no approval")
    if (row.approvedByUserId) denied("DOWNTIME_APPROVED", "Downtime " + row.productionDowntimeId + " is already approved")
    call("update#" + DOWNTIME, {
        productionDowntimeId: row.productionDowntimeId,
        approvedByUserId: ec.user.userId,
        approvedDate: ec.user.nowTimestamp,
        revision: Number(row.revision || 0) + 1
    })
    return answerOf(row.productionDowntimeId, "APPROVED", null)
}
const storeActions = {open, close, correct, approve}
function store(userScope, p) {
    if (!Object.hasOwn(storeActions, p.action)) denied("ACTION_INVALID", "Unknown downtime action " + (p.action || ""))
    return storeActions[p.action](userScope, p)
}

// ===== find#ProductionDowntime =====
// The facility and the facilities right under it (a plant's lines).
function facilityAndChildren(facilityId) {
    return [facilityId].concat(
        Array.from(find(FACILITY, {parentFacilityId: facilityId}).selectField("facilityId").list()).map(row => row.facilityId)
    )
}
// The rows of a page with their display text, the names read once per page.
function displayRows(list, at) {
    const cache = new Map()
    const cached = (key, read) => {
        if (!cache.has(key)) cache.set(key, read())
        return cache.get(key)
    }
    const facilityOf = facilityId => cached("f" + facilityId, () => (facilityId ? one(FACILITY, {facilityId}) : null))
    const assetOf = assetId => cached("a" + assetId, () => (assetId ? one(ASSET, {assetId}) : null))
    const workOfId = workEffortId => cached("w" + workEffortId, () => (workEffortId ? one(WORK, {workEffortId}) : null))
    const userName = userId =>
        cached("u" + userId, () => {
            const account = userId ? one("moqui.security.UserAccount", {userId}) : null
            return account ? account.userFullName || account.username || userId : ""
        })
    const reasonName = row =>
        cached("r" + row.organizationPartyId + "/" + row.reasonCode, () => {
            const latest = Array.from(
                find(REASON, {organizationPartyId: row.organizationPartyId, reasonCode: row.reasonCode})
                    .orderBy("-fromDate")
                    .limit(1)
                    .list()
            )[0]
            return latest?.reasonName || row.reasonCode
        })
    const report = canReport()
    const supervise = access.has("PRODUCTION_SUPERVISE")
    return list.map(row => {
        const facility = facilityOf(row.facilityId)
        const asset = assetOf(row.assetId)
        const run = workOfId(row.workEffortId)
        const operation = workOfId(row.operationWorkEffortId)
        const maintenance = row.assetMaintenanceId ? one(MAINTENANCE, {assetMaintenanceId: row.assetMaintenanceId}) : null
        const request = row.requestId ? one(REQUEST, {requestId: row.requestId}) : null
        // the outage in force (Maintenance may have corrected it, impl-maintenance P5) and who restored it
        const outage = row.resourceUnavailabilityId ? outages().current(row.resourceUnavailabilityId) : null
        const endMs = row.thruDate ? ms(row.thruDate) : at
        const minutes = Math.max(0, Math.round((endMs - ms(row.fromDate)) / 60000))
        const durationText = Math.floor(minutes / 60)
            ? Math.floor(minutes / 60) + " h " + (minutes % 60) + " min"
            : minutes + " min"
        const current = row.statusId !== "PdtCorrected"
        return {
            productionDowntimeId: row.productionDowntimeId,
            organizationPartyId: row.organizationPartyId,
            facilityId: row.facilityId,
            facilityName: facilityName(facility),
            assetId: row.assetId || null,
            assetName: asset ? asset.assetName || asset.assetId : "",
            workEffortId: row.workEffortId || null,
            runName: run ? run.workEffortName || run.workEffortId : "",
            operationWorkEffortId: row.operationWorkEffortId || null,
            operationName: operation ? operation.workEffortName || operation.workEffortId : "",
            workText: [run ? run.workEffortName || run.workEffortId : "", operation ? operation.workEffortName || "" : ""]
                .filter(Boolean)
                .join(" · "),
            reasonCode: row.reasonCode,
            reasonName: reasonName(row),
            categoryText: enumText(row.reasonCategoryEnumId),
            equipmentFault: row.equipmentFault === "Y",
            plannedStop: row.plannedStop === "Y",
            fromDate: row.fromDate,
            fromText: dateText(row.fromDate),
            thruDate: row.thruDate || null,
            thruText: dateText(row.thruDate),
            durationMinutes: minutes,
            durationText: row.thruDate ? durationText : "Open " + durationText,
            open: row.statusId === "PdtOpen",
            statusId: row.statusId,
            statusText: statusText(row.statusId),
            statusColor: statusColors[row.statusId] || "grey-8",
            description: row.description || "",
            revision: Number(row.revision || 0),
            reportedByUserId: row.reportedByUserId || null,
            reportedByName: userName(row.reportedByUserId),
            reportedText: dateText(row.reportedDate),
            closedByName: userName(row.closedByUserId),
            correctionOfDowntimeId: row.correctionOfDowntimeId || null,
            supersededByDowntimeId: row.supersededByDowntimeId || null,
            correctedByName: userName(row.correctedByUserId),
            correctedText: dateText(row.correctedDate),
            changeReason: row.changeReason || "",
            resourceUnavailabilityId: row.resourceUnavailabilityId || null,
            outageOpen: !!outage && outage.thruDate == null,
            outageText: outage
                ? outage.thruDate == null
                    ? "Out of service"
                    : "Restored " +
                      dateText(outage.thruDate) +
                      (outage.endedByUserId ? " by " + userName(outage.endedByUserId) : "")
                : "",
            assetMaintenanceId: row.assetMaintenanceId || null,
            maintenanceText: maintenance
                ? enumText(maintenance.maintenanceTypeEnumId) + " · " + statusText(maintenance.statusId)
                : "",
            requestId: row.requestId || null,
            requestText: request ? (request.requestName || request.requestId) + " · " + statusText(request.statusId) : "",
            canClose: report && row.statusId === "PdtOpen",
            approvalRequired: row.approvalRequired === "Y",
            approvedByName: userName(row.approvedByUserId),
            approvalText:
                row.approvalRequired !== "Y"
                    ? ""
                    : row.approvedByUserId
                      ? "Approved by " + userName(row.approvedByUserId)
                      : "Needs approval",
            canApprove: supervise && row.statusId === "PdtClosed" && row.approvalRequired === "Y" && !row.approvedByUserId,
            canCorrect: supervise && current,
            canRequestMaintenance: report && current && !!row.assetId && !row.assetMaintenanceId,
            suggestMaintenance: report && current && row.equipmentFault === "Y" && !!row.assetId && !row.assetMaintenanceId
        }
    })
}
// A stop's correction chain, from the first report to the row in force.
function chainOf(userScope, productionDowntimeId) {
    let row = downtimeOf(userScope, productionDowntimeId)
    const chain = [row]
    for (let guard = 0; row.correctionOfDowntimeId && guard < 50; guard++) {
        row = one(DOWNTIME, {productionDowntimeId: row.correctionOfDowntimeId})
        if (!row) break
        chain.unshift(row)
    }
    row = chain[chain.length - 1]
    for (let guard = 0; row.supersededByDowntimeId && guard < 50; guard++) {
        row = one(DOWNTIME, {productionDowntimeId: row.supersededByDowntimeId})
        if (!row) break
        chain.push(row)
    }
    return chain
}
function findDowntime(p) {
    if (!readPermissions.some(access.has)) denied("PERMISSION_DENIED", readPermissions.join(" or ") + " is required")
    const posting = ec.resource.script("component://mr-mantle/service/mantle/shipment/StockPosting.js")
    const userScope = posting.scope()
    const factory = ec.entity.conditionFactory
    const at = nowMs()
    const build = () => {
        let query = find(DOWNTIME).orderBy("-fromDate").orderBy("-productionDowntimeId")
        if (userScope.organizationPartyIds) query = query.condition("organizationPartyId", "in", userScope.organizationPartyIds)
        if (!blank(p.productionDowntimeId)) query = query.condition("productionDowntimeId", p.productionDowntimeId)
        if (!blank(p.facilityId)) query = query.condition("facilityId", "in", facilityAndChildren(p.facilityId))
        for (const field of ["assetId", "workEffortId", "operationWorkEffortId", "reasonCode", "requestId", "assetMaintenanceId"])
            if (!blank(p[field])) query = query.condition(field, p[field])
        if (p.open === true || p.open === "true") query = query.condition("statusId", "PdtOpen")
        if (p.needsApproval === true || p.needsApproval === "true")
            query = query
                .condition("statusId", "PdtClosed")
                .condition("approvalRequired", "Y")
                .condition("approvedByUserId", "is-null", null)
        if (!(p.includeCorrected === true || p.includeCorrected === "true") && blank(p.productionDowntimeId))
            query = query.condition("statusId", "not-equals", "PdtCorrected")
        if (p.thruDate) query = query.condition("fromDate", "less", p.thruDate)
        if (p.fromDate)
            query = query.condition(
                factory.makeCondition(
                    [
                        factory.makeCondition("thruDate", "is-null", null),
                        factory.makeCondition("thruDate", "greater", p.fromDate)
                    ],
                    "or"
                )
            )
        return query
    }
    const paged = lib.page(build(), p, "downtimeList", build().count())
    const result = Object.assign({}, paged, {rows: undefined, downtimeList: displayRows(paged.rows, at)})
    // a stop's history: every row of its correction chain, a row the user may not see refused
    result.history = blank(p.productionDowntimeId) ? [] : displayRows(chainOf(userScope, p.productionDowntimeId), at)
    result.canReport = canReport()
    result.canCorrect = access.has("PRODUCTION_SUPERVISE")
    return result
}

// ===== request#ProductionMaintenance =====
// Corrective maintenance of the equipment of a stop (or of equipment given alone, EquipmentDetail's action): the
// AssetMaintenance through EquipmentServices.create#AssetMaintenance (AsMntCreated, MntTpCorrective, D24) and, with
// createRequest, a submitted Request of type RqtMaintenance at the stop's work center (else the equipment's facility), for
// the organization, linked through RequestServices.link#RequestRecord to the stop, the equipment, the maintenance and the
// stopped operation or run. The stop keeps its maintenance and request.
function requestMaintenance(userScope, p) {
    const downtime = blank(p.productionDowntimeId) ? null : downtimeOf(userScope, p.productionDowntimeId, true)
    if (downtime) {
        requireNotCorrected(downtime)
        if (downtime.assetMaintenanceId)
            denied(
                "MAINTENANCE_REQUESTED",
                "Maintenance " +
                    downtime.assetMaintenanceId +
                    " was already requested for downtime " +
                    downtime.productionDowntimeId
            )
        if (!blank(p.assetId) && p.assetId !== downtime.assetId)
            denied(
                "ASSET_INVALID",
                "Equipment " + p.assetId + " is not the equipment of downtime " + downtime.productionDowntimeId
            )
    }
    const assetId = downtime ? downtime.assetId : text(p.assetId)
    if (!assetId) denied("ASSET_REQUIRED", "Maintenance is for equipment; the stop names none")
    const asset = equipmentOf(userScope, assetId, downtime?.organizationPartyId || null)
    const problem = text(p.problem)
    if (!problem) denied("PROBLEM_REQUIRED", "Describe the problem")
    const home = one(FACILITY, {facilityId: asset.facilityId})
    const organizationPartyId = downtime?.organizationPartyId || home.ownerPartyId
    const maintenance = call("mantle.product.EquipmentServices.create#AssetMaintenance", {
        assetId,
        statusId: "AsMntCreated",
        maintenanceTypeEnumId: "MntTpCorrective",
        maintenanceDate: ec.user.nowTimestamp,
        comments: problem
    })
    let requestId = null
    if (p.createRequest === true || p.createRequest === "true" || p.createRequest === "Y") {
        const assetName = asset.assetName || asset.assetId
        requestId = call("mantle.request.RequestServices.create#Request", {
            requestTypeEnumId: "RqtMaintenance",
            statusId: "ReqSubmitted",
            requestName: "Maintenance of " + assetName,
            description: problem,
            priority: blank(p.priority) ? null : Number(p.priority),
            facilityId: downtime?.facilityId || asset.facilityId
        }).requestId
        call("create#mantle.request.RequestParty", {
            requestId,
            partyId: organizationPartyId,
            roleTypeId: "OrgInternal",
            fromDate: ec.user.nowTimestamp
        })
        const links = [
            [ASSET, assetId],
            [MAINTENANCE, maintenance.assetMaintenanceId]
        ]
        if (downtime) links.unshift([DOWNTIME, downtime.productionDowntimeId])
        const workId = downtime?.operationWorkEffortId || downtime?.workEffortId
        if (workId) links.push([WORK, workId])
        for (const [recordEntityName, recordId] of links)
            call("mantle.request.RequestServices.link#RequestRecord", {requestId, recordEntityName, recordId})
    }
    if (downtime)
        call("update#" + DOWNTIME, {
            productionDowntimeId: downtime.productionDowntimeId,
            assetMaintenanceId: maintenance.assetMaintenanceId,
            requestId
        })
    return {
        resultCode: "MAINTENANCE_REQUESTED",
        productionDowntimeId: downtime?.productionDowntimeId || null,
        assetId,
        organizationPartyId,
        assetMaintenanceId: maintenance.assetMaintenanceId,
        requestId
    }
}

;({
    store,
    requestMaintenance,
    execute: (op, parameters) => {
        const operations = {find: findDowntime}
        if (!operations[op]) throw new Error("Unknown production downtime operation " + op)
        return operations[op](parameters)
    }
})
