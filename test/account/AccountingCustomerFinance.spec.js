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
            partyIdTypeEnumId: "PtidDuns",
            idValue: "123456789"
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
// SEC-BOS-82: identifications are answered masked to their last four characters, a tax identification (PtidSsn, PtidFein,
// PtidFuid) never, and an edit without a new value keeps the stored one; a tax identification and a masked value are refused
feature("AR stores a customer identification and reads it masked; a tax identification is never answered nor written", {
    when() {
        helper().call("create#mantle.party.PartyIdentification", {
            partyId: f.customer,
            partyIdTypeEnumId: "PtidSsn",
            idValue: "123-45-6789"
        })
        login(f.users.ar)
        const request = {organizationPartyId: f.org, customerPartyId: f.customer, partyIdTypeEnumId: "PtidDuns"}
        const stored = native("store#CustomerIdentification", Object.assign({idValue: "123456789", issuedBy: "D&B"}, request))
        const first = native("get#CustomerFinance", {organizationPartyId: f.org, customerPartyId: f.customer})
        const row = JSON.parse(JSON.stringify(first.identifications)).find(row => row.partyIdTypeEnumId == "PtidDuns")
        // the edit form sends no value: the stored one is kept
        native("store#CustomerIdentification", Object.assign({lastUpdatedStamp: row.lastUpdatedStamp, issuedBy: "Dun"}, request))
        const kept = helper().lib.one("mantle.party.PartyIdentification", {partyId: f.customer, partyIdTypeEnumId: "PtidDuns"})
        const maskedBack = helper().rejected(
            "mantle.account.CustomerFinanceServices.store#CustomerIdentification",
            Object.assign({lastUpdatedStamp: kept.lastUpdatedStamp, idValue: row.valueText}, request)
        )
        const ssn = helper().rejected(
            "mantle.account.CustomerFinanceServices.store#CustomerIdentification",
            Object.assign({}, request, {partyIdTypeEnumId: "PtidSsn", idValue: "987-65-4321"})
        )
        const detail = native("get#CustomerFinance", {organizationPartyId: f.org, customerPartyId: f.customer})
        return {stored, row, kept, maskedBack, ssn, detail}
    },
    then({stored, row, kept, maskedBack, ssn, detail}) {
        stored.partyIdTypeEnumId == "PtidDuns"
        stored.idValue == null
        row.valueText == "•••• 6789"
        row.idValue == null
        kept.idValue == "123456789"
        kept.issuedBy == "Dun"
        maskedBack.includes("IDENTIFICATION_VALUE_MASKED")
        ssn.includes("IDENTIFICATION_TYPE_RESTRICTED")
        !detail.identifications.some(row => row.partyIdTypeEnumId == "PtidSsn")
        !JSON.stringify(detail).includes("123456789")
        !JSON.stringify(detail).includes("123-45-6789")
    }
})
// SEC-BOS-82: Accounting's customer and supplier scope is a business relationship: an employee of the organization (with
// their payroll invoices) or of any other, an internal organization (rolled up into it) and a party related in another way
// are refused, and a former employee's payroll invoices make no supplier, while a pay run's third-party payee is one; a
// payroll bank account is refused to Accounting's bank writer (payroll changes it in People)
feature("an employee, an internal organization and a non-customer relationship are no customer or supplier of finance", {
    when() {
        const person = (partyId, thruDate) => {
            helper().call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
            helper().call("create#mantle.party.Person", {partyId, firstName: "Pay", lastName: partyId})
            helper().call("create#mantle.party.PartyRelationship", {
                partyRelationshipId: partyId + "_EMP",
                fromPartyId: partyId,
                toPartyId: f.org,
                relationshipTypeEnumId: "PrtEmployee",
                fromDate: 0,
                thruDate
            })
            const employment = helper().call("create#mantle.humanres.employment.Employment", {
                partyRelationshipId: partyId + "_EMP"
            })
            // net pay: a pay run's invoice of the employment
            helper().call("create#mantle.account.invoice.Invoice", {
                invoiceTypeEnumId: "InvoicePayroll",
                partyRelationshipId: employment.partyRelationshipId,
                fromPartyId: partyId,
                toPartyId: f.org,
                statusId: "InvoiceIncoming",
                invoiceDate: ec.user.nowTimestamp,
                currencyUomId: "USD"
            })
            helper().call("create#mantle.party.PartyIdentification", {
                partyId,
                partyIdTypeEnumId: "PtidPassport",
                idValue: "P1234567"
            })
            return partyId
        }
        const employee = person("NATIVE_CUST_EMPLOYEE", null)
        const former = person("NATIVE_CUST_FORMER", Number(ec.user.nowTimestamp) - 86400000)
        const internal = "NATIVE_CUST_INTERNAL"
        helper().call("create#mantle.party.Party", {partyId: internal, partyTypeEnumId: "PtyOrganization"})
        helper().call("create#mantle.party.Organization", {partyId: internal, organizationName: "Internal child"})
        helper().call("create#mantle.party.PartyRole", {partyId: internal, roleTypeId: "OrgInternal"})
        helper().call("create#mantle.party.PartyRelationship", {
            fromPartyId: internal,
            toPartyId: f.org,
            relationshipTypeEnumId: "PrtOrgRollup",
            fromDate: 0
        })
        const contact = "NATIVE_CUST_CONTACT"
        helper().call("create#mantle.party.Party", {partyId: contact, partyTypeEnumId: "PtyPerson"})
        helper().call("create#mantle.party.Person", {partyId: contact, firstName: "Only", lastName: "Contact"})
        helper().call("create#mantle.party.PartyRelationship", {
            fromPartyId: contact,
            toPartyId: f.org,
            relationshipTypeEnumId: "PrtContact",
            fromDate: 0
        })
        // employed by another organization, with an ordinary bill to this one
        const elsewhereEmployer = "NATIVE_CUST_EMPLOYER_B"
        helper().call("create#mantle.party.Party", {partyId: elsewhereEmployer, partyTypeEnumId: "PtyOrganization"})
        helper().call("create#mantle.party.PartyRole", {partyId: elsewhereEmployer, roleTypeId: "OrgInternal"})
        // a customer's contact person recorded as employed by their own, outside company (create#Person employerPartyId)
        const outsideCompany = "NATIVE_CUST_OUTSIDE_CO"
        helper().call("create#mantle.party.Party", {partyId: outsideCompany, partyTypeEnumId: "PtyOrganization"})
        const outsideContact = "NATIVE_CUST_OUTSIDE_PERSON"
        helper().call("create#mantle.party.Party", {partyId: outsideContact, partyTypeEnumId: "PtyPerson"})
        helper().call("create#mantle.party.Person", {partyId: outsideContact, firstName: "Buys", lastName: "Outside"})
        for (const [toPartyId, relationshipTypeEnumId] of [
            [outsideCompany, "PrtEmployee"],
            [f.org, "PrtCustomer"]
        ])
            helper().call("create#mantle.party.PartyRelationship", {
                fromPartyId: outsideContact,
                toPartyId,
                relationshipTypeEnumId,
                fromDate: 0
            })
        const elsewhere = "NATIVE_CUST_ELSEWHERE"
        helper().call("create#mantle.party.Party", {partyId: elsewhere, partyTypeEnumId: "PtyPerson"})
        helper().call("create#mantle.party.Person", {partyId: elsewhere, firstName: "Works", lastName: "Elsewhere"})
        helper().call("create#mantle.party.PartyRelationship", {
            fromPartyId: elsewhere,
            toPartyId: elsewhereEmployer,
            relationshipTypeEnumId: "PrtEmployee",
            fromDate: 0
        })
        const bill = (fromPartyId, invoiceTypeEnumId) =>
            helper().call("create#mantle.account.invoice.Invoice", {
                invoiceTypeEnumId,
                fromPartyId,
                toPartyId: f.org,
                statusId: "InvoiceIncoming",
                invoiceDate: ec.user.nowTimestamp,
                currencyUomId: "USD"
            })
        bill(elsewhere, "InvoiceSales")
        // a pay run's third-party payee (a benefit provider): its payroll invoice names no employment
        const provider = "NATIVE_CUST_BENEFITS"
        helper().call("create#mantle.party.Party", {partyId: provider, partyTypeEnumId: "PtyOrganization"})
        helper().call("create#mantle.party.Organization", {partyId: provider, organizationName: "Benefit provider"})
        bill(provider, "InvoicePayroll")
        // a payroll bank account on the customer (People's store#PayrollBankAccount writes these)
        const payrollMethodId = helper().call("mantle.account.PaymentMethodServices.create#BankAccount", {
            ownerPartyId: f.customer,
            purposeEnumId: "PmpPayroll",
            bankName: "Payroll bank",
            accountNumber: "777788889999",
            routingNumber: "111000025"
        }).paymentMethodId
        const payrollStamp = helper().lib.one("mantle.account.method.PaymentMethod", {
            paymentMethodId: payrollMethodId
        }).lastUpdatedStamp
        const customerOf = partyId =>
            helper().rejected("mantle.account.CustomerFinanceServices.get#CustomerFinance", {
                organizationPartyId: f.org,
                customerPartyId: partyId
            })
        const supplierOf = partyId =>
            helper().rejected("mantle.party.SupplierServices.get#SupplierFinance", {
                organizationPartyId: f.org,
                supplierPartyId: partyId
            })
        login(f.users.ar)
        const customer = {
            employee: customerOf(employee),
            internal: customerOf(internal),
            contact: customerOf(contact),
            outsideContact: customerOf(outsideContact)
        }
        const identification = helper().rejected("mantle.account.CustomerFinanceServices.store#CustomerIdentification", {
            organizationPartyId: f.org,
            customerPartyId: employee,
            partyIdTypeEnumId: "PtidPassport",
            idValue: "P7654321"
        })
        login(f.users.ap)
        const supplier = {
            employee: supplierOf(employee),
            former: supplierOf(former),
            internal: supplierOf(internal),
            elsewhere: supplierOf(elsewhere),
            provider: supplierOf(provider)
        }
        login(f.users.treasury)
        const bank = helper().rejected("mantle.account.CustomerFinanceServices.store#CustomerBankAccount", {
            organizationPartyId: f.org,
            customerPartyId: employee,
            side: "supplier",
            bankName: "Payroll bank",
            accountNumber: "222233334444",
            routingNumber: "111000025",
            typeEnumId: "BatChecking"
        })
        const payrollBank = helper().rejected("mantle.account.CustomerFinanceServices.store#CustomerBankAccount", {
            organizationPartyId: f.org,
            customerPartyId: f.customer,
            paymentMethodId: payrollMethodId,
            lastUpdatedStamp: payrollStamp,
            bankName: "Changed by treasury"
        })
        return {customer, identification, supplier, bank, payrollBank}
    },
    then({customer, identification, supplier, bank, payrollBank}) {
        customer.employee.includes("EMPLOYEE_EXCLUDED")
        customer.internal.includes("INTERCOMPANY_EXCLUDED")
        customer.contact.includes("CUSTOMER_SCOPE_INVALID")
        customer.outsideContact == ""
        identification.includes("EMPLOYEE_EXCLUDED")
        supplier.employee.includes("EMPLOYEE_EXCLUDED")
        supplier.former.includes("SUPPLIER_SCOPE_INVALID")
        supplier.internal.includes("INTERCOMPANY_EXCLUDED")
        supplier.elsewhere.includes("EMPLOYEE_EXCLUDED")
        supplier.provider == ""
        payrollBank.includes("PAYMENT_METHOD_UNAVAILABLE")
        bank.includes("EMPLOYEE_EXCLUDED")
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
