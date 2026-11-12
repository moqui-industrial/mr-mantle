// Catalog record writers enforce native permissions and owner scope for every caller.
const P = "mantle.product.",
    policy = () => ec.resource.script("component://mr-mantle/service/mantle/product/CatalogPolicy.js")
// the associations the catalog row writer keeps: substitutes, and the spare parts of an equipment model
const substituteAndPartTypes = ["PatEquivalent", "PatReplacement", "PatSparePart"]
const find = (n, p = {}) => policy().find(n, p),
    one = (n, p) => policy().one(n, p),
    list = (n, p = {}) => policy().rows(n, p),
    map = r => policy().map(r),
    ms = v => policy().ms(v),
    fields = (p, n) => policy().pick(p, n.split(","))
const call = (n, p = {}) => policy().call(n, p)
function access() {
    const s = policy().scope({}, "edit")
    return Object.assign({}, s, {capabilities: {catalogEdit: s.edit, systemAdmin: s.systemAdmin}})
}
function record(id, need = "read", entity = P + "Product") {
    const s = policy().scope({}, need === "catalogEdit" ? "edit" : "read")
    if (entity === P + "Product") return policy().product(id, s, need === "catalogEdit")
    if (![P + "category.ProductCategory", P + "feature.ProductFeature"].includes(entity))
        throw new Error("Unknown catalog record type")
    const key = entity.endsWith("ProductCategory") ? "productCategoryId" : "productFeatureId",
        r = one(entity, {[key]: id})
    if (!r || (!s.systemAdmin && !s.ownerPartyIds.includes(r.ownerPartyId || "_NA_")))
        throw new Error("Catalog record is not available")
    return r
}
function settings(p) {
    const at = p.asOfDate || ec.user.nowTimestamp,
        row = list(P + "ProductCatalogSetting", {organizationPartyId: p.organizationPartyId})
            .filter(r => policy().active(r, at))
            .sort((a, b) => ms(b.fromDate) - ms(a.fromDate))[0],
        out = Object.assign({}, defaults)
    // the defaults of an organization with no policy row are CatalogSettings.js's
    if (!row)
        Object.assign(
            out,
            ec.resource
                .script("component://mr-mantle/service/mantle/product/CatalogSettings.js")
                .catalogPolicy(null, p.organizationPartyId)
        )
    else for (const key of Object.keys(defaults)) if (row[key] != null) out[key] = row[key]
    return {settings: out}
}
const masterFields =
    "productName,pseudoId,description,comments,productTypeEnumId,productClassEnumId,assetTypeEnumId,assetClassEnumId,amountUomId,amountFixed,amountRequire,salesAllowed,purchaseAllowed,salesIntroductionDate,salesDiscontinuationDate,salesDiscWhenNotAvail,supportDiscontinuationDate,requireInventory,chargeShipping,taxable,returnable,originGeoId,storageTypeEnumId"
const defaults = {
    defaultProductTypeEnumId: "PtAsset",
    defaultAmountUomId: "OTH_ea",
    defaultCurrencyUomId: "USD",
    requiredFields: ["productName", "productTypeEnumId", "amountUomId"],
    allowCostSelfApproval: false,
    variantsEnabled: true,
    packagingEnabled: true,
    priceListsEnabled: true,
    idPolicy: "internal"
}
function prepareProduct(p) {
    const a = access(),
        oldRow = p.productId ? find(P + "Product", {productId: p.productId}).one() : null,
        old = oldRow ? map(oldRow) : null
    if (old) record(p.productId, "catalogEdit")
    if (p.createOnly && old) throw new Error("Product ID is already in use")
    if (old && p.expectedLastUpdatedStamp && ms(p.expectedLastUpdatedStamp) !== ms(old.lastUpdatedStamp))
        throw new Error("Product changed; reload before saving")
    let owner = old?.ownerPartyId || p.ownerPartyId || a.activeOrganizationPartyId || a.organizationPartyIds[0]
    if (
        !a.capabilities.catalogEdit ||
        !owner ||
        (owner === "_NA_" ? !a.capabilities.systemAdmin : !a.capabilities.systemAdmin && !a.organizationPartyIds.includes(owner))
    )
        throw new Error("Catalog editor authority over the owner is required")
    if (old) record(p.productId, "catalogEdit")
    if (p.ownerPartyId && old && p.ownerPartyId !== old.ownerPartyId)
        throw new Error("Changing a product owner requires a separate migration")
    const cfg = owner === "_NA_" ? defaults : settings({organizationPartyId: owner}).settings
    const data = Object.assign(
        {},
        old || {productTypeEnumId: cfg.defaultProductTypeEnumId, amountUomId: cfg.defaultAmountUomId},
        fields(p, masterFields),
        {ownerPartyId: owner}
    )
    if (one("moqui.basic.Enumeration", {enumId: data.productTypeEnumId})?.enumTypeId !== "ProductType")
        throw new Error("Choose a valid product type")
    if (data.amountUomId && one("moqui.basic.Uom", {uomId: data.amountUomId})?.uomTypeEnumId === "UT_CURRENCY_MEASURE")
        throw new Error("A stock unit cannot be a currency")
    if (!String(data.productName || "").trim()) throw new Error("Product name is required")
    if (p.productId && !/^[A-Za-z0-9_.-]{1,40}$/.test(p.productId))
        throw new Error("Product ID must contain 1–40 letters, numbers, dots, dashes or underscores")
    for (const key of [
        "salesAllowed",
        "purchaseAllowed",
        "salesDiscWhenNotAvail",
        "amountRequire",
        "requireInventory",
        "chargeShipping",
        "taxable",
        "returnable"
    ])
        if (data[key] != null && !["Y", "N"].includes(data[key])) throw new Error("Choose Yes or No for " + key)
    if (data.storageTypeEnumId && one("moqui.basic.Enumeration", {enumId: data.storageTypeEnumId})?.enumTypeId !== "StorageType")
        throw new Error("Choose a valid storage type")
    if (old && ["productTypeEnumId", "amountUomId"].some(k => data[k] !== old[k])) {
        if (
            old.statusId !== "PrdDraft" ||
            ["mantle.order.OrderItem", "mantle.product.asset.Asset", "mantle.account.invoice.InvoiceItem"].some(
                entity => find(entity, {productId: p.productId}).count() > 0
            )
        )
            throw new Error("Change type or stock unit only on an unused draft")
    }
    if (!old && cfg.idPolicy === "manual" && !p.productId) throw new Error("This organization requires a manual product ID")
    const save = fields(data, masterFields)
    Object.assign(save, {ownerPartyId: owner, productId: p.productId})
    if (!old) save.statusId = "PrdDraft"
    return {
        parameters: Object.assign({}, save, {createOnly: p.createOnly, expectedLastUpdatedStamp: old?.lastUpdatedStamp}),
        before: old,
        catalogPolicy: cfg
    }
}
function storeProduct(p) {
    access()
    if (p.productId)
        find(P + "Product", {productId: p.productId})
            .forUpdate(true)
            .one()
    const prepared = prepareProduct(p),
        old = prepared.before,
        out = call(
            (old ? "update#" : "create#") + P + "Product",
            fields(prepared.parameters, masterFields + ",ownerPartyId,productId,statusId")
        )
    return {productId: old?.productId || out.productId}
}

const kinds = {
    category: {
        entity: P + "category.ProductCategoryMember",
        names: "productCategoryId,fromDate,thruDate,sequenceNum,comments,quantity"
    },
    feature: {
        entity: P + "feature.ProductFeatureAppl",
        names: "productFeatureId,fromDate,thruDate,applTypeEnumId,amount,recurringAmount,sequenceNum"
    },
    dimension: {
        entity: P + "ProductUomDimension",
        names: "productUomDimensionId,uomDimensionTypeId,marketSegmentId,value,uomId",
        id: "productUomDimensionId"
    },
    party: {
        entity: P + "ProductParty",
        names: "partyId,roleTypeId,fromDate,thruDate,otherPartyItemId,otherPartyItemName,comments,sequenceNum"
    },
    association: {
        entity: P + "ProductAssoc",
        names: "toProductId,productAssocTypeEnumId,fromDate,thruDate,quantity,reason,sequenceNum"
    },
    meter: {
        entity: P + "maintenance.ProductMeter",
        names: "productMeterId,productMeterTypeId,meterUomId,meterName",
        id: "productMeterId"
    },
    maintenance: {
        entity: P + "maintenance.ProductMaintenance",
        names: "productMaintenanceId,maintenanceTypeEnumId,description,comments,templateWorkEffortId,intervalQuantity,intervalProductMeterId,intervalUomId,repeatCount",
        id: "productMaintenanceId"
    }
}
// A maintenance default's work template (impl-maintenance P6, an owner contract with Maintenance): a maintenance procedure the
// process applicability check admits for the model (not retired, of the model or of any). Empty is no template.
function maintenanceTemplate(data) {
    const templateId = String(data.templateWorkEffortId || "").trim()
    if (!templateId) return
    const checked = ec.service
        .sync()
        .name("mantle.work.ProcessServices.check#ProcessApplicability")
        .parameters({templateWorkEffortId: templateId, productId: data.productId})
        .disableAuthz()
        .call()
    if (!checked?.applicable)
        throw new Error("Work template " + templateId + " cannot be used: " + (checked?.message || "not a maintenance procedure"))
}
function storeRow(p) {
    const product = record(p.productId, "catalogEdit")
    if (["category", "feature"].includes(p.kind) && !p.operation) {
        find("moqui.basic.EnumerationType", {enumTypeId: "ProductFeatureType"}).forUpdate(true).one()
        find(P + "Product", {productId: p.productId})
            .forUpdate(true)
            .one()
        const prepared = prepareRow(p),
            result = call("store#" + prepared.recordEntityName, prepared.parameters),
            target = p.kind === "category" ? "productCategoryId" : "productFeatureId",
            before =
                prepared.beforeRows.find(
                    r => r[target] === prepared.parameters[target] && ms(r.fromDate) === ms(prepared.parameters.fromDate)
                ) || {},
            keys = {productId: p.productId, [target]: prepared.parameters[target], fromDate: prepared.parameters.fromDate}
        ec.resource
            .script("component://mr-mantle/service/mantle/product/MethodPolicy.js")
            .recordAudit(
                prepared.recordEntityName,
                keys,
                kinds[p.kind].names.split(","),
                before,
                Object.assign({}, before, prepared.parameters),
                p.changeReason || "Catalog assignment"
            )
        return result
    }
    if (p.kind === "identifier" || p.kind === "otherIdentifier")
        return call(
            "mantle.product.ProductServices.store#ProductIdentifier",
            Object.assign(fields(p, "productId,productIdTypeEnumId,idValue,productOtherIdentId,productStoreId,marketSegmentId"), {
                other: p.kind === "otherIdentifier"
            }),
            true
        )
    if (p.kind === "kit") {
        record(p.toProductId)
        return call(
            "mantle.product.ProductServices.store#KitComponent",
            fields(p, "productId,toProductId,fromDate,thruDate,quantity,sequenceNum"),
            true
        )
    }
    const spec = Object.prototype.hasOwnProperty.call(kinds, p.kind) ? kinds[p.kind] : null
    if (!spec) throw new Error("Unknown catalog row kind")
    const data = Object.assign(fields(p, spec.names), {productId: p.productId})
    if ("fromDate" in p || spec.names.includes("fromDate")) data.fromDate = p.fromDate || ec.user.nowTimestamp
    if (ms(data.thruDate) != null && ms(data.thruDate) <= ms(data.fromDate))
        throw new Error("End must follow start; use End now on an existing row")
    if (spec.id && data[spec.id]) {
        const old = one(spec.entity, {[spec.id]: data[spec.id]})
        if (!old || old.productId !== p.productId) throw new Error("Row is not on this product")
    }
    if (p.kind === "category") {
        find("moqui.basic.EnumerationType", {enumTypeId: "ProductFeatureType"}).forUpdate(true).one()
        record(data.productCategoryId, "read", P + "category.ProductCategory")
    }
    if (p.kind === "feature") {
        find("moqui.basic.EnumerationType", {enumTypeId: "ProductFeatureType"}).forUpdate(true).one()
        const lockedProduct = find(P + "Product", {productId: p.productId})
            .forUpdate(true)
            .one()
        record(data.productFeatureId, "read", P + "feature.ProductFeature")
        const old = one(spec.entity, {productId: p.productId, productFeatureId: data.productFeatureId, fromDate: data.fromDate})
        if (
            (old?.applTypeEnumId === "PfatDistinguishing" || data.applTypeEnumId === "PfatDistinguishing") &&
            (lockedProduct.statusId || "PrdActive") !== "PrdDraft"
        )
            throw new Error("Distinguishing feature identity is fixed on a used or active variant")
    }
    if (p.kind === "association") {
        // a substitute, or a spare part an equipment model uses in its maintenance (PatSparePart, impl-maintenance P2)
        if (!substituteAndPartTypes.includes(data.productAssocTypeEnumId))
            throw new Error("Use the dedicated kit, variant, BOM or packaging editor for this association")
        record(data.toProductId)
        if (data.toProductId === p.productId) throw new Error("A product cannot substitute for itself")
    }
    if (p.kind === "party") {
        const party = one("mantle.party.Party", {partyId: data.partyId}),
            a = access()
        if (
            !party ||
            (party.privateOwnerUserId && party.privateOwnerUserId !== ec.user.userId) ||
            (!a.capabilities.systemAdmin &&
                !a.ownerPartyIds.includes(party.ownerPartyId) &&
                !a.organizationPartyIds.includes(party.partyId))
        )
            throw new Error("Party is not available")
        if (!["Customer", "Manufacturer", "Distributor"].includes(data.roleTypeId)) throw new Error("Choose a catalog party role")
    }
    if (p.kind === "dimension") {
        const unit = one("moqui.basic.Uom", {uomId: data.uomId}),
            type = one("moqui.basic.UomDimensionType", {uomDimensionTypeId: data.uomDimensionTypeId})
        const standard = type?.defaultUomId ? one("moqui.basic.Uom", {uomId: type.defaultUomId}) : null
        if (
            !unit ||
            !type ||
            unit.uomTypeEnumId === "UT_CURRENCY_MEASURE" ||
            ((type.uomTypeEnumId || standard?.uomTypeEnumId) &&
                unit.uomTypeEnumId !== (type.uomTypeEnumId || standard?.uomTypeEnumId)) ||
            toDecimal(data.value || 0).compare(0) < 0
        )
            throw new Error("Dimension value and unit do not match its type")
    }
    if (["meter", "maintenance"].includes(p.kind)) {
        if (product.assetTypeEnumId !== "AstTpEquipment") throw new Error("Equipment templates require an equipment product")
        if (p.kind === "maintenance" && toDecimal(data.intervalQuantity || 0).compare(0) <= 0)
            throw new Error("Maintenance interval must be positive")
        if (p.kind === "maintenance") maintenanceTemplate(data)
        if (
            data.intervalProductMeterId &&
            one(P + "maintenance.ProductMeter", {productMeterId: data.intervalProductMeterId})?.productId !== p.productId
        )
            throw new Error("Maintenance meter is not on this product")
    }
    if (p.operation === "expire") {
        const keys = Object.keys(ec.entity.makeValue(spec.entity).getPrimaryKeys())
        const old = one(spec.entity, fields(data, keys.join(",")))
        if (!old || old.productId !== p.productId || !spec.names.includes("thruDate"))
            throw new Error("Dated row is not on this product")
        const end = ec.user.nowTimestamp
        if (ms(old.fromDate) >= ms(end)) throw new Error("Future row must be rescheduled rather than end-dated before its start")
        return call("update#" + spec.entity, Object.assign(fields(data, keys.join(",")), {thruDate: end}), true)
    }
    return call((spec.id && !data[spec.id] ? "create#" : "store#") + spec.entity, data, true)
}
function prepareRow(p) {
    if (!["category", "feature"].includes(p.kind) || p.operation)
        throw new Error("Only category and feature assignments are previewed here")
    const product = record(p.productId, "catalogEdit")
    if (p.kind === "identifier" || p.kind === "otherIdentifier")
        return call(
            "mantle.product.ProductServices.store#ProductIdentifier",
            Object.assign(fields(p, "productId,productIdTypeEnumId,idValue,productOtherIdentId,productStoreId,marketSegmentId"), {
                other: p.kind === "otherIdentifier"
            }),
            true
        )
    if (p.kind === "kit") {
        record(p.toProductId)
        return call(
            "mantle.product.ProductServices.store#KitComponent",
            fields(p, "productId,toProductId,fromDate,thruDate,quantity,sequenceNum"),
            true
        )
    }
    const spec = Object.prototype.hasOwnProperty.call(kinds, p.kind) ? kinds[p.kind] : null
    if (!spec) throw new Error("Unknown catalog row kind")
    const data = Object.assign(fields(p, spec.names), {productId: p.productId})
    if ("fromDate" in p || spec.names.includes("fromDate")) data.fromDate = p.fromDate || ec.user.nowTimestamp
    if (ms(data.thruDate) != null && ms(data.thruDate) <= ms(data.fromDate))
        throw new Error("End must follow start; use End now on an existing row")
    if (spec.id && data[spec.id]) {
        const old = one(spec.entity, {[spec.id]: data[spec.id]})
        if (!old || old.productId !== p.productId) throw new Error("Row is not on this product")
    }
    if (p.kind === "category") {
        find("moqui.basic.EnumerationType", {enumTypeId: "ProductFeatureType"}).one()
        record(data.productCategoryId, "read", P + "category.ProductCategory")
    }
    if (p.kind === "feature") {
        find("moqui.basic.EnumerationType", {enumTypeId: "ProductFeatureType"}).one()
        const lockedProduct = find(P + "Product", {productId: p.productId}).one()
        record(data.productFeatureId, "read", P + "feature.ProductFeature")
        const old = one(spec.entity, {productId: p.productId, productFeatureId: data.productFeatureId, fromDate: data.fromDate})
        if (
            (old?.applTypeEnumId === "PfatDistinguishing" || data.applTypeEnumId === "PfatDistinguishing") &&
            (lockedProduct.statusId || "PrdActive") !== "PrdDraft"
        )
            throw new Error("Distinguishing feature identity is fixed on a used or active variant")
    }
    if (p.kind === "association") {
        // a substitute, or a spare part an equipment model uses in its maintenance (PatSparePart, impl-maintenance P2)
        if (!substituteAndPartTypes.includes(data.productAssocTypeEnumId))
            throw new Error("Use the dedicated kit, variant, BOM or packaging editor for this association")
        record(data.toProductId)
        if (data.toProductId === p.productId) throw new Error("A product cannot substitute for itself")
    }
    if (p.kind === "party") {
        const party = one("mantle.party.Party", {partyId: data.partyId}),
            a = access()
        if (
            !party ||
            (party.privateOwnerUserId && party.privateOwnerUserId !== ec.user.userId) ||
            (!a.capabilities.systemAdmin &&
                !a.ownerPartyIds.includes(party.ownerPartyId) &&
                !a.organizationPartyIds.includes(party.partyId))
        )
            throw new Error("Party is not available")
        if (!["Customer", "Manufacturer", "Distributor"].includes(data.roleTypeId)) throw new Error("Choose a catalog party role")
    }
    if (p.kind === "dimension") {
        const unit = one("moqui.basic.Uom", {uomId: data.uomId}),
            type = one("moqui.basic.UomDimensionType", {uomDimensionTypeId: data.uomDimensionTypeId})
        const standard = type?.defaultUomId ? one("moqui.basic.Uom", {uomId: type.defaultUomId}) : null
        if (
            !unit ||
            !type ||
            unit.uomTypeEnumId === "UT_CURRENCY_MEASURE" ||
            ((type.uomTypeEnumId || standard?.uomTypeEnumId) &&
                unit.uomTypeEnumId !== (type.uomTypeEnumId || standard?.uomTypeEnumId)) ||
            toDecimal(data.value || 0).compare(0) < 0
        )
            throw new Error("Dimension value and unit do not match its type")
    }
    if (["meter", "maintenance"].includes(p.kind)) {
        if (product.assetTypeEnumId !== "AstTpEquipment") throw new Error("Equipment templates require an equipment product")
        if (p.kind === "maintenance" && toDecimal(data.intervalQuantity || 0).compare(0) <= 0)
            throw new Error("Maintenance interval must be positive")
        if (p.kind === "maintenance") maintenanceTemplate(data)
        if (
            data.intervalProductMeterId &&
            one(P + "maintenance.ProductMeter", {productMeterId: data.intervalProductMeterId})?.productId !== p.productId
        )
            throw new Error("Maintenance meter is not on this product")
    }
    if (p.operation === "expire") {
        const keys = Object.keys(ec.entity.makeValue(spec.entity).getPrimaryKeys())
        const old = one(spec.entity, fields(data, keys.join(",")))
        if (!old || old.productId !== p.productId || !spec.names.includes("thruDate"))
            throw new Error("Dated row is not on this product")
        const end = ec.user.nowTimestamp
        if (ms(old.fromDate) >= ms(end)) throw new Error("Future row must be rescheduled rather than end-dated before its start")
        return call("update#" + spec.entity, Object.assign(fields(data, keys.join(",")), {thruDate: end}), true)
    }
    if (p.kind === "feature") {
        data.applTypeEnumId = data.applTypeEnumId || "PfatStandard"
        if (one("moqui.basic.Enumeration", {enumId: data.applTypeEnumId})?.enumTypeId !== "ProductFeatureApplType")
            throw new Error("Choose a feature application type")
    }
    const target = p.kind === "category" ? "productCategoryId" : "productFeatureId",
        beforeRows = list(spec.entity, {productId: p.productId}).map(map)
    for (const row of beforeRows)
        if (
            row[target] === data[target] &&
            ms(row.fromDate) !== ms(data.fromDate) &&
            Math.max(ms(row.fromDate) ?? -Infinity, ms(data.fromDate) ?? -Infinity) <
                Math.min(ms(row.thruDate) ?? Infinity, ms(data.thruDate) ?? Infinity)
        )
            throw new Error("Assignment overlaps a dated row; use its key or end it first")
    return {parameters: data, beforeRows, recordEntityName: spec.entity, product: map(product)}
}

function ensureRow(p) {
    if (!["category", "feature"].includes(p.kind)) throw new Error("Choose a category or feature assignment")
    record(p.productId, "catalogEdit")
    find("moqui.basic.EnumerationType", {enumTypeId: "ProductFeatureType"}).forUpdate(true).one()
    find(P + "Product", {productId: p.productId})
        .forUpdate(true)
        .one()
    const spec = kinds[p.kind],
        key = p.kind === "category" ? "productCategoryId" : "productFeatureId"
    record(p[key], "read", p.kind === "category" ? P + "category.ProductCategory" : P + "feature.ProductFeature")
    const current = list(spec.entity, {productId: p.productId, [key]: p[key]}).filter(r =>
        policy().active(r, p.fromDate || ec.user.nowTimestamp)
    )
    if (current.length > 1) throw new Error("Several dated assignment rows apply; review them first")
    if (current.length) {
        if (p.kind === "feature" && p.applTypeEnumId && current[0].applTypeEnumId !== p.applTypeEnumId)
            throw new Error("Existing feature assignment has another application type")
        return {productId: p.productId, fromDate: current[0].fromDate}
    }
    return storeRow(p)
}
function execute(op, p) {
    return {storeProduct, storeRow, ensureRow}[op](p)
}
;({execute, settings, masterFields, kinds, prepareProduct, prepareRow})
