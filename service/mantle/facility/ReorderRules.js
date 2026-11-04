// A product's reorder rule at a facility is its ProductFacility row, kept through Warehouse's store#ProductFacilityPolicy
// (CX-FACILITY-POLICY; impl-purchasing P14a, design-purchasing §8 ReorderRules and §15): mantle.facility.ReorderRuleServices'
// suggested levels, previewed from average daily demand × lead time + safety stock and applied row by row through the same
// store, each row's failure named while the others go on (R-PUR-19); and the import of reorder-rule rows, a row kind of
// Products' catalog import, each validated through the store's own checks (WarehousePolicy.js facilityPreview) and stored
// through it with its row result.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, denied, probe, ms} = lib
const policy = () => ec.resource.script("component://mr-mantle/service/mantle/facility/WarehousePolicy.js")
const catalog = () => ec.resource.script("component://mr-mantle/service/mantle/product/CatalogPolicy.js")
const importer = () => ec.resource.script("component://mr-mantle/service/mantle/product/CatalogImport.js")

const STORE = "mantle.facility.FacilityServices.store#ProductFacilityPolicy"
const dayMs = 86400000
const productLimit = 200
const facilityDepth = 4
const levelFields = ["minimumStock", "maximumStock", "reorderQuantity", "reorderMethodEnumId", "daysToShip"]
const numberOf = value => (value == null || value === "" ? null : Number(String(value)))
const text = value => (value == null ? null : String(value))
const listOf = value =>
    value == null || value === ""
        ? []
        : Array.isArray(value) || typeof value !== "string"
          ? Array.from(value).map(String).filter(Boolean)
          : String(value)
                .split(",")
                .map(each => each.trim())
                .filter(Boolean)

// The facility and the facilities under it, a few levels down: the demand history of a rule is issued from any of them.
function facilityTree(facilityId) {
    const ids = [facilityId]
    let level = [facilityId]
    for (let depth = 0; depth < facilityDepth && level.length; depth++) {
        level = Array.from(
            find("mantle.facility.Facility").condition("parentFacilityId", "in", level).selectField("facilityId").list()
        ).map(row => row.facilityId)
        ids.push(...level.filter(id => !ids.includes(id)))
    }
    return ids
}
// The supplier lead time of a product: its current purchase price from another party with the lowest minimum quantity.
function supplierLeadDays(productId, organizationPartyId) {
    const price = rows("mantle.product.ProductPrice", {
        productId,
        pricePurposeEnumId: "PppPurchase",
        priceTypeEnumId: "PptCurrent"
    })
        .filter(row => row.vendorPartyId && row.vendorPartyId !== organizationPartyId && lib.active(row))
        .filter(row => row.standardLeadTimeDays != null)
        .sort((a, b) => Number(String(a.minQuantity ?? 0)) - Number(String(b.minQuantity ?? 0)))[0]
    return price ? Number(String(price.standardLeadTimeDays)) : null
}

// preview#ReorderLevels: per product at the facility, its average daily demand over the history (what was issued from the
// facility and those under it), the lead time (its supplier's, else the one given), the safety stock (safety days of
// demand), and the suggested minimum (demand over the lead time plus the safety stock) and maximum (the minimum plus the
// cover days of demand), rounded up to whole units; a product without demand history or without a lead time is named and
// gets no suggestion.
function preview(p) {
    const guard = policy().execute("guard", {facilityId: p.facilityId, organizationPartyId: p.organizationPartyId || null})
    if (!guard.canPlan) denied("PERMISSION_DENIED", "STOCK_POLICY_PLAN or STOCK_POLICY_MANAGE is required")
    if (guard.facilityId === "_NA_") denied("FACILITY_REQUIRED", "Choose the facility")
    const historyDays = numberOf(p.historyDays) ?? 90,
        safetyDays = numberOf(p.safetyDays) ?? 0,
        coverDays = numberOf(p.coverDays) ?? 30,
        givenLead = numberOf(p.leadTimeDays)
    if (!Number.isInteger(historyDays) || historyDays < 7 || historyDays > 730)
        denied("LEVELS_INVALID", "The demand history is from 7 to 730 days")
    if (![safetyDays, coverDays].every(days => Number.isFinite(days) && days >= 0 && days <= 365))
        denied("LEVELS_INVALID", "Safety and cover days are from 0 to 365")
    if (givenLead != null && !(givenLead >= 0 && givenLead <= 365))
        denied("LEVELS_INVALID", "The lead time is from 0 to 365 days")
    const facilityId = guard.facilityId,
        organizationPartyId = guard.organizationPartyId
    let productIds = listOf(p.productIds).concat(listOf(p.productId))
    if (!productIds.length)
        productIds = Array.from(
            find("mantle.facility.ProductFacility", {facilityId}).selectField("productId").orderBy("productId").list()
        ).map(row => row.productId)
    productIds = Array.from(new Set(productIds)).slice(0, productLimit)
    const tree = facilityTree(facilityId)
    const since = new Date(ms(ec.user.nowTimestamp) - historyDays * dayMs)
    const issued = new Map()
    if (productIds.length)
        for (const row of Array.from(
            find("mantle.product.issuance.AssetIssuance")
                .condition("productId", "in", productIds)
                .condition("facilityId", "in", tree)
                .condition("issuedDate", "greater-equals", since)
                .selectField("productId,quantity,quantityCancelled")
                .list()
        )) {
            const quantity = Number(String(row.quantity ?? 0)) - Number(String(row.quantityCancelled ?? 0))
            issued.set(row.productId, (issued.get(row.productId) || 0) + quantity)
        }
    const products = new Map(
        productIds.length
            ? Array.from(find("mantle.product.Product").condition("productId", "in", productIds).list()).map(row => [
                  row.productId,
                  row
              ])
            : []
    )
    const levelRows = productIds.map(productId => {
        const product = products.get(productId)
        const current = one("mantle.facility.ProductFacility", {productId, facilityId})
        const row = {
            productId,
            pseudoId: product?.pseudoId || productId,
            productName: product?.productName || productId,
            facilityId,
            currentMinimum: text(current?.minimumStock),
            currentMaximum: text(current?.maximumStock),
            reorderMethodEnumId: current?.reorderMethodEnumId || null,
            ok: false
        }
        if (!product) return Object.assign(row, {reasonCode: "PRODUCT_UNAVAILABLE", message: productId + " is not a product"})
        const total = issued.get(productId) || 0
        if (total <= 0)
            return Object.assign(row, {
                reasonCode: "NO_DEMAND_HISTORY",
                message: row.productName + " was not issued from " + facilityId + " in the last " + historyDays + " days"
            })
        const supplierLead = supplierLeadDays(productId, organizationPartyId)
        const lead = supplierLead ?? givenLead
        if (lead == null)
            return Object.assign(row, {
                reasonCode: "NO_LEAD_TIME",
                message: row.productName + " has no supplier lead time; give a lead time"
            })
        const daily = total / historyDays
        const safety = Math.ceil(daily * safetyDays)
        const minimum = Math.ceil(daily * lead) + safety
        const maximum = Math.max(minimum, Math.ceil(minimum + daily * coverDays))
        return Object.assign(row, {
            ok: true,
            averageDailyDemand: String(Math.round(daily * 1000) / 1000),
            leadTimeDays: String(lead),
            leadTimeSource: supplierLead != null ? "Supplier" : "Given",
            safetyStock: String(safety),
            suggestedMinimum: String(minimum),
            suggestedMaximum: String(maximum),
            reasonCode: null,
            message: null
        })
    })
    return {
        organizationPartyId,
        facilityId,
        historyDays,
        levelRows,
        suggestedCount: levelRows.filter(row => row.ok).length,
        failedCount: levelRows.filter(row => !row.ok).length
    }
}

// apply#ReorderLevels: each row's minimum and maximum (and the method given) through store#ProductFacilityPolicy, in its own
// transaction, so a row the store refuses is named with its reason and the others are kept.
function apply(p) {
    const why = String(p.changeReason || "").trim()
    if (!why) denied("REASON_REQUIRED", "Give the reason for the new levels")
    const levelRows = Array.from(p.levelRows || [])
    if (!levelRows.length) denied("ROWS_REQUIRED", "Choose the levels to apply")
    const results = []
    for (const row of levelRows) {
        const productId = row.productId,
            facilityId = row.facilityId || p.facilityId
        try {
            if (row.minimumStock == null || row.minimumStock === "")
                denied("LEVELS_REQUIRED", "No suggested minimum for " + productId)
            const parameters = {
                productId,
                facilityId,
                organizationPartyId: p.organizationPartyId || null,
                minimumStock: row.minimumStock,
                maximumStock: row.maximumStock == null || row.maximumStock === "" ? null : row.maximumStock,
                changeReason: why
            }
            if (p.reorderMethodEnumId) parameters.reorderMethodEnumId = p.reorderMethodEnumId
            probe(STORE, parameters)
            results.push({productId, facilityId, ok: true, reasonCode: null, message: null})
        } catch (error) {
            const message = String(error.message || error).replace(/^(Error: )+/, "")
            ec.logger.warn("Reorder levels of " + productId + " at " + facilityId + " not applied: " + message)
            results.push({productId, facilityId, ok: false, reasonCode: lib.reasonCode({message}) || "NOT_APPLIED", message})
        }
    }
    return {
        results,
        appliedCount: results.filter(row => row.ok).length,
        failedCount: results.filter(row => !row.ok).length
    }
}

// validate#ReorderRuleImportRow: a reorder-rule row of the catalog import (kind reorderRules): the product and facility of
// the import's organization, the update mode against the rule there, and the values checked by the store's own rules; the
// normalized parameters are the store's.
function validateImportRow(p) {
    const s = catalog().organization(p, "read")
    const cfg = importer().kind(p.kindId, s, true)
    const allowed = new Set([...cfg.columns.map(column => column.name), ...Object.keys(cfg.fixedParameters)])
    const data = Object.fromEntries(Object.entries(p.rowParameters || {}).filter(([key]) => allowed.has(key)))
    const facility = data.facilityId ? one("mantle.facility.Facility", {facilityId: data.facilityId}) : null
    if (!facility) throw new Error("Facility " + (data.facilityId || "") + " is not available")
    if (facility.ownerPartyId !== s.organizationPartyId) throw new Error("Facility is outside the selected import organization")
    const before = data.productId
        ? one("mantle.facility.ProductFacility", {productId: data.productId, facilityId: data.facilityId})
        : null
    const mode = p.updateMode || "upsert"
    if (mode === "create" && before) throw new Error("Update key already exists; choose Update or Upsert")
    if (mode === "update" && !before) throw new Error("Update key is not available; choose Create or Upsert")
    const parameters = Object.assign({}, data, {
        organizationPartyId: s.organizationPartyId,
        changeReason: String(data.changeReason || "").trim() || "Reorder rule import"
    })
    const checked = policy().execute("facilityPreview", parameters)
    const given = Object.keys(data).filter(key => !["productId", "facilityId", "changeReason"].includes(key))
    const normalizedParameters = Object.assign(
        {productId: checked.productId, facilityId: checked.facilityId, organizationPartyId: s.organizationPartyId},
        Object.fromEntries(given.map(key => [key, checked.values[key] ?? null])),
        {changeReason: checked.values.changeReason}
    )
    const changes = given
        .filter(key => String(checked.before?.[key] ?? "") !== String(checked.values[key] ?? ""))
        .map(field => ({
            field,
            before: checked.before?.[field] == null ? null : String(checked.before[field]),
            after: checked.values[field] == null ? null : String(checked.values[field])
        }))
    return {
        valid: true,
        errors: [],
        warnings: [],
        normalizedParameters,
        sourceFingerprint: catalog().fingerprint({
            registry: lib.map(one("mantle.product.ProductCatalogImportKind", {kindId: p.kindId})),
            rule: before
                ? Object.fromEntries(levelFields.concat(["snoozeThruDate", "snoozeReason"]).map(k => [k, text(before[k])]))
                : null
        }),
        changes
    }
}

const operations = {preview, apply, validateImportRow}
;({
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown reorder rule operation " + op)
        return operations[op](parameters || {})
    }
})
