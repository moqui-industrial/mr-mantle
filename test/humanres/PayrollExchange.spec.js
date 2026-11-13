// People's payroll exchange (mantle.humanres.PayrollExchangeServices preview#Batch, reconcile#Batch, execute#Batch; IronStone People
// design §8.4 external processing and migration, PayrollExchange; PE-19; impl-people P28): a pay group in external processing exports
// its period's approved inputs with a manifest (through the framework's export target, which keeps its record) and is never calculated
// here; payroll history makes legacy pay records and no invoice, a bad row named and the rest applied, a file replayed adding nothing;
// a processor's results are refused for a group not in external processing and while the group is not live (live results wait on the
// group's live state and Accounting's payroll-origin projection, as finalization does), then become a pay run of the period whose
// approval and finalization make the same slips and obligations as native pay, an employee with a refused line refused whole; a day
// People paid is refused as history. Standalone: spec-local organizations, people, employments, pay configuration (as data), a pay
// input and users.
// Run: ./moq test mr-mantle --spec PayrollExchange
const prefix = "PAYXCH"
const X = "mantle.humanres.PayrollExchangeServices."
const R = "mantle.humanres.PayrollRunServices."
const S = "mantle.humanres.PayrollSetupServices."
const RUN = "mantle.humanres.payroll.PayrollRun"
const ROW = "mantle.humanres.payroll.PayrollExchangeRow"
const OBLIGATION = "mantle.humanres.payroll.PayrollObligation"
const HISTORY = "mantle.humanres.employment.EmploymentPayHistory"
const since = "2001-01-01T00:00:00Z"
const state = {}

// a call as a user: its result with its error text ("" when it succeeds), in its own transaction
function run(username, service, parameters = {}) {
    login(username)
    ec.artifactExecution.disableAuthz()
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(service).parameters(parameters).requireNewTransaction(true).call() || {}
        return Object.assign({}, out, {error: ec.message.hasError() ? ec.message.getErrorsString() : ""})
    } catch (error) {
        return {error: String(error.message || error)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}
const code = out => (out.error ? /[A-Z][A-Z0-9_]{3,}(?=:)/.exec(out.error)?.[0] || out.error : "")
const rows = (entity, conditions) => Array.from(ec.entity.find(entity).condition(conditions).disableAuthz().list())
const one = (entity, conditions) => ec.entity.find(entity).condition(conditions).disableAuthz().one()
const money = value => (value == null ? null : String(toDecimal(value).setScale(2)))
const outcomes = payrollExchangeBatchId =>
    rows(ROW, {payrollExchangeBatchId})
        .sort((a, b) => a.rowSeqId.localeCompare(b.rowSeqId))
        .map(row => row.outcome + (row.reasonCode ? ":" + row.reasonCode : ""))
// the current month, as calendar days (the user's zone), so the invoices fall in the fiscal year the fixtures open
function month() {
    const today = ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd")
    const [year, number] = today.split("-").map(Number)
    const day = d => [year, String(number).padStart(2, "0"), String(d).padStart(2, "0")].join("-")
    return {today, from: day(1), thru: day(new Date(Date.UTC(year, number, 0)).getUTCDate())}
}
function person(kind) {
    const partyId = prefix + "_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Exchange", lastName: kind})
    return partyId
}
const employ = partyId =>
    call("mantle.humanres.EmploymentServices.create#Employment", {fromPartyId: partyId, toPartyId: state.org, fromDate: since})
        .partyRelationshipId
function account(kind, permissions) {
    const id = prefix + "_U_" + kind
    const party = person("USER_" + kind)
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Payroll exchange " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    call("create#mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtAgent",
        fromPartyId: party,
        toPartyId: state.org,
        toRoleTypeId: "OrgInternal",
        fromDate: since
    })
    call("create#moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId: party,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        timeZone: ec.user.userAccount?.timeZone || "America/Chicago"
    })
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: since})
    return id
}
function component(componentCode, componentKindEnumId, term) {
    const payrollComponentId = prefix + "_C_" + componentCode
    call("create#mantle.humanres.payroll.PayrollComponent", {
        payrollComponentId,
        organizationPartyId: state.org,
        componentCode,
        componentName: componentCode,
        componentKindEnumId
    })
    call(
        "create#mantle.humanres.payroll.PayrollComponentTerm",
        Object.assign(
            {
                payrollComponentId,
                statusId: "PtsPublished",
                fromDate: "2000-01-01T00:00:00Z",
                basisEnumId: "PcbAmount",
                amount: "0",
                currencyUomId: "USD"
            },
            term
        )
    )
    return payrollComponentId
}
function group(payrollGroupId, extra) {
    call(
        "create#mantle.humanres.payroll.PayrollGroup",
        Object.assign(
            {
                payrollGroupId,
                organizationPartyId: state.org,
                groupName: payrollGroupId,
                currencyUomId: "USD",
                timePeriodTypeId: "PayrollMonth",
                firstPeriodFromDate: state.month.from,
                periodsPerYear: 12,
                payDateOffsetDays: 0,
                prorationEnumId: "PprCalendarDays",
                timeBasisEnumId: "PtbTimesheets",
                liveEnabled: "N",
                fromDate: since
            },
            extra
        )
    )
    call("create#mantle.humanres.payroll.PayrollGroupPeriod", {
        payrollGroupId,
        timePeriodId: state.period,
        payDate: state.month.today
    })
}
function assign(partyRelationshipId, partyId, payrollGroupId) {
    call("create#mantle.humanres.payroll.PayrollAssignment", {
        partyRelationshipId,
        partyId,
        organizationPartyId: state.org,
        payrollStructureId: prefix + "_STRUCT",
        payrollGroupId,
        isPrimary: "Y",
        fromDate: "2020-01-01T00:00:00Z"
    })
}
const csv = lines => lines.join("\n")

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        // the employer, with its accounting set up from DefaultSettings and its fiscal periods (the finance fixtures')
        state.org = ec.resource.script("component://mr-mantle/test/account/AccountingSettlementFixtures.js").fixtures(prefix).org
        state.month = month()
        state.period = call("mantle.party.TimeServices.create#TimePeriod", {
            partyId: state.org,
            timePeriodTypeId: "PayrollMonth",
            fromDate: state.month.from,
            thruDate: state.month.thru
        }).timePeriodId
        // the processor's withholding is paid to an authority (the deduction's payee)
        state.authority = prefix + "_AUTHORITY"
        call("create#mantle.party.Party", {partyId: state.authority, partyTypeEnumId: "PtyOrganization"})
        call("create#mantle.party.Organization", {partyId: state.authority, organizationName: "Exchange tax authority"})
        state.salary = component("SALARY", "PckEarning", {expenseGlAccountId: "631100000", liabilityGlAccountId: "224000000"})
        state.tax = component("TAX", "PckDeduction", {liabilityGlAccountId: "224000000", payeePartyId: state.authority})
        state.bonus = component("BONUS", "PckEarning", {expenseGlAccountId: "631100000"})
        call("create#mantle.humanres.payroll.PayrollStructure", {
            payrollStructureId: prefix + "_STRUCT",
            organizationPartyId: state.org,
            structureName: "Exchange salaried",
            currencyUomId: "USD",
            payBasisEnumId: "PpbSalaried",
            statusId: "PtsPublished",
            fromDate: "2000-01-01T00:00:00Z"
        })
        // a group in external processing, not live yet, and a group calculated here
        state.ext = prefix + "_EXT"
        group(state.ext, {externalProcessing: "Y"})
        state.native = prefix + "_NATIVE"
        group(state.native, {payrollLocalizationId: "PlzDemonstration"})
        for (const kind of ["ANN", "BEN", "CAL"]) {
            state[kind] = person(kind)
            state[kind + "Emp"] = employ(state[kind])
            assign(state[kind + "Emp"], state[kind], state.ext)
        }
        // Dee is employed and paid by the native group alone
        state.DEE = person("DEE")
        state.DEEEmp = employ(state.DEE)
        assign(state.DEEEmp, state.DEE, state.native)
        // Ann's approved hours of the period, the input the processor is sent
        state.input = call("create#mantle.humanres.payroll.PayrollInput", {
            partyRelationshipId: state.ANNEmp,
            partyId: state.ANN,
            organizationPartyId: state.org,
            payrollGroupId: state.ext,
            timePeriodId: state.period,
            inputTypeEnumId: "PitWorked",
            inputName: "workedHours",
            inputDate: state.month.from,
            quantity: "8",
            quantityUomId: "TF_hr",
            statusId: "PinApproved",
            entitlementKey: prefix + ":HOURS:ANN",
            activeEntitlementKey: prefix + ":HOURS:ANN",
            isAdjustment: "N"
        }).payrollInputId
        state.payroll = account("PAYROLL", ["PAYROLL_VIEW", "PAYROLL_EDIT", "PEOPLE_IMPORT"])
        state.noImport = account("NOIMPORT", ["PAYROLL_VIEW", "PAYROLL_EDIT"])
        state.configurer = account("CONFIG", ["PAYROLL_VIEW", "PAYROLL_EDIT", "PAYROLL_CONFIGURE"])
        state.approver = account("APPROVER", ["PAYROLL_VIEW", "PAYROLL_APPROVE"])
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature("a group in external processing exports its approved inputs with a manifest and is never calculated here", {
    when() {
        const previewed = run(state.payroll, X + "preview#Batch", {
            exchangeKind: "export",
            payrollGroupId: state.ext,
            timePeriodId: state.period,
            sourceSystem: "Acme Payroll"
        })
        const again = run(state.payroll, X + "preview#Batch", {
            exchangeKind: "export",
            payrollGroupId: state.ext,
            timePeriodId: state.period
        })
        const early = code(run(state.payroll, X + "execute#Batch", {payrollExchangeBatchId: previewed.payrollExchangeBatchId}))
        const reconciled = run(state.payroll, X + "reconcile#Batch", {payrollExchangeBatchId: previewed.payrollExchangeBatchId})
        const executed = run(state.payroll, X + "execute#Batch", {payrollExchangeBatchId: previewed.payrollExchangeBatchId})
        const read = run(state.payroll, X + "get#Batch", {payrollExchangeBatchId: previewed.payrollExchangeBatchId})
        const fileText = read.batch?.files ? ec.resource.getLocationText(read.batch.files.file.location, false) : ""
        const manifest = read.batch?.files
            ? JSON.parse(ec.resource.getLocationText(read.batch.files.manifest.location, false))
            : {}
        const nativeRun = code(run(state.payroll, R + "create#Run", {payrollGroupId: state.ext, timePeriodId: state.period}))
        return {previewed, again, early, reconciled, executed, read, fileText, manifest, nativeRun}
    },
    then({previewed, again, early, reconciled, executed, read, fileText, manifest, nativeRun}) {
        previewed.error == ""
        previewed.readyCount == 1
        again.payrollExchangeBatchId == previewed.payrollExchangeBatchId
        again.repeated == true
        early == "NOT_RECONCILED"
        reconciled.statusId == "PxbReconciled"
        executed.statusId == "PxbExecuted"
        // the framework kept its record of the file, as for any export of the target
        one("moqui.server.TransferBatch", {transferId: executed.transferId}).targetId == "payrollExchangeInputs"
        read.rows[0].outcome == "exported"
        fileText.includes(prefix + ":HOURS:ANN")
        fileText.includes("Worked hours")
        manifest.rows == 1
        manifest.sourceKeys == [prefix + ":HOURS:ANN"]
        manifest.fileSha256.length == 64
        // native calculation is refused for the group
        nativeRun == "EXTERNAL_PROCESSING"
    }
})

feature(
    "payroll history makes legacy pay records and no invoice: a bad row named, the rest applied, a file replayed adds nothing",
    {
        when() {
            const file = csv([
                "worker,payDate,gross,net",
                state.ANN + ",2025-01-31,1000.00,800.00",
                state.BEN + ",2025-01-31,1200.00,900.00",
                prefix + "_NOBODY,2025-01-31,500.00,400.00",
                state.ANN + ",2099-01-31,1000.00,800.00",
                state.ANN + ",2025-01-31,1000.00,800.00"
            ])
            const values = {
                exchangeKind: "history",
                organizationPartyId: state.org,
                cutoverDate: state.month.from,
                currencyUomId: "USD",
                sourceSystem: "Old payroll",
                importText: file,
                fileName: "history.csv",
                expectedCount: "2",
                expectedGross: "2200",
                expectedNet: "1700"
            }
            // the import permission is People's own: PAYROLL_VIEW and PAYROLL_EDIT alone are refused, with the same parameters
            const noImport = code(run(state.noImport, X + "preview#Batch", values))
            const previewed = run(state.payroll, X + "preview#Batch", values)
            const read = outcomes(previewed.payrollExchangeBatchId)
            const reconciled = run(state.payroll, X + "reconcile#Batch", {
                payrollExchangeBatchId: previewed.payrollExchangeBatchId
            })
            const executed = run(state.payroll, X + "execute#Batch", {payrollExchangeBatchId: previewed.payrollExchangeBatchId})
            const replayed = run(state.payroll, X + "preview#Batch", values)
            // another file: Ann's record as recorded, Ben's with other amounts
            const second = run(state.payroll, X + "preview#Batch", {
                exchangeKind: "history",
                organizationPartyId: state.org,
                cutoverDate: state.month.from,
                currencyUomId: "USD",
                sourceSystem: "Old payroll",
                importText: csv([
                    "worker,payDate,gross,net",
                    state.ANN + ",2025-01-31,1000,800",
                    state.BEN + ",2025-01-31,1250,950"
                ])
            })
            return {
                noImport,
                previewed,
                outcomes: read,
                reconciled,
                executed,
                replayed,
                second: outcomes(second.payrollExchangeBatchId),
                records: rows(HISTORY, {partyRelationshipId: state.ANNEmp}).concat(
                    rows(HISTORY, {partyRelationshipId: state.BENEmp})
                ),
                invoices: rows("mantle.account.invoice.Invoice", {fromPartyId: state.ANN}).length
            }
        },
        then({noImport, previewed, outcomes, reconciled, executed, replayed, second, records, invoices}) {
            noImport == "PERMISSION_DENIED"
            previewed.error == ""
            outcomes == ["ready", "ready", "refused:WORKER_UNKNOWN", "refused:AFTER_CUTOVER", "duplicate"]
            reconciled.reconciliation.differences.length == 0
            executed.appliedCount == 2
            executed.errorCount == 2
            records.length == 2
            records.every(record => record.internalPayroll == "N")
            records.map(record => money(record.netPayAmount)).sort() == ["800.00", "900.00"]
            // history makes no invoice and no obligation
            invoices == 0
            replayed.payrollExchangeBatchId == previewed.payrollExchangeBatchId
            replayed.repeated == true
            second == ["known", "refused:CONFLICT"]
        }
    }
)

feature("a processor's results wait for a live group, then become a pay run approved and finalized as any run", {
    when() {
        const results = csv([
            "worker,component,amount",
            state.ANN + ",SALARY,3000.00",
            state.ANN + ",TAX,600.00",
            state.BEN + ",SALARY,2500.00",
            state.BEN + ",tax,500.00",
            state.CAL + ",SALARY,2000.00",
            state.CAL + ",NO_SUCH,10.00",
            state.DEE + ",SALARY,1000.00"
        ])
        const values = {
            exchangeKind: "results",
            payrollGroupId: state.ext,
            timePeriodId: state.period,
            sourceSystem: "Acme Payroll",
            importText: results,
            fileName: "results.csv",
            expectedCount: "2",
            expectedGross: "5500",
            expectedNet: "4400"
        }
        const nativeGroup = code(
            run(state.payroll, X + "preview#Batch", Object.assign({}, values, {payrollGroupId: state.native}))
        )
        const previewed = run(state.payroll, X + "preview#Batch", values)
        const read = outcomes(previewed.payrollExchangeBatchId)
        const reconciled = run(state.payroll, X + "reconcile#Batch", {payrollExchangeBatchId: previewed.payrollExchangeBatchId})
        // live results wait on the group's live state (and Accounting's projection, in place in this build), as finalization does
        const notLive = run(state.payroll, X + "execute#Batch", {payrollExchangeBatchId: previewed.payrollExchangeBatchId})
        const revision = run(state.configurer, S + "find#Groups", {payrollGroupId: state.ext}).group?.revision
        const liveOn = run(state.configurer, S + "store#Group", {
            payrollGroupId: state.ext,
            expectedRevision: revision,
            liveEnabled: "Y",
            reason: "The processor goes live"
        })
        const executed = run(state.payroll, X + "execute#Batch", {payrollExchangeBatchId: previewed.payrollExchangeBatchId})
        const payrollRunId = executed.payrollRunId
        const calculate = code(run(state.payroll, R + "calculate#Run", {payrollRunId}))
        const submitted = run(state.payroll, R + "submit#Run", {payrollRunId})
        const approved = run(state.approver, R + "approve#Run", {payrollRunId})
        const finalized = run(state.payroll, R + "finalize#Run", {payrollRunId})
        const replayed = run(state.payroll, X + "preview#Batch", values)
        // a day People paid is refused as history: no amount counts twice
        const paidDay = run(state.payroll, X + "preview#Batch", {
            exchangeKind: "history",
            organizationPartyId: state.org,
            cutoverDate: "2099-01-01",
            currencyUomId: "USD",
            sourceSystem: "Old payroll",
            importText: csv(["worker,payDate,gross,net", state.ANN + "," + state.month.today + ",3000,2400"])
        })
        const obligations = rows(OBLIGATION, {payrollRunId})
        return {
            nativeGroup,
            previewed,
            outcomes: read,
            reconciled,
            notLive,
            liveOn,
            executed,
            calculate,
            submitted,
            approved,
            finalized,
            replayed,
            paidDay: outcomes(paidDay.payrollExchangeBatchId),
            nets: obligations
                .filter(row => row.obligationKindEnumId === "PokNetPay")
                .map(row => row.partyId + "=" + money(row.amount))
                .sort(),
            payee: obligations.find(row => row.obligationKindEnumId === "PokPayee"),
            run: one(RUN, {payrollRunId}),
            units: rows("mantle.humanres.payroll.PayrollRunEmployment", {payrollRunId}).length,
            input: one("mantle.humanres.payroll.PayrollInput", {payrollInputId: state.input}),
            slips: rows("mantle.humanres.payroll.Payslip", {payrollRunId}).map(slip => slip.statusId)
        }
    },
    then(found) {
        found.nativeGroup == "NOT_EXTERNAL"
        found.previewed.error == ""
        // Cal's unknown line refuses Cal whole; Dee is not paid by the group
        found.outcomes ==
            [
                "ready",
                "ready",
                "ready",
                "ready",
                "refused:EMPLOYEE_INCOMPLETE",
                "refused:COMPONENT_UNKNOWN",
                "refused:NOT_IN_GROUP"
            ]
        found.reconciled.reconciliation.differences.length == 0
        found.reconciled.reconciliation.liveReasons.map(reason => reason.reasonCode) == ["LIVE_NOT_ENABLED"]
        code(found.notLive) == "NOT_LIVE"
        found.liveOn.error == ""
        found.executed.appliedCount == 4
        found.executed.errorCount == 3
        found.run.exchangeBatchId == found.previewed.payrollExchangeBatchId
        found.units == 2
        found.calculate == "EXTERNAL_PROCESSING"
        found.submitted.error == ""
        // the importer prepared the run, so they never approve it
        found.run.preparedByUserIds == state.payroll
        found.approved.approved == true
        found.finalized.statusId == "PrnFinalized"
        // the same obligations as native pay: each net pay invoice, and the withholding to its payee
        found.nets == [state.ANN + "=2400.00", state.BEN + "=2000.00"]
        found.payee.payeePartyId == state.authority
        money(found.payee.amount) == "1100.00"
        found.slips.every(status => status == "PssFinal" || status == "PssIssued")
        // Ann's hours the processor was sent are finalized with the run
        found.input.statusId == "PinFinalized"
        found.input.payrollRunId == found.run.payrollRunId
        found.replayed.repeated == true
        found.paidDay == ["refused:PAID_HERE"]
    }
})
