// Settlement through Mantle's apply services: open items, the retained review, confirmation and its replay, adjustments
// as credit memos, automatic application, permissions and the account choices. The data is spec-local.
const helper = () => ec.resource.script("component://mr-mantle/test/account/AccountingSettlementFixtures.js")
const A = "mantle.account.payment.PaymentApplication",
    T = "mantle.ledger.transaction.AcctgTrans"
let f, invoiceId, receiptId, creditId, reviewed, result
function previewRequest() {
    const h = helper(),
        documentId = h.invoice(f, "1"),
        paymentId = h.payment(f, "1")
    const sourceKey = h.key("payment", paymentId),
        targetKey = h.key("invoice", documentId)
    const selected = h.native("find#OpenItems", Object.assign(h.scope(f), {selectedKeyList: [sourceKey, targetKey]}))
    return Object.assign(h.scope(f), {
        effectiveDate: f.timestamp,
        sourceVersions: selected.sourceVersions,
        allocations: [{sourceKey, targetKey, amount: "1"}]
    })
}
function refusal(action) {
    try {
        action()
        return ""
    } catch (error) {
        ec.message.clearErrors()
        return String(error.message)
    }
}
spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("ACCT_P5_SETTLE")
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        login("john.doe")
    },
    cleanupSpec() {
        login("john.doe")
        if (f?.org) helper().base.cleanupLocks(f.org)
    }
})
feature("open items show current balances and page metadata without payment method details", {
    when() {
        const h = helper()
        invoiceId = h.invoice(f)
        receiptId = h.payment(f)
        creditId = h.credit(f, invoiceId)
        login(f.users.ar)
        return {view: h.native("find#OpenItems", h.scope(f))}
    },
    then({view}) {
        view.complete == true
        view.capabilities.canApply == true
        view.invoiceRows.some(row => row.sourceId === invoiceId && toDecimal(row.remaining).eq(100))
        view.creditRows.some(row => row.sourceId === creditId && toDecimal(row.remaining).eq(25))
        view.paymentRows.some(row => row.sourceId === receiptId && toDecimal(row.remaining).eq(60))
        view.pageInfo.invoice.recordCount == 1
        view.paymentRows.every(row => row.paymentMethodId == null && row.paymentGatewayConfigId == null)
    }
})
feature("a receipt of 60 and a credit of 25 settle an invoice of 100 through the apply services on the reviewed day", {
    when() {
        const h = helper()
        login(f.users.ar)
        reviewed = h.review(f, [
            {sourceKey: h.key("payment", receiptId), targetKey: h.key("invoice", invoiceId), amount: "60"},
            {sourceKey: h.key("credit", creditId), targetKey: h.key("invoice", invoiceId), amount: "25"}
        ])
        const retained = h.native("get#SettlementPreview", {previewId: reviewed.previewId})
        result = h.confirm(reviewed)
        login("john.doe")
        const applications = result.applicationIds.map(id => h.lib.one(A, {paymentApplicationId: id}))
        const postings = result.applicationIds.flatMap(id => h.lib.rows(T, {paymentApplicationId: id}))
        return {retained, applications, postings}
    },
    then({retained, applications, postings}) {
        reviewed.operationKey == "settle-" + reviewed.previewId
        retained.operationKey == reviewed.operationKey
        retained.inputFingerprint == reviewed.inputFingerprint
        retained.beforeBalances.find(row => row.sourceId === invoiceId).remaining == "100"
        result.operationKey == reviewed.operationKey
        result.applicationIds.length == 2
        result.remainingRows.find(row => row.sourceId === invoiceId).remaining == 15
        result.acctgTransIds.length == 0
        applications.some(row => row.paymentId === receiptId && row.invoiceId === invoiceId)
        applications.some(row => row.invoiceId === creditId && row.toInvoiceId === invoiceId)
        applications.every(row => helper().lib.policy.calendarDateText(row.accountingDate) === f.day)
        postings.length == 2
        postings.every(row => row.isPosted === "Y" && helper().lib.policy.calendarDateText(row.accountingDate) === f.day)
    }
})
feature("a retry with the review's operation key answers the first result and a changed request with it refuses", {
    when() {
        const h = helper()
        login(f.users.ar)
        return {
            replay: h.confirm(reviewed),
            bad: h.rejected("apply#Settlement", {previewId: reviewed.previewId, inputFingerprint: "changed"})
        }
    },
    then({replay, bad}) {
        replay.alreadyApplied == true
        JSON.stringify(replay.applicationIds) == JSON.stringify(result.applicationIds)
        bad.includes("OPERATION_KEY_CONFLICT")
    }
})
feature("a reader, a Projects editor and a treasury user cannot review a settlement", {
    when() {
        const h = helper(),
            payload = previewRequest(),
            payer = h.user(f, "PAY_READ", ["PAYMENT_VIEW"])
        login(f.users.ar)
        const positive = h.native("preview#Settlement", payload)
        const denied = []
        login(f.users.edit)
        denied.push(h.rejected("find#OpenItems", h.scope(f)), h.rejected("preview#Settlement", payload))
        login(f.users.treasury)
        denied.push(h.rejected("preview#Settlement", payload))
        login(f.users.read)
        const read = h.native("find#OpenItems", h.scope(f))
        denied.push(h.rejected("preview#Settlement", payload))
        denied.push(h.rejected("find#SettlementAdjustmentAccounts", {organizationPartyId: f.org, effectiveDate: f.timestamp}))
        login(payer)
        const paymentView = h.native("find#OpenItems", h.scope(f))
        denied.push(h.rejected("preview#Settlement", payload))
        return {positive, read, paymentView, denied}
    },
    then({positive, read, paymentView, denied}) {
        positive.canApply == true
        read.capabilities.canApply == false
        paymentView.capabilities.canApply == false
        denied.length == 6
        denied.every(message => message.includes("PERMISSION_DENIED"))
    }
})
feature("a write-off and a discount are credit memos on the chosen account that settle the invoice", {
    when() {
        const h = helper()
        login(f.users.ar)
        const accounts = h.native("find#SettlementAdjustmentAccounts", {
            organizationPartyId: f.org,
            effectiveDate: f.timestamp,
            text: "5500",
            selectedIdList: ["550000000"]
        })
        const preview = h.review(
            f,
            [],
            [
                {invoiceId, itemTypeEnumId: "ItemWriteOff", amount: "10", glAccountId: "550000000", reason: "Small residual"},
                {invoiceId, itemTypeEnumId: "ItemPromptDiscount", amount: "5", glAccountId: "550000000", reason: "Early pay"}
            ]
        )
        const applied = h.confirm(preview)
        login("john.doe")
        const credits = applied.adjustmentInvoiceIds.map(id => ({
            invoice: h.lib.one(h.lib.invoiceEntity, {invoiceId: id}),
            items: h.lib.rows("mantle.account.invoice.InvoiceItem", {invoiceId: id})
        }))
        return {accounts, applied, credits, invoice: h.lib.one(h.lib.invoiceEntity, {invoiceId})}
    },
    then({accounts, applied, credits, invoice}) {
        accounts.rows.some(row => row.glAccountId === "550000000")
        accounts.selectedRows[0].glAccountId == "550000000"
        applied.adjustmentInvoiceIds.length == 2
        credits.every(
            row => row.invoice.invoiceTypeEnumId === "InvoiceCreditMemo" && row.invoice.creditForInvoiceId === invoiceId
        )
        credits.every(row => row.invoice.statusId === "InvoicePmtRecvd")
        credits.every(row => row.items.length === 1 && row.items[0].overrideGlAccountId === "550000000")
        credits
            .map(row => row.items[0].itemTypeEnumId)
            .sort()
            .join() == "ItemPromptDiscount,ItemWriteOff"
        invoice.statusId == "InvoicePmtRecvd"
        helper().lib.ms(invoice.paidDate) == Number(f.timestamp)
        applied.remainingRows.find(row => row.sourceId === invoiceId).remaining == 0
    }
})
feature("an adjustment without an account or with another item type is refused before any write", {
    when() {
        const h = helper(),
            a = h.invoice(f, "10"),
            before = h.count(A)
        login(f.users.ar)
        const messages = [
            {itemTypeEnumId: "ItemWriteOff", amount: "5", reason: "No account"},
            {itemTypeEnumId: "ItemTimeEntry", amount: "5", glAccountId: "550000000", reason: "Wrong type"}
        ].map(adjustment => refusal(() => h.review(f, [], [Object.assign({invoiceId: a}, adjustment)])))
        return {messages, before, after: h.count(A)}
    },
    then({messages, before, after}) {
        messages[0].includes("ADJUSTMENT_ACCOUNT_REQUIRED")
        messages[1].includes("ADJUSTMENT_REASON_REQUIRED")
        before == after
    }
})
feature("a receipt split over two invoices applies the reviewed amounts", {
    when() {
        const h = helper(),
            a = h.invoice(f, "30"),
            b = h.invoice(f, "50"),
            p = h.payment(f, "70")
        login(f.users.ar)
        const preview = h.review(f, [
            {sourceKey: h.key("payment", p), targetKey: h.key("invoice", a), amount: "30"},
            {sourceKey: h.key("payment", p), targetKey: h.key("invoice", b), amount: "40"}
        ])
        return {applied: h.confirm(preview), b}
    },
    then({applied, b}) {
        applied.applicationIds.length == 2
        toDecimal(applied.remainingRows.find(row => row.sourceId === b).remaining).eq(10)
    }
})
feature("combined allocations over a balance, an old revision, a sub-cent amount or an earlier day refuse without writes", {
    when() {
        const h = helper(),
            a = h.invoice(f, "50"),
            b = h.invoice(f, "50"),
            p = h.payment(f, "60"),
            before = h.count(A)
        login(f.users.ar)
        const list = h.native("find#OpenItems", Object.assign(h.scope(f), {selectedKeyList: [h.key("payment", p)]}))
        const messages = {
            overSource: refusal(() =>
                h.review(f, [
                    {sourceKey: h.key("payment", p), targetKey: h.key("invoice", a), amount: "40"},
                    {sourceKey: h.key("payment", p), targetKey: h.key("invoice", b), amount: "40"}
                ])
            ),
            stale: h.rejected(
                "preview#Settlement",
                Object.assign(h.scope(f), {
                    effectiveDate: f.timestamp,
                    sourceVersions: {[h.key("payment", p)]: list.sourceVersions[h.key("payment", p)]},
                    allocations: [{sourceKey: h.key("payment", p), targetKey: h.key("invoice", a), amount: "10"}]
                })
            ),
            precision: refusal(() =>
                h.review(f, [{sourceKey: h.key("payment", p), targetKey: h.key("invoice", a), amount: "0.001"}])
            ),
            earlier: refusal(() =>
                h.review(f, [{sourceKey: h.key("payment", p), targetKey: h.key("invoice", a), amount: "1"}], [], "receivable", {
                    effectiveDate: Number(f.timestamp) - 86400000
                })
            )
        }
        return {messages, before, after: h.count(A)}
    },
    then({messages, before, after}) {
        messages.overSource.includes("SETTLEMENT_EXCEEDS_BALANCE")
        messages.stale.includes("STALE_PREVIEW")
        messages.precision.includes("CURRENCY_PRECISION")
        messages.earlier.includes("APPLICATION_BEFORE_SOURCE")
        before == after
    }
})
feature("a payables settlement pays a bill, and a receivables user cannot read payables", {
    when() {
        const h = helper(),
            a = h.invoice(f, "20", "payable"),
            p = h.payment(f, "20", "payable")
        login(f.users.ar)
        const denied = h.rejected("find#OpenItems", h.scope(f, "payable"))
        login(f.users.ap)
        const preview = h.review(
            f,
            [{sourceKey: h.key("payment", p), targetKey: h.key("invoice", a), amount: "20"}],
            [],
            "payable"
        )
        return {denied, applied: h.confirm(preview), invoice: h.lib.one(h.lib.invoiceEntity, {invoiceId: a})}
    },
    then({denied, applied, invoice}) {
        denied.includes("PERMISSION_DENIED")
        applied.applicationIds.length == 1
        invoice.statusId == "InvoicePmtSent"
    }
})
feature("automatic application is a retained review of oldest due invoices, and without a review applies nothing", {
    when() {
        const h = helper(),
            p = h.payment(f, "2")
        login(f.users.ar)
        const unreviewed = h.native("autoApply#Payment", {organizationPartyId: f.org, paymentId: p})
        const list = h.native("find#OpenItems", Object.assign(h.scope(f), {selectedKeyList: [h.key("payment", p)]}))
        const preview = h.native("preview#PaymentAutoApplication", {
            organizationPartyId: f.org,
            paymentId: p,
            effectiveDate: f.timestamp,
            sourceVersion: list.sourceVersions[h.key("payment", p)]
        })
        const params = {
            organizationPartyId: f.org,
            paymentId: p,
            previewId: preview.previewId,
            inputFingerprint: preview.inputFingerprint
        }
        const first = h.native("autoApply#Payment", params),
            retry = h.native("autoApply#Payment", params)
        return {
            unreviewed,
            first,
            retry,
            preview,
            expectedFirst: list.invoiceRows[0].sourceId,
            applied: h.count(A, {paymentId: p})
        }
    },
    then({unreviewed, first, retry, preview, expectedFirst, applied}) {
        unreviewed.invoiceIdList.length == 0
        unreviewed.reasonCode == "SETTLEMENT_PREVIEW_REQUIRED"
        first.applicationIds.length > 0
        first.invoiceIdList[0] == expectedFirst
        retry.alreadyApplied == true
        JSON.stringify(first.applicationIds) == JSON.stringify(retry.applicationIds)
        preview.allocationRows.every(row => row.sourceKind === "payment")
        applied == first.applicationIds.length
    }
})
feature("retained posting lines are hidden once the owner loses ledger view, and an expired review cannot be confirmed", {
    when() {
        const h = helper(),
            user = h.user(f, "LEDGER", ["RECEIVABLE_EDIT", "RECEIVABLE_VIEW", "ACCOUNTING_VIEW"]),
            a = h.invoice(f, "3"),
            p = h.payment(f, "3")
        login(user)
        const preview = h.review(f, [{sourceKey: h.key("payment", p), targetKey: h.key("invoice", a), amount: "3"}])
        login("john.doe")
        h.call("delete#moqui.security.UserGroupPermission", {userGroupId: user, userPermissionId: "ACCOUNTING_VIEW", fromDate: 0})
        h.call("update#mantle.account.payment.PaymentReview", {
            previewId: preview.previewId,
            expiresDate: Number(ec.user.nowTimestamp) - 1
        })
        login(user)
        return {
            preview,
            retained: h.native("get#SettlementPreview", {previewId: preview.previewId}),
            expired: h.rejected("apply#Settlement", {previewId: preview.previewId, inputFingerprint: preview.inputFingerprint}),
            foreign: (login(f.users.ar), h.rejected("get#SettlementPreview", {previewId: preview.previewId}))
        }
    },
    then({preview, retained, expired, foreign}) {
        preview.ledgerPreview.length == 2
        retained.capabilities.canReadLedger == false
        retained.ledgerPreview.length == 0
        retained.status == "review"
        retained.canApply == false
        expired.includes("SETTLEMENT_PREVIEW_EXPIRED")
        foreign.includes("SETTLEMENT_PREVIEW_UNAVAILABLE")
    }
})
feature("account choices leave out an account whose assignment has ended", {
    when() {
        const h = helper(),
            account = "550000000",
            assignment = h.lib.one("mantle.ledger.account.GlAccountOrganization", {
                organizationPartyId: f.org,
                glAccountId: account
            })
        h.call("update#mantle.ledger.account.GlAccountOrganization", {
            organizationPartyId: f.org,
            glAccountId: account,
            thruDate: Number(f.timestamp) - 1
        })
        login(f.users.ar)
        try {
            return {
                view: h.native("find#SettlementAdjustmentAccounts", {
                    organizationPartyId: f.org,
                    effectiveDate: f.timestamp,
                    text: "550000000",
                    selectedIdList: [account, "412000000"]
                })
            }
        } finally {
            login("john.doe")
            h.call("update#mantle.ledger.account.GlAccountOrganization", {
                organizationPartyId: f.org,
                glAccountId: account,
                thruDate: assignment.thruDate
            })
        }
    },
    then({view}) {
        view.rows.length == 0
        view.selectedRows.every(row => row.glAccountId !== "550000000")
        view.selectedRows.some(row => row.glAccountId === "412000000")
    }
})
feature("a payment posted directly against its invoice settles that invoice with no extra posting", {
    when() {
        const h = helper(),
            a = h.invoice(f, "10"),
            direct = h.legacyDirectPayment(f, a, "10")
        login(f.users.ar)
        const preview = h.review(f, [
            {sourceKey: h.key("payment", direct.paymentId), targetKey: h.key("invoice", a), amount: "10"}
        ])
        const applied = h.confirm(preview)
        const id = applied.applicationIds[0]
        return {
            applied,
            application: h.lib.one(A, {paymentApplicationId: id}),
            postings: h.lib.rows(T, {paymentApplicationId: id}),
            invoice: h.lib.one(h.lib.invoiceEntity, {invoiceId: a})
        }
    },
    then({applied, application, postings, invoice}) {
        applied.allocationResults[0].reasonCode == "ALREADY_POSTED_DIRECT"
        application.acctgTransResultEnumId == "AtrPaymentNotPosted"
        postings.length == 0
        invoice.statusId == "InvoicePmtRecvd"
    }
})
feature("a direct payment restores only its whole remaining amount to its own invoice", {
    when() {
        const h = helper(),
            a = h.invoice(f, "10"),
            direct = h.legacyDirectPayment(f, a, "10"),
            before = h.count(A, {paymentId: direct.paymentId})
        login(f.users.ar)
        return {
            partial: refusal(() =>
                h.review(f, [{sourceKey: h.key("payment", direct.paymentId), targetKey: h.key("invoice", a), amount: "4"}])
            ),
            before,
            after: h.count(A, {paymentId: direct.paymentId})
        }
    },
    then({partial, before, after}) {
        partial.includes("DIRECT_PAYMENT_RESTORE_REQUIRED")
        before == after
    }
})
feature("a caller failure after a complete settlement rolls back its applications, credit memos, postings and key", {
    when() {
        const h = helper(),
            a = h.invoice(f, "10"),
            p = h.payment(f, "5"),
            preview = h.review(
                f,
                [{sourceKey: h.key("payment", p), targetKey: h.key("invoice", a), amount: "5"}],
                [{invoiceId: a, itemTypeEnumId: "ItemPromptDiscount", amount: "5", glAccountId: "550000000", reason: "Discount"}]
            )
        const counts = () => ({
            applications: h.count(A),
            invoices: h.count(h.lib.invoiceEntity),
            transactions: h.count(T)
        })
        const before = counts()
        const failure = refusal(() =>
            parallel(
                1,
                (thread, args) => {
                    login("john.doe")
                    ec.artifactExecution.disableAuthz()
                    const result = call("mantle.account.PaymentServices.apply#Settlement", args)
                    if (result.applicationIds.length !== 2) throw new Error("Unexpected result")
                    throw new Error("CALLER_FAILURE_AFTER_SETTLEMENT")
                },
                {previewId: preview.previewId, inputFingerprint: preview.inputFingerprint},
                {transaction: true, timeout: 30}
            )
        )
        return {
            failure,
            before,
            after: counts(),
            retained: h.native("get#SettlementPreview", {previewId: preview.previewId})
        }
    },
    then({failure, before, after, retained}) {
        failure.includes("CALLER_FAILURE_AFTER_SETTLEMENT")
        JSON.stringify(before) == JSON.stringify(after)
        retained.status == "review"
    }
})
feature("a settlement draft is kept for its owner behind an ID and read as none by another user", {
    when() {
        const h = helper()
        login(f.users.ar)
        const stored = h.native("store#SettlementDraft", {organizationPartyId: f.org, draftJson: '{"allocations":[]}'})
        const replaced = h.native("store#SettlementDraft", {
            organizationPartyId: f.org,
            draftId: stored.draftId,
            draftJson: '{"allocations":[1]}'
        })
        const own = h.native("get#SettlementDraft", {draftId: stored.draftId})
        const notPreview = h.rejected("get#SettlementPreview", {previewId: stored.draftId})
        login(f.users.ap)
        const other = h.native("get#SettlementDraft", {draftId: stored.draftId})
        login(f.users.read)
        const reader = h.rejected("store#SettlementDraft", {organizationPartyId: f.org, draftJson: "{}"})
        return {stored, replaced, own, notPreview, other, reader}
    },
    then({stored, replaced, own, notPreview, other, reader}) {
        replaced.draftId == stored.draftId
        own.draftJson == '{"allocations":[1]}'
        notPreview.includes("SETTLEMENT_PREVIEW_UNAVAILABLE")
        other.draftJson == null
        reader.includes("PERMISSION_DENIED")
    }
})
