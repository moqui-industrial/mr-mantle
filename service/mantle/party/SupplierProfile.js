// An organization's suppliers (mantle.party.SupplierServices): the dated SupplierProfile with its finance fields (Accounting
// P6, SUPPLIER_TERMS_EDIT) and its buying fields (impl-purchasing P2, SUPPLIER_PROFILE_EDIT), a new supplier, and the
// supplier's buyer as a dated Buyer-to-Supplier PartyRelationship (impl-drawers-commons §4: parties by role). Each write
// checks its permission in the organization (InvoiceWorkflowLib.organization) and that the supplier is not another user's
// private contact. Disabled artifact authorization widens nothing here.
const workflowLib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const policyModule = ec.resource.script("component://mr-mantle/service/mantle/order/PurchasePolicy.js")
const {find, one, rows, call, denied, access, ms} = lib

const PROFILE = "mantle.party.supplier.SupplierProfile"
const financeFields = ["settlementTermId", "selfBillingIndicator"]
const buyingFields = [
    "currencyUomId",
    "incotermEnumId",
    "approvalStatusId",
    "purchaseBlockFromDate",
    "purchaseBlockThruDate",
    "purchaseBlockReason"
]
// the approval decisions (Approved, Rejected) are the purchase approver's (P4's decide#PurchaseApproval goes through here)
const decidedStatuses = ["SupaApproved", "SupaRejected"]
const blank = value => value == null || String(value).trim() === ""
const iso = value => new Date(value).toISOString()
const current = (row, at) => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at
const given = (p, field) => Object.keys(p).includes(field) && p[field] !== undefined

function supplierParty(partyId) {
    const supplier = partyId ? one("mantle.party.Party", {partyId}) : null
    if (!supplier || (supplier.privateOwnerUserId && supplier.privateOwnerUserId !== ec.user.userId))
        denied("SUPPLIER_UNAVAILABLE", "Choose an available supplier")
    return supplier
}
function validate(values) {
    if (values.settlementTermId && !one("mantle.account.invoice.SettlementTerm", {settlementTermId: values.settlementTermId}))
        denied("TERM_INVALID", "Choose an existing payment term")
    if (values.selfBillingIndicator && !["Y", "N"].includes(values.selfBillingIndicator))
        denied("SELF_BILLING_INVALID", "Self-billing is Y or N")
    if (values.currencyUomId && one("moqui.basic.Uom", {uomId: values.currencyUomId})?.uomTypeEnumId !== "UT_CURRENCY_MEASURE")
        denied("PROFILE_INVALID", "Choose a currency")
    if (values.incotermEnumId && one("moqui.basic.Enumeration", {enumId: values.incotermEnumId})?.parentEnumId !== "TtInco")
        denied("PROFILE_INVALID", "Choose an Incoterm")
    if (
        values.approvalStatusId &&
        one("moqui.basic.StatusItem", {statusId: values.approvalStatusId})?.statusTypeId !== "SupplierApproval"
    )
        denied("PROFILE_INVALID", "Choose a supplier approval status")
    const blockFrom = ms(values.purchaseBlockFromDate),
        blockThru = ms(values.purchaseBlockThruDate)
    if (blockThru != null && blockFrom == null) denied("BLOCK_INVALID", "A purchase block needs its start")
    if (blockFrom != null && blockThru != null && blockThru <= blockFrom)
        denied("BLOCK_INVALID", "A purchase block ends after it starts")
    if (blockFrom != null && blank(values.purchaseBlockReason)) denied("BLOCK_INVALID", "Give the purchase block's reason")
}
const dateFields = ["purchaseBlockFromDate", "purchaseBlockThruDate"]
const comparable = (field, value) => (blank(value) ? null : dateFields.includes(field) ? ms(value) : String(value))
const same = (field, a, b) => comparable(field, a) === comparable(field, b)

// store#SupplierProfile: the row in effect ends at fromDate (now by default) and the next starts there with the fields given
// and the others carried over; nothing changes when nothing differs. The finance fields need SUPPLIER_TERMS_EDIT, the
// buying fields SUPPLIER_PROFILE_EDIT, and an approval decision (Approved or Rejected) PURCHASE_APPROVE too, each in the
// organization. A supplier's first row takes self-billing from the organization's match policy (selfBillingDefault) unless
// the change gives it.
function store(p) {
    const financeGiven = financeFields.filter(field => given(p, field)),
        buyingGiven = buyingFields.filter(field => given(p, field))
    if (!financeGiven.length && !buyingGiven.length) denied("PROFILE_EMPTY", "Give a supplier profile field to change")
    const organizationPartyId = workflowLib.organization(
        p.organizationPartyId,
        financeGiven.length ? "SUPPLIER_TERMS_EDIT" : "SUPPLIER_PROFILE_EDIT",
        true
    )
    if (financeGiven.length && buyingGiven.length && !access.has("SUPPLIER_PROFILE_EDIT"))
        denied("PERMISSION_DENIED", "SUPPLIER_PROFILE_EDIT authority is required")
    const supplierPartyId = p.supplierPartyId
    supplierParty(supplierPartyId)
    const fromMillis = blank(p.fromDate) ? ms(ec.user.nowTimestamp) : ms(p.fromDate)
    if (!Number.isFinite(fromMillis)) denied("DATE_INVALID", "Choose a valid start")
    const all = Array.from(find(PROFILE, {organizationPartyId, supplierPartyId}).forUpdate(true).list())
    const currentRow = all.filter(row => current(row, fromMillis)).sort((a, b) => ms(b.fromDate) - ms(a.fromDate))[0] || null
    // a supplier's first row takes the organization's self-billing default (its match policy row)
    let selfBillingDefault = "N"
    if (!currentRow) {
        const matchPolicy = Array.from(
            find("mantle.account.invoice.InvoiceMatchPolicy", {
                organizationPartyId,
                productId: null,
                productCategoryId: null
            }).list()
        )
            .filter(row => current(row, fromMillis))
            .sort((a, b) => ms(b.fromDate) - ms(a.fromDate))[0]
        selfBillingDefault = matchPolicy?.selfBillingDefault || "N"
    }
    // an approval decision that changes the status is the purchase approver's; the same status given again is no decision
    if (
        given(p, "approvalStatusId") &&
        decidedStatuses.includes(p.approvalStatusId) &&
        p.approvalStatusId !== currentRow?.approvalStatusId &&
        !access.has("PURCHASE_APPROVE")
    )
        denied("PERMISSION_DENIED", "PURCHASE_APPROVE authority is required")
    const values = {}
    for (const field of financeFields.concat(buyingFields)) values[field] = currentRow ? (currentRow[field] ?? null) : null
    if (!currentRow) values.selfBillingIndicator = selfBillingDefault
    for (const field of financeGiven.concat(buyingGiven)) values[field] = blank(p[field]) ? null : p[field]
    values.selfBillingIndicator = values.selfBillingIndicator || "N"
    for (const field of dateFields) if (values[field] != null) values[field] = iso(ms(values[field]))
    if (values.purchaseBlockFromDate == null && values.purchaseBlockThruDate == null) values.purchaseBlockReason = null
    validate(values)
    const differs = financeFields
        .concat(buyingFields)
        .some(field =>
            field === "selfBillingIndicator"
                ? (currentRow?.selfBillingIndicator || "N") !== values.selfBillingIndicator
                : !same(field, currentRow?.[field], values[field])
        )
    if (currentRow && !differs) return {supplierProfileId: currentRow.supplierProfileId, changed: false}
    if (currentRow && ms(currentRow.fromDate) >= fromMillis)
        denied("DATE_INVALID", "The change must start after the profile in effect")
    const fromDate = iso(fromMillis)
    const why = blank(p.changeReason) ? null : String(p.changeReason)
    if (why)
        ec.context.putAll(
            Object.fromEntries(
                ["fromDate", "thruDate", ...financeFields, ...buyingFields, "changeReason"].map(name => [
                    name + "_changeReason",
                    why
                ])
            )
        )
    if (currentRow) call("update#" + PROFILE, {supplierProfileId: currentRow.supplierProfileId, thruDate: fromDate})
    // a later row, scheduled before this change, still starts where it did: this one ends there
    const later = all.filter(row => ms(row.fromDate) > fromMillis).sort((a, b) => ms(a.fromDate) - ms(b.fromDate))[0]
    const created = call(
        "create#" + PROFILE,
        Object.assign({organizationPartyId, supplierPartyId, fromDate}, values, {
            thruDate: later ? iso(ms(later.fromDate)) : null,
            changeReason: why,
            changedByUserId: ec.user.userId
        })
    )
    return {supplierProfileId: created.supplierProfileId, changed: true}
}

// create#Supplier: a new supplier organization or person owned by the organization, in the Supplier role, with its email
// and phone; its profile starts Pending approval when the organization's policy requires supplier approval.
function create(p) {
    const organizationPartyId = workflowLib.organization(p.organizationPartyId, "SUPPLIER_PROFILE_EDIT", false)
    const person = blank(p.organizationName)
    if (person && (blank(p.firstName) || blank(p.lastName)))
        denied("SUPPLIER_INVALID", "Give the supplier organization's name, or the person's first and last name")
    const party = {ownerPartyId: organizationPartyId, externalId: blank(p.externalId) ? null : String(p.externalId).trim()}
    const created = person
        ? call(
              "mantle.party.PartyServices.create#Person",
              Object.assign(party, {firstName: p.firstName, lastName: p.lastName, roleTypeId: "Supplier"})
          )
        : call(
              "mantle.party.PartyServices.create#Organization",
              Object.assign(party, {organizationName: String(p.organizationName).trim(), roleTypeId: "Supplier"})
          )
    const partyId = created.partyId
    if (!one("mantle.party.PartyRole", {partyId, roleTypeId: "Supplier"}))
        call("create#mantle.party.PartyRole", {partyId, roleTypeId: "Supplier"})
    if (!blank(p.emailAddress))
        call("mantle.party.ContactServices.create#EmailAddress", {
            partyId,
            emailAddress: String(p.emailAddress).trim(),
            contactMechPurposeId: "EmailPrimary"
        })
    if (!blank(p.contactNumber))
        call("mantle.party.ContactServices.create#TelecomNumber", {
            partyId,
            contactNumber: String(p.contactNumber).trim(),
            contactMechPurposeId: "PhonePrimary"
        })
    if (!blank(p.partyClassificationId)) classify(partyId, p.partyClassificationId)
    const policy = policyModule.effective(organizationPartyId, null).policy
    let supplierProfileId = null
    if (policy.supplierApprovalRequired === "Y")
        supplierProfileId = store({
            organizationPartyId,
            supplierPartyId: partyId,
            approvalStatusId: "SupaPending",
            changeReason: "New supplier"
        }).supplierProfileId
    return {partyId, supplierProfileId, approvalStatusId: supplierProfileId ? "SupaPending" : null}
}
// A supplier category (PcltSupplierCategory) on a supplier, replacing its category in effect.
function classify(partyId, partyClassificationId) {
    if (one("mantle.party.PartyClassification", {partyClassificationId})?.classificationTypeEnumId !== "PcltSupplierCategory")
        denied("CLASSIFICATION_INVALID", "Choose a supplier category")
    call("mantle.party.PartyServices.set#PartyClassification", {partyId, partyClassificationId})
}

// store#SupplierBuyer: the supplier's buyer for the organization from a date: the Buyer-to-Supplier relationships of the
// organization's people to the supplier in effect then end there, and the buyer's starts (none with no buyer).
function storeBuyer(p) {
    const organizationPartyId = workflowLib.organization(p.organizationPartyId, "SUPPLIER_PROFILE_EDIT", true)
    const supplierPartyId = p.supplierPartyId
    supplierParty(supplierPartyId)
    if (!one("mantle.party.PartyRole", {partyId: supplierPartyId, roleTypeId: "Supplier"}))
        denied("SUPPLIER_UNAVAILABLE", "Choose an available supplier")
    const at = blank(p.fromDate) ? ms(ec.user.nowTimestamp) : ms(p.fromDate)
    if (!Number.isFinite(at)) denied("DATE_INVALID", "Choose a valid start")
    const members = partyId =>
        Array.from(call("mantle.party.PartyServices.get#PartyOrganizationInfo", {partyId}).userOrgIds || []).includes(
            organizationPartyId
        )
    const buyerPartyId = blank(p.buyerPartyId) ? null : String(p.buyerPartyId)
    if (buyerPartyId && (!one("mantle.party.Person", {partyId: buyerPartyId}) || !members(buyerPartyId)))
        denied("BUYER_INVALID", "Choose a person of the organization as the buyer")
    const relationships = rows("mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtSupplier",
        toPartyId: supplierPartyId,
        fromRoleTypeId: "Buyer"
    }).filter(row => current(row, at) && members(row.fromPartyId))
    if (buyerPartyId && relationships.length === 1 && relationships[0].fromPartyId === buyerPartyId)
        return {partyRelationshipId: relationships[0].partyRelationshipId, changed: false}
    if (relationships.some(row => ms(row.fromDate) >= at))
        denied("DATE_INVALID", "The change must start after the buyer in effect")
    for (const row of relationships)
        call("update#mantle.party.PartyRelationship", {partyRelationshipId: row.partyRelationshipId, thruDate: iso(at)})
    if (!buyerPartyId) return {partyRelationshipId: null, changed: relationships.length > 0}
    if (!one("mantle.party.PartyRole", {partyId: buyerPartyId, roleTypeId: "Buyer"}))
        call("create#mantle.party.PartyRole", {partyId: buyerPartyId, roleTypeId: "Buyer"})
    const created = call("create#mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtSupplier",
        fromPartyId: buyerPartyId,
        fromRoleTypeId: "Buyer",
        toPartyId: supplierPartyId,
        toRoleTypeId: "Supplier",
        fromDate: iso(at)
    })
    return {partyRelationshipId: created.partyRelationshipId, changed: true}
}

// set#SupplierCategory: a supplier's category for the organization's buyers (SUPPLIER_PROFILE_EDIT), or none.
function setCategory(p) {
    workflowLib.organization(p.organizationPartyId, "SUPPLIER_PROFILE_EDIT", false)
    supplierParty(p.supplierPartyId)
    if (!one("mantle.party.PartyRole", {partyId: p.supplierPartyId, roleTypeId: "Supplier"}))
        denied("SUPPLIER_UNAVAILABLE", "Choose an available supplier")
    if (!blank(p.partyClassificationId)) {
        classify(p.supplierPartyId, p.partyClassificationId)
        return {changed: true}
    }
    const inEffect = rows("mantle.party.PartyClassificationAppl", {partyId: p.supplierPartyId}).filter(
        row =>
            current(row, ms(ec.user.nowTimestamp)) &&
            one("mantle.party.PartyClassification", {partyClassificationId: row.partyClassificationId})
                ?.classificationTypeEnumId === "PcltSupplierCategory"
    )
    for (const row of inEffect)
        call("mantle.party.PartyServices.remove#PartyClassification", {
            partyId: p.supplierPartyId,
            partyClassificationId: row.partyClassificationId
        })
    return {changed: inEffect.length > 0}
}

const operations = {store, create, storeBuyer, setCategory}
;({
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown supplier operation " + op)
        return operations[op](parameters)
    }
})
