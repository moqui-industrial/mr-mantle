// People's expense claims and advances (mantle.humanres.ExpenseServices and create#ProjectExpenseInvoice's claim write; impl-people
// P15, F21, F65; design-people §9): a claimant creates only their own claim, and HR one for them; a line from mail is made once
// from the sender's work address and waits for review; the manager's approval leaves the invoice received, and finance approves it
// for payment only after it; a claim reserved for one settlement route is refused by the other, and a payment run leaves out one
// reserved for payroll; an approved advance is a bill a payment run pays, and its outstanding is what was delivered less what was
// applied to a claim; PEOPLE_EXPENSE_MANAGE (the user's call of Nov 12, 2026) reads and acts for an employee where HR view and edit
// alone do not. Standalone: spec-local organizations with their own books, people, employments,
// groups and users, with artifact authorization disabled (the rules are the services' own checks).
// Run: ./moq test mr-mantle --spec ExpenseClaims
const prefix = "PEOPLE_EXP_SPEC"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    since = "2001-01-01T00:00:00Z"
const E = "mantle.humanres.ExpenseServices."
const NEW_CLAIM = "mantle.account.InvoiceServices.create#ProjectExpenseInvoice"
const state = {}

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
function organization(partyId, name) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
    call("mantle.ledger.LedgerServices.init#PartyAccountingConfiguration", {
        organizationPartyId: partyId,
        sourcePartyId: "DefaultSettings",
        baseCurrencyUomId: "USD"
    })
    call("mantle.ledger.LedgerServices.get#OrganizationFiscalTimePeriods", {
        organizationPartyId: partyId,
        filterDate: ec.user.nowTimestamp
    })
}
function person(kind) {
    const partyId = prefix + "_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Expense", lastName: kind})
    return partyId
}
const employ = (partyId, organizationPartyId) =>
    call("mantle.humanres.EmploymentServices.create#Employment", {
        fromPartyId: partyId,
        toPartyId: organizationPartyId,
        fromDate: since
    }).partyRelationshipId
function user(kind, permissions, partyId) {
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "People expenses " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    call("create#moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        timeZone: "America/Chicago"
    })
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: since})
    return id
}
const claimRow = invoiceId => ec.entity.find("mantle.humanres.expense.ExpenseClaim").condition({invoiceId}).disableAuthz().one()
const invoiceRow = invoiceId => ec.entity.find("mantle.account.invoice.Invoice").condition({invoiceId}).disableAuthz().one()
const newClaim = (username, partyId, extra = {}) =>
    run(username, NEW_CLAIM, Object.assign({expenseClaim: true, fromPartyId: partyId, purpose: "Customer visit"}, extra))
const line = (username, invoiceId, amount, extra = {}) =>
    run(
        username,
        E + "store#ClaimItem",
        Object.assign(
            {
                invoiceId,
                itemTypeEnumId: "ItemExpTravMealsEnt",
                description: "Lunch with the customer",
                itemDate: "2026-03-02",
                amount
            },
            extra
        )
    )
// a claim of Ana's with one line of the amount, submitted and approved by Max
function approvedClaim(amount) {
    const made = newClaim(state.uAna, state.ana)
    line(state.uAna, made.invoiceId, amount)
    run(state.uAna, E + "submit#Claim", {invoiceId: made.invoiceId})
    run(state.uMgr, E + "decide#Claim", {invoiceId: made.invoiceId, decision: "approve"})
    return made.invoiceId
}
const payable = invoiceId =>
    run(state.finance, "mantle.account.InvoiceServices.approve#Payable", {
        invoiceId,
        organizationPartyId: orgA,
        lastUpdatedStamp: invoiceRow(invoiceId).lastUpdatedStamp
    })

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(orgA, "People Expense Spec A")
        organization(orgB, "People Expense Spec B")
        // Ana and Bob work for A, managed by Max; HR of A and of B; payroll of A; finance of A (an agent)
        state.ana = person("ANA")
        state.anaEmp = employ(state.ana, orgA)
        state.bob = person("BOB")
        employ(state.bob, orgA)
        state.max = person("MAX")
        employ(state.max, orgA)
        for (const report of [state.ana, state.bob])
            call("create#mantle.party.PartyRelationship", {
                relationshipTypeEnumId: "PrtManager",
                fromPartyId: state.max,
                toPartyId: report,
                fromDate: since
            })
        state.hrParty = person("HR")
        employ(state.hrParty, orgA)
        state.hrBParty = person("HRB")
        employ(state.hrBParty, orgB)
        state.payParty = person("PAY")
        employ(state.payParty, orgA)
        state.finParty = person("FIN")
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtAgent",
            fromPartyId: state.finParty,
            toPartyId: orgA,
            fromDate: since
        })
        call("mantle.party.ContactServices.create#EmailAddress", {
            partyId: state.ana,
            emailAddress: "ana.expense@spec.example.com",
            contactMechPurposeId: "EmailWork"
        })
        // Ana decides others' requests too, so her own claim is refused as her own, not for the permission
        state.uAna = user("ANA", ["PEOPLE_SELF_SERVICE", "PEOPLE_REQUEST_APPROVE"], state.ana)
        state.uBob = user("BOB", ["PEOPLE_SELF_SERVICE"], state.bob)
        state.uMgr = user("MAX", ["PEOPLE_SELF_SERVICE", "PEOPLE_TEAM_VIEW", "PEOPLE_REQUEST_APPROVE"], state.max)
        state.hr = user("HR", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT", "PEOPLE_EXPENSE_MANAGE"], state.hrParty)
        state.hrB = user("HRB", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT", "PEOPLE_EXPENSE_MANAGE"], state.hrBParty)
        // HR of A without the expense permission: refused what HR is accepted with
        state.hrOnly = user("HRONLY", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"], state.hrParty)
        state.payroll = user("PAY", ["PEOPLE_DIRECTORY_VIEW", "PAYROLL_VIEW", "PAYROLL_EDIT"], state.payParty)
        state.payrollReader = user("PAYV", ["PEOPLE_DIRECTORY_VIEW", "PAYROLL_VIEW"], state.payParty)
        state.finance = user(
            "FIN",
            ["ACCOUNTING_VIEW", "INVOICE_APPROVE", "PAYMENT_EDIT", "PAYABLE_VIEW", "PAYABLE_EDIT"],
            state.finParty
        )
        // A's bank account, which a payment run pays from by check
        state.bank = call("mantle.account.PaymentMethodServices.create#BankAccount", {
            ownerPartyId: orgA,
            description: "Operating account",
            bankName: "Spec Bank",
            routingNumber: "021000021",
            accountNumber: "5550001234",
            typeEnumId: "BatChecking",
            currencyUomId: "USD",
            companyNameOnAccount: "People Expense Spec A"
        }).paymentMethodId
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature("a claimant creates only their own claim; HR of the employer creates one for them; a retry answers the first", {
    when() {
        const own = newClaim(state.uAna, state.ana, {operationKey: "EXP-OWN"})
        const again = newClaim(state.uAna, state.ana, {operationKey: "EXP-OWN"})
        // Bob for Ana, with the parameters Ana's own claim succeeds with
        const forOther = newClaim(state.uBob, state.ana)
        const byHr = newClaim(state.hr, state.ana)
        const byHrOnly = newClaim(state.hrOnly, state.ana)
        const byOtherHr = newClaim(state.hrB, state.ana)
        // who reads Ana's claim: HR with the expense permission; HR without it and a payroll reader not (PAYROLL_VIEW reads none)
        const reads = Object.fromEntries(
            [
                ["hr", state.hr],
                ["hrOnly", state.hrOnly],
                ["payroll", state.payrollReader]
            ].map(([name, username]) => [name, code(run(username, E + "get#Claim", {invoiceId: own.invoiceId})) || "accepted"])
        )
        const project = newClaim(state.uAna, state.ana, {workEffortId: prefix + "_NO_PROJECT"})
        const notEmployed = newClaim(state.uAna, state.ana, {toPartyId: orgB})
        // HR cancels the draft it made: the claim and its invoice cancelled
        const cancelled = run(state.hr, E + "decide#Claim", {invoiceId: byHr.invoiceId, decision: "cancel"})
        return {own, again, forOther, byHr, byHrOnly, byOtherHr, reads, project, notEmployed, cancelled}
    },
    then({own, again, forOther, byHr, byHrOnly, byOtherHr, reads, project, notEmployed, cancelled}) {
        own.error == "" && again.invoiceId == own.invoiceId
        const claim = claimRow(own.invoiceId)
        claim.partyId == state.ana && claim.organizationPartyId == orgA && claim.partyRelationshipId == state.anaEmp
        claim.statusEnumId == "EcsDraft" && claim.routeEnumId == "EcrPayable" && claim.purpose == "Customer visit"
        const invoice = invoiceRow(own.invoiceId)
        invoice.fromPartyId == state.ana && invoice.toPartyId == orgA && invoice.statusId == "InvoiceIncoming"
        invoice.currencyUomId == "USD"
        code(forOther) == "PERMISSION_DENIED"
        byHr.error == "" && claimRow(byHr.invoiceId).createdByUserId == state.hr && claimRow(byHr.invoiceId).partyId == state.ana
        code(byHrOnly) == "PERMISSION_DENIED"
        code(byOtherHr) == "PERMISSION_DENIED"
        reads.hr == "accepted" && reads.hrOnly == "RECORD_UNAVAILABLE" && reads.payroll == "RECORD_UNAVAILABLE"
        code(project) == "PROJECT_UNAVAILABLE"
        code(notEmployed) == "NOT_EMPLOYED"
        cancelled.statusEnumId == "EcsCancelled" && invoiceRow(byHr.invoiceId).statusId == "InvoiceCancelled"
        state.claim = own.invoiceId
    }
})

feature(
    "a receipt by mail is a draft line made once from the sender's work address; the claim is submitted once it is reviewed",
    {
        when() {
            const empty = run(state.uAna, E + "submit#Claim", {invoiceId: state.claim})
            for (const [id, from] of [
                ["1", "Ana Expense <ana.expense@spec.example.com>"],
                ["2", "stranger@spec.example.com"]
            ])
                call("create#moqui.basic.email.EmailMessage", {
                    emailMessageId: prefix + "_MAIL" + id,
                    fromAddress: from,
                    subject: "Taxi to the airport",
                    body: "Yellow Cab, 2026-03-03, total 42.50 USD",
                    sentDate: ec.user.nowTimestamp
                })
            const mailed = run("john.doe", E + "create#ClaimLineFromEmail", {emailMessageId: prefix + "_MAIL1"})
            const mailedAgain = run("john.doe", E + "create#ClaimLineFromEmail", {emailMessageId: prefix + "_MAIL1"})
            const stranger = run("john.doe", E + "create#ClaimLineFromEmail", {emailMessageId: prefix + "_MAIL2"})
            const toReview = run(state.uAna, E + "submit#Claim", {invoiceId: state.claim})
            const reviewed = line(state.uAna, state.claim, "42.50", {
                invoiceItemSeqId: mailed.invoiceItemSeqId,
                itemTypeEnumId: "ItemExpTravLocal",
                description: "Taxi to the airport",
                merchantName: "Yellow Cab"
            })
            const meal = line(state.uAna, state.claim, "57.50", {taxAmount: "5"})
            const badTax = line(state.uAna, state.claim, "10", {taxAmount: "11"})
            // a page named as a receipt is refused whatever type its upload declares (it would be sent as html)
            const page = line(state.uAna, state.claim, "10", {
                receiptFile: {fileName: "receipt.html", contentType: "text/plain", size: 20}
            })
            const hrBLine = line(state.hrB, state.claim, "10")
            const submitted = run(state.uAna, E + "submit#Claim", {invoiceId: state.claim})
            const locked = line(state.uAna, state.claim, "1")
            const detail = run(state.uMgr, E + "get#Claim", {invoiceId: state.claim})
            return {
                empty,
                mailed,
                mailedAgain,
                stranger,
                toReview,
                reviewed,
                meal,
                badTax,
                page,
                hrBLine,
                submitted,
                locked,
                detail
            }
        },
        then({empty, mailed, mailedAgain, stranger, toReview, reviewed, meal, badTax, page, hrBLine, submitted, locked, detail}) {
            code(empty) == "LINES_REQUIRED"
            mailed.created && mailed.invoiceId == state.claim
            !mailedAgain.created && mailedAgain.invoiceItemSeqId == mailed.invoiceItemSeqId
            !stranger.created && !stranger.invoiceId
            code(toReview) == "LINES_TO_REVIEW"
            reviewed.error == "" && meal.error == ""
            code(badTax) == "TAX_INVALID"
            code(page) == "RECEIPT_INVALID"
            code(hrBLine) == "RECORD_UNAVAILABLE"
            submitted.statusEnumId == "EcsSubmitted" && submitted.receiptsMissing == 1
            code(locked) == "CLAIM_LOCKED"
            invoiceRow(state.claim).statusId == "InvoiceReceived"
            // the manager reads it, decides its step, and sees the mailed line's receipt
            detail.canDecide && detail.lines.length == 2 && detail.claim.totalText.includes("100")
            detail.lines.find(row => row.invoiceItemSeqId == mailed.invoiceItemSeqId).receiptName == "message.txt"
            detail.lines.find(row => row.invoiceItemSeqId == mailed.invoiceItemSeqId).merchantName == "Yellow Cab"
        }
    }
)

feature("the manager's approval leaves the invoice received; finance approves it for payment only after it", {
    when() {
        // a second claim, submitted and not decided: finance is refused it
        const pending = newClaim(state.uAna, state.ana)
        line(state.uAna, pending.invoiceId, "20")
        run(state.uAna, E + "submit#Claim", {invoiceId: pending.invoiceId})
        const early = payable(pending.invoiceId)
        const ownDecision = run(state.uAna, E + "decide#Claim", {invoiceId: state.claim, decision: "approve"})
        const outsider = run(state.hrB, E + "decide#Claim", {invoiceId: state.claim, decision: "approve"})
        const toDecide = run(state.uMgr, E + "find#Claims", {toDecide: true}).claims
        const queued = () =>
            run(state.finance, "mantle.account.InvoiceServices.find#Payables", {
                organizationPartyId: orgA,
                queue: "expenses"
            }).records.map(row => row.invoiceId)
        const queueBefore = queued()
        const approved = run(state.uMgr, E + "decide#Claim", {invoiceId: state.claim, decision: "approve"})
        const repeated = run(state.uMgr, E + "decide#Claim", {invoiceId: state.claim, decision: "approve"})
        const afterApproval = invoiceRow(state.claim).statusId
        const queueAfter = queued()
        const finance = payable(state.claim)
        // a return sends the pending claim back for correction
        const returned = run(state.uMgr, E + "decide#Claim", {
            invoiceId: pending.invoiceId,
            decision: "return",
            reason: "Add the receipt"
        })
        const mine = run(state.uAna, E + "find#Claims", {mine: true}).claims
        return {
            early,
            ownDecision,
            outsider,
            toDecide,
            approved,
            repeated,
            afterApproval,
            finance,
            returned,
            mine,
            pending,
            queueBefore,
            queueAfter
        }
    },
    then({
        early,
        ownDecision,
        outsider,
        toDecide,
        approved,
        repeated,
        afterApproval,
        finance,
        returned,
        mine,
        pending,
        queueBefore,
        queueAfter
    }) {
        code(early) == "CLAIM_NOT_APPROVED"
        code(ownDecision) == "SELF_APPROVAL"
        code(outsider) == "RECORD_UNAVAILABLE"
        toDecide
            .map(row => row.invoiceId)
            .sort()
            .join(",") == [state.claim, pending.invoiceId].sort().join(",")
        approved.statusEnumId == "EcsApproved" && repeated.repeated
        // business approval is not financial approval; the expenses queue lists a claim once its business approval is done
        afterApproval == "InvoiceReceived"
        !queueBefore.includes(state.claim) && !queueBefore.includes(pending.invoiceId)
        queueAfter.includes(state.claim) && !queueAfter.includes(pending.invoiceId)
        finance.error == "" && invoiceRow(state.claim).statusId == "InvoiceApproved"
        claimRow(state.claim).reservedRouteEnumId == "EcrPayable"
        returned.statusEnumId == "EcsReturned" && claimRow(pending.invoiceId).decisionReason == "Add the receipt"
        mine.find(row => row.invoiceId == state.claim).stageText == "Finance approved"
        mine.find(row => row.invoiceId == pending.invoiceId).stageText == "Returned for correction"
    }
})

feature("a claim reserved for one settlement route is refused by the other", {
    when() {
        const payrollClaim = approvedClaim("30")
        const reader = run(state.payrollReader, E + "reserve#ClaimSettlement", {
            invoiceId: payrollClaim,
            routeEnumId: "EcrPayroll",
            reference: "RUN-1"
        })
        const reserved = run(state.payroll, E + "reserve#ClaimSettlement", {
            invoiceId: payrollClaim,
            routeEnumId: "EcrPayroll",
            reference: "RUN-1"
        })
        const again = run(state.payroll, E + "reserve#ClaimSettlement", {
            invoiceId: payrollClaim,
            routeEnumId: "EcrPayroll",
            reference: "RUN-1"
        })
        const byFinance = payable(payrollClaim)
        const asPayable = run(state.finance, E + "reserve#ClaimSettlement", {invoiceId: payrollClaim, routeEnumId: "EcrPayable"})
        // the claim finance approved is accounts payable's
        const toPayroll = run(state.payroll, E + "reserve#ClaimSettlement", {invoiceId: state.claim, routeEnumId: "EcrPayroll"})
        const queue = run(state.finance, "mantle.account.InvoiceServices.find#Payables", {
            organizationPartyId: orgA,
            queue: "expenses"
        }).records
        return {payrollClaim, reader, reserved, again, byFinance, asPayable, toPayroll, queue}
    },
    then({payrollClaim, reader, reserved, again, byFinance, asPayable, toPayroll, queue}) {
        code(reader) == "PERMISSION_DENIED"
        reserved.reservedRouteEnumId == "EcrPayroll" && reserved.reservedReference == "RUN-1" && again.repeated
        code(byFinance) == "CLAIM_RESERVED" && invoiceRow(payrollClaim).statusId == "InvoiceReceived"
        code(asPayable) == "CLAIM_RESERVED"
        code(toPayroll) == "CLAIM_RESERVED"
        // the expenses queue lists no claim reserved for payroll, and none waiting for its business approval
        !queue.some(row => row.invoiceId == payrollClaim)
        state.payrollClaim = payrollClaim
    }
})

feature(
    "an approved advance is a bill a payment run pays, never a claim reserved for payroll; its outstanding is what was delivered less what was applied to a claim",
    {
        when() {
            const asked = run(state.uAna, E + "request#Advance", {
                purpose: "Trade fair travel",
                amount: "40",
                operationKey: "ADV-1",
                requiredDate: "2026-03-01"
            })
            const retry = run(state.uAna, E + "request#Advance", {
                purpose: "Trade fair travel",
                amount: "40",
                operationKey: "ADV-1"
            })
            const forOther = run(state.uBob, E + "request#Advance", {
                partyRelationshipId: state.anaEmp,
                purpose: "x",
                amount: "40"
            })
            const advanceRow = () =>
                ec.entity
                    .find("mantle.humanres.expense.EmployeeAdvance")
                    .condition({employeeAdvanceId: asked.employeeAdvanceId})
                    .disableAuthz()
                    .one()
            const unbilled = advanceRow().invoiceId
            const approved = run(state.uMgr, E + "decide#Advance", {
                employeeAdvanceId: asked.employeeAdvanceId,
                decision: "approve"
            })
            const bill = advanceRow().invoiceId
            const billLines = Array.from(
                ec.entity.find("mantle.account.invoice.InvoiceItem").condition({invoiceId: bill}).disableAuthz().list()
            )
            const before = run(state.uAna, E + "find#Advances", {mine: true}).advances[0]
            const queue = run(state.finance, "mantle.account.InvoiceServices.find#Payables", {
                organizationPartyId: orgA,
                queue: "expenses"
            }).records.map(row => row.invoiceId)
            const billApproved = Object.assign(payable(bill), {billStatus: invoiceRow(bill).statusId})
            const forPayment = run(state.uAna, E + "find#Advances", {mine: true}).advances[0]
            // the payroll-reserved claim approved for payment as P27's route would: no payment run takes it
            ec.entity
                .find("mantle.account.invoice.Invoice")
                .condition({invoiceId: state.payrollClaim})
                .disableAuthz()
                .updateAll({statusId: "InvoiceApproved"})
            const today = ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd")
            const made = run(state.finance, "mantle.account.PaymentRunServices.create#Run", {
                organizationPartyId: orgA,
                paymentMethodId: state.bank,
                paymentInstrumentEnumId: "PiCompanyCheck",
                dueThroughDate: "2099-12-31",
                payDate: today
            })
            const runBills = Array.from(
                ec.entity
                    .find("mantle.account.payment.PaymentRunItem")
                    .condition({paymentRunId: made.paymentRunId})
                    .disableAuthz()
                    .list()
            ).map(row => row.invoiceId)
            run(state.finance, "mantle.account.PaymentRunServices.cancel#Run", {paymentRunId: made.paymentRunId})
            // the run's check to Ana, delivered and applied to the advance's bill, as paySupplier does
            const payment = call("mantle.account.PaymentServices.create#Payment", {
                paymentTypeEnumId: "PtInvoicePayment",
                fromPartyId: orgA,
                toPartyId: state.ana,
                amount: "40",
                amountUomId: "USD",
                paymentInstrumentEnumId: "PiCompanyCheck",
                statusId: "PmntDelivered",
                effectiveDate: ec.user.nowTimestamp
            })
            call("mantle.account.PaymentServices.apply#InvoicePayment", {paymentId: payment.paymentId, invoiceId: bill})
            ec.message.clearErrors()
            const delivered = run(state.uAna, E + "find#Advances", {mine: true}).advances[0]
            const tooMuch = run(state.finance, E + "apply#Advance", {
                employeeAdvanceId: asked.employeeAdvanceId,
                invoiceId: state.claim,
                amount: "41"
            })
            const notFinance = run(state.uMgr, E + "apply#Advance", {
                employeeAdvanceId: asked.employeeAdvanceId,
                invoiceId: state.claim
            })
            const applied = run(state.finance, E + "apply#Advance", {
                employeeAdvanceId: asked.employeeAdvanceId,
                invoiceId: state.claim
            })
            const after = run(state.uAna, E + "find#Advances", {mine: true}).advances[0]
            const financeList = run(state.finance, E + "find#Advances", {finance: true, organizationPartyId: orgA}).advances
            const claim = run(state.uAna, E + "get#Claim", {invoiceId: state.claim})
            const credit = applied.creditInvoiceId ? invoiceRow(applied.creditInvoiceId) : null
            // the credit's posting: the employee advances account credited (where the advance's bill debited it)
            const ledger = invoiceId =>
                Array.from(
                    ec.entity.find("mantle.ledger.transaction.AcctgTrans").condition({invoiceId}).disableAuthz().list()
                ).flatMap(trans =>
                    Array.from(
                        ec.entity
                            .find("mantle.ledger.transaction.AcctgTransEntry")
                            .condition({acctgTransId: trans.acctgTransId})
                            .disableAuthz()
                            .list()
                    ).map(
                        entry =>
                            entry.glAccountId +
                            ":" +
                            entry.debitCreditFlag +
                            ":" +
                            toDecimal(entry.amount).setScale(2, "HALF_UP").toString()
                    )
                )
            const advanceAccount = {bill: ledger(bill), credit: credit ? ledger(credit.invoiceId) : []}
            return {
                advanceAccount,
                asked,
                retry,
                forOther,
                unbilled,
                approved,
                bill,
                billLines,
                before,
                queue,
                billApproved,
                forPayment,
                made,
                runBills,
                delivered,
                tooMuch,
                notFinance,
                applied,
                after,
                financeList,
                claim,
                credit
            }
        },
        then({
            advanceAccount,
            asked,
            retry,
            forOther,
            unbilled,
            approved,
            bill,
            billLines,
            before,
            queue,
            billApproved,
            forPayment,
            made,
            runBills,
            delivered,
            tooMuch,
            notFinance,
            applied,
            after,
            financeList,
            claim,
            credit
        }) {
            asked.statusEnumId == "EasRequested" && retry.repeated && retry.employeeAdvanceId == asked.employeeAdvanceId
            code(forOther) == "PERMISSION_DENIED"
            // approval to advance is not payment: the last approval makes the advance a bill, received for finance
            !unbilled && approved.statusEnumId == "EasApproved" && bill
            const billRow = invoiceRow(bill)
            billRow.fromPartyId == state.ana && billRow.toPartyId == orgA && billRow.invoiceTotal.compare(40) == 0
            billLines.length == 1 && billLines[0].itemTypeEnumId == "ItemAdvancePay"
            ec.l10n.format(billRow.dueDate, "yyyy-MM-dd") == "2026-03-01"
            before.stageText == "Approved: with finance" && before.outstanding.compare(0) == 0 && before.invoiceId == bill
            queue.includes(bill)
            billApproved.error == "" &&
                billApproved.billStatus == "InvoiceApproved" &&
                invoiceRow(bill).statusId == "InvoicePmtSent"
            forPayment.stageText == "Approved for payment"
            // a payment run pays the advance's bill and the claim finance approved, and leaves out the claim reserved for payroll
            made.error == "" &&
                runBills.includes(bill) &&
                runBills.includes(state.claim) &&
                !runBills.includes(state.payrollClaim)
            delivered.stageText == "Paid: outstanding" && delivered.outstanding.compare(40) == 0
            code(tooMuch) == "AMOUNT_EXCEEDS"
            code(notFinance) == "PERMISSION_DENIED"
            applied.amountApplied.compare(40) == 0 && applied.outstanding.compare(0) == 0
            // the employer's credit on the claim: issued and posted, from the employer to Ana, linked to the claim, all of it applied
            credit.statusId == "InvoicePmtRecvd" && credit.acctgTransResultEnumId == "AtrSuccess"
            credit.fromPartyId == orgA && credit.toPartyId == state.ana
            credit.creditForInvoiceId == state.claim
            advanceAccount.bill.includes("151400000:D:40.00") && advanceAccount.credit.includes("151400000:C:40.00")
            after.stageText == "Settled" && after.appliedInvoiceIds.includes(state.claim)
            financeList.some(row => row.employeeAdvanceId == asked.employeeAdvanceId)
            // the claim of 100 shows the advance applied and 60 left to reimburse
            claim.payments.length == 1 && claim.payments[0].employeeAdvanceId == asked.employeeAdvanceId
            claim.claim.unpaidTotal.compare(60) == 0
        }
    }
)

feature(
    "Add to my claim: the caller's own chat message is a draft line made once; another's message and a room not read are refused",
    {
        when() {
            login(state.uAna)
            ec.artifactExecution.disableAuthz()
            const room = call("org.moqui.chat.ChatServices.create#Room", {
                roomTypeEnumId: "CrtPrivate",
                roomName: "Expense spec receipts",
                memberUserIdList: [state.uMgr]
            })
            const sent = call("org.moqui.chat.ChatServices.send#Message", {
                chatRoomId: room.chatRoomId,
                body: "Parking 12.00 at the fair"
            })
            login("john.doe")
            ec.artifactExecution.disableAuthz()
            const parameters = {chatRoomId: room.chatRoomId, eventSeq: sent.eventSeq}
            const added = run(state.uAna, E + "create#ClaimLineFromChat", parameters)
            const again = run(state.uAna, E + "create#ClaimLineFromChat", parameters)
            const notTheirs = run(state.uMgr, E + "create#ClaimLineFromChat", parameters)
            const notMember = run(state.uBob, E + "create#ClaimLineFromChat", parameters)
            const extension = ec.entity
                .find("mantle.humanres.expense.ExpenseClaimItem")
                .condition({invoiceId: added.invoiceId, invoiceItemSeqId: added.invoiceItemSeqId})
                .disableAuthz()
                .one()
            return {added, again, notTheirs, notMember, extension}
        },
        then({added, again, notTheirs, notMember, extension}) {
            added.created &&
                claimRow(added.invoiceId).statusEnumId == "EcsDraft" &&
                claimRow(added.invoiceId).partyId == state.ana
            !again.created && again.invoiceItemSeqId == added.invoiceItemSeqId
            extension.reviewNeeded == "Y" && extension.sourceEnumId == "ElsChat" && extension.receiptContentId
            code(notTheirs) == "NOT_YOURS"
            code(notMember) == "RECORD_UNAVAILABLE"
        }
    }
)
