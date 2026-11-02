// Recurring invoices (AC-09) and the aging as of a day (AC-12, F36): a schedule from a template invoice, a period made once
// however often it is retried, the job making the periods due and recording a failure; the aging of a past day, with what
// was paid after it still open and a 121-day-old invoice in the last bucket, and Mantle's aging view fixed the same way.
// Standalone: spec-local organization, customer and users.
const helper = () => ec.resource.script("component://mr-mantle/test/ledger/AccountingReceivablesFixtures.js")
const svc = (name, p) => helper().call(name, p)
const recurring = (name, p) => helper().call("mantle.account.RecurringInvoiceServices." + name, p)
const refused = (name, p) => helper().rejected(name, p)
const one = (entity, key) => helper().lib.one(entity, key)
const rows = (entity, key) => helper().lib.rows(entity, key)
const prefix = "NATIVE_RECUR"
const stamp = offset => new Date(Number(ec.user.nowTimestamp) + offset * 86400000)
const day = offset => ec.l10n.format(stamp(offset), "yyyy-MM-dd")
const calendar = value => helper().lib.policy.calendarDateText(value)
let f, scheduleId, firstInvoiceId, lateScheduleId, failingScheduleId, paidId, oldId

// An issued invoice dated and due the days given (its stored due schedule moved with it).
function issued(amount, invoiceDaysAgo, dueDaysAgo) {
    login(f.users.ar)
    const invoice = helper().draft(f, amount)
    svc("mantle.account.InvoiceServices.change#InvoiceState", {
        invoiceId: invoice.invoiceId,
        action: "finalize",
        lastUpdatedStamp: invoice.lastUpdatedStamp
    })
    login("john.doe")
    svc("update#mantle.account.invoice.Invoice", {
        invoiceId: invoice.invoiceId,
        invoiceDate: stamp(-invoiceDaysAgo),
        accountingDate: day(-invoiceDaysAgo),
        dueDate: stamp(-dueDaysAgo)
    })
    for (const row of rows("mantle.account.invoice.InvoiceDueSchedule", {invoiceId: invoice.invoiceId}))
        svc("update#mantle.account.invoice.InvoiceDueSchedule", {
            invoiceId: row.invoiceId,
            scheduleSeqId: row.scheduleSeqId,
            dueDate: day(-dueDaysAgo)
        })
    return invoice.invoiceId
}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures(prefix)
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        login("john.doe")
    }
})

feature("AR schedules a monthly invoice from a template; AP and an empty template are refused", {
    when() {
        login(f.users.ar)
        const template = helper().draft(f, "1500")
        const empty = svc("mantle.account.InvoiceServices.create#Receivable", {
            organizationPartyId: f.org,
            customerPartyId: f.customer
        })
        const request = {
            organizationPartyId: f.org,
            templateInvoiceId: template.invoiceId,
            description: "Office rent",
            intervalUomId: "TF_mon",
            intervalQuantity: 1,
            startDate: day(0)
        }
        const made = recurring("store#Schedule", request)
        scheduleId = made.invoiceScheduleId
        const emptyRefused = refused(
            "mantle.account.RecurringInvoiceServices.store#Schedule",
            Object.assign({}, request, {templateInvoiceId: empty.invoiceId})
        )
        login(f.users.ap)
        const denied = refused("mantle.account.RecurringInvoiceServices.store#Schedule", request)
        return {schedule: one("mantle.account.invoice.InvoiceSchedule", {invoiceScheduleId: scheduleId}), emptyRefused, denied}
    },
    then({schedule, emptyRefused, denied}) {
        schedule.statusId == "IschActive"
        schedule.partyId == f.customer
        calendar(schedule.nextDate) == day(0)
        emptyRefused.includes("TEMPLATE_EMPTY")
        denied.includes("PERMISSION_DENIED")
    }
})

feature("a period previews its draft, and generating it twice makes one draft", {
    when() {
        login(f.users.ar)
        const preview = recurring("preview#Period", {invoiceScheduleId: scheduleId})
        const first = recurring("generate#Invoices", {invoiceScheduleId: scheduleId, occurrenceDate: day(0)})
        const again = recurring("generate#Invoices", {invoiceScheduleId: scheduleId, occurrenceDate: day(0)})
        firstInvoiceId = first.invoiceId
        const made = one("mantle.account.invoice.Invoice", {invoiceId: first.invoiceId})
        return {
            preview,
            first,
            again,
            made,
            items: rows("mantle.account.invoice.InvoiceItem", {invoiceId: first.invoiceId}),
            occurrences: rows("mantle.account.invoice.InvoiceScheduleOccurrence", {invoiceScheduleId: scheduleId}),
            schedule: one("mantle.account.invoice.InvoiceSchedule", {invoiceScheduleId: scheduleId})
        }
    },
    then({preview, first, again, made, items, occurrences, schedule}) {
        preview.total.eq(1500)
        preview.lines.length == 1
        preview.invoiceId == null
        first.alreadyGenerated == false
        again.alreadyGenerated == true
        again.invoiceId == first.invoiceId
        made.statusId == "InvoiceInProcess"
        made.toPartyId == f.customer
        items.length == 1
        occurrences.length == 1
        calendar(schedule.nextDate) > day(0)
    }
})

feature("the job makes the periods due and records a failure with its reason and notice", {
    when() {
        login(f.users.ar)
        const late = helper().draft(f, "200")
        lateScheduleId = recurring("store#Schedule", {
            organizationPartyId: f.org,
            templateInvoiceId: late.invoiceId,
            intervalUomId: "TF_wk",
            intervalQuantity: 1,
            startDate: day(-15)
        }).invoiceScheduleId
        const failing = helper().draft(f, "90")
        failingScheduleId = recurring("store#Schedule", {
            organizationPartyId: f.org,
            templateInvoiceId: failing.invoiceId,
            intervalUomId: "TF_mon",
            intervalQuantity: 1,
            startDate: day(0)
        }).invoiceScheduleId
        login("john.doe")
        for (const item of rows("mantle.account.invoice.InvoiceItem", {invoiceId: failing.invoiceId}))
            svc("delete#mantle.account.invoice.InvoiceItem", {invoiceId: item.invoiceId, invoiceItemSeqId: item.invoiceItemSeqId})
        const ran = recurring("run#Schedules", {})
        const again = recurring("run#Schedules", {})
        const failed = one("mantle.account.invoice.InvoiceScheduleOccurrence", {
            invoiceScheduleId: failingScheduleId,
            occurrenceDate: day(0)
        })
        const notices = rows("moqui.security.user.NotificationMessage", {
            topic: "RecurringInvoiceFailed",
            recordId: failingScheduleId
        })
        const recipients = notices.length
            ? rows("moqui.security.user.NotificationMessageUser", {notificationMessageId: notices[0].notificationMessageId})
            : []
        return {
            ran,
            again,
            lateMade: rows("mantle.account.invoice.InvoiceScheduleOccurrence", {invoiceScheduleId: lateScheduleId}),
            failed,
            recipients,
            noticeCount: notices.length
        }
    },
    then({ran, again, lateMade, failed, recipients, noticeCount}) {
        ran.generatedCount == 3
        ran.failedCount == 1
        again.generatedCount == 0
        lateMade.length == 3
        lateMade.every(row => row.statusId == "IsoGenerated" && row.invoiceId)
        failed.statusId == "IsoFailed"
        failed.errorMessage.includes("TEMPLATE_EMPTY")
        failed.invoiceId == null
        recipients.some(row => row.userId == f.users.ar)
        // failed again on the second run, still one notice for the period
        again.failedCount == 1
        noticeCount == 1
        failed.attemptCount == 2
    }
})

feature("a draft copies every template line but its calculated tax, a child under its parent, and no reference", {
    when() {
        login(f.users.ar)
        const template = helper().draft(f, "100")
        login("john.doe")
        svc("update#mantle.account.invoice.Invoice", {invoiceId: template.invoiceId, referenceNumber: "PO-TEMPLATE"})
        const parent = rows("mantle.account.invoice.InvoiceItem", {invoiceId: template.invoiceId})[0]
        svc("create#mantle.account.invoice.InvoiceItem", {
            invoiceId: template.invoiceId,
            invoiceItemSeqId: "90",
            parentItemSeqId: parent.invoiceItemSeqId,
            itemTypeEnumId: "ItemDiscount",
            quantity: 1,
            amount: -10,
            isAdjustment: "Y",
            itemDate: stamp(-3),
            description: "Loyalty discount"
        })
        svc("create#mantle.account.invoice.InvoiceItem", {
            invoiceId: template.invoiceId,
            invoiceItemSeqId: "91",
            parentItemSeqId: parent.invoiceItemSeqId,
            itemTypeEnumId: "ItemSalesTax",
            quantity: 1,
            amount: 6,
            taxCalculated: "Y",
            description: "Sales tax"
        })
        login(f.users.ar)
        const scheduleId = recurring("store#Schedule", {
            organizationPartyId: f.org,
            templateInvoiceId: template.invoiceId,
            intervalUomId: "TF_mon",
            intervalQuantity: 1,
            startDate: day(0)
        }).invoiceScheduleId
        const made = recurring("generate#Invoices", {invoiceScheduleId: scheduleId})
        return {
            parent,
            invoice: one("mantle.account.invoice.Invoice", {invoiceId: made.invoiceId}),
            lines: rows("mantle.account.invoice.InvoiceItem", {invoiceId: made.invoiceId})
        }
    },
    then({parent, invoice, lines}) {
        lines.length == 2
        lines.some(
            line =>
                line.invoiceItemSeqId == "90" &&
                line.parentItemSeqId == parent.invoiceItemSeqId &&
                line.isAdjustment == "Y" &&
                line.itemDate != null
        )
        !lines.some(line => line.itemTypeEnumId == "ItemSalesTax")
        invoice.invoiceTotal.eq(90)
        invoice.referenceNumber == null
    }
})

feature("the aging of a past day buckets by that day, keeps what was paid after it open and ages 121 days as the last", {
    when() {
        paidId = issued("100", 80, 55)
        oldId = issued("200", 150, 131)
        issued("50", 5, 0)
        login("john.doe")
        svc("create#mantle.account.payment.Payment", {
            paymentId: prefix + "_PAY",
            fromPartyId: f.customer,
            toPartyId: f.org,
            amount: 100,
            amountUomId: "USD",
            statusId: "PmntDelivered",
            effectiveDate: ec.user.nowTimestamp
        })
        svc("create#mantle.account.payment.PaymentApplication", {
            paymentApplicationId: prefix + "_APP",
            paymentId: prefix + "_PAY",
            invoiceId: paidId,
            amountApplied: 100,
            appliedDate: ec.user.nowTimestamp
        })
        login(f.users.read)
        const past = svc("mantle.ledger.LedgerReportServices.run#Aging", {organizationPartyId: f.org, asOfDate: day(-10)})
        const now = svc("mantle.ledger.LedgerReportServices.run#Aging", {
            organizationPartyId: f.org,
            partyId: f.customer
        })
        return {past, now, row: past.agingRows.find(row => row.partyId == f.customer)}
    },
    then({past, now, row}) {
        past.complete == true
        row.period2.eq(100)
        row.periodRemaining.eq(200)
        row.current.eq(0)
        row.total.eq(300)
        past.totals[0].total.eq(300)
        now.detailRows.some(detail => detail.invoiceId == oldId && detail.bucket == 5)
        !now.detailRows.some(detail => detail.invoiceId == paidId)
    }
})

feature("the aging refuses a day after today, another organization and a user without the side's reads", {
    when() {
        login(f.users.ar)
        const future = refused("mantle.ledger.LedgerReportServices.run#Aging", {organizationPartyId: f.org, asOfDate: day(2)})
        const payables = refused("mantle.ledger.LedgerReportServices.run#Aging", {
            organizationPartyId: f.org,
            invoiceType: "payable"
        })
        const other = refused("mantle.ledger.LedgerReportServices.run#Aging", {organizationPartyId: "ORG_ZIZI_RETAIL"})
        const receivables = svc("mantle.ledger.LedgerReportServices.run#Aging", {organizationPartyId: f.org})
        return {future, payables, other, receivables}
    },
    then({future, payables, other, receivables}) {
        future.includes("AS_OF_FUTURE")
        payables.includes("PERMISSION_DENIED")
        other.includes("ORGANIZATION_DENIED")
        receivables.agingRows.length == 1
    }
})

feature("Mantle's aging view puts an invoice 121 days past due in its last bucket", {
    when() {
        issued("70", 140, 121)
        login("john.doe")
        // the view's day arithmetic is per database, named by dbConfName in the context
        globalThis.dbConfName = ec.entity.getDatabaseConfName("mantle.account.invoice.Invoice")
        const found = ec.entity
            .find("mantle.account.invoice.InvoiceAgingSummary")
            .condition("fromPartyId", f.org)
            .condition("toPartyId", f.customer)
            .condition("statusId", "in", ["InvoiceFinalized", "InvoiceSent"])
            .selectField("periodRemaining")
            .selectField("totalDue")
            .disableAuthz()
            .one()
        // a customer with a second role: the sums are not multiplied, and a filter by its role (Marble's Aging) finds
        // them once
        svc("create#mantle.party.PartyRole", {partyId: f.customer, roleTypeId: "Supplier"})
        const sums = role => {
            let query = ec.entity
                .find("mantle.account.invoice.InvoiceAgingSummary")
                .condition("fromPartyId", f.org)
                .condition("toPartyId", f.customer)
                .condition("statusId", "in", ["InvoiceFinalized", "InvoiceSent"])
            if (role) query = query.condition("toRoleTypeId", role)
            return query.selectField("totalDue").disableAuthz().list()
        }
        return {found, plain: sums(null), customer: sums("Customer"), supplier: sums("Supplier"), carrier: sums("Carrier")}
    },
    then({found, plain, customer, supplier, carrier}) {
        // 131 and 121 days past due today: 200 and 70 beyond the fourth period
        found.periodRemaining.eq(270)
        found.totalDue.eq(320)
        plain.length == 1
        plain[0].totalDue.eq(320)
        customer.length == 1
        customer[0].totalDue.eq(320)
        supplier[0].totalDue.eq(320)
        carrier.length == 0 || carrier[0].totalDue == null
    }
})
