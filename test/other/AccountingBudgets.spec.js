// Budgets (AC-14; mantle.other.BudgetServices): a draft approved by another user as revision 0 with its PDF, a revision that
// keeps the old numbers, control policies as dated rows, a purchase order commitment reserved and converted to actual
// by the bill's approval without counting twice, a Stop that refuses an over-budget bill until an overrider gives a
// reason, and the variance report checked against the organization. Standalone: spec-local organizations and users.
const helper = () => ec.resource.script("component://mr-mantle/test/ledger/AccountingReceivablesFixtures.js")
const svc = (name, p) => helper().call(name, p)
const budgets = (name, p) => helper().call("mantle.other.BudgetServices." + name, p)
const refused = (name, p) => helper().rejected(name, p)
const one = (entity, key) => helper().lib.one(entity, key)
const rows = (entity, key) => helper().lib.rows(entity, key)
const n = value => (value == null ? null : toDecimal(value).toNumber())
const prefix = "NATIVE_BUDGET"
const org = prefix + "_ORG",
    otherOrg = prefix + "_OTHER",
    supplier = prefix + "_SUPPLIER"
const users = {}
let firstMonthAmount,
    yearId,
    otherYearId,
    controlAccount,
    spreadAccount,
    budgetId,
    otherBudgetId,
    firstMonthId,
    orderId,
    overBillId

function party(partyId, name, roleTypeId) {
    svc("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
    svc("create#mantle.party.Organization", {partyId, organizationName: name})
    svc("create#mantle.party.PartyRole", {partyId, roleTypeId})
}
function organization(partyId, name) {
    party(partyId, name, "OrgInternal")
    svc("mantle.ledger.LedgerServices.init#PartyAccountingConfiguration", {
        organizationPartyId: partyId,
        sourcePartyId: "DefaultSettings",
        baseCurrencyUomId: "USD"
    })
    return svc("mantle.ledger.LedgerServices.get#OrganizationFiscalTimePeriods", {
        organizationPartyId: partyId,
        filterDate: ec.user.nowTimestamp,
        timePeriodTypeId: "FiscalYear"
    }).timePeriodList[0].timePeriodId
}
function user(kind, permissions) {
    const id = prefix + "_" + kind.toUpperCase()
    users[kind] = id
    svc("create#moqui.security.UserGroup", {userGroupId: id, description: "Budgets " + kind})
    for (const permission of permissions)
        svc("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: 0})
    svc("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    svc("create#moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId: id,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        timeZone: ec.user.userAccount?.timeZone || "America/Chicago"
    })
    svc("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: 0})
    svc("create#mantle.party.PartyRelationship", {
        partyRelationshipId: id,
        fromPartyId: id,
        toPartyId: org,
        relationshipTypeEnumId: "PrtAgent",
        fromDate: 0
    })
}
function report(p) {
    return helper().call("mantle.other.BudgetReportServices.run#BudgetVariance", Object.assign({organizationPartyId: org}, p))
}
function row(result, glAccountId) {
    return result.varianceRows.find(r => r.glAccountId === glAccountId)
}
function approveBill(invoiceId, extra = {}) {
    const invoice = one("mantle.account.invoice.Invoice", {invoiceId})
    return refused(
        "mantle.account.InvoiceServices.approve#Payable",
        Object.assign({invoiceId, lastUpdatedStamp: invoice.lastUpdatedStamp}, extra)
    )
}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        yearId = organization(org, "Budget organization")
        otherYearId = organization(otherOrg, "Other budget organization")
        party(supplier, "Budget supplier", "Supplier")
        user("gl", ["BUDGET_EDIT", "ACCOUNTING_VIEW"])
        // the approver also drafts, for the self-approval refusal
        user("approver", ["BUDGET_APPROVE", "BUDGET_EDIT", "ACCOUNTING_VIEW", "INVOICE_APPROVE"])
        user("overrider", ["INVOICE_APPROVE", "BUDGET_OVERRIDE", "ACCOUNTING_VIEW"])
        user("admin", ["ACCOUNTING_ADMIN", "ACCOUNTING_VIEW"])
        user("ap", ["PAYABLE_EDIT", "PAYABLE_VIEW", "PAYABLE_IMPORT"])
        user("read", ["ACCOUNTING_VIEW"])
        // the account a bill's expense line posts to, and another expense account of the organization
        controlAccount =
            svc("mantle.ledger.InvoiceAutoPostServices.get#InvoiceItemGlAccount", {
                organizationPartyId: org,
                itemTypeEnumId: "ItemExpense",
                direction: "I"
            }).glAccountId || "789000000"
        const classes = svc("org.moqui.impl.BasicServices.find#EnumerationByParent", {
            parentEnumId: "EXPENSE",
            includeNested: true
        })
        spreadAccount = Array.from(
            ec.entity
                .find("mantle.ledger.account.GlAccountAndOrganization")
                .condition("organizationPartyId", org)
                .condition("glAccountClassEnumId", "in", Array.from(classes.enumIdSet))
                .condition("glAccountId", "not-equals", controlAccount)
                .orderBy("accountCode")
                .list()
        )[0].glAccountId
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        login("john.doe")
    }
})

feature("a budget editor drafts a budget that another user approves as revision 0 with its PDF", {
    when() {
        login(users.gl)
        budgetId = budgets("create#Budget", {
            timePeriodId: yearId,
            subTimePeriodTypeId: "FiscalMonth",
            budgetTypeEnumId: "BudgetOperating",
            description: "Operating budget",
            statusId: "BudgetApproved"
        }).budgetId
        budgets("store#BudgetItem", {budgetId, glAccountId: controlAccount, amount: 1000})
        budgets("store#BudgetItemsSubPeriods", {budgetId, glAccountId: spreadAccount, amountMain: 1200})
        const party = budgets("store#BudgetParty", {budgetId, partyId: supplier, roleTypeId: "Supplier"})
        const editorApproves = refused("mantle.other.BudgetServices.change#BudgetState", {budgetId, action: "approve"})
        // an approver's own draft needs another approver
        login(users.approver)
        const ownId = budgets("create#Budget", {timePeriodId: yearId, description: "Own draft"}).budgetId
        budgets("store#BudgetItem", {budgetId: ownId, glAccountId: controlAccount, amount: 10})
        const selfApproval = refused("mantle.other.BudgetServices.change#BudgetState", {budgetId: ownId, action: "approve"})
        const approved = budgets("change#BudgetState", {budgetId, action: "approve"})
        login(users.gl)
        const draftEdit = refused("mantle.other.BudgetServices.store#BudgetItemsSubPeriods", {
            budgetId,
            glAccountId: spreadAccount,
            amountMain: 2000
        })
        return {
            party,
            editorApproves,
            selfApproval,
            approved,
            draftEdit,
            budget: one("mantle.other.budget.Budget", {budgetId}),
            contents: rows("mantle.other.budget.BudgetContent", {budgetId}),
            reviews: rows("mantle.other.budget.BudgetReview", {budgetId})
        }
    },
    then({party, editorApproves, selfApproval, approved, draftEdit, budget, contents, reviews}) {
        party.changed == true
        editorApproves.includes("PERMISSION_DENIED")
        selfApproval.includes("SELF_APPROVAL_DENIED")
        approved.statusId == "BudgetApproved"
        approved.revisionSeqId == "000"
        budget.statusId == "BudgetApproved"
        budget.createdByUserId == users.gl
        draftEdit.includes("BUDGET_NOT_DRAFT")
        reviews.length == 1
        reviews[0].budgetReviewResultEnumId == "BrrApproved"
        contents.length == 1
        contents[0].revisionSeqId == "000"
        contents[0].contentLocation.endsWith(".pdf")
    }
})

feature("a revision keeps the approved numbers: the budget reads as of either revision", {
    when() {
        login(users.read)
        const approvedAmounts = budgets("get#BudgetAmounts", {budgetId})
        firstMonthId = approvedAmounts.subTimePeriodList[0].timePeriodId
        // the first month's share of the spread total, raised by 300 with the total
        firstMonthAmount = n(
            approvedAmounts.itemList.find(item => item.glAccountId === spreadAccount && item.subTimePeriodId === firstMonthId)
                .amount
        )
        const reader = refused("mantle.other.BudgetServices.revise#Budget", {
            budgetId,
            lines: [{glAccountId: spreadAccount, amount: 1500}],
            changeReason: "More"
        })
        login(users.gl)
        const unbalanced = refused("mantle.other.BudgetServices.revise#Budget", {
            budgetId,
            lines: [{glAccountId: spreadAccount, amount: 1500}],
            changeReason: "More"
        })
        const noReason = refused("mantle.other.BudgetServices.revise#Budget", {
            budgetId,
            glAccountId: spreadAccount,
            amountMain: 1500,
            amountPer1: firstMonthAmount + 300
        })
        // the total and its first month, in the matrix form
        const revised = budgets("revise#Budget", {
            budgetId,
            glAccountId: spreadAccount,
            amountMain: 1500,
            amountPer1: firstMonthAmount + 300,
            changeReason: "Mid-year increase",
            lastRevisionSeqId: "000"
        })
        const stale = refused("mantle.other.BudgetServices.revise#Budget", {
            budgetId,
            lines: [{glAccountId: controlAccount, amount: 1100}],
            changeReason: "Again",
            lastRevisionSeqId: "000"
        })
        login(users.read)
        const amount = (read, sub) =>
            n(read.itemList.find(item => item.glAccountId === spreadAccount && (item.subTimePeriodId || null) === sub).amount)
        const original = budgets("get#BudgetAmounts", {budgetId, revisionSeqId: "000"})
        const latest = budgets("get#BudgetAmounts", {budgetId})
        const audit = rows("moqui.entity.EntityAuditLog", {
            changedEntityName: "mantle.other.budget.BudgetItem",
            changedFieldName: "amount",
            pkPrimaryValue: budgetId,
            changeReason: "Mid-year increase"
        })
        return {
            reader,
            unbalanced,
            noReason,
            revised,
            stale,
            before: [amount(original, null), amount(original, firstMonthId)],
            after: [amount(latest, null), amount(latest, firstMonthId)],
            audit,
            asApproved: row(report({budgetId, revisionSeqId: "000"}), spreadAccount),
            asRevised: row(report({budgetId}), spreadAccount),
            contents: rows("mantle.other.budget.BudgetContent", {budgetId}).length
        }
    },
    then({reader, unbalanced, noReason, revised, stale, before, after, audit, asApproved, asRevised, contents}) {
        reader.includes("PERMISSION_DENIED")
        unbalanced.includes("BUDGET_DISTRIBUTION")
        noReason.includes("CHANGE_REASON_REQUIRED")
        revised.revisionSeqId == "001"
        revised.changedCount == 2
        stale.includes("STALE_REVISION")
        before == [1200, firstMonthAmount]
        after == [1500, firstMonthAmount + 300]
        audit.length == 2
        audit.some(row => row.oldValueText == "1200" && row.newValueText == "1500")
        n(asApproved.approvedAmount) == 1200
        n(asRevised.approvedAmount) == 1500
        contents == 2
    }
})

feature("control policies are dated rows: a finance administrator starts a version that ends the one in effect", {
    when() {
        const request = {
            organizationPartyId: org,
            glAccountId: controlAccount,
            stageEnumId: "BcsExpense",
            actionEnumId: "BcaWarn",
            fromDate: new Date(Number(ec.user.nowTimestamp) - 86400000),
            changeReason: "Warn first"
        }
        login(users.gl)
        const editor = refused("mantle.other.BudgetServices.store#Policy", request)
        login(users.admin)
        const first = budgets("store#Policy", request).budgetControlPolicyId
        const overlap = refused("mantle.other.BudgetServices.store#Policy", Object.assign({}, request, {actionEnumId: "BcaStop"}))
        const second = budgets("store#Policy", {
            organizationPartyId: org,
            budgetControlPolicyId: first,
            actionEnumId: "BcaStop",
            thresholdPercent: 100,
            changeReason: "Stop over budget"
        }).budgetControlPolicyId
        // every stage of the organization is warned
        budgets("store#Policy", {organizationPartyId: org, actionEnumId: "BcaWarn", changeReason: "Warn on all"})
        return {
            editor,
            overlap,
            ended: one("mantle.other.budget.BudgetControlPolicy", {budgetControlPolicyId: first}),
            current: one("mantle.other.budget.BudgetControlPolicy", {budgetControlPolicyId: second}),
            audit: rows("moqui.entity.EntityAuditLog", {
                changedEntityName: "mantle.other.budget.BudgetControlPolicy",
                changedFieldName: "thruDate",
                pkPrimaryValue: first
            })
        }
    },
    then({editor, overlap, ended, current, audit}) {
        editor.includes("PERMISSION_DENIED")
        overlap.includes("POLICY_OVERLAP")
        ended.thruDate != null
        current.actionEnumId == "BcaStop"
        current.thruDate == null
        audit.length == 1
        audit[0].changeReason == "Stop over budget"
    }
})

feature("a purchase order's commitment converts to actual when its bill is approved, and is not counted again", {
    when() {
        const order = svc("mantle.order.OrderServices.create#Order", {
            customerPartyId: org,
            vendorPartyId: supplier,
            currencyUomId: "USD"
        })
        orderId = order.orderId
        const line = svc("mantle.order.OrderServices.create#OrderItem", {
            orderId,
            orderPartSeqId: order.orderPartSeqId,
            itemTypeEnumId: "ItemExpense",
            quantity: 1,
            unitAmount: 300,
            itemDescription: "Repairs"
        })
        svc("mantle.order.OrderServices.place#Order", {orderId})
        svc("mantle.order.OrderServices.approve#Order", {orderId})
        const reserve = {
            organizationPartyId: org,
            glAccountId: controlAccount,
            amount: 300,
            currencyUomId: "USD",
            stageEnumId: "BcsOrder",
            sourceEntityName: "mantle.order.OrderHeader",
            sourceId: orderId,
            sourceItemId: line.orderItemSeqId,
            sourceRevision: "1"
        }
        login(users.read)
        const reader = refused("mantle.other.BudgetServices.reserve#Commitment", reserve)
        // a bill editor converts at approval but neither reserves nor releases
        login(users.ap)
        const editor = refused("mantle.other.BudgetServices.reserve#Commitment", reserve)
        login(users.approver)
        const reserved = budgets("reserve#Commitment", reserve)
        const again = budgets("reserve#Commitment", reserve)
        const changed = refused("mantle.other.BudgetServices.reserve#Commitment", Object.assign({}, reserve, {amount: 310}))
        login(users.read)
        const committed = row(report({budgetId}), controlAccount)
        login(users.ap)
        const billId = svc("mantle.account.InvoiceServices.create#InvoiceFromSource", {
            orderId,
            organizationPartyId: org
        }).invoiceId
        login(users.approver)
        const approval = approveBill(billId)
        login(users.read)
        const actual = row(report({budgetId}), controlAccount)
        // a second commitment of an open order: released only with override or administration, once
        login(users.approver)
        budgets("reserve#Commitment", Object.assign({}, reserve, {sourceId: orderId, sourceItemId: "B", amount: 50}))
        const stillOpen = refused("mantle.other.BudgetServices.release#Commitment", {
            organizationPartyId: org,
            sourceEntityName: reserve.sourceEntityName,
            sourceId: orderId,
            sourceItemId: "B"
        })
        login(users.admin)
        const released = budgets("release#Commitment", {
            organizationPartyId: org,
            sourceEntityName: reserve.sourceEntityName,
            sourceId: orderId,
            sourceItemId: "B"
        })
        const releasedAgain = budgets("release#Commitment", {
            organizationPartyId: org,
            sourceEntityName: reserve.sourceEntityName,
            sourceId: orderId,
            sourceItemId: "B"
        })
        login(users.read)
        const afterRelease = row(report({budgetId}), controlAccount)
        return {
            reader,
            editor,
            stillOpen,
            reserved,
            again,
            changed,
            committed,
            approval,
            actual,
            released,
            releasedAgain,
            order: one("mantle.other.budget.BudgetCommitment", {budgetCommitmentId: reserved.budgetCommitmentId}),
            actuals: rows("mantle.other.budget.BudgetCommitment", {sourceId: billId, statusId: "BcActual"}),
            afterRelease
        }
    },
    then({
        reader,
        editor,
        stillOpen,
        reserved,
        again,
        changed,
        committed,
        approval,
        actual,
        released,
        releasedAgain,
        order,
        actuals,
        afterRelease
    }) {
        reader.includes("PERMISSION_DENIED")
        editor.includes("PERMISSION_DENIED")
        stillOpen.includes("SOURCE_OPEN")
        reserved.statusId == "BcReserved"
        reserved.decisionEnumId == "BcdWithin"
        again.existing == true
        again.budgetCommitmentId == reserved.budgetCommitmentId
        changed.includes("SOURCE_REVISION_REUSED")
        n(committed.committedAmount) == 300
        n(committed.actualAmount) == 0
        approval == ""
        order.statusId == "BcConverted"
        actuals.length == 1
        actuals[0].convertedFromId == reserved.budgetCommitmentId
        n(actuals[0].amount) == 300
        n(actual.committedAmount) == 0
        n(actual.actualAmount) == 300
        n(actual.remainingAmount) == 700
        released.releasedCount == 1
        releasedAgain.releasedCount == 0
        n(afterRelease.committedAmount) == 0
    }
})

feature("an over-budget bill under Stop is refused; only an overrider's reason passes it", {
    when() {
        login(users.ap)
        overBillId = svc("mantle.account.InvoiceServices.import#Bill", {
            organizationPartyId: org,
            supplierPartyId: supplier,
            referenceNumber: "BUDGET-800",
            amount: "800"
        }).invoiceId
        login(users.read)
        const preview = budgets("check#Budget", {organizationPartyId: org, glAccountId: controlAccount, amount: 800})
        login(users.approver)
        const stopped = approveBill(overBillId)
        const notOverrider = approveBill(overBillId, {budgetOverrideReason: "Needed"})
        const blocked = rows("mantle.other.budget.BudgetCommitment", {sourceId: overBillId, statusId: "BcBlocked"})
        const notices = rows("moqui.security.user.NotificationMessage", {
            topic: "BudgetOverride",
            recordId: blocked[0]?.budgetCommitmentId
        })
        const recipients = notices.length
            ? rows("moqui.security.user.NotificationMessageUser", {notificationMessageId: notices[0].notificationMessageId})
            : []
        login(users.overrider)
        const noReason = approveBill(overBillId)
        const overridden = approveBill(overBillId, {budgetOverrideReason: "Emergency repair"})
        const unread = recipients.length
            ? rows("moqui.security.user.NotificationMessageUser", {
                  notificationMessageId: notices[0].notificationMessageId
              }).filter(row => !row.viewedDate).length
            : -1
        return {
            preview: preview.checkList[0],
            stopped,
            notOverrider,
            noReason,
            overridden,
            blocked,
            recipients: recipients.map(row => row.userId),
            unread,
            bill: one("mantle.account.invoice.Invoice", {invoiceId: overBillId}),
            actual: rows("mantle.other.budget.BudgetCommitment", {sourceId: overBillId, statusId: "BcActual"})
        }
    },
    then({preview, stopped, notOverrider, noReason, overridden, blocked, recipients, unread, bill, actual}) {
        preview.blocked == true
        preview.canOverride == false
        n(preview.availableAmount) == 700
        stopped.includes("BUDGET_EXCEEDED")
        notOverrider.includes("PERMISSION_DENIED")
        noReason.includes("BUDGET_EXCEEDED")
        overridden == ""
        blocked.length == 1
        blocked[0].decisionEnumId == "BcdBlocked"
        recipients == [users.overrider]
        unread == 0
        bill.statusId == "InvoiceApproved"
        actual.length == 1
        actual[0].decisionEnumId == "BcdOverridden"
        actual[0].overrideReason == "Emergency repair"
        actual[0].overrideByUserId == users.overrider
    }
})

feature("the variance report and a bill's budget details stay in the reader's organization", {
    when() {
        login("john.doe")
        otherBudgetId = budgets("create#Budget", {timePeriodId: otherYearId, description: "Other organization budget"}).budgetId
        login(users.read)
        const foreign = refused("mantle.other.BudgetReportServices.run#BudgetVariance", {
            organizationPartyId: otherOrg,
            budgetId: otherBudgetId
        })
        const crossed = refused("mantle.other.BudgetReportServices.run#BudgetVariance", {
            organizationPartyId: org,
            budgetId: otherBudgetId
        })
        const wrongPeriod = refused("mantle.other.BudgetReportServices.run#BudgetVariance", {
            organizationPartyId: org,
            budgetId,
            timePeriodId: otherYearId
        })
        const month = report({budgetId, timePeriodId: firstMonthId})
        login(users.approver)
        const detail = svc("mantle.account.InvoiceServices.get#InvoiceFinanceDetail", {
            invoiceId: overBillId,
            organizationPartyId: org
        })
        return {foreign, crossed, wrongPeriod, month, detail}
    },
    then({foreign, crossed, wrongPeriod, month, detail}) {
        foreign.includes("ORGANIZATION_DENIED")
        crossed.length > 0
        wrongPeriod.includes("PERIOD_UNAVAILABLE")
        n(row(month, spreadAccount).approvedAmount) == firstMonthAmount + 300
        // the control account has no month amounts: no budget for the month, and no percent
        row(month, controlAccount).approvedAmount == null
        row(month, controlAccount).variancePercent == null
        detail.budgetAvailable == true
        detail.budgetRows.length == 1
        detail.budgetRows[0].decisionText == "Over budget, overridden"
        n(detail.budgetRows[0].amount) == 800
    }
})

// An approved purchase order of one expense line, quantity × price, as the spec's administrator.
function orderLine(quantity, unitAmount) {
    login("john.doe")
    const order = svc("mantle.order.OrderServices.create#Order", {
        customerPartyId: org,
        vendorPartyId: supplier,
        currencyUomId: "USD"
    })
    const line = svc("mantle.order.OrderServices.create#OrderItem", {
        orderId: order.orderId,
        orderPartSeqId: order.orderPartSeqId,
        itemTypeEnumId: "ItemExpense",
        quantity,
        unitAmount,
        itemDescription: "Budget spec repairs"
    })
    svc("mantle.order.OrderServices.place#Order", {orderId: order.orderId})
    svc("mantle.order.OrderServices.approve#Order", {orderId: order.orderId})
    return {orderId: order.orderId, orderItemSeqId: line.orderItemSeqId}
}
function reserveLine(line, amount, glAccountId = controlAccount, sourceRevision = "1") {
    login(users.approver)
    return budgets("reserve#Commitment", {
        organizationPartyId: org,
        glAccountId,
        amount,
        currencyUomId: "USD",
        stageEnumId: "BcsOrder",
        sourceEntityName: "mantle.order.OrderHeader",
        sourceId: line.orderId,
        sourceItemId: line.orderItemSeqId,
        sourceRevision
    })
}
// What a commitment has left: its amount less what later stages hold (not blocked or reversed).
function openOf(budgetCommitmentId) {
    const parent = one("mantle.other.budget.BudgetCommitment", {budgetCommitmentId})
    const used = rows("mantle.other.budget.BudgetCommitment", {convertedFromId: budgetCommitmentId})
        .filter(row => !["BcBlocked", "BcReversed"].includes(row.statusId))
        .reduce((sum, row) => sum + n(row.amount), 0)
    return {open: n(parent.amount) - used, statusId: parent.statusId}
}
const actualSum = invoiceId =>
    rows("mantle.other.budget.BudgetCommitment", {sourceId: invoiceId, statusId: "BcActual"}).reduce(
        (sum, row) => sum + n(row.amount),
        0
    )

feature("a bill whose approval is undone reverses its actuals; approved again it holds 600 of the order's 1000", {
    when() {
        const line = orderLine(10, 100)
        const reserved = reserveLine(line, 1000)
        login(users.ap)
        const billId = svc("mantle.account.InvoiceServices.create#InvoiceFromSource", {
            orderId: line.orderId,
            organizationPartyId: org
        }).invoiceId
        login("john.doe")
        const item = rows("mantle.account.invoice.InvoiceItem", {invoiceId: billId})[0]
        svc("update#mantle.account.invoice.InvoiceItem", {
            invoiceId: billId,
            invoiceItemSeqId: item.invoiceItemSeqId,
            quantity: 6
        })
        login(users.approver)
        const first = approveBill(billId)
        const afterFirst = {actual: actualSum(billId), order: openOf(reserved.budgetCommitmentId)}
        // Resume Changes: the approval undone, its posting reverted
        login("john.doe")
        svc("update#mantle.account.invoice.Invoice", {invoiceId: billId, statusId: "InvoiceReceived"})
        const resumed = {actual: actualSum(billId), order: openOf(reserved.budgetCommitmentId)}
        login(users.approver)
        const second = approveBill(billId)
        return {first, afterFirst, resumed, second, actual: actualSum(billId), order: openOf(reserved.budgetCommitmentId)}
    },
    then({first, afterFirst, resumed, second, actual, order}) {
        first == ""
        afterFirst.actual == 600
        afterFirst.order.open == 400
        resumed.actual == 0
        resumed.order.open == 1000
        resumed.order.statusId == "BcReserved"
        second == ""
        actual == 600
        order.open == 400
    }
})

feature("two bill lines against one order line use its 1000 once, and the excess 200 meets the Stop", {
    when() {
        const line = orderLine(10, 100)
        const reserved = reserveLine(line, 1000)
        login(users.ap)
        const billId = svc("mantle.account.InvoiceServices.import#Bill", {
            organizationPartyId: org,
            supplierPartyId: supplier,
            referenceNumber: "BUDGET-TWO-LINES"
        }).invoiceId
        login("john.doe")
        for (const seq of ["01", "02"]) {
            svc("mantle.account.InvoiceServices.create#InvoiceItem", {
                invoiceId: billId,
                invoiceItemSeqId: seq,
                itemTypeEnumId: "ItemExpense",
                quantity: 6,
                amount: 100,
                description: "Repairs " + seq
            })
            svc("create#mantle.order.OrderItemBilling", {
                orderId: line.orderId,
                orderItemSeqId: line.orderItemSeqId,
                invoiceId: billId,
                invoiceItemSeqId: seq,
                quantity: 6,
                amount: 100
            })
        }
        login(users.approver)
        const stopped = approveBill(billId)
        login(users.overrider)
        const overridden = approveBill(billId, {budgetOverrideReason: "Second repair crew"})
        const actuals = rows("mantle.other.budget.BudgetCommitment", {sourceId: billId, statusId: "BcActual"})
        return {
            stopped,
            overridden,
            converted: actuals
                .filter(row => row.convertedFromId == reserved.budgetCommitmentId)
                .reduce((sum, row) => sum + n(row.amount), 0),
            own: actuals.filter(row => !row.convertedFromId).reduce((sum, row) => sum + n(row.amount), 0),
            order: openOf(reserved.budgetCommitmentId)
        }
    },
    then({stopped, overridden, converted, own, order}) {
        stopped.includes("BUDGET_EXCEEDED")
        overridden == ""
        converted == 1000
        own == 200
        order.open == 0
        order.statusId == "BcConverted"
    }
})

feature("a revised order line reserves its new amount less what it already passed on", {
    when() {
        const line = {orderId: "BUDGET-REVISED-ORDER", orderItemSeqId: "01"}
        const first = reserveLine(line, 1000, spreadAccount, "1")
        login(users.approver)
        const converted = budgets("convert#Commitment", {
            organizationPartyId: org,
            fromCommitmentId: first.budgetCommitmentId,
            sourceEntityName: "mantle.account.invoice.Invoice",
            sourceId: "BUDGET-REVISED-BILL",
            sourceItemId: "01",
            sourceRevision: "1",
            stageEnumId: "BcsExpense",
            amount: 400
        })
        const second = reserveLine(line, 1200, spreadAccount, "2")
        const retry = reserveLine(line, 1200, spreadAccount, "2")
        const open = rows("mantle.other.budget.BudgetCommitment", {sourceId: line.orderId, statusId: "BcReserved"})
        const actualBefore = actualSum("BUDGET-REVISED-BILL")
        // the bill reversed: its 400 goes back to the line's current revision
        login("john.doe")
        svc("mantle.other.BudgetServices.reverse#InvoiceActuals", {invoiceId: "BUDGET-REVISED-BILL"})
        const afterReversal = n(
            one("mantle.other.budget.BudgetCommitment", {budgetCommitmentId: second.budgetCommitmentId}).amount
        )
        return {
            converted,
            second,
            retry,
            committed: open.reduce((sum, row) => sum + n(row.amount), 0),
            actual: actualBefore,
            afterReversal,
            firstStatus: one("mantle.other.budget.BudgetCommitment", {budgetCommitmentId: first.budgetCommitmentId}).statusId
        }
    },
    then({converted, second, retry, committed, actual, afterReversal, firstStatus}) {
        afterReversal == 1200
        converted.statusId == "BcActual"
        // before the reversal: 1200 less the 400 the first revision passed on
        retry.existing == true
        retry.budgetCommitmentId == second.budgetCommitmentId
        committed == 800
        actual == 400
        firstStatus == "BcReleased"
    }
})

feature("an order commitment on another account gives up its share; the bill line counts in full on its own account", {
    when() {
        const line = orderLine(1, 100)
        const reserved = reserveLine(line, 100, spreadAccount)
        login(users.ap)
        const billId = svc("mantle.account.InvoiceServices.create#InvoiceFromSource", {
            orderId: line.orderId,
            organizationPartyId: org
        }).invoiceId
        login(users.approver)
        const stopped = approveBill(billId)
        login(users.overrider)
        const overridden = approveBill(billId, {budgetOverrideReason: "Repair billed to the other account"})
        return {
            stopped,
            overridden,
            actuals: rows("mantle.other.budget.BudgetCommitment", {sourceId: billId, statusId: "BcActual"}),
            share: rows("mantle.other.budget.BudgetCommitment", {convertedFromId: reserved.budgetCommitmentId}),
            order: openOf(reserved.budgetCommitmentId)
        }
    },
    then({stopped, overridden, actuals, share, order}) {
        stopped.includes("BUDGET_EXCEEDED")
        overridden == ""
        actuals.length == 1
        actuals[0].glAccountId == controlAccount
        actuals[0].convertedFromId == null
        n(actuals[0].amount) == 100
        share.length == 1
        share[0].statusId == "BcReleased"
        share[0].glAccountId == spreadAccount
        order.open == 0
        order.statusId == "BcConverted"
    }
})

feature("budget writers need BUDGET_EDIT in the budget's organization, and the control reads only revised numbers", {
    when() {
        login(users.read)
        const readerCreate = refused("mantle.other.BudgetServices.create#Budget", {timePeriodId: yearId, description: "Reader"})
        login(users.gl)
        const foreignItem = refused("mantle.other.BudgetServices.store#BudgetItem", {
            budgetId: otherBudgetId,
            glAccountId: controlAccount,
            amount: 5
        })
        // an item written around revise#Budget (as an entity write) does not reach the control
        login("john.doe")
        const item = rows("mantle.other.budget.BudgetItem", {budgetId, glAccountId: controlAccount})[0]
        svc("update#mantle.other.budget.BudgetItem", {budgetId, budgetItemSeqId: item.budgetItemSeqId, amount: 999999})
        login(users.read)
        const preview = budgets("check#Budget", {organizationPartyId: org, glAccountId: controlAccount, amount: 1}).checkList[0]
        login("john.doe")
        svc("update#mantle.other.budget.BudgetItem", {budgetId, budgetItemSeqId: item.budgetItemSeqId, amount: item.amount})
        return {readerCreate, foreignItem, preview}
    },
    then({readerCreate, foreignItem, preview}) {
        readerCreate.includes("PERMISSION_DENIED")
        foreignItem.includes("ORGANIZATION_DENIED")
        n(preview.budgetAmount) == 1000
    }
})
