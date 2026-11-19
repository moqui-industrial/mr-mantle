// A customer's or supplier's payment methods for treasury, masked: a bank account shows its bank and last four digits
// only. A method whose bank account cannot be read is logged and left out. Its identifications, masked, never a tax one.
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const {find, one, denied} = lib
// SEC-BOS-82: identifications that are tax fields, payroll's and tax setup's (the same list as humanres/Employees.js
// taxIdTypes): never answered or written by Accounting's customer and supplier finance
const taxIdTypes = ["PtidSsn", "PtidFein", "PtidFuid"]
const masked = value => (value ? "•••• " + String(value).slice(-4) : "")
function paymentMethods(p) {
    const methods = Array.from(
        find("mantle.account.method.PaymentMethod", {ownerPartyId: p.customerPartyId})
            .conditionDate("fromDate", "thruDate", null)
            .orderBy("paymentMethodId")
            .limit(100)
            .list()
    )
    const rows = []
    for (const method of methods) {
        try {
            const bank = one("mantle.account.method.BankAccount", {paymentMethodId: method.paymentMethodId})
            const digits = bank?.accountNumber ? String(bank.accountNumber).slice(-4) : ""
            rows.push({
                paymentMethodId: method.paymentMethodId,
                paymentMethodTypeEnumId: method.paymentMethodTypeEnumId,
                description: bank ? (bank.bankName || "Bank account") + (digits ? " •••• " + digits : "") : method.description,
                bankName: bank?.bankName || "",
                maskedAccountNumber: digits ? "•••• " + digits : "",
                fromDate: method.fromDate,
                thruDate: method.thruDate,
                lastUpdatedStamp: method.lastUpdatedStamp
            })
        } catch (error) {
            ec.logger.error("Customer " + p.customerPartyId + " payment method " + method.paymentMethodId + ": " + error.message)
        }
    }
    return {paymentMethods: rows}
}
// A party's identifications other than the tax ones, each value masked to its last four characters (as People's
// Employees.js shows them), with what an edit needs; the whole value never leaves the server.
function identifications(p) {
    const rows = Array.from(
        find("mantle.party.PartyIdentification", {partyId: p.partyId})
            .condition("partyIdTypeEnumId", "not-in", taxIdTypes)
            .orderBy("partyIdTypeEnumId")
            .limit(100)
            .list()
    )
    return {
        identifications: rows.map(row => ({
            partyId: row.partyId,
            partyIdTypeEnumId: row.partyIdTypeEnumId,
            valueText: masked(row.idValue),
            issuedBy: row.issuedBy,
            issuedByPartyId: row.issuedByPartyId,
            expireDate: row.expireDate,
            lastUpdatedStamp: row.lastUpdatedStamp
        }))
    }
}
const operations = {paymentMethods, identifications}
;({
    taxIdTypes,
    execute: (op, parameters) => {
        if (!operations[op]) denied("OPERATION_UNKNOWN", "Unknown customer finance operation " + op)
        return operations[op](parameters)
    }
})
