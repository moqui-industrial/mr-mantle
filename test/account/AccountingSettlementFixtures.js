// Standalone settlement fixtures; all organizations, users and evidence are spec-local.
const base = ec.resource.script("component://mr-mantle/test/ledger/AccountingReceivablesFixtures.js")
const {lib, call} = base
const services = "mantle.account.PaymentServices."
function native(name, p) {
    return call(services + name, p)
}
function fixtures(prefix) {
    const f = base.fixtures(prefix)
    f.day = ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd")
    f.timestamp = ec.l10n.parseTimestamp(f.day + " 12:00:00", "yyyy-MM-dd HH:mm:ss")
    return f
}
function scope(f, direction = "receivable") {
    return {organizationPartyId: f.org, partyId: f.customer, direction, currencyUomId: "USD"}
}
function invoice(f, amount = "100", direction = "receivable", extra = {}) {
    const receivable = direction === "receivable"
    const made = call(
        "create#mantle.account.invoice.Invoice",
        Object.assign(
            {
                invoiceTypeEnumId: "InvoiceSales",
                fromPartyId: receivable ? f.org : f.customer,
                toPartyId: receivable ? f.customer : f.org,
                statusId: receivable ? "InvoiceInProcess" : "InvoiceIncoming",
                invoiceDate: f.timestamp,
                accountingDate: f.day,
                currencyUomId: "USD",
                draftedByUserId: ec.user.userId
            },
            extra
        )
    )
    call("mantle.account.InvoiceServices.create#InvoiceItem", {
        invoiceId: made.invoiceId,
        quantity: "1",
        amount,
        itemTypeEnumId: "ItemTimeEntry",
        overrideGlAccountId: receivable ? "412000000" : "550000000",
        description: "Settlement source"
    })
    call("update#mantle.account.invoice.Invoice", {
        invoiceId: made.invoiceId,
        statusId: receivable ? "InvoiceFinalized" : "InvoiceApproved"
    })
    return made.invoiceId
}
function payment(f, amount = "60", direction = "receivable", extra = {}) {
    const receivable = direction === "receivable"
    const made = call(
        "mantle.account.PaymentServices.create#Payment",
        Object.assign(
            {
                fromPartyId: receivable ? f.customer : f.org,
                toPartyId: receivable ? f.org : f.customer,
                paymentTypeEnumId: "PtInvoicePayment",
                paymentInstrumentEnumId: "PiCompanyCheck",
                amount,
                amountUomId: "USD",
                statusId: "PmntDelivered",
                effectiveDate: f.timestamp
            },
            extra
        )
    )
    return made.paymentId
}
function credit(f, sourceInvoiceId, amount = "25") {
    const result = call("mantle.account.InvoiceServices.create#InvoiceCreditMemo", {
        organizationPartyId: f.org,
        originalInvoiceId: sourceInvoiceId,
        amount,
        linkToOriginal: true,
        allocateToLines: true,
        operationKey: "settle-credit-" + sourceInvoiceId
    })
    const row = lib.one(lib.invoiceEntity, {invoiceId: result.invoiceId})
    call("mantle.account.InvoiceServices.change#InvoiceState", {
        organizationPartyId: f.org,
        invoiceId: row.invoiceId,
        action: "finalize",
        lastUpdatedStamp: row.lastUpdatedStamp,
        operationKey: "settle-final-" + row.invoiceId
    })
    return row.invoiceId
}
function key(kind, id) {
    return kind + ":" + encodeURIComponent(id)
}
function review(f, allocations, adjustments = [], direction = "receivable", extra = {}) {
    const keys = [
        ...new Set([
            ...allocations.flatMap(row => [row.sourceKey, row.targetKey]),
            ...adjustments.map(row => key("invoice", row.invoiceId))
        ])
    ]
    const selected = native("find#OpenItems", Object.assign(scope(f, direction), {selectedKeyList: keys})).selectedRows
    const sourceVersions = Object.fromEntries(selected.map(row => [row.sourceKey, row.version]))
    return native(
        "preview#Settlement",
        Object.assign(scope(f, direction), {effectiveDate: f.timestamp, allocations, adjustments, sourceVersions}, extra)
    )
}
// Confirm a review with its own operation key, or with the one given.
function confirm(preview, operationKey = null) {
    return native(
        "apply#Settlement",
        Object.assign(
            {previewId: preview.previewId, inputFingerprint: preview.inputFingerprint},
            operationKey ? {operationKey} : {}
        )
    )
}
function count(entity, conditions = {}) {
    return lib.find(entity, conditions).count()
}
function rejected(name, p) {
    return base.rejected(name.includes(".") ? name : services + name, p)
}
function user(f, suffix, permissions) {
    const id = f.org.slice(0, 25) + "_" + suffix
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Settlement scoped user"})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: 0})
    call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    call("create#moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId: id,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        timeZone: "America/Chicago"
    })
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: 0})
    call("create#mantle.party.PartyRelationship", {
        fromPartyId: id,
        toPartyId: f.org,
        relationshipTypeEnumId: "PrtAgent",
        fromDate: 0
    })
    return id
}
function directPayment(f, invoiceId, amount = "10", postedAmount = amount) {
    const paymentId = payment(f, postedAmount)
    // Imported inconsistent legacy source: genuine cash posted for postedAmount, but the document claims amount.
    call("update#mantle.account.payment.Payment", {paymentId, amount: toDecimal(amount)})
    return paymentId
}
function clearImportedApplication(paymentApplicationId, invoiceIdToRestore = null) {
    const parameters = {
        paymentApplicationId,
        invoiceIdToRestore,
        username: ec.user.username,
        effectiveTime: Number(ec.user.nowTimestamp),
        currentContext: ec.transaction.isTransactionInPlace()
    }
    const updateImported = (thread, args) => {
        if (!args.currentContext) login(args.username)
        ec.user.setEffectiveTime(args.effectiveTime)
        ec.artifactExecution.disableAuthz()
        const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
        const application = lib.one("mantle.account.payment.PaymentApplication", {
            paymentApplicationId: args.paymentApplicationId
        })
        if (!application) throw new Error("Imported application is unavailable")
        // Raw entity update is deliberate: the service SECA would reverse and recreate the cash posting.
        application.set("amountApplied", toDecimal(0))
        application.update()
        if (args.invoiceIdToRestore) {
            const invoice = lib.one(lib.invoiceEntity, {invoiceId: args.invoiceIdToRestore})
            invoice.set("statusId", "InvoiceFinalized")
            invoice.update()
        }
        return {paymentApplicationId: args.paymentApplicationId}
    }
    return parameters.currentContext
        ? updateImported(0, parameters)
        : parallel(1, updateImported, parameters, {transaction: true, timeout: 30})[0]
}
function legacyDirectPayment(f, invoiceId, amount = "10") {
    const made = call("mantle.account.PaymentServices.create#InvoicePayment", {
        invoiceId,
        amount,
        effectiveDate: f.timestamp,
        paymentStatusId: "PmntDelivered",
        paymentInstrumentEnumId: "PiCompanyCheck"
    })
    const application =
        lib.one("mantle.account.payment.PaymentApplication", {paymentApplicationId: made.paymentApplicationId}) ||
        lib.rows("mantle.account.payment.PaymentApplication", {paymentId: made.paymentId})[0]
    if (!application) throw new Error("Real legacy direct cash source needs its initial application")
    // A migrated zero application keeps its direct cash posting; reapplying it to the same invoice needs no new posting.
    clearImportedApplication(application.paymentApplicationId, invoiceId)
    return {paymentId: made.paymentId, originalApplicationId: application.paymentApplicationId}
}
;({
    base,
    lib,
    call,
    native,
    fixtures,
    scope,
    invoice,
    payment,
    credit,
    key,
    review,
    confirm,
    count,
    rejected,
    user,
    directPayment,
    legacyDirectPayment,
    clearImportedApplication
})
