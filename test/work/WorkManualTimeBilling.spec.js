// Regression: grouped client invoice lines retain rated sources, including manual hourly, zero and piece rates.
const INVOICE = "mantle.account.InvoiceServices"
const made = {projects: [], invoices: []}
const one = (entity, fields) => ec.entity.find(entity).condition(fields).one()
const count = (entity, fields) => ec.entity.find(entity).condition(fields).count()
const stamp = text => ec.l10n.parseTimestamp(text, "yyyy-MM-dd HH:mm:ss")

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        call("create#mantle.party.Party", {partyId: "TMB_CLIENT", partyTypeEnumId: "PtyOrganization"})
        call("create#mantle.party.Organization", {partyId: "TMB_CLIENT", organizationName: "Manual time billing client"})
        call("create#mantle.party.PartyRole", {partyId: "TMB_CLIENT", roleTypeId: "Customer"})
        ec.artifactExecution.enableAuthz()
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.artifactExecution.enableAuthz()
    },
    cleanupSpec() {
        ec.artifactExecution.disableAuthz()
        try {
            for (const invoiceId of made.invoices) {
                const invoice = one("mantle.account.invoice.Invoice", {invoiceId})
                if (invoice && invoice.statusId !== "InvoiceCancelled")
                    call("update#mantle.account.invoice.Invoice", {invoiceId, statusId: "InvoiceCancelled"})
            }
            for (const workEffortId of made.projects) {
                const project = one("mantle.work.effort.WorkEffort", {workEffortId})
                if (project) {
                    project.statusId = "WeCancelled"
                    project.update()
                }
            }
        } finally {
            ec.artifactExecution.enableAuthz()
        }
    }
})

feature("#grouping grouping links manual-rate sources exactly once and releases them on line removal and cancellation", {
    where: [{grouping: "worker"}, {grouping: "all"}],
    when({grouping}) {
        const projectId = grouping === "worker" ? "TMBW" : "TMBA"
        made.projects.push(projectId)
        call("mantle.work.ProjectServices.create#Project", {
            workEffortId: projectId,
            workEffortName: "Manual billing " + grouping
        })
        for (const [partyId, roleTypeId] of [
            ["ORG_ZIZI_SERVICES", "Vendor"],
            ["TMB_CLIENT", "Customer"]
        ])
            call("create#mantle.work.effort.WorkEffortParty", {
                workEffortId: projectId,
                partyId,
                roleTypeId,
                fromDate: stamp("2026-10-01 00:00:00"),
                statusId: "WeptAssigned"
            })
        const taskId = call("mantle.work.TaskServices.create#Task", {
            rootWorkEffortId: projectId,
            workEffortName: "Manual billing sources"
        }).workEffortId
        const timesheetId = call("create#mantle.work.time.Timesheet", {
            partyId: "ORG_ZIZI_JD",
            statusId: "TmshApproved",
            fromDate: stamp("2026-10-12 00:00:00"),
            thruDate: stamp("2026-10-19 00:00:00")
        }).timesheetId
        const ids = []
        for (const [hours, clientHourRate, pieceCount, clientPieceRate] of [
            [2, 150, 0, null],
            [1, 0, 0, null],
            [0, null, 3, 25]
        ])
            ids.push(
                call("create#mantle.work.time.TimeEntry", {
                    partyId: "ORG_ZIZI_JD",
                    vendorPartyId: "ORG_ZIZI_SERVICES",
                    workEffortId: taskId,
                    timesheetId,
                    fromDate: stamp("2026-10-12 09:00:00"),
                    thruDate: stamp("2026-10-12 11:00:00"),
                    hours,
                    clientHourRate,
                    pieceCount,
                    clientPieceRate,
                    rateTypeEnumId: "RatpStandard",
                    hasModifiedRates: "Y"
                }).timeEntryId
            )
        const unratedId = call("create#mantle.work.time.TimeEntry", {
            partyId: "ORG_ZIZI_JD",
            vendorPartyId: "ORG_ZIZI_SERVICES",
            workEffortId: taskId,
            timesheetId,
            fromDate: stamp("2026-10-12 11:00:00"),
            thruDate: stamp("2026-10-12 12:00:00"),
            hours: 0,
            pieceCount: 2,
            rateTypeEnumId: "RatpStandard",
            hasModifiedRates: "Y"
        }).timeEntryId
        const selectedIds = ids.concat(unratedId)
        const unrated = () => {
            const entry = one("mantle.work.time.TimeEntry", {timeEntryId: unratedId})
            return {invoiceId: entry.invoiceId || null, seq: entry.invoiceItemSeqId || null}
        }
        const fields = {
            workEffortId: projectId,
            timeEntryIdList: selectedIds,
            approvedOnly: true,
            billableOnly: true,
            createItemPerWorker: grouping === "worker",
            createSingleItem: grouping === "all",
            currencyUomId: "USD"
        }
        const created = call(INVOICE + ".create#ProjectInvoiceItems", {
            workEffortId: projectId,
            timeEntryIdList: selectedIds,
            approvedOnly: true,
            billableOnly: true,
            includeExpenses: false,
            entryGrouping: grouping,
            currencyUomId: "USD"
        })
        made.invoices.push(created.invoiceId)
        const links = () =>
            ids.map(timeEntryId => {
                const entry = one("mantle.work.time.TimeEntry", {timeEntryId})
                return {invoiceId: entry.invoiceId || null, seq: entry.invoiceItemSeqId || null}
            })
        const linked = links()
        const unratedAfterCreate = unrated()
        const detail = call(INVOICE + ".get#InvoiceTimeDetail", {invoiceId: created.invoiceId})
        const items = Array.from(
            ec.entity.find("mantle.account.invoice.InvoiceItem").condition("invoiceId", created.invoiceId).list()
        )
        const amount = items.reduce((total, item) => total + Number(String(item.amount)) * Number(String(item.quantity)), 0)
        const again = call(INVOICE + ".create#TimeEntryInvoiceItems", Object.assign({}, fields, {invoiceId: created.invoiceId}))
        const itemsAfterRetry = count("mantle.account.invoice.InvoiceItem", {invoiceId: created.invoiceId})
        const unbilledAfterRetry = ec.entity
            .find("mantle.work.time.TimeEntry")
            .condition("timeEntryId", "in", selectedIds)
            .condition("invoiceId", "is-null", null)
            .count()
        call(INVOICE + ".delete#InvoiceItem", {invoiceId: created.invoiceId, invoiceItemSeqId: items[0].invoiceItemSeqId})
        const removed = links()
        const rebuilt = call(INVOICE + ".create#TimeEntryInvoiceItems", Object.assign({}, fields, {invoiceId: created.invoiceId}))
        const relinked = links()
        const unratedAfterRebuild = unrated()
        call("update#mantle.account.invoice.Invoice", {invoiceId: created.invoiceId, statusId: "InvoiceCancelled"})
        const cancelled = links()
        return {
            created,
            ids,
            linked,
            unratedAfterCreate,
            detail,
            amount,
            again,
            itemsAfterRetry,
            unbilledAfterRetry,
            removed,
            rebuilt,
            relinked,
            unratedAfterRebuild,
            cancelled
        }
    },
    then({
        created,
        ids,
        linked,
        unratedAfterCreate,
        detail,
        amount,
        again,
        itemsAfterRetry,
        unbilledAfterRetry,
        removed,
        rebuilt,
        relinked,
        unratedAfterRebuild,
        cancelled
    }) {
        created.invoiceItemCreatedCount == 1
        amount == 375
        linked.every(row => row.invoiceId === created.invoiceId && row.seq)
        new Set(linked.map(row => row.seq)).size == 1
        unratedAfterCreate.invoiceId == null && unratedAfterCreate.seq == null
        detail.entryList.map(row => row.timeEntryId).sort() == ids.slice().sort()
        Number(String(detail.hours)) == 3
        again.invoiceItemCreatedCount == 0
        itemsAfterRetry == 1
        unbilledAfterRetry == 1
        removed.every(row => row.invoiceId == null && row.seq == null)
        rebuilt.invoiceItemCreatedCount == 1
        relinked.every(row => row.invoiceId === created.invoiceId && row.seq)
        unratedAfterRebuild.invoiceId == null && unratedAfterRebuild.seq == null
        cancelled.every(row => row.invoiceId == null && row.seq == null)
    }
})
