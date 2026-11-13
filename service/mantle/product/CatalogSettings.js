// The organization catalog and variant policies: effective-dated rows by organization (ProductCatalogSetting and
// ProductVariantSetting), each change starting a row and ending the one before it, with its fields audit-logged.
// Reading needs catalog read in the organization; changing needs catalog administration there.
const P = "mantle.product."
const policy = ec.resource.script("component://mr-mantle/service/mantle/product/CatalogPolicy.js")
const {find, one, rows, call, ms} = policy

const masterFields = ec.resource.script("component://mr-mantle/service/mantle/product/CatalogRecords.js").masterFields.split(",")
const policyFlags = ["allowCostSelfApproval", "variantsEnabled", "packagingEnabled", "priceListsEnabled"]
const catalogFields = [
    "defaultProductTypeEnumId",
    "defaultAmountUomId",
    "defaultCurrencyUomId",
    "requiredFields",
    "idPolicy",
    ...policyFlags
]
// The policy of an organization with no row: its base currency, else USD.
function catalogDefaults(organizationPartyId) {
    const preference = organizationPartyId
        ? one("mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: organizationPartyId})
        : null
    return {
        defaultProductTypeEnumId: "PtAsset",
        defaultAmountUomId: "OTH_ea",
        defaultCurrencyUomId: preference?.baseCurrencyUomId || "USD",
        requiredFields: ["productName", "productTypeEnumId", "amountUomId"],
        allowCostSelfApproval: false,
        variantsEnabled: true,
        packagingEnabled: true,
        priceListsEnabled: true,
        idPolicy: "internal"
    }
}
// The fields a variant may copy from its virtual product: never identity, prices, costs or transactional fields.
const copyableFields = {
    description: "Description",
    comments: "Comments",
    productClassEnumId: "Product class",
    amountUomId: "Stock unit",
    amountFixed: "Fixed amount",
    amountRequire: "Require amount",
    salesAllowed: "Allow sales",
    purchaseAllowed: "Allow purchases",
    requireInventory: "Require inventory",
    chargeShipping: "Charge shipping",
    taxable: "Taxable",
    returnable: "Returnable",
    originGeoId: "Origin"
}
const defaultCopyFields = [
    "description",
    "productClassEnumId",
    "amountUomId",
    "salesAllowed",
    "purchaseAllowed",
    "requireInventory",
    "chargeShipping",
    "taxable",
    "returnable"
]
const flag = value => value === true || value === "Y" || value === "true"
const list = value =>
    Array.isArray(value)
        ? value.map(String)
        : String(value || "")
              .split(",")
              .map(item => item.trim())
              .filter(Boolean)
const parse = (value, fallback) =>
    value == null || value === "" ? fallback : typeof value === "string" ? JSON.parse(value) : value
const activeAt = (row, at) => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at

// The organization a read or change is for: the given one, else the user's active one; it must be internal and the
// user's.
function organization(p, need) {
    const scope = policy.scope({organizationPartyId: p.organizationPartyId}, need)
    if (!scope.organizationPartyId) throw new Error("Choose an internal organization")
    return scope
}
function effectiveAt(p) {
    const at = p.asOfDate == null || p.asOfDate === "" ? ms(ec.user.nowTimestamp) : ms(p.asOfDate)
    if (!Number.isFinite(at)) throw new Error("Choose a valid effective date")
    return at
}
// A new row starting at a time: the row in effect then ends there, and the new one ends where a later one starts.
function startRow(entity, organizationPartyId, at, values, changeReason) {
    const all = rows(entity, {organizationPartyId}).sort((a, b) => ms(a.fromDate) - ms(b.fromDate))
    if (all.some(row => ms(row.fromDate) === at))
        throw new Error("A policy already starts at this time; choose a later effective date")
    const before = all.filter(row => ms(row.fromDate) < at && (row.thruDate == null || ms(row.thruDate) > at)).at(-1),
        after = all.find(row => ms(row.fromDate) > at),
        fromDate = new Date(at).toISOString()
    ec.context.putAll(
        Object.fromEntries(["fromDate", "thruDate", ...Object.keys(values)].map(field => [field + "_changeReason", changeReason]))
    )
    if (before)
        call("update#" + entity, {organizationPartyId, fromDate: new Date(ms(before.fromDate)).toISOString(), thruDate: fromDate})
    call(
        "create#" + entity,
        Object.assign({}, values, {
            organizationPartyId,
            fromDate,
            thruDate: after ? new Date(ms(after.fromDate)).toISOString() : null,
            changeReason
        })
    )
    return fromDate
}

// ===== catalog policy
function catalogPolicy(row, organizationPartyId) {
    const out = Object.assign(catalogDefaults(organizationPartyId), {defaultOwnerPartyId: organizationPartyId || null})
    if (row) {
        for (const field of catalogFields) if (row[field] != null) out[field] = row[field]
        out.requiredFields = list(row.requiredFields)
        for (const field of policyFlags) out[field] = row[field] === "Y"
    }
    return out
}
function catalogSettings(p) {
    // a user with no organization reads the defaults
    const organizationPartyId = policy.scope({organizationPartyId: p.organizationPartyId}, "read").organizationPartyId || null,
        at = effectiveAt(p)
    if (!organizationPartyId)
        return {
            organizationPartyId: null,
            versionSeqId: 0,
            fromDate: null,
            thruDate: null,
            asOfDate: at,
            settings: catalogPolicy(null, null),
            history: []
        }
    const all = rows(P + "ProductCatalogSetting", {organizationPartyId}).sort((a, b) => ms(b.fromDate) - ms(a.fromDate)),
        row = all.find(r => activeAt(r, at))
    // versionSeqId is the optimistic token of the old API: the effective start, never a sequence.
    return {
        organizationPartyId,
        versionSeqId: ms(row?.fromDate) || 0,
        fromDate: row?.fromDate || null,
        thruDate: row?.thruDate || null,
        asOfDate: at,
        settings: catalogPolicy(row, organizationPartyId),
        history: all.map(r => Object.assign(policy.map(r), {requiredFields: list(r.requiredFields).join(", ")}))
    }
}
function storeCatalogSettings(p) {
    const organizationPartyId = organization(p, "admin").organizationPartyId
    find("mantle.party.Party", {partyId: organizationPartyId}).forNoKeyUpdate(true).one()
    const old = catalogSettings({organizationPartyId})
    if (Number(p.expectedVersion || 0) !== Number(old.versionSeqId))
        throw new Error("Catalog settings changed; reload before saving")
    const now = ms(ec.user.nowTimestamp),
        at = p.fromDate == null || p.fromDate === "" ? Math.max(now, (ms(old.fromDate) || 0) + 1) : ms(p.fromDate)
    if (!Number.isFinite(at) || at < now) throw new Error("Policy changes must take effect now or later")
    const data = parse(p.settingsJson, p.settings || {}),
        saved = Object.assign({}, catalogSettings({organizationPartyId, asOfDate: at}).settings)
    for (const field of catalogFields)
        if (Object.keys(data).includes(field)) saved[field] = data[field] === "" ? null : data[field]
    for (const field of policyFlags) saved[field] = flag(saved[field])
    saved.requiredFields = list(saved.requiredFields)
    if (saved.requiredFields.some(field => !masterFields.includes(field))) throw new Error("Unknown required catalog field")
    if (!["internal", "manual"].includes(saved.idPolicy)) throw new Error("Unknown product ID policy")
    if (
        saved.allowCostSelfApproval &&
        !ec.resource.script("component://mr-mantle/service/mantle/product/CostPolicy.js").capabilities().approve
    )
        throw new Error("Cost approval authority is required to enable self approval")
    if (one("moqui.basic.Uom", {uomId: saved.defaultCurrencyUomId})?.uomTypeEnumId !== "UT_CURRENCY_MEASURE")
        throw new Error("Choose a valid default currency")
    if (one("moqui.basic.Enumeration", {enumId: saved.defaultProductTypeEnumId})?.enumTypeId !== "ProductType")
        throw new Error("Choose a valid default product type")
    const amountUom = one("moqui.basic.Uom", {uomId: saved.defaultAmountUomId})
    if (!amountUom || amountUom.uomTypeEnumId === "UT_CURRENCY_MEASURE") throw new Error("Choose a valid default amount unit")
    const values = {}
    for (const field of catalogFields) values[field] = saved[field]
    for (const field of policyFlags) values[field] = saved[field] ? "Y" : "N"
    values.requiredFields = [...new Set(saved.requiredFields)].join(",")
    const fromDate = startRow(
        P + "ProductCatalogSetting",
        organizationPartyId,
        at,
        values,
        p.changeReason || "Catalog policy changed"
    )
    return catalogSettings({organizationPartyId, asOfDate: fromDate})
}

// ===== variant policy
function variantSettings(p) {
    const organizationPartyId = organization(p, "read").organizationPartyId,
        at = effectiveAt(p),
        all = rows(P + "ProductVariantSetting", {organizationPartyId}).sort((a, b) => ms(b.fromDate) - ms(a.fromDate)),
        row = all.find(r => activeAt(r, at))
    return {
        organizationPartyId,
        fromDate: row?.fromDate || null,
        thruDate: row?.thruDate || null,
        asOfDate: at,
        settings: {
            batchLimit: Number(row?.batchLimit || 1000),
            copyFields: row ? list(row.copyFields) : defaultCopyFields,
            copyCategoryMembers: row?.copyCategoryMembers === "Y",
            identifierPattern: "{base}_{features}"
        },
        safeCopyFields: Object.keys(copyableFields),
        copyFieldOptions: Object.entries(copyableFields).map(([value, label]) => ({value, label})),
        history: all.map(r => ({
            fromDate: r.fromDate,
            thruDate: r.thruDate,
            batchLimit: r.batchLimit,
            copyFields: r.copyFields,
            changeReason: r.changeReason
        }))
    }
}
function storeVariantSettings(p) {
    const organizationPartyId = organization(p, "admin").organizationPartyId
    find("mantle.party.Party", {partyId: organizationPartyId}).forNoKeyUpdate(true).one()
    const old = variantSettings({organizationPartyId}),
        data = parse(p.settingsJson, p.settings || {}),
        now = ms(ec.user.nowTimestamp),
        at = p.fromDate == null || p.fromDate === "" ? Math.max(now, (ms(old.fromDate) || 0) + 1) : ms(p.fromDate)
    if (!Number.isFinite(at) || at < now) throw new Error("Policy changes must take effect now or later")
    if (ms(p.expectedFromDate) !== ms(old.fromDate)) throw new Error("Variant policy changed; reload before saving")
    const batchLimit = Number(data.batchLimit == null ? old.settings.batchLimit : data.batchLimit),
        copyFields = data.copyFields == null ? old.settings.copyFields : list(data.copyFields)
    if (!Number.isInteger(batchLimit) || batchLimit < 1 || batchLimit > 1000)
        throw new Error("Interactive batch limit must be between 1 and 1000")
    if (copyFields.some(field => !copyableFields[field]))
        throw new Error("Identity, prices, costs and transactional fields are never copyable")
    if (data.identifierPattern && data.identifierPattern !== "{base}_{features}")
        throw new Error("Use the canonical {base}_{features} identifier pattern")
    if (flag(data.updateExisting)) throw new Error("Existing overrides require a separate explicit propagation preview")
    const copyCategoryMembers =
        data.copyCategoryMembers == null ? old.settings.copyCategoryMembers : flag(data.copyCategoryMembers)
    const fromDate = startRow(
        P + "ProductVariantSetting",
        organizationPartyId,
        at,
        {
            batchLimit,
            copyFields: copyFields.join(","),
            copyCategoryMembers: copyCategoryMembers ? "Y" : "N",
            identifierPattern: "{base}_{features}"
        },
        p.changeReason || data.changeReason || "Variant policy changed"
    )
    return variantSettings({organizationPartyId, asOfDate: fromDate})
}

function execute(op, p) {
    const operations = {catalogSettings, storeCatalogSettings, variantSettings, storeVariantSettings}
    if (!operations[op]) throw new Error("Unknown catalog settings operation " + op)
    return operations[op](p || {})
}
;({execute, catalogPolicy, defaultCopyFields, copyableFields})
