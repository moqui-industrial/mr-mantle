// Price-row invariants and the shared direction/organization boundary. Disabling artifact authorization never grants a price capability.
const P = "mantle.product.",
    E = P + "ProductPrice",
    PS = P + "PriceServices."
const find = (n, p) =>
    ec.entity
        .find(n)
        .condition(p || {})
        .disableAuthz()
const one = (n, p) => find(n, p).one()
const rows = (n, p) => Array.from(find(n, p).list())
const map = r => (r.getMap ? r.getMap() : Object.assign({}, r))
const ms = v => (v == null || v === "" ? null : Number.isFinite(Number(String(v))) ? Number(String(v)) : Date.parse(String(v)))
const call = (n, p) => {
    const out =
        ec.service
            .sync()
            .name(n)
            .parameters(p || {})
            .disableAuthz()
            .call() || {}
    if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
    return out
}
const internal = id => !!id && !!one("mantle.party.PartyRole", {partyId: id, roleTypeId: "OrgInternal"})
const has = permission => ec.resource.script("component://mr-mantle/service/mantle/product/ProductAccess.js").has(permission)
const optional = [
    "productStoreId",
    "vendorPartyId",
    "customerPartyId",
    "pricePurposeEnumId",
    "quantityUomId",
    "termUomId",
    "agreementId",
    "agreementItemSeqId"
]
const writeFields =
    "productId,productStoreId,vendorPartyId,customerPartyId,priceTypeEnumId,pricePurposeEnumId,fromDate,thruDate,minQuantity,price,priceUomId,termUomId,taxInPrice,taxAmount,taxPercentage,taxAuthorityId,agreementId,agreementItemSeqId,otherPartyItemName,otherPartyItemId,comments,quantityIncrement,quantityIncluded,quantityUomId,preferredOrderEnumId,supplierRatingTypeEnumId,standardLeadTimeDays,canDropShip,changeReason".split(
        ","
    )
const pick = (p, keys) =>
    Object.fromEntries(keys.filter(k => Object.keys(p).includes(k)).map(k => [k, p[k] === "" ? null : p[k]]))
function direction(r) {
    return internal(r.vendorPartyId)
        ? "sales"
        : r.vendorPartyId && internal(r.customerPartyId)
          ? "purchase"
          : !r.vendorPartyId && !r.customerPartyId
            ? "public"
            : "invalid"
}
// An access refusal with a reason a caller may test (only "direction" is tested today), never its wording.
function denied(reason, message) {
    const error = new Error(message)
    error.reason = reason
    return error
}
function access(r, write = false) {
    const scope = call(P + "ProductServices.get#CatalogOwnerScope"),
        admin = scope.systemAdmin,
        b = one(P + "Product", {productId: r.productId}),
        d = direction(r)
    if (!b || (!admin && !scope.ownerPartyIds.includes(b.ownerPartyId))) throw new Error("Price record is not available")
    const org = d === "sales" ? r.vendorPartyId : d === "purchase" ? r.customerPartyId : null
    for (const id of [r.vendorPartyId, r.customerPartyId].filter(Boolean)) {
        const party = one("mantle.party.Party", {partyId: id})
        if (
            !party ||
            (party.privateOwnerUserId && party.privateOwnerUserId !== ec.user.userId) ||
            (!admin && !scope.ownerPartyIds.includes(party.ownerPartyId) && !scope.organizationPartyIds.includes(id))
        )
            throw new Error("Price counterparty is not available")
    }
    if (r.productStoreId) {
        const store = one(P + "store.ProductStore", {productStoreId: r.productStoreId})
        if (!store || (!admin && !scope.ownerPartyIds.includes(store.organizationPartyId)))
            throw new Error("Price store is not available")
    }
    if (r.agreementId) {
        const agr = one("mantle.party.agreement.Agreement", {agreementId: r.agreementId})
        if (!agr || (!admin && !scope.ownerPartyIds.includes(agr.organizationPartyId)))
            throw new Error("Price agreement is not available")
        const other = agr.otherPartyId ? one("mantle.party.Party", {partyId: agr.otherPartyId}) : null
        if (other?.privateOwnerUserId && other.privateOwnerUserId !== ec.user.userId)
            throw new Error("Price agreement is not available")
        // a purchase agreement's price is part of the agreement, changed and approved with it (store#AgreementItem, P13)
        if (write && agr.agreementTypeEnumId === "AgrPurchase")
            throw new Error("A purchase agreement's price changes on the agreement")
    }
    if (d === "invalid" || (write && d === "public" && !admin))
        throw denied("direction", "Choose an internal sales vendor, or an external supplier and an internal buying organization")
    if (org && !admin && !scope.ownerPartyIds.includes(org)) throw new Error("Price organization is not available")
    if (r.priceTypeEnumId === "PptAverage") {
        if (
            !admin &&
            (write ||
                (!has("PRODUCT_COST_VIEW") &&
                    !has("PRODUCT_COST_ESTIMATE") &&
                    !has("PRODUCT_COST_APPROVE") &&
                    !has("ACCOUNTING_VIEW") &&
                    !has("ACCOUNTING_GL_POST")))
        )
            throw new Error("Cost authority is required; maintain valuation costs in their owning application")
    } else {
        const group = d === "purchase" ? "SUPPLIER_PRICE_" : "PRICE_"
        if (!admin && !(write ? has(group + "EDIT") : has(group + "VIEW") || has(group + "EDIT")))
            throw new Error(d === "purchase" ? "Supplier-price authority is required" : "Sales-price authority is required")
    }
    return {direction: d, organizationPartyId: org, product: b, systemAdmin: admin, scope}
}
function lock(r) {
    find("moqui.basic.EnumerationType", {enumTypeId: "ProductPriceType"}).forUpdate(true).one()
    find(P + "Product", {productId: r.productId})
        .forUpdate(true)
        .one()
}
function overlaps(a, b) {
    if (
        a.productId !== b.productId ||
        a.priceTypeEnumId !== b.priceTypeEnumId ||
        a.priceUomId !== b.priceUomId ||
        toDecimal(a.minQuantity || 0).compare(b.minQuantity || 0) !== 0
    )
        return false
    if (
        optional.filter(k => a[k] != null).length !== optional.filter(k => b[k] != null).length ||
        optional.some(k => a[k] != null && b[k] != null && String(a[k]) !== String(b[k]))
    )
        return false
    return (
        Math.max(ms(a.fromDate) ?? -Infinity, ms(b.fromDate) ?? -Infinity) <
        Math.min(ms(a.thruDate) ?? Infinity, ms(b.thruDate) ?? Infinity)
    )
}
function validate(r, ignoreIds = []) {
    const a = access(r, true)
    if (a.direction === "public") throw new Error("New or corrected prices require an explicit internal sales vendor")
    const policy = rows(P + "ProductPricingSetting", {organizationPartyId: a.organizationPartyId})
        .filter(s => (ms(s.fromDate) ?? -Infinity) <= ms(r.fromDate) && (ms(s.thruDate) ?? Infinity) > ms(r.fromDate))
        .sort((a, b) => ms(b.fromDate) - ms(a.fromDate))[0]
    if (
        !ignoreIds.length &&
        policy?.allowedPurposeIds &&
        r.pricePurposeEnumId &&
        !String(policy.allowedPurposeIds).split(",").includes(r.pricePurposeEnumId)
    )
        throw new Error("Purpose is not permitted by the dated pricing policy")
    if (one("moqui.basic.Enumeration", {enumId: r.priceTypeEnumId})?.enumTypeId !== "ProductPriceType")
        throw new Error("Choose a price type")
    if (
        r.pricePurposeEnumId &&
        one("moqui.basic.Enumeration", {enumId: r.pricePurposeEnumId})?.enumTypeId !== "ProductPricePurpose"
    )
        throw new Error("Choose a price purpose")
    if (one("moqui.basic.Uom", {uomId: r.priceUomId})?.uomTypeEnumId !== "UT_CURRENCY_MEASURE")
        throw new Error("Choose a price currency")
    if (r.price == null || toDecimal(r.price).compare(0) < 0) throw new Error("Price must be zero or positive")
    if (toDecimal(r.minQuantity || 0).compare(0) < 0) throw new Error("Minimum quantity cannot be negative")
    const from = ms(r.fromDate),
        thru = ms(r.thruDate)
    if (from == null || !Number.isFinite(from) || (thru != null && (!Number.isFinite(thru) || thru <= from)))
        throw new Error("End must follow a valid price start")
    if (r.quantityUomId) {
        const u = one("moqui.basic.Uom", {uomId: r.quantityUomId})
        if (
            !u ||
            u.uomTypeEnumId === "UT_CURRENCY_MEASURE" ||
            /PACK|CASE|BOX/.test(u.uomTypeEnumId || "") ||
            (u.uomTypeEnumId === "UT_OTHER_MEASURE" && !["OTH_ea", "OTH_ct", "OTH_pp"].includes(r.quantityUomId))
        )
            throw new Error("Use a stock quantity unit; a case or pack offer prices its pack product")
    }
    for (const [field, type] of [
        ["preferredOrderEnumId", "SupplierPreferredOrder"],
        ["supplierRatingTypeEnumId", "SupplierRatingType"]
    ])
        if (r[field] && one("moqui.basic.Enumeration", {enumId: r[field]})?.enumTypeId !== type)
            throw new Error("Choose a valid " + field)
    if (r.termUomId && !one("moqui.basic.Uom", {uomId: r.termUomId})) throw new Error("Choose a term unit")
    for (const k of ["quantityIncrement", "quantityIncluded", "standardLeadTimeDays"])
        if (r[k] != null && toDecimal(r[k]).compare(0) < 0) throw new Error(k + " cannot be negative")
    for (const k of ["taxInPrice", "canDropShip"])
        if (r[k] != null && !["Y", "N"].includes(r[k])) throw new Error("Choose Yes or No for " + k)
    if (r.taxInPrice === "Y" && (!r.taxAuthorityId || !one("mantle.other.tax.TaxAuthority", {taxAuthorityId: r.taxAuthorityId})))
        throw new Error("Choose the authority for included tax")
    if (r.taxPercentage != null && (toDecimal(r.taxPercentage).compare(0) < 0 || toDecimal(r.taxPercentage).compare(100) > 0))
        throw new Error("Tax percentage must be between zero and 100")
    for (const id of [r.vendorPartyId, r.customerPartyId].filter(Boolean)) {
        const party = one("mantle.party.Party", {partyId: id})
        if (
            !party ||
            (party.privateOwnerUserId && party.privateOwnerUserId !== ec.user.userId) ||
            (!a.systemAdmin && !a.scope.ownerPartyIds.includes(party.ownerPartyId) && !a.scope.organizationPartyIds.includes(id))
        )
            throw new Error("Price counterparty is not available")
    }
    if (a.direction === "purchase" && !one("mantle.party.PartyRole", {partyId: r.vendorPartyId, roleTypeId: "Supplier"}))
        throw new Error("Choose a supplier in the Supplier role")
    if (r.productStoreId) {
        const store = one(P + "store.ProductStore", {productStoreId: r.productStoreId})
        if (!store || store.organizationPartyId !== a.organizationPartyId)
            throw new Error("Store is not in the price organization")
    }
    if (r.agreementItemSeqId && !r.agreementId) throw new Error("Choose the agreement for its item")
    if (r.agreementId) {
        const agr = one("mantle.party.agreement.Agreement", {agreementId: r.agreementId})
        if (!agr || agr.organizationPartyId !== a.organizationPartyId)
            throw new Error("Agreement is not in the price organization")
        if (
            r.agreementItemSeqId &&
            !one("mantle.party.agreement.AgreementItem", {agreementId: r.agreementId, agreementItemSeqId: r.agreementItemSeqId})
        )
            throw new Error("Agreement item is not available")
    }
    // Null scopes match any value; two intersecting scopes with the same specificity and tier would have equal precedence.
    for (const other of rows(E, {productId: r.productId, priceTypeEnumId: r.priceTypeEnumId, priceUomId: r.priceUomId})) {
        if (!ignoreIds.includes(other.productPriceId) && overlaps(r, other))
            throw new Error("Another price row overlaps this tier at equal precedence")
    }
    return a
}
function fresh(p) {
    const row = p.productPriceId ? one(E, {productPriceId: p.productPriceId}) : null
    if (row && p.productId && row.productId !== p.productId) throw new Error("Price record is not available")
    if (p.productPriceId && !row) throw new Error("Price record is not available")
    if (row && p.expectedState && p.expectedState !== ec.user.singleUseCodeHash(JSON.stringify(map(row))))
        throw new Error("Price changed; preview again before applying")
    if (row && p.expectedLastUpdatedStamp && ms(row.lastUpdatedStamp) !== ms(p.expectedLastUpdatedStamp))
        throw new Error("Price changed; reload before saving")
    return row
}
function prepare(p, locking = false) {
    let old = fresh(p),
        data = Object.assign(
            {},
            old ? map(old) : {fromDate: ec.user.nowTimestamp, minQuantity: 0, pricePurposeEnumId: "PppPurchase"},
            pick(p, writeFields)
        )
    if (!data.fromDate) data.fromDate = old?.fromDate || ec.user.nowTimestamp
    access(data, true)
    if (locking) {
        lock(data)
        old = fresh(p)
    }
    if (old) {
        access(old, true)
        if (["productId", ...optional, "priceTypeEnumId", "priceUomId"].some(k => String(old[k] ?? "") !== String(data[k] ?? "")))
            throw new Error("Price scope is fixed; create a separate dated row for another scope")
        if (
            find("mantle.order.OrderItem", {productPriceId: old.productPriceId}).count() > 0 &&
            writeFields.some(k => String(old[k] ?? "") !== String(data[k] ?? ""))
        )
            throw new Error("This price is referenced; schedule a successor instead of editing it")
        if (!String(p.changeReason || "").trim()) throw new Error("Give a reason for the correction")
    }
    validate(data, old ? [old.productPriceId] : [])
    if (old) data.productPriceId = old.productPriceId
    return {old, data}
}
function preview(p) {
    const prepared = prepare(p),
        old = prepared.old
    return {
        normalizedParameters: Object.assign(
            {},
            pick(prepared.data, ["productPriceId", ...writeFields]),
            old ? {productPriceId: old.productPriceId, expectedState: ec.user.singleUseCodeHash(JSON.stringify(map(old)))} : {}
        ),
        before: old ? map(old) : null,
        priceRows: findPrices({productId: prepared.data.productId, includeHistory: true}).productPriceList
    }
}
function store(p) {
    const prepared = prepare(p, true),
        old = prepared.old
    if (p.catalogOperationKey) {
        const op = one(P + "ProductCatalogOperation", {operationKey: p.catalogOperationKey}),
            org = direction(prepared.data) === "purchase" ? prepared.data.customerPartyId : prepared.data.vendorPartyId
        if (
            !op ||
            op.operationType !== "import" ||
            !op.inputFingerprint ||
            !["validated", "partial"].includes(op.state) ||
            op.ownerPartyId !== org ||
            (op.submittedByUserId !== ec.user.userId && !has("ADMIN"))
        )
            throw new Error("A validated import of this actor and organization is required")
    }
    const saved = call((old ? "update#" : "create#") + E, pick(prepared.data, ["productPriceId", ...writeFields]))
    return {productPriceId: old?.productPriceId || saved.productPriceId}
}

function replace(p) {
    let old = fresh(p)
    if (!old) throw new Error("Choose the source price")
    access(old, true)
    lock(old)
    old = fresh(p)
    const at = ms(p.effectiveDate),
        end = ms(old.thruDate)
    if (!Number.isFinite(at) || at < ms(ec.user.nowTimestamp) || at <= ms(old.fromDate) || (end != null && at >= end))
        throw new Error("Successor must start now or later, within the source interval")
    if (!String(p.changeReason || "").trim()) throw new Error("Give a reason for the price change")
    const next = Object.assign(map(old), {
        productPriceId: null,
        fromDate: new Date(at).toISOString(),
        price: p.price,
        changeReason: p.changeReason
    })
    validate(next, [old.productPriceId])
    call("update#" + E, {productPriceId: old.productPriceId, thruDate: new Date(at).toISOString(), changeReason: p.changeReason})
    const out = call("create#" + E, pick(next, writeFields))
    return {productPriceId: out.productPriceId, previousProductPriceId: old.productPriceId}
}
function expire(p) {
    let old = fresh(p)
    if (!old) throw new Error("Choose the price to end")
    access(old, true)
    lock(old)
    old = fresh(p)
    const at = ms(p.thruDate || ec.user.nowTimestamp)
    if (
        !Number.isFinite(at) ||
        at < ms(ec.user.nowTimestamp) ||
        at <= ms(old.fromDate) ||
        (ms(old.thruDate) != null && at > ms(old.thruDate))
    )
        throw new Error("Choose an end now or later within the price interval")
    if (!String(p.changeReason || "").trim()) throw new Error("Give a reason for ending the price")
    call("update#" + E, {productPriceId: old.productPriceId, thruDate: new Date(at).toISOString(), changeReason: p.changeReason})
    return {productPriceId: old.productPriceId}
}
function findPrices(p) {
    const scope = call(P + "ProductServices.get#CatalogOwnerScope"),
        b = one(P + "Product", {productId: p.productId})
    if (!b || (!scope.systemAdmin && !scope.ownerPartyIds.includes(b.ownerPartyId))) throw new Error("Product is not available")
    const canRead =
        scope.systemAdmin ||
        [
            "PRICE_VIEW",
            "PRICE_EDIT",
            "SUPPLIER_PRICE_VIEW",
            "SUPPLIER_PRICE_EDIT",
            "PRODUCT_COST_VIEW",
            "PRODUCT_COST_ESTIMATE",
            "PRODUCT_COST_APPROVE"
        ].some(has)
    if (!canRead) throw new Error("Price read authority is required")
    const at = ms(p.asOfDate || ec.user.nowTimestamp),
        out = []
    for (const row of rows(E, {productId: p.productId})) {
        if (p.productPriceId && row.productPriceId !== p.productPriceId) continue
        if (
            !p.includeHistory &&
            !p.productPriceId &&
            ((ms(row.fromDate) != null && ms(row.fromDate) > at) || (ms(row.thruDate) != null && ms(row.thruDate) <= at))
        )
            continue
        if (p.priceTypeEnumId && row.priceTypeEnumId !== p.priceTypeEnumId) continue
        try {
            const a = access(row)
            if (
                p.direction &&
                p.direction !== "all" &&
                a.direction !== p.direction &&
                !(p.direction === "sales" && a.direction === "public")
            )
                continue
            out.push(map(row))
        } catch (e) {
            /* Not readable in this owner/direction scope; no values leave the boundary. */
        }
    }
    return {productPriceList: out, productPrice: p.productPriceId ? out[0] || null : null}
}
// A legacy row may have been repurposed before its scope became immutable: its earlier amounts are visible only when
// every earlier scope in its audit log is readable too. A system administrator may read a scope whose only fault is a
// direction the current rules no longer allow.
const scopeFields = ["productId", "vendorPartyId", "customerPartyId", "productStoreId", "agreementId", "priceTypeEnumId"]
function earlierScopesVisible(p) {
    const row = one(E, {productPriceId: p.productPriceId})
    if (!row) return {visible: false}
    const admin = call(P + "ProductServices.get#CatalogOwnerScope").systemAdmin
    const logs = rows("moqui.entity.EntityAuditLog", {changedEntityName: E, pkPrimaryValue: row.productPriceId}).filter(
        log => scopeFields.includes(log.changedFieldName) && log.oldValueText != null && log.oldValueText !== log.newValueText
    )
    for (const log of logs) {
        try {
            access(Object.assign(map(row), {[log.changedFieldName]: log.oldValueText}))
        } catch (e) {
            if (!(admin && e.reason === "direction")) return {visible: false}
        }
    }
    return {visible: true}
}
function execute(op, p) {
    if (["store", "replace", "expire"].includes(op))
        ec.context.putAll(Object.fromEntries(writeFields.map(field => [field + "_changeReason", p.changeReason || "New price"])))
    return {
        store,
        replace,
        expire,
        access,
        writeAccess: r => access(r, true),
        validate,
        direction,
        findPrices,
        preview,
        earlierScopesVisible
    }[op](p)
}
;({execute, direction, overlaps})
