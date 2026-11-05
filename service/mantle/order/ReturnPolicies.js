// Customer return policies and the authorization of customer returns (design-customer-service §5 Returns, NewReturn,
// ReturnDetail, Approvals, §9 ReturnPolicies; impl-customer-service P9, CS-RETURN-POLICY, CX-RETURNS, CX-APPROVAL; F21, F22,
// F24, F45, F46, F61): an organization's dated return policies and reason rows; the eligibility of a sale's lines under a
// lock per source order item, against what was shipped and invoiced less every earlier return that is not cancelled, drafts
// included; a customer's return entered by an agent (submit#CustomerReturn, save#ReturnItem) and its policy evaluation, kept
// on the return; the authorization (authorize#Return), which wraps Mantle's approve#Return (the return shipment), forces
// immediate responses off unless the policy and the actor's settlement authority allow them, settles nothing and stores the
// RMA as ReturnContent; an exception's approval on Purchasing's decision pattern (decide#ReturnException, the
// ReturnExceptionApproval topic, bound to the return's revision); a remainder closed and a return cancelled before any
// effect; the RMA print and its mail. Each operation checks its permission and the return's organization itself, reads and
// writes with artifact authorization off. Accounting settles (ReturnSettlement.js) and Warehouse receives (ReturnStock.js).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const {find, one, rows, call, denied, access, ms} = lib

const HEADER = "mantle.order.return.ReturnHeader",
    ITEM = "mantle.order.return.ReturnItem",
    POLICY = "mantle.order.return.ReturnPolicy",
    REASON = "mantle.order.return.ReturnReasonPolicy",
    PARTY = "mantle.order.return.ReturnParty",
    DECISION = "mantle.order.return.ReturnAuthorizationDecision",
    CONTENT = "mantle.order.return.ReturnContent",
    BILLING = "mantle.order.return.ReturnItemBilling"
const readPermissions = ["SUPPORT_CASE_EDIT", "RETURN_AUTHORIZE", "RETURN_EXCEPTION_APPROVE", "RETURN_POLICY_EDIT"]
const enterPermissions = ["SUPPORT_CASE_EDIT", "RETURN_AUTHORIZE"]
const amountPermissions = ["PRICE_VIEW", "ACCOUNTING_VIEW", "RECEIVABLE_VIEW"]
const openStatuses = ["ReturnCreated", "ReturnRequested"]
const authorizedStatuses = ["ReturnApproved", "ReturnShipped", "ReturnReceived", "ReturnManResp", "ReturnCompleted"]
const defaultResponses = ["RrspCredit", "RrspRefund", "RrspReplace"]
const defaultAuthorizationDays = 30
const dayMs = 86400000

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const yn = (value, fallback = "N") => (value === true || value === "Y" || value === "true" ? "Y" : blank(value) ? fallback : "N")
const flag = value => value === true || value === "Y" || value === "true"
const dec = value => toDecimal(value ?? 0)
const zero = () => toDecimal(0)
const qty = value => (dec(value).compare(0) === 0 ? "0" : ec.l10n.format(dec(value), "#,##0.###"))
const nowMs = () => Number(ms(ec.user.nowTimestamp))
const msOf = value => (value == null || value === "" ? null : Number(ms(value)))
const stamp = millis => (millis == null ? null : new Date(Number(millis)))
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "")
const partyName = partyId => (partyId ? lib.partyNames([partyId])[partyId] || partyId : "")
const isInternal = partyId => !!partyId && !!one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
const list = value =>
    (Array.isArray(value) ? value : String(value || "").split(",")).map(entry => String(entry).trim()).filter(Boolean)
const escapeHtml = value =>
    String(value ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[c])

// ===== access =====
function requirePermission(...permissions) {
    if (!permissions.some(permission => access.has(permission)))
        denied("PERMISSION_DENIED", permissions.join(" or ") + " is required")
}
function requireOrganization(organizationPartyId) {
    if (
        !organizationPartyId ||
        !isInternal(organizationPartyId) ||
        !facilityScope.owns(facilityScope.scope(), organizationPartyId)
    )
        denied("RECORD_UNAVAILABLE", "Organization " + (organizationPartyId || "") + " is not available")
    return String(organizationPartyId)
}
// A customer return of one of the user's organizations: its vendor internal and the user's, its customer not internal. A
// missing return, a supplier return and another organization's are refused alike (RECORD_UNAVAILABLE).
function customerReturn(returnId, lock = false) {
    const unavailable = () => denied("RECORD_UNAVAILABLE", "Return " + (returnId || "") + " is not available")
    const header = blank(returnId) ? null : lock ? find(HEADER, {returnId}).forUpdate(true).one() : one(HEADER, {returnId})
    if (!header || !isInternal(header.vendorPartyId) || isInternal(header.customerPartyId)) unavailable()
    if (!facilityScope.owns(facilityScope.scope(), header.vendorPartyId)) unavailable()
    return header
}
// A sales order of one of the user's organizations to a customer that is not internal.
function salesOrder(orderId, orderPartSeqId) {
    const unavailable = () => denied("RECORD_UNAVAILABLE", "Order " + (orderId || "") + " is not available")
    const order = blank(orderId) ? null : one("mantle.order.OrderHeader", {orderId})
    const parts = order ? rows("mantle.order.OrderPart", {orderId}) : []
    const part = orderPartSeqId ? parts.find(row => row.orderPartSeqId === orderPartSeqId) : parts[0]
    if (!part || !isInternal(part.vendorPartyId) || isInternal(part.customerPartyId)) unavailable()
    if (!facilityScope.owns(facilityScope.scope(), part.vendorPartyId)) unavailable()
    return {order, part}
}
// The return's revision: the last change of its header, items or parties, so a decision bound to it stops counting when any of
// them changes (STALE_REVISION).
function revisionOf(returnId) {
    let latest = Number(ms(one(HEADER, {returnId})?.lastUpdatedStamp) || 0)
    for (const entity of [ITEM, PARTY])
        for (const row of rows(entity, {returnId})) latest = Math.max(latest, Number(ms(row.lastUpdatedStamp) || 0))
    return String(latest)
}
function currentRows(entity, conditions, date = ec.user.nowTimestamp) {
    return Array.from(
        find(entity, conditions)
            .condition(ec.entity.conditionFactory.makeCondition("fromDate", "is-not-null", null))
            .conditionDate("fromDate", "thruDate", date)
            .orderBy("-fromDate")
            .list()
    )
}
const topItems = returnId =>
    rows(ITEM, {returnId})
        .filter(item => !item.parentItemSeqId && item.statusId !== "ReturnCancelled")
        .sort((a, b) => String(a.returnItemSeqId).localeCompare(String(b.returnItemSeqId)))
const assigneeOf = returnId => currentRows(PARTY, {returnId, roleTypeId: "Assignee"})[0]?.partyId || null

// ===== policies =====
// The rank of a policy: its most specific condition decides (category 4, customer group 2, store 1; the default 0).
const conditionFields = ["productCategoryId", "partyClassificationId", "productStoreId"]
const rankOf = row => (row.productCategoryId ? 4 : row.partyClassificationId ? 2 : row.productStoreId ? 1 : 0)
const rankText = row =>
    row.productCategoryId ? "Category" : row.partyClassificationId ? "Customer group" : row.productStoreId ? "Store" : "Default"
const sameConditions = (a, b) => conditionFields.every(field => (a[field] || null) === (b[field] || null))
function holds(policy, facts, date) {
    if (policy.productStoreId && policy.productStoreId !== facts.productStoreId) return false
    if (policy.partyClassificationId) {
        const applied = rows("mantle.party.PartyClassificationAppl", {
            partyId: facts.customerPartyId || "_NA_",
            partyClassificationId: policy.partyClassificationId
        }).some(row => lib.active(row, date))
        if (!applied) return false
    }
    if (policy.productCategoryId) {
        if (!facts.productId) return false
        const member = rows("mantle.product.category.ProductCategoryMember", {
            productCategoryId: policy.productCategoryId,
            productId: facts.productId
        }).some(row => lib.active(row, date))
        if (!member) return false
    }
    return true
}
// The policy of a line: the organization's published rows in effect whose conditions hold, the most specific first; null is
// manual review.
function selectPolicy(organizationPartyId, facts, date = ec.user.nowTimestamp) {
    const candidates = currentRows(POLICY, {organizationPartyId}, date).filter(row => holds(row, facts, date))
    return candidates.sort((a, b) => rankOf(b) - rankOf(a) || msOf(b.fromDate) - msOf(a.fromDate))[0] || null
}
const policyState = (row, now = nowMs()) =>
    !row.fromDate
        ? "Draft"
        : msOf(row.fromDate) > now
          ? "Scheduled"
          : row.thruDate && msOf(row.thruDate) <= now
            ? "Ended"
            : "In effect"
function conditionText(row) {
    const parts = []
    if (row.productCategoryId)
        parts.push(
            "category " +
                (one("mantle.product.category.ProductCategory", {productCategoryId: row.productCategoryId})?.categoryName ||
                    row.productCategoryId)
        )
    if (row.partyClassificationId)
        parts.push(
            "customer group " +
                (one("mantle.party.PartyClassification", {partyClassificationId: row.partyClassificationId})?.description ||
                    row.partyClassificationId)
        )
    if (row.productStoreId)
        parts.push(
            "store " +
                (one("mantle.product.store.ProductStore", {productStoreId: row.productStoreId})?.storeName || row.productStoreId)
        )
    return parts.length ? parts.join(", ") : "Every return (the organization's default)"
}
function feeText(row, currencyUomId) {
    if (row.restockFeePercent == null || dec(row.restockFeePercent).compare(0) <= 0) return "No restocking fee"
    const percent = ec.l10n.format(dec(row.restockFeePercent), "#,##0.##") + "% restocking fee"
    return row.restockFeeCap != null
        ? percent + ", at most " + ec.l10n.formatCurrency(dec(row.restockFeeCap), currencyUomId || "USD")
        : percent
}
function policyView(row, now = nowMs()) {
    return Object.assign(lib.map(row), {
        state: policyState(row, now),
        rank: rankOf(row),
        rankText: rankText(row),
        conditionText: conditionText(row),
        windowText:
            row.windowDays != null
                ? row.windowDays + " days from " + enumText(row.windowFromEnumId || "RpwDelivered").toLowerCase()
                : "No window: manual review",
        authorizationText: (row.authorizationDays ?? defaultAuthorizationDays) + " days",
        reasonsText: list(row.allowedReasonEnumIds).map(enumText).join(", ") || "Every reason",
        responsesText: (list(row.allowedResponseEnumIds).length ? list(row.allowedResponseEnumIds) : defaultResponses)
            .map(enumText)
            .join(", "),
        feeText: feeText(row),
        periodText: row.fromDate
            ? lib.dateText(row.fromDate) + (row.thruDate ? " – " + lib.dateText(row.thruDate) : " on")
            : "Not published"
    })
}
// find#Policies: an organization's return policies, the most specific first, with their state.
function findPolicies(p) {
    requirePermission(...readPermissions)
    const organizationPartyId = requireOrganization(p.organizationPartyId)
    const now = nowMs()
    let found = Array.from(find(POLICY, {organizationPartyId}).orderBy("-fromDate").list())
    if (p.returnPolicyId) found = found.filter(row => row.returnPolicyId === p.returnPolicyId)
    else if (!flag(p.includeEnded)) found = found.filter(row => policyState(row, now) !== "Ended")
    const policies = found
        .map(row => policyView(row, now))
        .sort((a, b) => b.rank - a.rank || String(a.policyName).localeCompare(String(b.policyName)))
    const reasons = currentRows(REASON, {organizationPartyId}).map(row =>
        Object.assign(lib.map(row), {
            reasonText: enumText(row.returnReasonEnumId),
            suggestedText: row.suggestedResponseEnumId ? enumText(row.suggestedResponseEnumId) : "",
            periodText: lib.dateText(row.fromDate) + (row.thruDate ? " – " + lib.dateText(row.thruDate) : " on")
        })
    )
    return {organizationPartyId, policies, reasons}
}
function checkPolicyFields(fields, organizationPartyId) {
    if (fields.productStoreId) {
        const store = one("mantle.product.store.ProductStore", {productStoreId: fields.productStoreId})
        if (!store || store.organizationPartyId !== organizationPartyId)
            denied("STORE_UNAVAILABLE", "Store " + fields.productStoreId + " is not one of the organization's")
    }
    if (
        fields.partyClassificationId &&
        !one("mantle.party.PartyClassification", {partyClassificationId: fields.partyClassificationId})
    )
        denied("CLASSIFICATION_UNKNOWN", fields.partyClassificationId + " is not a customer group")
    if (
        fields.productCategoryId &&
        !one("mantle.product.category.ProductCategory", {productCategoryId: fields.productCategoryId})
    )
        denied("CATEGORY_UNKNOWN", fields.productCategoryId + " is not a product category")
    if (fields.destinationFacilityId) {
        const facility = one("mantle.facility.Facility", {facilityId: fields.destinationFacilityId})
        if (!facility || facility.ownerPartyId !== organizationPartyId)
            denied("FACILITY_UNAVAILABLE", "Facility " + fields.destinationFacilityId + " is not one of the organization's")
    }
    if (
        fields.windowFromEnumId &&
        one("moqui.basic.Enumeration", {enumId: fields.windowFromEnumId})?.enumTypeId !== "ReturnWindowFrom"
    )
        denied("WINDOW_INVALID", fields.windowFromEnumId + " is not a return window start")
    for (const [field, typeId] of [
        ["allowedReasonEnumIds", "ReturnReason"],
        ["allowedResponseEnumIds", "ReturnResponse"]
    ])
        for (const enumId of list(fields[field]))
            if (one("moqui.basic.Enumeration", {enumId})?.enumTypeId !== typeId)
                denied("VALUE_INVALID", enumId + " is not a " + typeId)
    for (const field of ["windowDays", "authorizationDays"])
        if (fields[field] != null && !(Number.isInteger(fields[field]) && fields[field] > 0))
            denied("VALUE_INVALID", "Days are whole numbers above zero")
    if (
        fields.restockFeePercent != null &&
        (dec(fields.restockFeePercent).compare(0) < 0 || dec(fields.restockFeePercent).compare(100) > 0)
    )
        denied("VALUE_INVALID", "A restocking fee is a percent from 0 to 100")
    if (fields.restockFeeCap != null && dec(fields.restockFeeCap).compare(0) < 0)
        denied("VALUE_INVALID", "A fee cap is not negative")
    if (fields.exceptionUserGroupId && !one("moqui.security.UserGroup", {userGroupId: fields.exceptionUserGroupId}))
        denied("VALUE_INVALID", fields.exceptionUserGroupId + " is not a user group")
}
const intOf = value => (blank(value) ? null : Number(value))
const decOf = value => (blank(value) ? null : toDecimal(value))
const policyFields = {
    productStoreId: text,
    partyClassificationId: text,
    productCategoryId: text,
    windowDays: intOf,
    windowFromEnumId: text,
    authorizationDays: intOf,
    selfServiceEnabled: value => yn(value),
    allowedReasonEnumIds: value => list(value).join(",") || null,
    allowedResponseEnumIds: value => list(value).join(",") || null,
    proofRequired: value => yn(value),
    destinationFacilityId: text,
    exceptionUserGroupId: text,
    receiptlessEligible: value => yn(value),
    advanceReplacement: value => yn(value),
    instantCredit: value => yn(value),
    restockFeePercent: decOf,
    restockFeeCap: decOf,
    instructions: text
}
// save#Policy: a new row (from a date, or a draft), a draft changed or published, a row replaced from a date (the new row names
// it and it ends there), or a row ended; refuses two published rows with the same conditions over the same dates. A field not
// passed (null) keeps the row's; an empty one clears it.
function savePolicy(p) {
    requirePermission("RETURN_POLICY_EDIT")
    const existing = p.returnPolicyId ? one(POLICY, {returnPolicyId: p.returnPolicyId}) : null
    if (p.returnPolicyId && !existing) denied("RECORD_UNAVAILABLE", "Policy " + p.returnPolicyId + " is not available")
    const organizationPartyId = requireOrganization(existing?.organizationPartyId || p.organizationPartyId)
    if (existing && p.organizationPartyId && p.organizationPartyId !== existing.organizationPartyId)
        denied("RECORD_UNAVAILABLE", "A policy stays its organization's")
    const draft = flag(p.draft)
    const fromMs = draft ? null : (msOf(p.fromDate) ?? nowMs())
    if (flag(p.end)) {
        if (!existing || !existing.fromDate) denied("RECORD_UNAVAILABLE", "Only a published policy is ended")
        call("update#" + POLICY, {returnPolicyId: existing.returnPolicyId, thruDate: stamp(msOf(p.fromDate) ?? nowMs())})
        return {returnPolicyId: existing.returnPolicyId}
    }
    const fields = {}
    for (const [field, parse] of Object.entries(policyFields))
        fields[field] = p[field] != null ? parse(p[field]) : existing ? (existing[field] ?? null) : null
    checkPolicyFields(fields, organizationPartyId)
    const name = p.policyName != null ? text(p.policyName) : existing?.policyName
    if (!name) denied("NAME_REQUIRED", "A policy needs a name")
    fields.policyName = name.substring(0, 255)
    fields.changeReason = text(p.changeReason)
    const editDraft = existing && !existing.fromDate
    const replaces = editDraft ? existing.previousPolicyId || null : existing ? existing.returnPolicyId : null
    if (!draft) {
        const overlapping = currentRows(POLICY, {organizationPartyId}, stamp(fromMs))
            .concat(Array.from(find(POLICY, {organizationPartyId}).condition("fromDate", "greater", stamp(fromMs)).list()))
            .filter(row => row.returnPolicyId !== replaces && row.returnPolicyId !== existing?.returnPolicyId)
            .filter(row => sameConditions(row, fields))
        if (overlapping.length)
            denied(
                "EQUAL_RANK_OVERLAP",
                "Policy " +
                    (overlapping[0].policyName || overlapping[0].returnPolicyId) +
                    " has the same conditions over these dates; change or end it first"
            )
    }
    let returnPolicyId
    if (editDraft) {
        returnPolicyId = existing.returnPolicyId
        call("update#" + POLICY, Object.assign({returnPolicyId, fromDate: stamp(fromMs)}, fields))
    } else
        returnPolicyId = call(
            "create#" + POLICY,
            Object.assign({organizationPartyId, previousPolicyId: replaces, fromDate: stamp(fromMs), thruDate: null}, fields)
        ).returnPolicyId
    if (!draft && replaces) {
        const replaced = one(POLICY, {returnPolicyId: replaces})
        if (replaced?.fromDate && (!replaced.thruDate || msOf(replaced.thruDate) > fromMs))
            call("update#" + POLICY, {returnPolicyId: replaces, thruDate: stamp(fromMs)})
    }
    return {returnPolicyId}
}
// save#ReturnReason: an organization's row for a ReturnReason, from a date (now), replacing its current row; end ends it.
function saveReason(p) {
    requirePermission("RETURN_POLICY_EDIT")
    const organizationPartyId = requireOrganization(p.organizationPartyId)
    if (one("moqui.basic.Enumeration", {enumId: p.returnReasonEnumId || "_NA_"})?.enumTypeId !== "ReturnReason")
        denied("VALUE_INVALID", (p.returnReasonEnumId || "") + " is not a return reason")
    if (
        p.suggestedResponseEnumId &&
        one("moqui.basic.Enumeration", {enumId: p.suggestedResponseEnumId})?.enumTypeId !== "ReturnResponse"
    )
        denied("VALUE_INVALID", p.suggestedResponseEnumId + " is not a return response")
    const fromMs = msOf(p.fromDate) ?? nowMs()
    for (const row of currentRows(REASON, {organizationPartyId, returnReasonEnumId: p.returnReasonEnumId}, stamp(fromMs)))
        call("update#" + REASON, {returnReasonPolicyId: row.returnReasonPolicyId, thruDate: stamp(fromMs)})
    if (flag(p.end)) return {returnReasonPolicyId: null}
    return call("create#" + REASON, {
        organizationPartyId,
        returnReasonEnumId: p.returnReasonEnumId,
        customerLabel: text(p.customerLabel),
        customerVisible: yn(p.customerVisible, "Y"),
        evidenceRequired: yn(p.evidenceRequired),
        suggestedResponseEnumId: text(p.suggestedResponseEnumId),
        inspectionRequired: yn(p.inspectionRequired),
        fromDate: stamp(fromMs),
        changeReason: text(p.changeReason)
    })
}

// ===== eligibility (F21) =====
const shippableTypes = ["PtAsset", "PtDigitalAsset", "PtAssetUse", "PtPickAssembly"]
// What a source order line allows now: what was shipped (issued) and invoiced, what returns not cancelled already take (drafts
// included; exceptItem leaves out the line being changed), and what is left. A line that ships nothing (a service) counts what
// was invoiced. Locked (forUpdate) when the caller changes a return of it, so two returns at once cannot exceed it.
function lineFacts(orderId, orderItemSeqId, exceptItem = null, lock = false) {
    const item = lock
        ? find("mantle.order.OrderItem", {orderId, orderItemSeqId}).forUpdate(true).one()
        : one("mantle.order.OrderItem", {orderId, orderItemSeqId})
    if (!item) return null
    const product = item.productId ? one("mantle.product.Product", {productId: item.productId}) : null
    const shippable = !!product && shippableTypes.includes(product.productTypeEnumId)
    const issuances = rows("mantle.product.issuance.AssetIssuance", {orderId, orderItemSeqId})
    const shipped = issuances.reduce((sum, row) => sum.add(dec(row.quantity)).subtract(dec(row.quantityCancelled)), zero())
    const invoiced = rows("mantle.order.OrderItemBilling", {orderId, orderItemSeqId}).reduce(
        (sum, row) => sum.add(dec(row.quantity ?? 1)),
        zero()
    )
    const returned = rows(ITEM, {orderId, orderItemSeqId})
        .filter(row => row.statusId !== "ReturnCancelled")
        .filter(row => !exceptItem || row.returnId !== exceptItem.returnId || row.returnItemSeqId !== exceptItem.returnItemSeqId)
        .reduce((sum, row) => sum.add(dec(row.returnQuantity ?? 1)), zero())
    const ceiling = shippable ? (shipped.compare(invoiced) < 0 ? shipped : invoiced) : invoiced
    const eligible = ceiling.subtract(returned)
    const shippedMs = issuances.reduce((latest, row) => Math.max(latest, msOf(row.issuedDate) || 0), 0) || null
    return {
        item,
        product,
        shippable,
        ordered: dec(item.quantity ?? 1),
        shipped,
        invoiced,
        returned,
        eligible: eligible.compare(0) > 0 ? eligible : zero(),
        shippedMs,
        shipmentIds: Array.from(new Set(issuances.map(row => row.shipmentId).filter(Boolean)))
    }
}
// When the goods of a line arrived: the shipment's delivery in its audit log, else its expected arrival, else the ship time.
function deliveredMs(facts) {
    let latest = null
    for (const shipmentId of facts.shipmentIds) {
        const delivered = Array.from(
            find("moqui.entity.EntityAuditLog", {
                changedEntityName: "mantle.shipment.Shipment",
                changedFieldName: "statusId",
                pkPrimaryValue: shipmentId,
                newValueText: "ShipDelivered"
            })
                .orderBy("-changedDate")
                .limit(1)
                .list()
        )[0]
        const shipment = one("mantle.shipment.Shipment", {shipmentId})
        const at =
            msOf(delivered?.changedDate) ?? (shipment?.statusId === "ShipDelivered" ? msOf(shipment.estimatedArrivalDate) : null)
        if (at != null) latest = Math.max(latest ?? 0, at)
    }
    return latest
}
function requireLineQuantity(facts, quantity) {
    if (quantity.compare(0) <= 0) denied("QUANTITY_INVALID", "Give a quantity above zero")
    if (quantity.compare(facts.eligible) > 0)
        denied(
            "QUANTITY_EXCEEDS_ELIGIBLE",
            "Order line " +
                facts.item.orderItemSeqId +
                " may be returned for " +
                qty(facts.eligible) +
                " more (shipped " +
                qty(facts.shipped) +
                ", invoiced " +
                qty(facts.invoiced) +
                ", on other returns " +
                qty(facts.returned) +
                ")"
        )
}

// ===== evaluation =====
// One line against its policy: the window (from shipment or delivery), the reason and remedy allowed, proof, unreferenced
// goods (no order line: only by a manager's exception), and with no policy manual review.
function evaluateLine(organizationPartyId, base, line, date) {
    const facts = line.orderItemSeqId ? lineFacts(base.orderId, line.orderItemSeqId, line.exceptItem || null) : null
    const productId = facts?.item.productId || line.productId || null
    const policy = selectPolicy(
        organizationPartyId,
        {productStoreId: base.productStoreId, customerPartyId: base.customerPartyId, productId},
        date
    )
    const exceptions = []
    const requested = line.quantity != null ? dec(line.quantity) : null
    let windowEndMs = null
    if (!facts) exceptions.push("UNREFERENCED")
    if (policy && facts) {
        if (policy.windowDays != null) {
            const startMs = policy.windowFromEnumId === "RpwShipped" ? facts.shippedMs : (deliveredMs(facts) ?? facts.shippedMs)
            windowEndMs = startMs != null ? startMs + Number(policy.windowDays) * dayMs : null
            if (windowEndMs == null || windowEndMs < msOf(date)) exceptions.push("OUTSIDE_WINDOW")
        }
    }
    if (
        policy &&
        line.returnReasonEnumId &&
        list(policy.allowedReasonEnumIds).length &&
        !list(policy.allowedReasonEnumIds).includes(line.returnReasonEnumId)
    )
        exceptions.push("REASON_NOT_ALLOWED")
    const responses =
        policy && list(policy.allowedResponseEnumIds).length ? list(policy.allowedResponseEnumIds) : defaultResponses
    if (
        policy &&
        line.returnResponseEnumId &&
        line.returnResponseEnumId !== "RrspManual" &&
        !responses.includes(line.returnResponseEnumId)
    )
        exceptions.push("RESPONSE_NOT_ALLOWED")
    const reasonRow = line.returnReasonEnumId
        ? currentRows(REASON, {organizationPartyId, returnReasonEnumId: line.returnReasonEnumId}, date)[0]
        : null
    return {
        orderItemSeqId: facts?.item.orderItemSeqId || null,
        returnItemSeqId: line.returnItemSeqId || null,
        productId,
        productText: productId
            ? [
                  one("mantle.product.Product", {productId})?.pseudoId || productId,
                  one("mantle.product.Product", {productId})?.productName
              ]
                  .filter(Boolean)
                  .join(" · ")
            : line.description || "",
        orderedQuantity: facts ? qty(facts.ordered) : "",
        shippedQuantity: facts ? qty(facts.shipped) : "",
        invoicedQuantity: facts ? qty(facts.invoiced) : "",
        returnedQuantity: facts ? qty(facts.returned) : "",
        eligibleQuantity: facts ? qty(facts.eligible) : "",
        eligible: facts ? facts.eligible : null,
        requestedQuantity: requested != null ? qty(requested) : "",
        overEligible: !!facts && requested != null && requested.compare(facts.eligible) > 0,
        returnReasonEnumId: line.returnReasonEnumId || null,
        returnResponseEnumId: line.returnResponseEnumId || null,
        returnPolicyId: policy?.returnPolicyId || null,
        policyName: policy?.policyName || "",
        policy,
        windowEndText: windowEndMs != null ? lib.dateText(stamp(windowEndMs)) : "",
        evidenceRequired: reasonRow?.evidenceRequired === "Y" || policy?.proofRequired === "Y",
        suggestedResponseEnumId: reasonRow?.suggestedResponseEnumId || null,
        exceptions
    }
}
const exceptionTexts = {
    UNREFERENCED: "goods with no order line",
    OUTSIDE_WINDOW: "outside the return window",
    REASON_NOT_ALLOWED: "a reason the policy does not allow",
    RESPONSE_NOT_ALLOWED: "a remedy the policy does not allow"
}
// The evaluation of a sale's lines, or a return's: each line with its policy, eligibility and exceptions; the return's policy
// (its first line's), its expiry if authorized now, its fee, its instructions and its outcome: Eligible, ManualReview (no
// policy: a person decides), ExceptionRequired (a manager approves first) or NotEligible (more than is left).
function evaluateCore(p) {
    const date = p.evaluateDate || ec.user.nowTimestamp
    let base, lines
    if (!blank(p.returnId)) {
        const header = customerReturn(p.returnId)
        const items = topItems(header.returnId)
        const orderId = p.orderId || items.find(item => item.orderId)?.orderId || null
        const order = orderId ? one("mantle.order.OrderHeader", {orderId}) : null
        base = {
            organizationPartyId: header.vendorPartyId,
            customerPartyId: header.customerPartyId,
            orderId,
            productStoreId: order?.productStoreId || null,
            currencyUomId: header.currencyUomId || order?.currencyUomId || null,
            header
        }
        lines = p.lineList
            ? Array.from(p.lineList)
            : items.map(item => ({
                  orderItemSeqId: item.orderItemSeqId,
                  productId: item.productId,
                  description: item.description,
                  quantity: item.returnQuantity,
                  returnReasonEnumId: item.returnReasonEnumId,
                  returnResponseEnumId: item.returnResponseEnumId,
                  returnItemSeqId: item.returnItemSeqId,
                  exceptItem: item
              }))
    } else {
        const so = salesOrder(p.orderId, p.orderPartSeqId)
        base = {
            organizationPartyId: so.part.vendorPartyId,
            customerPartyId: so.part.customerPartyId,
            orderId: so.order.orderId,
            productStoreId: so.order.productStoreId || null,
            currencyUomId: so.order.currencyUomId || null
        }
        lines = p.lineList
            ? Array.from(p.lineList)
            : rows("mantle.order.OrderItem", {orderId: so.order.orderId, orderPartSeqId: so.part.orderPartSeqId})
                  .filter(item => item.productId && !item.parentItemSeqId)
                  .map(item => ({orderItemSeqId: item.orderItemSeqId}))
    }
    const evaluated = lines.filter(Boolean).map(line => evaluateLine(base.organizationPartyId, base, line, date))
    const policy = evaluated.find(line => line.policy)?.policy || null
    const exceptions = Array.from(new Set(evaluated.flatMap(line => line.exceptions)))
    const manualReview = evaluated.length > 0 && evaluated.every(line => !line.policy)
    const overEligible = evaluated.some(line => line.overEligible)
    const days = policy?.authorizationDays ?? defaultAuthorizationDays
    const outcome = overEligible
        ? "NotEligible"
        : exceptions.length
          ? "ExceptionRequired"
          : manualReview || evaluated.some(line => !line.policy)
            ? "ManualReview"
            : "Eligible"
    return {
        base,
        policy,
        evaluated,
        exceptions,
        manualReview: outcome === "ManualReview" || manualReview,
        outcome,
        expireMs: msOf(date) + Number(days) * dayMs,
        days
    }
}
function evaluationResult(core) {
    const currencyUomId = core.base.currencyUomId
    return {
        organizationPartyId: core.base.organizationPartyId,
        customerPartyId: core.base.customerPartyId,
        orderId: core.base.orderId,
        returnPolicyId: core.policy?.returnPolicyId || null,
        policyName: core.policy?.policyName || "",
        outcome: core.outcome,
        outcomeText: {
            Eligible: "Eligible under " + (core.policy?.policyName || "the policy"),
            ManualReview: "No return policy applies: a person reviews this return",
            ExceptionRequired:
                "Needs a manager's exception: " + core.exceptions.map(code => exceptionTexts[code] || code).join(", "),
            NotEligible: "More than is left to return"
        }[core.outcome],
        manualReview: !!core.manualReview,
        exceptions: core.exceptions,
        exceptionText: core.exceptions.map(code => exceptionTexts[code] || code).join(", "),
        expireDate: stamp(core.expireMs),
        expireText: lib.dateText(stamp(core.expireMs)),
        // no fee without a published rule
        feeText: core.policy ? feeText(core.policy, currencyUomId) : "No restocking fee",
        instructions: core.policy?.instructions || "",
        selfServiceEnabled: core.policy?.selfServiceEnabled === "Y",
        approvalText:
            core.outcome === "ExceptionRequired"
                ? "A return exception approver decides first"
                : core.outcome === "ManualReview"
                  ? "A return authorizer reviews it with a reason"
                  : "A return authorizer authorizes it",
        lineRows: core.evaluated.map(line => {
            const out = Object.assign({}, line)
            delete out.policy
            delete out.eligible
            out.exceptionText = line.exceptions.map(code => exceptionTexts[code] || code).join(", ")
            return out
        })
    }
}
function evaluate(p) {
    requirePermission(...readPermissions)
    return evaluationResult(evaluateCore(p))
}

// ===== entering a customer's return =====
// save#ReturnItem (F21): add a line of the sale to an open return, or change or remove one, under a lock on the return and on
// the source order line, against what is left; BOSS writes return lines only through it. Goods with no order line need a
// product and a reason, and then a manager's exception before authorization.
function saveItem(p, nested = false) {
    if (!nested) requirePermission(...enterPermissions)
    const header = customerReturn(p.returnId, true)
    if (!openStatuses.includes(header.statusId))
        denied(
            "RETURN_NOT_OPEN",
            "Return " + header.returnId + " is " + statusText(header.statusId) + "; its lines no longer change"
        )
    const quantity = p.returnQuantity != null && !blank(p.returnQuantity) ? dec(p.returnQuantity) : null
    let existing = null
    if (!blank(p.returnItemSeqId)) {
        existing = one(ITEM, {returnId: header.returnId, returnItemSeqId: p.returnItemSeqId})
        if (!existing || existing.parentItemSeqId || existing.statusId === "ReturnCancelled")
            denied("RETURN_ITEM_UNAVAILABLE", "Item " + p.returnItemSeqId + " is not on return " + header.returnId)
    }
    const orderId = existing?.orderId || text(p.orderId)
    const orderItemSeqId = existing?.orderItemSeqId || text(p.orderItemSeqId)
    const reasonEnumId = text(p.returnReasonEnumId) || existing?.returnReasonEnumId || null
    const responseEnumId = text(p.returnResponseEnumId) || existing?.returnResponseEnumId || null
    if (!reasonEnumId) denied("REASON_REQUIRED", "Give the reason for the return")
    if (!responseEnumId) denied("RESPONSE_REQUIRED", "Give the remedy asked for")
    // remove
    if (existing && quantity != null && quantity.compare(0) === 0) {
        call("mantle.order.ReturnServices.delete#ReturnItem", {
            returnId: header.returnId,
            returnItemSeqId: existing.returnItemSeqId
        })
        return {returnId: header.returnId, returnItemSeqId: null, removed: true}
    }
    if (!orderItemSeqId) {
        // goods with no order line (unreferenced): a product of the organization and a reason; authorization then needs an
        // exception a manager approves
        const productId = existing?.productId || text(p.productId)
        if (!productId || !one("mantle.product.Product", {productId})) denied("PRODUCT_REQUIRED", "Give the product returned")
        if (quantity == null || quantity.compare(0) <= 0) denied("QUANTITY_INVALID", "Give a quantity above zero")
        if (blank(p.description) && !existing) denied("EVIDENCE_REQUIRED", "Describe the goods and how the customer owns them")
        if (existing) {
            call("update#" + ITEM, {
                returnId: header.returnId,
                returnItemSeqId: existing.returnItemSeqId,
                returnQuantity: quantity,
                returnReasonEnumId: reasonEnumId,
                returnResponseEnumId: responseEnumId
            })
            return {returnId: header.returnId, returnItemSeqId: existing.returnItemSeqId}
        }
        const created = call("create#" + ITEM, {
            returnId: header.returnId,
            statusId: header.statusId,
            itemTypeEnumId: "ItemProduct",
            productId,
            description: String(p.description).substring(0, 255),
            returnQuantity: quantity,
            returnPrice: zero(),
            returnReasonEnumId: reasonEnumId,
            returnResponseEnumId: responseEnumId,
            responseImmediate: "N"
        })
        return {returnId: header.returnId, returnItemSeqId: created.returnItemSeqId, unreferenced: true}
    }
    // a line of the sale: the sale must be the return's customer's, under the line's lock
    const so = salesOrder(orderId)
    if (so.part.customerPartyId !== header.customerPartyId || so.part.vendorPartyId !== header.vendorPartyId)
        denied("ORDER_MISMATCH", "Order " + orderId + " is not a sale of this return's organization to its customer")
    const facts = lineFacts(orderId, orderItemSeqId, existing, true)
    if (!facts || facts.item.parentItemSeqId || !facts.item.productId)
        denied("ORDER_ITEM_UNAVAILABLE", "Order line " + orderItemSeqId + " is not a returnable product line")
    const wanted = quantity ?? dec(existing?.returnQuantity)
    requireLineQuantity(facts, wanted)
    if (existing) {
        if (wanted.compare(dec(existing.returnQuantity)) === 0) {
            call("mantle.order.ReturnServices.update#ReturnItem", {
                returnId: header.returnId,
                returnItemSeqId: existing.returnItemSeqId,
                returnReasonEnumId: reasonEnumId,
                returnResponseEnumId: responseEnumId
            })
            return {returnId: header.returnId, returnItemSeqId: existing.returnItemSeqId}
        }
        // a new quantity re-prorates the line's adjustments: the line is made again
        call("mantle.order.ReturnServices.delete#ReturnItem", {
            returnId: header.returnId,
            returnItemSeqId: existing.returnItemSeqId
        })
    }
    const added = call("mantle.order.ReturnServices.add#OrderItemToReturn", {
        returnId: header.returnId,
        orderId,
        orderItemSeqId,
        returnQuantity: wanted,
        returnReasonEnumId: reasonEnumId,
        returnResponseEnumId: responseEnumId,
        responseImmediate: "N",
        description: text(p.description) || undefined
    })
    return {returnId: header.returnId, returnItemSeqId: added.returnItemSeqId}
}
// The return's assignee, a dated ReturnParty row: the current one ended, the new one from now.
function setAssignee(returnId, partyId) {
    const now = ec.user.nowTimestamp
    const current = currentRows(PARTY, {returnId, roleTypeId: "Assignee"})
    if (current.some(row => row.partyId === partyId)) return false
    for (const row of current)
        call("update#" + PARTY, {returnId, partyId: row.partyId, roleTypeId: "Assignee", fromDate: row.fromDate, thruDate: now})
    if (partyId) {
        if (!one("mantle.party.PartyRole", {partyId, roleTypeId: "Assignee"}))
            call("create#mantle.party.PartyRole", {partyId, roleTypeId: "Assignee"})
        call("create#" + PARTY, {returnId, partyId, roleTypeId: "Assignee", fromDate: now})
    }
    return true
}
// assign#Return: a staff person of the return's organization follows it.
function assign(p) {
    requirePermission(...enterPermissions)
    const header = customerReturn(p.returnId, true)
    const partyId = text(p.assigneePartyId)
    if (partyId) {
        const works = rows("mantle.party.PartyRelationship", {fromPartyId: partyId, toPartyId: header.vendorPartyId}).some(row =>
            lib.active(row)
        )
        if (!works) denied("ASSIGNEE_UNAVAILABLE", partyName(partyId) + " does not work for " + partyName(header.vendorPartyId))
    }
    setAssignee(header.returnId, partyId)
    return {returnId: header.returnId, assigneePartyId: partyId}
}
// submit#CustomerReturn (over save#ReturnItem and request#Return): a customer's return entered for them, from a sale (a new
// return) or a draft, its lines saved through the eligibility check, its policy evaluated and kept on the return with the
// customer's reference, its case linked and its assignee set, and requested (unless kept as a draft). An exception the
// policy needs is sent to the exception approvers. The same operation key answers the first result.
function submit(p) {
    requirePermission(...enterPermissions)
    const lines = Array.from(p.lineList || []).filter(
        line => line && (line.orderItemSeqId || line.productId || line.returnItemSeqId)
    )
    let header = blank(p.returnId) ? null : customerReturn(p.returnId)
    const so = header ? null : salesOrder(p.orderId, p.orderPartSeqId)
    const organizationPartyId = header ? header.vendorPartyId : so.part.vendorPartyId
    const request = {
        returnId: p.returnId || null,
        orderId: p.orderId || null,
        lines: lines.map(line => [
            line.orderItemSeqId || line.productId,
            String(line.quantity ?? ""),
            line.returnReasonEnumId,
            line.returnResponseEnumId
        ]),
        customerReference: text(p.customerReference),
        requestId: text(p.requestId),
        draft: flag(p.draft)
    }
    const operation = lib.operation(p, "CustomerReturnSubmit", organizationPartyId, request)
    if (operation.old) return lib.previous(operation)
    if (!header) {
        const created = call("mantle.order.ReturnServices.create#ReturnFromOrder", {
            orderId: so.order.orderId,
            orderPartSeqId: so.part.orderPartSeqId,
            facilityId: text(p.facilityId) || undefined
        })
        header = one(HEADER, {returnId: created.returnId})
    }
    if (!openStatuses.includes(header.statusId))
        denied("RETURN_NOT_OPEN", "Return " + header.returnId + " is " + statusText(header.statusId))
    for (const line of lines) {
        const existing = line.returnItemSeqId
            ? null
            : topItems(header.returnId).find(item => line.orderItemSeqId && item.orderItemSeqId === line.orderItemSeqId)
        saveItem(
            Object.assign({}, line, {
                returnId: header.returnId,
                returnItemSeqId: line.returnItemSeqId || existing?.returnItemSeqId || null,
                orderId: line.orderId || so?.order.orderId || null,
                returnQuantity: line.quantity
            }),
            true
        )
    }
    if (!topItems(header.returnId).length) denied("RETURN_EMPTY", "Choose what the customer returns")
    const core = evaluateCore({returnId: header.returnId})
    if (core.outcome === "NotEligible") denied("QUANTITY_EXCEEDS_ELIGIBLE", "More than is left to return")
    // the policy the return was evaluated against, the time, the customer's reference and the policy's destination
    const destination = core.policy?.destinationFacilityId || null
    call("update#" + HEADER, {
        returnId: header.returnId,
        customerReference: p.customerReference != null ? text(p.customerReference) : header.customerReference,
        returnPolicyId: core.policy?.returnPolicyId || null,
        policyEvaluatedDate: ec.user.nowTimestamp,
        manualReview: core.manualReview ? "Y" : "N",
        facilityId: header.facilityId || destination,
        // the return label's carrier and service (request#ReturnLabel reads them), when given
        carrierPartyId: text(p.carrierPartyId) || header.carrierPartyId || null,
        shipmentMethodEnumId: text(p.shipmentMethodEnumId) || header.shipmentMethodEnumId || null
    })
    setAssignee(header.returnId, text(p.assigneePartyId) || assigneeOf(header.returnId) || ec.user.userAccount?.partyId || null)
    if (!blank(p.requestId))
        call("mantle.request.RequestServices.link#RequestRecord", {
            requestId: p.requestId,
            recordEntityName: HEADER,
            recordId: header.returnId
        })
    if (!flag(p.draft) && one(HEADER, {returnId: header.returnId}).statusId === "ReturnCreated")
        call("mantle.order.ReturnServices.request#Return", {returnId: header.returnId})
    let exceptionNotified = 0
    if (!flag(p.draft) && core.outcome === "ExceptionRequired")
        exceptionNotified = requestExceptionCore(
            header.returnId,
            text(p.exceptionReason) || "Entered with an exception"
        ).notifiedCount
    const result = Object.assign(evaluationResult(core), {
        returnId: header.returnId,
        statusId: one(HEADER, {returnId: header.returnId}).statusId,
        sourceRevision: revisionOf(header.returnId),
        exceptionNotified
    })
    delete result.expireDate
    lib.complete(operation, HEADER, header.returnId, result)
    return Object.assign(result, {alreadyApplied: false})
}

// ===== exceptions and their approval (CX-APPROVAL, F45, F46) =====
// The users who approve an exception of the organization: holders of RETURN_EXCEPTION_APPROVE who work for it (in the
// policy's exception group when it names one).
function exceptionApprovers(organizationPartyId, policy) {
    const groupIds = new Set(
        rows("moqui.security.UserGroupPermission", {userPermissionId: "RETURN_EXCEPTION_APPROVE"})
            .filter(row => lib.active(row))
            .map(row => row.userGroupId)
    )
    if (policy?.exceptionUserGroupId) {
        if (!groupIds.has(policy.exceptionUserGroupId)) return []
        groupIds.clear()
        groupIds.add(policy.exceptionUserGroupId)
    }
    if (!groupIds.size) return []
    const userIds = new Set()
    for (const member of find("moqui.security.UserGroupMember").condition("userGroupId", "in", Array.from(groupIds)).list()) {
        if (!lib.active(member)) continue
        const account = one("moqui.security.UserAccount", {userId: member.userId})
        if (!account?.partyId || account.disabled === "Y") continue
        const works = rows("mantle.party.PartyRelationship", {fromPartyId: account.partyId, toPartyId: organizationPartyId}).some(
            row => lib.active(row)
        )
        if (works) userIds.add(member.userId)
    }
    return Array.from(userIds)
}
function clearNotices(returnId) {
    const messageIds = rows("moqui.security.user.NotificationMessage", {
        topic: "ReturnExceptionApproval",
        recordEntityName: HEADER,
        recordId: returnId
    }).map(row => row.notificationMessageId)
    if (!messageIds.length) return
    for (const user of Array.from(
        find("moqui.security.user.NotificationMessageUser")
            .condition("notificationMessageId", "in", messageIds)
            .condition("viewedDate", "is-null", null)
            .list()
    ))
        call("update#moqui.security.user.NotificationMessageUser", {
            notificationMessageId: user.notificationMessageId,
            userId: user.userId,
            viewedDate: ec.user.nowTimestamp
        })
}
function decisionRow(header, decisionEnumId, fields) {
    return call(
        "create#" + DECISION,
        Object.assign(
            {
                returnId: header.returnId,
                organizationPartyId: header.vendorPartyId,
                decisionEnumId,
                decisionDate: ec.user.nowTimestamp,
                decidedByUserId: ec.user.userId,
                decidedByPartyId: ec.user.userAccount?.partyId || null
            },
            fields
        )
    ).returnAuthorizationDecisionId
}
// The decision on the return's assignee's desk (ReturnDecision): an authorization or an exception decided by someone else.
function notifyDecision(header, decisionText) {
    try {
        const assignee = assigneeOf(header.returnId)
        const userIds = assignee
            ? rows("moqui.security.UserAccount", {partyId: assignee})
                  .filter(row => row.userId !== ec.user.userId && row.disabled !== "Y")
                  .map(row => row.userId)
            : []
        if (!userIds.length) return 0
        ec.makeNotificationMessage()
            .topic("ReturnDecision")
            .message({
                returnId: header.returnId,
                customerName: partyName(header.customerPartyId),
                decisionText,
                decidedByName: partyName(ec.user.userAccount?.partyId) || ec.user.username
            })
            .record(HEADER, header.returnId)
            .actorUserId(ec.user.userId)
            .userIds(userIds)
            .send()
        return userIds.length
    } catch (error) {
        ec.logger.error("Return decision notice of " + header.returnId + " was not sent: " + error.message)
        return 0
    }
}
// An exception asked for at the return's current revision: the request recorded, the approvers told (ReturnExceptionApproval,
// its message naming the revision). A failure to notify is logged and the request stays.
function requestExceptionCore(returnId, reason) {
    const header = one(HEADER, {returnId})
    const core = evaluateCore({returnId})
    if (!core.exceptions.length) denied("NO_EXCEPTION", "Return " + returnId + " needs no exception")
    const sourceRevision = revisionOf(returnId)
    const exceptionText = core.exceptions.map(code => exceptionTexts[code] || code).join(", ")
    decisionRow(header, "RdExceptionRequested", {
        sourceRevision,
        reason: text(reason),
        returnPolicyId: core.policy?.returnPolicyId || null,
        policyFromDate: core.policy?.fromDate || null,
        exceptionText
    })
    let notifiedCount = 0
    try {
        clearNotices(returnId)
        const userIds = exceptionApprovers(header.vendorPartyId, core.policy).filter(userId => userId !== ec.user.userId)
        if (userIds.length) {
            ec.makeNotificationMessage()
                .topic("ReturnExceptionApproval")
                .message({
                    returnId,
                    sourceRevision,
                    organizationPartyId: header.vendorPartyId,
                    organizationName: partyName(header.vendorPartyId),
                    customerName: partyName(header.customerPartyId),
                    exceptionText,
                    reason: text(reason) || "",
                    requestedByName: partyName(ec.user.userAccount?.partyId) || ec.user.username
                })
                .record(HEADER, returnId)
                .actorUserId(ec.user.userId)
                .userIds(userIds)
                .send()
            notifiedCount = userIds.length
        }
    } catch (error) {
        ec.logger.error("Return exception notice of " + returnId + " was not sent: " + error.message)
    }
    return {returnId, sourceRevision, exceptionText, notifiedCount}
}
function requestException(p) {
    requirePermission(...enterPermissions)
    const header = customerReturn(p.returnId, true)
    if (!openStatuses.includes(header.statusId))
        denied("RETURN_NOT_OPEN", "Return " + header.returnId + " is " + statusText(header.statusId))
    return requestExceptionCore(header.returnId, p.reason)
}
// decide#ReturnException (RETURN_EXCEPTION_APPROVE): a manager approves or refuses the exceptions of an open return at its
// revision; a stale revision is refused naming the current one (STALE_REVISION), and from a topic a message with no revision
// is refused (REVISION_REQUIRED, F46). A refusal needs a reason.
function decide(p, fromTopic = false) {
    requirePermission("RETURN_EXCEPTION_APPROVE")
    const header = customerReturn(p.returnId, true)
    if (!openStatuses.includes(header.statusId))
        denied(
            "RETURN_NOT_OPEN",
            "Return " + header.returnId + " is " + statusText(header.statusId) + "; nothing waits on an exception"
        )
    const current = revisionOf(header.returnId)
    if (blank(p.sourceRevision)) {
        if (fromTopic) denied("REVISION_REQUIRED", "The approval names no revision of return " + header.returnId)
    } else if (String(p.sourceRevision) !== current)
        denied("STALE_REVISION", "Return " + header.returnId + " changed since; its current revision is " + current)
    const decision = String(p.decision || "")
    if (!["approve", "refuse"].includes(decision)) denied("DECISION_INVALID", "Approve or refuse")
    if (decision === "refuse" && blank(p.reason)) denied("REASON_REQUIRED", "Give the reason for refusing")
    const core = evaluateCore({returnId: header.returnId})
    if (!core.exceptions.length) denied("NO_EXCEPTION", "Return " + header.returnId + " needs no exception")
    const exceptionText = core.exceptions.map(code => exceptionTexts[code] || code).join(", ")
    const decisionId = decisionRow(header, decision === "approve" ? "RdExceptionApproved" : "RdExceptionRefused", {
        sourceRevision: current,
        reason: text(p.reason),
        returnPolicyId: core.policy?.returnPolicyId || null,
        policyFromDate: core.policy?.fromDate || null,
        exceptionText
    })
    clearNotices(header.returnId)
    notifyDecision(
        header,
        decision === "approve" ? "Exception approved: " + exceptionText : "Exception refused: " + text(p.reason)
    )
    return {
        returnId: header.returnId,
        decision,
        sourceRevision: current,
        returnAuthorizationDecisionId: decisionId
    }
}
// approve#ReturnException and refuse#ReturnException: the topic's handlers, called by the framework as the deciding user
// with the record, its message, the notice and the reason; each decides at the revision in the message.
function decideFromTopic(p, decision) {
    if (p.recordEntityName && p.recordEntityName !== HEADER) denied("SOURCE_INVALID", "Not a return exception")
    const message = p.message || {}
    return decide({returnId: p.recordId, sourceRevision: message.sourceRevision ?? null, decision, reason: p.reason}, true)
}
// An approved exception at the return's current revision, not refused later at it.
function exceptionApproved(returnId, revision) {
    const decisions = rows(DECISION, {returnId, sourceRevision: revision})
        .filter(row => ["RdExceptionApproved", "RdExceptionRefused"].includes(row.decisionEnumId))
        .sort((a, b) => msOf(b.decisionDate) - msOf(a.decisionDate))
    return decisions[0]?.decisionEnumId === "RdExceptionApproved" ? decisions[0] : null
}

// ===== authorization =====
// Whether an item may be answered at approval (responseImmediate Y): the policy allows instant credit (a credit or refund) or
// advance replacement, and the actor holds the settlement authority: RECEIVABLE_EDIT for a credit or replacement, PAYMENT_EDIT
// too for a refund. Where the organization does not settle returns separately Mantle answers the item at approval as the
// actor, approving the credit memo (Incoming to Approved, a transition that needs INVOICE_APPROVE), so a credit or refund
// needs INVOICE_APPROVE too there; without it the item waits for receipt rather than failing the authorization.
function immediateAllowed(policy, responseEnumId, settles) {
    if (!policy) return false
    if (responseEnumId === "RrspReplace") return policy.advanceReplacement === "Y" && access.has("RECEIVABLE_EDIT")
    const approvesCredit = settles || access.has("INVOICE_APPROVE")
    if (responseEnumId === "RrspCredit") return policy.instantCredit === "Y" && access.has("RECEIVABLE_EDIT") && approvesCredit
    if (responseEnumId === "RrspRefund")
        return policy.instantCredit === "Y" && access.has("RECEIVABLE_EDIT") && access.has("PAYMENT_EDIT") && approvesCredit
    return false
}
// authorize#Return (RETURN_AUTHORIZE): an open customer return with lines, at its revision when one is given, its lines checked
// again under their locks, its exceptions approved first (EXCEPTION_REQUIRED) and with no policy a reason (REASON_REQUIRED,
// manual review); every item's responseImmediate N unless asked for and allowed; the expiry from the policy; approve#Return
// (Mantle's ReturnApprovedProcess makes the return shipment; no settlement); the decision recorded; the RMA stored as
// ReturnContent (a failure to render is logged, the authorization stands). A retry with the operation key answers the first.
function authorize(p) {
    requirePermission("RETURN_AUTHORIZE")
    const peek = customerReturn(p.returnId)
    const operation = lib.operation(p, "ReturnAuthorize", peek.vendorPartyId, {
        returnId: peek.returnId,
        sourceRevision: text(p.sourceRevision),
        immediate: flag(p.immediate),
        reason: text(p.reason)
    })
    if (operation.old) return lib.previous(operation)
    const header = customerReturn(p.returnId, true)
    if (authorizedStatuses.includes(header.statusId))
        return {resultCode: "ALREADY_AUTHORIZED", returnId: header.returnId, statusId: header.statusId, alreadyApplied: false}
    if (!openStatuses.includes(header.statusId))
        denied("RETURN_CLOSED", "Return " + header.returnId + " is " + statusText(header.statusId) + " and is not authorized")
    const revision = revisionOf(header.returnId)
    if (!blank(p.sourceRevision) && String(p.sourceRevision) !== revision)
        denied("STALE_REVISION", "Return " + header.returnId + " changed since; its current revision is " + revision)
    const items = topItems(header.returnId)
    if (!items.length) denied("RETURN_EMPTY", "Return " + header.returnId + " has no lines")
    for (const item of items) {
        if (!item.orderItemSeqId) continue
        const facts = lineFacts(item.orderId, item.orderItemSeqId, item, true)
        requireLineQuantity(facts, dec(item.returnQuantity))
    }
    const core = evaluateCore({returnId: header.returnId})
    let exception = null
    if (core.exceptions.length) {
        exception = exceptionApproved(header.returnId, revision)
        if (!exception)
            denied(
                "EXCEPTION_REQUIRED",
                "Return " +
                    header.returnId +
                    " needs a manager's exception first: " +
                    core.exceptions.map(code => exceptionTexts[code]).join(", ")
            )
    }
    if (core.manualReview && blank(p.reason))
        denied("REASON_REQUIRED", "No return policy applies to return " + header.returnId + ": give the reason you authorize it")
    // where the organization does not settle returns separately, Mantle's approval places a replacement order for every
    // replacement item at once (respond#ReturnItems); that is an advance replacement, so only where the policy allows one
    const settles = !!call("mantle.order.ReturnServices.get#ReturnSettlementMode", {returnId: header.returnId}).settlementRequired
    if (!settles) {
        const early = items.filter(item => {
            if (item.returnResponseEnumId !== "RrspReplace") return false
            const policy = core.evaluated.find(row => row.returnItemSeqId === item.returnItemSeqId)?.policy || core.policy
            return policy?.advanceReplacement !== "Y"
        })
        if (early.length)
            denied(
                "REPLACEMENT_AFTER_RECEIPT",
                "Return " +
                    header.returnId +
                    ": " +
                    partyName(header.vendorPartyId) +
                    " does not settle returns separately, so authorizing would place the replacement now, and the return policy" +
                    " allows no advance replacement; change the remedy of item " +
                    early.map(item => item.returnItemSeqId).join(", ") +
                    " or replace after receipt"
            )
    }
    const immediateItems = []
    for (const item of items) {
        const line = core.evaluated.find(row => row.returnItemSeqId === item.returnItemSeqId)
        const immediate = flag(p.immediate) && immediateAllowed(line?.policy || core.policy, item.returnResponseEnumId, settles)
        if (immediate) immediateItems.push(item.returnItemSeqId)
        if ((item.responseImmediate || "N") !== (immediate ? "Y" : "N"))
            call("mantle.order.ReturnServices.update#ReturnItem", {
                returnId: header.returnId,
                returnItemSeqId: item.returnItemSeqId,
                responseImmediate: immediate ? "Y" : "N"
            })
    }
    if (flag(p.immediate) && !immediateItems.length)
        ec.logger.info("Return " + header.returnId + ": immediate responses asked for but not allowed; none given")
    call("update#" + HEADER, {
        returnId: header.returnId,
        authorizationExpireDate: stamp(core.expireMs),
        returnPolicyId: core.policy?.returnPolicyId || null,
        policyEvaluatedDate: ec.user.nowTimestamp,
        manualReview: core.manualReview ? "Y" : "N"
    })
    call("mantle.order.ReturnServices.approve#Return", {returnId: header.returnId})
    const decisionId = decisionRow(header, "RdAuthorized", {
        sourceRevision: revision,
        reason: text(p.reason),
        returnPolicyId: core.policy?.returnPolicyId || null,
        policyFromDate: core.policy?.fromDate || null,
        exceptionText: exception ? exception.exceptionText : core.manualReview ? "no policy: manual review" : null,
        operationKey: operation.operationKey
    })
    let returnContentId = null
    try {
        returnContentId = storeAuthorization(header.returnId)
    } catch (error) {
        ec.message.clearErrors()
        ec.logger.error("RMA of return " + header.returnId + " was not stored: " + error.message)
    }
    notifyDecision(header, "Authorized until " + lib.dateText(stamp(core.expireMs)))
    const shipmentId = rows("mantle.shipment.ShipmentItemSource", {returnId: header.returnId})[0]?.shipmentId || null
    const result = {
        resultCode: "AUTHORIZED",
        returnId: header.returnId,
        statusId: one(HEADER, {returnId: header.returnId}).statusId,
        shipmentId,
        expireText: lib.dateText(stamp(core.expireMs)),
        immediateItems,
        returnContentId,
        returnAuthorizationDecisionId: decisionId,
        sourceRevision: revision
    }
    lib.complete(operation, HEADER, header.returnId, result)
    return Object.assign(result, {alreadyApplied: false})
}

// ===== after authorization =====
// What a return has done that cannot be undone by cancelling: goods received, a credit or refund, a replacement.
function effectsOf(returnId) {
    const items = rows(ITEM, {returnId})
    const effects = []
    if (
        items.some(item => dec(item.receivedQuantity).compare(0) > 0) ||
        rows("mantle.product.receipt.AssetReceipt", {returnId}).length
    )
        effects.push("goods received")
    if (rows(BILLING, {returnId}).length) effects.push("a credit")
    if (items.some(item => item.refundPaymentId || item.finAccountTransId)) effects.push("a refund")
    if (items.some(item => item.replacementOrderId)) effects.push("a replacement")
    return effects
}
// cancel#CustomerReturn: a customer return cancelled before any physical or financial effect (RETURN_HAS_EFFECT otherwise);
// Mantle's cancel#Return then cancels its return shipment too (F22). An open return by an agent, an authorized one by a return
// authorizer.
function cancelReturn(p) {
    const header = customerReturn(p.returnId, true)
    if (header.statusId === "ReturnCancelled")
        return {returnId: header.returnId, statusId: header.statusId, alreadyCancelled: true}
    if (openStatuses.includes(header.statusId)) requirePermission(...enterPermissions)
    else requirePermission("RETURN_AUTHORIZE")
    if (!openStatuses.includes(header.statusId) && header.statusId !== "ReturnApproved")
        denied(
            "RETURN_HAS_EFFECT",
            "Return " + header.returnId + " is " + statusText(header.statusId) + "; it can no longer be cancelled"
        )
    const effects = effectsOf(header.returnId)
    if (effects.length)
        denied(
            "RETURN_HAS_EFFECT",
            "Return " + header.returnId + " already has " + effects.join(", ") + "; it can no longer be cancelled"
        )
    if (blank(p.reason) && header.statusId === "ReturnApproved") denied("REASON_REQUIRED", "Give the reason for cancelling")
    const revision = revisionOf(header.returnId)
    call("mantle.order.ReturnServices.cancel#Return", {returnId: header.returnId})
    decisionRow(header, "RdCancelled", {sourceRevision: revision, reason: text(p.reason)})
    clearNotices(header.returnId)
    return {returnId: header.returnId, statusId: one(HEADER, {returnId: header.returnId}).statusId}
}
// close#ReturnRemainder (RETURN_AUTHORIZE): what will not come back of an authorized item, closed with a reason: its authorized
// quantity becomes what was received, so it is Received (or cancelled when nothing came), its shipment source no longer waits
// for the rest, and the return is Received when every item is; an open return shipment with nothing left to come is delivered,
// or cancelled when nothing came at all.
function closeRemainder(p) {
    requirePermission("RETURN_AUTHORIZE")
    const header = customerReturn(p.returnId, true)
    if (!["ReturnApproved", "ReturnShipped"].includes(header.statusId))
        denied("RETURN_NOT_AWAITING", "Return " + header.returnId + " waits for no goods")
    if (blank(p.reason)) denied("REASON_REQUIRED", "Give the reason the rest will not come back")
    const revision = revisionOf(header.returnId)
    const items = topItems(header.returnId).filter(item =>
        blank(p.returnItemSeqId) ? true : item.returnItemSeqId === String(p.returnItemSeqId)
    )
    const closed = []
    for (const item of items) {
        if (!["ReturnApproved", "ReturnShipped"].includes(item.statusId)) continue
        const received = dec(item.receivedQuantity)
        if (received.compare(dec(item.returnQuantity)) >= 0) continue
        if (received.compare(0) === 0) {
            call("mantle.order.ReturnServices.cancel#ReturnItem", {
                returnId: header.returnId,
                returnItemSeqId: item.returnItemSeqId
            })
        } else {
            for (const child of rows(ITEM, {returnId: header.returnId, parentItemSeqId: item.returnItemSeqId}))
                if (!["ReturnCancelled", "ReturnCompleted"].includes(child.statusId))
                    call("update#" + ITEM, {
                        returnId: header.returnId,
                        returnItemSeqId: child.returnItemSeqId,
                        statusId: "ReturnReceived"
                    })
            call("update#" + ITEM, {
                returnId: header.returnId,
                returnItemSeqId: item.returnItemSeqId,
                returnQuantity: received,
                statusId: item.returnResponseEnumId === "RrspManual" ? "ReturnManResp" : "ReturnReceived"
            })
        }
        for (const source of rows("mantle.shipment.ShipmentItemSource", {
            returnId: header.returnId,
            returnItemSeqId: item.returnItemSeqId
        }))
            if (source.statusId !== "SisReceived")
                call("update#mantle.shipment.ShipmentItemSource", {
                    shipmentItemSourceId: source.shipmentItemSourceId,
                    quantityNotHandled: zero(),
                    statusId: "SisReceived"
                })
        closed.push({returnItemSeqId: item.returnItemSeqId, closedQuantity: qty(dec(item.returnQuantity).subtract(received))})
    }
    if (!closed.length) denied("NOTHING_TO_CLOSE", "No item of return " + header.returnId + " waits for more goods")
    call("mantle.order.ReturnServices.checkUpdate#ReturnHeaderStatus", {
        returnId: header.returnId,
        statusId: "ReturnReceived",
        itemStatusIds: ["ReturnReceived", "ReturnManResp", "ReturnCompleted", "ReturnCancelled"]
    })
    if (topItems(header.returnId).length === 0) call("update#" + HEADER, {returnId: header.returnId, statusId: "ReturnCancelled"})
    for (const shipmentId of new Set(
        rows("mantle.shipment.ShipmentItemSource", {returnId: header.returnId}).map(row => row.shipmentId)
    )) {
        const shipment = one("mantle.shipment.Shipment", {shipmentId})
        if (!shipment || ["ShipDelivered", "ShipCancelled"].includes(shipment.statusId)) continue
        const waiting = rows("mantle.shipment.ShipmentItemSource", {shipmentId}).some(
            row => row.statusId !== "SisReceived" && dec(row.quantityNotHandled ?? row.quantity).compare(0) > 0
        )
        if (waiting) continue
        if (rows("mantle.product.receipt.AssetReceipt", {shipmentId}).length)
            call("mantle.shipment.ShipmentServices.deliver#Shipment", {shipmentId})
        else call("mantle.shipment.ShipmentServices.cancel#Shipment", {shipmentId, undoIssueReceive: false})
    }
    decisionRow(header, "RdRemainderClosed", {sourceRevision: revision, reason: text(p.reason)})
    return {returnId: header.returnId, statusId: one(HEADER, {returnId: header.returnId}).statusId, closedItems: closed}
}

// ===== reads =====
const views = {
    requested: {statuses: ["ReturnRequested"]},
    awaiting: {statuses: ["ReturnCreated", "ReturnRequested"]},
    authorized: {statuses: ["ReturnApproved", "ReturnShipped"]},
    received: {statuses: ["ReturnReceived"]},
    manual: {statuses: ["ReturnManResp"]},
    settlement: {statuses: ["ReturnApproved", "ReturnShipped", "ReturnReceived", "ReturnManResp"], settlementPending: true},
    expiring: {statuses: ["ReturnApproved", "ReturnShipped"], expiring: true},
    cancelled: {statuses: ["ReturnCancelled"]},
    closed: {statuses: ["ReturnCompleted"]},
    all: {statuses: null}
}
const statusColors = {
    ReturnCreated: "grey-8",
    ReturnRequested: "info",
    ReturnApproved: "primary",
    ReturnShipped: "primary",
    ReturnReceived: "warning",
    ReturnManResp: "warning",
    ReturnCompleted: "positive",
    ReturnCancelled: "grey"
}
// A return's row: its quantities authorized, received, accepted and settled, the expiry, the assignee, the policy and the
// exception waiting; the credited amount only for an amount reader (PRICE_VIEW, ACCOUNTING_VIEW or RECEIVABLE_VIEW).
function returnRow(header, amounts) {
    const items = topItems(header.returnId)
    const authorized = items.reduce((sum, item) => sum.add(dec(item.returnQuantity)), zero())
    const received = items.reduce((sum, item) => sum.add(dec(item.receivedQuantity)), zero())
    const receipts = rows("mantle.product.receipt.AssetReceipt", {returnId: header.returnId})
    const accepted = receipts.reduce((sum, row) => sum.add(dec(row.quantityAccepted)), zero())
    const rejected = receipts.reduce((sum, row) => sum.add(dec(row.quantityRejected)), zero())
    const billings = rows(BILLING, {returnId: header.returnId})
    const settled = billings
        .reduce((sum, row) => sum.add(dec(row.quantity)), zero())
        .add(items.reduce((sum, item) => sum.add(dec(item.replacedQuantity)), zero()))
    const creditedAmount = billings.reduce((sum, row) => sum.add(dec(row.amount).multiply(dec(row.quantity ?? 1))), zero())
    const assigneePartyId = assigneeOf(header.returnId)
    const orderIds = Array.from(new Set(items.map(item => item.orderId).filter(Boolean)))
    const exceptionAsked = rows(DECISION, {returnId: header.returnId, decisionEnumId: "RdExceptionRequested"}).some(
        row => row.sourceRevision === revisionOf(header.returnId)
    )
    const expireMs = msOf(header.authorizationExpireDate)
    return {
        returnId: header.returnId,
        displayId: header.displayId || header.returnId,
        customerReference: header.customerReference || "",
        customerPartyId: header.customerPartyId,
        customerName: partyName(header.customerPartyId),
        organizationPartyId: header.vendorPartyId,
        orderIds,
        orderText: orderIds.join(", "),
        statusId: header.statusId,
        statusText: statusText(header.statusId),
        statusColor: statusColors[header.statusId] || "grey",
        entryText: lib.dateText(header.entryDate),
        expireText: expireMs ? lib.dateText(header.authorizationExpireDate) : "",
        expired: !!expireMs && expireMs < nowMs() && ["ReturnApproved", "ReturnShipped"].includes(header.statusId),
        assigneePartyId,
        assigneeName: partyName(assigneePartyId),
        authorizedQuantity: qty(authorized),
        receivedQuantity: qty(received),
        acceptedQuantity: qty(accepted),
        rejectedQuantity: qty(rejected),
        settledQuantity: qty(settled),
        settlementPending: received.compare(settled) > 0,
        quantitiesText: [
            qty(authorized) + " authorized",
            qty(received) + " received",
            rejected.compare(0) > 0 ? qty(rejected) + " rejected" : "",
            qty(settled) + " settled"
        ]
            .filter(Boolean)
            .join(" · "),
        creditedText: amounts ? ec.l10n.formatCurrency(creditedAmount, header.currencyUomId || "USD") : null,
        amountsWithheld: !amounts,
        manualReview: header.manualReview === "Y",
        exceptionAsked,
        policyName: header.returnPolicyId ? one(POLICY, {returnPolicyId: header.returnPolicyId})?.policyName || "" : "",
        revision: revisionOf(header.returnId)
    }
}
// find#ServiceReturns: the customer returns of the user's organizations (a supplier return is Purchasing's), by view (design
// Returns), customer, order, status, assignee, text (the return, its RMA number or the customer's reference) and entry period,
// newest first, a page at a time.
function findReturns(p) {
    requirePermission(...readPermissions)
    const userScope = facilityScope.scope()
    const factory = ec.entity.conditionFactory
    const view = views[p.view] || views.all
    let query = find(HEADER).orderBy("-entryDate")
    const internalIds = rows("mantle.party.PartyRole", {roleTypeId: "OrgInternal"}).map(row => row.partyId)
    const vendorIds = userScope.organizationPartyIds || internalIds
    query = query
        .condition("vendorPartyId", "in", vendorIds.length ? vendorIds : ["_NA_"])
        .condition("customerPartyId", "not-in", internalIds)
    if (p.organizationPartyId) query = query.condition("vendorPartyId", String(p.organizationPartyId))
    if (view.statuses) query = query.condition("statusId", "in", view.statuses)
    if (!blank(p.statusId)) query = query.condition("statusId", String(p.statusId))
    if (!blank(p.customerPartyId)) query = query.condition("customerPartyId", String(p.customerPartyId))
    if (p.customerPartyIds) query = query.condition("customerPartyId", "in", list(p.customerPartyIds).concat(["_NA_"]))
    if (!blank(p.text)) {
        const like =
            "%" +
            String(p.text)
                .trim()
                .replace(/[\\%_]/g, c => "\\" + c) +
            "%"
        query = query.condition(
            factory.makeCondition(
                ["returnId", "displayId", "customerReference", "externalId"].map(field =>
                    factory.makeCondition(field, "like", like).ignoreCase()
                ),
                "or"
            )
        )
    }
    if (!blank(p.fromDate)) query = query.condition("entryDate", "greater-equals", p.fromDate)
    if (!blank(p.thruDate)) query = query.condition("entryDate", "less", p.thruDate)
    if (view.expiring)
        query = query
            .condition("authorizationExpireDate", "is-not-null", null)
            .condition("authorizationExpireDate", "less", stamp(nowMs() + 7 * dayMs))
    let headers = Array.from(query.limit(500).list())
    if (!blank(p.orderId)) {
        const returnIds = new Set(rows(ITEM, {orderId: String(p.orderId)}).map(row => row.returnId))
        headers = headers.filter(row => returnIds.has(row.returnId))
    }
    if (!blank(p.assigneePartyId)) headers = headers.filter(row => assigneeOf(row.returnId) === String(p.assigneePartyId))
    const amounts = amountPermissions.some(permission => access.has(permission))
    const pageSize = Math.max(1, Math.min(100, Number(p.pageSize || 25)))
    const pageIndex = Math.max(0, Number(p.pageIndex || 0))
    let returnRows = headers.map(row => returnRow(row, amounts))
    if (view.settlementPending) returnRows = returnRows.filter(row => row.settlementPending)
    return {
        returnRows: returnRows.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize),
        returnRowsCount: returnRows.length,
        returnRowsPageIndex: pageIndex,
        returnRowsPageSize: pageSize,
        amountsWithheld: !amounts
    }
}
// find#ReturnApprovals (Home's AwaitingReturns): the open returns of the user's organizations waiting for authorization, the
// oldest first, with the expiry an authorization now would have and the exception waiting.
function findApprovals(p) {
    requirePermission("RETURN_AUTHORIZE", "RETURN_EXCEPTION_APPROVE")
    const found = findReturns(Object.assign({}, p, {view: "requested", pageSize: 100}))
    const limit = Math.max(1, Math.min(50, Number(p.limit || 10)))
    const approvalRows = found.returnRows
        .reverse()
        .slice(0, limit)
        .map(row => {
            let outcome = {}
            try {
                outcome = evaluationResult(evaluateCore({returnId: row.returnId}))
            } catch (error) {
                ec.logger.warn("Return " + row.returnId + " was not evaluated: " + error.message)
            }
            return Object.assign(row, {
                previewExpireText: outcome.expireText || "",
                outcome: outcome.outcome || "",
                exceptionText: outcome.exceptionText || (outcome.manualReview ? "no policy: manual review" : "")
            })
        })
    return {approvalRows, approvalCount: found.returnRowsCount}
}
// get#ReturnDetail's Mantle part: the return's policy evaluation, its decisions, its assignee and revision (ReturnDetail).
function returnState(p) {
    requirePermission(...readPermissions)
    const header = customerReturn(p.returnId)
    const amounts = amountPermissions.some(permission => access.has(permission))
    const decisions = rows(DECISION, {returnId: header.returnId})
        .sort((a, b) => msOf(b.decisionDate) - msOf(a.decisionDate))
        .map(row => ({
            decisionText: enumText(row.decisionEnumId),
            dateText: lib.dateText(row.decisionDate),
            byName: partyName(row.decidedByPartyId) || row.decidedByUserId || "",
            reason: row.reason || "",
            exceptionText: row.exceptionText || "",
            current: row.sourceRevision === revisionOf(header.returnId)
        }))
    let evaluation = null
    try {
        evaluation = evaluationResult(evaluateCore({returnId: header.returnId}))
    } catch (error) {
        if (lib.reasonCode(error) == null) ec.logger.warn("Return " + header.returnId + " evaluation: " + error.message)
    }
    const revision = revisionOf(header.returnId)
    return {
        returnRow: returnRow(header, amounts),
        evaluation,
        decisions,
        sourceRevision: revision,
        exceptionApproved: !!exceptionApproved(header.returnId, revision),
        effects: effectsOf(header.returnId),
        rmaContentId:
            rows(CONTENT, {returnId: header.returnId, contentTypeEnumId: "RtcntAuthorization"}).sort(
                (a, b) => msOf(b.contentDate) - msOf(a.contentDate)
            )[0]?.returnContentId || null
    }
}

// ===== the RMA (outputs) =====
// The RMA authorization as the customer reads it: the return, the customer's reference, what to send back and why, the
// expiry, where to send it, the label's tracking and the policy's instructions; no amount, cost or internal note.
function printOf(header) {
    const facility = header.facilityId ? one("mantle.facility.Facility", {facilityId: header.facilityId}) : null
    const facilityMech = facility
        ? rows("mantle.facility.FacilityContactMech", {facilityId: facility.facilityId}).find(row =>
              ["PostalShippingDest", "PostalPrimary"].includes(row.contactMechPurposeId)
          )
        : null
    const address = facilityMech ? one("mantle.party.contact.PostalAddress", {contactMechId: facilityMech.contactMechId}) : null
    const policy = header.returnPolicyId ? one(POLICY, {returnPolicyId: header.returnPolicyId}) : null
    const routes = rows("mantle.shipment.ShipmentItemSource", {returnId: header.returnId}).map(row => row.shipmentId)
    const packages = routes.length
        ? Array.from(
              find("mantle.shipment.ShipmentPackageRouteSeg")
                  .condition("shipmentId", "in", Array.from(new Set(routes)))
                  .list()
          )
        : []
    const tracking = packages.map(row => row.trackingCode).filter(Boolean)
    const lines = topItems(header.returnId).map(item => {
        const product = item.productId ? one("mantle.product.Product", {productId: item.productId}) : null
        return {
            productText: product
                ? [product.pseudoId || product.productId, product.productName].filter(Boolean).join(" · ")
                : item.description,
            quantityText: qty(item.returnQuantity),
            reasonText: enumText(item.returnReasonEnumId),
            responseText: enumText(item.returnResponseEnumId)
        }
    })
    const printHtml = ec.resource.template("component://mr-mantle/template/order/ReturnAuthorization.print.html.fancy", {
        returnId: header.returnId,
        displayId: header.displayId || header.returnId,
        organizationName: partyName(header.vendorPartyId),
        customerName: partyName(header.customerPartyId),
        customerReference: header.customerReference || "",
        authorizedText: lib.dateText(ec.user.nowTimestamp),
        expireText: header.authorizationExpireDate ? lib.dateText(header.authorizationExpireDate) : "",
        shipToText: address
            ? [
                  facility.facilityName,
                  address.address1,
                  address.address2,
                  [address.city, address.postalCode].filter(Boolean).join(" ")
              ]
                  .filter(Boolean)
                  .join(", ")
            : facility?.facilityName || "",
        trackingText: tracking.join(", "),
        instructions: policy?.instructions || "",
        lines
    })
    return {printHtml, fileName: "RMA-" + (header.displayId || header.returnId) + ".pdf"}
}
function print(p) {
    requirePermission(...readPermissions)
    const header = customerReturn(p.returnId)
    if (!authorizedStatuses.includes(header.statusId))
        denied("RETURN_NOT_AUTHORIZED", "Return " + header.returnId + " is not authorized yet")
    return Object.assign({returnId: header.returnId}, printOf(header))
}
// The RMA stored as the return's ReturnContent (RtcntAuthorization): its PDF, once per authorization.
function storeAuthorization(returnId) {
    const header = one(HEADER, {returnId})
    const printed = printOf(header)
    const pdf = ec.resource.xslFoTransform(printed.printHtml, null, null, "application/pdf")
    const key = ec.user
        .singleUseCodeHash(printed.printHtml)
        .replace(/[^A-Za-z0-9]/g, "")
        .slice(0, 24)
    const location = "dbresource://mantle/content/return/" + returnId + "/rma_" + key + "/" + printed.fileName
    ec.resource.getLocationReference(location).putBytes(pdf)
    return call("create#" + CONTENT, {
        returnId,
        contentTypeEnumId: "RtcntAuthorization",
        contentLocation: location,
        description: "Return authorization " + (header.displayId || returnId),
        contentDate: ec.user.nowTimestamp,
        userId: ec.user.userId
    }).returnContentId
}
// send#ReturnAuthorization: the stored RMA (stored now if it is not) and its label's tracking to a checked recipient (the
// customer's or a current contact's address), as a mail client draft of an account the user sends from, sent and filed on
// the return; the RMA link of the Support app when a capability is made for it. The same operation key answers the first.
function send(p) {
    requirePermission(...enterPermissions)
    const header = customerReturn(p.returnId)
    if (!authorizedStatuses.includes(header.statusId))
        denied("RETURN_NOT_AUTHORIZED", "Return " + header.returnId + " is not authorized yet")
    const recipient = String(p.toAddress || "")
        .trim()
        .toLowerCase()
    if (!recipient) denied("RECIPIENT_REQUIRED", "Give the address to send the authorization to")
    const operation = lib.operation(p, "ReturnAuthorizationSend", header.vendorPartyId, {
        returnId: header.returnId,
        recipient,
        emailAccountId: p.emailAccountId || null,
        note: p.note || null
    })
    if (operation.old) return lib.previous(operation)
    const confirmations = ec.resource.script("component://mr-mantle/service/mantle/order/OrderConfirmations.js")
    const allowed = confirmations.allowedRecipients([header.customerPartyId])
    if (!allowed.has(recipient))
        denied(
            "RECIPIENT_UNCHECKED",
            recipient + " is not an address of " + partyName(header.customerPartyId) + " or of its contacts"
        )
    const account = confirmations.senderAccount(p.emailAccountId, header.vendorPartyId)
    const stored =
        rows(CONTENT, {returnId: header.returnId, contentTypeEnumId: "RtcntAuthorization"}).sort(
            (a, b) => msOf(b.contentDate) - msOf(a.contentDate)
        )[0] || one(CONTENT, {returnContentId: storeAuthorization(header.returnId)})
    const printed = printOf(header)
    const fileName = String(stored.contentLocation).substring(String(stored.contentLocation).lastIndexOf("/") + 1)
    const body =
        (p.note ? "<p>" + escapeHtml(p.note).replace(/\n/g, "<br>") + "</p>" : "") +
        "<p>" +
        escapeHtml(
            ec.l10n.localize("Your return is authorized") +
                ": " +
                (header.displayId || header.returnId) +
                (header.authorizationExpireDate
                    ? ". " + ec.l10n.localize("Please send it by") + " " + lib.dateText(header.authorizationExpireDate)
                    : "") +
                "."
        ) +
        "</p>" +
        (p.linkUrl
            ? '<p><a href="' + escapeHtml(p.linkUrl) + '">' + escapeHtml(ec.l10n.localize("Follow your return")) + "</a></p>"
            : "") +
        "<p>" +
        escapeHtml(ec.l10n.localize("The authorization with what to send and where is attached.")) +
        "</p>"
    const draft = lib.call("org.moqui.impl.EmailClientServices.save#Draft", {
        emailAccountId: account.emailAccountId,
        toAddresses: recipient,
        subject: p.subject || ec.l10n.localize("Return authorization") + " " + (header.displayId || header.returnId),
        body,
        attachmentList: [{attachmentLocation: stored.contentLocation, fileName, contentType: "application/pdf"}]
    })
    const sent = lib.call("mantle.party.CommunicationServices.send#EmailDraft", {
        emailMessageId: draft.emailMessageId,
        recordEntityName: HEADER,
        recordId: header.returnId
    })
    const result = {
        returnId: header.returnId,
        returnContentId: stored.returnContentId,
        emailMessageId: draft.emailMessageId,
        recipient,
        recipientPartyId: allowed.get(recipient),
        status: sent.sent ? "sent" : sent.sendError ? "failed" : "queued",
        printedFileName: printed.fileName
    }
    lib.complete(operation, "moqui.basic.email.EmailMessage", draft.emailMessageId, result)
    return Object.assign(result, {alreadyApplied: false})
}

const operations = {
    findPolicies,
    savePolicy,
    saveReason,
    evaluate,
    saveItem: p => saveItem(p),
    assign,
    submit,
    requestException,
    decide: p => decide(p),
    approveFromTopic: p => decideFromTopic(p, "approve"),
    refuseFromTopic: p => decideFromTopic(p, "refuse"),
    authorize,
    cancelReturn,
    closeRemainder,
    findReturns,
    findApprovals,
    returnState,
    print,
    send
}
;({
    revisionOf,
    // each operation checks its own permission and organization, and reads and writes with artifact authorization off
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown return policy operation " + op)
        const wasDisabled = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](parameters || {})
        } finally {
            if (!wasDisabled) ec.artifactExecution.enableAuthz()
        }
    }
})
