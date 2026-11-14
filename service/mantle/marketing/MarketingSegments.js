// Marketing's segments (mantle.marketing.SegmentServices, Q; IronStone Marketing design §4 Segments, SegmentDetail, §14.1, §14.2;
// impl-marketing P5, F5): a segment of an organization (the native MarketSegment, its owner the organization, X12) defined by its
// native rules (classifications and geographies, each family's rows alternatives; dimension bounds, all of them), a saved filter
// over the registered projections below, and dated explicit members that include or exclude a party; evaluated, bounded and paged,
// with the rule each party matched by or the reason it is left out. An evaluation subscribes no one and is no send authority.
//
// - Scope: a segment of an organization of the caller's scope (MarketingAccess.js covers); any other, missing or unowned answers as
//   missing (RECORD_UNAVAILABLE). Reading needs MARKETING_AUDIENCE_VIEW, a write MARKETING_AUDIENCE_EDIT (PERMISSION_DENIED). An
//   archived segment takes no change (SEGMENT_ARCHIVED).
// - Revisions: a segment write names the segment's lastUpdatedStamp (expectedRevision; none REVISION_REQUIRED, another
//   STALE_REVISION naming the current one); a change of its rules, filter, kind or parent raises its definitionRevision. A member
//   write names the member row's revision when the row exists.
// - Who is evaluated (the organization's audience, bounded at universeCap parties, AUDIENCE_TOO_LARGE beyond): the current members
//   of the organization's Marketing lists, the parties it owns (not internal organizations), the segment's explicit members, and
//   the parties a source in its filter discovers (an order's customer, a Sales lead's contact the caller sees); each one a party
//   that exists, is not disabled or merged and is not another user's personal contact. A native rule never reaches outside it.
// - The match: the rule match (every populated native family and the filter, all of them) joined by the explicit inclusions,
//   intersected with the parent's match (each parent's in turn; a cycle refused at store and at evaluation), less the explicit
//   exclusions, which always win. A rule segment with no rule matches its explicit inclusions alone; an explicit segment never
//   reads its rules.
// - The projections (sources): each names its fields and the read it needs; a caller who lacks a source's read cannot store a
//   condition on it or evaluate a segment whose filter (or a parent's) holds one (SOURCE_UNAVAILABLE): no count of it is answered.
//   Sales' sources read Sales' records under the caller's own Sales scope only (Mantle's SalesAccess.js opportunityOf, accountOf),
//   in the segment's organization: a Marketing user without a Sales read has no Sales criterion. A missing value never matches,
//   whatever the operator, so a negation never reaches a party whose value is unknown.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const marketingAccess = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingAccess.js")
const {find, one, rows, denied, call} = lib

const SEGMENT = "mantle.marketing.segment.MarketSegment"
const MEMBER = "mantle.marketing.segment.MarketSegmentParty"
const FILTER = "mantle.marketing.segment.MarketSegmentFilter"
const CLASSIFICATION = "mantle.marketing.segment.MarketSegmentClassification"
const GEO = "mantle.marketing.segment.MarketSegmentGeo"
const DIMENSION = "mantle.marketing.segment.MarketSegmentDimension"
const LIST = "mantle.marketing.contact.ContactList"
const CLP = "mantle.marketing.contact.ContactListParty"
const kinds = {rule: "MskRule", explicit: "MskExplicit"}
const memberKinds = {include: "MspInclude", exclude: "MspExclude"}
const marketingListTypes = ["MARKETING", "NEWSLETTER", "ANNOUNCEMENT"]
const universeCap = 5000
const parentDepthCap = 10
const filterLimits = {depth: 3, conditions: 20, values: 50}
const placedStatuses = ["OrderPlaced", "OrderApproved", "OrderProcessing", "OrderSent", "OrderCompleted"]
const dayMs = 24 * 60 * 60 * 1000

const text = value => (value == null ? "" : String(value).trim())
const blank = value => value == null || value === ""
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const organizationName = partyId => (partyId ? one("mantle.party.Organization", {partyId})?.organizationName || partyId : "")
const idOrder = (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)
const unique = values => Array.from(new Set(Array.from(values || []).filter(Boolean)))
const listOf = value =>
    value == null
        ? []
        : (typeof value === "string" ? value.split(",") : Array.from(value)).map(item => text(item)).filter(Boolean)
// A number of a value that may be a decimal (BigDecimal has no valueOf), or null.
const num = value =>
    value == null || value === "" ? null : typeof value?.toNumber === "function" ? value.toNumber() : Number(value)
const asOfOf = value => (blank(value) ? ec.user.nowTimestamp : new Date(lib.ms(value)))
// Rows of an entity whose field is one of many values, read 500 at a time.
function rowsIn(entity, field, values, conditions = {}, configure = null) {
    const all = unique(values)
    const found = []
    for (let start = 0; start < all.length; start += 500) {
        let query = find(entity, conditions).condition(field, "in", all.slice(start, start + 500))
        if (configure) query = configure(query)
        for (const row of query.list()) found.push(row)
    }
    return found
}
// The rows of a read limited to universeCap + 1, refused past the cap (AUDIENCE_TOO_LARGE), never cut short: a list, an exclusion or
// an audience is read whole or not at all (P5 review).
function bounded(list, what) {
    const all = Array.from(list)
    if (all.length > universeCap)
        denied("AUDIENCE_TOO_LARGE", what + " holds more than " + universeCap + " people; narrow it with a list or a segment")
    return all
}
const groupBy = (list, key) => {
    const grouped = new Map()
    for (const row of list) {
        const value = row[key]
        if (!grouped.has(value)) grouped.set(value, [])
        grouped.get(value).push(row)
    }
    return grouped
}

// ===== the projections' registry (design §4 SavedFilter; impl-marketing P5) =====
// Each source: its label, whether the caller may read it in the organization (readable), its fields (type and label, an enum's
// values), facts(ctx, partyIds) → Map partyId → {field: value} (null when unknown), and discover(ctx) → the parties it brings to
// the organization's audience. Field types and their operators:
const operatorsByType = {
    boolean: ["is"],
    number: ["equals", "not-equals", "greater", "greater-equals", "less", "less-equals"],
    date: ["before", "after", "within-days"],
    enum: ["equals", "not-equals", "in", "not-in"],
    id: ["equals", "not-equals", "in", "not-in"],
    ids: ["includes", "excludes"]
}
const operatorTexts = {
    is: "is",
    equals: "is",
    "not-equals": "is not",
    greater: "is more than",
    "greater-equals": "is at least",
    less: "is less than",
    "less-equals": "is at most",
    before: "is before",
    after: "is after",
    "within-days": "is within the last days",
    in: "is one of",
    "not-in": "is none of",
    includes: "includes",
    excludes: "excludes"
}
// The Sales scope, read once for a context, and whether it reads the organization.
function salesReadable(ctx) {
    if (ctx.salesScope === undefined) {
        const salesAccess = ec.resource.script("component://mr-mantle/service/mantle/sales/SalesAccess.js")
        ctx.salesAccess = salesAccess
        ctx.salesScope = ec.user.userId ? salesAccess.scope() : null
    }
    return !!ctx.salesScope?.capabilities?.anyRead && ctx.salesAccess.covers(ctx.salesScope, ctx.organizationPartyId)
}
// The organization's Sales deals the caller sees (SalesAccess opportunityOf), each once, among those named.
function visibleOpportunities(ctx, salesOpportunityIds) {
    if (!ctx.visibleDeals) ctx.visibleDeals = new Map()
    const found = []
    for (const id of unique(salesOpportunityIds)) {
        if (!ctx.visibleDeals.has(id)) {
            const deal = ctx.salesAccess.opportunityOf(ctx.salesScope, id)
            ctx.visibleDeals.set(id, deal && deal.organizationPartyId === ctx.organizationPartyId ? deal.opportunity : null)
        }
        if (ctx.visibleDeals.get(id)) found.push(ctx.visibleDeals.get(id))
    }
    return found
}
const openDeal = deal => !deal.statusId || deal.statusId === "SalesOppOpen"
// The current Contact rows of deals for parties: Map partyId → [deal] the caller sees, of the type named.
function dealsOfParties(ctx, partyIds, typeEnumId) {
    const contactRows = rowsIn(
        "mantle.sales.opportunity.SalesOpportunityParty",
        "partyId",
        partyIds,
        {roleTypeId: "Contact"},
        query => query.conditionDate("fromDate", "thruDate", ctx.asOf)
    )
    const deals = new Map(
        visibleOpportunities(
            ctx,
            contactRows.map(row => row.salesOpportunityId)
        ).map(deal => [deal.salesOpportunityId, deal])
    )
    const byParty = new Map()
    for (const row of contactRows) {
        const deal = deals.get(row.salesOpportunityId)
        if (!deal || deal.typeEnumId !== typeEnumId) continue
        if (!byParty.has(row.partyId)) byParty.set(row.partyId, [])
        if (!byParty.get(row.partyId).includes(deal)) byParty.get(row.partyId).push(deal)
    }
    return byParty
}
// The contacts of the organization's deals of a type the caller sees, bounded.
function dealContacts(ctx, typeEnumId) {
    const ids = bounded(
        find("mantle.sales.opportunity.SalesOpportunity", {organizationPartyId: ctx.organizationPartyId, typeEnumId})
            .selectField("salesOpportunityId")
            .limit(universeCap + 1)
            .list(),
        "The organization's Sales pipeline"
    ).map(row => row.salesOpportunityId)
    const visible = visibleOpportunities(ctx, ids).map(deal => deal.salesOpportunityId)
    return unique(
        rowsIn("mantle.sales.opportunity.SalesOpportunityParty", "salesOpportunityId", visible, {roleTypeId: "Contact"}, query =>
            query.conditionDate("fromDate", "thruDate", ctx.asOf)
        ).map(row => row.partyId)
    )
}
// The organization's stores whose orders the caller reads in Commerce, read once a context: COMMERCE_VIEW and COMMERCE_ORDER_VIEW
// within Commerce's store scope (StoreAdmin.js: the user's organizations, a store staff member's own stores), as Commerce's order
// lists read them. An order with no store (a Sales order) is Sales' record and no purchase fact (P5 review).
function purchaseStores(ctx) {
    if (ctx.purchaseStoreIds === undefined) {
        ctx.purchaseStoreIds = []
        if (ec.user.userId && lib.access.has("COMMERCE_VIEW") && lib.access.has("COMMERCE_ORDER_VIEW")) {
            const storeAdmin = ec.resource.script("component://mr-mantle/service/mantle/product/StoreAdmin.js")
            ctx.purchaseStoreIds = Array.from(
                storeAdmin
                    .storeQuery(storeAdmin.scope("view"))
                    .condition("organizationPartyId", ctx.organizationPartyId)
                    .selectField("productStoreId")
                    .list()
            ).map(row => row.productStoreId)
        }
    }
    return ctx.purchaseStoreIds
}
const sources = {
    party: {
        label: "Party",
        readable: ctx => !!ctx.userScope.capabilities.anyRead,
        fields: {
            partyType: {
                type: "enum",
                label: "Kind",
                values: [
                    {value: "PtyPerson", label: "Person"},
                    {value: "PtyOrganization", label: "Organization"}
                ]
            },
            classification: {type: "ids", label: "Classification"},
            role: {type: "ids", label: "Role"}
        },
        facts(ctx, partyIds) {
            const facts = new Map()
            for (const party of rowsIn("mantle.party.Party", "partyId", partyIds))
                facts.set(party.partyId, {partyType: party.partyTypeEnumId || null, classification: [], role: []})
            for (const row of rowsIn("mantle.party.PartyClassificationAppl", "partyId", partyIds))
                if (lib.active(row, ctx.asOf)) facts.get(row.partyId)?.classification.push(row.partyClassificationId)
            for (const row of rowsIn("mantle.party.PartyRole", "partyId", partyIds))
                facts.get(row.partyId)?.role.push(row.roleTypeId)
            return facts
        }
    },
    contact: {
        label: "Contact",
        readable: ctx => !!ctx.userScope.capabilities.anyRead,
        fields: {
            hasEmail: {type: "boolean", label: "Has an email address"},
            hasPhone: {type: "boolean", label: "Has a phone number"},
            country: {type: "id", label: "Country"},
            stateProvince: {type: "id", label: "State or province"}
        },
        facts(ctx, partyIds) {
            const facts = new Map(
                partyIds.map(id => [id, {hasEmail: false, hasPhone: false, country: null, stateProvince: null}])
            )
            for (const info of rowsIn("mantle.party.contact.PartyContactMechInfo", "partyId", partyIds, {}, query =>
                query.conditionDate("fromDate", "thruDate", ctx.asOf)
            )) {
                const fact = facts.get(info.partyId)
                if (!fact) continue
                if (info.contactMechTypeEnumId === "CmtEmailAddress" && info.infoString) fact.hasEmail = true
                if (info.contactMechTypeEnumId === "CmtTelecomNumber") fact.hasPhone = true
            }
            const addresses = rowsIn("mantle.party.contact.PartyContactMechPostalAddressOnly", "partyId", partyIds, {}, query =>
                query.conditionDate("fromDate", "thruDate", ctx.asOf).orderBy("fromDate")
            )
            for (const [partyId, list] of groupBy(addresses, "partyId")) {
                const fact = facts.get(partyId)
                if (!fact) continue
                const address =
                    list.find(row => ["PostalPrimary", "PostalHome", "PostalShippingDest"].includes(row.contactMechPurposeId)) ||
                    list[0]
                fact.country = address.countryGeoId || null
                fact.stateProvince = address.stateProvinceGeoId || null
            }
            return facts
        }
    },
    purchase: {
        label: "Purchases",
        readable: ctx => purchaseStores(ctx).length > 0,
        fields: {
            orderCount: {type: "number", label: "Orders placed"},
            totalSpent: {type: "number", label: "Total spent, in the organization's currency"},
            lastOrderDate: {type: "date", label: "Last order"}
        },
        facts(ctx, partyIds) {
            const currency =
                one("mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: ctx.organizationPartyId})
                    ?.baseCurrencyUomId || null
            const facts = new Map(partyIds.map(id => [id, {orderCount: 0, totalSpent: 0, lastOrderDate: null}]))
            for (const order of rowsIn(
                "mantle.order.OrderHeaderAndPart",
                "customerPartyId",
                partyIds,
                {vendorPartyId: ctx.organizationPartyId},
                query =>
                    query
                        .condition("productStoreId", "in", purchaseStores(ctx))
                        .condition("statusId", "in", placedStatuses)
                        .condition("placedDate", "less-equals", ctx.asOf)
                        .selectField("orderId,customerPartyId,placedDate,grandTotal,currencyUomId,orderPurposeEnumId")
            )) {
                if (order.orderPurposeEnumId === "OrpSalesQuote") continue
                const fact = facts.get(order.customerPartyId)
                if (!fact) continue
                fact.orderCount += 1
                if (!currency || order.currencyUomId === currency) fact.totalSpent += num(order.grandTotal) || 0
                const placed = lib.ms(order.placedDate)
                if (placed != null && (fact.lastOrderDate == null || placed > fact.lastOrderDate)) fact.lastOrderDate = placed
            }
            return facts
        },
        discover(ctx) {
            return unique(
                bounded(
                    find("mantle.order.OrderHeaderAndPart", {vendorPartyId: ctx.organizationPartyId})
                        .condition("productStoreId", "in", purchaseStores(ctx))
                        .condition("statusId", "in", placedStatuses)
                        .selectField("customerPartyId")
                        .distinct(true)
                        .limit(universeCap + 1)
                        .list(),
                    "The organization's store customers"
                ).map(row => row.customerPartyId)
            )
        }
    },
    engagement: {
        label: "Engagement",
        readable: ctx => !!ctx.userScope.capabilities.anyRead,
        fields: {
            subscribedList: {type: "ids", label: "Subscribed list"},
            deliveryCount: {type: "number", label: "Messages delivered in the last year"},
            lastDeliveryDate: {type: "date", label: "Last message delivered"}
        },
        facts(ctx, partyIds) {
            const facts = new Map(partyIds.map(id => [id, {subscribedList: [], deliveryCount: 0, lastDeliveryDate: null}]))
            const listIds = organizationListIds(ctx.organizationPartyId)
            if (listIds.length)
                for (const row of rowsIn(CLP, "partyId", partyIds, {}, query =>
                    query
                        .condition("contactListId", "in", listIds)
                        .condition("statusId", "in", ["CLPT_ACCEPTED", "CLPT_IN_USE"])
                        .conditionDate("fromDate", "thruDate", ctx.asOf)
                ))
                    facts.get(row.partyId)?.subscribedList.push(row.contactListId)
            const since = new Date(lib.ms(ctx.asOf) - 365 * dayMs)
            for (const row of rowsIn(
                "mantle.party.MessageDelivery",
                "recipientPartyId",
                partyIds,
                {organizationPartyId: ctx.organizationPartyId, stateEnumId: "MdsSent"},
                query =>
                    query
                        .condition("sentDate", "greater-equals", since)
                        .condition("sentDate", "less-equals", ctx.asOf)
                        .selectField("deliveryId,recipientPartyId,sentDate")
            )) {
                const fact = facts.get(row.recipientPartyId)
                if (!fact) continue
                fact.deliveryCount += 1
                const sent = lib.ms(row.sentDate)
                if (fact.lastDeliveryDate == null || sent > fact.lastDeliveryDate) fact.lastDeliveryDate = sent
            }
            return facts
        }
    },
    salesLead: {
        label: "Sales leads",
        readable: salesReadable,
        fields: {
            openLead: {type: "boolean", label: "Has an open lead"},
            leadSource: {type: "ids", label: "Source of an open lead"},
            leadCampaign: {type: "ids", label: "Campaign of an open lead"}
        },
        facts(ctx, partyIds) {
            const deals = dealsOfParties(ctx, partyIds, "SotLead")
            return new Map(
                partyIds.map(id => {
                    const open = (deals.get(id) || []).filter(openDeal)
                    return [
                        id,
                        {
                            openLead: open.length > 0,
                            leadSource: unique(open.map(deal => deal.dataSourceId)),
                            leadCampaign: unique(open.map(deal => deal.marketingCampaignId))
                        }
                    ]
                })
            )
        },
        discover: ctx => dealContacts(ctx, "SotLead")
    },
    salesOpportunity: {
        label: "Sales opportunities",
        readable: salesReadable,
        fields: {
            openOpportunity: {type: "boolean", label: "Has an open opportunity"},
            wonOpportunity: {type: "boolean", label: "Has a won opportunity"},
            opportunityStage: {type: "ids", label: "Stage of an open opportunity"}
        },
        facts(ctx, partyIds) {
            const deals = dealsOfParties(ctx, partyIds, "SotOpportunity")
            return new Map(
                partyIds.map(id => {
                    const all = deals.get(id) || []
                    const open = all.filter(openDeal)
                    return [
                        id,
                        {
                            openOpportunity: open.length > 0,
                            wonOpportunity: all.some(deal => deal.statusId === "SalesOppWon"),
                            opportunityStage: unique(open.map(deal => deal.opportunityStageId))
                        }
                    ]
                })
            )
        },
        discover: ctx => dealContacts(ctx, "SotOpportunity")
    },
    salesAccount: {
        label: "Sales accounts",
        readable: salesReadable,
        fields: {
            accountContact: {type: "boolean", label: "Is an account or one's contact"}
        },
        facts(ctx, partyIds) {
            // an account the caller sees (SalesAccess accountOf) of the organization or shared, or a contact of one
            const ofOrganization = account =>
                !!account && (account.shared || account.organizationPartyId === ctx.organizationPartyId)
            return new Map(
                partyIds.map(id => [
                    id,
                    {
                        accountContact:
                            ofOrganization(ctx.salesAccess.accountOf(ctx.salesScope, id)) ||
                            ctx.salesAccess.contactAccounts(ctx.salesScope, id).some(ofOrganization)
                    }
                ])
            )
        }
    }
}
// The sources and fields a caller may build a filter on in an organization, for the filter editor.
function describeSources(ctx) {
    return Object.entries(sources)
        .filter(([, source]) => source.readable(ctx))
        .map(([key, source]) => ({
            source: key,
            label: source.label,
            fields: Object.entries(source.fields).map(([field, definition]) => ({
                field,
                key: key + "." + field,
                label: source.label + " · " + definition.label,
                type: definition.type,
                operators: operatorsByType[definition.type],
                values: definition.values || null
            }))
        }))
}

// ===== the saved filter: parse, check, describe and evaluate =====
// A filter as stored (JSON text or a map) checked against the registry: its structure, sizes, operators and typed values; with
// ctx, every source readable by the caller (SOURCE_UNAVAILABLE). Answers the normalized tree.
function parseFilter(value, ctx) {
    const tree = typeof value === "string" ? lib.json(value, null) : value
    if (!tree || typeof tree !== "object") denied("FILTER_INVALID", "A filter is a group of conditions")
    let count = 0
    const node = (item, depth) => {
        if (item && Array.isArray(item.conditions)) {
            if (depth > filterLimits.depth) denied("FILTER_INVALID", "Groups go at most " + filterLimits.depth + " deep")
            const match = item.match === "any" ? "any" : "all"
            if (item.match != null && !["all", "any"].includes(item.match))
                denied("FILTER_INVALID", "A group matches all or any of its conditions")
            if (!item.conditions.length) denied("FILTER_INVALID", "A group holds at least one condition")
            return {match, conditions: item.conditions.map(child => node(child, depth + 1))}
        }
        count += 1
        if (count > filterLimits.conditions)
            denied("FILTER_INVALID", "A filter holds at most " + filterLimits.conditions + " conditions")
        const sourceKey = text(item?.source)
        const source = Object.hasOwn(sources, sourceKey) ? sources[sourceKey] : null
        if (!source) denied("FILTER_INVALID", "Unknown source " + sourceKey)
        const fieldKey = text(item.field)
        const definition = Object.hasOwn(source.fields, fieldKey) ? source.fields[fieldKey] : null
        if (!definition) denied("FILTER_INVALID", "Unknown field " + sourceKey + "." + fieldKey)
        if (ctx && !source.readable(ctx)) denied("SOURCE_UNAVAILABLE", source.label + " are not open to you in this organization")
        const operator = text(item.operator)
        if (!operatorsByType[definition.type].includes(operator))
            denied("FILTER_INVALID", "Operator " + operator + " does not apply to " + definition.label)
        return {source: sourceKey, field: fieldKey, operator, value: typedValue(definition, operator, item.value)}
    }
    const root = node(tree.conditions ? tree : {match: "all", conditions: [tree]}, 1)
    return root
}
function typedValue(definition, operator, value) {
    const invalid = () => denied("VALUE_INVALID", "The value does not suit " + definition.label)
    if (definition.type === "boolean") {
        if ([true, "true", "Y", "y", "yes"].includes(value)) return true
        if ([false, "false", "N", "n", "no"].includes(value)) return false
        return invalid()
    }
    if (definition.type === "number") {
        const number = Number(value)
        if (blank(value) || !Number.isFinite(number)) invalid()
        return number
    }
    if (definition.type === "date") {
        if (operator === "within-days") {
            const days = Number(value)
            if (!Number.isInteger(days) || days < 1 || days > 3650) invalid()
            return days
        }
        const stamp = lib.ms(value)
        if (stamp == null || !Number.isFinite(stamp)) invalid()
        return stamp
    }
    const many = ["in", "not-in", "includes", "excludes"].includes(operator)
    const values = listOf(value)
    if (!values.length || values.length > filterLimits.values || values.some(item => item.length > 60)) invalid()
    if (definition.values && values.some(item => !definition.values.some(option => option.value === item))) invalid()
    if (!many && values.length !== 1) invalid()
    return many ? values : values[0]
}
// The sources a filter names.
function filterSources(tree, found = new Set()) {
    if (!tree) return found
    if (tree.conditions) for (const child of tree.conditions) filterSources(child, found)
    else found.add(tree.source)
    return found
}
// A filter in words, for SegmentDetail and the explanation.
function describeFilter(tree) {
    if (!tree) return ""
    if (tree.conditions) {
        const parts = tree.conditions.map(child => (child.conditions ? "(" + describeFilter(child) + ")" : describeFilter(child)))
        return parts.join(tree.match === "any" ? " or " : " and ")
    }
    const definition = sources[tree.source].fields[tree.field]
    const value = Array.isArray(tree.value)
        ? tree.value.join(", ")
        : definition.type === "date" && tree.operator !== "within-days"
          ? lib.dateText(new Date(tree.value))
          : String(tree.value)
    return sources[tree.source].label + " · " + definition.label + " " + operatorTexts[tree.operator] + " " + value
}
// Whether one condition holds for a value: a missing value (null) never does, whatever the operator.
function holds(condition, value, asOfMs) {
    if (value == null) return false
    const wanted = condition.value
    switch (condition.operator) {
        case "is":
            return value === wanted
        case "equals":
            return value === wanted
        case "not-equals":
            return value !== wanted
        case "greater":
            return value > wanted
        case "greater-equals":
            return value >= wanted
        case "less":
            return value < wanted
        case "less-equals":
            return value <= wanted
        case "before":
            return value < wanted
        case "after":
            return value > wanted
        case "within-days":
            return value >= asOfMs - wanted * dayMs && value <= asOfMs
        case "in":
            return wanted.includes(value)
        case "not-in":
            return !wanted.includes(value)
        case "includes":
            return value.some(item => wanted.includes(item))
        case "excludes":
            return !value.some(item => wanted.includes(item))
        default:
            throw new Error("Unknown operator " + condition.operator)
    }
}
// The parties of a set the filter matches, with the facts of each source it names read once for them.
function filterMatches(ctx, tree, partyIds) {
    const facts = {}
    for (const sourceKey of filterSources(tree)) facts[sourceKey] = sources[sourceKey].facts(ctx, partyIds)
    const asOfMs = lib.ms(ctx.asOf)
    const test = (node, partyId) => {
        if (node.conditions) {
            const results = node.conditions.map(child => test(child, partyId))
            return node.match === "any" ? results.some(Boolean) : results.every(Boolean)
        }
        const value = facts[node.source].get(partyId)?.[node.field]
        return holds(node, value === undefined ? null : value, asOfMs)
    }
    return new Set(partyIds.filter(partyId => test(tree, partyId)))
}

// ===== scope and records =====
function audienceScope(capability) {
    const userScope = marketingAccess.scope()
    if (!userScope.capabilities.audienceRead) denied("PERMISSION_DENIED", "Marketing audiences are not open to you")
    if (capability) marketingAccess.requireCapability(userScope, capability)
    return userScope
}
// A segment of the scope, else RECORD_UNAVAILABLE (missing, another organization's or unowned alike).
function segmentOfScope(userScope, marketSegmentId, lock = false) {
    const id = text(marketSegmentId)
    let query = id ? find(SEGMENT, {marketSegmentId: id}) : null
    if (query && lock) query = query.forUpdate(true)
    const row = query ? query.one() : null
    if (!row || !marketingAccess.covers(userScope, row.ownerPartyId))
        denied("RECORD_UNAVAILABLE", "Segment " + id + " is not available")
    return row
}
const archived = segment => segment.archivedDate != null && lib.ms(segment.archivedDate) <= lib.ms(ec.user.nowTimestamp)
function requireOpen(segment) {
    if (archived(segment)) denied("SEGMENT_ARCHIVED", "Segment " + segmentLabel(segment) + " is archived")
}
function requireRevision(row, expectedRevision, label) {
    if (blank(expectedRevision)) denied("REVISION_REQUIRED", "Name the revision of " + label + " you read")
    if (lib.ms(expectedRevision) !== lib.ms(row.lastUpdatedStamp))
        denied("STALE_REVISION", label + " changed since it was read; its revision is now " + lib.ms(row.lastUpdatedStamp))
}
const segmentLabel = segment => segment.segmentName || segment.description || segment.marketSegmentId
const kindOf = segment => (segment.segmentKindEnumId === kinds.explicit ? kinds.explicit : kinds.rule)
// The definition changed: its revision raised (so the segment's lastUpdatedStamp moves too).
function revise(segment, fields = {}) {
    call(
        "update#" + SEGMENT,
        Object.assign(
            {marketSegmentId: segment.marketSegmentId, definitionRevision: Number(segment.definitionRevision || 0) + 1},
            fields
        )
    )
}
// A parent a segment may name: a segment of the same organization, not archived, whose own parents never reach the segment.
function parentFor(userScope, parentId, organizationPartyId, marketSegmentId) {
    const id = text(parentId)
    if (!id) return null
    const parent = segmentOfScope(userScope, id)
    if (parent.ownerPartyId !== organizationPartyId) denied("RECORD_UNAVAILABLE", "Segment " + id + " is not available")
    requireOpen(parent)
    let current = parent
    for (let depth = 0; current; depth += 1) {
        if (marketSegmentId && current.marketSegmentId === marketSegmentId)
            denied("PARENT_CYCLE", "A segment cannot be inside itself, directly or through its parents")
        if (depth >= parentDepthCap) denied("PARENT_CYCLE", "Segments nest at most " + parentDepthCap + " deep")
        current = current.parentMarketSegmentId ? one(SEGMENT, {marketSegmentId: current.parentMarketSegmentId}) : null
    }
    return id
}
function storeFor(productStoreId, organizationPartyId) {
    const id = text(productStoreId)
    if (!id) return null
    const store = one("mantle.product.store.ProductStore", {productStoreId: id})
    if (!store || store.organizationPartyId !== organizationPartyId)
        denied("RECORD_UNAVAILABLE", "Store " + id + " is not available")
    return id
}
// The Marketing lists of an organization (never a mailbox).
const organizationListIds = organizationPartyId =>
    Array.from(
        find(LIST, {ownerPartyId: organizationPartyId})
            .condition("contactListTypeEnumId", "in", marketingListTypes)
            .selectField("contactListId")
            .list()
    ).map(row => row.contactListId)
// The current filter of a segment, or null.
const currentFilterRow = marketSegmentId =>
    Array.from(find(FILTER, {marketSegmentId}).orderBy("-fromDate").list()).find(row => lib.active(row)) || null
const filterAt = (marketSegmentId, asOf) =>
    Array.from(find(FILTER, {marketSegmentId}).orderBy("-fromDate").list()).find(row => lib.active(row, asOf)) || null

// ===== evaluation =====
// An evaluation context: the caller's scope, the organization and the time, with the Sales scope read once when a source needs it.
function context(userScope, organizationPartyId, asOf) {
    return {userScope, organizationPartyId, asOf: asOf || ec.user.nowTimestamp, segments: new Map()}
}
// Whether a party may be evaluated: it exists, is not disabled or merged and is not another user's personal contact. Map by id.
function inScopeParties(partyIds) {
    const found = new Map()
    for (const party of rowsIn("mantle.party.Party", "partyId", partyIds)) {
        if (party.disabled === "Y" || party.mergedToPartyId) continue
        if (party.privateOwnerUserId && party.privateOwnerUserId !== ec.user.userId) continue
        found.set(party.partyId, party)
    }
    return found
}
// The organization's audience a segment is evaluated over (see the head of this module), bounded.
function universe(ctx, extraPartyIds, filterTree) {
    const ids = new Set(extraPartyIds)
    const listIds = organizationListIds(ctx.organizationPartyId)
    if (listIds.length)
        for (const row of bounded(
            find(CLP)
                .condition("contactListId", "in", listIds)
                .conditionDate("fromDate", "thruDate", ctx.asOf)
                .selectField("partyId")
                .distinct(true)
                .limit(universeCap + 1)
                .list(),
            "The organization's lists"
        ))
            ids.add(row.partyId)
    const internal = new Set(
        Array.from(find("mantle.party.PartyRole", {roleTypeId: "OrgInternal"}).selectField("partyId").list()).map(
            row => row.partyId
        )
    )
    for (const row of bounded(
        find("mantle.party.Party", {ownerPartyId: ctx.organizationPartyId})
            .selectField("partyId")
            .limit(universeCap + 1)
            .list(),
        "The organization's own contacts"
    ))
        if (!internal.has(row.partyId)) ids.add(row.partyId)
    for (const sourceKey of filterSources(filterTree))
        if (sources[sourceKey].discover) for (const id of sources[sourceKey].discover(ctx)) ids.add(id)
    if (ids.size > universeCap)
        denied(
            "AUDIENCE_TOO_LARGE",
            "The organization's audience is larger than " + universeCap + " parties; narrow it with a list"
        )
    return Array.from(inScopeParties(Array.from(ids)).keys())
}
// Unit conversion of a dimension's value to the rule's unit (UomConversion either way), or null when they do not convert.
function converted(value, fromUomId, toUomId, asOf) {
    if (value == null) return null
    const number = num(value)
    if (!fromUomId || !toUomId || fromUomId === toUomId) return number
    const forward = rows("moqui.basic.UomConversion", {uomId: fromUomId, toUomId}).find(row => lib.active(row, asOf))
    if (forward) return number * (num(forward.conversionFactor) || 1) + (num(forward.conversionOffset) || 0)
    const reverse = rows("moqui.basic.UomConversion", {uomId: toUomId, toUomId: fromUomId}).find(row => lib.active(row, asOf))
    if (reverse) return (number - (num(reverse.conversionOffset) || 0)) / (num(reverse.conversionFactor) || 1)
    return null
}
// The native families a segment populates and the parties of a set each matches: {families: [{key, label, matched: Set}]}.
function nativeMatches(ctx, segment, partyIds) {
    const families = []
    const classifications = rows(CLASSIFICATION, {marketSegmentId: segment.marketSegmentId}).map(row => row.partyClassificationId)
    if (classifications.length) {
        const matched = new Set()
        for (const row of rowsIn("mantle.party.PartyClassificationAppl", "partyId", partyIds, {}, query =>
            query.condition("partyClassificationId", "in", classifications)
        ))
            if (lib.active(row, ctx.asOf)) matched.add(row.partyId)
        families.push({key: "classification", label: "classification", matched})
    }
    const geos = rows(GEO, {marketSegmentId: segment.marketSegmentId}).map(row => row.geoId)
    if (geos.length) {
        // a geography rule names an area, or a group of areas (its GeoAssoc members, one level)
        const areas = new Set(geos)
        for (const row of rowsIn("moqui.basic.GeoAssoc", "geoId", geos)) areas.add(row.toGeoId)
        const matched = new Set()
        for (const address of rowsIn("mantle.party.contact.PartyContactMechPostalAddressOnly", "partyId", partyIds, {}, query =>
            query.conditionDate("fromDate", "thruDate", ctx.asOf)
        ))
            if (
                ["countryGeoId", "stateProvinceGeoId", "countyGeoId", "cityGeoId", "postalCodeGeoId"].some(field =>
                    areas.has(address[field])
                )
            )
                matched.add(address.partyId)
        families.push({key: "geo", label: "geography", matched})
    }
    const dimensions = rows(DIMENSION, {marketSegmentId: segment.marketSegmentId})
    if (dimensions.length) {
        // each bound holds, inclusive, on the party's latest value of its dimension at the time, in the rule's unit
        const values = new Map()
        for (const row of rowsIn("mantle.party.PartyDimension", "partyId", partyIds, {}, query =>
            query
                .condition(
                    "uomDimensionTypeId",
                    "in",
                    dimensions.map(rule => rule.uomDimensionTypeId)
                )
                .condition("dimensionDate", "less-equals", ctx.asOf)
                .orderBy("-dimensionDate")
        )) {
            const key = row.partyId + "|" + row.uomDimensionTypeId
            if (!values.has(key)) values.set(key, row)
        }
        const matched = new Set()
        for (const partyId of partyIds)
            if (
                dimensions.every(rule => {
                    const row = values.get(partyId + "|" + rule.uomDimensionTypeId)
                    const value = row ? converted(row.value, row.uomId, rule.uomId || row.uomId, ctx.asOf) : null
                    if (value == null || !Number.isFinite(value)) return false
                    if (rule.minValue != null && value < num(rule.minValue)) return false
                    if (rule.maxValue != null && value > num(rule.maxValue)) return false
                    return true
                })
            )
                matched.add(partyId)
        families.push({key: "dimension", label: "dimension", matched})
    }
    return families
}
// The explicit members in effect at the time: {include: Set, exclude: Set}.
function explicitMembers(segment, asOf) {
    const include = new Set(),
        exclude = new Set()
    for (const row of rows(MEMBER, {marketSegmentId: segment.marketSegmentId})) {
        if (!lib.active(row, asOf)) continue
        if (row.memberKindEnumId === memberKinds.exclude) exclude.add(row.partyId)
        else include.add(row.partyId)
    }
    return {include, exclude}
}
// A segment evaluated in a context: {matched: Map partyId → reason text, excluded: Map partyId → reason text}, each segment once a
// context (a parent shared by two sources is evaluated once). Refuses a cycle (PARENT_CYCLE) and a filter source the caller cannot
// read (SOURCE_UNAVAILABLE), before any count.
function evaluate(ctx, segment, path = []) {
    if (ctx.segments.has(segment.marketSegmentId)) return ctx.segments.get(segment.marketSegmentId)
    if (path.includes(segment.marketSegmentId) || path.length >= parentDepthCap)
        denied("PARENT_CYCLE", "Segment " + segmentLabel(segment) + " is inside itself through its parents")
    const parent = segment.parentMarketSegmentId ? one(SEGMENT, {marketSegmentId: segment.parentMarketSegmentId}) : null
    const parentResult = parent ? evaluate(ctx, parent, path.concat([segment.marketSegmentId])) : null
    const explicit = explicitMembers(segment, ctx.asOf)
    const rule = kindOf(segment) === kinds.rule
    const filterRow = rule ? filterAt(segment.marketSegmentId, ctx.asOf) : null
    const tree = filterRow ? parseFilter(filterRow.filterJson, ctx) : null
    const candidates = universe(ctx, explicit.include, tree)
    const reasons = new Map()
    if (rule) {
        const families = nativeMatches(ctx, segment, candidates)
        const filtered = tree ? filterMatches(ctx, tree, candidates) : null
        if (families.length || filtered) {
            const label = families
                .map(family => family.label)
                .concat(filtered ? ["filter"] : [])
                .join(", ")
            for (const partyId of candidates)
                if (families.every(family => family.matched.has(partyId)) && (!filtered || filtered.has(partyId)))
                    reasons.set(partyId, "Rules: " + label)
        }
    }
    const inScope = new Set(candidates)
    for (const partyId of explicit.include)
        if (inScope.has(partyId)) reasons.set(partyId, reasons.has(partyId) ? reasons.get(partyId) + "; included" : "Included")
    const matched = new Map(),
        excluded = new Map()
    for (const [partyId, reason] of reasons) {
        if (explicit.exclude.has(partyId)) excluded.set(partyId, "Excluded explicitly")
        else if (parentResult && !parentResult.matched.has(partyId))
            excluded.set(partyId, "Outside the parent segment " + segmentLabel(parent))
        else matched.set(partyId, reason)
    }
    const result = {matched, excluded}
    ctx.segments.set(segment.marketSegmentId, result)
    return result
}
// The parties a segment matches in a context (for preview#Audience), a set.
const matchesOf = (ctx, segment) => new Set(evaluate(ctx, segment).matched.keys())

// ===== find#Segments, get#Segment =====
function segmentRow(segment, extra = {}) {
    const parent = segment.parentMarketSegmentId ? one(SEGMENT, {marketSegmentId: segment.parentMarketSegmentId}) : null
    return Object.assign(
        {
            marketSegmentId: segment.marketSegmentId,
            segmentName: segmentLabel(segment),
            description: segment.description || "",
            segmentKindEnumId: kindOf(segment),
            kindText: kindOf(segment) === kinds.explicit ? "Explicit members" : "Rules",
            ownerPartyId: segment.ownerPartyId,
            organizationName: organizationName(segment.ownerPartyId),
            parentMarketSegmentId: segment.parentMarketSegmentId || null,
            parentName: parent ? segmentLabel(parent) : "",
            productStoreId: segment.productStoreId || null,
            storeName: segment.productStoreId
                ? one("mantle.product.store.ProductStore", {productStoreId: segment.productStoreId})?.storeName ||
                  segment.productStoreId
                : "",
            archived: archived(segment),
            stateText: archived(segment) ? "Archived" : "Active",
            stateColor: archived(segment) ? "grey-7" : "positive",
            definitionRevision: Number(segment.definitionRevision || 0),
            revision: lib.ms(segment.lastUpdatedStamp)
        },
        extra
    )
}
function ruleSummary(marketSegmentId) {
    const counts = [
        [find(CLASSIFICATION, {marketSegmentId}).count(), "classification"],
        [find(GEO, {marketSegmentId}).count(), "geography"],
        [find(DIMENSION, {marketSegmentId}).count(), "dimension"]
    ]
        .filter(([count]) => count > 0)
        .map(([count, label]) => count + " " + label + (count > 1 ? (label === "geography" ? " rows" : "s") : ""))
    if (currentFilterRow(marketSegmentId)) counts.push("a filter")
    return counts.join(", ")
}
const currentMemberCount = (marketSegmentId, kind) =>
    rows(MEMBER, {marketSegmentId}).filter(
        row => lib.active(row) && (row.memberKindEnumId === memberKinds.exclude) === (kind === memberKinds.exclude)
    ).length
function findSegments(p) {
    const userScope = audienceScope()
    let ids = marketingAccess.organizationIds(userScope)
    if (text(p.organizationPartyId)) {
        marketingAccess.requireOrganization(userScope, p.organizationPartyId)
        ids = [text(p.organizationPartyId)]
    }
    if (!ids.length) return lib.pageList([], p, "segmentList")
    const factory = ec.entity.conditionFactory
    let query = find(SEGMENT).condition("ownerPartyId", "in", ids).orderBy("^segmentName").orderBy("^description")
    if (text(p.text))
        query = query.condition(
            factory.makeCondition(
                ["marketSegmentId", "segmentName", "description"].map(field =>
                    factory.makeCondition(field, "like", "%" + text(p.text) + "%").ignoreCase()
                ),
                "or"
            )
        )
    if (text(p.segmentKindEnumId) === kinds.explicit) query = query.condition("segmentKindEnumId", kinds.explicit)
    else if (text(p.segmentKindEnumId) === kinds.rule)
        query = query.condition(factory.makeCondition("segmentKindEnumId", "not-equals", kinds.explicit, true))
    if (text(p.parentMarketSegmentId)) query = query.condition("parentMarketSegmentId", text(p.parentMarketSegmentId))
    if (text(p.productStoreId)) query = query.condition("productStoreId", text(p.productStoreId))
    const state = text(p.archived) || "N"
    if (state === "N") query = query.condition(factory.makeCondition("archivedDate", "greater", ec.user.nowTimestamp, true))
    else if (state === "Y") query = query.condition("archivedDate", "less-equals", ec.user.nowTimestamp)
    const count = query.count()
    const paged = lib.page(query, p, "segmentList", count, {noLimitCap: 1000})
    paged.segmentList = paged.rows.map(segment =>
        segmentRow(segment, {
            rulesText: kindOf(segment) === kinds.explicit ? "" : ruleSummary(segment.marketSegmentId),
            includedCount: currentMemberCount(segment.marketSegmentId, memberKinds.include),
            excludedCount: currentMemberCount(segment.marketSegmentId, memberKinds.exclude)
        })
    )
    return paged
}
function getSegment(p) {
    const userScope = audienceScope()
    const segment = segmentOfScope(userScope, p.marketSegmentId)
    const id = segment.marketSegmentId
    const ctx = context(userScope, segment.ownerPartyId)
    const classifications = rows(CLASSIFICATION, {marketSegmentId: id}).map(row => ({
        partyClassificationId: row.partyClassificationId,
        label:
            one("mantle.party.PartyClassification", {partyClassificationId: row.partyClassificationId})?.description ||
            row.partyClassificationId
    }))
    const geos = rows(GEO, {marketSegmentId: id}).map(row => ({
        geoId: row.geoId,
        label: one("moqui.basic.Geo", {geoId: row.geoId})?.geoName || row.geoId
    }))
    const dimensions = rows(DIMENSION, {marketSegmentId: id}).map(row => ({
        uomDimensionTypeId: row.uomDimensionTypeId,
        label:
            one("moqui.basic.UomDimensionType", {uomDimensionTypeId: row.uomDimensionTypeId})?.description ||
            row.uomDimensionTypeId,
        uomId: row.uomId || null,
        uomText: row.uomId ? one("moqui.basic.Uom", {uomId: row.uomId})?.abbreviation || row.uomId : "",
        minValue: row.minValue == null ? null : String(num(row.minValue)),
        maxValue: row.maxValue == null ? null : String(num(row.maxValue)),
        boundsText: [
            row.minValue != null ? "at least " + String(num(row.minValue)) : null,
            row.maxValue != null ? "at most " + String(num(row.maxValue)) : null
        ]
            .filter(Boolean)
            .join(" and ")
    }))
    const filterRow = currentFilterRow(id)
    // the filter as stored, described; its conditions listed for the editor, each marked when the caller cannot read its source
    let filter = null
    if (filterRow) {
        const tree = parseFilter(filterRow.filterJson, null)
        const conditions = (tree.conditions || []).map((node, index) => ({
            index,
            text: node.conditions ? "(" + describeFilter(node) + ")" : describeFilter(node),
            readable: Array.from(filterSources(node)).every(key => sources[key].readable(ctx))
        }))
        filter = {
            match: tree.match,
            matchText: tree.match === "any" ? "any" : "all",
            text: describeFilter(tree),
            conditions,
            readable: conditions.every(condition => condition.readable),
            fromText: lib.dateText(filterRow.fromDate)
        }
    }
    const filterHistory = Array.from(find(FILTER, {marketSegmentId: id}).orderBy("-fromDate").limit(20).list()).map(row => ({
        fromText: lib.dateText(row.fromDate),
        thruText: lib.dateText(row.thruDate),
        text: describeFilter(parseFilter(row.filterJson, null)),
        changedBy: row.changedByUserId
            ? one("moqui.security.UserAccount", {userId: row.changedByUserId})?.userFullName || row.changedByUserId
            : ""
    }))
    const memberRows = Array.from(find(MEMBER, {marketSegmentId: id}).orderBy("-fromDate").limit(200).list())
    const names = lib.partyNames(memberRows.map(row => row.partyId))
    const members = memberRows
        .filter(row => names[row.partyId])
        .map(row => ({
            partyId: row.partyId,
            partyName: names[row.partyId],
            roleTypeId: row.roleTypeId,
            memberKindEnumId: row.memberKindEnumId === memberKinds.exclude ? memberKinds.exclude : memberKinds.include,
            kindText: row.memberKindEnumId === memberKinds.exclude ? "Exclude" : "Include",
            kindColor: row.memberKindEnumId === memberKinds.exclude ? "negative" : "positive",
            fromText: lib.dateText(row.fromDate),
            thruText: lib.dateText(row.thruDate),
            current: lib.active(row),
            comments: row.comments || "",
            revision: lib.ms(row.lastUpdatedStamp)
        }))
    const editable = !!userScope.capabilities.audienceEdit && !archived(segment)
    return {
        segment: segmentRow(segment),
        classifications,
        geos,
        dimensions,
        filter,
        filterHistory,
        members,
        sources: describeSources(ctx),
        capabilities: {canEdit: editable, canArchive: editable, canDuplicate: !!userScope.capabilities.audienceEdit}
    }
}

// ===== store#Segment, archive#Segment, duplicate#Segment =====
function kindFor(value) {
    const kind = text(value) || kinds.rule
    if (!Object.values(kinds).includes(kind)) denied("KIND_INVALID", "A segment is defined by rules or by explicit members")
    return kind
}
function storeSegment(p) {
    const userScope = audienceScope("audienceEdit")
    const name = Object.hasOwn(p, "segmentName") ? text(p.segmentName) : null
    if (!text(p.marketSegmentId)) {
        const organizationPartyId = marketingAccess.requireOrganization(userScope, text(p.organizationPartyId))
        if (!name) denied("NAME_REQUIRED", "Give the segment a name")
        const made = call("create#" + SEGMENT, {
            marketSegmentTypeEnumId: "MARKET_SEGMENT",
            segmentName: name,
            description: text(p.description) || null,
            segmentKindEnumId: kindFor(p.segmentKindEnumId),
            parentMarketSegmentId: parentFor(userScope, p.parentMarketSegmentId, organizationPartyId, null),
            productStoreId: storeFor(p.productStoreId, organizationPartyId),
            ownerPartyId: organizationPartyId,
            createdByUserId: ec.user.userId || null,
            definitionRevision: 1
        })
        return {marketSegmentId: made.marketSegmentId}
    }
    const segment = segmentOfScope(userScope, p.marketSegmentId, true)
    requireOpen(segment)
    requireRevision(segment, p.expectedRevision, "segment " + segment.marketSegmentId)
    const fields = {}
    if (name != null) {
        if (!name) denied("NAME_REQUIRED", "Give the segment a name")
        fields.segmentName = name
    }
    if (Object.hasOwn(p, "description")) fields.description = text(p.description) || null
    if (Object.hasOwn(p, "productStoreId")) fields.productStoreId = storeFor(p.productStoreId, segment.ownerPartyId)
    let definitionChanged = false
    if (!blank(p.segmentKindEnumId) && kindFor(p.segmentKindEnumId) !== kindOf(segment)) {
        fields.segmentKindEnumId = kindFor(p.segmentKindEnumId)
        definitionChanged = true
    }
    if (Object.hasOwn(p, "parentMarketSegmentId")) {
        const parentId = parentFor(userScope, p.parentMarketSegmentId, segment.ownerPartyId, segment.marketSegmentId)
        if (parentId !== (segment.parentMarketSegmentId || null)) {
            fields.parentMarketSegmentId = parentId
            definitionChanged = true
        }
    }
    if (definitionChanged) revise(segment, fields)
    else call("update#" + SEGMENT, Object.assign({marketSegmentId: segment.marketSegmentId}, fields))
    return {marketSegmentId: segment.marketSegmentId}
}
function archiveSegment(p) {
    const userScope = audienceScope("audienceEdit")
    const segment = segmentOfScope(userScope, p.marketSegmentId, true)
    requireRevision(segment, p.expectedRevision, "segment " + segment.marketSegmentId)
    if (archived(segment)) return {marketSegmentId: segment.marketSegmentId, archived: false}
    // a segment another open segment names as its parent keeps its children's meaning: refused until they move
    const children = Array.from(find(SEGMENT, {parentMarketSegmentId: segment.marketSegmentId}).list()).filter(
        row => !archived(row)
    )
    if (children.length)
        denied(
            "SEGMENT_IN_USE",
            "Segment " + segmentLabel(segment) + " is the parent of " + children.map(segmentLabel).join(", ")
        )
    call("update#" + SEGMENT, {
        marketSegmentId: segment.marketSegmentId,
        archivedDate: ec.user.nowTimestamp,
        archivedDate_changeReason: text(p.reason) || "Archived"
    })
    return {marketSegmentId: segment.marketSegmentId, archived: true}
}
function duplicateSegment(p) {
    const userScope = audienceScope("audienceEdit")
    const segment = segmentOfScope(userScope, p.marketSegmentId)
    // the copy is stored by the caller, so its filter's sources must be theirs to read, as store#SegmentFilter asks (P5 review)
    const filterRow = currentFilterRow(segment.marketSegmentId)
    if (filterRow) parseFilter(filterRow.filterJson, context(userScope, segment.ownerPartyId))
    const made = call("create#" + SEGMENT, {
        marketSegmentTypeEnumId: segment.marketSegmentTypeEnumId || "MARKET_SEGMENT",
        segmentName: text(p.segmentName) || "Copy of " + segmentLabel(segment),
        description: segment.description || null,
        segmentKindEnumId: kindOf(segment),
        parentMarketSegmentId:
            segment.parentMarketSegmentId && !archived(one(SEGMENT, {marketSegmentId: segment.parentMarketSegmentId}))
                ? segment.parentMarketSegmentId
                : null,
        productStoreId: segment.productStoreId || null,
        ownerPartyId: segment.ownerPartyId,
        createdByUserId: ec.user.userId || null,
        definitionRevision: 1
    })
    const id = made.marketSegmentId
    const now = ec.user.nowTimestamp
    for (const row of rows(CLASSIFICATION, {marketSegmentId: segment.marketSegmentId}))
        call("create#" + CLASSIFICATION, {marketSegmentId: id, partyClassificationId: row.partyClassificationId})
    for (const row of rows(GEO, {marketSegmentId: segment.marketSegmentId}))
        call("create#" + GEO, {marketSegmentId: id, geoId: row.geoId})
    for (const row of rows(DIMENSION, {marketSegmentId: segment.marketSegmentId}))
        call("create#" + DIMENSION, {
            marketSegmentId: id,
            uomDimensionTypeId: row.uomDimensionTypeId,
            uomId: row.uomId,
            minValue: row.minValue,
            maxValue: row.maxValue
        })
    if (filterRow)
        call("create#" + FILTER, {
            marketSegmentId: id,
            fromDate: now,
            filterJson: filterRow.filterJson,
            changedByUserId: ec.user.userId || null
        })
    for (const row of rows(MEMBER, {marketSegmentId: segment.marketSegmentId}).filter(row => lib.active(row)))
        call("create#" + MEMBER, {
            marketSegmentId: id,
            partyId: row.partyId,
            roleTypeId: row.roleTypeId,
            fromDate: now,
            memberKindEnumId: row.memberKindEnumId || memberKinds.include,
            comments: row.comments
        })
    return {marketSegmentId: id}
}

// ===== store#SegmentRules =====
// One change of the native rules at the segment's revision: add or remove a classification or a geography; store or remove a
// dimension's bounds (its unit, and at least one of min and max, min no more than max). The definition's revision rises.
function storeSegmentRules(p) {
    const userScope = audienceScope("audienceEdit")
    const segment = segmentOfScope(userScope, p.marketSegmentId, true)
    requireOpen(segment)
    requireRevision(segment, p.expectedRevision, "segment " + segment.marketSegmentId)
    if (kindOf(segment) === kinds.explicit) denied("KIND_INVALID", "A segment of explicit members has no rules")
    const id = segment.marketSegmentId
    const action = text(p.action)
    if (action === "addClassification" || action === "removeClassification") {
        const partyClassificationId = text(p.partyClassificationId)
        if (!one("mantle.party.PartyClassification", {partyClassificationId}))
            denied("RULE_INVALID", "Unknown classification " + partyClassificationId)
        const existing = one(CLASSIFICATION, {marketSegmentId: id, partyClassificationId})
        if (action === "addClassification" && !existing)
            call("create#" + CLASSIFICATION, {marketSegmentId: id, partyClassificationId})
        if (action === "removeClassification" && existing)
            call("delete#" + CLASSIFICATION, {marketSegmentId: id, partyClassificationId})
    } else if (action === "addGeo" || action === "removeGeo") {
        const geoId = text(p.geoId)
        if (!one("moqui.basic.Geo", {geoId})) denied("RULE_INVALID", "Unknown geography " + geoId)
        const existing = one(GEO, {marketSegmentId: id, geoId})
        if (action === "addGeo" && !existing) call("create#" + GEO, {marketSegmentId: id, geoId})
        if (action === "removeGeo" && existing) call("delete#" + GEO, {marketSegmentId: id, geoId})
    } else if (action === "storeDimension" || action === "removeDimension") {
        const uomDimensionTypeId = text(p.uomDimensionTypeId)
        const type = one("moqui.basic.UomDimensionType", {uomDimensionTypeId})
        if (!type) denied("RULE_INVALID", "Unknown dimension " + uomDimensionTypeId)
        const existing = one(DIMENSION, {marketSegmentId: id, uomDimensionTypeId})
        if (action === "removeDimension") {
            if (existing) call("delete#" + DIMENSION, {marketSegmentId: id, uomDimensionTypeId})
        } else {
            const minValue = blank(p.minValue) ? null : num(p.minValue)
            const maxValue = blank(p.maxValue) ? null : num(p.maxValue)
            if (minValue == null && maxValue == null) denied("RULE_INVALID", "Give a minimum, a maximum or both")
            if ((minValue != null && !Number.isFinite(minValue)) || (maxValue != null && !Number.isFinite(maxValue)))
                denied("RULE_INVALID", "A bound is a number")
            if (minValue != null && maxValue != null && minValue > maxValue)
                denied("RULE_INVALID", "The minimum is more than the maximum")
            const uomId = text(p.uomId) || type.defaultUomId || null
            if (uomId && !one("moqui.basic.Uom", {uomId})) denied("RULE_INVALID", "Unknown unit " + uomId)
            const values = {marketSegmentId: id, uomDimensionTypeId, uomId, minValue, maxValue}
            call((existing ? "update#" : "create#") + DIMENSION, values)
        }
    } else denied("RULE_INVALID", "Unknown rule change " + action)
    revise(segment)
    return {marketSegmentId: id}
}

// ===== store#SegmentFilter =====
// The saved filter at the segment's revision, as a new dated row (the one in effect ended): replace with a whole filter, add a
// condition, remove the top-level condition at an index, set whether the top group matches all or any, or clear. Each source the
// filter names must be readable by the caller (SOURCE_UNAVAILABLE), so an editor never stores a condition they could not evaluate.
function storeSegmentFilter(p) {
    const userScope = audienceScope("audienceEdit")
    const segment = segmentOfScope(userScope, p.marketSegmentId, true)
    requireOpen(segment)
    requireRevision(segment, p.expectedRevision, "segment " + segment.marketSegmentId)
    if (kindOf(segment) === kinds.explicit) denied("KIND_INVALID", "A segment of explicit members has no filter")
    const ctx = context(userScope, segment.ownerPartyId)
    const current = currentFilterRow(segment.marketSegmentId)
    const tree = current ? parseFilter(current.filterJson, null) : {match: "all", conditions: []}
    const action = text(p.action) || "replace"
    let next
    if (action === "replace") next = blank(p.filter) ? null : parseFilter(p.filter, ctx)
    else if (action === "clear") next = null
    else if (action === "addCondition") {
        const key = text(p.fieldKey)
        const [source, field] = key.includes(".") ? key.split(".") : [text(p.source), text(p.field)]
        next = parseFilter(
            {
                match: tree.match,
                conditions: tree.conditions.concat([{source, field, operator: text(p.operator), value: p.value}])
            },
            ctx
        )
    } else if (action === "removeCondition") {
        const index = Number(p.index)
        if (!Number.isInteger(index) || index < 0 || index >= tree.conditions.length)
            denied("RECORD_UNAVAILABLE", "That condition is not in the filter")
        const conditions = tree.conditions.filter((_, position) => position !== index)
        next = conditions.length ? parseFilter({match: tree.match, conditions}, ctx) : null
    } else if (action === "setMatch") {
        if (!tree.conditions.length) denied("FILTER_INVALID", "The filter has no condition")
        next = parseFilter({match: text(p.match) === "any" ? "any" : "all", conditions: tree.conditions}, ctx)
    } else denied("FILTER_INVALID", "Unknown filter change " + action)
    const now = ec.user.nowTimestamp
    if (current) call("update#" + FILTER, {marketSegmentId: segment.marketSegmentId, fromDate: current.fromDate, thruDate: now})
    if (next)
        call("create#" + FILTER, {
            marketSegmentId: segment.marketSegmentId,
            fromDate: now,
            filterJson: JSON.stringify(next),
            changedByUserId: ec.user.userId || null
        })
    revise(segment)
    return {marketSegmentId: segment.marketSegmentId, filterText: describeFilter(next)}
}

// ===== store#SegmentMember =====
// An explicit member, dated: add (include, the default, or exclude) from a date (now by default) until one (none by default), or
// end the member's row now. A party is one that exists, is not disabled or merged and is not another user's personal contact. The
// member row's revision is named when the row exists. An explicit member subscribes no one.
function storeSegmentMember(p) {
    const userScope = audienceScope("audienceEdit")
    const segment = segmentOfScope(userScope, p.marketSegmentId, true)
    requireOpen(segment)
    const partyId = text(p.partyId)
    if (!inScopeParties([partyId]).has(partyId)) denied("RECORD_UNAVAILABLE", "Party " + partyId + " is not available")
    const roleTypeId = text(p.roleTypeId) || "_NA_"
    const key = {marketSegmentId: segment.marketSegmentId, partyId, roleTypeId}
    const existing = find(MEMBER, key).forUpdate(true).one()
    if (existing) requireRevision(existing, p.expectedRevision, "the member " + partyId)
    const now = ec.user.nowTimestamp
    if ((text(p.action) || "add") === "end") {
        if (!existing || !lib.active(existing)) denied("RECORD_UNAVAILABLE", "Party " + partyId + " is not a current member")
        call("update#" + MEMBER, Object.assign({}, key, {thruDate: now}))
        return {ended: true}
    }
    const memberKindEnumId = text(p.memberKindEnumId) || memberKinds.include
    if (!Object.values(memberKinds).includes(memberKindEnumId)) denied("KIND_INVALID", "A member is included or excluded")
    const fromDate = blank(p.fromDate) ? now : new Date(lib.ms(p.fromDate))
    const thruDate = blank(p.thruDate) ? null : new Date(lib.ms(p.thruDate))
    if (thruDate && lib.ms(thruDate) <= lib.ms(fromDate)) denied("DATE_INVALID", "The member ends after it starts")
    const values = Object.assign({}, key, {fromDate, thruDate, memberKindEnumId, comments: text(p.comments) || null})
    call((existing ? "update#" : "create#") + MEMBER, values)
    return {ended: false}
}

// ===== evaluate#Segment =====
// A segment evaluated as of a time (now by default): the parties it matches, with the rule each matched by, and those its explicit
// exclusions or its parent leave out, with the reason; paged (show: matched, the default; excluded; all), names of the parties the
// caller may see. Nothing is stored and no one is subscribed.
function evaluateSegment(p) {
    const userScope = audienceScope()
    const segment = segmentOfScope(userScope, p.marketSegmentId)
    const asOf = asOfOf(p.asOf)
    const ctx = context(userScope, segment.ownerPartyId, asOf)
    const result = evaluate(ctx, segment)
    const show = ["excluded", "all"].includes(text(p.show)) ? text(p.show) : "matched"
    const all = []
    if (show !== "excluded") for (const [partyId, reason] of result.matched) all.push({partyId, matched: true, reason})
    if (show !== "matched") for (const [partyId, reason] of result.excluded) all.push({partyId, matched: false, reason})
    all.sort((a, b) => (a.matched === b.matched ? idOrder(a.partyId, b.partyId) : a.matched ? -1 : 1))
    const paged = lib.pageList(all, p, "evaluationList")
    const names = lib.partyNames(paged.evaluationList.map(row => row.partyId))
    paged.evaluationList = paged.evaluationList.map(row =>
        Object.assign(row, {
            partyName: names[row.partyId] || row.partyId,
            stateText: row.matched ? "Matched" : "Left out",
            stateColor: row.matched ? "positive" : "grey-7"
        })
    )
    return Object.assign(paged, {
        matchedCount: result.matched.size,
        excludedCount: result.excluded.size,
        evaluatedText: lib.dateText(asOf)
    })
}

const operations = {
    findSegments,
    getSegment,
    storeSegment,
    archiveSegment,
    duplicateSegment,
    storeSegmentRules,
    storeSegmentFilter,
    storeSegmentMember,
    evaluateSegment
}
;({
    sources,
    universeCap,
    kinds,
    memberKinds,
    context,
    segmentOfScope,
    segmentLabel,
    archived,
    matchesOf,
    parseFilter,
    describeFilter,
    describeSources,
    inScopeParties,
    rowsIn,
    bounded,
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown segment operation " + op)
        return operations[op](parameters || {})
    }
})
