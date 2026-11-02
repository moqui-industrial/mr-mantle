const policy = () =>
    ec.resource.script(
        "component://mr-mantle/service/mantle/ledger/AccountingPolicy.js",
    )
const org = "NATIVE_FIN_REPORTS"
const call = (name, p) =>
    policy().call(
        name.startsWith("mantle.") || name.includes("#mantle.")
            ? name
            : "mantle.ledger." + name,
        p,
    )
// A month-end evening in Chicago that is already the next month in UTC: the books use the user's day.
const evening = Date.UTC(2026, 10, 1, 1, 30) // October 31, 20:30 in Chicago; November 1, 01:30 in UTC
let today, thru, savedTimeZone
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        savedTimeZone = ec.user.userAccount?.timeZone || null
        ec.user.setTimeZone("America/Chicago")
        ec.user.setEffectiveTime(evening)
        call("create#mantle.party.Party", {
            partyId: org,
            partyTypeEnumId: "PtyOrganization",
        })
        call("create#mantle.party.Organization", {
            partyId: org,
            organizationName: "Native reports",
        })
        call("create#mantle.party.PartyRole", {
            partyId: org,
            roleTypeId: "OrgInternal",
        })
        call("LedgerServices.init#PartyAccountingConfiguration", {
            sourcePartyId: "DefaultSettings",
            organizationPartyId: org,
            baseCurrencyUomId: "USD",
        })
        today = new Date(Number(ec.user.nowTimestamp) - 3600000).toISOString()
        thru = new Date(Number(ec.user.nowTimestamp) + 3600000).toISOString()
        for (const [amountUomId, amount] of [
            ["USD", 100],
            ["EUR", 50],
        ]) {
            // a transaction in another currency carries its rate; post#AcctgTrans converts it to the base currency
            const id = call("LedgerServices.create#AcctgTrans", {
                organizationPartyId: org,
                amountUomId,
                exchangeRate: amountUomId == "EUR" ? "1.2" : null,
                acctgTransTypeEnumId: "AttInternal",
            }).acctgTransId
            for (const [glAccountId, debitCreditFlag] of [
                ["111100000", "D"],
                ["331100000", "C"],
            ])
                call("LedgerServices.create#AcctgTransEntry", {
                    acctgTransId: id,
                    glAccountId,
                    debitCreditFlag,
                    amount,
                })
            call("LedgerServices.post#AcctgTrans", { acctgTransId: id })
        }
    },
    cleanupSpec() {
        login("john.doe")
        ec.user.setEffectiveTime(null)
        ec.user.setTimeZone(savedTimeZone)
    },
})
feature("live trial balance and ledger hold the base currency, another currency converted at its rate", {
    when() {
        return {
            trial: call("FinanceReportServices.run#TrialBalance", {
                organizationPartyId: org,
                fromDate: today,
                thruDate: thru,
            }),
            ledger: call("FinanceReportServices.run#GeneralLedger", {
                organizationPartyId: org,
                fromDate: today,
                thruDate: thru,
            }),
        }
    },
    then({ trial, ledger }) {
        trial.reportRows.length == 2
        ledger.reportRows.length == 4
        trial.reportRows.every((r) => r.amountUomId == "USD")
        trial.reportRows
            .find((r) => r.glAccountId == "111100000" && r.amountUomId == "USD")
            .ending.eq(160)
    },
})
feature(
    "comparison uses the same scoped calculation and preserves empty prior balances",
    {
        when() {
            return call("FinanceReportServices.run#TrialBalance", {
                organizationPartyId: org,
                fromDate: today,
                thruDate: thru,
                compareFromDate: "2000-01-01",
                compareThruDate: "2000-01-02",
            })
        },
        then({ reportRows }) {
            reportRows.length == 2
            reportRows.every(
                (r) => r.comparisonEnding.isZero() && r.change.eq(r.ending),
            )
        },
    },
)
feature("a closed fiscal month reads its stored base-currency summary", {
    when() {
        const day = ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd")
        const period = policy()
            .rows("mantle.party.time.TimePeriod", {
                partyId: org,
                timePeriodTypeId: "FiscalMonth",
            })
            .find(
                (r) =>
                    policy().calendarDateText(r.fromDate) <= day &&
                    policy().calendarDateText(r.thruDate) >= day,
            )
        const key = {
                organizationPartyId: org,
                glAccountId: "111100000",
                timePeriodId: period.timePeriodId,
            },
            old = policy().one(
                "mantle.ledger.account.GlAccountOrgTimePeriod",
                key,
            )
        call(
            (old ? "update#" : "create#") +
                "mantle.ledger.account.GlAccountOrgTimePeriod",
            Object.assign({}, key, {
                beginningBalance: 0,
                postedDebits: 999,
                postedCredits: 0,
                endingBalance: 999,
            }),
        )
        call("update#mantle.party.time.TimePeriod", {
            timePeriodId: period.timePeriodId,
            isClosed: "Y",
        })
        const result = call("FinanceReportServices.run#TrialBalance", {
            organizationPartyId: org,
            glAccountId: "111100000",
            amountUomId: "USD",
            timePeriodId: period.timePeriodId,
        })
        call("update#mantle.party.time.TimePeriod", {
            timePeriodId: period.timePeriodId,
            isClosed: "N",
        })
        return {
            day,
            month: policy().calendarDateText(period.fromDate),
            reportRows: result.reportRows,
        }
    },
    then({ day, month, reportRows }) {
        day == "2026-10-31"
        month == "2026-10-01"
        reportRows.length == 1
        reportRows[0].closedSummary == true
        reportRows[0].ending.eq(999)
    },
})
