// Payment-specific trade settlement scope and narrow balance projections. No bank or gateway data leaves these reads.
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const {find, one, rows, call, denied, has} = lib
const I = "mantle.account.invoice.Invoice",
    P = "mantle.account.payment.Payment",
    A = "mantle.account.payment.PaymentApplication"
const kinds = ["invoice", "credit", "payment", "paymentTarget"]
function context(p, write = false, lock = false, requireParty = true) {
    const direction = p.direction || "receivable"
    if (!["receivable", "payable"].includes(direction)) denied("SETTLEMENT_DIRECTION_INVALID", "Choose receivables or payables")
    const organizationPartyId = lib.organization(
        p.organizationPartyId || lib.policy.access().activeOrganizationPartyId,
        null,
        lock
    )
    const side = direction === "receivable" ? "RECEIVABLE" : "PAYABLE"
    if (
        !has(side + "_VIEW") &&
        !has("PAYMENT_VIEW") &&
        !has("ACCOUNTING_VIEW") &&
        !has("ACCOUNTING_ADMIN") &&
        !lib.access.systemAdmin()
    )
        denied("PERMISSION_DENIED", "Settlement read authority is required")
    if (write) lib.requirePermission(side + "_EDIT")
    const party = requireParty ? one("mantle.party.Party", {partyId: p.partyId}) : null
    if (
        requireParty &&
        (!party || (party.privateOwnerUserId && party.privateOwnerUserId !== ec.user.userId && !lib.access.systemAdmin()))
    )
        denied("PARTY_UNAVAILABLE", "Choose an available counterparty")
    if (p.partyId === organizationPartyId) denied("SETTLEMENT_PARTY_INVALID", "Trade settlement needs a counterparty")
    if (requireParty && one("mantle.party.PartyRole", {partyId: p.partyId, roleTypeId: "OrgInternal"}))
        denied("INTERCOMPANY_EXCLUDED", "Internal counterparties use the intercompany workflow")
    if (requireParty) lib.policy.currency(p.currencyUomId)
    return {
        organizationPartyId,
        partyId: p.partyId,
        direction,
        currencyUomId: p.currencyUomId,
        capabilities: {
            canRead: true,
            canApply: has(side + "_EDIT"),
            canReadLedger:
                has("ACCOUNTING_VIEW") || has("ACCOUNTING_GL_POST") || has("ACCOUNTING_ADMIN") || lib.access.systemAdmin()
        }
    }
}
function key(kind, id) {
    return kind + ":" + encodeURIComponent(String(id))
}
function parseKey(value) {
    const text = String(value || ""),
        index = text.indexOf(":")
    const kind = text.slice(0, index)
    let id
    try {
        id = decodeURIComponent(text.slice(index + 1))
    } catch (_) {
        denied("SETTLEMENT_KEY_INVALID", "Choose a settlement record")
    }
    if (index < 0 || !kinds.includes(kind) || !id || id.length > 40 || key(kind, id) !== text)
        denied("SETTLEMENT_KEY_INVALID", "Choose a settlement record")
    return {kind, id, key: text, entity: ["invoice", "credit"].includes(kind) ? I : P}
}
function privateQuery(query) {
    if (lib.access.systemAdmin()) return query
    const cf = ec.entity.conditionFactory
    for (const field of ["fromPrivateOwnerUserId", "toPrivateOwnerUserId"])
        query = query.condition(
            cf.makeCondition([cf.makeCondition(field, "is-null", null), cf.makeCondition(field, "equals", ec.user.userId)], "or")
        )
    return query
}
function query(scope, kind, filters = {}) {
    const invoice = ["invoice", "credit"].includes(kind),
        cf = ec.entity.conditionFactory
    let q = find(invoice ? "mantle.account.payment.SettlementInvoiceBalance" : "mantle.account.payment.SettlementPaymentBalance")
    const org = scope.organizationPartyId
    if (invoice)
        q = q.condition(lib.policy.invoiceDirectionCondition(scope.direction === "receivable" ? "invoices" : "bills", [org]))
    else {
        q = q.condition(sideCondition(org, scope.direction)).condition("paymentTypeEnumId", "not-equals", "PtInternalTransfer")
    }
    q = q
        .condition(
            cf.makeCondition(
                [
                    cf.makeCondition(
                        [cf.makeCondition("fromPartyId", "equals", org), cf.makeCondition("toPartyId", "equals", scope.partyId)],
                        "and"
                    ),
                    cf.makeCondition(
                        [cf.makeCondition("toPartyId", "equals", org), cf.makeCondition("fromPartyId", "equals", scope.partyId)],
                        "and"
                    )
                ],
                "or"
            )
        )
        .condition(invoice ? "currencyUomId" : "amountUomId", scope.currencyUomId)
    q = privateQuery(q)
    // People P27 review (AC-23): a payroll-origin invoice or payment (its payrollOrigin mark) is no open item, nor a linked record
    // a payment's detail shows, for a user without PAYROLL_VIEW (PayrollOrigin.js)
    const origin = ec.resource.script("component://mr-mantle/service/mantle/account/PayrollOrigin.js")
    const originCondition = invoice ? origin.invoiceCondition() : origin.paymentCondition()
    if (originCondition) q = q.condition(originCondition)
    if (invoice) q = q.condition("invoiceTypeEnumId", kind === "credit" ? "equals" : "not-equals", "InvoiceCreditMemo")
    else {
        const sourceField = scope.direction === "receivable" ? "toPartyId" : "fromPartyId"
        q = q.condition(sourceField, kind === "payment" ? "equals" : "not-equals", org)
    }
    if (filters.ids) q = q.condition(invoice ? "invoiceId" : "paymentId", "in", filters.ids)
    if (!filters.selected) {
        q = q.condition(
            "statusId",
            "in",
            invoice
                ? ["InvoiceFinalized", "InvoiceSent", "InvoiceAcked", "InvoiceApproved", "InvoicePmtRecvd", "InvoicePmtSent"]
                : ["PmntDelivered", "PmntConfirmed"]
        )
        q = q.condition("balanceRemaining", "greater", 0)
        if (filters.asOfDate) {
            const day = ec.l10n.format(filters.asOfDate, "yyyy-MM-dd"),
                end = ec.l10n.parseTimestamp(day + " 23:59:59.999", "yyyy-MM-dd HH:mm:ss.SSS")
            q = invoice
                ? q.condition(
                      cf.makeCondition(
                          [
                              cf.makeCondition("accountingDate", "less-equals", day),
                              cf.makeCondition(
                                  [
                                      cf.makeCondition("accountingDate", "is-null", null),
                                      cf.makeCondition("invoiceDate", "less-equals", end)
                                  ],
                                  "and"
                              )
                          ],
                          "or"
                      )
                  )
                : q.condition("effectiveDate", "less-equals", end)
        }
        const today = ec.l10n.parseTimestamp(
            ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd") + " 00:00:00",
            "yyyy-MM-dd HH:mm:ss"
        )
        if (filters.dueBucket === "overdue" && invoice) q = q.condition("dueDate", "less", today)
        if (filters.dueBucket === "current" && invoice)
            q = q.condition(
                cf.makeCondition(
                    [cf.makeCondition("dueDate", "greater-equals", today), cf.makeCondition("dueDate", "is-null", null)],
                    "or"
                )
            )
        if (filters.text)
            q = q.condition(
                cf.makeCondition(
                    (invoice ? ["invoiceId", "referenceNumber", "description"] : ["paymentId", "paymentRefNum", "comments"]).map(
                        field => cf.makeCondition(field, "like", "%" + filters.text + "%").ignoreCase()
                    ),
                    "or"
                )
            )
    }
    return q
}
function applications(records) {
    const invoiceIds = records.filter(row => row.invoiceId).map(row => row.invoiceId),
        paymentIds = records.filter(row => row.paymentId).map(row => row.paymentId)
    const cf = ec.entity.conditionFactory,
        conditions = []
    for (const field of ["invoiceId", "toInvoiceId"])
        if (invoiceIds.length) conditions.push(cf.makeCondition(field, "in", invoiceIds))
    for (const field of ["paymentId", "toPaymentId"])
        if (paymentIds.length) conditions.push(cf.makeCondition(field, "in", paymentIds))
    return conditions.length
        ? Array.from(find(A).condition(cf.makeCondition(conditions, "or")).orderBy("paymentApplicationId").list())
        : []
}
function project(scope, kind, records, asOfDate = null) {
    if (!records.length) return []
    const invoice = ["invoice", "credit"].includes(kind),
        applied = applications(records)
    const held = invoice ? lib.openHolds(records.map(row => row.invoiceId)) : {}
    const invoiceTotals = invoice ? lib.totalsMany(records) : {},
        names = lib.partyNames([scope.partyId])
    // the due schedule's discount open today (PaymentTerms.js), for invoices and bills, not credits
    const dueSchedules =
        kind === "invoice"
            ? ec.resource.script("component://mr-mantle/service/mantle/account/PaymentTerms.js").schedules(
                  Array.from(
                      find(I)
                          .condition(
                              "invoiceId",
                              "in",
                              records.map(row => row.invoiceId)
                          )
                          .list()
                  )
              )
            : {}
    return records.map(record => {
        const id = invoice ? record.invoiceId : record.paymentId
        const evidence = applied.filter(row =>
            invoice ? [row.invoiceId, row.toInvoiceId].includes(id) : [row.paymentId, row.toPaymentId].includes(id)
        )
        const original = invoice ? invoiceTotals[id].invoiceTotal : toDecimal(record.amount || 0)
        const used = invoice
            ? invoiceTotals[id].appliedPayments
            : evidence.reduce((sum, row) => sum.add(row.amountApplied || 0), toDecimal(0))
        const remaining = original.subtract(used),
            date = invoice ? record.invoiceDate : record.effectiveDate
        const accountingDateText =
            invoice && record.accountingDate
                ? lib.policy.calendarDateText(record.accountingDate)
                : date
                  ? ec.l10n.format(date, "yyyy-MM-dd")
                  : ""
        const reasons = []
        if (
            !(
                invoice
                    ? ["InvoiceFinalized", "InvoiceSent", "InvoiceAcked", "InvoiceApproved", "InvoicePmtRecvd", "InvoicePmtSent"]
                    : ["PmntDelivered", "PmntConfirmed"]
            ).includes(record.statusId)
        )
            reasons.push("SETTLEMENT_STATE_INVALID")
        if (remaining.compare(0) <= 0) reasons.push("NO_REMAINING_BALANCE")
        if (held[id]) reasons.push("INVOICE_HELD")
        if (!date) reasons.push("SOURCE_DATE_REQUIRED")
        if (asOfDate && accountingDateText > ec.l10n.format(asOfDate, "yyyy-MM-dd")) reasons.push("OUTSIDE_SELECTION_DATE")
        const version = lib.hash({
            record: lib.map(record),
            original: String(original),
            remaining: String(remaining),
            applications: evidence.map(lib.map)
        })
        return {
            sourceKey: key(kind, id),
            sourceKind: kind,
            sourceId: id,
            counterpartyId: scope.partyId,
            counterpartyName: names[scope.partyId],
            date,
            dateText: accountingDateText,
            accountingDateText,
            dueDate: invoice ? record.dueDate : record.dueDate,
            dueDateText: lib.policy.dateText(record.dueDate),
            discountAvailable: dueSchedules[id]?.discountAvailable ?? null,
            discountDateText: dueSchedules[id]?.discountDateText ?? null,
            original,
            remaining,
            availableAmount: remaining,
            currencyUomId: scope.currencyUomId,
            statusId: record.statusId,
            version,
            statusDescription: one("moqui.basic.StatusItem", {statusId: record.statusId})?.description || record.statusId,
            capabilities: {canAllocate: scope.capabilities.canApply && !reasons.length},
            reasons
        }
    })
}
function selected(scope, selectedKeys, lock = false, asOfDate = null) {
    const keys = [...new Set(Array.from(selectedKeys || []).map(String))].sort()
    if (keys.length > 200) denied("SETTLEMENT_SELECTION_LIMIT", "Select at most 200 records")
    const parsed = keys.map(parseKey),
        out = []
    for (const kind of kinds) {
        const ids = parsed.filter(row => row.kind === kind).map(row => row.id)
        if (!ids.length) continue
        const records = Array.from(query(scope, kind, {ids, selected: true}).list())
        out.push(...project(scope, kind, records, asOfDate))
    }
    if (lock) {
        if (out.length !== parsed.length) denied("SETTLEMENT_RECORD_UNAVAILABLE", "A selected record is unavailable")
        for (const record of [...parsed].sort((a, b) => (a.entity + a.id).localeCompare(b.entity + b.id)))
            find(record.entity, {[record.entity === I ? "invoiceId" : "paymentId"]: record.id})
                .forUpdate(true)
                .one()
        const records = parsed.map(row => ({[row.entity === I ? "invoiceId" : "paymentId"]: row.id}))
        const apps = applications(records)
        for (const row of apps) find(A, {paymentApplicationId: row.paymentApplicationId}).forUpdate(true).one()
        return selected(scope, keys, false, asOfDate)
    }
    return out
}
function openItems(p) {
    const scope = context(p),
        activeKinds = p.sourceKind ? [p.sourceKind] : kinds
    if (activeKinds.some(kind => !kinds.includes(kind))) denied("SETTLEMENT_KIND_INVALID", "Choose a settlement record type")
    const result = {
        invoiceRows: [],
        creditRows: [],
        paymentRows: [],
        paymentTargetRows: [],
        pageInfo: {},
        selectedRows: [],
        sourceVersions: {},
        complete: true,
        incomplete: false,
        errors: [],
        capabilities: scope.capabilities,
        balanceBasis: "current",
        balanceAsOfDate: ec.user.nowTimestamp,
        selectionThroughDate: p.asOfDate || ec.user.nowTimestamp,
        selectionThroughDateText: ec.l10n.format(p.asOfDate || ec.user.nowTimestamp, "yyyy-MM-dd"),
        totals: {basis: "page"}
    }
    for (const kind of activeKinds) {
        const paging = Object.assign({}, p, p.pageByKind?.[kind] || {})
        const filters = Object.assign({}, p, {asOfDate: result.selectionThroughDate})
        try {
            const count = query(scope, kind, filters).count()
            const page = lib.page(
                query(scope, kind, filters).orderBy(
                    kind === "invoice" || kind === "credit" ? "dueDate,invoiceDate,invoiceId" : "effectiveDate,paymentId"
                ),
                paging,
                "records",
                count
            )
            const list = project(scope, kind, page.rows, result.selectionThroughDate)
            result[kind + "Rows"] = list
            result.pageInfo[kind] = lib.policy.pick(page, [
                "recordCount",
                "pageIndex",
                "pageSize",
                "pageMaxIndex",
                "pageRangeLow",
                "pageRangeHigh"
            ])
            result.totals[kind] = list.reduce((sum, row) => sum.add(row.remaining), toDecimal(0))
            if (p.sourceKind) Object.assign(result, result.pageInfo[kind], {rows: list})
        } catch (error) {
            ec.logger.error("Settlement " + kind + " balances: " + error.message)
            result.complete = false
            result.incomplete = true
            result.errors.push({reasonCode: "BALANCE_UNAVAILABLE", message: "The requested balances are unavailable"})
        }
    }
    result.selectedRows = selected(scope, p.selectedKeyList || [], false, result.selectionThroughDate)
    for (const row of [...activeKinds.flatMap(kind => result[kind + "Rows"]), ...result.selectedRows])
        result.sourceVersions[row.sourceKey] = row.version
    result.selectedTotals = result.selectedRows.reduce((sum, row) => sum.add(row.remaining), toDecimal(0))
    return result
}
// Payment lifecycle reads deliberately have a separate read gate from settlement writes.
const paymentFields = [
    "paymentId",
    "paymentTypeEnumId",
    "fromPartyId",
    "toPartyId",
    "paymentInstrumentEnumId",
    "paymentMethodId",
    "toPaymentMethodId",
    "statusId",
    "effectiveDate",
    "settlementDate",
    "dueDate",
    "paymentRefNum",
    "comments",
    "amount",
    "amountUomId",
    "forInvoiceId",
    "refundForPaymentId",
    "orderId",
    "orderPartSeqId",
    "reconcileStatusId",
    "feeForPaymentId",
    "lastUpdatedStamp"
]
const manualInstruments = [
    "PiCash",
    "PiPersonalCheck",
    "PiCompanyCheck",
    "PiCertifiedCheck",
    "PiMoneyOrder",
    "PiWireTransfer",
    "PiAch",
    "PiCod",
    "PiOther"
]
function broadRead() {
    return has("PAYMENT_VIEW") || has("ACCOUNTING_VIEW") || has("ACCOUNTING_ADMIN") || lib.access.systemAdmin()
}
function ledgerRead() {
    return has("ACCOUNTING_VIEW") || has("ACCOUNTING_GL_POST") || has("ACCOUNTING_ADMIN") || lib.access.systemAdmin()
}
function paymentContext(p, write = false, lock = false) {
    const organizationPartyId = lib.organization(
        p.organizationPartyId || lib.policy.access().activeOrganizationPartyId,
        null,
        lock
    )
    const broad = broadRead()
    if (!broad && !has("RECEIVABLE_VIEW") && !has("PAYABLE_VIEW"))
        denied("PERMISSION_DENIED", "Payment view authority is required")
    if (write && (!broad || !has("PAYMENT_EDIT")))
        denied("PERMISSION_DENIED", "Payment editing and payment view authority are required")
    return {organizationPartyId, broad}
}
// The internal organization of a payment: the one of its parties with the OrgInternal role, as set#PaymentAutoInfo reads
// it, the payer first.
function paymentOrganization(payment) {
    return (
        [payment.fromPartyId, payment.toPartyId].find(
            partyId => partyId && one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
        ) || null
    )
}
// The trade side of a payment for its organization: receivable when the organization receives it, payable when it pays;
// a refund keeps its original's side and an internal transfer is "transfer".
function paymentDirection(payment, org, original = null) {
    if (payment.paymentTypeEnumId === "PtInternalTransfer") return "transfer"
    const source = payment.refundForPaymentId ? original || one(P, {paymentId: payment.refundForPaymentId}) : payment
    return (source || payment).toPartyId === org ? "receivable" : "payable"
}
// The payments of one trade side of an organization (paymentDirection, in a query of PaymentFinance or a view on it).
function sideCondition(org, direction) {
    const cf = ec.entity.conditionFactory,
        receivable = direction === "receivable"
    return cf.makeCondition(
        [
            cf.makeCondition(
                [
                    cf.makeCondition("refundForPaymentId", "is-null", null),
                    cf.makeCondition(receivable ? "toPartyId" : "fromPartyId", "equals", org)
                ],
                "and"
            ),
            cf.makeCondition(
                [
                    cf.makeCondition("refundForPaymentId", "is-not-null", null),
                    cf.makeCondition(receivable ? "originalToPartyId" : "originalFromPartyId", "equals", org)
                ],
                "and"
            )
        ],
        "or"
    )
}
function paymentQuery(scope, p = {}) {
    const cf = ec.entity.conditionFactory,
        org = scope.organizationPartyId
    let q = privateQuery(
        find("mantle.account.payment.PaymentLifecycleBalance").condition(
            cf.makeCondition([cf.makeCondition("fromPartyId", "equals", org), cf.makeCondition("toPartyId", "equals", org)], "or")
        )
    )
    if (!scope.broad) {
        const sides = []
        if (has("RECEIVABLE_VIEW")) sides.push(sideCondition(org, "receivable"))
        if (has("PAYABLE_VIEW")) sides.push(sideCondition(org, "payable"))
        q = q.condition(cf.makeCondition(sides, "or")).condition("paymentTypeEnumId", "not-equals", "PtInternalTransfer")
    }
    // People P27 (AC-23): a payroll payment is a reader of payroll's, in every list and the detail this query authorizes
    const payrollOrigin = ec.resource.script("component://mr-mantle/service/mantle/account/PayrollOrigin.js").paymentCondition()
    if (payrollOrigin) q = q.condition(payrollOrigin)
    const queue = p.queue || "all"
    if (!["all", "incoming", "outgoing", "toValidate", "unapplied", "refunds", "transfers"].includes(queue))
        denied("PAYMENT_QUEUE_INVALID", "Choose a payment queue")
    if (queue === "incoming") q = q.condition("toPartyId", org).condition("fromPartyId", "not-equals", org)
    if (queue === "outgoing") q = q.condition("fromPartyId", org).condition("toPartyId", "not-equals", org)
    if (queue === "toValidate") q = q.condition("statusId", "PmntProposed")
    if (queue === "unapplied")
        q = q
            .condition("statusId", "in", ["PmntDelivered", "PmntConfirmed"])
            .condition("balanceRemaining", "greater", 0)
            .condition(
                cf.makeCondition(
                    [
                        cf.makeCondition("paymentTypeEnumId", "is-null", null),
                        cf.makeCondition("paymentTypeEnumId", "not-equals", "PtInternalTransfer")
                    ],
                    "or"
                )
            )
    if (queue === "refunds") q = q.condition("refundForPaymentId", "is-not-null", null)
    if (queue === "transfers") q = q.condition("paymentTypeEnumId", "PtInternalTransfer")
    for (const field of ["paymentInstrumentEnumId", "statusId"]) if (p[field]) q = q.condition(field, p[field])
    if (p.currencyUomId) q = q.condition("amountUomId", p.currencyUomId)
    if (p.partyId)
        q = q.condition(
            cf.makeCondition(
                [cf.makeCondition("fromPartyId", "equals", p.partyId), cf.makeCondition("toPartyId", "equals", p.partyId)],
                "or"
            )
        )
    for (const [field, operator] of [
        ["fromDay", "greater-equals"],
        ["throughDay", "less-equals"]
    ])
        if (p[field]) {
            const day = String(p[field])
            if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) denied("DATE_INVALID", "Choose a valid payment date")
            const stamp = ec.l10n.parseTimestamp(
                day + (field === "throughDay" ? " 23:59:59.999" : " 00:00:00.000"),
                "yyyy-MM-dd HH:mm:ss.SSS"
            )
            q = q.condition("effectiveDate", operator, stamp)
        }
    if (String(p.text || "").trim())
        q = q.condition(
            cf.makeCondition(
                [
                    "paymentId",
                    "paymentRefNum",
                    "comments",
                    "fromOrganizationName",
                    "fromFirstName",
                    "fromLastName",
                    "toOrganizationName",
                    "toFirstName",
                    "toLastName"
                ].map(field => cf.makeCondition(field, "like", "%" + String(p.text).trim().slice(0, 200) + "%").ignoreCase()),
                "or"
            )
        )
    return q
}
function paymentScope(p, write = false, lock = false) {
    let parameters = p
    if (!p.organizationPartyId && !lib.policy.access().activeOrganizationPartyId) {
        const source = one(P, {paymentId: p.paymentId})
        if (!source) denied("PAYMENT_UNAVAILABLE", "Payment is not available")
        const internal = [...new Set([source.fromPartyId, source.toPartyId])].filter(partyId =>
            one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
        )
        const organizationPartyId = internal.length === 1 ? internal[0] : null
        if (!organizationPartyId) denied("ORGANIZATION_REQUIRED", "Choose the organization for this payment")
        parameters = Object.assign({}, p, {organizationPartyId})
    }
    const scope = paymentContext(parameters, write, lock)
    let record = paymentQuery(scope).condition("paymentId", p.paymentId).one()
    if (!record) denied("PAYMENT_UNAVAILABLE", "Payment is not available")
    // The balance view authorizes selection; financial revisions always use the same base entity as locked writers.
    record = find(P, {paymentId: p.paymentId}).forUpdate(lock).one()
    if (!record || ![record.fromPartyId, record.toPartyId].includes(scope.organizationPartyId))
        denied("PAYMENT_UNAVAILABLE", "Payment is not available")
    const org = scope.organizationPartyId,
        original = record.refundForPaymentId ? one(P, {paymentId: record.refundForPaymentId}) : null
    const financeDirection = paymentDirection(record, org, original)
    const partyId = record.fromPartyId === org ? record.toPartyId : record.fromPartyId
    const party = one("mantle.party.Party", {partyId})
    if (!party || (party.privateOwnerUserId && party.privateOwnerUserId !== ec.user.userId && !lib.access.systemAdmin()))
        denied("PAYMENT_UNAVAILABLE", "Payment is not available")
    if (
        !scope.broad &&
        (financeDirection === "transfer" || !has(financeDirection === "receivable" ? "RECEIVABLE_VIEW" : "PAYABLE_VIEW"))
    )
        denied("PERMISSION_DENIED", "Matching side payment view authority is required")
    return Object.assign(scope, {
        record,
        original,
        financeDirection,
        tradeExcluded: partyId === org || Boolean(one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})),
        cashDirection:
            record.paymentTypeEnumId === "PtInternalTransfer" ? "transfer" : record.fromPartyId === org ? "outgoing" : "incoming",
        partyId
    })
}
function paymentApplications(ids) {
    if (!ids.length) return []
    const cf = ec.entity.conditionFactory
    return Array.from(
        find(A)
            .condition(
                cf.makeCondition([cf.makeCondition("paymentId", "in", ids), cf.makeCondition("toPaymentId", "in", ids)], "or")
            )
            .orderBy("paymentApplicationId")
            .list()
    )
}
// The revision of a payment a review or an edit is checked against: its lastUpdatedStamp, which every write of the
// payment changes (its applications through its applied and unapplied totals).
function paymentVersion(record) {
    return record.lastUpdatedStamp == null ? null : String(lib.ms(record.lastUpdatedStamp))
}
function paymentTotals(record, applicationRows) {
    const amount = toDecimal(record.amount || 0),
        appliedTotal = applicationRows.reduce((sum, row) => sum.add(row.amountApplied || 0), toDecimal(0))
    return {amount, appliedTotal, unappliedTotal: amount.subtract(appliedTotal), currencyUomId: record.amountUomId}
}
function paymentCapabilities(scope, applicationRows = [], posted = false) {
    const r = scope.record,
        draft = r && ["PmntProposed", "PmntPromised"].includes(r.statusId),
        canWrite = scope.broad && has("PAYMENT_EDIT"),
        supported = r && !r.refundForPaymentId && r.paymentTypeEnumId === "PtInvoicePayment" && !scope.tradeExcluded,
        hasApplications = applicationRows.some(row => toDecimal(row.amountApplied || 0).compare(0) > 0),
        sideEdit = has(scope.financeDirection === "receivable" ? "RECEIVABLE_EDIT" : "PAYABLE_EDIT"),
        gateway = Boolean(
            scope.gatewayManaged || r?.paymentGatewayConfigId || !manualInstruments.includes(r?.paymentInstrumentEnumId)
        )
    const capabilities = {
        canRead: true,
        canCreate: scope.broad && has("PAYMENT_EDIT"),
        canEdit: Boolean(
            canWrite &&
            supported &&
            draft &&
            !posted &&
            !hasApplications &&
            !scope.hasGatewayInstruction &&
            !scope.hasPriorFinancialHistory
        ),
        canEditDraft: Boolean(
            canWrite &&
            supported &&
            draft &&
            !posted &&
            !hasApplications &&
            !scope.hasGatewayInstruction &&
            !scope.hasPriorFinancialHistory
        ),
        canValidate: Boolean(
            canWrite &&
            supported &&
            r.statusId === "PmntProposed" &&
            Boolean(r.effectiveDate) &&
            !posted &&
            !scope.hasPriorFinancialHistory &&
            !scope.hasGatewayInstruction
        ),
        canDeliver: Boolean(
            canWrite &&
            supported &&
            draft &&
            !gateway &&
            Boolean(r.effectiveDate) &&
            !posted &&
            !hasApplications &&
            !r.forInvoiceId &&
            !scope.hasPriorFinancialHistory &&
            !scope.hasGatewayInstruction
        ),
        canManualDeliver: Boolean(
            canWrite &&
            supported &&
            draft &&
            !gateway &&
            Boolean(r.effectiveDate) &&
            !posted &&
            !hasApplications &&
            !r.forInvoiceId &&
            !scope.hasPriorFinancialHistory &&
            !scope.hasGatewayInstruction
        ),
        canConfirm: Boolean(canWrite && supported && r.statusId === "PmntDelivered" && !gateway && posted),
        canCancel: Boolean(canWrite && supported && draft && !posted && !hasApplications && !scope.hasGatewayInstruction),
        canVoid: Boolean(
            canWrite &&
            supported &&
            ["PmntDelivered", "PmntConfirmed"].includes(r.statusId) &&
            posted &&
            (!hasApplications || sideEdit) &&
            (!r.reconcileStatusId || r.reconcileStatusId === "PmtrNot")
        ),
        canUnapply: Boolean(
            canWrite &&
            supported &&
            hasApplications &&
            sideEdit &&
            ["PmntDelivered", "PmntConfirmed"].includes(r.statusId) &&
            posted
        ),
        canReadGateway: scope.broad && (has("PAYMENT_EDIT") || has("ACCOUNTING_ADMIN") || lib.access.systemAdmin()),
        canReadLedger: ledgerRead(),
        canReadFiles: true,
        canUploadContent: Boolean(canWrite && supported),
        canPrintReceipt: false,
        canPrintDetail: false,
        canPrintCheck: false,
        canGatewayAuthorize: false,
        canGatewayCapture: false,
        canGatewayRelease: false,
        canGatewayRefund: false,
        canGatewayLookup: false,
        canRefund: false,
        canPreviewRefund: false,
        canTransfer: Boolean(scope.broad && has("PAYMENT_EDIT")),
        reasons: [],
        unavailableReason: "PAYMENT_SLICE_UNAVAILABLE"
    }
    return capabilities
}
function paymentProjection(scope, record, appRows, names = {}) {
    if (!scope.labels)
        scope.labels = {
            statuses: Object.fromEntries(
                rows("moqui.basic.StatusItem", {statusTypeId: "Payment"}).map(row => [row.statusId, row.description])
            ),
            instruments: Object.fromEntries(
                rows("moqui.basic.Enumeration", {enumTypeId: "PaymentInstrument"}).map(row => [row.enumId, row.description])
            )
        }
    const org = scope.organizationPartyId,
        cashDirection =
            record.paymentTypeEnumId === "PtInternalTransfer" ? "transfer" : record.fromPartyId === org ? "outgoing" : "incoming",
        partyId = cashDirection === "outgoing" ? record.toPartyId : record.fromPartyId,
        financeDirection =
            record.paymentTypeEnumId === "PtInternalTransfer"
                ? "transfer"
                : (record.refundForPaymentId ? record.originalToPartyId || scope.original?.toPartyId : record.toPartyId) === org
                  ? "receivable"
                  : "payable",
        out = lib.policy.pick(
            lib.display(record),
            paymentFields
                .filter(field => !["forInvoiceId", "refundForPaymentId", "orderId", "orderPartSeqId"].includes(field))
                .concat(paymentFields.filter(field => /Date$|Stamp$/.test(field)).map(field => field + "Text"))
        )
    out.effectiveDateValue = record.effectiveDate ? ec.l10n.format(record.effectiveDate, "yyyy-MM-dd") : null
    out.accountingDateText = out.effectiveDateValue
    out.effectiveDateText = out.effectiveDateValue || ""
    out.settlementDateText = record.settlementDate ? ec.l10n.format(record.settlementDate, "yyyy-MM-dd") : ""
    Object.assign(out, paymentTotals(record, appRows), {
        partyId,
        partyName: names[partyId] || partyId,
        fromName: names[record.fromPartyId],
        toName: names[record.toPartyId],
        cashDirection,
        financeDirection,
        referenceNumber: record.paymentRefNum,
        currencyUomId: record.amountUomId,
        sourceVersion: paymentVersion(scope.versionRecords?.[record.paymentId] || record),
        statusDescription: scope.labels.statuses[record.statusId] || record.statusId,
        instrumentDescription: scope.labels.instruments[record.paymentInstrumentEnumId] || record.paymentInstrumentEnumId
    })
    out.availableAmount = out.unappliedTotal
    if (record.paymentTypeEnumId === "PtInternalTransfer") {
        out.transferSummary = transferProjection(record).transferSummary
        Object.assign(out, {
            appliedTotal: toDecimal(0),
            unappliedTotal: toDecimal(0),
            availableAmount: toDecimal(0)
        })
    }
    return out
}
function payments(p) {
    const scope = paymentContext(p),
        count = paymentQuery(scope, p).count(),
        page = lib.page(paymentQuery(scope, p).orderBy("-effectiveDate,paymentId"), p, "records", count),
        ids = [...new Set(Array.from(p.selectedPaymentIdList || []).map(String))]
    if (ids.length > 200) denied("PAYMENT_SELECTION_LIMIT", "Select at most two hundred payments")
    const selectedRows = ids.length ? Array.from(paymentQuery(scope).condition("paymentId", "in", ids).list()) : [],
        records = [...page.rows, ...selectedRows],
        apps = paymentApplications(records.map(row => row.paymentId)),
        names = lib.partyNames(records.flatMap(row => [row.fromPartyId, row.toPartyId])),
        errors = []
    scope.versionRecords = records.length
        ? Object.fromEntries(
              Array.from(
                  find(P)
                      .condition("paymentId", "in", [...new Set(records.map(row => row.paymentId))])
                      .list()
              ).map(row => [row.paymentId, row])
          )
        : {}
    function projectRow(record) {
        try {
            return paymentProjection(
                scope,
                record,
                apps.filter(row => row.paymentId === record.paymentId || row.toPaymentId === record.paymentId),
                names
            )
        } catch (error) {
            ec.logger.error("Payment " + record.paymentId + " projection: " + error.message)
            errors.push({paymentId: record.paymentId, reasonCode: "PAYMENT_READ_FAILED"})
            return null
        }
    }
    return Object.assign(
        lib.policy.pick(page, ["recordCount", "pageIndex", "pageSize", "pageMaxIndex", "pageRangeLow", "pageRangeHigh"]),
        {
            rows: page.rows.map(projectRow).filter(Boolean),
            selectedRows: selectedRows.map(projectRow).filter(Boolean),
            complete: !errors.length,
            errors,
            capabilities: paymentCapabilities(scope),
            totals: {basis: "page", currencies: [...new Set(page.rows.map(row => row.amountUomId))]}
        }
    )
}
const bankIdentityFields = ["paymentMethodId", "bankName", "typeEnumId", "routingNumber", "accountNumber"]
const cardIdentityFields = ["paymentMethodId", "creditCardTypeEnumId", "cardNumber", "validFromDate", "expireDate", "issueNumber"]
const methodIdentityFields = [
    "paymentMethodId",
    "paymentMethodTypeEnumId",
    "ownerPartyId",
    "fromDate",
    "thruDate",
    "currencyUomId",
    "glAccountId",
    "paymentGatewayConfigId",
    "originalPaymentMethodId",
    "description",
    "titleOnAccount",
    "firstNameOnAccount",
    "middleNameOnAccount",
    "lastNameOnAccount",
    "suffixOnAccount",
    "companyNameOnAccount",
    "postalContactMechId",
    "gatewayCimId"
]
function subtypeQuery(entity, fields) {
    let query = find(entity)
    for (const field of fields) query = query.selectField(field)
    return query
}
function methodIdentities(method, lock = false) {
    return {
        bank:
            method.paymentMethodTypeEnumId === "PmtBankAccount"
                ? subtypeQuery("mantle.account.method.BankAccount", bankIdentityFields)
                      .condition("paymentMethodId", method.paymentMethodId)
                      .forUpdate(lock)
                      .one()
                : null,
        card:
            method.paymentMethodTypeEnumId === "PmtCreditCard"
                ? subtypeQuery("mantle.account.method.CreditCard", cardIdentityFields)
                      .condition("paymentMethodId", method.paymentMethodId)
                      .forUpdate(lock)
                      .one()
                : null
    }
}
function methodVersion(method, identities = null) {
    const {bank, card} = identities || methodIdentities(method)
    return lib.hash({
        method: lib.policy.pick(lib.map(method), methodIdentityFields),
        bank: bank ? lib.policy.pick(lib.map(bank), bankIdentityFields) : null,
        card: card ? lib.policy.pick(lib.map(card), cardIdentityFields) : null
    })
}
// An internal transfer: one payment from the organization's from method (paymentMethodId) to its to method
// (toPaymentMethodId), shown as its outgoing and incoming sides with masked method labels, and the payment of its fee
// (feeForPaymentId), if any.
function transferProjection(record) {
    const label = paymentMethodId => {
            const method = paymentMethodId && one("mantle.account.method.PaymentMethod", {paymentMethodId})
            return method ? methodRows([method])[0].label : null
        },
        fee = find(P, {feeForPaymentId: record.paymentId}).orderBy("paymentId").limit(1).one(),
        summary = {
            paymentId: record.paymentId,
            principalAmount: String(record.amount ?? 0),
            currencyUomId: record.amountUomId,
            accountingDateText: record.effectiveDate ? ec.l10n.format(record.effectiveDate, "yyyy-MM-dd") : null,
            fromMethodLabel: label(record.paymentMethodId),
            toMethodLabel: label(record.toPaymentMethodId),
            referenceNumber: record.paymentRefNum,
            reason: record.comments,
            feePaymentId: fee?.paymentId || null,
            feeAmount: fee ? String(fee.amount ?? 0) : null,
            feePartyId: fee?.toPartyId || null,
            feePartyName: fee ? lib.partyNames([fee.toPartyId])[fee.toPartyId] || null : null
        },
        side = (leg, maskedMethodLabel) => ({
            paymentId: record.paymentId,
            leg,
            maskedMethodLabel,
            amount: summary.principalAmount,
            currencyUomId: summary.currencyUomId,
            accountingDateText: summary.accountingDateText
        })
    return {
        transferSummary: summary,
        transferLegRows: [side("outgoing", summary.fromMethodLabel), side("incoming", summary.toMethodLabel)]
    }
}
function methodRows(records) {
    const ids = records.map(row => row.paymentMethodId),
        banks = ids.length
            ? Array.from(
                  subtypeQuery("mantle.account.method.BankAccount", bankIdentityFields)
                      .condition("paymentMethodId", "in", ids)
                      .list()
              )
            : [],
        cards = ids.length
            ? Array.from(
                  subtypeQuery("mantle.account.method.CreditCard", cardIdentityFields)
                      .condition("paymentMethodId", "in", ids)
                      .list()
              )
            : [],
        types = rows("moqui.basic.Enumeration", {enumTypeId: "PaymentMethodType"})
    return records.map(method => {
        const bank = banks.find(row => row.paymentMethodId === method.paymentMethodId),
            card = cards.find(row => row.paymentMethodId === method.paymentMethodId),
            number = bank?.accountNumber || card?.cardNumber,
            lastFour = number ? String(number).slice(-4) : null,
            typeDescription =
                types.find(row => row.enumId === method.paymentMethodTypeEnumId)?.description || method.paymentMethodTypeEnumId
        return {
            paymentMethodId: method.paymentMethodId,
            ownerPartyId: method.ownerPartyId,
            paymentMethodTypeEnumId: method.paymentMethodTypeEnumId,
            typeDescription,
            description: method.description,
            currencyUomId: method.currencyUomId,
            maskedNumber: lastFour ? "•••• " + lastFour : null,
            label: [method.description || typeDescription, lastFour ? "•••• " + lastFour : null].filter(Boolean).join(" · "),
            version: methodVersion(method, {bank, card}),
            gatewayManaged: Boolean(method.paymentGatewayConfigId)
        }
    })
}
// Treasury reads issued checks: payment view and payment edit (or accounting administration).
function treasury(scope) {
    return scope.broad && (has("PAYMENT_EDIT") || has("ACCOUNTING_ADMIN") || lib.access.systemAdmin())
}
// The payment's content the user may read: check images only with treasury authority.
function contentQuery(scope) {
    const cf = ec.entity.conditionFactory
    let query = find("mantle.account.payment.PaymentContent", {paymentId: scope.record.paymentId})
    if (!treasury(scope))
        query = query.condition(
            cf.makeCondition(
                [
                    cf.makeCondition("contentTypeEnumId", "is-null", null),
                    cf.makeCondition("contentTypeEnumId", "not-equals", "PctCheckImage")
                ],
                "or"
            )
        )
    return query
}
// A payment the user may read, and what they may do with its files: add them (canChange), replace or remove them
// (not once the payment is posted: contentLocked) and read check images (canReadCheck).
function access(p) {
    const scope = paymentScope(p),
        posted = find("mantle.ledger.transaction.AcctgTrans", {paymentId: scope.record.paymentId, isPosted: "Y"}).count() > 0
    return {
        organizationPartyId: scope.organizationPartyId,
        partyId: scope.partyId,
        cashDirection: scope.cashDirection,
        canChange: scope.broad && has("PAYMENT_EDIT"),
        contentLocked: posted,
        canReadCheck: treasury(scope)
    }
}
// The organization whose payment methods a user with payment view authority may choose from.
function methodScope(p) {
    const scope = paymentContext(p)
    if (!scope.broad) denied("PERMISSION_DENIED", "Payment method choices require payment view authority")
    return {organizationPartyId: scope.organizationPartyId}
}
// Masked rows of the given payment methods, for a service's paymentMethodList.
function maskedMethods(p) {
    return {methodRows: methodRows(Array.from(p.paymentMethodList || []))}
}
function visibleApplications(scope, applicationRows) {
    if (!applicationRows.length && !scope.record.forInvoiceId) return {rows: [], restricted: false, invoiceIds: new Set()}
    const invoiceIds = [
            ...new Set(
                [...applicationRows.flatMap(row => [row.invoiceId, row.toInvoiceId]), scope.record.forInvoiceId].filter(Boolean)
            )
        ],
        paymentIds = [...new Set(applicationRows.flatMap(row => [row.paymentId, row.toPaymentId]).filter(Boolean))],
        allowedInvoices = new Set(),
        allowedPayments = new Set()
    try {
        const trade = context({
            organizationPartyId: scope.organizationPartyId,
            partyId: scope.partyId,
            direction: scope.financeDirection,
            currencyUomId: scope.record.amountUomId
        })
        for (const [ids, types, field, target] of [
            [invoiceIds, ["invoice", "credit"], "invoiceId", allowedInvoices],
            [paymentIds, ["payment", "paymentTarget"], "paymentId", allowedPayments]
        ]) {
            if (!ids.length) continue
            for (const kind of types)
                for (const row of query(trade, kind, {ids, selected: true}).selectField(field).list()) target.add(row[field])
        }
    } catch (error) {
        ec.logger.error("Payment " + scope.record.paymentId + " linked record read: " + error.message)
        return {rows: [], restricted: true, invoiceIds: allowedInvoices}
    }
    const visible = applicationRows.filter(
        row =>
            [row.invoiceId, row.toInvoiceId].filter(Boolean).every(id => allowedInvoices.has(id)) &&
            [row.paymentId, row.toPaymentId].filter(Boolean).every(id => allowedPayments.has(id))
    )
    return {rows: visible, restricted: visible.length !== applicationRows.length, invoiceIds: allowedInvoices}
}
function paymentDetailRead(p) {
    const scope = paymentScope(p),
        record = scope.record,
        apps = paymentApplications([p.paymentId]),
        names = lib.partyNames([record.fromPartyId, record.toPartyId]),
        transactions = Array.from(
            find("mantle.ledger.transaction.AcctgTrans", {paymentId: p.paymentId, organizationPartyId: scope.organizationPartyId})
                .orderBy("transactionDate,acctgTransId")
                .limit(501)
                .list()
        ),
        posted = transactions.some(row => row.isPosted === "Y" && !row.reversedByAcctgTransId && !row.reverseOfAcctgTransId),
        methodIds = [record.paymentMethodId, record.toPaymentMethodId].filter(Boolean),
        maskedMethodRows = methodIds.length
            ? methodRows(
                  Array.from(find("mantle.account.method.PaymentMethod").condition("paymentMethodId", "in", methodIds).list())
              )
            : []
    scope.gatewayManaged = maskedMethodRows.some(row => row.gatewayManaged)
    scope.hasGatewayInstruction = Boolean(
        find("mantle.account.method.PaymentGatewayResponse", {paymentId: p.paymentId}).limit(1).one()
    )
    scope.hasPriorFinancialHistory = apps.length > 0 || transactions.length > 0
    const visible = visibleApplications(scope, apps),
        capabilities = paymentCapabilities(scope, apps, posted),
        out = {
            payment: paymentProjection(scope, record, apps, names),
            sourceVersion: paymentVersion(record),
            totals: paymentTotals(record, apps),
            maskedMethodRows,
            applicationRows: visible.rows.map(row =>
                Object.assign(
                    lib.policy.pick(lib.display(row), [
                        "paymentApplicationId",
                        "paymentId",
                        "toPaymentId",
                        "invoiceId",
                        "toInvoiceId",
                        "amountApplied",
                        "appliedDate",
                        "appliedDateText",
                        "currencyUomId"
                    ]),
                    {version: lib.hash(lib.map(row))}
                )
            ),
            refundRows: [],
            contentRows: [],
            sourceRows: [],
            capabilities,
            reasons: capabilities.reasons,
            complete: transactions.length <= 500,
            errors: []
        }
    out.totals.availableAmount = out.totals.unappliedTotal
    if (visible.restricted) {
        out.complete = false
        out.errors.push({reasonCode: "APPLICATIONS_RESTRICTED", message: "Some application links are unavailable"})
        capabilities.canVoid = false
    }
    out.refundRows = Array.from(
        paymentQuery(scope, {partyId: scope.partyId, currencyUomId: record.amountUomId})
            .condition(sideCondition(scope.organizationPartyId, scope.financeDirection))
            .condition("refundForPaymentId", p.paymentId)
            .orderBy("effectiveDate,paymentId")
            .limit(100)
            .list()
    ).map(row => paymentProjection(scope, row, paymentApplications([row.paymentId]), names))
    const outputService = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentOutput.js")
    Object.assign(capabilities, outputService.available(scope))
    out.outputRows = capabilities.outputRows
    delete capabilities.outputRows
    if (record.paymentTypeEnumId === "PtInternalTransfer") {
        Object.assign(out, transferProjection(record))
        Object.assign(out.totals, {
            appliedTotal: toDecimal(0),
            unappliedTotal: toDecimal(0),
            availableAmount: toDecimal(0)
        })
    }
    out.contentRows = contentQuery(scope)
        .orderBy("-contentDate,paymentContentId")
        .limit(100)
        .list()
        .map(row =>
            lib.policy.pick(lib.display(row), [
                "paymentContentId",
                "contentTypeEnumId",
                "description",
                "contentDate",
                "contentDateText",
                "userId"
            ])
        )
    out.sourceRows = [
        record.forInvoiceId && visible.invoiceIds.has(record.forInvoiceId)
            ? {sourceKind: "invoice", sourceId: record.forInvoiceId}
            : null
    ].filter(Boolean)
    if (record.orderId) {
        let order = find("mantle.order.OrderPart", {
            orderId: record.orderId,
            vendorPartyId: scope.financeDirection === "receivable" ? scope.organizationPartyId : scope.partyId,
            customerPartyId: scope.financeDirection === "receivable" ? scope.partyId : scope.organizationPartyId
        })
        if (record.orderPartSeqId) order = order.condition("orderPartSeqId", record.orderPartSeqId)
        if (order.limit(1).one()) out.sourceRows.push({sourceKind: "order", sourceId: record.orderId})
    }
    if (
        scope.original &&
        [scope.original.fromPartyId, scope.original.toPartyId].includes(scope.organizationPartyId) &&
        [scope.original.fromPartyId, scope.original.toPartyId].includes(scope.partyId) &&
        scope.original.amountUomId === record.amountUomId
    )
        out.sourceRows.push({sourceKind: "payment", sourceId: scope.original.paymentId})
    if (capabilities.canReadLedger)
        out.ledgerRows = transactions
            .slice(0, 500)
            .map(row =>
                lib.policy.pick(lib.display(row), [
                    "acctgTransId",
                    "acctgTransTypeEnumId",
                    "transactionDate",
                    "transactionDateText",
                    "accountingDate",
                    "isPosted",
                    "reverseOfAcctgTransId",
                    "reversedByAcctgTransId",
                    "amountUomId"
                ])
            )
    // Gateway actions and refunds through Mantle's gateway services (get#PaymentGatewayActions), for treasury users.
    if (capabilities.canReadGateway && record.paymentTypeEnumId !== "PtInternalTransfer") {
        const gateway = lib.call("mantle.account.PaymentServices.get#PaymentGatewayActions", {
            organizationPartyId: scope.organizationPartyId,
            paymentId: record.paymentId
        })
        const actions = Array.from(gateway.actionList || [])
        out.gatewayActions = lib.policy.pick(gateway, ["paymentGatewayConfigId", "gatewayDescription", "reasonCode"])
        out.gatewayActions.actionList = actions
        out.refundSummary = gateway.refundSummary
        Object.assign(capabilities, {
            canGatewayAuthorize: actions.includes("authorize"),
            canGatewayCapture: actions.includes("capture"),
            canGatewayRelease: actions.includes("release"),
            canGatewayRefund: actions.includes("refund"),
            canGatewayLookup: actions.includes("lookup"),
            canRefund: gateway.canRefund === true,
            canPreviewRefund: gateway.canRefund === true,
            refundUnavailableReason: gateway.refundReasonCode || null
        })
    }
    if (scope.broad && has("PAYMENT_EDIT")) {
        const evidence = ec.resource
            .script("component://mr-mantle/service/mantle/account/PaymentLifecycle.js")
            .evidenceOptions(scope, Array.from(contentQuery(scope).orderBy("-contentDate,paymentContentId").limit(101).list()))
        out.evidenceRows = evidence.evidenceRows
        out.evidenceIncomplete = evidence.incomplete
        const byId = Object.fromEntries(evidence.evidenceRows.map(row => [row.paymentContentId, row]))
        out.contentRows = out.contentRows.map(row => Object.assign(row, byId[row.paymentContentId] || {}))
    }
    return out
}
// What the user may read beside the payments: the ledger (canReadLedger) and every payment (broad).
function readAuthority() {
    return {canReadLedger: ledgerRead(), broad: broadRead()}
}
const operations = {openItems, payments, paymentDetail: paymentDetailRead, access, methodScope, maskedMethods, readAuthority}
// Runs one payment read for its service and puts the results in the service's context.
function execute(op, context) {
    if (!operations[op]) throw new Error("Unknown payment workflow operation " + op)
    const result = operations[op](context)
    ec.context.putAll(result)
    return result
}
const paymentDetail = paymentDetailRead
;({
    execute,
    lib,
    I,
    P,
    A,
    kinds,
    context,
    key,
    parseKey,
    query,
    project,
    selected,
    applications,
    openItems,
    broadRead,
    ledgerRead,
    treasury,
    paymentContext,
    paymentQuery,
    paymentScope,
    paymentApplications,
    paymentVersion,
    paymentOrganization,
    paymentDirection,
    sideCondition,
    paymentTotals,
    paymentCapabilities,
    paymentProjection,
    payments,
    methodVersion,
    methodIdentityFields,
    bankIdentityFields,
    cardIdentityFields,
    methodIdentities,
    methodRows,
    paymentDetail,
    manualInstruments
})
