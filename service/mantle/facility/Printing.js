// Facility printing (impl-warehouse P13; design-warehouse §12 Printers, §16 outputs, §17 WH-LABEL; F15, F16):
// mantle.facility.PrintServices dispatch#Document, get#PrinterCapabilities and store#FacilityPrinter, over the framework's
// org.moqui.impl.PrintServices (print#Document, print#ScreenDocument, send#PrintJob) and the NetworkPrinter record.
// A document goes to the printer the facility binds for its purpose (FacilityPrinter, in effect by its dates, with its
// copies). Printing is never part of a posting: dispatch#Document runs each print in a transaction of its own and answers
// what happened (printed, or the reason: PRINTER_NOT_BOUND, PRINTING_UNAVAILABLE when this build has no print client, a
// printer that refused), with the print job kept so a reprint sends the same document again (printJobId); a print failure
// never undoes what was posted before it. Labels are PDF only (ZPL is later, impl-warehouse §4).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const {find, one, rows, denied, call, probe, access} = lib

const BINDING = "mantle.facility.FacilityPrinter",
    PRINTER = "moqui.basic.print.NetworkPrinter",
    JOB = "moqui.basic.print.PrintJob",
    ROUTE_SEG = "mantle.shipment.ShipmentPackageRouteSeg"
// the permissions of the work that prints in a warehouse
const printPermissions = [
    "SHIPMENT_SHIP",
    "SHIPMENT_PACK",
    "SHIPMENT_PICK",
    "STOCK_RECEIVE",
    "STOCK_MOVE",
    "STOCK_COUNT",
    "STOCK_ADJUST",
    "QUALITY_INSPECT",
    "FACILITY_EDIT"
]
const unavailableText = "not installed"
const blank = value => value == null || String(value).trim() === ""
const number = value => (value == null || value === "" ? 0 : Number(String(value)))
const inEffect = (row, now = lib.ms(ec.user.nowTimestamp)) =>
    (row.fromDate == null || lib.ms(row.fromDate) <= now) && (row.thruDate == null || lib.ms(row.thruDate) > now)

function facilityOf(userScope, facilityId) {
    const facility = blank(facilityId) ? null : one("mantle.facility.Facility", {facilityId})
    if (!facility || !facilityScope.owns(userScope, facility.ownerPartyId))
        denied("RECORD_UNAVAILABLE", "Facility " + (facilityId || "") + " is not available")
    return facility
}
function requireAny(permissions) {
    if (!permissions.some(access.has)) denied("PERMISSION_DENIED", permissions.join(" or ") + " is required")
}
// The binding in effect for the facility's purpose, or null.
function bindingOf(facilityId, printerPurposeEnumId) {
    const row = blank(printerPurposeEnumId) ? null : one(BINDING, {facilityId, printerPurposeEnumId})
    return row && row.networkPrinterId && inEffect(row) ? row : null
}

// ===== capabilities =====
// What each printer can take: PDF documents (labels are PDF only), no ZPL yet; and what its last job says about it (a
// build with no print client answers every job "not installed").
function capabilitiesOf(printer) {
    const last = Array.from(find(JOB, {networkPrinterId: printer.networkPrinterId}).orderBy("-createdDate").limit(1).list())[0]
    const unavailable = last?.statusId === "PtjSendFailed" && String(last.errorMessage || "").includes(unavailableText)
    return {
        networkPrinterId: printer.networkPrinterId,
        description: printer.description || printer.printerName || printer.networkPrinterId,
        location: printer.location || null,
        serverHost: printer.serverHost || null,
        printerName: printer.printerName || null,
        pdf: true,
        zpl: false,
        formats: ["PDF"],
        lastJobStatusId: last?.statusId || null,
        lastJobDate: last?.createdDate || null,
        lastJobError: last?.errorMessage || null,
        availability: unavailable ? "unavailable" : last?.statusId === "PtjSendFailed" ? "failing" : last ? "used" : "unknown"
    }
}
function capabilities(p) {
    requireAny(printPermissions)
    const userScope = facilityScope.scope()
    let printerIds
    if (!blank(p.networkPrinterId)) printerIds = [p.networkPrinterId]
    else if (!blank(p.facilityId)) {
        facilityOf(userScope, p.facilityId)
        printerIds = rows(BINDING, {facilityId: p.facilityId}).map(row => row.networkPrinterId)
    } else printerIds = rows(PRINTER, {}).map(row => row.networkPrinterId)
    const printers = Array.from(
        find(PRINTER)
            .condition("networkPrinterId", "in", [...new Set(printerIds.filter(Boolean))])
            .list()
    )
    return {printers: printers.map(capabilitiesOf)}
}

// ===== the bindings =====
function storeBinding(p) {
    if (!access.has("FACILITY_EDIT")) denied("PERMISSION_DENIED", "FACILITY_EDIT is required")
    const facility = facilityOf(facilityScope.scope(), p.facilityId)
    const purpose = one("moqui.basic.Enumeration", {enumId: p.printerPurposeEnumId})
    if (!purpose || purpose.enumTypeId !== "PrinterPurpose") denied("PURPOSE_INVALID", "Choose a printer purpose")
    const existing = one(BINDING, {facilityId: facility.facilityId, printerPurposeEnumId: purpose.enumId})
    if (p.endNow === true || p.endNow === "Y" || p.endNow === "true") {
        if (!existing) denied("RECORD_UNAVAILABLE", "There is no " + purpose.description + " printer here")
        call("update#" + BINDING, {
            facilityId: facility.facilityId,
            printerPurposeEnumId: purpose.enumId,
            thruDate: ec.user.nowTimestamp
        })
        return {facilityId: facility.facilityId, printerPurposeEnumId: purpose.enumId, ended: true}
    }
    if (blank(p.networkPrinterId) || !one(PRINTER, {networkPrinterId: p.networkPrinterId}))
        denied("PRINTER_INVALID", "Choose a network printer")
    const copies = blank(p.copies) ? 1 : number(p.copies)
    if (!Number.isInteger(copies) || copies < 1 || copies > 20) denied("COPIES_INVALID", "Copies are 1 to 20")
    if (p.fromDate && p.thruDate && lib.ms(p.thruDate) <= lib.ms(p.fromDate))
        denied("DATES_INVALID", "The binding must end after it starts")
    const values = {
        facilityId: facility.facilityId,
        printerPurposeEnumId: purpose.enumId,
        networkPrinterId: p.networkPrinterId,
        copies,
        fromDate: p.fromDate || ec.user.nowTimestamp,
        thruDate: p.thruDate || null
    }
    call((existing ? "update#" : "create#") + BINDING, values)
    return {facilityId: facility.facilityId, printerPurposeEnumId: purpose.enumId, ended: false}
}

// ===== dispatch =====
// The PrintJob a failed print left (print#Document creates it in its own transaction before sending), by its job name.
const jobOf = (networkPrinterId, jobName) =>
    Array.from(find(JOB, {networkPrinterId, jobName}).orderBy("-createdDate").limit(1).list())[0] || null
function failure(reasonCode, message, extra = {}) {
    return Object.assign({printed: false, reasonCode, message, printJobIds: [], reprintable: false}, extra)
}
function reasonOfPrint(message) {
    return String(message).includes(unavailableText) ? "PRINTING_UNAVAILABLE" : "PRINT_FAILED"
}
function dispatch(p) {
    const userScope = facilityScope.scope()
    const labels = ["shipmentLabel", "returnLabel"].includes(p.documentType)
    requireAny(labels ? ["SHIPMENT_SHIP", "SHIPMENT_PACK"] : printPermissions)
    const facility = facilityOf(userScope, p.facilityId)
    // a reprint: the same document sent again, from the job a print left
    if (!blank(p.printJobId)) {
        const job = one(JOB, {printJobId: p.printJobId})
        const bound = job
            ? rows(BINDING, {facilityId: facility.facilityId}).some(row => row.networkPrinterId === job.networkPrinterId)
            : false
        if (!job || !bound) denied("RECORD_UNAVAILABLE", "Print job " + p.printJobId + " is not of this facility's printers")
        if (job.document == null) return failure("DOCUMENT_UNAVAILABLE", "The job kept no document to send again")
        try {
            probe("org.moqui.impl.PrintServices.send#PrintJob", {printJobId: job.printJobId})
            return {
                printed: true,
                reasonCode: null,
                message: null,
                printJobIds: [job.printJobId],
                networkPrinterId: job.networkPrinterId,
                reprintable: true
            }
        } catch (error) {
            const message = String(error?.message || error).replace(/^(Error: )+/, "")
            return failure(reasonOfPrint(message), message, {
                printJobIds: [job.printJobId],
                networkPrinterId: job.networkPrinterId,
                reprintable: true
            })
        }
    }
    let networkPrinterId = null,
        copies = 1
    if (!blank(p.networkPrinterId)) {
        const bindings = rows(BINDING, {facilityId: facility.facilityId}).filter(
            row => row.networkPrinterId === p.networkPrinterId && inEffect(row)
        )
        if (!bindings.length)
            denied("PRINTER_UNAVAILABLE", "Printer " + p.networkPrinterId + " is not bound at " + facility.facilityId)
        networkPrinterId = p.networkPrinterId
        copies = number(bindings[0].copies) || 1
    } else {
        const binding = bindingOf(facility.facilityId, p.printerPurposeEnumId)
        if (!binding)
            return failure(
                "PRINTER_NOT_BOUND",
                "Facility " + facility.facilityId + " has no printer for " + (p.printerPurposeEnumId || "this document")
            )
        networkPrinterId = binding.networkPrinterId
        copies = number(binding.copies) || 1
    }
    if (!blank(p.copies)) copies = Math.max(1, Math.min(20, number(p.copies)))
    const token = ec.user.nowTimestamp ? String(lib.ms(ec.user.nowTimestamp)) : ""
    const documents = []
    if (labels) {
        // each package's label: the PDF the gateway gave (labelImage), for the shipment's facility only
        const shipment = one("mantle.shipment.Shipment", {shipmentId: p.shipmentId})
        const segments = shipment ? rows("mantle.shipment.ShipmentRouteSegment", {shipmentId: p.shipmentId}) : []
        if (
            !shipment ||
            !segments.some(
                row => row.originFacilityId === facility.facilityId || row.destinationFacilityId === facility.facilityId
            )
        )
            denied("RECORD_UNAVAILABLE", "Shipment " + (p.shipmentId || "") + " is not of facility " + facility.facilityId)
        const r = p.documentType === "returnLabel"
        const routeSegs = rows(ROUTE_SEG, {shipmentId: p.shipmentId}).filter(
            row => blank(p.shipmentPackageSeqId) || row.shipmentPackageSeqId === p.shipmentPackageSeqId
        )
        for (const routeSeg of routeSegs) {
            const image = r ? routeSeg.returnLabelImage : routeSeg.labelImage
            if (image == null) continue
            documents.push({
                jobName: (r ? "ReturnLabel" : "ShipmentLabel") + p.shipmentId + "-" + routeSeg.shipmentPackageSeqId + "-" + token,
                bytes: image
            })
        }
        if (!documents.length) return failure("NO_LABEL", "There is no label to print", {networkPrinterId})
    } else if (p.documentType === "screen") {
        if (blank(p.screenLocation) || !String(p.screenLocation).startsWith("component://"))
            denied("DOCUMENT_INVALID", "Name the screen to print")
        documents.push({jobName: (p.jobName || "Document") + "-" + token, screen: true})
    } else denied("DOCUMENT_INVALID", "Unknown document type " + p.documentType)

    const printJobIds = []
    for (const document of documents) {
        try {
            const out = document.screen
                ? probe("org.moqui.impl.PrintServices.print#ScreenDocument", {
                      networkPrinterId,
                      jobName: document.jobName,
                      copies,
                      screenLocation: p.screenLocation,
                      screenParameters: p.screenParameters || {}
                  })
                : probe("org.moqui.impl.PrintServices.print#Document", {
                      networkPrinterId,
                      jobName: document.jobName,
                      copies,
                      contentType: "application/pdf",
                      serialBlob: document.bytes
                  })
            if (out.printJobId) printJobIds.push(out.printJobId)
        } catch (error) {
            const message = String(error?.message || error).replace(/^(Error: )+/, "")
            ec.logger.warn("Print " + document.jobName + " on " + networkPrinterId + " failed: " + message)
            const job = jobOf(networkPrinterId, document.jobName)
            if (job) printJobIds.push(job.printJobId)
            return failure(reasonOfPrint(message), message, {printJobIds, networkPrinterId, reprintable: printJobIds.length > 0})
        }
    }
    if (labels)
        for (const routeSeg of rows(ROUTE_SEG, {shipmentId: p.shipmentId}))
            if (blank(p.shipmentPackageSeqId) || routeSeg.shipmentPackageSeqId === p.shipmentPackageSeqId)
                probe("update#" + ROUTE_SEG, {
                    shipmentId: routeSeg.shipmentId,
                    shipmentPackageSeqId: routeSeg.shipmentPackageSeqId,
                    shipmentRouteSegmentSeqId: routeSeg.shipmentRouteSegmentSeqId,
                    labelPrinted: "Y"
                })
    return {printed: true, reasonCode: null, message: null, printJobIds, networkPrinterId, copies, reprintable: true}
}

const operations = {dispatch, capabilities, storeBinding}
;({
    bindingOf,
    inEffect,
    execute(op, parameters) {
        if (!operations[op]) throw new Error("Unknown printing operation " + op)
        return operations[op](parameters)
    }
})
