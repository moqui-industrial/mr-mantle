// Outgoing bank files: NACHA (mantle.ext.account.NachaServices) and Positive Pay in each supported format
// (PositivePayServices). New spec, no Groovy original.
const organizationPartyId = "ORG_ZIZI_RETAIL"
const effectiveTime = Date.now()
let payeeId, companyBankId, payeeBankId, achPaymentIds = [], nachaOut

spec({
    stepwise: true,
    tempSequences: { start: 56500, banks: { "mantle.party.Party": 10, "mantle.account.payment.Payment": 40,
        "mantle.account.method.PaymentMethod": 20, "mantle.account.method.PaymentMethodFile": 10 } },
    setupSpec() {
        login("john.doe")
        ec.user.setEffectiveTime(effectiveTime)
    },
    setup() { ec.artifactExecution.disableAuthz() },
    cleanup() { ec.artifactExecution.enableAuthz() },
})

function errorOf(name, params) {
    try { call(name, params) } catch (e) { ec.message.clearErrors(); return String(e.message) }
    return null
}

feature("set up a company bank account with NACHA settings, a payee and ACH payments", {
    when() {
        payeeId = call("mantle.party.PartyServices.create#Person", { firstName: "Pat", lastName: "Payee" }).partyId
        companyBankId = call("mantle.account.PaymentMethodServices.create#BankAccount", { ownerPartyId: organizationPartyId,
                description: "Company ACH", bankName: "Test Bank", routingNumber: "021000021", accountNumber: "5550001234",
                typeEnumId: "BatChecking", currencyUomId: "USD", companyNameOnAccount: "Ziziwork Retail",
                nachaImmedDest: "021000021", nachaImmedOrig: "1234567890", nachaCompanyId: "1234567890",
                nachaEntryDescription: "PAYROLL" }).paymentMethodId
        payeeBankId = call("mantle.account.PaymentMethodServices.create#BankAccount", { ownerPartyId: payeeId, description: "Payee Checking",
                bankName: "Payee Bank", routingNumber: "011000015", accountNumber: "111222333", typeEnumId: "BatChecking",
                firstNameOnAccount: "Pat", lastNameOnAccount: "Payee" }).paymentMethodId
        for (const amount of ["100.25", "2000.00"]) {
            achPaymentIds.push(call("mantle.account.PaymentServices.create#Payment", { fromPartyId: organizationPartyId, toPartyId: payeeId,
                    amount, amountUomId: "USD", paymentMethodId: companyBankId, toPaymentMethodId: payeeBankId,
                    paymentInstrumentEnumId: "PiAch", statusId: "PmntAuthorized", effectiveDate: effectiveTime - 3600000 }).paymentId)
        }
        return { ids: [payeeId, companyBankId, payeeBankId, ...achPaymentIds] }
    },
    then({ ids }) {
        ids.every(id => id != null)
        achPaymentIds.length == 2
    },
})

feature("generate a NACHA file", {
    when() {
        nachaOut = call("mantle.ext.account.NachaServices.generate#NachaFile", { paymentMethodId: companyBankId, addNewLine: true, addOffsetRecord: true,
                effectiveEntryDate: "2026-12-15" })
        const lines = nachaOut.fileText.split("\n").filter(l => l.length)
        const file = ec.entity.find("mantle.account.method.PaymentMethodFile").condition("paymentMethodFileId", nachaOut.paymentMethodFileId).one()
        const payments = achPaymentIds.map(id => ec.entity.find("mantle.account.payment.Payment").condition("paymentId", id).one())
        return { lines, file, payments }
    },
    then({ lines, file, payments }) {
        // file header, batch header, two credits, one offset debit, batch control, file control, then 9-filled lines to a
        // multiple of ten records
        lines.length == 10
        lines.every(l => l.length == 94)
        lines[0].startsWith("101")
        lines[1].startsWith("5200")
        lines[2].startsWith("622")
        lines[2].includes("011000015")
        lines[3].startsWith("622")
        lines[4].startsWith("627")
        lines[5].startsWith("8200")
        lines[6].startsWith("9")
        lines.slice(7).every(l => l == "9".repeat(94))
        lines[2].substring(29, 39) == "0000010025"
        lines[3].substring(29, 39) == "0000200000"
        file.fileTypeEnumId == "PmftNacha"
        payments.every(p => p.paymentMethodFileId == nachaOut.paymentMethodFileId)
    },
})

feature("a second NACHA run has nothing to send, and bad configuration is refused", {
    when() {
        const again = call("mantle.ext.account.NachaServices.generate#NachaFile", { paymentMethodId: companyBankId })
        const missing = errorOf("mantle.ext.account.NachaServices.generate#NachaFile", { paymentMethodId: "NO_SUCH_METHOD" })
        return { again, missing }
    },
    then({ again, missing }) {
        again.fileText == null
        missing.includes("is not a bank account")
    },
})

// SEC-BOS-123: a payee's name with a line break or a letter whose upper case is longer (ß) neither splits nor lengthens a
// record: NACHA's name is upper case printable ASCII cut to its 22 columns, Positive Pay's printable ASCII
feature("a payee's name with a line break stays one field of one record in NACHA and Positive Pay", {
    when() {
        const oddId = call("mantle.party.PartyServices.create#Person", { firstName: "Pat\nEvil", lastName: "Straße" }).partyId
        const oddBankId = call("mantle.account.PaymentMethodServices.create#BankAccount", { ownerPartyId: oddId, description: "Odd Checking",
                bankName: "Payee Bank", routingNumber: "011000015", accountNumber: "444555666", typeEnumId: "BatChecking" }).paymentMethodId
        call("mantle.account.PaymentServices.create#Payment", { fromPartyId: organizationPartyId, toPartyId: oddId, amount: "12.00",
                amountUomId: "USD", paymentMethodId: companyBankId, toPaymentMethodId: oddBankId, paymentInstrumentEnumId: "PiAch",
                statusId: "PmntAuthorized", effectiveDate: effectiveTime - 3600000 })
        const nacha = call("mantle.ext.account.NachaServices.generate#NachaFile", { paymentMethodId: companyBankId, addNewLine: true,
                effectiveEntryDate: "2026-12-16" }).fileText.split("\n").filter(l => l.length)
        const checkBankId = call("mantle.account.PaymentMethodServices.create#BankAccount", { ownerPartyId: organizationPartyId,
                description: "PosPay odd payee", bankName: "Test Bank", routingNumber: "021000021", accountNumber: "7770009999",
                typeEnumId: "BatChecking", currencyUomId: "USD", posPayFormatEnumId: "PmftCityBankCnb", posPayBankNumber: "123" }).paymentMethodId
        call("mantle.account.PaymentServices.create#Payment", { fromPartyId: organizationPartyId, toPartyId: oddId, amount: "30.00", amountUomId: "USD",
                paymentMethodId: checkBankId, paymentRefNum: "3001", paymentInstrumentEnumId: "PiCompanyCheck", statusId: "PmntDelivered",
                effectiveDate: effectiveTime - 3600000 })
        const posPay = call("mantle.ext.account.PositivePayServices.generate#PositivePayFile", { paymentMethodId: checkBankId })
                .fileText.split("\n").filter(l => l.length)
        return { nacha, posPay }
    },
    then({ nacha, posPay }) {
        nacha.length == 10
        nacha.every(l => l.length == 94 && !/[^\x20-\x7E]/.test(l))
        nacha[2].includes("PAT EVIL STRASSE")
        posPay.length == 1
        posPay[0].length == 87 && posPay[0].includes("Pat Evil Straße".normalize("NFKD").replace(/[^\x20-\x7E]/g, " "))
    },
})

// SEC-BAP-08: a caller whom an app root's grant lets run the bank file services, with no finance authority, is refused by
// the services themselves (check#BankAccess); the holder's runs are the features above, with authorization off as a job's
feature("the bank file services refuse a caller without finance authority in the bank account's organization", {
    when() {
        const since = effectiveTime - 86400000
        call("create#moqui.security.UserGroup", { userGroupId: "BOF_SPEC_NOFIN", description: "Bank files spec: no finance authority" })
        call("create#moqui.security.ArtifactGroup", { artifactGroupId: "BOF_SPEC_FILES", description: "Bank file services" })
        call("create#moqui.security.ArtifactGroupMember", { artifactGroupId: "BOF_SPEC_FILES", artifactTypeEnumId: "AT_SERVICE",
                artifactName: "mantle\\.(ext\\.account\\.(NachaServices|OfxServices|PositivePayServices)|account\\.ReconciliationServices)\\..*", nameIsPattern: "Y", inheritAuthz: "Y" })
        call("create#moqui.security.ArtifactAuthz", { artifactAuthzId: "BOF_SPEC_FILES", artifactGroupId: "BOF_SPEC_FILES",
                userGroupId: "BOF_SPEC_NOFIN", authzTypeEnumId: "AUTHZT_ALLOW", authzActionEnumId: "AUTHZA_ALL" })
        const partyId = call("mantle.party.PartyServices.create#Person", { firstName: "No", lastName: "Finance" }).partyId
        call("mantle.party.PartyServices.create#PartyUserAccount", { partyId, username: "bof.nofinance", emailAddress: "bof.nofinance@example.com",
                newPassword: "moqui1!!", newPasswordVerify: "moqui1!!" })
        const userId = ec.entity.find("moqui.security.UserAccount").condition("username", "bof.nofinance").one().userId
        call("create#moqui.security.UserGroupMember", { userGroupId: "BOF_SPEC_NOFIN", userId, fromDate: since })
        login("bof.nofinance", "moqui1!!")
        ec.artifactExecution.enableAuthz()
        try {
            return {
                nacha: errorOf("mantle.ext.account.NachaServices.generate#NachaFile", { paymentMethodId: companyBankId }),
                ofx: errorOf("mantle.ext.account.OfxServices.import#OfxVersion1", { paymentMethodId: companyBankId, ofxString: "OFXHEADER:100" }),
                nachaReturn: errorOf("mantle.ext.account.NachaServices.import#NachaReturn", { paymentMethodId: companyBankId, nachaString: "9" }),
            }
        } finally {
            ec.artifactExecution.disableAuthz()
            login("john.doe")
        }
    },
    then({ nacha, ofx, nachaReturn }) {
        nacha != null && nacha.includes("Accounting access is required")
        ofx != null && ofx.includes("Accounting access is required")
        nachaReturn != null && nachaReturn.includes("Accounting access is required")
    },
})

// SEC-BAP-08 (the owner's decision of Nov 16, 2026): a NACHA or Positive Pay file tells the bank to pay, so a direct caller needs
// what approving a payment run needs, PAYMENT_RUN_APPROVE in the bank account's organization; a finance reader there is refused.
// Both are agents of the organization (AccountingSettlementFixtures user) and run the services through the spec's ALLOW group.
// The REST resources that write the files are POST only: a GET is not served and writes nothing.
feature("a NACHA or Positive Pay file needs payment run approval authority: a finance reader is refused, an approver is answered", {
    when() {
        const h = ec.resource.script("component://mr-mantle/test/account/AccountingSettlementFixtures.js")
        const f = { org: organizationPartyId }
        const reader = h.user(f, "BOF_READ", ["ACCOUNTING_VIEW", "PAYMENT_VIEW"])
        const approver = h.user(f, "BOF_APPROVE", ["ACCOUNTING_VIEW", "PAYMENT_RUN_APPROVE"])
        for (const userId of [reader, approver])
            call("create#moqui.security.UserGroupMember", { userGroupId: "BOF_SPEC_NOFIN", userId, fromDate: effectiveTime - 86400000 })
        const as = (userId, run) => {
            login(userId)
            ec.artifactExecution.enableAuthz()
            try { return run() } finally { ec.artifactExecution.disableAuthz(); login("john.doe") }
        }
        // a check account with a Positive Pay format and no checks
        const checkBankId = call("mantle.account.PaymentMethodServices.create#BankAccount", { ownerPartyId: organizationPartyId,
                description: "PosPay approval", bankName: "Test Bank", routingNumber: "021000021", accountNumber: "7770009999",
                typeEnumId: "BatChecking", currencyUomId: "USD", posPayFormatEnumId: "PmftZionsBankCsv", posPayBankNumber: "123" }).paymentMethodId
        const NACHA = "mantle.ext.account.NachaServices.generate#NachaFile", POSPAY = "mantle.ext.account.PositivePayServices.generate#PositivePayFile"
        const refused = as(reader, () => ({ nacha: errorOf(NACHA, { paymentMethodId: companyBankId }),
                posPay: errorOf(POSPAY, { paymentMethodId: checkBankId }) }))
        // nothing is left to send (the features above sent it), so the approver's answer is an empty file, not a refusal
        const answered = as(approver, () => {
            const nacha = call(NACHA, { paymentMethodId: companyBankId })
            const posPay = call(POSPAY, { paymentMethodId: checkBankId })
            const errors = ec.message.getErrorsString() || ""
            ec.message.clearErrors()
            return { nacha, posPay, errors }
        })
        // the REST resources as an administrator: a GET is not served and writes no file
        const filesBefore = ec.entity.find("mantle.account.method.PaymentMethodFile").count()
        const gets = ["nacha", "positivePay"].map(name =>
            screenTest("rest").render("s1/mantle/parties/paymentMethods/" + (name == "nacha" ? companyBankId : checkBankId) + "/" + name, null, "get"))
        const filesAfter = ec.entity.find("mantle.account.method.PaymentMethodFile").count()
        ec.message.clearErrors()
        return { refused, answered, gets: gets.map(out => ({ status: out.status, errors: String(out.errorMessages || ""), output: String(out.output || "") })),
            filesBefore, filesAfter }
    },
    then({ refused, answered, gets, filesBefore, filesAfter }) {
        refused.nacha != null && refused.nacha.includes("runApprove authority is required")
        refused.posPay != null && refused.posPay.includes("runApprove authority is required")
        answered.errors == ""
        answered.nacha.fileText == null
        answered.posPay.paymentCount == 0 && answered.posPay.paymentMethodFileId == null
        gets.every(out => out.status == 405)
        filesAfter == filesBefore
    },
})

const formats = ["PmftBankOfAmericaAr", "PmftCityBankCnb", "PmftSunTrustCpr", "PmftWachoviaAr", "PmftWellsFargoArp", "PmftZionsBankCsv"]
feature("generate Positive Pay files #format", {
    where: formats.map(format => ({ format })),
    when(ctx) {
        const format = ctx.format
        const bankId = call("mantle.account.PaymentMethodServices.create#BankAccount", { ownerPartyId: organizationPartyId,
                description: "PosPay " + format, bankName: "Test Bank", routingNumber: "021000021", accountNumber: "7770001234",
                typeEnumId: "BatChecking", currencyUomId: "USD", posPayFormatEnumId: format, posPayBankNumber: "123" }).paymentMethodId
        for (const [index, amount] of ["150.00", "75.50"].entries()) {
            call("mantle.account.PaymentServices.create#Payment", { fromPartyId: organizationPartyId, toPartyId: payeeId, amount, amountUomId: "USD",
                    paymentMethodId: bankId, paymentRefNum: String(2001 + index), paymentInstrumentEnumId: "PiCompanyCheck",
                    statusId: "PmntDelivered", effectiveDate: effectiveTime - 3600000 })
        }
        const out = call("mantle.ext.account.PositivePayServices.generate#PositivePayFile", { paymentMethodId: bankId })
        const payments = ec.entity.find("mantle.account.payment.Payment").condition("paymentMethodId", bankId).list()
        return { out, payments }
    },
    then({ out, payments }) {
        out.paymentCount == 2
        out.fileText.length > 0
        out.fileText.includes("2001")
        out.fileText.includes("2002")
        payments.every(p => p.paymentMethodFileId == out.paymentMethodFileId)
    },
})

feature("Positive Pay is refused without a format", {
    when() {
        const noFormat = errorOf("mantle.ext.account.PositivePayServices.generate#PositivePayFile", { paymentMethodId: companyBankId })
        return { noFormat }
    },
    then({ noFormat }) {
        noFormat.includes("No Pos. Pay File Format")
    },
})

// SEC-BOS-81: the bank's channel (a system message's consume, authorization off) names payments by id too, so an entry is held
// to the bank account's ACH payments, and a return to the entry's amount: one of another bank account, a return at another
// amount, an X id two payments end with, and any entry when an empty list of payments is given are skipped. A notification of
// change (98, a zero amount) is recorded once and changes no payment. An id longer than 15 is written and read as "X" and its
// rightmost 14 characters.
feature("import a NACHA return: returns decline their payments, the others are skipped, a change is recorded, a bad line is an error", {
    when() {
        const pad = (text, n) => String(text).padEnd(n, " ").slice(0, n)
        const entry = (paymentId, amountCents) => "6" + "26" + "01100001" + "5" + pad("111222333", 17) + String(amountCents).padStart(10, "0") + pad(paymentId, 15) +
                pad("Pat Payee", 22) + "  " + "1" + "011000010000001"
        const returnAddenda = (reason, info) => "7" + "99" + reason + "011000010000001" + "      " + "01100001" + pad(info, 44) + "011000010000009"
        const changeAddenda = (changeCode, corrected) => "7" + "98" + changeCode + "011000010000001" + "      " + "01100001" + pad(corrected, 29) +
                " ".repeat(15) + "011000010000008"
        const file = lines => lines.concat(["9" + " ".repeat(93)]).join("\n")
        const importReturn = (nachaString, extra = {}) =>
            call("mantle.ext.account.NachaServices.import#NachaReturn", Object.assign({ paymentMethodId: companyBankId, nachaString }, extra))
        const payment = paymentId => ec.entity.find("mantle.account.payment.Payment").condition("paymentId", paymentId).one()
        const responsesOf = paymentId => Array.from(ec.entity.find("mantle.account.method.PaymentGatewayResponse").condition("paymentId", paymentId).list())
        const ach = (paymentId, amount, statusId = "PmntDelivered") => call("create#mantle.account.payment.Payment", { paymentId, fromPartyId: organizationPartyId,
                toPartyId: payeeId, amount, amountUomId: "USD", paymentMethodId: companyBankId, toPaymentMethodId: payeeBankId,
                paymentInstrumentEnumId: "PiAch", paymentTypeEnumId: "PtInvoicePayment", statusId, effectiveDate: effectiveTime - 3600000 }).paymentId
        // a payee's own ACH payment from its bank account, of the same amount: not this bank account's
        const foreignId = call("create#mantle.account.payment.Payment", { fromPartyId: payeeId, toPartyId: organizationPartyId, amount: "100.25",
                amountUomId: "USD", paymentMethodId: payeeBankId, paymentInstrumentEnumId: "PiAch", statusId: "PmntDelivered",
                effectiveDate: effectiveTime - 3600000 }).paymentId
        // a long id sent in a NACHA file and returned by its X id; two long ids with the same rightmost 14 characters
        const longId = ach("BOF_LONG_A_00000000000001", "12.34", "PmntAuthorized")
        const sent = call("mantle.ext.account.NachaServices.generate#NachaFile", { paymentMethodId: companyBankId, paymentIdList: [longId] })
        const twinIds = [ach("BOF_LONG_B_77700000000002", "5.00"), ach("BOF_LONG_C_77700000000002", "5.00")]
        const nocId = ach(null, "50.00")
        importReturn(file([entry(foreignId, 10025), returnAddenda("R01", "Insufficient funds"),
                entry(achPaymentIds[1], 200001), returnAddenda("R01", "Insufficient funds"),
                entry("X" + twinIds[0].slice(-14), 500), returnAddenda("R03", "No account"),
                entry("X" + longId.slice(-14), 1234), returnAddenda("R03", "No account"),
                entry(achPaymentIds[0], 10025), returnAddenda("R01", "Insufficient funds")]))
        // an empty list of payments admits none
        importReturn(file([entry(nocId, 5000), returnAddenda("R01", "Insufficient funds")]), { paymentIdList: [] })
        const afterEmptyList = payment(nocId).statusId
        // a notification of change has a zero amount; imported twice it is recorded once and the payment stays delivered
        const noc = file([entry(nocId, 0), changeAddenda("C01", "998877665544")])
        importReturn(noc)
        importReturn(noc)
        // the service adds its errors to the message facade without stopping, so read them from there
        const errorsOf = (nachaString) => {
            ec.service.sync().name("mantle.ext.account.NachaServices.import#NachaReturn").parameters({ paymentMethodId: companyBankId, nachaString }).call()
            const text = ec.message.getErrorsString()
            ec.message.clearErrors()
            return text
        }
        const short = errorsOf("6short")
        return { returned: payment(achPaymentIds[0]), responses: responsesOf(achPaymentIds[0]), short, foreign: payment(foreignId),
            wrongAmount: payment(achPaymentIds[1]), sentText: sent.fileText || "", long: payment(longId), twins: twinIds.map(payment),
            afterEmptyList, noc: payment(nocId), nocResponses: responsesOf(nocId), longId }
    },
    then({ returned, responses, short, foreign, wrongAmount, sentText, long, twins, afterEmptyList, noc, nocResponses, longId }) {
        returned.statusId == "PmntDeclined"
        responses.length == 1
        responses.some(r => r.reasonCode == "R01")
        foreign.statusId == "PmntDelivered"
        wrongAmount.statusId == "PmntDelivered"
        sentText.includes("X" + longId.slice(-14))
        long.statusId == "PmntDeclined"
        twins.every(row => row.statusId == "PmntDelivered")
        afterEmptyList == "PmntDelivered"
        noc.statusId == "PmntDelivered"
        nocResponses.length == 1
        nocResponses[0].reasonCode == "C01"
        nocResponses[0].reasonMessage.includes("998877665544")
        short.includes("Length of the line is incorrect")
    },
})

feature("system messages carry the files: a return is consumed, a file is queued, and the positive pay job sends its file", {
    when() {
        call("create#moqui.service.message.SystemMessageType", { systemMessageTypeId: "TestAchReturn", description: "Test ACH return",
                consumeServiceName: "mantle.ext.account.NachaServices.consume#NachaReturnSystemMessage" })
        call("create#moqui.service.message.SystemMessageType", { systemMessageTypeId: "TestBankOut", description: "Test outgoing bank file" })
        call("create#moqui.service.message.SystemMessageRemote", { systemMessageRemoteId: "TEST_BANK", description: "Test bank", systemMessageTypeId: "TestBankOut" })
        call("create#mantle.account.method.PaymentMethodFileType", { paymentMethodId: companyBankId, fileTypeEnumId: "PmftNacha",
                systemMessageTypeId: "TestAchReturn", systemMessageRemoteId: "TEST_BANK" })
        const pad = (text, n) => String(text).padEnd(n, " ").slice(0, n)
        const entry = "6" + "26" + "01100001" + "5" + pad("111222333", 17) + "0000200000" + pad(achPaymentIds[1], 15) + pad("Pat Payee", 22) + "  " + "1" + "011000010000002"
        const addenda = "7" + "99" + "R02" + "011000010000002" + "      " + "01100001" + pad("Account closed", 44) + "011000010000009"
        const messageId = call("create#moqui.service.message.SystemMessage", { systemMessageTypeId: "TestAchReturn", systemMessageRemoteId: "TEST_BANK", isOutgoing: "N",
                statusId: "SmsgReceived", messageText: [entry, addenda, "9" + " ".repeat(93)].join("\n"), initDate: effectiveTime }).systemMessageId
        call("mantle.ext.account.NachaServices.consume#NachaReturnSystemMessage", { systemMessageId: messageId })
        const declined = ec.entity.find("mantle.account.payment.Payment").condition("paymentId", achPaymentIds[1]).one()
        // queue the NACHA file that was generated earlier as an outgoing message, once
        const notFound = call("mantle.account.PaymentMethodServices.produce#PaymentMethodFileSystemMessage", { paymentMethodFileId: "NO_SUCH_FILE" })
        const noConfig = call("mantle.account.PaymentMethodServices.produce#PaymentMethodFileSystemMessage", { paymentMethodFileId: nachaOut.paymentMethodFileId })
        const queued = call("mantle.account.PaymentMethodServices.produce#PaymentMethodFileSystemMessage", { paymentMethodFileId: nachaOut.paymentMethodFileId,
                systemMessageTypeId: "TestBankOut", systemMessageRemoteId: "TEST_BANK" })
        const again = call("mantle.account.PaymentMethodServices.produce#PaymentMethodFileSystemMessage", { paymentMethodFileId: nachaOut.paymentMethodFileId,
                systemMessageTypeId: "TestBankOut", systemMessageRemoteId: "TEST_BANK" })
        const message = ec.entity.find("moqui.service.message.SystemMessage").condition("systemMessageId", queued.systemMessageId).one()
        return { declined, notFound, noConfig, queued, again, message }
    },
    then({ declined, queued, again, message }) {
        declined.statusId == "PmntDeclined"
        queued.systemMessageId != null
        again.systemMessageId == null
        message.isOutgoing == "Y"
        message.paymentMethodFileId == nachaOut.paymentMethodFileId
    },
})

feature("the positive pay job generates the file and queues it, and does nothing when there are no checks", {
    when() {
        const bankId = call("mantle.account.PaymentMethodServices.create#BankAccount", { ownerPartyId: organizationPartyId, description: "PosPay Job",
                bankName: "Test Bank", routingNumber: "021000021", accountNumber: "8880001234", typeEnumId: "BatChecking", currencyUomId: "USD",
                posPayFormatEnumId: "PmftWachoviaAr", posPayBankNumber: "123" }).paymentMethodId
        call("create#mantle.account.method.PaymentMethodFileType", { paymentMethodId: bankId, fileTypeEnumId: "PmftWachoviaAr",
                systemMessageTypeId: "TestBankOut", systemMessageRemoteId: "TEST_BANK" })
        const empty = call("mantle.ext.account.PositivePayServices.send#PositivePayJob", { paymentMethodId: bankId })
        call("mantle.account.PaymentServices.create#Payment", { fromPartyId: organizationPartyId, toPartyId: payeeId, amount: "99.00", amountUomId: "USD",
                paymentMethodId: bankId, paymentRefNum: "3001", paymentInstrumentEnumId: "PiCompanyCheck", statusId: "PmntDelivered", effectiveDate: effectiveTime - 3600000 })
        const sent = call("mantle.ext.account.PositivePayServices.send#PositivePayJob", { paymentMethodId: bankId, lookBackDays: 5 })
        return { empty, sent }
    },
    then({ empty, sent }) {
        empty.paymentMethodFileId == null
        sent.paymentMethodFileId != null
        sent.systemMessageId != null
    },
})
