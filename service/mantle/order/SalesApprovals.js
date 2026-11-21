// Sales defaults, approval policies and approvals (mantle.order.SalesApprovalServices; IronStone Sales design §9 SalesDefaults and
// ApprovalPolicies, §5 Approvals and the approval binding, §13.1; impl-sales P9, §4 Nov 11 and Nov 13, F14, F26, F58, F60).
//
// - SalesPolicy: an organization's dated defaults, one in effect at a time; store#SalesPolicy publishes a successor from now or
//   later and ends the row it replaces there (a preview writes nothing). Its quote validity and default team are read by create#Quote,
//   its intake retention by purge#LeadIntakes; its templates, response requirements, thresholds, net-terms option and the approval
//   setting are read by the phases that send, accept and approve (P10, P11, P13). Follow-up 5: its default facility (a warehouse,
//   store or plant the organization owns) is given to a Sales order part that names none when it is made and before it is placed
//   (applyDefaultFacility), so reservation and the shipment's origin have one; facilityRefusal is the one check of a part's facility.
// - SalesApprovalPolicy: an organization's dated rules, each of one purpose (SapQuote: a quote's exception, decided before it is
//   proposed; SapOrder: the final approval of a sales order, a person's approve#Order) and one bounded type: SarAmount (the total at
//   or above a threshold in its currency), SarDiscount (a line's price at or beyond a percent under its calculated price), SarPriceFloor
//   (a line's price under the product's cost and a margin; a line whose cost is not known needs approval; the cost is read here and
//   never answered) and SarFreeLine (a free or zero-price line). With no quote rule in effect, a manual price on a quote needs an
//   approver other than its author (SarOverride, design §9 "until configured").
// - A requirement is a rule a quote meets at its current revision; its approval is an OrderDecision of purpose SapQuote bound to that
//   revision and rule (SdrApproved or SdrRefused), an approval asked an SdrRequested row of the rule. A later revision supersedes
//   every decision (the SECA on increment#OrderRevision marks invalidatedDate, and currency is read by revision anyway). The approver holds
//   SALES_APPROVE in the quote's organization (and is in the rule's group when it names one) and is not its author (its owner, who
//   asked for the approval, or who entered a line the rule names) unless the rule allows it.
// - The SalesQuoteApproval topic (data/15-seed-initial/Notifications.xml) carries the request to the approvers; its title names the quote and the
//   customer and never an amount; its handlers decide at the revision in the message.
// - Sales' pre-approval warnings (§4 Nov 11): for an order whose seller has a rule in effect, an unresolved quote requirement of an
//   accepted quote and an order rule the order meets are added to check#OrderPreApprove's approveWarnings, so with the seller's
//   approval setting off they stop autoApprove#Order as the credit and purchase warnings do; a person's approve#Order does not call
//   that check. An organization with no rule adds nothing.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const salesAccess = ec.resource.script("component://mr-mantle/service/mantle/sales/SalesAccess.js")
const {find, one, rows, denied, call, ms} = lib

const POLICY = "mantle.sales.policy.SalesPolicy"
const THRESHOLD = "mantle.sales.policy.SalesPolicyThreshold"
const RULE = "mantle.sales.policy.SalesApprovalPolicy"
const DECISION = "mantle.order.OrderDecision"
const ORDER = "mantle.order.OrderHeader"
const PART = "mantle.order.OrderPart"
const ITEM = "mantle.order.OrderItem"
const PART_PARTY = "mantle.order.OrderPartParty"
const topic = "SalesQuoteApproval"
const purposes = {quote: "SapQuote", order: "SapOrder"}
const ruleTypes = ["SarAmount", "SarDiscount", "SarPriceFloor", "SarFreeLine"]
const overrideRule = "SarOverride"
const ruleKinds = {
    SarAmount: "amount",
    SarDiscount: "discount",
    SarPriceFloor: "price floor",
    SarFreeLine: "free line",
    SarOverride: "manual price"
}
const results = {requested: "SdrRequested", approved: "SdrApproved", refused: "SdrRefused"}
// P10: a quote being revised (Proposed to Being changed, revise#Quote) is a draft again
const draftStatuses = ["OrderOpen", "OrderBeingChanged"]
const taxTypes = ["ItemSalesTax", "ItemVatTax"]
const policyFields = [
    "defaultTeamPartyId",
    "quoteValidityDays",
    "quoteEmailTemplateId",
    "confirmationEmailTemplateId",
    "reminderEmailTemplateId",
    "responsePoRequired",
    "orderApprovalRequired",
    "approveNetTermsOrders",
    "intakeRetentionDays",
    "reminderDays",
    // P10: the stored text of the quote's cover and terms and of its reminder (F70)
    "quoteTextLocation",
    "reminderTextLocation",
    // P20 review: whether a request for quote made from mail is acknowledged, and its stored text (design §16)
    "rfqAcknowledge",
    "rfqAcknowledgeTextLocation",
    // follow-up 5: the facility a Sales order part ships from when it names none
    "defaultFacilityId"
]
const flagFields = ["responsePoRequired", "orderApprovalRequired", "approveNetTermsOrders", "rfqAcknowledge"]
const dayFields = ["quoteValidityDays", "intakeRetentionDays", "reminderDays"]
const ruleFields = [
    "purposeEnumId",
    "ruleTypeEnumId",
    "thresholdAmount",
    "currencyUomId",
    "discountPercent",
    "floorMarginPercent",
    "approverUserGroupId",
    "selfApprovalAllowed",
    "description"
]
const minuteMs = 60 * 1000
// follow-up 5: the facility types a Sales order part ships from
const shippingFacilityTypes = ["FcTpWarehouse", "FcTpRetailStore", "FcTpPlant"]

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const flag = value => value === true || value === "true" || value === "Y"
const L = value => ec.l10n.localize(value)
const nowMs = () => ms(ec.user.nowTimestamp)
const partyName = partyId => (partyId ? lib.partyNames([partyId])[partyId] || partyId : "")
const userName = userId => {
    if (!userId) return ""
    const account = one("moqui.security.UserAccount", {userId})
    return account?.userFullName || account?.username || userId
}
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const moneyText = (value, currencyUomId) =>
    value == null ? "" : ec.l10n.formatCurrency(ec.l10n.roundCurrency(toDecimal(value), currencyUomId), currencyUomId)
const percentText = value => (value == null ? "" : String(Number(toDecimal(value).setScale(1, "HALF_UP").toNumber())) + " %")
const revisionOf = order => Number(order?.orderRevision ?? 1)
const inEffect = (row, at = nowMs()) => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at
const stamp = row => String(ms(row?.lastUpdatedStamp) ?? 0)

// The audit log's reason for each field a write sets (entity-auto's <field>_changeReason).
const auditReasons = (fields, reason) => Object.fromEntries(fields.map(field => [field + "_changeReason", reason]))
function decimal(value, label) {
    let number
    try {
        number = toDecimal(value)
    } catch (_) {
        number = null
    }
    if (number == null || number.compare(0) < 0) denied("VALUE_INVALID", "Enter " + label + " of zero or more")
    return number
}
function days(value, label) {
    if (blank(value)) return null
    const number = Number(value)
    if (!Number.isInteger(number) || number < 1 || number > 3650) denied("VALUE_INVALID", label + " is a whole number of days")
    return number
}
function fromNow(value, label) {
    if (blank(value)) return nowMs()
    const millis = ms(value)
    if (!Number.isFinite(millis) || millis < nowMs() - minuteMs) denied("DATE_INVALID", label + " is now or later")
    return millis
}

// ===== scope =====
function configurer(organizationPartyId) {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in to change Sales' defaults")
    const userScope = salesAccess.scope()
    salesAccess.requireCapability(userScope, "configure")
    const chosen = text(organizationPartyId) || salesAccess.defaultOrganization(userScope)
    if (!chosen || !salesAccess.isInternal(chosen)) denied("ORGANIZATION_DENIED", "Choose the organization")
    salesAccess.requireOrganization(userScope, chosen)
    return {userScope, organizationPartyId: chosen}
}
// The quote as an approver or the caller may see it: SalesAccess.js quoteOf, which admits a holder of SALES_APPROVE to a quote of
// their organizations that asked for an approval (P9).
function quoteFor(userScope, orderId) {
    const quote = salesAccess.quoteOf(userScope, text(orderId))
    if (!quote) denied("RECORD_UNAVAILABLE", "Quote " + (orderId || "") + " is not available")
    return quote
}
function requireRevision(order, given) {
    if (blank(given)) denied("REVISION_REQUIRED", "Reload the quote and try again (revision " + revisionOf(order) + ")")
    if (Number(given) !== revisionOf(order))
        denied("REVISION_CHANGED", "Quote " + order.orderId + " changed; its current revision is " + revisionOf(order))
}

// ===== policies =====
// The organization's SalesPolicy in effect at a time (now when not given), or null.
function policyOf(organizationPartyId, at = nowMs()) {
    if (!organizationPartyId) return null
    return (
        rows(POLICY, {organizationPartyId})
            .filter(row => inEffect(row, at))
            .sort((a, b) => (ms(b.fromDate) ?? 0) - (ms(a.fromDate) ?? 0))[0] || null
    )
}
function thresholdsOf(salesPolicyId) {
    return salesPolicyId
        ? rows(THRESHOLD, {salesPolicyId}).map(row => ({currencyUomId: row.currencyUomId, thresholdAmount: row.thresholdAmount}))
        : []
}
function policyView(row) {
    if (!row) return null
    const view = {salesPolicyId: row.salesPolicyId, fromDate: row.fromDate, thruDate: row.thruDate}
    for (const field of policyFields) view[field] = row[field] ?? null
    view.fromText = lib.dateText(row.fromDate)
    view.thruText = row.thruDate ? lib.dateText(row.thruDate) : ""
    view.teamName = row.defaultTeamPartyId ? partyName(row.defaultTeamPartyId) : ""
    view.facilityName = row.defaultFacilityId ? facilityName(row.defaultFacilityId) : ""
    view.changeReason = row.changeReason || ""
    view.changedByName = userName(row.changedByUserId)
    view.thresholds = thresholdsOf(row.salesPolicyId).map(found =>
        Object.assign(found, {thresholdText: moneyText(found.thresholdAmount, found.currencyUomId)})
    )
    view.revision = stamp(row)
    return view
}
// The values a policy publishes: the one replaced (or none), changed by the fields given; a team of the organization, positive day
// counts, Y or N flags and one threshold per currency.
function policyValues(organizationPartyId, replaced, p) {
    const values = {}
    for (const field of policyFields) values[field] = replaced ? (replaced[field] ?? null) : null
    // a field not given (or null) keeps the value it replaces; an empty one clears it
    for (const field of policyFields) if (Object.hasOwn(p, field) && p[field] != null) values[field] = text(p[field])
    for (const field of flagFields) values[field] = values[field] == null ? null : flag(values[field]) ? "Y" : "N"
    for (const field of dayFields) values[field] = days(values[field], field)
    if (values.defaultTeamPartyId && salesAccess.teamOrganization(values.defaultTeamPartyId) !== organizationPartyId)
        denied("TEAM_INVALID", "Choose a team of the organization")
    const facilityRefused = values.defaultFacilityId ? facilityRefusal(organizationPartyId, values.defaultFacilityId) : null
    if (facilityRefused) denied("FACILITY_INVALID", facilityRefused)
    for (const field of ["quoteEmailTemplateId", "confirmationEmailTemplateId", "reminderEmailTemplateId"])
        if (values[field] && !one("moqui.basic.email.EmailTemplate", {emailTemplateId: values[field]}))
            denied("TEMPLATE_INVALID", "Choose a mail template")
    let thresholds = replaced ? thresholdsOf(replaced.salesPolicyId) : []
    if (Array.isArray(p.acceptanceThresholds) || (p.acceptanceThresholds && typeof p.acceptanceThresholds.length === "number")) {
        thresholds = []
        for (const entry of Array.from(p.acceptanceThresholds)) {
            const currencyUomId = text(entry?.currencyUomId)
            if (!currencyUomId || one("moqui.basic.Uom", {uomId: currencyUomId})?.uomTypeEnumId !== "UT_CURRENCY_MEASURE")
                denied("CURRENCY_INVALID", "A threshold names its currency")
            if (blank(entry.thresholdAmount)) continue
            if (thresholds.some(found => found.currencyUomId === currencyUomId))
                denied("THRESHOLD_DUPLICATE", "One threshold per currency")
            thresholds.push({currencyUomId, thresholdAmount: decimal(entry.thresholdAmount, "a threshold")})
        }
    }
    return {values, thresholds}
}
// store#SalesPolicy: the organization's defaults published from now or later as a successor of the row in effect then (ended there);
// a successor that starts after another scheduled one replaces nothing earlier. previewOnly Y answers the values and their changes
// and writes nothing. Each change names the revision of the row it replaces (REVISION_CHANGED).
function storePolicy(p) {
    const {organizationPartyId} = configurer(p.organizationPartyId)
    const reason = text(p.changeReason)
    const fromMillis = fromNow(p.fromDate, "The start")
    const current = policyOf(organizationPartyId, fromMillis)
    if (current && !blank(p.revision) && String(p.revision) !== stamp(current))
        denied("REVISION_CHANGED", "The defaults changed since you read them; open them again")
    const {values, thresholds} = policyValues(organizationPartyId, current, p)
    const changes = []
    for (const field of policyFields) {
        const before = current ? (current[field] ?? null) : null
        if (String(before ?? "") !== String(values[field] ?? ""))
            changes.push({field, beforeText: before ?? "", afterText: values[field] ?? ""})
    }
    const beforeThresholds = current ? thresholdsOf(current.salesPolicyId) : []
    const thresholdText = list =>
        list
            .map(found => found.currencyUomId + " " + String(found.thresholdAmount))
            .sort()
            .join(", ")
    if (thresholdText(beforeThresholds) !== thresholdText(thresholds))
        changes.push({
            field: "acceptanceThresholds",
            beforeText: thresholdText(beforeThresholds),
            afterText: thresholdText(thresholds)
        })
    if (flag(p.previewOnly)) return {salesPolicyId: current?.salesPolicyId || null, changes, published: false}
    if (!reason) denied("REASON_REQUIRED", "Give the reason for the change")
    // a successor names the revision of the defaults it replaces (§2 "every write names the revision it read")
    if (current && blank(p.revision)) denied("REVISION_REQUIRED", "Open the defaults again and publish from them")
    if (current && !changes.length) denied("NO_CHANGE", "Nothing changed")
    if (current && ms(current.fromDate) >= fromMillis)
        denied("DATE_INVALID", "The new defaults start after the ones they replace (" + lib.dateText(current.fromDate) + ")")
    // a scheduled row that starts later stays; the successor ends where it starts
    const later = rows(POLICY, {organizationPartyId})
        .filter(row => (ms(row.fromDate) ?? 0) > fromMillis)
        .sort((a, b) => ms(a.fromDate) - ms(b.fromDate))[0]
    const reasons = auditReasons(policyFields.concat(["fromDate", "thruDate", "changeReason"]), reason)
    if (current)
        call("update#" + POLICY, {
            salesPolicyId: current.salesPolicyId,
            thruDate: new Date(fromMillis),
            changeReason: reason,
            changedByUserId: ec.user.userId,
            thruDate_changeReason: reason
        })
    const created = call(
        "create#" + POLICY,
        Object.assign({}, values, reasons, {
            organizationPartyId,
            fromDate: new Date(fromMillis),
            thruDate: later ? later.fromDate : current?.thruDate || null,
            changeReason: reason,
            changedByUserId: ec.user.userId
        })
    )
    for (const found of thresholds)
        call("create#" + THRESHOLD, {
            salesPolicyId: created.salesPolicyId,
            currencyUomId: found.currencyUomId,
            thresholdAmount: found.thresholdAmount
        })
    return {salesPolicyId: created.salesPolicyId, changes, published: true}
}
// ===== follow-up 5: the facility a Sales order part ships from =====
function facilityName(facilityId) {
    const facility = facilityId ? one("mantle.facility.Facility", {facilityId}) : null
    return facility ? facility.facilityName || facility.pseudoId || facilityId : facilityId || ""
}
// Why a facility may not be a Sales order part's of the organization, or null: one it owns, a warehouse, store or plant, not closed.
function facilityRefusal(organizationPartyId, facilityId) {
    const facility = facilityId ? one("mantle.facility.Facility", {facilityId: String(facilityId)}) : null
    if (!facility || !organizationPartyId || facility.ownerPartyId !== organizationPartyId)
        return "Choose a facility of " + (partyName(organizationPartyId) || "the selling organization")
    if (!shippingFacilityTypes.includes(facility.facilityTypeEnumId))
        return "Choose a warehouse, store or plant to ship from; " + facilityName(facilityId) + " is not one"
    if (facility.closedDate && ms(facility.closedDate) <= nowMs()) return facilityName(facilityId) + " is closed"
    return null
}
// The facilities a Sales order part of the organization may ship from, searched ignoring case by name or id ({value, label}), for a
// drop-down (the caller has checked the organization).
function facilityOptions(organizationPartyId, term, limit = 30) {
    if (!organizationPartyId) return []
    const factory = ec.entity.conditionFactory
    let query = find("mantle.facility.Facility")
        .condition("ownerPartyId", organizationPartyId)
        .condition("facilityTypeEnumId", "in", shippingFacilityTypes)
        .condition(
            factory.makeCondition(
                [
                    factory.makeCondition("closedDate", "is-null", null),
                    factory.makeCondition("closedDate", "greater", ec.user.nowTimestamp)
                ],
                "or"
            )
        )
        .orderBy("facilityName")
        .limit(limit)
    const searched = text(term)
    if (searched) {
        const like = "%" + searched.replace(/[\\%_]/g, character => "\\" + character) + "%"
        query = query.condition(
            factory.makeCondition(
                ["facilityId", "facilityName", "pseudoId"].map(field => factory.makeCondition(field, "like", like).ignoreCase()),
                "or"
            )
        )
    }
    return Array.from(query.list()).map(row => ({
        value: row.facilityId,
        label: row.facilityName || row.pseudoId || row.facilityId
    }))
}
// The organization's default facility in effect now, while it still qualifies (a facility since sold or closed is none), or null.
function defaultFacilityOf(organizationPartyId) {
    const facilityId = policyOf(organizationPartyId)?.defaultFacilityId || null
    return facilityId && !facilityRefusal(organizationPartyId, facilityId) ? facilityId : null
}
// Each Sales part of the order (an internal seller, a customer that is not internal) that names no facility given its seller's
// default (a quote or direct order made, a copy, a recurring order, a part placed); a part with a facility keeps it, and a seller
// with no default leaves it as it is. Answers the parts given one.
function applyDefaultFacility(orderId) {
    let applied = 0
    if (blank(orderId)) return applied
    for (const part of rows(PART, {orderId: String(orderId)})) {
        if (part.facilityId || !part.vendorPartyId || !part.customerPartyId) continue
        if (!salesAccess.isInternal(part.vendorPartyId) || salesAccess.isInternal(part.customerPartyId)) continue
        const facilityId = defaultFacilityOf(part.vendorPartyId)
        if (!facilityId) continue
        call("update#" + PART, {orderId: part.orderId, orderPartSeqId: part.orderPartSeqId, facilityId})
        applied++
    }
    return applied
}

// get#SalesPolicy: the organization's defaults in effect, the scheduled ones and the earlier ones (each with who and why), the
// effective commercial revision flag (X2, F9) and where it is set, for a configurer of the organization.
function getPolicy(p) {
    const {organizationPartyId} = configurer(p.organizationPartyId)
    const now = nowMs()
    const all = rows(POLICY, {organizationPartyId}).sort((a, b) => (ms(b.fromDate) ?? 0) - (ms(a.fromDate) ?? 0))
    const current = all.find(row => inEffect(row, now)) || null
    const preference = commercialRevisionOf(organizationPartyId)
    return {
        organizationPartyId,
        organizationName: partyName(organizationPartyId),
        policy: policyView(current),
        scheduled: all.filter(row => (ms(row.fromDate) ?? 0) > now).map(policyView),
        earlier: all
            .filter(row => (ms(row.thruDate) ?? Infinity) <= now)
            .slice(0, 20)
            .map(policyView),
        commercialRevisionOnly: preference.on,
        commercialRevisionOwnerName: preference.ownerPartyId ? partyName(preference.ownerPartyId) : "",
        commercialRevisionOwn: preference.ownerPartyId === organizationPartyId
    }
}
// The effective commercial revision flag of a seller (OrderServices increment#OrderRevision reads it through
// find#PartyAcctgPreference, which takes a parent organization's row when the seller has none): {on, ownerPartyId}.
function commercialRevisionOf(organizationPartyId) {
    const found =
        call("mantle.ledger.LedgerServices.find#PartyAcctgPreference", {organizationPartyId}).partyAcctgPreference || null
    return {on: found?.salesCommercialRevisionOnly === "Y", ownerPartyId: found?.organizationPartyId || null}
}
// store#SalesCommercialRevision: the seller's own PartyAcctgPreference.salesCommercialRevisionOnly (X2, F9: a quote is issued only
// where it is on), audit-logged with the reason; a seller that takes its preference from a parent organization is refused
// (PREFERENCE_INHERITED), as the flag would change every organization of that parent.
function storeCommercialRevision(p) {
    const {organizationPartyId} = configurer(p.organizationPartyId)
    const reason = text(p.changeReason)
    if (!reason) denied("REASON_REQUIRED", "Give the reason for the change")
    const own = one("mantle.ledger.config.PartyAcctgPreference", {organizationPartyId})
    if (!own) {
        const effective = commercialRevisionOf(organizationPartyId)
        denied(
            "PREFERENCE_INHERITED",
            "The organization takes its accounting preference from " +
                (partyName(effective.ownerPartyId) || "another organization") +
                "; set it there"
        )
    }
    call("update#mantle.ledger.config.PartyAcctgPreference", {
        organizationPartyId,
        salesCommercialRevisionOnly: flag(p.commercialRevisionOnly) ? "Y" : "N",
        salesCommercialRevisionOnly_changeReason: reason
    })
    return {commercialRevisionOnly: flag(p.commercialRevisionOnly)}
}

// ===== approval rules =====
function rulesOf(organizationPartyId, purposeEnumId = null, at = nowMs()) {
    if (!organizationPartyId) return []
    return rows(RULE, purposeEnumId ? {organizationPartyId, purposeEnumId} : {organizationPartyId}).filter(row =>
        inEffect(row, at)
    )
}
function approverText(rule) {
    if (rule?.approverUserGroupId)
        return one("moqui.security.UserGroup", {userGroupId: rule.approverUserGroupId})?.description || rule.approverUserGroupId
    return L("A sales approver")
}
function ruleText(rule) {
    switch (rule.ruleTypeEnumId) {
        case "SarAmount":
            return L("Total at or above") + " " + moneyText(rule.thresholdAmount, rule.currencyUomId)
        case "SarDiscount":
            return L("Discount at or beyond") + " " + percentText(rule.discountPercent)
        case "SarPriceFloor":
            return (
                L("Price under its floor") +
                (rule.floorMarginPercent != null && !toDecimal(rule.floorMarginPercent).isZero()
                    ? " (" + L("cost and") + " " + percentText(rule.floorMarginPercent) + ")"
                    : " (" + L("cost") + ")")
            )
        case "SarFreeLine":
            return L("Free or zero-price line")
        default:
            return L("Manual price")
    }
}
function ruleView(row) {
    return {
        salesApprovalPolicyId: row.salesApprovalPolicyId,
        purposeEnumId: row.purposeEnumId,
        purposeText: enumText(row.purposeEnumId),
        ruleTypeEnumId: row.ruleTypeEnumId,
        ruleText: ruleText(row),
        thresholdAmount: row.thresholdAmount ?? null,
        currencyUomId: row.currencyUomId || null,
        discountPercent: row.discountPercent ?? null,
        floorMarginPercent: row.floorMarginPercent ?? null,
        approverUserGroupId: row.approverUserGroupId || null,
        approverText: approverText(row),
        selfApprovalAllowed: row.selfApprovalAllowed === "Y" ? "Y" : "N",
        description: row.description || "",
        fromDate: row.fromDate,
        thruDate: row.thruDate,
        fromText: lib.dateText(row.fromDate),
        thruText: row.thruDate ? lib.dateText(row.thruDate) : "",
        stateText: !inEffect(row)
            ? (ms(row.fromDate) ?? 0) > nowMs()
                ? L("From") + " " + lib.dateText(row.fromDate)
                : L("Ended") + " " + lib.dateText(row.thruDate)
            : row.thruDate
              ? L("Ends") + " " + lib.dateText(row.thruDate)
              : L("In effect"),
        current: inEffect(row),
        ended: (ms(row.thruDate) ?? Infinity) <= nowMs(),
        changeReason: row.changeReason || "",
        changedByName: userName(row.changedByUserId),
        revision: stamp(row)
    }
}
// The rule's values: a purpose and a type, each type with its own inputs (an amount with its currency, a percent, a margin), an
// approver group whose members hold SALES_APPROVE, and self-approval Y or N. No permissive monetary threshold is assumed.
function ruleValues(replaced, p) {
    const values = {}
    for (const field of ruleFields) values[field] = replaced ? (replaced[field] ?? null) : null
    // a field not given (or null) keeps the value it replaces; an empty one clears it
    for (const field of ruleFields) if (Object.hasOwn(p, field) && p[field] != null) values[field] = text(p[field])
    if (!Object.values(purposes).includes(values.purposeEnumId)) denied("PURPOSE_INVALID", "Choose the rule's purpose")
    if (!ruleTypes.includes(values.ruleTypeEnumId)) denied("RULE_INVALID", "Choose the rule's type")
    const type = values.ruleTypeEnumId
    if (type === "SarAmount") {
        if (blank(values.thresholdAmount)) denied("THRESHOLD_REQUIRED", "Give the amount at which approval is needed")
        values.thresholdAmount = decimal(values.thresholdAmount, "an amount")
        if (
            !values.currencyUomId ||
            one("moqui.basic.Uom", {uomId: values.currencyUomId})?.uomTypeEnumId !== "UT_CURRENCY_MEASURE"
        )
            denied("CURRENCY_INVALID", "Choose the amount's currency")
    } else {
        values.thresholdAmount = null
        values.currencyUomId = null
    }
    if (type === "SarDiscount") {
        if (blank(values.discountPercent)) denied("PERCENT_REQUIRED", "Give the discount at which approval is needed")
        values.discountPercent = decimal(values.discountPercent, "a percent")
        if (values.discountPercent.isZero() || values.discountPercent.compare(100) > 0)
            denied("PERCENT_INVALID", "A discount is more than 0 and at most 100 %")
    } else values.discountPercent = null
    if (type === "SarPriceFloor")
        values.floorMarginPercent = blank(values.floorMarginPercent) ? null : decimal(values.floorMarginPercent, "a margin")
    else values.floorMarginPercent = null
    if (values.approverUserGroupId) {
        if (!one("moqui.security.UserGroup", {userGroupId: values.approverUserGroupId}))
            denied("APPROVER_INVALID", "Choose the approvers' group")
        const holds = rows("moqui.security.UserGroupPermission", {
            userGroupId: values.approverUserGroupId,
            userPermissionId: "SALES_APPROVE"
        }).some(row => lib.active(row))
        if (!holds) denied("APPROVER_INVALID", "The approvers' group holds no SALES_APPROVE")
    }
    values.selfApprovalAllowed = flag(values.selfApprovalAllowed) ? "Y" : "N"
    return values
}
// store#SalesApprovalPolicy: a new rule from its date; given a rule (salesApprovalPolicyId), its next version (the rule ends where
// the next starts), or with endPolicy Y the rule ended (from thruDate, now when empty). Each change has its reason and names the
// revision it read; an ended rule is not changed.
function storeRule(p) {
    let replaced = null
    if (!blank(p.salesApprovalPolicyId)) {
        replaced = one(RULE, {salesApprovalPolicyId: String(p.salesApprovalPolicyId)})
        if (!replaced) denied("RECORD_UNAVAILABLE", "Approval rule " + p.salesApprovalPolicyId + " is not available")
    }
    const {userScope, organizationPartyId} = configurer(replaced ? replaced.organizationPartyId : p.organizationPartyId)
    if (replaced && !salesAccess.covers(userScope, replaced.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Approval rule " + p.salesApprovalPolicyId + " is not available")
    const reason = text(p.changeReason)
    if (!reason) denied("REASON_REQUIRED", "Give the reason for the change")
    if (replaced && blank(p.revision)) denied("REVISION_REQUIRED", "Open the rule again and change it from there")
    if (replaced && String(p.revision) !== stamp(replaced))
        denied("REVISION_CHANGED", "The rule changed since you read it; open it again")
    if (replaced && (ms(replaced.thruDate) ?? Infinity) <= nowMs()) denied("RULE_ENDED", "The rule has ended")
    if (replaced && flag(p.endPolicy)) {
        const thru = blank(p.thruDate) ? nowMs() : fromNow(p.thruDate, "The end")
        if (thru <= (ms(replaced.fromDate) ?? 0)) denied("DATE_INVALID", "A rule ends after it starts")
        call("update#" + RULE, {
            salesApprovalPolicyId: replaced.salesApprovalPolicyId,
            thruDate: new Date(thru),
            changeReason: reason,
            changedByUserId: ec.user.userId,
            thruDate_changeReason: reason
        })
        return {salesApprovalPolicyId: replaced.salesApprovalPolicyId, ended: true}
    }
    const values = ruleValues(replaced, p)
    const fromMillis = fromNow(p.fromDate, "The start")
    const thruMillis = blank(p.thruDate) ? null : ms(p.thruDate)
    if (thruMillis != null && (!Number.isFinite(thruMillis) || thruMillis <= fromMillis))
        denied("DATE_INVALID", "A rule ends after it starts")
    if (replaced && (ms(replaced.fromDate) ?? 0) >= fromMillis)
        denied("DATE_INVALID", "The new version starts after the one it replaces")
    if (replaced)
        call("update#" + RULE, {
            salesApprovalPolicyId: replaced.salesApprovalPolicyId,
            thruDate: new Date(fromMillis),
            changeReason: reason,
            changedByUserId: ec.user.userId,
            thruDate_changeReason: reason
        })
    const created = call(
        "create#" + RULE,
        Object.assign({}, values, auditReasons(ruleFields.concat(["fromDate", "thruDate", "changeReason"]), reason), {
            organizationPartyId,
            fromDate: new Date(fromMillis),
            thruDate: thruMillis == null ? null : new Date(thruMillis),
            changeReason: reason,
            changedByUserId: ec.user.userId
        })
    )
    return {salesApprovalPolicyId: created.salesApprovalPolicyId, ended: false}
}
// find#SalesApprovalPolicies: the organization's rules (in effect and scheduled; ended too with includeEnded Y), for a configurer, an
// approver or a Sales reader of the organization (the rules tell a rep what needs approval).
function findRules(p) {
    const userScope = salesAccess.scope()
    salesAccess.requireCapability(userScope, "anyRead")
    const organizationPartyId = text(p.organizationPartyId) || salesAccess.defaultOrganization(userScope)
    if (!organizationPartyId) denied("ORGANIZATION_DENIED", "Choose the organization")
    salesAccess.requireOrganization(userScope, organizationPartyId)
    const now = nowMs()
    const ruleList = rows(RULE, {organizationPartyId})
        .filter(row => flag(p.includeEnded) || (ms(row.thruDate) ?? Infinity) > now)
        .sort(
            (a, b) =>
                String(a.purposeEnumId).localeCompare(String(b.purposeEnumId)) ||
                ruleTypes.indexOf(a.ruleTypeEnumId) - ruleTypes.indexOf(b.ruleTypeEnumId) ||
                (ms(a.fromDate) ?? 0) - (ms(b.fromDate) ?? 0)
        )
        .map(ruleView)
    return {
        organizationPartyId,
        organizationName: partyName(organizationPartyId),
        ruleList,
        configured: rulesOf(organizationPartyId, purposes.quote).length > 0,
        canConfigure: !!userScope.capabilities.configure
    }
}

// ===== evaluation =====
// The product lines of an order with their price facts (tax and child lines left out).
function linesOf(orderId) {
    return rows(ITEM, {orderId})
        .filter(item => !taxTypes.includes(item.itemTypeEnumId) && !item.parentItemSeqId && item.productId)
        .sort((a, b) => String(a.orderItemSeqId).localeCompare(String(b.orderItemSeqId)))
}
// The unit cost of a product for the seller in a currency: its approved standard cost in effect, else the seller's average cost;
// null when neither is known. Read on the server for the floor rule and never answered.
function costOf(productId, organizationPartyId, currencyUomId) {
    const standard = rows("mantle.product.cost.ProductStandardCost", {productId, organizationPartyId, state: "approved"}).filter(
        row => lib.active(row) && !row.facilityId && (!row.priceUomId || row.priceUomId === currencyUomId) && row.unitCost != null
    )[0]
    if (standard) return toDecimal(standard.unitCost)
    const average = rows("mantle.product.ProductPrice", {
        productId,
        vendorPartyId: organizationPartyId,
        priceTypeEnumId: "PptAverage",
        priceUomId: currencyUomId
    }).filter(row => lib.active(row) && row.price != null)[0]
    return average ? toDecimal(average.price) : null
}
const unitOf = item => toDecimal(item.unitAmount ?? 0)
const lineLabel = item => L("Line") + " " + item.orderItemSeqId
// What a rule finds on a line: null, or {lineText, author} (the inputs of the requirement, never a cost).
function lineFinding(rule, item, context) {
    const unit = unitOf(item)
    const basis = item.calculatedUnitAmount == null ? null : toDecimal(item.calculatedUnitAmount)
    switch (rule.ruleTypeEnumId) {
        case "SarFreeLine":
            return unit.isZero() ? {lineText: lineLabel(item) + ": " + L("free of charge")} : null
        case "SarDiscount": {
            if (basis == null || basis.compare(0) <= 0 || unit.compare(basis) >= 0) return null
            const percent = basis.subtract(unit).multiply(100).divide(basis)
            if (percent.compare(toDecimal(rule.discountPercent)) < 0) return null
            return {
                lineText:
                    lineLabel(item) +
                    ": " +
                    moneyText(unit, context.currencyUomId) +
                    " " +
                    L("under the calculated") +
                    " " +
                    moneyText(basis, context.currencyUomId) +
                    " (" +
                    percentText(percent) +
                    ")"
            }
        }
        case "SarPriceFloor": {
            const cost = costOf(item.productId, context.organizationPartyId, context.currencyUomId)
            if (cost == null) return {lineText: lineLabel(item) + ": " + L("the product's cost is not known")}
            const margin = rule.floorMarginPercent == null ? toDecimal(0) : toDecimal(rule.floorMarginPercent)
            const floor = cost.multiply(toDecimal(100).add(margin)).divide(toDecimal(100))
            return unit.compare(floor) < 0 ? {lineText: lineLabel(item) + ": " + L("under its price floor")} : null
        }
        case overrideRule:
            return ["manual", "free"].includes(item.priceSource)
                ? {
                      lineText:
                          lineLabel(item) +
                          ": " +
                          L("entered") +
                          " " +
                          moneyText(unit, context.currencyUomId) +
                          (basis == null ? "" : " (" + L("calculated") + " " + moneyText(basis, context.currencyUomId) + ")")
                  }
                : null
        default:
            return null
    }
}
// The users who entered or changed the order's lines (all, or those of seqIds) since its last approval of the purpose (the
// audit log of OrderItem's quantity, price and product): each is an author of a requirement those lines meet, so an editor
// of a quote's quantities does not approve its amount rule, a refusal between included (SEC-BAP-113).
function lineEditors(orderId, purposeEnumId, seqIds = null) {
    const decided = rows(DECISION, {orderId, decisionPurposeEnumId: purposeEnumId})
        .filter(row => row.decisionResultEnumId === results.approved)
        .map(row => Number(ms(row.decisionDate) || 0))
    const since = decided.length ? Math.max(...decided) : 0
    let query = find("moqui.entity.EntityAuditLog")
        .condition({changedEntityName: "mantle.order.OrderItem", pkPrimaryValue: orderId})
        .condition("changedFieldName", "in", ["quantity", "unitAmount", "productId"])
    if (since) query = query.condition("changedDate", "greater", new Date(since))
    return Array.from(
        new Set(
            Array.from(query.list())
                .filter(row => !seqIds || seqIds.includes(row.pkSecondaryValue))
                .map(row => row.changedByUserId)
                .filter(Boolean)
        )
    )
}
// The requirements of an order of an organization for a purpose at its current lines and total: each rule it meets, with its inputs,
// the lines it names and their authors; with no quote rule in effect, a quote's manual prices (SarOverride).
function requirementsOf(order, part, purposeEnumId) {
    const organizationPartyId = part.vendorPartyId
    const context = {organizationPartyId, currencyUomId: order.currencyUomId}
    let rules = rulesOf(organizationPartyId, purposeEnumId).map(row => lib.map(row))
    const configured = rules.length > 0
    if (!configured && purposeEnumId === purposes.quote)
        rules = [{salesApprovalPolicyId: null, purposeEnumId, ruleTypeEnumId: overrideRule, selfApprovalAllowed: "N"}]
    const lines = linesOf(order.orderId)
    const found = []
    for (const rule of rules) {
        const inputs = []
        const lineSeqIds = []
        const authorUserIds = []
        if (rule.ruleTypeEnumId === "SarAmount") {
            if (rule.currencyUomId !== order.currencyUomId) continue
            const total = toDecimal(order.grandTotal ?? 0)
            if (total.compare(toDecimal(rule.thresholdAmount)) < 0) continue
            inputs.push(L("Total") + " " + moneyText(total, order.currencyUomId))
        } else {
            for (const item of lines) {
                const finding = lineFinding(rule, item, context)
                if (!finding) continue
                inputs.push(finding.lineText)
                lineSeqIds.push(item.orderItemSeqId)
                if (item.priceOverrideUserId) authorUserIds.push(item.priceOverrideUserId)
            }
            if (!lineSeqIds.length) continue
        }
        authorUserIds.push(...lineEditors(order.orderId, purposeEnumId, rule.ruleTypeEnumId === "SarAmount" ? null : lineSeqIds))
        found.push({
            key: rule.salesApprovalPolicyId || "default",
            salesApprovalPolicyId: rule.salesApprovalPolicyId || null,
            purposeEnumId,
            ruleTypeEnumId: rule.ruleTypeEnumId,
            ruleText: ruleText(rule),
            approverUserGroupId: rule.approverUserGroupId || null,
            approverText: approverText(rule),
            selfApprovalAllowed: rule.selfApprovalAllowed === "Y",
            inputs,
            lineSeqIds,
            authorUserIds: Array.from(new Set(authorUserIds))
        })
    }
    return {configured, requirements: found}
}
// The quote's decisions of a purpose at a revision, not superseded, newest first.
function decisionsAt(orderId, revision, purposeEnumId = purposes.quote) {
    return rows(DECISION, {orderId, decisionPurposeEnumId: purposeEnumId})
        .filter(row => Number(row.orderRevision) === revision && !row.invalidatedDate)
        .sort((a, b) => ms(b.decisionDate) - ms(a.decisionDate))
}
const keyOf = row => row.salesApprovalPolicyId || "default"
// Each requirement's state at the revision by its rule's latest row: approved, refused, or requested (its approval asked, again after
// a refusal too), else required. A rule set after an approval was asked is required until it is asked for itself.
function withStates(requirements, decisions) {
    return requirements.map(requirement => {
        const latest = decisions.find(row => keyOf(row) === requirement.key) || null
        const requested = decisions.find(row => row.decisionResultEnumId === results.requested && keyOf(row) === requirement.key)
        const state = !latest
            ? "required"
            : latest.decisionResultEnumId === results.approved
              ? "approved"
              : latest.decisionResultEnumId === results.refused
                ? "refused"
                : "requested"
        return Object.assign({}, requirement, {
            state,
            decision: latest && latest.decisionResultEnumId !== results.requested ? latest : null,
            requestedByUserId: requested?.decisionByUserId || null
        })
    })
}
// The parties and users who may not approve a quote's requirement unless its rule allows it: its owner, who asked for its approval
// at the revision, who priced the lines it names, and who entered or changed them (for an amount rule, any line) since the last
// decision (lineEditors, SEC-BAP-113).
function authorsOf(quote, requirement, decisions) {
    const owner = rows(PART_PARTY, {orderId: quote.order.orderId, roleTypeId: salesAccess.quoteRoles.owner}).map(
        row => row.partyId
    )
    const requesters = decisions.filter(row => row.decisionResultEnumId === results.requested).map(row => row.decisionByUserId)
    return {partyIds: owner, userIds: requesters.concat(requirement.authorUserIds).filter(Boolean)}
}
const isMember = (userGroupId, userId) =>
    rows("moqui.security.UserGroupMember", {userGroupId, userId}).some(row => lib.active(row))
// Why the user may not decide a requirement (a reason code and message), or null.
function decideRefusal(userScope, quote, requirement, decisions, userId = ec.user.userId, partyId = userScope.partyId) {
    if (!userScope.capabilities.approve)
        return {code: "PERMISSION_DENIED", message: "A sales approver (SALES_APPROVE) decides it"}
    if (requirement.approverUserGroupId && !isMember(requirement.approverUserGroupId, userId))
        return {code: "APPROVER_INVALID", message: requirement.approverText + " decides it"}
    if (!requirement.selfApprovalAllowed) {
        const authors = authorsOf(quote, requirement, decisions)
        if ((partyId && authors.partyIds.includes(partyId)) || authors.userIds.includes(userId))
            return {code: "SELF_APPROVAL", message: "Another approver decides a quote you made or priced"}
    }
    return null
}
// The approvers a requirement goes to: active holders of SALES_APPROVE who work for the organization (an agent, employee or member),
// in the rule's group when it names one, the authors left out unless the rule allows them.
function approversOf(quote, requirement, decisions) {
    const groupIds = rows("moqui.security.UserGroupPermission", {userPermissionId: "SALES_APPROVE"})
        .filter(row => lib.active(row))
        .map(row => row.userGroupId)
    if (!groupIds.length) return []
    const userIds = Array.from(
        new Set(
            Array.from(find("moqui.security.UserGroupMember").condition("userGroupId", "in", groupIds).list())
                .filter(row => lib.active(row))
                .map(row => row.userId)
        )
    )
    if (!userIds.length) return []
    const accounts = Array.from(find("moqui.security.UserAccount").condition("userId", "in", userIds).list()).filter(
        row => row.partyId && row.disabled !== "Y"
    )
    if (!accounts.length) return []
    const members = new Set(
        Array.from(
            find("mantle.party.PartyRelationship", {toPartyId: quote.organizationPartyId})
                .condition("relationshipTypeEnumId", "in", ["PrtAgent", "PrtEmployee", "PrtMember"])
                .condition(
                    "fromPartyId",
                    "in",
                    accounts.map(row => row.partyId)
                )
                .list()
        )
            .filter(row => lib.active(row))
            .map(row => row.fromPartyId)
    )
    const authors = authorsOf(quote, requirement, decisions)
    return accounts
        .filter(row => members.has(row.partyId))
        .filter(row => !requirement.approverUserGroupId || isMember(requirement.approverUserGroupId, row.userId))
        .filter(
            row =>
                requirement.selfApprovalAllowed ||
                (!authors.partyIds.includes(row.partyId) && !authors.userIds.includes(row.userId))
        )
        .map(row => row.userId)
}
// The quote's approval at its current revision: its requirements with their states and who may decide them.
function approvalOf(userScope, quote) {
    const revision = revisionOf(quote.order)
    const {configured, requirements} = requirementsOf(quote.order, quote.part, purposes.quote)
    const decisions = decisionsAt(quote.order.orderId, revision)
    const states = withStates(requirements, decisions)
    const draft = draftStatuses.includes(quote.order.statusId)
    const open = states.filter(row => row.state !== "approved")
    return {
        orderId: quote.order.orderId,
        orderRevision: revision,
        configured,
        needsApproval: states.length > 0,
        approved: open.length === 0,
        requested: states.some(row => row.state === "requested"),
        refused: states.some(row => row.state === "refused"),
        canRequest: draft && quote.canEdit && states.some(row => row.state === "required" || row.state === "refused"),
        requirements: states.map(row => {
            const refusal = draft && row.state !== "approved" ? decideRefusal(userScope, quote, row, decisions) : null
            return {
                key: row.key,
                salesApprovalPolicyId: row.salesApprovalPolicyId,
                ruleTypeEnumId: row.ruleTypeEnumId,
                ruleText: row.ruleText,
                inputs: row.inputs,
                inputsText: row.inputs.join(" · "),
                approverText: row.approverText,
                selfApprovalAllowed: row.selfApprovalAllowed,
                state: row.state,
                stateText: L(
                    {approved: "Approved", refused: "Refused", requested: "Waiting for approval", required: "Needs approval"}[
                        row.state
                    ]
                ),
                decidedByName: row.decision ? userName(row.decision.decisionByUserId) : "",
                decidedText: row.decision ? lib.dateText(row.decision.decisionDate) : "",
                reason: row.decision?.reasonText || "",
                canDecide: draft && row.state !== "approved" && !refusal,
                decideRefusal: refusal?.message || ""
            }
        })
    }
}
// preview#Quote: the rules the quote meets now, each with its inputs, the approver it needs and its state; the cost behind a floor is
// checked here and never answered.
function preview(p) {
    const userScope = salesAccess.scope()
    const quote = quoteFor(userScope, p.orderId)
    return {approval: approvalOf(userScope, quote)}
}
// Whether a free or zero-price line a rep enters on a quote is covered by an approval it will need (the user's call of Nov 13): with
// no quote rule in effect the manual-price rule covers it; otherwise a rule of the organization must meet it (a free-line rule, a
// discount rule its calculated price makes it meet, or a floor rule). Used by store#QuoteLine in place of P7's SALES_APPROVE check.
function freeLineCovered(quote, candidate) {
    const rules = rulesOf(quote.organizationPartyId, purposes.quote)
    if (!rules.length) return true
    const context = {organizationPartyId: quote.organizationPartyId, currencyUomId: quote.order.currencyUomId}
    const item = Object.assign({orderItemSeqId: "", priceSource: "free", unitAmount: toDecimal(0)}, candidate)
    return rules.some(rule => rule.ruleTypeEnumId !== "SarAmount" && !!lineFinding(rule, item, context))
}
// get#Quote's approval summary of a quote the caller sees.
function summary(userScope, quote) {
    try {
        return approvalOf(userScope, quote)
    } catch (error) {
        ec.logger.error("Approval of quote " + quote.order.orderId + " could not be evaluated: " + error.message)
        return null
    }
}

// ===== asking and deciding =====
// The approvers' unread notices of a quote, read once it is decided or changed.
function clearNotices(orderId) {
    const messageIds = rows("moqui.security.user.NotificationMessage", {topic, recordEntityName: ORDER, recordId: orderId}).map(
        row => row.notificationMessageId
    )
    if (!messageIds.length) return 0
    let cleared = 0
    for (const user of Array.from(
        find("moqui.security.user.NotificationMessageUser")
            .condition("notificationMessageId", "in", messageIds)
            .condition("viewedDate", "is-null", null)
            .list()
    )) {
        call("update#moqui.security.user.NotificationMessageUser", {
            notificationMessageId: user.notificationMessageId,
            userId: user.userId,
            viewedDate: ec.user.nowTimestamp
        })
        cleared++
    }
    return cleared
}
// A decision date free on the order (OrderDecision's key is the order and the time).
function freeDate(orderId, base = nowMs()) {
    let at = base
    while (one(DECISION, {orderId, decisionDate: new Date(at)})) at++
    return new Date(at)
}
// request#QuoteApproval: the rep asks for each requirement not asked for or refused at the quote's revision (an SdrRequested row of
// its rule at the revision), and one SalesQuoteApproval notice, naming the quote and the customer and never an amount, replaces the
// earlier one and goes to the approvers of every rule still waiting (ruleKeys: what deciding the notice decides). Needs
// SALES_QUOTE_EDIT on a draft the caller sees, at its current revision; a quote that needs no approval or is approved, and one whose
// every open rule is asked for already, are refused.
function requestApproval(p) {
    const userScope = salesAccess.scope()
    const quote = salesAccess.requireQuote(userScope, text(p.orderId), true)
    if (!draftStatuses.includes(quote.order.statusId))
        denied("QUOTE_NOT_DRAFT", "Quote " + quote.order.orderId + " is not a draft")
    requireRevision(quote.order, p.orderRevision)
    const revision = revisionOf(quote.order)
    const {requirements} = requirementsOf(quote.order, quote.part, purposes.quote)
    if (!requirements.length) denied("APPROVAL_NOT_NEEDED", "Quote " + quote.order.orderId + " needs no approval")
    let decisions = decisionsAt(quote.order.orderId, revision)
    const states = withStates(requirements, decisions)
    const open = states.filter(row => row.state !== "approved")
    if (!open.length) denied("APPROVAL_NOT_NEEDED", "Quote " + quote.order.orderId + " is approved")
    const asking = open.filter(row => row.state === "required" || row.state === "refused")
    if (!asking.length) denied("APPROVAL_REQUESTED", "Its approval is asked already")
    let at = nowMs()
    for (const row of asking) {
        const decisionDate = freeDate(quote.order.orderId, at)
        at = decisionDate.getTime() + 1
        call("create#" + DECISION, {
            orderId: quote.order.orderId,
            decisionDate,
            decisionByPartyId: userScope.partyId,
            decisionByUserId: ec.user.userId,
            statusId: quote.order.statusId,
            orderRevision: revision,
            organizationPartyId: quote.organizationPartyId,
            decisionPurposeEnumId: purposes.quote,
            salesApprovalPolicyId: row.salesApprovalPolicyId,
            ruleTypeEnumId: row.ruleTypeEnumId,
            evaluatedDate: ec.user.nowTimestamp,
            decisionResultEnumId: results.requested,
            reasonText: text(p.note)
        })
    }
    decisions = decisionsAt(quote.order.orderId, revision)
    const userIds = Array.from(new Set(open.flatMap(row => approversOf(quote, row, decisions))))
    let notifiedCount = 0
    try {
        clearNotices(quote.order.orderId)
        if (userIds.length) {
            ec.makeNotificationMessage()
                .topic(topic)
                .message({
                    orderId: quote.order.orderId,
                    sourceRevision: revision,
                    quoteName: quote.order.orderName || quote.order.orderId,
                    customerName: partyName(quote.customerPartyId),
                    organizationName: partyName(quote.organizationPartyId),
                    // the kinds of the rules, never an amount (a notice's title names the quote alone)
                    ruleText: Array.from(new Set(open.map(row => L(ruleKinds[row.ruleTypeEnumId] || "approval")))).join(", "),
                    // the rules asked for: deciding the notice decides these and no rule set after it was sent
                    ruleKeys: open.map(row => row.key),
                    requestedByName: partyName(userScope.partyId) || userName(ec.user.userId)
                })
                .record(ORDER, quote.order.orderId)
                .actorUserId(ec.user.userId)
                .userIds(userIds)
                .send()
            notifiedCount = userIds.length
        }
    } catch (error) {
        ec.logger.error("Approval notice of quote " + quote.order.orderId + " was not sent: " + error.message)
    }
    return {orderId: quote.order.orderId, orderRevision: revision, notifiedCount}
}
// decide#Quote: approve or refuse the quote's requirements at the revision read (one rule with salesApprovalPolicyId, "default" for
// the manual-price rule; the open ones of a list with salesApprovalPolicyIds, the notice's rules; else every open one), each an
// OrderDecision bound to the revision, rule and time with the reason (a refusal needs one). Every rule chosen must be the caller's
// to decide, or none is decided: a notice decided leaves every approver's list, so it never decides some rules and strands the rest. Needs SALES_APPROVE in the quote's organization; refuses a quote not a draft (QUOTE_NOT_DRAFT), an
// expired one (QUOTE_EXPIRED), a missing or stale revision naming the current one (REVISION_REQUIRED, REVISION_CHANGED), a rule the
// quote no longer meets (APPROVAL_NOT_NEEDED), the author unless the rule allows it (SELF_APPROVAL) and one outside the rule's group
// (APPROVER_INVALID). The same operation key answers the first result.
function decide(p) {
    const userScope = salesAccess.scope()
    salesAccess.requireCapability(userScope, "approve")
    const quote = quoteFor(userScope, p.orderId)
    const decision = String(p.decision || "approve")
    if (!["approve", "refuse"].includes(decision)) denied("DECISION_INVALID", "Approve or refuse")
    const operation = !blank(p.operationKey)
        ? lib.operation(p, "SalesQuoteDecide", quote.organizationPartyId, {
              orderId: quote.order.orderId,
              orderRevision: p.orderRevision ?? null,
              salesApprovalPolicyId: p.salesApprovalPolicyId ?? null,
              salesApprovalPolicyIds: keysOf(p.salesApprovalPolicyIds),
              decision
          })
        : null
    if (operation?.old) return lib.previous(operation)
    if (!draftStatuses.includes(quote.order.statusId))
        denied("QUOTE_NOT_DRAFT", "Quote " + quote.order.orderId + " is not a draft")
    requireRevision(quote.order, p.orderRevision)
    const thru = ms(quote.part.validThruDate)
    if (thru != null && thru < nowMs()) denied("QUOTE_EXPIRED", "Quote " + quote.order.orderId + " has expired")
    const reason = text(p.reason)
    if (decision === "refuse" && !reason) denied("REASON_REQUIRED", "Give the reason for the refusal")
    const revision = revisionOf(quote.order)
    const {requirements} = requirementsOf(quote.order, quote.part, purposes.quote)
    const decisions = decisionsAt(quote.order.orderId, revision)
    const states = withStates(requirements, decisions)
    const wanted = text(p.salesApprovalPolicyId)
    const listed = keysOf(p.salesApprovalPolicyIds)
    const chosen = wanted
        ? states.filter(row => row.key === wanted)
        : states.filter(row => row.state !== "approved" && (!listed || listed.includes(row.key)))
    if (!chosen.length)
        denied("APPROVAL_NOT_NEEDED", "Quote " + quote.order.orderId + " needs no such approval at revision " + revision)
    for (const row of chosen) {
        const refusal = decideRefusal(userScope, quote, row, decisions)
        if (refusal) denied(refusal.code, refusal.message)
    }
    const allowed = chosen
    const resultEnumId = decision === "approve" ? results.approved : results.refused
    let at = nowMs()
    for (const row of allowed) {
        const decisionDate = freeDate(quote.order.orderId, at)
        at = decisionDate.getTime() + 1
        call("create#" + DECISION, {
            orderId: quote.order.orderId,
            decisionDate,
            decisionByPartyId: userScope.partyId,
            decisionByUserId: ec.user.userId,
            statusId: quote.order.statusId,
            orderRevision: revision,
            organizationPartyId: quote.organizationPartyId,
            decisionPurposeEnumId: purposes.quote,
            salesApprovalPolicyId: row.salesApprovalPolicyId,
            ruleTypeEnumId: row.ruleTypeEnumId,
            evaluatedDate: ec.user.nowTimestamp,
            decisionResultEnumId: resultEnumId,
            reasonText: reason,
            operationKey: text(p.operationKey)
        })
    }
    const after = withStates(requirements, decisionsAt(quote.order.orderId, revision))
    // the notices leave the approvers' lists once nothing waits on them: every rule decided, or one refused
    if (decision === "refuse" || after.every(row => row.state === "approved" || row.state === "refused"))
        clearNotices(quote.order.orderId)
    const result = {
        orderId: quote.order.orderId,
        orderRevision: revision,
        decidedCount: allowed.length,
        decisionResultEnumId: resultEnumId,
        approved: after.every(row => row.state === "approved")
    }
    if (operation) lib.complete(operation, DECISION, quote.order.orderId, result)
    return Object.assign(result, {alreadyApplied: false})
}
// A list of rule keys (a List parameter or a message's array), or null.
function keysOf(value) {
    if (value == null || typeof value === "string" || typeof value.length !== "number") return null
    const keys = Array.from(value)
        .map(key => text(key))
        .filter(Boolean)
    return keys.length ? keys : null
}
// The SalesQuoteApproval topic's handlers (approve#QuoteMessage, refuse#QuoteMessage), called by the framework as the user deciding
// the notice: the decision at the revision the message names, never the current one, of the rules the message asked for (ruleKeys),
// never one set after it was sent; each must be the approver's to decide, else none is (decide#Quote).
function decideMessage(p, decision) {
    if (p.recordEntityName && p.recordEntityName !== ORDER) denied("SOURCE_INVALID", "Not a quote approval")
    const message = p.message || {}
    if (message.sourceRevision == null || message.sourceRevision === "")
        denied("REVISION_REQUIRED", "The approval names no revision of the quote; open it to decide")
    const ruleKeys = keysOf(message.ruleKeys)
    if (!ruleKeys) denied("SOURCE_INVALID", "The approval names no rule of the quote; open it to decide")
    return decide({
        orderId: p.recordId,
        orderRevision: message.sourceRevision,
        salesApprovalPolicyIds: ruleKeys,
        decision,
        reason: p.reason
    })
}
// The approvals a quote needs before it is proposed (propose#Quote's guard, design §5 "a direct service call cannot propose an
// unapproved quote"): APPROVAL_REQUIRED naming the rules still open at its revision.
function requireApproved(userScope, quote) {
    const approval = approvalOf(userScope, quote)
    const open = approval.requirements.filter(row => row.state !== "approved")
    if (open.length)
        denied(
            "APPROVAL_REQUIRED",
            "Quote " +
                quote.order.orderId +
                " needs approval first: " +
                open.map(row => row.ruleText + " (" + row.stateText + ")").join("; ")
        )
    return approval
}
// ===== rules on the native order =====
// handle#SalesApprovalRevision, the SECA on increment#OrderRevision: a commercial change of a quote supersedes the decisions of its
// earlier revisions (invalidatedDate) and reads their notices, so a stale approval leaves the approvers' lists. Any other order
// returns at once (every order's revision passes here). No permission check: it runs as any user.
function revisionChanged(p) {
    if (blank(p.orderId) || ["status", "content", "note"].includes(p.revisionKind)) return {supersededCount: 0}
    const order = one(ORDER, {orderId: String(p.orderId)})
    if (!order || order.orderPurposeEnumId !== salesAccess.quotePurpose) return {supersededCount: 0}
    const revision = revisionOf(order)
    const stale = rows(DECISION, {orderId: order.orderId}).filter(
        row => row.orderRevision != null && Number(row.orderRevision) < revision && !row.invalidatedDate
    )
    for (const row of stale)
        call("update#" + DECISION, {orderId: row.orderId, decisionDate: row.decisionDate, invalidatedDate: ec.user.nowTimestamp})
    if (stale.length) clearNotices(order.orderId)
    return {supersededCount: stale.length}
}
// check#SalesPreApprove, the SECA on check#OrderPreApprove (§4 Nov 11, F60): for each sales part of a seller with a Sales rule in
// effect, the quote rules an accepted quote meets without a current approval and the order rules the order meets, as warnings; none
// for an organization with no rule or an order that meets none. They stop autoApprove#Order as the credit and purchase warnings do;
// with the seller's approval setting on, OrderDetail shows them to the person approving, whom they do not refuse (P11).
// A warning's rule: its kind and id, never its threshold, the order's amounts or a cost (a warning reaches whoever reads the order's
// pre-approval check and the server log; the quote's approval box shows the inputs to its readers).
const warningRule = row =>
    L(ruleKinds[row.ruleTypeEnumId] || "approval") +
    " " +
    L("rule") +
    (row.salesApprovalPolicyId ? " " + row.salesApprovalPolicyId : "")
function preApproveWarnings(p) {
    const order = blank(p.orderId) ? null : one(ORDER, {orderId: String(p.orderId)})
    if (!order) return {approveWarnings: []}
    const warnings = []
    for (const part of rows(PART, {orderId: order.orderId})) {
        if (!part.vendorPartyId || !salesAccess.isInternal(part.vendorPartyId)) continue
        if (!part.customerPartyId || salesAccess.isInternal(part.customerPartyId)) continue
        if (!rulesOf(part.vendorPartyId).length) continue
        if (order.orderPurposeEnumId === salesAccess.quotePurpose) {
            const {configured, requirements} = requirementsOf(order, part, purposes.quote)
            if (configured) {
                const states = withStates(requirements, decisionsAt(order.orderId, revisionOf(order)))
                for (const row of states.filter(found => found.state !== "approved"))
                    warnings.push(L("Sales approval needed") + ": " + warningRule(row))
            }
        }
        for (const row of requirementsOf(order, part, purposes.order).requirements)
            warnings.push(L("Sales order approval needed") + ": " + warningRule(row))
    }
    return {approveWarnings: Array.from(new Set(warnings))}
}

// ===== P11: a sales order's approval (impl-sales P11, §4 Nov 11; design-sales §1.1, §6 OrderDetail) =====
// The seller's approval setting (SalesPolicy.orderApprovalRequired): Y, no sales order of the seller is approved automatically and a
// person's approval needs SALES_ORDER_APPROVE and a current decision of every order rule (SapOrder) the order meets; N or no policy,
// every caller approves as built. Read for each part's seller (its vendor) by approve#Order, autoApprove#Order and the callers that
// approve as built (SalesOrders.js).
const orderGateOn = organizationPartyId => policyOf(organizationPartyId)?.orderApprovalRequired === "Y"
// The order rules an order meets at its revision for its part's seller, with their states (approved, refused, required); none for a
// seller with no order rule in effect.
function orderRequirements(order, part) {
    if (!rulesOf(part.vendorPartyId, purposes.order).length) return []
    const {requirements} = requirementsOf(order, part, purposes.order)
    return withStates(requirements, decisionsAt(order.orderId, revisionOf(order), purposes.order))
}
// The parties and users who may not decide an order rule unless it allows it: the order's owner, who entered it and who placed it,
// and who entered a line the rule names.
function orderAuthors(order, requirement) {
    const owners = rows(PART_PARTY, {orderId: order.orderId, roleTypeId: salesAccess.quoteRoles.owner}).map(row => row.partyId)
    const placers = rows("moqui.entity.EntityAuditLog", {
        changedEntityName: ORDER,
        changedFieldName: "statusId",
        pkPrimaryValue: order.orderId,
        newValueText: "OrderPlaced"
    }).map(row => row.changedByUserId)
    return {
        partyIds: owners.concat(order.enteredByPartyId ? [order.enteredByPartyId] : []),
        userIds: placers.concat(requirement.authorUserIds).filter(Boolean)
    }
}
// Why the user may not decide an order rule ({code, message}), or null.
function orderDecideRefusal(userScope, order, requirement) {
    if (!userScope.capabilities.orderApprove && !ec.user.hasPermission("ORDER_APPROVE"))
        return {code: "PERMISSION_DENIED", message: "An order approver decides it"}
    if (requirement.approverUserGroupId && !isMember(requirement.approverUserGroupId, ec.user.userId))
        return {code: "APPROVER_INVALID", message: requirement.approverText + " decides it"}
    if (!requirement.selfApprovalAllowed) {
        const authors = orderAuthors(order, requirement)
        if ((userScope.partyId && authors.partyIds.includes(userScope.partyId)) || authors.userIds.includes(ec.user.userId))
            return {code: "SELF_APPROVAL", message: "Another approver decides an order you own, entered or placed"}
    }
    return null
}
// The order's approval as OrderDetail shows it: the setting, each order rule it meets with its state and whether the user may decide
// it, and the pre-approval warnings (check#OrderPreApprove: the credit, purchase, store and Sales warnings), shown to the person
// approving; with the setting on they refuse nothing (§4).
function orderApprovalOf(userScope, order, part) {
    const states = orderRequirements(order, part)
    return {
        gateOn: orderGateOn(part.vendorPartyId),
        requirements: states.map(row => {
            const refusal = row.state === "approved" ? null : orderDecideRefusal(userScope, order, row)
            return {
                key: row.key,
                salesApprovalPolicyId: row.salesApprovalPolicyId,
                ruleTypeEnumId: row.ruleTypeEnumId,
                ruleText: row.ruleText,
                inputsText: row.inputs.join(" · "),
                approverText: row.approverText,
                state: row.state,
                stateText: L(
                    {approved: "Approved", refused: "Refused", requested: "Waiting for approval", required: "Needs approval"}[
                        row.state
                    ]
                ),
                decidedByName: row.decision ? userName(row.decision.decisionByUserId) : "",
                canDecide: row.state !== "approved" && !refusal,
                decideRefusal: refusal?.message || ""
            }
        })
    }
}
// approve#Order's sales direction for a part whose seller has the setting on: null when the user may approve it, else the refusal.
// SALES_ORDER_APPROVE in an organization of the user's sales scope, and every order rule the order meets decided at its revision.
function orderApproveRefusal(order, part) {
    if (!ec.user.hasPermission("SALES_ORDER_APPROVE"))
        return (
            "PERMISSION_DENIED: SALES_ORDER_APPROVE is required to approve sales order " +
            order.orderId +
            "; its seller's sales orders wait for a Sales approver"
        )
    if (!salesAccess.covers(salesAccess.scope(), part.vendorPartyId))
        return "ORGANIZATION_DENIED: Order " + order.orderId + " is of an organization outside your sales scope"
    const open = orderRequirements(order, part).filter(row => row.state !== "approved")
    if (open.length)
        return (
            "SALES_APPROVAL_REQUIRED: Sales order " +
            order.orderId +
            " revision " +
            revisionOf(order) +
            " needs a Sales decision first (" +
            open.map(row => warningRule(row)).join("; ") +
            "); approve it through Sales"
        )
    return null
}
// The decisions approve#SalesOrder records before the native approval: an SdrApproved OrderDecision of purpose SapOrder for each
// order rule the order meets and has not approved at its revision, each the user's to decide (refused naming the first that is
// not). Answers the number of rule decisions recorded. P12 review (the user's call of Nov 14: a decision on every approval, rule or
// not): with no rule left to decide, one approval decision of purpose SapOrder with no rule records who approved it, so
// the approver keeps read-only sight of every order they approved (SalesAccess.js orderOf); no requirement reads a decision with no
// policy for an order (only a quote's unconfigured manual-price rule has no policy).
function decideOrderRules(userScope, order, part) {
    const open = orderRequirements(order, part).filter(row => row.state !== "approved")
    for (const row of open) {
        const refusal = orderDecideRefusal(userScope, order, row)
        if (refusal) denied(refusal.code, refusal.message)
    }
    let at = nowMs()
    const record = row => {
        const decisionDate = freeDate(order.orderId, at)
        at = decisionDate.getTime() + 1
        call("create#" + DECISION, {
            orderId: order.orderId,
            decisionDate,
            decisionByPartyId: userScope.partyId,
            decisionByUserId: ec.user.userId,
            statusId: order.statusId,
            orderRevision: revisionOf(order),
            organizationPartyId: part.vendorPartyId,
            decisionPurposeEnumId: purposes.order,
            salesApprovalPolicyId: row?.salesApprovalPolicyId || null,
            ruleTypeEnumId: row?.ruleTypeEnumId || null,
            evaluatedDate: ec.user.nowTimestamp,
            decisionResultEnumId: results.approved
        })
    }
    for (const row of open) record(row)
    if (!open.length) record(null)
    return open.length
}

const operations = {
    storePolicy,
    getPolicy,
    storeCommercialRevision,
    storeRule,
    findRules,
    preview,
    requestApproval,
    decide,
    approveMessage: p => decideMessage(p, "approve"),
    refuseMessage: p => decideMessage(p, "refuse"),
    revisionChanged,
    preApproveWarnings
}
;({
    // for SalesQuotes.js and SalesIntake.js, never a service's parameters
    policyOf,
    // follow-up 5: a Sales order part's facility (SalesQuotes.js, SalesOrders.js, SalesQuoteIssues.js, SalesRecurrence.js)
    facilityName,
    facilityRefusal,
    facilityOptions,
    defaultFacilityOf,
    applyDefaultFacility,
    freeLineCovered,
    summary,
    // P10: propose#Quote's approval guard and the quote's product lines (SalesQuoteIssues.js)
    requireApproved,
    linesOf,
    // P11: a sales order's approval (SalesOrders.js, PurchaseOrders.js approveRefusal)
    orderGateOn,
    orderRequirements,
    orderApprovalOf,
    orderApproveRefusal,
    decideOrderRules,
    preApproveWarnings,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown sales approval operation " + op)
        return operations[op](parameters || {})
    }
})
