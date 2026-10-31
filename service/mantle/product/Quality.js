// Shared quality inspection (design-crosscut §3.19 CX-QUALITY, design-warehouse WH-QUALITY; impl-warehouse P8), the logic of
// mantle.product.QualityServices. A template's characteristics are effective-dated rows: a draft item has no fromDate,
// publishing stamps it, and a change to a published item ends it and starts a new row (the shared rule of
// impl-drawers-commons §4), so an inspection reads the items in effect when it was created (templateAsOfDate) and the
// template prints as of any date. An inspection holds a source (a receipt, a return, an outgoing shipment, a run, or stock),
// the asset quarantined for it, readings per item and sample, the result (accepted and rejected), verification by another
// user with QUALITY_VERIFY, and dispositions through the posting guard (StockPosting.js): Release reserves its pegged
// customer demand first and then sets AstAvailable through Mantle's update#Asset (whose AssetStatusAvailableReservations
// SECA gives the rest to waiting reservations); Scrap moves the stock to the morgue status and then calls
// WarehouseTaskServices.scrap#Asset; the others keep it quarantined. Each disposition queues the bill matches of its
// receipt. get#SourceInspectionStatus gives matching and planning each receipt's held, match-eligible and rejected
// quantities. Permissions: QUALITY_TEMPLATE_EDIT, QUALITY_INSPECT, QUALITY_VERIFY, QUALITY_DISPOSE; the organization scope is
// FacilityScope.js's. Each refusal is denied(reason, message).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const posting = ec.resource.script("component://mr-mantle/service/mantle/shipment/StockPosting.js")
const {find, one, rows, denied, call, access, ms, dateText} = lib

const TEMPLATE = "mantle.product.quality.InspectionTemplate",
    ITEM = "mantle.product.quality.InspectionTemplateItem",
    INSPECTION = "mantle.product.quality.QualityInspection",
    READING = "mantle.product.quality.InspectionReading",
    DISPOSITION = "mantle.product.quality.QualityInspectionDisposition",
    CONTENT = "mantle.product.quality.QualityInspectionContent",
    ASSET = "mantle.product.asset.Asset",
    RECEIPT = "mantle.product.receipt.AssetReceipt",
    FACILITY = "mantle.facility.Facility"
const openStatuses = ["QiDraft", "QiSubmitted", "QiVerified"]
// dispositions that take the accepted quantity, and the rest, which take the rejected quantity
const acceptedDispositions = ["QdRelease"]
// dispositions after which the stock is no longer held for the inspection (the others keep it quarantined until their own
// process, a supplier return or a rework, moves it)
const endingDispositions = ["QdRelease", "QdUseAsIs", "QdScrap"]
const dispositionNames = {
    QdRelease: "Release",
    QdQuarantine: "Quarantine",
    QdRework: "Rework or repair",
    QdReturnCustomer: "Return to customer",
    QdReturnSupplier: "Return to supplier",
    QdScrap: "Scrap",
    QdUseAsIs: "Use as is"
}
// the item fields a revision compares and copies
const itemFields = [
    "sequenceNum",
    "characteristicName",
    "description",
    "readingTypeEnumId",
    "uomId",
    "lowerLimit",
    "upperLimit",
    "targetValue",
    "mandatory"
]
const headerFields = [
    "templateName",
    "description",
    "inspectionContextEnumId",
    "productId",
    "productCategoryId",
    "facilityId",
    "samplePolicyEnumId",
    "sampleSize",
    "samplePercent"
]

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const dec = value => toDecimal(value ?? 0)
const decimal = value => (blank(value) ? null : toDecimal(value))
const textOf = value => (value == null || value === "" ? null : String(toDecimal(value).toNumber()))
const truthy = value => value === true || value === "true" || value === "Y"
const now = () => ec.user.nowTimestamp
const unique = values => [...new Set(values.filter(value => value != null && value !== ""))]
const same = (a, b) => {
    if (blank(a) && blank(b)) return true
    if (blank(a) || blank(b)) return false
    const numeric = value => typeof value === "object" && typeof value.compare === "function"
    if (numeric(a) || numeric(b)) return dec(a).compare(dec(b)) === 0
    return String(a) === String(b)
}

// ===== access =====
function requireAny(permissions) {
    if (!permissions.some(permission => access.has(permission)))
        denied("PERMISSION_DENIED", permissions.join(" or ") + " is required")
}
function scope() {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "A signed-in user is required")
    return facilityScope.scope()
}
function checkEnum(value, enumTypeId, label) {
    if (blank(value)) return null
    if (one("moqui.basic.Enumeration", {enumId: value})?.enumTypeId !== enumTypeId)
        denied("VALUE_INVALID", "Choose a valid " + label)
    return value
}
// An organization of the user's scope: the given one, else the active one, else their only one.
function organizationOf(userScope, organizationPartyId) {
    const chosen =
        text(organizationPartyId) ||
        userScope.activeOrganizationPartyId ||
        (userScope.memberPartyIds.length === 1 ? userScope.memberPartyIds[0] : null)
    if (!chosen || !facilityScope.owns(userScope, chosen)) denied("ORGANIZATION_UNAVAILABLE", "Choose one of your organizations")
    return chosen
}
// A template of the user's organizations, locked when asked; a missing one and one outside the scope are refused alike.
function templateOf(userScope, inspectionTemplateId, lock = false) {
    const template = blank(inspectionTemplateId) ? null : find(TEMPLATE, {inspectionTemplateId}).forUpdate(lock).one()
    if (!template || !facilityScope.owns(userScope, template.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Inspection template " + (inspectionTemplateId || "") + " is not available")
    return template
}
// An inspection of the user's organizations (its organization, or its facility's owner), locked when asked, and with
// facilityIds (an app's narrower facility scope) in one of those facilities.
function inspectionOf(userScope, qualityInspectionId, lock = false, facilityIds = null) {
    const inspection = blank(qualityInspectionId) ? null : find(INSPECTION, {qualityInspectionId}).forUpdate(lock).one()
    const facility = inspection?.facilityId ? one(FACILITY, {facilityId: inspection.facilityId}) : null
    const inScope =
        !!inspection &&
        (facilityScope.owns(userScope, inspection.organizationPartyId) ||
            (facility && facilityScope.owns(userScope, facility.ownerPartyId)))
    const ids = facilityIds == null ? null : Array.from(facilityIds)
    if (!inScope || (ids && !ids.includes(inspection.facilityId)))
        denied("RECORD_UNAVAILABLE", "Inspection " + (qualityInspectionId || "") + " is not available")
    return inspection
}
function requireStatus(inspection, statuses, code, message) {
    if (!statuses.includes(inspection.statusId)) denied(code, "Inspection " + inspection.qualityInspectionId + " " + message)
}

// ===== templates and their dated items =====
const effective = (row, at) => !!row.fromDate && ms(row.fromDate) <= ms(at) && (!row.thruDate || ms(row.thruDate) > ms(at))
const bySequence = (a, b) =>
    Number(a.sequenceNum ?? 0) - Number(b.sequenceNum ?? 0) ||
    String(a.characteristicName || "").localeCompare(String(b.characteristicName || ""))
// The template's items in effect at a time (an inspection's creation, a print's date).
function itemsAsOf(inspectionTemplateId, asOf) {
    if (!inspectionTemplateId) return []
    return rows(ITEM, {inspectionTemplateId})
        .filter(row => effective(row, asOf))
        .sort(bySequence)
}
// The items not published yet (a draft template's, or added to a draft).
function draftItems(inspectionTemplateId) {
    return rows(ITEM, {inspectionTemplateId})
        .filter(row => !row.fromDate && !row.thruDate)
        .sort(bySequence)
}
// The published template that applies to a product received (or returned, shipped, produced) at a facility of an
// organization at a time: the most specific of the organization's published templates of that context (a product's,
// then a category's the product is in, then one for any product; a facility's before one for any facility). None when no
// template applies.
function applicableTemplate(organizationPartyId, productId, facilityId, contextEnumId, asOf = now()) {
    if (!organizationPartyId) return null
    const categories = productId
        ? new Set(
              rows("mantle.product.category.ProductCategoryMember", {productId})
                  .filter(row => lib.active(row, asOf))
                  .map(row => row.productCategoryId)
          )
        : new Set()
    const candidates = rows(TEMPLATE, {organizationPartyId, statusId: "QtPublished"}).filter(
        row =>
            (!row.publishedDate || ms(row.publishedDate) <= ms(asOf)) &&
            (!row.inspectionContextEnumId || row.inspectionContextEnumId === contextEnumId) &&
            (!row.facilityId || row.facilityId === facilityId) &&
            (row.productId ? row.productId === productId : !row.productCategoryId || categories.has(row.productCategoryId))
    )
    const rank = row => (row.productId ? 4 : row.productCategoryId ? 2 : 0) + (row.facilityId ? 1 : 0)
    candidates.sort((a, b) => rank(b) - rank(a) || String(a.inspectionTemplateId).localeCompare(b.inspectionTemplateId))
    return candidates[0] || null
}
// An item change merged onto the stored row (or none, for a new item): the fields given, an empty one clearing it.
function mergedItem(stored, change) {
    const merged = {}
    for (const field of itemFields) {
        const given = Object.hasOwn(change, field) && change[field] !== undefined
        merged[field] = given ? (blank(change[field]) ? null : change[field]) : stored ? (stored[field] ?? null) : null
    }
    merged.readingTypeEnumId = merged.readingTypeEnumId || "QrtNumeric"
    merged.mandatory = merged.mandatory === "N" ? "N" : "Y"
    for (const field of ["lowerLimit", "upperLimit", "targetValue"]) merged[field] = decimal(merged[field])
    if (merged.sequenceNum != null) merged.sequenceNum = Number(merged.sequenceNum)
    return merged
}
function checkItem(item) {
    if (blank(item.characteristicName)) denied("NAME_REQUIRED", "Name the characteristic")
    checkEnum(item.readingTypeEnumId, "InspectionReadingType", "reading type")
    if (item.uomId && !one("moqui.basic.Uom", {uomId: item.uomId})) denied("VALUE_INVALID", "Choose a valid unit")
    if (item.readingTypeEnumId === "QrtNumeric" && item.lowerLimit != null && item.upperLimit != null)
        if (item.lowerLimit.compare(item.upperLimit) > 0)
            denied("LIMITS_INVALID", item.characteristicName + ": the lower limit is above the upper limit")
}
const differs = (stored, merged) => itemFields.some(field => !same(stored[field], merged[field]))
function checkHeader(userScope, organizationPartyId, header) {
    if (Object.hasOwn(header, "templateName") && blank(header.templateName)) denied("NAME_REQUIRED", "Name the template")
    checkEnum(header.inspectionContextEnumId, "InspectionContext", "context")
    checkEnum(header.samplePolicyEnumId, "InspectionSamplePolicy", "sample policy")
    if (header.productId && !one("mantle.product.Product", {productId: header.productId}))
        denied("VALUE_INVALID", "Product " + header.productId + " is not available")
    if (
        header.productCategoryId &&
        !one("mantle.product.category.ProductCategory", {productCategoryId: header.productCategoryId})
    )
        denied("VALUE_INVALID", "Category " + header.productCategoryId + " is not available")
    if (header.facilityId) {
        const facility = one(FACILITY, {facilityId: header.facilityId})
        if (!facility || facility.ownerPartyId !== organizationPartyId)
            denied("VALUE_INVALID", "Facility " + header.facilityId + " is not one of the template's organization")
    }
    if (header.samplePolicyEnumId === "QspFixed" && !(dec(header.sampleSize).compare(0) > 0))
        denied("SAMPLE_INVALID", "Give the number of units to sample")
    if (header.samplePolicyEnumId === "QspPercent") {
        const percent = dec(header.samplePercent)
        if (percent.compare(0) <= 0 || percent.compare(100) > 0) denied("SAMPLE_INVALID", "Give a percentage up to 100")
    }
}

// store#InspectionTemplate: create a draft or change one of the user's templates: the header when templateName is given
// (every header field then takes the value given, an empty one clearing it), item changes in itemList (a draft item is
// edited or removed in place; a published one is ended and, when changed, a new row starts now), then publish (stamps the
// draft items' fromDate) or retire. A published template's changes need a reason (audit-logged).
function storeTemplate(p) {
    requireAny(["QUALITY_TEMPLATE_EDIT"])
    const userScope = scope()
    let template = blank(p.inspectionTemplateId) ? null : templateOf(userScope, p.inspectionTemplateId, true)
    if (template?.statusId === "QtRetired")
        denied("TEMPLATE_RETIRED", "Template " + template.inspectionTemplateId + " is retired")
    const changeReason = text(p.changeReason)
    const header = {}
    if (!template || !blank(p.templateName)) for (const field of headerFields) header[field] = blank(p[field]) ? null : p[field]
    for (const field of ["sampleSize", "samplePercent"]) if (Object.hasOwn(header, field)) header[field] = decimal(header[field])
    const organizationPartyId = template ? template.organizationPartyId : organizationOf(userScope, p.organizationPartyId)
    if (!template && blank(header.templateName)) denied("NAME_REQUIRED", "Name the template")
    checkHeader(userScope, organizationPartyId, header)
    const published = template?.statusId === "QtPublished"
    const itemList = Array.from(p.itemList || []).map(change => Object.assign({}, change?.getMap ? change.getMap() : change))
    const headerChanged = template && Object.keys(header).some(field => !same(template[field], header[field]))
    if (published && (headerChanged || itemList.length) && !changeReason)
        denied("REASON_REQUIRED", "Give the reason for changing a published template")
    if (!template) {
        const created = call(
            "create#" + TEMPLATE,
            Object.assign({}, header, {
                organizationPartyId,
                statusId: "QtDraft",
                samplePolicyEnumId: header.samplePolicyEnumId || "QspAll",
                createdDate: now(),
                createdByUserId: ec.user.userId
            })
        )
        template = find(TEMPLATE, {inspectionTemplateId: created.inspectionTemplateId}).forUpdate(true).one()
    } else if (headerChanged) {
        call("update#" + TEMPLATE, Object.assign({inspectionTemplateId: template.inspectionTemplateId, changeReason}, header))
    }
    const inspectionTemplateId = template.inspectionTemplateId
    const changedItemIds = [],
        endedItemIds = []
    for (const change of itemList) {
        const id = text(change.inspectionTemplateItemId)
        if (!id) {
            if (truthy(change.remove)) continue
            const merged = mergedItem(null, change)
            checkItem(merged)
            const created = call(
                "create#" + ITEM,
                Object.assign({}, merged, {
                    inspectionTemplateId,
                    fromDate: published ? now() : null,
                    changeReason
                })
            )
            call("update#" + ITEM, {
                inspectionTemplateItemId: created.inspectionTemplateItemId,
                characteristicId: created.inspectionTemplateItemId
            })
            changedItemIds.push(created.inspectionTemplateItemId)
            continue
        }
        const stored = find(ITEM, {inspectionTemplateItemId: id}).forUpdate(true).one()
        if (!stored || stored.inspectionTemplateId !== inspectionTemplateId)
            denied("ITEM_INVALID", "Characteristic " + id + " is not of template " + inspectionTemplateId)
        if (stored.thruDate) denied("ITEM_ENDED", "Characteristic " + id + " has ended; change its current row")
        if (!stored.fromDate) {
            // a draft item: edited or removed in place, nothing was read from it
            if (truthy(change.remove)) {
                call("delete#" + ITEM, {inspectionTemplateItemId: id})
                endedItemIds.push(id)
            } else {
                const merged = mergedItem(stored, change)
                checkItem(merged)
                call("update#" + ITEM, Object.assign({inspectionTemplateItemId: id}, merged))
                changedItemIds.push(id)
            }
            continue
        }
        // a published item: never edited in place
        if (truthy(change.remove)) {
            call("update#" + ITEM, {inspectionTemplateItemId: id, thruDate: now(), changeReason})
            endedItemIds.push(id)
            continue
        }
        const merged = mergedItem(stored, change)
        if (!differs(stored, merged)) continue
        checkItem(merged)
        call("update#" + ITEM, {inspectionTemplateItemId: id, thruDate: now(), changeReason})
        const created = call(
            "create#" + ITEM,
            Object.assign({}, merged, {
                inspectionTemplateId,
                characteristicId: stored.characteristicId || stored.inspectionTemplateItemId,
                previousItemId: id,
                fromDate: now(),
                changeReason
            })
        )
        endedItemIds.push(id)
        changedItemIds.push(created.inspectionTemplateItemId)
    }
    let statusId = template.statusId
    if (p.action === "publish") {
        if (statusId !== "QtDraft") denied("TEMPLATE_PUBLISHED", "Template " + inspectionTemplateId + " is already published")
        const drafts = draftItems(inspectionTemplateId)
        if (!drafts.length && !itemsAsOf(inspectionTemplateId, now()).length)
            denied("NO_ITEMS", "Add a characteristic before publishing")
        for (const item of drafts)
            call("update#" + ITEM, {inspectionTemplateItemId: item.inspectionTemplateItemId, fromDate: now()})
        call("update#" + TEMPLATE, {inspectionTemplateId, statusId: "QtPublished", publishedDate: now(), changeReason})
        statusId = "QtPublished"
    } else if (p.action === "retire") {
        if (!changeReason) denied("REASON_REQUIRED", "Give the reason for retiring the template")
        call("update#" + TEMPLATE, {inspectionTemplateId, statusId: "QtRetired", retiredDate: now(), changeReason})
        statusId = "QtRetired"
    } else if (!blank(p.action)) denied("ACTION_INVALID", "Unknown template action " + p.action)
    return {inspectionTemplateId, statusId, changedItemIds, endedItemIds}
}

const names = (entity, idField, nameField, ids) => {
    const wanted = unique(ids)
    if (!wanted.length) return {}
    return Object.fromEntries(
        Array.from(find(entity).condition(idField, "in", wanted).list()).map(row => [
            row[idField],
            row[nameField] || row[idField]
        ])
    )
}
const enumNames = ids => names("moqui.basic.Enumeration", "enumId", "description", ids)
const statusNames = ids => names("moqui.basic.StatusItem", "statusId", "description", ids)
const userNames = ids => names("moqui.security.UserAccount", "userId", "userFullName", ids)
const itemRow = (item, readingType) =>
    Object.assign(lib.display(item), {
        readingTypeText: readingType[item.readingTypeEnumId] || item.readingTypeEnumId,
        limitsText: limitsText(item),
        lowerLimit: textOf(item.lowerLimit),
        upperLimit: textOf(item.upperLimit),
        targetValue: textOf(item.targetValue)
    })
function limitsText(item) {
    if (item.readingTypeEnumId !== "QrtNumeric") return ""
    const unit = item.uomId ? " " + (one("moqui.basic.Uom", {uomId: item.uomId})?.abbreviation || item.uomId) : ""
    const low = textOf(item.lowerLimit),
        high = textOf(item.upperLimit),
        target = textOf(item.targetValue)
    const range =
        low != null && high != null
            ? low + " to " + high
            : low != null
              ? "at least " + low
              : high != null
                ? "at most " + high
                : ""
    return [range && range + unit, target != null ? "target " + target + unit : ""].filter(Boolean).join(", ")
}

// get#InspectionTemplate: a template of the user's organizations with its items as of a date (now by default) and its
// draft items, and its revision history: every item row with its dates and the header's audit-logged changes.
function getTemplate(p) {
    const userScope = scope()
    const template = templateOf(userScope, p.inspectionTemplateId)
    const asOf = p.asOfDate || now()
    const allItems = rows(ITEM, {inspectionTemplateId: template.inspectionTemplateId})
    const readingType = enumNames(allItems.map(row => row.readingTypeEnumId))
    const audit = Array.from(
        find("moqui.entity.EntityAuditLog", {changedEntityName: TEMPLATE, pkPrimaryValue: template.inspectionTemplateId})
            .orderBy("-changedDate")
            .limit(100)
            .list()
    )
    const users = userNames(audit.map(row => row.changedByUserId))
    const header = lib.display(template)
    const enums = enumNames([template.inspectionContextEnumId, template.samplePolicyEnumId])
    Object.assign(header, {
        statusText: statusNames([template.statusId])[template.statusId] || template.statusId,
        contextText: enums[template.inspectionContextEnumId] || "Any context",
        samplePolicyText: enums[template.samplePolicyEnumId] || "",
        sampleSize: textOf(template.sampleSize),
        samplePercent: textOf(template.samplePercent),
        organizationName: lib.partyNames([template.organizationPartyId])[template.organizationPartyId] || "",
        productName: template.productId ? one("mantle.product.Product", {productId: template.productId})?.productName || "" : "",
        categoryName: template.productCategoryId
            ? one("mantle.product.category.ProductCategory", {productCategoryId: template.productCategoryId})?.categoryName || ""
            : "",
        facilityName: template.facilityId ? one(FACILITY, {facilityId: template.facilityId})?.facilityName || "" : ""
    })
    return {
        template: header,
        asOfDate: asOf,
        asOfText: dateText(asOf),
        items: itemsAsOf(template.inspectionTemplateId, asOf).map(item => itemRow(item, readingType)),
        draftItems: draftItems(template.inspectionTemplateId).map(item => itemRow(item, readingType)),
        revisionRows: allItems
            .filter(row => row.fromDate)
            .sort(
                (a, b) => String(a.characteristicId).localeCompare(String(b.characteristicId)) || ms(a.fromDate) - ms(b.fromDate)
            )
            .map(item =>
                Object.assign(itemRow(item, readingType), {
                    stateText: item.thruDate ? (ms(item.thruDate) <= ms(now()) ? "Ended" : "Ending") : "In effect",
                    revisedFrom: item.previousItemId || null
                })
            ),
        changeRows: audit.map(row => ({
            changedDateText: dateText(row.changedDate),
            fieldName: row.changedFieldName,
            oldValueText: row.oldValueText || "",
            newValueText: row.newValueText || "",
            changeReason: row.changeReason || "",
            changedByName: users[row.changedByUserId] || row.changedByUserId || ""
        }))
    }
}

// find#InspectionTemplates: the user's organizations' templates by state, context, product and name, a page at a time.
function findTemplates(p) {
    const userScope = scope()
    let query = find(TEMPLATE).orderBy("templateName")
    if (userScope.organizationPartyIds) query = query.condition("organizationPartyId", "in", userScope.organizationPartyIds)
    if (!blank(p.statusId)) query = query.condition("statusId", p.statusId)
    if (!blank(p.inspectionContextEnumId)) query = query.condition("inspectionContextEnumId", p.inspectionContextEnumId)
    if (!blank(p.productId)) query = query.condition("productId", p.productId)
    if (!blank(p.templateName))
        query = query.condition(
            ec.entity.conditionFactory
                .makeCondition("templateName", "like", "%" + String(p.templateName).replace(/[\\%_]/g, c => "\\" + c) + "%")
                .ignoreCase()
        )
    const found = lib.page(query, p, "templates", query.count())
    const statuses = statusNames(found.rows.map(row => row.statusId))
    const enums = enumNames(found.rows.map(row => row.inspectionContextEnumId))
    const products = names(
        "mantle.product.Product",
        "productId",
        "productName",
        found.rows.map(row => row.productId)
    )
    const categories = names(
        "mantle.product.category.ProductCategory",
        "productCategoryId",
        "categoryName",
        found.rows.map(row => row.productCategoryId)
    )
    found.templates = found.rows.map(row =>
        Object.assign(lib.display(row), {
            statusText: statuses[row.statusId] || row.statusId,
            contextText: enums[row.inspectionContextEnumId] || "Any context",
            appliesText:
                [
                    row.productId ? products[row.productId] || row.productId : "",
                    row.productCategoryId ? "category " + (categories[row.productCategoryId] || row.productCategoryId) : "",
                    row.facilityId ? "at " + row.facilityId : ""
                ]
                    .filter(Boolean)
                    .join(" · ") || "Any product",
            itemCount: itemsAsOf(row.inspectionTemplateId, now()).length + draftItems(row.inspectionTemplateId).length
        })
    )
    delete found.rows
    return found
}

// ===== inspections =====
// The sample of a quantity under a template's policy: every unit, a fixed number (at most the quantity), or a percentage
// rounded up; at least one unit.
function sampleOf(template, quantity, given) {
    if (!blank(given)) {
        const sample = dec(given)
        if (sample.compare(0) <= 0 || sample.compare(quantity) > 0)
            denied("SAMPLE_INVALID", "The sample is from 1 to the quantity")
        return sample
    }
    if (!template || template.samplePolicyEnumId === "QspAll" || !template.samplePolicyEnumId) return quantity
    if (template.samplePolicyEnumId === "QspFixed") {
        const fixed = dec(template.sampleSize)
        return fixed.compare(quantity) > 0 ? quantity : fixed
    }
    const percent = Math.ceil((quantity.toNumber() * dec(template.samplePercent).toNumber()) / 100)
    return toDecimal(Math.max(1, Math.min(quantity.toNumber(), percent)))
}
// An inspector: a person of the organization (agent or employee) whose user may inspect (QUALITY_INSPECT in a group).
function checkInspector(partyId, organizationPartyId) {
    const member = rows("mantle.party.PartyRelationship", {fromPartyId: partyId, toPartyId: organizationPartyId}).some(
        row => ["PrtAgent", "PrtEmployee"].includes(row.relationshipTypeEnumId) && lib.active(row)
    )
    const userIds = rows("moqui.security.UserAccount", {partyId}).map(row => row.userId)
    const groupIds = userIds.length
        ? Array.from(find("moqui.security.UserGroupMember").condition("userId", "in", userIds).list())
              .filter(row => lib.active(row))
              .map(row => row.userGroupId)
        : []
    const inspects =
        groupIds.length &&
        Array.from(
            find("moqui.security.UserGroupPermission", {userPermissionId: "QUALITY_INSPECT"})
                .condition("userGroupId", "in", groupIds)
                .list()
        ).some(row => lib.active(row))
    if (!member || !inspects) denied("INSPECTOR_INVALID", "Assign the inspection to someone of the organization who inspects")
    return partyId
}

// An inspection (QiDraft) for a source: an asset (its facility, product, lot and on-hand quantity), a receipt (its asset,
// shipment and order line) or a facility and product; the template given (published, of the organization) or the one
// that applies; the items read as of now; the stock held when the asset is quarantined; the demand of a run's
// OrderItemWorkEffort when none is given. Called by create#Inspection after its permission, and by the receipt guard in its
// own operation (that entry point's check, impl-warehouse §2).
function createInspection(userScope, p) {
    let asset = null,
        receipt = null
    if (!blank(p.assetReceiptId)) {
        receipt = one(RECEIPT, {assetReceiptId: p.assetReceiptId})
        if (!receipt) denied("RECORD_UNAVAILABLE", "Receipt " + p.assetReceiptId + " is not available")
        const open = find(INSPECTION, {assetReceiptId: p.assetReceiptId}).condition("statusId", "in", openStatuses).count()
        if (open) denied("INSPECTION_EXISTS", "Receipt " + p.assetReceiptId + " already has an open inspection")
    }
    const assetId = text(p.assetId) || receipt?.assetId || null
    if (assetId) {
        asset = one(ASSET, {assetId})
        if (!asset) denied("RECORD_UNAVAILABLE", "Asset " + assetId + " is not available")
    }
    const facilityId = asset?.facilityId || text(p.facilityId)
    const facility = facilityId ? one(FACILITY, {facilityId}) : null
    if (!facility || !facilityScope.owns(userScope, facility.ownerPartyId))
        denied("RECORD_UNAVAILABLE", "Facility " + (facilityId || "") + " is not available")
    const productId = asset?.productId || receipt?.productId || text(p.productId)
    if (!productId || !one("mantle.product.Product", {productId})) denied("PRODUCT_REQUIRED", "Give the product inspected")
    const quantity = blank(p.quantity)
        ? receipt
            ? dec(receipt.quantityAccepted)
            : dec(asset?.quantityOnHandTotal)
        : dec(p.quantity)
    if (quantity.compare(0) <= 0) denied("QUANTITY_INVALID", "Give a quantity above zero")
    if (asset && quantity.compare(dec(asset.quantityOnHandTotal)) > 0)
        denied(
            "QUANTITY_EXCEEDS_ON_HAND",
            "Asset " + asset.assetId + " has only " + textOf(asset.quantityOnHandTotal) + " on hand"
        )
    const contextEnumId =
        checkEnum(text(p.inspectionContextEnumId), "InspectionContext", "context") ||
        (receipt || p.shipmentId ? "QicReceipt" : p.returnId ? "QicReturn" : p.workEffortId ? "QicProduction" : "QicReceipt")
    const organizationPartyId = facility.ownerPartyId
    const asOf = now()
    let template = null
    if (!blank(p.inspectionTemplateId)) {
        template = templateOf(userScope, p.inspectionTemplateId)
        if (template.statusId !== "QtPublished" || template.organizationPartyId !== organizationPartyId)
            denied("TEMPLATE_UNAVAILABLE", "Template " + p.inspectionTemplateId + " is not published for " + organizationPartyId)
    } else template = applicableTemplate(organizationPartyId, productId, facility.facilityId, contextEnumId, asOf)
    if (!blank(p.inspectorPartyId)) checkInspector(p.inspectorPartyId, organizationPartyId)
    let demandOrderId = text(p.demandOrderId),
        demandOrderItemSeqId = text(p.demandOrderItemSeqId)
    if (demandOrderId && !one("mantle.order.OrderItem", {orderId: demandOrderId, orderItemSeqId: demandOrderItemSeqId}))
        denied("DEMAND_INVALID", "Order item " + demandOrderId + ":" + (demandOrderItemSeqId || "") + " is not available")
    if (!demandOrderId && !blank(p.workEffortId)) {
        const pegged = rows("mantle.order.OrderItemWorkEffort", {workEffortId: p.workEffortId})[0]
        if (pegged) {
            demandOrderId = pegged.orderId
            demandOrderItemSeqId = pegged.orderItemSeqId
        }
    }
    const sourceTypeEnumId =
        checkEnum(text(p.sourceTypeEnumId), "InspectionSourceType", "source") ||
        (receipt
            ? "QisReceipt"
            : p.returnId
              ? "QisReturn"
              : p.workEffortId
                ? "QisWorkEffort"
                : p.shipmentId
                  ? "QisShipment"
                  : "QisAsset")
    const held = asset?.statusId === "AstQuarantine" ? quantity : toDecimal(0)
    const created = call("create#" + INSPECTION, {
        organizationPartyId,
        facilityId: facility.facilityId,
        statusId: "QiDraft",
        inspectionContextEnumId: contextEnumId,
        sourceTypeEnumId,
        shipmentId: receipt?.shipmentId || text(p.shipmentId),
        assetReceiptId: receipt?.assetReceiptId || null,
        orderId: receipt?.orderId || text(p.orderId),
        orderItemSeqId: receipt?.orderItemSeqId || text(p.orderItemSeqId),
        returnId: text(p.returnId),
        returnItemSeqId: text(p.returnItemSeqId),
        workEffortId: text(p.workEffortId),
        productId,
        lotId: asset?.lotId || text(p.lotId),
        assetId: asset?.assetId || null,
        quantity,
        heldQuantity: held,
        disposedQuantity: toDecimal(0),
        sampleSize: sampleOf(template, quantity, p.sampleSize),
        inspectionTemplateId: template?.inspectionTemplateId || null,
        templateAsOfDate: asOf,
        inspectorPartyId: text(p.inspectorPartyId),
        dueDate: p.dueDate || null,
        demandOrderId,
        demandOrderItemSeqId,
        createdDate: asOf,
        createdByUserId: ec.user.userId,
        comments: text(p.comments)
    })
    return {
        qualityInspectionId: created.qualityInspectionId,
        inspectionTemplateId: template?.inspectionTemplateId || null,
        heldQuantity: textOf(held),
        quantity: textOf(quantity)
    }
}

// Whether a receipt of a product at a facility needs inspection: the operation policy's step 3 (quarantine then inspection),
// the tracking policy's inspectionRequired, or a published receipt template that applies (design-warehouse §4 Receive).
function receiptNeedsInspection(facility, productId, policy) {
    if (Number(policy.operation?.receiptSteps) === 3) return true
    if (policy.tracking?.inspectionRequired === "Y") return true
    return !!applicableTemplate(facility.ownerPartyId, productId, facility.facilityId, "QicReceipt")
}
// The inspections of a receipt line just posted into quarantine: one per receipt with accepted stock, in the receipt's own
// operation (its STOCK_RECEIVE check). Answers their ids.
function receiptInspections(userScope, assetReceiptIds) {
    const ids = []
    for (const assetReceiptId of Array.from(assetReceiptIds || [])) {
        const receipt = one(RECEIPT, {assetReceiptId})
        if (!receipt?.assetId || dec(receipt.quantityAccepted).compare(0) <= 0) continue
        ids.push(createInspection(userScope, {assetReceiptId}).qualityInspectionId)
    }
    return ids
}

// assign#Inspection: the inspector and due date of an open inspection (assigning work only: never its status), and while it
// is a draft with no readings its template.
function assignInspection(p) {
    requireAny(["QUALITY_INSPECT", "QUALITY_VERIFY", "QUALITY_DISPOSE"])
    const userScope = scope()
    const inspection = inspectionOf(userScope, p.qualityInspectionId, true, p.facilityIds)
    requireStatus(inspection, openStatuses, "INSPECTION_CLOSED", "is closed")
    const changes = {}
    if (p.inspectorPartyId !== undefined && p.inspectorPartyId !== null) {
        if (!blank(p.inspectorPartyId)) checkInspector(p.inspectorPartyId, inspection.organizationPartyId)
        changes.inspectorPartyId = text(p.inspectorPartyId)
    }
    if (p.dueDate) changes.dueDate = p.dueDate
    if (!blank(p.inspectionTemplateId) && p.inspectionTemplateId !== inspection.inspectionTemplateId) {
        if (inspection.statusId !== "QiDraft" || find(READING, {qualityInspectionId: inspection.qualityInspectionId}).count())
            denied("TEMPLATE_FIXED", "The template of an inspection with readings stays as it is")
        const template = templateOf(userScope, p.inspectionTemplateId)
        if (template.statusId !== "QtPublished" || template.organizationPartyId !== inspection.organizationPartyId)
            denied("TEMPLATE_UNAVAILABLE", "Template " + p.inspectionTemplateId + " is not published")
        // the inspection reads its new template as of now
        Object.assign(changes, {
            inspectionTemplateId: template.inspectionTemplateId,
            templateAsOfDate: now(),
            sampleSize: sampleOf(template, dec(inspection.quantity), null)
        })
    }
    if (Object.keys(changes).length)
        call("update#" + INSPECTION, Object.assign({qualityInspectionId: inspection.qualityInspectionId}, changes))
    return {
        qualityInspectionId: inspection.qualityInspectionId,
        inspectorPartyId: changes.inspectorPartyId ?? inspection.inspectorPartyId
    }
}

// save#InspectionReading: a reading of an item the inspection's template had at its creation, for a sample from 1 to the
// sample size, while it is a draft; a measured value passes within the item's limits; saved again it replaces the value
// (audit-logged).
function saveReading(p) {
    requireAny(["QUALITY_INSPECT"])
    const userScope = scope()
    const inspection = inspectionOf(userScope, p.qualityInspectionId, true, p.facilityIds)
    requireStatus(inspection, ["QiDraft"], "INSPECTION_NOT_DRAFT", "is not a draft: readings are saved before it is submitted")
    const item = itemsAsOf(inspection.inspectionTemplateId, inspection.templateAsOfDate).find(
        row => row.inspectionTemplateItemId === p.inspectionTemplateItemId
    )
    if (!item) denied("ITEM_INVALID", "Characteristic " + (p.inspectionTemplateItemId || "") + " is not of this inspection")
    const sampleNumber = blank(p.sampleNumber) ? 1 : Number(p.sampleNumber)
    if (!Number.isInteger(sampleNumber) || sampleNumber < 1 || sampleNumber > dec(inspection.sampleSize).toNumber())
        denied("SAMPLE_INVALID", "The sample is from 1 to " + textOf(inspection.sampleSize))
    const values = {numericValue: null, passIndicator: null, textValue: text(p.textValue)}
    if (item.readingTypeEnumId === "QrtNumeric") {
        if (blank(p.numericValue)) denied("VALUE_REQUIRED", "Give the measured value of " + item.characteristicName)
        let value
        try {
            value = toDecimal(p.numericValue)
        } catch (error) {
            denied("VALUE_INVALID", "Give a number for " + item.characteristicName)
        }
        const low = item.lowerLimit != null && value.compare(item.lowerLimit) < 0
        const high = item.upperLimit != null && value.compare(item.upperLimit) > 0
        Object.assign(values, {numericValue: value, passIndicator: low || high ? "N" : "Y"})
    } else if (item.readingTypeEnumId === "QrtPassFail") {
        if (!["Y", "N"].includes(p.passIndicator)) denied("VALUE_REQUIRED", "Give pass or fail for " + item.characteristicName)
        values.passIndicator = p.passIndicator
    } else {
        if (!values.textValue) denied("VALUE_REQUIRED", "Give the observation of " + item.characteristicName)
        values.passIndicator = ["Y", "N"].includes(p.passIndicator) ? p.passIndicator : "Y"
    }
    const existing = find(READING, {
        qualityInspectionId: inspection.qualityInspectionId,
        inspectionTemplateItemId: item.inspectionTemplateItemId,
        sampleNumber
    })
        .forUpdate(true)
        .one()
    const fields = Object.assign(values, {
        uomId: item.uomId || null,
        comments: text(p.comments),
        readDate: now(),
        readByUserId: ec.user.userId
    })
    let inspectionReadingId
    if (existing) {
        inspectionReadingId = existing.inspectionReadingId
        call("update#" + READING, Object.assign({inspectionReadingId}, fields))
    } else
        inspectionReadingId = call(
            "create#" + READING,
            Object.assign(
                {
                    qualityInspectionId: inspection.qualityInspectionId,
                    inspectionTemplateItemId: item.inspectionTemplateItemId,
                    sampleNumber
                },
                fields
            )
        ).inspectionReadingId
    return {inspectionReadingId, passIndicator: fields.passIndicator}
}

// The mandatory items without a reading.
function missingReadings(inspection) {
    const read = new Set(
        rows(READING, {qualityInspectionId: inspection.qualityInspectionId}).map(row => row.inspectionTemplateItemId)
    )
    return itemsAsOf(inspection.inspectionTemplateId, inspection.templateAsOfDate).filter(
        item => item.mandatory !== "N" && !read.has(item.inspectionTemplateItemId)
    )
}
// The decision notice (topic QualityInspectionDecision): to the organization's holders of a permission, or to the
// inspector's users. A notice that fails is logged; the inspection stands.
function notifyDecision(inspection, decision, permission) {
    const message = {
        qualityInspectionId: inspection.qualityInspectionId,
        decision,
        facilityId: inspection.facilityId,
        productId: inspection.productId
    }
    try {
        if (permission) {
            ec.resource.script("component://mr-mantle/service/mantle/account/Payables.js").execute("notify", {
                topic: "QualityInspectionDecision",
                permission,
                organizationPartyId: inspection.organizationPartyId,
                recordEntityName: INSPECTION,
                recordId: inspection.qualityInspectionId,
                message
            })
            return true
        }
        const userIds = inspection.inspectorPartyId
            ? rows("moqui.security.UserAccount", {partyId: inspection.inspectorPartyId})
                  .map(row => row.userId)
                  .filter(userId => userId !== ec.user.userId)
            : []
        if (!userIds.length) return false
        ec.makeNotificationMessage()
            .topic("QualityInspectionDecision")
            .message(message)
            .record(INSPECTION, inspection.qualityInspectionId)
            .actorUserId(ec.user.userId)
            .userIds(userIds)
            .send()
        return true
    } catch (error) {
        ec.logger.error("Inspection decision notice for " + inspection.qualityInspectionId + " failed: " + error.message)
        return false
    }
}

// submit#Inspection: the result of a draft whose mandatory items each have a reading: accepted and rejected adding up to
// the quantity, a reason for a rejection; the verifiers hear of it.
function submitInspection(p) {
    requireAny(["QUALITY_INSPECT"])
    const userScope = scope()
    const inspection = inspectionOf(userScope, p.qualityInspectionId, true, p.facilityIds)
    requireStatus(inspection, ["QiDraft"], "INSPECTION_NOT_DRAFT", "is not a draft")
    const missing = missingReadings(inspection)
    if (missing.length)
        denied("READINGS_REQUIRED", "Readings are needed for " + missing.map(item => item.characteristicName).join(", "))
    const accepted = dec(p.quantityAccepted),
        rejected = dec(p.quantityRejected)
    if (accepted.compare(0) < 0 || rejected.compare(0) < 0 || accepted.add(rejected).compare(dec(inspection.quantity)) !== 0)
        denied("QUANTITY_MISMATCH", "Accepted and rejected must add up to the " + textOf(inspection.quantity) + " inspected")
    if (rejected.compare(0) > 0 && blank(p.resultReason)) denied("REASON_REQUIRED", "Give the reason units are rejected")
    const resultEnumId = rejected.isZero() ? "QirAccepted" : accepted.isZero() ? "QirRejected" : "QirPartial"
    call("update#" + INSPECTION, {
        qualityInspectionId: inspection.qualityInspectionId,
        statusId: "QiSubmitted",
        resultEnumId,
        quantityAccepted: accepted,
        quantityRejected: rejected,
        resultReason: text(p.resultReason),
        submittedDate: now(),
        submittedByUserId: ec.user.userId
    })
    notifyDecision(
        inspection,
        "submitted, " + (enumNames([resultEnumId])[resultEnumId] || resultEnumId).toLowerCase(),
        "QUALITY_VERIFY"
    )
    return {qualityInspectionId: inspection.qualityInspectionId, statusId: "QiSubmitted", resultEnumId}
}

// verify#Inspection: a submitted inspection verified (Verified, ready for disposition) or returned to its inspector (Draft,
// the readings kept) by a user who did not submit it; the inspector hears of it.
function verifyInspection(p) {
    requireAny(["QUALITY_VERIFY"])
    const userScope = scope()
    const inspection = inspectionOf(userScope, p.qualityInspectionId, true, p.facilityIds)
    requireStatus(inspection, ["QiSubmitted"], "INSPECTION_NOT_SUBMITTED", "is not waiting for verification")
    if (inspection.submittedByUserId === ec.user.userId)
        denied("SELF_VERIFY", "The user who submitted an inspection does not verify it")
    const approve = !(p.approve === false || p.approve === "false" || p.approve === "N")
    if (!approve && blank(p.verificationComments)) denied("REASON_REQUIRED", "Say why the inspection goes back to its inspector")
    const statusId = approve ? "QiVerified" : "QiDraft"
    call("update#" + INSPECTION, {
        qualityInspectionId: inspection.qualityInspectionId,
        statusId,
        verifiedDate: approve ? now() : null,
        verifiedByUserId: approve ? ec.user.userId : null,
        verificationComments: text(p.verificationComments)
    })
    notifyDecision(inspection, approve ? "verified" : "returned to the inspector", null)
    return {qualityInspectionId: inspection.qualityInspectionId, statusId}
}

// ===== dispositions (dispose#Inspection, through StockPosting.js) =====
// The inspection, locked first (the one lock order: the inspection, then its asset, then the location).
function lockInspection(userScope, qualityInspectionId, facilityIds) {
    return inspectionOf(userScope, qualityInspectionId, true, facilityIds)
}
// What is left to dispose: the accepted quantity less Release, the rejected less the other dispositions.
function remaining(inspection) {
    const done = rows(DISPOSITION, {qualityInspectionId: inspection.qualityInspectionId})
    const taken = kinds =>
        done.filter(row => kinds(row.dispositionEnumId)).reduce((sum, row) => sum.add(dec(row.quantity)), toDecimal(0))
    const accepted = dec(inspection.quantityAccepted).subtract(taken(id => acceptedDispositions.includes(id)))
    const rejected = dec(inspection.quantityRejected).subtract(taken(id => !acceptedDispositions.includes(id)))
    return {accepted, rejected, dispositions: done}
}
// Everything checked before anything posts: the status, the disposition, the quantity left for its kind, the reason, the
// destination's type and status (posting.destination: open, locked), the stock held.
function dispositionPlan(userScope, inspection, asset, p) {
    requireStatus(inspection, ["QiVerified"], "VERIFICATION_REQUIRED", "is not verified: verify it before its disposition")
    const dispositionEnumId = checkEnum(text(p.dispositionEnumId), "InspectionDisposition", "disposition")
    if (!dispositionEnumId) denied("DISPOSITION_INVALID", "Choose the disposition")
    const quantity = dec(p.quantity)
    if (quantity.compare(0) <= 0) denied("QUANTITY_INVALID", "Give a quantity above zero")
    const left = remaining(inspection)
    const fromAccepted = acceptedDispositions.includes(dispositionEnumId)
    const available = fromAccepted ? left.accepted : left.rejected
    if (quantity.compare(available) > 0)
        denied(
            "QUANTITY_EXCEEDS_RESULT",
            textOf(available) +
                " " +
                (fromAccepted ? "accepted" : "rejected") +
                " is left to dispose of inspection " +
                inspection.qualityInspectionId
        )
    const held = !!asset && asset.statusId === "AstQuarantine"
    if (dispositionEnumId === "QdScrap" && !held)
        denied("NOT_HELD", "Only held stock is scrapped by its inspection; scrap free stock with Adjustments")
    if (["QdScrap"].includes(dispositionEnumId) && !blank(p.varianceReasonEnumId)) {
        const reason = one("moqui.basic.Enumeration", {enumId: p.varianceReasonEnumId})
        if (reason?.enumTypeId !== "InventoryVarianceReason" || !(reason.enumCode === "scrap" || reason.enumId === "InVrDamaged"))
            denied("REASON_INVALID", "Scrap with a scrap, expired or damaged reason")
    }
    let target = null
    if (!blank(p.toLocationSeqId) && held) {
        target = posting.destination(userScope, asset.facilityId, {toLocationSeqId: p.toLocationSeqId})
        const released = endingDispositions.includes(dispositionEnumId) && dispositionEnumId !== "QdScrap"
        if (dispositionEnumId === "QdScrap" && target.locationTypeEnumId !== "FltMorgue")
            denied("LOCATION_NOT_MORGUE", "Location " + p.toLocationSeqId + " is not a morgue location")
        if (released && target.autoStatusId && target.autoStatusId !== "AstAvailable")
            denied("LOCATION_INVALID", "Location " + p.toLocationSeqId + " would make released stock " + target.autoStatusId)
        if (!endingDispositions.includes(dispositionEnumId) && target.locationTypeEnumId !== "FltQuarantine")
            denied("LOCATION_NOT_QUARANTINE", "Stock that stays held moves only to a quarantine location")
    }
    return {dispositionEnumId, quantity, held, target, remainingBefore: left}
}
// The quantity as its own asset where it is (a part of the asset split off; the whole asset as it is), keeping its status.
function splitOff(asset, quantity) {
    if (quantity.compare(dec(asset.quantityOnHandTotal)) >= 0) return asset.assetId
    const moved = call("mantle.product.AssetServices.move#Asset", {
        assetId: asset.assetId,
        facilityId: asset.facilityId,
        locationSeqId: asset.locationSeqId,
        assetPoolId: asset.assetPoolId,
        quantity,
        forceNewAsset: true
    })
    return moved.newAssetId || asset.assetId
}
// The disposition's stock postings and records, in the entry point's transaction: Release (and Use as is) reserves the
// pegged demand on the released stock first and then sets AstAvailable (the SECA gives the rest to waiting reservations),
// then moves it when a destination is given; Scrap sets AstMorgue (moved to the morgue when given) and calls scrap#Asset
// with this disposition; the others keep it quarantined, moved within quarantine when given. Then the disposition row, the
// inspection's held and disposed quantities (Disposed once nothing is left), the bill matches of its receipt queued and
// the inspector's notice. Answers the result fields.
function disposeStock(inspection, asset, plan, p) {
    const {dispositionEnumId, quantity, held, target} = plan
    let resultAssetId = asset?.assetId || null
    let statusAfter = asset?.statusId || null
    let reserved = null,
        physicalInventoryId = null
    const dispositionSeqId = String(rows(DISPOSITION, {qualityInspectionId: inspection.qualityInspectionId}).length + 1).padStart(
        2,
        "0"
    )
    if (held && ["QdRelease", "QdUseAsIs"].includes(dispositionEnumId)) {
        resultAssetId = splitOff(asset, quantity)
        if (inspection.demandOrderId) {
            call("mantle.product.AssetServices.reserve#AssetForOrderItem", {
                orderId: inspection.demandOrderId,
                orderItemSeqId: inspection.demandOrderItemSeqId,
                assetId: resultAssetId,
                resetReservations: true
            })
            reserved = {orderId: inspection.demandOrderId, orderItemSeqId: inspection.demandOrderItemSeqId}
        }
        call("mantle.product.AssetServices.update#Asset", {assetId: resultAssetId, statusId: "AstAvailable"})
        statusAfter = "AstAvailable"
        if (target && target.locationSeqId !== asset.locationSeqId)
            call("mantle.product.AssetServices.move#Asset", {
                assetId: resultAssetId,
                facilityId: asset.facilityId,
                locationSeqId: target.locationSeqId
            })
    } else if (held && dispositionEnumId === "QdScrap") {
        if (target && target.locationSeqId !== asset.locationSeqId) {
            // the morgue location gives AstMorgue by its type, through the flow from AstQuarantine
            const moved = call("mantle.product.AssetServices.move#Asset", {
                assetId: asset.assetId,
                facilityId: asset.facilityId,
                locationSeqId: target.locationSeqId,
                assetPoolId: asset.assetPoolId,
                quantity
            })
            resultAssetId = moved.newAssetId || asset.assetId
        } else resultAssetId = splitOff(asset, quantity)
        const morgue = one(ASSET, {assetId: resultAssetId})
        if (morgue.statusId !== "AstMorgue")
            call("mantle.product.AssetServices.update#Asset", {assetId: resultAssetId, statusId: "AstMorgue"})
        statusAfter = "AstMorgue"
    } else if (held && target && target.locationSeqId !== asset.locationSeqId) {
        const moved = call("mantle.product.AssetServices.move#Asset", {
            assetId: asset.assetId,
            facilityId: asset.facilityId,
            locationSeqId: target.locationSeqId,
            assetPoolId: asset.assetPoolId,
            quantity
        })
        resultAssetId = moved.newAssetId || asset.assetId
    }
    call("create#" + DISPOSITION, {
        qualityInspectionId: inspection.qualityInspectionId,
        dispositionSeqId,
        dispositionEnumId,
        quantity,
        assetId: asset?.assetId || null,
        resultAssetId,
        fromLocationSeqId: asset?.locationSeqId || null,
        toLocationSeqId: target?.locationSeqId || asset?.locationSeqId || null,
        statusId: statusAfter,
        reservedOrderId: reserved?.orderId || null,
        reservedOrderItemSeqId: reserved?.orderItemSeqId || null,
        varianceReasonEnumId: dispositionEnumId === "QdScrap" ? text(p.varianceReasonEnumId) || "InVrScrap" : null,
        reason: text(p.reason),
        disposedDate: now(),
        disposedByUserId: ec.user.userId
    })
    if (held && dispositionEnumId === "QdScrap") {
        // the scrap itself: P6's guarded scrap#Asset, which admits QUALITY_DISPOSE for the result asset of this disposition
        const scrapped = call("mantle.shipment.WarehouseTaskServices.scrap#Asset", {
            operationKey: String(p.operationKey) + "/scrap",
            assetId: resultAssetId,
            quantity,
            varianceReasonEnumId: text(p.varianceReasonEnumId) || "InVrScrap",
            comments: "Inspection " + inspection.qualityInspectionId + (blank(p.reason) ? "" : ": " + p.reason),
            qualityInspectionId: inspection.qualityInspectionId
        }).result
        physicalInventoryId = scrapped?.physicalInventoryId || null
        call("update#" + DISPOSITION, {
            qualityInspectionId: inspection.qualityInspectionId,
            dispositionSeqId,
            physicalInventoryId
        })
    }
    const disposed = dec(inspection.disposedQuantity).add(quantity)
    const heldAfter = endingDispositions.includes(dispositionEnumId)
        ? dec(inspection.heldQuantity).subtract(quantity)
        : dec(inspection.heldQuantity)
    const complete = disposed.compare(dec(inspection.quantity)) >= 0
    call("update#" + INSPECTION, {
        qualityInspectionId: inspection.qualityInspectionId,
        disposedQuantity: disposed,
        heldQuantity: heldAfter.compare(0) > 0 ? heldAfter : toDecimal(0),
        statusId: complete ? "QiDisposed" : inspection.statusId
    })
    if (inspection.assetReceiptId || inspection.orderId)
        call("mantle.account.InvoiceMatchServices.queue#MatchReevaluation", {
            assetReceiptId: inspection.assetReceiptId || null,
            orderId: inspection.orderId || null,
            orderItemSeqId: inspection.orderItemSeqId || null,
            staleReason: "Inspection " + inspection.qualityInspectionId + " disposition " + dispositionNames[dispositionEnumId]
        })
    notifyDecision(inspection, dispositionNames[dispositionEnumId].toLowerCase() + " " + textOf(quantity), null)
    return {
        resultCode: "DISPOSED",
        qualityInspectionId: inspection.qualityInspectionId,
        dispositionSeqId,
        dispositionEnumId,
        quantity: textOf(quantity),
        assetId: asset?.assetId || null,
        resultAssetId,
        statusId: statusAfter,
        locationSeqId: target?.locationSeqId || asset?.locationSeqId || null,
        reservedOrderId: reserved?.orderId || null,
        reservedOrderItemSeqId: reserved?.orderItemSeqId || null,
        physicalInventoryId,
        heldQuantity: textOf(heldAfter.compare(0) > 0 ? heldAfter : 0),
        inspectionStatusId: complete ? "QiDisposed" : inspection.statusId
    }
}
// scrap#Asset's admission of a quality disposition: the asset is the result of a scrap disposition of the inspection that has
// not been scrapped yet (only dispose#Inspection, which checked QUALITY_DISPOSE and the inspection, writes that row).
function scrapDisposition(qualityInspectionId, assetId) {
    return rows(DISPOSITION, {qualityInspectionId, resultAssetId: assetId, dispositionEnumId: "QdScrap"}).some(
        row => !row.physicalInventoryId
    )
}

// ===== reads =====
// get#Inspection: one inspection of the user's organizations (narrowed to facilityIds when given): its header with names,
// its template's items as of its creation with their readings, the readings, dispositions, what is left to dispose, the
// history (audit-logged changes, readings, dispositions) and what the user may do now.
function getInspection(p) {
    const userScope = scope()
    const inspection = inspectionOf(userScope, p.qualityInspectionId, false, p.facilityIds)
    const id = inspection.qualityInspectionId
    const items = itemsAsOf(inspection.inspectionTemplateId, inspection.templateAsOfDate)
    const readings = rows(READING, {qualityInspectionId: id}).sort(
        (a, b) => Number(a.sampleNumber ?? 0) - Number(b.sampleNumber ?? 0)
    )
    const left = remaining(inspection)
    const enums = enumNames([
        inspection.inspectionContextEnumId,
        inspection.sourceTypeEnumId,
        inspection.resultEnumId,
        ...items.map(item => item.readingTypeEnumId),
        ...left.dispositions.map(row => row.dispositionEnumId)
    ])
    const users = userNames([
        inspection.createdByUserId,
        inspection.submittedByUserId,
        inspection.verifiedByUserId,
        ...readings.map(row => row.readByUserId),
        ...left.dispositions.map(row => row.disposedByUserId)
    ])
    const product = inspection.productId ? one("mantle.product.Product", {productId: inspection.productId}) : null
    const lot = inspection.lotId ? one("mantle.product.asset.Lot", {lotId: inspection.lotId}) : null
    const asset = inspection.assetId ? one(ASSET, {assetId: inspection.assetId}) : null
    const facility = one(FACILITY, {facilityId: inspection.facilityId})
    const template = inspection.inspectionTemplateId
        ? one(TEMPLATE, {inspectionTemplateId: inspection.inspectionTemplateId})
        : null
    const parties = lib.partyNames([inspection.inspectorPartyId, inspection.organizationPartyId])
    const readingsByItem = {}
    for (const reading of readings) (readingsByItem[reading.inspectionTemplateItemId] ||= []).push(reading)
    const readingText = (item, reading) =>
        item.readingTypeEnumId === "QrtNumeric"
            ? textOf(reading.numericValue)
            : item.readingTypeEnumId === "QrtPassFail"
              ? reading.passIndicator === "Y"
                  ? "Pass"
                  : "Fail"
              : reading.textValue || ""
    const itemRows = items.map(item => {
        const own = readingsByItem[item.inspectionTemplateItemId] || []
        return Object.assign(itemRow(item, enums), {
            readingCount: own.length,
            failCount: own.filter(row => row.passIndicator === "N").length,
            readingsText: own
                .map(row => "#" + row.sampleNumber + " " + readingText(item, row) + (row.passIndicator === "N" ? " (fail)" : ""))
                .join(", "),
            missing: item.mandatory !== "N" && !own.length
        })
    })
    const itemById = Object.fromEntries(items.map(item => [item.inspectionTemplateItemId, item]))
    const statusName = statusNames([inspection.statusId])[inspection.statusId] || inspection.statusId
    const dispositionRows = left.dispositions.map(row =>
        Object.assign(lib.display(row), {
            dispositionText: enums[row.dispositionEnumId] || row.dispositionEnumId,
            quantity: textOf(row.quantity),
            disposedByName: users[row.disposedByUserId] || row.disposedByUserId || "",
            reservedText: row.reservedOrderId ? "Reserved to " + row.reservedOrderId + ":" + row.reservedOrderItemSeqId : ""
        })
    )
    // the history: the inspection's audit-logged changes, each reading saved and each disposition, newest first
    const audit = Array.from(
        find("moqui.entity.EntityAuditLog", {changedEntityName: INSPECTION, pkPrimaryValue: id})
            .orderBy("-changedDate")
            .limit(100)
            .list()
    )
    const auditUsers = userNames(audit.map(row => row.changedByUserId))
    const history = [
        ...audit.map(row => ({
            at: ms(row.changedDate),
            whenText: dateText(row.changedDate),
            who: auditUsers[row.changedByUserId] || row.changedByUserId || "",
            action: "Changed " + row.changedFieldName,
            detail: (row.oldValueText || "—") + " → " + (row.newValueText || "—")
        })),
        ...readings.map(row => ({
            at: ms(row.readDate),
            whenText: dateText(row.readDate),
            who: users[row.readByUserId] || row.readByUserId || "",
            action: "Reading",
            detail:
                (itemById[row.inspectionTemplateItemId]?.characteristicName || row.inspectionTemplateItemId) +
                " #" +
                row.sampleNumber +
                ": " +
                readingText(itemById[row.inspectionTemplateItemId] || {}, row)
        })),
        ...dispositionRows.map(row => ({
            at: ms(row.disposedDate),
            whenText: row.disposedDateText,
            who: row.disposedByName,
            action: row.dispositionText,
            detail:
                row.quantity + (row.resultAssetId ? " in asset " + row.resultAssetId : "") + (row.reason ? ": " + row.reason : "")
        }))
    ].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    const header = Object.assign(lib.display(inspection), {
        statusText: statusName,
        contextText: enums[inspection.inspectionContextEnumId] || "",
        sourceText: sourceText(inspection, enums),
        resultText: inspection.resultEnumId ? enums[inspection.resultEnumId] || inspection.resultEnumId : "",
        productName: product?.productName || inspection.productId || "",
        lotNumber: lot?.lotNumber || inspection.lotId || "",
        facilityName: facility?.facilityName || inspection.facilityId,
        organizationName: parties[inspection.organizationPartyId] || inspection.organizationPartyId,
        inspectorName: inspection.inspectorPartyId ? parties[inspection.inspectorPartyId] || inspection.inspectorPartyId : "",
        templateName: template?.templateName || "",
        quantity: textOf(inspection.quantity),
        heldQuantity: textOf(inspection.heldQuantity),
        disposedQuantity: textOf(inspection.disposedQuantity),
        sampleSize: textOf(inspection.sampleSize),
        quantityAccepted: textOf(inspection.quantityAccepted),
        quantityRejected: textOf(inspection.quantityRejected),
        createdByName: users[inspection.createdByUserId] || "",
        submittedByName: users[inspection.submittedByUserId] || "",
        verifiedByName: users[inspection.verifiedByUserId] || "",
        assetStatusId: asset?.statusId || null,
        assetLocationSeqId: asset?.locationSeqId || null,
        assetOnHand: asset ? textOf(asset.quantityOnHandTotal) : null,
        overdue: !!inspection.dueDate && openStatuses.includes(inspection.statusId) && ms(inspection.dueDate) < ms(now())
    })
    const missing = itemRows.filter(row => row.missing).map(row => row.characteristicName)
    return {
        inspection: header,
        items: itemRows,
        readings: readings.map(row =>
            Object.assign(lib.display(row), {
                characteristicName: itemById[row.inspectionTemplateItemId]?.characteristicName || "",
                valueText: readingText(itemById[row.inspectionTemplateItemId] || {}, row),
                readByName: users[row.readByUserId] || ""
            })
        ),
        dispositions: dispositionRows,
        history,
        acceptedLeft: textOf(left.accepted),
        rejectedLeft: textOf(left.rejected),
        missingReadings: missing,
        capabilities: {
            canRead: true,
            canSaveReadings: access.has("QUALITY_INSPECT") && inspection.statusId === "QiDraft" && !!items.length,
            canSubmit: access.has("QUALITY_INSPECT") && inspection.statusId === "QiDraft",
            canVerify:
                access.has("QUALITY_VERIFY") &&
                inspection.statusId === "QiSubmitted" &&
                inspection.submittedByUserId !== ec.user.userId,
            canDispose: access.has("QUALITY_DISPOSE") && inspection.statusId === "QiVerified",
            canAssign:
                ["QUALITY_INSPECT", "QUALITY_VERIFY", "QUALITY_DISPOSE"].some(access.has) &&
                openStatuses.includes(inspection.statusId)
        }
    }
}
function sourceText(inspection, enums) {
    const kind = enums[inspection.sourceTypeEnumId] || ""
    const ref = inspection.shipmentId
        ? "shipment " + inspection.shipmentId
        : inspection.returnId
          ? "return " + inspection.returnId
          : inspection.workEffortId
            ? "run " + inspection.workEffortId
            : inspection.assetId
              ? "asset " + inspection.assetId
              : ""
    return [kind, ref].filter(Boolean).join(", ")
}

// find#Inspections: the inspections of the user's organizations, in facilityIds when given, by status (or open ones),
// product, lot, inspector, source, shipment and due date, a page at a time, the nearest due first.
function findInspections(p) {
    const userScope = scope()
    const factory = ec.entity.conditionFactory
    let query = find(INSPECTION).orderBy("dueDate").orderBy("-createdDate")
    if (userScope.organizationPartyIds) {
        const ownFacilities = Array.from(
            find(FACILITY).condition("ownerPartyId", "in", userScope.organizationPartyIds).selectField("facilityId").list()
        ).map(row => row.facilityId)
        query = query.condition(
            factory.makeCondition(
                [
                    factory.makeCondition("organizationPartyId", "in", userScope.organizationPartyIds),
                    factory.makeCondition("facilityId", "in", ownFacilities.length ? ownFacilities : ["_NA_"])
                ],
                "or"
            )
        )
    }
    if (p.facilityIds != null) {
        const ids = Array.from(p.facilityIds)
        query = query.condition("facilityId", "in", ids.length ? ids : ["_NA_"])
    }
    if (!blank(p.statusId)) query = query.condition("statusId", p.statusId)
    else if (truthy(p.openOnly)) query = query.condition("statusId", "in", openStatuses)
    for (const field of [
        "productId",
        "lotId",
        "inspectorPartyId",
        "sourceTypeEnumId",
        "shipmentId",
        "qualityInspectionId",
        "assetReceiptId"
    ])
        if (!blank(p[field])) query = query.condition(field, p[field])
    if (p.dueBefore) query = query.condition("dueDate", "less", p.dueBefore)
    const found = lib.page(query, p, "inspections", query.count(), {noLimitCap: 2000})
    const list = found.rows
    const statuses = statusNames(list.map(row => row.statusId))
    const enums = enumNames(list.flatMap(row => [row.resultEnumId, row.sourceTypeEnumId]))
    const products = names(
        "mantle.product.Product",
        "productId",
        "productName",
        list.map(row => row.productId)
    )
    const lots = names(
        "mantle.product.asset.Lot",
        "lotId",
        "lotNumber",
        list.map(row => row.lotId)
    )
    const facilities = names(
        FACILITY,
        "facilityId",
        "facilityName",
        list.map(row => row.facilityId)
    )
    const parties = lib.partyNames(list.map(row => row.inspectorPartyId))
    found.inspections = list.map(row =>
        Object.assign(lib.display(row), {
            statusText: statuses[row.statusId] || row.statusId,
            resultText: row.resultEnumId ? enums[row.resultEnumId] || row.resultEnumId : "",
            sourceText: sourceText(row, enums),
            productName: products[row.productId] || row.productId || "",
            lotNumber: row.lotId ? lots[row.lotId] || row.lotId : "",
            facilityName: facilities[row.facilityId] || row.facilityId,
            inspectorName: row.inspectorPartyId ? parties[row.inspectorPartyId] || row.inspectorPartyId : "",
            quantity: textOf(row.quantity),
            heldQuantity: textOf(row.heldQuantity),
            sampleSize: textOf(row.sampleSize),
            overdue: !!row.dueDate && openStatuses.includes(row.statusId) && ms(row.dueDate) < ms(now())
        })
    )
    delete found.rows
    return found
}

// get#SourceInspectionStatus: each receipt of an order line, a shipment or one receipt, with its accepted and dock-rejected
// quantity, the held quantity (its inspections' heldQuantity; a receipt with no inspection whose stock is quarantined is
// held whole, as before CX-QUALITY), match-eligible (accepted less held) and what its inspections rejected (scrapped or
// returned to the supplier), and the totals. Bill matching leaves held quantity out; planning shows it pending release.
function sourceStatus(p) {
    const conditions = !blank(p.assetReceiptId)
        ? {assetReceiptId: p.assetReceiptId}
        : !blank(p.orderId)
          ? {orderId: p.orderId, orderItemSeqId: p.orderItemSeqId}
          : !blank(p.shipmentId)
            ? {shipmentId: p.shipmentId}
            : null
    if (!conditions) denied("SOURCE_REQUIRED", "Give a receipt, an order line or a shipment")
    const receipts = rows(RECEIPT, conditions)
    const receiptIds = receipts.map(row => row.assetReceiptId)
    const inspections = receiptIds.length
        ? Array.from(
              find(INSPECTION)
                  .condition("assetReceiptId", "in", receiptIds)
                  .condition("statusId", "not-equals", "QiCancelled")
                  .list()
          )
        : []
    const inspectionIds = inspections.map(row => row.qualityInspectionId)
    const dispositions = inspectionIds.length
        ? Array.from(
              find(DISPOSITION)
                  .condition("qualityInspectionId", "in", inspectionIds)
                  .condition("dispositionEnumId", "in", ["QdScrap", "QdReturnSupplier"])
                  .list()
          )
        : []
    const assetIds = unique(receipts.map(row => row.assetId))
    const quarantined = new Set(
        assetIds.length
            ? Array.from(find(ASSET).condition("assetId", "in", assetIds).condition("statusId", "AstQuarantine").list()).map(
                  row => row.assetId
              )
            : []
    )
    const zero = toDecimal(0)
    const receiptRows = receipts.map(receipt => {
        const own = inspections.filter(row => row.assetReceiptId === receipt.assetReceiptId)
        const accepted = dec(receipt.quantityAccepted)
        const held = own.length
            ? own.reduce((sum, row) => sum.add(dec(row.heldQuantity)), zero)
            : quarantined.has(receipt.assetId)
              ? accepted
              : zero
        const ownIds = new Set(own.map(row => row.qualityInspectionId))
        const inspectionRejected = dispositions
            .filter(row => ownIds.has(row.qualityInspectionId))
            .reduce((sum, row) => sum.add(dec(row.quantity)), zero)
        const eligible = accepted.subtract(held)
        return {
            assetReceiptId: receipt.assetReceiptId,
            shipmentId: receipt.shipmentId,
            orderId: receipt.orderId,
            orderItemSeqId: receipt.orderItemSeqId,
            assetId: receipt.assetId,
            acceptedQuantity: accepted,
            rejectedQuantity: dec(receipt.quantityRejected),
            heldQuantity: held,
            matchEligibleQuantity: eligible.compare(0) > 0 ? eligible : zero,
            inspectionRejectedQuantity: inspectionRejected,
            openInspectionIds: own.filter(row => openStatuses.includes(row.statusId)).map(row => row.qualityInspectionId)
        }
    })
    const total = field => receiptRows.reduce((sum, row) => sum.add(row[field]), zero)
    return {
        receiptRows,
        acceptedQuantity: total("acceptedQuantity"),
        rejectedQuantity: total("rejectedQuantity"),
        heldQuantity: total("heldQuantity"),
        matchEligibleQuantity: total("matchEligibleQuantity"),
        inspectionRejectedQuantity: total("inspectionRejectedQuantity")
    }
}

// create#InspectionContent's check: an inspection of the user's organizations, for a user who inspects, verifies or
// disposes.
function contentAccess(p) {
    requireAny(["QUALITY_INSPECT", "QUALITY_VERIFY", "QUALITY_DISPOSE"])
    return inspectionOf(scope(), p.qualityInspectionId).qualityInspectionId
}

const operations = {
    storeTemplate,
    getTemplate,
    findTemplates,
    assignInspection,
    saveReading,
    submitInspection,
    verifyInspection,
    getInspection,
    findInspections,
    sourceStatus,
    contentAccess,
    create: p => {
        requireAny(["QUALITY_INSPECT"])
        return createInspection(scope(), p)
    }
}
;({
    // for the receipt guard (Receiving.js), dispose#Inspection and scrap#Asset
    receiptNeedsInspection,
    receiptInspections,
    applicableTemplate,
    itemsAsOf,
    lockInspection,
    dispositionPlan,
    disposeStock,
    scrapDisposition,
    execute(op, parameters) {
        if (!operations[op]) throw new Error("Unknown quality operation " + op)
        return operations[op](parameters)
    }
})
