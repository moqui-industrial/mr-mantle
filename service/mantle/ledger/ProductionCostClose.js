// Accounting's production cost close (design-accounting ProductionCostClose and CostingPolicies, AC-07; crosscut §3.24, D12,
// R-SA-01, R-SA-11, R-SA-18; impl-manufacturing P15). Manufacturing writes every cost event (ProductionCosts.js); this module
// only allocates and posts them:
// - store#AllocationPolicy and get#AllocationPolicies: the organization's effective-dated ProductionAllocationPolicy (the
//   overhead basis and the co-product method), a change ending the row in effect;
// - preview#CostClose: for a completed run, the absorption of the events not yet in the GL (Dr WIP; Cr applied labor, applied
//   machine and overhead, and the outside-processing accrual, by each event's cost component, so a new kind of labor or
//   machine event is absorbed as it is), the overhead the policy applies, the scrap of issued material moved out of WIP, the
//   co-product split of the run's cost over its output lines and the residual WIP to production variance; after the run's
//   close, the late events alone in adjustment mode. It blocks on unvalued events, time on an unapproved timesheet, a closed
//   period and unmapped accounts;
// - post#CostClose: the previewed close as one AcctgTrans, the events marked posted, a ProductionCostAllocation per line, and
//   (not in adjustment mode) the run closed through transition#ProductionOrder in the same transaction; a retry with the same
//   operation key answers the first post;
// - get#CostClose, return#CostReview and check#ProductionClose (the two period close rows);
// - byproductCost: the cost receive#ProductionOutput takes a by-product at (its co-product share of the frozen estimate).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/AccountingPolicy.js")
const entityLib = lib.lib
const {find, one, rows, call, denied, hash} = lib
const has = permission => entityLib.access.has(permission)

const WORK = "mantle.work.effort.WorkEffort",
    EVENT = "mantle.work.production.ProductionCostEvent",
    ALLOCATION = "mantle.work.production.ProductionCostAllocation",
    POLICY = "mantle.work.production.ProductionAllocationPolicy",
    LINE = "mantle.work.production.ProductionRunLine",
    STANDARD = "mantle.product.cost.ProductStandardCost",
    ASSET = "mantle.product.asset.Asset",
    PRODUCT = "mantle.product.Product",
    TIME = "mantle.work.time.TimeEntry",
    TIMESHEET = "mantle.work.time.Timesheet",
    TRANS = "mantle.ledger.transaction.AcctgTrans"
// what each cost component of an event absorbed at the close credits (design ProductionCostClose rule 3); overhead is the
// close's own, applied on the hours of the events it absorbs
const creditTypes = {
    PrcLabor: "GatLaborApplied",
    PrcMachine: "GatOverheadApplied",
    PrcOverhead: "GatOverheadApplied",
    PrcOutside: "GatOutsideProcessAccrued"
}
// the allocation destinations that move the run's WIP (an output line's share is shown beside them and moves nothing)
const wipDestinations = ["PcdWip", "PcdVariance", "PcdScrap"]
const outputRoles = ["PrlrOutput", "PrlrByproduct"]
const hourFactors = {TF_hr: 1, TF_min: 1 / 60, TF_s: 1 / 3600, TF_ms: 1 / 3600000}
const defaultPolicy = {
    productionAllocationPolicyId: null,
    overheadBasisEnumId: "PobWorkCenterHour",
    coproductMethodEnumId: "PcmQuantity",
    overheadRate: null,
    overheadPercent: null,
    rateUomId: null,
    allowOutputWeights: "N",
    scrapToVariance: "N",
    varianceGlAccountId: null,
    fromDate: null,
    thruDate: null
}
const policyFields = [
    "overheadBasisEnumId",
    "overheadRate",
    "overheadPercent",
    "rateUomId",
    "coproductMethodEnumId",
    "allowOutputWeights",
    "scrapToVariance",
    "varianceGlAccountId"
]

const zero = () => toDecimal(0)
const dec = value => toDecimal(value ?? 0)
const blank = value => value == null || String(value).trim() === ""
const text = value => (value == null ? null : dec(value).compare(0) === 0 ? "0" : String(dec(value).toNumber()))
const negate = value => zero().subtract(dec(value))
const ms = entityLib.ms
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : null)
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : null)
const today = () => entityLib.bookDay(null, ec.user.nowTimestamp)
const production = () => ec.resource.script("component://mr-mantle/service/mantle/work/Production.js")
const payables = () => ec.resource.script("component://mr-mantle/service/mantle/account/Payables.js")

// ===== access =====
// The permission (any of a list) and the organizations the user may work in: every internal organization for a finance
// administrator, else the user's own.
function requireAny(permissions) {
    if (!permissions.some(has)) denied("PERMISSION_DENIED", permissions.join(" or ") + " is required")
}
function organizationIds() {
    if (entityLib.access.systemAdmin() || has("ACCOUNTING_ADMIN"))
        return Array.from(find("mantle.party.PartyRole", {roleTypeId: "OrgInternal"}).selectField("partyId").list()).map(
            row => row.partyId
        )
    const info = ec.user.userId ? call("mantle.party.PartyServices.get#PartyOrganizationInfo") : {}
    return Array.from(info.userOrgIds || [])
}
function organizationOf(p) {
    const ids = organizationIds()
    const org = p.organizationPartyId || (ids.length === 1 ? ids[0] : null)
    if (!org) denied("ORGANIZATION_REQUIRED", "Choose an internal organization")
    if (!ids.includes(org)) denied("ORGANIZATION_DENIED", "Organization " + org + " is not available")
    return org
}
// A production run of the user's organizations (the organization given, when one is), locked when asked.
function runOf(p, lock = false) {
    const run = blank(p.workEffortId) ? null : find(WORK, {workEffortId: p.workEffortId}).forUpdate(lock).one()
    if (
        !run ||
        run.purposeEnumId !== "WepProductionRun" ||
        !run.ownerPartyId ||
        !organizationIds().includes(run.ownerPartyId) ||
        (!blank(p.organizationPartyId) && p.organizationPartyId !== run.ownerPartyId)
    )
        denied("RECORD_UNAVAILABLE", "Production run " + (p.workEffortId || "") + " is not available")
    return run
}

// ===== the allocation policy =====
const current = (row, at) => ms(row.fromDate) <= at && (row.thruDate == null || ms(row.thruDate) > at)
// The organization's policy row in effect at a time, else the default (work-center hours, quantity).
function policyAt(org, at = ec.user.nowTimestamp) {
    const when = ms(at)
    const row = rows(POLICY, {organizationPartyId: org})
        .filter(r => current(r, when))
        .sort((a, b) => ms(a.fromDate) - ms(b.fromDate))
        .at(-1)
    return row ? Object.assign({}, defaultPolicy, entityLib.map(row)) : Object.assign({}, defaultPolicy)
}
function policyRow(row, now, withRates = true) {
    const inEffect = row.productionAllocationPolicyId ? current(row, now) : true
    return {
        productionAllocationPolicyId: row.productionAllocationPolicyId || null,
        organizationPartyId: row.organizationPartyId || null,
        fromDate: row.fromDate || null,
        fromDateText: entityLib.dateText(row.fromDate),
        thruDate: row.thruDate || null,
        thruDateText: entityLib.dateText(row.thruDate),
        inEffect,
        stateText: !row.productionAllocationPolicyId
            ? "Default"
            : inEffect
              ? "In effect"
              : ms(row.fromDate) > now
                ? "Starts " + entityLib.dateText(row.fromDate)
                : "Ended",
        overheadBasisEnumId: row.overheadBasisEnumId,
        overheadBasisText: enumText(row.overheadBasisEnumId),
        overheadRate: withRates ? text(row.overheadRate) : null,
        overheadPercent: withRates ? text(row.overheadPercent) : null,
        rateUomId: withRates ? row.rateUomId || null : null,
        coproductMethodEnumId: row.coproductMethodEnumId,
        coproductMethodText: enumText(row.coproductMethodEnumId),
        allowOutputWeights: row.allowOutputWeights === "Y",
        scrapToVariance: row.scrapToVariance === "Y",
        varianceGlAccountId: withRates ? row.varianceGlAccountId || null : null,
        changeReason: row.changeReason || null
    }
}
// get#AllocationPolicies: the organization's rows, newest first, with the one in effect (or the default); a production
// reader (Manufacturing's ProductionSettings) reads the bases and methods without the rates and the variance account.
function policies(p) {
    requireAny(["ACCOUNTING_VIEW", "ACCOUNTING_GL_POST", "ACCOUNTING_ADMIN", "PRODUCTION_COST_POST", "PRODUCTION_VIEW"])
    const org = organizationOf(p)
    const now = ms(ec.user.nowTimestamp)
    const financial = ["ACCOUNTING_VIEW", "ACCOUNTING_GL_POST", "ACCOUNTING_ADMIN", "PRODUCTION_COST_POST"].some(has)
    const all = rows(POLICY, {organizationPartyId: org}).sort((a, b) => ms(b.fromDate) - ms(a.fromDate))
    const inEffect = all.find(row => current(row, now))
    return {
        organizationPartyId: org,
        policy: policyRow(
            inEffect ? entityLib.map(inEffect) : Object.assign({organizationPartyId: org}, defaultPolicy),
            now,
            financial
        ),
        policyRows: all.map(row => policyRow(entityLib.map(row), now, financial)),
        expectedFromDate: inEffect?.fromDate || null,
        canEdit: has("ACCOUNTING_ADMIN")
    }
}
// store#AllocationPolicy: a new row from fromDate (now when empty, never before now), ending the row in effect then; the
// fields not given keep the previous row's values. The expected from date of the row in effect guards a stale form.
function storePolicy(p) {
    requireAny(["ACCOUNTING_ADMIN"])
    const org = organizationOf(p)
    const why = String(p.changeReason || "").trim()
    if (!why || why.length > 255) denied("CHANGE_REASON_REQUIRED", "Give a change reason of 1–255 characters")
    find("mantle.party.Party", {partyId: org}).forNoKeyUpdate(true).one()
    const now = ms(ec.user.nowTimestamp)
    const all = rows(POLICY, {organizationPartyId: org}).sort((a, b) => ms(a.fromDate) - ms(b.fromDate))
    const inEffect = all.filter(row => current(row, now)).at(-1)
    if (ms(p.expectedFromDate) !== (inEffect ? ms(inEffect.fromDate) : null))
        denied("POLICY_CHANGED", "The allocation policy changed; reload before saving")
    const at = blank(p.fromDate) ? Math.max(now, inEffect ? ms(inEffect.fromDate) + 1 : 0) : ms(p.fromDate)
    if (!Number.isFinite(at)) denied("POLICY_INVALID", "Choose when the policy starts")
    if (at < now - 1000) denied("POLICY_INVALID", "A policy change takes effect now or later")
    if (all.some(row => ms(row.fromDate) === at)) denied("POLICY_INVALID", "A policy already starts at this time")
    const before = all.filter(row => ms(row.fromDate) < at && (row.thruDate == null || ms(row.thruDate) > at)).at(-1)
    const after = all.find(row => ms(row.fromDate) > at)
    const data = Object.fromEntries(policyFields.map(name => [name, before ? (before[name] ?? null) : defaultPolicy[name]]))
    // a field not given (null) keeps its value; an empty one clears it
    for (const name of policyFields) if (p[name] != null) data[name] = blank(p[name]) ? null : p[name]
    for (const flag of ["allowOutputWeights", "scrapToVariance"])
        data[flag] = data[flag] === true || data[flag] === "true" || data[flag] === "Y" ? "Y" : "N"
    data.overheadBasisEnumId = data.overheadBasisEnumId || defaultPolicy.overheadBasisEnumId
    data.coproductMethodEnumId = data.coproductMethodEnumId || defaultPolicy.coproductMethodEnumId
    if (!one("moqui.basic.Enumeration", {enumId: data.overheadBasisEnumId, enumTypeId: "ProductionOverheadBasis"}))
        denied("POLICY_INVALID", "Choose an overhead basis")
    if (!one("moqui.basic.Enumeration", {enumId: data.coproductMethodEnumId, enumTypeId: "ProductionCoproductMethod"}))
        denied("POLICY_INVALID", "Choose a co-product method")
    if (
        data.overheadBasisEnumId === "PobLaborPercent" &&
        (data.overheadPercent == null || dec(data.overheadPercent).compare(0) < 0)
    )
        denied("POLICY_INVALID", "Give the overhead percentage of direct labor")
    if (data.overheadRate != null && dec(data.overheadRate).compare(0) < 0) denied("POLICY_INVALID", "A rate is not negative")
    if (data.overheadRate != null && !data.rateUomId) data.rateUomId = lib.preference(org).baseCurrencyUomId || null
    if (data.varianceGlAccountId) lib.account(org, data.varianceGlAccountId, new Date(at))
    ec.context.putAll(
        Object.fromEntries(["fromDate", "thruDate", ...policyFields, "changeReason"].map(name => [name + "_changeReason", why]))
    )
    // an instant, as ProductionPolicy.js stores its rows' dates
    const fromDate = new Date(at).toISOString()
    if (before) call("update#" + POLICY, {productionAllocationPolicyId: before.productionAllocationPolicyId, thruDate: fromDate})
    const created = call(
        "create#" + POLICY,
        Object.assign({organizationPartyId: org}, data, {
            fromDate,
            thruDate: after ? after.fromDate : null,
            changeReason: why,
            createdByUserId: ec.user.userId,
            createdDate: ec.user.nowTimestamp
        })
    )
    return Object.assign(policies({organizationPartyId: org}), {
        productionAllocationPolicyId: created.productionAllocationPolicyId
    })
}

// ===== accounts =====
function defaultAccount(org, glAccountTypeEnumId) {
    return call("mantle.ledger.LedgerServices.get#DefaultGlAccountByType", {organizationPartyId: org, glAccountTypeEnumId})
        .glAccountId
}
function assetTypeAccount(org, asset) {
    return (
        call("mantle.ledger.AssetAutoPostServices.get#AssetTypeGlAccount", {
            organizationPartyId: org,
            assetTypeEnumId: asset?.assetTypeEnumId || "AstTpInventory",
            classEnumId: asset?.classEnumId || null,
            assetId: asset?.assetId || null
        }).assetTypeGlAccount || null
    )
}
// The accounts of a run's close: its WIP account (the inventory type's, as the stock hooks post it), the applied and accrual
// accounts by type, the variance account (the policy's, else the organization's) and, by asset type, the scrap account.
function accountsOf(org, policy) {
    const accounts = {
        wip: assetTypeAccount(org, null)?.wipAssetGlAccountId || defaultAccount(org, "GatWipInventory"),
        variance: policy.varianceGlAccountId || defaultAccount(org, "GatProductionVariance"),
        byType: {}
    }
    for (const type of new Set(Object.values(creditTypes))) accounts.byType[type] = defaultAccount(org, type)
    return accounts
}
function scrapAccount(org, assetId, policy, accounts) {
    if (policy.scrapToVariance === "Y") return accounts.variance
    const asset = assetId ? one(ASSET, {assetId}) : null
    return assetTypeAccount(org, asset)?.scrapGlAccountId || accounts.variance
}

// ===== the evidence =====
const eventsOf = workEffortId =>
    Array.from(find(EVENT, {workEffortId}).orderBy("eventDate").orderBy("productionCostEventId").list())
const allocationsOf = workEffortId => rows(ALLOCATION, {workEffortId}).filter(row => row.acctgTransId || row.allocatedDate)
// An event a later revision of its source and component follows (a review that valued it, a correction). Revisions are
// deltas, so each valued one counts; this only clears an unvalued or unposted one from blocking the close.
function superseded(event, events) {
    return events.some(
        other =>
            other.sourceEntityName === event.sourceEntityName &&
            other.sourceId === event.sourceId &&
            other.costComponentEnumId === event.costComponentEnumId &&
            Number(other.sourceRevision || 1) > Number(event.sourceRevision || 1)
    )
}
// The run's WIP in the GL: what the stock hooks posted (each event's amount) and what earlier closes allocated to WIP,
// variance and scrap.
function ledgerWip(events, allocations) {
    const posted = events
        .filter(event => event.ledgerStatusEnumId === "PclPosted")
        .reduce((sum, event) => sum.add(dec(event.amount)), zero())
    return allocations
        .filter(row => wipDestinations.includes(row.destinationEnumId))
        .reduce((sum, row) => sum.add(dec(row.allocatedAmount)), posted)
}
// The time on the run and its operations whose timesheet is not approved (labor not yet valued, design Y2): read from
// mantle.work.time directly.
function unapprovedTime(run) {
    const workEffortIds = [
        run.workEffortId,
        ...rows(WORK, {parentWorkEffortId: run.workEffortId}).map(operation => operation.workEffortId)
    ]
    const entries = Array.from(find(TIME).condition("workEffortId", "in", workEffortIds).limit(2000).list())
    const sheets = new Map()
    const statusOf = timesheetId => {
        if (!sheets.has(timesheetId)) sheets.set(timesheetId, one(TIMESHEET, {timesheetId})?.statusId || null)
        return sheets.get(timesheetId)
    }
    return entries.filter(entry => !entry.timesheetId || statusOf(entry.timesheetId) !== "TmshApproved")
}
// A price-variance event of a subcontract bill whose match was unapplied (impl-manufacturing F115), not yet reversed.
function unappliedVariances(events) {
    return events.filter(event => {
        if (event.costEventTypeEnumId !== "PcetOutsideVariance" || event.originalCostEventId) return false
        if (events.some(other => other.originalCostEventId === event.productionCostEventId)) return false
        const invoiceMatchId = String(event.sourceId || "").split("|")[0]
        return one("mantle.account.invoice.InvoiceMatch", {invoiceMatchId})?.statusId === "ImUnapplied"
    })
}
// The hours an event carries (its quantity in a time unit), else null.
function hoursOf(event) {
    const factor = hourFactors[event.quantityUomId]
    return factor == null || event.quantity == null ? null : dec(event.quantity).multiply(toDecimal(factor))
}
// A work center's overhead rate per hour on a day: its approved WorkCenterRate of the overhead component, else none.
function centerRate(facilityId, at) {
    const when = ms(at)
    return (
        rows("mantle.work.production.WorkCenterRate", {facilityId, componentTypeEnumId: "PccOverhead"})
            .filter(row => row.state === "approved" && current(row, when))
            .sort((a, b) => ms(a.fromDate) - ms(b.fromDate))
            .at(-1) || null
    )
}
// The overhead the policy applies on the events this close absorbs (R-SA-18): per work-center hour of each operation's
// machine events (its labor events when the operation has no machine runtime), at the center's overhead rate on the event's
// date, else the policy's rate; or a percentage of the labor; or none.
function overheadOf(run, absorbed, allEvents, policy, currency, warnings) {
    const basis = policy.overheadBasisEnumId
    if (basis === "PobNone") return []
    if (basis === "PobLaborPercent") {
        const percent = dec(policy.overheadPercent)
        return absorbed
            .filter(line => line.costComponentEnumId === "PrcLabor")
            .map(line => ({
                productionCostEventId: line.productionCostEventId,
                operationWorkEffortId: line.operationWorkEffortId,
                basisQuantity: line.amount,
                basisRate: percent,
                amount: entityLib.money(line.amount.multiply(percent).divide(toDecimal(100), 6, "HALF_UP"), currency),
                description: "Overhead " + text(percent) + "% of labor"
            }))
            .filter(row => !row.amount.isZero())
    }
    const machineOps = new Set(
        allEvents
            .filter(event => event.costComponentEnumId === "PrcMachine")
            .map(event => event.operationWorkEffortId || run.workEffortId)
    )
    const out = []
    const missing = new Set()
    for (const line of absorbed) {
        const op = line.operationWorkEffortId || run.workEffortId
        const carries =
            line.costComponentEnumId === "PrcMachine" || (line.costComponentEnumId === "PrcLabor" && !machineOps.has(op))
        if (!carries) continue
        const hours = hoursOf(line.event)
        if (hours == null || hours.isZero()) continue
        const operation = line.operationWorkEffortId ? one(WORK, {workEffortId: line.operationWorkEffortId}) : null
        const facilityId = operation?.facilityId || run.facilityId
        const rate = facilityId ? centerRate(facilityId, line.event.eventDate || ec.user.nowTimestamp) : null
        const rateAmount = rate ? dec(rate.rateAmount) : policy.overheadRate != null ? dec(policy.overheadRate) : null
        if (rateAmount == null) {
            missing.add(facilityId || run.workEffortId)
            continue
        }
        if (rate && rate.priceUomId && currency && rate.priceUomId !== currency) {
            missing.add(facilityId)
            continue
        }
        const amount = entityLib.money(hours.multiply(rateAmount), currency)
        if (amount.isZero()) continue
        out.push({
            productionCostEventId: line.productionCostEventId,
            operationWorkEffortId: line.operationWorkEffortId,
            facilityId,
            basisQuantity: hours,
            basisRate: rateAmount,
            amount,
            description:
                "Overhead " + text(hours) + " h at " + text(rateAmount) + (rate ? " (work center rate)" : " (policy rate)")
        })
    }
    for (const id of missing)
        warnings.push({code: "OVERHEAD_RATE_MISSING", message: "No overhead rate in " + currency + " for work center " + id})
    return out
}
// The sales price of a product in a currency (relative sales value): its list price for customers, in effect now.
function salesPrice(productId, currency) {
    const now = ms(ec.user.nowTimestamp)
    const row = rows("mantle.product.ProductPrice", {productId, priceTypeEnumId: "PptList", pricePurposeEnumId: "PppPurchase"})
        .filter(r => !r.customerPartyId && !r.productStoreId && (!currency || r.priceUomId === currency))
        .filter(r => (ms(r.fromDate) ?? -Infinity) <= now && (r.thruDate == null || ms(r.thruDate) > now))
        .sort((a, b) => ms(a.fromDate) - ms(b.fromDate))
        .at(-1)
    return row?.price == null ? null : dec(row.price)
}
// The weight of each output line under the co-product method: its quantity in the primary output's unit (a line in another
// unit takes none), the BOM output line's fixed share (the primary the rest), or quantity times the sales price; explicit
// weights where the policy allows them. quantityOf(line) is the quantity to weigh (received at the close, the target at a
// receipt). Answers {weights: Map, findings}.
function weightsOf(lines, policy, currency, quantityOf, explicit) {
    const findings = []
    const weights = new Map()
    const primary = lines.find(line => line.lineRoleEnumId === "PrlrOutput") || lines[0]
    if (explicit && Object.keys(explicit).length) {
        if (policy.allowOutputWeights !== "Y")
            findings.push({code: "WEIGHTS_NOT_ALLOWED", message: "The allocation policy does not allow explicit output weights"})
        for (const line of lines) weights.set(line.productionRunLineId, dec(explicit[line.productionRunLineId]))
        return {weights, findings, method: "PcmExplicit"}
    }
    const method = policy.coproductMethodEnumId
    if (method === "PcmFixedShare") {
        let others = zero()
        for (const line of lines.filter(row => row !== primary)) {
            const share = line.bomItemId
                ? one("mantle.product.bom.ProductBomItem", {bomItemId: line.bomItemId})?.allocationShare
                : null
            if (share == null)
                findings.push({
                    code: "SHARE_MISSING",
                    message: "Output line " + line.productionRunLineId + " has no fixed share on its BOM line"
                })
            weights.set(line.productionRunLineId, dec(share))
            others = others.add(dec(share))
        }
        const own = primary?.bomItemId
            ? one("mantle.product.bom.ProductBomItem", {bomItemId: primary.bomItemId})?.allocationShare
            : null
        // a BOM line's share is a fraction of one (Boms.js), so the primary takes what the others leave of one
        if (primary) weights.set(primary.productionRunLineId, own != null ? dec(own) : toDecimal(1).subtract(others))
    } else if (method === "PcmSalesValue") {
        for (const line of lines) {
            const price = salesPrice(line.productId, currency)
            if (price == null)
                findings.push({
                    code: "SALES_VALUE_MISSING",
                    message: "Product " + line.productId + " has no list price in " + currency + " for its sales value"
                })
            weights.set(line.productionRunLineId, price == null ? zero() : price.multiply(quantityOf(line)))
        }
    } else {
        for (const line of lines)
            weights.set(
                line.productionRunLineId,
                (line.stockUomId || null) === (primary?.stockUomId || null) ? quantityOf(line) : zero()
            )
    }
    return {weights, findings, method}
}
// An amount split by weights, rounded to the currency, the last weighted line taking the rest.
function split(amount, lines, weights, currency) {
    const total = lines.reduce((sum, line) => sum.add(dec(weights.get(line.productionRunLineId))), zero())
    if (total.compare(0) <= 0) return null
    const weighted = lines.filter(line => dec(weights.get(line.productionRunLineId)).compare(0) !== 0)
    let left = dec(amount)
    return lines.map(line => {
        const weight = dec(weights.get(line.productionRunLineId))
        const last = line === weighted.at(-1)
        const share = weight.isZero()
            ? zero()
            : last
              ? left
              : entityLib.money(dec(amount).multiply(weight).divide(total, 10, "HALF_UP"), currency)
        left = left.subtract(share)
        return {line, weight, sharePercent: weight.multiply(toDecimal(100)).divide(total, 4, "HALF_UP"), amount: share}
    })
}

// ===== preview#CostClose =====
// The close of a run as of an accounting day: its findings, lines and entries, and the fingerprint post#CostClose takes.
function calculate(p, lock = false) {
    const run = runOf(p, lock)
    const org = run.ownerPartyId
    const mode = run.statusId === "WeClosed" ? "adjustment" : "close"
    const findings = []
    const warnings = []
    const finding = (code, message) => findings.push({code, message})
    const currency = lib.preference(org).baseCurrencyUomId || null
    if (mode === "close" && run.statusId !== "WeComplete")
        finding("RUN_NOT_COMPLETE", "Work order " + run.workEffortId + " is " + statusText(run.statusId) + "; complete it first")
    // the review's proposed day for the close; an adjustment after the close is dated today (an open period, R-SA-11)
    const day = !blank(p.accountingDate)
        ? entityLib.calendarDateText(p.accountingDate)
        : mode === "close" && run.productionCostAccountingDate
          ? entityLib.calendarDateText(run.productionCostAccountingDate)
          : today()
    if (day > today()) finding("DATE_FUTURE", "The cost close cannot be dated in the future")
    const guard = ec.resource.script("component://mr-mantle/service/mantle/ledger/PostingGuard.js")
    const fiscal = guard.fiscal(org, ec.user.nowTimestamp, lock, [], day)
    for (const row of fiscal.findings.filter(row => ["PERIOD_CLOSED", "PERIOD_MISSING"].includes(row.code)))
        finding(row.code, "The fiscal period of " + day + ": " + row.message)
    const policy = policyAt(org, ec.l10n.parseTimestamp(day + " 23:59:59", "yyyy-MM-dd HH:mm:ss"))
    const accounts = accountsOf(org, policy)
    const events = eventsOf(run.workEffortId)
    const allocations = allocationsOf(run.workEffortId)
    // what keeps it from closing: unvalued events (F70, unvalued machine runtime), events their movement did not post, other
    // currencies, time on an unapproved timesheet
    const unvalued = events.filter(event => event.valuationStatusEnumId === "PcvUnvalued" && !superseded(event, events))
    if (unvalued.length)
        finding(
            "UNVALUED_EVENTS",
            unvalued.length + " cost event" + (unvalued.length === 1 ? " has" : "s have") + " no value; value them first"
        )
    const notPosted = events.filter(
        event =>
            event.ledgerStatusEnumId === "PclNotPosted" &&
            event.valuationStatusEnumId === "PcvValued" &&
            !dec(event.amount).isZero() &&
            !superseded(event, events)
    )
    if (notPosted.length) finding("EVENTS_NOT_POSTED", notPosted.length + " stock movement(s) of this run posted nothing")
    const foreign = events.filter(event => event.amountUomId && currency && event.amountUomId !== currency)
    if (foreign.length) finding("CURRENCY_MISMATCH", foreign.length + " cost event(s) are in another currency than " + currency)
    const time = unapprovedTime(run)
    if (time.length)
        finding(
            "TIME_UNAPPROVED",
            time.length + " time entr" + (time.length === 1 ? "y is" : "ies are") + " on a timesheet not approved yet"
        )
    // the events not yet in the GL, by component; the reversal of a variance whose bill match was unapplied (F115)
    const awaiting = events.filter(
        event =>
            event.ledgerStatusEnumId === "PclAwaitingClose" &&
            !event.closeAcctgTransId &&
            event.valuationStatusEnumId === "PcvValued"
    )
    const absorbed = awaiting
        .filter(event => event.costEventTypeEnumId !== "PcetMaterialScrap")
        .map(event => ({
            event,
            productionCostEventId: event.productionCostEventId,
            costComponentEnumId: event.costComponentEnumId,
            operationWorkEffortId: event.operationWorkEffortId || null,
            amount: entityLib.money(dec(event.amount), currency),
            glAccountId: accounts.byType[creditTypes[event.costComponentEnumId]] || null,
            reversal: null
        }))
    for (const event of unappliedVariances(events))
        absorbed.push({
            event,
            productionCostEventId: null,
            costComponentEnumId: event.costComponentEnumId,
            operationWorkEffortId: event.operationWorkEffortId || null,
            amount: entityLib.money(negate(event.amount), currency),
            glAccountId: accounts.byType[creditTypes[event.costComponentEnumId]] || null,
            reversal: {sourceEntityName: event.sourceEntityName, sourceId: event.sourceId, original: event}
        })
    for (const line of absorbed.filter(row => !creditTypes[row.costComponentEnumId]))
        finding("COMPONENT_UNMAPPED", "No account absorbs the " + enumText(line.costComponentEnumId) + " component")
    const scrap = awaiting
        .filter(event => event.costEventTypeEnumId === "PcetMaterialScrap")
        .map(event => ({
            event,
            productionCostEventId: event.productionCostEventId,
            amount: entityLib.money(dec(event.amount), currency),
            glAccountId: scrapAccount(org, event.assetId, policy, accounts)
        }))
    const overhead = overheadOf(run, absorbed, events, policy, currency, warnings).map(row =>
        Object.assign(row, {glAccountId: accounts.byType.GatOverheadApplied})
    )
    // the run's WIP: in the GL before the close, then with the absorption and overhead in and the scrap out
    const before = ledgerWip(events, allocations)
    const sum = list => list.reduce((total, row) => total.add(row.amount), zero())
    const absorbedTotal = sum(absorbed),
        overheadTotal = sum(overhead),
        scrapTotal = sum(scrap)
    const residual = entityLib.money(before.add(absorbedTotal).add(overheadTotal).subtract(scrapTotal), currency)
    // the co-product split of the run's cost over its output lines (in adjustment mode, of the adjustment), each line's
    // variance its share less what its receipts relieved; the variance moves the residual out of WIP
    const lines = production()
        .linesOf(run.workEffortId)
        .filter(line => outputRoles.includes(line.lineRoleEnumId))
    const relievedOf = line =>
        events
            .filter(
                event =>
                    event.costComponentEnumId === "PrcOutput" &&
                    event.productionRunLineId === line.productionRunLineId &&
                    event.ledgerStatusEnumId === "PclPosted"
            )
            .reduce((total, event) => total.subtract(dec(event.amount)), zero())
    const receivedOf = line =>
        events
            .filter(event => event.costComponentEnumId === "PrcOutput" && event.productionRunLineId === line.productionRunLineId)
            .reduce(
                (total, event) =>
                    event.costEventTypeEnumId === "PcetOutputScrap"
                        ? total.subtract(dec(event.quantity))
                        : total.add(dec(event.quantity)),
                zero()
            )
    const anyReceived = lines.some(line => receivedOf(line).compare(0) > 0)
    const weighting = weightsOf(
        lines,
        policy,
        currency,
        line => (anyReceived ? receivedOf(line) : dec(line.stockQuantity)),
        p.outputWeights
    )
    findings.push(...weighting.findings)
    const relievedTotal = lines.reduce((total, line) => total.add(relievedOf(line)), zero())
    const runCost = mode === "close" ? residual.add(relievedTotal) : residual
    const shares = lines.length ? split(runCost, lines, weighting.weights, currency) : null
    const outputRows = (shares || []).map(share => {
        const relieved = mode === "close" ? entityLib.money(relievedOf(share.line), currency) : zero()
        return {
            productionRunLineId: share.line.productionRunLineId,
            lineRoleEnumId: share.line.lineRoleEnumId,
            roleText: share.line.lineRoleEnumId === "PrlrOutput" ? "Output" : "By-product",
            productId: share.line.productId,
            productName: one(PRODUCT, {productId: share.line.productId})?.productName || share.line.productId,
            quantity: text(anyReceived ? receivedOf(share.line) : share.line.stockQuantity),
            stockUomId: share.line.stockUomId || null,
            weight: share.weight,
            sharePercent: share.sharePercent,
            share: share.amount,
            relieved,
            variance: share.amount.subtract(relieved)
        }
    })
    // the variance rows: each output line's, or the residual alone with no weighted line
    const varianceRows = outputRows.length
        ? outputRows.filter(row => !row.variance.isZero())
        : residual.isZero()
          ? []
          : [{productionRunLineId: null, variance: residual}]
    if (!outputRows.length && lines.length && !residual.isZero())
        warnings.push({code: "NO_OUTPUT_WEIGHT", message: "No output line has a weight; the residual goes to variance alone"})
    // the entries: Dr WIP and Cr the applied accounts for the absorption and overhead, Dr scrap and Cr WIP, and the residual
    // between WIP and variance
    const entries = []
    const entry = (glAccountId, amount, description) => {
        if (!amount.isZero()) entries.push({glAccountId, amount, description})
    }
    for (const line of absorbed) {
        entry(accounts.wip, line.amount, enumText(line.costComponentEnumId) + " absorbed")
        entry(line.glAccountId, negate(line.amount), enumText(line.costComponentEnumId) + " applied")
    }
    for (const row of overhead) {
        entry(accounts.wip, row.amount, row.description)
        entry(row.glAccountId, negate(row.amount), row.description)
    }
    for (const row of scrap) {
        entry(row.glAccountId, row.amount, "Scrap of issued material")
        entry(accounts.wip, negate(row.amount), "Scrap of issued material")
    }
    if (!residual.isZero()) {
        entry(accounts.variance, residual, "Production variance")
        entry(accounts.wip, negate(residual), "Production variance")
    }
    // the accounts the posting uses must be active posting accounts of the organization
    const stamp = ec.l10n.parseTimestamp(day + " 12:00:00", "yyyy-MM-dd HH:mm:ss")
    const used = new Set(entries.map(row => row.glAccountId))
    if (used.has(null) || used.has(undefined) || (entries.length && !accounts.wip))
        finding("ACCOUNT_MISSING", "Map the production cost accounts (applied labor, overhead, accrual, variance, WIP)")
    for (const glAccountId of [...used].filter(Boolean).sort())
        try {
            lib.account(org, glAccountId, stamp)
        } catch (error) {
            finding("ACCOUNT_UNAVAILABLE", "Account " + glAccountId + " is not an active posting account of the organization")
        }
    if (mode === "adjustment" && !entries.length && !absorbed.length && !scrap.length)
        finding("NOTHING_TO_ADJUST", "Work order " + run.workEffortId + " has no cost event after its close")
    // the ledger lines netted by account
    const byAccount = new Map()
    for (const row of entries) byAccount.set(row.glAccountId, (byAccount.get(row.glAccountId) || zero()).add(row.amount))
    const ledgerRows = [...byAccount.entries()]
        .filter(([, amount]) => !amount.isZero())
        .map(([glAccountId, amount]) => {
            const account = glAccountId ? one("mantle.ledger.account.GlAccount", {glAccountId}) : null
            return {
                glAccountId,
                accountText: account ? (account.accountCode || glAccountId) + " " + (account.accountName || "") : "Not mapped",
                debitCreditFlag: amount.compare(0) > 0 ? "D" : "C",
                debit: amount.compare(0) > 0 ? amount : null,
                credit: amount.compare(0) < 0 ? negate(amount) : null
            }
        })
        .sort((a, b) => (a.debitCreditFlag === b.debitCreditFlag ? 0 : a.debitCreditFlag === "D" ? -1 : 1))
    const evidence = {
        mode,
        day,
        statusId: run.statusId,
        revision: Number(run.productionRevision || 0),
        policy: policy.productionAllocationPolicyId,
        weights: p.outputWeights || null,
        events: events.map(event => [
            event.productionCostEventId,
            String(event.amount ?? ""),
            event.ledgerStatusEnumId,
            event.valuationStatusEnumId,
            ms(event.lastUpdatedStamp)
        ]),
        allocations: allocations.map(row => row.productionCostAllocationId).sort(),
        time: time.map(entry => entry.timeEntryId),
        entries: ledgerRows.map(row => [row.glAccountId, String(row.debit ?? ""), String(row.credit ?? "")])
    }
    return {
        run,
        org,
        mode,
        day,
        stamp,
        currency,
        policy,
        accounts,
        absorbed,
        overhead,
        scrap,
        outputRows,
        varianceRows,
        ledgerRows,
        findings,
        warnings,
        totals: {before, absorbedTotal, overheadTotal, scrapTotal, residual, runCost},
        inputFingerprint: hash(evidence)
    }
}
// The preview as the screen and post#CostClose's caller read it.
function shape(out) {
    const eventRow = line => ({
        productionCostEventId: line.productionCostEventId,
        reversalOf: line.reversal ? line.reversal.original.productionCostEventId : null,
        eventTypeText: line.reversal ? "Reversal of an unapplied bill match" : enumText(line.event.costEventTypeEnumId),
        componentText: enumText(line.event.costComponentEnumId),
        operationWorkEffortId: line.operationWorkEffortId || null,
        productId: line.event.productId || null,
        quantity: text(line.event.quantity),
        quantityUomId: line.event.quantityUomId || null,
        eventDateText: entityLib.dateText(line.event.eventDate),
        afterClose: line.event.afterClose === "Y",
        amount: text(line.amount),
        glAccountId: line.glAccountId || null
    })
    return {
        workEffortId: out.run.workEffortId,
        organizationPartyId: out.org,
        mode: out.mode,
        modeText: out.mode === "adjustment" ? "Adjustment after the close" : "Cost close",
        statusId: out.run.statusId,
        statusText: statusText(out.run.statusId),
        revision: Number(out.run.productionRevision || 0),
        accountingDate: out.day,
        currencyUomId: out.currency,
        policy: policyRow(out.policy, ms(ec.user.nowTimestamp)),
        absorptionRows: out.absorbed.map(eventRow),
        overheadRows: out.overhead.map(row => ({
            productionCostEventId: row.productionCostEventId,
            operationWorkEffortId: row.operationWorkEffortId || null,
            facilityId: row.facilityId || null,
            basisQuantity: text(row.basisQuantity),
            basisRate: text(row.basisRate),
            amount: text(row.amount),
            description: row.description
        })),
        scrapRows: out.scrap.map(row =>
            Object.assign(eventRow({event: row.event, productionCostEventId: row.productionCostEventId, amount: row.amount}), {
                glAccountId: row.glAccountId
            })
        ),
        outputRows: out.outputRows.map(row =>
            Object.assign({}, row, {
                weight: text(row.weight),
                sharePercent: text(row.sharePercent),
                share: text(row.share),
                relieved: text(row.relieved),
                variance: text(row.variance)
            })
        ),
        ledgerRows: out.ledgerRows.map(row => Object.assign({}, row, {debit: text(row.debit), credit: text(row.credit)})),
        totals: Object.fromEntries(Object.entries(out.totals).map(([name, value]) => [name, text(value)])),
        findings: out.findings,
        warnings: out.warnings,
        blocked: out.findings.length > 0,
        canPost: out.findings.length === 0 && has("PRODUCTION_COST_POST"),
        inputFingerprint: out.inputFingerprint
    }
}
function preview(p) {
    requireAny(["ACCOUNTING_GL_POST", "PRODUCTION_COST_POST"])
    return shape(calculate(p))
}

// ===== post#CostClose =====
function post(p) {
    requireAny(["PRODUCTION_COST_POST"])
    const run0 = runOf(p)
    if (blank(p.inputFingerprint)) denied("PREVIEW_REQUIRED", "Preview the cost close before posting it")
    const request = {
        workEffortId: run0.workEffortId,
        inputFingerprint: p.inputFingerprint,
        accountingDate: p.accountingDate || null
    }
    const op = entityLib.operation(p, "production-cost-close", run0.ownerPartyId, request)
    const first = entityLib.previous(op)
    if (first) return first
    // the organization, then the run: the order every close locks in
    find("mantle.party.Party", {partyId: run0.ownerPartyId}).forNoKeyUpdate(true).one()
    const out = calculate(p, true)
    if (out.inputFingerprint !== p.inputFingerprint)
        denied("STALE_PREVIEW", "The run's costs changed since the preview; preview again")
    if (out.findings.length) denied(out.findings[0].code, out.findings.map(row => row.message).join("; "))
    const {run, org, currency} = out
    const why = String(p.changeReason || "").trim() || (out.mode === "adjustment" ? "Cost adjustment" : "Cost close")
    // the variance reversals of unapplied bill matches are recorded first (P6's one event writer), then absorbed
    for (const line of out.absorbed.filter(row => row.reversal)) {
        const recorded = call("mantle.work.ProductionServices.record#ProductionCostEvent", {
            sourceEntityName: line.reversal.sourceEntityName,
            sourceId: line.reversal.sourceId,
            sourceRevision: Number(line.reversal.original.sourceRevision || 1) + 1
        })
        line.productionCostEventId = recorded.productionCostEventId
    }
    const stamp = out.day === today() ? ec.user.nowTimestamp : out.stamp
    let acctgTransId = null
    if (out.ledgerRows.length) {
        acctgTransId = call("mantle.ledger.LedgerServices.create#AcctgTrans", {
            organizationPartyId: org,
            acctgTransTypeEnumId: "AttManufacturing",
            transactionDate: stamp,
            accountingDate: out.day,
            amountUomId: currency,
            workEffortId: run.workEffortId,
            description:
                (out.mode === "adjustment" ? "Cost adjustment of work order " : "Cost close of work order ") +
                run.workEffortId +
                ": " +
                why
        }).acctgTransId
        for (const row of out.ledgerRows)
            call("mantle.ledger.LedgerServices.create#AcctgTransEntry", {
                acctgTransId,
                glAccountId: row.glAccountId,
                debitCreditFlag: row.debitCreditFlag,
                amount: row.debit || row.credit,
                description: why
            })
        call("mantle.ledger.LedgerServices.post#AcctgTrans", {acctgTransId})
        const posted = one(TRANS, {acctgTransId})
        if (posted?.isPosted !== "Y")
            denied("POSTING_REFUSED", posted?.postingFailureMessage || "The cost close did not post to the ledger")
    }
    const now = ec.user.nowTimestamp
    const adjustment = out.mode === "adjustment" ? "Y" : "N"
    const allocationIds = []
    const allocate = values =>
        allocationIds.push(
            call(
                "create#" + ALLOCATION,
                Object.assign(
                    {
                        workEffortId: run.workEffortId,
                        organizationPartyId: org,
                        productionAllocationPolicyId: out.policy.productionAllocationPolicyId,
                        amountUomId: currency,
                        allocatedDate: now,
                        accountingDate: out.day,
                        operationKey: op.operationKey,
                        acctgTransId,
                        adjustment,
                        createdByUserId: ec.user.userId
                    },
                    values
                )
            ).productionCostAllocationId
        )
    const closed = eventId =>
        call("update#" + EVENT, {
            productionCostEventId: eventId,
            ledgerStatusEnumId: "PclClosePosted",
            closeAcctgTransId: acctgTransId
        })
    for (const line of out.absorbed) {
        allocate({
            productionCostEventId: line.productionCostEventId,
            destinationEnumId: "PcdWip",
            costComponentEnumId: line.costComponentEnumId,
            glAccountId: line.glAccountId,
            allocatedAmount: line.amount,
            description: line.reversal ? "Reversal of an unapplied bill match" : enumText(line.costComponentEnumId) + " absorbed"
        })
        if (line.productionCostEventId) closed(line.productionCostEventId)
        if (line.reversal) closed(line.reversal.original.productionCostEventId)
    }
    for (const row of out.overhead)
        allocate({
            productionCostEventId: row.productionCostEventId,
            destinationEnumId: "PcdWip",
            costComponentEnumId: "PrcOverhead",
            glAccountId: row.glAccountId,
            allocatedAmount: row.amount,
            basisQuantity: row.basisQuantity,
            basisRate: row.basisRate,
            description: row.description
        })
    for (const row of out.scrap) {
        allocate({
            productionCostEventId: row.productionCostEventId,
            destinationEnumId: "PcdScrap",
            costComponentEnumId: "PrcMaterial",
            glAccountId: row.glAccountId,
            allocatedAmount: negate(row.amount),
            description: "Scrap of issued material"
        })
        closed(row.productionCostEventId)
    }
    for (const row of out.outputRows)
        allocate({
            productionRunLineId: row.productionRunLineId,
            destinationEnumId: row.lineRoleEnumId === "PrlrByproduct" ? "PcdByproduct" : "PcdOutput",
            costComponentEnumId: "PrcOutput",
            allocatedAmount: row.share,
            basisQuantity: dec(row.quantity),
            sharePercent: row.sharePercent,
            description: "Share of the run's cost; relieved " + text(row.relieved)
        })
    for (const row of out.varianceRows)
        allocate({
            productionRunLineId: row.productionRunLineId,
            destinationEnumId: "PcdVariance",
            costComponentEnumId: "PrcOutput",
            glAccountId: out.accounts.variance,
            allocatedAmount: negate(row.variance),
            description: "Production variance"
        })
    let transition = null
    if (out.mode === "close") {
        call("update#" + WORK, {
            workEffortId: run.workEffortId,
            productionCostClosedDate: now,
            productionCostCloseTransId: acctgTransId,
            productionAllocationPolicyId: out.policy.productionAllocationPolicyId,
            productionCostReviewStatusId: "PcrClosed"
        })
        transition = call("mantle.work.ProductionServices.transition#ProductionOrder", {
            operationKey: "cc/" + op.operationKey,
            workEffortId: run.workEffortId,
            action: "close",
            expectedRevision: Number(run.productionRevision || 0),
            reason: why
        }).result
    }
    try {
        payables().execute("clearNotices", {topic: "ProductionCostReview", recordEntityName: WORK, recordId: run.workEffortId})
    } catch (error) {
        ec.logger.error("Work order " + run.workEffortId + " cost review notices were not cleared: " + error.message)
    }
    const after = one(WORK, {workEffortId: run.workEffortId})
    const result = {
        resultCode: out.mode === "adjustment" ? "ADJUSTED" : "CLOSED",
        workEffortId: run.workEffortId,
        mode: out.mode,
        acctgTransId,
        productionCostAllocationIds: allocationIds,
        productionAllocationPolicyId: out.policy.productionAllocationPolicyId,
        accountingDate: out.day,
        variance: text(out.totals.residual),
        statusId: after.statusId,
        revision: Number(after.productionRevision || 0),
        transitionResultCode: transition?.resultCode || null
    }
    entityLib.complete(op, acctgTransId ? TRANS : WORK, acctgTransId || run.workEffortId, result)
    return Object.assign(result, {alreadyApplied: false})
}

// ===== get#CostClose =====
// A run's cost close as posted: its date, transaction and policy, and each allocation (amounts only with financial read).
function closeOf(p) {
    requireAny(["ACCOUNTING_VIEW", "ACCOUNTING_GL_POST", "PRODUCTION_COST_POST", "PRODUCTION_VIEW"])
    const run = runOf(p)
    const financial = ["ACCOUNTING_VIEW", "ACCOUNTING_GL_POST", "PRODUCTION_COST_POST"].some(has)
    const allocations = allocationsOf(run.workEffortId).sort((a, b) => ms(a.allocatedDate) - ms(b.allocatedDate))
    const lines = new Map(
        production()
            .linesOf(run.workEffortId)
            .map(line => [line.productionRunLineId, line])
    )
    return {
        workEffortId: run.workEffortId,
        organizationPartyId: run.ownerPartyId,
        statusId: run.statusId,
        statusText: statusText(run.statusId),
        closed: !!run.productionCostClosedDate,
        closedDate: run.productionCostClosedDate || null,
        closedDateText: entityLib.dateText(run.productionCostClosedDate),
        acctgTransId: financial ? run.productionCostCloseTransId || null : null,
        productionAllocationPolicyId: run.productionAllocationPolicyId || null,
        reviewStatusId: run.productionCostReviewStatusId || null,
        reviewStatusText: statusText(run.productionCostReviewStatusId) || "Not requested",
        financialRead: financial,
        allocationRows: allocations.map(row => {
            const line = row.productionRunLineId ? lines.get(row.productionRunLineId) : null
            const out = {
                productionCostAllocationId: row.productionCostAllocationId,
                productionCostEventId: row.productionCostEventId || null,
                productionRunLineId: row.productionRunLineId || null,
                productId: line?.productId || null,
                productName: line ? one(PRODUCT, {productId: line.productId})?.productName || line.productId : null,
                destinationEnumId: row.destinationEnumId,
                destinationText: enumText(row.destinationEnumId),
                componentText: enumText(row.costComponentEnumId),
                sharePercent: text(row.sharePercent),
                basisQuantity: text(row.basisQuantity),
                adjustment: row.adjustment === "Y",
                accountingDate: row.accountingDate || null,
                description: row.description || null
            }
            if (financial)
                Object.assign(out, {
                    allocatedAmount: text(row.allocatedAmount),
                    amountUomId: row.amountUomId || null,
                    glAccountId: row.glAccountId || null,
                    acctgTransId: row.acctgTransId || null
                })
            return out
        })
    }
}

// ===== return#CostReview =====
// Accounting returns a requested review to Manufacturing with a note: the review status PcrReturned, so Manufacturing may
// ask again at the same revision; the notices of the request are marked read.
function returnReview(p) {
    requireAny(["PRODUCTION_COST_POST"])
    const run = runOf(p, true)
    if (run.productionCostReviewStatusId !== "PcrRequested")
        denied("REVIEW_NOT_REQUESTED", "The cost review of work order " + run.workEffortId + " is not requested")
    const note = String(p.note || "").trim()
    if (!note) denied("NOTE_REQUIRED", "Say why the review is returned")
    call("update#" + WORK, {
        workEffortId: run.workEffortId,
        productionCostReviewStatusId: "PcrReturned",
        productionCostReviewNote: note.slice(0, 255)
    })
    try {
        payables().execute("clearNotices", {topic: "ProductionCostReview", recordEntityName: WORK, recordId: run.workEffortId})
    } catch (error) {
        ec.logger.error("Work order " + run.workEffortId + " cost review notices were not cleared: " + error.message)
    }
    return {resultCode: "RETURNED", workEffortId: run.workEffortId, reviewStatusId: "PcrReturned"}
}

// ===== check#ProductionClose =====
// The production rows of the period close checklist: the WIP account at the period's end against the production runs' WIP
// (their cost events and allocations to then), and the runs completed by then and not cost closed, with the closed runs
// that have cost events after their close.
function closeCheck(p) {
    const close = ec.resource.script("component://mr-mantle/service/mantle/ledger/PeriodClose.js")
    const c = close.periodScope(p)
    const afterMs = ms(c.afterStamp)
    const runsOf = statuses =>
        Array.from(
            find(WORK, {purposeEnumId: "WepProductionRun"})
                .condition("ownerPartyId", "in", c.organizations)
                .condition("statusId", "in", statuses)
                .orderBy("workEffortId")
                .limit(2000)
                .list()
        )
    if (p.checkEnumId === "PccProductionCostClose") {
        const items = []
        for (const run of runsOf(["WeComplete"])) {
            if ((ms(run.actualCompletionDate) ?? 0) >= afterMs) continue
            items.push({
                recordKind: "productionCostClose",
                recordId: run.workEffortId,
                text: "Work order " + run.workEffortId + (run.workEffortName ? " " + run.workEffortName : ""),
                detail:
                    run.productionCostReviewStatusId === "PcrRequested"
                        ? "Complete; its cost review is requested"
                        : "Complete; its cost is not closed"
            })
        }
        for (const run of runsOf(["WeClosed"])) {
            const late = eventsOf(run.workEffortId).filter(
                event => event.ledgerStatusEnumId === "PclAwaitingClose" && (ms(event.eventDate) ?? 0) < afterMs
            )
            if (late.length)
                items.push({
                    recordKind: "productionCostClose",
                    recordId: run.workEffortId,
                    text: "Work order " + run.workEffortId + (run.workEffortName ? " " + run.workEffortName : ""),
                    detail: late.length + " cost event(s) after its close: post the adjustment"
                })
        }
        return {count: items.length, items: items.slice(0, 20)}
    }
    if (p.checkEnumId === "PccProductionWip") {
        const items = []
        const valuation = ec.resource.script("component://mr-mantle/service/mantle/product/InventoryValuation.js")
        for (const org of c.organizations) {
            const runs = Array.from(
                find(WORK, {purposeEnumId: "WepProductionRun", ownerPartyId: org}).selectField("workEffortId").limit(5000).list()
            ).map(row => row.workEffortId)
            let runWip = zero()
            const open = []
            for (const workEffortId of runs) {
                const events = eventsOf(workEffortId).filter(event => (ms(event.eventDate) ?? 0) < afterMs)
                const allocations = allocationsOf(workEffortId).filter(row =>
                    row.accountingDate ? String(row.accountingDate) < c.afterDay : ms(row.allocatedDate) < afterMs
                )
                const wip = ledgerWip(events, allocations)
                runWip = runWip.add(wip)
                if (!wip.isZero()) open.push({workEffortId, wip})
            }
            const currency = lib.preference(org).baseCurrencyUomId || null
            const ledger = valuation.tieOut(org, c.afterDay).wipBalance
            const difference = dec(ledger).subtract(runWip)
            if (!entityLib.money(difference, currency).isZero())
                items.push({
                    recordKind: "inventoryValuation",
                    recordId: org,
                    text:
                        "WIP accounts " +
                        ec.l10n.formatCurrency(dec(ledger), currency) +
                        ", production runs " +
                        ec.l10n.formatCurrency(runWip, currency),
                    detail: "A difference of " + ec.l10n.formatCurrency(difference, currency) + " (kit and repack work included)"
                })
            for (const row of open.slice(0, 19))
                items.push({
                    recordKind: "productionCostClose",
                    recordId: row.workEffortId,
                    text: "Work order " + row.workEffortId + " holds " + ec.l10n.formatCurrency(row.wip, currency) + " of WIP",
                    detail: statusText(one(WORK, {workEffortId: row.workEffortId})?.statusId)
                })
        }
        return {count: items.length, items: items.slice(0, 20)}
    }
    throw new Error("Unknown production close check " + p.checkEnumId)
}

// ===== by-product receipt (receive#ProductionOutput) =====
// The cost a by-product line is received at (design ByProducts, D12): its co-product share, under the policy in effect now,
// of the run's frozen estimate, over the line's target quantity. The primary output is received at its frozen standard
// (rule 1), which Products' rollup already nets of the by-products' shares (Costs.js scales the primary's lines by its
// share), so the run's whole estimate is the primary's target at its standard over the primary's weight: under quantity a
// by-product unit in the primary's unit costs what a primary unit does. Without a frozen estimate there is nothing to
// allocate (BYPRODUCT_NOT_COSTED).
function byproductCost(run, line, quantity) {
    const standard = run.productStandardCostId ? one(STANDARD, {productStandardCostId: run.productStandardCostId}) : null
    const lines = production()
        .linesOf(run.workEffortId)
        .filter(row => outputRoles.includes(row.lineRoleEnumId))
    const primary = lines.find(row => row.lineRoleEnumId === "PrlrOutput")
    if (standard?.unitCost == null || !primary)
        denied("BYPRODUCT_NOT_COSTED", "By-product " + line.productId + " has no frozen estimate to take its share of")
    const policy = policyAt(run.ownerPartyId)
    const currency = standard.priceUomId || lib.preference(run.ownerPartyId).baseCurrencyUomId || null
    const weighting = weightsOf(lines, policy, currency, row => dec(row.stockQuantity), null)
    if (weighting.findings.length) denied("BYPRODUCT_NOT_COSTED", weighting.findings.map(row => row.message).join("; "))
    const primaryWeight = dec(weighting.weights.get(primary.productionRunLineId))
    const totalWeight = lines.reduce((sum, row) => sum.add(dec(weighting.weights.get(row.productionRunLineId))), zero())
    if (primaryWeight.compare(0) <= 0)
        denied("BYPRODUCT_NOT_COSTED", "The primary output takes no share, so the run's estimate cannot be shared")
    const estimate = dec(standard.unitCost)
        .multiply(dec(primary.stockQuantity))
        .multiply(totalWeight)
        .divide(primaryWeight, 10, "HALF_UP")
    const shares = split(estimate, lines, weighting.weights, currency)
    const mine = shares?.find(row => row.line.productionRunLineId === line.productionRunLineId)
    if (!mine || mine.amount.compare(0) <= 0 || dec(line.stockQuantity).compare(0) <= 0)
        denied("BYPRODUCT_NOT_COSTED", "By-product " + line.productId + " takes no share of the run's cost")
    const unit = mine.amount.divide(dec(line.stockQuantity), 6, "HALF_UP")
    return {
        total: unit.multiply(quantity),
        currencyUomId: currency,
        provisional: false,
        costSource: "allocation",
        productionAllocationPolicyId: policy.productionAllocationPolicyId,
        sharePercent: mine.sharePercent
    }
}

const operations = {policies, storePolicy, preview, post, closeOf, returnReview, closeCheck}
;({
    byproductCost,
    policyAt,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown production cost close operation " + op)
        return operations[op](parameters)
    }
})
