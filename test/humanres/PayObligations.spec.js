// People's Accounting handoff (mantle.humanres.PayrollRunServices finalize#Run and get#Settlement; IronStone People design §8.2
// steps 6 and 7, §8.3, §9's payroll route; PE-11; impl-people P27) and Accounting's owner contracts (design-accounting AC-23 and
// ExpensePosting's payroll paragraph): a group is live only with a real localization, so the demonstration group's finalize is
// refused with its two reasons and this spec makes its own live localization; a finalization makes each obligation once (its key),
// releases nothing to Accounting until every employee and the payee's amounts are made, and a retry finishes it; an expense claim
// on the payroll route is linked as it is (no second expense), and the design's example (1,000 wage net, a 100 claim, a 40 advance
// applied to it) delivers 1,060 in one payroll payment from the person's payroll account; a negative correction is recovered by
// deductions capped a period on the next regular run, a leaver's (the group no longer paying them in the period) as a receivable;
// a finance user without PAYROLL_VIEW finds no payroll invoice where one with it does. The P27 review: a finalization whose caller's
// transaction rolls back stays Finalizing (a retry finishes it); a finalized run's statements are issued; payroll's posting mappings
// added to an existing database (migrate#PayrollOrigin) and a leaver's receivable posted; the recovery cap a percentage of net pay,
// set through store#RecoverySettings; a pension deduction and the employer's contribution paid to the fund, one invoice from it
// (the user's calls of Nov 13, 2026); P28: a percentage cap with no earlier net waits a period, or takes an amount set; an amount
// and a percentage together (the user's call of Nov 13, 2026, P28's review): the percentage of the last net, at most the amount.
// Standalone: spec-local organizations, people, employments, pay configuration (published as data), a live localization,
// salaries, inputs, a claim, an advance and users.
// Run: ./moq test mr-mantle --spec PayObligations
const prefix = "PAYOBL"
const R = "mantle.humanres.PayrollRunServices."
const S = "mantle.humanres.PayrollSetupServices."
const I = "mantle.humanres.PayrollInputServices."
const OBLIGATION = "mantle.humanres.payroll.PayrollObligation"
const INVOICE = "mantle.account.invoice.Invoice"
const ITEM = "mantle.account.invoice.InvoiceItem"
const SLIP = "mantle.humanres.payroll.Payslip"
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
const total = invoiceId => money(call("mantle.account.InvoiceServices.get#InvoiceTotal", {invoiceId}).invoiceTotal)
const unpaid = invoiceId => money(call("mantle.account.InvoiceServices.get#InvoiceTotal", {invoiceId}).unpaidTotal)
// the current month and the next, as calendar days (the user's zone), so the invoices fall in the fiscal year the fixtures open
function months() {
    const today = ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd")
    const [year, month] = today.split("-").map(Number)
    const day = (y, m, d) => [y, String(m).padStart(2, "0"), String(d).padStart(2, "0")].join("-")
    const last = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate()
    const [ny, nm] = month === 12 ? [year + 1, 1] : [year, month + 1]
    return {
        today,
        from: day(year, month, 1),
        thru: day(year, month, last(year, month)),
        nextFrom: day(ny, nm, 1),
        nextThru: day(ny, nm, last(ny, nm))
    }
}
function person(kind) {
    const partyId = prefix + "_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Obligation", lastName: kind})
    return partyId
}
const employ = partyId =>
    call("mantle.humanres.EmploymentServices.create#Employment", {
        fromPartyId: partyId,
        toPartyId: state.org,
        fromDate: since
    }).partyRelationshipId
function account(kind, permissions, partyId = null) {
    const id = prefix + "_U_" + kind
    const party = partyId || person("USER_" + kind)
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Pay obligations " + kind})
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
                basisEnumId: term.formula ? "PcbFormula" : "PcbAmount",
                currencyUomId: "USD"
            },
            term
        )
    )
    return payrollComponentId
}
function group(payrollGroupId, payrollLocalizationId, extra = {}) {
    call(
        "create#mantle.humanres.payroll.PayrollGroup",
        Object.assign(
            {
                payrollGroupId,
                organizationPartyId: state.org,
                groupName: payrollGroupId,
                currencyUomId: "USD",
                timePeriodTypeId: "PayrollMonth",
                firstPeriodFromDate: state.months.from,
                periodsPerYear: 12,
                payDateOffsetDays: 0,
                prorationEnumId: "PprCalendarDays",
                timeBasisEnumId: "PtbTimesheets",
                payrollLocalizationId,
                liveEnabled: "N",
                fromDate: since
            },
            extra
        )
    )
    // this month paid today (a payment run pays on or after an invoice's day), the next at its end
    for (const [timePeriodId, payDate] of [
        [state.period, state.months.today],
        [state.next, state.months.nextThru]
    ])
        call("create#mantle.humanres.payroll.PayrollGroupPeriod", {payrollGroupId, timePeriodId, payDate})
}
function assign(partyRelationshipId, partyId, payrollGroupId, annual) {
    call("create#mantle.humanres.payroll.PayrollAssignment", {
        partyRelationshipId,
        partyId,
        organizationPartyId: state.org,
        payrollStructureId: prefix + "_SAL",
        payrollGroupId,
        isPrimary: "Y",
        fromDate: "2026-01-01T00:00:00Z"
    })
    call("create#mantle.humanres.employment.EmploymentSalary", {
        partyRelationshipId,
        fromDate: "2026-01-01T00:00:00Z",
        amount: annual,
        currencyUomId: "USD",
        timePeriodTypeId: "PayrollYear"
    })
}
// a run of a group's period (or a correction run) calculated, asked and approved by the approver
function approve(payrollRunId) {
    run(state.payroll, R + "calculate#Run", {payrollRunId})
    run(state.payroll, R + "submit#Run", {payrollRunId})
    return run(state.approver, R + "approve#Run", {payrollRunId})
}
function approvedRun(payrollGroupId, timePeriodId) {
    const created = run(state.payroll, R + "create#Run", {payrollGroupId, timePeriodId})
    approve(created.payrollRunId)
    return created.payrollRunId
}
// a bill from the person, received (a claim's), or approved and paid by a delivered payment (an advance's)
function bill(invoiceId, partyId, amount, itemTypeEnumId) {
    call("create#mantle.account.invoice.Invoice", {
        invoiceId,
        invoiceTypeEnumId: "InvoiceSales",
        fromPartyId: partyId,
        toPartyId: state.org,
        statusId: "InvoiceIncoming",
        invoiceDate: ec.l10n.parseTimestamp(state.months.from + " 12:00:00", "yyyy-MM-dd HH:mm:ss"),
        accountingDate: state.months.from,
        currencyUomId: "USD"
    })
    call("mantle.account.InvoiceServices.create#InvoiceItem", {invoiceId, itemTypeEnumId, quantity: "1", amount})
    call("update#mantle.account.invoice.Invoice", {invoiceId, statusId: "InvoiceReceived"})
}
const obligations = payrollRunId => rows(OBLIGATION, {payrollRunId})
const obligationOf = (payrollRunId, obligationKindEnumId, partyId = null) =>
    obligations(payrollRunId).find(
        row => row.obligationKindEnumId === obligationKindEnumId && (!partyId || row.partyId === partyId)
    )

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        // the employer, with its accounting set up from DefaultSettings and its fiscal periods (the finance fixtures')
        state.org = ec.resource.script("component://mr-mantle/test/account/AccountingSettlementFixtures.js").fixtures(prefix).org
        state.months = months()
        const period = (from, thru) =>
            call("mantle.party.TimeServices.create#TimePeriod", {
                partyId: state.org,
                timePeriodTypeId: "PayrollMonth",
                fromDate: from,
                thruDate: thru
            }).timePeriodId
        state.period = period(state.months.from, state.months.thru)
        state.next = period(state.months.nextFrom, state.months.nextThru)
        // the localization's payee, an authority with no bank account a PPD file could pay
        state.authority = prefix + "_AUTHORITY"
        call("create#mantle.party.Party", {partyId: state.authority, partyTypeEnumId: "PtyOrganization"})
        call("create#mantle.party.Organization", {partyId: state.authority, organizationName: "Obligations levy authority"})
        // a live localization of this spec's own: real (not the demonstration), covering today, calculating as the demonstration
        state.live = prefix + "_LIVE"
        call("create#mantle.humanres.payroll.PayrollLocalization", {
            payrollLocalizationId: state.live,
            localizationName: "Obligations spec localization",
            calculationServiceName: "mantle.humanres.PayrollLocalizationServices.calculate#Demonstration",
            coverageFromDate: "2000-01-01T00:00:00Z",
            releaseVersion: "1",
            isDemonstration: "N"
        })
        state.salaryC = component("SALARY", "PckEarning", {
            formula: "round(annualSalary / periodsPerYear, 2)",
            inputNames: "annualSalary,periodsPerYear",
            expenseGlAccountId: "631100000",
            liabilityGlAccountId: "224000000"
        })
        // a claim's reimbursement: paid on the claim's own invoice, never posted again
        state.reimburse = component("REIMB", "PckEarning", {
            formula: "reimbursement",
            inputNames: "reimbursement",
            expenseGlAccountId: "631100000",
            liabilityGlAccountId: "224000000"
        })
        // the employer's overpayment recovery: a deduction posting back to the wage expense
        state.recovery = component("RECOVER", "PckDeduction", {amount: "0", liabilityGlAccountId: "631100000"})
        call("create#mantle.humanres.payroll.PayrollStructure", {
            payrollStructureId: prefix + "_SAL",
            organizationPartyId: state.org,
            structureName: "Obligations salaried",
            currencyUomId: "USD",
            payBasisEnumId: "PpbSalaried",
            statusId: "PtsPublished",
            fromDate: "2000-01-01T00:00:00Z"
        })
        ;[state.salaryC, state.reimburse].forEach((payrollComponentId, index) =>
            call("create#mantle.humanres.payroll.PayrollStructureComponent", {
                payrollStructureId: prefix + "_SAL",
                payrollComponentId,
                statusId: "PtsPublished",
                fromDate: "2000-01-01T00:00:00Z",
                sequenceNum: index + 1
            })
        )
        state.demo = prefix + "_DEMO"
        group(state.demo, "PlzDemonstration")
        // the live group (made live in the first feature), its localization's amounts paid to the authority
        state.group = prefix + "_LIVEGRP"
        group(state.group, state.live, {
            localizationPayeePartyId: state.authority,
            localizationLiabilityGlAccountId: "224000000",
            localizationExpenseGlAccountId: "631100000"
        })
        state.EMP = person("EMP")
        state.EMPEmp = employ(state.EMP)
        state.LEFT = person("LEFT")
        state.LEFTEmp = employ(state.LEFT)
        state.DEMO = person("DEMO")
        state.DEMOEmp = employ(state.DEMO)
        // 1,020.41 a month: the 2% levy 20.41, a wage net of 1,000.00 (the design's example)
        assign(state.EMPEmp, state.EMP, state.group, "12244.92")
        assign(state.LEFTEmp, state.LEFT, state.group, "12000")
        assign(state.DEMOEmp, state.DEMO, state.demo, "12000")
        state.payroll = account("PAYROLL", ["PAYROLL_VIEW", "PAYROLL_EDIT"])
        state.configurer = account("CONFIG", ["PAYROLL_VIEW", "PAYROLL_EDIT", "PAYROLL_CONFIGURE"])
        state.approver = account("APPROVER", ["PAYROLL_VIEW", "PAYROLL_APPROVE"])
        const finance = ["ACCOUNTING_VIEW", "PAYABLE_VIEW", "PAYABLE_EDIT", "INVOICE_APPROVE", "PAYMENT_EDIT"]
        state.finance = account("FINANCE", finance.concat(["PAYROLL_VIEW"]))
        state.financeOnly = account("FINANCEONLY", finance)
        state.runApprover = account("RUNAPP", ["PAYABLE_VIEW", "PAYMENT_RUN_APPROVE", "PAYROLL_VIEW"])
        // Emp's claim of 100, approved and reserved for payroll, and its pay input as prepare#Inputs makes one
        state.claim = prefix + "_CLAIM"
        bill(state.claim, state.EMP, "100", "ItemExpense")
        call("create#mantle.humanres.expense.ExpenseClaim", {
            invoiceId: state.claim,
            partyRelationshipId: state.EMPEmp,
            partyId: state.EMP,
            organizationPartyId: state.org,
            statusEnumId: "EcsApproved",
            routeEnumId: "EcrPayroll",
            reservedRouteEnumId: "EcrPayroll",
            reservedReference: "Payroll",
            reservedDate: ec.user.nowTimestamp
        })
        const claimInput = call("create#mantle.humanres.payroll.PayrollInput", {
            partyRelationshipId: state.EMPEmp,
            partyId: state.EMP,
            organizationPartyId: state.org,
            payrollGroupId: state.group,
            timePeriodId: state.period,
            inputTypeEnumId: "PitReimbursement",
            inputName: "reimbursement",
            inputDate: state.months.from,
            amount: "100",
            currencyUomId: "USD",
            statusId: "PinApproved",
            entitlementKey: "CLAIM:" + state.claim,
            activeEntitlementKey: "CLAIM:" + state.claim,
            isAdjustment: "N"
        }).payrollInputId
        call("create#mantle.humanres.payroll.PayrollInputSource", {
            payrollInputId: claimInput,
            sourceEntityName: "mantle.humanres.expense.ExpenseClaim",
            sourceId: state.claim,
            sourcePart: "claim",
            sourceKey: "mantle.humanres.expense.ExpenseClaim:" + state.claim,
            activeSourceKey: "mantle.humanres.expense.ExpenseClaim:" + state.claim,
            amount: "100"
        })
        // Emp's advance of 40, paid out by a delivered payment on its bill
        state.advance = prefix + "_ADVANCE"
        bill(prefix + "_ADVBILL", state.EMP, "40", "ItemAdvancePay")
        call("update#mantle.account.invoice.Invoice", {invoiceId: prefix + "_ADVBILL", statusId: "InvoiceApproved"})
        call("create#mantle.humanres.expense.EmployeeAdvance", {
            employeeAdvanceId: state.advance,
            partyRelationshipId: state.EMPEmp,
            partyId: state.EMP,
            organizationPartyId: state.org,
            currencyUomId: "USD",
            amount: "40",
            statusEnumId: "EasApproved",
            invoiceId: prefix + "_ADVBILL"
        })
        call("create#mantle.account.payment.Payment", {
            paymentId: prefix + "_ADVPAY",
            statusId: "PmntDelivered",
            fromPartyId: state.org,
            toPartyId: state.EMP,
            amount: "40",
            amountUomId: "USD"
        })
        call("create#mantle.account.payment.PaymentApplication", {
            paymentApplicationId: prefix + "_ADVAPP",
            paymentId: prefix + "_ADVPAY",
            invoiceId: prefix + "_ADVBILL",
            amountApplied: "40"
        })
        // the employer's bank account, and Emp's: a payroll account and a newer general one
        const bank = (ownerPartyId, accountNumber, extra = {}) =>
            call(
                "mantle.account.PaymentMethodServices.create#BankAccount",
                Object.assign(
                    {
                        ownerPartyId,
                        description: ownerPartyId + " " + accountNumber,
                        bankName: "Obligations Bank",
                        routingNumber: "021000021",
                        accountNumber,
                        typeEnumId: "BatChecking",
                        currencyUomId: "USD",
                        companyNameOnAccount: ownerPartyId
                    },
                    extra
                )
            ).paymentMethodId
        state.bank = bank(state.org, "5550001111", {
            nachaImmedDest: "021000021",
            nachaImmedOrig: "1234567890",
            nachaCompanyId: "1234567890",
            nachaEntryDescription: "PAYROLL"
        })
        state.payrollAccount = bank(state.EMP, "7770001", {purposeEnumId: "PmpPayroll", fromDate: "2020-01-01T00:00:00Z"})
        state.otherAccount = bank(state.EMP, "7770002")
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature("a group is live only with a real localization: the demonstration group's finalize is refused with its two reasons", {
    when() {
        const demoRun = approvedRun(state.demo, state.period)
        const detail = run(state.payroll, R + "get#Run", {payrollRunId: demoRun})
        const refused = run(state.payroll, R + "finalize#Run", {payrollRunId: demoRun})
        const revision = groupId =>
            run(state.configurer, S + "find#Groups", {payrollGroupId: groupId}).group?.revision ||
            run(state.configurer, S + "find#Groups", {}).groups.find(row => row.payrollGroupId === groupId)?.revision
        const demoLive = run(state.configurer, S + "store#Group", {
            payrollGroupId: state.demo,
            expectedRevision: revision(state.demo),
            liveEnabled: "Y",
            reason: "Go live"
        })
        const liveOn = run(state.configurer, S + "store#Group", {
            payrollGroupId: state.group,
            expectedRevision: revision(state.group),
            liveEnabled: "Y",
            reason: "Go live"
        })
        return {detail, refused, demoLive, liveOn, slips: rows(SLIP, {payrollRunId: demoRun})}
    },
    then({detail, refused, demoLive, liveOn, slips}) {
        detail.run.liveReasons.map(reason => reason.reasonCode) == ["PREVIEW_ONLY", "LIVE_NOT_ENABLED"]
        !detail.canFinalize
        code(refused) == "NOT_LIVE"
        refused.error.includes("PREVIEW_ONLY")
        refused.error.includes("LIVE_NOT_ENABLED")
        // its approved results stay preview slips, never final
        slips.every(slip => slip.statusId == "PssPreview")
        code(demoLive) == "LIVE_NOT_AVAILABLE"
        liveOn.error == ""
        one("mantle.humanres.payroll.PayrollGroup", {payrollGroupId: state.group}).liveEnabled == "Y"
    }
})

feature("finalizing releases nothing until every employee and the payee's amounts are made, then each obligation once", {
    when() {
        // the localization's payee lost (a party that is none, as data), so the finalization cannot finish at once
        call("update#mantle.humanres.payroll.PayrollGroup", {
            payrollGroupId: state.group,
            localizationPayeePartyId: prefix + "_NO_SUCH_PARTY"
        })
        state.regular = approvedRun(state.group, state.period)
        const claimBefore = code(
            run(state.finance, "mantle.account.InvoiceServices.approve#Payable", {
                invoiceId: state.claim,
                lastUpdatedStamp: one(INVOICE, {invoiceId: state.claim}).lastUpdatedStamp
            })
        )
        // the finalizing caller's transaction rolled back (a timeout, say) after the employees' own transactions committed: the run
        // stays Finalizing, so the retry below goes on (the P27 review: it went back to Approved, its approval no longer holding)
        login(state.payroll)
        ec.artifactExecution.disableAuthz()
        ec.message.pushErrors()
        try {
            ec.transaction.runRequireNew(null, "The spec's caller rolled back", () => {
                ec.service
                    .sync()
                    .name(R + "finalize#Run")
                    .parameters({payrollRunId: state.regular})
                    .call()
                throw new Error("SPEC_ROLLBACK: the caller's transaction rolled back")
            })
        } catch (error) {
            // the caller's rollback, as meant
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
            login("john.doe")
            ec.artifactExecution.disableAuthz()
        }
        const rolledBack = one("mantle.humanres.payroll.PayrollRun", {payrollRunId: state.regular}).statusId
        const pending = run(state.payroll, R + "finalize#Run", {payrollRunId: state.regular})
        const net = obligationOf(state.regular, "PokNetPay", state.EMP)
        const netStatus = one(INVOICE, {invoiceId: net.invoiceId}).statusId
        const approveEarly = code(
            run(state.finance, "mantle.account.InvoiceServices.approve#Payable", {
                invoiceId: net.invoiceId,
                lastUpdatedStamp: one(INVOICE, {invoiceId: net.invoiceId}).lastUpdatedStamp
            })
        )
        const settlementPending = run(state.payroll, R + "get#Settlement", {payrollRunId: state.regular})
        // the payee fixed, a retry finishes; another makes nothing again
        call("update#mantle.humanres.payroll.PayrollGroup", {
            payrollGroupId: state.group,
            localizationPayeePartyId: state.authority
        })
        const done = run(state.payroll, R + "finalize#Run", {payrollRunId: state.regular})
        const again = run(state.payroll, R + "finalize#Run", {payrollRunId: state.regular})
        const hr = run(account("HR", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"]), R + "finalize#Run", {payrollRunId: state.regular})
        const payee = obligationOf(state.regular, "PokPayee")
        const items = rows(ITEM, {invoiceId: net.invoiceId})
        return {
            claimBefore,
            rolledBack,
            pending,
            net,
            netStatus,
            approveEarly,
            settlementPending,
            done,
            again,
            hr: code(hr),
            payee,
            items,
            invoicesFromEmp: rows(INVOICE, {fromPartyId: state.EMP, toPartyId: state.org}).map(row => row.invoiceId),
            slips: rows(SLIP, {payrollRunId: state.regular}),
            claimLink: obligationOf(state.regular, "PokClaim", state.EMP),
            inputs: rows("mantle.humanres.payroll.PayrollInput", {payrollRunId: state.regular})
        }
    },
    then({
        claimBefore,
        rolledBack,
        pending,
        net,
        netStatus,
        approveEarly,
        settlementPending,
        done,
        again,
        hr,
        payee,
        items,
        invoicesFromEmp,
        slips,
        claimLink,
        inputs
    }) {
        // before finalization the claim is payroll's, not finance's
        claimBefore == "CLAIM_RESERVED"
        rolledBack == "PrnFinalizing"
        // the payee could not be invoiced: the employees are final, but nothing is released to Accounting
        pending.error == ""
        pending.statusId == "PrnFinalizing"
        !pending.complete
        netStatus == "InvoiceIncoming"
        approveEarly == "PAYROLL_NOT_FINALIZED"
        settlementPending.pendingText.includes("payee")
        done.statusId == "PrnFinalized"
        done.complete
        one(INVOICE, {invoiceId: net.invoiceId}).statusId == "InvoiceReceived"
        again.repeated
        again.obligationCount == done.obligationCount
        hr == "PERMISSION_DENIED"
        // Emp's wage net: salary 1,020.41 on the wage expense, the 2% levy 20.41 withheld on its liability; no reimbursement line
        money(net.amount) == "1000.00"
        total(net.invoiceId) == "1000.00"
        one(INVOICE, {invoiceId: net.invoiceId}).invoiceTypeEnumId == "InvoicePayroll"
        items.length == 2
        items.some(item => money(item.amount) == "1020.41" && item.overrideGlAccountId == "631100000")
        items.some(item => money(item.amount) == "-20.41" && item.overrideGlAccountId == "224000000")
        // the claim linked as it is: no second invoice of its 100
        claimLink.invoiceId == state.claim
        money(claimLink.amount) == "100.00"
        invoicesFromEmp.length == 3
        // the authority's invoice: both employees' levies, withheld and the employer's (20.41 + 10.20 + 20.00 + 10.00)
        total(payee.invoiceId) == "60.61"
        one(INVOICE, {invoiceId: payee.invoiceId}).fromPartyId == state.authority
        slips.length == 2
        // each final slip's statement issued once the run is finalized (the user's call of Nov 13, 2026), and not again
        done.issuedCount == 2
        again.issuedCount == 0
        slips.every(slip => slip.statusId == "PssIssued" && slip.isPreview == "N" && !!slip.contentLocation)
        inputs.every(input => input.statusId == "PinFinalized")
    }
})

feature("Accounting settles: the 100 claim less a 40 advance and the 1,000 wage net are 1,060 in one payroll payment", {
    when() {
        const stamp = invoiceId => one(INVOICE, {invoiceId}).lastUpdatedStamp
        const net = obligationOf(state.regular, "PokNetPay", state.EMP).invoiceId
        const payee = obligationOf(state.regular, "PokPayee").invoiceId
        // a finance user without PAYROLL_VIEW: the payroll invoice is missing to them, as the claim is not
        // an existing database: the employer's payroll posting mappings missing, as before P27; the data update adds them
        const PTGA = "mantle.ledger.config.PaymentTypeGlAccount"
        const ITTT = "mantle.ledger.config.InvoiceTypeTransType"
        const mappings = () =>
            rows(PTGA, {organizationPartyId: state.org, paymentTypeEnumId: "PtPayrollPayment"}).length +
            rows(ITTT, {organizationPartyId: state.org, invoiceTypeEnumId: "InvoicePayroll", isPayable: "N"}).length
        const mappingsBefore = mappings()
        ec.entity
            .find(PTGA)
            .condition({organizationPartyId: state.org, paymentTypeEnumId: "PtPayrollPayment"})
            .disableAuthz()
            .deleteAll()
        ec.entity
            .find(ITTT)
            .condition({organizationPartyId: state.org, invoiceTypeEnumId: "InvoicePayroll", isPayable: "N"})
            .disableAuthz()
            .deleteAll()
        const mappingsRemoved = mappings()
        const migrated = call("mantle.account.PayrollOriginServices.migrate#PayrollOrigin")
        const mappingsAfter = mappings()
        const financeOnly = run(state.financeOnly, "mantle.account.InvoiceServices.find#Payables", {
            organizationPartyId: state.org,
            queue: "all",
            pageSize: 100
        })
        const financeOnlyApprove = code(
            run(state.financeOnly, "mantle.account.InvoiceServices.approve#Payable", {
                invoiceId: net,
                lastUpdatedStamp: stamp(net)
            })
        )
        const financeList = run(state.finance, "mantle.account.InvoiceServices.find#Payables", {
            organizationPartyId: state.org,
            queue: "all",
            pageSize: 100
        })
        const claim = run(state.finance, "mantle.account.InvoiceServices.approve#Payable", {
            invoiceId: state.claim,
            lastUpdatedStamp: stamp(state.claim)
        })
        const applied = run(state.finance, "mantle.humanres.ExpenseServices.apply#Advance", {
            employeeAdvanceId: state.advance,
            invoiceId: state.claim
        })
        const claimUnpaid = unpaid(state.claim)
        const netApproved = run(state.finance, "mantle.account.InvoiceServices.approve#Payable", {
            invoiceId: net,
            lastUpdatedStamp: stamp(net)
        })
        run(state.finance, "mantle.account.InvoiceServices.approve#Payable", {invoiceId: payee, lastUpdatedStamp: stamp(payee)})
        const settlement = run(state.payroll, R + "get#Settlement", {payrollRunId: state.regular})
        // an ACH run pays Emp's two bills from his payroll account, and leaves the authority to its own channel
        const today = ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd")
        const made = run(state.finance, "mantle.account.PaymentRunServices.create#Run", {
            organizationPartyId: state.org,
            paymentMethodId: state.bank,
            paymentInstrumentEnumId: "PiAch",
            dueThroughDate: "2099-12-31",
            payDate: today
        })
        const items = rows("mantle.account.payment.PaymentRunItem", {paymentRunId: made.paymentRunId})
        const masked = run(state.financeOnly, "mantle.account.PaymentRunServices.get#Run", {paymentRunId: made.paymentRunId})
        const approved = run(state.runApprover, "mantle.account.PaymentRunServices.approve#Run", {
            paymentRunId: made.paymentRunId,
            lastUpdatedStamp: one("mantle.account.payment.PaymentRun", {paymentRunId: made.paymentRunId}).lastUpdatedStamp
        })
        const executed = run(state.finance, "mantle.account.PaymentRunServices.execute#Run", {
            paymentRunId: made.paymentRunId,
            operationKey: prefix + "-RUN"
        })
        const paymentIds = [...new Set(items.filter(item => item.supplierPartyId === state.EMP).map(item => item.invoiceId))].map(
            invoiceId => one("mantle.account.payment.PaymentRunItem", {paymentRunId: made.paymentRunId, invoiceId}).paymentId
        )
        return {
            mappingsBefore,
            mappingsRemoved,
            migrated,
            mappingsAfter,
            financeOnly,
            financeOnlyApprove,
            financeList,
            claim,
            applied,
            claimUnpaid,
            netApproved,
            settlement,
            net,
            payee,
            items,
            masked,
            approved,
            executed,
            paymentIds,
            payment: paymentIds[0] ? one("mantle.account.payment.Payment", {paymentId: paymentIds[0]}) : null
        }
    },
    then({
        mappingsBefore,
        mappingsRemoved,
        migrated,
        mappingsAfter,
        financeOnly,
        financeOnlyApprove,
        financeList,
        claim,
        applied,
        claimUnpaid,
        netApproved,
        settlement,
        net,
        payee,
        items,
        masked,
        approved,
        executed,
        paymentIds,
        payment
    }) {
        // the employer's three payroll mappings (PtPayrollPayment applied and unapplied, a receivable InvoicePayroll) put back
        mappingsBefore == 3
        mappingsRemoved == 0
        migrated.mappingCount >= 3
        mappingsAfter == 3
        // AC-23: the same list and approval, refused for PAYROLL_VIEW alone
        !financeOnly.records.some(row => row.invoiceId == net)
        financeOnly.records.some(row => row.invoiceId == state.claim)
        financeOnlyApprove == "INVOICE_UNAVAILABLE"
        financeList.records.some(row => row.invoiceId == net)
        claim.statusId == "InvoiceApproved"
        applied.error == ""
        claimUnpaid == "60.00"
        // paid: the claim and the net pay settled by the one payment
        unpaid(state.claim) == "0.00"
        unpaid(net) == "0.00"
        netApproved.statusId == "InvoiceApproved"
        // the settlement: wage net 1,000, reimbursement still due 60, a payment instruction of 1,060
        settlement.people.find(row => row.partyId == state.EMP).wageNetText.includes("1,000.00")
        settlement.people.find(row => row.partyId == state.EMP).reimbursementDueText.includes("60.00")
        settlement.people.find(row => row.partyId == state.EMP).instructionText.includes("1,060.00")
        settlement.obligations.some(row => row.invoiceId == net && row.postedText == "Posted")
        items.filter(item => item.supplierPartyId == state.EMP && item.selectedIndicator == "Y").length == 2
        items.filter(item => item.supplierPartyId == state.EMP).every(item => item.toPaymentMethodId == state.payrollAccount)
        items.find(item => item.invoiceId == payee).excludeReasonEnumId == "PrxPayeeChannel"
        // a finance reader of the run without PAYROLL_VIEW sees the net pay as one masked amount, the claim as any bill
        !masked.runItems.some(row => row.invoiceId == net)
        masked.runItems.some(row => row.invoiceId == state.claim)
        masked.run.payrollMaskedCount == 1
        approved.statusId == "PrunApproved"
        executed.error == ""
        paymentIds.length == 2
        paymentIds[0] == paymentIds[1]
        payment.paymentTypeEnumId == "PtPayrollPayment"
        money(payment.amount) == "1060.00"
        payment.toPaymentMethodId == state.payrollAccount
    }
})

feature("a negative correction is recovered: by capped deductions on the next run, or from a leaver as a receivable", {
    when() {
        const slipOf = partyRelationshipId => one(SLIP, {payrollRunId: state.regular, partyRelationshipId}).payslipId
        // Emp's salary was too high: 6,000 a year from the start
        const salary = rows("mantle.humanres.employment.EmploymentSalary", {partyRelationshipId: state.EMPEmp})[0]
        call("update#mantle.humanres.employment.EmploymentSalary", {
            partyRelationshipId: state.EMPEmp,
            fromDate: salary.fromDate,
            amount: "6000"
        })
        const empCorrection = run(state.payroll, R + "create#Correction", {
            payslipId: slipOf(state.EMPEmp),
            reason: "Salary entered too high"
        })
        approve(empCorrection.payrollRunId)
        // no recovery deduction set up: that employee stays pending; set up, a retry finishes
        const noSetup = run(state.payroll, R + "finalize#Run", {payrollRunId: empCorrection.payrollRunId})
        // the employer's recovery set on Overpayment recovery (the user's call of Nov 13, 2026): its deduction, and at most 30% of
        // net pay a period; refused to the payroll operator (no PAYROLL_CONFIGURE), a percentage above 100, and a stale read
        const settings = () =>
            run(state.configurer, S + "get#RecoverySettings", {organizationPartyId: state.org}).employers?.[0] || {}
        const recoveryValues = {
            organizationPartyId: state.org,
            expectedRevision: settings().revision,
            payrollComponentId: state.recovery,
            capPercent: "30"
        }
        const settingRefusals = {
            operator: code(run(state.payroll, S + "store#RecoverySettings", recoveryValues)),
            above100: code(
                run(state.configurer, S + "store#RecoverySettings", Object.assign({}, recoveryValues, {capPercent: "150"}))
            ),
            stale: code(
                run(state.configurer, S + "store#RecoverySettings", Object.assign({}, recoveryValues, {expectedRevision: "1"}))
            )
        }
        const stored = run(state.configurer, S + "store#RecoverySettings", recoveryValues)
        const settingsRead = settings()
        const finalized = run(state.payroll, R + "finalize#Run", {payrollRunId: empCorrection.payrollRunId})
        const correctionSlip = one(SLIP, {payrollRunId: empCorrection.payrollRunId}).payslipId
        // the next period: its input recovers the cap, its run deducts it
        const prepared = run(state.payroll, I + "prepare#Inputs", {payrollGroupId: state.group, timePeriodId: state.next})
        const nextRun = approvedRun(state.group, state.next)
        const nextFinal = run(state.payroll, R + "finalize#Run", {payrollRunId: nextRun})
        const afterNext = run(state.payroll, "mantle.humanres.PayrollResultServices.get#Payslip", {payslipId: correctionSlip})
        // Left's employment ended before the period (a backdated separation): the group no longer pays him in it, and his
        // correction recovers the period's pay from him as a receivable
        call("update#mantle.party.PartyRelationship", {
            partyRelationshipId: state.LEFTEmp,
            thruDate: ec.l10n.parseTimestamp(state.months.from + " 00:00:00", "yyyy-MM-dd HH:mm:ss")
        })
        const leftCorrection = run(state.payroll, R + "create#Correction", {
            payslipId: slipOf(state.LEFTEmp),
            reason: "Left before the period"
        })
        approve(leftCorrection.payrollRunId)
        const leftFinal = run(state.payroll, R + "finalize#Run", {payrollRunId: leftCorrection.payrollRunId})
        const receivable = obligationOf(leftCorrection.payrollRunId, "PokReceivable", state.LEFT)
        const receivableInvoice = receivable ? one(INVOICE, {invoiceId: receivable.invoiceId}) : null
        // Accounting finalizes the receivable: it posts (InvoicePayroll's receivable mapping), marked payroll-origin
        if (receivable)
            call("update#mantle.account.invoice.Invoice", {invoiceId: receivable.invoiceId, statusId: "InvoiceFinalized"})
        const receivableTrans = receivable ? rows("mantle.ledger.transaction.AcctgTrans", {invoiceId: receivable.invoiceId}) : []
        const receivableDebit = receivableTrans.length
            ? rows("mantle.ledger.transaction.AcctgTransEntry", {acctgTransId: receivableTrans[0].acctgTransId}).find(
                  entry => entry.debitCreditFlag === "D" && money(entry.amount) === "980.00"
              )
            : null
        return {
            settingRefusals,
            stored,
            settingsRead,
            receivableTrans,
            receivableDebit,
            empCorrection,
            noSetup,
            finalized,
            recovery: one("mantle.humanres.payroll.PayrollRecovery", {payslipId: correctionSlip}),
            prepared,
            nextFinal,
            nextNet: obligationOf(nextRun, "PokNetPay", state.EMP),
            afterNext,
            leftCorrection,
            leftFinal,
            receivable,
            receivableInvoice
        }
    },
    then({
        settingRefusals,
        stored,
        settingsRead,
        receivableTrans,
        receivableDebit,
        empCorrection,
        noSetup,
        finalized,
        recovery,
        prepared,
        nextFinal,
        nextNet,
        afterNext,
        leftCorrection,
        leftFinal,
        receivable,
        receivableInvoice
    }) {
        empCorrection.error == ""
        noSetup.statusId == "PrnFinalizing"
        noSetup.message.includes("RECOVERY_SETUP_MISSING")
        settingRefusals == {operator: "PERMISSION_DENIED", above100: "CAP_INVALID", stale: "REVISION_CHANGED"}
        stored.error == ""
        settingsRead.payrollComponentId == state.recovery
        settingsRead.capPercent == "30"
        settingsRead.capText.includes("30% of net pay")
        finalized.statusId == "PrnFinalized"
        // 500.00 a month now: salary 520.41 less, the levy 10.41 less: 510.00 overpaid, on the payroll route
        money(recovery.amount) == "510.00"
        recovery.recoveryRouteEnumId == "PrcPayroll"
        prepared.createdCount >= 1
        nextFinal.statusId == "PrnFinalized"
        // the next month: 500.00 less the 10.00 levy less the 300.00 recovered (the cap: 30% of the 1,000.00 wage net of Emp's last
        // regular run)
        money(nextNet.amount) == "190.00"
        afterNext.settlement.recovery.recoveredText.includes("300.00")
        afterNext.settlement.recovery.remainingText.includes("210.00")
        // the group no longer pays Left in the period (P26's NOT_IN_GROUP lifted for a leaver): 980.00 to recover from him
        leftCorrection.error == ""
        leftFinal.statusId == "PrnFinalized"
        money(receivable.amount) == "980.00"
        receivableInvoice.fromPartyId == state.org
        receivableInvoice.toPartyId == state.LEFT
        receivableInvoice.statusId == "InvoiceInProcess"
        total(receivable.invoiceId) == "980.00"
        // it posts: the 980.00 on accounts receivable, the transaction payroll-origin
        receivableTrans.length == 1
        receivableTrans[0].isPosted == "Y"
        receivableTrans[0].payrollOrigin == "Y"
        receivableDebit.glAccountId == "121000000"
        money(receivableDebit.amount) == "980.00"
    }
})

feature(
    "a pension deduction and the employer's contribution are paid to the fund: one invoice from it, the contribution posted",
    {
        when() {
            // the user's call of Nov 13, 2026: a component's term names its payee; refused for an earning
            state.fund = prefix + "_FUND"
            call("create#mantle.party.Party", {partyId: state.fund, partyTypeEnumId: "PtyOrganization"})
            call("create#mantle.party.Organization", {partyId: state.fund, organizationName: "Obligations pension fund"})
            const earningPayee = code(
                run(state.configurer, S + "store#Component", {
                    organizationPartyId: state.org,
                    componentCode: "BONUS_PAYEE",
                    componentName: "Bonus",
                    componentKindEnumId: "PckEarning",
                    basisEnumId: "PcbAmount",
                    amount: "10",
                    currencyUomId: "USD",
                    expenseGlAccountId: "631100000",
                    payeePartyId: state.fund
                })
            )
            const pension = component("PENSION", "PckDeduction", {
                amount: "50",
                liabilityGlAccountId: "224000000",
                payeePartyId: state.fund
            })
            const employer = component("PENSION_ER", "PckContribution", {
                amount: "30",
                expenseGlAccountId: "631100000",
                liabilityGlAccountId: "224000000",
                payeePartyId: state.fund
            })
            call("create#mantle.humanres.payroll.PayrollStructure", {
                payrollStructureId: prefix + "_PEN",
                organizationPartyId: state.org,
                structureName: "Obligations with a pension",
                currencyUomId: "USD",
                payBasisEnumId: "PpbSalaried",
                statusId: "PtsPublished",
                fromDate: "2000-01-01T00:00:00Z"
            })
            ;[state.salaryC, pension, employer].forEach((payrollComponentId, index) =>
                call("create#mantle.humanres.payroll.PayrollStructureComponent", {
                    payrollStructureId: prefix + "_PEN",
                    payrollComponentId,
                    statusId: "PtsPublished",
                    fromDate: "2000-01-01T00:00:00Z",
                    sequenceNum: index + 1
                })
            )
            const penGroup = prefix + "_PENGRP"
            group(penGroup, state.live, {
                localizationPayeePartyId: state.authority,
                localizationLiabilityGlAccountId: "224000000",
                localizationExpenseGlAccountId: "631100000",
                liveEnabled: "Y"
            })
            const PEN = person("PEN")
            const penEmp = employ(PEN)
            call("create#mantle.humanres.payroll.PayrollAssignment", {
                partyRelationshipId: penEmp,
                partyId: PEN,
                organizationPartyId: state.org,
                payrollStructureId: prefix + "_PEN",
                payrollGroupId: penGroup,
                isPrimary: "Y",
                fromDate: "2026-01-01T00:00:00Z"
            })
            call("create#mantle.humanres.employment.EmploymentSalary", {
                partyRelationshipId: penEmp,
                fromDate: "2026-01-01T00:00:00Z",
                amount: "12000",
                currencyUomId: "USD",
                timePeriodTypeId: "PayrollYear"
            })
            const penRun = approvedRun(penGroup, state.period)
            const finalized = run(state.payroll, R + "finalize#Run", {payrollRunId: penRun})
            const payees = obligations(penRun).filter(row => row.obligationKindEnumId === "PokPayee")
            const fundObligation = payees.find(row => row.payeePartyId === state.fund)
            const fundInvoice = fundObligation?.invoiceId
            // Accounting approves the fund's invoice: it posts the withheld pension off its liability and the contribution's expense
            const approved = fundInvoice
                ? run(state.finance, "mantle.account.InvoiceServices.approve#Payable", {
                      invoiceId: fundInvoice,
                      lastUpdatedStamp: one(INVOICE, {invoiceId: fundInvoice}).lastUpdatedStamp
                  })
                : {}
            const trans = fundInvoice ? rows("mantle.ledger.transaction.AcctgTrans", {invoiceId: fundInvoice}) : []
            return {
                earningPayee,
                finalized,
                net: obligationOf(penRun, "PokNetPay", PEN),
                payees,
                fundObligation,
                fundInvoice: fundInvoice ? one(INVOICE, {invoiceId: fundInvoice}) : null,
                fundItems: fundInvoice ? rows(ITEM, {invoiceId: fundInvoice}) : [],
                authority: payees.find(row => row.payeePartyId === state.authority),
                approved,
                entries: trans.length
                    ? rows("mantle.ledger.transaction.AcctgTransEntry", {acctgTransId: trans[0].acctgTransId})
                    : []
            }
        },
        then({earningPayee, finalized, net, payees, fundObligation, fundInvoice, fundItems, authority, approved, entries}) {
            earningPayee == "PAYEE_NOT_FOR_KIND"
            finalized.statusId == "PrnFinalized"
            // the person's net pay: 1,000.00 less the 50.00 pension and the 20.00 levy withheld
            money(net.amount) == "930.00"
            // one invoice for each payee and liability: the authority's levy (20.00 withheld, 10.00 the employer's), the fund's pension
            payees.length == 2
            money(authority.amount) == "30.00"
            money(fundObligation.amount) == "80.00"
            fundInvoice.fromPartyId == state.fund
            fundInvoice.invoiceTypeEnumId == "InvoicePayroll"
            fundInvoice.payrollOrigin == "Y"
            fundItems.some(item => money(item.amount) == "50.00" && item.overrideGlAccountId == "224000000")
            fundItems.some(item => money(item.amount) == "30.00" && item.overrideGlAccountId == "631100000")
            approved.error == ""
            // posted: the pension off its liability, the contribution on the wage expense, 80.00 owed to the fund
            entries.some(
                entry => entry.debitCreditFlag == "D" && entry.glAccountId == "224000000" && money(entry.amount) == "50.00"
            )
            entries.some(
                entry => entry.debitCreditFlag == "D" && entry.glAccountId == "631100000" && money(entry.amount) == "30.00"
            )
            entries.some(entry => entry.debitCreditFlag == "C" && money(entry.amount) == "80.00")
        }
    }
)

// The user's calls of Nov 13, 2026 (impl-people P28 and its review): the percentage cap is a share of the employee's last finalized
// regular wage net; with none yet the recovery waits a period (no input) or, when an amount cap is set too, recovers that amount; it
// is never uncapped. Both may be set (store#RecoverySettings): once there is a net, its percentage applies, at most the amount. A new
// hire with no finalized pay and an overpayment to recover on the payroll route, planned for the next period as prepare#Inputs plans
// it (PayrollObligations.js recoveryInputs); then a finalized regular net of 1,000.00.
feature(
    "a percentage cap with no earlier net waits a period or takes the amount; with a net, the percentage at most the amount",
    {
        when() {
            const NEW = person("NEWHIRE")
            const newEmp = employ(NEW)
            call("create#mantle.humanres.payroll.PayrollRecovery", {
                payslipId: prefix + "_NOSLIP",
                payrollRunId: state.regular,
                partyRelationshipId: newEmp,
                partyId: NEW,
                organizationPartyId: state.org,
                payrollGroupId: state.group,
                currencyUomId: "USD",
                amount: "500",
                recoveryRouteEnumId: "PrcPayroll",
                payrollComponentId: state.recovery
            })
            const settings = () =>
                run(state.configurer, S + "get#RecoverySettings", {organizationPartyId: state.org}).employers?.[0] || {}
            const store = (capPercent, capAmount) =>
                run(state.configurer, S + "store#RecoverySettings", {
                    organizationPartyId: state.org,
                    expectedRevision: settings().revision,
                    payrollComponentId: state.recovery,
                    capPercent,
                    capAmount
                })
            const plan = () =>
                ec.resource
                    .script("component://mr-mantle/service/mantle/humanres/PayrollObligations.js")
                    .recoveryInputs(
                        {partyRelationshipId: newEmp},
                        one("mantle.humanres.payroll.PayrollGroup", {payrollGroupId: state.group}),
                        {timePeriodId: state.next, thruDay: state.months.nextThru}
                    )
                    .map(input => money(input.amount))
            const percentStored = store("30", "")
            const percentOnly = plan()
            const both = store("30", "40")
            const bothRead = settings()
            const withAmount = plan()
            // the new hire's first finalized regular net: 1,000.00, so 30% is 300.00
            call("create#mantle.humanres.payroll.PayrollObligation", {
                obligationKey: prefix + ":NEWHIRE:NET",
                obligationKindEnumId: "PokNetPay",
                payrollRunId: state.regular,
                partyRelationshipId: newEmp,
                partyId: NEW,
                organizationPartyId: state.org,
                payeePartyId: NEW,
                currencyUomId: "USD",
                amount: "1000"
            })
            const amountBounds = plan()
            store("30", "450")
            const percentApplies = plan()
            store("30", "")
            const percentAlone = plan()
            return {percentStored, percentOnly, both, bothRead, withAmount, amountBounds, percentApplies, percentAlone}
        },
        then({percentStored, percentOnly, both, bothRead, withAmount, amountBounds, percentApplies, percentAlone}) {
            percentStored.error == ""
            // no earlier net: nothing this period, never the whole 500.00
            percentOnly.length == 0
            // both kept together
            both.error == ""
            bothRead.capPercent == "30"
            bothRead.capAmount == "40"
            bothRead.capText.includes("at most 40")
            // before a first net, the amount
            withAmount == ["40.00"]
            // with a net of 1,000.00: 30% is 300.00, bounded by the amount 40.00, or within the amount 450.00
            amountBounds == ["40.00"]
            percentApplies == ["300.00"]
            percentAlone == ["300.00"]
        }
    }
)
