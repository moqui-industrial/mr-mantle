// Sales' recurring orders and subscriptions (mantle.order.SalesRecurrenceServices, the recurrence part of G of IronStone Sales design
// §12.1; design §7 RecurringOrders and Subscriptions, §13.1 create_RecurringOrders; impl-sales P16, SAL-RECURRENCE, CX-RECURRING, X5,
// F22, F23, §4 Q7).
//
// - A recurring base is a native OrderHeader in OrderApproved marked OrpRecurringTemplate (Shop's marker, which every exclusion reads:
//   credit, reservation, shipment, invoicing, store mail, the sales summaries, planning, Customer Service's and the customers' order
//   lists), with no reservation, shipment or billing source of its own: store#SalesRecurrence makes it as a copy of an approved sales
//   order (clone#Order with copyPayment=false, as Shop's base is made), so the order it came from is fulfilled and billed as before and
//   the base only ever holds the schedule. Its cadence is recurCronExpression (a monthly, weekly or yearly day and hour, or a cron
//   expression), read in its own zone (recurTimeZone); it runs between recurFromDate and recurThruDate, may be paused, and may name the
//   customer agreement it is kept under (recurAgreementId, entity/SalesRecurrenceEntities.xml). A base a Shop contract renews is Shop's
//   (SalesAccess.js recurrenceOf) and is only dispatched to Shop, as before.
// - The worker (OrderServices.create#RecurringOrders, the create_RecurringOrders job, and create#RecurringOrder, its unit) asks
//   occurrenceOf: the latest scheduled time at or before now in the base's zone, due when it is after the base's last occurrence and
//   its resumption, inside its dates and not paused; an agreement the base or a line's price names must still apply at that time
//   (PriceResolver.js agreementApplies) or the occurrence fails, never repriced. Under the base's lock it makes one order for an
//   occurrence (recurOccurrenceDate on the order, so the job and an operator's retry answer the same order), cloned with
//   copyPayment=false and placed through place#Order, so the seller's approval setting and every placement rule apply; with no
//   payment copied the order waits to be approved like any sales order, and auto-invoice bills only an approved part. A base that
//   fails is named in the log and on the base (recurFailureDate, recurFailureMessage) and the next base runs (runOccurrence).
// - Access (SalesAccess.js recurrenceOf): SALES_RECURRENCE_MANAGE keeps the bases of the scope's organizations, SALES_TEAM_VIEW reads
//   them; another organization's answers as missing. Auto-invoice needs the finance right (RECEIVABLE_EDIT) when it is turned on.
//   Every change names the base's revision (recurRevision: REVISION_REQUIRED, REVISION_CHANGED); a retry carries an operation key.
// - Subscriptions in Sales' context (find#SalesSubscriptions): the scope's store contracts (Commerce's and Shop's records, read only)
//   beside the storeless Subscription rows of native orders, with the order, the base and the agreement each came from and whether
//   it is billed; a Sales reader's. add#SubscriptionFollowUp schedules a Commons task on the customer. Lifecycle actions stay with
//   Commerce (COMMERCE_SUBSCRIPTION_MANAGE) and Accounting.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const salesAccess = ec.resource.script("component://mr-mantle/service/mantle/sales/SalesAccess.js")
const prices = () => ec.resource.script("component://mr-mantle/service/mantle/product/PriceResolver.js")
const shop = () => ec.resource.script("component://mr-mantle/service/mantle/product/ShopSubscriptions.js")
const salesSettings = () => ec.resource.script("component://mr-mantle/service/mantle/sales/SalesSettings.js")
const {find, one, rows, denied, call, ms} = lib

const ORDER = "mantle.order.OrderHeader"
const PART = "mantle.order.OrderPart"
const ITEM = "mantle.order.OrderItem"
const PRICE = "mantle.product.ProductPrice"
const CONTRACT = "mantle.product.subscription.StoreRecurringContract"
const SUBSCRIPTION = "mantle.product.subscription.Subscription"
const STORE = "mantle.product.store.ProductStore"
const AGREEMENT = "mantle.party.agreement.Agreement"
const basePurpose = salesAccess.recurringPurpose
// the finance right auto-invoice needs (design §7: "auto-invoice needs finance authority at configuration")
const financePermission = "RECEIVABLE_EDIT"
const states = ["active", "paused", "ended", "failing", "all"]
const frequencies = ["monthly", "weekly", "yearly", "cron"]
const weekDays = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]
const limits = {candidates: 500, choices: 30, steps: 2000}
const wallPattern = "yyyy-MM-dd HH:mm:ss"
const dayMs = 24 * 60 * 60 * 1000
// the windows looked back over for the latest scheduled time: an hour, a day, 40 days, 400 days, about 8 years
const lookBack = [3600 * 1000, dayMs, 40 * dayMs, 400 * dayMs, 3000 * dayMs]

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const flag = value => value === true || value === "true" || value === "Y" || value === "on"
const given = (p, field) => p[field] !== undefined && p[field] !== null
const L = value => ec.l10n.localize(value)
const now = () => ms(ec.user.nowTimestamp)
const partyName = partyId => (partyId ? lib.partyNames([partyId])[partyId] || partyId : "")
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "")
const productName = productId => (productId ? one("mantle.product.Product", {productId})?.productName || productId : "")
const moneyText = (value, currencyUomId) =>
    value == null ? "" : ec.l10n.formatCurrency(ec.l10n.roundCurrency(toDecimal(value), currencyUomId), currencyUomId)

// A moment given as epoch millis, a timestamp, or text in the user's zone (a date alone is its start).
function dateOf(value, label) {
    if (blank(value)) return null
    let millis = null
    if (value instanceof Date || /^-?\d+$/.test(String(value))) millis = ms(value)
    else {
        const trimmed = String(value).trim()
        const parsed = ec.l10n.parseTimestamp(
            /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed + " 00:00:00" : trimmed,
            null,
            null,
            null
        )
        millis = parsed == null ? ms(trimmed) : ms(parsed)
    }
    if (!Number.isFinite(millis)) denied("DATE_INVALID", label + " is not a date")
    return millis
}
function signedIn() {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in to use Sales")
    return salesAccess.scope()
}

// ===== the schedule in the base's zone =====
// The cron functions read an expression in the machine's zone (ec.service.nextCronExecution). A base's cadence is read in its own
// zone: a moment is moved to the instant whose machine wall clock is the base zone's wall clock (toWall), the expression is read
// there, and the result moved back (fromWall). Exact but for the hour a clock change repeats or skips.
const machineZone = () => String(ec.user.machineTimeZone || "UTC")
const zoneOf = base => text(base.recurTimeZone) || machineZone()
function toWall(millis, zone) {
    if (millis == null || zone === machineZone()) return millis
    const wall = ec.l10n.format(new Date(millis), wallPattern, null, zone)
    return ms(ec.l10n.parseTimestamp(wall, wallPattern, null, machineZone()))
}
function fromWall(millis, zone) {
    if (millis == null || zone === machineZone()) return millis
    const wall = ec.l10n.format(new Date(millis), wallPattern, null, machineZone())
    return ms(ec.l10n.parseTimestamp(wall, wallPattern, null, zone))
}
const nextAfter = (cron, wallMillis) => {
    const next = ec.service.nextCronExecution(cron, wallMillis)
    return next == null ? null : Number(next)
}
// The latest scheduled time at or before a moment, in the zone; null when the expression was never due in the last years.
function latestOccurrence(cron, zone, at) {
    const wallAt = toWall(at, zone)
    for (const window of lookBack) {
        let found = nextAfter(cron, wallAt - window)
        if (found == null || found > wallAt) continue
        for (let step = 0; step < limits.steps; step++) {
            const next = nextAfter(cron, found)
            if (next == null || next > wallAt) break
            found = next
        }
        return fromWall(found, zone)
    }
    return null
}
// The first scheduled time after a moment, in the zone.
function nextOccurrence(cron, zone, after) {
    return fromWall(nextAfter(cron, toWall(after, zone)), zone)
}
// The moment no occurrence at or before is ordered again: the last occurrence ordered or the resumption after a pause.
function anchorOf(base) {
    const moments = [ms(base.lastOrderedDate), ms(base.recurResumedDate)].filter(value => value != null)
    return moments.length ? Math.max(...moments) : null
}
// Whether the base is due, and for which occurrence (the worker's guards): {due, occurrenceDate, reason, message}. A base without
// Sales' fields (one made before Sales) is due as the native worker had it: its latest scheduled time after its last order.
function occurrenceOf(base, at = now()) {
    const answer = (reason, message, occurrenceDate = null) => ({due: false, occurrenceDate, reason, message})
    if (!base || !base.recurCronExpression) return answer("NOT_RECURRING", "Not a recurring order")
    if (base.recurPausedDate) return answer("PAUSED", "Order " + base.orderId + " is paused")
    const from = ms(base.recurFromDate)
    const thru = ms(base.recurThruDate)
    if (thru != null && thru <= at) return answer("ENDED", "Order " + base.orderId + " ended its recurrence")
    if (from != null && from > at) return answer("NOT_STARTED", "Order " + base.orderId + " starts recurring later")
    let occurrence
    try {
        occurrence = latestOccurrence(String(base.recurCronExpression), zoneOf(base), at)
    } catch (error) {
        return answer("SCHEDULE_INVALID", "Order " + base.orderId + " has a schedule that cannot be read: " + error.message)
    }
    const anchor = anchorOf(base)
    if (occurrence == null || (from != null && occurrence < from) || (anchor != null && occurrence <= anchor))
        return answer("NOT_DUE", "Order " + base.orderId + " is not yet scheduled to reorder")
    return {due: true, occurrenceDate: occurrence, reason: null, message: null}
}
// The agreements whose terms the base's lines are kept under: the one it names and those whose prices its lines took.
function baseAgreementIds(base) {
    const ids = new Set(base.recurAgreementId ? [base.recurAgreementId] : [])
    const priceIds = rows(ITEM, {orderId: base.orderId})
        .map(row => row.productPriceId)
        .filter(Boolean)
    if (priceIds.length)
        for (const row of find(PRICE).condition("productPriceId", "in", priceIds).list())
            if (row.agreementId) ids.add(row.agreementId)
    return Array.from(ids)
}
// Why an occurrence may not be ordered under the base's agreements (the agreement price guard), or null: an agreement no longer
// active, outside its dates at the occurrence, or not the seller's with the customer.
function agreementRefusal(base, occurrenceDate) {
    const part = Array.from(find(PART).condition("orderId", base.orderId).orderBy("orderPartSeqId").list())[0]
    if (!part) return null
    const context = {
        direction: "sale",
        customerPartyId: part.customerPartyId,
        organizationPartyId: part.vendorPartyId,
        validDate: occurrenceDate
    }
    for (const agreementId of baseAgreementIds(base))
        if (!prices().agreementApplies(agreementId, context))
            return (
                "AGREEMENT_INACTIVE: Agreement " +
                agreementId +
                " no longer applies to order " +
                base.orderId +
                " (not active, outside its dates or not with this customer); end the recurrence or keep it under a current agreement"
            )
    return null
}
// The order already made for an occurrence of a base, or null (one order for an occurrence).
function orderForOccurrence(baseOrderId, occurrenceDate) {
    return (
        Array.from(
            find(ORDER)
                .condition("parentOrderId", baseOrderId)
                .condition("recurOccurrenceDate", new Date(occurrenceDate))
                .selectField("orderId")
                .limit(1)
                .list()
        )[0]?.orderId || null
    )
}
// One base's due occurrence ordered (create#RecurringOrder in its own transaction): its order, or its failure recorded on the base
// in a transaction of its own and named in the log, so the caller goes on with the next base.
function runOccurrence(baseOrderId) {
    ec.message.pushErrors()
    let result = {}
    let failure = null
    try {
        result =
            ec.service
                .sync()
                .name("mantle.order.OrderServices.create#RecurringOrder")
                .parameters({baseOrderId})
                .disableAuthz()
                .requireNewTransaction(true)
                .call() || {}
        if (ec.message.hasError()) failure = ec.message.getErrorsString()
    } catch (error) {
        failure = ec.message.hasError() ? ec.message.getErrorsString() : String(error.message || error)
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
    if (failure) {
        const message = String(failure).split("\n")[0].slice(0, 255)
        ec.logger.error("Recurring order " + baseOrderId + " did not make its order: " + message)
        try {
            lib.probe("update#" + ORDER, {
                orderId: baseOrderId,
                recurFailureDate: ec.user.nowTimestamp,
                recurFailureMessage: message
            })
        } catch (error) {
            ec.logger.error("Recurring order " + baseOrderId + ": its failure was not recorded: " + error.message)
        }
        return {orderId: null, failure: message}
    }
    return {orderId: result.orderId || null, failure: null}
}

// ===== a base's row =====
const cronDescription = cron => {
    try {
        return ec.service.getCronDescription(String(cron))
    } catch (_) {
        return String(cron)
    }
}
const zonedText = (millis, zone) => (millis == null ? "" : ec.l10n.format(new Date(millis), "d MMM yyyy HH:mm", null, zone))
function stateOf(base, at = now()) {
    const thru = ms(base.recurThruDate)
    if (thru != null && thru <= at) return "ended"
    if (base.recurPausedDate) return "paused"
    if (base.recurFailureDate) return "failing"
    return "active"
}
const stateTexts = {active: "Active", paused: "Paused", ended: "Ended", failing: "Last run failed"}
// The schedule of a cron expression in the editor's words, where it is one the editor writes: {frequency, dayOfMonth, dayOfWeek,
// month, hourOfDay}; frequency cron otherwise.
function scheduleOf(cron) {
    const fields = String(cron || "")
        .trim()
        .split(/\s+/)
    if (fields.length >= 6 && fields[0] === "0" && fields[1] === "0" && /^\d+$/.test(fields[2])) {
        const hourOfDay = fields[2]
        if (/^(\d+|L)$/.test(fields[3]) && fields[4] === "*" && fields[5] === "?")
            return {frequency: "monthly", dayOfMonth: fields[3], hourOfDay}
        if (fields[3] === "?" && fields[4] === "*" && weekDays.includes(fields[5]))
            return {frequency: "weekly", dayOfWeek: fields[5], hourOfDay}
        if (/^\d+$/.test(fields[3]) && /^\d+$/.test(fields[4]) && fields[5] === "?")
            return {frequency: "yearly", dayOfMonth: fields[3], month: fields[4], hourOfDay}
    }
    return {frequency: "cron"}
}
function lastChildOf(baseOrderId) {
    return (
        Array.from(
            find(ORDER).condition("parentOrderId", baseOrderId).orderBy("-entryDate").orderBy("-orderId").limit(1).list()
        )[0] || null
    )
}
function baseRow(found) {
    const base = found.order
    const zone = zoneOf(base)
    const at = now()
    const state = stateOf(base, at)
    const totalText = moneyText(base.grandTotal ?? 0, base.currencyUomId)
    const anchor = Math.max(anchorOf(base) ?? -Infinity, at, (ms(base.recurFromDate) ?? at) - 1000)
    let nextDate = null
    if (state !== "ended" && state !== "paused")
        try {
            nextDate = nextOccurrence(String(base.recurCronExpression), zone, anchor)
            if (nextDate != null && base.recurThruDate && nextDate >= ms(base.recurThruDate)) nextDate = null
        } catch (_) {
            nextDate = null
        }
    const child = lastChildOf(base.orderId)
    const agreement = base.recurAgreementId ? one(AGREEMENT, {agreementId: base.recurAgreementId}) : null
    const schedule = scheduleOf(base.recurCronExpression)
    return {
        baseOrderId: base.orderId,
        orderName: base.orderName || "",
        organizationPartyId: found.organizationPartyId,
        organizationName: partyName(found.organizationPartyId),
        customerPartyId: found.customerPartyId,
        customerName: partyName(found.customerPartyId),
        recurCronExpression: base.recurCronExpression,
        cadenceText: cronDescription(base.recurCronExpression) + " · " + zone,
        recurTimeZone: zone,
        frequency: schedule.frequency,
        dayOfMonth: schedule.dayOfMonth || null,
        dayOfWeek: schedule.dayOfWeek || null,
        month: schedule.month || null,
        hourOfDay: schedule.hourOfDay || null,
        recurFromDate: base.recurFromDate ? lib.dateText(base.recurFromDate) : null,
        recurThruDate: base.recurThruDate ? lib.dateText(base.recurThruDate) : null,
        intervalText: [lib.dateText(base.recurFromDate), lib.dateText(base.recurThruDate)].filter(Boolean).join(" – "),
        recurAutoInvoice: base.recurAutoInvoice === "Y" ? "Y" : "N",
        recurAgreementId: base.recurAgreementId || null,
        agreementName: agreement ? agreement.description || agreement.agreementId : "",
        nextText: nextDate == null ? "" : zonedText(nextDate, zone),
        lastOrderedText: lib.dateText(base.lastOrderedDate),
        lastChildOrderId: child?.orderId || null,
        lastChildText: child ? child.orderId + " · " + statusText(child.statusId) : "",
        totalText,
        currencyUomId: base.currencyUomId,
        state,
        stateText: L(stateTexts[state]),
        failureText: base.recurFailureDate ? lib.dateText(base.recurFailureDate) + " · " + (base.recurFailureMessage || "") : "",
        legacy: base.orderPurposeEnumId !== basePurpose,
        recurRevision: String(base.recurRevision ?? 1),
        canEdit: found.canEdit,
        canPause: found.canEdit && state !== "ended" && state !== "paused",
        canResume: found.canEdit && state === "paused",
        canEnd: found.canEdit && state !== "ended",
        canRetry: found.canEdit && state !== "ended" && state !== "paused" && occurrenceOf(base, at).due
    }
}

// ===== find#RecurringSalesOrders =====
// RecurrenceList's bases of the scope (or one organization), by state (active, paused, ended, failing, all), customer, agreement and
// text (the base's id or name), newest first, paged.
function findRecurringSalesOrders(p) {
    const userScope = signedIn()
    salesAccess.requireCapability(userScope, "anyRead")
    if (!salesAccess.recurrenceReader(userScope)) denied("PERMISSION_DENIED", "Sales recurrenceManage is required")
    const state = text(p.state) || "active"
    if (!states.includes(state)) denied("STATE_INVALID", "State " + state + " is not a recurrence state")
    if (text(p.organizationPartyId)) salesAccess.requireOrganization(userScope, text(p.organizationPartyId))
    let query = find(ORDER)
        .condition("recurCronExpression", "is-not-null", null)
        .condition("statusId", "OrderApproved")
        .orderBy("-entryDate")
        .orderBy("-orderId")
        .limit(limits.candidates)
    if (text(p.agreementId)) query = query.condition("recurAgreementId", text(p.agreementId))
    if (text(p.text)) {
        const cf = ec.entity.conditionFactory
        const like = "%" + text(p.text).replace(/[\\%_]/g, character => "\\" + character) + "%"
        query = query.condition(
            cf.makeCondition(
                cf.makeCondition("orderId", "like", like).ignoreCase(),
                "or",
                cf.makeCondition("orderName", "like", like).ignoreCase()
            )
        )
    }
    const at = now()
    const list = []
    for (const order of query.list()) {
        const found = salesAccess.recurrenceOf(userScope, order.orderId)
        if (!found) continue
        if (text(p.organizationPartyId) && found.organizationPartyId !== text(p.organizationPartyId)) continue
        if (text(p.customerPartyId) && found.customerPartyId !== text(p.customerPartyId)) continue
        if (state !== "all" && stateOf(order, at) !== state) continue
        list.push(found)
    }
    const page = lib.pageList(list, p, "recurrenceList")
    page.recurrenceList = page.recurrenceList.map(baseRow)
    return page
}

// ===== store#SalesRecurrence =====
// The cron expression of the editor's schedule: monthly on a day (1-28, or L for the last) at an hour, weekly on a day, yearly on a
// day of a month, or a cron expression of its own (seconds first); refused when it cannot be read (SCHEDULE_INVALID).
function cronOf(p) {
    const frequency = text(p.frequency) || "monthly"
    if (!frequencies.includes(frequency)) denied("SCHEDULE_INVALID", "Choose monthly, weekly, yearly or a cron expression")
    const hour = blank(p.hourOfDay) ? 6 : Number(p.hourOfDay)
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) denied("SCHEDULE_INVALID", "The hour is 0 to 23")
    const dayOfMonth = () => {
        const day = text(p.dayOfMonth) || "1"
        if (day === "L") return day
        if (!/^\d+$/.test(day) || Number(day) < 1 || Number(day) > 28)
            denied("SCHEDULE_INVALID", "The day of the month is 1 to 28, or the last day")
        return String(Number(day))
    }
    let cron
    if (frequency === "monthly") cron = "0 0 " + hour + " " + dayOfMonth() + " * ?"
    else if (frequency === "weekly") {
        const day = (text(p.dayOfWeek) || "MON").toUpperCase()
        if (!weekDays.includes(day)) denied("SCHEDULE_INVALID", "Choose a day of the week")
        cron = "0 0 " + hour + " ? * " + day
    } else if (frequency === "yearly") {
        const month = Number(text(p.month) || "1")
        if (!Number.isInteger(month) || month < 1 || month > 12) denied("SCHEDULE_INVALID", "Choose a month")
        cron = "0 0 " + hour + " " + dayOfMonth() + " " + month + " ?"
    } else cron = text(p.recurCronExpression)
    if (!cron) denied("SCHEDULE_INVALID", "Enter the schedule")
    try {
        if (ec.service.nextCronExecution(cron, now()) == null) denied("SCHEDULE_INVALID", "The schedule is never due")
    } catch (error) {
        if (lib.reasonCode(error) === "SCHEDULE_INVALID") throw error
        denied("SCHEDULE_INVALID", "The schedule '" + cron + "' cannot be read: " + error.message)
    }
    return cron
}
function zoneParam(value) {
    const zone = text(value)
    if (!zone) return ec.user.timeZone ? String(ec.user.timeZone) : machineZone()
    if (
        !Array.from(ec.l10n.getAvailableTimeZones() || [])
            .map(String)
            .includes(zone)
    )
        denied("ZONE_INVALID", "Time zone " + zone + " is not known")
    return zone
}
// The agreement a base names: a customer agreement of the scope, of the base's seller with its customer, active (AGREEMENT_INVALID).
function agreementParam(userScope, agreementId, organizationPartyId, customerPartyId) {
    if (!agreementId) return null
    const found = salesAccess.agreementOf(userScope, agreementId)
    const agreement = found?.agreement
    if (
        !agreement ||
        agreement.isTemplate === "Y" ||
        agreement.statusId !== "AgmStActive" ||
        agreement.organizationPartyId !== organizationPartyId ||
        (agreement.otherPartyId && agreement.otherPartyId !== customerPartyId)
    )
        denied("AGREEMENT_INVALID", "Agreement " + agreementId + " is not an active agreement of the seller with this customer")
    return agreement.agreementId
}
function requireRevision(base, value) {
    const current = Number(base.recurRevision ?? 1)
    if (blank(value)) denied("REVISION_REQUIRED", "Reload the recurring order and try again (revision " + current + ")")
    if (Number(value) !== current)
        denied("REVISION_CHANGED", "Recurring order " + base.orderId + " changed; its current revision is " + current)
}
// A write with a reason: the audit log keeps it with each audited field changed (the framework reads <field>_changeReason).
function updateBase(orderId, fields, reason) {
    const parameters = Object.assign({orderId}, fields)
    if (reason) for (const field of Object.keys(fields)) parameters[field + "_changeReason"] = reason
    call("update#" + ORDER, parameters)
}
// A new base from an approved sales order of the scope: a copy with no payments, approved, marked OrpRecurringTemplate, with no
// reservation (update#OrderRecur removes any and refuses a billed or shipped one). The order it came from stays an ordinary order.
// The source order as the caller may repeat it: one they see (SalesAccess.js orderOf), or, for a keeper of recurrence (who sees no
// orders by assignment: the agreement keeper), an approved sales order of an organization of the scope.
function sourceOf(userScope, orderId) {
    const seen = salesAccess.orderOf(userScope, orderId)
    if (seen || !userScope.capabilities.recurrenceManage || !orderId) return seen
    const order = one(ORDER, {orderId: String(orderId)})
    const parts = order ? Array.from(find(PART).condition("orderId", order.orderId).orderBy("orderPartSeqId").list()) : []
    if (!order || order.statusId !== "OrderApproved" || !salesAccess.isSalesOrder(order, parts[0])) return null
    if (!salesAccess.covers(userScope, parts[0].vendorPartyId)) return null
    return {order, part: parts[0], parts, organizationPartyId: parts[0].vendorPartyId, customerPartyId: parts[0].customerPartyId}
}
function makeBase(userScope, sourceOrderId) {
    const source = sourceOf(userScope, sourceOrderId)
    if (!source) denied("RECORD_UNAVAILABLE", "Order " + (sourceOrderId || "") + " is not available")
    if (source.order.statusId !== "OrderApproved")
        denied(
            "ORDER_NOT_APPROVED",
            "Order " + sourceOrderId + " is " + statusText(source.order.statusId) + "; an approved order repeats"
        )
    if (source.parts.some(part => !salesAccess.covers(userScope, part.vendorPartyId)))
        denied("RECORD_UNAVAILABLE", "Order " + sourceOrderId + " is not available")
    const baseOrderId = call("mantle.order.OrderServices.clone#Order", {
        baseOrderId: source.order.orderId,
        copyPayment: false,
        copyContent: false,
        copyNote: false,
        statusId: "OrderApproved",
        orderName: (source.order.orderName || L("Order") + " " + source.order.orderId) + " · " + L("recurring")
    }).orderId
    // no placed or approved date: a base is no order placed, so a reader by those dates never counts it
    call("update#" + ORDER, {orderId: baseOrderId, orderPurposeEnumId: basePurpose})
    return {baseOrderId, organizationPartyId: source.organizationPartyId, customerPartyId: source.customerPartyId}
}
function storeSalesRecurrence(p) {
    const userScope = signedIn()
    salesAccess.requireCapability(userScope, "recurrenceManage")
    const cron = cronOf(p)
    const zone = zoneParam(p.recurTimeZone)
    const from = dateOf(p.recurFromDate, "The start")
    const thru = dateOf(p.recurThruDate, "The end")
    if (from != null && thru != null && thru <= from) denied("DATE_INVALID", "The end is after the start")
    const autoInvoice = flag(p.recurAutoInvoice)
    const reason = text(p.reason)
    let found
    let created = false
    if (text(p.baseOrderId)) {
        found = salesAccess.requireRecurrence(userScope, text(p.baseOrderId), true)
        requireRevision(found.order, p.recurRevision)
    } else {
        const sourceOrderId = text(p.orderId)
        if (!sourceOrderId) denied("ORDER_REQUIRED", "Choose the approved order to repeat")
        // an order made recurring before Sales (no marker) is kept here as it is
        const legacy = salesAccess.recurrenceOf(userScope, sourceOrderId)
        if (legacy) {
            salesAccess.requireRecurrence(userScope, sourceOrderId, true)
            found = legacy
            requireRevision(found.order, p.recurRevision)
        } else {
            const source = makeBase(userScope, sourceOrderId)
            created = true
            found = {
                order: one(ORDER, {orderId: source.baseOrderId}),
                organizationPartyId: source.organizationPartyId,
                customerPartyId: source.customerPartyId,
                canEdit: true
            }
        }
    }
    const base = found.order
    if (autoInvoice && base.recurAutoInvoice !== "Y" && !lib.access.has(financePermission))
        denied("PERMISSION_DENIED", "Billing each order as it is made needs the finance right (" + financePermission + ")")
    const agreementId = given(p, "recurAgreementId")
        ? agreementParam(userScope, text(p.recurAgreementId), found.organizationPartyId, found.customerPartyId)
        : base.recurAgreementId || null
    // the native writer: cadence and auto-invoice, the billed and shipped refusals, reservations removed
    call("mantle.order.OrderServices.update#OrderRecur", {
        orderId: base.orderId,
        recurCronExpression: cron,
        recurAutoInvoice: autoInvoice ? "Y" : "N"
    })
    const revision = created ? 1 : Number(base.recurRevision ?? 1) + 1
    const fields = {
        orderPurposeEnumId: basePurpose,
        recurTimeZone: zone,
        recurFromDate: from == null ? (created ? ec.user.nowTimestamp : base.recurFromDate) : new Date(from),
        recurThruDate: thru == null ? null : new Date(thru),
        recurAgreementId: agreementId,
        recurRevision: revision
    }
    updateBase(base.orderId, fields, reason)
    const row = baseRow(salesAccess.requireRecurrence(userScope, base.orderId))
    return {baseOrderId: base.orderId, recurRevision: String(revision), nextText: row.nextText, created}
}

// ===== change#SalesRecurrence =====
// Pause (the occurrences in the pause are skipped), resume, end (now or at a later date) or retry (the due occurrence ordered now,
// through the worker's unit: one order for an occurrence, so a retry after the job or a double submit answers the same order; keyed
// by an operation).
const operations = ["pause", "resume", "end", "retry"]
function changeSalesRecurrence(p) {
    const userScope = signedIn()
    const found = salesAccess.requireRecurrence(userScope, text(p.baseOrderId), true)
    const operation = text(p.operation)
    if (!operations.includes(operation)) denied("OPERATION_INVALID", "Choose pause, resume, end or retry")
    let op = null
    if (operation === "retry") {
        op = lib.operation(p, "SalesRecurrenceRetry", found.organizationPartyId, {baseOrderId: found.order.orderId})
        const again = lib.previous(op)
        if (again) return again
    }
    // a retry leaves the base unlocked: the worker's unit takes its lock in a transaction of its own
    const base = find(ORDER, {orderId: found.order.orderId})
        .forUpdate(operation !== "retry")
        .one()
    requireRevision(base, p.recurRevision)
    const state = stateOf(base)
    const reason = text(p.reason)
    const revision = Number(base.recurRevision ?? 1) + 1
    if (operation === "pause") {
        if (state === "ended" || state === "paused") denied("STATE_INVALID", "Recurring order " + base.orderId + " is " + state)
        if (!reason) denied("REASON_REQUIRED", "Say why the recurrence is paused")
        updateBase(base.orderId, {recurPausedDate: ec.user.nowTimestamp, recurRevision: revision}, reason)
    } else if (operation === "resume") {
        if (state !== "paused") denied("STATE_INVALID", "Recurring order " + base.orderId + " is not paused")
        updateBase(base.orderId, {recurPausedDate: null, recurResumedDate: ec.user.nowTimestamp, recurRevision: revision}, reason)
    } else if (operation === "end") {
        if (state === "ended") denied("STATE_INVALID", "Recurring order " + base.orderId + " has ended")
        if (!reason) denied("REASON_REQUIRED", "Say why the recurrence ends")
        const endDate = dateOf(p.endDate, "The end") ?? now()
        if (endDate < now() - 60 * 1000) denied("DATE_INVALID", "The end is now or later")
        updateBase(base.orderId, {recurThruDate: new Date(endDate), recurRevision: revision}, reason)
    } else {
        if (state === "ended" || state === "paused") denied("STATE_INVALID", "Recurring order " + base.orderId + " is " + state)
        const due = occurrenceOf(base)
        if (!due.due) denied("NOTHING_DUE", due.message || "Nothing is due for recurring order " + base.orderId)
    }
    // a retry changes no setting of the recurrence, so its revision stays
    const result = {baseOrderId: base.orderId, operation, recurRevision: String(operation === "retry" ? revision - 1 : revision)}
    if (operation === "retry") {
        const run = runOccurrence(base.orderId)
        result.orderId = run.orderId
        result.failure = run.failure
        lib.complete(op, ORDER, run.orderId || base.orderId, result)
    }
    return result
}

// ===== Subscriptions in Sales' context =====
// The storeless Subscription rows of the scope: those of a native order with no store whose seller is an organization of the scope,
// newest first; each with the order, the base it came from and the agreement it is kept under.
function storelessRows(userScope, p) {
    let query = find(SUBSCRIPTION).condition("orderId", "is-not-null", null).orderBy("-fromDate").limit(limits.candidates)
    if (text(p.customerPartyId)) query = query.condition("subscriberPartyId", text(p.customerPartyId))
    const out = []
    const orders = {}
    for (const sub of query.list()) {
        if (!Object.hasOwn(orders, sub.orderId)) {
            const order = one(ORDER, {orderId: sub.orderId})
            const part = order
                ? Array.from(find(PART).condition("orderId", sub.orderId).orderBy("orderPartSeqId").list())[0]
                : null
            const parent = order?.parentOrderId ? one(ORDER, {orderId: order.parentOrderId}) : null
            const base = parent && parent.recurCronExpression ? parent : null
            orders[sub.orderId] =
                order && !order.productStoreId && part && salesAccess.covers(userScope, part.vendorPartyId)
                    ? {order, part, base, agreementIds: baseAgreementIds(base || order)}
                    : null
        }
        const source = orders[sub.orderId]
        if (!source) continue
        if (text(p.organizationPartyId) && source.part.vendorPartyId !== text(p.organizationPartyId)) continue
        if (text(p.agreementId) && !source.agreementIds.includes(text(p.agreementId))) continue
        out.push({sub, source})
    }
    return out
}
function storelessRow(userScope, {sub, source}) {
    const billed =
        find("mantle.order.OrderItemBilling").condition({orderId: sub.orderId, orderItemSeqId: sub.orderItemSeqId}).count() > 0
    const current = shop().accessActive(sub)
    const agreementId = source.agreementIds[0] || null
    const agreement = agreementId ? one(AGREEMENT, {agreementId}) : null
    return {
        rowKey: "S" + sub.subscriptionId,
        kind: "storeless",
        kindText: source.base ? L("Recurring order") : L("Order"),
        subscriptionId: sub.subscriptionId,
        contractId: null,
        customerPartyId: sub.subscriberPartyId,
        customerName: partyName(sub.subscriberPartyId),
        organizationPartyId: source.part.vendorPartyId,
        organizationName: partyName(source.part.vendorPartyId),
        productName: productName(sub.productId),
        storeName: "",
        periodText: [lib.dateText(sub.fromDate), lib.dateText(sub.thruDate)].filter(Boolean).join(" – "),
        renewalText: "",
        billingText: billed ? L("Billed") : L("No billing link"),
        billed,
        accessText: sub.accessRevokedDate ? L("Revoked") : current ? L("Access") : L("No access now"),
        hasAccess: current && !sub.accessRevokedDate,
        orderId: sub.orderId,
        orderVisible: !!salesAccess.orderOf(userScope, sub.orderId),
        baseOrderId: source.base?.orderId || null,
        agreementId,
        agreementName: agreement ? agreement.description || agreementId : ""
    }
}
// The store contracts of the stores whose organization is in the scope (or one store), read only: Commerce keeps them.
function contractRows(userScope, p) {
    let stores = Array.from(find(STORE).list()).filter(
        store => store.organizationPartyId && salesAccess.covers(userScope, store.organizationPartyId)
    )
    if (text(p.organizationPartyId)) stores = stores.filter(store => store.organizationPartyId === text(p.organizationPartyId))
    if (text(p.productStoreId)) stores = stores.filter(store => store.productStoreId === text(p.productStoreId))
    if (!stores.length) return []
    let query = find(CONTRACT)
        .condition(
            "productStoreId",
            "in",
            stores.map(store => store.productStoreId)
        )
        .orderBy("-createdDate")
        .limit(limits.candidates)
    if (text(p.customerPartyId)) query = query.condition("customerPartyId", text(p.customerPartyId))
    const storeOf = Object.fromEntries(stores.map(store => [store.productStoreId, store]))
    return Array.from(query.list()).map(contract => {
        const subs = shop().subscriptionsOf(contract.contractId)
        const hasAccess = subs.some(shop().accessActive)
        const renews = contract.autoRenew === "Y" && shop().renewableStates.includes(contract.stateEnumId)
        const store = storeOf[contract.productStoreId]
        return {
            rowKey: "C" + contract.contractId,
            kind: "store",
            kindText: L("Store contract"),
            subscriptionId: null,
            contractId: contract.contractId,
            customerPartyId: contract.customerPartyId,
            customerName: partyName(contract.customerPartyId),
            organizationPartyId: store.organizationPartyId,
            organizationName: partyName(store.organizationPartyId),
            productName: productName(contract.productId),
            storeName: store.storeName || store.productStoreId,
            periodText: lib.dateText(contract.paidThroughDate)
                ? L("Paid through") + " " + lib.dateText(contract.paidThroughDate)
                : "",
            renewalText: renews
                ? lib.dateText(contract.nextRenewalDate) + " · " + moneyText(contract.priceAmount ?? 0, contract.currencyUomId)
                : "",
            billingText: shop().stateTexts[contract.stateEnumId] || enumText(contract.stateEnumId),
            billed: true,
            accessText: hasAccess ? L("Access") : L("No access now"),
            hasAccess,
            orderId: contract.originOrderId || null,
            orderVisible: contract.originOrderId ? !!salesAccess.orderOf(userScope, contract.originOrderId) : false,
            baseOrderId: null,
            agreementId: null,
            agreementName: ""
        }
    })
}
// find#SalesSubscriptions (Subscriptions in Sales' context): the store contracts and the storeless subscriptions of the scope, by
// kind (all, store, storeless), organization, customer, agreement (storeless only: a store contract names none) and store (store
// contracts only), newest first, paged. A Sales reader's.
function findSalesSubscriptions(p) {
    const userScope = signedIn()
    salesAccess.requireCapability(userScope, "anyRead")
    if (text(p.organizationPartyId)) salesAccess.requireOrganization(userScope, text(p.organizationPartyId))
    const kind = text(p.kind) || "all"
    if (!["all", "store", "storeless"].includes(kind)) denied("KIND_INVALID", "Choose store contracts, storeless or all")
    const list = []
    if (kind !== "storeless" && !text(p.agreementId)) list.push(...contractRows(userScope, p))
    if (kind !== "store" && !text(p.productStoreId))
        list.push(...storelessRows(userScope, p).map(row => storelessRow(userScope, row)))
    const page = lib.pageList(list, p, "subscriptionList")
    page.truncated = list.length >= limits.candidates
    return page
}
// add#SubscriptionFollowUp (Follow up): a Commons task on the customer of a subscription the caller sees, assigned to the caller or a
// person who works for its organization, due when given. Needs SALES_ACCOUNT_EDIT (renewals are account work).
function addSubscriptionFollowUp(p) {
    const userScope = signedIn()
    salesAccess.requireCapability(userScope, "accountEdit")
    let row = null
    if (text(p.contractId)) {
        const contract = one(CONTRACT, {contractId: text(p.contractId)})
        const store = contract ? one(STORE, {productStoreId: contract.productStoreId}) : null
        if (store && salesAccess.covers(userScope, store.organizationPartyId))
            row = {
                customerPartyId: contract.customerPartyId,
                organizationPartyId: store.organizationPartyId,
                label: contract.contractId
            }
    } else if (text(p.subscriptionId)) {
        const sub = one(SUBSCRIPTION, {subscriptionId: text(p.subscriptionId)})
        const order = sub?.orderId ? one(ORDER, {orderId: sub.orderId}) : null
        const part = order ? Array.from(find(PART).condition("orderId", order.orderId).orderBy("orderPartSeqId").list())[0] : null
        if (order && !order.productStoreId && part && salesAccess.covers(userScope, part.vendorPartyId))
            row = {customerPartyId: sub.subscriberPartyId, organizationPartyId: part.vendorPartyId, label: sub.subscriptionId}
    }
    if (!row)
        denied("RECORD_UNAVAILABLE", "Subscription " + (text(p.contractId) || text(p.subscriptionId) || "") + " is not available")
    const workEffortName =
        text(p.workEffortName) || L("Follow up the renewal of") + " " + row.label + " · " + partyName(row.customerPartyId)
    const assignee = text(p.assignToPartyId) || userScope.partyId
    if (!assignee || !salesSettings().worksFor(assignee, row.organizationPartyId))
        denied("OWNER_INVALID", "The follow-up goes to a person who works for the organization")
    const workEffortId = call("mantle.work.TaskServices.create#SimpleTask", {
        workEffortName,
        description: text(p.description),
        estimatedCompletionDate:
            dateOf(p.estimatedCompletionDate, "The due date") == null ? null : new Date(ms(p.estimatedCompletionDate)),
        assignToPartyId: assignee
    }).workEffortId
    if (row.customerPartyId)
        call("mantle.work.WorkEffortServices.link#WorkEffortRecord", {
            workEffortId,
            recordEntityName: "mantle.party.Party",
            recordId: row.customerPartyId
        })
    return {workEffortId}
}

// ===== choices =====
// RecurrenceSettings' order: the approved sales orders of the scope the caller may repeat (sourceOf), newest first, found by id or
// name in the query.
function recurrenceSourceOptions(term, selected) {
    const userScope = salesAccess.scope()
    if (!userScope.capabilities.recurrenceManage) return []
    const cf = ec.entity.conditionFactory
    let query = find(ORDER)
        .condition("statusId", "OrderApproved")
        .condition("recurCronExpression", "is-null", null)
        .orderBy("-entryDate")
        .orderBy("-orderId")
        .limit(200)
    if (text(term)) {
        const like = "%" + text(term).replace(/[\\%_]/g, character => "\\" + character) + "%"
        query = query.condition(
            cf.makeCondition(
                cf.makeCondition("orderId", "like", like).ignoreCase(),
                "or",
                cf.makeCondition("orderName", "like", like).ignoreCase()
            )
        )
    }
    const options = []
    for (const order of query.list()) {
        const source = sourceOf(userScope, order.orderId)
        if (!source) continue
        options.push({
            value: order.orderId,
            label: [order.orderId, partyName(source.customerPartyId), moneyText(order.grandTotal ?? 0, order.currencyUomId)].join(
                " · "
            )
        })
        if (options.length >= limits.choices) break
    }
    if (text(selected) && !options.some(option => option.value === text(selected)) && sourceOf(userScope, text(selected)))
        options.push({value: text(selected), label: text(selected)})
    return options
}

const services = {
    findRecurringSalesOrders,
    storeSalesRecurrence,
    changeSalesRecurrence,
    findSalesSubscriptions,
    addSubscriptionFollowUp
}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(services, op)) throw new Error("Unknown sales recurrence operation " + op)
        return services[op](parameters || {})
    },
    // the worker's guards (OrderServices.create#RecurringOrders and create#RecurringOrder)
    occurrenceOf,
    agreementRefusal,
    orderForOccurrence,
    runOccurrence,
    // Sales.js: RecurrenceSettings' order choice
    recurrenceSourceOptions
})
