// Standalone payment lifecycle fixtures; no application records or application groups are used.
const settlement = ec.resource.script("component://mr-mantle/test/account/AccountingSettlementFixtures.js")
const {lib, call} = settlement
// A fresh operation key for a test request.
function key(prefix) {
    return prefix + ec.entity.sequencedIdPrimary("AccountingPaymentLifecycleSpecKey", null, null)
}
function native(name, parameters) {
    return call("mantle.account.PaymentServices." + name, parameters)
}
function fixtures(prefix) {
    const f = settlement.fixtures(prefix)
    f.methodId = prefix + "_BANK"
    f.customerMethodId = prefix + "_CUSTOMER_BANK"
    for (const [paymentMethodId, ownerPartyId, number] of [
        [f.methodId, f.org, "123456789"],
        [f.customerMethodId, f.customer, "987654321"]
    ]) {
        call("create#mantle.account.method.PaymentMethod", {
            paymentMethodId,
            ownerPartyId,
            paymentMethodTypeEnumId: "PmtBankAccount",
            currencyUomId: "USD",
            fromDate: 0,
            description: ownerPartyId === f.org ? "Operating bank" : "Customer account",
            glAccountId: "111100000"
        })
        call("create#mantle.account.method.BankAccount", {
            paymentMethodId,
            bankName: "Native fixture bank",
            typeEnumId: "BatChecking",
            accountNumber: number,
            routingNumber: "111000025",
            lastCheckNumber: 100
        })
    }
    f.users.paymentView = settlement.user(f, "PAYMENT_READER", ["PAYMENT_VIEW"])
    f.users.paymentEditOnly = settlement.user(f, "PAYMENT_EDIT_ONLY", ["PAYMENT_EDIT"])
    return f
}
function request(f, extra = {}) {
    const module = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js"),
        method = lib.one("mantle.account.method.PaymentMethod", {paymentMethodId: f.methodId})
    return Object.assign(
        {
            organizationPartyId: f.org,
            cashDirection: "incoming",
            partyId: f.customer,
            amount: "60",
            currencyUomId: "USD",
            effectiveDate: f.timestamp,
            paymentInstrumentEnumId: "PiOther",
            organizationPaymentMethodId: f.methodId,
            organizationMethodVersion: module.methodVersion(method),
            referenceNumber: "Manual receipt",
            comments: "Native payment lifecycle",
            operationKey: key("life-create-")
        },
        extra
    )
}
function draft(f, extra = {}) {
    return native("create#PaymentDraft", request(f, extra)).paymentId
}
function detail(f, paymentId) {
    return native("get#PaymentFinanceDetail", {organizationPartyId: f.org, paymentId})
}
function preview(f, paymentId, action, extra = {}) {
    return native(
        "preview#PaymentState",
        Object.assign(
            {
                organizationPartyId: f.org,
                paymentId,
                action,
                sourceVersion: detail(f, paymentId).sourceVersion,
                referenceNumber: "Human reference",
                reason: "Verified manual instruction",
                settlementDate: f.timestamp
            },
            extra
        )
    )
}
function confirm(review, operationKey = key("life-state-")) {
    return native("change#PaymentState", {previewId: review.previewId, inputFingerprint: review.inputFingerprint, operationKey})
}
function delivered(f, extra = {}) {
    const paymentId = draft(f, extra)
    confirm(preview(f, paymentId, "deliver"))
    return paymentId
}
function rejected(name, parameters) {
    return settlement.rejected(name, parameters)
}
function count(entity, conditions) {
    return lib.find(entity, conditions).count()
}
function unapplyRequest(f, paymentId, ids = null) {
    const view = detail(f, paymentId),
        selected = view.applicationRows.filter(
            row => toDecimal(row.amountApplied || 0).compare(0) > 0 && (!ids || ids.includes(row.paymentApplicationId))
        )
    return {
        organizationPartyId: f.org,
        paymentId,
        sourceVersion: view.sourceVersion,
        paymentApplicationIdList: selected.map(row => row.paymentApplicationId),
        applicationVersions: Object.fromEntries(selected.map(row => [row.paymentApplicationId, row.version])),
        reason: "Correct reviewed allocation"
    }
}
function apply(f, paymentId, invoiceId, amount, direction = "receivable") {
    return settlement.confirm(
        settlement.review(
            f,
            [{sourceKey: settlement.key("payment", paymentId), targetKey: settlement.key("invoice", invoiceId), amount}],
            [],
            direction
        ),
        key("life-apply-")
    )
}
function rawApplication(values) {
    const id = values.paymentApplicationId || key("LIFE_APP_")
    return parallel(
        1,
        (thread, args) => {
            login("john.doe")
            ec.artifactExecution.disableAuthz()
            const value = ec.entity.makeValue("mantle.account.payment.PaymentApplication")
            for (const [field, input] of Object.entries(args)) value.set(field, input)
            value.create()
            return {paymentApplicationId: args.paymentApplicationId}
        },
        Object.assign({}, values, {paymentApplicationId: id}),
        {transaction: true, timeout: 30}
    )[0]
}
;({
    key,
    settlement,
    lib,
    call,
    native,
    fixtures,
    request,
    draft,
    detail,
    preview,
    confirm,
    delivered,
    rejected,
    count,
    unapplyRequest,
    apply,
    rawApplication
})
