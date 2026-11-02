// Internal transfer fixtures: the lifecycle organization's bank (cash 111100000, paid to a bank party for fees) and a
// destination bank with its own spec-local cash account, so a spec can make only the incoming side fail to post.
const lifecycle = ec.resource.script("component://mr-mantle/test/account/AccountingPaymentLifecycleFixtures.js")
const {lib, call, native} = lifecycle
function fixtures(prefix) {
    const f = lifecycle.fixtures(prefix)
    f.feeAccountId = "710000000"
    f.toCashAccountId = prefix + "_CASH"
    f.toMethodId = prefix + "_DEST_BANK"
    f.bankPartyId = prefix + "_BANK"
    call("create#mantle.ledger.account.GlAccountOrganization", {organizationPartyId: f.org, glAccountId: f.feeAccountId})
    call("create#mantle.ledger.account.GlAccount", {
        glAccountId: f.toCashAccountId,
        accountName: "Destination reserve cash",
        glAccountClassEnumId: "CASH_EQUIVALENT"
    })
    call("create#mantle.ledger.account.GlAccountOrganization", {organizationPartyId: f.org, glAccountId: f.toCashAccountId})
    call("create#mantle.party.Party", {partyId: f.bankPartyId, partyTypeEnumId: "PtyOrganization"})
    call("create#mantle.party.Organization", {partyId: f.bankPartyId, organizationName: prefix + " bank"})
    call("update#mantle.account.method.BankAccount", {paymentMethodId: f.methodId, bankPartyId: f.bankPartyId})
    call("create#mantle.account.method.PaymentMethod", {
        paymentMethodId: f.toMethodId,
        ownerPartyId: f.org,
        paymentMethodTypeEnumId: "PmtBankAccount",
        currencyUomId: "USD",
        fromDate: 0,
        description: "Destination reserve bank",
        glAccountId: f.toCashAccountId
    })
    call("create#mantle.account.method.BankAccount", {
        paymentMethodId: f.toMethodId,
        bankName: "Destination bank",
        typeEnumId: "BatChecking",
        accountNumber: "123123456",
        routingNumber: "111000025",
        lastCheckNumber: 1
    })
    // payment view and edit without ledger read
    f.users.transfer = lifecycle.settlement.user(f, "TRANSFER", ["PAYMENT_VIEW", "PAYMENT_EDIT"])
    return f
}
function request(f, extra = {}) {
    const workflow = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js"),
        version = paymentMethodId => workflow.methodVersion(lib.one("mantle.account.method.PaymentMethod", {paymentMethodId}))
    return Object.assign(
        {
            organizationPartyId: f.org,
            fromPaymentMethodId: f.methodId,
            fromMethodVersion: version(f.methodId),
            toPaymentMethodId: f.toMethodId,
            toMethodVersion: version(f.toMethodId),
            amount: "50",
            feeAmount: "0",
            currencyUomId: "USD",
            effectiveDate: f.timestamp,
            referenceNumber: "Bank transfer",
            reason: "Move cash to the reserve account"
        },
        extra
    )
}
function preview(f, extra = {}) {
    return native("preview#InternalTransfer", request(f, extra))
}
function confirm(review, operationKey = lifecycle.key("xfer-")) {
    return native("create#InternalTransfer", {
        previewId: review.previewId,
        inputFingerprint: review.inputFingerprint,
        operationKey
    })
}
// What a transfer creates in the organization: payments, transactions and issued documents.
function counts(f) {
    const payments = paymentTypeEnumId => lib.find("mantle.account.payment.Payment", {fromPartyId: f.org, paymentTypeEnumId})
    return {
        transfers: payments("PtInternalTransfer").count(),
        disbursements: payments("PtDisbursement").count(),
        transactions: lib.find("mantle.ledger.transaction.AcctgTrans", {organizationPartyId: f.org}).count()
    }
}
// The posted entries of a payment's transactions.
function entries(paymentId) {
    return lib
        .rows("mantle.ledger.transaction.AcctgTrans", {paymentId})
        .flatMap(tx =>
            lib
                .rows("mantle.ledger.transaction.AcctgTransEntry", {acctgTransId: tx.acctgTransId})
                .map(row => Object.assign({isPosted: tx.isPosted, acctgTransTypeEnumId: tx.acctgTransTypeEnumId}, row))
        )
}
;({lifecycle, lib, call, native, fixtures, request, preview, confirm, counts, entries})
