// Collections (AC-10; mantle.account.CollectionServices): contacts with a customer and their next action (a WorkEffort
// activity on the customer with a CollectionActivity row), disputes, payment promises and their state, the dunning levels,
// and reminder runs: a preview of the notices and what is left out, then the send, each notice in its own transaction so
// one failed recipient never resends the others.
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const {find, one, rows, call, denied, has} = lib
const I = lib.invoiceEntity
const ACTIVITY = "mantle.account.invoice.CollectionActivity"
const PROMISE = "mantle.account.invoice.CollectionPromise"
const LEVEL = "mantle.account.invoice.DunningLevel"
const RUN = "mantle.account.invoice.DunningRun"
const NOTICE = "mantle.account.invoice.DunningNotice"
const OPEN_STATUSES = ["InvoiceFinalized", "InvoiceSent", "InvoiceAcked"]
const PURPOSES = {call: "WepPhoneCall", email: "WepEmail", todo: "WepToDo"}
const RUN_LIMIT = 2000
const cf = () => ec.entity.conditionFactory
const today = () => ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd")
const startOf = day => ec.l10n.parseTimestamp(day + " 00:00:00", "yyyy-MM-dd HH:mm:ss")
const endOf = day => ec.l10n.parseTimestamp(day + " 23:59:59.999", "yyyy-MM-dd HH:mm:ss.SSS")
const dayOf = value => (value == null || value === "" ? null : lib.entityLib.bookDay(null, value))
// a calendar day (a date field or Date parameter), read as the day it names whatever the user's zone
const dayText = value => (value == null || value === "" ? null : lib.policy.calendarDateText(value))
const dayNumber = day => {
    const [year, month, date] = String(day).split("-").map(Number)
    return Date.UTC(year, month - 1, date) / 86400000
}
// Ids given as a list, a comma-separated text or a list of such texts (a multiple drop-down's value).
const idList = value =>
    [
        ...new Set(
            (typeof value === "string" ? [value] : Array.from(value || []))
                .flatMap(item => String(item).split(","))
                .map(id => id.trim())
        )
    ].filter(Boolean)

// The organization (with the permission) and a customer the user may see.
function customerScope(p, permission) {
    const organizationPartyId = lib.organization(p.organizationPartyId, permission)
    const customerPartyId = p.customerPartyId
    const customer = customerPartyId ? one("mantle.party.Party", {partyId: customerPartyId}) : null
    if (!customer || (customer.privateOwnerUserId && customer.privateOwnerUserId !== ec.user.userId))
        denied("CUSTOMER_UNAVAILABLE", "The customer is not available")
    const names = lib.partyNames([customerPartyId])
    return {organizationPartyId, customerPartyId, customerName: names[customerPartyId] || customerPartyId}
}
// The customer's receivables named, each the organization's invoice to the customer.
function customerInvoices(scope, ids) {
    const list = idList(ids)
    if (!list.length) return []
    const found = Array.from(find(I).condition("invoiceId", "in", list).list())
    if (
        found.length !== list.length ||
        found.some(row => row.fromPartyId !== scope.organizationPartyId || row.toPartyId !== scope.customerPartyId)
    )
        denied("INVOICE_UNAVAILABLE", "An invoice is not one of the customer's")
    return found
}
function userPartyId() {
    return ec.user.userAccount?.partyId || null
}

// A contact with a customer (done now) with its outcome and note, and an optional next action due on a day, assigned to
// the collector (default the user), which reaches their Today. Disputed marks the invoices named; dispute resolved
// clears them.
function recordActivity(p) {
    const scope = customerScope(p, "RECEIVABLE_EDIT")
    const outcome = one("moqui.basic.Enumeration", {enumId: p.outcomeEnumId})
    if (outcome?.enumTypeId !== "CollectionOutcome") denied("OUTCOME_INVALID", "Choose the outcome of the contact")
    const activityType = p.activityType || "call"
    if (!PURPOSES[activityType]) denied("ACTIVITY_TYPE_INVALID", "An activity is a call, an email or a to-do")
    const invoices = customerInvoices(scope, p.invoiceIdList)
    const disputing = ["CaoDisputed", "CaoDisputeResolved"].includes(p.outcomeEnumId)
    if (disputing && !invoices.length) denied("INVOICES_REQUIRED", "Choose the invoices of the dispute")
    const me = userPartyId()
    const note = String(p.note || "").trim()
    const done = call("mantle.work.TaskServices.create#SimpleTask", {
        workEffortName: (outcome.description + " · " + scope.customerName).slice(0, 255),
        purposeEnumId: PURPOSES[activityType],
        statusId: "WeComplete",
        resolutionEnumId: "WerCompleted",
        estimatedCompletionDate: ec.user.nowTimestamp,
        actualCompletionDate: ec.user.nowTimestamp,
        description: note || null,
        ownerPartyId: me,
        assignToPartyId: me
    })
    link(done.workEffortId, scope, p.outcomeEnumId, invoices)
    if (disputing)
        for (const invoice of invoices)
            call(
                "update#" + I,
                p.outcomeEnumId === "CaoDisputed"
                    ? {invoiceId: invoice.invoiceId, disputedDate: ec.user.nowTimestamp, disputeNote: note.slice(0, 255) || null}
                    : {invoiceId: invoice.invoiceId, disputedDate: null, disputeNote: null}
            )
    let nextWorkEffortId = null
    if (p.nextActionDate) {
        const nextType = p.nextActionType && PURPOSES[p.nextActionType] ? p.nextActionType : activityType
        const next = call("mantle.work.TaskServices.create#SimpleTask", {
            workEffortName: (String(p.nextActionName || "").trim() || "Follow up · " + scope.customerName).slice(0, 255),
            purposeEnumId: PURPOSES[nextType],
            estimatedCompletionDate: p.nextActionDate,
            description: note || null,
            ownerPartyId: me,
            assignToPartyId: p.assignToPartyId || me
        })
        link(next.workEffortId, scope, "CaoNextAction", invoices)
        nextWorkEffortId = next.workEffortId
    }
    return {workEffortId: done.workEffortId, nextWorkEffortId}
}
function link(workEffortId, scope, outcomeEnumId, invoices) {
    call("mantle.work.WorkEffortServices.link#WorkEffortRecord", {
        workEffortId,
        recordEntityName: "mantle.party.Party",
        recordId: scope.customerPartyId
    })
    call("create#" + ACTIVITY, {
        workEffortId,
        organizationPartyId: scope.organizationPartyId,
        customerPartyId: scope.customerPartyId,
        outcomeEnumId,
        invoiceIds: invoices.map(row => row.invoiceId).join(",") || null
    })
}

// A customer's promise to pay an amount by a day, or, with collectionPromiseId and cancel Y, its cancellation.
function storePromise(p) {
    const scope = customerScope(p, "RECEIVABLE_EDIT")
    if (p.collectionPromiseId) {
        const promise = find(PROMISE, {collectionPromiseId: p.collectionPromiseId}).forUpdate(true).one()
        if (
            !promise ||
            promise.organizationPartyId !== scope.organizationPartyId ||
            promise.customerPartyId !== scope.customerPartyId
        )
            denied("PROMISE_UNAVAILABLE", "The promise is not available")
        if (p.cancel !== "Y") denied("PROMISE_FIXED", "A promise is cancelled and recorded again, not changed")
        if (promise.statusId === "CprCancelled") return {collectionPromiseId: promise.collectionPromiseId}
        call("update#" + PROMISE, {collectionPromiseId: promise.collectionPromiseId, statusId: "CprCancelled"})
        return {collectionPromiseId: promise.collectionPromiseId}
    }
    const preference = lib.policy.preference(scope.organizationPartyId)
    const currencyUomId = p.currencyUomId || preference.baseCurrencyUomId
    const amount = lib.amount(p.amount, currencyUomId)
    const promisedDay = dayText(p.promisedDate)
    if (!promisedDay) denied("PROMISED_DATE_REQUIRED", "Give the day the customer promised to pay by")
    if (promisedDay < today()) denied("PROMISED_DATE_PAST", "The promised day has passed")
    const invoices = customerInvoices(scope, p.invoiceIdList)
    if (invoices.some(row => row.currencyUomId !== currencyUomId))
        denied("CURRENCY_DIFFERENT", "The invoices are in another currency")
    const created = call("create#" + PROMISE, {
        organizationPartyId: scope.organizationPartyId,
        customerPartyId: scope.customerPartyId,
        currencyUomId,
        amount,
        promisedDate: promisedDay,
        invoiceIds: invoices.map(row => row.invoiceId).join(",") || null,
        note:
            String(p.note || "")
                .trim()
                .slice(0, 255) || null,
        statusId: "CprOpen",
        createdByUserId: ec.user.userId,
        createdDate: ec.user.nowTimestamp,
        workEffortId: p.workEffortId || null
    })
    return {collectionPromiseId: created.collectionPromiseId}
}

// Each promise's state: kept when the customer's payments received from its making through its day reach the amount,
// broken when the day has passed first, open until then, or cancelled. Never marks an invoice paid.
function promiseStates(promises) {
    const list = Array.from(promises || []).map(row => lib.map(row))
    if (!list.length) return []
    const now = today()
    const customerIds = [...new Set(list.map(row => row.customerPartyId))]
    const orgIds = [...new Set(list.map(row => row.organizationPartyId))]
    const earliest = list.reduce((min, row) => (lib.ms(row.createdDate) < min ? lib.ms(row.createdDate) : min), Infinity)
    const payments = Array.from(
        find("mantle.account.payment.Payment")
            .condition("fromPartyId", "in", customerIds)
            .condition("toPartyId", "in", orgIds)
            .condition("statusId", "in", ["PmntDelivered", "PmntConfirmed"])
            .condition("effectiveDate", "greater-equals", new Date(earliest))
            .list()
    )
    return list.map(promise => {
        const thru = lib.ms(endOf(dayText(promise.promisedDate)))
        const from = lib.ms(promise.createdDate)
        const paid = payments
            .filter(
                row =>
                    row.fromPartyId === promise.customerPartyId &&
                    row.toPartyId === promise.organizationPartyId &&
                    row.amountUomId === promise.currencyUomId &&
                    lib.ms(row.effectiveDate) >= from &&
                    lib.ms(row.effectiveDate) <= thru
            )
            .reduce((sum, row) => sum.add(row.amount ?? 0), toDecimal(0))
        const state =
            promise.statusId === "CprCancelled"
                ? "cancelled"
                : paid.compare(promise.amount ?? 0) >= 0
                  ? "kept"
                  : dayText(promise.promisedDate) < now
                    ? "broken"
                    : "open"
        return Object.assign(lib.display(promise), {
            promisedDateText: dayText(promise.promisedDate),
            paidAmount: paid,
            state,
            stateText: {cancelled: "Cancelled", kept: "Kept", broken: "Broken", open: "Open"}[state]
        })
    })
}

// A customer's collection history with the organization: its activities, newest first, with their outcome, who and when,
// and the open next actions; its promises with their state; its disputed invoices.
function customerCollections(p) {
    const scope = customerScope(p, null)
    if (!has("RECEIVABLE_VIEW") && !has("ACCOUNTING_VIEW") && !has("ACCOUNTING_ADMIN"))
        denied("PERMISSION_DENIED", "RECEIVABLE_VIEW authority is required")
    const links = Array.from(
        find(ACTIVITY, {organizationPartyId: scope.organizationPartyId, customerPartyId: scope.customerPartyId})
            .orderBy("-workEffortId")
            .limit(100)
            .list()
    )
    const ids = links.map(row => row.workEffortId)
    const efforts = ids.length
        ? Array.from(find("mantle.work.effort.WorkEffort").condition("workEffortId", "in", ids).list())
        : []
    const assignees = ids.length
        ? Array.from(
              find("mantle.work.effort.WorkEffortParty", {roleTypeId: "Assignee"}).condition("workEffortId", "in", ids).list()
          )
        : []
    const names = lib.partyNames(assignees.map(row => row.partyId))
    const outcomes = Object.fromEntries(
        rows("moqui.basic.Enumeration", {enumTypeId: "CollectionOutcome"}).map(row => [row.enumId, row.description])
    )
    const activities = links
        .map(link => {
            const effort = efforts.find(row => row.workEffortId === link.workEffortId)
            if (!effort) return null
            const assignee = assignees.find(row => row.workEffortId === link.workEffortId)
            const done = ["WeComplete", "WeClosed"].includes(effort.statusId)
            const when = done ? effort.actualCompletionDate : effort.estimatedCompletionDate
            return {
                workEffortId: effort.workEffortId,
                workEffortName: effort.workEffortName,
                description: effort.description || "",
                purposeEnumId: effort.purposeEnumId,
                outcomeEnumId: link.outcomeEnumId,
                outcomeText: outcomes[link.outcomeEnumId] || "",
                invoiceIds: link.invoiceIds || "",
                done,
                cancelled: effort.statusId === "WeCancelled",
                dateText: when ? lib.entityLib.dateText(when) : "",
                dueDay: done ? null : dayOf(when),
                assigneePartyId: assignee?.partyId || null,
                assigneeName: names[assignee?.partyId] || ""
            }
        })
        .filter(row => row && !row.cancelled)
    const promises = promiseStates(
        find(PROMISE, {organizationPartyId: scope.organizationPartyId, customerPartyId: scope.customerPartyId})
            .orderBy("-createdDate")
            .limit(50)
            .list()
    )
    const disputed = Array.from(
        find(I, {fromPartyId: scope.organizationPartyId, toPartyId: scope.customerPartyId})
            .condition("disputedDate", "is-not-null", null)
            .condition("statusId", "in", OPEN_STATUSES)
            .list()
    ).map(row => Object.assign(lib.display(row), {disputedDateText: lib.entityLib.dateText(row.disputedDate)}))
    return {
        customerName: scope.customerName,
        activities,
        nextActions: activities.filter(row => !row.done),
        promises,
        disputedInvoices: disputed,
        canEdit: has("RECEIVABLE_EDIT")
    }
}

// ---------- Dunning ----------
function levelsInEffect(organizationPartyId, date = ec.user.nowTimestamp) {
    return Array.from(
        find(LEVEL, {organizationPartyId})
            .condition(cf().makeConditionDate("fromDate", "thruDate", date))
            .orderBy("daysOverdueFrom")
            .list()
    ).map(row => lib.map(row))
}
// Add or change a dunning level (a new dated row replacing the one given), or end it. Refuses negative days, a cadence
// under one day, an unknown email template and a second level from the same days overdue.
function storeLevel(p) {
    const organizationPartyId = lib.organization(p.organizationPartyId, "ACCOUNTING_ADMIN", true)
    let current = null
    if (p.dunningLevelId) {
        current = find(LEVEL, {dunningLevelId: p.dunningLevelId}).forUpdate(true).one()
        if (!current || current.organizationPartyId !== organizationPartyId || !lib.entityLib.active(current))
            denied("LEVEL_UNAVAILABLE", "The dunning level is not available")
    }
    const changeReason =
        String(p.changeReason || "")
            .trim()
            .slice(0, 255) || null
    const end = () => {
        if (current)
            call("update#" + LEVEL, {dunningLevelId: current.dunningLevelId, thruDate: ec.user.nowTimestamp, changeReason})
    }
    if (p.ended === "Y") {
        if (!current) denied("LEVEL_UNAVAILABLE", "Choose the level to end")
        end()
        return {dunningLevelId: current.dunningLevelId}
    }
    const days = Number(p.daysOverdueFrom)
    if (!Number.isInteger(days) || days < 1) denied("DAYS_INVALID", "A level starts one or more days overdue")
    const cadence = Number(p.cadenceDays ?? 7)
    if (!Number.isInteger(cadence) || cadence < 1) denied("CADENCE_INVALID", "Days between reminders is one or more")
    const emailTemplateId = p.emailTemplateId || "MANTLE_DUNNING_EMAIL"
    if (!one("moqui.basic.email.EmailTemplate", {emailTemplateId})) denied("TEMPLATE_INVALID", "Choose an email template")
    const description = String(p.description || "").trim()
    if (!description) denied("DESCRIPTION_REQUIRED", "Give the level's wording")
    if (
        levelsInEffect(organizationPartyId).some(
            row => Number(row.daysOverdueFrom) === days && row.dunningLevelId !== current?.dunningLevelId
        )
    )
        denied("LEVEL_DUPLICATE", "Another level starts at " + days + " days overdue")
    end()
    const levels = levelsInEffect(organizationPartyId).filter(row => row.dunningLevelId !== current?.dunningLevelId)
    const created = call("create#" + LEVEL, {
        organizationPartyId,
        sequenceNum: levels.filter(row => Number(row.daysOverdueFrom) < days).length + 1,
        description: description.slice(0, 255),
        daysOverdueFrom: days,
        cadenceDays: cadence,
        emailTemplateId,
        excludeDisputed: p.excludeDisputed === "N" ? "N" : "Y",
        fromDate: ec.user.nowTimestamp,
        changeReason,
        changedByUserId: ec.user.userId,
        previousLevelId: current?.dunningLevelId || null
    })
    return {dunningLevelId: created.dunningLevelId}
}

// The overdue part of invoices on a day as reminder lines: each invoice's portions of its due schedule past due, less what
// was applied (LedgerReportServices' aging, Aging.pastDue), with its oldest such due day; an invoice with nothing past
// due is left out.
function invoiceRows(invoices, asOf) {
    // a past day reads what was open then
    const late = ec.resource
        .script("component://mr-mantle/service/mantle/ledger/Aging.js")
        .pastDue(invoices, asOf, asOf < today() ? endOf(asOf) : null)
    return invoices
        .filter(invoice => late[invoice.invoiceId])
        .map(invoice => {
            const due = late[invoice.invoiceId]
            return {
                invoiceId: invoice.invoiceId,
                referenceNumber: invoice.referenceNumber || "",
                dueDateText: due.oldestDueDay,
                daysOverdue: due.daysOverdue,
                overdueAmount: due.amount,
                unpaidTotal: due.unpaidTotal,
                disputed: !!invoice.disputedDate
            }
        })
}
// The invoices of a Shop renewal still in retry (mr-pass impl-shop P7; review X5, R-SC-03): its occurrence's payment is
// being retried or waits for the customer, whose payment-attempt notices are the reminders then, so Dunning never sends a
// second one; once the retries end (or the renewal is closed) the invoice is Dunning's again. Through the occurrence's
// invoice or its order's billing.
const RENEWAL_RETRY_STATES = ["SrsCharging", "SrsRetry", "SrsActionRequired"]
function renewalsInRetry(invoiceIds) {
    const ids = [...new Set(invoiceIds)]
    const out = new Set()
    if (!ids.length) return out
    const OCCURRENCE = "mantle.product.subscription.StoreRenewalOccurrence"
    for (let index = 0; index < ids.length; index += 500) {
        const chunk = ids.slice(index, index + 500)
        for (const row of find(OCCURRENCE)
            .condition("invoiceId", "in", chunk)
            .condition("stateEnumId", "in", RENEWAL_RETRY_STATES)
            .list())
            out.add(row.invoiceId)
        const orderOf = new Map()
        for (const row of find("mantle.order.OrderItemBilling").condition("invoiceId", "in", chunk).list())
            if (row.orderId) orderOf.set(row.invoiceId, row.orderId)
        const orderIds = [...new Set(orderOf.values())]
        if (!orderIds.length) continue
        const retrying = new Set(
            Array.from(
                find(OCCURRENCE).condition("orderId", "in", orderIds).condition("stateEnumId", "in", RENEWAL_RETRY_STATES).list()
            ).map(row => row.orderId)
        )
        for (const [invoiceId, orderId] of orderOf) if (retrying.has(orderId)) out.add(invoiceId)
    }
    return out
}
// Preview a reminder run as of a day (default today): for each customer and currency with overdue invoices, the level of
// its most overdue invoice that is not disputed, and a notice of its overdue invoices; left out, with the reason: disputed
// invoices (unless the level includes them), a customer whose unapplied payments and credits cover what is overdue, one
// with an open promise, a notice of the same level sent within its cadence, and the invoice of a Shop renewal still in
// retry (renewalsInRetry). Stores the run and its notices.
function previewDunning(p) {
    const organizationPartyId = lib.organization(p.organizationPartyId, "RECEIVABLE_EDIT")
    const asOf = dayText(p.asOfDate) || today()
    const levels = levelsInEffect(organizationPartyId)
    if (!levels.length) denied("LEVELS_REQUIRED", "Set up the dunning levels first")
    const found = Array.from(
        find(I, {fromPartyId: organizationPartyId})
            .condition("statusId", "in", OPEN_STATUSES)
            .condition("unpaidTotal", "greater", toDecimal(0))
            .condition("invoiceDate", "less-equals", endOf(asOf))
            .orderBy("toPartyId,currencyUomId,invoiceDate,invoiceId")
            .limit(RUN_LIMIT + 1)
            .list()
    )
    const incomplete = found.length > RUN_LIMIT
    const invoices = found.slice(0, RUN_LIMIT)
    const names = lib.partyNames(invoices.map(row => row.toPartyId))
    const groups = new Map()
    for (const invoice of invoices) {
        if (!names[invoice.toPartyId]) continue
        const key = invoice.toPartyId + "|" + invoice.currencyUomId
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(invoice)
    }
    const run = call("create#" + RUN, {
        organizationPartyId,
        asOfDate: asOf,
        statusId: "DrnPreview",
        createdByUserId: ec.user.userId,
        createdDate: ec.user.nowTimestamp,
        incomplete: incomplete ? "Y" : "N"
    })
    let seq = 0
    const add = values =>
        call(
            "create#" + NOTICE,
            Object.assign({dunningRunId: run.dunningRunId, noticeSeqId: String(++seq).padStart(4, "0")}, values)
        )
    let noticeCount = 0,
        excludedCount = 0
    const customerIds = [...new Set(invoices.map(row => row.toPartyId))]
    const openPromises = customerIds.length
        ? promiseStates(
              find(PROMISE, {organizationPartyId, statusId: "CprOpen"}).condition("customerPartyId", "in", customerIds).list()
          ).filter(row => row.state === "open")
        : []
    const inRetry = renewalsInRetry(invoices.map(row => row.invoiceId))
    for (const [key, list] of groups) {
        const [customerPartyId, currencyUomId] = key.split("|")
        const overdueLines = invoiceRows(list, asOf)
        if (!overdueLines.length) continue
        // a renewal in retry is left out (Shop's attempt notices remind the customer until its retries end)
        const renewalLeftOut = overdueLines.filter(line => inRetry.has(line.invoiceId))
        const lines = overdueLines.filter(line => !inRetry.has(line.invoiceId))
        const base = {customerPartyId, currencyUomId}
        const undisputed = lines.filter(line => !line.disputed)
        const days = undisputed.length ? Math.max(...undisputed.map(line => line.daysOverdue)) : 0
        const level = levels.filter(row => Number(row.daysOverdueFrom) <= days).pop() || null
        const included = level?.excludeDisputed === "N" ? lines : undisputed
        const disputedLeftOut = lines.filter(line => line.disputed && !included.includes(line))
        const excludedRow = (reason, set) => {
            excludedCount++
            add(
                Object.assign({}, base, {
                    statusId: "DntExcluded",
                    excludedReason: reason,
                    dunningLevelId: level?.dunningLevelId || null,
                    levelSequenceNum: level?.sequenceNum ?? null,
                    invoiceIds: set.map(line => line.invoiceId).join(","),
                    overdueAmount: set.reduce((sum, line) => sum.add(line.overdueAmount), toDecimal(0)),
                    oldestDueDate: set.map(line => line.dueDateText).sort()[0] || null
                })
            )
        }
        if (renewalLeftOut.length) excludedRow("RENEWAL_RETRY", renewalLeftOut)
        if (disputedLeftOut.length) excludedRow("DISPUTED", disputedLeftOut)
        if (!level || !included.length) continue
        const overdueAmount = included.reduce((sum, line) => sum.add(line.overdueAmount), toDecimal(0))
        const cover = Array.from(
            find("mantle.account.payment.Payment", {
                fromPartyId: customerPartyId,
                toPartyId: organizationPartyId,
                amountUomId: currencyUomId
            })
                .condition("statusId", "in", ["PmntDelivered", "PmntConfirmed"])
                .condition("unappliedTotal", "greater", toDecimal(0))
                .list()
        ).reduce((sum, row) => sum.add(row.unappliedTotal ?? 0), toDecimal(0))
        if (cover.compare(overdueAmount) >= 0) {
            excludedRow("COVERED", included)
            continue
        }
        if (openPromises.some(row => row.customerPartyId === customerPartyId && row.currencyUomId === currencyUomId)) {
            excludedRow("PROMISED", included)
            continue
        }
        const invoiceIds = included.map(line => line.invoiceId).sort()
        const noticeKey = lib.hash({organizationPartyId, customerPartyId, currencyUomId, level: level.sequenceNum})
        const since = startOf(addDays(asOf, -Number(level.cadenceDays || 1) + 1))
        // a reminder of this level to the customer (its key: this organization, customer, currency and level) sent within
        // the cadence
        const recent = find(NOTICE, {noticeKey, statusId: "DntSent"}).condition("sentDate", "greater-equals", since).count()
        if (recent > 0) {
            excludedRow("RECENT_NOTICE", included)
            continue
        }
        const contacts = call("mantle.party.ContactServices.get#PartyContactInfoList", {
            partyId: customerPartyId,
            emailContactMechPurposeId: "EmailBilling",
            alsoIncludePrimaryPurpose: true
        })
        const addresses = Array.from(contacts.emailAddressList || [])
            .map(row => row.emailAddress)
            .filter(Boolean)
        noticeCount++
        add(
            Object.assign({}, base, {
                statusId: "DntPending",
                dunningLevelId: level.dunningLevelId,
                levelSequenceNum: level.sequenceNum,
                invoiceIds: invoiceIds.join(","),
                overdueAmount: ec.l10n.roundCurrency(overdueAmount, currencyUomId),
                oldestDueDate: included.map(line => line.dueDateText).sort()[0],
                noticeKey,
                toAddresses: [...new Set(addresses)].join(",").slice(0, 255) || null
            })
        )
    }
    return {dunningRunId: run.dunningRunId, noticeCount, excludedCount, incomplete}
}
function addDays(day, days) {
    const value = new Date((dayNumber(day) + days) * 86400000)
    const pad = n => String(n).padStart(2, "0")
    return value.getUTCFullYear() + "-" + pad(value.getUTCMonth() + 1) + "-" + pad(value.getUTCDate())
}

// The run of the organization, for a reader or (edit) an AR user.
function runScope(p, permission) {
    const run = one(RUN, {dunningRunId: p.dunningRunId})
    if (!run) denied("RUN_UNAVAILABLE", "The reminder run is not available")
    lib.organization(run.organizationPartyId, permission)
    return run
}
// Send the run's notices not yet sent. Each is marked sending in a transaction of its own, then prepared in its own
// (prepare#DunningNotice: a failure there, before any email, leaves it failed with its reason); then its email; then the
// outcome. An exception during or after the email call leaves it sending with SEND_UNKNOWN, never sent again on its own
// (resolve#DunningNotice settles it). The same operation key answers the first result.
function sendDunning(p) {
    const first = runScope(p, "RECEIVABLE_EDIT")
    const op = lib.operation(p, "DunningSend", first.organizationPartyId, {dunningRunId: first.dunningRunId})
    const previous = lib.previous(op)
    if (previous) return previous
    find(RUN, {dunningRunId: first.dunningRunId}).forUpdate(true).one()
    const waiting = Array.from(
        find(NOTICE, {dunningRunId: first.dunningRunId}).condition("statusId", "in", ["DntPending", "DntFailed"]).list()
    )
    const results = []
    for (const notice of waiting) {
        const key = {dunningRunId: notice.dunningRunId, noticeSeqId: notice.noticeSeqId}
        const record = values => lib.probe("update#" + NOTICE, Object.assign({}, key, values))
        const result = (statusId, reasonCode) =>
            results.push({noticeSeqId: notice.noticeSeqId, customerPartyId: notice.customerPartyId, statusId, reasonCode})
        try {
            record({statusId: "DntSending", errorMessage: null})
        } catch (error) {
            ec.logger.error("Dunning notice " + notice.noticeSeqId + " not marked sending: " + error.message)
            continue
        }
        let prepared
        try {
            prepared = lib.probe("mantle.account.CollectionServices.prepare#DunningNotice", key).prepared || {}
        } catch (error) {
            record({statusId: "DntFailed", errorMessage: ("SEND_FAILED: " + error.message).slice(0, 255)})
            result("DntFailed", "SEND_FAILED")
            continue
        }
        if (!prepared.ready) {
            result(prepared.statusId, prepared.reasonCode || null)
            continue
        }
        try {
            // a failed send (its errors, not an exception) leaves no email and the notice failed
            ec.message.pushErrors()
            let sent
            try {
                sent =
                    ec.service
                        .sync()
                        .name("org.moqui.impl.EmailServices.send#EmailTemplate")
                        .parameters(prepared.email)
                        .disableAuthz()
                        .requireNewTransaction(true)
                        .call() || {}
            } finally {
                ec.message.clearErrors()
                ec.message.popErrors()
            }
            const message = sent?.emailMessageId
                ? one("moqui.basic.email.EmailMessage", {emailMessageId: sent.emailMessageId})
                : null
            if (!message || !["ES_SENT", "ES_READY", "ES_SCHEDULED"].includes(message.statusId)) {
                record({statusId: "DntFailed", errorMessage: "DELIVERY_FAILED: The email could not be sent"})
                result("DntFailed", "DELIVERY_FAILED")
                continue
            }
            record({
                statusId: "DntSent",
                emailMessageId: message.emailMessageId,
                sentDate: ec.user.nowTimestamp,
                overdueAmount: prepared.overdueAmount,
                invoiceIds: prepared.invoiceIds
            })
            result("DntSent", null)
        } catch (error) {
            // its email may have gone: it stays sending, with the error, and is not sent again on its own
            ec.logger.error("Dunning run " + notice.dunningRunId + " notice " + notice.noticeSeqId + ": " + error.message)
            try {
                record({errorMessage: ("SEND_UNKNOWN: " + error.message).slice(0, 255)})
            } catch (recordError) {
                ec.logger.error("Dunning notice " + notice.noticeSeqId + " error not recorded: " + recordError.message)
            }
            result("DntSending", "SEND_UNKNOWN")
        }
    }
    updateRunStatus(first.dunningRunId)
    const result = {
        results,
        sentCount: results.filter(row => row.statusId === "DntSent").length,
        failedCount: results.filter(row => row.statusId === "DntFailed").length
    }
    lib.complete(op, RUN, first.dunningRunId, result)
    return Object.assign(result, {alreadyApplied: false})
}
function updateRunStatus(dunningRunId) {
    const left = find(NOTICE, {dunningRunId}).condition("statusId", "in", ["DntPending", "DntFailed", "DntSending"]).count()
    call("update#" + RUN, {
        dunningRunId,
        statusId: left ? "DrnPartial" : "DrnSent",
        sentByUserId: ec.user.userId,
        sentDate: ec.user.nowTimestamp
    })
}
// Settle a notice left sending (its email's outcome unknown) as sent or failed, with a note; a failed one is sent again
// by the next send of the run.
function resolveNotice(p) {
    const run = runScope(p, "RECEIVABLE_EDIT")
    const note = String(p.note || "").trim()
    if (!note) denied("NOTE_REQUIRED", "Say how the outcome was found")
    if (!["DntSent", "DntFailed"].includes(p.statusId)) denied("STATUS_INVALID", "Choose sent or failed")
    const notice = find(NOTICE, {dunningRunId: run.dunningRunId, noticeSeqId: p.noticeSeqId}).forUpdate(true).one()
    if (!notice || notice.statusId !== "DntSending") denied("NOTICE_NOT_SENDING", "Only a notice left sending is settled")
    call("update#" + NOTICE, {
        dunningRunId: run.dunningRunId,
        noticeSeqId: p.noticeSeqId,
        statusId: p.statusId,
        sentDate: p.statusId === "DntSent" ? ec.user.nowTimestamp : null,
        errorMessage: ("Settled: " + note).slice(0, 255)
    })
    updateRunStatus(run.dunningRunId)
    return {statusId: p.statusId}
}
// One notice ready to send: its invoices read again (one now paid, no longer past due, or disputed since unless the level
// includes disputed invoices is left out; nothing left leaves the notice out), its recipients checked, and its email
// rendered. Sends nothing.
function prepareNotice(p) {
    const notice = find(NOTICE, {dunningRunId: p.dunningRunId, noticeSeqId: p.noticeSeqId}).forUpdate(true).one()
    if (!notice || notice.statusId !== "DntSending") return {statusId: notice?.statusId || null, ready: false}
    const run = one(RUN, {dunningRunId: p.dunningRunId})
    const asOf = dayText(run.asOfDate)
    const update = values =>
        call("update#" + NOTICE, Object.assign({dunningRunId: p.dunningRunId, noticeSeqId: p.noticeSeqId}, values))
    const ids = idList(notice.invoiceIds)
    const level = one(LEVEL, {dunningLevelId: notice.dunningLevelId})
    const open = Array.from(find(I).condition("invoiceId", "in", ids).orderBy("invoiceDate,invoiceId").list()).filter(
        row => OPEN_STATUSES.includes(row.statusId) && toDecimal(row.unpaidTotal ?? 0).compare(0) > 0
    )
    // an invoice disputed since the preview is left out, unless the level includes disputed invoices
    const invoices = level?.excludeDisputed === "N" ? open : open.filter(row => !row.disputedDate)
    const lines = invoiceRows(invoices, asOf)
    if (!lines.length) {
        const reasonCode = open.some(row => row.disputedDate) ? "DISPUTED" : "PAID"
        update({statusId: "DntExcluded", excludedReason: reasonCode})
        return {statusId: "DntExcluded", reasonCode, ready: false}
    }
    const fail = (reasonCode, message) => {
        update({statusId: "DntFailed", errorMessage: reasonCode + ": " + message})
        return {statusId: "DntFailed", reasonCode, ready: false}
    }
    const addresses = idList(notice.toAddresses).map(address => address.toLowerCase())
    if (!addresses.length) return fail("RECIPIENT_REQUIRED", "The customer has no billing email address")
    const invalid = addresses.filter(address => !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(address))
    if (invalid.length) return fail("RECIPIENT_INVALID", "Invalid recipient address")
    const organization = one("mantle.party.PartyDetail", {partyId: run.organizationPartyId})
    const organizationName = organization?.organizationName || run.organizationPartyId
    const names = lib.partyNames([notice.customerPartyId])
    const overdueAmount = lines.reduce((sum, line) => sum.add(line.overdueAmount), toDecimal(0))
    const body = ec.resource.template("component://mr-mantle/template/account/DunningNotice.html.fancy", {
        notice: {
            customerName: names[notice.customerPartyId] || notice.customerPartyId,
            currencyUomId: notice.currencyUomId,
            levelText: level?.description || "",
            invoiceRows: lines,
            overdueAmount
        },
        organizationName,
        asOfDateText: asOf
    })
    const issuer = call("mantle.party.ContactServices.get#PartyContactInfo", {
        partyId: run.organizationPartyId,
        emailContactMechPurposeId: "EmailBilling"
    })
    return {
        ready: true,
        overdueAmount: ec.l10n.roundCurrency(overdueAmount, notice.currencyUomId),
        invoiceIds: lines.map(line => line.invoiceId).join(","),
        email: {
            emailTemplateId: level?.emailTemplateId || "MANTLE_DUNNING_EMAIL",
            toAddresses: addresses.join(","),
            bodyParameters: {
                subject: "Payment reminder from " + organizationName,
                fromAddress: issuer.emailAddress,
                fromName: organizationName
            },
            body,
            bodyText: "Past due as of " + asOf + ": " + ec.l10n.formatCurrency(overdueAmount, notice.currencyUomId)
        }
    }
}
// A run with its notices for a reader: each with the customer's name, level and invoices, and the run's counts.
function getRun(p) {
    const run = runScope(p, null)
    if (!has("RECEIVABLE_VIEW") && !has("ACCOUNTING_VIEW") && !has("ACCOUNTING_ADMIN"))
        denied("PERMISSION_DENIED", "RECEIVABLE_VIEW authority is required")
    const notices = Array.from(find(NOTICE, {dunningRunId: run.dunningRunId}).orderBy("noticeSeqId").list()).map(row =>
        lib.display(row)
    )
    const names = lib.partyNames(notices.map(row => row.customerPartyId))
    const statuses = Object.fromEntries(
        rows("moqui.basic.StatusItem", {statusTypeId: "DunningNotice"}).map(row => [row.statusId, row.description])
    )
    const reasons = {
        DISPUTED: "Disputed",
        COVERED: "Covered by payments or credits",
        PROMISED: "Promised to pay",
        RECENT_NOTICE: "Reminded recently",
        PAID: "Paid since the preview",
        RENEWAL_RETRY: "Renewal payment being retried"
    }
    return {
        run: Object.assign(lib.display(run), {
            asOfDateText: dayText(run.asOfDate),
            statusText: one("moqui.basic.StatusItem", {statusId: run.statusId})?.description || run.statusId
        }),
        notices: notices
            .filter(row => names[row.customerPartyId])
            .map(row =>
                Object.assign(row, {
                    customerName: names[row.customerPartyId],
                    statusText: statuses[row.statusId] || row.statusId,
                    excludedText: row.excludedReason ? reasons[row.excludedReason] || row.excludedReason : "",
                    oldestDueDateText: dayText(row.oldestDueDate) || ""
                })
            ),
        canSend: has("RECEIVABLE_EDIT")
    }
}

const operations = {
    recordActivity,
    storePromise,
    customerCollections,
    storeLevel,
    previewDunning,
    sendDunning,
    prepareNotice,
    resolveNotice,
    getRun
}
;({
    promiseStates,
    levelsInEffect,
    execute(op, parameters) {
        if (!operations[op]) throw new Error("Unknown collections operation " + op)
        return operations[op](parameters)
    }
})
