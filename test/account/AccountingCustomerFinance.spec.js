const helper = () => ec.resource.script("component://mr-mantle/test/ledger/AccountingReceivablesFixtures.js")
const native = (name, p) => helper().call("mantle.account.CustomerFinanceServices." + name, p)
let f, bankMethodId
spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("NATIVE_CUST")
        helper().draft(f)
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        login("john.doe")
    }
})
feature("a treasury writer stores a customer bank account while AR is refused the same valid write", {
    when() {
        const parameters = {
            organizationPartyId: f.org,
            customerPartyId: f.customer,
            bankName: "Customer bank",
            accountNumber: "123456789012",
            routingNumber: "111000025",
            typeEnumId: "BatChecking"
        }
        login(f.users.ar)
        const denied = helper().rejected("mantle.account.CustomerFinanceServices.store#CustomerBankAccount", parameters)
        login(f.users.treasury)
        const stored = native("store#CustomerBankAccount", parameters)
        bankMethodId = stored.paymentMethodId
        const detail = native("get#CustomerFinance", parameters)
        return {denied, stored, detail}
    },
    then({denied, stored, detail}) {
        denied.includes("PERMISSION_DENIED")
        !!stored.paymentMethodId
        detail.paymentMethods.some(row => row.paymentMethodId == bankMethodId && row.maskedAccountNumber == "•••• 9012")
        !JSON.stringify(detail).includes("123456789012")
    }
})
feature("financial readers receive no bank or tax details and cannot edit customer identifications", {
    when() {
        login(f.users.read)
        const detail = native("get#CustomerFinance", {organizationPartyId: f.org, customerPartyId: f.customer})
        const denied = helper().rejected("mantle.account.CustomerFinanceServices.store#CustomerIdentification", {
            organizationPartyId: f.org,
            customerPartyId: f.customer,
            partyIdTypeEnumId: "PtidFein",
            idValue: "12-3456789"
        })
        return {detail, denied}
    },
    then({detail, denied}) {
        detail.paymentMethods.length == 0
        detail.taxRegistrations.length == 0
        detail.capabilities.canEditIdentifications == false
        denied.includes("PERMISSION_DENIED")
    }
})
feature("customer headers omit unrelated decrypted personal information", {
    when() {
        const customer = "NATIVE_CUST_PERSON"
        helper().call("create#mantle.party.Party", {partyId: customer, partyTypeEnumId: "PtyPerson"})
        helper().call("create#mantle.party.Person", {
            partyId: customer,
            firstName: "Customer",
            lastName: "Person",
            mothersMaidenName: "Private family value",
            birthDate: "1980-01-01",
            gender: "F"
        })
        helper().call("create#mantle.party.PartyRelationship", {
            fromPartyId: f.org,
            toPartyId: customer,
            relationshipTypeEnumId: "PrtCustomer",
            fromDate: 0
        })
        login(f.users.ar)
        const detail = native("get#CustomerFinance", {organizationPartyId: f.org, customerPartyId: customer})
        return {detail}
    },
    then({detail}) {
        detail.customer.firstName == "Customer"
        detail.customer.mothersMaidenName == null
        detail.customer.birthDate == null
        detail.customer.gender == null
        !JSON.stringify(detail).includes("Private family value")
    }
})
feature("authorized customer contacts include postal and telephone subtypes without private contact metadata", {
    when() {
        const postal = helper().call("mantle.party.ContactServices.create#PostalAddress", {
            partyId: f.customer,
            contactMechPurposeId: "PostalBilling",
            address1: "123 Finance Street",
            address2: "Suite 4",
            city: "Chicago",
            stateProvinceGeoId: "USA_IL",
            countryGeoId: "USA",
            postalCode: "60601",
            accessCode: "PRIVATE-ENTRY-CODE"
        })
        const phone = helper().call("mantle.party.ContactServices.create#TelecomNumber", {
            partyId: f.customer,
            contactMechPurposeId: "PhonePrimary",
            countryCode: "1",
            areaCode: "312",
            contactNumber: "5551234",
            extension: "42"
        })
        const email = helper().call("mantle.party.ContactServices.create#EmailAddress", {
            partyId: f.customer,
            contactMechPurposeId: "EmailBilling",
            emailAddress: "billing@native.example"
        })
        login(f.users.ar)
        const detail = native("get#CustomerFinance", {organizationPartyId: f.org, customerPartyId: f.customer})
        return {detail, postalId: postal.contactMechId, phoneId: phone.contactMechId, emailId: email.contactMechId}
    },
    then({detail, postalId, phoneId, emailId}) {
        const postal = detail.contacts.find(row => row.contactMechId == postalId)
        const phone = detail.contacts.find(row => row.contactMechId == phoneId)
        postal.address1 == "123 Finance Street"
        postal.address2 == "Suite 4"
        postal.city == "Chicago"
        postal.stateProvinceGeoId == "USA_IL"
        !!postal.stateProvinceGeoName
        postal.countryGeoId == "USA"
        postal.postalCode == "60601"
        !!postal.purposeDescription
        phone.countryCode == "1"
        phone.areaCode == "312"
        phone.contactNumber == "555-1234"
        phone.extension == "42"
        !!phone.purposeDescription
        detail.contacts.some(row => row.contactMechId == emailId && row.infoString == "billing@native.example")
        detail.sendTo == "billing@native.example"
        !JSON.stringify(detail.contacts).includes("PRIVATE-ENTRY-CODE")
        detail.contacts.every(row => row.verifyCode == null && row.comments == null && row.accessCode == null)
    }
})
feature("an AR customer identification write returns only its declared identifiers", {
    when() {
        login(f.users.ar)
        const stored = native("store#CustomerIdentification", {
            organizationPartyId: f.org,
            customerPartyId: f.customer,
            partyIdTypeEnumId: "PtidFein",
            idValue: "12-3456789",
            issuedBy: "Revenue agency"
        })
        const detail = native("get#CustomerFinance", {organizationPartyId: f.org, customerPartyId: f.customer})
        return {stored, detail}
    },
    then({stored, detail}) {
        stored.partyIdTypeEnumId == "PtidFein"
        stored.idValue == null
        detail.identifications.some(row => row.idValue == "12-3456789")
    }
})
feature("customer finance rejects another organization and another customer's bank method", {
    when() {
        login(f.users.treasury)
        const foreign = helper().rejected("mantle.account.CustomerFinanceServices.get#CustomerFinance", {
            organizationPartyId: "ORG_ZIZI_CORP",
            customerPartyId: f.customer
        })
        const wrong = helper().rejected("mantle.account.CustomerFinanceServices.store#CustomerBankAccount", {
            organizationPartyId: f.org,
            customerPartyId: f.customer,
            paymentMethodId: "UNKNOWN_METHOD",
            bankName: "Wrong owner"
        })
        return {foreign, wrong}
    },
    then({foreign, wrong}) {
        foreign.includes("ORGANIZATION_DENIED")
        wrong.includes("PAYMENT_METHOD_UNAVAILABLE")
    }
})
feature("tax users maintain dated customer registrations and AR cannot submit the same valid registration", {
    when() {
        const parameters = {
            organizationPartyId: f.org,
            customerPartyId: f.customer,
            taxAuthorityId: "UsaIrs",
            fromDate: 0,
            partyTaxId: "12-3456789",
            isExempt: "N",
            isNexus: "Y"
        }
        login(f.users.ar)
        const refused = helper().rejected("mantle.account.CustomerFinanceServices.store#CustomerTaxRegistration", parameters)
        login(f.users.tax)
        native("store#CustomerTaxRegistration", parameters)
        const detail = native("get#CustomerFinance", {organizationPartyId: f.org, customerPartyId: f.customer})
        return {refused, detail}
    },
    then({refused, detail}) {
        refused.includes("PERMISSION_DENIED")
        detail.taxRegistrations.some(row => row.taxAuthorityId == "UsaIrs" && row.partyTaxId == "12-3456789")
    }
})
feature("customer aging by due date and the latest received payment are by currency", {
    when() {
        const invoice = (name, p) => helper().call("mantle.account.InvoiceServices." + name, p)
        for (const [days, amount] of [
            [-5, "10"],
            [15, "20"],
            [45, "30"],
            [75, "40"],
            [100, "50"]
        ]) {
            const record = helper().draft(f, amount)
            const saved = invoice("store#InvoiceDraft", {
                invoiceId: record.invoiceId,
                lastUpdatedStamp: record.lastUpdatedStamp,
                dueDate: Number(ec.user.nowTimestamp) - days * 86400000
            })
            invoice("change#InvoiceState", {
                invoiceId: record.invoiceId,
                action: "finalize",
                lastUpdatedStamp: saved.lastUpdatedStamp
            })
        }
        for (const [id, statusId, days, amount, currency] of [
            ["OLD", "PmntConfirmed", 2, "6", "USD"],
            ["RECEIVED", "PmntDelivered", 1, "7", "USD"],
            ["DRAFT", "PmntProposed", 0, "999", "USD"],
            ["FUTURE", "PmntConfirmed", -5, "888", "USD"],
            ["EURO", "PmntDelivered", 1, "3", "EUR"]
        ])
            helper().call("create#mantle.account.payment.Payment", {
                paymentId: "NATIVE_CUST_" + id,
                fromPartyId: f.customer,
                toPartyId: f.org,
                statusId,
                paymentTypeEnumId: "PtInvoicePayment",
                amount,
                amountUomId: currency,
                effectiveDate: Number(ec.user.nowTimestamp) - days * 86400000
            })
        login(f.users.ar)
        return {detail: native("get#CustomerFinance", {organizationPartyId: f.org, customerPartyId: f.customer})}
    },
    then({detail}) {
        const usd = detail.summaryRows.find(row => row.currencyUomId == "USD")
        const eur = detail.summaryRows.find(row => row.currencyUomId == "EUR")
        usd.current.eq(10)
        usd.days1To30.eq(20)
        usd.days31To60.eq(30)
        usd.days61To90.eq(40)
        usd.over90.eq(50)
        usd.openReceivable.eq(150)
        usd.overdue.eq(140)
        usd.lastPaymentAmount.eq(7)
        usd.lastPaymentDate != null
        eur.openReceivable.isZero()
        eur.lastPaymentAmount.eq(3)
    }
})
