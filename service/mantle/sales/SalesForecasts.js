// Sales' forecasts and targets (mantle.sales.ForecastServices, F of IronStone Sales design §12.1; design §8 Forecast and
// TargetAttainment, §9 Targets; impl-sales P18, SAL-FORECAST).
//
// - A forecast is a SalesForecast row keyed by its organization, its internal party (a person, a sales team of the organization or
//   the organization itself), its time period (a Sales or Fiscal period of the organization) and its currency, one row a key. It
//   holds the entered judgement (forecastAmount, bestCaseAmount: store#Forecast, with its product and category allocations,
//   store#ForecastDetail) and the target (quotaAmount and the basis it is measured on: store#Target), and a parent forecast of the
//   same organization, period and currency for the team hierarchy, never a cycle.
// - The calculated measures are read, never stored (get#Forecast): over the opportunities of the key's party and of its descendant
//   forecasts' parties at the as-of date (a person's: those they own; a team's: those on the team or owned by a current member; the
//   organization's: all), a deal counted once whatever its owner or team changes, and only the deals the reader sees
//   (SalesAccess.js assignedOpportunityIds): the open pipeline (qualified open deals expected to close in the period, in the key's
//   currency), the weighted amount (each deal's amount times its probability, the rep's manual one included), open and won monthly
//   recurring revenue, and the won amount (deals closed won in the period). A deal left out is listed with its reason (a lead, no
//   expected close date, no amount, no probability, another currency). Placed sales orders and finalized sales invoices are
//   separate measures by their own dates (placedDate, invoiceDate) and documents, attributed to the order's one representative or
//   team, else unassigned, and only those the reader sees; templates and recurring bases never count (SalesAccess.js
//   orderExcludedPurposes). Nothing is added across currencies, and a parent's entered forecast is never added to its children's.
// - Attainment (get#TargetAttainment) compares each target's quota with the one basis it names, a zero quota with no percentage;
//   orders and invoices with no representative are shown apart.
// - Access (SalesAccess.js forecastOf): a reader sees their own key, a team manager their teams' and members', SALES_TEAM_VIEW the
//   organization's; entering a judgement needs SALES_FORECAST_EDIT (forecastSubmits), a target SALES_TEAM_MANAGE (targetManages).
//   Every write of a stored row names the revision it read (the latest stamp of the row and its details, REVISION_CHANGED).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const salesAccess = ec.resource.script("component://mr-mantle/service/mantle/sales/SalesAccess.js")
const {find, one, rows, denied, call, ms} = lib

const FORECAST = "mantle.sales.forecast.SalesForecast"
const DETAIL = "mantle.sales.forecast.SalesForecastDetail"
const OPPORTUNITY = "mantle.sales.opportunity.SalesOpportunity"
const OPPORTUNITY_PARTY = "mantle.sales.opportunity.SalesOpportunityParty"
const PERIOD = "mantle.party.time.TimePeriod"
const PART_PARTY = "mantle.order.OrderPartParty"
const salesPeriodTypes = ["SalesYear", "SalesQuarter", "SalesMonth"]
const periodTypes = salesPeriodTypes.concat(["FiscalYear", "FiscalQuarter", "FiscalMonth"])
const bases = salesAccess.forecastBases
const basisTexts = {
    SfbWonOpportunity: "Won opportunity value",
    SfbPlacedOrder: "Placed sales order value",
    SfbFinalInvoice: "Finalized sales invoice value"
}
const types = {lead: "SotLead", opportunity: "SotOpportunity"}
const won = "SalesOppWon"
const closedStatuses = [won, "SalesOppLost"]
const orderStatuses = ["OrderPlaced", "OrderProcessing", "OrderApproved", "OrderSent", "OrderCompleted", "OrderHold"]
const invoiceStatuses = ["InvoiceFinalized", "InvoiceSent", "InvoiceAcked", "InvoicePmtRecvd", "InvoiceWriteOff"]
const dealLimit = 2000
const dayMs = 24 * 60 * 60 * 1000

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const flag = value => value === true || value === "true" || value === "Y"
const L = value => ec.l10n.localize(value)
const zero = () => toDecimal(0)
const moneyText = (value, currencyUomId) =>
    value == null ? "" : ec.l10n.formatCurrency(ec.l10n.roundCurrency(toDecimal(value), currencyUomId), currencyUomId)
const percentText = value => (value == null ? "" : Number(String(value)) + " %")
const dayText = value => (value == null || value === "" ? "" : ec.l10n.format(new Date(ms(value)), "d MMM yyyy"))
const partyName = partyId => (partyId ? lib.partyNames([partyId])[partyId] || partyId : "")
// A query's rows up to the limit; past it the read is refused naming what to narrow, never counted short (a measure over the
// first rows only would undercount without saying so).
function limitedList(query, what) {
    const found = Array.from(query.limit(dealLimit + 1).list())
    if (found.length > dealLimit)
        denied(
            "TOO_MANY_RECORDS",
            "More than " + dealLimit + " " + what + " to count here; choose a shorter period, a team or a person"
        )
    return found
}

// ===== keys, periods and revisions =====
// A forecast's revision: the latest stamp of the row and its details.
function revisionOf(forecast, details = null) {
    const stamps = [ms(forecast.lastUpdatedStamp) ?? 0].concat(
        (details || rows(DETAIL, {salesForecastId: forecast.salesForecastId})).map(row => ms(row.lastUpdatedStamp) ?? 0)
    )
    return String(Math.max(...stamps))
}
function requireRevision(forecast, expected) {
    const current = revisionOf(forecast)
    if (blank(expected) || String(expected) !== current)
        denied("REVISION_CHANGED", "Forecast " + forecast.salesForecastId + " changed; its revision is now " + current)
}
// A calendar day's text after another (yyyy-MM-dd).
function nextDayText(dayText) {
    const [year, month, day] = dayText.split("-").map(Number)
    const next = new Date(Date.UTC(year, month - 1, day + 1))
    return [
        next.getUTCFullYear(),
        String(next.getUTCMonth() + 1).padStart(2, "0"),
        String(next.getUTCDate()).padStart(2, "0")
    ].join("-")
}
const startOfDay = dayText => ms(ec.l10n.parseTimestamp(dayText + " 00:00", "yyyy-MM-dd HH:mm"))
// The period of a key: a Sales or Fiscal TimePeriod of the organization, with its bounds in the user's zone ([from, thru)).
function periodOf(organizationPartyId, timePeriodId) {
    const period = timePeriodId ? one(PERIOD, {timePeriodId: String(timePeriodId)}) : null
    if (!period || period.partyId !== organizationPartyId || !periodTypes.includes(period.timePeriodTypeId))
        denied("PERIOD_INVALID", "Choose a sales period of the organization")
    const fromText = lib.calendarDateText(period.fromDate)
    const thruText = lib.calendarDateText(period.thruDate)
    return {
        period,
        timePeriodId: period.timePeriodId,
        periodName: period.periodName || fromText + " – " + thruText,
        fromText,
        thruText,
        fromMs: startOfDay(fromText),
        thruMs: startOfDay(nextDayText(thruText))
    }
}
// The period a key is for when none is named: the organization's Sales quarter that holds today, else any of its Sales periods that
// does, else none.
function defaultPeriodId(organizationPartyId) {
    const today = ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd")
    const found = Array.from(
        find(PERIOD).condition("partyId", organizationPartyId).condition("timePeriodTypeId", "in", salesPeriodTypes).list()
    ).filter(row => lib.calendarDateText(row.fromDate) <= today && lib.calendarDateText(row.thruDate) >= today)
    const order = type => (salesPeriodTypes.indexOf(type) === 1 ? 0 : 1)
    found.sort((a, b) => order(a.timePeriodTypeId) - order(b.timePeriodTypeId))
    return found[0]?.timePeriodId || null
}
// The currency of a key: the one given (a currency), else the organization's base currency.
function currencyFor(organizationPartyId, currencyUomId) {
    if (!blank(currencyUomId)) {
        const uom = one("moqui.basic.Uom", {uomId: text(currencyUomId)})
        if (!uom || uom.uomTypeEnumId !== "UT_CURRENCY_MEASURE") denied("CURRENCY_INVALID", "Choose a currency")
        return uom.uomId
    }
    let base = null
    try {
        base = lib.probe("mantle.ledger.LedgerServices.find#PartyAcctgPreference", {organizationPartyId}).partyAcctgPreference
            ?.baseCurrencyUomId
    } catch (error) {
        base = null
    }
    if (!base) denied("CURRENCY_REQUIRED", "Choose the forecast's currency")
    return base
}
// An entered amount: null when empty, else a decimal not negative and within the currency's precision.
function amountOf(value, currencyUomId, label) {
    if (blank(value)) return null
    let decimal
    try {
        decimal = toDecimal(String(value).trim())
    } catch (error) {
        denied("AMOUNT_INVALID", label + " is a number")
    }
    if (decimal.compare(0) < 0) denied("AMOUNT_INVALID", label + " is not negative")
    if (!decimal.eq(ec.l10n.roundCurrency(decimal, currencyUomId)))
        denied("CURRENCY_PRECISION", label + " exceeds the currency's precision")
    return decimal
}
const keyRow = key =>
    one(FORECAST, {
        organizationPartyId: key.organizationPartyId,
        internalPartyId: key.internalPartyId,
        timePeriodId: key.timePeriodId,
        currencyUomId: key.currencyUomId
    })
// A key from its parts, each checked: the organization in the scope (else the default one), the internal party a person, team or
// the organization itself (else the caller), the period the organization's (else its current Sales quarter), the currency.
function keyOf(userScope, p) {
    const organizationPartyId = text(p.organizationPartyId) || salesAccess.defaultOrganization(userScope)
    if (!organizationPartyId) denied("ORGANIZATION_DENIED", "Choose the organization")
    salesAccess.requireOrganization(userScope, organizationPartyId)
    const internalPartyId = text(p.internalPartyId) || userScope.partyId
    const kind = salesAccess.forecastSubjectKind(organizationPartyId, internalPartyId)
    if (!kind) denied("SUBJECT_INVALID", "Choose a person, a sales team or the organization itself")
    const timePeriodId = text(p.timePeriodId) || defaultPeriodId(organizationPartyId)
    const period = periodOf(organizationPartyId, timePeriodId)
    return {
        organizationPartyId,
        internalPartyId,
        kind,
        timePeriodId: period.timePeriodId,
        period,
        currencyUomId: currencyFor(organizationPartyId, p.currencyUomId)
    }
}
// The key of a stored forecast the caller sees (SalesAccess.js forecastOf), its period's bounds read.
function storedKey(found) {
    const forecast = found.forecast
    return {
        organizationPartyId: forecast.organizationPartyId,
        internalPartyId: forecast.internalPartyId,
        kind: found.kind,
        timePeriodId: forecast.timePeriodId,
        period: periodOf(forecast.organizationPartyId, forecast.timePeriodId),
        currencyUomId: forecast.currencyUomId
    }
}
// The forecasts below one (its children, theirs and so on), each once.
function descendantsOf(salesForecastId) {
    const seen = new Set([salesForecastId])
    const found = []
    let level = [salesForecastId]
    while (level.length) {
        const next = []
        for (const row of find(FORECAST).condition("parentSalesForecastId", "in", level).list())
            if (!seen.has(row.salesForecastId)) {
                seen.add(row.salesForecastId)
                found.push(row)
                next.push(row.salesForecastId)
            }
        level = next
    }
    return found
}

// ===== the measures =====
// The ids of the deals of the organization owned by a person at a time (their SalesRepresentative row in effect then).
function ownedAt(partyIds, at) {
    if (!partyIds.length) return []
    return Array.from(
        find(OPPORTUNITY_PARTY)
            .condition("partyId", "in", partyIds)
            .condition("roleTypeId", salesAccess.opportunityRoles.owner)
            .conditionDate("fromDate", "thruDate", at)
            .selectField("salesOpportunityId")
            .list()
    ).map(row => row.salesOpportunityId)
}
// The deal ids of a set of subjects at a time, or null for an organization's every deal.
function subjectDealIds(subjects, at) {
    if (subjects.some(subject => subject.kind === "organization")) return null
    const ids = new Set()
    const people = subjects.filter(subject => subject.kind === "person").map(subject => subject.partyId)
    const teams = subjects.filter(subject => subject.kind === "team").map(subject => subject.partyId)
    for (const id of ownedAt(people, at)) ids.add(id)
    if (teams.length) {
        for (const row of find(OPPORTUNITY_PARTY)
            .condition("partyId", "in", teams)
            .condition("roleTypeId", salesAccess.opportunityRoles.team)
            .conditionDate("fromDate", "thruDate", at)
            .selectField("salesOpportunityId")
            .list())
            ids.add(row.salesOpportunityId)
        const members = Array.from(new Set(teams.flatMap(teamPartyId => salesAccess.teamMemberIds(teamPartyId, at))))
        for (const id of ownedAt(members, at)) ids.add(id)
    }
    return Array.from(ids)
}
// Whether an order's or invoice's attribution (its one representative, else its team) belongs to a set of subjects at a time.
function attributedTo(attribution, subjects, at, memberCache) {
    if (subjects.some(subject => subject.kind === "organization")) return true
    if (!attribution.ownerPartyId && !attribution.teamPartyId) return false
    for (const subject of subjects) {
        if (subject.kind === "person" && attribution.ownerPartyId === subject.partyId) return true
        if (subject.kind === "team") {
            if (attribution.teamPartyId === subject.partyId) return true
            const members = (memberCache[subject.partyId] =
                memberCache[subject.partyId] || salesAccess.teamMemberIds(subject.partyId, at))
            if (attribution.ownerPartyId && members.includes(attribution.ownerPartyId)) return true
        }
    }
    return false
}
// The attribution of orders: each order's one representative (none when it has none or more than one) and its team.
function orderAttributions(orderIds) {
    const found = {}
    for (const orderId of orderIds) found[orderId] = {owners: new Set(), teams: new Set()}
    if (orderIds.length)
        for (const row of find(PART_PARTY)
            .condition("orderId", "in", orderIds)
            .condition("roleTypeId", "in", [salesAccess.quoteRoles.owner, salesAccess.quoteRoles.team])
            .list()) {
            const entry = found[row.orderId]
            if (row.roleTypeId === salesAccess.quoteRoles.owner) entry.owners.add(row.partyId)
            else entry.teams.add(row.partyId)
        }
    const out = {}
    for (const [orderId, entry] of Object.entries(found))
        out[orderId] = {
            ownerPartyId: entry.owners.size === 1 ? Array.from(entry.owners)[0] : null,
            teamPartyId: entry.teams.size === 1 ? Array.from(entry.teams)[0] : null
        }
    return out
}
const recurringMonths = enumIds => {
    const ids = Array.from(new Set(enumIds.filter(Boolean)))
    if (!ids.length) return {}
    return Object.fromEntries(
        Array.from(find("moqui.basic.Enumeration").condition("enumId", "in", ids).list()).map(row => [
            row.enumId,
            Number(row.enumCode) || null
        ])
    )
}
// The deal measures of a key's subjects, from the deals the reader sees: open and weighted pipeline, open and won monthly recurring
// revenue, the won amount, and each deal with whether it counts and why not.
function dealMeasures(userScope, key, subjects, at) {
    const out = {
        open: zero(),
        weighted: zero(),
        openMrr: zero(),
        wonMrr: zero(),
        won: zero(),
        openCount: 0,
        wonCount: 0,
        deals: []
    }
    let ids = subjectDealIds(subjects, at)
    const visible = salesAccess.assignedOpportunityIds(userScope)
    if (visible != null) {
        const visibleIds = new Set(visible)
        ids = ids == null ? visible : ids.filter(id => visibleIds.has(id))
    }
    if (ids != null && !ids.length) return out
    const factory = ec.entity.conditionFactory
    const from = new Date(key.period.fromMs)
    const thru = new Date(key.period.thruMs)
    const openStatus = factory.makeCondition(
        [factory.makeCondition("statusId", "is-null", null), factory.makeCondition("statusId", "not-in", closedStatuses)],
        "or"
    )
    let query = find(OPPORTUNITY)
        .condition("organizationPartyId", key.organizationPartyId)
        .condition(
            factory.makeCondition(
                [
                    // a qualified open deal with no expected close date (left out, with its reason)
                    factory.makeCondition(
                        [
                            openStatus,
                            factory.makeCondition("typeEnumId", "equals", types.opportunity),
                            factory.makeCondition("estimatedCloseDate", "is-null", null)
                        ],
                        "and"
                    ),
                    // an open deal or lead expected to close in the period
                    factory.makeCondition(
                        [
                            openStatus,
                            factory.makeCondition("estimatedCloseDate", "greater-equals", from),
                            factory.makeCondition("estimatedCloseDate", "less", thru)
                        ],
                        "and"
                    ),
                    // a deal won in the period
                    factory.makeCondition(
                        [
                            factory.makeCondition("statusId", "equals", won),
                            factory.makeCondition("closedDate", "greater-equals", from),
                            factory.makeCondition("closedDate", "less", thru)
                        ],
                        "and"
                    )
                ],
                "or"
            )
        )
        .orderBy(["estimatedCloseDate", "salesOpportunityId"])
    if (ids != null) query = query.condition("salesOpportunityId", "in", ids)
    const found = limitedList(query, "deals")
    const months = recurringMonths(found.map(row => row.recurringPlanEnumId))
    const owners = {}
    if (found.length)
        for (const row of find(OPPORTUNITY_PARTY)
            .condition(
                "salesOpportunityId",
                "in",
                found.map(row => row.salesOpportunityId)
            )
            .condition("roleTypeId", salesAccess.opportunityRoles.owner)
            .conditionDate("fromDate", "thruDate", at)
            .list())
            owners[row.salesOpportunityId] = row.partyId
    const ownerNames = lib.partyNames(Object.values(owners))
    const stageIds = Array.from(new Set(found.map(row => row.opportunityStageId).filter(Boolean)))
    const stages = stageIds.length
        ? Object.fromEntries(
              Array.from(
                  find("mantle.sales.opportunity.SalesOpportunityStage").condition("opportunityStageId", "in", stageIds).list()
              ).map(row => [row.opportunityStageId, row.description || row.opportunityStageId])
          )
        : {}
    const currency = key.currencyUomId
    const monthly = row => {
        const plan = months[row.recurringPlanEnumId]
        return row.recurringAmount == null || !plan ? null : toDecimal(row.recurringAmount).divide(toDecimal(plan))
    }
    for (const row of found) {
        const isWon = row.statusId === won
        let measure = isWon ? "won" : "open"
        let included = false
        let weightedAmount = null
        let reason = ""
        if (row.typeEnumId === types.lead) reason = L("A lead, not yet qualified")
        else if ((row.currencyUomId || null) !== currency)
            reason = L("In another currency") + (row.currencyUomId ? " (" + row.currencyUomId + ")" : "")
        else if (row.estimatedAmount == null) reason = isWon ? L("Won, with no amount") : L("No amount")
        else if (isWon) {
            included = true
            out.won = out.won.add(toDecimal(row.estimatedAmount))
            out.wonCount++
            const mrr = monthly(row)
            if (mrr) out.wonMrr = out.wonMrr.add(mrr)
        } else if (row.estimatedCloseDate == null) reason = L("No expected close date")
        else {
            included = true
            out.open = out.open.add(toDecimal(row.estimatedAmount))
            out.openCount++
            const mrr = monthly(row)
            if (mrr) out.openMrr = out.openMrr.add(mrr)
            if (row.estimatedProbability == null) reason = L("No probability: counted open, not weighted")
            else {
                weightedAmount = toDecimal(row.estimatedAmount)
                    .multiply(toDecimal(row.estimatedProbability))
                    .divide(toDecimal(100))
                out.weighted = out.weighted.add(weightedAmount)
            }
        }
        out.deals.push({
            salesOpportunityId: row.salesOpportunityId,
            opportunityName: row.opportunityName || row.salesOpportunityId,
            measure,
            measureText: isWon ? L("Won") : L("Open"),
            stageText: stages[row.opportunityStageId] || "",
            ownerName: owners[row.salesOpportunityId] ? ownerNames[owners[row.salesOpportunityId]] || "" : "",
            estimatedAmount: row.estimatedAmount,
            currencyUomId: row.currencyUomId,
            amountText: row.estimatedAmount == null ? "" : moneyText(row.estimatedAmount, row.currencyUomId),
            probabilityText: percentText(row.estimatedProbability),
            manualProbability: row.probabilityModeEnumId === "SpmManual",
            weightedAmount,
            weightedText: weightedAmount == null ? "" : moneyText(weightedAmount, currency),
            closeText: dayText(isWon ? row.closedDate : row.estimatedCloseDate),
            included,
            includedText: included ? (reason ? L("Counted, not weighted") : L("Counted")) : L("Left out"),
            reasonText: reason
        })
    }
    return out
}
// The placed sales orders of a key's subjects in its period and currency, from the orders the reader sees: their total and count,
// and those with no representative or team apart. Templates, recurring bases, open carts and unplaced quotes never count.
function orderMeasures(userScope, key, subjects, at) {
    const out = {amount: zero(), count: 0, unassigned: zero(), unassignedCount: 0, orderIds: []}
    const factory = ec.entity.conditionFactory
    const internal = Array.from(new Set(rows("mantle.party.PartyRole", {roleTypeId: "OrgInternal"}).map(row => row.partyId)))
    let query = find("mantle.order.OrderHeaderAndPart")
        .condition("vendorPartyId", key.organizationPartyId)
        .condition("currencyUomId", key.currencyUomId)
        .condition("statusId", "in", orderStatuses)
        .condition("placedDate", "greater-equals", new Date(key.period.fromMs))
        .condition("placedDate", "less", new Date(key.period.thruMs))
        .condition("customerPartyId", "is-not-null", null)
        .condition("customerPartyId", "not-in", internal)
        .condition(
            factory.makeCondition(
                [
                    factory.makeCondition("orderPurposeEnumId", "is-null", null),
                    factory.makeCondition("orderPurposeEnumId", "not-in", salesAccess.orderExcludedPurposes)
                ],
                "or"
            )
        )
        .selectField("orderId")
        .selectField("grandTotal")
        .distinct(true)
    const visible = salesAccess.assignedOrderIds(userScope)
    if (visible != null) {
        if (!visible.length) return out
        query = query.condition("orderId", "in", visible)
    }
    const totals = {}
    for (const row of limitedList(query, "orders")) totals[row.orderId] = row.grandTotal
    const attributions = orderAttributions(Object.keys(totals))
    const memberCache = {}
    for (const [orderId, total] of Object.entries(totals)) {
        const attribution = attributions[orderId]
        const amount = toDecimal(total ?? 0)
        if (!attribution.ownerPartyId && !attribution.teamPartyId) {
            out.unassigned = out.unassigned.add(amount)
            out.unassignedCount++
        }
        if (!attributedTo(attribution, subjects, at, memberCache)) continue
        out.amount = out.amount.add(amount)
        out.count++
        out.orderIds.push(orderId)
    }
    return out
}
// The finalized sales invoices of a key's subjects in its period and currency: attributed through their order, those of no order
// or of an order with no representative apart; a reader without SALES_TEAM_VIEW sees only the invoices of orders they see.
function invoiceMeasures(userScope, key, subjects, at) {
    const out = {amount: zero(), count: 0, unassigned: zero(), unassignedCount: 0}
    const internal = Array.from(new Set(rows("mantle.party.PartyRole", {roleTypeId: "OrgInternal"}).map(row => row.partyId)))
    const invoices = limitedList(
        find("mantle.account.invoice.Invoice")
            .condition("fromPartyId", key.organizationPartyId)
            .condition("invoiceTypeEnumId", "InvoiceSales")
            .condition("statusId", "in", invoiceStatuses)
            .condition("currencyUomId", key.currencyUomId)
            .condition("invoiceDate", "greater-equals", new Date(key.period.fromMs))
            .condition("invoiceDate", "less", new Date(key.period.thruMs))
            .condition("toPartyId", "not-in", internal)
            .selectField("invoiceId")
            .selectField("invoiceTotal"),
        "invoices"
    )
    if (!invoices.length) return out
    // the orders an invoice bills (OrderItemBilling), each once
    const ordersOf = {}
    for (const row of find("mantle.order.OrderItemBilling")
        .condition(
            "invoiceId",
            "in",
            invoices.map(row => row.invoiceId)
        )
        .condition("orderId", "is-not-null", null)
        .selectField("invoiceId")
        .selectField("orderId")
        .distinct(true)
        .list())
        (ordersOf[row.invoiceId] = ordersOf[row.invoiceId] || new Set()).add(row.orderId)
    const assigned = salesAccess.assignedOrderIds(userScope)
    const visible = assigned == null ? null : new Set(assigned)
    const attributions = orderAttributions(Array.from(new Set(Object.values(ordersOf).flatMap(orderIds => Array.from(orderIds)))))
    const none = {ownerPartyId: null, teamPartyId: null}
    const memberCache = {}
    for (const invoice of invoices) {
        const orderIds = Array.from(ordersOf[invoice.invoiceId] || [])
        // a reader of their own and their team's sees an invoice only when they see every order it bills: its total carries them all
        if (visible != null && (!orderIds.length || orderIds.some(orderId => !visible.has(orderId)))) continue
        // an invoice of several orders is attributed only when they are all attributed alike, else it is unassigned
        const each = orderIds.map(orderId => attributions[orderId] || none)
        const attribution =
            each.length &&
            each.every(found => found.ownerPartyId === each[0].ownerPartyId && found.teamPartyId === each[0].teamPartyId)
                ? each[0]
                : none
        const amount = toDecimal(invoice.invoiceTotal ?? 0)
        if (!attribution.ownerPartyId && !attribution.teamPartyId) {
            out.unassigned = out.unassigned.add(amount)
            out.unassignedCount++
        }
        if (!attributedTo(attribution, subjects, at, memberCache)) continue
        out.amount = out.amount.add(amount)
        out.count++
    }
    return out
}
// The subjects a key's measures read: its own party and those of its descendant forecasts (a parent's roll-up), each once.
function subjectsOf(key, forecast) {
    const subjects = [{kind: key.kind, partyId: key.internalPartyId}]
    if (forecast)
        for (const row of descendantsOf(forecast.salesForecastId)) {
            const kind =
                salesAccess.forecastSubjectKind(row.organizationPartyId, row.internalPartyId) ||
                (one("mantle.party.Person", {partyId: row.internalPartyId || "_NA_"}) ? "person" : null)
            if (kind && !subjects.some(subject => subject.partyId === row.internalPartyId))
                subjects.push({kind, partyId: row.internalPartyId})
        }
    return subjects
}
const asOfOf = p => (blank(p.asOfDate) ? ec.user.nowTimestamp : new Date(ms(p.asOfDate)))
// The actual of a basis for a key's subjects: {amount, count}.
function actualOf(userScope, key, subjects, at, basisEnumId, measured = {}) {
    if (basisEnumId === bases.order) {
        const found = measured.orders || orderMeasures(userScope, key, subjects, at)
        return {amount: found.amount, count: found.count, unassigned: found.unassigned, unassignedCount: found.unassignedCount}
    }
    if (basisEnumId === bases.invoice) {
        const found = measured.invoices || invoiceMeasures(userScope, key, subjects, at)
        return {amount: found.amount, count: found.count, unassigned: found.unassigned, unassignedCount: found.unassignedCount}
    }
    const found = measured.deals || dealMeasures(userScope, key, subjects, at)
    return {amount: found.won, count: found.wonCount, unassigned: null, unassignedCount: 0}
}
// A percentage of a quota, or null for no quota or a zero one.
function percentOf(amount, quota) {
    if (quota == null || toDecimal(quota).isZero() || amount == null) return null
    return Math.round((Number(String(amount)) / Number(String(quota))) * 1000) / 10
}

// ===== get#Forecast =====
function getForecast(p) {
    const userScope = salesAccess.scope()
    salesAccess.requireCapability(userScope, "anyRead")
    // a key that names no period, of an organization with no sales period yet: nothing to show, said so
    if (!text(p.salesForecastId) && !text(p.timePeriodId)) {
        const organizationPartyId = text(p.organizationPartyId) || salesAccess.defaultOrganization(userScope)
        if (organizationPartyId && salesAccess.covers(userScope, organizationPartyId) && !defaultPeriodId(organizationPartyId))
            return {forecastFound: false, noPeriod: true}
    }
    let key
    let stored = null
    if (text(p.salesForecastId)) {
        const found = salesAccess.requireForecast(userScope, text(p.salesForecastId))
        stored = found.forecast
        key = storedKey(found)
    } else {
        key = keyOf(userScope, p)
        stored = keyRow(key)
    }
    if (!salesAccess.forecastSees(userScope, key.organizationPartyId, key.internalPartyId, key.kind))
        denied("RECORD_UNAVAILABLE", "This forecast is not available")
    const at = asOfOf(p)
    const subjects = subjectsOf(key, stored)
    const deals = dealMeasures(userScope, key, subjects, at)
    const orders = orderMeasures(userScope, key, subjects, at)
    const invoices = invoiceMeasures(userScope, key, subjects, at)
    const details = stored ? rows(DETAIL, {salesForecastId: stored.salesForecastId}) : []
    const currency = key.currencyUomId
    const basisEnumId = stored?.basisEnumId || bases.won
    const actual = actualOf(userScope, key, subjects, at, basisEnumId, {deals, orders, invoices})
    const quota = stored?.quotaAmount ?? null
    const parent = stored?.parentSalesForecastId ? one(FORECAST, {salesForecastId: stored.parentSalesForecastId}) : null
    const canSee = row => !!row && salesAccess.forecastSees(userScope, row.organizationPartyId, row.internalPartyId)
    const submits = salesAccess.forecastSubmits(userScope, key.organizationPartyId, key.internalPartyId, key.kind)
    const manages = salesAccess.targetManages(userScope, key.organizationPartyId, key.internalPartyId, key.kind)
    const measure = (measureKey, label, amount, count = null, note = "") => ({
        measureKey,
        label: L(label),
        amount,
        amountText: amount == null ? L("Not set") : moneyText(amount, currency),
        countText: count == null ? "" : String(count),
        note: note ? L(note) : ""
    })
    const forecastPercent = percentOf(stored?.forecastAmount, quota)
    const actualPercent = percentOf(actual.amount, quota)
    const measures = [
        measure("quota", "Quota", quota, null, quota == null ? "No target set" : basisTexts[basisEnumId]),
        measure("open", "Open pipeline", deals.open, deals.openCount, "Qualified open deals expected to close in the period"),
        measure("weighted", "Weighted pipeline", deals.weighted, null, "Each deal's amount times its probability"),
        measure("openMrr", "Open monthly recurring revenue", deals.openMrr),
        measure("wonMrr", "Won monthly recurring revenue", deals.wonMrr),
        measure("forecast", "Submitted forecast", stored?.forecastAmount ?? null, null, "An entered judgement"),
        measure("bestCase", "Best case", stored?.bestCaseAmount ?? null, null, "An entered judgement"),
        measure(
            "won",
            "Won amount",
            deals.won,
            deals.wonCount,
            "Opportunity value closed won in the period; not invoiced revenue"
        ),
        measure("orders", "Placed orders", orders.amount, orders.count, "Sales orders by their placed date"),
        measure("invoices", "Finalized invoices", invoices.amount, invoices.count, "Sales invoices by their invoice date")
    ]
    if (key.kind === "organization" && userScope.capabilities.teamRead) {
        measures.push(measure("unassignedOrders", "Orders with no representative", orders.unassigned, orders.unassignedCount))
        measures.push(
            measure("unassignedInvoices", "Invoices with no representative", invoices.unassigned, invoices.unassignedCount)
        )
    }
    const children = stored
        ? Array.from(find(FORECAST).condition("parentSalesForecastId", stored.salesForecastId).list())
              .filter(row => canSee(row))
              .map(row => ({
                  salesForecastId: row.salesForecastId,
                  subjectName: partyName(row.internalPartyId),
                  quotaText: row.quotaAmount == null ? "" : moneyText(row.quotaAmount, currency),
                  forecastText: row.forecastAmount == null ? L("Not submitted") : moneyText(row.forecastAmount, currency),
                  bestCaseText: row.bestCaseAmount == null ? "" : moneyText(row.bestCaseAmount, currency)
              }))
        : []
    const productIds = details.map(row => row.productId).filter(Boolean)
    const categoryIds = details.map(row => row.productCategoryId).filter(Boolean)
    const products = productIds.length
        ? Object.fromEntries(
              Array.from(find("mantle.product.Product").condition("productId", "in", productIds).list()).map(row => [
                  row.productId,
                  row.productName || row.productId
              ])
          )
        : {}
    const categories = categoryIds.length
        ? Object.fromEntries(
              Array.from(
                  find("mantle.product.category.ProductCategory").condition("productCategoryId", "in", categoryIds).list()
              ).map(row => [row.productCategoryId, row.categoryName || row.productCategoryId])
          )
        : {}
    let allocated = zero()
    const detailList = details.map(row => {
        if (row.amount != null) allocated = allocated.add(toDecimal(row.amount))
        return {
            salesForecastDetailSeqId: row.salesForecastDetailSeqId,
            productId: row.productId || null,
            productCategoryId: row.productCategoryId || null,
            dimensionText: row.productId ? products[row.productId] || row.productId : categories[row.productCategoryId] || "",
            dimensionKindText: row.productId ? L("Product") : L("Category"),
            amount: row.amount,
            amountText: row.amount == null ? "" : moneyText(row.amount, currency),
            quantityText:
                row.quantity == null
                    ? ""
                    : String(Number(String(row.quantity))) + (row.quantityUomId ? " " + row.quantityUomId : "")
        }
    })
    const paged = lib.pageList(deals.deals, p, "dealList", {noLimitCap: dealLimit})
    return Object.assign(
        {
            forecastFound: true,
            noPeriod: false,
            forecast: {
                salesForecastId: stored?.salesForecastId || null,
                organizationPartyId: key.organizationPartyId,
                organizationName: partyName(key.organizationPartyId),
                internalPartyId: key.internalPartyId,
                subjectName: partyName(key.internalPartyId),
                subjectKind: key.kind,
                timePeriodId: key.timePeriodId,
                periodName: key.period.periodName,
                periodText: key.period.fromText + " – " + key.period.thruText,
                currencyUomId: currency,
                basisEnumId,
                basisText: L(basisTexts[basisEnumId]),
                quotaAmount: quota,
                forecastAmount: stored?.forecastAmount ?? null,
                bestCaseAmount: stored?.bestCaseAmount ?? null,
                forecastText: stored?.forecastAmount == null ? L("Not submitted") : moneyText(stored.forecastAmount, currency),
                forecastDateText: stored?.forecastDate ? lib.dateText(stored.forecastDate) : "",
                forecastByName: stored?.forecastByUserId ? userName(stored.forecastByUserId) : "",
                forecastPercentText: forecastPercent == null ? "" : forecastPercent + " %",
                actualText: moneyText(actual.amount, currency),
                actualPercentText: actualPercent == null ? "" : actualPercent + " %",
                parentSalesForecastId: parent && canSee(parent) ? parent.salesForecastId : null,
                parentName: parent && canSee(parent) ? partyName(parent.internalPartyId) : "",
                allocatedText: moneyText(allocated, currency),
                asOfText: lib.dateText(at),
                revision: stored ? revisionOf(stored, details) : null,
                canSubmit: submits,
                canManage: manages
            },
            measures,
            children,
            details: detailList
        },
        paged
    )
}
function userName(userId) {
    const account = one("moqui.security.UserAccount", {userId})
    return account?.partyId ? partyName(account.partyId) : account?.userFullName || userId
}

// ===== store#Forecast =====
// The caller's judgement on a key: forecastAmount and bestCaseAmount, a reason in the audit log. A stored row is named by its id
// and revision; a new key makes the row, refused when it already has one (FORECAST_EXISTS).
function storeForecast(p) {
    const userScope = salesAccess.scope()
    salesAccess.requireCapability(userScope, "forecastEdit")
    let forecast = null
    let key
    if (text(p.salesForecastId)) {
        const found = salesAccess.requireForecast(userScope, text(p.salesForecastId))
        if (!found.canSubmit) denied("PERMISSION_DENIED", "This forecast's judgement is not yours to enter")
        forecast = found.forecast
        requireRevision(forecast, p.expectedRevision)
        key = {currencyUomId: forecast.currencyUomId}
    } else {
        key = keyOf(userScope, p)
        if (!salesAccess.forecastSubmits(userScope, key.organizationPartyId, key.internalPartyId, key.kind))
            denied("PERMISSION_DENIED", "This forecast's judgement is not yours to enter")
        const existing = keyRow(key)
        if (existing) denied("FORECAST_EXISTS", "This key has forecast " + existing.salesForecastId + "; change it there")
    }
    const forecastAmount = amountOf(p.forecastAmount, key.currencyUomId, "The forecast")
    const bestCaseAmount = amountOf(p.bestCaseAmount, key.currencyUomId, "The best case")
    if (forecastAmount == null) denied("AMOUNT_REQUIRED", "Enter the forecast amount")
    if (bestCaseAmount != null && bestCaseAmount.compare(forecastAmount) < 0)
        denied("BEST_CASE_INVALID", "The best case is at least the forecast")
    const reason = text(p.reason)
    const values = {
        forecastAmount,
        bestCaseAmount,
        forecastDate: ec.user.nowTimestamp,
        forecastByUserId: ec.user.userId,
        forecastAmount_changeReason: reason,
        bestCaseAmount_changeReason: reason
    }
    if (forecast) {
        // the allocations reconcile to the judgement
        const allocated = rows(DETAIL, {salesForecastId: forecast.salesForecastId}).reduce(
            (sum, row) => (row.amount == null ? sum : sum.add(toDecimal(row.amount))),
            zero()
        )
        if (allocated.compare(forecastAmount) > 0)
            denied("DETAIL_OVER_FORECAST", "The product and category allocations add up to more than this forecast")
        call("update#" + FORECAST, Object.assign({salesForecastId: forecast.salesForecastId}, values))
        forecast = one(FORECAST, {salesForecastId: forecast.salesForecastId})
    } else {
        const created = call(
            "create#" + FORECAST,
            Object.assign(
                {
                    organizationPartyId: key.organizationPartyId,
                    internalPartyId: key.internalPartyId,
                    timePeriodId: key.timePeriodId,
                    currencyUomId: key.currencyUomId
                },
                values
            )
        )
        forecast = one(FORECAST, {salesForecastId: created.salesForecastId})
    }
    return {salesForecastId: forecast.salesForecastId, revision: revisionOf(forecast)}
}

// ===== store#ForecastDetail =====
// An allocation of a forecast's judgement to a product or a category (one of them), or its removal; the allocations never add up to
// more than the forecast, and a product is never counted twice: directly and through a category it is a member of, or through two
// categories. The product or category is the forecast organization's or a shared one (as Sales' choices offer them).
function categoryProducts(productCategoryId) {
    return rows("mantle.product.category.ProductCategoryMember", {productCategoryId})
        .filter(row => lib.active(row))
        .map(row => row.productId)
}
function storeForecastDetail(p) {
    const userScope = salesAccess.scope()
    salesAccess.requireCapability(userScope, "forecastEdit")
    const found = salesAccess.requireForecast(userScope, text(p.salesForecastId))
    if (!found.canSubmit) denied("PERMISSION_DENIED", "This forecast's judgement is not yours to enter")
    const forecast = found.forecast
    requireRevision(forecast, p.expectedRevision)
    const details = rows(DETAIL, {salesForecastId: forecast.salesForecastId})
    const seqId = text(p.salesForecastDetailSeqId)
    const existing = seqId ? details.find(row => row.salesForecastDetailSeqId === seqId) : null
    if (seqId && !existing) denied("RECORD_UNAVAILABLE", "This allocation is not available")
    if (existing && flag(p.remove)) {
        call("delete#" + DETAIL, {salesForecastId: forecast.salesForecastId, salesForecastDetailSeqId: seqId})
        return {salesForecastDetailSeqId: seqId, revision: revisionOf(one(FORECAST, {salesForecastId: forecast.salesForecastId}))}
    }
    const productId = text(p.productId)
    const productCategoryId = text(p.productCategoryId)
    if (!!productId === !!productCategoryId) denied("DIMENSION_REQUIRED", "Choose a product or a category, not both")
    const owned = row => !!row && [forecast.organizationPartyId, "_NA_"].includes(row.ownerPartyId || "_NA_")
    if (productId && !owned(one("mantle.product.Product", {productId}))) denied("PRODUCT_INVALID", "Choose a product")
    if (productCategoryId && !owned(one("mantle.product.category.ProductCategory", {productCategoryId})))
        denied("CATEGORY_INVALID", "Choose a category")
    const members = {}
    const membersOf = categoryId => (members[categoryId] = members[categoryId] || categoryProducts(categoryId))
    const others = details.filter(row => row !== existing && row.salesForecastDetailSeqId !== seqId)
    for (const other of others) {
        const overlaps = productId
            ? other.productId === productId || (other.productCategoryId && membersOf(other.productCategoryId).includes(productId))
            : other.productCategoryId === productCategoryId ||
              (other.productId && membersOf(productCategoryId).includes(other.productId)) ||
              (other.productCategoryId &&
                  membersOf(other.productCategoryId).some(memberId => membersOf(productCategoryId).includes(memberId)))
        if (overlaps) denied("DETAIL_OVERLAP", "This product is already allocated, directly or through a category")
    }
    const amount = amountOf(p.amount, forecast.currencyUomId, "The amount")
    let quantity = null
    if (!blank(p.quantity)) {
        try {
            quantity = toDecimal(String(p.quantity).trim())
        } catch (error) {
            denied("QUANTITY_INVALID", "The quantity is a number")
        }
        if (quantity.compare(0) < 0) denied("QUANTITY_INVALID", "The quantity is not negative")
    }
    if (amount == null && quantity == null) denied("AMOUNT_REQUIRED", "Enter an amount or a quantity")
    const quantityUomId = quantity == null ? null : text(p.quantityUomId)
    if (quantityUomId && !one("moqui.basic.Uom", {uomId: quantityUomId})) denied("UOM_INVALID", "Choose a unit")
    if (amount != null) {
        if (forecast.forecastAmount == null) denied("FORECAST_REQUIRED", "Submit the forecast before allocating it")
        const allocated = others.reduce((sum, row) => (row.amount == null ? sum : sum.add(toDecimal(row.amount))), amount)
        if (allocated.compare(toDecimal(forecast.forecastAmount)) > 0)
            denied("DETAIL_OVER_FORECAST", "The allocations would add up to more than the forecast")
    }
    const values = {productId, productCategoryId, amount, quantity, quantityUomId}
    let detailSeqId = seqId
    if (existing)
        call(
            "update#" + DETAIL,
            Object.assign({salesForecastId: forecast.salesForecastId, salesForecastDetailSeqId: seqId}, values)
        )
    else
        detailSeqId = call(
            "create#" + DETAIL,
            Object.assign({salesForecastId: forecast.salesForecastId}, values)
        ).salesForecastDetailSeqId
    return {
        salesForecastDetailSeqId: detailSeqId,
        revision: revisionOf(one(FORECAST, {salesForecastId: forecast.salesForecastId}))
    }
}

// ===== store#Target =====
// A key's target: its quota, the basis it is measured on (won by default) and its parent in the team hierarchy (of the same
// organization, period and currency; never a cycle). A new key makes the row, refused when it has one already (DUPLICATE_KEY); a
// stored row is named by its id and revision, and its key does not change.
function storeTarget(p) {
    const userScope = salesAccess.scope()
    salesAccess.requireCapability(userScope, "teamManage")
    let forecast = null
    let key
    if (text(p.salesForecastId)) {
        const found = salesAccess.requireForecast(userScope, text(p.salesForecastId))
        if (!found.canManage) denied("PERMISSION_DENIED", "This target is not yours to set")
        forecast = found.forecast
        requireRevision(forecast, p.expectedRevision)
        key = {
            organizationPartyId: forecast.organizationPartyId,
            timePeriodId: forecast.timePeriodId,
            currencyUomId: forecast.currencyUomId
        }
    } else {
        if (blank(p.internalPartyId)) denied("SUBJECT_INVALID", "Choose a person, a sales team or the organization itself")
        if (blank(p.timePeriodId)) denied("PERIOD_INVALID", "Choose a sales period of the organization")
        key = keyOf(userScope, p)
        if (!salesAccess.targetManages(userScope, key.organizationPartyId, key.internalPartyId, key.kind))
            denied("PERMISSION_DENIED", "This target is not yours to set")
        const existing = keyRow(key)
        if (existing) denied("DUPLICATE_KEY", "This key has forecast " + existing.salesForecastId + "; change its target there")
    }
    const quotaAmount = amountOf(p.quotaAmount, key.currencyUomId, "The quota")
    if (quotaAmount == null) denied("AMOUNT_REQUIRED", "Enter the quota")
    const basisEnumId = text(p.basisEnumId) || forecast?.basisEnumId || bases.won
    if (!Object.values(bases).includes(basisEnumId)) denied("BASIS_INVALID", "Choose what the target is measured on")
    // the parent named, else none with clearParent, else the stored one
    const parentSalesForecastId =
        text(p.parentSalesForecastId) || (flag(p.clearParent) ? null : forecast?.parentSalesForecastId || null)
    if (parentSalesForecastId) {
        const parent = salesAccess.forecastOf(userScope, parentSalesForecastId)?.forecast
        if (
            !parent ||
            parent.organizationPartyId !== key.organizationPartyId ||
            parent.timePeriodId !== key.timePeriodId ||
            parent.currencyUomId !== key.currencyUomId
        )
            denied("PARENT_INVALID", "The parent is a forecast of the same organization, period and currency")
        // the hierarchy runs from the organization through its teams: a parent is the organization's or a team's forecast, never a
        // person's (whose measures would then take in every deal below it), and the organization's own forecast has none
        const parentKind = salesAccess.forecastSubjectKind(parent.organizationPartyId, parent.internalPartyId)
        const ownKind = forecast
            ? salesAccess.forecastSubjectKind(forecast.organizationPartyId, forecast.internalPartyId)
            : key.kind
        if (!["organization", "team"].includes(parentKind) || ownKind === "organization")
            denied("PARENT_INVALID", "A forecast rolls up to its organization's or a sales team's forecast")
        // no cycle: the parent and its ancestors never reach this forecast
        const seen = new Set()
        let at = parent
        while (at) {
            if ((forecast && at.salesForecastId === forecast.salesForecastId) || seen.has(at.salesForecastId))
                denied("HIERARCHY_CYCLE", "A forecast cannot be its own ancestor")
            seen.add(at.salesForecastId)
            at = at.parentSalesForecastId ? one(FORECAST, {salesForecastId: at.parentSalesForecastId}) : null
        }
    }
    const reason = text(p.reason)
    const values = {
        quotaAmount,
        basisEnumId,
        parentSalesForecastId,
        quotaAmount_changeReason: reason,
        basisEnumId_changeReason: reason
    }
    if (forecast) call("update#" + FORECAST, Object.assign({salesForecastId: forecast.salesForecastId}, values))
    else
        forecast = {
            salesForecastId: call(
                "create#" + FORECAST,
                Object.assign(
                    {
                        organizationPartyId: key.organizationPartyId,
                        internalPartyId: key.internalPartyId,
                        timePeriodId: key.timePeriodId,
                        currencyUomId: key.currencyUomId
                    },
                    values
                )
            ).salesForecastId
        }
    const stored = one(FORECAST, {salesForecastId: forecast.salesForecastId})
    return {salesForecastId: stored.salesForecastId, revision: revisionOf(stored)}
}

// ===== find#Targets =====
// Targets' list: the forecasts of an organization (and a period, when named) the caller sees, with their quota, basis, parent and
// entered judgement, by period and party; targets only (a quota set) unless includeForecasts.
function findTargets(p) {
    const userScope = salesAccess.scope()
    salesAccess.requireCapability(userScope, "anyRead")
    const organizationPartyId = text(p.organizationPartyId) || salesAccess.defaultOrganization(userScope)
    if (!organizationPartyId)
        return Object.assign({organizationPartyId: null, periodsFound: false}, lib.pageList([], p, "targetList"))
    salesAccess.requireOrganization(userScope, organizationPartyId)
    let query = find(FORECAST).condition("organizationPartyId", organizationPartyId)
    if (text(p.timePeriodId)) query = query.condition("timePeriodId", text(p.timePeriodId))
    if (!flag(p.includeForecasts)) query = query.condition("quotaAmount", "is-not-null", null)
    const found = limitedList(query, "forecasts").filter(row => !!salesAccess.forecastOf(userScope, row.salesForecastId))
    const periodIds = Array.from(new Set(found.map(row => row.timePeriodId).filter(Boolean)))
    const periods = periodIds.length
        ? Object.fromEntries(
              Array.from(find(PERIOD).condition("timePeriodId", "in", periodIds).list()).map(row => [row.timePeriodId, row])
          )
        : {}
    const byId = Object.fromEntries(found.map(row => [row.salesForecastId, row]))
    const names = lib.partyNames(found.map(row => row.internalPartyId))
    const list = found
        .map(row => {
            const period = periods[row.timePeriodId]
            const parent = row.parentSalesForecastId ? byId[row.parentSalesForecastId] : null
            const kind =
                salesAccess.forecastSubjectKind(row.organizationPartyId, row.internalPartyId) ||
                (one("mantle.party.Person", {partyId: row.internalPartyId || "_NA_"}) ? "person" : null)
            return {
                salesForecastId: row.salesForecastId,
                internalPartyId: row.internalPartyId,
                subjectName: names[row.internalPartyId] || row.internalPartyId,
                subjectKindText: kind === "organization" ? L("Organization") : kind === "team" ? L("Team") : L("Person"),
                timePeriodId: row.timePeriodId,
                periodName: period?.periodName || row.timePeriodId,
                periodFrom: period ? lib.calendarDateText(period.fromDate) : "",
                currencyUomId: row.currencyUomId,
                quotaAmount: row.quotaAmount,
                quotaText: row.quotaAmount == null ? "" : moneyText(row.quotaAmount, row.currencyUomId),
                basisEnumId: row.basisEnumId || bases.won,
                basisText: L(basisTexts[row.basisEnumId || bases.won]),
                parentSalesForecastId: row.parentSalesForecastId || null,
                parentName: parent ? names[parent.internalPartyId] || parent.internalPartyId : "",
                forecastText: row.forecastAmount == null ? L("Not submitted") : moneyText(row.forecastAmount, row.currencyUomId),
                revision: revisionOf(row),
                canManage: salesAccess.targetManages(userScope, row.organizationPartyId, row.internalPartyId, kind || "person")
            }
        })
        .sort((a, b) => b.periodFrom.localeCompare(a.periodFrom) || a.subjectName.localeCompare(b.subjectName))
    return Object.assign(
        {organizationPartyId, periodsFound: periodOptions(organizationPartyId, "", 1).length > 0},
        lib.pageList(list, p, "targetList", {noLimitCap: dealLimit})
    )
}

// ===== get#TargetAttainment =====
// Each target of an organization, period and currency the caller sees (narrowed to one target and those below it, and to a basis,
// when named): its quota, the submitted forecast, the actual on the target's own basis, the variance and the percentage (none for
// a zero quota) and the count of the source records; orders and invoices with no representative apart, for a reader of the
// organization's whole pipeline.
function getTargetAttainment(p) {
    const userScope = salesAccess.scope()
    salesAccess.requireCapability(userScope, "reportRead")
    const organizationPartyId = text(p.organizationPartyId) || salesAccess.defaultOrganization(userScope)
    if (!organizationPartyId) denied("ORGANIZATION_DENIED", "Choose the organization")
    salesAccess.requireOrganization(userScope, organizationPartyId)
    const timePeriodId = text(p.timePeriodId) || defaultPeriodId(organizationPartyId)
    if (!timePeriodId)
        return Object.assign({organizationPartyId, noPeriod: true, unassignedList: []}, lib.pageList([], p, "resultList"))
    const period = periodOf(organizationPartyId, timePeriodId)
    const currencyUomId = currencyFor(organizationPartyId, p.currencyUomId)
    const basisFilter = text(p.basisEnumId)
    if (basisFilter && !Object.values(bases).includes(basisFilter))
        denied("BASIS_INVALID", "Choose what the targets are measured on")
    let candidates = Array.from(
        find(FORECAST)
            .condition("organizationPartyId", organizationPartyId)
            .condition("timePeriodId", period.timePeriodId)
            .condition("currencyUomId", currencyUomId)
            .condition("quotaAmount", "is-not-null", null)
            .list()
    )
    if (text(p.salesForecastId)) {
        const top = salesAccess.requireForecast(userScope, text(p.salesForecastId)).forecast
        const below = new Set([top.salesForecastId].concat(descendantsOf(top.salesForecastId).map(row => row.salesForecastId)))
        candidates = candidates.filter(row => below.has(row.salesForecastId))
    }
    const at = asOfOf(p)
    const names = lib.partyNames(candidates.map(row => row.internalPartyId))
    const unassigned = {}
    const results = []
    for (const row of candidates) {
        const found = salesAccess.forecastOf(userScope, row.salesForecastId)
        if (!found) continue
        const basisEnumId = row.basisEnumId || bases.won
        if (basisFilter && basisEnumId !== basisFilter) continue
        const key = {organizationPartyId, internalPartyId: row.internalPartyId, kind: found.kind, period, currencyUomId}
        const actual = actualOf(userScope, key, subjectsOf(key, row), at, basisEnumId)
        if (actual.unassigned != null) unassigned[basisEnumId] = actual
        const variance = actual.amount.subtract(toDecimal(row.quotaAmount))
        const percent = percentOf(actual.amount, row.quotaAmount)
        results.push({
            salesForecastId: row.salesForecastId,
            subjectName: names[row.internalPartyId] || row.internalPartyId,
            basisEnumId,
            basisText: L(basisTexts[basisEnumId]),
            quotaText: moneyText(row.quotaAmount, currencyUomId),
            forecastText: row.forecastAmount == null ? L("Not submitted") : moneyText(row.forecastAmount, currencyUomId),
            actualAmount: actual.amount,
            actualText: moneyText(actual.amount, currencyUomId),
            varianceText: moneyText(variance, currencyUomId),
            percentText: percent == null ? L("No quota") : percent + " %",
            sourceCount: actual.count
        })
    }
    results.sort((a, b) => a.subjectName.localeCompare(b.subjectName))
    const unassignedList = userScope.capabilities.teamRead
        ? Object.entries(unassigned).map(([basisEnumId, actual]) => ({
              basisText: L(basisTexts[basisEnumId]),
              amountText: moneyText(actual.unassigned, currencyUomId),
              sourceCount: actual.unassignedCount
          }))
        : []
    return Object.assign(
        {
            organizationPartyId,
            organizationName: partyName(organizationPartyId),
            timePeriodId: period.timePeriodId,
            periodName: period.periodName,
            currencyUomId,
            unassignedList
        },
        lib.pageList(results, p, "resultList", {noLimitCap: dealLimit})
    )
}

// ===== ensure#SalesPeriods =====
// An organization's sales periods of a calendar year: its Sales year, quarters and months, each made when the organization has none
// of that type starting on that day, the quarters under the year and the months under their quarter.
function ensureSalesPeriods(p) {
    const userScope = salesAccess.scope()
    if (!userScope.capabilities.teamManage && !userScope.capabilities.configure)
        denied("PERMISSION_DENIED", "Sales periods are added by a sales manager or the Sales administrator")
    const organizationPartyId = text(p.organizationPartyId) || salesAccess.defaultOrganization(userScope)
    if (!organizationPartyId || !salesAccess.isInternal(organizationPartyId))
        denied("ORGANIZATION_DENIED", "Choose the organization")
    salesAccess.requireOrganization(userScope, organizationPartyId)
    const year = Number(text(p.year) || ec.l10n.format(ec.user.nowTimestamp, "yyyy"))
    if (!Number.isInteger(year) || year < 2000 || year > 2100) denied("YEAR_INVALID", "Choose a year")
    const name = partyName(organizationPartyId)
    const pad = number => String(number).padStart(2, "0")
    const lastDay = (y, month) => new Date(Date.UTC(y, month, 0)).getUTCDate()
    let created = 0
    const ensure = (timePeriodTypeId, fromDate, thruDate, periodNum, periodName, parentPeriodId) => {
        const existing = rows(PERIOD, {partyId: organizationPartyId, timePeriodTypeId}).find(
            row => lib.calendarDateText(row.fromDate) === fromDate
        )
        if (existing) return existing.timePeriodId
        created++
        return call("create#" + PERIOD, {
            partyId: organizationPartyId,
            timePeriodTypeId,
            fromDate,
            thruDate,
            periodNum,
            periodName,
            parentPeriodId,
            isClosed: "N"
        }).timePeriodId
    }
    const yearId = ensure("SalesYear", year + "-01-01", year + "-12-31", year, name + " " + year, null)
    for (let quarter = 1; quarter <= 4; quarter++) {
        const firstMonth = (quarter - 1) * 3 + 1
        const quarterId = ensure(
            "SalesQuarter",
            year + "-" + pad(firstMonth) + "-01",
            year + "-" + pad(firstMonth + 2) + "-" + pad(lastDay(year, firstMonth + 2)),
            quarter,
            name + " " + year + " Q" + quarter,
            yearId
        )
        for (let month = firstMonth; month < firstMonth + 3; month++)
            ensure(
                "SalesMonth",
                year + "-" + pad(month) + "-01",
                year + "-" + pad(month) + "-" + pad(lastDay(year, month)),
                month,
                name + " " + year + "-" + pad(month),
                quarterId
            )
    }
    return {createdCount: created, yearPeriodId: yearId}
}

// ===== for Sales' choices =====
// The sales periods of an organization, the latest first, as options.
function periodOptions(organizationPartyId, term = "", limit = 30) {
    const lower = String(term || "").toLowerCase()
    return Array.from(
        find(PERIOD)
            .condition("partyId", organizationPartyId)
            .condition("timePeriodTypeId", "in", periodTypes)
            .orderBy(["-fromDate", "timePeriodTypeId"])
            .limit(200)
            .list()
    )
        .map(row => ({value: row.timePeriodId, label: row.periodName || lib.calendarDateText(row.fromDate)}))
        .filter(option => !lower || option.label.toLowerCase().includes(lower))
        .slice(0, limit)
}
// The parties whose forecasts the caller sees in an organization, as options: the organization, its teams and their members for a
// reader of the organization's pipeline; else themselves and the teams they manage with those teams' members.
function subjectOptions(userScope, organizationPartyId, term = "", limit = 30) {
    if (!organizationPartyId || !salesAccess.covers(userScope, organizationPartyId)) return []
    const ids = []
    const teamIds = userScope.capabilities.teamRead
        ? Array.from(
              new Set(
                  rows("mantle.party.PartyRelationship", {
                      relationshipTypeEnumId: "PrtSalesTeamOf",
                      toPartyId: organizationPartyId
                  })
                      .filter(row => lib.active(row))
                      .map(row => row.fromPartyId)
              )
          )
        : salesAccess
              .managedTeams(userScope.partyId)
              .filter(teamPartyId => salesAccess.teamOrganization(teamPartyId) === organizationPartyId)
    if (userScope.capabilities.teamRead) ids.push(organizationPartyId)
    if (userScope.partyId) ids.push(userScope.partyId)
    for (const teamPartyId of teamIds) ids.push(teamPartyId, ...salesAccess.teamMemberIds(teamPartyId))
    const names = lib.partyNames(ids)
    const lower = String(term || "").toLowerCase()
    return Array.from(new Set(ids))
        .filter(partyId => salesAccess.forecastSees(userScope, organizationPartyId, partyId))
        .map(partyId => ({
            value: partyId,
            label:
                (names[partyId] || partyId) +
                (partyId === organizationPartyId ? " · " + L("organization") : teamIds.includes(partyId) ? " · " + L("team") : "")
        }))
        .filter(option => !lower || option.label.toLowerCase().includes(lower))
        .slice(0, limit)
}
// The forecasts of an organization and period the caller sees, as a target's parent options.
function parentOptions(userScope, organizationPartyId, timePeriodId, term = "", limit = 30) {
    if (!organizationPartyId || !salesAccess.covers(userScope, organizationPartyId)) return []
    let query = find(FORECAST).condition("organizationPartyId", organizationPartyId)
    if (timePeriodId) query = query.condition("timePeriodId", timePeriodId)
    const found = Array.from(query.limit(500).list()).filter(row => !!salesAccess.forecastOf(userScope, row.salesForecastId))
    const names = lib.partyNames(found.map(row => row.internalPartyId))
    const periods = Object.fromEntries(
        found.length
            ? Array.from(
                  find(PERIOD)
                      .condition("timePeriodId", "in", Array.from(new Set(found.map(row => row.timePeriodId))))
                      .list()
              ).map(row => [row.timePeriodId, row.periodName || row.timePeriodId])
            : []
    )
    const lower = String(term || "").toLowerCase()
    return found
        .map(row => ({
            value: row.salesForecastId,
            label:
                (names[row.internalPartyId] || row.internalPartyId) +
                " · " +
                (periods[row.timePeriodId] || "") +
                " · " +
                row.currencyUomId
        }))
        .filter(option => !lower || option.label.toLowerCase().includes(lower))
        .slice(0, limit)
}

const operations = {
    getForecast,
    storeForecast,
    storeForecastDetail,
    storeTarget,
    findTargets,
    getTargetAttainment,
    ensureSalesPeriods
}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown sales forecast operation " + op)
        return operations[op](parameters || {})
    },
    // for Sales' choices, never a service's parameters
    periodOptions,
    subjectOptions,
    parentOptions
})
