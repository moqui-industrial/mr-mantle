// Dated pricing policies. Role associations carry counterparties; audit rows carry changes.
const P = "mantle.product.",
    L = P + "ProductPriceList",
    R = P + "ProductPriceRule",
    A = P + "ProductPriceListParty",
    S = P + "ProductPricingSetting"
const find = (name, where = {}) => ec.entity.find(name).condition(where).disableAuthz()
const one = (name, where) => find(name, where).one()
const rows = (name, where) => Array.from(find(name, where).list())
const map = r => (r?.getMap ? r.getMap() : Object.assign({}, r))
const ms = v => (v == null || v === "" ? null : Number.isFinite(Number(String(v))) ? Number(String(v)) : Date.parse(String(v)))
const at = (r, date) => (ms(r.fromDate) ?? -Infinity) <= ms(date) && (ms(r.thruDate) ?? Infinity) > ms(date)
const iso = v => new Date(ms(v)).toISOString()
const call = (name, params = {}) => {
    const out = ec.service.sync().name(name).parameters(params).disableAuthz().call() || {}
    if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
    return out
}
const pick = (p, fields) =>
    Object.fromEntries(fields.filter(k => Object.keys(p).includes(k)).map(k => [k, p[k] === "" ? null : p[k]]))
const listFields =
    "listName,organizationPartyId,direction,pricePurposeEnumId,priceUomId,productStoreId,agreementId,agreementItemSeqId,partyClassificationId,geoId,priority,state,fromDate,thruDate,changeReason".split(
        ","
    )
const ruleFields =
    "priceListId,sequenceNum,selector,productId,productCategoryId,productFeatureId,partyClassificationId,geoId,minQuantity,maxQuantity,quantityUomId,fromDate,thruDate,baseType,basePriceTypeEnumId,basePriceListId,fixedPrice,percentChange,amountChange,roundingIncrement,minimumPrice,maximumPrice,changeReason".split(
        ","
    )
const settingFields =
    "defaultPriceListId,defaultCurrencyUomId,defaultPurposeEnumId,roundingIncrement,allowedPurposeIds,changeReason".split(",")
const has = permission => ec.resource.script("component://mr-mantle/service/mantle/product/ProductAccess.js").has(permission)
function scope() {
    return call(P + "ProductServices.get#CatalogOwnerScope")
}
function guard(r, write = false) {
    const s = scope(),
        group = r.direction === "purchase" ? "SUPPLIER_PRICE_" : "PRICE_"
    if (
        !ec.user.userId ||
        (!s.systemAdmin &&
            (!s.ownerPartyIds.includes(r.organizationPartyId) ||
                !(write ? has(group + "EDIT") : has(group + "VIEW") || has(group + "EDIT"))))
    )
        throw new Error("Price list is not available in your direction and organization")
    return s
}
function party(id, s) {
    const p = one("mantle.party.Party", {partyId: id})
    if (
        !p ||
        (p.privateOwnerUserId && p.privateOwnerUserId !== ec.user.userId) ||
        (!s.systemAdmin && !s.ownerPartyIds.includes(p.ownerPartyId) && !s.organizationPartyIds.includes(id))
    )
        throw new Error("Price-list party is not available")
    return p
}
function getList(id, write = false) {
    const r = one(L, {priceListId: id})
    if (!r) throw new Error("Price list is not available")
    const s = guard(r, write)
    for (const role of rows(A, {priceListId: id})) party(role.partyId, s)
    return r
}
function audit(fields, reason) {
    ec.context.putAll(Object.fromEntries(fields.map(k => [k + "_changeReason", reason])))
}
function interval(r) {
    if (
        !Number.isFinite(ms(r.fromDate)) ||
        (r.thruDate && (!Number.isFinite(ms(r.thruDate)) || ms(r.thruDate) <= ms(r.fromDate)))
    )
        throw new Error("Choose a valid effective interval")
}
function reason(p) {
    if (!String(p.changeReason || "").trim()) throw new Error("Give a reason for the policy change")
}
function lock() {
    find("moqui.basic.EnumerationType", {enumTypeId: "ProductPriceType"}).forUpdate(true).one()
}
function assertStamp(old, p) {
    if (p.expectedLastUpdatedStamp && ms(old.lastUpdatedStamp) !== ms(p.expectedLastUpdatedStamp))
        throw new Error("Policy changed; reload before saving")
}
function validateList(r) {
    const s = guard(r, true)
    interval(r)
    if (!String(r.listName || "").trim() || !["sales", "purchase"].includes(r.direction))
        throw new Error("Choose a name and sales or purchase direction")
    if (!one("mantle.party.PartyRole", {partyId: r.organizationPartyId, roleTypeId: "OrgInternal"}))
        throw new Error("Choose an internal organization")
    if (one("moqui.basic.Uom", {uomId: r.priceUomId})?.uomTypeEnumId !== "UT_CURRENCY_MEASURE")
        throw new Error("Choose a currency")
    const setting = rows(S, {organizationPartyId: r.organizationPartyId})
        .filter(s => at(s, r.fromDate))
        .sort((a, b) => ms(b.fromDate) - ms(a.fromDate))[0]
    if (
        setting?.allowedPurposeIds &&
        r.pricePurposeEnumId &&
        !String(setting.allowedPurposeIds).split(",").includes(r.pricePurposeEnumId)
    )
        throw new Error("Purpose is not permitted by the dated pricing policy")
    if (
        r.pricePurposeEnumId &&
        one("moqui.basic.Enumeration", {enumId: r.pricePurposeEnumId})?.enumTypeId !== "ProductPricePurpose"
    )
        throw new Error("Choose a price purpose")
    if (
        r.productStoreId &&
        one(P + "store.ProductStore", {productStoreId: r.productStoreId})?.organizationPartyId !== r.organizationPartyId
    )
        throw new Error("Store belongs to another organization")
    if (r.agreementId) {
        const agreement = one("mantle.party.agreement.Agreement", {agreementId: r.agreementId})
        if (!agreement || agreement.organizationPartyId !== r.organizationPartyId)
            throw new Error("Agreement belongs to another organization")
        if (agreement.otherPartyId) party(agreement.otherPartyId, s)
    }
    if (
        r.agreementItemSeqId &&
        (!r.agreementId ||
            !one("mantle.party.agreement.AgreementItem", {agreementId: r.agreementId, agreementItemSeqId: r.agreementItemSeqId}))
    )
        throw new Error("Choose the agreement item")
    if (r.geoId && !one("moqui.basic.Geo", {geoId: r.geoId})) throw new Error("Choose a geography")
    if (r.partyClassificationId && !one("mantle.party.PartyClassification", {partyClassificationId: r.partyClassificationId}))
        throw new Error("Choose a party classification")
    return s
}
function parties(id, date) {
    return rows(A, {priceListId: id}).filter(r => at(r, date))
}
function listInfo(r, date) {
    const result = map(r)
    result.parties = parties(r.priceListId, date).map(map)
    result.effective = at(r, date) && r.state === "published"
    return result
}
function findLists(p) {
    const date = p.asOfDate || ec.user.nowTimestamp,
        out = []
    for (const r of rows(L)) {
        try {
            getList(r.priceListId)
            if (
                (p.organizationPartyId && r.organizationPartyId !== p.organizationPartyId) ||
                (p.direction && r.direction !== p.direction) ||
                (p.priceUomId && r.priceUomId !== p.priceUomId) ||
                (p.pricePurposeEnumId && r.pricePurposeEnumId !== p.pricePurposeEnumId) ||
                (p.state && r.state !== p.state) ||
                (!p.includeHistory && !at(r, date))
            )
                continue
            out.push(listInfo(r, date))
        } catch (e) {
            /* Inaccessible policies never enter the projection. */
        }
    }
    out.sort(
        (a, b) => Number(a.priority || 0) - Number(b.priority || 0) || String(a.priceListId).localeCompare(String(b.priceListId))
    )
    return {priceListRows: out}
}
function findRules(p) {
    const list = getList(p.priceListId),
        date = p.asOfDate || ec.user.nowTimestamp
    return {
        priceList: listInfo(list, date),
        priceRuleRows: rows(R, {priceListId: p.priceListId})
            .filter(r => p.includeHistory || at(r, date))
            .sort(
                (a, b) =>
                    Number(a.sequenceNum) - Number(b.sequenceNum) || String(a.priceRuleId).localeCompare(String(b.priceRuleId))
            )
            .map(map)
    }
}
function storeRoles(id, p, list, s) {
    audit(["partyId", "roleTypeId", "fromDate", "thruDate"], p.changeReason)
    for (const [field, role] of [
        ["vendorPartyId", "Vendor"],
        ["customerPartyId", "Customer"]
    ])
        if (p[field]) {
            party(p[field], s)
            if (
                (list.direction === "sales" && role === "Vendor" && p[field] !== list.organizationPartyId) ||
                (list.direction === "purchase" && role === "Customer" && p[field] !== list.organizationPartyId)
            )
                throw new Error("The internal pricing party must match the list organization")
            if (
                list.direction === "purchase" &&
                role === "Vendor" &&
                !one("mantle.party.PartyRole", {partyId: p[field], roleTypeId: "Supplier"})
            )
                throw new Error("Choose a supplier")
            call("create#" + A, {
                priceListId: id,
                partyId: p[field],
                roleTypeId: role,
                fromDate: list.fromDate,
                thruDate: list.thruDate,
                changeReason: p.changeReason
            })
        }
}
function storeList(p) {
    lock()
    reason(p)
    const old = p.priceListId ? getList(p.priceListId, true) : null,
        source = old || (p.cloneFromPriceListId ? getList(p.cloneFromPriceListId) : null)
    if (old) assertStamp(old, p)
    const data = Object.assign(
        {direction: "sales", priority: 100, fromDate: ec.user.nowTimestamp, state: "draft"},
        source ? map(source) : {},
        pick(p, listFields),
        {state: "draft"}
    )
    if (!data.fromDate) data.fromDate = ec.user.nowTimestamp
    const s = validateList(data)
    audit(listFields, p.changeReason)
    // A changed policy receives a new dated identity, retaining prior transaction references.
    if (old) {
        if (["organizationPartyId", "direction", "priceUomId"].some(k => data[k] !== old[k]))
            throw new Error("Create a separate list for another organization, direction or currency")
        const date = ms(p.fromDate || new Date(Math.max(ms(ec.user.nowTimestamp), ms(old.fromDate) + 1)))
        if (date <= ms(old.fromDate) || (ms(old.thruDate) != null && date >= ms(old.thruDate)))
            throw new Error("Successor must start within and after the prior interval start")
        data.fromDate = iso(date)
        call("update#" + L, {priceListId: old.priceListId, thruDate: data.fromDate, changeReason: p.changeReason})
    }
    const saved = call("create#" + L, pick(data, listFields)),
        id = saved.priceListId
    if (source) {
        for (const r of rows(R, {priceListId: source.priceListId}).filter(r => at(r, data.fromDate)))
            call(
                "create#" + R,
                Object.assign(pick(map(r), ruleFields), {
                    priceListId: id,
                    fromDate: data.fromDate,
                    thruDate: data.thruDate,
                    changeReason: p.changeReason
                })
            )
        const prior = Object.fromEntries(
            parties(source.priceListId, data.fromDate).map(r => [
                r.roleTypeId === "Vendor" ? "vendorPartyId" : "customerPartyId",
                r.partyId
            ])
        )
        storeRoles(id, Object.assign(prior, p), data, s)
    } else storeRoles(id, p, data, s)
    return {priceListId: id}
}
function cycle(listId, baseId, from, thru, path = []) {
    if (from >= thru) return
    if (baseId === listId || path.includes(baseId)) throw new Error("Price-list base cycle")
    const base = getList(baseId),
        start = Math.max(from, ms(base.fromDate) ?? -Infinity),
        end = Math.min(thru, ms(base.thruDate) ?? Infinity)
    for (const rule of rows(R, {priceListId: baseId}).filter(r => r.baseType === "list"))
        cycle(
            listId,
            rule.basePriceListId,
            Math.max(start, ms(rule.fromDate) ?? -Infinity),
            Math.min(end, ms(rule.thruDate) ?? Infinity),
            path.concat(baseId)
        )
}
function validateRule(r, ignoreId) {
    const list = getList(r.priceListId, true)
    interval(r)
    if (!Number.isInteger(Number(r.sequenceNum)) || Number(r.sequenceNum) < 0)
        throw new Error("Choose a nonnegative integer sequence")
    if (!["all", "product", "category", "feature"].includes(r.selector)) throw new Error("Choose a rule selector")
    const selectorField = {product: "productId", category: "productCategoryId", feature: "productFeatureId"}[r.selector],
        selectorEntity = {
            product: P + "Product",
            category: P + "category.ProductCategory",
            feature: P + "feature.ProductFeature"
        }[r.selector]
    if (selectorField) {
        const selected = one(selectorEntity, {[selectorField]: r[selectorField]}),
            s = scope()
        if (!selected || (!s.systemAdmin && !s.ownerPartyIds.includes(selected.ownerPartyId)))
            throw new Error("Rule selector is not available")
    }
    if (
        toDecimal(r.minQuantity || 0).compare(0) < 0 ||
        (r.maxQuantity != null && toDecimal(r.maxQuantity).compare(r.minQuantity || 0) <= 0)
    )
        throw new Error("Maximum quantity must be above the minimum")
    if (r.quantityUomId) {
        const u = one("moqui.basic.Uom", {uomId: r.quantityUomId})
        if (
            !u ||
            u.uomTypeEnumId === "UT_CURRENCY_MEASURE" ||
            (u.uomTypeEnumId === "UT_OTHER_MEASURE" && !["OTH_ea", "OTH_ct", "OTH_pp"].includes(r.quantityUomId))
        )
            throw new Error("Choose a dimensional quantity unit, not a product pack")
    }
    if (!["typed", "fixed", "list", "standard"].includes(r.baseType)) throw new Error("Choose a rule base")
    if (r.baseType === "standard") {
        if (list.direction !== "sales") throw new Error("Standard estimates are a sales-price base")
        if (!ec.resource.script("component://mr-mantle/service/mantle/product/CostPolicy.js").capabilities().read)
            throw new Error("Cost-read authority is required to author a standard-estimate rule")
    }
    if (
        r.baseType === "typed" &&
        (!r.basePriceTypeEnumId ||
            one("moqui.basic.Enumeration", {enumId: r.basePriceTypeEnumId})?.enumTypeId !== "ProductPriceType")
    )
        throw new Error("Choose a typed base price")
    if (r.basePriceTypeEnumId === "PptAverage")
        throw new Error("Valuation cost is not a sales-price base; use an approved standard estimate")
    if (r.baseType === "fixed" && (r.fixedPrice == null || toDecimal(r.fixedPrice).compare(0) < 0))
        throw new Error("Choose a nonnegative fixed price")
    if (r.baseType === "list") {
        const base = getList(r.basePriceListId)
        if (base.direction !== list.direction || base.organizationPartyId !== list.organizationPartyId)
            throw new Error("Base list belongs to another direction or organization")
        cycle(r.priceListId, r.basePriceListId, ms(r.fromDate), ms(r.thruDate) ?? Infinity)
    }
    if (r.roundingIncrement != null && toDecimal(r.roundingIncrement).compare(0) <= 0)
        throw new Error("Rounding increment must be positive")
    for (const field of ["minimumPrice", "maximumPrice"])
        if (r[field] != null && toDecimal(r[field]).compare(0) < 0) throw new Error("Price bounds cannot be negative")
    if (r.minimumPrice != null && r.maximumPrice != null && toDecimal(r.minimumPrice).compare(r.maximumPrice) > 0)
        throw new Error("Minimum price exceeds maximum")
    if (r.geoId && !one("moqui.basic.Geo", {geoId: r.geoId})) throw new Error("Choose a geography")
    if (r.partyClassificationId && !one("mantle.party.PartyClassification", {partyClassificationId: r.partyClassificationId}))
        throw new Error("Choose a party classification")
    for (const other of rows(R, {priceListId: r.priceListId, sequenceNum: r.sequenceNum}))
        if (
            other.priceRuleId !== ignoreId &&
            Math.max(ms(other.fromDate) ?? -Infinity, ms(r.fromDate)) <
                Math.min(ms(other.thruDate) ?? Infinity, ms(r.thruDate) ?? Infinity)
        )
            throw new Error("Another rule has this effective sequence")
}
function storeRule(p) {
    lock()
    reason(p)
    const old = p.priceRuleId ? one(R, {priceRuleId: p.priceRuleId}) : null
    if (p.priceRuleId && !old) throw new Error("Rule is not available")
    if (old) {
        getList(old.priceListId, true)
        assertStamp(old, p)
        if (p.priceListId && p.priceListId !== old.priceListId) throw new Error("Rule belongs to another list")
    }
    const data = Object.assign(
        {
            selector: "all",
            minQuantity: 0,
            sequenceNum: 10,
            baseType: "typed",
            basePriceTypeEnumId: "PptCurrent",
            fromDate: ec.user.nowTimestamp
        },
        old ? map(old) : {},
        pick(p, ruleFields)
    )
    if (old) {
        const date = ms(p.fromDate || new Date(Math.max(ms(ec.user.nowTimestamp), ms(old.fromDate) + 1)))
        if (
            date < ms(old.fromDate) ||
            (date === ms(old.fromDate) && getList(old.priceListId).state !== "draft") ||
            (ms(old.thruDate) != null && date >= ms(old.thruDate))
        )
            throw new Error("New rule must start after and within the old rule interval")
        data.fromDate = iso(date)
    }
    if (!data.fromDate) data.fromDate = ec.user.nowTimestamp
    if (data.roundingIncrement == null) {
        const list = getList(data.priceListId, true),
            setting = rows(S, {organizationPartyId: list.organizationPartyId})
                .filter(r => at(r, data.fromDate))
                .sort((a, b) => ms(b.fromDate) - ms(a.fromDate))[0]
        if (setting?.roundingIncrement != null) data.roundingIncrement = setting.roundingIncrement
    }
    validateRule(data, old?.priceRuleId)
    audit(ruleFields, p.changeReason)
    if (old) call("update#" + R, {priceRuleId: old.priceRuleId, thruDate: data.fromDate, changeReason: p.changeReason})
    return call("create#" + R, pick(data, ruleFields))
}
function publication(p) {
    const list = getList(p.priceListId),
        rules = rows(R, {priceListId: p.priceListId})
            .sort((a, b) => String(a.priceRuleId).localeCompare(String(b.priceRuleId)))
            .map(map),
        roles = rows(A, {priceListId: p.priceListId})
            .sort(
                (a, b) =>
                    String(a.partyId).localeCompare(String(b.partyId)) ||
                    String(a.roleTypeId).localeCompare(String(b.roleTypeId)) ||
                    ms(a.fromDate) - ms(b.fromDate)
            )
            .map(map)
    return {
        priceList: listInfo(list, p.asOfDate || ec.user.nowTimestamp),
        priceRuleRows: rules,
        publicationToken: ec.user.singleUseCodeHash(JSON.stringify([map(list), rules, roles]))
    }
}
function publish(p) {
    lock()
    getList(p.priceListId, true)
    reason(p)
    const state = publication(p)
    if (!p.publicationToken || p.publicationToken !== state.publicationToken)
        throw new Error("Review the exact current list scope and rules before publishing")
    if (!state.priceRuleRows.length) throw new Error("Add at least one rule")
    for (const r of state.priceRuleRows.filter(r => !r.thruDate || ms(r.thruDate) > ms(r.fromDate)))
        validateRule(r, r.priceRuleId)
    audit(["state", "changeReason"], p.changeReason)
    call("update#" + L, {priceListId: p.priceListId, state: "published", changeReason: p.changeReason})
    // the publication as a marker on the organization's time series, after the commit (BusinessEvents.js)
    ec.resource
        .script("component://mr-mantle/service/mantle/party/BusinessEvents.js")
        .register("PriceListPublished", p.priceListId)
    return {priceListId: p.priceListId}
}
function retire(p) {
    lock()
    const list = getList(p.priceListId, true)
    reason(p)
    const date = ms(p.thruDate || ec.user.nowTimestamp)
    if (date <= ms(list.fromDate) || date < ms(ec.user.nowTimestamp))
        throw new Error("Choose an end now or later after the list starts")
    audit(["state", "thruDate", "changeReason"], p.changeReason)
    call("update#" + L, {priceListId: p.priceListId, thruDate: iso(date), changeReason: p.changeReason})
    return {priceListId: p.priceListId}
}
function settings(p) {
    const s = scope(),
        org = p.organizationPartyId || s.activeOrganizationPartyId || s.organizationPartyIds[0]
    if (!s.systemAdmin && !(has("PRODUCT_CATALOG_ADMIN") && s.ownerPartyIds.includes(org)))
        guard({
            organizationPartyId: org,
            direction: has("SUPPLIER_PRICE_VIEW") || has("SUPPLIER_PRICE_EDIT") ? "purchase" : "sales"
        })
    const date = p.asOfDate || ec.user.nowTimestamp,
        r = rows(S, {organizationPartyId: org})
            .filter(r => at(r, date))
            .sort((a, b) => ms(b.fromDate) - ms(a.fromDate))[0]
    return {
        organizationPartyId: org,
        fromDate: r?.fromDate,
        settings: r
            ? map(r)
            : {
                  defaultCurrencyUomId: "USD",
                  defaultPurposeEnumId: "PppPurchase",
                  roundingIncrement: null,
                  allowedPurposeIds: "PppPurchase,PppRecurring,PppUsage,PppComponent"
              }
    }
}
function storeSettings(p) {
    const s = scope(),
        org = p.organizationPartyId
    if (!s.systemAdmin && (!has("PRODUCT_CATALOG_ADMIN") || !s.ownerPartyIds.includes(org)))
        throw new Error("Catalog administrator authority in the organization is required")
    lock()
    reason(p)
    const now = ms(ec.user.nowTimestamp),
        old = rows(S, {organizationPartyId: org})
            .filter(r => at(r, now))
            .sort((a, b) => ms(b.fromDate) - ms(a.fromDate))[0]
    if (ms(p.expectedFromDate) !== ms(old?.fromDate)) throw new Error("Pricing settings changed; reload before saving")
    const data = Object.assign({}, old ? map(old) : {}, pick(p, settingFields)),
        date = p.fromDate || now
    if (!one("mantle.party.PartyRole", {partyId: org, roleTypeId: "OrgInternal"}) || !Number.isFinite(ms(date)) || ms(date) < now)
        throw new Error("Choose an internal organization and an effective date now or later")
    if (rows(S, {organizationPartyId: org}).some(r => ms(r.fromDate) > now))
        throw new Error("A future pricing policy is already scheduled")
    if (old && ms(date) <= ms(old.fromDate)) throw new Error("New settings must start after the current row")
    if (one("moqui.basic.Uom", {uomId: data.defaultCurrencyUomId})?.uomTypeEnumId !== "UT_CURRENCY_MEASURE")
        throw new Error("Choose a default currency")
    const allowed = String(data.allowedPurposeIds || "")
        .split(",")
        .map(v => v.trim())
        .filter(Boolean)
    if (
        !allowed.length ||
        allowed.some(enumId => one("moqui.basic.Enumeration", {enumId})?.enumTypeId !== "ProductPricePurpose") ||
        !allowed.includes(data.defaultPurposeEnumId)
    )
        throw new Error("Choose permitted price purposes and a default among them")
    data.allowedPurposeIds = allowed.join(",")
    if (data.roundingIncrement != null && toDecimal(data.roundingIncrement).compare(0) <= 0)
        throw new Error("Rounding increment must be positive")
    if (data.defaultPriceListId) {
        const list = one(L, {priceListId: data.defaultPriceListId})
        if (!list || list.organizationPartyId !== org || list.direction !== "sales")
            throw new Error("Default list must be a sales list in this organization")
        for (const role of rows(A, {priceListId: list.priceListId})) party(role.partyId, s)
    }
    audit([...settingFields, "fromDate", "thruDate"], p.changeReason)
    if (old)
        call("update#" + S, {
            organizationPartyId: org,
            fromDate: iso(old.fromDate),
            thruDate: iso(date),
            changeReason: p.changeReason
        })
    call("create#" + S, Object.assign(pick(data, settingFields), {organizationPartyId: org, fromDate: iso(date)}))
    return settings({organizationPartyId: org, asOfDate: date})
}
function execute(op, p) {
    return {findLists, findRules, storeList, storeRule, publication, publish, retire, settings, storeSettings}[op](p)
}
;({execute, getList, guard, scope, parties, party, at, ms, has})
