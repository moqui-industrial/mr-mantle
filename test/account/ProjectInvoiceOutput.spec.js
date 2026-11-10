// A project's invoice output and delivery as its billing editor (get#InvoiceOutput and send#Invoice with projectBilling:
// the side's editor who sees a project the invoice bills, by WorkEffortInvoice or by time billed on one of its tasks), the
// organization's project print screen (OrgTemplateProjectInvoicePrint: the default and the only print accepted), and the
// calendar days of authorized invoices (InvoiceWorkflowLib.invoiceCalendarDays). Regression suite: Mantle rules, no screen
// render and no PDF (each send here is refused before the print is issued).
const helper = () => ec.resource.script("component://mr-mantle/test/ledger/AccountingReceivablesFixtures.js")
const lib = () => ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const native = (name, p) => helper().call("mantle.account.InvoiceServices." + name, p)
const refused = (name, p) => helper().rejected("mantle.account.InvoiceServices." + name, p)
const made = {}
let f

function sendRequest(invoice, key, more = {}) {
    return Object.assign(
        {
            invoiceId: invoice.invoiceId,
            organizationPartyId: f.org,
            operationKey: key,
            sourceVersion: lib().fingerprint(invoice),
            emailTemplateId: f.emailTemplateId,
            projectBilling: true
        },
        more
    )
}
function setPrint(settingValue) {
    const key = {partyId: f.org, partySettingTypeId: "OrgTemplateProjectInvoicePrint"}
    if (lib().one("mantle.party.PartySetting", key)) helper().call("update#mantle.party.PartySetting", Object.assign({settingValue}, key))
    else helper().call("create#mantle.party.PartySetting", Object.assign({settingValue}, key))
}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        made.zone = ec.user.timeZone
        f = helper().fixtures("PIO")
        const work = (workEffortId, workEffortTypeEnumId, rootWorkEffortId) =>
            helper().call("create#mantle.work.effort.WorkEffort", {
                workEffortId,
                workEffortTypeEnumId,
                rootWorkEffortId,
                workEffortName: "Project invoice output " + workEffortId,
                visibilityEnumId: "WevWorkGroup",
                statusId: "WeInProgress"
            })
        work("PIO_PRJ", "WetProject", null)
        work("PIO_PRJ_TASK", "WetTask", "PIO_PRJ")
        work("PIO_HIDDEN", "WetProject", null)
        // the editor (RECEIVABLE_EDIT, no invoice view) is a party of the one project
        helper().call("create#mantle.work.effort.WorkEffortParty", {
            workEffortId: "PIO_PRJ",
            partyId: f.users.edit,
            roleTypeId: "Manager",
            fromDate: 0,
            statusId: "WeptAssigned"
        })
        // one invoice bills the project through time on its task, one bills only the hidden project
        made.billed = helper().draft(f, "30")
        helper().call("create#mantle.work.time.TimeEntry", {
            timeEntryId: "PIO_TIME",
            partyId: f.users.edit,
            workEffortId: "PIO_PRJ_TASK",
            fromDate: ec.user.nowTimestamp,
            hours: 1,
            invoiceId: made.billed.invoiceId
        })
        made.hidden = helper().draft(f, "31")
        helper().call("create#mantle.work.effort.WorkEffortInvoice", {workEffortId: "PIO_HIDDEN", invoiceId: made.hidden.invoiceId})
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        login("john.doe")
    },
    cleanupSpec() {
        ec.user.setTimeZone(made.zone)
    }
})

feature("the project billing editor gets the output of an invoice billing a project it sees, in the configured template only", {
    when() {
        login(f.users.edit)
        const billed = made.billed.invoiceId
        return {
            output: native("get#InvoiceOutput", {invoiceId: billed, organizationPartyId: f.org, projectBilling: true}),
            plain: refused("get#InvoiceOutput", {invoiceId: billed, organizationPartyId: f.org}),
            hidden: refused("get#InvoiceOutput", {invoiceId: made.hidden.invoiceId, organizationPartyId: f.org, projectBilling: true}),
            custom: refused("get#InvoiceOutput", {
                invoiceId: billed,
                organizationPartyId: f.org,
                projectBilling: true,
                templateLocation: "component://mr-mantle/template/account/Invoice.print.html.fancy"
            })
        }
    },
    then({output, plain, hidden, custom}) {
        output.printHtml.includes("<h1>Invoice " + made.billed.invoiceId + "</h1>")
        output.printHtml.includes("$30.00")
        plain.includes("PERMISSION_DENIED")
        hidden.includes("PERMISSION_DENIED")
        custom.includes("PROJECT_INVOICE_PRINT_INVALID")
    }
})

feature("a project send is refused for a project it does not see and for any print but the organization's project print screen", {
    when() {
        login(f.users.edit)
        const screen = "component://mr-mantle/test/account/ProjectInvoicePrint.xml"
        const hidden = refused("send#Invoice", sendRequest(made.hidden, "pio-hidden", {toAddresses: "client@example.com"}))
        setPrint(screen)
        const untrusted = refused(
            "send#Invoice",
            sendRequest(made.billed, "pio-untrusted", {printLocation: "component://mr-mantle/test/account/Other.xml"})
        )
        // no printLocation takes the setting: the print check passes and the send stops at its recipients
        const defaulted = refused("send#Invoice", sendRequest(made.billed, "pio-default"))
        // a setting that is not a screen is not accepted as a default either
        setPrint("component://mr-mantle/template/account/Invoice.print.html.fancy")
        const template = refused("send#Invoice", sendRequest(made.billed, "pio-template"))
        const state = lib().one(lib().invoiceEntity, {invoiceId: made.billed.invoiceId}).statusId
        return {hidden, untrusted, defaulted, template, state}
    },
    then({hidden, untrusted, defaulted, template, state}) {
        hidden.includes("PERMISSION_DENIED")
        untrusted.includes("PROJECT_INVOICE_PRINT_INVALID")
        defaulted.includes("RECIPIENT_REQUIRED")
        template.includes("PROJECT_INVOICE_PRINT_INVALID")
        state == "InvoiceInProcess"
    }
})

feature("invoiceCalendarDays: the book day, a single portion's due day, none for several portions or none, nothing for a missing invoice", {
    when() {
        const invoiceId = made.billed.invoiceId
        helper().call("update#mantle.account.invoice.Invoice", {invoiceId, accountingDate: "2026-11-09"})
        helper().call("create#mantle.account.invoice.InvoiceDueSchedule", {invoiceId, scheduleSeqId: "01", dueDate: "2026-12-09", amount: 0})
        // the days are the stored calendar days whatever the viewer's zone
        ec.user.setTimeZone("Pacific/Auckland")
        const single = lib().invoiceCalendarDays([invoiceId, invoiceId, null])[invoiceId]
        helper().call("create#mantle.account.invoice.InvoiceDueSchedule", {invoiceId, scheduleSeqId: "02", dueDate: "2026-12-19", amount: 0})
        const multiple = lib().invoiceCalendarDays([invoiceId])[invoiceId]
        for (const scheduleSeqId of ["01", "02"])
            helper().call("delete#mantle.account.invoice.InvoiceDueSchedule", {invoiceId, scheduleSeqId})
        const legacy = lib().invoiceCalendarDays([invoiceId])[invoiceId]
        ec.user.setTimeZone(made.zone)
        return {single, multiple, legacy, missing: Object.keys(lib().invoiceCalendarDays(["PIO_MISSING"]))}
    },
    then({single, multiple, legacy, missing}) {
        single.invoiceDay == "2026-11-09"
        single.dueDay == "2026-12-09"
        multiple.invoiceDay == "2026-11-09"
        multiple.dueDay == null
        legacy.invoiceDay == "2026-11-09"
        legacy.dueDay == null
        missing == []
    }
})
