// Fixed asset books (AssetBookServices; design-accounting §10, impl-accounting P12): an organization's book defaults by
// asset class (FixedAssetClass versions), the book events of an asset (capitalize, adjust, dispose, reverse, and the finance
// administrator's acquire cost repair), each an AssetBookEvent with its posted transaction, and depreciation as a kind of
// period run (PrkDepreciation) over Mantle's calculate#FixedAssetDepreciation and calculateAndPost#FixedAssetDepreciation,
// each asset-period posted once, in its own transaction with its depreciation row. The organization is the asset's owner;
// a book day in a closed fiscal period is refused.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/AccountingPolicy.js")
const {find, one, rows, call, display, denied, ms} = lib
const ASSET = "mantle.product.asset.Asset",
    EVENT = "mantle.product.asset.AssetBookEvent",
    CLASS = "mantle.product.asset.FixedAssetClass",
    MAPPING = "mantle.ledger.config.AssetTypeGlAccount",
    DEPRECIATION = "mantle.product.asset.AssetDepreciation",
    TRANS = "mantle.ledger.transaction.AcctgTrans",
    PERIOD = "mantle.party.time.TimePeriod"
// The book fields of an asset that a book event changes and its reversal restores.
const bookFields = [
    "classEnumId",
    "acquiredDate",
    "acquireCost",
    "acquireCostUomId",
    "salvageValue",
    "depreciationTypeEnumId",
    "expectedEndOfLife",
    "actualEndOfLife"
]
// The accounts of the asset's own AssetTypeGlAccount row, which capitalization sets from its class.
const mappingFields = [
    "assetGlAccountId",
    "accDepreciationGlAccountId",
    "depreciationGlAccountId",
    "profitGlAccountId",
    "lossGlAccountId",
    "receiptGlAccountId",
    "issuanceGlAccountId",
    "transferGlAccountId",
    "shrinkageGlAccountId",
    "foundGlAccountId",
    "receiptTransTypeEnumId",
    "issuanceTransTypeEnumId"
]
const reversibleTypes = ["AbeCapitalize", "AbeAdjust", "AbeDispose"]
// the events that decide which one is the latest: an acquire cost repair after an event keeps it from being reversed
const latestTypes = [...reversibleTypes, "AbeCostRepair"]

const today = () => ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd")
// A book day's timestamp: noon in the user's zone, so its day is the same in every zone near it.
const stamp = day => ec.l10n.parseTimestamp(day + " 12:00:00", "yyyy-MM-dd HH:mm:ss")
const dayOf = value => (value == null || value === "" ? today() : lib.calendarDateText(value))
const stampDay = value => (value == null || value === "" ? null : lib.bookDay(null, value))
// The start of a moment's day in the user's zone: class versions change by day, so one added this afternoon applies to an
// asset in service today.
const dayStart = value => ec.l10n.parseTimestamp(lib.bookDay(null, value) + " 00:00:00", "yyyy-MM-dd HH:mm:ss")
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const decimal = value => toDecimal(value ?? 0)
const negate = value => toDecimal(0).subtract(value)

// Whether an asset type is a fixed asset type (AstTpFixed or one of its kinds).
function fixedTypes() {
    return ["AstTpFixed", ...rows("moqui.basic.Enumeration", {parentEnumId: "AstTpFixed"}).map(r => r.enumId)]
}
// The asset and its owner, with the user's authority there: the record decides the organization. Locks the organization,
// then the asset, the order the posting guard locks them in.
function assetScope(assetId, need, lock = false) {
    const initial = assetId && one(ASSET, {assetId})
    if (!initial || !initial.ownerPartyId) denied("ASSET_UNAVAILABLE", "The asset is not available")
    let s
    try {
        s = lib.organization({organizationPartyId: initial.ownerPartyId}, need)
    } catch (error) {
        if (lib.lib.reasonCode(error) === "ORGANIZATION_DENIED") denied("ASSET_UNAVAILABLE", "The asset is not available")
        throw error
    }
    if (!fixedTypes().includes(initial.assetTypeEnumId)) denied("ASSET_NOT_FIXED", "Only a fixed asset has a book")
    if (!lock) return {s, asset: initial, org: s.organizationPartyId}
    find("mantle.party.Party", {partyId: s.organizationPartyId}).forNoKeyUpdate(true).one()
    return {s, asset: find(ASSET, {assetId}).forUpdate(true).one(), org: s.organizationPartyId}
}
// The fiscal periods of the organization, and those it rolls up to, that hold the day and are closed.
function closedPeriods(org, day) {
    return lib.organizationChain(org).flatMap(partyId =>
        Array.from(
            find("mantle.party.time.TimePeriodAndType", {partyId, periodPurposeEnumId: "Fiscal", isClosed: "Y"})
                .condition("fromDate", "less-equals", day)
                .condition("thruDate", "greater-equals", day)
                .list()
        )
    )
}
// Refused when the book day (yyyy-MM-dd) is in a closed fiscal period.
function checkOpen(org, day) {
    const closed = closedPeriods(org, day)
    if (closed.length) denied("PERIOD_CLOSED", "The fiscal period of " + day + " (" + closed[0].periodName + ") is closed")
    return day
}
// The asset's accounts: its own row, else by its type and class, else by its type (Mantle's lookup).
function mappingOf(asset) {
    const out = call("mantle.ledger.AssetAutoPostServices.get#AssetTypeGlAccount", {
        organizationPartyId: asset.ownerPartyId,
        assetTypeEnumId: asset.assetTypeEnumId,
        classEnumId: asset.classEnumId,
        assetId: asset.assetId
    })
    return lib.map(out.assetTypeGlAccount)
}
const ownMapping = asset => rows(MAPPING, {assetId: asset.assetId, organizationPartyId: asset.ownerPartyId})[0] || null
function postingAccount(org, glAccountId, label) {
    if (!glAccountId) denied("ACCOUNT_MISSING", "Configure the " + label + " account for this asset")
    lib.account(org, glAccountId)
    return glAccountId
}
// The book basis to restore: the asset's book fields, and its own account row or none.
function bookOf(asset) {
    const book = {}
    for (const field of bookFields) {
        const value = asset[field]
        book[field] =
            value == null || value === ""
                ? null
                : field === "acquiredDate"
                  ? ms(value)
                  : ["expectedEndOfLife", "actualEndOfLife"].includes(field)
                    ? lib.calendarDateText(value)
                    : String(value)
    }
    const own = ownMapping(asset)
    return {asset: book, mapping: own ? lib.pick(lib.map(own), ["assetTypeGlAccountId", ...mappingFields]) : null}
}
function restoreBook(asset, before) {
    const values = {assetId: asset.assetId}
    for (const field of bookFields) {
        const value = before.asset[field]
        values[field] = value == null ? null : field === "acquiredDate" ? new Date(Number(value)) : value
    }
    call("update#" + ASSET, values)
    const own = ownMapping(asset)
    if (!before.mapping && own) call("delete#" + MAPPING, {assetTypeGlAccountId: own.assetTypeGlAccountId})
    else if (before.mapping && own) call("update#" + MAPPING, Object.assign({}, before.mapping))
    else if (before.mapping) call("create#" + MAPPING, Object.assign({}, before.mapping))
}
// The asset's own account row: its type's accounts with those the book chose.
function storeMapping(asset, base, accounts) {
    const own = ownMapping(asset)
    const values = Object.assign(lib.pick(base, mappingFields), accounts)
    if (own) call("update#" + MAPPING, Object.assign({assetTypeGlAccountId: own.assetTypeGlAccountId}, values))
    else
        call(
            "create#" + MAPPING,
            Object.assign(
                {organizationPartyId: asset.ownerPartyId, assetTypeEnumId: asset.assetTypeEnumId, assetId: asset.assetId},
                values
            )
        )
}
// A line of a book posting: a positive amount debits the account, a negative one credits it.
const line = (glAccountId, signed) => ({glAccountId, amount: decimal(signed)})
// Post a book transaction of the asset on the book day; refused when it does not post.
function postBook(org, type, day, asset, lines, description) {
    const tx = call("mantle.ledger.LedgerServices.create#AcctgTrans", {
        organizationPartyId: org,
        acctgTransTypeEnumId: type,
        transactionDate: stamp(day),
        assetId: asset.assetId,
        description
    })
    // the book day is the posting's accounting day, whatever the user's zone
    call("update#" + TRANS, {acctgTransId: tx.acctgTransId, accountingDate: day})
    for (const entry of lines) {
        if (entry.amount.isZero()) continue
        call("mantle.ledger.LedgerServices.create#AcctgTransEntry", {
            acctgTransId: tx.acctgTransId,
            glAccountId: entry.glAccountId,
            debitCreditFlag: entry.amount.compare(0) > 0 ? "D" : "C",
            amount: entry.amount.compare(0) > 0 ? entry.amount : negate(entry.amount),
            assetId: asset.assetId,
            productId: asset.productId || null,
            description
        })
    }
    call("mantle.ledger.LedgerServices.post#AcctgTrans", {acctgTransId: tx.acctgTransId, reviewed: true})
    const posted = one(TRANS, {acctgTransId: tx.acctgTransId})
    if (posted?.isPosted !== "Y")
        denied(posted?.postingFailureCode || "POSTING_FAILED", posted?.postingFailureMessage || "The book posting did not post")
    return tx.acctgTransId
}
function createEvent(asset, org, day, values) {
    return call(
        "create#" + EVENT,
        Object.assign(
            {
                assetId: asset.assetId,
                productId: asset.productId || null,
                organizationPartyId: org,
                facilityId: asset.facilityId || null,
                eventDate: stamp(day),
                amountUomId: lib.preference(org).baseCurrencyUomId,
                postedByUserId: ec.user.userId,
                postedDate: ec.user.nowTimestamp
            },
            values
        )
    ).assetBookEventId
}
// The asset's book events, newest first, and which of them a later reversal undid.
function eventsOf(assetId) {
    const events = Array.from(find(EVENT, {assetId}).orderBy("-postedDate,-assetBookEventId").list())
    const reversed = new Set(events.map(e => e.reversalOfAssetBookEventId).filter(Boolean))
    return {events, reversed}
}
// The asset's capitalization in force, or null.
function capitalization(assetId) {
    const {events, reversed} = eventsOf(assetId)
    return events.find(e => e.eventTypeEnumId === "AbeCapitalize" && !reversed.has(e.assetBookEventId)) || null
}
// The posted depreciation of the asset with its period's days, oldest first.
function depreciationsOf(assetId) {
    return rows(DEPRECIATION, {assetId})
        .map(row => {
            const period = one(PERIOD, {timePeriodId: row.timePeriodId})
            return {
                row,
                period,
                fromDay: lib.calendarDateText(period.fromDate),
                thruDay: lib.calendarDateText(period.thruDate)
            }
        })
        .sort((a, b) => a.fromDay.localeCompare(b.fromDay))
}
const yearsAfter = (day, years) => {
    const [y, m, d] = day.split("-").map(Number)
    const last = new Date(Date.UTC(y + years, m, 0)).getUTCDate()
    return lib.calendarDateText(Date.UTC(y + years, m - 1, Math.min(d, last)))
}
const netBookOf = asset => decimal(asset.acquireCost).subtract(decimal(asset.depreciation))

// ---- Classes

// The version of an organization's class in effect at a moment.
function classVersion(org, classEnumId, at) {
    return (
        Array.from(find(CLASS, {organizationPartyId: org, classEnumId}).orderBy("-fromDate").list()).find(r =>
            lib.active(r, at)
        ) || null
    )
}
function storeClass(p) {
    const s = lib.organization(p, "admin")
    const org = s.organizationPartyId
    const why = lib.reason(p)
    const replaced = p.fixedAssetClassId ? find(CLASS, {fixedAssetClassId: p.fixedAssetClassId}).forUpdate(true).one() : null
    if (p.fixedAssetClassId && (!replaced || replaced.organizationPartyId !== org))
        denied("CLASS_UNAVAILABLE", "The asset class is not available")
    // only an end date: end the version
    if (replaced && p.usefulLifeYears == null) {
        const end = dayStart(p.thruDate || ec.user.nowTimestamp)
        if (ms(end) <= ms(replaced.fromDate)) denied("CLASS_DATES_INVALID", "A version must end after it starts")
        lib.audit(["thruDate"], why)
        call("update#" + CLASS, {fixedAssetClassId: replaced.fixedAssetClassId, thruDate: end})
        return {fixedAssetClassId: replaced.fixedAssetClassId}
    }
    const classEnumId = replaced?.classEnumId || p.classEnumId
    if (!classEnumId || one("moqui.basic.Enumeration", {enumId: classEnumId})?.enumTypeId !== "AssetClass")
        denied("CLASS_REQUIRED", "Choose an asset class")
    const assetTypeEnumId = p.assetTypeEnumId || replaced?.assetTypeEnumId || "AstTpEquipment"
    if (!fixedTypes().includes(assetTypeEnumId)) denied("TYPE_INVALID", "Choose a fixed asset type")
    const life = Number(p.usefulLifeYears)
    if (!Number.isInteger(life) || life < 1 || life > 100) denied("LIFE_INVALID", "Enter a useful life of 1 to 100 years")
    const salvage = decimal(p.salvagePercent ?? replaced?.salvagePercent)
    if (salvage.compare(0) < 0 || salvage.compare(100) >= 0) denied("SALVAGE_INVALID", "Enter a residual of 0 to 99 percent")
    const method = p.depreciationTypeEnumId || replaced?.depreciationTypeEnumId
    if (!method || one("moqui.basic.Enumeration", {enumId: method})?.enumTypeId !== "DepreciationType")
        denied("METHOD_REQUIRED", "Choose a depreciation method")
    const taxMethod = p.taxDepreciationTypeEnumId || replaced?.taxDepreciationTypeEnumId || null
    const accounts = {}
    for (const field of [
        "assetGlAccountId",
        "accDepreciationGlAccountId",
        "depreciationGlAccountId",
        "gainGlAccountId",
        "lossGlAccountId"
    ]) {
        accounts[field] = p[field] || replaced?.[field] || null
        if (accounts[field]) lib.account(org, accounts[field])
    }
    const fromDate = dayStart(p.fromDate || ec.user.nowTimestamp),
        thruDate = p.thruDate ? dayStart(p.thruDate) : null
    if (thruDate && ms(thruDate) <= ms(fromDate)) denied("CLASS_DATES_INVALID", "A version must end after it starts")
    if (replaced && ms(fromDate) <= ms(replaced.fromDate))
        denied("CLASS_DATES_INVALID", "A new version starts after the one it replaces")
    const overlapping = Array.from(find(CLASS, {organizationPartyId: org, classEnumId}).forUpdate(true).list()).filter(
        row =>
            row.fixedAssetClassId !== replaced?.fixedAssetClassId &&
            (row.thruDate == null || ms(row.thruDate) > ms(fromDate)) &&
            (thruDate == null || ms(row.fromDate) < ms(thruDate))
    )
    if (overlapping.length)
        denied("CLASS_OVERLAP", "Another version of this class covers these dates; start a new version of it or end it")
    lib.audit(["usefulLifeYears", "salvagePercent", "depreciationTypeEnumId", "fromDate", "thruDate"], why)
    if (replaced && (replaced.thruDate == null || ms(replaced.thruDate) > ms(fromDate)))
        call("update#" + CLASS, {fixedAssetClassId: replaced.fixedAssetClassId, thruDate: fromDate})
    const created = call(
        "create#" + CLASS,
        Object.assign(
            {
                organizationPartyId: org,
                classEnumId,
                assetTypeEnumId,
                description: p.description || replaced?.description || enumText(classEnumId),
                fromDate,
                thruDate,
                usefulLifeYears: life,
                salvagePercent: salvage,
                depreciationTypeEnumId: method,
                taxDepreciationTypeEnumId: taxMethod
            },
            accounts
        )
    )
    return {fixedAssetClassId: created.fixedAssetClassId}
}

// ---- Book events

function capitalize(p) {
    const {asset, org} = assetScope(p.assetId, "glPost", true)
    const day = dayOf(p.inServiceDate)
    const why = String(p.changeReason || "").trim() || "Capitalized"
    const request = {day, why}
    for (const field of [
        "assetId",
        "classEnumId",
        "acquireCost",
        "acquireCostUomId",
        "usefulLifeYears",
        "salvageValue",
        "depreciationTypeEnumId",
        "assetGlAccountId",
        "accDepreciationGlAccountId",
        "depreciationGlAccountId",
        "sourceInvoiceId",
        "sourceAssetReceiptId",
        "offsetGlAccountId"
    ])
        request[field] = p[field] == null || p[field] === "" ? null : String(p[field])
    const op = lib.lib.operation(p, "AssetCapitalize", org, request)
    if (op.old) return lib.lib.previous(op)
    checkOpen(org, day)
    if (capitalization(asset.assetId)) denied("ALREADY_CAPITALIZED", "The asset is already on the books")
    if (asset.actualEndOfLife) denied("ASSET_DISPOSED", "The asset was disposed")
    const currency = lib.preference(org).baseCurrencyUomId
    if (p.acquireCostUomId && p.acquireCostUomId !== currency)
        denied("CURRENCY_UNSUPPORTED", "Capitalize in the organization's currency")
    const classEnumId = p.classEnumId || asset.classEnumId || null
    const version = classEnumId ? classVersion(org, classEnumId, stamp(day)) : null
    if (p.classEnumId && !version) denied("CLASS_UNAVAILABLE", "The class has no version in effect on the in-service day")
    // the source: a receipt of this asset, a purchase invoice of the organization
    const receipts = rows("mantle.product.receipt.AssetReceipt", {assetId: asset.assetId})
    if (p.sourceAssetReceiptId && !receipts.some(r => r.assetReceiptId === p.sourceAssetReceiptId))
        denied("SOURCE_INVALID", "Choose a receipt of this asset")
    if (p.sourceInvoiceId && one("mantle.account.invoice.Invoice", {invoiceId: p.sourceInvoiceId})?.toPartyId !== org)
        denied("SOURCE_INVALID", "Choose a bill the organization received")
    // any receipt makes the asset received: its cost is on the books once the receipt posts, never from Unreceived
    const receiptTrans = receipts.map(r => {
        const tx = find(TRANS, {assetReceiptId: r.assetReceiptId}).orderBy("acctgTransId").one()
        if (tx?.isPosted !== "Y")
            denied("RECEIPT_NOT_POSTED", "Receipt " + r.assetReceiptId + " of this asset has not posted; post the receipt first")
        return tx
    })
    const received = receipts.length > 0
    if (received && p.offsetGlAccountId) denied("OFFSET_FROM_RECEIPT", "A received asset's cost came from its receipt")
    // a received asset's cost is on the books from its receipt; another is capitalized at the cost given
    let cost
    if (received) {
        cost = decimal(asset.acquireCost)
        if (p.acquireCost != null && p.acquireCost !== "" && !decimal(p.acquireCost).eq(cost))
            denied("COST_FROM_RECEIPT", "The receipt set this asset's cost; adjust the book to change it")
    } else cost = lib.lib.amount(p.acquireCost ?? asset.acquireCost, currency)
    const life = Number(p.usefulLifeYears != null && p.usefulLifeYears !== "" ? p.usefulLifeYears : version?.usefulLifeYears)
    if (!Number.isInteger(life) || life < 1 || life > 100) denied("LIFE_INVALID", "Enter a useful life of 1 to 100 years")
    const method = p.depreciationTypeEnumId || version?.depreciationTypeEnumId
    if (!method || one("moqui.basic.Enumeration", {enumId: method})?.enumTypeId !== "DepreciationType")
        denied("METHOD_REQUIRED", "Choose a depreciation method")
    const salvage =
        p.salvageValue != null && p.salvageValue !== ""
            ? lib.lib.money(p.salvageValue, currency)
            : lib.lib.money(cost.multiply(decimal(version?.salvagePercent)).divide(100), currency)
    if (salvage.compare(0) < 0 || salvage.compare(cost) >= 0)
        denied("SALVAGE_INVALID", "The residual value is below the acquire cost")
    const base = mappingOf(asset)
    const accounts = {
        assetGlAccountId: p.assetGlAccountId || version?.assetGlAccountId || base.assetGlAccountId,
        accDepreciationGlAccountId:
            p.accDepreciationGlAccountId || version?.accDepreciationGlAccountId || base.accDepreciationGlAccountId,
        depreciationGlAccountId: p.depreciationGlAccountId || version?.depreciationGlAccountId || base.depreciationGlAccountId,
        profitGlAccountId: version?.gainGlAccountId || base.profitGlAccountId || null,
        lossGlAccountId: version?.lossGlAccountId || base.lossGlAccountId || null
    }
    postingAccount(org, accounts.assetGlAccountId, "asset")
    postingAccount(org, accounts.accDepreciationGlAccountId, "accumulated depreciation")
    postingAccount(org, accounts.depreciationGlAccountId, "depreciation expense")
    const lines = []
    if (!received) {
        // the cost from the clearing account a fixed asset bill debits (Unreceived Fixed Asset)
        lines.push(line(accounts.assetGlAccountId, cost))
        const offset = p.offsetGlAccountId || base.receiptGlAccountId
        lines.push(line(postingAccount(org, offset, "unreceived fixed asset"), negate(cost)))
    } else {
        // the receipt debited its type's asset account: reclassify to the class's when they differ
        const receiptAccount = rows("mantle.ledger.transaction.AcctgTransEntry", {
            acctgTransId: receiptTrans[0].acctgTransId,
            debitCreditFlag: "D"
        })[0]?.glAccountId
        if (receiptAccount && receiptAccount !== accounts.assetGlAccountId) {
            lines.push(line(accounts.assetGlAccountId, cost))
            lines.push(line(receiptAccount, negate(cost)))
        }
    }
    const before = bookOf(asset)
    const acctgTransId = lines.length ? postBook(org, "AttCapitalization", day, asset, lines, why) : null
    lib.audit(["acquireCost", "salvageValue", "depreciationTypeEnumId"], why)
    call("update#" + ASSET, {
        assetId: asset.assetId,
        classEnumId,
        acquiredDate: stamp(day),
        acquireCost: cost,
        acquireCostUomId: currency,
        salvageValue: salvage,
        depreciationTypeEnumId: method,
        expectedEndOfLife: yearsAfter(day, life),
        actualEndOfLife: null
    })
    storeMapping(asset, base, accounts)
    const after = bookOf(one(ASSET, {assetId: asset.assetId}))
    const assetBookEventId = createEvent(asset, org, day, {
        eventTypeEnumId: "AbeCapitalize",
        fixedAssetClassId: version?.fixedAssetClassId || null,
        amount: cost,
        newUnitCost: cost,
        acctgTransId,
        assetGlAccountId: accounts.assetGlAccountId,
        offsetGlAccountId: lines.length ? lines[1].glAccountId : null,
        sourceInvoiceId: p.sourceInvoiceId || null,
        sourceAssetReceiptId: p.sourceAssetReceiptId || receipts[0]?.assetReceiptId || null,
        operationKey: op.operationKey,
        changeReason: why,
        bookBeforeJson: JSON.stringify(before),
        bookAfterJson: JSON.stringify(after)
    })
    const answer = {assetBookEventId, acctgTransId}
    lib.lib.complete(op, EVENT, assetBookEventId, answer)
    return answer
}

// Refused when depreciation is posted for a period that starts after the day: a book change is dated in or after the last
// depreciated period, and later depreciation uses it.
function checkNotDepreciatedAfter(assetId, day) {
    const later = depreciationsOf(assetId).find(d => d.fromDay > day)
    if (later)
        denied("DEPRECIATED_AFTER", "Depreciation is posted for " + later.fromDay + " on; date the change in that period or after")
}
// Refused while a fiscal month of the organization from the asset's in-service day through the month before the disposal
// has no depreciation and the asset is not fully depreciated: depreciate those months first.
function checkDepreciationDue(asset, org, day) {
    if (!asset.depreciationTypeEnumId || !asset.acquiredDate) return
    const depreciable = decimal(asset.acquireCost).subtract(decimal(asset.salvageValue))
    if (decimal(asset.depreciation).compare(depreciable) >= 0) return
    const inService = stampDay(asset.acquiredDate)
    const months = Array.from(
        find(PERIOD, {partyId: org, timePeriodTypeId: "FiscalMonth"})
            .condition("thruDate", "greater-equals", inService)
            .condition("thruDate", "less", day)
            .list()
    ).filter(m => lib.calendarDateText(m.thruDate) < day)
    const missing = months.filter(m => !one(DEPRECIATION, {assetId: asset.assetId, timePeriodId: m.timePeriodId}))
    if (missing.length)
        denied(
            "DEPRECIATION_DUE",
            "Depreciate " + missing.map(m => m.periodName || m.timePeriodId).join(", ") + " before disposing of the asset"
        )
}
function bookedAsset(p, need = "glPost") {
    const scoped = assetScope(p.assetId, need, true)
    if (!capitalization(scoped.asset.assetId)) denied("NOT_CAPITALIZED", "Capitalize the asset first")
    if (scoped.asset.actualEndOfLife) denied("ASSET_DISPOSED", "The asset was disposed")
    return scoped
}

function adjust(p) {
    const {asset, org} = assetScope(p.assetId, "glPost", true)
    const day = dayOf(p.effectiveDate)
    const op = lib.lib.operation(p, "AssetBookAdjust", org, {
        assetId: asset.assetId,
        day,
        costChange: String(p.costChange ?? ""),
        usefulLifeChange: String(p.usefulLifeChange ?? ""),
        salvageChange: String(p.salvageChange ?? ""),
        offset: p.offsetGlAccountId || null,
        why: String(p.changeReason || "").trim()
    })
    if (op.old) return lib.lib.previous(op)
    checkOpen(org, day)
    const why = lib.reason(p)
    bookedAsset(p)
    const currency = lib.preference(org).baseCurrencyUomId
    const costChange = lib.lib.money(p.costChange, currency),
        salvageChange = lib.lib.money(p.salvageChange, currency),
        lifeChange = Number(p.usefulLifeChange || 0)
    if (!Number.isInteger(lifeChange)) denied("LIFE_INVALID", "Change the useful life by whole years")
    if (costChange.isZero() && salvageChange.isZero() && !lifeChange)
        denied("NOTHING_TO_ADJUST", "Enter a change in cost, useful life or residual value")
    checkNotDepreciatedAfter(asset.assetId, day)
    const cost = decimal(asset.acquireCost),
        newCost = cost.add(costChange),
        newSalvage = decimal(asset.salvageValue).add(salvageChange)
    if (newSalvage.compare(0) < 0 || newSalvage.compare(newCost) >= 0)
        denied("SALVAGE_INVALID", "The residual value is below the acquire cost")
    if (newCost.subtract(newSalvage).compare(decimal(asset.depreciation)) < 0)
        denied("BOOK_NEGATIVE", "The cost less the residual is below the depreciation already posted")
    const newEnd = lifeChange
        ? yearsAfter(lib.calendarDateText(asset.expectedEndOfLife), lifeChange)
        : lib.calendarDateText(asset.expectedEndOfLife)
    if (newEnd <= day) denied("LIFE_INVALID", "The useful life ends after the change's day")
    const mapping = mappingOf(asset)
    // a received asset's change of cost comes from an account the user names (a bill's, an expense); another's from the
    // Unreceived Fixed Asset clearing account its capitalization used, unless one is named
    const received = rows("mantle.product.receipt.AssetReceipt", {assetId: asset.assetId}).length > 0
    const offset = p.offsetGlAccountId || (received ? null : mapping.receiptGlAccountId)
    if (!costChange.isZero() && !offset)
        denied("OFFSET_REQUIRED", "Choose the account the change of a received asset's cost comes from")
    let acctgTransId = null
    if (!costChange.isZero())
        acctgTransId = postBook(org, "AttAssetBookAdjust", day, asset, [
            line(postingAccount(org, mapping.assetGlAccountId, "asset"), costChange),
            line(postingAccount(org, offset, "offset"), negate(costChange))
        ], why)
    const before = bookOf(asset)
    lib.audit(["acquireCost", "salvageValue"], why)
    call("update#" + ASSET, {assetId: asset.assetId, acquireCost: newCost, salvageValue: newSalvage, expectedEndOfLife: newEnd})
    const after = one(ASSET, {assetId: asset.assetId})
    const assetBookEventId = createEvent(asset, org, day, {
        eventTypeEnumId: "AbeAdjust",
        amount: costChange,
        previousUnitCost: cost,
        newUnitCost: newCost,
        acctgTransId,
        assetGlAccountId: acctgTransId ? mapping.assetGlAccountId : null,
        offsetGlAccountId: acctgTransId ? offset : null,
        operationKey: op.operationKey,
        changeReason: why,
        bookBeforeJson: JSON.stringify(before),
        bookAfterJson: JSON.stringify(bookOf(after))
    })
    const answer = {assetBookEventId, acctgTransId, netBookBefore: netBookOf(asset), netBookAfter: netBookOf(after)}
    lib.lib.complete(op, EVENT, assetBookEventId, answer)
    return answer
}

// A scrap or sale: the cost and accumulated depreciation leave the books, a sale's proceeds go to the clearing account its
// invoice line credits (Unissued Fixed Asset), and the difference is a gain or a loss. An invoice that sells the asset
// itself (an ItemAsset line) posts that sale with the invoice, so it is not disposed here.
function dispose(p) {
    const {asset, org} = assetScope(p.assetId, "glPost", true)
    const day = dayOf(p.disposalDate)
    const sale = p.disposalTypeEnumId === "AdtSale"
    const op = lib.lib.operation(p, "AssetDispose", org, {
        assetId: asset.assetId,
        day,
        type: p.disposalTypeEnumId || null,
        proceeds: String(p.proceedsAmount ?? ""),
        buyer: p.buyerPartyId || null,
        invoice: p.salesInvoiceId || null,
        why: String(p.changeReason || "").trim()
    })
    if (op.old) return lib.lib.previous(op)
    checkOpen(org, day)
    const why = lib.reason(p)
    if (!["AdtSale", "AdtScrap"].includes(p.disposalTypeEnumId)) denied("DISPOSAL_TYPE_REQUIRED", "Choose scrap or sale")
    if (asset.actualEndOfLife) denied("ALREADY_DISPOSED", "The asset was already disposed")
    bookedAsset(p)
    if (asset.acquiredDate && day < stampDay(asset.acquiredDate))
        denied("DISPOSAL_DATE_INVALID", "A disposal is dated on or after the asset went in service")
    checkNotDepreciatedAfter(asset.assetId, day)
    checkDepreciationDue(asset, org, day)
    const currency = lib.preference(org).baseCurrencyUomId
    const proceeds = sale ? lib.lib.amount(p.proceedsAmount, currency) : toDecimal(0)
    if (!sale && p.proceedsAmount != null && p.proceedsAmount !== "" && !decimal(p.proceedsAmount).isZero())
        denied("PROCEEDS_INVALID", "A scrapped asset has no proceeds; record a sale")
    if (p.buyerPartyId) lib.counterparty(p.buyerPartyId)
    if (p.salesInvoiceId) {
        const invoice = one("mantle.account.invoice.Invoice", {invoiceId: p.salesInvoiceId})
        if (!sale || invoice?.fromPartyId !== org || (p.buyerPartyId && invoice.toPartyId !== p.buyerPartyId))
            denied("SOURCE_INVALID", "Choose a sales invoice of the organization to the buyer")
        if (rows("mantle.account.invoice.InvoiceItem", {invoiceId: p.salesInvoiceId, assetId: asset.assetId}).length)
            denied("ASSET_SOLD_BY_INVOICE", "This invoice sells the asset itself, and its posting disposes of it")
        // the invoice bills the sale on a line to the clearing account the disposal debits
        const clearing = mappingOf(asset).issuanceGlAccountId
        const saleLines = clearing
            ? rows("mantle.account.invoice.InvoiceItem", {invoiceId: p.salesInvoiceId, overrideGlAccountId: clearing})
            : []
        if (!saleLines.length)
            denied("SOURCE_INVALID", "The invoice has no line to the disposal clearing account " + clearing)
    }
    const cost = decimal(asset.acquireCost),
        accumulated = decimal(asset.depreciation),
        gain = proceeds.subtract(cost.subtract(accumulated))
    const mapping = mappingOf(asset)
    const lines = [
        line(postingAccount(org, mapping.assetGlAccountId, "asset"), negate(cost)),
        line(
            accumulated.isZero() ? null : postingAccount(org, mapping.accDepreciationGlAccountId, "accumulated depreciation"),
            accumulated
        ),
        line(proceeds.isZero() ? null : postingAccount(org, mapping.issuanceGlAccountId, "disposal clearing"), proceeds)
    ]
    if (gain.compare(0) > 0) lines.push(line(postingAccount(org, mapping.profitGlAccountId, "gain on disposal"), negate(gain)))
    if (gain.compare(0) < 0) lines.push(line(postingAccount(org, mapping.lossGlAccountId, "loss on disposal"), negate(gain)))
    const before = bookOf(asset)
    const acctgTransId = postBook(org, "AttAssetDisposal", day, asset, lines, why)
    call("update#" + ASSET, {assetId: asset.assetId, actualEndOfLife: day})
    const assetBookEventId = createEvent(asset, org, day, {
        eventTypeEnumId: "AbeDispose",
        disposalTypeEnumId: p.disposalTypeEnumId,
        amount: cost,
        proceedsAmount: proceeds,
        gainLossAmount: gain,
        buyerPartyId: p.buyerPartyId || null,
        salesInvoiceId: p.salesInvoiceId || null,
        acctgTransId,
        assetGlAccountId: mapping.assetGlAccountId,
        offsetGlAccountId: gain.compare(0) > 0 ? mapping.profitGlAccountId : mapping.lossGlAccountId,
        operationKey: op.operationKey,
        changeReason: why,
        bookBeforeJson: JSON.stringify(before),
        bookAfterJson: JSON.stringify(bookOf(one(ASSET, {assetId: asset.assetId})))
    })
    const answer = {assetBookEventId, acctgTransId, gainLossAmount: gain}
    lib.lib.complete(op, EVENT, assetBookEventId, answer)
    return answer
}

// Reverse the asset's latest book event in force: a dated reversal of its posting and its book basis restored. A
// capitalization or adjustment that depreciation has used since is not reversed.
function reverse(p) {
    const initial = p.assetBookEventId && one(EVENT, {assetBookEventId: p.assetBookEventId})
    if (!initial) denied("EVENT_UNAVAILABLE", "The book event is not available")
    const {asset, org} = assetScope(initial.assetId, "glPost", true)
    const day = dayOf(p.reversalDate)
    const op = lib.lib.operation(p, "AssetBookReverse", org, {
        assetBookEventId: initial.assetBookEventId,
        day,
        why: String(p.changeReason || "").trim()
    })
    if (op.old) return lib.lib.previous(op)
    checkOpen(org, day)
    const why = lib.reason(p)
    if (!reversibleTypes.includes(initial.eventTypeEnumId))
        denied("EVENT_NOT_REVERSIBLE", "Only a capitalization, adjustment or disposal is reversed here")
    const {events, reversed} = eventsOf(asset.assetId)
    if (reversed.has(initial.assetBookEventId)) denied("EVENT_REVERSED", "The book event was already reversed")
    const latest = events.find(e => latestTypes.includes(e.eventTypeEnumId) && !reversed.has(e.assetBookEventId))
    if (latest?.assetBookEventId !== initial.assetBookEventId)
        denied("EVENT_NOT_LATEST", "Reverse the asset's later book events first")
    const eventDay = stampDay(initial.eventDate)
    if (day < eventDay) denied("REVERSAL_DATE_INVALID", "A reversal is dated on or after its event")
    if (initial.eventTypeEnumId !== "AbeDispose" && depreciationsOf(asset.assetId).some(d => d.thruDay >= eventDay))
        denied("EVENT_DEPRECIATED", "Depreciation is posted on this book basis; adjust the book instead")
    let acctgTransId = null
    if (initial.acctgTransId) {
        acctgTransId = call("mantle.ledger.LedgerServices.post#ReverseAcctgTrans", {
            acctgTransId: initial.acctgTransId,
            reversalDate: stamp(day),
            changeReason: why,
            reviewed: true
        }).acctgTransId
        if (one(TRANS, {acctgTransId})?.isPosted !== "Y") denied("POSTING_FAILED", "The reversal did not post")
    }
    const before = lib.lib.json(initial.bookBeforeJson, null)
    if (!before) denied("EVENT_NOT_REVERSIBLE", "The book event kept no basis to restore")
    const current = bookOf(asset)
    lib.audit(["acquireCost", "salvageValue", "depreciationTypeEnumId"], why)
    restoreBook(asset, before)
    const assetBookEventId = createEvent(asset, org, day, {
        eventTypeEnumId: "AbeReversal",
        reversalOfAssetBookEventId: initial.assetBookEventId,
        amount: initial.amount == null ? null : negate(decimal(initial.amount)),
        acctgTransId,
        operationKey: op.operationKey,
        changeReason: why,
        bookBeforeJson: JSON.stringify(current),
        bookAfterJson: JSON.stringify(before)
    })
    const answer = {assetBookEventId, acctgTransId}
    lib.lib.complete(op, EVENT, assetBookEventId, answer)
    return answer
}

// The finance administrator's data repair of an asset's acquire cost (Mantle's update#AssetAcquireCost, which reposts its
// receipts, issuances and counts), audited and only while every posting of the asset is in an open period (F39).
function repairCost(p) {
    const {asset, org} = assetScope(p.assetId, "admin", true)
    const op = lib.lib.operation(p, "AssetCostRepair", org, {
        assetId: asset.assetId,
        cost: String(p.acquireCost ?? ""),
        why: String(p.changeReason || "").trim()
    })
    if (op.old) return lib.lib.previous(op)
    const why = lib.reason(p)
    const currency = asset.acquireCostUomId || lib.preference(org).baseCurrencyUomId
    const newCost = lib.lib.amount(p.acquireCost, currency)
    // a capitalized asset's cost is its book's: update#AssetAcquireCost reposts only its receipts and issuances, so the
    // capitalization, adjustments and depreciation would no longer agree with it
    if (asset.actualEndOfLife) denied("ASSET_DISPOSED", "The asset was disposed")
    if (capitalization(asset.assetId)) denied("ASSET_CAPITALIZED", "The asset is on the books; adjust the book instead")
    for (const tx of postingsOf(asset.assetId)) {
        const day = lib.postingDay(tx)
        if (closedPeriods(org, day).length)
            denied("PERIOD_CLOSED", "Transaction " + tx.acctgTransId + " of " + day + " is in a closed period")
    }
    const previous = asset.acquireCost
    lib.audit(["acquireCost"], why)
    call("mantle.product.AssetServices.update#AssetAcquireCost", {assetId: asset.assetId, acquireCost: newCost})
    const assetBookEventId = createEvent(asset, org, today(), {
        eventTypeEnumId: "AbeCostRepair",
        previousUnitCost: previous,
        newUnitCost: newCost,
        unitCostUomId: currency,
        operationKey: op.operationKey,
        changeReason: why
    })
    const answer = {assetBookEventId}
    lib.lib.complete(op, EVENT, assetBookEventId, answer)
    return answer
}
// The posted transactions of an asset: its own, and those of its receipts and issuances.
function postingsOf(assetId) {
    const out = rows(TRANS, {assetId, isPosted: "Y"})
    for (const [entity, field] of [
        ["mantle.product.receipt.AssetReceipt", "assetReceiptId"],
        ["mantle.product.issuance.AssetIssuance", "assetIssuanceId"]
    ]) {
        const ids = rows(entity, {assetId}).map(r => r[field])
        if (ids.length) out.push(...Array.from(find(TRANS, {isPosted: "Y"}).condition(field, "in", ids).list()))
    }
    return out
}

// ---- The book of an asset, for EquipmentDetail

function accountText(glAccountId) {
    if (!glAccountId) return ""
    const gl = one("mantle.ledger.account.GlAccount", {glAccountId})
    return gl ? [gl.accountCode, gl.accountName].filter(Boolean).join(" · ") : glAccountId
}
function book(p) {
    const {s, asset, org} = assetScope(p.assetId, "read")
    const c = s.capabilities
    if (!c.glPost && !c.reportRead && !c.admin) denied("PERMISSION_DENIED", "Accounting read authority is required")
    const currency = asset.acquireCostUomId || lib.preference(org).baseCurrencyUomId
    const capitalized = capitalization(asset.assetId)
    const disposed = !!asset.actualEndOfLife
    const {events, reversed} = eventsOf(asset.assetId)
    const latest = events.find(e => latestTypes.includes(e.eventTypeEnumId) && !reversed.has(e.assetBookEventId))
    const depreciations = depreciationsOf(asset.assetId)
    const lastDepreciatedDay = depreciations.length ? depreciations[depreciations.length - 1].thruDay : ""
    const todayOpen = !closedPeriods(org, today()).length
    const mapping = mappingOf(asset)
    const facility = asset.facilityId ? one("mantle.facility.Facility", {facilityId: asset.facilityId}) : null
    const product = asset.productId ? one("mantle.product.Product", {productId: asset.productId}) : null
    const names = lib.lib.partyNames([org, ...events.map(e => e.buyerPartyId)])
    const defaults = asset.classEnumId ? classVersion(org, asset.classEnumId, ec.user.nowTimestamp) : null
    const cost = decimal(asset.acquireCost),
        accumulated = decimal(asset.depreciation)
    return {
        asset: Object.assign(display(asset), {
            assetName: asset.assetName || asset.assetId,
            typeText: enumText(asset.assetTypeEnumId),
            classText: enumText(asset.classEnumId),
            statusText: asset.statusId ? one("moqui.basic.StatusItem", {statusId: asset.statusId})?.description : "",
            methodText: enumText(asset.depreciationTypeEnumId),
            productText: product ? product.productName || product.productId : "",
            facilityText: facility ? facility.facilityName || facility.facilityId : "",
            ownerText: names[org] || org,
            currencyUomId: currency,
            acquiredDateText: asset.acquiredDate ? lib.lib.dateText(asset.acquiredDate).slice(0, 10) : "",
            expectedEndOfLifeText: asset.expectedEndOfLife ? lib.calendarDateText(asset.expectedEndOfLife) : "",
            actualEndOfLifeText: disposed ? lib.calendarDateText(asset.actualEndOfLife) : "",
            accumulated,
            netBook: cost.subtract(accumulated),
            capitalized: !!capitalized,
            disposed,
            stateText: disposed ? "Disposed" : capitalized ? "In service" : "Not capitalized",
            stateColor: disposed ? "grey-8" : capitalized ? "positive" : "warning",
            lastDepreciatedDay
        }),
        accounts: [
            ["Asset", mapping.assetGlAccountId],
            ["Accumulated depreciation", mapping.accDepreciationGlAccountId],
            ["Depreciation expense", mapping.depreciationGlAccountId],
            ["Gain on disposal", mapping.profitGlAccountId],
            ["Loss on disposal", mapping.lossGlAccountId],
            ["Sale proceeds clearing", mapping.issuanceGlAccountId]
        ]
            .filter(([, id]) => id)
            .map(([label, glAccountId]) => ({label, glAccountId, accountText: accountText(glAccountId)})),
        classDefaults: defaults
            ? Object.assign(display(defaults), {
                  salvageValue: lib.lib.money(cost.multiply(decimal(defaults.salvagePercent)).divide(100), currency)
              })
            : null,
        events: events.map(e =>
            Object.assign(display(e), {
                typeText: enumText(e.eventTypeEnumId),
                eventDateText: stampDay(e.eventDate),
                disposalText: enumText(e.disposalTypeEnumId),
                buyerText: e.buyerPartyId ? names[e.buyerPartyId] || "" : "",
                reversed: reversed.has(e.assetBookEventId),
                canReverse:
                    !!c.glPost &&
                    todayOpen &&
                    latest?.assetBookEventId === e.assetBookEventId &&
                    (e.eventTypeEnumId === "AbeDispose" ||
                        !depreciations.some(d => d.thruDay >= stampDay(e.eventDate)))
            })
        ),
        depreciations: depreciations
            .slice()
            .reverse()
            .map(d =>
                Object.assign(display(d.row), {
                    periodText: d.period.periodName || d.row.timePeriodId,
                    fromDay: d.fromDay,
                    thruDay: d.thruDay,
                    currencyUomId: currency
                })
            ),
        receipts: rows("mantle.product.receipt.AssetReceipt", {assetId: asset.assetId}).map(r =>
            Object.assign(display(r), {acctgTransId: one(TRANS, {assetReceiptId: r.assetReceiptId})?.acctgTransId || null})
        ),
        canCapitalize: !!c.glPost && !capitalized && !disposed && todayOpen,
        canAdjust: !!c.glPost && !!capitalized && !disposed && todayOpen,
        canDispose: !!c.glPost && !!capitalized && !disposed && todayOpen,
        canRepair: !!c.admin && todayOpen && !capitalized && !disposed,
        canPostLedger: !!c.glPost,
        periodOpen: todayOpen
    }
}

// ---- Depreciation as a period run (PrkDepreciation)

// The organization's fixed assets with a depreciation method, in service by the period's end and not disposed by it, that
// have no depreciation for the period: one result each, with the month's amount and accounts, or why it cannot be
// computed. Fully depreciated assets have nothing to post and no result.
function calculateRun(p) {
    const period = one(PERIOD, {timePeriodId: p.timePeriodId})
    if (period?.timePeriodTypeId !== "FiscalMonth") denied("PERIOD_NOT_MONTH", "Depreciation runs by fiscal month")
    const thruDay = lib.calendarDateText(period.thruDate)
    const day = p.effectiveDate ? lib.calendarDateText(p.effectiveDate) : thruDay
    const sourceIds = Array.from(p.sourceIdList || [])
    let query = find(ASSET)
        .condition("ownerPartyId", p.organizationPartyId)
        .condition("assetTypeEnumId", "in", fixedTypes())
        .condition("depreciationTypeEnumId", "is-not-null", null)
    if (sourceIds.length) query = query.condition("assetId", "in", sourceIds)
    const results = []
    for (const asset of Array.from(query.orderBy("assetId").list())) {
        if (asset.acquiredDate && stampDay(asset.acquiredDate) > thruDay) continue
        // disposed (here, or sold on an invoice that posted its sale) assets are not depreciated again
        if (asset.actualEndOfLife || soldByInvoice(asset)) continue
        if (one(DEPRECIATION, {assetId: asset.assetId, timePeriodId: period.timePeriodId})) continue
        const result = {sourceEntityName: ASSET, sourceId: asset.assetId, description: asset.assetName || asset.assetId}
        try {
            const out = lib.probe("mantle.ledger.AssetAutoPostServices.calculate#FixedAssetDepreciation", {
                assetId: asset.assetId,
                transactionDate: stamp(day)
            })
            if (out.monthlyDepreciation == null || decimal(out.monthlyDepreciation).isZero()) continue
            const mapping = mappingOf(asset)
            results.push(
                Object.assign(result, {
                    amount: String(out.monthlyDepreciation),
                    debitGlAccountId: mapping.depreciationGlAccountId || null,
                    creditGlAccountId: mapping.accDepreciationGlAccountId || null
                })
            )
        } catch (error) {
            ec.logger.error("Depreciation of asset " + asset.assetId + " for " + period.timePeriodId + ": " + error.message)
            results.push(
                Object.assign(result, {failureCode: "CALCULATION_FAILED", failureMessage: String(error.message)})
            )
        }
    }
    return {results}
}
// Whether a posted sales invoice of the asset's owner sells the asset itself (an ItemAsset line).
function soldByInvoice(asset) {
    return rows("mantle.account.invoice.InvoiceItem", {assetId: asset.assetId, itemTypeEnumId: "ItemAsset"}).some(item => {
        const invoice = one("mantle.account.invoice.Invoice", {invoiceId: item.invoiceId})
        return invoice?.fromPartyId === asset.ownerPartyId && !!find(TRANS, {invoiceId: item.invoiceId, isPosted: "Y"}).count()
    })
}
// One asset's depreciation for the period, in the caller's new transaction: Mantle calculates and posts it with its
// depreciation row; when its transaction did not post, the error rolls both back, so no row is left.
function postAssetPeriod(p) {
    const {asset} = assetScope(p.assetId, "glPost", true)
    if (asset.actualEndOfLife || soldByInvoice(asset)) denied("ASSET_DISPOSED", "The asset was disposed")
    if (one(DEPRECIATION, {assetId: asset.assetId, timePeriodId: p.timePeriodId}))
        denied("ALREADY_DEPRECIATED", "The asset is already depreciated for this period")
    const out = call("mantle.ledger.AssetAutoPostServices.calculateAndPost#FixedAssetDepreciation", {
        assetId: asset.assetId,
        timePeriodId: p.timePeriodId,
        transactionDate: p.transactionDate
    })
    if (!out.acctgTransId) denied("NOTHING_TO_POST", "The asset has no depreciation to post for this period")
    // the amount reviewed in the run: a change rolls this asset back (post#Run checked the run's version before)
    if (p.expectedAmount != null && !decimal(out.monthlyDepreciation).eq(decimal(p.expectedAmount)))
        denied("RUN_CHANGED", "The asset's depreciation changed from " + p.expectedAmount + " to " + out.monthlyDepreciation)
    const tx = one(TRANS, {acctgTransId: out.acctgTransId})
    if (tx?.isPosted !== "Y")
        denied(tx?.postingFailureCode || "POSTING_FAILED", tx?.postingFailureMessage || "The depreciation did not post")
    return {acctgTransId: out.acctgTransId}
}
function postRun(p) {
    const run = one("mantle.ledger.transaction.AccountingPeriodRun", {periodRunId: p.periodRunId})
    const transactionDate = stamp(lib.calendarDateText(run.effectiveDate))
    let postedCount = 0,
        failedCount = 0
    for (const result of rows("mantle.ledger.transaction.AccountingPeriodRunResult", {
        periodRunId: p.periodRunId,
        statusId: "PrrReady"
    })) {
        let acctgTransId = null,
            failure = null
        ec.message.pushErrors()
        try {
            const out =
                ec.service
                    .sync()
                    .name("mantle.ledger.AssetBookServices.post#AssetPeriodDepreciation")
                    .parameters({
                        assetId: result.sourceId,
                        timePeriodId: run.timePeriodId,
                        transactionDate,
                        expectedAmount: result.amount
                    })
                    .disableAuthz()
                    .requireNewTransaction(true)
                    .call() || {}
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
            acctgTransId = out.acctgTransId || null
        } catch (error) {
            ec.logger.error("Depreciation run " + run.periodRunId + " asset " + result.sourceId + ": " + error.message)
            failure = String(error.message)
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
        if (acctgTransId) postedCount++
        else failedCount++
        call("update#mantle.ledger.transaction.AccountingPeriodRunResult", {
            periodRunId: result.periodRunId,
            resultSeqId: result.resultSeqId,
            statusId: acctgTransId ? "PrrPosted" : "PrrFailed",
            acctgTransId,
            failureCode: acctgTransId ? null : /\b([A-Z][A-Z0-9]*_[A-Z0-9_]+):/.exec(failure || "")?.[1] || "POSTING_FAILED",
            failureMessage: acctgTransId ? null : failure
        })
    }
    return {postedCount, failedCount}
}

// A depreciation preview of chosen assets: those of a class, or those chosen, or all.
function previewDepreciation(p) {
    const s = lib.organization(p, "glPost")
    let sourceIdList = Array.from(p.assetIdList || [])
    if (p.classEnumId) {
        const ofClass = Array.from(
            find(ASSET, {ownerPartyId: s.organizationPartyId, classEnumId: p.classEnumId}).selectField("assetId").list()
        ).map(r => r.assetId)
        sourceIdList = sourceIdList.length ? sourceIdList.filter(id => ofClass.includes(id)) : ofClass
        if (!sourceIdList.length) sourceIdList = ["_NONE_"]
    }
    return call("mantle.ledger.PeriodRunServices.preview#Run", {
        runKindEnumId: "PrkDepreciation",
        organizationPartyId: s.organizationPartyId,
        timePeriodId: p.timePeriodId,
        effectiveDate: p.effectiveDate,
        sourceIdList
    })
}
// A depreciation run with each asset's book: cost, residual, depreciation before the period, the period's amount and the
// net book after it.
function depreciationPreview(p) {
    const found = call("mantle.ledger.PeriodRunServices.get#Run", {periodRunId: p.periodRunId})
    if (found.run.runKindEnumId !== "PrkDepreciation") denied("RUN_KIND_INVALID", "This is not a depreciation run")
    const period = one(PERIOD, {timePeriodId: found.run.timePeriodId})
    const fromDay = lib.calendarDateText(period.fromDate)
    const results = Array.from(found.results).map(result => {
        const asset = result.sourceId ? one(ASSET, {assetId: result.sourceId}) : null
        if (!asset) return result
        const prior = depreciationsOf(asset.assetId)
            .filter(d => d.fromDay < fromDay)
            .reduce((sum, d) => sum.add(decimal(d.row.monthlyDepreciation)), toDecimal(0))
        const cost = decimal(asset.acquireCost)
        return Object.assign({}, result, {
            assetId: asset.assetId,
            acquireCost: asset.acquireCost,
            salvageValue: asset.salvageValue,
            priorDepreciation: prior,
            endingNetBook: result.amount == null ? null : cost.subtract(prior).subtract(decimal(result.amount))
        })
    })
    return {run: found.run, results}
}
function postDepreciation(p) {
    const run = one("mantle.ledger.transaction.AccountingPeriodRun", {periodRunId: p.periodRunId})
    if (!run || run.runKindEnumId !== "PrkDepreciation") denied("RUN_KIND_INVALID", "This is not a depreciation run")
    return call("mantle.ledger.PeriodRunServices.post#Run", {
        periodRunId: p.periodRunId,
        calculationVersion: p.calculationVersion,
        operationKey: p.operationKey
    })
}

const operations = {
    storeClass,
    capitalize,
    adjust,
    dispose,
    reverse,
    repairCost,
    book,
    calculateRun,
    postAssetPeriod,
    postRun,
    previewDepreciation,
    depreciationPreview,
    postDepreciation
}
;({
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown fixed asset operation " + op)
        return operations[op](parameters)
    }
})
