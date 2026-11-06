// Store administration (impl-commerce P2, COM-STORE; design-commerce §3 Stores, StoreDetail, StoreGroups): the stores a user
// works, a store's reads and its guarded saves, the dated child rows (facilities, staff, emails, order checks, search and
// content bindings, typed settings), store groups with their members and parties, the clone guard over clone#ProductStore
// and the readiness findings. Each operation checks its permission (COMMERCE_VIEW to read, COMMERCE_STORE_EDIT to change)
// and the store's organization itself, and a user with a current StoreStaff ProductStoreParty row is limited to those stores
// (impl-commerce §4); reads and writes below the checks run without artifact authorization. Disabled artifact authorization
// widens nothing. Refusals carry reason codes (EntityLib.denied).
//
// Later phases extend the tables below rather than the functions: staffRoles, settingTypes (the checkout and recovery
// types, P6 and P10), cloneLeftOutSettingTypes, documentTypes and readinessChecks (catalog P3, theme Shop P2, payments,
// delivery rates and support P6, the subscription address P12).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const {find, one, rows, denied, call, ms, active, dateText, partyNames, access} = lib
const S = "mantle.product.store."
const STORE = S + "ProductStore"
const choiceLimit = 30

// ===== tables =====
// The roles a store's staff row may have (never a customer's CustomerBillTo or another party role).
const staffRoles = {StoreStaff: "Store staff"}
// ProductStore's policy fields, each audit-logged (entity/ProductStoreEntities.xml), with their History labels; the other
// fields store#Store writes. The reservation fields are Warehouse's (update#StoreReservation) and never written here.
const policyFields = {
    organizationPartyId: "Organization",
    defaultCurrencyUomId: "Currency",
    defaultLocale: "Locale",
    defaultSalesChannelEnumId: "Sales channel",
    autoApproveDelay: "Approval delay",
    taxGatewayConfigId: "Tax gateway"
}
const indicatorFields = ["requireCustomerRole", "defaultDisablePromotions", "defaultDisableShippingCalc", "defaultDisableTaxCalc"]
const storeFields = ["storeName", ...Object.keys(policyFields), ...indicatorFields, "storeDomain"]
const historyLabels = Object.assign({storeName: "Name"}, policyFields, {
    inventoryFacilityId: "Inventory facility",
    reservationOrderEnumId: "Reservation order",
    reservationAutoEnumId: "Reservation timing",
    requireInventory: "Require inventory",
    carrierPartyId: "Ship option carrier",
    shipmentMethodEnumId: "Ship option method",
    paymentInstrumentEnumId: "Payment instrument",
    paymentGatewayConfigId: "Payment gateway"
})
// The entities whose audit rows are a store's History (their first key field is the store).
const historyEntities = [STORE, S + "ProductStoreShipOption", S + "ProductStorePaymentGateway"]
// The setting types staff may set, each with its kind of value; a type not here (template and content locations, URL
// templates, the REST location) is shown and never written, so staff cannot choose a resource location (design §3).
const settingTypes = {
    PsstShipLabelName: "text",
    PsstShipLabelCompany: "text",
    PsstShipRestrictCarriers: "boolean",
    PsstShipLabelMarkup: "percent",
    PsstShipOrderMarkup: "percent",
    PsstGetReturnLabels: "boolean",
    PsstOrdApproveNewCust: "boolean",
    PsstOrdApproveAddrNotValid: "boolean",
    PsstOrdApproveAddrMissing: "boolean",
    PsstOrdApproveLargeOrder: "number",
    PsstOrdApproveLargeWebOrder: "number",
    PsstOrdApproveStdDevTotal: "number",
    PsstOrdApproveStdDevProdQty: "number",
    PsstOrdApproveInventoryNotAvail: "boolean",
    PsstOrdApprovePercAvailInv: "percent",
    PsstOrdApproveSimilar: "boolean",
    PsstOrdApprovePriceMinMax: "boolean",
    PsstOrdApproveBillShipAddrDiff: "boolean",
    PsstOrdApprovePayMethNameDiff: "boolean",
    PsstOrdApproveContactBlacklist: "boolean"
}
// Setting types a clone never copies (a recovery schedule, P10).
const cloneLeftOutSettingTypes = []
// The search documents a store may bind, by type: a DataDocument with a search index over the type's records.
const documentTypes = {
    PsdtProduct: "mantle.product.Product",
    PsdtCategory: "mantle.product.category.ProductCategory",
    PsdtBlog: "moqui.resource.wiki.WikiPage",
    PsdtContent: "moqui.resource.wiki.WikiPage"
}
const groupOwnerRole = "OrgInternal"
const staffRelationships = ["PrtAgent", "PrtEmployee", "PrtMember"]

// ===== scope =====
// The organizations whose stores the user works (null for every one: a system administrator), the stores a store-limited
// staff member is limited to (null when none), and whether they may change stores. COMMERCE_VIEW reads; COMMERCE_STORE_EDIT
// with it changes. A Projects client contact and a user without the read get nothing.
function scope(need = "view") {
    if (!ec.user.userId || !access.has("COMMERCE_VIEW")) denied("PERMISSION_DENIED", "COMMERCE_VIEW is required")
    const canEdit = access.has("COMMERCE_STORE_EDIT")
    if (need === "edit" && !canEdit) denied("PERMISSION_DENIED", "COMMERCE_STORE_EDIT is required")
    const organizations = facilityScope.scope()
    const systemAdmin = organizations.systemAdmin
    // FACILITY_ALL_ORGANIZATIONS is Warehouse's: a store is worked in the user's own organizations
    const organizationPartyIds = systemAdmin ? null : organizations.organizationPartyIds || organizations.memberPartyIds
    const partyId = ec.user.userAccount?.partyId || null
    let storeLimit = null
    if (!systemAdmin && partyId) {
        const ids = rows(S + "ProductStoreParty", {partyId, roleTypeId: "StoreStaff"})
            .filter(row => active(row))
            .map(row => row.productStoreId)
        if (ids.length) storeLimit = Array.from(new Set(ids))
    }
    return {organizationPartyIds, storeLimit, systemAdmin, canEdit, partyId}
}
const owns = (s, partyId) => !!partyId && (!s.organizationPartyIds || s.organizationPartyIds.includes(partyId))
const isInternal = partyId => !!partyId && !!one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
// The stores the user works, in the query.
function storeQuery(s) {
    let query = find(STORE)
    if (s.organizationPartyIds) query = query.condition("organizationPartyId", "in", s.organizationPartyIds)
    if (s.storeLimit) query = query.condition("productStoreId", "in", s.storeLimit)
    return query
}
// A store the user works; a missing one and one outside the scope are refused alike.
function storeOf(s, productStoreId, forUpdate = false) {
    const store = productStoreId ? find(STORE, {productStoreId}).forUpdate(forUpdate).one() : null
    if (!store || !owns(s, store.organizationPartyId) || (s.storeLimit && !s.storeLimit.includes(productStoreId)))
        denied("RECORD_UNAVAILABLE", "Store " + (productStoreId || "") + " is not available")
    return store
}
// An internal organization of the user's.
function organizationOf(s, partyId) {
    if (!partyId || !isInternal(partyId) || !owns(s, partyId))
        denied("ORGANIZATION_UNAVAILABLE", "Organization " + (partyId || "") + " is not available")
    return partyId
}

// ===== values =====
const text = value => (value == null ? "" : String(value).trim())
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const uomText = uomId => (uomId ? one("moqui.basic.Uom", {uomId})?.description || uomId : "")
const likeText = term => "%" + String(term).replace(/[\\%_]/g, character => "\\" + character) + "%"
function checkEnum(enumId, enumTypeId, label) {
    if (enumId && one("moqui.basic.Enumeration", {enumId})?.enumTypeId !== enumTypeId)
        denied("VALUE_INVALID", "Choose a valid " + label)
}
// A date parameter as milliseconds, or the fallback; refused when not a date.
function dateOf(value, fallback, label) {
    if (value == null || value === "") return fallback
    const at = ms(value)
    if (!Number.isFinite(at)) denied("VALUE_INVALID", "Choose a valid " + label)
    return at
}
function reason(p, required) {
    const why = text(p.changeReason)
    if (!why && required) denied("REASON_REQUIRED", "Give a reason for the change")
    return why || null
}
function stale(p, row) {
    if (p.expectedLastUpdatedStamp && ms(p.expectedLastUpdatedStamp) !== ms(row.lastUpdatedStamp))
        denied("STALE_REVISION", "Changed by someone else since it was read (now " + dateText(row.lastUpdatedStamp) + "); reload")
}
const nowMs = () => ms(ec.user.nowTimestamp)
function rowDates(row) {
    const from = ms(row.fromDate)
    const thru = ms(row.thruDate)
    const now = nowMs()
    return {
        fromDateText: dateText(row.fromDate),
        thruDateText: dateText(row.thruDate),
        current: (from ?? -Infinity) <= now && (thru ?? Infinity) > now,
        future: from != null && from > now,
        ended: thru != null && thru <= now
    }
}
const stateOf = dates => (dates.current ? "Current" : dates.future ? "Starts later" : "Ended")

// A dated child row saved from a date (effective dating, impl-commerce §2): ending, the row in effect at that time ends
// there; otherwise the open row of the same key ends at the new row's start, a row starting on the same instant is changed in
// place, and a row starting later is refused (end or change it first).
function saveDated(entity, key, values, p) {
    const now = nowMs()
    const existing = rows(entity, key)
    if (p.end === true || p.end === "true" || p.end === "Y") {
        // a row that has not started is withdrawn: it was never in effect
        const startsLater =
            p.fromDate != null && p.fromDate !== "" ? existing.find(row => ms(row.fromDate) === ms(p.fromDate)) : null
        if (startsLater && ms(startsLater.fromDate) > now) {
            call("delete#" + entity, Object.assign({}, key, {fromDate: startsLater.fromDate}))
            return {fromDate: startsLater.fromDate, thruDate: null, ended: true}
        }
        const at = dateOf(p.thruDate, now, "end date")
        const open = existing.filter(row => (ms(row.thruDate) ?? Infinity) > at && (ms(row.fromDate) ?? -Infinity) <= at)
        if (!open.length) denied("RECORD_UNAVAILABLE", "Nothing of that is in effect to end")
        for (const row of open) call("update#" + entity, Object.assign({}, key, {fromDate: row.fromDate, thruDate: at}))
        return {fromDate: open[0].fromDate, thruDate: at, ended: true}
    }
    const fromDate = dateOf(p.fromDate, now, "start date")
    const thruDate = dateOf(p.thruDate, null, "end date")
    if (thruDate != null && thruDate <= fromDate) denied("VALUE_INVALID", "The end comes after the start")
    if (existing.some(row => ms(row.fromDate) > fromDate))
        denied("DATED_OVERLAP", "A row of it starts later; end or change that one first")
    const same = existing.find(row => ms(row.fromDate) === fromDate)
    for (const row of existing)
        if (row !== same && ms(row.fromDate) < fromDate && (ms(row.thruDate) ?? Infinity) > fromDate)
            call("update#" + entity, Object.assign({}, key, {fromDate: row.fromDate, thruDate: fromDate}))
    const data = Object.assign({}, key, values, {thruDate})
    if (same) call("update#" + entity, Object.assign(data, {fromDate: same.fromDate}))
    else call("create#" + entity, Object.assign(data, {fromDate}))
    return {fromDate, thruDate, ended: false}
}

// ===== stores =====
// The Shop mounts naming each store (PublicSiteApp app shop, its target the store; Shop P1 makes them), by store.
function shopMounts(storeIds) {
    if (!storeIds.length) return {}
    const mounts = Array.from(
        find("mantle.public.PublicSiteApp").condition("app", "shop").condition("targetId", "in", storeIds).list()
    )
    const byStore = {}
    for (const mount of mounts) (byStore[mount.targetId] = byStore[mount.targetId] || []).push(mount)
    return byStore
}
function findStores(p) {
    const s = scope()
    const factory = ec.entity.conditionFactory
    const memberIds = p.productStoreGroupId
        ? rows(S + "ProductStoreGroupMember", {productStoreGroupId: p.productStoreGroupId})
              .filter(row => active(row))
              .map(row => row.productStoreId)
        : null
    // a find is used once: one for the count, one for the page
    const build = () => {
        let query = storeQuery(s)
        const term = text(p.term)
        if (term)
            query = query.condition(
                factory.makeCondition(
                    ["productStoreId", "storeName"].map(field =>
                        factory.makeCondition(field, "like", likeText(term)).ignoreCase()
                    ),
                    "or"
                )
            )
        if (p.organizationPartyId) query = query.condition("organizationPartyId", p.organizationPartyId)
        if (p.salesChannelEnumId) query = query.condition("defaultSalesChannelEnumId", p.salesChannelEnumId)
        if (memberIds) query = query.condition("productStoreId", "in", memberIds)
        return query
    }
    const count = build().count()
    const found = lib.page(build().orderBy("storeName,productStoreId"), p, "stores", count)
    const ids = found.rows.map(row => row.productStoreId)
    const names = partyNames(found.rows.map(row => row.organizationPartyId))
    const mounts = shopMounts(ids)
    const stores = found.rows.map(row => {
        const sites = mounts[row.productStoreId] || []
        return {
            productStoreId: row.productStoreId,
            storeName: row.storeName || row.productStoreId,
            organizationPartyId: row.organizationPartyId,
            organizationName: names[row.organizationPartyId] || row.organizationPartyId || "",
            defaultSalesChannelEnumId: row.defaultSalesChannelEnumId,
            channelText: enumText(row.defaultSalesChannelEnumId),
            defaultCurrencyUomId: row.defaultCurrencyUomId,
            defaultLocale: row.defaultLocale,
            localeCurrencyText: [row.defaultLocale, row.defaultCurrencyUomId].filter(Boolean).join(" · "),
            siteCount: sites.length,
            siteText: sites.length ? sites.map(mount => mount.siteId).join(", ") : "No site",
            siteColor: sites.some(mount => mount.enabled === "Y") ? "positive" : "grey-7"
        }
    })
    const result = {stores, storesCount: count}
    for (const key of ["PageIndex", "PageSize", "PageMaxIndex", "PageRangeLow", "PageRangeHigh"])
        result["stores" + key] = found["stores" + key]
    return result
}

function partyLabel(names, partyId) {
    return partyId ? names[partyId] || partyId : ""
}
// The sections get#Store reads on request (each tab names its own).
const sections = {
    facilities(store) {
        const found = rows(S + "ProductStoreFacility", {productStoreId: store.productStoreId}).sort(
            (a, b) => (a.sequenceNum ?? 0) - (b.sequenceNum ?? 0) || ms(b.fromDate) - ms(a.fromDate)
        )
        const facilityIds = found.map(row => row.facilityId)
        const facilities = facilityIds.length
            ? Object.fromEntries(
                  Array.from(find("mantle.facility.Facility").condition("facilityId", "in", facilityIds).list()).map(row => [
                      row.facilityId,
                      row.facilityName || row.facilityId
                  ])
              )
            : {}
        return found.map(row => {
            const dates = rowDates(row)
            return Object.assign(
                {
                    facilityId: row.facilityId,
                    facilityName: facilities[row.facilityId] || row.facilityId,
                    sequenceNum: row.sequenceNum,
                    fromDate: ms(row.fromDate),
                    stateText: stateOf(dates)
                },
                dates
            )
        })
    },
    staff(store) {
        const found = rows(S + "ProductStoreParty", {productStoreId: store.productStoreId})
        const names = partyNames(found.map(row => row.partyId))
        // only staff roles are shown with names; another role's row (a customer's bill-to) is counted, never listed
        const staff = found.filter(row => Object.hasOwn(staffRoles, row.roleTypeId))
        return staff
            .sort((a, b) => ms(b.fromDate) - ms(a.fromDate))
            .map(row => {
                const dates = rowDates(row)
                return Object.assign(
                    {
                        partyId: row.partyId,
                        partyName: partyLabel(names, row.partyId),
                        roleTypeId: row.roleTypeId,
                        roleText: staffRoles[row.roleTypeId],
                        fromDate: ms(row.fromDate),
                        stateText: stateOf(dates)
                    },
                    dates
                )
            })
    },
    emails(store) {
        const found = rows(S + "ProductStoreEmail", {productStoreId: store.productStoreId}).sort(
            (a, b) => enumText(a.emailTypeEnumId).localeCompare(enumText(b.emailTypeEnumId)) || ms(b.fromDate) - ms(a.fromDate)
        )
        return found.map(row => {
            const dates = rowDates(row)
            const template = row.emailTemplateId
                ? one("moqui.basic.email.EmailTemplate", {emailTemplateId: row.emailTemplateId})
                : null
            return Object.assign(
                {
                    emailTypeEnumId: row.emailTypeEnumId,
                    emailTypeText: enumText(row.emailTypeEnumId),
                    emailTemplateId: row.emailTemplateId,
                    templateText: template?.description || row.emailTemplateId || "",
                    headerImagePath: row.headerImagePath,
                    detailLinkPath: row.detailLinkPath,
                    webOrderBcc: row.webOrderBcc,
                    fromDate: ms(row.fromDate),
                    stateText: stateOf(dates)
                },
                dates
            )
        })
    },
    approvals(store) {
        const found = rows(S + "ProductStoreApprove", {productStoreId: store.productStoreId}).sort(
            (a, b) => (a.sequenceNum ?? 0) - (b.sequenceNum ?? 0)
        )
        return found.map(row => {
            const dates = rowDates(row)
            const register = one("moqui.service.ServiceRegister", {serviceRegisterId: row.serviceRegisterId})
            const parameters = rows(S + "ProductStoreApproveParam", {storeApproveId: row.storeApproveId})
            return Object.assign(
                {
                    storeApproveId: row.storeApproveId,
                    serviceRegisterId: row.serviceRegisterId,
                    checkText: register?.description || row.serviceRegisterId,
                    sequenceNum: row.sequenceNum,
                    parametersText: parameters.map(param => param.parameterName + " = " + param.parameterValue).join(", "),
                    stateText: stateOf(dates)
                },
                dates
            )
        })
    },
    content(store) {
        const documents = rows(S + "ProductStoreDataDocument", {productStoreId: store.productStoreId}).map(row => {
            const document = row.dataDocumentId
                ? one("moqui.entity.document.DataDocument", {dataDocumentId: row.dataDocumentId})
                : null
            return {
                typeEnumId: row.typeEnumId,
                typeText: enumText(row.typeEnumId),
                dataDocumentId: row.dataDocumentId,
                documentText: document?.documentName || row.dataDocumentId || ""
            }
        })
        const spaces = rows(S + "ProductStoreWikiSpace", {productStoreId: store.productStoreId})
            .sort((a, b) => ms(b.fromDate) - ms(a.fromDate))
            .map(row => {
                const dates = rowDates(row)
                const space = row.wikiSpaceId ? one("moqui.resource.wiki.WikiSpace", {wikiSpaceId: row.wikiSpaceId}) : null
                return Object.assign(
                    {
                        storeWikiSpaceId: row.storeWikiSpaceId,
                        spaceTypeEnumId: row.spaceTypeEnumId,
                        spaceTypeText: enumText(row.spaceTypeEnumId),
                        locale: row.locale || "",
                        wikiSpaceId: row.wikiSpaceId,
                        spaceText: space?.description || row.wikiSpaceId || "",
                        stateText: stateOf(dates)
                    },
                    dates
                )
            })
        return {documents, spaces}
    },
    settings(store) {
        const found = rows(S + "ProductStoreSetting", {productStoreId: store.productStoreId}).sort(
            (a, b) =>
                enumText(a.settingTypeEnumId).localeCompare(enumText(b.settingTypeEnumId)) || ms(b.fromDate) - ms(a.fromDate)
        )
        return found.map(row => {
            const dates = rowDates(row)
            return Object.assign(
                {
                    settingTypeEnumId: row.settingTypeEnumId,
                    settingTypeText: enumText(row.settingTypeEnumId),
                    settingValue: row.settingValue,
                    kind: settingTypes[row.settingTypeEnumId] || null,
                    editable: Object.hasOwn(settingTypes, row.settingTypeEnumId),
                    fromDate: ms(row.fromDate),
                    stateText: stateOf(dates)
                },
                dates
            )
        })
    },
    history(store) {
        const found = Array.from(
            find("moqui.entity.EntityAuditLog")
                .condition("changedEntityName", "in", historyEntities)
                .condition("pkPrimaryValue", store.productStoreId)
                .orderBy("-changedDate")
                .limit(100)
                .list()
        )
        const userIds = Array.from(new Set(found.map(row => row.changedByUserId).filter(Boolean)))
        const users = userIds.length
            ? Object.fromEntries(
                  Array.from(find("moqui.security.UserAccount").condition("userId", "in", userIds).list()).map(row => [
                      row.userId,
                      row.userFullName || row.username || row.userId
                  ])
              )
            : {}
        return found.map(row => ({
            auditHistorySeqId: row.auditHistorySeqId,
            changedDateText: dateText(row.changedDate),
            fieldText: historyLabels[row.changedFieldName] || row.changedFieldName,
            oldValueText: row.oldValueText || "",
            newValueText: row.newValueText || "",
            userText: users[row.changedByUserId] || row.changedByUserId || "",
            changeReason: row.changeReason || ""
        }))
    }
}
// A store's record and, on request, its sections (facilities, staff, emails, approvals, content, settings, history).
function getStore(p) {
    const s = scope()
    const store = storeOf(s, p.productStoreId)
    const names = partyNames([store.organizationPartyId])
    const facility = store.inventoryFacilityId ? one("mantle.facility.Facility", {facilityId: store.inventoryFacilityId}) : null
    const taxGateway = store.taxGatewayConfigId
        ? one("mantle.other.tax.TaxGatewayConfig", {taxGatewayConfigId: store.taxGatewayConfigId})
        : null
    const otherParties = rows(S + "ProductStoreParty", {productStoreId: store.productStoreId}).filter(
        row => !Object.hasOwn(staffRoles, row.roleTypeId)
    ).length
    const result = {
        store: {
            productStoreId: store.productStoreId,
            storeName: store.storeName || store.productStoreId,
            organizationPartyId: store.organizationPartyId,
            organizationName: partyLabel(names, store.organizationPartyId),
            defaultCurrencyUomId: store.defaultCurrencyUomId,
            currencyText: uomText(store.defaultCurrencyUomId),
            defaultLocale: store.defaultLocale,
            defaultSalesChannelEnumId: store.defaultSalesChannelEnumId,
            channelText: enumText(store.defaultSalesChannelEnumId),
            autoApproveDelay: store.autoApproveDelay,
            taxGatewayConfigId: store.taxGatewayConfigId,
            taxGatewayText: taxGateway?.description || store.taxGatewayConfigId || "",
            requireCustomerRole: store.requireCustomerRole,
            defaultDisablePromotions: store.defaultDisablePromotions,
            defaultDisableShippingCalc: store.defaultDisableShippingCalc,
            defaultDisableTaxCalc: store.defaultDisableTaxCalc,
            storeDomain: store.storeDomain,
            // the reservation group, Warehouse's (update#StoreReservation), read only here
            inventoryFacilityId: store.inventoryFacilityId,
            inventoryFacilityText: facility?.facilityName || store.inventoryFacilityId || "",
            reservationOrderText: enumText(store.reservationOrderEnumId),
            reservationAutoText: enumText(store.reservationAutoEnumId),
            requireInventory: store.requireInventory,
            otherPartyCount: otherParties,
            lastUpdatedStamp: ms(store.lastUpdatedStamp),
            lastUpdatedText: dateText(store.lastUpdatedStamp)
        },
        canEdit: s.canEdit
    }
    for (const name of [].concat(p.include || []))
        if (Object.hasOwn(sections, name)) result[name] = sections[name](store)
        else throw new Error("Unknown store section " + name)
    return result
}

// The PASS sites and mounts naming a store (a Shop mount whose target is the store), read only: hosts and mounts are the
// site operator's (store#Mounts).
function getStoreSites(p) {
    const s = scope()
    const store = storeOf(s, p.productStoreId)
    const mounts = shopMounts([store.productStoreId])[store.productStoreId] || []
    const sites = mounts.map(mount => {
        const site = one("mantle.public.PublicSite", {siteId: mount.siteId})
        const hosts = rows("mantle.public.PublicSiteHost", {siteId: mount.siteId})
        const canonical = hosts.find(host => host.canonical === "Y")
        return {
            siteId: mount.siteId,
            siteName: site?.name || mount.siteId,
            state: site?.state || "",
            canonicalHost: canonical?.hostname || "",
            hostsText: hosts.map(host => host.hostname).join(", "),
            pathPrefix: mount.pathPrefix || "/",
            enabled: mount.enabled === "Y",
            readinessText: !canonical ? "No canonical host" : mount.enabled !== "Y" ? "Mount disabled" : "Served"
        }
    })
    return {productStoreId: store.productStoreId, sites}
}

// The organization's defaults for a new store: its base currency and document locale (find#PartyAcctgPreference), else the
// user's locale; never a fixed currency or language.
function organizationDefaults(organizationPartyId) {
    let preference = null
    try {
        preference = call("mantle.ledger.LedgerServices.find#PartyAcctgPreference", {organizationPartyId}).partyAcctgPreference
    } catch (error) {
        ec.logger.warn("Store defaults of organization " + organizationPartyId + ": " + error.message)
    }
    return {
        defaultCurrencyUomId: preference?.baseCurrencyUomId || null,
        defaultLocale: preference?.documentLocale || ec.user.locale?.toString?.() || null
    }
}
function checkStoreValues(changes) {
    if (Object.hasOwn(changes, "storeName") && !text(changes.storeName)) denied("VALUE_INVALID", "Give the store a name")
    if (changes.defaultCurrencyUomId) {
        const uom = one("moqui.basic.Uom", {uomId: changes.defaultCurrencyUomId})
        if (uom?.uomTypeEnumId !== "UT_CURRENCY_MEASURE") denied("VALUE_INVALID", "Choose a valid currency")
    }
    if (changes.defaultLocale) {
        const locales = Array.from(ec.l10n.getAvailableLocales() || []).map(row => String(row.locale))
        if (!locales.includes(String(changes.defaultLocale))) denied("VALUE_INVALID", "Choose a valid locale")
    }
    checkEnum(changes.defaultSalesChannelEnumId, "SalesChannel", "sales channel")
    if (changes.autoApproveDelay != null && changes.autoApproveDelay !== "") {
        const delay = Number(String(changes.autoApproveDelay))
        if (!Number.isInteger(delay) || delay < 0) denied("VALUE_INVALID", "The approval delay is a whole number of minutes")
        changes.autoApproveDelay = delay
    }
    if (changes.taxGatewayConfigId && !one("mantle.other.tax.TaxGatewayConfig", {taxGatewayConfigId: changes.taxGatewayConfigId}))
        denied("VALUE_INVALID", "Choose a valid tax gateway")
    for (const field of indicatorFields)
        if (changes[field] != null && changes[field] !== "" && !["Y", "N"].includes(changes[field]))
            denied("VALUE_INVALID", "Choose Yes or No for " + field)
    if (changes.storeDomain && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(changes.storeDomain))
        denied("VALUE_INVALID", "The store domain is a host name such as shop.example.com")
}
const blankToNull = value => (value === "" ? null : value)
// store#Store: a new store (no productStoreId) of one of the user's organizations, with its currency and locale from the
// organization unless given, and no site mount; or a change of a store's fields, a stale revision refused and a policy
// change needing its reason, which the audit log keeps with the user.
function storeStore(p) {
    const s = scope("edit")
    const changes = {}
    for (const field of storeFields) if (Object.hasOwn(p, field) && p[field] !== undefined) changes[field] = blankToNull(p[field])
    if (!p.productStoreId) {
        if (s.storeLimit) denied("STORE_LIMITED", "A store-limited staff member does not start stores")
        const organizationPartyId = organizationOf(s, p.organizationPartyId)
        const defaults = organizationDefaults(organizationPartyId)
        for (const [field, value] of Object.entries(defaults)) if (!changes[field]) changes[field] = value
        checkStoreValues(changes)
        if (!text(changes.storeName)) denied("VALUE_INVALID", "Give the store a name")
        let facilityId = null
        if (p.facilityId) facilityId = facilityOf(organizationPartyId, p.facilityId).facilityId
        const why = reason(p, false) || "Store started"
        const reasons = Object.fromEntries(Object.keys(policyFields).map(field => [field + "_changeReason", why]))
        ec.context.putAll(reasons)
        const created = call("create#" + STORE, Object.assign({}, changes, {organizationPartyId}, reasons))
        if (facilityId)
            call("create#" + S + "ProductStoreFacility", {
                productStoreId: created.productStoreId,
                facilityId,
                fromDate: nowMs(),
                sequenceNum: 1
            })
        return {productStoreId: created.productStoreId, created: true}
    }
    const store = storeOf(s, p.productStoreId, true)
    stale(p, store)
    checkStoreValues(changes)
    const changed = Object.keys(changes).filter(field => String(changes[field] ?? "") !== String(store[field] ?? ""))
    if (!changed.length) return {productStoreId: store.productStoreId, created: false}
    if (changed.includes("organizationPartyId")) {
        organizationOf(s, changes.organizationPartyId)
        if (find("mantle.order.OrderHeader", {productStoreId: store.productStoreId}).count())
            denied("STORE_HAS_ORDERS", "A store with orders keeps its organization")
    }
    const policyChanged = changed.filter(field => Object.hasOwn(policyFields, field))
    const why = reason(p, policyChanged.length > 0)
    const reasons = why ? Object.fromEntries(changed.map(field => [field + "_changeReason", why])) : {}
    ec.context.putAll(reasons)
    call(
        "update#" + STORE,
        Object.assign({productStoreId: store.productStoreId}, Object.fromEntries(changed.map(f => [f, changes[f]])), reasons)
    )
    return {productStoreId: store.productStoreId, created: false}
}

// ===== child rows =====
function facilityOf(organizationPartyId, facilityId) {
    const facility = facilityId ? one("mantle.facility.Facility", {facilityId}) : null
    if (!facility || facility.ownerPartyId !== organizationPartyId)
        denied("FACILITY_UNAVAILABLE", "Facility " + (facilityId || "") + " is not one of the store organization's")
    return facility
}
// A person who works for the organization (a current agent, employee or member relationship to it).
function worksFor(partyId, organizationPartyId) {
    if (!partyId || one("mantle.party.Party", {partyId})?.partyTypeEnumId !== "PtyPerson") return false
    return find("mantle.party.PartyRelationship", {fromPartyId: partyId, toPartyId: organizationPartyId})
        .condition("relationshipTypeEnumId", "in", staffRelationships)
        .list()
        .some(row => active(row))
}
function storeStoreFacility(p) {
    const s = scope("edit")
    const store = storeOf(s, p.productStoreId)
    facilityOf(store.organizationPartyId, p.facilityId)
    const sequenceNum = p.sequenceNum == null || p.sequenceNum === "" ? null : Number(String(p.sequenceNum))
    if (sequenceNum != null && !Number.isInteger(sequenceNum)) denied("VALUE_INVALID", "The priority is a whole number")
    const saved = saveDated(
        S + "ProductStoreFacility",
        {productStoreId: store.productStoreId, facilityId: p.facilityId},
        {sequenceNum},
        p
    )
    return Object.assign({productStoreId: store.productStoreId}, saved)
}
function storeStoreParty(p) {
    const s = scope("edit")
    // a staff row is the limit itself: a store-limited member who ended or dated their own (or a colleague's) row would widen
    // it to every store of the organization, and one who added a manager would limit them
    if (s.storeLimit) denied("STORE_LIMITED", "A store-limited staff member does not assign store staff")
    const store = storeOf(s, p.productStoreId)
    const roleTypeId = p.roleTypeId || "StoreStaff"
    if (!Object.hasOwn(staffRoles, roleTypeId)) denied("ROLE_NOT_STAFF", "Only a staff role is set here")
    if (!(p.end === true || p.end === "true" || p.end === "Y") && !worksFor(p.partyId, store.organizationPartyId))
        denied("PARTY_UNAVAILABLE", "Party " + (p.partyId || "") + " does not work for the store's organization")
    const saved = saveDated(
        S + "ProductStoreParty",
        {productStoreId: store.productStoreId, partyId: p.partyId, roleTypeId},
        {},
        p
    )
    return Object.assign({productStoreId: store.productStoreId}, saved)
}
const pathPattern = /^\/[A-Za-z0-9/_.~-]*$/
const emailPattern = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/
function storeStoreEmail(p) {
    const s = scope("edit")
    const store = storeOf(s, p.productStoreId)
    if (!p.emailTypeEnumId) denied("VALUE_INVALID", "Choose an email type")
    checkEnum(p.emailTypeEnumId, "ProductStoreEmailType", "email type")
    const ending = p.end === true || p.end === "true" || p.end === "Y"
    const values = {
        emailTemplateId: blankToNull(p.emailTemplateId) ?? null,
        headerImagePath: blankToNull(text(p.headerImagePath)),
        detailLinkPath: blankToNull(text(p.detailLinkPath)),
        webOrderBcc: blankToNull(text(p.webOrderBcc))
    }
    if (!ending) {
        if (!values.emailTemplateId || !one("moqui.basic.email.EmailTemplate", {emailTemplateId: values.emailTemplateId}))
            denied("VALUE_INVALID", "Choose a registered email template")
        for (const field of ["headerImagePath", "detailLinkPath"])
            if (values[field] && (!pathPattern.test(values[field]) || values[field].includes("..")))
                denied("VALUE_INVALID", "A link path is a path on the store's site, such as /order")
        if (values.webOrderBcc && !values.webOrderBcc.split(",").every(address => emailPattern.test(address.trim())))
            denied("VALUE_INVALID", "The copy addresses are email addresses separated by commas")
    }
    const saved = saveDated(
        S + "ProductStoreEmail",
        {productStoreId: store.productStoreId, emailTypeEnumId: p.emailTypeEnumId},
        values,
        p
    )
    return Object.assign({productStoreId: store.productStoreId}, saved)
}
// The parameters a registered order check takes: its ServiceRegister's configParameters, a comma-separated list of names,
// each optionally typed (name:number, name:boolean; text otherwise). A check with none takes no parameters.
function checkParameters(register) {
    return Object.fromEntries(
        String(register.configParameters || "")
            .split(",")
            .map(entry => entry.trim())
            .filter(Boolean)
            .map(entry => {
                const [name, kind] = entry.split(":").map(part => part.trim())
                return [name, kind || "text"]
            })
    )
}
function settingValue(kind, value, label) {
    const raw = text(value)
    if (kind === "boolean") {
        if (!["true", "false"].includes(raw)) denied("VALUE_INVALID", label + " is true or false")
        return raw
    }
    if (kind === "number" || kind === "percent") {
        const number = Number(raw)
        if (raw === "" || !Number.isFinite(number) || number < 0) denied("VALUE_INVALID", label + " is a number of at least 0")
        if (kind === "percent" && number > 100) denied("VALUE_INVALID", label + " is a percentage from 0 to 100")
        return raw
    }
    if (!raw || raw.length > 255 || /[\r\n\x00]/.test(raw))
        denied("VALUE_INVALID", label + " is one line of at most 255 characters")
    return raw
}
function storeStoreApproval(p) {
    const s = scope("edit")
    const store = storeOf(s, p.productStoreId)
    const entity = S + "ProductStoreApprove"
    if (p.storeApproveId) {
        const row = one(entity, {storeApproveId: p.storeApproveId})
        if (!row || row.productStoreId !== store.productStoreId)
            denied("RECORD_UNAVAILABLE", "Order check " + p.storeApproveId + " is not available")
        if (!(p.end === true || p.end === "true" || p.end === "Y"))
            denied("VALUE_INVALID", "End the check, then add its replacement")
        const at = dateOf(p.thruDate, nowMs(), "end date")
        call("update#" + entity, {storeApproveId: row.storeApproveId, thruDate: at})
        return {productStoreId: store.productStoreId, storeApproveId: row.storeApproveId, ended: true}
    }
    const register = p.serviceRegisterId ? one("moqui.service.ServiceRegister", {serviceRegisterId: p.serviceRegisterId}) : null
    if (!register || register.serviceTypeEnumId !== "OrderValidate")
        denied("CHECK_NOT_REGISTERED", "Choose a registered order check")
    const allowed = checkParameters(register)
    const given = p.parameters && typeof p.parameters === "object" ? p.parameters : {}
    const values = {}
    for (const [name, value] of Object.entries(given)) {
        if (value == null || value === "") continue
        if (!Object.hasOwn(allowed, name)) denied("VALUE_INVALID", register.description + " takes no parameter " + name)
        values[name] = settingValue(allowed[name], value, name)
    }
    const fromDate = dateOf(p.fromDate, nowMs(), "start date")
    const sequenceNum = p.sequenceNum == null || p.sequenceNum === "" ? null : Number(String(p.sequenceNum))
    const created = call("create#" + entity, {
        productStoreId: store.productStoreId,
        serviceRegisterId: register.serviceRegisterId,
        fromDate,
        sequenceNum
    })
    for (const [parameterName, parameterValue] of Object.entries(values))
        call("create#" + S + "ProductStoreApproveParam", {storeApproveId: created.storeApproveId, parameterName, parameterValue})
    return {productStoreId: store.productStoreId, storeApproveId: created.storeApproveId, ended: false}
}
// store#StoreContentBinding: a search document of a type (registered: a search-indexed DataDocument over the type's records),
// set or removed; or a wiki space of a type and locale from a date (never a private space).
function storeStoreContentBinding(p) {
    const s = scope("edit")
    const store = storeOf(s, p.productStoreId)
    if (p.typeEnumId) {
        if (!Object.hasOwn(documentTypes, p.typeEnumId)) denied("VALUE_INVALID", "Choose a search document type")
        const key = {productStoreId: store.productStoreId, typeEnumId: p.typeEnumId}
        const existing = one(S + "ProductStoreDataDocument", key)
        if (!p.dataDocumentId) {
            if (existing) call("delete#" + S + "ProductStoreDataDocument", key)
            return {productStoreId: store.productStoreId, removed: !!existing}
        }
        const document = one("moqui.entity.document.DataDocument", {dataDocumentId: p.dataDocumentId})
        if (!document || !document.indexName || document.primaryEntityName !== documentTypes[p.typeEnumId])
            denied("DOCUMENT_NOT_REGISTERED", "Choose a search document of that type")
        call(
            (existing ? "update#" : "create#") + S + "ProductStoreDataDocument",
            Object.assign({}, key, {dataDocumentId: p.dataDocumentId})
        )
        return {productStoreId: store.productStoreId, removed: false}
    }
    const entity = S + "ProductStoreWikiSpace"
    if (p.storeWikiSpaceId) {
        const row = one(entity, {storeWikiSpaceId: p.storeWikiSpaceId})
        if (!row || row.productStoreId !== store.productStoreId)
            denied("RECORD_UNAVAILABLE", "Content space " + p.storeWikiSpaceId + " is not available")
        call("update#" + entity, {storeWikiSpaceId: row.storeWikiSpaceId, thruDate: dateOf(p.thruDate, nowMs(), "end date")})
        return {productStoreId: store.productStoreId, removed: true}
    }
    checkEnum(p.spaceTypeEnumId, "ProductStoreWikiSpaceType", "content type")
    if (!p.spaceTypeEnumId) denied("VALUE_INVALID", "Choose a content type")
    const space = p.wikiSpaceId ? one("moqui.resource.wiki.WikiSpace", {wikiSpaceId: p.wikiSpaceId}) : null
    if (!space) denied("VALUE_INVALID", "Choose a wiki space")
    if (space.restrictView === "Y") denied("SPACE_PRIVATE", "A private wiki space is not published through a store")
    const locale = blankToNull(text(p.locale))
    if (locale) checkStoreValues({defaultLocale: locale})
    const fromDate = dateOf(p.fromDate, nowMs(), "start date")
    // the space in effect for the same type and locale ends where this one starts
    for (const row of rows(entity, {productStoreId: store.productStoreId, spaceTypeEnumId: p.spaceTypeEnumId}))
        if (
            (row.locale || null) === locale &&
            (ms(row.thruDate) ?? Infinity) > fromDate &&
            (ms(row.fromDate) ?? -Infinity) < fromDate
        )
            call("update#" + entity, {storeWikiSpaceId: row.storeWikiSpaceId, thruDate: fromDate})
    const created = call("create#" + entity, {
        productStoreId: store.productStoreId,
        spaceTypeEnumId: p.spaceTypeEnumId,
        locale,
        wikiSpaceId: space.wikiSpaceId,
        fromDate
    })
    return {productStoreId: store.productStoreId, storeWikiSpaceId: created.storeWikiSpaceId, removed: false}
}
function storeStoreSetting(p) {
    const s = scope("edit")
    const store = storeOf(s, p.productStoreId)
    if (!Object.hasOwn(settingTypes, p.settingTypeEnumId || ""))
        denied("SETTING_NOT_EDITABLE", "Setting " + (p.settingTypeEnumId || "") + " is not set here")
    const ending = p.end === true || p.end === "true" || p.end === "Y"
    const values = ending
        ? {}
        : {settingValue: settingValue(settingTypes[p.settingTypeEnumId], p.settingValue, enumText(p.settingTypeEnumId))}
    const saved = saveDated(
        S + "ProductStoreSetting",
        {productStoreId: store.productStoreId, settingTypeEnumId: p.settingTypeEnumId},
        values,
        p
    )
    return Object.assign({productStoreId: store.productStoreId}, saved)
}

// ===== store groups =====
// A group belongs to the organization of its current OrgInternal ProductStoreGroupParty row (ProductStoreGroup has no
// organization field): store#StoreGroup writes it at creation. A store-limited staff member sees only their stores among
// a group's members and changes a group only when every member in effect is theirs.
function groupOwner(productStoreGroupId) {
    return (
        rows(S + "ProductStoreGroupParty", {productStoreGroupId, roleTypeId: groupOwnerRole}).filter(row => active(row))[0]
            ?.partyId || null
    )
}
function groupOf(s, productStoreGroupId) {
    const group = productStoreGroupId ? one(S + "ProductStoreGroup", {productStoreGroupId}) : null
    const owner = group ? groupOwner(productStoreGroupId) : null
    if (!group || !owner || !owns(s, owner))
        denied("RECORD_UNAVAILABLE", "Store group " + (productStoreGroupId || "") + " is not available")
    return {group, owner}
}
function groupDetail(s, group, owner, names) {
    const members = rows(S + "ProductStoreGroupMember", {productStoreGroupId: group.productStoreGroupId})
    const storeIds = Array.from(new Set(members.map(row => row.productStoreId)))
    const stores = storeIds.length
        ? Object.fromEntries(
              Array.from(storeQuery(s).condition("productStoreId", "in", storeIds).list()).map(row => [
                  row.productStoreId,
                  row.storeName || row.productStoreId
              ])
          )
        : {}
    const memberRows = members
        .filter(row => Object.hasOwn(stores, row.productStoreId))
        .sort((a, b) => (a.sequenceNum ?? 0) - (b.sequenceNum ?? 0) || ms(b.fromDate) - ms(a.fromDate))
        .map(row => {
            const dates = rowDates(row)
            return Object.assign(
                {
                    productStoreId: row.productStoreId,
                    storeName: stores[row.productStoreId],
                    fromDate: ms(row.fromDate),
                    stateText: stateOf(dates)
                },
                dates
            )
        })
    const parties = rows(S + "ProductStoreGroupParty", {productStoreGroupId: group.productStoreGroupId}).filter(
        row => row.roleTypeId !== groupOwnerRole
    )
    const partyNamesFound = partyNames(parties.map(row => row.partyId))
    const partyRows = parties
        .sort((a, b) => ms(b.fromDate) - ms(a.fromDate))
        .map(row => {
            const dates = rowDates(row)
            return Object.assign(
                {
                    partyId: row.partyId,
                    partyName: partyLabel(partyNamesFound, row.partyId),
                    roleTypeId: row.roleTypeId,
                    roleText: staffRoles[row.roleTypeId] || row.roleTypeId,
                    fromDate: ms(row.fromDate),
                    stateText: stateOf(dates)
                },
                dates
            )
        })
    return {
        productStoreGroupId: group.productStoreGroupId,
        description: group.description || group.productStoreGroupId,
        storeGroupTypeEnumId: group.storeGroupTypeEnumId,
        typeText: enumText(group.storeGroupTypeEnumId),
        organizationPartyId: owner,
        organizationName: partyLabel(names, owner),
        memberCount: memberRows.filter(row => row.current).length,
        lastUpdatedStamp: ms(group.lastUpdatedStamp),
        members: memberRows,
        parties: partyRows
    }
}
// find#StoreGroups: the groups of the user's organizations (by type, organization or description), and one group's members
// and parties when productStoreGroupId is given.
function findStoreGroups(p) {
    const s = scope()
    let owners = Array.from(find(S + "ProductStoreGroupParty", {roleTypeId: groupOwnerRole}).list()).filter(row => active(row))
    owners = owners.filter(row => owns(s, row.partyId))
    if (p.organizationPartyId) owners = owners.filter(row => row.partyId === p.organizationPartyId)
    const ownerOf = Object.fromEntries(owners.map(row => [row.productStoreGroupId, row.partyId]))
    const ids = Object.keys(ownerOf)
    let query = find(S + "ProductStoreGroup").condition("productStoreGroupId", "in", ids)
    if (p.storeGroupTypeEnumId) query = query.condition("storeGroupTypeEnumId", p.storeGroupTypeEnumId)
    const term = text(p.term)
    if (term)
        query = query.condition(ec.entity.conditionFactory.makeCondition("description", "like", likeText(term)).ignoreCase())
    const groups = Array.from(query.orderBy("description").limit(200).list())
    const names = partyNames(Object.values(ownerOf))
    const listed = groups.map(group => {
        const detail = groupDetail(s, group, ownerOf[group.productStoreGroupId], names)
        delete detail.members
        delete detail.parties
        return detail
    })
    const result = {groups: listed, group: null, canEdit: s.canEdit}
    if (p.productStoreGroupId) {
        const {group, owner} = groupOf(s, p.productStoreGroupId)
        result.group = groupDetail(s, group, owner, partyNames([owner]))
    }
    return result
}
// store#StoreGroup: a new group of one of the user's organizations, a change of its description or type, a store bound to
// it from a date or ended (memberStoreId), or a party of a staff role (partyId). Groups select stores for reports and bulk
// work; they share no settings.
function storeStoreGroup(p) {
    const s = scope("edit")
    checkEnum(p.storeGroupTypeEnumId, "ProductStoreGroupType", "group type")
    if (!p.productStoreGroupId) {
        if (s.storeLimit) denied("STORE_LIMITED", "A store-limited staff member does not start store groups")
        const organizationPartyId = organizationOf(s, p.organizationPartyId)
        if (!text(p.description)) denied("VALUE_INVALID", "Describe the group")
        const created = call("create#" + S + "ProductStoreGroup", {
            description: text(p.description),
            storeGroupTypeEnumId: blankToNull(p.storeGroupTypeEnumId) ?? null
        })
        call("create#" + S + "ProductStoreGroupParty", {
            productStoreGroupId: created.productStoreGroupId,
            partyId: organizationPartyId,
            roleTypeId: groupOwnerRole,
            fromDate: nowMs()
        })
        return {productStoreGroupId: created.productStoreGroupId, created: true}
    }
    const {group, owner} = groupOf(s, p.productStoreGroupId)
    if (s.storeLimit) {
        const outside = rows(S + "ProductStoreGroupMember", {productStoreGroupId: group.productStoreGroupId}).filter(
            row => active(row) && !s.storeLimit.includes(row.productStoreId)
        )
        if (outside.length) denied("RECORD_UNAVAILABLE", "Store group " + group.productStoreGroupId + " is not available")
    }
    const key = {productStoreGroupId: group.productStoreGroupId}
    if (p.memberStoreId) {
        const store = storeOf(s, p.memberStoreId)
        if (store.organizationPartyId !== owner)
            denied("STORE_OTHER_ORGANIZATION", "A group holds stores of its own organization only")
        const sequenceNum = p.sequenceNum == null || p.sequenceNum === "" ? null : Number(String(p.sequenceNum))
        const saved = saveDated(
            S + "ProductStoreGroupMember",
            Object.assign({}, key, {productStoreId: store.productStoreId}),
            {sequenceNum},
            p
        )
        return Object.assign({productStoreGroupId: group.productStoreGroupId, created: false}, saved)
    }
    if (p.partyId) {
        const roleTypeId = p.roleTypeId || "StoreStaff"
        if (!Object.hasOwn(staffRoles, roleTypeId)) denied("ROLE_NOT_STAFF", "Only a staff role is set here")
        if (!(p.end === true || p.end === "true" || p.end === "Y") && !worksFor(p.partyId, owner))
            denied("PARTY_UNAVAILABLE", "Party " + p.partyId + " does not work for the group's organization")
        const saved = saveDated(S + "ProductStoreGroupParty", Object.assign({}, key, {partyId: p.partyId, roleTypeId}), {}, p)
        return Object.assign({productStoreGroupId: group.productStoreGroupId, created: false}, saved)
    }
    stale(p, group)
    const changes = {}
    if (Object.hasOwn(p, "description") && p.description != null) {
        if (!text(p.description)) denied("VALUE_INVALID", "Describe the group")
        changes.description = text(p.description)
    }
    if (Object.hasOwn(p, "storeGroupTypeEnumId") && p.storeGroupTypeEnumId !== undefined)
        changes.storeGroupTypeEnumId = blankToNull(p.storeGroupTypeEnumId)
    if (Object.keys(changes).length) call("update#" + S + "ProductStoreGroup", Object.assign({}, key, changes))
    return {productStoreGroupId: group.productStoreGroupId, created: false}
}

// ===== clone =====
// What a clone of a store copies, section by section, and the references it carries into the target organization. Copied:
// the categories and emails in effect or later (clone#ProductStore), the target organization's facilities, the staff rows
// of people who work for the target organization, and the editable settings. Never: the store's customers' and other
// non-staff party rows, its products (the clone starts unpublished), promotions, payment and shipping gateways, ship
// options, order checks, content bindings, group memberships, host mounts, its integration remote and credentials.
function clonePlan(base, organizationPartyId, p) {
    const now = nowMs()
    const inEffect = row => (ms(row.thruDate) ?? Infinity) >= now
    const want = field => p[field] !== false && p[field] !== "false" && p[field] !== "N"
    const sectionsFound = []
    const references = []
    const left = (section, label, count, note) => sectionsFound.push({section, label, copied: 0, leftOut: count, note})
    const facilities = rows(S + "ProductStoreFacility", {productStoreId: base.productStoreId}).filter(inEffect)
    const ownFacilities = facilities.filter(
        row => one("mantle.facility.Facility", {facilityId: row.facilityId})?.ownerPartyId === organizationPartyId
    )
    const staff = rows(S + "ProductStoreParty", {productStoreId: base.productStoreId}).filter(inEffect)
    const staffRows = staff.filter(row => Object.hasOwn(staffRoles, row.roleTypeId))
    const ownStaff = staffRows.filter(row => worksFor(row.partyId, organizationPartyId))
    const settings = rows(S + "ProductStoreSetting", {productStoreId: base.productStoreId}).filter(inEffect)
    const copiedSettings = settings.filter(
        row => Object.hasOwn(settingTypes, row.settingTypeEnumId) && !cloneLeftOutSettingTypes.includes(row.settingTypeEnumId)
    )
    const categories = rows(S + "ProductStoreCategory", {productStoreId: base.productStoreId}).filter(inEffect)
    const emails = rows(S + "ProductStoreEmail", {productStoreId: base.productStoreId}).filter(inEffect)
    const copy = {
        categories: want("copyCategories"),
        emails: want("copyEmails"),
        facilities: want("copyFacilities"),
        staff: want("copyStaff"),
        settings: want("copySettings")
    }
    sectionsFound.push({
        section: "categories",
        label: "Categories",
        copied: copy.categories ? categories.length : 0,
        leftOut: copy.categories ? 0 : categories.length,
        note: copy.categories ? "In effect or starting later" : "Not chosen"
    })
    sectionsFound.push({
        section: "emails",
        label: "Emails",
        copied: copy.emails ? emails.length : 0,
        leftOut: copy.emails ? 0 : emails.length,
        note: copy.emails ? "Their templates are shared" : "Not chosen"
    })
    sectionsFound.push({
        section: "facilities",
        label: "Facilities",
        copied: copy.facilities ? ownFacilities.length : 0,
        leftOut: facilities.length - (copy.facilities ? ownFacilities.length : 0),
        note: !copy.facilities
            ? "Not chosen"
            : ownFacilities.length < facilities.length
              ? "Another organization's are left out"
              : ""
    })
    sectionsFound.push({
        section: "staff",
        label: "Staff",
        copied: copy.staff ? ownStaff.length : 0,
        leftOut: staffRows.length - (copy.staff ? ownStaff.length : 0),
        note: !copy.staff ? "Not chosen" : ownStaff.length < staffRows.length ? "People of another organization are left out" : ""
    })
    sectionsFound.push({
        section: "settings",
        label: "Settings",
        copied: copy.settings ? copiedSettings.length : 0,
        leftOut: settings.length - (copy.settings ? copiedSettings.length : 0),
        note:
            copy.settings && copiedSettings.length < settings.length
                ? "Locations and schedules are left out"
                : copy.settings
                  ? ""
                  : "Not chosen"
    })
    left("customers", "Customer and other party rows", staff.length - staffRows.length, "Never copied")
    left(
        "products",
        "Published products",
        rows(S + "ProductStoreProduct", {productStoreId: base.productStoreId}).length,
        "The clone starts unpublished"
    )
    left(
        "promotions",
        "Promotions",
        rows(S + "ProductStorePromotion", {productStoreId: base.productStoreId}).length,
        "Never copied"
    )
    left(
        "gateways",
        "Payment and shipping gateways, ship options",
        rows(S + "ProductStorePaymentGateway", {productStoreId: base.productStoreId}).length +
            rows(S + "ProductStoreShippingGateway", {productStoreId: base.productStoreId}).length +
            rows(S + "ProductStoreShipOption", {productStoreId: base.productStoreId}).length,
        "Set the clone's checkout yourself"
    )
    left("approvals", "Order checks", rows(S + "ProductStoreApprove", {productStoreId: base.productStoreId}).length, "Not copied")
    left(
        "content",
        "Search and content bindings",
        rows(S + "ProductStoreDataDocument", {productStoreId: base.productStoreId}).length +
            rows(S + "ProductStoreWikiSpace", {productStoreId: base.productStoreId}).length,
        "Not copied"
    )
    left(
        "sites",
        "Site mounts",
        (shopMounts([base.productStoreId])[base.productStoreId] || []).length,
        "A site operator mounts the clone"
    )
    // the organization-sensitive references the clone carries, which the user approves
    if (copy.facilities)
        for (const row of ownFacilities)
            references.push({
                kind: "Facility",
                id: row.facilityId,
                name: one("mantle.facility.Facility", {facilityId: row.facilityId})?.facilityName || row.facilityId
            })
    if (copy.staff) {
        const names = partyNames(ownStaff.map(row => row.partyId))
        for (const row of ownStaff) references.push({kind: "Staff member", id: row.partyId, name: partyLabel(names, row.partyId)})
    }
    if (
        base.inventoryFacilityId &&
        one("mantle.facility.Facility", {facilityId: base.inventoryFacilityId})?.ownerPartyId === organizationPartyId
    )
        references.push({kind: "Inventory facility", id: base.inventoryFacilityId, name: base.inventoryFacilityId})
    if (base.taxGatewayConfigId)
        references.push({kind: "Tax gateway", id: base.taxGatewayConfigId, name: base.taxGatewayConfigId})
    return {sections: sectionsFound, references, copy, ownFacilities, ownStaff, copiedSettings}
}
// clone#Store: a preview of what a clone of the store copies, or the clone itself, a new unpublished store of one of the
// user's organizations, once the user approves the references it carries; the base store's revision is checked and the
// operation key answers a retry with the first result.
function cloneStore(p) {
    const s = scope("edit")
    if (s.storeLimit) denied("STORE_LIMITED", "A store-limited staff member does not start stores")
    const base = storeOf(s, p.baseProductStoreId)
    const organizationPartyId = organizationOf(s, p.organizationPartyId || base.organizationPartyId)
    const plan = clonePlan(base, organizationPartyId, p)
    const preview = {baseProductStoreId: base.productStoreId, sections: plan.sections, references: plan.references}
    if (p.preview === true || p.preview === "true" || p.preview === "Y") return Object.assign(preview, {productStoreId: null})
    const storeName = text(p.storeName)
    if (!storeName) denied("VALUE_INVALID", "Give the clone a name")
    const request = {base: base.productStoreId, organizationPartyId, storeName, copy: plan.copy}
    const op = lib.operation(p, "StoreClone", organizationPartyId, request)
    const again = lib.previous(op)
    if (again) return again
    stale(p, base)
    if (
        plan.references.length &&
        !(p.approveReferences === true || p.approveReferences === "true" || p.approveReferences === "Y")
    )
        denied("CLONE_APPROVAL_REQUIRED", "Approve the facilities, staff and gateway the clone carries")
    const cloned = call("mantle.product.StoreServices.clone#ProductStore", {
        baseProductStoreId: base.productStoreId,
        storeName,
        organizationPartyId,
        copyCategories: plan.copy.categories,
        copyEmails: plan.copy.emails,
        copyFacilities: false,
        copyParties: false,
        copyProducts: false,
        copySettings: false
    })
    const productStoreId = cloned.productStoreId
    // no integration remote, and no inventory facility of another organization
    const keepInventory = plan.references.some(row => row.kind === "Inventory facility")
    call("update#" + STORE, {
        productStoreId,
        systemMessageRemoteId: null,
        inventoryFacilityId: keepInventory ? base.inventoryFacilityId : null
    })
    if (plan.copy.facilities)
        for (const row of plan.ownFacilities)
            call("create#" + S + "ProductStoreFacility", {
                productStoreId,
                facilityId: row.facilityId,
                fromDate: row.fromDate,
                thruDate: row.thruDate,
                sequenceNum: row.sequenceNum
            })
    if (plan.copy.staff)
        for (const row of plan.ownStaff)
            call("create#" + S + "ProductStoreParty", {
                productStoreId,
                partyId: row.partyId,
                roleTypeId: row.roleTypeId,
                fromDate: row.fromDate,
                thruDate: row.thruDate
            })
    if (plan.copy.settings)
        for (const row of plan.copiedSettings)
            call("create#" + S + "ProductStoreSetting", {
                productStoreId,
                settingTypeEnumId: row.settingTypeEnumId,
                fromDate: row.fromDate,
                thruDate: row.thruDate,
                settingValue: row.settingValue
            })
    const result = Object.assign(preview, {productStoreId})
    lib.complete(op, STORE, productStoreId, result)
    return result
}

// ===== readiness =====
// What a store needs before it sells, each finding with the area it belongs to, whether it blocks or only warns, and the
// section that fixes it (fix: general, sites, facilities, emails, settings), never a screen path: the app maps the section
// to its own screen. P2 checks what the stores' records hold now; later phases append their checks here.
const readinessChecks = [
    {
        key: "organization",
        area: "store",
        label: "Organization",
        fix: "general",
        check: store =>
            isInternal(store.organizationPartyId)
                ? {ready: true, message: "Sells for an internal organization"}
                : {ready: false, message: "The store has no internal organization"}
    },
    {
        key: "currency",
        area: "store",
        label: "Currency",
        fix: "general",
        check: store =>
            store.defaultCurrencyUomId
                ? {ready: true, message: "Prices in " + store.defaultCurrencyUomId}
                : {ready: false, message: "No currency is set"}
    },
    {
        key: "site",
        area: "site",
        label: "Site",
        fix: "sites",
        check: store => {
            const mounts = (shopMounts([store.productStoreId])[store.productStoreId] || []).filter(mount => mount.enabled === "Y")
            return mounts.length
                ? {ready: true, message: "Sold on " + mounts.map(mount => mount.siteId).join(", ")}
                : {ready: false, message: "No site sells from this store; a site operator mounts the shop for it"}
        }
    },
    {
        key: "siteHost",
        area: "site",
        label: "Site address",
        fix: "sites",
        check: store => {
            const mounts = shopMounts([store.productStoreId])[store.productStoreId] || []
            if (!mounts.length) return null
            const hostless = mounts.filter(mount => !one("mantle.public.PublicSiteHost", {siteId: mount.siteId, canonical: "Y"}))
            return hostless.length
                ? {ready: false, message: "No canonical host for " + hostless.map(mount => mount.siteId).join(", ")}
                : {ready: true, message: "Every site has its address"}
        }
    },
    {
        key: "facility",
        area: "delivery",
        label: "Fulfillment",
        fix: "facilities",
        severity: "warning",
        check: store =>
            rows(S + "ProductStoreFacility", {productStoreId: store.productStoreId}).some(row => active(row))
                ? {ready: true, message: "Ships from its facilities"}
                : {ready: false, message: "No facility fulfills its orders; a store of digital items only needs none"}
    },
    {
        key: "tax",
        area: "tax",
        label: "Tax",
        fix: "general",
        check: store =>
            store.taxGatewayConfigId
                ? {ready: true, message: "Taxed through " + store.taxGatewayConfigId}
                : {ready: false, message: "No tax gateway is set"}
    },
    {
        key: "orderNotice",
        area: "content",
        label: "Order notice",
        fix: "emails",
        check: store =>
            rows(S + "ProductStoreEmail", {productStoreId: store.productStoreId, emailTypeEnumId: "PsetOrderPlaced"}).some(row =>
                active(row)
            )
                ? {ready: true, message: "Customers get an order confirmation"}
                : {ready: false, message: "No order placed email is bound"}
    }
]
// The findings for a store: each check's result, a check that fails to answer named not ready (failure tolerance).
function findings(store) {
    const found = []
    for (const definition of readinessChecks) {
        let outcome
        try {
            outcome = definition.check(store)
        } catch (error) {
            ec.logger.error(
                "Readiness check " + definition.key + " of store " + store.productStoreId + " failed: " + error.message
            )
            outcome = {ready: false, message: "Could not be checked"}
        }
        if (!outcome) continue
        found.push({
            key: definition.key,
            area: definition.area,
            label: definition.label,
            ready: !!outcome.ready,
            severity: outcome.ready ? "ok" : definition.severity || "blocking",
            warning: definition.severity === "warning",
            message: outcome.message,
            fix: definition.fix
        })
    }
    return found
}
// check#StoreReadiness: a store's findings for a user who reads it (COMMERCE_VIEW, its organization, a store-limited staff
// member's own); or, called as a PASS app's readiness with input {siteId, app, targetId} (the store), the checks by name
// only, as PublicApps' other readiness services answer. It writes nothing.
function checkStoreReadiness(p) {
    if (p.input && typeof p.input === "object" && !p.productStoreId) {
        const store = p.input.targetId ? one(STORE, {productStoreId: p.input.targetId}) : null
        if (!store) return {ready: false, findings: [], result: {checks: [{name: "store", ready: false}]}}
        const found = findings(store).filter(row => !row.warning)
        return {
            productStoreId: store.productStoreId,
            ready: found.every(row => row.ready),
            findings: [],
            result: {checks: found.map(row => ({name: row.label.toLowerCase(), ready: row.ready}))}
        }
    }
    const s = scope()
    const store = storeOf(s, p.productStoreId)
    const found = findings(store)
    return {
        productStoreId: store.productStoreId,
        ready: found.every(row => row.ready || row.severity === "warning"),
        findings: found,
        result: {checks: found.map(row => ({name: row.label.toLowerCase(), ready: row.ready}))}
    }
}

// ===== options =====
// The options a store's forms may choose, each the values its save accepts, searched by term in the query where the records
// are many, with the selected value's label when it is valid but not on the page.
function termCondition(fields, term) {
    const factory = ec.entity.conditionFactory
    return factory.makeCondition(
        fields.map(field => factory.makeCondition(field, "like", likeText(term)).ignoreCase()),
        "or"
    )
}
const optionSources = {
    facilities: (s, store, term) => {
        let query = find("mantle.facility.Facility", {ownerPartyId: store.organizationPartyId})
        if (term) query = query.condition(termCondition(["facilityId", "facilityName"], term))
        return Array.from(query.orderBy("facilityName").limit(choiceLimit).list()).map(row => ({
            value: row.facilityId,
            label: row.facilityName || row.facilityId
        }))
    },
    staff: (s, store, term, organizationPartyId) => {
        const owner = organizationPartyId || store.organizationPartyId
        const ids = Array.from(
            find("mantle.party.PartyRelationship", {toPartyId: owner})
                .condition("relationshipTypeEnumId", "in", staffRelationships)
                .list()
        )
            .filter(row => active(row))
            .map(row => row.fromPartyId)
        if (!ids.length) return []
        let query = find("mantle.party.PartyDetail")
            .condition("partyId", "in", Array.from(new Set(ids)))
            .condition("partyTypeEnumId", "PtyPerson")
        if (term) query = query.condition(termCondition(["partyId", "firstName", "lastName"], term))
        const found = Array.from(query.orderBy("firstName,lastName").limit(choiceLimit).list())
        const names = partyNames(found.map(row => row.partyId))
        return found.filter(row => names[row.partyId]).map(row => ({value: row.partyId, label: names[row.partyId]}))
    },
    emailTemplates: (s, store, term) => {
        let query = find("moqui.basic.email.EmailTemplate")
        if (term) query = query.condition(termCondition(["emailTemplateId", "description"], term))
        return Array.from(query.orderBy("description").limit(choiceLimit).list()).map(row => ({
            value: row.emailTemplateId,
            label: row.description || row.emailTemplateId
        }))
    },
    orderChecks: () =>
        rows("moqui.service.ServiceRegister", {serviceTypeEnumId: "OrderValidate"}).map(row => ({
            value: row.serviceRegisterId,
            label: row.description || row.serviceRegisterId
        })),
    documents: (s, store, term, organizationPartyId, typeEnumId) => {
        const entities = typeEnumId
            ? [documentTypes[typeEnumId]].filter(Boolean)
            : Array.from(new Set(Object.values(documentTypes)))
        if (!entities.length) return []
        return Array.from(
            find("moqui.entity.document.DataDocument")
                .condition("primaryEntityName", "in", entities)
                .condition("indexName", "is-not-null", null)
                .orderBy("documentName")
                .limit(choiceLimit)
                .list()
        ).map(row => ({value: row.dataDocumentId, label: row.documentName || row.dataDocumentId}))
    },
    wikiSpaces: (s, store, term) => {
        const factory = ec.entity.conditionFactory
        let query = find("moqui.resource.wiki.WikiSpace").condition(
            factory.makeCondition(
                [
                    factory.makeCondition("restrictView", "is-null", null),
                    factory.makeCondition("restrictView", "not-equals", "Y")
                ],
                "or"
            )
        )
        if (term) query = query.condition(termCondition(["wikiSpaceId", "description"], term))
        return Array.from(query.orderBy("wikiSpaceId").limit(choiceLimit).list()).map(row => ({
            value: row.wikiSpaceId,
            label: row.description ? row.wikiSpaceId + " · " + row.description : row.wikiSpaceId
        }))
    },
    taxGateways: () =>
        rows("mantle.other.tax.TaxGatewayConfig", {}).map(row => ({
            value: row.taxGatewayConfigId,
            label: row.description || row.taxGatewayConfigId
        })),
    settingTypes: () =>
        Object.keys(settingTypes)
            .map(enumId => ({value: enumId, label: enumText(enumId)}))
            .sort((a, b) => a.label.localeCompare(b.label)),
    groupStores: (s, store, term, organizationPartyId) => {
        let query = storeQuery(s)
        if (organizationPartyId) query = query.condition("organizationPartyId", organizationPartyId)
        if (term) query = query.condition(termCondition(["productStoreId", "storeName"], term))
        return Array.from(query.orderBy("storeName").limit(choiceLimit).list()).map(row => ({
            value: row.productStoreId,
            label: row.storeName || row.productStoreId
        }))
    }
}
// find#StoreOptions: the options of a store form's drop-down (facilities, staff, emailTemplates, orderChecks, documents,
// wikiSpaces, taxGateways, settingTypes; groupStores for a group's organization).
function findStoreOptions(p) {
    const s = scope()
    if (!Object.hasOwn(optionSources, p.choice || "")) throw new Error("Unknown store option " + p.choice)
    const store = p.productStoreId ? storeOf(s, p.productStoreId) : null
    let organizationPartyId = null
    if (p.productStoreGroupId) organizationPartyId = groupOf(s, p.productStoreGroupId).owner
    else if (p.organizationPartyId) organizationPartyId = organizationOf(s, p.organizationPartyId)
    if (
        !store &&
        !organizationPartyId &&
        !["emailTemplates", "orderChecks", "documents", "wikiSpaces", "taxGateways", "settingTypes", "groupStores"].includes(
            p.choice
        )
    )
        denied("RECORD_UNAVAILABLE", "Choose a store")
    const scoped = store || {organizationPartyId}
    const term = text(p.term)
    const options = optionSources[p.choice](s, scoped, term, organizationPartyId, p.typeEnumId || null)
    if (p.selected && !options.some(option => option.value === p.selected)) {
        const all = optionSources[p.choice](s, scoped, String(p.selected), organizationPartyId, p.typeEnumId || null)
        const match = all.find(option => option.value === p.selected)
        if (match) options.push(match)
    }
    return {options}
}

const operations = {
    findStores,
    getStore,
    getStoreSites,
    storeStore,
    storeStoreFacility,
    storeStoreParty,
    storeStoreEmail,
    storeStoreApproval,
    storeStoreContentBinding,
    storeStoreSetting,
    findStoreGroups,
    storeStoreGroup,
    cloneStore,
    checkStoreReadiness,
    findStoreOptions
}
;({
    // the scope and checks for later phases' store modules (merchandising, operations, promotions): the user's stores and the
    // refusal of one outside them
    scope,
    storeQuery,
    storeOf,
    // P3 (StoreMerchandising.js): the dated save, the date and reason checks and row dates, shared by the store modules
    saveDated,
    dateOf,
    reason,
    rowDates,
    stateOf,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown store operation " + op)
        return operations[op](parameters || {})
    }
})
