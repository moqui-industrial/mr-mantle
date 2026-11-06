// Store promotions (impl-commerce P7, COM-PROMO; design-commerce §7, crosscut §3.28): a store's promotions
// (ProductStorePromotion) with their registered rule, typed parameters and products, its promotion codes
// (ProductStorePromoCode) with their customers, a bounded batch of generated codes, the committed uses of a promotion or
// code, and the use limits counted again under a lock when an order is placed (check#OrderPromotionLimits, F18).
//
// The maintenance operations check COMMERCE_VIEW to read and COMMERCE_PROMOTION_EDIT to change, and the store's scope
// through StoreAdmin.js (the user's own organizations; a user with a current StoreStaff row works only those stores); a
// promotion of no store is not a store promotion and is refused like one outside the scope. Reads and writes below the
// checks run without artifact authorization. Refusals carry reason codes (EntityLib.denied). The browser never names a
// service: a promotion's rule is a ServiceRegister of type ProductStorePromotion, and its parameters are the registered
// service's own in-parameters, typed by its definition. A code is expired, never deleted, so its uses stay readable.
//
// Uses are counted as Mantle's apply#OrderPromotions counts them: the promoTimesUsed of the promotion items of orders whose
// part is placed or later (OrderItemAndPartSummary). check#OrderPromotionLimits is called by place#Order for any store
// order (and by Shop's checkout freeze): it locks the rows of the promotions and codes whose limits the order would use
// (promotions first, then codes, each in id order, so two placements never wait on each other in a cycle), counts the
// placed uses again, and answers each limit the order would pass. An order whose promotions and codes set no limit takes
// no lock and places as before.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const stores = ec.resource.script("component://mr-mantle/service/mantle/product/StoreAdmin.js")
const {find, one, rows, denied, call, ms, dateText, access} = lib
const S = "mantle.product.store."
const PROMOTION = S + "ProductStorePromotion"
const PARAMETER = S + "ProductStorePromoParameter"
const PROMO_PRODUCT = S + "ProductStorePromoProduct"
const CODE = S + "ProductStorePromoCode"
const CODE_PARTY = S + "ProductStorePromoCodeParty"
const STORE = S + "ProductStore"
const REGISTER = "moqui.service.ServiceRegister"
const USES = "mantle.order.OrderItemAndPartSummary"
const RULE_INTERFACE = "mantle.product.PromotionServices.apply#Promotion"
const RULE_TYPE = "ProductStorePromotion"

// ===== tables =====
// The order part statuses whose promotion uses count (as apply#OrderPromotions and add#OrderPromoCode count them).
const placedStatuses = ["OrderPlaced", "OrderProcessing", "OrderApproved", "OrderSent", "OrderCompleted", "OrderHold"]
// The limit fields of a promotion and a code, each with its label and what it counts.
const promotionLimits = {
    useLimitPerOrder: {label: "uses per order", per: "order"},
    useLimitPerCustomer: {label: "uses per customer", per: "customer"},
    useLimitPerPromotion: {label: "uses in all", per: "all"}
}
const codeLimits = {
    useLimitPerCode: {label: "uses of the code", per: "all"},
    useLimitPerCustomer: {label: "uses per customer", per: "customer"}
}
// The kinds of a rule parameter, from the registered service's parameter type.
const numberTypes = ["BigDecimal", "Integer", "Long", "Double", "Float", "Number", "BigInteger"]
const generateLimit = 500
const productLimit = 200
const choiceLimit = 30
// The characters of a generated code: no 0, O, 1, I or L, which a customer misreads.
const codeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
const codePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{1,39}$/
const prefixPattern = /^[A-Za-z0-9_-]{0,20}$/

// ===== values =====
const text = value => (value == null ? "" : String(value).trim())
// a number from an entity value, which may be a decimal (whose valueOf throws)
const num = value =>
    value == null || value === "" ? 0 : typeof value?.toNumber === "function" ? value.toNumber() : Number(value)
const isTrue = value => value === true || value === "true" || value === "Y"
const unique = list => Array.from(new Set(list.filter(Boolean)))
const nowMs = () => ms(ec.user.nowTimestamp)
const likeText = term => "%" + String(term).replace(/[\\%_]/g, character => "\\" + character) + "%"
const listOf = value =>
    value == null || value === ""
        ? []
        : Array.isArray(value)
          ? value
          : typeof value === "string"
            ? value.split(",").map(item => item.trim())
            : Array.from(value)
const rowsIn = (entity, field, values, conditions = {}) =>
    values.length ? Array.from(find(entity, conditions).condition(field, "in", values).list()) : []
const indicator = (value, label) => {
    if (value == null || value === "") return null
    if (!["Y", "N"].includes(String(value))) denied("VALUE_INVALID", label + " is Y or N")
    return String(value)
}
// A use limit: a whole number of at least 1, or empty for none (Mantle reads 0 as no limit, so it is refused).
function limitOf(value, label) {
    if (value == null || value === "") return null
    const number = Number(String(value))
    if (!Number.isInteger(number) || number < 1)
        denied("VALUE_INVALID", label + " is a whole number of at least 1, or empty for none")
    return number
}
function datesOf(p, row) {
    const fromDate = Object.hasOwn(p, "fromDate") ? stores.dateOf(p.fromDate, null, "start date") : ms(row?.fromDate)
    const thruDate = Object.hasOwn(p, "thruDate") ? stores.dateOf(p.thruDate, null, "end date") : ms(row?.thruDate)
    if (fromDate != null && thruDate != null && thruDate <= fromDate) denied("VALUE_INVALID", "The end comes after the start")
    return {fromDate, thruDate}
}
// The audit log reads a field's reason (<field>_changeReason) from the context as well as the update's parameters, as
// StoreAdmin's store#Store passes it.
function withReasons(update) {
    const reasons = Object.fromEntries(Object.entries(update).filter(([field]) => field.endsWith("_changeReason")))
    if (Object.keys(reasons).length) ec.context.putAll(reasons)
}
function stale(p, row) {
    if (p.expectedLastUpdatedStamp && ms(p.expectedLastUpdatedStamp) !== ms(row.lastUpdatedStamp))
        denied("STALE_REVISION", "Changed by someone else since it was read (now " + dateText(row.lastUpdatedStamp) + "); reload")
}
const stateOf = row => {
    const dates = stores.rowDates(row)
    return dates.current ? "Current" : dates.future ? "Starts later" : "Ended"
}
const limitsText = (row, limits) =>
    Object.entries(limits)
        .filter(([field]) => row[field] != null && row[field] !== "")
        .map(([field, limit]) => row[field] + " " + limit.label)
        .join(" · ") || "No limit"

// ===== scope =====
// COMMERCE_VIEW reads; COMMERCE_PROMOTION_EDIT with it changes.
function scope(need = "view") {
    const s = stores.scope("view")
    s.canEdit = access.has("COMMERCE_PROMOTION_EDIT")
    if (need === "edit" && !s.canEdit) denied("PERMISSION_DENIED", "COMMERCE_PROMOTION_EDIT is required")
    return s
}
// A promotion of a store the user works; a missing one, one of no store and one outside the scope are refused alike.
function promotionOf(s, storePromotionId) {
    const promotion = storePromotionId ? one(PROMOTION, {storePromotionId}) : null
    const unavailable = () => denied("RECORD_UNAVAILABLE", "Promotion " + (storePromotionId || "") + " is not available")
    if (!promotion || !promotion.productStoreId) unavailable()
    try {
        return {promotion, store: stores.storeOf(s, promotion.productStoreId)}
    } catch (error) {
        if (lib.reasonCode(error) === "RECORD_UNAVAILABLE") unavailable()
        throw error
    }
}
// A code of a promotion the user works, refused like the promotion.
function codeOf(s, promoCodeId) {
    const code = promoCodeId ? one(CODE, {promoCodeId}) : null
    if (!code || !code.storePromotionId)
        denied("RECORD_UNAVAILABLE", "Promotion code " + (promoCodeId || "") + " is not available")
    try {
        return Object.assign({code}, promotionOf(s, code.storePromotionId))
    } catch (error) {
        if (lib.reasonCode(error) === "RECORD_UNAVAILABLE")
            denied("RECORD_UNAVAILABLE", "Promotion code " + promoCodeId + " is not available")
        throw error
    }
}

// ===== rules =====
// A registered promotion rule: a ServiceRegister of type ProductStorePromotion naming a service that implements
// apply#Promotion.
function ruleOf(serviceRegisterId) {
    const register = serviceRegisterId ? one(REGISTER, {serviceRegisterId}) : null
    if (!register || register.serviceTypeEnumId !== RULE_TYPE || !register.serviceName)
        denied("SERVICE_NOT_REGISTERED", "Choose a registered promotion rule")
    return register
}
// The parameters a rule takes: the registered service's in-parameters that apply#Promotion does not define, each with its
// kind (number, boolean or text), whether it is required, its default and its description.
function ruleParameters(register) {
    let definition, base
    try {
        definition = ec.service.getServiceDefinition(register.serviceName)
        base = ec.service.getServiceDefinition(RULE_INTERFACE)
    } catch (error) {
        ec.logger.error("Promotion rule " + register.serviceRegisterId + " service " + register.serviceName + ": " + error)
    }
    if (!definition) return []
    const baseNames = new Set(Array.from(base?.inParameterNames || []))
    const parameters = []
    for (const name of Array.from(definition.inParameterNames || [])) {
        if (baseNames.has(name)) continue
        const parameter = definition.getInParameter(name)
        const type = String(parameter?.attribute("type") || "String").replace(/^java\.(lang|math)\./, "")
        parameters.push({
            parameterName: name,
            kind: numberTypes.includes(type) ? "number" : type === "Boolean" ? "boolean" : "text",
            required: parameter?.attribute("required") === "true",
            defaultValue: parameter?.attribute("default") || parameter?.attribute("default-value") || null,
            description: text(parameter?.first("description")?.text)
        })
    }
    return parameters
}
function typedValue(kind, value, name) {
    const raw = text(value)
    if (kind === "boolean") {
        if (!["true", "false"].includes(raw)) denied("VALUE_INVALID", name + " is true or false")
        return raw
    }
    if (kind === "number") {
        if (!Number.isFinite(Number(raw))) denied("VALUE_INVALID", name + " is a number")
        return raw
    }
    if (raw.length > 255 || /[\r\n\x00]/.test(raw)) denied("VALUE_INVALID", name + " is one line of at most 255 characters")
    return raw
}

// ===== uses =====
// The placed uses (summed promoTimesUsed) matching the conditions, leaving out an order's own.
function placedUses(conditions, exceptOrderId) {
    let query = find(USES, conditions).condition("statusId", "in", placedStatuses).selectField("promoTimesUsed")
    if (exceptOrderId) query = query.condition("orderId", "not-equals", exceptOrderId)
    const row = Array.from(query.list())[0]
    return num(row?.promoTimesUsed)
}
// The placed uses of each promotion (or code) of a list, by id, in one grouped query.
function usesBy(field, ids) {
    if (!ids.length) return {}
    const found = find(USES)
        .condition(field, "in", ids)
        .condition("statusId", "in", placedStatuses)
        .selectField(field)
        .selectField("promoTimesUsed")
        .list()
    return Object.fromEntries(Array.from(found).map(row => [row[field], num(row.promoTimesUsed)]))
}

// ===== promotions =====
function promotionRow(promotion, names, uses) {
    return Object.assign(
        {
            storePromotionId: promotion.storePromotionId,
            productStoreId: promotion.productStoreId,
            storeName: names.stores[promotion.productStoreId] || promotion.productStoreId,
            itemDescription: promotion.itemDescription || "",
            serviceRegisterId: promotion.serviceRegisterId,
            ruleText: names.rules[promotion.serviceRegisterId] || promotion.serviceRegisterId,
            fromDate: promotion.fromDate,
            thruDate: promotion.thruDate,
            sequenceNum: promotion.sequenceNum,
            requireCode: promotion.requireCode || "N",
            useLimitPerOrder: promotion.useLimitPerOrder,
            useLimitPerCustomer: promotion.useLimitPerCustomer,
            useLimitPerPromotion: promotion.useLimitPerPromotion,
            freeGroundShipping: promotion.freeGroundShipping || "N",
            limitsText: limitsText(promotion, promotionLimits),
            state: stateOf(promotion),
            useCount: uses[promotion.storePromotionId] || 0,
            lastUpdatedStamp: promotion.lastUpdatedStamp,
            lastUpdatedText: dateText(promotion.lastUpdatedStamp)
        },
        stores.rowDates(promotion)
    )
}
function namesFor(promotions) {
    const storeIds = unique(promotions.map(row => row.productStoreId))
    const ruleIds = unique(promotions.map(row => row.serviceRegisterId))
    return {
        stores: Object.fromEntries(
            rowsIn(STORE, "productStoreId", storeIds).map(row => [row.productStoreId, row.storeName || row.productStoreId])
        ),
        rules: Object.fromEntries(
            rowsIn(REGISTER, "serviceRegisterId", ruleIds).map(row => [
                row.serviceRegisterId,
                row.description || row.serviceRegisterId
            ])
        )
    }
}
// The user's stores (or the one asked for, checked) as ids, for a find's condition.
function storeIdsFor(s, productStoreId) {
    if (productStoreId) return [stores.storeOf(s, productStoreId).productStoreId]
    return Array.from(stores.storeQuery(s).selectField("productStoreId").list()).map(row => row.productStoreId)
}
function stateCondition(query, state) {
    const now = ec.user.nowTimestamp
    const factory = ec.entity.conditionFactory
    if (state === "current")
        return query
            .condition(
                factory.makeCondition(
                    [factory.makeCondition("fromDate", "is-null", null), factory.makeCondition("fromDate", "less-equals", now)],
                    "or"
                )
            )
            .condition(
                factory.makeCondition(
                    [factory.makeCondition("thruDate", "is-null", null), factory.makeCondition("thruDate", "greater", now)],
                    "or"
                )
            )
    if (state === "later") return query.condition("fromDate", "greater", now)
    if (state === "ended") return query.condition("thruDate", "less-equals", now)
    if (state && state !== "all") denied("VALUE_INVALID", "Choose current, later, ended or all")
    return query
}

// find#Promotions: the promotions of the user's stores (or one store), by description or id ignoring case, rule, whether
// a code is required and state (current, later, ended; all by default), a page at a time.
function findPromotions(p) {
    const s = scope()
    const storeIds = storeIdsFor(s, p.productStoreId)
    if (!storeIds.length) return lib.pageList([], p, "promotions")
    const term = text(p.term)
    const factory = ec.entity.conditionFactory
    const build = () => {
        let query = find(PROMOTION).condition("productStoreId", "in", storeIds)
        if (term)
            query = query.condition(
                factory.makeCondition(
                    ["storePromotionId", "itemDescription"].map(field =>
                        factory.makeCondition(field, "like", likeText(term)).ignoreCase()
                    ),
                    "or"
                )
            )
        if (p.serviceRegisterId) query = query.condition("serviceRegisterId", p.serviceRegisterId)
        if (p.requireCode === "Y") query = query.condition("requireCode", "Y")
        if (p.requireCode === "N")
            query = query.condition(
                factory.makeCondition(
                    [factory.makeCondition("requireCode", "is-null", null), factory.makeCondition("requireCode", "equals", "N")],
                    "or"
                )
            )
        return stateCondition(query, p.state).useCache(false)
    }
    const total = build().count()
    const query = build().orderBy("productStoreId").orderBy("sequenceNum").orderBy("storePromotionId")
    const found = lib.page(query, p, "promotions", total)
    const names = namesFor(found.rows)
    const uses = usesBy(
        "storePromotionId",
        found.rows.map(row => row.storePromotionId)
    )
    found.promotions = found.rows.map(row => promotionRow(row, names, uses))
    delete found.rows
    return found
}

// get#Promotion: a promotion with its rule's typed parameters and their values, its products and its codes' count, and
// whether the user may change it.
function getPromotion(p) {
    const s = scope()
    const {promotion, store} = promotionOf(s, p.storePromotionId)
    const names = namesFor([promotion])
    const uses = usesBy("storePromotionId", [promotion.storePromotionId])
    const register = one(REGISTER, {serviceRegisterId: promotion.serviceRegisterId})
    const values = Object.fromEntries(
        rows(PARAMETER, {storePromotionId: promotion.storePromotionId}).map(row => [row.parameterName, row.parameterValue])
    )
    const declared = register ? ruleParameters(register) : []
    const parameters = declared.map(parameter =>
        Object.assign({}, parameter, {parameterValue: values[parameter.parameterName] ?? ""})
    )
    // values of names the rule no longer takes are shown, to remove
    for (const [parameterName, parameterValue] of Object.entries(values))
        if (!declared.some(parameter => parameter.parameterName === parameterName))
            parameters.push({
                parameterName,
                kind: "text",
                required: false,
                description: "Not a parameter of this rule",
                parameterValue,
                unknown: true
            })
    const productRows = rows(PROMO_PRODUCT, {storePromotionId: promotion.storePromotionId})
    const productNames = Object.fromEntries(
        rowsIn(
            "mantle.product.Product",
            "productId",
            productRows.map(row => row.productId)
        ).map(row => [row.productId, row.productName || row.productId])
    )
    const products = productRows
        .map(row => ({
            productId: row.productId,
            productName: productNames[row.productId] || row.productId,
            excludeProduct: row.excludeProduct === "Y" ? "Y" : "N",
            useText: row.excludeProduct === "Y" ? "Excluded" : "Included"
        }))
        .sort((a, b) => a.productName.localeCompare(b.productName))
    return {
        promotion: Object.assign(promotionRow(promotion, names, uses), {
            organizationPartyId: store.organizationPartyId,
            codeCount: find(CODE, {storePromotionId: promotion.storePromotionId}).count()
        }),
        parameters,
        products,
        canEdit: s.canEdit
    }
}

// store#Promotion: a new promotion of a store with its registered rule, or a change of one (its store and rule are fixed:
// start a new promotion for another). A stale row is refused; a change of its dates or limits names its reason in the audit
// log.
function storePromotion(p) {
    const s = scope("edit")
    const values = {}
    let promotion = null
    let store
    if (p.storePromotionId) {
        ;({promotion, store} = promotionOf(s, p.storePromotionId))
        stale(p, promotion)
        if (p.productStoreId && p.productStoreId !== promotion.productStoreId)
            denied("VALUE_INVALID", "A promotion stays in its store; start a new one in the other store")
        if (p.serviceRegisterId && p.serviceRegisterId !== promotion.serviceRegisterId)
            denied("VALUE_INVALID", "A promotion keeps its rule; start a new promotion for another rule")
    } else {
        store = stores.storeOf(s, p.productStoreId)
        values.productStoreId = store.productStoreId
        values.serviceRegisterId = ruleOf(p.serviceRegisterId).serviceRegisterId
        if (!text(p.itemDescription)) denied("VALUE_INVALID", "Describe the promotion")
    }
    if (Object.hasOwn(p, "itemDescription")) {
        const description = text(p.itemDescription)
        if (!description || description.length > 255) denied("VALUE_INVALID", "Describe the promotion in at most 255 characters")
        values.itemDescription = description
    }
    const dates = datesOf(p, promotion)
    if (Object.hasOwn(p, "fromDate")) values.fromDate = dates.fromDate
    if (Object.hasOwn(p, "thruDate")) values.thruDate = dates.thruDate
    if (Object.hasOwn(p, "sequenceNum")) {
        const sequence = p.sequenceNum == null || p.sequenceNum === "" ? null : Number(String(p.sequenceNum))
        if (sequence != null && !Number.isInteger(sequence)) denied("VALUE_INVALID", "The order is a whole number")
        values.sequenceNum = sequence
    }
    if (Object.hasOwn(p, "requireCode")) values.requireCode = indicator(p.requireCode, "Code required") || "N"
    if (Object.hasOwn(p, "freeGroundShipping"))
        values.freeGroundShipping = indicator(p.freeGroundShipping, "Free ground shipping") || "N"
    for (const [field, limit] of Object.entries(promotionLimits))
        if (Object.hasOwn(p, field)) values[field] = limitOf(p[field], "The " + limit.label)
    const changeReason = text(p.changeReason) || null
    if (promotion) {
        const changed = Object.keys(values).filter(field => String(values[field] ?? "") !== String(promotion[field] ?? ""))
        if (!changed.length) return {storePromotionId: promotion.storePromotionId, changed: []}
        const update = {storePromotionId: promotion.storePromotionId}
        for (const field of changed) {
            update[field] = values[field]
            if (changeReason) update[field + "_changeReason"] = changeReason
        }
        withReasons(update)
        call("update#" + PROMOTION, update)
        return {storePromotionId: promotion.storePromotionId, changed}
    }
    const created = call("create#" + PROMOTION, Object.assign({requireCode: "N", freeGroundShipping: "N"}, values))
    return {storePromotionId: created.storePromotionId, changed: Object.keys(values)}
}

// store#PromotionParameters: the rule's parameters, each value typed by the registered service (an empty value removes
// it); a name the rule does not take is refused.
function storePromotionParameters(p) {
    const s = scope("edit")
    const {promotion} = promotionOf(s, p.storePromotionId)
    const register = ruleOf(promotion.serviceRegisterId)
    const declared = Object.fromEntries(ruleParameters(register).map(parameter => [parameter.parameterName, parameter]))
    const existing = Object.fromEntries(
        rows(PARAMETER, {storePromotionId: promotion.storePromotionId}).map(row => [row.parameterName, row])
    )
    const given = p.parameters && typeof p.parameters === "object" ? p.parameters : {}
    const saved = []
    for (const [parameterName, value] of Object.entries(given)) {
        const key = {storePromotionId: promotion.storePromotionId, parameterName}
        if (value == null || value === "") {
            if (existing[parameterName]) {
                if (declared[parameterName]?.required) denied("VALUE_INVALID", parameterName + " is required by the rule")
                call("delete#" + PARAMETER, key)
                saved.push({parameterName, removed: true})
            }
            continue
        }
        if (!declared[parameterName]) denied("VALUE_INVALID", "The rule takes no parameter " + parameterName)
        const parameterValue = typedValue(declared[parameterName].kind, value, parameterName)
        if (existing[parameterName]) {
            if (existing[parameterName].parameterValue !== parameterValue)
                call("update#" + PARAMETER, Object.assign({parameterValue}, key))
        } else call("create#" + PARAMETER, Object.assign({parameterValue}, key))
        saved.push({parameterName, parameterValue})
    }
    const after = new Set(rows(PARAMETER, {storePromotionId: promotion.storePromotionId}).map(row => row.parameterName))
    const missing = Object.values(declared)
        .filter(parameter => parameter.required && !parameter.defaultValue && !after.has(parameter.parameterName))
        .map(parameter => parameter.parameterName)
    return {storePromotionId: promotion.storePromotionId, saved, missing}
}

// store#PromotionProducts: products the promotion applies to (or leaves out, excludeProduct Y), or their removal; each a
// product of the store's organization or the shared catalog.
function storePromotionProducts(p) {
    const s = scope("edit")
    const {promotion, store} = promotionOf(s, p.storePromotionId)
    const productIds = unique(listOf(p.productIds).concat(p.productId ? [p.productId] : []))
    if (!productIds.length) denied("VALUE_INVALID", "Choose the products")
    if (productIds.length > productLimit) denied("VALUE_INVALID", "Choose at most " + productLimit + " products")
    const remove = isTrue(p.remove)
    const excludeProduct = indicator(p.excludeProduct, "Exclude") || "N"
    const products = Object.fromEntries(
        rowsIn("mantle.product.Product", "productId", productIds).map(row => [row.productId, row])
    )
    for (const productId of productIds) {
        const product = products[productId]
        if (
            !product ||
            (product.ownerPartyId && product.ownerPartyId !== "_NA_" && product.ownerPartyId !== store.organizationPartyId)
        )
            denied("PRODUCT_UNAVAILABLE", "Product " + productId + " is not available to the store")
    }
    for (const productId of productIds) {
        const key = {storePromotionId: promotion.storePromotionId, productId}
        const row = one(PROMO_PRODUCT, key)
        if (remove) {
            if (row) call("delete#" + PROMO_PRODUCT, key)
        } else if (row) {
            if ((row.excludeProduct || "N") !== excludeProduct)
                call("update#" + PROMO_PRODUCT, Object.assign({excludeProduct}, key))
        } else call("create#" + PROMO_PRODUCT, Object.assign({excludeProduct}, key))
    }
    return {storePromotionId: promotion.storePromotionId, productIds, removed: remove}
}

// ===== codes =====
function codeRow(code, promotion, names, uses) {
    return Object.assign(
        {
            promoCodeId: code.promoCodeId,
            promoCode: code.promoCode || code.promoCodeId,
            storePromotionId: code.storePromotionId,
            promotionText: promotion?.itemDescription || code.storePromotionId,
            productStoreId: promotion?.productStoreId || null,
            storeName: names.stores[promotion?.productStoreId] || promotion?.productStoreId || "",
            fromDate: code.fromDate,
            thruDate: code.thruDate,
            useLimitPerCode: code.useLimitPerCode,
            useLimitPerCustomer: code.useLimitPerCustomer,
            userEntered: code.userEntered || "N",
            requireParty: code.requireParty || "N",
            limitsText: limitsText(code, codeLimits),
            state: stateOf(code),
            useCount: uses[code.promoCodeId] || 0,
            lastUpdatedStamp: code.lastUpdatedStamp,
            lastUpdatedText: dateText(code.lastUpdatedStamp)
        },
        stores.rowDates(code)
    )
}
// The code text, refused when it is not one word of letters, digits, - and _ (2 to 40), or another code has it, ignoring
// case (add#OrderPromoCode finds a code ignoring case).
function codeTextOf(value, exceptPromoCodeId) {
    const code = text(value)
    if (!codePattern.test(code)) denied("VALUE_INVALID", "A code is 2 to 40 letters, digits, - or _")
    if (codeTaken(code, exceptPromoCodeId)) denied("CODE_TAKEN", "The code " + code + " is taken")
    return code
}
function codeTaken(code, exceptPromoCodeId) {
    const factory = ec.entity.conditionFactory
    let query = find(CODE).condition(factory.makeCondition("promoCode", "equals", code).ignoreCase())
    if (exceptPromoCodeId) query = query.condition("promoCodeId", "not-equals", exceptPromoCodeId)
    return query.count() > 0 || (!!one(CODE, {promoCodeId: code}) && code !== exceptPromoCodeId)
}

// find#PromoCodes: the codes of the user's stores' promotions (or one promotion, or one store), by code ignoring case,
// state and whether they are limited to customers, a page at a time, each with its placed uses.
function findPromoCodes(p) {
    const s = scope()
    let promotionIds
    if (p.storePromotionId) promotionIds = [promotionOf(s, p.storePromotionId).promotion.storePromotionId]
    else {
        const storeIds = storeIdsFor(s, p.productStoreId)
        promotionIds = storeIds.length
            ? Array.from(
                  find(PROMOTION)
                      .condition("productStoreId", "in", storeIds)
                      .selectField("storePromotionId")
                      .useCache(false)
                      .list()
              ).map(row => row.storePromotionId)
            : []
    }
    if (!promotionIds.length) return lib.pageList([], p, "codes")
    const term = text(p.term)
    const build = () => {
        let query = find(CODE).condition("storePromotionId", "in", promotionIds)
        if (term)
            query = query.condition(ec.entity.conditionFactory.makeCondition("promoCode", "like", likeText(term)).ignoreCase())
        if (p.requireParty === "Y") query = query.condition("requireParty", "Y")
        return stateCondition(query, p.state)
    }
    const found = lib.page(build().orderBy("promoCode"), p, "codes", build().count())
    const promotions = Object.fromEntries(
        rowsIn(PROMOTION, "storePromotionId", unique(found.rows.map(row => row.storePromotionId))).map(row => [
            row.storePromotionId,
            row
        ])
    )
    const names = namesFor(Object.values(promotions))
    const uses = usesBy(
        "promoCodeId",
        found.rows.map(row => row.promoCodeId)
    )
    found.codes = found.rows.map(row => codeRow(row, promotions[row.storePromotionId], names, uses))
    delete found.rows
    return found
}

// get#PromoCode: a code with its promotion, the customers it is limited to and whether the user may change it.
function getPromoCode(p) {
    const s = scope()
    const {code, promotion} = codeOf(s, p.promoCodeId)
    const names = namesFor([promotion])
    const uses = usesBy("promoCodeId", [code.promoCodeId])
    const partyIds = rows(CODE_PARTY, {promoCodeId: code.promoCodeId}).map(row => row.partyId)
    const partyNames = lib.partyNames(partyIds)
    const parties = partyIds
        .map(partyId => ({partyId, partyName: partyNames[partyId] || "Private contact"}))
        .sort((a, b) => a.partyName.localeCompare(b.partyName))
    return {code: codeRow(code, promotion, names, uses), parties, canEdit: s.canEdit}
}

// The values of a code from the parameters (dates, limits and indicators), for store#PromoCode and generate#PromoCodes.
function codeValues(p, row) {
    const values = {}
    const dates = datesOf(p, row)
    if (Object.hasOwn(p, "fromDate")) values.fromDate = dates.fromDate
    if (Object.hasOwn(p, "thruDate")) values.thruDate = dates.thruDate
    for (const [field, limit] of Object.entries(codeLimits))
        if (Object.hasOwn(p, field)) values[field] = limitOf(p[field], "The " + limit.label)
    if (Object.hasOwn(p, "userEntered")) values.userEntered = indicator(p.userEntered, "Customer entered") || "N"
    if (Object.hasOwn(p, "requireParty")) values.requireParty = indicator(p.requireParty, "Customers only") || "N"
    return values
}

// store#PromoCode: a new code of a promotion (its text given, or generated when empty) or a change of one. A code keeps its
// promotion, and its text once it has been used; a stale row is refused; a change of its dates or limits names its reason in
// the audit log.
function storePromoCode(p) {
    const s = scope("edit")
    let code = null
    let promotion
    if (p.promoCodeId) {
        ;({code, promotion} = codeOf(s, p.promoCodeId))
        stale(p, code)
        if (p.storePromotionId && p.storePromotionId !== code.storePromotionId)
            denied("VALUE_INVALID", "A code keeps its promotion; make a new code for the other one")
    } else promotion = promotionOf(s, p.storePromotionId).promotion
    const values = codeValues(p, code)
    if (!code || Object.hasOwn(p, "promoCode")) {
        const wanted = text(p.promoCode)
        if (code && wanted === code.promoCode) {
            // unchanged
        } else if (code && usesBy("promoCodeId", [code.promoCodeId])[code.promoCodeId])
            denied("CODE_REDEEMED", "The code has been used; it keeps its text (expire it and make a new one)")
        else values.promoCode = wanted ? codeTextOf(wanted, code?.promoCodeId) : drawCodes("", 1, 8, new Set())[0]
    }
    const changeReason = text(p.changeReason) || null
    if (code) {
        const changed = Object.keys(values).filter(field => String(values[field] ?? "") !== String(code[field] ?? ""))
        if (!changed.length) return {promoCodeId: code.promoCodeId, promoCode: code.promoCode, changed: []}
        const update = {promoCodeId: code.promoCodeId}
        for (const field of changed) {
            update[field] = values[field]
            if (changeReason) update[field + "_changeReason"] = changeReason
        }
        withReasons(update)
        call("update#" + CODE, update)
        return {promoCodeId: code.promoCodeId, promoCode: values.promoCode || code.promoCode, changed}
    }
    const created = call(
        "create#" + CODE,
        Object.assign({userEntered: "Y", requireParty: "N"}, values, {storePromotionId: promotion.storePromotionId})
    )
    return {promoCodeId: created.promoCodeId, promoCode: values.promoCode, changed: Object.keys(values)}
}

// Codes drawn at random: the prefix and a suffix from codeAlphabet, none taken (ignoring case) nor repeated in the batch;
// a draw that collides is drawn again, and the number of collisions is counted on the set's `collisions`.
function drawCodes(prefix, count, suffixLength, taken, counter = {collisions: 0}) {
    const codes = []
    let tries = 0
    while (codes.length < count) {
        if (++tries > count * 20)
            denied("CODES_EXHAUSTED", "Too few codes are left with this prefix and length; use a longer code")
        let suffix = ""
        const random = String(ec.user.randomString(suffixLength * 2))
        for (let index = 0; suffix.length < suffixLength; index++)
            suffix += codeAlphabet[random.charCodeAt(index % random.length) % codeAlphabet.length]
        const code = prefix + suffix
        const key = code.toUpperCase()
        if (taken.has(key) || codeTaken(code)) {
            counter.collisions++
            continue
        }
        taken.add(key)
        codes.push(code)
    }
    return codes
}
// Numbered codes: the prefix and numbers from startNumber, zero padded to the widest; those taken are named.
function numberedCodes(prefix, count, startNumber) {
    const width = String(startNumber + count - 1).length
    const codes = []
    for (let number = startNumber; number < startNumber + count; number++)
        codes.push(prefix + String(number).padStart(width, "0"))
    const factory = ec.entity.conditionFactory
    const existing = new Set(
        Array.from(
            find(CODE)
                .condition(factory.makeCondition("promoCode", "like", likeText(prefix).slice(1)).ignoreCase())
                .selectField("promoCode")
                .list()
        ).map(row => String(row.promoCode).toUpperCase())
    )
    return {codes, taken: codes.filter(code => existing.has(code.toUpperCase()) || !!one(CODE, {promoCodeId: code}))}
}

// generate#PromoCodes: a bounded batch of codes of a promotion (count up to 500, a prefix, random suffixes of a length, or
// numbered from a start), each with the same dates, limits and customer restriction. With preview it writes nothing and
// answers the codes it would make, the codes the prefix already has and, for numbered codes, those taken; otherwise each
// code is made in its own transaction (one that fails is named and the rest are made), keyed by its operation key so a
// retry answers the first result.
function generatePromoCodes(p) {
    const s = scope("edit")
    const {promotion, store} = promotionOf(s, p.storePromotionId)
    const count = Number(String(p.count ?? ""))
    if (!Number.isInteger(count) || count < 1 || count > generateLimit)
        denied("VALUE_INVALID", "Make from 1 to " + generateLimit + " codes at a time")
    const prefix = text(p.prefix).toUpperCase()
    if (!prefixPattern.test(prefix)) denied("VALUE_INVALID", "A prefix is up to 20 letters, digits, - or _")
    const numbered = isTrue(p.numbered)
    const suffixLength = p.suffixLength == null || p.suffixLength === "" ? 8 : Number(String(p.suffixLength))
    if (!numbered && (!Number.isInteger(suffixLength) || suffixLength < 4 || suffixLength > 16))
        denied("VALUE_INVALID", "A random part is 4 to 16 characters")
    const startNumber = p.startNumber == null || p.startNumber === "" ? 1 : Number(String(p.startNumber))
    if (numbered && (!Number.isInteger(startNumber) || startNumber < 0)) denied("VALUE_INVALID", "Numbers start at 0 or more")
    const values = codeValues(p, null)
    const factory = ec.entity.conditionFactory
    const existingWithPrefix = prefix
        ? find(CODE)
              .condition(factory.makeCondition("promoCode", "like", likeText(prefix).slice(1)).ignoreCase())
              .count()
        : null
    const request = {
        storePromotionId: promotion.storePromotionId,
        count,
        prefix,
        numbered,
        suffixLength: numbered ? null : suffixLength,
        startNumber: numbered ? startNumber : null,
        values
    }
    if (isTrue(p.preview)) {
        if (numbered) {
            const planned = numberedCodes(prefix, count, startNumber)
            const taken = new Set(planned.taken)
            return {
                preview: true,
                count,
                codes: planned.codes.filter(code => !taken.has(code)).slice(0, 10),
                makeCount: count - planned.taken.length,
                taken: planned.taken,
                collisions: planned.taken.length,
                existingWithPrefix
            }
        }
        const counter = {collisions: 0}
        const codes = drawCodes(prefix, count, suffixLength, new Set(), counter)
        return {
            preview: true,
            count,
            codes: codes.slice(0, 10),
            makeCount: count,
            taken: [],
            collisions: counter.collisions,
            existingWithPrefix
        }
    }
    const op = lib.operation(p, "PromoCodeBatch", store.organizationPartyId, request)
    const again = lib.previous(op)
    if (again) return again
    const counter = {collisions: 0}
    const planned = numbered
        ? numberedCodes(prefix, count, startNumber).codes
        : drawCodes(prefix, count, suffixLength, new Set(), counter)
    const results = []
    for (const promoCode of planned) {
        try {
            if (codeTaken(promoCode)) denied("CODE_TAKEN", "The code " + promoCode + " is taken")
            const out = lib.probe(
                "create#" + CODE,
                Object.assign({userEntered: "Y", requireParty: "N"}, values, {
                    storePromotionId: promotion.storePromotionId,
                    promoCode
                })
            )
            results.push({promoCode, promoCodeId: out.promoCodeId, ok: true, code: null, message: "Made"})
        } catch (error) {
            const reason = lib.reasonCode(error) || "ERROR"
            if (reason !== "CODE_TAKEN")
                ec.logger.error(
                    "Promotion code " + promoCode + " of " + promotion.storePromotionId + " not made: " + error.message
                )
            results.push({
                promoCode,
                ok: false,
                code: reason,
                message: String(error.message || error).replace(/^(Error: )?[A-Z][A-Z0-9_]+: /, "")
            })
        }
    }
    const answer = {
        results,
        doneCount: results.filter(result => result.ok).length,
        failedCount: results.filter(result => !result.ok).length,
        collisions: counter.collisions
    }
    lib.complete(op, CODE, promotion.storePromotionId, answer)
    return answer
}

// store#PromoCodeParty: a customer the code is limited to, or their removal; a party that does not exist, is disabled or is
// another user's private contact is refused.
function storePromoCodeParty(p) {
    const s = scope("edit")
    const {code} = codeOf(s, p.promoCodeId)
    const party = p.partyId ? one("mantle.party.Party", {partyId: p.partyId}) : null
    if (!party || party.disabled === "Y" || (party.privateOwnerUserId && party.privateOwnerUserId !== ec.user.userId))
        denied("PARTY_UNAVAILABLE", "Customer " + (p.partyId || "") + " is not available")
    const key = {promoCodeId: code.promoCodeId, partyId: party.partyId}
    const row = one(CODE_PARTY, key)
    if (isTrue(p.remove)) {
        if (row) call("delete#" + CODE_PARTY, key)
        return {promoCodeId: code.promoCodeId, partyId: party.partyId, removed: true}
    }
    if (!row) call("create#" + CODE_PARTY, key)
    return {promoCodeId: code.promoCodeId, partyId: party.partyId, removed: false, requireParty: code.requireParty === "Y"}
}

// expire#PromoCode: the code ends at thruDate (now when empty); one already ended is refused. Codes are never deleted, so
// their uses stay readable.
function expirePromoCode(p) {
    const s = scope("edit")
    const {code} = codeOf(s, p.promoCodeId)
    const at = stores.dateOf(p.thruDate, nowMs(), "end date")
    if (code.thruDate != null && ms(code.thruDate) <= nowMs()) denied("ALREADY_EXPIRED", "The code has already ended")
    if (code.fromDate != null && at <= ms(code.fromDate)) denied("VALUE_INVALID", "The end comes after the start")
    const update = {promoCodeId: code.promoCodeId, thruDate: at}
    const changeReason = text(p.changeReason)
    if (changeReason) update.thruDate_changeReason = changeReason
    withReasons(update)
    call("update#" + CODE, update)
    return {promoCodeId: code.promoCodeId, thruDate: at}
}

// find#PromotionUses: the committed uses of a promotion or a code (placed orders and later), an order and code to a row with
// its date, customer (name only, a private contact left unnamed), uses and discount, most recent first, a page at a time.
function findPromotionUses(p) {
    const s = scope()
    let conditions
    if (p.promoCodeId) conditions = {promoCodeId: codeOf(s, p.promoCodeId).code.promoCodeId}
    else conditions = {storePromotionId: promotionOf(s, p.storePromotionId).promotion.storePromotionId}
    const usedRows = find(USES, conditions)
        .condition("statusId", "in", placedStatuses)
        .selectField("orderId")
        .selectField("promoCodeId")
        .selectField("promoCodeText")
        .selectField("customerPartyId")
        .selectField("placedDate")
        .selectField("promoTimesUsed")
        .selectField("itemTotal")
        .list()
    const totals = {}
    for (const row of Array.from(usedRows)) {
        const key = row.orderId + "|" + (row.promoCodeId || "")
        const total = (totals[key] = totals[key] || {
            orderId: row.orderId,
            promoCodeId: row.promoCodeId || null,
            promoCode: row.promoCodeText || row.promoCodeId || "",
            customerPartyId: row.customerPartyId || null,
            placedDate: row.placedDate,
            useCount: 0,
            discount: toDecimal(0)
        })
        if (ms(row.placedDate) > ms(total.placedDate)) total.placedDate = row.placedDate
        total.useCount += num(row.promoTimesUsed)
        total.discount = total.discount.add(toDecimal(row.itemTotal ?? 0))
    }
    const list = Object.values(totals).sort(
        (a, b) => (ms(b.placedDate) ?? 0) - (ms(a.placedDate) ?? 0) || b.orderId.localeCompare(a.orderId)
    )
    const found = lib.pageList(list, p, "uses")
    const orders = Object.fromEntries(
        rowsIn(
            "mantle.order.OrderHeader",
            "orderId",
            found.uses.map(row => row.orderId)
        ).map(row => [row.orderId, row])
    )
    const names = lib.partyNames(found.uses.map(row => row.customerPartyId))
    found.uses = found.uses.map(row => {
        const order = orders[row.orderId]
        return Object.assign({}, row, {
            orderName: order?.orderName || row.orderId,
            currencyUomId: order?.currencyUomId || null,
            statusText: order?.statusId
                ? one("moqui.basic.StatusItem", {statusId: order.statusId})?.description || order.statusId
                : "",
            customerName: row.customerPartyId ? names[row.customerPartyId] || "Private contact" : "Guest",
            placedDateText: dateText(row.placedDate),
            discount: row.discount.negate()
        })
    })
    found.useCount = list.reduce((sum, row) => sum + row.useCount, 0)
    found.orderCount = new Set(list.map(row => row.orderId)).size
    return found
}

// find#PromotionOptions: a promotion form's drop-down: the registered rules (rules), or the promotions of the user's stores
// (promotions, of one store when given), by name or id, with the selected value's label when it is in scope.
function findPromotionOptions(p) {
    const s = scope()
    const term = text(p.term).toLowerCase()
    if (p.choice === "rules") {
        const options = rows(REGISTER, {serviceTypeEnumId: RULE_TYPE})
            .map(row => ({value: row.serviceRegisterId, label: row.description || row.serviceRegisterId}))
            .filter(option => !term || (option.label + " " + option.value).toLowerCase().includes(term))
            .sort((a, b) => a.label.localeCompare(b.label))
        return {options}
    }
    if (p.choice === "promotions") {
        const storeIds = storeIdsFor(s, p.productStoreId)
        if (!storeIds.length) return {options: []}
        let query = find(PROMOTION)
            .condition("productStoreId", "in", storeIds)
            .useCache(false)
            .orderBy("itemDescription")
            .limit(choiceLimit)
        if (term) {
            const factory = ec.entity.conditionFactory
            query = query.condition(
                factory.makeCondition(
                    ["storePromotionId", "itemDescription"].map(field =>
                        factory.makeCondition(field, "like", likeText(term)).ignoreCase()
                    ),
                    "or"
                )
            )
        }
        const options = Array.from(query.list()).map(row => ({
            value: row.storePromotionId,
            label: row.itemDescription || row.storePromotionId
        }))
        if (p.selected && !options.some(option => option.value === p.selected)) {
            try {
                const {promotion} = promotionOf(s, p.selected)
                options.push({value: promotion.storePromotionId, label: promotion.itemDescription || promotion.storePromotionId})
            } catch (error) {
                if (lib.reasonCode(error) !== "RECORD_UNAVAILABLE") throw error
            }
        }
        return {options}
    }
    throw new Error("Unknown promotion option " + p.choice)
}

// ===== limits at placement =====
// check#OrderPromotionLimits: whether the order's promotion uses (in the parts being placed: those not yet placed, or the
// one asked for) stay within every limit of their promotions and codes, counted over the placed orders under a lock of the
// rows whose limits they use (with lock false, as a cart's preview does, nothing is locked and nothing consumed). An order of
// no store, with no promotion items or whose promotions and codes set no limit, is within its limits and locks nothing.
// Each limit passed is answered with what it allows, what is used and what the order asks.
function checkOrderPromotionLimits(p) {
    const none = {withinLimits: true, exceeded: [], locked: []}
    const order = p.orderId ? one("mantle.order.OrderHeader", {orderId: p.orderId}) : null
    if (!order || !order.productStoreId) return none
    const parts = rows("mantle.order.OrderPart", {orderId: order.orderId})
    const placing = parts.filter(
        part => (!p.orderPartSeqId || part.orderPartSeqId === p.orderPartSeqId) && !placedStatuses.includes(part.statusId)
    )
    if (!placing.length) return none
    const placingIds = new Set(placing.map(part => part.orderPartSeqId))
    const placedIds = new Set(parts.filter(part => placedStatuses.includes(part.statusId)).map(part => part.orderPartSeqId))
    const items = Array.from(
        find("mantle.order.OrderItem", {orderId: order.orderId}).condition("storePromotionId", "is-not-null", null).list()
    ).filter(item => placingIds.has(item.orderPartSeqId) || placedIds.has(item.orderPartSeqId))
    const asked = items.filter(item => placingIds.has(item.orderPartSeqId) && num(item.promoTimesUsed) > 0)
    if (!asked.length) return none
    const customerPartyId = (parts.find(part => part.customerPartyId) || {}).customerPartyId || null

    // the rows read first, unlocked: only those with a limit the order uses are locked and counted
    const promotionIds = unique(asked.map(item => item.storePromotionId)).sort()
    const codeIds = unique(asked.map(item => item.promoCodeId)).sort()
    const hasLimit = (row, limits) =>
        !!row && Object.keys(limits).some(field => row[field] != null && row[field] !== "" && num(row[field]) > 0)
    const lock = p.lock !== false && p.lock !== "false"
    const read = (entity, field, id) =>
        find(entity, {[field]: id})
            .useCache(false)
            .forUpdate(lock)
            .one()
    const limitedPromotions = promotionIds.filter(id =>
        hasLimit(find(PROMOTION, {storePromotionId: id}).useCache(false).one(), promotionLimits)
    )
    const limitedCodes = codeIds.filter(id => hasLimit(one(CODE, {promoCodeId: id}), codeLimits))
    if (!limitedPromotions.length && !limitedCodes.length) return none
    // promotions, then codes, each in id order: the one lock order of every placement
    const promotions = Object.fromEntries(limitedPromotions.map(id => [id, read(PROMOTION, "storePromotionId", id)]))
    const codes = Object.fromEntries(limitedCodes.map(id => [id, read(CODE, "promoCodeId", id)]))

    const sum = list => list.reduce((total, item) => total + num(item.promoTimesUsed), 0)
    const exceeded = []
    const checkLimits = (kind, id, row, limits, field) => {
        const mine = asked.filter(item => item[field] === id)
        const ownPlaced = sum(items.filter(item => item[field] === id && placedIds.has(item.orderPartSeqId)))
        for (const [limitField, limit] of Object.entries(limits)) {
            const allowed = num(row[limitField])
            if (!allowed) continue
            if (limit.per === "order") {
                // per order part, as apply#OrderPromotions applies it
                for (const partId of placingIds) {
                    const requested = sum(mine.filter(item => item.orderPartSeqId === partId))
                    if (requested > allowed)
                        exceeded.push({
                            kind,
                            id,
                            label: row.itemDescription || row.promoCode || id,
                            limitField,
                            limitText: limit.label,
                            limit: allowed,
                            used: 0,
                            requested,
                            orderPartSeqId: partId
                        })
                }
                continue
            }
            const requested = sum(mine)
            if (!requested) continue
            let used
            if (limit.per === "customer")
                used = customerPartyId ? placedUses({[field]: id, customerPartyId}, order.orderId) + ownPlaced : ownPlaced
            else used = placedUses({[field]: id}, order.orderId) + ownPlaced
            if (used + requested > allowed)
                exceeded.push({
                    kind,
                    id,
                    label: row.itemDescription || row.promoCode || id,
                    limitField,
                    limitText: limit.label,
                    limit: allowed,
                    used,
                    requested
                })
        }
    }
    for (const [id, row] of Object.entries(promotions))
        if (row) checkLimits("promotion", id, row, promotionLimits, "storePromotionId")
    for (const [id, row] of Object.entries(codes)) if (row) checkLimits("code", id, row, codeLimits, "promoCodeId")
    return {
        withinLimits: exceeded.length === 0,
        exceeded,
        locked: lock ? limitedPromotions.concat(limitedCodes) : []
    }
}

const operations = {
    findPromotions,
    getPromotion,
    storePromotion,
    storePromotionParameters,
    storePromotionProducts,
    findPromoCodes,
    getPromoCode,
    storePromoCode,
    generatePromoCodes,
    storePromoCodeParty,
    expirePromoCode,
    findPromotionUses,
    findPromotionOptions,
    checkOrderPromotionLimits
}
;({
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown store promotion operation " + op)
        return operations[op](parameters || {})
    }
})
