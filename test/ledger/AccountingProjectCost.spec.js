// Project cost posting (OtherAutoPostServices.post#WorkEffortCost) and the period-run contract (PeriodRunServices):
// approving a week posts its project time at cost from labor clearing, leaving out production work and an outside
// vendor's time; a rate change and a reopen post dated deltas; with the flag set late, a project cost period run previews
// and posts what is missing, refusing a stale version. Spec-local organization, project, worker and users.
const fixtures = () => ec.resource.script("component://mr-mantle/test/account/AccountingSettlementFixtures.js")
const runs = "mantle.ledger.PeriodRunServices."
let f
function asUser(userId, run) {
    login(userId)
    try {
        return run()
    } finally {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}
function costLines(acctgTransIds) {
    return Array.from(
        ec.entity
            .find("mantle.ledger.transaction.AcctgTransAndEntry")
            .condition("acctgTransTypeEnumId", "AttWorkEffortCost")
            .condition("organizationPartyId", f.org)
            .condition("isPosted", "Y")
            .disableAuthz()
            .list()
    ).filter(row => !acctgTransIds || acctgTransIds.includes(row.acctgTransId))
}
// The net posted to project cost: debits less credits.
function netCost() {
    return costLines()
        .filter(row => row.glAccountId == "550000000")
        .reduce((sum, row) => sum.add(toDecimal(row.amount).multiply(row.debitCreditFlag == "D" ? 1 : -1)), toDecimal(0))
}
function setFlag(value) {
    const pref = ec.entity
        .find("mantle.ledger.config.PartyAcctgPreference")
        .condition("organizationPartyId", f.org)
        .disableAuthz()
        .one()
    asUser(f.users.financeadmin, () =>
        call("mantle.ledger.SetupServices.store#Preferences", {
            organizationPartyId: f.org,
            settings: {projectCostPostingEnabled: value},
            changeReason: "Project cost posting",
            lastUpdatedStamp: pref.lastUpdatedStamp
        })
    )
}
function sheetStatus(statusId) {
    call("update#mantle.work.time.Timesheet", {timesheetId: f.sheetId, statusId})
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const h = fixtures()
        f = h.fixtures("ACCT_P11_COST")
        f.users.gl = h.user(f, "GLPOST", ["ACCOUNTING_VIEW", "ACCOUNTING_GL_POST"])
        f.worker = "ACCT_P11_COST_WORKER"
        f.vendor = "ACCT_P11_COST_VENDOR"
        for (const [partyId, partyTypeEnumId] of [
            [f.worker, "PtyPerson"],
            [f.vendor, "PtyOrganization"]
        ])
            call("create#mantle.party.Party", {partyId, partyTypeEnumId})
        for (const [workEffortId, workEffortTypeEnumId, parent] of [
            ["P11_PROJECT", "WetProject", null],
            ["P11_TASK", "WetTask", "P11_PROJECT"],
            ["P11_RUN", "WetTask", null]
        ])
            call("create#mantle.work.effort.WorkEffort", {
                workEffortId,
                workEffortTypeEnumId,
                purposeEnumId: workEffortId == "P11_RUN" ? "WepProductionRun" : null,
                parentWorkEffortId: parent,
                rootWorkEffortId: parent,
                ownerPartyId: f.org,
                statusId: "WeInProgress",
                workEffortName: workEffortId
            })
        // the week stays open to changes once approved (timesheet policy lk N), so a change of an approved entry posts its delta
        call("create#mantle.party.PartyRelationship", {
            fromPartyId: f.worker,
            toPartyId: f.org,
            relationshipTypeEnumId: "PrtAgent",
            fromDate: 0
        })
        call("create#mantle.party.PartySetting", {
            partyId: f.org,
            partySettingTypeId: "ProjTimesheetPolicy",
            settingValue: JSON.stringify({lk: "N"})
        })
        f.sheetId = "P11_SHEET"
        call("create#mantle.work.time.Timesheet", {
            timesheetId: f.sheetId,
            partyId: f.worker,
            fromDate: f.timestamp,
            statusId: "TmshCompleted"
        })
        for (const [timeEntryId, workEffortId, vendorPartyId] of [
            ["P11_E1", "P11_TASK", null],
            ["P11_E2", "P11_RUN", null],
            ["P11_E3", "P11_TASK", f.vendor]
        ])
            call("create#mantle.work.time.TimeEntry", {
                timeEntryId,
                timesheetId: f.sheetId,
                partyId: f.worker,
                workEffortId,
                vendorPartyId,
                fromDate: f.timestamp,
                hours: timeEntryId == "P11_E2" ? "2" : "3",
                vendorHourRate: "40",
                rateTypeEnumId: "RatpStandard"
            })
        setFlag("Y")
        f.monthId = ec.entity
            .find("mantle.party.time.TimePeriod")
            .condition({partyId: f.org, timePeriodTypeId: "FiscalMonth"})
            .condition("fromDate", "less-equals", f.day)
            .condition("thruDate", "greater-equals", f.day)
            .disableAuthz()
            .one().timePeriodId
    },
    setup() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
})

feature("approving the week posts its project time at cost from labor clearing, without production or vendor time", {
    when() {
        call("mantle.work.TimesheetServices.approve#Timesheet", {timesheetId: f.sheetId})
        const lines = costLines()
        const operation = ec.entity
            .find("mantle.ledger.transaction.PostingOperation")
            .condition("operationKey", "wec:P11_E1")
            .disableAuthz()
            .one()
        const others = ["P11_E2", "P11_E3"].map(id =>
            ec.entity
                .find("mantle.ledger.transaction.PostingOperation")
                .condition("operationKey", "wec:" + id)
                .disableAuthz()
                .one()
        )
        return {lines, operation, others}
    },
    then({lines, operation, others}) {
        lines.length == 2
        lines.find(l => l.glAccountId == "550000000").debitCreditFlag == "D"
        lines.find(l => l.glAccountId == "550000000").amount == 120
        lines.find(l => l.glAccountId == "631100000").debitCreditFlag == "C"
        lines[0].workEffortId == "P11_PROJECT"
        operation.organizationPartyId == f.org && operation.resultId == "P11_E1"
        others[0] == null && others[1] == null
    }
})
feature("a rate change on the approved week posts the difference, and reopening the week reverses the rest", {
    when() {
        const entry = ec.entity.find("mantle.work.time.TimeEntry").condition("timeEntryId", "P11_E1").disableAuthz().one()
        call(
            "mantle.work.TimeServices.store#TimeEntry",
            Object.assign(
                {},
                Object.fromEntries(
                    [
                        "timeEntryId",
                        "timesheetId",
                        "partyId",
                        "workEffortId",
                        "fromDate",
                        "thruDate",
                        "hours",
                        "rateTypeEnumId"
                    ].map(k => [k, entry[k]])
                ),
                {vendorHourRate: "50"}
            )
        )
        const afterRate = netCost()
        call("mantle.work.TimesheetServices.reopen#Timesheet", {timesheetId: f.sheetId, reason: "Correct the week"})
        const reversal = costLines()
            .filter(l => l.glAccountId == "550000000" && l.debitCreditFlag == "C")
            .map(l => l.amount)
        return {afterRate, afterReopen: netCost(), reversal}
    },
    then({afterRate, afterReopen, reversal}) {
        afterRate == 150
        afterReopen == 0
        reversal.length == 1 && reversal[0] == 150
    }
})
feature(
    "with the flag set after the approval, a project cost run previews and posts the missing cost; a stale version is refused",
    {
        when() {
            setFlag("N")
            sheetStatus("TmshCompleted")
            call("mantle.work.TimesheetServices.approve#Timesheet", {timesheetId: f.sheetId})
            const offNet = netCost()
            setFlag("Y")
            const request = {runKindEnumId: "PrkProjectCost", organizationPartyId: f.org, timePeriodId: f.monthId}
            const readerPreview = asUser(f.users.read, () => fixtures().rejected(runs + "preview#Run", request))
            const checklist = asUser(f.users.gl, () =>
                call("mantle.ledger.CloseServices.get#Checklist", {organizationPartyId: f.org, timePeriodId: f.monthId})
            )
            const preview = asUser(f.users.gl, () => call(runs + "preview#Run", request))
            const reviewed = asUser(f.users.gl, () => call(runs + "get#Run", {periodRunId: preview.periodRunId}))
            const stale = asUser(f.users.gl, () =>
                fixtures().rejected(runs + "post#Run", {
                    periodRunId: preview.periodRunId,
                    calculationVersion: "x",
                    operationKey: "p11-run-x"
                })
            )
            const posted = asUser(f.users.gl, () =>
                call(runs + "post#Run", {
                    periodRunId: preview.periodRunId,
                    calculationVersion: preview.calculationVersion,
                    operationKey: "p11-run-1"
                })
            )
            const after = asUser(f.users.gl, () => call(runs + "get#Run", {periodRunId: preview.periodRunId}))
            const second = asUser(f.users.gl, () => call(runs + "preview#Run", request))
            return {offNet, readerPreview, checklist, preview, reviewed, stale, posted, after, second, net: netCost()}
        },
        then({offNet, readerPreview, checklist, preview, reviewed, stale, posted, after, second, net}) {
            offNet == 0
            readerPreview.includes("PERMISSION_DENIED")
            Array.from(checklist.checkRows).find(r => r.checkEnumId == "PccProjectCost").items[0].recordId == "P11_E1"
            Array.from(checklist.checkRows).find(r => r.checkEnumId == "PccProjectCost").status == "warning"
            preview.resultCount == 1 && preview.failedCount == 0 && preview.totalAmount == 150
            reviewed.results[0].sourceId == "P11_E1" && reviewed.run.canPost == true && reviewed.run.kindText == "Project cost"
            stale.includes("RUN_CHANGED")
            posted.statusId == "PrnPosted" && posted.postedCount == 1
            after.results[0].statusId == "PrrPosted" && !!after.results[0].acctgTransId
            second.resultCount == 0
            net == 150
        }
    }
)
// Deleting a time entry whose cost was posted reverses its posting on the day of the delete, also after project cost
// posting is turned off (the week's policy leaves its time open to changes).
feature("deleting a posted time entry reverses its project cost", {
    when() {
        const before = netCost()
        // with project cost posting turned off since, the earlier posting is still reversed
        setFlag("N")
        call("mantle.work.TimeServices.delete#TimeEntry", {timeEntryId: "P11_E1"})
        const operation = ec.entity
            .find("mantle.ledger.transaction.PostingOperation")
            .condition("operationKey", "wec:P11_E1")
            .disableAuthz()
            .one()
        return {before, after: netCost(), lines: JSON.parse(operation.resultJson).lines.length}
    },
    then({before, after, lines}) {
        before == 150
        after == 0
        lines >= 4
    }
})
