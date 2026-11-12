// People's expense claims and employee advances (mantle.humanres.ExpenseServices; IronStone People design §9 ExpenseClaims,
// ExpenseClaimDetail and EmployeeAdvances, §15 the claim's PDF and evidence, PE-13, PE-24; impl-people P15, F21, F65). Every
// service checks the caller's People scope first (People.js scopeOf) and reads and writes with authorization off after it.
//
// A claim is an employee-from Invoice (the claimant to the employer: create#ProjectExpenseInvoice's claim write, createClaim here)
// whose lines are ItemExpense-family InvoiceItems with their receipts (InvoiceContent), and an ExpenseClaim keyed by the invoice
// (PeopleExpenseEntities.xml):
// - a draft (or a claim returned for correction) is changed by the claimant or, for them, a holder of PEOPLE_EXPENSE_MANAGE;
//   a line from mail or chat, or with values read from its receipt, waits for the claimant's review;
// - submitted, the invoice is InvoiceReceived and the claim waits for a People approval of kind PakExpenseClaim (the claimant's
//   manager unless a rule says otherwise; never the claimant or who asked); the last approval is its business approval and
//   leaves the invoice received, for finance; a decider may also return it for correction or refuse it (the invoice cancelled);
// - finance's approve#Payable (InvoiceWorkflow.js issue, through financeApproval here) approves only a claim whose business
//   approval is done and reserves it for accounts payable; a payroll run reserves it for payroll (reserve#ClaimSettlement, P27),
//   and a claim reserved for one route is refused by the other.
// An advance (EmployeeAdvance) is asked by the employee (or for them) and waits for a People approval of kind PakAdvance; its
// last approval makes it a payable (the user's call, impl-people §4, Nov 12, 2026): a bill from the employee to the employer of
// one ItemAdvancePay line (the employee advances account), received, which finance approves for payment and a payment run pays
// like any other bill. Finance applies the paid advance to the employee's finance-approved claim (apply#Advance): a credit the
// employer issues against the claim on the employee advances account, applied to it. Delivered is what delivered payments paid
// of the advance's bill, applied what its credits settled of claims, outstanding the difference.
//
// Who: the claimant (PEOPLE_SELF_SERVICE) reads and changes their own; a manager (PEOPLE_TEAM_VIEW) reads their live reports' at
// the line's employers; a holder of PEOPLE_EXPENSE_MANAGE reads every claim and advance of their employers and acts for an
// employee (the user's call, impl-people §4, Nov 12, 2026: HR and Accounting's payables, in BOSS); the approvers of the step
// waiting read and decide it. Finance applies advances with PAYMENT_EDIT in the organization and reserves a claim with its own
// permission; a payroll editor reserves one for payroll (P27). Missing and unauthorized records are refused alike
// (RECORD_UNAVAILABLE).
const people = ec.resource.script("component://mr-mantle/service/mantle/humanres/People.js")
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, denied, call, dateText} = lib
const approvals = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/Approvals.js")
const invoiceLib = () => ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")

const CLAIM = "mantle.humanres.expense.ExpenseClaim"
const CLAIM_ITEM = "mantle.humanres.expense.ExpenseClaimItem"
const ADVANCE = "mantle.humanres.expense.EmployeeAdvance"
const ADVANCE_APPLICATION = "mantle.humanres.expense.EmployeeAdvanceApplication"
const INVOICE = "mantle.account.invoice.Invoice"
const LINE = "mantle.account.invoice.InvoiceItem"
const CONTENT = "mantle.account.invoice.InvoiceContent"
const PAYMENT = "mantle.account.payment.Payment"
const APPLICATION = "mantle.account.payment.PaymentApplication"
const RELATIONSHIP = "mantle.party.PartyRelationship"
const ASSIGNMENT = "mantle.humanres.employment.EmploymentAssignment"
const claimKind = "PakExpenseClaim"
const advanceKind = "PakAdvance"

// the most rows a list reads and an export gives; the receipts a line keeps and their size
const listCap = 500
const exportCap = 2000
const receiptMaxBytes = 10 * 1024 * 1024
const receiptTypes = /^(image\/|application\/pdf$|text\/plain$)/
// a receipt is a photo, a PDF or a text file by its name too: an upload's declared type is the client's word, and a file is sent
// with the type its name gives, so an html or svg page is never kept as a receipt (nor shown inline from the app's origin)
const receiptNames = /\.(png|jpe?g|gif|webp|heic|heif|pdf|txt)$/i
const receiptName = name => receiptNames.test(String(name || ""))

const ms = lib.ms
const nowMs = () => ms(ec.user.nowTimestamp)
const text = value => String(value ?? "").trim()
const truthy = value => value === true || value === "true" || value === "Y"
const unique = people.unique
const first = query => Array.from(query.limit(1).list())[0] || null
const zero = () => toDecimal(0)
const decimalOf = value => (value == null || value === "" ? zero() : toDecimal(value))
const sum = values => values.reduce((total, value) => total.add(decimalOf(value)), zero())
const money = (value, currencyUomId) => ec.l10n.roundCurrency(decimalOf(value), currencyUomId || null)
const moneyText = (value, currencyUomId) =>
    currencyUomId ? ec.l10n.formatCurrency(money(value, currencyUomId), currencyUomId) : String(money(value, null))

const claimStatusTexts = {
    EcsDraft: "Draft",
    EcsSubmitted: "Waiting for approval",
    EcsReturned: "Returned for correction",
    EcsApproved: "Approved",
    EcsRefused: "Refused",
    EcsCancelled: "Cancelled"
}
const editableStatuses = ["EcsDraft", "EcsReturned"]
const routeTexts = {EcrPayable: "Accounts payable", EcrPayroll: "Payroll"}
const advanceStatusTexts = {
    EasRequested: "Waiting for approval",
    EasApproved: "Approved",
    EasRefused: "Refused",
    EasWithdrawn: "Withdrawn"
}
const sourceTexts = {ElsEntered: "Entered", ElsMail: "By mail", ElsChat: "From chat"}

// ===== scope =====
const employmentRow = partyRelationshipId =>
    partyRelationshipId ? one(RELATIONSHIP, {partyRelationshipId, relationshipTypeEnumId: "PrtEmployee"}) : null
const currentAt = (row, atMs) => !!row && (ms(row.fromDate) ?? -Infinity) <= atMs && (ms(row.thruDate) ?? Infinity) > atMs
// The caller's People scope with the employers whose claims and advances they manage (PEOPLE_EXPENSE_MANAGE): the internal
// organizations they work in, or the active one (every internal organization with PEOPLE_ALL_ORGANIZATIONS), read as People's
// staff reads read theirs. PEOPLE_EXPENSE_MANAGE is no staff read: it opens no person's People record.
function expenseScope() {
    const userScope = people.scopeOf()
    const caps = userScope.capabilities
    let managed = []
    if (caps.expenseManage && ec.user.userId) {
        const info = call("mantle.party.PartyServices.get#PartyOrganizationInfo")
        managed = people.employers({staff: true, allOrganizations: caps.allOrganizations}, info).organizationPartyIds
    }
    return Object.assign(userScope, {expenseOrganizationPartyIds: managed})
}
const managedEmployers = userScope => userScope.expenseOrganizationPartyIds || []
// How the scope admits a person's claims or advances at an employer: self (their own), team (a live report at the line's
// employer), manage (PEOPLE_EXPENSE_MANAGE at the employer).
function accessKinds(userScope, partyId, organizationPartyId) {
    const caps = userScope.capabilities
    const kinds = []
    if (caps.self && partyId === userScope.partyId) kinds.push("self")
    if (caps.team && ((userScope.reportLines || {})[partyId] || []).includes(organizationPartyId)) kinds.push("team")
    if (managedEmployers(userScope).includes(organizationPartyId)) kinds.push("manage")
    return kinds
}
// whether a party decided a step of a source's approval requests
function decidedBy(kind, sourceEntityName, sourceId, partyId) {
    if (!partyId) return false
    return rows("mantle.humanres.approval.PeopleApproval", {sourceEntityName, sourceId}).some(approval =>
        rows("mantle.humanres.approval.PeopleApprovalDecision", {peopleApprovalId: approval.peopleApprovalId}).some(
            row => row.decidedByPartyId === partyId
        )
    )
}
// The ways the caller reads a claim (or an advance): their access kinds, and approver when they may decide its step waiting or
// decided one; with its approval summary.
function recordAccess(userScope, record, kind, sourceEntityName, sourceId) {
    const kinds = accessKinds(userScope, record.partyId, record.organizationPartyId)
    const summary = approvals().sourceSummary(kind, sourceId)
    if (summary?.canDecide || decidedBy(kind, sourceEntityName, sourceId, userScope.partyId)) kinds.push("approver")
    return {kinds, summary}
}
// who changes a claim or asks an advance for a person: the person themselves, or a holder of PEOPLE_EXPENSE_MANAGE at the employer
const changes = kinds => kinds.includes("self") || kinds.includes("manage")
const lockClaim = invoiceId => find(CLAIM, {invoiceId}).forUpdate(true).one()
const lockAdvance = employeeAdvanceId => find(ADVANCE, {employeeAdvanceId}).forUpdate(true).one()
function departmentAt(partyRelationshipId, atMs) {
    const assignment = first(
        people.current(find(ASSIGNMENT).condition({partyRelationshipId, isPrimary: "Y"}), atMs).orderBy("-fromDate")
    )
    return assignment?.departmentPartyId || null
}
function readableClaim(userScope, invoiceId) {
    const claim = text(invoiceId) ? one(CLAIM, {invoiceId: text(invoiceId)}) : null
    const access = claim ? recordAccess(userScope, claim, claimKind, CLAIM, claim.invoiceId) : {kinds: []}
    if (!claim || !access.kinds.length) denied("RECORD_UNAVAILABLE", "Expense claim " + text(invoiceId) + " is not available")
    return Object.assign({claim}, access)
}
// A claim the caller may change: readable, theirs to change (the claimant or a holder of PEOPLE_EXPENSE_MANAGE at the employer), and a draft or
// returned for correction.
function changeableClaim(userScope, invoiceId) {
    const found = readableClaim(userScope, invoiceId)
    if (!changes(found.kinds)) denied("PERMISSION_DENIED", "The claimant or HR changes an expense claim")
    const claim = lockClaim(found.claim.invoiceId)
    if (!editableStatuses.includes(claim.statusEnumId))
        denied("CLAIM_LOCKED", "This claim is " + (claimStatusTexts[claim.statusEnumId] || claim.statusEnumId).toLowerCase())
    return Object.assign(found, {claim})
}
// a change of the claim or its lines moves its revision, so a request names what it was made at
const touch = invoiceId => call("update#" + CLAIM, {invoiceId, changedDate: ec.user.nowTimestamp})

// ===== the claim's stage, as the lists and the claim show it =====
// Draft, business-approved, finance-approved and paid are distinct labels (design §9 ExpenseClaims).
function stageOf(claim, invoice) {
    const statusId = claim.statusEnumId
    if (statusId !== "EcsApproved") return {stage: statusId, stageText: claimStatusTexts[statusId] || statusId}
    const invoiceStatus = invoice?.statusId
    if (invoiceStatus === "InvoicePmtSent" || (invoiceStatus === "InvoiceApproved" && decimalOf(invoice.unpaidTotal).isZero()))
        return {stage: "paid", stageText: "Paid"}
    if (invoiceStatus === "InvoiceApproved") return {stage: "financeApproved", stageText: "Finance approved"}
    if (invoiceStatus === "InvoiceCancelled") return {stage: "EcsCancelled", stageText: "Cancelled"}
    if (claim.reservedRouteEnumId === "EcrPayroll") return {stage: "payroll", stageText: "Approved: with payroll"}
    return {stage: "approved", stageText: "Approved: with finance"}
}
const stageColors = {
    EcsDraft: "grey-8",
    EcsSubmitted: "warning",
    EcsReturned: "warning",
    approved: "primary",
    payroll: "primary",
    financeApproved: "primary",
    paid: "positive",
    EcsRefused: "negative",
    EcsCancelled: "grey-8"
}

// ===== create#ProjectExpenseInvoice's claim write (F21) =====
// The claimant (fromPartyId) creates only their own claim (PEOPLE_SELF_SERVICE); anyone else's is made by a holder of
// PEOPLE_EXPENSE_MANAGE at the employer, who is recorded. The employer is that of the claimant's current employment (the one named, else the one with toPartyId, else
// their only one); a project is one the claimant works on. The invoice (the claimant to the employer, InvoiceIncoming) and the
// ExpenseClaim (a draft on the accounts payable route) are written; a retry with the same operation key answers the first.
function createClaim(p) {
    const userScope = expenseScope()
    const operationKey = text(p.operationKey) || null
    if (operationKey) {
        const known = first(find(CLAIM, {operationKey, createdByUserId: ec.user.userId}))
        if (known) return {invoiceId: known.invoiceId, repeated: true}
    }
    const partyId = text(p.fromPartyId)
    const own = !!partyId && partyId === userScope.partyId
    if (own && !userScope.capabilities.self) denied("PERMISSION_DENIED", "Expense claims need PEOPLE_SELF_SERVICE")
    // another person's claim is made for them under PEOPLE_EXPENSE_MANAGE: checked before anything of that person is read
    if (!own && !userScope.capabilities.expenseManage)
        denied("PERMISSION_DENIED", "You make expense claims for yourself; HR makes them for an employee")
    const now = nowMs()
    let employment
    if (text(p.partyRelationshipId)) {
        employment = employmentRow(text(p.partyRelationshipId))
        if (!employment || employment.fromPartyId !== partyId)
            denied("RECORD_UNAVAILABLE", "Employment " + text(p.partyRelationshipId) + " is not available")
    } else {
        const current = Array.from(
            people.current(people.employmentFind().condition("fromPartyId", partyId), null).limit(20).list()
        ).filter(row => !text(p.toPartyId) || row.toPartyId === text(p.toPartyId))
        if (!current.length) denied("NOT_EMPLOYED", "The claimant has no current employment with this employer")
        if (current.length > 1) denied("EMPLOYMENT_REQUIRED", "Choose the employer the claim is for")
        employment = employmentRow(current[0].partyRelationshipId)
    }
    const kinds = accessKinds(userScope, employment.fromPartyId, employment.toPartyId)
    if (!changes(kinds)) denied("PERMISSION_DENIED", "You make expense claims for yourself; HR makes them for an employee")
    if (!currentAt(employment, now) || (text(p.toPartyId) && text(p.toPartyId) !== employment.toPartyId))
        denied("NOT_EMPLOYED", "The claimant is not employed there now")
    const workEffortId = text(p.workEffortId) || null
    if (workEffortId) checkProject(workEffortId, employment.fromPartyId)
    const purpose = text(p.purpose) || null
    const created = call("mantle.account.InvoiceServices.create#Invoice", {
        fromPartyId: employment.fromPartyId,
        toPartyId: employment.toPartyId,
        invoiceTypeEnumId: text(p.invoiceTypeEnumId) || "InvoiceSales",
        invoiceDate: p.invoiceDate || ec.user.nowTimestamp,
        currencyUomId: text(p.currencyUomId) || null,
        description: text(p.description) || purpose
    })
    if (workEffortId) call("create#mantle.work.effort.WorkEffortInvoice", {workEffortId, invoiceId: created.invoiceId})
    writeClaim(created.invoiceId, employment, {workEffortId, purpose, operationKey})
    return {invoiceId: created.invoiceId, repeated: false}
}
function writeClaim(invoiceId, employment, values) {
    call("create#" + CLAIM, {
        invoiceId,
        partyRelationshipId: employment.partyRelationshipId,
        partyId: employment.fromPartyId,
        organizationPartyId: employment.toPartyId,
        departmentPartyId: departmentAt(employment.partyRelationshipId, nowMs()),
        workEffortId: values.workEffortId || null,
        purpose: values.purpose || null,
        statusEnumId: "EcsDraft",
        routeEnumId: "EcrPayable",
        createdByUserId: ec.user.userId || null,
        createdDate: ec.user.nowTimestamp,
        changedDate: ec.user.nowTimestamp,
        operationKey: values.operationKey || null
    })
}
// a project the claimant works on now (a current party of a project), else PROJECT_UNAVAILABLE
function checkProject(workEffortId, partyId) {
    const project = one("mantle.work.effort.WorkEffort", {workEffortId})
    const onIt =
        project?.workEffortTypeEnumId === "WetProject" &&
        people.current(find("mantle.work.effort.WorkEffortParty").condition({workEffortId, partyId}), null).count() > 0
    if (!onIt) denied("PROJECT_UNAVAILABLE", "Choose a project you work on")
}

// ===== store#Claim =====
// A draft's (or a returned claim's) header: purpose, description, project, the day it is dated and, while it has no line, the
// currency. revision (the claim's last change, from get#Claim) refuses a stale write.
function storeClaim(p) {
    const userScope = expenseScope()
    const {claim} = changeableClaim(userScope, p.invoiceId)
    if (text(p.revision) && text(p.revision) !== String(ms(claim.lastUpdatedStamp) ?? 0))
        denied("REVISION_CHANGED", "The claim changed since you read it; open it again")
    const invoice = one(INVOICE, {invoiceId: claim.invoiceId})
    const changesOf = {}
    if (p.purpose !== undefined && p.purpose !== null) changesOf.purpose = text(p.purpose) || null
    if (p.workEffortId !== undefined && p.workEffortId !== null && text(p.workEffortId) !== text(claim.workEffortId)) {
        const workEffortId = text(p.workEffortId) || null
        if (workEffortId) checkProject(workEffortId, claim.partyId)
        for (const link of rows("mantle.work.effort.WorkEffortInvoice", {invoiceId: claim.invoiceId}))
            call("delete#mantle.work.effort.WorkEffortInvoice", {workEffortId: link.workEffortId, invoiceId: claim.invoiceId})
        if (workEffortId) call("create#mantle.work.effort.WorkEffortInvoice", {workEffortId, invoiceId: claim.invoiceId})
        changesOf.workEffortId = workEffortId
    }
    const invoiceChanges = {}
    if (p.description !== undefined && p.description !== null) invoiceChanges.description = text(p.description) || null
    if (p.invoiceDate) invoiceChanges.invoiceDate = p.invoiceDate
    if (text(p.currencyUomId) && text(p.currencyUomId) !== invoice.currencyUomId) {
        if (find(LINE, {invoiceId: claim.invoiceId}).count() > 0)
            denied("CURRENCY_LOCKED", "The currency changes only while the claim has no line")
        invoiceChanges.currencyUomId = text(p.currencyUomId)
    }
    if (Object.keys(invoiceChanges).length) call("update#" + INVOICE, Object.assign({invoiceId: claim.invoiceId}, invoiceChanges))
    call("update#" + CLAIM, Object.assign({invoiceId: claim.invoiceId, changedDate: ec.user.nowTimestamp}, changesOf))
    return {invoiceId: claim.invoiceId}
}

// ===== store#ClaimItem =====
const expenseTypes = () =>
    Array.from(
        find("moqui.basic.Enumeration")
            .condition({enumTypeId: "ItemType", parentEnumId: "ItemExpense"})
            .orderBy("description")
            .list()
    )
function checkExpenseType(itemTypeEnumId) {
    const row = one("moqui.basic.Enumeration", {enumId: itemTypeEnumId})
    if (!row || row.enumTypeId !== "ItemType" || row.parentEnumId !== "ItemExpense")
        denied("EXPENSE_TYPE_INVALID", "Choose an expense type")
}
function nextSeqId(invoiceId) {
    const seqIds = Array.from(find(LINE, {invoiceId}).selectField("invoiceItemSeqId").list()).map(row =>
        Number(row.invoiceItemSeqId)
    )
    return String((seqIds.length ? Math.max(...seqIds.filter(Number.isFinite), 0) : 0) + 1).padStart(2, "0")
}
// A receipt kept with the claim's invoice (InvoiceContent IctReceipt): a file uploaded, or a file at a location (a mail or chat
// attachment), copied under the invoice's content folder. Answers the content id.
function keepReceipt(invoiceId, source) {
    const name =
        String(source.fileName || "receipt")
            .split(/[\\/]/)
            .pop()
            .replace(/[^A-Za-z0-9._ -]/g, "_")
            .replace(/^\.+/, "")
            .substring(0, 120) || "receipt"
    const content = call("create#" + CONTENT, {
        invoiceId,
        contentTypeEnumId: "IctReceipt",
        description: name,
        contentDate: ec.user.nowTimestamp,
        userId: ec.user.userId || null
    })
    const location = "dbresource://mantle/content/invoice/" + invoiceId + "/content_" + content.invoiceContentId + "/" + name
    const reference = ec.resource.getLocationReference(location)
    if (source.file) {
        const stream = source.file.getInputStream()
        try {
            reference.putStream(stream)
        } finally {
            stream.close()
        }
    } else if (source.location) reference.copyFrom(source.location)
    else if (source.text != null) reference.putText(String(source.text))
    call("update#" + CONTENT, {invoiceContentId: content.invoiceContentId, contentLocation: location})
    return content.invoiceContentId
}
function checkReceiptFile(file) {
    const size = Number(file.size ?? file.getSize?.() ?? 0)
    const type = String(file.contentType || "").toLowerCase()
    if (!size) denied("RECEIPT_INVALID", "The receipt file is empty")
    if (size > receiptMaxBytes) denied("RECEIPT_TOO_LARGE", "A receipt is at most 10 MB")
    if ((type && !receiptTypes.test(type)) || type === "image/svg+xml" || !receiptName(file.fileName || file.name))
        denied("RECEIPT_INVALID", "A receipt is a photo, a PDF or a text file")
}
// A line of a draft (or returned) claim added, changed or removed (remove), by the claimant or HR: the expense type (an
// ItemExpense-family type), the description, the day, the quantity (1 by default) and the amount (positive, to the currency's
// precision), the tax it includes (not more than the line), the merchant and a receipt file (a photo, a PDF or a text file, at
// most 10 MB). Saving a line is its review: a line from mail or chat no longer waits. Answers the line.
function storeClaimItem(p) {
    const userScope = expenseScope()
    const {claim} = changeableClaim(userScope, p.invoiceId)
    const invoice = one(INVOICE, {invoiceId: claim.invoiceId})
    const currencyUomId = invoice.currencyUomId || null
    let seqId = text(p.invoiceItemSeqId) || null
    const existing = seqId ? one(LINE, {invoiceId: claim.invoiceId, invoiceItemSeqId: seqId}) : null
    if (seqId && !existing) denied("RECORD_UNAVAILABLE", "Line " + seqId + " is not available")
    if (truthy(p.remove)) {
        if (!existing) denied("RECORD_UNAVAILABLE", "Choose the line to remove")
        const extension = one(CLAIM_ITEM, {invoiceId: claim.invoiceId, invoiceItemSeqId: seqId})
        if (extension) call("delete#" + CLAIM_ITEM, {invoiceId: claim.invoiceId, invoiceItemSeqId: seqId})
        call("delete#" + LINE, {invoiceId: claim.invoiceId, invoiceItemSeqId: seqId})
        touch(claim.invoiceId)
        return {invoiceId: claim.invoiceId, invoiceItemSeqId: seqId, removed: true}
    }
    const itemTypeEnumId = text(p.itemTypeEnumId) || existing?.itemTypeEnumId || ""
    checkExpenseType(itemTypeEnumId)
    const description = text(p.description) || existing?.description || ""
    if (!description) denied("DESCRIPTION_REQUIRED", "Say what the expense was")
    const quantity = p.quantity == null || p.quantity === "" ? decimalOf(existing?.quantity ?? 1) : decimalOf(p.quantity)
    if (quantity.compare(0) <= 0) denied("QUANTITY_INVALID", "The quantity is more than nothing")
    const amount = lib.amount(p.amount == null || p.amount === "" ? existing?.amount : p.amount, currencyUomId)
    const lineTotal = ec.l10n.roundCurrency(quantity.multiply(amount), currencyUomId)
    const taxAmount = p.taxAmount == null || p.taxAmount === "" ? null : decimalOf(p.taxAmount)
    if (taxAmount && (taxAmount.compare(0) < 0 || taxAmount.compare(lineTotal) > 0))
        denied("TAX_INVALID", "The tax is part of the line's amount")
    const itemDate = p.itemDate || existing?.itemDate || ec.user.nowTimestamp
    if (ms(itemDate) > nowMs() + 24 * 3600 * 1000) denied("DATE_FUTURE", "An expense is of today or an earlier day")
    const file = p.receiptFile && (p.receiptFile.fileName || p.receiptFile.name) ? p.receiptFile : null
    if (file) checkReceiptFile(file)
    const values = {invoiceId: claim.invoiceId, itemTypeEnumId, description, quantity, amount, itemDate}
    if (existing) call("update#" + LINE, Object.assign({invoiceItemSeqId: seqId}, values))
    else {
        seqId = nextSeqId(claim.invoiceId)
        call("create#" + LINE, Object.assign({invoiceItemSeqId: seqId}, values))
    }
    const extension = one(CLAIM_ITEM, {invoiceId: claim.invoiceId, invoiceItemSeqId: seqId})
    const receiptContentId = file
        ? keepReceipt(claim.invoiceId, {file, fileName: file.fileName || file.name})
        : extension?.receiptContentId || null
    const extensionValues = {
        invoiceId: claim.invoiceId,
        invoiceItemSeqId: seqId,
        merchantName: p.merchantName != null ? text(p.merchantName) || null : extension?.merchantName || null,
        taxAmount,
        receiptContentId,
        reviewNeeded: "N"
    }
    if (extension) call("update#" + CLAIM_ITEM, extensionValues)
    else call("create#" + CLAIM_ITEM, Object.assign({sourceEnumId: "ElsEntered"}, extensionValues))
    touch(claim.invoiceId)
    return {invoiceId: claim.invoiceId, invoiceItemSeqId: seqId, removed: false}
}

// ===== read#Receipt =====
// Values proposed from a receipt's text, nothing saved: the text given (typed or pasted), else the text of the line's receipt
// file (a PDF or a text file; a photo has no text the server reads), passed to org.moqui.agent.AiTaskServices.run#Extract, which
// wraps it as untrusted. The claimant reviews the proposal before store#ClaimItem saves it. available is false, with why, when
// there is no text or no model answers.
const extractFields = {
    itemDate: "The day of the purchase, as yyyy-MM-dd",
    amount: "The total paid, as a number with a decimal point and no currency symbol",
    currencyUomId: "The ISO 4217 code of the currency paid",
    merchantName: "The name of the merchant or business",
    taxAmount: "The tax included in the total, as a number, or empty",
    description: "What was bought, in a few words"
}
function readReceipt(p) {
    const userScope = expenseScope()
    const {claim} = changeableClaim(userScope, p.invoiceId)
    let receiptText = text(p.receiptText)
    if (!receiptText && text(p.invoiceItemSeqId)) {
        const extension = one(CLAIM_ITEM, {invoiceId: claim.invoiceId, invoiceItemSeqId: text(p.invoiceItemSeqId)})
        const content = extension?.receiptContentId ? one(CONTENT, {invoiceContentId: extension.receiptContentId}) : null
        if (content?.contentLocation)
            try {
                receiptText = text(ec.resource.extractText(content.contentLocation, "receipt-" + content.invoiceContentId, 8000))
            } catch (error) {
                ec.logger.warn(
                    "Receipt " + content.invoiceContentId + " of claim " + claim.invoiceId + " has no text: " + error.message
                )
            }
    }
    if (!receiptText)
        return {available: false, message: "The receipt has no text to read: type or paste what it says", proposal: {}}
    let values = {}
    try {
        const out = lib.probe("org.moqui.agent.AiTaskServices.run#Extract", {
            text: receiptText.substring(0, 8000),
            fieldMap: extractFields,
            allowInTransaction: true
        })
        values = out.valueMap || {}
    } catch (error) {
        ec.logger.warn("Reading a receipt of claim " + claim.invoiceId + " failed: " + error.message)
        return {available: false, message: "Reading receipts is not available now: enter the values", proposal: {}}
    }
    const number = value => {
        const cleaned = text(value).replace(/[^0-9.-]/g, "")
        return /^-?\d+(\.\d+)?$/.test(cleaned) ? cleaned : ""
    }
    const day = /^\d{4}-\d{2}-\d{2}$/.test(text(values.itemDate)) ? text(values.itemDate) : ""
    return {
        available: true,
        message: "Proposed from the receipt: check each value before you save the line",
        proposal: {
            itemDate: day,
            amount: number(values.amount),
            currencyUomId: /^[A-Z]{3}$/.test(text(values.currencyUomId).toUpperCase())
                ? text(values.currencyUomId).toUpperCase()
                : "",
            merchantName: text(values.merchantName).substring(0, 255),
            taxAmount: number(values.taxAmount),
            description: text(values.description).substring(0, 255)
        }
    }
}

// ===== submit#Claim =====
// A draft (or a returned claim) sent for business approval by the claimant or HR: it has lines, none waiting for review, each
// with a positive amount; the invoice is received (InvoiceReceived) and a People approval of kind PakExpenseClaim is asked (the
// claimant's manager unless a rule says otherwise). Lines without a receipt are counted (receiptsMissing), not refused. A
// retry once it waits answers it (repeated).
function submitClaim(p) {
    const userScope = expenseScope()
    const found = readableClaim(userScope, p.invoiceId)
    if (!changes(found.kinds)) denied("PERMISSION_DENIED", "The claimant or HR submits an expense claim")
    let claim = lockClaim(found.claim.invoiceId)
    if (claim.statusEnumId === "EcsSubmitted") return Object.assign(claimAnswer(claim), {repeated: true, receiptsMissing: 0})
    if (!editableStatuses.includes(claim.statusEnumId))
        denied("CLAIM_LOCKED", "This claim is " + (claimStatusTexts[claim.statusEnumId] || claim.statusEnumId).toLowerCase())
    const lines = rows(LINE, {invoiceId: claim.invoiceId})
    if (!lines.length) denied("LINES_REQUIRED", "Add the expenses before you submit the claim")
    const extensions = Object.fromEntries(rows(CLAIM_ITEM, {invoiceId: claim.invoiceId}).map(row => [row.invoiceItemSeqId, row]))
    if (lines.some(line => extensions[line.invoiceItemSeqId]?.reviewNeeded === "Y"))
        denied("LINES_TO_REVIEW", "Review the lines from mail or chat before you submit the claim")
    if (lines.some(line => decimalOf(line.amount).compare(0) <= 0 || decimalOf(line.quantity ?? 1).compare(0) <= 0))
        denied("AMOUNT_INVALID", "Every line needs an amount")
    const receiptsMissing = lines.filter(line => !extensions[line.invoiceItemSeqId]?.receiptContentId).length
    const invoice = one(INVOICE, {invoiceId: claim.invoiceId})
    if (invoice.statusId === "InvoiceIncoming")
        call("update#" + INVOICE, {invoiceId: claim.invoiceId, statusId: "InvoiceReceived"})
    else if (invoice.statusId !== "InvoiceReceived") denied("CLAIM_LOCKED", "This claim's invoice is no longer a draft")
    call("update#" + CLAIM, {
        invoiceId: claim.invoiceId,
        statusEnumId: "EcsSubmitted",
        submittedDate: ec.user.nowTimestamp,
        decidedDate: null,
        changedDate: ec.user.nowTimestamp
    })
    claim = one(CLAIM, {invoiceId: claim.invoiceId})
    approvals().request({
        approvalKindEnumId: claimKind,
        sourceId: claim.invoiceId,
        organizationPartyId: claim.organizationPartyId,
        departmentPartyId: claim.departmentPartyId || null,
        subjectPartyId: claim.partyId,
        effectiveDate: ec.user.nowTimestamp,
        justification: claim.purpose || null
    })
    return Object.assign(claimAnswer(claim), {repeated: false, receiptsMissing})
}
const claimAnswer = claim => ({
    invoiceId: claim.invoiceId,
    statusEnumId: claim.statusEnumId,
    statusText: claimStatusTexts[claim.statusEnumId] || claim.statusEnumId
})

// ===== decide#Claim and the topic's services =====
// approve: the step waiting (record#Decision at the claim's revision); the last approval is the business approval and leaves the
// invoice received, for finance. return and refuse (with a reason): the claim goes back to the claimant to correct (returned), or
// is refused and its invoice cancelled. withdraw: the claimant or who made it takes back a claim waiting (a draft again). cancel:
// the claimant or HR cancels a draft or returned claim (its invoice cancelled). Under the claim's lock; one who reads nothing of it
// is answered as for a missing one. A decision retried answers the first.
function decideClaim(p) {
    const userScope = expenseScope()
    const action = text(p.decision) || "approve"
    if (!["approve", "refuse", "return", "withdraw", "cancel"].includes(action))
        denied("DECISION_INVALID", "Approve, return, refuse, withdraw or cancel")
    const known = text(p.invoiceId) ? one(CLAIM, {invoiceId: text(p.invoiceId)}) : null
    if (!known) denied("RECORD_UNAVAILABLE", "Expense claim " + text(p.invoiceId) + " is not available")
    let claim = lockClaim(known.invoiceId)
    const {kinds} = recordAccess(userScope, claim, claimKind, CLAIM, claim.invoiceId)
    if (!kinds.length) denied("RECORD_UNAVAILABLE", "Expense claim " + claim.invoiceId + " is not available")
    if (action === "withdraw") {
        if (!kinds.includes("self") && claim.createdByUserId !== ec.user.userId)
            denied("NOT_YOURS", "The claimant or who made it withdraws a claim")
        if (claim.statusEnumId !== "EcsSubmitted") denied("NOT_PENDING", "Only a claim waiting for approval is withdrawn")
        call("update#" + CLAIM, {invoiceId: claim.invoiceId, statusEnumId: "EcsDraft", changedDate: ec.user.nowTimestamp})
        approvals().sourceChanged(claimKind, claim.invoiceId)
        return Object.assign(claimAnswer(one(CLAIM, {invoiceId: claim.invoiceId})), {repeated: false})
    }
    if (action === "cancel") {
        if (!changes(kinds)) denied("NOT_YOURS", "The claimant or HR cancels a claim")
        if (claim.statusEnumId === "EcsCancelled") return Object.assign(claimAnswer(claim), {repeated: true})
        if (!editableStatuses.includes(claim.statusEnumId))
            denied("NOT_PENDING", "Only a draft or a returned claim is cancelled; withdraw one that waits first")
        call("update#" + CLAIM, {invoiceId: claim.invoiceId, statusEnumId: "EcsCancelled", changedDate: ec.user.nowTimestamp})
        cancelInvoice(claim.invoiceId, "Expense claim cancelled")
        return Object.assign(claimAnswer(one(CLAIM, {invoiceId: claim.invoiceId})), {repeated: false})
    }
    const asked = claim.statusEnumId
    const reason = text(p.reason) || null
    const decided = call("mantle.humanres.PeopleApprovalServices.record#Decision", {
        approvalKindEnumId: claimKind,
        peopleApprovalId: text(p.peopleApprovalId) || null,
        sourceId: claim.invoiceId,
        decision: action === "approve" ? "approve" : "refuse",
        reason,
        sourceRevision: text(p.sourceRevision) || null,
        operationKey: text(p.operationKey) || null
    })
    if (decided.repeated) return Object.assign(claimAnswer(one(CLAIM, {invoiceId: claim.invoiceId})), {repeated: true})
    if (asked !== "EcsSubmitted") denied("NOT_PENDING", "This claim is " + (claimStatusTexts[asked] || asked).toLowerCase())
    if (decided.complete)
        call("update#" + CLAIM, {
            invoiceId: claim.invoiceId,
            statusEnumId: "EcsApproved",
            decidedDate: ec.user.nowTimestamp,
            decisionReason: null
        })
    else if (decided.statusId === "PapRefused") {
        call("update#" + CLAIM, {
            invoiceId: claim.invoiceId,
            statusEnumId: action === "refuse" ? "EcsRefused" : "EcsReturned",
            decidedDate: ec.user.nowTimestamp,
            decisionReason: reason,
            changedDate: ec.user.nowTimestamp
        })
        if (action === "refuse") cancelInvoice(claim.invoiceId, "Expense claim refused")
    }
    return Object.assign(claimAnswer(one(CLAIM, {invoiceId: claim.invoiceId})), {repeated: false})
}
function cancelInvoice(invoiceId, reason) {
    const invoice = one(INVOICE, {invoiceId})
    if (invoice && ["InvoiceIncoming", "InvoiceReceived"].includes(invoice.statusId))
        call("update#" + INVOICE, {invoiceId, statusId: "InvoiceCancelled", statusId_changeReason: reason})
}
function decideClaimNotice(p, decision) {
    const message = p.message || {}
    if (p.recordEntityName && p.recordEntityName !== CLAIM) denied("SOURCE_INVALID", "Not an expense claim approval")
    return decideClaim({
        invoiceId: p.recordId,
        peopleApprovalId: message.peopleApprovalId,
        sourceRevision: message.sourceRevision,
        decision,
        reason: p.reason
    })
}

// ===== find#Claims, get#Claim =====
// The claims the caller reads, as a query condition: their own (self), their reports' at the line's employers (team), the
// employers' of a holder of PEOPLE_EXPENSE_MANAGE; with mine their own alone.
function reachCondition(userScope, mine) {
    const caps = userScope.capabilities
    const factory = ec.entity.conditionFactory
    const parts = []
    if (caps.self && userScope.partyId) parts.push(factory.makeCondition("partyId", "equals", userScope.partyId))
    if (!mine) {
        const reportIds = []
        const lines = userScope.reportLines || {}
        if (caps.team && Object.keys(lines).length)
            for (const row of Array.from(
                people.employmentFind().condition("fromPartyId", "in", Object.keys(lines)).limit(listCap).list()
            ))
                if ((lines[row.fromPartyId] || []).includes(row.toPartyId)) reportIds.push(row.partyRelationshipId)
        if (reportIds.length) parts.push(factory.makeCondition("partyRelationshipId", "in", reportIds))
        const employers = managedEmployers(userScope)
        if (employers.length) parts.push(factory.makeCondition("organizationPartyId", "in", employers))
    }
    if (!parts.length) return null
    return parts.reduce((all, part) => factory.makeCondition(all, "or", part))
}
// the sources of a kind whose step waiting the caller decides now (Approvals.js waitingFor)
const toDecideOf = kind =>
    unique(
        approvals()
            .waitingFor(listCap)
            .filter(row => row.approvalKindEnumId === kind)
            .map(row => row.sourceId)
    )
function claimLine(claim, invoice, names, organizations, projects, deciding) {
    const stage = stageOf(claim, invoice)
    const currencyUomId = invoice?.currencyUomId || null
    return {
        invoiceId: claim.invoiceId,
        partyId: claim.partyId,
        personName: names[claim.partyId] || claim.partyId,
        organizationPartyId: claim.organizationPartyId,
        organizationName: organizations[claim.organizationPartyId] || claim.organizationPartyId,
        workEffortId: claim.workEffortId || null,
        projectName: claim.workEffortId ? projects[claim.workEffortId] || claim.workEffortId : "",
        purpose: claim.purpose || invoice?.description || "",
        invoiceDateText: invoice?.invoiceDate ? ec.l10n.format(invoice.invoiceDate, "yyyy-MM-dd") : "",
        currencyUomId,
        invoiceTotal: money(invoice?.invoiceTotal, currencyUomId),
        totalText: moneyText(invoice?.invoiceTotal, currencyUomId),
        unpaidTotal: money(invoice?.unpaidTotal, currencyUomId),
        statusEnumId: claim.statusEnumId,
        statusText: claimStatusTexts[claim.statusEnumId] || claim.statusEnumId,
        stage: stage.stage,
        stageText: stage.stageText,
        stageColor: stageColors[stage.stage] || "grey-8",
        financeStatusId: invoice?.statusId || null,
        routeText: routeTexts[claim.reservedRouteEnumId || claim.routeEnumId] || "",
        submittedDateText: dateText(claim.submittedDate),
        toDecide: !!deciding
    }
}
function projectNames(workEffortIds) {
    if (!workEffortIds.length) return {}
    return Object.fromEntries(
        Array.from(find("mantle.work.effort.WorkEffort").condition("workEffortId", "in", workEffortIds).list()).map(row => [
            row.workEffortId,
            row.workEffortName || row.workEffortId
        ])
    )
}
// find#Claims: the claims the caller reads (their own, a manager's reports' at the line's employers, the employers' of
// PEOPLE_EXPENSE_MANAGE), or with toDecide those whose step waiting they decide now; narrowed by a person, an employer, a state and the days
// dated. Newest first, paged (an export up to 2000).
function findClaims(p) {
    const userScope = expenseScope()
    const caps = userScope.capabilities
    if (!(caps.self || caps.team || caps.expenseManage || caps.requestApprove))
        denied("PERMISSION_DENIED", "Expense claims need PEOPLE_SELF_SERVICE, PEOPLE_TEAM_VIEW or PEOPLE_EXPENSE_MANAGE")
    const toDecide = truthy(p.toDecide)
    const deciding = toDecide || caps.requestApprove ? new Set(toDecideOf(claimKind)) : new Set()
    let query = find(CLAIM)
    if (toDecide) query = query.condition("invoiceId", "in", deciding.size ? Array.from(deciding) : ["_NA_"])
    else {
        const reach = reachCondition(userScope, truthy(p.mine))
        if (!reach) denied("PERMISSION_DENIED", "No expense claim is yours to read")
        query = query.condition(reach)
    }
    if (text(p.partyId)) query = query.condition("partyId", text(p.partyId))
    if (text(p.organizationPartyId)) query = query.condition("organizationPartyId", text(p.organizationPartyId))
    if (text(p.statusEnumId)) query = query.condition("statusEnumId", text(p.statusEnumId))
    if (p.fromDate) query = query.condition("createdDate", "greater-equals", p.fromDate)
    if (p.thruDate) query = query.condition("createdDate", "less", p.thruDate)
    query = query.orderBy(["-createdDate", "invoiceId"])
    const paged = lib.page(query, p, "claims", query.count(), {noLimitCap: exportCap})
    const invoices = Object.fromEntries(
        paged.rows.length
            ? Array.from(
                  find(INVOICE)
                      .condition(
                          "invoiceId",
                          "in",
                          paged.rows.map(row => row.invoiceId)
                      )
                      .list()
              ).map(row => [row.invoiceId, row])
            : []
    )
    const names = people.personNames(unique(paged.rows.map(row => row.partyId)))
    const organizations = people.organizationNames(unique(paged.rows.map(row => row.organizationPartyId)))
    const projects = projectNames(unique(paged.rows.map(row => row.workEffortId).filter(Boolean)))
    const claims = paged.rows.map(claim =>
        claimLine(claim, invoices[claim.invoiceId], names, organizations, projects, deciding.has(claim.invoiceId))
    )
    return Object.assign({}, paged, {claims, rows: undefined})
}
// get#Claim: a claim the caller reads, with its lines (type, description, day, quantity, amount, tax, merchant, receipt, source,
// whether it waits for review), its approval, the finance state and settlement (the invoice's state, total, applied and unpaid,
// each payment applied to it: an advance or a reimbursement, the route and its reservation), the claimant's advances outstanding
// at the employer, and what the caller may do.
function getClaim(p) {
    const userScope = expenseScope()
    const {claim, kinds, summary} = readableClaim(userScope, p.invoiceId)
    const invoice = one(INVOICE, {invoiceId: claim.invoiceId})
    const currencyUomId = invoice?.currencyUomId || null
    const names = people.personNames([claim.partyId])
    const organizations = people.organizationNames([claim.organizationPartyId, claim.departmentPartyId].filter(Boolean))
    const projects = projectNames([claim.workEffortId].filter(Boolean))
    const deciding = !!summary?.canDecide
    const line = claimLine(claim, invoice, names, organizations, projects, deciding)
    const extensions = Object.fromEntries(rows(CLAIM_ITEM, {invoiceId: claim.invoiceId}).map(row => [row.invoiceItemSeqId, row]))
    const types = Object.fromEntries(expenseTypes().map(row => [row.enumId, row.description || row.enumId]))
    const contents = Object.fromEntries(rows(CONTENT, {invoiceId: claim.invoiceId}).map(row => [row.invoiceContentId, row]))
    const lines = Array.from(find(LINE, {invoiceId: claim.invoiceId}).orderBy("invoiceItemSeqId").list()).map(item => {
        const extension = extensions[item.invoiceItemSeqId] || {}
        const receipt = extension.receiptContentId ? contents[extension.receiptContentId] : null
        const quantity = decimalOf(item.quantity ?? 1)
        return {
            invoiceItemSeqId: item.invoiceItemSeqId,
            itemTypeEnumId: item.itemTypeEnumId,
            itemTypeText: types[item.itemTypeEnumId] || item.itemTypeEnumId || "",
            description: item.description || "",
            itemDateText: item.itemDate ? ec.l10n.format(item.itemDate, "yyyy-MM-dd") : "",
            quantity,
            amount: money(item.amount, currencyUomId),
            lineTotal: money(quantity.multiply(decimalOf(item.amount)), currencyUomId),
            lineTotalText: moneyText(quantity.multiply(decimalOf(item.amount)), currencyUomId),
            taxAmount: extension.taxAmount != null ? money(extension.taxAmount, currencyUomId) : null,
            taxText: extension.taxAmount != null ? moneyText(extension.taxAmount, currencyUomId) : "",
            merchantName: extension.merchantName || "",
            receiptContentId: receipt?.invoiceContentId || null,
            receiptName: receipt?.description || "",
            sourceText: sourceTexts[extension.sourceEnumId] || "Entered",
            reviewNeeded: extension.reviewNeeded === "Y"
        }
    })
    // what settled the claim: payments (a reimbursement) and credits applied to it (an advance's, else another credit)
    const applications = Array.from(find(APPLICATION, {invoiceId: claim.invoiceId}).orderBy("appliedDate").list())
        .filter(row => row.paymentId)
        .concat(Array.from(find(APPLICATION, {toInvoiceId: claim.invoiceId}).orderBy("appliedDate").list()))
    const creditIds = applications.filter(row => !row.paymentId && row.invoiceId).map(row => row.invoiceId)
    const advanceByCredit = Object.fromEntries(
        creditIds.length
            ? Array.from(find(ADVANCE_APPLICATION).condition("creditInvoiceId", "in", creditIds).list()).map(row => [
                  row.creditInvoiceId,
                  row.employeeAdvanceId
              ])
            : []
    )
    const payments = applications.map(row => {
        const advanceId = row.paymentId ? null : advanceByCredit[row.invoiceId] || null
        return {
            paymentApplicationId: row.paymentApplicationId,
            paymentId: row.paymentId || null,
            kindText: row.paymentId ? "Reimbursement" : advanceId ? "Advance " + advanceId : "Credit " + row.invoiceId,
            employeeAdvanceId: advanceId,
            amountText: moneyText(row.amountApplied, currencyUomId),
            appliedDateText: row.appliedDate ? ec.l10n.format(row.appliedDate, "yyyy-MM-dd") : ""
        }
    })
    const editable = editableStatuses.includes(claim.statusEnumId) && changes(kinds)
    const advances = rows(ADVANCE, {
        partyId: claim.partyId,
        organizationPartyId: claim.organizationPartyId,
        statusEnumId: "EasApproved"
    })
        .map(advance => Object.assign({employeeAdvanceId: advance.employeeAdvanceId}, advanceMoney(advance)))
        .filter(row => row.outstanding.compare(0) > 0)
        .map(row => ({
            employeeAdvanceId: row.employeeAdvanceId,
            outstandingText: moneyText(row.outstanding, row.currencyUomId)
        }))
    return {
        claim: Object.assign(line, {
            partyRelationshipId: claim.partyRelationshipId,
            departmentName: claim.departmentPartyId ? organizations[claim.departmentPartyId] || "" : "",
            description: invoice?.description || "",
            invoiceDate: invoice?.invoiceDate || null,
            revision: String(ms(claim.lastUpdatedStamp) ?? 0),
            decisionReason: claim.decisionReason || "",
            appliedText: moneyText(invoice?.appliedPaymentsTotal, currencyUomId),
            unpaidText: moneyText(invoice?.unpaidTotal, currencyUomId),
            financeStatusText: financeText(invoice),
            reservedRouteText: routeTexts[claim.reservedRouteEnumId] || "",
            createdByOther: !!claim.createdByUserId && claim.createdByUserId !== ec.user.userId && !kinds.includes("manage")
        }),
        lines,
        approval: summary,
        payments,
        advances,
        access: kinds,
        receiptsMissing: lines.filter(row => !row.receiptContentId).length,
        linesToReview: lines.filter(row => row.reviewNeeded).length,
        canEdit: editable,
        canSubmit: editable && lines.length > 0 && !lines.some(row => row.reviewNeeded),
        canCancel: editable,
        canDecide: deciding,
        canWithdraw: claim.statusEnumId === "EcsSubmitted" && (kinds.includes("self") || claim.createdByUserId === ec.user.userId)
    }
}
function financeText(invoice) {
    const statusId = invoice?.statusId
    if (statusId === "InvoiceIncoming") return "Not sent to finance"
    if (statusId === "InvoiceReceived") return "Received: finance codes and approves it after business approval"
    if (statusId === "InvoiceApproved")
        return decimalOf(invoice.unpaidTotal).isZero() ? "Approved for payment and settled" : "Approved for payment"
    if (statusId === "InvoicePmtSent") return "Paid"
    if (statusId === "InvoiceCancelled") return "Cancelled"
    return statusId || ""
}
// get#ClaimReceipt: a receipt of a claim the caller reads (its location, name and type, for the screen to send).
function getClaimReceipt(p) {
    const userScope = expenseScope()
    const {claim} = readableClaim(userScope, p.invoiceId)
    const content = text(p.invoiceContentId) ? one(CONTENT, {invoiceContentId: text(p.invoiceContentId)}) : null
    if (!content || content.invoiceId !== claim.invoiceId || !content.contentLocation)
        denied("RECORD_UNAVAILABLE", "This receipt is not available")
    const fileName = content.description || "receipt"
    // shown inline only when its name is a photo's, a PDF's or a text file's; anything else (a file kept before this rule) is a
    // download
    return {location: content.contentLocation, fileName, inline: receiptName(fileName)}
}
// get#ClaimEvidence: the receipts of a claim the caller reads, each a path in the bundle and its location (the screen adds the
// claim's printed PDF): one entry a receipt, numbered by its line.
function getClaimEvidence(p) {
    const userScope = expenseScope()
    const {claim} = readableClaim(userScope, p.invoiceId)
    const byContent = Object.fromEntries(
        rows(CLAIM_ITEM, {invoiceId: claim.invoiceId})
            .filter(row => row.receiptContentId)
            .map(row => [row.receiptContentId, row.invoiceItemSeqId])
    )
    const entries = rows(CONTENT, {invoiceId: claim.invoiceId, contentTypeEnumId: "IctReceipt"})
        .filter(row => row.contentLocation)
        .map(row => ({
            path:
                "receipts/" +
                (byContent[row.invoiceContentId] ? "line-" + byContent[row.invoiceContentId] : "claim") +
                "-" +
                row.invoiceContentId +
                "-" +
                (row.description || "receipt"),
            location: row.contentLocation
        }))
    return {invoiceId: claim.invoiceId, entries}
}
// get#ClaimOptions: what the caller's new claim or advance offers: their own current employments (employer, its currency) and the
// projects they work on (self-service), and the expense types (a closed list, for anyone changing a claim).
function claimOptions() {
    const userScope = expenseScope()
    const types = expenseTypes().map(row => ({itemTypeEnumId: row.enumId, description: row.description || row.enumId}))
    if (!userScope.capabilities.self || !userScope.partyId) return {employments: [], expenseTypes: types, projects: []}
    const now = nowMs()
    const own = (userScope.employments || []).filter(row => currentAt(row, now))
    const names = people.organizationNames(unique(own.map(row => row.organizationPartyId)))
    const projectIds = unique(
        Array.from(
            people
                .current(find("mantle.work.effort.WorkEffortParty").condition("partyId", userScope.partyId), null)
                .selectField("workEffortId")
                .limit(200)
                .list()
        ).map(row => row.workEffortId)
    )
    const projects = projectIds.length
        ? Array.from(
              find("mantle.work.effort.WorkEffort")
                  .condition("workEffortId", "in", projectIds)
                  .condition("workEffortTypeEnumId", "WetProject")
                  .orderBy("workEffortName")
                  .limit(50)
                  .list()
          ).map(row => ({workEffortId: row.workEffortId, projectName: row.workEffortName || row.workEffortId}))
        : []
    return {
        employments: own.map(row => ({
            partyRelationshipId: row.partyRelationshipId,
            organizationPartyId: row.organizationPartyId,
            organizationName: names[row.organizationPartyId] || row.organizationPartyId,
            currencyUomId: baseCurrency(row.organizationPartyId)
        })),
        expenseTypes: types,
        projects
    }
}
// an employer's currency: its accounting preference's, else its parent organization's (find#PartyAcctgPreference)
function baseCurrency(organizationPartyId) {
    if (!organizationPartyId) return null
    try {
        return (
            call("mantle.ledger.LedgerServices.find#PartyAcctgPreference", {organizationPartyId}).partyAcctgPreference
                ?.baseCurrencyUomId || null
        )
    } catch (error) {
        ec.logger.warn("No accounting preference for " + organizationPartyId + ": " + error.message)
        return null
    }
}
// get#ClaimOffer: whether the caller has a current employment of their own to claim under (PEOPLE_SELF_SERVICE), the condition of
// the quick create New claim (org.moqui.ui.ShellServices.offer#QuickCreate). It reads only the session's own employments.
function offerClaim() {
    const partyId = ec.user.userAccount?.partyId || null
    if (!partyId || !ec.user.hasPermission("PEOPLE_SELF_SERVICE")) return {offer: false}
    const now = nowMs()
    return {
        offer: Array.from(people.current(people.employmentFind().condition("fromPartyId", partyId), null).limit(20).list()).some(
            row => currentAt(row, now)
        )
    }
}

// ===== the settlement route =====
// Finance's approval of a claim's invoice (InvoiceWorkflow.js issue, approve#Payable and BillDetail's approval): refused before
// the claim's business approval (CLAIM_NOT_APPROVED) and for a claim reserved for payroll (CLAIM_RESERVED); otherwise it reserves
// the claim for accounts payable. An invoice that is no claim passes.
function financeApproval(invoiceId) {
    const claim = invoiceId ? one(CLAIM, {invoiceId}) : null
    if (!claim) return
    if (claim.statusEnumId !== "EcsApproved")
        denied("CLAIM_NOT_APPROVED", "This expense claim waits for its business approval in People")
    if (claim.reservedRouteEnumId === "EcrPayroll" || claim.routeEnumId === "EcrPayroll")
        denied("CLAIM_RESERVED", "This expense claim is reserved for payroll")
    if (!claim.reservedRouteEnumId) reserve(claim, "EcrPayable", "Accounts payable")
}
function reserve(claim, routeEnumId, reference) {
    call("update#" + CLAIM, {
        invoiceId: claim.invoiceId,
        routeEnumId,
        reservedRouteEnumId: routeEnumId,
        reservedReference: reference || null,
        reservedDate: ec.user.nowTimestamp,
        reservedByUserId: ec.user.userId || null
    })
}
// reserve#ClaimSettlement: an approved claim taken by a settlement route, or released by it: payroll (a payroll editor of the
// employer, PAYROLL_VIEW and PAYROLL_EDIT; a pay run names itself as reference, P27) or accounts payable (INVOICE_APPROVE in the
// organization, as finance's approval does). A claim reserved for the other route is refused (CLAIM_RESERVED); one not
// business-approved too (CLAIM_NOT_APPROVED). Taken again by its own route it answers as it is (repeated). A release frees a
// reservation of the same route while the invoice is not approved for payment (CLAIM_SETTLED otherwise).
function reserveClaimSettlement(p) {
    const routeEnumId = text(p.routeEnumId)
    if (!routeTexts[routeEnumId]) denied("ROUTE_INVALID", "Choose payroll or accounts payable")
    const known = text(p.invoiceId) ? one(CLAIM, {invoiceId: text(p.invoiceId)}) : null
    if (!known) denied("RECORD_UNAVAILABLE", "Expense claim " + text(p.invoiceId) + " is not available")
    if (routeEnumId === "EcrPayroll") {
        // payroll's own route (P27): a payroll editor of the employer, not a reader of every claim
        const userScope = people.scopeOf()
        const caps = userScope.capabilities
        if (!(caps.payrollView && userScope.organizationPartyIds.includes(known.organizationPartyId)))
            denied("RECORD_UNAVAILABLE", "Expense claim " + known.invoiceId + " is not available")
        if (!caps.payrollEdit) denied("PERMISSION_DENIED", "A payroll editor reserves a claim for payroll")
    } else invoiceLib().organization(known.organizationPartyId, "INVOICE_APPROVE")
    const claim = lockClaim(known.invoiceId)
    const invoice = one(INVOICE, {invoiceId: claim.invoiceId})
    if (truthy(p.release)) {
        if (claim.reservedRouteEnumId !== routeEnumId)
            denied("CLAIM_RESERVED", "This claim is not reserved for " + routeTexts[routeEnumId].toLowerCase())
        if (!["InvoiceIncoming", "InvoiceReceived"].includes(invoice.statusId))
            denied("CLAIM_SETTLED", "This claim is approved for payment; it is reallocated through its owner's reversal")
        call("update#" + CLAIM, {
            invoiceId: claim.invoiceId,
            reservedRouteEnumId: null,
            reservedReference: null,
            reservedDate: null,
            reservedByUserId: null,
            routeEnumId: "EcrPayable"
        })
        return reservationAnswer(one(CLAIM, {invoiceId: claim.invoiceId}), false)
    }
    if (claim.statusEnumId !== "EcsApproved") denied("CLAIM_NOT_APPROVED", "The claim waits for its business approval")
    if (claim.reservedRouteEnumId === routeEnumId) return reservationAnswer(claim, true)
    if (claim.reservedRouteEnumId || (routeEnumId === "EcrPayroll" && invoice.statusId !== "InvoiceReceived"))
        denied(
            "CLAIM_RESERVED",
            "This claim is reserved for " + (routeTexts[claim.reservedRouteEnumId] || "accounts payable").toLowerCase()
        )
    reserve(claim, routeEnumId, text(p.reference) || null)
    return reservationAnswer(one(CLAIM, {invoiceId: claim.invoiceId}), false)
}
const reservationAnswer = (claim, repeated) => ({
    invoiceId: claim.invoiceId,
    reservedRouteEnumId: claim.reservedRouteEnumId || null,
    reservedReference: claim.reservedReference || null,
    repeated
})

// ===== advances =====
// What an advance's bill was paid by delivered (or confirmed) payments (nothing before, or once a payment is returned or voided),
// what its credits applied to the employee's claims, and what is outstanding: delivered less applied.
const deliveredStatuses = ["PmntDelivered", "PmntConfirmed"]
function advanceMoney(advance) {
    const currencyUomId = advance.currencyUomId || null
    const bill = advance.invoiceId ? one(INVOICE, {invoiceId: advance.invoiceId}) : null
    const paid = bill ? rows(APPLICATION, {invoiceId: bill.invoiceId}).filter(row => row.paymentId) : []
    const statuses = Object.fromEntries(
        paid.length
            ? Array.from(
                  find(PAYMENT)
                      .condition("paymentId", "in", unique(paid.map(row => row.paymentId)))
                      .selectField(["paymentId", "statusId"])
                      .list()
              ).map(row => [row.paymentId, row.statusId])
            : []
    )
    const delivered = sum(paid.filter(row => deliveredStatuses.includes(statuses[row.paymentId])).map(row => row.amountApplied))
    const recoveries = rows(ADVANCE_APPLICATION, {employeeAdvanceId: advance.employeeAdvanceId})
    const credited = recoveries.length
        ? Array.from(
              find(APPLICATION)
                  .condition(
                      "invoiceId",
                      "in",
                      recoveries.map(row => row.creditInvoiceId)
                  )
                  .condition("toInvoiceId", "is-not-null", null)
                  .list()
          )
        : []
    const applied = sum(credited.map(row => row.amountApplied))
    const left = delivered.subtract(applied)
    const outstanding = left.compare(0) > 0 ? money(left, currencyUomId) : zero()
    return {
        currencyUomId,
        bill,
        delivered: money(delivered, currencyUomId),
        applied: money(applied, currencyUomId),
        outstanding,
        appliedInvoiceIds: unique(credited.filter(row => decimalOf(row.amountApplied).compare(0) > 0).map(row => row.toInvoiceId))
    }
}
function advanceLine(advance, names, organizations, deciding, callerPartyId = null) {
    const amounts = advanceMoney(advance)
    const currencyUomId = advance.currencyUomId || null
    let stage = advance.statusEnumId
    let stageText = advanceStatusTexts[advance.statusEnumId] || advance.statusEnumId
    if (advance.statusEnumId === "EasApproved") {
        if (amounts.delivered.isZero()) {
            // the bill with finance, approved for payment (a payment run pays it), or paid by a payment not yet delivered
            const billStatus = amounts.bill?.statusId
            stage = "toPay"
            stageText =
                billStatus === "InvoiceApproved" || billStatus === "InvoicePmtSent"
                    ? "Approved for payment"
                    : billStatus === "InvoiceCancelled"
                      ? "Approved: its bill cancelled"
                      : "Approved: with finance"
        } else if (amounts.outstanding.compare(0) > 0) {
            stage = "outstanding"
            stageText = "Paid: outstanding"
        } else {
            stage = "settled"
            stageText = "Settled"
        }
    }
    return {
        employeeAdvanceId: advance.employeeAdvanceId,
        partyId: advance.partyId,
        personName: names[advance.partyId] || advance.partyId,
        organizationPartyId: advance.organizationPartyId,
        organizationName: organizations[advance.organizationPartyId] || advance.organizationPartyId,
        purpose: advance.purpose || "",
        currencyUomId,
        amount: money(advance.amount, currencyUomId),
        amountText: moneyText(advance.amount, currencyUomId),
        deliveredText: moneyText(amounts.delivered, currencyUomId),
        appliedText: moneyText(amounts.applied, currencyUomId),
        outstanding: amounts.outstanding,
        outstandingText: moneyText(amounts.outstanding, currencyUomId),
        invoiceId: advance.invoiceId || null,
        appliedInvoiceIds: amounts.appliedInvoiceIds,
        requiredDateText: advance.requiredDate ? lib.calendarDateText(advance.requiredDate) : "",
        expectedSettlementDateText: advance.expectedSettlementDate ? lib.calendarDateText(advance.expectedSettlementDate) : "",
        requestedDateText: dateText(advance.requestedDate),
        statusEnumId: advance.statusEnumId,
        statusText: advanceStatusTexts[advance.statusEnumId] || advance.statusEnumId,
        stage,
        stageText,
        decisionReason: advance.decisionReason || "",
        toDecide: !!deciding,
        canWithdraw:
            advance.statusEnumId === "EasRequested" &&
            ((!!callerPartyId && advance.partyId === callerPartyId) || advance.requestedByUserId === ec.user.userId)
    }
}
// The claims of an employee at an employer that an advance can be applied to: approved for payment with something unpaid.
function applicableClaims(partyId, organizationPartyId) {
    const claimIds = Array.from(
        find(CLAIM, {partyId, organizationPartyId, statusEnumId: "EcsApproved"}).selectField("invoiceId").limit(50).list()
    ).map(row => row.invoiceId)
    if (!claimIds.length) return []
    return Array.from(
        find(INVOICE)
            .condition("invoiceId", "in", claimIds)
            .condition("statusId", "InvoiceApproved")
            .condition("unpaidTotal", "greater", 0)
            .list()
    ).map(row => ({
        invoiceId: row.invoiceId,
        label: row.invoiceId + " · " + moneyText(row.unpaidTotal, row.currencyUomId) + " unpaid"
    }))
}
// the employment an advance is asked under: the caller's own current one (the one named, else their only one), or one an HR
// editor of its employer names
function advanceEmployment(userScope, partyRelationshipId) {
    const now = nowMs()
    if (text(partyRelationshipId)) {
        const employment = employmentRow(text(partyRelationshipId))
        // another person's advance is asked under PEOPLE_EXPENSE_MANAGE: refused for the permission before anything of theirs is told
        const own = !!employment && !!userScope.partyId && employment.fromPartyId === userScope.partyId
        if (!own && !userScope.capabilities.expenseManage)
            denied("PERMISSION_DENIED", "You ask advances for yourself; HR asks them for an employee")
        const kinds = employment ? accessKinds(userScope, employment.fromPartyId, employment.toPartyId) : []
        if (!employment || !changes(kinds))
            denied("RECORD_UNAVAILABLE", "Employment " + text(partyRelationshipId) + " is not available")
        if (!currentAt(employment, now)) denied("NOT_EMPLOYED", "The employment is not current")
        return employment
    }
    if (!userScope.capabilities.self || !userScope.partyId) denied("PERMISSION_DENIED", "Advances need PEOPLE_SELF_SERVICE")
    const own = (userScope.employments || []).filter(row => currentAt(row, now))
    if (!own.length) denied("NOT_EMPLOYED", "You have no current employment")
    if (own.length > 1) denied("EMPLOYMENT_REQUIRED", "Choose the employer the advance is from")
    return employmentRow(own[0].partyRelationshipId)
}
// request#Advance: an advance asked by the employee for their own employment, or by HR for an employee: the purpose, the amount
// (positive, in the employer's currency unless another is named) and when it is needed and should be settled; sent for a People
// approval of kind PakAdvance. A retry with the same operation key answers the first.
function requestAdvance(p) {
    const userScope = expenseScope()
    const operationKey = text(p.operationKey) || null
    const firstOf = () =>
        operationKey ? first(find(ADVANCE).condition({operationKey, requestedByUserId: ec.user.userId})) : null
    const earlier = firstOf()
    if (earlier) return Object.assign(advanceAnswer(earlier), {repeated: true})
    const employment = advanceEmployment(userScope, p.partyRelationshipId)
    const purpose = text(p.purpose)
    if (!purpose) denied("PURPOSE_REQUIRED", "Say what the advance is for")
    const currencyUomId = text(p.currencyUomId) || baseCurrency(employment.toPartyId)
    if (!currencyUomId) denied("CURRENCY_REQUIRED", "Choose the currency")
    const amount = lib.amount(p.amount, currencyUomId)
    if (p.requiredDate && p.expectedSettlementDate && ms(p.expectedSettlementDate) < ms(p.requiredDate))
        denied("DATES_INVALID", "The advance is settled after it is needed")
    const created = call("create#" + ADVANCE, {
        partyRelationshipId: employment.partyRelationshipId,
        partyId: employment.fromPartyId,
        organizationPartyId: employment.toPartyId,
        departmentPartyId: departmentAt(employment.partyRelationshipId, nowMs()),
        purpose,
        currencyUomId,
        amount,
        requiredDate: p.requiredDate || null,
        expectedSettlementDate: p.expectedSettlementDate || null,
        statusEnumId: "EasRequested",
        requestedByUserId: ec.user.userId || null,
        requestedDate: ec.user.nowTimestamp,
        operationKey
    })
    const advance = one(ADVANCE, {employeeAdvanceId: created.employeeAdvanceId})
    approvals().request({
        approvalKindEnumId: advanceKind,
        sourceId: advance.employeeAdvanceId,
        organizationPartyId: advance.organizationPartyId,
        departmentPartyId: advance.departmentPartyId || null,
        subjectPartyId: advance.partyId,
        effectiveDate: ec.user.nowTimestamp,
        justification: purpose
    })
    return Object.assign(advanceAnswer(advance), {repeated: false})
}
const advanceAnswer = advance => ({
    employeeAdvanceId: advance.employeeAdvanceId,
    statusEnumId: advance.statusEnumId,
    statusText: advanceStatusTexts[advance.statusEnumId] || advance.statusEnumId
})
// decide#Advance: approve or refuse (with a reason) the step waiting, through record#Decision at the advance's revision; the last
// approval makes it payable by finance (approval to advance is not payment). withdraw: the person or who asked, while it waits.
function decideAdvance(p) {
    const userScope = expenseScope()
    const action = text(p.decision) || "approve"
    if (!["approve", "refuse", "withdraw"].includes(action)) denied("DECISION_INVALID", "Approve, refuse or withdraw")
    const known = text(p.employeeAdvanceId) ? one(ADVANCE, {employeeAdvanceId: text(p.employeeAdvanceId)}) : null
    if (!known) denied("RECORD_UNAVAILABLE", "Advance " + text(p.employeeAdvanceId) + " is not available")
    const advance = lockAdvance(known.employeeAdvanceId)
    const {kinds} = recordAccess(userScope, advance, advanceKind, ADVANCE, advance.employeeAdvanceId)
    if (!kinds.length) denied("RECORD_UNAVAILABLE", "Advance " + advance.employeeAdvanceId + " is not available")
    if (action === "withdraw") {
        if (!kinds.includes("self") && advance.requestedByUserId !== ec.user.userId)
            denied("NOT_YOURS", "The person or who asked withdraws an advance")
        if (advance.statusEnumId !== "EasRequested") denied("NOT_PENDING", "Only an advance waiting for approval is withdrawn")
        call("update#" + ADVANCE, {
            employeeAdvanceId: advance.employeeAdvanceId,
            statusEnumId: "EasWithdrawn",
            decidedDate: ec.user.nowTimestamp
        })
        approvals().sourceChanged(advanceKind, advance.employeeAdvanceId)
        return Object.assign(advanceAnswer(one(ADVANCE, {employeeAdvanceId: advance.employeeAdvanceId})), {repeated: false})
    }
    const asked = advance.statusEnumId
    const reason = text(p.reason) || null
    const decided = call("mantle.humanres.PeopleApprovalServices.record#Decision", {
        approvalKindEnumId: advanceKind,
        peopleApprovalId: text(p.peopleApprovalId) || null,
        sourceId: advance.employeeAdvanceId,
        decision: action,
        reason,
        sourceRevision: text(p.sourceRevision) || null,
        operationKey: text(p.operationKey) || null
    })
    if (decided.repeated)
        return Object.assign(advanceAnswer(one(ADVANCE, {employeeAdvanceId: advance.employeeAdvanceId})), {repeated: true})
    if (asked !== "EasRequested") denied("NOT_PENDING", "This advance is " + (advanceStatusTexts[asked] || asked).toLowerCase())
    if (decided.complete || decided.statusId === "PapRefused")
        call("update#" + ADVANCE, {
            employeeAdvanceId: advance.employeeAdvanceId,
            statusEnumId: decided.complete ? "EasApproved" : "EasRefused",
            decidedDate: ec.user.nowTimestamp,
            decisionReason: decided.complete ? null : reason
        })
    if (decided.complete && !advance.invoiceId) advanceBill(one(ADVANCE, {employeeAdvanceId: advance.employeeAdvanceId}))
    return Object.assign(advanceAnswer(one(ADVANCE, {employeeAdvanceId: advance.employeeAdvanceId})), {repeated: false})
}
function decideAdvanceNotice(p, decision) {
    const message = p.message || {}
    if (p.recordEntityName && p.recordEntityName !== ADVANCE) denied("SOURCE_INVALID", "Not an advance approval")
    return decideAdvance({
        employeeAdvanceId: p.recordId,
        peopleApprovalId: message.peopleApprovalId,
        sourceRevision: message.sourceRevision,
        decision,
        reason: p.reason
    })
}
// Finance's reach on an organization's advances: a finance reader (ACCOUNTING_VIEW, ACCOUNTING_ADMIN or PAYABLE_VIEW) of an
// organization the user works in (InvoiceWorkflowLib's check), else refused.
function financeOrganization(organizationPartyId, permission) {
    const has = permission => ec.user.hasPermission(permission)
    if (!permission && !has("ACCOUNTING_VIEW") && !has("ACCOUNTING_ADMIN") && !has("PAYABLE_VIEW"))
        denied("PERMISSION_DENIED", "Advances in finance need payables read authority")
    return invoiceLib().organization(organizationPartyId, permission || null)
}
// find#Advances: the advances the caller reads (their own, a manager's reports', the employers' of PEOPLE_EXPENSE_MANAGE), or with
// toDecide those they decide now; or, with finance and an organization, the organization's approved advances for finance to pay
// and apply (a finance reader of it). Each with what was asked, delivered, applied and is outstanding. Newest first, paged.
function findAdvances(p) {
    let query = find(ADVANCE)
    const finance = truthy(p.finance)
    let deciding = new Set()
    if (finance) {
        const organizationPartyId = financeOrganization(text(p.organizationPartyId) || null, null)
        query = query.condition({organizationPartyId, statusEnumId: "EasApproved"})
    } else {
        const userScope = expenseScope()
        const caps = userScope.capabilities
        if (!(caps.self || caps.team || caps.expenseManage || caps.requestApprove))
            denied("PERMISSION_DENIED", "Advances need PEOPLE_SELF_SERVICE, PEOPLE_TEAM_VIEW or PEOPLE_EXPENSE_MANAGE")
        const toDecide = truthy(p.toDecide)
        deciding = toDecide || caps.requestApprove ? new Set(toDecideOf(advanceKind)) : new Set()
        if (toDecide) query = query.condition("employeeAdvanceId", "in", deciding.size ? Array.from(deciding) : ["_NA_"])
        else {
            const reach = reachCondition(userScope, truthy(p.mine))
            if (!reach) denied("PERMISSION_DENIED", "No advance is yours to read")
            query = query.condition(reach)
        }
        if (text(p.organizationPartyId)) query = query.condition("organizationPartyId", text(p.organizationPartyId))
        if (text(p.statusEnumId)) query = query.condition("statusEnumId", text(p.statusEnumId))
    }
    if (text(p.partyId)) query = query.condition("partyId", text(p.partyId))
    query = query.orderBy(["-requestedDate", "employeeAdvanceId"])
    const paged = lib.page(query, p, "advances", query.count(), {noLimitCap: exportCap})
    const names = people.personNames(unique(paged.rows.map(row => row.partyId)))
    const organizations = people.organizationNames(unique(paged.rows.map(row => row.organizationPartyId)))
    const callerPartyId = ec.user.userAccount?.partyId || null
    const advances = paged.rows.map(advance => {
        const line = advanceLine(advance, names, organizations, deciding.has(advance.employeeAdvanceId), callerPartyId)
        // finance: the employee's claims the advance can be applied to
        if (finance)
            line.applicableClaims =
                line.stage === "outstanding" ? applicableClaims(advance.partyId, advance.organizationPartyId) : []
        return line
    })
    return Object.assign({}, paged, {advances, rows: undefined})
}
// An approved advance made a payable (the user's call, impl-people §4, Nov 12, 2026): a bill from the employee to the employer
// of one ItemAdvancePay line (posted to the employee advances account), due when the advance is needed, received for finance's
// approval in Accounting (Expense posting lists a person's bills); a payment run pays it once approved, as any other bill.
function advanceBill(advance) {
    const description = "Employee advance " + advance.employeeAdvanceId + (advance.purpose ? ": " + advance.purpose : "")
    const created = call("mantle.account.InvoiceServices.create#Invoice", {
        fromPartyId: advance.partyId,
        toPartyId: advance.organizationPartyId,
        invoiceTypeEnumId: "InvoiceSales",
        invoiceDate: ec.user.nowTimestamp,
        currencyUomId: advance.currencyUomId || null,
        description: description.substring(0, 255)
    })
    call("create#" + LINE, {
        invoiceId: created.invoiceId,
        invoiceItemSeqId: "01",
        itemTypeEnumId: "ItemAdvancePay",
        description: description.substring(0, 255),
        quantity: 1,
        amount: advance.amount
    })
    const dueDate = advance.requiredDate
        ? ec.l10n.parseTimestamp(lib.calendarDateText(advance.requiredDate) + " 00:00:00", "yyyy-MM-dd HH:mm:ss")
        : null
    call(
        "update#" + INVOICE,
        Object.assign({invoiceId: created.invoiceId, statusId: "InvoiceReceived"}, dueDate ? {dueDate} : {})
    )
    call("update#" + ADVANCE, {employeeAdvanceId: advance.employeeAdvanceId, invoiceId: created.invoiceId})
    return created.invoiceId
}
// apply#Advance: finance applies a paid advance to the employee's claim at the same employer (PAYMENT_EDIT in the organization):
// the claim's invoice approved for payment (CLAIM_NOT_FINANCE_APPROVED otherwise), at most what is outstanding of the advance and
// unpaid of the claim (the amount given, else the lesser). The employer issues a credit against the claim on the employee
// advances account (create#InvoiceCreditMemo, ItemAdvancePay on the account the advance's bill posted to), finalized at once as
// a payment run's discount credit is, and applies it to the claim (apply#InvoiceToInvoice): the claim's payable settled from the
// advance, with no cash moved.
function applyAdvance(p) {
    const known = text(p.employeeAdvanceId) ? one(ADVANCE, {employeeAdvanceId: text(p.employeeAdvanceId)}) : null
    if (!known) denied("RECORD_UNAVAILABLE", "Advance " + text(p.employeeAdvanceId) + " is not available")
    financeOrganization(known.organizationPartyId, "PAYMENT_EDIT")
    const advance = lockAdvance(known.employeeAdvanceId)
    const claim = text(p.invoiceId) ? one(CLAIM, {invoiceId: text(p.invoiceId)}) : null
    if (!claim || claim.partyId !== advance.partyId || claim.organizationPartyId !== advance.organizationPartyId)
        denied("CLAIM_INVALID", "Choose a claim of the same employee and employer")
    const invoice = find(INVOICE, {invoiceId: claim.invoiceId}).forUpdate(true).one()
    if (!["InvoiceApproved", "InvoicePmtSent"].includes(invoice.statusId))
        denied("CLAIM_NOT_FINANCE_APPROVED", "Apply an advance to a claim approved for payment")
    if (invoice.currencyUomId && advance.currencyUomId && invoice.currencyUomId !== advance.currencyUomId)
        denied("CURRENCY_MISMATCH", "The advance and the claim are in different currencies")
    const amounts = advanceMoney(advance)
    if (amounts.outstanding.compare(0) <= 0) denied("NOTHING_OUTSTANDING", "Nothing of this advance is outstanding")
    const unpaid = decimalOf(invoice.unpaidTotal)
    if (unpaid.compare(0) <= 0) denied("CLAIM_SETTLED", "This claim has nothing unpaid")
    let amount = amounts.outstanding.compare(unpaid) < 0 ? amounts.outstanding : unpaid
    if (p.amount != null && p.amount !== "") {
        const asked = lib.amount(p.amount, advance.currencyUomId)
        if (asked.compare(amount) > 0) denied("AMOUNT_EXCEEDS", "At most " + moneyText(amount, advance.currencyUomId))
        amount = asked
    }
    const glAccountId = call("mantle.ledger.InvoiceAutoPostServices.get#InvoiceItemGlAccount", {
        organizationPartyId: advance.organizationPartyId,
        otherPartyId: advance.partyId,
        itemTypeEnumId: "ItemAdvancePay",
        direction: "I"
    }).glAccountId
    if (!glAccountId) denied("ADVANCE_ACCOUNT_MISSING", "The employer has no employee advances account (ItemAdvancePay)")
    const description = "Employee advance " + advance.employeeAdvanceId + " applied to claim " + claim.invoiceId
    const credit = call("mantle.account.InvoiceServices.create#InvoiceCreditMemo", {
        originalInvoiceId: claim.invoiceId,
        invoiceDate: ec.user.nowTimestamp,
        amount,
        itemTypeEnumId: "ItemAdvancePay",
        overrideGlAccountId: glAccountId,
        description
    })
    call("update#" + INVOICE, {
        invoiceId: credit.invoiceId,
        creditForInvoiceId: claim.invoiceId,
        description,
        financeOrganizationPartyId: advance.organizationPartyId,
        financeDirection: "payable",
        statusId: "InvoiceFinalized",
        statusId_changeReason: description
    })
    call("create#" + ADVANCE_APPLICATION, {
        employeeAdvanceId: advance.employeeAdvanceId,
        creditInvoiceId: credit.invoiceId,
        invoiceId: claim.invoiceId,
        appliedDate: ec.user.nowTimestamp,
        appliedByUserId: ec.user.userId || null
    })
    const applied = call("mantle.account.PaymentServices.apply#InvoiceToInvoice", {
        invoiceId: credit.invoiceId,
        toInvoiceId: claim.invoiceId,
        amount,
        appliedDate: ec.user.nowTimestamp
    })
    const after = advanceMoney(one(ADVANCE, {employeeAdvanceId: advance.employeeAdvanceId}))
    return {
        employeeAdvanceId: advance.employeeAdvanceId,
        invoiceId: claim.invoiceId,
        creditInvoiceId: credit.invoiceId,
        paymentApplicationId: applied.paymentApplicationId || null,
        amountApplied: applied.amountApplied ?? zero(),
        outstanding: after.outstanding
    }
}

// ===== payment runs =====
// The invoices of a list that are expense claims reserved for payroll (or routed to it): a payment run neither selects nor pays
// them (PaymentRuns.js), as P27's pay run settles them.
function payrollReserved(invoiceIds) {
    const ids = unique(Array.from(invoiceIds || []).filter(Boolean))
    if (!ids.length) return []
    return Array.from(find(CLAIM).condition("invoiceId", "in", ids).list())
        .filter(claim => claim.reservedRouteEnumId === "EcrPayroll" || claim.routeEnumId === "EcrPayroll")
        .map(claim => claim.invoiceId)
}

// ===== mail and chat intake =====
const emailPerson = address => {
    const key = text(address).toLowerCase()
    if (!key.includes("@")) return []
    const mechs = Array.from(
        find("mantle.party.contact.ContactMech")
            .condition(ec.entity.conditionFactory.makeCondition("infoString", "equals", key, false, true))
            .condition("contactMechTypeEnumId", "CmtEmailAddress")
            .selectField("contactMechId")
            .limit(20)
            .list()
    ).map(row => row.contactMechId)
    if (!mechs.length) return []
    return unique(
        Array.from(
            people
                .current(
                    find("mantle.party.contact.PartyContactMech")
                        .condition("contactMechId", "in", mechs)
                        .condition("contactMechPurposeId", "EmailWork"),
                    null
                )
                .list()
        ).map(row => row.partyId)
    )
}
// The claimant's open draft with the employer (newest), else a new draft made by the intake (no user acts).
function draftFor(employment, purpose) {
    const draft = first(
        find(CLAIM)
            .condition({partyId: employment.fromPartyId, organizationPartyId: employment.toPartyId, statusEnumId: "EcsDraft"})
            .orderBy("-createdDate")
    )
    if (draft) return draft.invoiceId
    const created = call("mantle.account.InvoiceServices.create#Invoice", {
        fromPartyId: employment.fromPartyId,
        toPartyId: employment.toPartyId,
        invoiceTypeEnumId: "InvoiceSales",
        invoiceDate: ec.user.nowTimestamp,
        description: purpose
    })
    writeClaim(created.invoiceId, employment, {purpose})
    return created.invoiceId
}
// A draft line to review on the claim, with its receipts (the first the line's, the rest the claim's), keyed by its source so a
// message makes one line once.
function intakeLine(invoiceId, values) {
    const seqId = nextSeqId(invoiceId)
    call("create#" + LINE, {
        invoiceId,
        invoiceItemSeqId: seqId,
        itemTypeEnumId: "ItemExpense",
        description: values.description.substring(0, 255) || "Receipt",
        itemDate: values.itemDate || ec.user.nowTimestamp,
        quantity: 1,
        amount: 0
    })
    const receiptIds = []
    for (const receipt of values.receipts)
        try {
            receiptIds.push(keepReceipt(invoiceId, receipt))
        } catch (error) {
            ec.logger.error(
                "Expense intake " + values.sourceKey + ": receipt " + receipt.fileName + " not kept: " + error.message
            )
        }
    call("create#" + CLAIM_ITEM, {
        invoiceId,
        invoiceItemSeqId: seqId,
        receiptContentId: receiptIds[0] || null,
        sourceEnumId: values.sourceEnumId,
        sourceKey: values.sourceKey,
        reviewNeeded: "Y"
    })
    touch(invoiceId)
    return seqId
}
// create#ClaimLineFromEmail, the mail rule action createExpenseLine (F65; run#EmailRules calls it with authorization off): the
// claimant is the person whose current work address (EmailWork) sent the message and who is employed now (the rule's value names
// the employer when they have several); the message's files (else its text) become the receipts of one draft line on their open
// draft claim with that employer, or a new draft. Never submitted by mail: a forged sender adds a draft line at most. A message
// makes one line once (answers it again); a sender who is no one's work address, or not employed, adds nothing (logged).
function claimLineFromEmail(p) {
    const emailMessageId = text(p.emailMessageId)
    const sourceKey = "mail:" + emailMessageId
    const known = first(find(CLAIM_ITEM, {sourceKey}))
    if (known) return {invoiceId: known.invoiceId, invoiceItemSeqId: known.invoiceItemSeqId, created: false}
    const message = one("moqui.basic.email.EmailMessage", {emailMessageId})
    if (!message) {
        ec.logger.warn("Expense intake: email message " + emailMessageId + " not found")
        return {created: false}
    }
    const senders = emailPerson(String(message.fromAddress || "").replace(/^.*<([^>]+)>.*$/, "$1"))
    if (senders.length !== 1) {
        ec.logger.warn(
            "Expense intake: email " +
                emailMessageId +
                " is from " +
                (senders.length ? "several people's" : "no one's") +
                " work address"
        )
        return {created: false}
    }
    const now = nowMs()
    const employments = Array.from(
        people.current(people.employmentFind().condition("fromPartyId", senders[0]), null).limit(20).list()
    ).filter(row => currentAt(row, now) && (!text(p.value) || row.toPartyId === text(p.value)))
    if (employments.length !== 1) {
        ec.logger.warn(
            "Expense intake: the sender of email " + emailMessageId + " has " + employments.length + " current employments"
        )
        return {created: false}
    }
    const employment = employmentRow(employments[0].partyRelationshipId)
    const invoiceId = draftFor(employment, "Expenses by mail")
    const attachments = rows("moqui.basic.email.EmailMessageAttachment", {emailMessageId}).filter(row => {
        if (!row.attachmentLocation || row.isInline === "Y") return false
        if (receiptName(row.fileName)) return true
        ec.logger.warn(
            "Expense intake: email " + emailMessageId + " attachment " + row.fileName + " is no receipt file, left out"
        )
        return false
    })
    const receipts = attachments.length
        ? attachments.map(row => ({location: row.attachmentLocation, fileName: row.fileName || "receipt"}))
        : [{text: [message.subject, message.body].filter(Boolean).join("\n\n"), fileName: "message.txt"}]
    const seqId = intakeLine(invoiceId, {
        description: text(message.subject) || "Receipt by mail",
        itemDate: message.sentDate || message.receivedDate || null,
        receipts,
        sourceEnumId: "ElsMail",
        sourceKey
    })
    return {invoiceId, invoiceItemSeqId: seqId, created: true}
}
// create#ClaimLineFromChat (the "Add to my claim" create-from): a chat message of the caller's own (they read the room; not of an
// encrypted room) becomes a draft line on their open draft claim, its files the receipts; for the caller's one current employment
// (PEOPLE_SELF_SERVICE). An event makes one line once.
function claimLineFromChat(p) {
    const userScope = expenseScope()
    if (!userScope.capabilities.self || !userScope.partyId) denied("PERMISSION_DENIED", "Expense claims need PEOPLE_SELF_SERVICE")
    const chatRoomId = text(p.chatRoomId)
    const eventSeq = Number(p.eventSeq)
    const access = lib.probe("org.moqui.chat.ChatServices.get#RoomAccess", {chatRoomId})
    if (!access?.canRead) denied("RECORD_UNAVAILABLE", "Message " + eventSeq + " is not available")
    if (one("moqui.chat.ChatRoom", {chatRoomId})?.encrypted === "Y")
        denied("ROOM_ENCRYPTED", "A message of an end-to-end encrypted room is not read on the server")
    const event = one("moqui.chat.ChatEvent", {chatRoomId, eventSeq})
    if (!event || event.eventTypeEnumId !== "CetMessage" || event.redactedDate)
        denied("RECORD_UNAVAILABLE", "Message " + eventSeq + " is not available")
    if (event.senderUserId !== ec.user.userId) denied("NOT_YOURS", "Add a receipt you sent to your claim")
    const sourceKey = "chat:" + chatRoomId + ":" + eventSeq
    const known = first(find(CLAIM_ITEM, {sourceKey}))
    if (known) return {invoiceId: known.invoiceId, invoiceItemSeqId: known.invoiceItemSeqId, created: false}
    const now = nowMs()
    const own = (userScope.employments || []).filter(row => currentAt(row, now))
    if (!own.length) denied("NOT_EMPLOYED", "You have no current employment")
    if (own.length > 1) denied("EMPLOYMENT_REQUIRED", "You work for several employers: add the line on your claim")
    const employment = employmentRow(own[0].partyRelationshipId)
    const attachments = rows("moqui.chat.ChatAttachment", {chatRoomId, eventSeq}).filter(
        row => row.location && receiptName(row.fileName)
    )
    const invoiceId = draftFor(employment, "Expenses")
    const receipts = attachments.length
        ? attachments.map(row => ({location: row.location, fileName: row.fileName || "receipt"}))
        : [{text: event.bodyText || "", fileName: "message.txt"}]
    const seqId = intakeLine(invoiceId, {
        description: text(event.bodyText).split("\n")[0] || "Receipt from chat",
        itemDate: event.sentDate || null,
        receipts,
        sourceEnumId: "ElsChat",
        sourceKey
    })
    return {invoiceId, invoiceItemSeqId: seqId, created: true}
}

const operations = {
    createClaim,
    storeClaim,
    storeClaimItem,
    readReceipt,
    submitClaim,
    decideClaim,
    approveClaimNotice: p => decideClaimNotice(p, "approve"),
    refuseClaimNotice: p => decideClaimNotice(p, "refuse"),
    findClaims,
    getClaim,
    getClaimReceipt,
    getClaimEvidence,
    claimOptions,
    offerClaim,
    reserveClaimSettlement,
    requestAdvance,
    decideAdvance,
    approveAdvanceNotice: p => decideAdvanceNotice(p, "approve"),
    refuseAdvanceNotice: p => decideAdvanceNotice(p, "refuse"),
    findAdvances,
    applyAdvance,
    claimLineFromEmail,
    claimLineFromChat
}
function run(op, p) {
    if (!Object.hasOwn(operations, op)) throw new Error("Unknown expense operation " + op)
    return operations[op](p || {})
}
;({execute: run, financeApproval, payrollReserved})
