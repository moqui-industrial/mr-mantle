// Dunning's renewal exclusion (mr-pass impl-shop P7; design-accounting Dunning "Renewals in retry", review X5, R-SC-03;
// Collections.js renewalsInRetry): preview#Dunning leaves out the overdue invoice of a Shop renewal whose payment is still
// being retried (RENEWAL_RETRY: Shop's attempt notices remind the customer then), and once the retries are exhausted the
// invoice is Dunning's again; another customer's overdue invoice is reminded as before. Standalone: spec-local
// organization, customers and users. Run: ./moq test mr-mantle --spec DunningRenewalExclusion
const helper = () => ec.resource.script("component://mr-mantle/test/ledger/AccountingReceivablesFixtures.js")
const svc = (name, p) => helper().call(name, p)
const collections = (name, p) => helper().call("mantle.account.CollectionServices." + name, p)
const one = (entity, key) => helper().lib.one(entity, key)
const rows = (entity, key) => helper().lib.rows(entity, key)
const SUB = "mantle.product.subscription."
const prefix = "DREX"
let f, renewalInvoiceId, otherInvoiceId, occurrenceId
const day = offset => ec.l10n.format(new Date(Number(ec.user.nowTimestamp) + offset * 86400000), "yyyy-MM-dd")
// An issued invoice to a customer, due a number of days ago (its due schedule with it).
function overdue(customerPartyId, amount, daysAgo) {
    login(f.users.ar)
    const made = svc("mantle.account.InvoiceServices.create#Receivable", {organizationPartyId: f.org, customerPartyId})
    svc("mantle.account.InvoiceServices.store#InvoiceDraftItem", {
        invoiceId: made.invoiceId,
        itemTypeEnumId: "ItemTimeEntry",
        quantity: "1",
        amount,
        description: "Monthly access"
    })
    const invoice = one("mantle.account.invoice.Invoice", {invoiceId: made.invoiceId})
    svc("mantle.account.InvoiceServices.change#InvoiceState", {
        invoiceId: made.invoiceId,
        action: "finalize",
        lastUpdatedStamp: invoice.lastUpdatedStamp
    })
    login("john.doe")
    svc("update#mantle.account.invoice.Invoice", {
        invoiceId: made.invoiceId,
        dueDate: new Date(Number(ec.user.nowTimestamp) - daysAgo * 86400000)
    })
    for (const row of rows("mantle.account.invoice.InvoiceDueSchedule", {invoiceId: made.invoiceId}))
        svc("update#mantle.account.invoice.InvoiceDueSchedule", {
            invoiceId: made.invoiceId,
            scheduleSeqId: row.scheduleSeqId,
            dueDate: day(-daysAgo)
        })
    return made.invoiceId
}
const preview = () => {
    login(f.users.ar)
    const run = collections("preview#Dunning", {organizationPartyId: f.org})
    return collections("get#DunningRun", {dunningRunId: run.dunningRunId}).notices
}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures(prefix)
        const second = prefix + "_SECOND"
        svc("create#mantle.party.Party", {partyId: second, partyTypeEnumId: "PtyOrganization"})
        svc("create#mantle.party.Organization", {partyId: second, organizationName: prefix + " second customer"})
        svc("create#mantle.party.PartyRole", {partyId: second, roleTypeId: "Customer"})
        for (const partyId of [f.customer, second])
            svc("mantle.party.ContactServices.create#EmailAddress", {
                partyId,
                emailAddress: partyId.toLowerCase() + "@drex.example.test",
                contactMechPurposeId: "EmailBilling"
            })
        login(f.users.financeadmin)
        collections("store#Level", {
            organizationPartyId: f.org,
            emailTemplateId: f.emailTemplateId,
            description: "Reminder",
            daysOverdueFrom: 1
        })
        // the renewal's invoice (a renewal occurrence still retrying its payment) and another customer's
        renewalInvoiceId = overdue(f.customer, "12", 5)
        otherInvoiceId = overdue(second, "40", 5)
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        svc("create#" + SUB + "StoreRecurringContract", {
            contractId: prefix + "_CONTRACT",
            customerPartyId: f.customer,
            autoRenew: "Y"
        })
        occurrenceId = svc("create#" + SUB + "StoreRenewalOccurrence", {
            contractId: prefix + "_CONTRACT",
            periodStartDate: ec.user.nowTimestamp,
            stateEnumId: "SrsRetry",
            invoiceId: renewalInvoiceId,
            attemptCount: 1
        }).occurrenceId
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    }
})

feature("a renewal in retry is left out of a reminder run; another customer's invoice is reminded as before", {
    when() {
        return {notices: preview()}
    },
    then({notices}) {
        notices.some(
            row => row.statusId == "DntExcluded" && row.excludedReason == "RENEWAL_RETRY" && row.invoiceIds == renewalInvoiceId
        )
        !notices.some(row => row.statusId == "DntPending" && String(row.invoiceIds).includes(renewalInvoiceId))
        notices.some(row => row.statusId == "DntPending" && row.invoiceIds == otherInvoiceId)
    }
})

feature("once the renewal's retries are exhausted its invoice is Dunning's again", {
    when() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        svc("update#" + SUB + "StoreRenewalOccurrence", {occurrenceId, stateEnumId: "SrsFailed"})
        return {notices: preview()}
    },
    then({notices}) {
        notices.some(row => row.statusId == "DntPending" && row.invoiceIds == renewalInvoiceId)
        !notices.some(row => row.excludedReason == "RENEWAL_RETRY")
    }
})
