// An invoice's supporting files sent with it: the choices a sender reviews by an opaque content version, the frozen copies
// sent (immutable InvoiceContent rows, as the issued PDF is), and the guard that keeps issued files as they were sent.
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const {find, one, call, denied} = lib
const C = "mantle.account.invoice.InvoiceContent"
const maxAttachmentCount = 10,
    maxAttachmentBytes = 10485760,
    maxTotalAttachmentBytes = 20971520
const issuedFolder = "dbresource://mantle/content/invoice-issued/"
// Match DbResource's db_parts: both prefixes and empty slash-separated segments name the same resource.
function canonicalDbLocation(value) {
    const location = String(value || "")
    if (!location.startsWith("dbresource:")) return location
    const rest = location.startsWith("dbresource://")
        ? location.slice("dbresource://".length)
        : location.slice("dbresource:".length)
    return "dbresource://" + rest.split("/").filter(Boolean).join("/")
}
function isIssued(row) {
    return !!row && (row.isImmutable === "Y" || canonicalDbLocation(row.contentLocation).startsWith(issuedFolder))
}
function selection(p) {
    if (p.attachmentContentIdList != null && typeof p.attachmentContentIdList === "string")
        denied("ATTACHMENT_SELECTION_INVALID", "Choose invoice attachment identifiers")
    const ids = [...new Set(Array.from(p.attachmentContentIdList || []).map(String))].sort()
    if (ids.length > maxAttachmentCount) denied("ATTACHMENT_COUNT_LIMIT", "Select at most ten supporting attachments")
    if (ids.some(id => !/^[A-Za-z0-9_-]{1,40}$/.test(id))) denied("ATTACHMENT_UNAVAILABLE", "An attachment is not available")
    const versions = Object.fromEntries(ids.map(id => [id, String(p.attachmentVersions?.[id] || "")]))
    if (ids.some(id => !versions[id])) denied("STALE_ATTACHMENT", "Review each selected attachment before sending")
    return {ids, versions}
}
// A supporting file is one saved in the invoice's own content folder, under the content roots, never an issued file.
function source(row) {
    const location = canonicalDbLocation(row.contentLocation)
    const roots = [
        ...new Set(
            [
                "dbresource://mantle/content",
                ec.factory.getConfValue("mantle@content-root"),
                ec.factory.getConfValue("mantle@content-large-root")
            ]
                .filter(root => root && String(root).startsWith("dbresource:"))
                .map(root => canonicalDbLocation(root).replace(/\/+$/, ""))
        )
    ]
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(row.invoiceId) || !/^[A-Za-z0-9_-]{1,40}$/.test(row.invoiceContentId))
        denied("ATTACHMENT_LOCATION_INVALID", "The attachment is not a supported local invoice file")
    if (isIssued(row)) denied("ATTACHMENT_ARCHIVED_INVOICE", "An issued invoice file cannot be a supporting attachment")
    const prefix = roots.find(root =>
        location.startsWith(root + "/invoice/" + row.invoiceId + "/content_" + row.invoiceContentId + "/")
    )
    const relative = prefix ? location.slice(prefix.length + 1) : ""
    if (
        !prefix ||
        /[\\?#\x00-\x1f]|%2e|%2f|%5c/i.test(location) ||
        location
            .slice("dbresource://".length)
            .split("/")
            .some(part => !part || part === "." || part === "..") ||
        relative.split("/").length !== 4
    )
        denied("ATTACHMENT_LOCATION_INVALID", "The attachment is not a supported local invoice file")
    const ref = ec.resource.getLocationReference(location)
    if (!ref.getExists() || !ref.isFile()) denied("ATTACHMENT_UNAVAILABLE", "The selected attachment file is missing")
    const size = Number(ref.getSize())
    if (!Number.isSafeInteger(size) || size < 0 || size > maxAttachmentBytes)
        denied("ATTACHMENT_SIZE_LIMIT", "Each supporting attachment must be at most 10 MiB")
    const fileName = String(ref.getFileName())
        .replace(/[\\/:?*"<>\x00-\x1f\x7f]/g, "_")
        .slice(0, 180)
    return {ref, fileName, contentType: ref.getContentType() || "application/octet-stream", contentSize: size}
}
function read(row, metadata, byteBudget) {
    const stream = metadata.ref.getInputStream()
    if (!stream) denied("ATTACHMENT_UNAVAILABLE", "The selected attachment file is missing")
    try {
        const size = Number(stream.size)
        if (!Number.isSafeInteger(size) || size < 0 || size > maxAttachmentBytes || size > byteBudget)
            denied("ATTACHMENT_TOTAL_SIZE_LIMIT", "Supporting attachments must total at most 20 MiB")
        const bytes = stream.readAllBytes()
        if (bytes.length !== size || size !== metadata.contentSize)
            denied("STALE_ATTACHMENT", "An attachment changed; review it before sending")
        const contentHash = lib.hash(StringUtilities.base64Encode(bytes))
        const attachmentVersion = lib.hash({
            invoiceContentId: row.invoiceContentId,
            lastUpdatedStamp: String(row.lastUpdatedStamp),
            location: row.contentLocation,
            fileName: metadata.fileName,
            contentType: metadata.contentType,
            size,
            contentHash
        })
        return {bytes, contentHash, attachmentVersion}
    } finally {
        stream.close()
    }
}
// Each file a sender may attach, with its version; the others annotated with the reason they cannot be.
function project(invoiceId, records) {
    const attachmentRows = [],
        annotations = {}
    let remaining = maxTotalAttachmentBytes,
        incomplete = records.length > 100
    for (const row of records.slice(0, 100)) {
        if (isIssued(row)) {
            annotations[row.invoiceContentId] = {
                attachable: false,
                issued: true,
                attachmentReasonCode: "ATTACHMENT_ARCHIVED_INVOICE"
            }
            continue
        }
        try {
            const metadata = source(row)
            if (metadata.contentSize > remaining) {
                incomplete = true
                annotations[row.invoiceContentId] = {attachable: false, attachmentReasonCode: "ATTACHMENT_DISCOVERY_LIMIT"}
                continue
            }
            const reviewed = read(row, metadata, remaining)
            remaining -= metadata.contentSize
            const option = {
                invoiceContentId: row.invoiceContentId,
                fileName: metadata.fileName,
                contentType: metadata.contentType,
                contentSize: metadata.contentSize,
                attachmentVersion: reviewed.attachmentVersion,
                description: row.description,
                contentDate: row.contentDate,
                contentDateText: lib.policy.dateText(row.contentDate),
                attachable: true
            }
            attachmentRows.push(option)
            annotations[row.invoiceContentId] = option
        } catch (error) {
            const reasonCode = String(error.message).split(":")[0]
            annotations[row.invoiceContentId] = {attachable: false, attachmentReasonCode: reasonCode}
            ec.logger.warn("Invoice " + invoiceId + " file " + row.invoiceContentId + " cannot be attached: " + error.message)
        }
    }
    return {attachmentRows, annotations, incomplete, maxAttachmentCount, maxAttachmentBytes, maxTotalAttachmentBytes}
}
function contentRecords(invoiceId, ids = null) {
    let query = find(C, {invoiceId}).orderBy("-contentDate,invoiceContentId").limit(101)
    if (ids) query = query.condition("invoiceContentId", "in", ids)
    return Array.from(query.list())
}
// get#InvoiceDeliveryAttachments: the files of a receivable a sender (RECEIVABLE_EDIT) may attach.
function options(p) {
    const scope = lib.writeInvoice(p, false)
    if (!scope.receivable) denied("INVOICE_DIRECTION_INVALID", "Only customer invoice attachments are sent here")
    const ids = p.attachmentContentIdList?.length ? Array.from(p.attachmentContentIdList).map(String) : null
    if (ids && ids.length > 100) denied("ATTACHMENT_COUNT_LIMIT", "Review at most one hundred attachment identifiers")
    return project(scope.record.invoiceId, contentRecords(scope.record.invoiceId, ids))
}
// The annotations of an invoice's files for its detail: attachable with a version, or issued.
function annotate(p) {
    const records = contentRecords(p.invoiceId)
    const projected = p.canSend ? project(p.invoiceId, records) : {annotations: {}, incomplete: false}
    const contentRows = records
        .slice(0, 100)
        .map(row =>
            Object.assign(
                lib.display(row),
                {attachable: false, issued: isIssued(row)},
                projected.annotations[row.invoiceContentId] || {}
            )
        )
    return {contentRows, incomplete: projected.incomplete}
}
// Copy the selected files, at the versions the sender reviewed, under the issued folder of this sending, each recorded as an
// immutable InvoiceContent; a copy already made for the same version is used again.
function freeze(p) {
    const selected = selection(p)
    if (!selected.ids.length) return {attachmentList: [], attachmentRows: []}
    const records = Array.from(
        find(C, {invoiceId: p.invoiceId})
            .condition("invoiceContentId", "in", selected.ids)
            .orderBy("invoiceContentId")
            .forUpdate(true)
            .list()
    )
    if (records.length !== selected.ids.length)
        denied("ATTACHMENT_UNAVAILABLE", "A selected attachment does not belong to this invoice")
    const attachmentList = [],
        attachmentRows = []
    let remaining = maxTotalAttachmentBytes
    for (const row of records) {
        const metadata = source(row),
            reviewed = read(row, metadata, remaining)
        if (reviewed.attachmentVersion !== selected.versions[row.invoiceContentId])
            denied("STALE_ATTACHMENT", "An attachment changed; review it before sending")
        remaining -= metadata.contentSize
        const location =
            issuedFolder +
            p.invoiceId +
            "/" +
            p.issueKey +
            "/attachments/" +
            reviewed.contentHash.slice(0, 24) +
            "/" +
            metadata.fileName
        let copy = one(C, {contentLocation: location})
        if (!copy) {
            ec.resource.getLocationReference(location).putBytes(reviewed.bytes)
            copy = call("create#" + C, {
                invoiceId: p.invoiceId,
                contentLocation: location,
                contentTypeEnumId: row.contentTypeEnumId,
                description: "Sent copy of " + metadata.fileName,
                isImmutable: "Y"
            })
        }
        attachmentList.push({fileName: metadata.fileName, contentType: metadata.contentType, contentBytes: reviewed.bytes})
        attachmentRows.push({
            invoiceContentId: copy.invoiceContentId,
            sourceInvoiceContentId: row.invoiceContentId,
            fileName: metadata.fileName,
            contentType: metadata.contentType,
            contentSize: metadata.contentSize,
            contentHash: reviewed.contentHash,
            attachmentVersion: reviewed.attachmentVersion
        })
    }
    return {attachmentList, attachmentRows}
}
// update#InvoiceContent and save#InvoiceContentFile: an issued file is never replaced or removed.
function assertMutable(p) {
    if (isIssued(find(C, {invoiceContentId: p.invoiceContentId}).forUpdate(true).one()))
        denied("ISSUED_INVOICE_IMMUTABLE", "An issued invoice file cannot be replaced or removed")
    return {}
}
// The IssuedInvoiceContentImmutable EECA: an issued file is never deleted, and neither its identity nor its location
// changes; no other file may take an issued location. Writes of any other content pass.
function guardContent(p) {
    const original = p.originalValue ? lib.map(p.originalValue) : null
    const candidate = Object.assign({}, original || {}, lib.map(p.entityValue || {}))
    if (!isIssued(original) && !isIssued(candidate)) return {}
    if (p.eecaOperation === "delete") denied("ISSUED_INVOICE_IMMUTABLE", "An issued invoice file cannot be removed")
    if (p.eecaOperation === "create") {
        if (candidate.isImmutable !== "Y" || one(C, {contentLocation: candidate.contentLocation}))
            denied("ISSUED_INVOICE_IMMUTABLE", "A file cannot take the location of an issued invoice file")
        return {}
    }
    for (const field of ["invoiceContentId", "invoiceId", "contentLocation", "contentDate", "userId", "isImmutable"]) {
        const before = original?.[field],
            after = candidate[field]
        if (field === "contentDate" ? lib.ms(before) !== lib.ms(after) : String(before ?? "") !== String(after ?? ""))
            denied("ISSUED_INVOICE_IMMUTABLE", "An issued invoice file's identity cannot be changed")
    }
    return {}
}

const operations = {options, annotate, freeze, assertMutable, guardContent}
;({
    execute: (op, parameters) => {
        if (!operations[op]) denied("OPERATION_UNKNOWN", "Unknown invoice attachment operation " + op)
        return operations[op](parameters)
    }
})
