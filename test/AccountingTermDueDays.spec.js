// An invoice's due date is a calendar day counted from its day in the user's zone, also on the day daylight saving
// ends or starts: a bill with Immediate terms dated the morning of the change is due that day, and a payment run due
// through that day selects it. Standalone: spec-local organization, supplier and user.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingSettlementFixtures.js")
const terms = () => ec.resource.script("component://mr-mantle/service/mantle/account/PaymentTerms.js")
const prefix = "TERM_DST"
const supplier = prefix + "_SUP"
// 02:20 in Chicago on November 1, 2026, an hour after daylight saving ended; 03:30 on March 8, an hour and a half after
// it started; 01:30 on November 1, still daylight time.
const fallBack = Date.UTC(2026, 10, 1, 8, 20),
    springForward = Date.UTC(2026, 2, 8, 8, 30),
    beforeChange = Date.UTC(2026, 10, 1, 6, 30)
let f, runUser, bankId

// Run in Chicago with the clock at the time given; the user's zone and the clock are restored after.
function inChicago(at, action) {
    const savedTimeZone = ec.user.userAccount?.timeZone || null
    ec.user.setTimeZone("America/Chicago")
    ec.user.setEffectiveTime(at)
    try {
        return action()
    } finally {
        ec.user.setEffectiveTime(null)
        ec.user.setTimeZone(savedTimeZone)
    }
}
// A bill dated the time given with a term, approved; its due date as a day and a time in Chicago.
function bill(at, settlementTermId) {
    login("john.doe")
    ec.artifactExecution.disableAuthz()
    return inChicago(at, () => {
        const invoiceId = helper().invoice(f, "40", "payable", {
            fromPartyId: supplier,
            invoiceDate: at,
            accountingDate: ec.l10n.format(new Date(at), "yyyy-MM-dd"),
            settlementTermId
        })
        const row = helper().lib.one(helper().lib.invoiceEntity, {invoiceId})
        return {
            invoiceId,
            dueDay: terms().stampDay(row.dueDate),
            due: ec.l10n.format(row.dueDate, "yyyy-MM-dd HH:mm"),
            sameTime: Number(String(row.dueDate)) === at
        }
    })
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const h = helper()
        f = h.fixtures(prefix)
        runUser = h.user(f, "RUNAP", ["PAYABLE_EDIT", "PAYABLE_VIEW"])
        h.call("create#mantle.party.Party", {partyId: supplier, partyTypeEnumId: "PtyOrganization"})
        h.call("create#mantle.party.Organization", {partyId: supplier, organizationName: "DST supplier"})
        h.call("create#mantle.party.PartyRole", {partyId: supplier, roleTypeId: "Supplier"})
        bankId = h.call("mantle.account.PaymentMethodServices.create#BankAccount", {
            ownerPartyId: f.org,
            description: "Operating account",
            bankName: "Test Bank",
            routingNumber: "021000021",
            accountNumber: "5550004321",
            typeEnumId: "BatChecking",
            currencyUomId: "USD",
            companyNameOnAccount: "DST Org"
        }).paymentMethodId
    },
    cleanupSpec() {
        login("john.doe")
    }
})

feature("a bill dated the morning daylight saving ends is due by its term's days in Chicago", {
    when() {
        return {
            immediate: bill(fallBack, "Immediate"),
            net30: bill(fallBack, "Net30"),
            lastOfMonth: bill(fallBack, "NetLastCur"),
            firstNext: bill(fallBack, "Net1stNext"),
            daylight: bill(beforeChange, "Immediate")
        }
    },
    then({immediate, net30, lastOfMonth, firstNext, daylight}) {
        immediate.dueDay == "2026-11-01"
        immediate.sameTime == true
        net30.due == "2026-12-01 02:20"
        lastOfMonth.due == "2026-11-30 02:20"
        firstNext.due == "2026-12-01 02:20"
        daylight.dueDay == "2026-11-01"
        daylight.sameTime == true
    }
})

feature("a bill dated the morning daylight saving starts is due by its term's days in Chicago", {
    when() {
        return {immediate: bill(springForward, "Immediate"), net30: bill(springForward, "Net30")}
    },
    then({immediate, net30}) {
        immediate.dueDay == "2026-03-08"
        immediate.sameTime == true
        net30.due == "2026-04-07 03:30"
    }
})

feature("a payment run due through the day daylight saving ends selects the bill due that day", {
    when() {
        const due = bill(fallBack, "Immediate")
        login(runUser)
        const made = inChicago(fallBack + 3600000, () =>
            helper().call("mantle.account.PaymentRunServices.create#Run", {
                organizationPartyId: f.org,
                paymentMethodId: bankId,
                paymentInstrumentEnumId: "PiCompanyCheck",
                dueThroughDate: "2026-11-01",
                payDate: "2026-11-01"
            })
        )
        const items = helper().lib.rows("mantle.account.payment.PaymentRunItem", {paymentRunId: made.paymentRunId})
        return {due, item: items.find(row => row.invoiceId === due.invoiceId)}
    },
    then({due, item}) {
        item != null
        item.selectedIndicator == "Y"
        helper().lib.policy.calendarDateText(item.dueDate) == "2026-11-01"
    }
})
