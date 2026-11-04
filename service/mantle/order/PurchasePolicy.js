// Purchasing's buying policy and supplier check (design-purchasing PurchasePolicy and Supplier360; impl-purchasing P2, F34):
// dated PurchasePolicy rows of an organization, resolved field by field over the built-in defaults, and whether a supplier
// may be sent an RFQ or a purchase order (its profile's approval status and purchase block against the policy's Warn or
// Stop). A change ends the row in effect and starts the next, never earlier than now, so a document evaluated against a
// row keeps reading it by its time. Reading takes a purchasing permission and writing PURCHASE_POLICY_EDIT, each in the
// user's organizations (FacilityScope.js). The purchase rules of later phases (the approval gate's SECA, the order checks)
// read the policy through effective() and supplierUsable(), which check no permission. Disabled artifact authorization
// widens nothing here.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const {find, one, rows, call, denied, access, ms, map} = lib

const POLICY = "mantle.order.purchase.PurchasePolicy",
    PROFILE = "mantle.party.supplier.SupplierProfile"
// the permissions that read the policy: whoever buys, approves or keeps a supplier profile in the organization
const readPermissions = [
    "PURCHASE_POLICY_EDIT",
    "PURCHASE_ORDER_EDIT",
    "PURCHASE_APPROVE",
    "PURCHASE_ORDER_APPROVE",
    "SUPPLIER_PROFILE_EDIT"
]
const blank = value => value == null || String(value).trim() === ""
const iso = value => new Date(value).toISOString()
const current = (row, at) => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at
const yesNo = value => (value === "Y" ? "Yes" : value === "N" ? "No" : "")
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
function partyName(partyId) {
    if (!partyId) return ""
    const organization = one("mantle.party.Organization", {partyId})
    if (organization?.organizationName) return organization.organizationName
    const person = one("mantle.party.Person", {partyId})
    return (person ? [person.firstName, person.lastName].filter(Boolean).join(" ") : "") || partyId
}

// ===== the policy fields =====
// Each field: its group (the PurchasePolicy form: defaults or controls), label, kind and built-in default, Mantle's behavior
// with no row. The flags that change an existing Mantle service (the approval gate) default to N (impl-purchasing §2).
const fields = [
    {name: "currencyUomId", group: "defaults", label: "Currency", kind: "currency", default: null},
    {name: "priceListId", group: "defaults", label: "Purchase price list", kind: "priceList", default: null},
    {name: "facilityId", group: "defaults", label: "Receiving facility", kind: "facility", default: null},
    {name: "buyerPartyId", group: "defaults", label: "Default buyer", kind: "buyer", default: null},
    {name: "settlementTermId", group: "defaults", label: "Payment term", kind: "term", default: null},
    {name: "incotermEnumId", group: "defaults", label: "Incoterm", kind: "incoterm", default: null},
    {name: "rfqResponseDays", group: "controls", label: "RFQ response time", kind: "days", default: 7},
    {name: "quoteExpiryWarnDays", group: "controls", label: "Quote expiry warning", kind: "days", default: 7},
    {name: "reminderDays", group: "controls", label: "Acknowledgement reminder", kind: "days", default: 3},
    {name: "lockSentOrders", group: "controls", label: "Sent orders change by revision", kind: "indicator", default: "N"},
    {name: "supplierApprovalRequired", group: "controls", label: "New suppliers need approval", kind: "indicator", default: "N"},
    {
        name: "unapprovedSupplierEnumId",
        group: "controls",
        label: "Unapproved supplier",
        kind: "PurchaseUnapprovedSupplier",
        default: "PusWarn"
    },
    {name: "approvalGateEnabled", group: "controls", label: "Purchase approval gate", kind: "indicator", default: "N"},
    {name: "selfApprovalAllowed", group: "controls", label: "Buyers approve their own orders", kind: "indicator", default: "N"},
    // P3: the commercial revision (PurchaseOrderEntities.xml, increment#OrderRevision)
    {
        name: "commercialRevisionOnly",
        group: "controls",
        label: "Revisions count commercial changes only",
        kind: "indicator",
        default: "N"
    }
]
const fieldNames = fields.map(field => field.name)
const groupLabels = {defaults: "Buying defaults", controls: "Purchase controls"}

function valueText(field, value) {
    if (value == null || value === "") return field.kind === "indicator" || field.kind === "days" ? "" : "None"
    if (field.kind === "indicator") return yesNo(value)
    if (field.kind === "days") return String(value) + (Number(String(value)) === 1 ? " day" : " days")
    if (field.kind === "currency") return one("moqui.basic.Uom", {uomId: value})?.description || value
    if (field.kind === "priceList") return one("mantle.product.ProductPriceList", {priceListId: value})?.listName || value
    if (field.kind === "facility") return one("mantle.facility.Facility", {facilityId: value})?.facilityName || value
    if (field.kind === "buyer") return partyName(value)
    if (field.kind === "term")
        return one("mantle.account.invoice.SettlementTerm", {settlementTermId: value})?.description || value
    return enumText(value)
}

// ===== scope =====
// The organization a read or change is for, in the user's organizations: the given one, else the active one, else the
// user's first. It must be an internal organization.
function scopeOf(p) {
    const userScope = facilityScope.scope()
    if (!ec.user.userId || (!userScope.systemAdmin && ec.user.hasPermission("PROJECT_CLIENT")))
        denied("PERMISSION_DENIED", "The buying policy is not available")
    const organizationPartyId = blank(p.organizationPartyId)
        ? userScope.activeOrganizationPartyId || userScope.memberPartyIds[0] || null
        : String(p.organizationPartyId)
    if (
        !organizationPartyId ||
        !one("mantle.party.PartyRole", {partyId: organizationPartyId, roleTypeId: "OrgInternal"}) ||
        !facilityScope.owns(userScope, organizationPartyId)
    )
        denied("RECORD_UNAVAILABLE", "Organization " + (organizationPartyId || "") + " is not available")
    return {organizationPartyId, canEdit: access.has("PURCHASE_POLICY_EDIT")}
}
function requireRead() {
    if (!readPermissions.some(permission => access.has(permission)))
        denied("PERMISSION_DENIED", "A purchasing permission is required")
}
function requireEdit() {
    if (!access.has("PURCHASE_POLICY_EDIT")) denied("PERMISSION_DENIED", "PURCHASE_POLICY_EDIT is required")
}
function dateOf(value, label) {
    if (blank(value)) return ms(ec.user.nowTimestamp)
    const at = ms(value)
    if (!Number.isFinite(at)) denied("POLICY_INVALID", "Choose a valid " + label)
    return at
}

// ===== resolution =====
// The policy of an organization in effect at a time: the built-in defaults with the values the row in effect sets (an empty
// field takes the default), and that row (null when none). Internal: it checks no permission.
function effective(organizationPartyId, at) {
    const when = at == null || at === "" ? ms(ec.user.nowTimestamp) : ms(at)
    const policy = Object.fromEntries(fields.map(field => [field.name, field.default]))
    if (!organizationPartyId) return {policy, row: null}
    const row =
        rows(POLICY, {organizationPartyId})
            .filter(policyRow => current(policyRow, when))
            .sort((a, b) => ms(b.fromDate) - ms(a.fromDate))[0] || null
    if (row) for (const name of fieldNames) if (row[name] != null && row[name] !== "") policy[name] = row[name]
    return {policy, row}
}
function historyRow(row, at) {
    const set = fields.filter(field => row[field.name] != null && row[field.name] !== "")
    return Object.assign(map(row), {
        fromDateText: lib.dateText(row.fromDate),
        thruDateText: lib.dateText(row.thruDate),
        inEffect: current(row, at),
        summary: set.length ? set.map(field => field.label + " " + valueText(field, row[field.name])).join(", ") : "Nothing set"
    })
}
// get#PurchasePolicy: the policy in effect at the date with each value's source, the row in effect (the one a document
// keeps), the organization's rows and whether the user may change them.
function resolve(p) {
    requireRead()
    const scope = scopeOf(p)
    const at = dateOf(p.asOfDate, "policy date")
    const resolved = effective(scope.organizationPartyId, at)
    const all = rows(POLICY, {organizationPartyId: scope.organizationPartyId}).sort((a, b) => ms(b.fromDate) - ms(a.fromDate))
    const row = resolved.row
    const traceRows = fields.map(field => {
        const set = !!row && row[field.name] != null && row[field.name] !== ""
        return {
            field: field.name,
            group: field.group,
            groupLabel: groupLabels[field.group],
            fieldLabel: field.label,
            value: resolved.policy[field.name],
            valueText: valueText(field, resolved.policy[field.name]),
            level: set ? "organization" : "default",
            sourceText: set ? "Organization policy" : "Built-in default",
            fromDate: set ? row.fromDate : null,
            fromDateText: set ? lib.dateText(row.fromDate) : "",
            changeReason: set ? row.changeReason : null
        }
    })
    return {
        organizationPartyId: scope.organizationPartyId,
        organizationName: partyName(scope.organizationPartyId),
        asOfDate: iso(at),
        policy: resolved.policy,
        policyFromDate: row ? row.fromDate : null,
        traceRows,
        configuredPolicy: row ? map(row) : {},
        expectedFromDate: row ? row.fromDate : null,
        history: all.map(each => historyRow(each, at)),
        canEdit: scope.canEdit
    }
}

// ===== the change =====
function validate(data, organizationPartyId) {
    for (const field of fields) {
        const value = data[field.name]
        if (value == null) continue
        const invalid = () => denied("POLICY_INVALID", "Choose a valid " + field.label.toLowerCase())
        if (field.kind === "indicator") {
            if (!["Y", "N"].includes(value)) denied("POLICY_INVALID", "Choose Yes or No for " + field.label)
        } else if (field.kind === "days") {
            const number = Number(String(value))
            if (!Number.isInteger(number) || number < 0 || number > 3650)
                denied("POLICY_INVALID", field.label + " is a whole number of days from 0 to 3650")
        } else if (field.kind === "currency") {
            if (one("moqui.basic.Uom", {uomId: value})?.uomTypeEnumId !== "UT_CURRENCY_MEASURE") invalid()
        } else if (field.kind === "priceList") {
            const list = one("mantle.product.ProductPriceList", {priceListId: value})
            if (
                !list ||
                list.direction !== "purchase" ||
                (list.organizationPartyId && list.organizationPartyId !== organizationPartyId)
            )
                invalid()
        } else if (field.kind === "facility") {
            if (one("mantle.facility.Facility", {facilityId: value})?.ownerPartyId !== organizationPartyId) invalid()
        } else if (field.kind === "buyer") {
            const info = call("mantle.party.PartyServices.get#PartyOrganizationInfo", {partyId: value})
            if (!Array.from(info.userOrgIds || []).includes(organizationPartyId)) invalid()
        } else if (field.kind === "term") {
            if (!one("mantle.account.invoice.SettlementTerm", {settlementTermId: value})) invalid()
        } else if (field.kind === "incoterm") {
            if (one("moqui.basic.Enumeration", {enumId: value})?.parentEnumId !== "TtInco") invalid()
        } else if (one("moqui.basic.Enumeration", {enumId: value})?.enumTypeId !== field.kind) {
            invalid()
        }
    }
}
// store#PurchasePolicy: a dated change. The new row holds the values of the row in effect at its start with the changes (a
// given empty value takes the default again); the row in effect there ends at its start, and the new one ends where a later
// row starts. Refuses a stale expectedFromDate (POLICY_CHANGED), a start before now, a second row at the same time and an
// invalid value (POLICY_INVALID).
function store(p) {
    requireEdit()
    const scope = scopeOf(p)
    const why = String(p.changeReason || "").trim()
    if (!why) denied("POLICY_INVALID", "Give a reason for the policy change")
    const key = {organizationPartyId: scope.organizationPartyId}
    find("mantle.party.Party", {partyId: scope.organizationPartyId}).forUpdate(true).one()
    // now is read after the lock, so a change that waited on another starts after it and sees it (POLICY_CHANGED)
    const now = ms(ec.user.nowTimestamp)
    const all = rows(POLICY, key).sort((a, b) => ms(a.fromDate) - ms(b.fromDate))
    const inEffect = all.filter(row => current(row, now)).at(-1)
    if (ms(p.expectedFromDate) !== (inEffect ? ms(inEffect.fromDate) : null))
        denied("POLICY_CHANGED", "The buying policy changed; reload before saving")
    const at = blank(p.fromDate) ? Math.max(now, (inEffect ? ms(inEffect.fromDate) : 0) + 1) : dateOf(p.fromDate, "start")
    if (at < now) denied("POLICY_INVALID", "Policy changes take effect now or later")
    if (all.some(row => ms(row.fromDate) === at)) denied("POLICY_INVALID", "A buying policy already starts at this time")
    const before = all.filter(row => ms(row.fromDate) < at && (row.thruDate == null || ms(row.thruDate) > at)).at(-1),
        after = all.find(row => ms(row.fromDate) > at)
    const data = Object.fromEntries(fieldNames.map(name => [name, before ? (before[name] ?? null) : null]))
    // with a policy group (one PurchasePolicy form) only that group's fields change
    if (!blank(p.policyGroup) && !Object.hasOwn(groupLabels, p.policyGroup)) denied("POLICY_INVALID", "Unknown policy group")
    const changing = fields.filter(field => blank(p.policyGroup) || field.group === p.policyGroup).map(field => field.name)
    for (const name of changing) if (Object.keys(p).includes(name)) data[name] = blank(p[name]) ? null : String(p[name])
    validate(data, scope.organizationPartyId)
    ec.context.putAll(
        Object.fromEntries(["fromDate", "thruDate", ...fieldNames, "changeReason"].map(name => [name + "_changeReason", why]))
    )
    const fromDate = iso(at)
    if (before) call("update#" + POLICY, Object.assign({}, key, {fromDate: iso(ms(before.fromDate)), thruDate: fromDate}))
    call(
        "create#" + POLICY,
        Object.assign({}, key, data, {
            fromDate,
            thruDate: after ? iso(ms(after.fromDate)) : null,
            changeReason: why,
            changedByUserId: ec.user.userId
        })
    )
    return resolve({organizationPartyId: scope.organizationPartyId, asOfDate: fromDate})
}

// ===== the supplier check =====
// The organization's profile of a supplier in effect at a time, else null. Internal.
function profileAt(organizationPartyId, supplierPartyId, at) {
    return (
        rows(PROFILE, {organizationPartyId, supplierPartyId})
            .filter(row => current(row, at))
            .sort((a, b) => ms(b.fromDate) - ms(a.fromDate))[0] || null
    )
}
// Whether the organization may send the supplier an RFQ or a purchase order at a time (now by default): a purchase block in
// effect or a Suspended profile stops (SUPPLIER_BLOCKED, SUPPLIER_SUSPENDED); a supplier that is not Approved (Pending,
// Rejected, or no status where the policy requires approval) gets the policy's result, a warning by default or a stop
// (SUPPLIER_UNAPPROVED). result is OK, WARN or STOP; the policy row and the profile row are the ones the check read, for the
// document to keep. Internal: it checks no permission.
function supplierUsable(organizationPartyId, supplierPartyId, at) {
    const when = at == null || at === "" ? ms(ec.user.nowTimestamp) : ms(at)
    const {policy, row: policyRow} = effective(organizationPartyId, when)
    const profile = profileAt(organizationPartyId, supplierPartyId, when)
    const base = {
        organizationPartyId,
        supplierPartyId,
        approvalStatusId: profile?.approvalStatusId || null,
        supplierProfileId: profile?.supplierProfileId || null,
        policyFromDate: policyRow ? policyRow.fromDate : null,
        unapprovedSupplierEnumId: policy.unapprovedSupplierEnumId
    }
    const answer = (result, reasonCode, message) => Object.assign(base, {usable: result !== "STOP", result, reasonCode, message})
    const blockFrom = ms(profile?.purchaseBlockFromDate),
        blockThru = ms(profile?.purchaseBlockThruDate)
    if (profile && blockFrom != null && blockFrom <= when && (blockThru == null || blockThru > when))
        return answer(
            "STOP",
            "SUPPLIER_BLOCKED",
            "Purchasing from " +
                partyName(supplierPartyId) +
                " is blocked" +
                (profile.purchaseBlockReason ? ": " + profile.purchaseBlockReason : "")
        )
    const status = profile?.approvalStatusId || null
    if (status === "SupaSuspended")
        return answer(
            "STOP",
            "SUPPLIER_SUSPENDED",
            partyName(supplierPartyId) + " is suspended" + (profile.changeReason ? ": " + profile.changeReason : "")
        )
    const unapproved = status ? status !== "SupaApproved" : policy.supplierApprovalRequired === "Y"
    if (unapproved) {
        const statusText = status ? one("moqui.basic.StatusItem", {statusId: status})?.description || status : "Not approved"
        return answer(
            policy.unapprovedSupplierEnumId === "PusStop" ? "STOP" : "WARN",
            "SUPPLIER_UNAPPROVED",
            partyName(supplierPartyId) + " is not an approved supplier (" + statusText + ")"
        )
    }
    return answer("OK", null, null)
}
// check#SupplierUsable: the supplier check for a user who buys, approves or keeps profiles in the organization.
function checkSupplier(p) {
    requireRead()
    const scope = scopeOf(p)
    if (blank(p.supplierPartyId) || !one("mantle.party.Party", {partyId: p.supplierPartyId}))
        denied("SUPPLIER_UNAVAILABLE", "Choose an available supplier")
    return supplierUsable(scope.organizationPartyId, p.supplierPartyId, blank(p.asOfDate) ? null : dateOf(p.asOfDate, "date"))
}

const operations = {resolve, store, checkSupplier}
;({
    fields,
    // for the purchase rules of later phases and the supplier profile: no permission check
    effective,
    supplierUsable,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown purchase policy operation " + op)
        return operations[op](parameters)
    }
})
