// Customer repairs as maintenance work (IronStone Maintenance design §3 WorkOrderDetail's customer repair context and the consent
// recheck, §12 the customer service and intervention report; crosscut §4.6 "Customer repair"; MT-10; impl-maintenance P12):
// mantle.work.MaintenanceServices get# and store#InterventionReport, and the repair's parts of MaintenanceWork.js and
// MaintenanceMaterials.js.
//
// - A customer repair is the work order a warranty repair became (MaintenanceWork.js adoptRepair, source MsrcWarranty): its claim,
//   decision and consent are Customer Service's, read through mantle.request.WarrantyServices (Warranty.js), never decided here.
// - Start and a parts issue recheck the claim (check#WarrantyRepair): a missing or changed consent, a superseded decision, a
//   rejection or a closed case is a blocker, which no maintenance approval lifts.
// - The customer's asset is read through the repair (the work order's organization and the claim), never by changing its owner
//   or by Maintenance's equipment scope, which does not cover a customer's asset away from the organization's facilities.
// - The intervention report (html-print and PDF): the customer-safe work done (the work, its technicians, start and finish,
//   outcome and the equipment's state after it), parts and labor only where the reader may read costs
//   (MaintenanceReportServices.get#MaintenanceCosts admits them), and the customer's acknowledgment. Stored on the work order as
//   its WectInterventionReport content by the planner, supervisor or assigned technician of completed or closed work; Customer
//   Service's RepairLinks sends the stored one (send#InterventionReport). Printing and storing post nothing.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const maintenanceAccess = ec.resource.script("component://mr-mantle/service/mantle/work/MaintenanceAccess.js")
const workProcesses = ec.resource.script("component://mr-mantle/service/mantle/work/WorkProcesses.js")
const warranty = () => ec.resource.script("component://mr-mantle/service/mantle/request/Warranty.js")
const {find, one, rows, denied, call, ms} = lib

const WORK = "mantle.work.effort.WorkEffort"
const ORDER = "mantle.work.maintenance.MaintenanceWorkOrder"
const PARTY = "mantle.work.effort.WorkEffortParty"
const CONTENT = "mantle.work.effort.WorkEffortContent"
const ASSET = "mantle.product.asset.Asset"
const FACILITY = "mantle.facility.Facility"
const TEMPLATE = "component://mr-mantle/template/work/InterventionReport.print.html.fancy"
const REPORT = "WectInterventionReport"
const ACKNOWLEDGMENT = "WectAcknowledgment"
const doneStatuses = ["WeComplete", "WeClosed"]

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const dateText = value => (value == null || value === "" ? "" : lib.dateText(value))
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "")
const isRepair = order => order?.sourceEnumId === "MsrcWarranty" && !!order.assetMaintenanceId

// ===== the claim's standing (Start, the parts issue) =====
// Why the claim stops a customer repair now ({reason, message}), or null: Customer Service's check#WarrantyRepair.
function standingOf(order) {
    if (!isRepair(order)) return null
    const out = call("mantle.request.WarrantyServices.check#WarrantyRepair", {assetMaintenanceId: order.assetMaintenanceId})
    return out.allowed
        ? null
        : {reason: out.reasonCode || "CONSENT_REQUIRED", message: out.message || "The claim stops the repair"}
}
function requireStanding(order) {
    const blocked = standingOf(order)
    if (blocked) denied(blocked.reason, blocked.message)
}

// ===== the summary (WorkOrderDetail) =====
// The customer repair of a work order the caller reads (MaintenanceWork.js getWorkOrder has checked it): the claim's safe summary
// with whether the caller's Maintenance scope covers the customer's asset (its EquipmentDetail), and the stored report; null for
// other work.
function summaryOf(userScope, order) {
    if (!isRepair(order)) return null
    const summary = warranty().repairSummary(order.assetMaintenanceId)
    if (!summary) return null
    const report = latest(order.workEffortId, REPORT)
    const acknowledgment = latest(order.workEffortId, ACKNOWLEDGMENT)
    return Object.assign(summary, {
        assetInScope: maintenanceAccess.covers(userScope, maintenanceAccess.assetOrganization(order.assetId)),
        reportStored: !!report,
        reportText: report ? "Stored " + dateText(report.contentDate) : "",
        acknowledgmentText: acknowledgment ? acknowledgment.description || fileName(acknowledgment.contentLocation) : ""
    })
}
const fileName = location => (location ? String(location).split("/").pop() : "")
function latest(workEffortId, contentTypeEnumId) {
    return (
        rows(CONTENT, {workEffortId, contentTypeEnumId})
            .filter(row => row.contentLocation && row.thruDate == null)
            .sort((a, b) => ms(b.contentDate) - ms(a.contentDate))[0] || null
    )
}

// ===== the work order =====
function signedIn() {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in to use maintenance work")
}
// A customer repair the caller reads: {root, order, organizationPartyId, userScope}.
function readRepair(workEffortId) {
    signedIn()
    const userScope = maintenanceAccess.scope()
    const found = maintenanceAccess.requireWork(userScope, text(workEffortId))
    const order = one(ORDER, {workEffortId: found.rootWorkEffortId})
    const root = one(WORK, {workEffortId: found.rootWorkEffortId})
    if (!order || !root || root.isTemplate === "Y")
        denied("RECORD_UNAVAILABLE", "Work order " + (workEffortId || "") + " is not available")
    if (!isRepair(order)) denied("NOT_CUSTOMER_REPAIR", "Work order " + root.workEffortId + " is no customer repair")
    return {root, order, organizationPartyId: found.organizationPartyId, userScope}
}

// ===== the intervention report =====
// The report's values as of now: the work done for the customer, and parts and labor where the reader may read costs.
function reportValues(ctx) {
    const {root, order, organizationPartyId, userScope} = ctx
    const summary = warranty().repairSummary(order.assetMaintenanceId) || {}
    const asset = order.assetId ? one(ASSET, {assetId: order.assetId}) : null
    const facility = root.facilityId ? one(FACILITY, {facilityId: root.facilityId}) : null
    const technicianIds = Array.from(
        find(PARTY, {workEffortId: root.workEffortId, roleTypeId: "Assignee"})
            .condition(ec.entity.conditionFactory.makeCondition("statusId", "not-in", ["WeptDeclined", "WeptUnassigned"], true))
            .list()
    ).map(row => row.partyId)
    const names = lib.partyNames(technicianIds.concat([organizationPartyId]))
    let partList = [],
        laborList = [],
        totalList = [],
        costsShown = false
    if (userScope.capabilities.costView) {
        // the cost reader's own answer for this work order (its permission and scope checked there again)
        ec.message.pushErrors()
        try {
            const costs = call("mantle.work.MaintenanceReportServices.get#MaintenanceCosts", {
                workEffortId: root.workEffortId
            }).costs
            const sources = Array.from(costs?.sourceList || [])
            const line = row => ({
                description: row.description || "",
                quantityText: row.quantityText || "",
                amountText: row.amountText || ""
            })
            partList = sources.filter(row => row.component === "parts").map(line)
            laborList = sources.filter(row => row.component === "labor").map(line)
            totalList = Array.from(costs?.totalList || []).map(row => ({
                partsText: row.partsText,
                laborText: row.laborText,
                totalText: row.totalText
            }))
            costsShown = true
        } catch (error) {
            ec.logger.warn("Work order " + root.workEffortId + ": the report's parts and labor were left out: " + error.message)
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    const acknowledgment = latest(root.workEffortId, ACKNOWLEDGMENT)
    return {
        workEffortId: root.workEffortId,
        workEffortName: root.workEffortName || root.workEffortId,
        description: root.description || "",
        organizationName: names[organizationPartyId] || organizationPartyId || "",
        customerName: summary.customerName || "",
        requestId: summary.requestId || "",
        requestName: summary.requestName || "",
        decisionText: summary.decisionText || "",
        equipmentText: [asset?.assetName, summary.productText, summary.assetText].filter(Boolean).join(" · "),
        placeText: facility ? facility.facilityName || facility.facilityId : "",
        technicianText: technicianIds.map(id => names[id] || id).join(", "),
        statusText: statusText(root.statusId),
        startedText: dateText(root.actualStartDate),
        finishedText: dateText(root.actualCompletionDate),
        outcomeText: enumText(order.outcomeEnumId),
        dispositionText: enumText(order.dispositionEnumId),
        costsShown,
        partList,
        laborList,
        totalList,
        acknowledgmentText: acknowledgment ? acknowledgment.description || fileName(acknowledgment.contentLocation) : "",
        acknowledgmentDateText: acknowledgment ? dateText(acknowledgment.contentDate) : "",
        asOfText: dateText(ec.user.nowTimestamp),
        printedBy: ec.user.userAccount?.userFullName || ec.user.username || ""
    }
}
const reportFileName = workEffortId => "InterventionReport-" + workEffortId + ".pdf"
// get#InterventionReport: the report as of now for the reader (html for html-print and its PDF), and the stored one.
function getReport(p) {
    const ctx = readRepair(p.workEffortId)
    const values = reportValues(ctx)
    const printHtml = ec.resource.template(TEMPLATE, values)
    const stored = latest(ctx.root.workEffortId, REPORT)
    return {
        printHtml,
        pdfBytes:
            p.pdf === true || p.pdf === "true" ? ec.resource.xslFoTransform(printHtml, null, null, "application/pdf") : null,
        fileName: reportFileName(ctx.root.workEffortId),
        costsShown: values.costsShown,
        stored: stored
            ? {
                  workEffortContentId: stored.workEffortContentId,
                  contentLocation: String(stored.contentLocation),
                  storedText: dateText(stored.contentDate),
                  description: stored.description || ""
              }
            : null
    }
}
// store#InterventionReport: the report as of now stored on the work order (a new WectInterventionReport each time, the earlier kept),
// with the customer's acknowledgment file first when one is given; for the planner, supervisor or assigned technician of completed
// or closed work. A retry under its operation key answers the first result.
function storeReport(p) {
    const ctx = readRepair(p.workEffortId)
    const {root, userScope} = ctx
    const caps = userScope.capabilities
    const assigned = maintenanceAccess.assignment(userScope, root.workEffortId).root
    if (!(caps.plan || caps.supervise || (caps.execute && assigned)))
        denied("PERMISSION_DENIED", "The work's planner, supervisor or assigned technician stores its intervention report")
    const operation = !blank(p.operationKey)
        ? lib.operation(p, "InterventionReportStore", ctx.organizationPartyId, {workEffortId: root.workEffortId})
        : null
    if (operation?.old) return lib.previous(operation)
    if (!doneStatuses.includes(root.statusId))
        denied("WORK_NOT_DONE", "Work order " + root.workEffortId + " is " + statusText(root.statusId) + "; complete it first")
    return workProcesses.asManagedOwner([root.workEffortId], () => {
        const file = [].concat(p.acknowledgmentFile || []).find(item => item && (item.size == null || Number(item.size) > 0))
        const acknowledgmentId = file
            ? call("mantle.work.WorkEffortServices.create#WorkEffortContent", {
                  workEffortId: root.workEffortId,
                  contentTypeEnumId: ACKNOWLEDGMENT,
                  description: text(p.acknowledgmentText) || "Customer acknowledgment",
                  contentDate: ec.user.nowTimestamp,
                  contentFile: file
              }).workEffortContentId
            : null
        // the PDF; on a server with no PDF engine the html-print document itself, so the report is stored either way
        const printHtml = ec.resource.template(TEMPLATE, reportValues(ctx))
        let pdf = null
        try {
            pdf = ec.resource.xslFoTransform(printHtml, null, null, "application/pdf")
        } catch (error) {
            ec.logger.warn(
                "Work order " + root.workEffortId + ": the intervention report is stored as html, with no PDF: " + error.message
            )
        }
        const sequence = rows(CONTENT, {workEffortId: root.workEffortId, contentTypeEnumId: REPORT}).length + 1
        const name = pdf ? reportFileName(root.workEffortId) : reportFileName(root.workEffortId).replace(/\.pdf$/, ".html")
        const location = "dbresource://mantle/content/workEffort/" + root.workEffortId + "/intervention_" + sequence + "/" + name
        const reference = ec.resource.getLocationReference(location)
        if (pdf) reference.putBytes(pdf)
        else reference.putText(printHtml)
        const workEffortContentId = call("create#" + CONTENT, {
            workEffortId: root.workEffortId,
            contentTypeEnumId: REPORT,
            contentLocation: location,
            contentChecksum: ec.resource.digest(location, "sha256"),
            description: "Intervention report of work order " + root.workEffortId,
            contentDate: ec.user.nowTimestamp,
            userId: ec.user.userId
        }).workEffortContentId
        const result = {workEffortContentId, acknowledgmentContentId: acknowledgmentId}
        if (operation) lib.complete(operation, CONTENT, workEffortContentId, result)
        return result
    })
}

const operations = {getReport, storeReport}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown maintenance repair operation " + op)
        return operations[op](parameters || {})
    },
    // for MaintenanceWork.js (Start, the work order's read) and MaintenanceMaterials.js (the issue), never a service's parameters
    standingOf,
    requireStanding,
    summaryOf
})
