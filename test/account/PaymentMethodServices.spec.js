// Payment methods (mantle.account.PaymentMethodServices): credit cards and bank accounts, storing and updating (an
// update clones the immutable record), deleting and expunging, payment method files and content. New spec, no Groovy
// original.
const effectiveTime = Date.now()
const year = new Date(effectiveTime).getUTCFullYear()
let ownerId, cardId, card2Id, bankId, fileId

spec({
    stepwise: true,
    tempSequences: { start: 57500, banks: { "mantle.party.Party": 10, "mantle.account.method.PaymentMethod": 30,
        "mantle.account.method.PaymentMethodFile": 10, "mantle.account.payment.Payment": 10, "mantle.party.contact.ContactMech": 20 } },
    setupSpec() {
        login("john.doe")
        ec.user.setEffectiveTime(effectiveTime)
    },
    setup() { ec.artifactExecution.disableAuthz() },
    cleanup() { ec.artifactExecution.enableAuthz() },
})

const n = (value) => dec(value).toNumber()
function errorOf(name, params) {
    try { call(name, params) } catch (e) { ec.message.clearErrors(); return String(e.message) }
    return null
}
const pm = (id) => ec.entity.find("mantle.account.method.PaymentMethod").condition("paymentMethodId", id).one()

feature("store a credit card with a billing address, and get the party's payment method info", {
    when() {
        ownerId = call("mantle.party.PartyServices.create#Person", { firstName: "Cardy", lastName: "Holder" }).partyId
        const stored = call("mantle.account.PaymentMethodServices.store#PaymentMethodInfo", { partyId: ownerId, paymentMethodTypeEnumId: "PmtCreditCard",
                creditCardTypeEnumId: "CctVisa", cardNumber: "4111111111111111", expireMonth: "12", expireYear: String(year + 2), firstNameOnAccount: "Cardy", lastNameOnAccount: "Holder",
                address1: "1 Card St", city: "Orem", stateProvinceGeoId: "USA_UT", postalCode: "84057", countryGeoId: "USA" })
        cardId = stored.paymentMethodId
        const info = call("mantle.account.PaymentMethodServices.get#PartyPaymentMethodInfo", { partyId: ownerId, paymentMethodId: cardId })
        const list = call("mantle.account.PaymentMethodServices.get#PartyPaymentMethodInfoList", { partyId: ownerId })
        // another party's id with this method: refused (SEC-BAP-04)
        const otherId = call("mantle.party.PartyServices.create#Person", { firstName: "Other", lastName: "Party" }).partyId
        const other = errorOf("mantle.account.PaymentMethodServices.get#PartyPaymentMethodInfo", { partyId: otherId, paymentMethodId: cardId })
        return { stored, info, list, other }
    },
    then({ stored, info, list, other }) {
        other.includes("not found for party")
        !("cardSecurityCode" in info.creditCard)
        !("cardSecurityCode" in list.methodInfoList[0].creditCard)
        cardId != null
        stored.postalContactMechId != null
        info.paymentMethod.paymentMethodId == cardId
        info.creditCard != null
        info.maskedCardNumber.endsWith("1111")
        info.expireMonth == "12"
        list.methodInfoList.length == 1
    },
})

feature("updating a credit card keeps the record immutable by cloning it", {
    when() {
        const out = call("mantle.account.PaymentMethodServices.store#PaymentMethodInfo", { partyId: ownerId, paymentMethodId: cardId, paymentMethodTypeEnumId: "PmtCreditCard",
                expireMonth: "11", expireYear: String(year + 3), firstNameOnAccount: "Cardy", lastNameOnAccount: "Holder" })
        card2Id = out.paymentMethodId
        const old = pm(cardId)
        const list = call("mantle.account.PaymentMethodServices.get#PartyPaymentMethodInfoList", { partyId: ownerId })
        return { out, old, list }
    },
    then({ out, old, list }) {
        card2Id != null
        card2Id != cardId
        old.thruDate != null
        list.methodInfoList.length == 1
    },
})

feature("mutable fields update in place; create and update a bank account", {
    when() {
        call("mantle.account.PaymentMethodServices.update#PaymentMethodMutable", { paymentMethodId: card2Id, description: "Personal card", trustLevelEnumId: "CmtlVerified" })
        const mutable = pm(card2Id)
        bankId = call("mantle.account.PaymentMethodServices.create#BankAccount", { ownerPartyId: ownerId, bankName: "Card Bank", routingNumber: "021000021", accountNumber: "444555666",
                typeEnumId: "BatChecking", firstNameOnAccount: "Cardy", lastNameOnAccount: "Holder" }).paymentMethodId
        const updated = call("mantle.account.PaymentMethodServices.update#BankAccount", { paymentMethodId: bankId, bankName: "Card Bank 2" })
        call("mantle.account.PaymentMethodServices.update#BankAccountMutable", { paymentMethodId: updated.paymentMethodId, lastCheckNumber: 1000, nachaCompanyName: "CARDY", posPayBankNumber: "123" })
        const bank = ec.entity.find("mantle.account.method.BankAccount").condition("paymentMethodId", updated.paymentMethodId).one()
        // an update of the immutable bank account fields makes a new record, which is the one in use from now on
        bankId = updated.paymentMethodId
        return { mutable, updated, bank }
    },
    then({ mutable, updated, bank }) {
        mutable.description == "Personal card"
        updated.paymentMethodId != null
        n(bank.lastCheckNumber) == 1000
        bank.nachaCompanyName == "CARDY"
    },
})

// the account number is stored encrypted and the default label shows its last four digits only (SEC-BAP-02); a number
// stored in plain text before the field was encrypted is encrypted by the migration, and its label masked
const storedNumber = (id) => {
    return String(ec.entity.runSqlStatement("transactional", `SELECT ACCOUNT_NUMBER FROM BANK_ACCOUNT WHERE PAYMENT_METHOD_ID = '${id}'`, 1).records[0][0])
}
feature("a bank account number is stored encrypted, labeled by its last four digits, and a plain one is migrated", {
    when() {
        const madeId = call("mantle.account.PaymentMethodServices.create#BankAccount", { ownerPartyId: ownerId, bankName: "Mask Bank",
            routingNumber: "021000021", accountNumber: "000123456789", typeEnumId: "BatChecking" }).paymentMethodId
        const made = { label: pm(madeId).description, stored: storedNumber(madeId),
            read: ec.entity.find("mantle.account.method.BankAccount").condition("paymentMethodId", madeId).one().accountNumber }
        // as a row written before the field was encrypted
        ec.entity.runSqlStatement("transactional", `UPDATE BANK_ACCOUNT SET ACCOUNT_NUMBER = '000987654321' WHERE PAYMENT_METHOD_ID = '${madeId}'`, 1)
        call("mantle.account.PaymentMethodServices.update#PaymentMethodMutable", { paymentMethodId: madeId, description: "Old Bank 000987654321" })
        const migrated = call("mantle.account.PaymentMethodServices.migrate#BankAccountNumbers", {})
        const after = { label: pm(madeId).description, stored: storedNumber(madeId),
            read: ec.entity.find("mantle.account.method.BankAccount").condition("paymentMethodId", madeId).one().accountNumber }
        return { made, migrated, after }
    },
    then({ made, migrated, after }) {
        made.label == "Mask Bank •••• 6789"
        made.stored.startsWith(":")
        made.read == "000123456789"
        migrated.migratedCount >= 1
        migrated.failedCount == 0
        after.label == "Old Bank •••• 4321"
        after.stored.startsWith(":")
        after.read == "000987654321"
    },
})

// a user of its own group holding only the permissions given
function userWith(kind, permissions) {
    const id = "PMS_U_" + kind
    call("create#moqui.security.UserGroup", { userGroupId: id, description: "Payment numbers " + kind })
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", { userGroupId: id, userPermissionId: permission, fromDate: effectiveTime - 1000 })
    call("create#mantle.party.Party", { partyId: id, partyTypeEnumId: "PtyPerson" })
    call("create#mantle.party.Person", { partyId: id, firstName: "Numbers", lastName: kind })
    call("create#moqui.security.UserAccount", { userId: id, username: id, partyId: id,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394", passwordHashType: "SHA", timeZone: ec.user.userAccount?.timeZone || "America/Chicago" })
    call("create#moqui.security.UserGroupMember", { userId: id, userGroupId: id, fromDate: effectiveTime - 1000 })
    return id
}

// a list answers card and bank numbers masked; the edit form's single answer has them whole only for the owner's own user or a
// holder of PAYMENT_NUMBER_VIEW, not for CARD_NUMBER_EDIT or PAYMENT_EDIT alone, and a save that leaves the number out keeps
// it (SEC-BAP-04)
feature("payment method lists mask the numbers; the edit answer is whole for PAYMENT_NUMBER_VIEW only, and a save without the number keeps it", {
    when() {
        const list = call("mantle.account.PaymentMethodServices.get#PartyPaymentMethodInfoList", { partyId: ownerId })
        const bankInfo = list.methodInfoList.find(info => info.paymentMethodId == bankId)
        const cardInfo = list.methodInfoList.find(info => info.paymentMethodId == card2Id)
        const users = { viewer: userWith("NUMBER_VIEW", ["PAYMENT_NUMBER_VIEW"]), cardEditor: userWith("CARD_EDIT", ["CARD_NUMBER_EDIT"]),
            paymentEditor: userWith("PAYMENT_EDIT", ["PAYMENT_EDIT"]), other: "joe@public.com" }
        const answers = {}
        try {
            for (const [name, username] of Object.entries(users)) {
                login(username)
                answers[name] = { bank: call("mantle.account.PaymentMethodServices.get#PartyPaymentMethodInfo", { partyId: ownerId, paymentMethodId: bankId }),
                    card: call("mantle.account.PaymentMethodServices.get#PartyPaymentMethodInfo", { partyId: ownerId, paymentMethodId: card2Id }) }
            }
        } finally { login("john.doe") }
        const editor = answers.viewer.bank, editorCard = answers.viewer.card
        const masked = ["cardEditor", "paymentEditor", "other"].map(name => answers[name])
        // the form of a user who sees the number masked sends none
        const savedId = call("mantle.account.PaymentMethodServices.store#PaymentMethodInfo", { partyId: ownerId, paymentMethodId: bankId,
            paymentMethodTypeEnumId: "PmtBankAccount", bankName: "Card Bank 3", routingNumber: "021000021" }).paymentMethodId
        const saved = ec.entity.find("mantle.account.method.BankAccount").condition("paymentMethodId", savedId).one()
        bankId = savedId
        return { bankInfo, cardInfo, editor, editorCard, masked, saved }
    },
    then({ bankInfo, cardInfo, editor, editorCard, masked, saved }) {
        !("accountNumber" in bankInfo.bankAccount)
        bankInfo.maskedAccountNumber == "•••• 5666"
        !("cardNumber" in cardInfo.creditCard)
        cardInfo.maskedCardNumber.endsWith("1111")
        editor.fullNumbers == true
        editor.bankAccount.accountNumber == "444555666"
        editorCard.creditCard.cardNumber == "4111111111111111"
        masked.every(({ bank }) => bank.fullNumbers == false && !("accountNumber" in bank.bankAccount) && bank.maskedAccountNumber == "•••• 5666")
        masked.every(({ card }) => !("cardNumber" in card.creditCard) && card.maskedCardNumber.endsWith("1111"))
        saved.bankName == "Card Bank 3"
        saved.accountNumber == "444555666"
    },
})

feature("payment method content text", {
    when() {
        const contentId = call("mantle.account.PaymentMethodServices.create#PaymentMethodContent", { paymentMethodId: card2Id, contentTypeEnumId: "PmctImage", description: "scan" }).paymentMethodContentId
        call("mantle.account.PaymentMethodServices.update#PaymentMethodContent", { paymentMethodContentId: contentId, description: "scan edited" })
        const pmFileId = call("mantle.account.PaymentMethodServices.create#PaymentMethodContent", { paymentMethodId: card2Id, contentTypeEnumId: "PmctImage", contentFile: uploadedFile("card.txt", "front") }).paymentMethodContentId
        call("mantle.account.PaymentMethodServices.update#PaymentMethodContent", { paymentMethodContentId: pmFileId, contentFile: uploadedFile("card2.txt", "back") })
        const loc = call("mantle.account.PaymentMethodServices.get#PaymentMethodContentLocation", { paymentMethodId: card2Id, contentTypeEnumIdList: ["PmctImage"] })
        return { contentId, loc }
    },
    then({ contentId }) { contentId != null },
})

feature("delete expires a payment method, and checkDelete expires one marked as set automatically", {
    when() {
        call("mantle.account.PaymentMethodServices.delete#PaymentMethod", { paymentMethodId: card2Id })
        const deleted = pm(card2Id)
        const autoId = call("mantle.account.PaymentMethodServices.create#BankAccount", { ownerPartyId: ownerId, bankName: "Temp Bank", routingNumber: "011000015", accountNumber: "1", thruDateSetAuto: "Y" }).paymentMethodId
        const payId = call("mantle.account.PaymentServices.create#Payment", { fromPartyId: ownerId, toPartyId: "ORG_ZIZI_RETAIL", amount: 5, amountUomId: "USD", paymentMethodId: autoId, statusId: "PmntDelivered", effectiveDate: effectiveTime }).paymentId
        call("mantle.account.PaymentMethodServices.checkDelete#PaymentPaymentMethods", { paymentId: payId })
        return { deleted, auto: pm(autoId) }
    },
    then({ deleted, auto }) {
        deleted.thruDate != null
        auto.thruDate != null
    },
})

feature("payment method files: complete and cancel", {
    when() {
        const payId = call("mantle.account.PaymentServices.create#Payment", { fromPartyId: "ORG_ZIZI_RETAIL", toPartyId: ownerId, amount: 12, amountUomId: "USD", paymentMethodId: bankId, statusId: "PmntAuthorized",
                paymentInstrumentEnumId: "PiAch", effectiveDate: effectiveTime }).paymentId
        fileId = call("create#mantle.account.method.PaymentMethodFile", { paymentMethodId: bankId, fileTypeEnumId: "PmftNacha", fileDate: effectiveTime }).paymentMethodFileId
        call("update#mantle.account.payment.Payment", { paymentId: payId, paymentMethodFileId: fileId })
        call("mantle.account.PaymentMethodServices.update#PaymentMethodFileComplete", { paymentMethodFileId: fileId, fileText: "FILE", paymentList: [{ paymentId: payId }] })
        const completed = ec.entity.find("mantle.account.method.PaymentMethodFile").condition("paymentMethodFileId", fileId).one()
        const delivered = ec.entity.find("mantle.account.payment.Payment").condition("paymentId", payId).one()
        call("mantle.account.PaymentMethodServices.cancel#PaymentMethodFile", { paymentMethodFileId: fileId })
        const afterCancel = ec.entity.find("mantle.account.payment.Payment").condition("paymentId", payId).one()
        return { completed, delivered, afterCancel }
    },
    then({ completed, delivered, afterCancel }) {
        completed.fileText == "FILE"
        delivered.statusId == "PmntDelivered"
        afterCancel.paymentMethodFileId == null
    },
})

feature("expunge removes a payment method and its clones", {
    when() {
        // expunge leaves clearing records that refer to the payment method as a TODO, so remove the content made above
        ec.entity.find("mantle.account.method.PaymentMethodContent").condition("paymentMethodId", card2Id).deleteAll()
        call("mantle.account.PaymentMethodServices.expunge#PaymentMethod", { paymentMethodId: card2Id })
        return { first: pm(cardId), second: pm(card2Id) }
    },
    then({ first, second }) {
        first == null
        second == null
    },
})
