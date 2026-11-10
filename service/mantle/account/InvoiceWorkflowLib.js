// Invoice scope for the account modules: the invoice and its organization for a read or a write, the side's
// permission, stored totals and fingerprints. The entity, value, paging and operation-key helpers are EntityLib's.
const policy = ec.resource.script("component://mr-mantle/service/mantle/ledger/AccountingPolicy.js")
const entityLib = policy.lib
const access = entityLib.access
const invoiceEntity = "mantle.account.invoice.Invoice"
const {find, one, rows, call, probe, ms, map, display, hash, denied, partyNames, page, operationEntity, complete, previous} =
    entityLib
const has = access.has
function invoiceDisplay(record) {
    const out = display(record)
    if (record.accountingDate) {
        out.accountingDateText = policy.calendarDateText(record.accountingDate)
        out.invoiceDateText = out.accountingDateText
        out.invoiceDateValue = out.accountingDateText
    } else out.invoiceDateValue = record.invoiceDate ? ec.l10n.format(record.invoiceDate, "yyyy-MM-dd") : null
    return out
}
// Calendar labels for invoices the caller already authorized. Keep their book days and a single issued portion's
// immutable due day independent of the viewer's zone. Legacy stamps and multiple portions retain their existing
// presentation; their calendar meaning cannot be reconstructed from one timestamp. Read schedules in batches.
function invoiceCalendarDays(invoiceIds) {
    const ids = Array.from(new Set(Array.from(invoiceIds || []).filter(Boolean)))
    const out = {}
    for (let offset = 0; offset < ids.length; offset += 1000) {
        const part = ids.slice(offset, offset + 1000)
        for (const invoice of find(invoiceEntity)
            .condition("invoiceId", "in", part)
            .selectField("invoiceId")
            .selectField("accountingDate")
            .list())
            out[invoice.invoiceId] = {
                invoiceDay: invoice.accountingDate ? policy.calendarDateText(invoice.accountingDate) : null,
                dueDay: null
            }
        const portions = {}
        for (const row of find("mantle.account.invoice.InvoiceDueSchedule")
            .condition("invoiceId", "in", part)
            .selectField("invoiceId")
            .selectField("dueDate")
            .list()) {
            const entry = portions[row.invoiceId] || (portions[row.invoiceId] = {count: 0, day: null})
            entry.count++
            entry.day = row.dueDate ? policy.calendarDateText(row.dueDate) : null
        }
        for (const [id, entry] of Object.entries(portions)) if (out[id] && entry.count === 1) out[id].dueDay = entry.day
    }
    return out
}
function requirePermission(permission) {
    if (!has(permission)) denied("PERMISSION_DENIED", permission + " authority is required")
}
function organization(organizationPartyId, permission, lock = false) {
    if (permission) requirePermission(permission)
    if (!organizationPartyId || !one("mantle.party.PartyRole", {partyId: organizationPartyId, roleTypeId: "OrgInternal"}))
        denied("ORGANIZATION_REQUIRED", "Choose an internal organization")
    if (!access.systemAdmin()) {
        const financeAdmin = has("ACCOUNTING_ADMIN")
        const scope = call("mantle.party.PartyServices.get#PartyOrganizationInfo", {partyId: ec.user.userAccount?.partyId})
        const permitted = Array.from(scope.userOrgIds || [])
        const selected = ec.user.getPreference("ACTIVE_ORGANIZATION") || scope.activeOrgId || null
        const activeOrgId =
            selected &&
            (financeAdmin || permitted.includes(selected)) &&
            one("mantle.party.PartyRole", {partyId: selected, roleTypeId: "OrgInternal"})
                ? selected
                : null
        if ((!financeAdmin && !permitted.includes(organizationPartyId)) || (activeOrgId && activeOrgId !== organizationPartyId))
            denied("ORGANIZATION_DENIED", "The organization is not available")
    }
    if (lock) find("mantle.party.Party", {partyId: organizationPartyId}).forUpdate(true).one()
    return organizationPartyId
}
function invoice(p, permission = null, lock = false) {
    let record = one(invoiceEntity, {invoiceId: p.invoiceId})
    if (!record) denied("INVOICE_UNAVAILABLE", "Invoice is not available")
    let organizationPartyId = p.organizationPartyId || record.financeOrganizationPartyId
    if (!organizationPartyId) {
        const internalFrom = one("mantle.party.PartyRole", {partyId: record.fromPartyId, roleTypeId: "OrgInternal"})
        organizationPartyId = internalFrom ? record.fromPartyId : record.toPartyId
    }
    if (![record.fromPartyId, record.toPartyId].includes(organizationPartyId))
        denied("ORGANIZATION_DENIED", "The invoice belongs to another organization")
    organization(organizationPartyId, permission, lock)
    if (lock) {
        record = find(invoiceEntity, {invoiceId: p.invoiceId}).forUpdate(true).one()
        if (!record || ![record.fromPartyId, record.toPartyId].includes(organizationPartyId))
            denied("ORGANIZATION_DENIED", "The invoice changed its organization")
    }
    const linked = record.creditForInvoiceId && one(invoiceEntity, {invoiceId: record.creditForInvoiceId})
    const receivable =
        record.financeOrganizationPartyId === organizationPartyId && record.financeDirection
            ? record.financeDirection === "receivable"
            : linked
              ? linked.fromPartyId === organizationPartyId
              : record.fromPartyId === organizationPartyId
    const partyId = record.fromPartyId === organizationPartyId ? record.toPartyId : record.fromPartyId
    const party = one("mantle.party.Party", {partyId})
    if (party?.privateOwnerUserId && party.privateOwnerUserId !== ec.user.userId && !access.systemAdmin())
        denied("INVOICE_UNAVAILABLE", "Invoice is not available")
    return {record, organizationPartyId, receivable, partyId, permission: receivable ? "RECEIVABLE_EDIT" : "PAYABLE_EDIT"}
}
function readInvoice(p) {
    const out = invoice(p)
    if (!has("ACCOUNTING_VIEW") && !has("ACCOUNTING_ADMIN") && !has(out.receivable ? "RECEIVABLE_VIEW" : "PAYABLE_VIEW"))
        denied("PERMISSION_DENIED", "Invoice view authority is required")
    return out
}
// The projects an invoice bills (WorkEffortInvoice, or time billed on it: TimeEntry.invoiceId or vendorInvoiceId), each
// work effort read once in batches rather than one read per row.
function invoiceProjectIds(invoiceId) {
    const workEffortIds = new Set(rows("mantle.work.effort.WorkEffortInvoice", {invoiceId}).map(row => row.workEffortId))
    for (const field of ["invoiceId", "vendorInvoiceId"])
        for (const row of Array.from(
            find("mantle.work.time.TimeEntry", {[field]: invoiceId})
                .selectField("workEffortId")
                .distinct(true)
                .list()
        ))
            workEffortIds.add(row.workEffortId)
    workEffortIds.delete(null)
    const ids = Array.from(workEffortIds)
    const projectIds = new Set()
    for (let offset = 0; offset < ids.length; offset += 1000)
        for (const row of Array.from(
            find("mantle.work.effort.WorkEffort")
                .condition("workEffortId", "in", ids.slice(offset, offset + 1000))
                .selectField("workEffortId,workEffortTypeEnumId,rootWorkEffortId")
                .list()
        )) {
            const projectId = row.workEffortTypeEnumId === "WetProject" ? row.workEffortId : row.rootWorkEffortId
            if (projectId) projectIds.add(projectId)
        }
    return projectIds
}
// Projects' billing: the editor of an invoice's side (RECEIVABLE_EDIT or PAYABLE_EDIT, never a client) who sees one of the
// projects it bills, as Projects' get#InvoiceProjects scopes them (IronStone Accounting P21, F438). found: an invoice()
// result the caller already has, so the invoice is not read again.
// memo: an object kept over several calls (a search's hits), which holds the user's visible projects once found.
function projectEditorOf(found, memo = {}) {
    if (!has(found.permission)) return false
    const projectIds = invoiceProjectIds(found.record.invoiceId)
    if (!projectIds.size) return false
    if (!memo.projects) {
        const visible = call("mantle.work.ProjectServices.get#VisibleProjectInfo")
        memo.projects = {all: !!visible.allProjects, ids: Array.from(visible.visibleProjectIds || [])}
    }
    return memo.projects.all || [...projectIds].some(id => memo.projects.ids.includes(id))
}
function projectEditor(p, memo = {}) {
    return projectEditorOf(invoice(p), memo)
}
// Refuses unless the user is the invoice's project billing editor; found as for projectEditorOf.
function requireProjectEditor(found, memo = {}) {
    if (!projectEditorOf(found, memo)) denied("PERMISSION_DENIED", "Project invoice view authority is required")
    return found
}
// Whether the user reads an invoice outside the finance screens (record mounts, search): its reader (readInvoice) or a
// project's billing editor (projectEditor). Answers false, never an error: a lookup that fails leaves no message behind.
function readable(invoiceId, memo = {}) {
    ec.message.pushErrors()
    try {
        try {
            readInvoice({invoiceId})
            return true
        } catch (error) {
            ec.message.clearErrors()
            return projectEditor({invoiceId}, memo) && !ec.message.hasError()
        }
    } catch (other) {
        return false
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}
function writeInvoice(p, lock = true) {
    const initial = invoice(p)
    requirePermission(initial.permission)
    return lock
        ? invoice(Object.assign({}, p, {organizationPartyId: initial.organizationPartyId}), initial.permission, true)
        : initial
}
function revision(record, expected) {
    if (expected == null || ms(record.lastUpdatedStamp) !== ms(expected))
        denied("STALE_REVISION", "Invoice changed; reload before saving")
}
function fingerprint(record) {
    const fields = [
        "invoiceId",
        "invoiceTypeEnumId",
        "fromPartyId",
        "toPartyId",
        "invoiceDate",
        "accountingDate",
        "dueDate",
        "settlementTermId",
        "referenceNumber",
        "description",
        "invoiceMessage",
        "currencyUomId"
    ]
    return hash({
        invoice: Object.fromEntries(
            fields.map(field => [
                field,
                record[field] == null
                    ? null
                    : field === "accountingDate"
                      ? policy.calendarDateText(record[field])
                      : String(record[field])
            ])
        ),
        lines: rows("mantle.account.invoice.InvoiceItem", {invoiceId: record.invoiceId})
            .map(row => map(row))
            .sort((a, b) => String(a.invoiceItemSeqId).localeCompare(String(b.invoiceItemSeqId)))
    })
}
// An operation key for an invoice operation, with the organization locked first.
function operation(p, type, organizationPartyId, request, lock = true) {
    if (lock && p.operationKey) organization(organizationPartyId, null, true)
    return entityLib.operation(p, type, organizationPartyId, request)
}
// One invoice line's amount, rounded to its currency.
function lineTotal(line, currencyUomId) {
    return ec.l10n.roundCurrency(toDecimal(line.quantity ?? 1).multiply(line.amount ?? 0), currencyUomId)
}
// The totals Mantle stores on the Invoice (update#InvoiceTotals, run by the InvoiceItem and PaymentApplication EECAs).
function storedTotals(row) {
    const appliedPayments = toDecimal(row.appliedPaymentsTotal ?? 0)
    return {
        invoiceTotal: toDecimal(row.invoiceTotal ?? 0),
        appliedPayments,
        appliedPaymentsTotal: appliedPayments,
        unpaidTotal: toDecimal(row.unpaidTotal ?? 0),
        currencyUomId: row.currencyUomId
    }
}
// The stored totals of an invoice, read again so a change earlier in the transaction is included.
function totals(record) {
    return storedTotals(one(invoiceEntity, {invoiceId: record.invoiceId}) || record)
}
// The stored totals of several invoices by invoice ID; with asOfDate also the applications on or before it, and the
// applied and unpaid amounts as of that date.
function totalsMany(records, asOfDate = null) {
    if (!records.length) return {}
    const ids = records.map(row => row.invoiceId)
    const stored = Object.fromEntries(
        Array.from(find(invoiceEntity).condition("invoiceId", "in", ids).list()).map(row => [row.invoiceId, row])
    )
    const values = Object.fromEntries(records.map(row => [row.invoiceId, storedTotals(stored[row.invoiceId] || row)]))
    if (asOfDate == null) return values
    for (const value of Object.values(values)) {
        value.applications = []
        value.appliedPayments = toDecimal(0)
    }
    const cf = ec.entity.conditionFactory
    const applications = find("mantle.account.payment.PaymentApplication")
        .condition(cf.makeCondition([cf.makeCondition("invoiceId", "in", ids), cf.makeCondition("toInvoiceId", "in", ids)], "or"))
        .condition("appliedDate", "less-equals", asOfDate)
    for (const item of applications.list())
        for (const id of new Set([item.invoiceId, item.toInvoiceId].filter(id => values[id]))) {
            values[id].appliedPayments = values[id].appliedPayments.add(item.amountApplied || 0)
            values[id].applications.push(map(item))
        }
    for (const value of Object.values(values)) {
        value.appliedPaymentsTotal = value.appliedPayments
        value.unpaidTotal = value.invoiceTotal.subtract(value.appliedPayments)
    }
    return values
}
// The open holds of the invoices given (InvoiceHold with no releasedDate), by invoice ID.
function openHolds(invoiceIds) {
    const ids = [...new Set(Array.from(invoiceIds || []).filter(Boolean))]
    if (!ids.length) return {}
    const holds = {}
    const found = find("mantle.account.invoice.InvoiceHold")
        .condition("invoiceId", "in", ids)
        .condition("releasedDate", "is-null", null)
        .orderBy("placedDate")
        .list()
    for (const row of Array.from(found)) (holds[row.invoiceId] = holds[row.invoiceId] || []).push(map(row))
    return holds
}
// The hold guard: a payable with an open hold is not approved and no payment or credit is applied to it.
function requireNotHeld(invoiceId) {
    const held = openHolds([invoiceId])[invoiceId]
    if (!held) return
    const reason = one("moqui.basic.Enumeration", {enumId: held[0].holdReasonEnumId})
    denied("INVOICE_HELD", "Bill " + invoiceId + " is on hold (" + (reason?.description || held[0].holdReasonEnumId) + ")")
}
// Place a hold on a bill whose scope the caller has checked: refuses a receivable, a cancelled or paid bill, a reason that
// is not an InvoiceHoldReason and, unless existingOk, a second open hold for the same reason (an existing one is then
// answered). hold#Invoice calls it after its INVOICE_HOLD check, the bill match after its INVOICE_MATCH check, and the
// match re-evaluation job, which has no user, for the match exception.
function placeHold(scope, holdReasonEnumId, holdComment, options = {}) {
    if (scope.receivable) denied("PAYABLE_ONLY", "Only a bill is held")
    if (["InvoiceCancelled", "InvoicePmtSent"].includes(scope.record.statusId))
        denied("HOLD_STATE_INVALID", "A cancelled or paid bill is not held")
    const reason = one("moqui.basic.Enumeration", {enumId: holdReasonEnumId})
    if (reason?.enumTypeId !== "InvoiceHoldReason") denied("HOLD_REASON_INVALID", "Choose a hold reason")
    const invoiceId = scope.record.invoiceId
    const open = find("mantle.account.invoice.InvoiceHold", {invoiceId, holdReasonEnumId})
        .condition("releasedDate", "is-null", null)
        .one()
    if (open) {
        if (options.existingOk) return {invoiceHoldId: open.invoiceHoldId, placed: false}
        denied("HOLD_EXISTS", "Bill " + invoiceId + " is already on hold for " + reason.description)
    }
    const created = call("create#mantle.account.invoice.InvoiceHold", {
        invoiceId,
        holdReasonEnumId,
        holdComment: holdComment == null ? null : String(holdComment).slice(0, 4000),
        reviewDate: options.reviewDate ?? null,
        placedByUserId: ec.user.userId || null,
        placedDate: ec.user.nowTimestamp
    })
    return {invoiceHoldId: created.invoiceHoldId, placed: true}
}
function escapeHtml(value) {
    const entities = {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}
    return String(value ?? "").replace(/[&<>"']/g, character => entities[character])
}
;({
    entityLib,
    amount: entityLib.amount,
    json: entityLib.json,
    check: entityLib.check,
    policy,
    access,
    invoiceEntity,
    operationEntity,
    find,
    one,
    rows,
    call,
    ms,
    map,
    display,
    invoiceDisplay,
    invoiceCalendarDays,
    hash,
    has,
    denied,
    requirePermission,
    organization,
    invoice,
    readInvoice,
    projectEditor,
    projectEditorOf,
    requireProjectEditor,
    invoiceProjectIds,
    readable,
    writeInvoice,
    revision,
    fingerprint,
    operation,
    complete,
    previous,
    lineTotal,
    storedTotals,
    totals,
    totalsMany,
    partyNames,
    page,
    probe,
    openHolds,
    requireNotHeld,
    placeHold,
    escapeHtml
})
