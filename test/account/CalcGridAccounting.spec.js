// The accounting access profile of CalcGrid (data/10-seed/Accounting.xml; mr-moqui plans/IronCalc-DB2.md CG5, docs/tools/Database.md
// CalcGrid and access profiles), through org.moqui.calc.CalcServices as a screen would call them, with authorization on, as
// test/order/CalcGridSales.spec.js holds the sales profile: a holder reads the invoices and ledger transactions of the
// organization they work in and none of another's, through a view and the invoices' summary too; a payroll-origin invoice,
// payment or transaction (CALC_NO_PAYROLL) is never on the sheet; an entity the profile does not offer, and a view's member
// with no filter of its own, are refused. New spec, no Groovy original.
const CALC = "org.moqui.calc.CalcServices"
const effectiveTime = Date.now()
const dayMillis = 86400000
const users = {}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.user.setEffectiveTime(effectiveTime)
    },
    setup() { ec.artifactExecution.disableAuthz() },
    cleanup() {
        ec.artifactExecution.enableAuthz()
        login("john.doe")
    },
})

// run as a user with authorization on, the user's organizations in the user context as an app's root screen sets them
function as(username, run) {
    login(username, "moqui1!!")
    call("mantle.party.PartyServices.setup#UserOrganizationInfo", {})
    ec.artifactExecution.enableAuthz()
    try { return run() } finally {
        ec.artifactExecution.disableAuthz()
        for (const name of ["userOrgIds", "filterOrgIds", "activeOrgId"]) delete ec.user.context[name]
        login("john.doe")
    }
}
function calc(verbNoun, parameters) {
    const out = ec.service.sync().name(`${CALC}.${verbNoun}`).parameters(parameters).call() || {}
    const errors = ec.message.hasError() ? ec.message.getErrorsString() : ""
    ec.message.clearErrors()
    return { out, errors }
}
// open a new document over an entity under the accounting profile, read its texts, and close it
function readEntity(entityName) {
    const opened = calc("open#CalcDocument", { profileId: "accounting", source: { type: "entity", entityName } })
    if (opened.errors || !opened.out.roomId) return { errors: opened.errors, texts: [], dataRows: null }
    const cells = calc("get#CalcCells", { roomId: opened.out.roomId, profileId: "accounting", sheet: 0, row: 1, column: 1, width: 40, height: 30 })
    calc("close#CalcDocument", { roomId: opened.out.roomId })
    const texts = cells.errors ? [] : Array.from(JSON.parse(String(cells.out.blockJson)).texts || []).map((text) => String(text.text))
    return { errors: cells.errors, texts, dataRows: (opened.out.sheets || [])[0].dataRows }
}

feature("two organizations with an invoice and a ledger transaction each, a payroll invoice of the first, and a reader of each", {
    when() {
        const past = effectiveTime - dayMillis
        for (const [orgId, name] of [["CGA_ORG", "CalcGrid Books"], ["CGA_ORG2", "CalcGrid Ledger"]]) {
            call("create#mantle.party.Party", { partyId: orgId, partyTypeEnumId: "PtyOrganization", ownerPartyId: "_NA_" })
            call("create#mantle.party.Organization", { partyId: orgId, organizationName: name })
            call("create#mantle.party.PartyRole", { partyId: orgId, roleTypeId: "OrgInternal" })
        }
        // the grants an application makes: CalcGrid itself, authoring, and the accounting profile, always for view, with the user
        // organization filters and no payroll-origin document as its row scope
        call("create#moqui.security.UserGroup", { userGroupId: "CGA_READERS", description: "CalcGrid accounting readers" })
        call("create#moqui.security.ArtifactAuthz", { artifactAuthzId: "CGA_READERS_GRID", userGroupId: "CGA_READERS", artifactGroupId: "CALC_GRID",
                authzTypeEnumId: "AUTHZT_ALLOW", authzActionEnumId: "AUTHZA_ALL" })
        // authors: a new document over an entity is an author's to open (CALC_GRID_AUTHOR)
        call("create#moqui.security.ArtifactAuthz", { artifactAuthzId: "CGA_READERS_AUTHOR", userGroupId: "CGA_READERS", artifactGroupId: "CALC_GRID_AUTHOR",
                authzTypeEnumId: "AUTHZT_ALLOW", authzActionEnumId: "AUTHZA_ALL" })
        call("create#moqui.security.ArtifactAuthz", { artifactAuthzId: "CGA_READERS_ACCOUNTING", userGroupId: "CGA_READERS", artifactGroupId: "CALC_PROFILE_ACCOUNTING",
                authzTypeEnumId: "AUTHZT_ALWAYS", authzActionEnumId: "AUTHZA_VIEW" })
        for (const entityFilterSetId of ["MANTLE_USER_ORG", "CALC_NO_PAYROLL"])
            call("create#moqui.security.ArtifactAuthzFilter", { artifactAuthzId: "CGA_READERS_ACCOUNTING", entityFilterSetId })
        const parties = {}
        for (const [first, username, orgId] of [["Ann", "cga.ann", "CGA_ORG"], ["Otto", "cga.otto", "CGA_ORG2"]]) {
            const partyId = call("mantle.party.PartyServices.create#Person", { firstName: first, lastName: "CalcGrid" }).partyId
            users[first] = call("mantle.party.PartyServices.create#PartyUserAccount", { partyId, emailAddress: `${username}@example.com`, username,
                    newPassword: "moqui1!!", newPasswordVerify: "moqui1!!" }).userId
            parties[first] = partyId
            call("create#moqui.security.UserGroupMember", { userGroupId: "CGA_READERS", userId: users[first], fromDate: past })
            call("create#mantle.party.PartyRelationship", { relationshipTypeEnumId: "PrtEmployee", fromPartyId: partyId,
                    fromRoleTypeId: "Employee", toPartyId: orgId, toRoleTypeId: "OrgInternal", fromDate: past })
        }
        // an invoice and a transaction (with an entry) of each organization, and Ann's pay as a payroll-origin invoice of the first
        for (const [invoiceId, fromPartyId, toPartyId, payrollOrigin] of [["CGA-I1", "CGA_ORG", parties.Otto, null],
            ["CGA-I2", "CGA_ORG2", parties.Ann, null], ["CGA-PAY1", "CGA_ORG", parties.Ann, "Y"]])
            call("create#mantle.account.invoice.Invoice", { invoiceId, invoiceTypeEnumId: "InvoiceSales", fromPartyId, toPartyId,
                    statusId: "InvoiceInProcess", currencyUomId: "USD", invoiceDate: ec.user.nowTimestamp, payrollOrigin })
        for (const [acctgTransId, organizationPartyId, payrollOrigin] of [["CGA-T1", "CGA_ORG", null], ["CGA-T2", "CGA_ORG2", null],
            ["CGA-TPAY1", "CGA_ORG", "Y"]]) {
            call("create#mantle.ledger.transaction.AcctgTrans", { acctgTransId, organizationPartyId, acctgTransTypeEnumId: "AttInternal",
                    transactionDate: ec.user.nowTimestamp, isPosted: "N", amountUomId: "USD", payrollOrigin })
            call("create#mantle.ledger.transaction.AcctgTransEntry", { acctgTransId, acctgTransEntrySeqId: "01", glAccountId: "111100000",
                    debitCreditFlag: "D", amount: 10 })
        }
        // a payment of the first organization's and its payment of Ann's pay
        for (const [paymentId, toPartyId, payrollOrigin] of [["CGA-PM1", parties.Otto, null], ["CGA-PAYPM1", parties.Ann, "Y"]])
            call("create#mantle.account.payment.Payment", { paymentId, fromPartyId: "CGA_ORG", toPartyId, amount: 30, amountUomId: "USD", payrollOrigin })
        return { users }
    },
    then({ users }) {
        Object.keys(users).length == 2
    },
})

feature("a holder reads their own organization's invoices and transactions, a view too, never a payroll invoice; an entity not offered is refused", {
    when() {
        const annInvoices = as("cga.ann", () => readEntity("mantle.account.invoice.Invoice"))
        const ottoInvoices = as("cga.otto", () => readEntity("mantle.account.invoice.Invoice"))
        const annLedger = as("cga.ann", () => readEntity("mantle.ledger.transaction.AcctgTransAndEntry"))
        const ottoLedger = as("cga.otto", () => readEntity("mantle.ledger.transaction.AcctgTrans"))
        const orders = as("cga.ann", () => readEntity("mantle.order.OrderPart"))
        const entries = as("cga.ann", () => readEntity("mantle.ledger.transaction.AcctgTransEntry"))
        const payments = as("cga.ann", () => readEntity("mantle.account.payment.Payment"))
        const summary = as("cga.ann", () => readEntity("mantle.account.invoice.InvoiceSummary"))
        const partyOf = (userId) => ec.entity.find("moqui.security.UserAccount").condition("userId", userId).one().partyId
        const parties = { ann: partyOf(users.Ann), otto: partyOf(users.Otto) }
        const profileIds = as("cga.ann", () => Array.from(calc("get#CalcProfiles", {}).out.profiles || []).map((profile) => profile.profileId))
        return { annInvoices, ottoInvoices, annLedger, ottoLedger, orders, profileIds, entries, payments, summary, parties }
    },
    then({ annInvoices, ottoInvoices, annLedger, ottoLedger, orders, profileIds, entries, payments, summary, parties }) {
        profileIds.includes("accounting")
        annInvoices.errors == ""
        annInvoices.texts.includes("CGA-I1")
        !annInvoices.texts.includes("CGA-I2")
        !annInvoices.texts.includes("CGA-PAY1")
        ottoInvoices.errors == ""
        ottoInvoices.texts.includes("CGA-I2")
        !ottoInvoices.texts.includes("CGA-I1")
        !ottoInvoices.texts.includes("CGA-PAY1")
        annLedger.errors == ""
        annLedger.texts.includes("CGA-T1")
        !annLedger.texts.includes("CGA-T2")
        ottoLedger.errors == ""
        ottoLedger.texts.includes("CGA-T2")
        !ottoLedger.texts.includes("CGA-T1")
        orders.errors.includes("Not available")
        orders.texts.length == 0
        // the entries are a plain member of the view: no organization filter of their own
        entries.errors.includes("Not available")
        // no payroll-origin transaction, payment or invoice: in the view, the payments, the invoices' summary
        !annLedger.texts.includes("CGA-TPAY1")
        payments.errors == ""
        payments.texts.includes("CGA-PM1")
        !payments.texts.includes("CGA-PAYPM1")
        summary.errors == ""
        summary.dataRows == 1
        summary.texts.includes(parties.otto)
        !summary.texts.includes(parties.ann)
    },
})
