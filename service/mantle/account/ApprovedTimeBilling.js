// Finance billing of approved project time and worker expenses, by project and worker, at the billing rates.
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const {find, one, call, denied, display} = lib
function project(p) {
    const record = find("mantle.work.effort.WorkEffort", {workEffortId: p.workEffortId}).forUpdate(true).one()
    if (!record || record.workEffortTypeEnumId !== "WetProject") denied("PROJECT_UNAVAILABLE", "Choose an available project")
    const parties = Array.from(
        find("mantle.work.effort.WorkEffortParty", {workEffortId: p.workEffortId})
            .conditionDate("fromDate", "thruDate", null)
            .orderBy("fromDate")
            .list()
    )
    const vendor = parties.find(row => ["Vendor", "VendorBillFrom"].includes(row.roleTypeId))
    const customer = parties.find(row => ["Customer", "CustomerBillTo"].includes(row.roleTypeId))
    if (!vendor || vendor.partyId !== p.organizationPartyId || !customer)
        denied("PROJECT_SCOPE_INVALID", "The project is not billed by this organization")
    const customerParty = one("mantle.party.Party", {partyId: customer.partyId})
    if (
        !customerParty ||
        (customerParty.privateOwnerUserId && customerParty.privateOwnerUserId !== ec.user.userId && !lib.access.systemAdmin())
    )
        denied("PROJECT_UNAVAILABLE", "The project's customer is not available")
    return {record, vendorPartyId: vendor.partyId, customerPartyId: customer.partyId}
}
function entries(p, projectIdList) {
    const cf = ec.entity.conditionFactory
    let query = find("mantle.work.time.TimeEntryAndWorkEffort")
        .condition(
            cf.makeCondition(
                [
                    cf.makeCondition("workEffortId", "in", projectIdList),
                    cf.makeCondition("rootWorkEffortId", "in", projectIdList)
                ],
                "or"
            )
        )
        .condition("thruDate", "less-equals", p.throughDate || ec.user.nowTimestamp)
        .condition("thruDate", "is-not-null", null)
        .condition(p.direction === "payable" ? "vendorInvoiceId" : "invoiceId", "is-null", null)
        .condition(
            cf.makeCondition(
                [
                    cf.makeCondition("rateTypeEnumId", "not-equals", "RatpNoCharge"),
                    cf.makeCondition("rateTypeEnumId", "is-null", null)
                ],
                "or"
            )
        )
    if (p.workerPartyId) query = query.condition("partyId", p.workerPartyId)
    return query
}
function approved(p, ids) {
    const list = Array.from(entries(p, ids).orderBy("fromDate,timeEntryId").limit(10001).list())
    if (list.length > 10000) denied("BILLING_SCOPE_TOO_LARGE", "Narrow the billing date or project selection")
    const sheets = [...new Set(list.map(row => row.timesheetId).filter(Boolean))]
    const approvedIds = sheets.length
        ? new Set(
              Array.from(
                  find("mantle.work.time.Timesheet")
                      .condition("timesheetId", "in", sheets)
                      .condition("statusId", "TmshApproved")
                      .selectField("timesheetId")
                      .list()
              ).map(row => row.timesheetId)
          )
        : new Set()
    const ready = list.filter(row => approvedIds.has(row.timesheetId))
    if (p.direction !== "payable" || !ready.length) return ready
    // a worker invoice and payroll never both take a time entry (impl-people P24, F44): time a pay input consumed is payroll's
    const consumed = new Set(
        Array.from(
            call("mantle.humanres.PayrollInputServices.check#SourceUse", {
                sourceEntityName: "mantle.work.time.TimeEntry",
                sourceIdList: ready.map(row => row.timeEntryId)
            }).consumedIdList || []
        )
    )
    const unconsumed = consumed.size ? ready.filter(row => !consumed.has(row.timeEntryId)) : ready
    if (!unconsumed.length) return unconsumed
    // worker invoices are for contractors (the user's call of Nov 12, 2026): the time of an employee of the organization (on the
    // entry's date or now) is payroll's, left out of the payable list as create#TimeEntryInvoiceItems refuses it (EMPLOYEE_TIME)
    const employees = new Set(
        Array.from(
            call("mantle.humanres.EmploymentServices.get#PayRateAccess", {
                organizationPartyId: p.organizationPartyId,
                entryList: unconsumed.map(row => ({
                    key: row.timeEntryId,
                    partyId: row.partyId,
                    date: row.fromDate ?? row.thruDate
                }))
            }).employeeKeys || []
        ).map(String)
    )
    return employees.size ? unconsumed.filter(row => !employees.has(String(row.timeEntryId))) : unconsumed
}
function expenses(p, ids) {
    if (!ids.length || p.direction === "payable") return []
    let query = find("mantle.work.effort.WorkEffortInvoiceDetail")
        .condition("workEffortId", "in", ids)
        .condition("statusId", "InvoicePmtSent")
        .condition("toPartyId", p.organizationPartyId)
        .condition("fromPartyId", "not-equals", p.organizationPartyId)
        .condition("invoiceDate", "less-equals", p.throughDate || ec.user.nowTimestamp)
    if (p.workerPartyId) query = query.condition("fromPartyId", p.workerPartyId)
    const records = Array.from(query.orderBy("invoiceId").limit(5001).list())
    if (records.length > 5000) denied("BILLING_SCOPE_TOO_LARGE", "Narrow the expense selection")
    if (!records.length) return []
    const invoiceIds = [...new Set(records.map(row => row.invoiceId))]
    const through = new Set(
        Array.from(
            find("mantle.account.invoice.InvoiceItemAssoc")
                .condition("invoiceId", "in", invoiceIds)
                .condition("invoiceItemAssocTypeEnumId", "IiatBillThrough")
                .list()
        ).map(row => row.invoiceId + ":" + row.invoiceItemSeqId)
    )
    const timeLines = new Set(
        Array.from(
            find("mantle.work.time.TimeEntry")
                .condition("vendorInvoiceId", "in", invoiceIds)
                .selectField("vendorInvoiceId")
                .selectField("vendorInvoiceItemSeqId")
                .list()
        ).map(row => row.vendorInvoiceId + ":" + row.vendorInvoiceItemSeqId)
    )
    const amounts = Object.fromEntries(invoiceIds.map(id => [id, toDecimal(0)]))
    const currencies = Object.fromEntries(records.map(row => [row.invoiceId, row.currencyUomId]))
    for (const line of find("mantle.account.invoice.InvoiceItem").condition("invoiceId", "in", invoiceIds).list()) {
        const key = line.invoiceId + ":" + line.invoiceItemSeqId
        if (!through.has(key) && !timeLines.has(key))
            amounts[line.invoiceId] = amounts[line.invoiceId].add(lib.lineTotal(line, currencies[line.invoiceId]))
    }
    return records
        .filter(row => !amounts[row.invoiceId].isZero())
        .map(row => ({
            invoiceId: row.invoiceId,
            workEffortId: row.workEffortId,
            workerPartyId: row.fromPartyId,
            currencyUomId: row.currencyUomId,
            amount: amounts[row.invoiceId]
        }))
}
// One page of rows, with the records page fields of a paged list.
function pageOf(all, p) {
    const recordsPageSize = Math.min(100, Math.max(1, Number(p.pageSize) || 20)),
        recordsCount = all.length
    const recordsPageMaxIndex = Math.max(0, Math.ceil(recordsCount / recordsPageSize) - 1)
    const recordsPageIndex = Math.min(recordsPageMaxIndex, Math.max(0, Number(p.pageIndex) || 0))
    return {
        records: all.slice(recordsPageIndex * recordsPageSize, (recordsPageIndex + 1) * recordsPageSize),
        recordsCount,
        recordsPageSize,
        recordsPageIndex,
        recordsPageMaxIndex,
        recordsPageRangeLow: recordsCount ? recordsPageIndex * recordsPageSize + 1 : 0,
        recordsPageRangeHigh: Math.min(recordsCount, (recordsPageIndex + 1) * recordsPageSize)
    }
}
function list(p) {
    lib.organization(p.organizationPartyId)
    if (p.direction && !["receivable", "payable"].includes(p.direction))
        denied("BILLING_DIRECTION_INVALID", "Choose customer or worker billing")
    if (!lib.has("ACCOUNTING_VIEW") && !lib.has("ACCOUNTING_ADMIN"))
        lib.requirePermission(p.direction === "payable" ? "PAYABLE_VIEW" : "RECEIVABLE_VIEW")
    const projectIds = Array.from(
        find("mantle.work.effort.WorkEffortParty", {partyId: p.organizationPartyId})
            .condition("roleTypeId", "in", ["Vendor", "VendorBillFrom"])
            .conditionDate("fromDate", "thruDate", null)
            .selectField("workEffortId")
            .distinct(true)
            .limit(2001)
            .list()
    ).map(row => row.workEffortId)
    if (projectIds.length > 2000) denied("BILLING_SCOPE_TOO_LARGE", "Narrow the project selection")
    if (p.workEffortId && !projectIds.includes(p.workEffortId)) denied("PROJECT_UNAVAILABLE", "Project is not available")
    const ids = p.workEffortId ? [p.workEffortId] : projectIds
    if (!ids.length) return pageOf([], p)
    const list = approved(p, ids)
    const customerRoles = Array.from(
        find("mantle.work.effort.WorkEffortParty")
            .condition("workEffortId", "in", ids)
            .condition("roleTypeId", "in", ["Customer", "CustomerBillTo"])
            .conditionDate("fromDate", "thruDate", null)
            .list()
    )
    const customers = Object.fromEntries(customerRoles.map(row => [row.workEffortId, row.partyId]))
    const customerIds = [...new Set(Object.values(customers))]
    const cf = ec.entity.conditionFactory
    const visibleCustomers = !customerIds.length
        ? new Set()
        : new Set(
              Array.from(
                  find("mantle.party.Party")
                      .condition("partyId", "in", customerIds)
                      .condition(
                          lib.access.systemAdmin()
                              ? cf.makeCondition("partyId", "in", customerIds)
                              : cf.makeCondition(
                                    [
                                        cf.makeCondition("privateOwnerUserId", "is-null", null),
                                        cf.makeCondition("privateOwnerUserId", "equals", ec.user.userId)
                                    ],
                                    "or"
                                )
                      )
                      .selectField("partyId")
                      .list()
              ).map(row => row.partyId)
          )
    const group = {}
    for (const entry of list) {
        const projectId = entry.workEffortTypeEnumId === "WetProject" ? entry.workEffortId : entry.rootWorkEffortId
        const customerPartyId = customers[projectId]
        if (!visibleCustomers.has(customerPartyId)) continue
        if (p.customerPartyId && p.customerPartyId !== customerPartyId) continue
        const key = projectId + ":" + entry.partyId
        const item =
            group[key] ||
            (group[key] = {
                workEffortId: projectId,
                workerPartyId: entry.partyId,
                customerPartyId,
                approvedHours: toDecimal(0),
                approvedAmount: toDecimal(0),
                expenseAmount: toDecimal(0),
                entryCount: 0,
                missingRateCount: 0
            })
        item.approvedHours = item.approvedHours.add(entry.hours || 0)
        const rate = p.direction === "payable" ? entry.vendorHourRate : entry.clientHourRate
        if (rate == null) item.missingRateCount++
        else item.approvedAmount = item.approvedAmount.add(toDecimal(entry.hours || 0).multiply(rate))
        item.entryCount++
    }
    const currency = lib.policy.preference(p.organizationPartyId).baseCurrencyUomId
    for (const expense of expenses(p, ids)) {
        const customerPartyId = customers[expense.workEffortId]
        if (!visibleCustomers.has(customerPartyId) || (p.customerPartyId && p.customerPartyId !== customerPartyId)) continue
        const key = expense.workEffortId + ":" + expense.workerPartyId
        const item =
            group[key] ||
            (group[key] = {
                workEffortId: expense.workEffortId,
                workerPartyId: expense.workerPartyId,
                customerPartyId,
                approvedHours: toDecimal(0),
                approvedAmount: toDecimal(0),
                expenseAmount: toDecimal(0),
                entryCount: 0,
                missingRateCount: 0
            })
        if (expense.currencyUomId !== currency) item.sourceCurrencyMismatch = true
        else item.expenseAmount = item.expenseAmount.add(expense.amount)
    }
    const all = Object.values(group)
    const names = lib.partyNames(all.flatMap(row => [row.workerPartyId, row.customerPartyId]))
    const projectNames = Object.fromEntries(
        Array.from(find("mantle.work.effort.WorkEffort").condition("workEffortId", "in", ids).list()).map(row => [
            row.workEffortId,
            row.workEffortName
        ])
    )
    const result = pageOf(all, p)
    result.records = result.records.map(row =>
        Object.assign(row, {
            workEffortName: projectNames[row.workEffortId],
            customerName: names[row.customerPartyId],
            workerName: names[row.workerPartyId],
            currencyUomId: currency,
            canInvoice: row.missingRateCount === 0 && !row.sourceCurrencyMismatch,
            reason: row.sourceCurrencyMismatch
                ? "An expense has another currency"
                : row.missingRateCount
                  ? "An approved entry has no billing rate"
                  : null
        })
    )
    return result
}
function create(p) {
    if (p.direction && !["receivable", "payable"].includes(p.direction))
        denied("BILLING_DIRECTION_INVALID", "Choose customer or worker billing")
    if (p.direction === "payable" && !p.workerPartyId) denied("WORKER_REQUIRED", "Choose the worker to bill")
    const permission = p.direction === "payable" ? "PAYABLE_EDIT" : "RECEIVABLE_EDIT"
    lib.organization(p.organizationPartyId, permission, true)
    const sourceProject = project(p)
    const request = {
        workEffortId: p.workEffortId,
        direction: p.direction || "receivable",
        workerPartyId: p.workerPartyId || null,
        throughDate: p.throughDate == null ? null : String(p.throughDate),
        invoiceId: p.invoiceId || null,
        entryGrouping: p.entryGrouping || "entry",
        settlementTermId: p.settlementTermId || null
    }
    const operation = lib.operation(p, "ApprovedTimeInvoice", p.organizationPartyId, request)
    if (operation.old) return lib.previous(operation)
    if (p.invoiceId) {
        const target = lib.writeInvoice({invoiceId: p.invoiceId, organizationPartyId: p.organizationPartyId})
        if (!["InvoiceInProcess", "InvoiceIncoming", "InvoiceReceived"].includes(target.record.statusId))
            denied("INVOICE_NOT_DRAFT", "Choose a draft invoice")
        const fromPartyId = p.direction === "payable" ? p.workerPartyId : p.organizationPartyId
        const toPartyId = p.direction === "payable" ? p.organizationPartyId : sourceProject.customerPartyId
        if (
            target.record.fromPartyId !== fromPartyId ||
            target.record.toPartyId !== toPartyId ||
            target.record.currencyUomId !== lib.policy.preference(p.organizationPartyId).baseCurrencyUomId ||
            target.record.invoiceTypeEnumId === "InvoiceCreditMemo"
        )
            denied("BILLING_TARGET_INVALID", "Choose a draft for this customer or worker in the organization's billing currency")
        if (find("mantle.ledger.transaction.AcctgTrans", {invoiceId: p.invoiceId, isPosted: "Y"}).count())
            denied("INVOICE_POSTED", "A posted invoice cannot receive more source items")
    }
    const ready = approved(p, [p.workEffortId])
    const eligibleExpenses = expenses(p, [p.workEffortId])
    if (!ready.length && !eligibleExpenses.length)
        denied("NOTHING_TO_BILL", "The project has no approved unbilled time or expenses")
    const currency = lib.policy.preference(p.organizationPartyId).baseCurrencyUomId
    for (const expense of eligibleExpenses) {
        const current = find(lib.invoiceEntity, {invoiceId: expense.invoiceId}).forUpdate(true).one()
        if (current?.statusId !== "InvoicePmtSent") denied("BILLING_SOURCE_CHANGED", "An expense is no longer eligible")
        if (expense.currencyUomId !== currency)
            denied("SOURCE_CURRENCY_MISMATCH", "The expense currency must match the billing currency")
    }
    for (const timesheetId of new Set(ready.map(row => row.timesheetId))) {
        const sheet = find("mantle.work.time.Timesheet", {timesheetId}).forUpdate(true).one()
        if (sheet?.statusId !== "TmshApproved") denied("BILLING_SOURCE_CHANGED", "A timesheet is no longer approved")
    }
    for (const row of ready) {
        find("mantle.work.time.TimeEntry", {timeEntryId: row.timeEntryId}).forUpdate(true).one()
        if ((p.direction === "payable" ? row.vendorHourRate : row.clientHourRate) == null)
            denied("BILLING_RATE_MISSING", "Approved time entry " + row.timeEntryId + " has no billing rate")
    }
    const made = call("mantle.account.InvoiceServices.create#ProjectInvoiceItems", {
        workEffortId: p.workEffortId,
        invoiceId: p.invoiceId,
        workerPartyId: p.workerPartyId,
        thruDate: p.throughDate || ec.user.nowTimestamp,
        entryGrouping: p.entryGrouping || "entry",
        ratePurposeEnumId: p.direction === "payable" ? "RaprVendor" : "RaprClient",
        approvedOnly: true,
        billableOnly: true,
        includeExpenses: true,
        timeEntryIdList: ready.map(row => row.timeEntryId),
        settlementTermId: p.settlementTermId
    })
    if (!made.invoiceId || !Number(made.invoiceItemCreatedCount))
        denied("NOTHING_TO_BILL", "The approved source entries are no longer available")
    const created = one(lib.invoiceEntity, {invoiceId: made.invoiceId})
    const expectedFrom = p.direction === "payable" ? p.workerPartyId : p.organizationPartyId
    const expectedTo = p.direction === "payable" ? p.organizationPartyId : sourceProject.customerPartyId
    if (
        !created ||
        created.fromPartyId !== expectedFrom ||
        created.toPartyId !== expectedTo ||
        created.currencyUomId !== currency
    )
        denied(
            "BILLING_SOURCE_SCOPE_CHANGED",
            "The source billing parties or currency changed; review the project before billing"
        )
    call("update#" + lib.invoiceEntity, {
        invoiceId: made.invoiceId,
        ...(!p.invoiceId
            ? {draftedByUserId: ec.user.userId, accountingDate: ec.l10n.format(created.invoiceDate, "yyyy-MM-dd")}
            : {}),
        workflowSourceKey: "approved-time:" + operation.requestHash.slice(0, 64)
    })
    const result = Object.assign(made, {alreadyApplied: false})
    lib.complete(operation, lib.invoiceEntity, made.invoiceId, result)
    return result
}
const operations = {list, create}
;({
    execute: (op, p) => {
        if (!operations[op]) denied("OPERATION_UNKNOWN", "Unknown approved time billing operation " + op)
        return operations[op](p)
    }
})
