// Regression: task and project actuals use a time entry's explicit hourly rates, including zero, before referenced rates.
const PROJECT = "TMR"
const made = {}
const values = id => {
    const row = ec.entity.find("mantle.work.effort.WorkEffort").condition("workEffortId", id).one()
    return [row.actualWorkTime, row.actualClientCost, row.actualCost].map(value => Number(String(value ?? 0)))
}
const snapshot = () => ({task: values(made.task), project: values(PROJECT)})

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    },
    cleanupSpec() {
        const row = ec.entity.find("mantle.work.effort.WorkEffort").condition("workEffortId", PROJECT).one()
        if (row) {
            row.statusId = "WeCancelled"
            row.update()
        }
        ec.artifactExecution.enableAuthz()
    }
})

feature("explicit hourly overrides, zero overrides and referenced fallback roll up consistently after each entry change", {
    when() {
        call("mantle.work.ProjectServices.create#Project", {workEffortId: PROJECT, workEffortName: "Manual hourly actuals"})
        made.task = call("mantle.work.TaskServices.create#Task", {
            rootWorkEffortId: PROJECT,
            workEffortName: "Hourly actuals"
        }).workEffortId
        const fromDate = ec.l10n.parseTimestamp("2026-10-12 09:00:00", "yyyy-MM-dd HH:mm:ss")
        const thruDate = ec.l10n.parseTimestamp("2026-10-12 11:00:00", "yyyy-MM-dd HH:mm:ss")
        const rate = (purpose, amount) =>
            call("create#mantle.humanres.rate.RateAmount", {
                ratePurposeEnumId: purpose,
                rateTypeEnumId: "RatpStandard",
                workEffortId: made.task,
                rateAmount: amount,
                rateCurrencyUomId: "USD",
                timePeriodUomId: "TF_hr",
                fromDate
            }).rateAmountId
        const clientRate = rate("RaprClient", 200),
            workerRate = rate("RaprVendor", 50)
        made.entry = call("create#mantle.work.time.TimeEntry", {
            partyId: "ORG_ZIZI_JD",
            workEffortId: made.task,
            fromDate,
            thruDate,
            hours: 2,
            rateTypeEnumId: "RatpStandard",
            rateAmountId: clientRate,
            vendorRateAmountId: workerRate,
            clientHourRate: 150,
            vendorHourRate: 60,
            hasModifiedRates: "Y"
        }).timeEntryId
        const explicit = snapshot()
        call("update#mantle.work.time.TimeEntry", {timeEntryId: made.entry, clientHourRate: 0, vendorHourRate: 0})
        const zero = snapshot()
        call("update#mantle.work.time.TimeEntry", {timeEntryId: made.entry, clientHourRate: null, vendorHourRate: null})
        const fallback = snapshot()
        call("delete#mantle.work.time.TimeEntry", {timeEntryId: made.entry})
        const removed = snapshot()
        for (const rateAmountId of [clientRate, workerRate]) call("delete#mantle.humanres.rate.RateAmount", {rateAmountId})
        return {explicit, zero, fallback, removed}
    },
    then({explicit, zero, fallback, removed}) {
        explicit.task == [2, 300, 120]
        explicit.project == [2, 300, 120]
        zero.task == [2, 0, 0]
        zero.project == [2, 0, 0]
        fallback.task == [2, 400, 100]
        fallback.project == [2, 400, 100]
        removed.task == [0, 0, 0]
        removed.project == [0, 0, 0]
    }
})
