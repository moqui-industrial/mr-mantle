// The equipment import (mantle.product.MaintenanceImportServices validate#EquipmentImportRow, apply#EquipmentImportRow and
// find#EquipmentImportScopes; IronStone Maintenance design §6 EquipmentImport, §12, MT-12; impl-maintenance P18, F36, F51): the
// row services of the framework's import target `equipment` (data/MaintenanceSettingsData.xml), called by
// org.moqui.admin.DataTransferServices for each row of a staged file, as the importer.
//
// A row is one piece of equipment of the batch's organization (its scope), kept by its source system and key: an
// AssetIdentification of type AitMntSourceKey whose value is the source and the key, one asset a source key. A row whose key, or
// whose equipment ID, names equipment already there changes that equipment; any other registers new equipment. The writes are
// Maintenance's own guarded services, as the importer: store#MaintenanceEquipment (the identity, the model, the location and the
// supplier warranty), change#MaintenanceCustody (the custodian, when it changes) and record#MaintenanceMeter (the starting
// reading, once: a reading equal to the meter's last is not recorded again, and a lower one on a counting meter is refused). So a
// row applied twice, in the same file or another, makes one asset and one reading. Nothing posts and no cost, book value,
// warranty decision or maintenance history is imported (the registration refuses such columns and no field here names one).
//
// The importer holds MAINTENANCE_IMPORT and MAINTENANCE_RESOURCE_EDIT (the registration asks both, and no ADMIN_* permission:
// a target's permissions are all required, F51) and the organization is in their maintenance scope; equipment, a location or
// a source key of another organization is refused by row, and the other rows go on.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const maintenanceAccess = ec.resource.script("component://mr-mantle/service/mantle/work/MaintenanceAccess.js")
const {find, one, denied} = lib

const ASSET = "mantle.product.asset.Asset"
const IDENTIFICATION = "mantle.product.asset.AssetIdentification"
const METER = "mantle.product.maintenance.AssetMeter"
const PRODUCT_METER = "mantle.product.maintenance.ProductMeter"
const sourceKeyType = "AitMntSourceKey"
const resources = "mantle.product.MaintenanceResourceServices."
const stockTypes = ["AstTpInventory", "AstTpSupplies"]

// the registered fields a row may give
const fields = [
    "externalSource",
    "externalKey",
    "assetId",
    "assetName",
    "serialNumber",
    "classEnumId",
    "productId",
    "facilityId",
    "custodianPartyId",
    "warrantyThruDate",
    "warrantyPartyId",
    "productMeterTypeId",
    "meterValue",
    "readingDate",
    "comments"
]
// the identity fields a change of existing equipment writes (store#MaintenanceEquipment's change path)
const identityFields = ["assetName", "serialNumber", "classEnumId", "warrantyThruDate", "warrantyPartyId", "comments"]
const text = value => String(value ?? "").trim()
const mapOf = value => (value?.getMap ? value.getMap() : Object.assign({}, value || {}))
const refusal = message => String(message ?? "").replace(/^(Error: )?[A-Z][A-Z0-9_]+: /, "")

// The importer: a holder of MAINTENANCE_IMPORT and MAINTENANCE_RESOURCE_EDIT, importing into an organization of their
// maintenance scope.
function importer(scopeKey) {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in to import equipment")
    const userScope = maintenanceAccess.scope()
    const caps = userScope.capabilities
    if (!caps.import || !caps.resourceEdit)
        denied("PERMISSION_DENIED", "Importing equipment needs MAINTENANCE_IMPORT and MAINTENANCE_RESOURCE_EDIT")
    const organizationPartyId = text(scopeKey)
    if (!organizationPartyId) throw new Error("Choose the organization the equipment is for")
    maintenanceAccess.requireOrganization(userScope, organizationPartyId)
    return {userScope, organizationPartyId}
}
function organizationName(partyId) {
    return one("mantle.party.Organization", {partyId})?.organizationName || partyId
}
// The source key's stored value: the source system and the key (the key alone with no source).
function sourceKeyOf(values) {
    const key = text(values.externalKey)
    if (!key) return null
    const source = text(values.externalSource)
    return (source ? source + " / " : "") + key
}
// The row's values: the registered fields given, trimmed; a row naming another organization is refused.
function rowValues(p, organizationPartyId) {
    const values = mapOf(p.rowValues)
    const rowOrganization = text(values.organizationPartyId)
    if (rowOrganization && rowOrganization !== organizationPartyId)
        throw new Error(
            "This import is for " + organizationName(organizationPartyId) + ": import another organization's equipment apart"
        )
    const normalized = {}
    for (const field of fields) if (text(values[field])) normalized[field] = text(values[field])
    return normalized
}
// The equipment a row names, or null for new equipment: by its ID, else by its source key; either of another organization
// is refused, and an ID and a key naming two pieces of equipment too.
function existingOf(values, organizationPartyId) {
    const sourceKey = sourceKeyOf(values)
    const keyed = sourceKey
        ? Array.from(find(IDENTIFICATION, {identificationTypeEnumId: sourceKeyType, idValue: sourceKey}).limit(2).list())
        : []
    if (keyed.length > 1) throw new Error("Source key " + sourceKey + " names more than one piece of equipment")
    const keyedId = keyed[0]?.assetId || null
    const named = text(values.assetId) || null
    if (named && keyedId && named !== keyedId)
        throw new Error("Source key " + sourceKey + " is equipment " + keyedId + ", not " + named)
    const assetId = named || keyedId
    if (!assetId) return null
    const asset = one(ASSET, {assetId})
    if (!asset || maintenanceAccess.assetOrganization(assetId) !== organizationPartyId)
        throw new Error(
            "Equipment " + (named ? assetId : "of source key " + sourceKey) + " is not available in this organization"
        )
    if (stockTypes.includes(asset.assetTypeEnumId)) throw new Error("Asset " + assetId + " is stock, not equipment")
    return asset
}
// The meter a starting reading is for: the model's meter of the type given (or its one meter), else a meter type for
// equipment whose model has none.
function meterOf(productId, productMeterTypeId) {
    const modelMeters = productId ? Array.from(find(PRODUCT_METER, {productId}).list()) : []
    const meter = productMeterTypeId
        ? modelMeters.find(row => row.productMeterTypeId === productMeterTypeId)
        : modelMeters.length === 1
          ? modelMeters[0]
          : null
    if (meter)
        return {
            productMeterId: meter.productMeterId,
            productMeterTypeId: meter.productMeterTypeId,
            isCumulative: meter.isCumulative === "Y"
        }
    if (modelMeters.length || !productMeterTypeId) return null
    return one("mantle.product.maintenance.ProductMeterType", {productMeterTypeId})
        ? {productMeterId: null, productMeterTypeId, isCumulative: false}
        : null
}
// The last reading of a meter of the equipment.
function lastReading(assetId, meter) {
    let query = find(METER, {assetId})
    query = meter.productMeterId
        ? query.condition("productMeterId", meter.productMeterId)
        : query.condition("productMeterTypeId", meter.productMeterTypeId)
    return query.orderBy("-readingDate").limit(1).one()
}
const decimalOf = value => {
    try {
        return toDecimal(value)
    } catch (_) {
        return null
    }
}
// What a row would do, changing nothing; errors named. Shared by the validation and the apply (which rechecks the current
// state before it writes).
function plan(p) {
    const {organizationPartyId} = importer(p.scopeKey)
    const values = rowValues(p, organizationPartyId)
    const errors = []
    if (!values.externalKey) errors.push("Give the equipment's source key")
    let existing = null
    try {
        existing = existingOf(values, organizationPartyId)
    } catch (error) {
        errors.push(refusal(error.message))
    }
    if (!existing && !values.assetName && !values.assetId) errors.push("Give the new equipment's name")
    if (values.classEnumId && !one("moqui.basic.Enumeration", {enumId: values.classEnumId, enumTypeId: "AssetClass"}))
        errors.push("Asset class " + values.classEnumId + " is not known")
    if (values.productId && !one("mantle.product.Product", {productId: values.productId}))
        errors.push("Model " + values.productId + " is not known")
    if (values.facilityId) {
        if (maintenanceAccess.facilityOrganization(values.facilityId) !== organizationPartyId)
            errors.push("Location " + values.facilityId + " is not one of " + organizationName(organizationPartyId) + "'s")
        else if (existing && existing.facilityId && existing.facilityId !== values.facilityId)
            errors.push(
                "Equipment " + existing.assetId + " is at " + existing.facilityId + ": move it in Maintenance, not by import"
            )
    }
    for (const field of ["custodianPartyId", "warrantyPartyId"])
        if (values[field] && !one("mantle.party.Party", {partyId: values[field]}))
            errors.push((field === "custodianPartyId" ? "Custodian " : "Warrantor ") + values[field] + " is not known")
    if (values.warrantyThruDate && !/^\d{4}-\d{2}-\d{2}$/.test(values.warrantyThruDate))
        errors.push("Give the warranty's end as a date (yyyy-MM-dd)")
    if (values.readingDate && !/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(values.readingDate))
        errors.push("Give the reading date as yyyy-MM-dd or yyyy-MM-dd HH:mm")
    // the starting reading: a number, of one of the equipment's meters, not below the last reading of a counting meter
    let reading = null
    if (values.meterValue) {
        const value = decimalOf(values.meterValue)
        const meter = meterOf(values.productId || existing?.productId || null, values.productMeterTypeId || null)
        if (value == null) errors.push("The starting reading " + values.meterValue + " is not a number")
        else if (!meter) errors.push("Give the meter type of the starting reading: the model has none of that type, or several")
        else {
            const last = existing ? lastReading(existing.assetId, meter) : null
            if (last?.meterValue != null && value.compare(last.meterValue) === 0) reading = {meter, value, recorded: true}
            else if (last?.meterValue != null && meter.isCumulative && value.compare(last.meterValue) < 0)
                errors.push(
                    "The starting reading " + values.meterValue + " is below the last one (" + String(last.meterValue) + ")"
                )
            else reading = {meter, value, recorded: false}
        }
    } else if (values.productMeterTypeId || values.readingDate) errors.push("Give the starting reading of the meter")
    return {organizationPartyId, values, existing, reading, errors}
}
function validateRow(p) {
    const planned = plan(p)
    const {values, existing, errors} = planned
    return {
        valid: !errors.length,
        errors,
        warnings: [],
        normalizedValues: values,
        displayText:
            (values.assetName || existing?.assetName || values.assetId || "") +
            (existing ? " (changes " + existing.assetId + ")" : " (new)")
    }
}
// A guarded service as the importer, its refusal thrown.
function write(name, parameters) {
    const out = ec.service.sync().name(name).parameters(parameters).disableAuthz().call() || {}
    if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
    return out
}
function readingDateOf(value) {
    if (!value) return null
    return ec.l10n.parseTimestamp(value.length === 10 ? value + " 00:00" : value, "yyyy-MM-dd HH:mm")
}
function applyRow(p) {
    ec.message.pushErrors()
    try {
        const {organizationPartyId, values, existing, reading, errors} = plan(p)
        if (errors.length) return {applied: false, reasonCode: "ROW_INVALID", reason: errors.join("; ")}
        let assetId = existing?.assetId || null
        const identity = {}
        for (const field of identityFields) if (values[field]) identity[field] = values[field]
        if (existing) {
            if (Object.keys(identity).length) write(resources + "store#MaintenanceEquipment", Object.assign({assetId}, identity))
        } else {
            assetId = write(
                resources + "store#MaintenanceEquipment",
                Object.assign({}, identity, {
                    ownerPartyId: organizationPartyId,
                    facilityId: values.facilityId || null,
                    productId: values.productId || null
                })
            ).assetId
        }
        // the source key, kept with the equipment (one a source key; an equipment with another key keeps its first)
        const sourceKey = sourceKeyOf(values)
        if (!one(IDENTIFICATION, {assetId, identificationTypeEnumId: sourceKeyType}))
            lib.call("create#" + IDENTIFICATION, {assetId, identificationTypeEnumId: sourceKeyType, idValue: sourceKey})
        if (values.custodianPartyId) {
            const holders = Array.from(
                find("mantle.product.asset.AssetPartyAssignment", {assetId, roleTypeId: "Custodian"})
                    .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                    .list()
            )
            if (!holders.some(row => row.partyId === values.custodianPartyId))
                write(resources + "change#MaintenanceCustody", {
                    assetId,
                    roleTypeId: "Custodian",
                    newPartyId: values.custodianPartyId
                })
        }
        if (reading && !reading.recorded)
            write(resources + "record#MaintenanceMeter", {
                assetId,
                productMeterId: reading.meter.productMeterId,
                productMeterTypeId: reading.meter.productMeterTypeId,
                meterValue: reading.value,
                readingDate: readingDateOf(values.readingDate)
            })
        const name = one(ASSET, {assetId})?.assetName || assetId
        return {applied: true, resultRef: assetId, resultText: (existing ? "Updated: " : "Registered: ") + name}
    } catch (error) {
        const message = String(error.message || error)
        return {
            applied: false,
            reasonCode: lib.reasonCode(error) || /\b([A-Z][A-Z0-9_]{3,}):/.exec(message)?.[1] || "EQUIPMENT_REFUSED",
            reason: refusal(message)
        }
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}
// The organizations an equipment import may be for and whose imports the caller may read: the internal organizations of
// their maintenance scope, for a reader of equipment (MAINTENANCE_RESOURCE_VIEW, or any view that reads it). None otherwise.
function findScopes() {
    if (!ec.user.userId) return {scopeList: []}
    const userScope = maintenanceAccess.scope()
    if (!userScope.capabilities.resourceRead) return {scopeList: []}
    const internal = Array.from(find("mantle.party.PartyRole", {roleTypeId: "OrgInternal"}).selectField("partyId").list()).map(
        row => row.partyId
    )
    const ids =
        userScope.organizationPartyIds == null ? internal : userScope.organizationPartyIds.filter(id => internal.includes(id))
    return {
        scopeList: ids
            .map(scopeKey => ({scopeKey, title: organizationName(scopeKey)}))
            .sort((a, b) => a.title.localeCompare(b.title))
    }
}

const operations = {validateRow, applyRow, findScopes}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown equipment import operation " + op)
        return operations[op](parameters || {})
    }
})
