// Purchase agreements (design-purchasing §7 Agreements and AgreementDetail; impl-purchasing P13, §2, §4, F10, F18, F36): a
// buying organization's blanket agreement with a supplier, or a sourcing template, on Mantle's Agreement, AgreementItem,
// AgreementTerm and AgreementParty, with the release allocation as a record of its own (AgreementRelease).
// - store#PurchaseAgreement: the header (supplier, dates, currency, text), the effective-dated terms and the signers, a new
//   one from a template (its items, prices and terms, never its releases), and the buyer's close or cancel.
// - store#AgreementItem: an effective-dated item with its product, quantity cap, unit, value cap, release tolerance and the
//   agreement's price (a ProductPrice row of the agreement and item, ended and started anew when it changes).
// - A change of a key field counts the agreement's revision once (agreementRevision, audit-logged with the fields, so the
//   history and the print as of a time read them back), supersedes the decisions of earlier revisions and, for an active or
//   submitted agreement, sends the new revision to its approvers: a changed active agreement takes no release until its new
//   revision is approved.
// - submit#PurchaseAgreement and decide (decide#PurchaseApproval with agreementId): approved as a purchase order is (§4), on
//   PurchaseOrderApproval with the agreement as source and the steps of the organization's purchase order policy for the
//   agreement's value; the last step activates a draft, sets the approved revision and stores the agreement's PDF as
//   AgreementContent.
// - get#ReleaseBalance and release#PurchaseAgreement: each item's quantity and value released and remaining; a release, under
//   a lock on the agreement, makes or adds to a draft purchase order line at the agreement's price, refused over the
//   remaining quantity or value beyond the item's tolerance. An expired, closed or cancelled agreement takes no release and
//   its orders stay. A template has no balance and takes no release.
// - get#PurchaseAgreementPrint (as of a time) and expire#PurchaseAgreements (the daily job).
// Each service checks its permission and the agreement's organization (RECORD_UNAVAILABLE outside the user's).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const policy = ec.resource.script("component://mr-mantle/service/mantle/order/PurchasePolicy.js")
const orders = () => ec.resource.script("component://mr-mantle/service/mantle/order/PurchaseOrders.js")
const approvals = () => ec.resource.script("component://mr-mantle/service/mantle/order/PurchaseApprovals.js")
const {find, one, rows, call, denied, access, ms} = lib

const AGREEMENT = "mantle.party.agreement.Agreement",
    ITEM = "mantle.party.agreement.AgreementItem",
    TERM = "mantle.party.agreement.AgreementTerm",
    PARTY = "mantle.party.agreement.AgreementParty",
    RELEASE = "mantle.party.agreement.AgreementRelease",
    CONTENT = "mantle.party.agreement.AgreementContent",
    PRICE = "mantle.product.ProductPrice",
    DECISION = "mantle.order.purchase.PurchaseApprovalDecision",
    ORDER = "mantle.order.OrderHeader",
    ORDER_ITEM = "mantle.order.OrderItem"
const editableStatuses = ["AgmStDraft", "AgmStActive"]
const readPermissions = ["PURCHASE_ORDER_EDIT", "PURCHASE_APPROVE", "PURCHASE_ORDER_APPROVE"]
// the statuses of an order whose release no longer uses the agreement
const deadOrderStatuses = ["OrderCancelled", "OrderRejected"]
const headerFields = ["otherPartyId", "fromDate", "thruDate", "currencyUomId"]
const itemFields = ["productId", "quantity", "quantityUomId", "amountCap", "releaseTolerancePercent", "fromDate", "thruDate"]
const termFields = ["termTypeEnumId", "settlementTermId", "termText", "termNumber", "fromDate", "thruDate"]
const fieldLabels = {
    statusId: "Status",
    otherPartyId: "Supplier",
    fromDate: "From",
    thruDate: "Through",
    currencyUomId: "Currency",
    agreementRevision: "Revision",
    approvedRevision: "Approved revision",
    productId: "Product",
    quantity: "Quantity",
    quantityUomId: "Unit",
    amountCap: "Value cap",
    releaseTolerancePercent: "Release tolerance %",
    termTypeEnumId: "Term",
    settlementTermId: "Payment term",
    termText: "Text",
    termNumber: "Value",
    price: "Price"
}
const dateFields = ["fromDate", "thruDate"]
const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const given = (p, field) => p[field] !== undefined
const dec = value => toDecimal(value ?? 0)
const now = () => Number(ec.user.nowTimestamp)
const revisionOf = agreement => Number(agreement.agreementRevision ?? 1)
const partyName = partyId => lib.partyNames([partyId])[partyId] || partyId || ""
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "")
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const uomText = uomId => (uomId ? one("moqui.basic.Uom", {uomId})?.abbreviation || uomId : "")
const quantityText = value => (value == null || value === "" ? "" : ec.l10n.format(toDecimal(value), "#,##0.###"))
const money = (value, currencyUomId) =>
    value == null || value === ""
        ? ""
        : currencyUomId
          ? ec.l10n.formatCurrency(lib.money(value, currencyUomId), currencyUomId)
          : quantityText(value)
const productText = productId => {
    if (!productId) return ""
    const product = one("mantle.product.Product", {productId})
    return product ? [product.pseudoId || product.productId, product.productName].filter(Boolean).join(" · ") : productId
}
function decimal(value, label, allowZero = true) {
    let number
    try {
        number = toDecimal(value)
    } catch (_) {
        number = null
    }
    if (number == null || number.compare(0) < 0 || (!allowZero && number.isZero()))
        denied("AMOUNT_INVALID", "Enter a " + (allowZero ? "" : "positive ") + label)
    return number
}
function dateOf(value, label) {
    if (blank(value)) return null
    const stamp = ms(value)
    if (stamp == null || !Number.isFinite(stamp)) denied("DATE_INVALID", "Choose a valid " + label)
    return stamp
}

// ===== checks =====
function requirePermission(...permissions) {
    if (!permissions.some(permission => access.has(permission)))
        denied("PERMISSION_DENIED", permissions.join(" or ") + " is required")
}
const isInternal = partyId => !!partyId && !!one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
function requireOrganization(organizationPartyId) {
    if (
        !organizationPartyId ||
        !isInternal(organizationPartyId) ||
        !facilityScope.owns(facilityScope.scope(), organizationPartyId)
    )
        denied("RECORD_UNAVAILABLE", "Organization " + (organizationPartyId || "") + " is not available")
    return String(organizationPartyId)
}
// A purchase agreement of the user's organizations (the organization buys, the other party is a supplier); a missing one,
// another type and one outside the user's organizations are refused alike (RECORD_UNAVAILABLE).
function purchaseAgreement(agreementId, lock = false) {
    const unavailable = () => denied("RECORD_UNAVAILABLE", "Agreement " + (agreementId || "") + " is not available")
    if (blank(agreementId)) unavailable()
    const agreement = lock ? find(AGREEMENT, {agreementId}).forUpdate(true).one() : one(AGREEMENT, {agreementId})
    if (!agreement || agreement.agreementTypeEnumId !== "AgrPurchase") unavailable()
    if (!isInternal(agreement.organizationPartyId) || !facilityScope.owns(facilityScope.scope(), agreement.organizationPartyId))
        unavailable()
    return {
        agreement,
        agreementId: String(agreementId),
        organizationPartyId: agreement.organizationPartyId,
        supplierPartyId: agreement.otherPartyId,
        template: agreement.isTemplate === "Y"
    }
}
// The same without the user's organization (the daily job, Purchasing's reads after their own scope check).
function agreementRow(agreementId) {
    const agreement = blank(agreementId) ? null : one(AGREEMENT, {agreementId})
    if (!agreement || agreement.agreementTypeEnumId !== "AgrPurchase") return null
    return {
        agreement,
        agreementId: String(agreementId),
        organizationPartyId: agreement.organizationPartyId,
        supplierPartyId: agreement.otherPartyId,
        template: agreement.isTemplate === "Y"
    }
}
function requireEditable(pa) {
    if (!editableStatuses.includes(pa.agreement.statusId))
        denied(
            "AGREEMENT_CLOSED",
            "Agreement " + pa.agreementId + " is " + statusText(pa.agreement.statusId).toLowerCase() + "; it no longer changes"
        )
}
// A write with a reason: the audit log keeps it with each change (the framework reads <field>_changeReason, F113).
function withReason(fields, reason, write) {
    const keys = fields.map(field => field + "_changeReason")
    if (reason) for (const key of keys) globalThis[key] = reason
    try {
        return write()
    } finally {
        if (reason) for (const key of keys) delete globalThis[key]
    }
}
const allFields = ["statusId", "agreementRevision", "approvedRevision", "price"].concat(headerFields, itemFields, termFields)

// ===== items, terms and prices =====
const itemsOf = agreementId =>
    rows(ITEM, {agreementId}).sort((a, b) => String(a.agreementItemSeqId).localeCompare(b.agreementItemSeqId))
const termsOf = agreementId =>
    rows(TERM, {agreementId}).sort((a, b) => String(a.agreementTermId).localeCompare(b.agreementTermId))
const inEffect = (row, at = now()) => lib.active(row, at)
// The agreement's price rows of an item, oldest first; the one in effect at a time.
function priceRows(agreementId, agreementItemSeqId) {
    return rows(PRICE, {agreementId, agreementItemSeqId}).sort((a, b) => (ms(a.fromDate) ?? 0) - (ms(b.fromDate) ?? 0))
}
const priceAt = (agreementId, agreementItemSeqId, at = now()) =>
    priceRows(agreementId, agreementItemSeqId)
        .filter(row => lib.active(row, at))
        .at(-1) || null
// Set an item's price: the row in effect ended and a new one started, unless the price is the same. The row is the
// agreement's own (agreementId and agreementItemSeqId), so the resolver picks it only for a release of the agreement.
function storePrice(pa, item, price) {
    const current = priceAt(pa.agreementId, item.agreementItemSeqId)
    if (current && current.productId === item.productId && dec(current.price).compare(price) === 0) return false
    const at = now()
    if (current) call("update#" + PRICE, {productPriceId: current.productPriceId, thruDate: at})
    call("create#" + PRICE, {
        productId: item.productId,
        vendorPartyId: pa.supplierPartyId,
        customerPartyId: pa.organizationPartyId,
        pricePurposeEnumId: "PppPurchase",
        priceTypeEnumId: "PptCurrent",
        priceUomId: pa.agreement.currencyUomId,
        quantityUomId: item.quantityUomId || null,
        minQuantity: 0,
        price,
        agreementId: pa.agreementId,
        agreementItemSeqId: item.agreementItemSeqId,
        fromDate: at
    })
    return true
}
function endPrices(agreementId, agreementItemSeqId) {
    const at = now()
    for (const row of priceRows(agreementId, agreementItemSeqId))
        if (row.thruDate == null || ms(row.thruDate) > at)
            call("update#" + PRICE, {productPriceId: row.productPriceId, thruDate: at})
}

// ===== the revision =====
// The users who wrote a revision: who moved the count to it (or created the agreement, for the first).
function revisionAuthors(agreementId, revision) {
    return rows("moqui.entity.EntityAuditLog", {
        changedEntityName: AGREEMENT,
        changedFieldName: "agreementRevision",
        pkPrimaryValue: agreementId
    })
        .filter(row => Number(row.newValueText) === revision)
        .map(row => row.changedByUserId)
}
const noticed = agreementId =>
    find("moqui.security.user.NotificationMessage", {
        topic: "PurchaseOrderApproval",
        recordEntityName: AGREEMENT,
        recordId: agreementId
    }).count() > 0
// A key-field change: the revision counted once, the earlier revisions' decisions superseded, and an active agreement (its
// change needs approval) or one sent for approval sent to its approvers at the new revision.
function countRevision(pa, reason) {
    const agreement = one(AGREEMENT, {agreementId: pa.agreementId})
    const revision = revisionOf(agreement) + 1
    withReason(["agreementRevision"], reason, () =>
        call("update#" + AGREEMENT, {agreementId: pa.agreementId, agreementRevision: revision, revisionDate: now()})
    )
    const decisions = rows(DECISION, {sourceEntityName: AGREEMENT, sourceId: pa.agreementId}).filter(row => !row.supersededDate)
    for (const row of decisions.filter(decision => Number(decision.sourceRevision) < revision))
        call("update#" + DECISION, {purchaseApprovalDecisionId: row.purchaseApprovalDecisionId, supersededDate: now()})
    if (!pa.template && (agreement.statusId === "AgmStActive" || decisions.length || noticed(pa.agreementId)))
        approvals().notify(agreementSource(purchaseAgreement(pa.agreementId)))
    return revision
}

// ===== the approval source =====
// The value of an agreement for its approval: each item in effect's value cap, else its quantity at the agreement's price.
function agreementValue(agreementId) {
    let total = toDecimal(0)
    for (const item of itemsOf(agreementId).filter(row => inEffect(row) || ms(row.fromDate) > now())) {
        if (item.amountCap != null) total = total.add(dec(item.amountCap))
        else {
            const price = priceAt(agreementId, item.agreementItemSeqId)
            if (price && item.quantity != null) total = total.add(dec(item.quantity).multiply(dec(price.price)))
        }
    }
    return total
}
// An agreement as a purchase approval source: approved as a purchase order is (§4), by the organization's purchase order
// policy steps for its value, currency and its products' categories.
function agreementSource(pa) {
    const agreement = pa.agreement
    const productIds = [
        ...new Set(
            itemsOf(pa.agreementId)
                .map(row => row.productId)
                .filter(Boolean)
        )
    ]
    const categoryIds = productIds.length
        ? [
              ...new Set(
                  Array.from(
                      find("mantle.product.category.ProductCategoryMember").condition("productId", "in", productIds).list()
                  )
                      .filter(row => lib.active(row))
                      .map(row => row.productCategoryId)
              )
          ]
        : []
    const revision = revisionOf(agreement)
    const amount = agreementValue(pa.agreementId)
    return {
        sourceEntityName: AGREEMENT,
        sourceId: pa.agreementId,
        sourceTypeEnumId: "PasOrder",
        organizationPartyId: pa.organizationPartyId,
        supplierPartyId: pa.supplierPartyId,
        amount,
        currencyUomId: agreement.currencyUomId || null,
        facilityId: null,
        categoryIds,
        revision,
        statusId: agreement.statusId,
        label: "purchase agreement " + pa.agreementId,
        submittedBy: userId => revisionAuthors(pa.agreementId, revision).includes(userId),
        title: state =>
            "Approve purchase agreement " +
            pa.agreementId +
            " revision " +
            revision +
            " from " +
            partyName(pa.supplierPartyId) +
            ", " +
            money(amount, agreement.currencyUomId) +
            " (" +
            (state.current ? approvals().stepText(state, state.current) : "") +
            ")"
    }
}
// Whether the agreement waits for an approval: a draft, or an active agreement whose revision is not the approved one.
const pending = agreement =>
    agreement.isTemplate !== "Y" &&
    (agreement.statusId === "AgmStDraft" ||
        (agreement.statusId === "AgmStActive" && Number(agreement.approvedRevision ?? 0) !== revisionOf(agreement)))

// ===== store#PurchaseAgreement =====
function store(p) {
    requirePermission("PURCHASE_ORDER_EDIT")
    const reason = text(p.changeReason)
    if (blank(p.agreementId)) return create(p, reason)
    const pa = purchaseAgreement(p.agreementId, true)
    // the buyer's close or cancel
    if (!blank(p.statusId) && p.statusId !== pa.agreement.statusId) return changeStatus(pa, String(p.statusId), reason)
    requireEditable(pa)
    const changes = {}
    if (given(p, "otherPartyId") && !blank(p.otherPartyId) && p.otherPartyId !== pa.agreement.otherPartyId) {
        orders().supplierOf(pa.organizationPartyId, String(p.otherPartyId))
        if (releasesOf(pa.agreementId).length)
            denied("SUPPLIER_CHANGE_RELEASED", "Agreement " + pa.agreementId + " has releases; its supplier stays")
        changes.otherPartyId = String(p.otherPartyId)
    }
    if (given(p, "currencyUomId") && !blank(p.currencyUomId) && p.currencyUomId !== pa.agreement.currencyUomId) {
        if (releasesOf(pa.agreementId).length)
            denied("CURRENCY_CHANGE_RELEASED", "Agreement " + pa.agreementId + " has releases; its currency stays")
        changes.currencyUomId = String(p.currencyUomId)
    }
    for (const field of ["fromDate", "thruDate"])
        if (given(p, field)) {
            const value = dateOf(p[field], field === "fromDate" ? "start date" : "end date")
            if (value !== ms(pa.agreement[field])) changes[field] = value
        }
    const from = given(changes, "fromDate") ? changes.fromDate : ms(pa.agreement.fromDate)
    const thru = given(changes, "thruDate") ? changes.thruDate : ms(pa.agreement.thruDate)
    if (from != null && thru != null && thru <= from) denied("DATE_INVALID", "The agreement ends after it starts")
    const plain = {}
    for (const field of ["description", "textData"]) if (given(p, field)) plain[field] = text(p[field])
    if (given(p, "agreementDate")) plain.agreementDate = dateOf(p.agreementDate, "agreement date")
    let revised = Object.keys(changes).length > 0
    if (revised || Object.keys(plain).length)
        withReason(Object.keys(changes), reason, () =>
            call("update#" + AGREEMENT, Object.assign({agreementId: pa.agreementId}, plain, changes))
        )
    if (Array.isArray(p.terms) && p.terms.length) revised = storeTerms(pa, p.terms, reason) || revised
    if (Array.isArray(p.parties) && p.parties.length) storeParties(pa, p.parties)
    const revision = revised ? countRevision(pa, reason) : revisionOf(pa.agreement)
    return result(pa.agreementId, {agreementRevision: revision, revised})
}
function result(agreementId, extra = {}) {
    const agreement = one(AGREEMENT, {agreementId})
    return Object.assign(
        {agreementId, statusId: agreement.statusId, agreementRevision: revisionOf(agreement), revised: false},
        extra
    )
}
// A new agreement of the organization with the supplier, a draft at revision 1; from a template, its items, prices and
// terms copied (never its releases).
function create(p, reason) {
    const organizationPartyId = requireOrganization(text(p.organizationPartyId))
    const template = blank(p.templateAgreementId) ? null : purchaseAgreement(p.templateAgreementId)
    if (template && !template.template) denied("TEMPLATE_INVALID", "Agreement " + template.agreementId + " is not a template")
    if (template && template.organizationPartyId !== organizationPartyId)
        denied("TEMPLATE_INVALID", "Template " + template.agreementId + " is another organization's")
    const supplierPartyId = text(p.otherPartyId) || template?.supplierPartyId
    orders().supplierOf(organizationPartyId, supplierPartyId)
    const from = dateOf(p.fromDate, "start date") ?? (template ? null : now())
    const thru = dateOf(p.thruDate, "end date")
    if (from != null && thru != null && thru <= from) denied("DATE_INVALID", "The agreement ends after it starts")
    const currencyUomId =
        text(p.currencyUomId) ||
        template?.agreement.currencyUomId ||
        policy.effective(organizationPartyId).policy.currencyUomId ||
        null
    if (!currencyUomId) denied("CURRENCY_REQUIRED", "Choose the agreement's currency")
    const created = withReason(headerFields, reason, () =>
        call("create#" + AGREEMENT, {
            agreementTypeEnumId: "AgrPurchase",
            statusId: "AgmStDraft",
            organizationPartyId,
            organizationRoleTypeId: "OrgInternal",
            otherPartyId: supplierPartyId,
            otherRoleTypeId: "Supplier",
            agreementDate: dateOf(p.agreementDate, "agreement date") ?? now(),
            fromDate: from,
            thruDate: thru,
            currencyUomId,
            description: text(p.description) || template?.agreement.description || null,
            textData: text(p.textData) || template?.agreement.textData || null,
            isTemplate: p.isTemplate === "Y" || p.isTemplate === true ? "Y" : "N",
            templateAgreementId: template?.agreementId || null,
            agreementRevision: 1,
            revisionDate: now()
        })
    )
    const pa = purchaseAgreement(created.agreementId)
    if (template) {
        for (const item of itemsOf(template.agreementId).filter(row => row.thruDate == null || ms(row.thruDate) > now())) {
            const copied = call("create#" + ITEM, {
                agreementId: pa.agreementId,
                agreementItemSeqId: item.agreementItemSeqId,
                agreementItemTypeEnumId: item.agreementItemTypeEnumId || "AitPurchase",
                productId: item.productId,
                quantity: item.quantity,
                quantityUomId: item.quantityUomId,
                amountCap: item.amountCap,
                releaseTolerancePercent: item.releaseTolerancePercent,
                itemText: item.itemText,
                fromDate: from
            })
            const price = priceAt(template.agreementId, item.agreementItemSeqId)
            if (price && item.productId)
                storePrice(
                    pa,
                    {
                        agreementItemSeqId: copied.agreementItemSeqId || item.agreementItemSeqId,
                        productId: item.productId,
                        quantityUomId: item.quantityUomId
                    },
                    dec(price.price)
                )
        }
        for (const term of termsOf(template.agreementId).filter(row => row.thruDate == null || ms(row.thruDate) > now()))
            call("create#" + TERM, {
                agreementId: pa.agreementId,
                agreementItemSeqId: term.agreementItemSeqId,
                termTypeEnumId: term.termTypeEnumId,
                settlementTermId: term.settlementTermId,
                termText: term.termText,
                termNumber: term.termNumber,
                fromDate: from
            })
    }
    if (Array.isArray(p.terms) && p.terms.length) storeTerms(pa, p.terms, reason)
    if (Array.isArray(p.parties) && p.parties.length) storeParties(pa, p.parties)
    return result(pa.agreementId, {revised: true})
}
// The buyer's close (an active or expired agreement) or cancel (a draft or active one): Mantle's status flow checks the
// transition (StatusFlowTransition); activation is the approval's.
function changeStatus(pa, statusId, reason) {
    if (!["AgmStClosed", "AgmStCancelled"].includes(statusId))
        denied("STATUS_INVALID", "An agreement is activated by its approval; close or cancel it here")
    if (statusId === "AgmStCancelled" && !reason) denied("REASON_REQUIRED", "Give the reason for cancelling the agreement")
    withReason(["statusId"], reason, () => call("update#" + AGREEMENT, {agreementId: pa.agreementId, statusId}))
    if (!pa.template) approvals().clearNotices(agreementSource(pa))
    return result(pa.agreementId)
}
// The terms: each new, changed, ended (thruDate) or, on a never-approved agreement, removed. A term's key fields are its
// type, payment term, text, value and dates. Answers whether anything changed.
function storeTerms(pa, terms, reason) {
    let changed = false
    for (const term of terms) {
        const values = {}
        for (const field of ["termTypeEnumId", "settlementTermId", "termText"])
            if (given(term, field)) values[field] = text(term[field])
        if (given(term, "termNumber")) values.termNumber = blank(term.termNumber) ? null : decimal(term.termNumber, "term value")
        for (const field of ["fromDate", "thruDate"]) if (given(term, field)) values[field] = dateOf(term[field], "term date")
        if (!blank(term.agreementItemSeqId)) {
            if (!one(ITEM, {agreementId: pa.agreementId, agreementItemSeqId: term.agreementItemSeqId}))
                denied("ITEM_UNAVAILABLE", "Item " + term.agreementItemSeqId + " is not on agreement " + pa.agreementId)
            values.agreementItemSeqId = String(term.agreementItemSeqId)
        }
        if (values.settlementTermId && !one("mantle.account.invoice.SettlementTerm", {settlementTermId: values.settlementTermId}))
            denied("TERM_INVALID", "Choose an existing payment term")
        if (blank(term.agreementTermId)) {
            if (!values.termTypeEnumId && !values.settlementTermId && !values.termText)
                denied("TERM_REQUIRED", "Give the term's type, payment term or text")
            withReason(termFields, reason, () =>
                call("create#" + TERM, Object.assign({agreementId: pa.agreementId, fromDate: now()}, values))
            )
            changed = true
            continue
        }
        const existing = one(TERM, {agreementTermId: term.agreementTermId})
        if (!existing || existing.agreementId !== pa.agreementId)
            denied("TERM_UNAVAILABLE", "Term " + term.agreementTermId + " is not on agreement " + pa.agreementId)
        if (term.remove === true || term.remove === "true" || term.remove === "Y") {
            if (pa.agreement.approvedRevision != null)
                denied("TERM_APPROVED", "The agreement was approved with this term; end it with a through date instead")
            call("delete#" + TERM, {agreementTermId: existing.agreementTermId})
            changed = true
            continue
        }
        const diff = Object.fromEntries(
            Object.entries(values).filter(([field, value]) =>
                dateFields.includes(field)
                    ? value !== ms(existing[field])
                    : field === "termNumber"
                      ? (value == null) !== (existing[field] == null) ||
                        (value != null && value.compare(dec(existing[field])) !== 0)
                      : (value ?? null) !== (existing[field] ?? null)
            )
        )
        if (!Object.keys(diff).length) continue
        withReason(Object.keys(diff), reason, () =>
            call("update#" + TERM, Object.assign({agreementTermId: existing.agreementTermId}, diff))
        )
        changed = true
    }
    return changed
}
// The signers and other parties (AgreementParty): each added, or removed with remove.
function storeParties(pa, parties) {
    for (const row of parties) {
        const partyId = text(row.partyId),
            roleTypeId = text(row.roleTypeId) || "AgreementSigner"
        if (!partyId || !one("mantle.party.Party", {partyId})) denied("PARTY_REQUIRED", "Choose the signer")
        if (!one("mantle.party.RoleType", {roleTypeId})) denied("ROLE_INVALID", "Choose the party's role")
        const key = {agreementId: pa.agreementId, partyId, roleTypeId}
        const existing = one(PARTY, key)
        if (row.remove === true || row.remove === "true" || row.remove === "Y") {
            if (existing) call("delete#" + PARTY, key)
        } else if (!existing) call("create#" + PARTY, key)
    }
}

// ===== store#AgreementItem =====
function storeItem(p) {
    requirePermission("PURCHASE_ORDER_EDIT")
    const pa = purchaseAgreement(p.agreementId, true)
    requireEditable(pa)
    const reason = text(p.changeReason)
    const values = {}
    if (given(p, "productId") && !blank(p.productId)) {
        if (!one("mantle.product.Product", {productId: p.productId})) denied("PRODUCT_REQUIRED", "Choose a product")
        values.productId = String(p.productId)
    }
    if (given(p, "quantity")) values.quantity = blank(p.quantity) ? null : decimal(p.quantity, "quantity", false)
    if (given(p, "quantityUomId")) values.quantityUomId = text(p.quantityUomId)
    if (given(p, "amountCap")) values.amountCap = blank(p.amountCap) ? null : decimal(p.amountCap, "value cap", false)
    if (given(p, "releaseTolerancePercent"))
        values.releaseTolerancePercent = blank(p.releaseTolerancePercent)
            ? null
            : decimal(p.releaseTolerancePercent, "release tolerance")
    for (const field of ["fromDate", "thruDate"]) if (given(p, field)) values[field] = dateOf(p[field], "item date")
    if (given(p, "itemText")) values.itemText = text(p.itemText)
    const price = given(p, "price") && !blank(p.price) ? decimal(p.price, "price") : null
    let item = blank(p.agreementItemSeqId)
        ? null
        : one(ITEM, {agreementId: pa.agreementId, agreementItemSeqId: p.agreementItemSeqId})
    if (!blank(p.agreementItemSeqId) && !item)
        denied("ITEM_UNAVAILABLE", "Item " + p.agreementItemSeqId + " is not on agreement " + pa.agreementId)
    // an item never approved and never released is removed; any other is ended with a through date
    if (item && (p.remove === true || p.remove === "true" || p.remove === "Y")) {
        if (pa.agreement.approvedRevision != null || releasesOf(pa.agreementId, item.agreementItemSeqId).length)
            denied("ITEM_APPROVED", "The agreement was approved or released with this item; end it with a through date instead")
        for (const row of priceRows(pa.agreementId, item.agreementItemSeqId))
            call("delete#" + PRICE, {productPriceId: row.productPriceId})
        for (const row of rows(TERM, {agreementId: pa.agreementId, agreementItemSeqId: item.agreementItemSeqId}))
            call("delete#" + TERM, {agreementTermId: row.agreementTermId})
        call("delete#" + ITEM, {agreementId: pa.agreementId, agreementItemSeqId: item.agreementItemSeqId})
        const revision = countRevision(pa, reason)
        return {
            agreementId: pa.agreementId,
            agreementItemSeqId: item.agreementItemSeqId,
            agreementRevision: revision,
            revised: true
        }
    }
    const productId = values.productId ?? item?.productId
    if (!productId) denied("PRODUCT_REQUIRED", "Choose a product")
    const from = given(values, "fromDate") ? values.fromDate : ms(item?.fromDate)
    const thru = given(values, "thruDate") ? values.thruDate : ms(item?.thruDate)
    if (from != null && thru != null && thru <= from) denied("DATE_INVALID", "The item ends after it starts")
    if (item) {
        if (values.productId && values.productId !== item.productId && releasesOf(pa.agreementId, item.agreementItemSeqId).length)
            denied("PRODUCT_CHANGE_RELEASED", "Item " + item.agreementItemSeqId + " has releases; its product stays")
        // a cap is not lowered below what the item's releases use
        const used = usageOf(pa.agreementId, item.agreementItemSeqId)
        const quantityCap = given(values, "quantity") ? values.quantity : item.quantity
        const valueCap = given(values, "amountCap") ? values.amountCap : item.amountCap
        if (quantityCap != null && dec(quantityCap).compare(used.quantity) < 0)
            denied(
                "CAP_BELOW_RELEASED",
                "Item " + item.agreementItemSeqId + " has " + quantityText(used.quantity) + " released already"
            )
        if (valueCap != null && dec(valueCap).compare(used.amount) < 0)
            denied(
                "CAP_BELOW_RELEASED",
                "Item " + item.agreementItemSeqId + " has " + money(used.amount, pa.agreement.currencyUomId) + " released already"
            )
    }
    let revised = false
    if (!item) {
        const created = withReason(itemFields, reason, () =>
            call(
                "create#" + ITEM,
                Object.assign(
                    {
                        agreementId: pa.agreementId,
                        agreementItemTypeEnumId: "AitPurchase",
                        fromDate: from ?? ms(pa.agreement.fromDate) ?? now()
                    },
                    values,
                    {productId}
                )
            )
        )
        item = one(ITEM, {agreementId: pa.agreementId, agreementItemSeqId: created.agreementItemSeqId})
        revised = true
    } else {
        const diff = Object.fromEntries(
            Object.entries(values).filter(([field, value]) =>
                dateFields.includes(field)
                    ? value !== ms(item[field])
                    : ["quantity", "amountCap", "releaseTolerancePercent"].includes(field)
                      ? (value == null) !== (item[field] == null) || (value != null && value.compare(dec(item[field])) !== 0)
                      : (value ?? null) !== (item[field] ?? null)
            )
        )
        if (Object.keys(diff).length) {
            withReason(Object.keys(diff), reason, () =>
                call(
                    "update#" + ITEM,
                    Object.assign({agreementId: pa.agreementId, agreementItemSeqId: item.agreementItemSeqId}, diff)
                )
            )
            revised = revised || Object.keys(diff).some(field => itemFields.includes(field))
            item = one(ITEM, {agreementId: pa.agreementId, agreementItemSeqId: item.agreementItemSeqId})
        }
    }
    if (price != null && storePrice(pa, item, price)) revised = true
    if (item.thruDate != null && ms(item.thruDate) <= now()) endPrices(pa.agreementId, item.agreementItemSeqId)
    const revision = revised ? countRevision(pa, reason) : revisionOf(pa.agreement)
    return {agreementId: pa.agreementId, agreementItemSeqId: item.agreementItemSeqId, agreementRevision: revision, revised}
}

// ===== releases and the balance =====
const releasesOf = (agreementId, agreementItemSeqId) =>
    rows(RELEASE, agreementItemSeqId ? {agreementId, agreementItemSeqId} : {agreementId})
// What a release still uses: its quantity less what its line cancelled (none once the order is cancelled or rejected), at
// its unit amount; with the line's ordered, cancelled and received quantities.
function releaseUse(release) {
    const line = one(ORDER_ITEM, {orderId: release.orderId, orderItemSeqId: release.orderItemSeqId})
    const order = one(ORDER, {orderId: release.orderId})
    const ordered = dec(line?.quantity)
    const cancelled = dec(line?.quantityCancelled)
    const dead = !line || !order || deadOrderStatuses.includes(order.statusId)
    let quantity = dead ? toDecimal(0) : dec(release.quantity)
    const open = ordered.subtract(cancelled)
    if (quantity.compare(open) > 0) quantity = open.compare(0) > 0 ? open : toDecimal(0)
    const received = rows("mantle.product.receipt.AssetReceipt", {
        orderId: release.orderId,
        orderItemSeqId: release.orderItemSeqId
    }).reduce((sum, row) => sum.add(dec(row.quantityAccepted)), toDecimal(0))
    return {
        quantity,
        amount: ec.l10n.roundCurrency(quantity.multiply(dec(release.unitAmount)), release.currencyUomId),
        ordered,
        cancelled,
        received,
        orderStatusId: order?.statusId || null
    }
}
function usageOf(agreementId, agreementItemSeqId) {
    let quantity = toDecimal(0),
        amount = toDecimal(0)
    for (const release of releasesOf(agreementId, agreementItemSeqId)) {
        const use = releaseUse(release)
        quantity = quantity.add(use.quantity)
        amount = amount.add(use.amount)
    }
    return {quantity, amount}
}
const withTolerance = (cap, item) =>
    cap == null ? null : dec(cap).multiply(toDecimal(1).add(dec(item.releaseTolerancePercent).divide(toDecimal(100))))
// Why the agreement takes no release now, or null: a template, not active (expired by its date too), or a change waiting for
// its approval.
function releaseRefusal(agreement, at = now()) {
    if (agreement.isTemplate === "Y") return ["TEMPLATE_NO_RELEASE", "A template has no balance and takes no release"]
    if (agreement.statusId === "AgmStExpired" || (agreement.thruDate != null && ms(agreement.thruDate) <= at))
        return ["AGREEMENT_EXPIRED", "Agreement " + agreement.agreementId + " has expired; its orders stay"]
    if (agreement.statusId !== "AgmStActive")
        return [
            "AGREEMENT_NOT_ACTIVE",
            "Agreement " + agreement.agreementId + " is " + statusText(agreement.statusId).toLowerCase()
        ]
    if (agreement.fromDate != null && ms(agreement.fromDate) > at)
        return ["AGREEMENT_NOT_STARTED", "Agreement " + agreement.agreementId + " starts " + lib.dateText(agreement.fromDate)]
    if (Number(agreement.approvedRevision ?? 0) !== revisionOf(agreement))
        return [
            "AGREEMENT_CHANGE_PENDING",
            "Agreement " + agreement.agreementId + " revision " + revisionOf(agreement) + " waits for its approval"
        ]
    return null
}
// The balance of an agreement, without the user's checks: each item's caps, what its releases use and what remains (within
// the tolerance too), and the release rows. A template has none.
function balanceOf(agreementId) {
    const pa = agreementRow(agreementId)
    if (!pa) return null
    const agreement = pa.agreement
    const currencyUomId = agreement.currencyUomId
    const refusal = releaseRefusal(agreement)
    const base = {
        agreementId: pa.agreementId,
        template: pa.template,
        statusId: agreement.statusId,
        agreementRevision: revisionOf(agreement),
        approvedRevision: agreement.approvedRevision == null ? null : Number(agreement.approvedRevision),
        currencyUomId,
        releasable: !refusal,
        releaseRefusalCode: refusal ? refusal[0] : null,
        releaseRefusalText: refusal ? refusal[1] : "",
        itemBalances: [],
        releaseRows: []
    }
    if (pa.template) return base
    const releases = releasesOf(pa.agreementId)
    const uses = new Map(releases.map(release => [release.agreementReleaseId, releaseUse(release)]))
    base.itemBalances = itemsOf(pa.agreementId).map(item => {
        let quantity = toDecimal(0),
            amount = toDecimal(0)
        for (const release of releases.filter(row => row.agreementItemSeqId === item.agreementItemSeqId)) {
            quantity = quantity.add(uses.get(release.agreementReleaseId).quantity)
            amount = amount.add(uses.get(release.agreementReleaseId).amount)
        }
        const quantityLimit = withTolerance(item.quantity, item),
            valueLimit = withTolerance(item.amountCap, item)
        const price = priceAt(pa.agreementId, item.agreementItemSeqId)
        return {
            agreementItemSeqId: item.agreementItemSeqId,
            productId: item.productId,
            productText: productText(item.productId),
            inEffect: inEffect(item),
            quantity: item.quantity,
            quantityUomId: item.quantityUomId,
            amountCap: item.amountCap,
            releaseTolerancePercent: item.releaseTolerancePercent,
            price: price ? price.price : null,
            releasedQuantity: quantity,
            releasedAmount: amount,
            remainingQuantity: item.quantity == null ? null : dec(item.quantity).subtract(quantity),
            remainingAmount: item.amountCap == null ? null : dec(item.amountCap).subtract(amount),
            quantityLimit,
            valueLimit,
            quantityText:
                item.quantity == null
                    ? "No limit"
                    : [quantityText(item.quantity), uomText(item.quantityUomId)].filter(Boolean).join(" "),
            releasedQuantityText: quantityText(quantity),
            remainingQuantityText: item.quantity == null ? "" : quantityText(dec(item.quantity).subtract(quantity)),
            amountCapText: item.amountCap == null ? "No limit" : money(item.amountCap, currencyUomId),
            releasedAmountText: money(amount, currencyUomId),
            remainingAmountText: item.amountCap == null ? "" : money(dec(item.amountCap).subtract(amount), currencyUomId),
            priceText: price ? money(price.price, currencyUomId) : "",
            toleranceText: item.releaseTolerancePercent == null ? "" : quantityText(item.releaseTolerancePercent) + "%"
        }
    })
    base.releaseRows = releases
        .sort((a, b) => ms(a.releaseDate) - ms(b.releaseDate))
        .map(release => {
            const use = uses.get(release.agreementReleaseId)
            return {
                agreementReleaseId: release.agreementReleaseId,
                agreementItemSeqId: release.agreementItemSeqId,
                orderId: release.orderId,
                orderItemSeqId: release.orderItemSeqId,
                orderStatusId: use.orderStatusId,
                orderStatusText: statusText(use.orderStatusId),
                agreementRevision: release.agreementRevision,
                releaseDate: release.releaseDate,
                releaseDateText: lib.dateText(release.releaseDate),
                releasedQuantity: release.quantity,
                usedQuantity: use.quantity,
                orderedQuantity: use.ordered,
                cancelledQuantity: use.cancelled,
                receivedQuantity: use.received,
                amount: use.amount,
                releasedQuantityText: quantityText(release.quantity) + " " + uomText(release.quantityUomId),
                orderedText: quantityText(use.ordered),
                cancelledText: use.cancelled.isZero() ? "" : quantityText(use.cancelled),
                receivedText: quantityText(use.received),
                amountText: money(use.amount, release.currencyUomId),
                unitAmountText: money(release.unitAmount, release.currencyUomId)
            }
        })
    return base
}
// get#ReleaseBalance: the balance for a purchasing reader of the organization.
function balance(p) {
    requirePermission(...readPermissions)
    purchaseAgreement(p.agreementId)
    return {balance: balanceOf(p.agreementId)}
}

// release#PurchaseAgreement: a quantity of an item released to a draft purchase order (a new one, or a draft of the same
// organization, supplier and currency) at the agreement's price, under a lock on the agreement.
function release(p) {
    requirePermission("PURCHASE_ORDER_EDIT")
    const pa = purchaseAgreement(p.agreementId, true)
    const quantity = decimal(p.quantity, "quantity", false)
    const request = {
        agreementId: pa.agreementId,
        agreementRevision: blank(p.agreementRevision) ? null : Number(p.agreementRevision),
        agreementItemSeqId: text(p.agreementItemSeqId),
        quantity: String(quantity),
        orderId: text(p.orderId)
    }
    const operation = blank(p.operationKey) ? null : lib.operation(p, "AgreementRelease", pa.organizationPartyId, request)
    if (operation?.old) return lib.previous(operation)
    const agreement = pa.agreement
    const refusal = releaseRefusal(agreement)
    if (refusal) denied(refusal[0], refusal[1])
    const revision = revisionOf(agreement)
    if (!blank(p.agreementRevision) && Number(p.agreementRevision) !== revision)
        denied("STALE_REVISION", "Agreement " + pa.agreementId + " is at revision " + revision + "; review it again")
    const item = blank(p.agreementItemSeqId)
        ? null
        : one(ITEM, {agreementId: pa.agreementId, agreementItemSeqId: p.agreementItemSeqId})
    if (!item || !item.productId) denied("ITEM_UNAVAILABLE", "Choose an item of agreement " + pa.agreementId)
    if (!inEffect(item)) denied("ITEM_NOT_IN_EFFECT", "Item " + item.agreementItemSeqId + " is not in effect")
    const currencyUomId = agreement.currencyUomId
    const priced = call("mantle.product.PriceServices.get#ProductPrice", {
        productId: item.productId,
        quantity,
        quantityUomId: item.quantityUomId || null,
        vendorPartyId: pa.supplierPartyId,
        customerPartyId: pa.organizationPartyId,
        organizationPartyId: pa.organizationPartyId,
        pricePurposeEnumId: "PppPurchase",
        priceUomId: currencyUomId,
        direction: "purchase",
        agreementId: pa.agreementId,
        agreementItemSeqId: item.agreementItemSeqId,
        validDate: ec.user.nowTimestamp
    })
    if (!priced.priceAvailable)
        denied("PRICE_UNAVAILABLE", "Item " + item.agreementItemSeqId + " has no price you may read; set the agreement's price")
    const unitAmount = dec(priced.price)
    const amount = ec.l10n.roundCurrency(quantity.multiply(unitAmount), currencyUomId)
    // the caps: what the item's releases use, with this one, within the caps and the tolerance
    const used = usageOf(pa.agreementId, item.agreementItemSeqId)
    const quantityLimit = withTolerance(item.quantity, item),
        valueLimit = withTolerance(item.amountCap, item)
    if (quantityLimit != null && used.quantity.add(quantity).compare(quantityLimit) > 0)
        denied(
            "RELEASE_OVER_QUANTITY",
            "Item " +
                item.agreementItemSeqId +
                " has " +
                [quantityText(dec(item.quantity).subtract(used.quantity)), uomText(item.quantityUomId)]
                    .filter(Boolean)
                    .join(" ") +
                " left" +
                (item.releaseTolerancePercent ? " (" + quantityText(item.releaseTolerancePercent) + "% tolerance)" : "")
        )
    if (valueLimit != null && used.amount.add(amount).compare(valueLimit) > 0)
        denied(
            "RELEASE_OVER_VALUE",
            "Item " +
                item.agreementItemSeqId +
                " has " +
                money(dec(item.amountCap).subtract(used.amount), currencyUomId) +
                " left" +
                (item.releaseTolerancePercent ? " (" + quantityText(item.releaseTolerancePercent) + "% tolerance)" : "")
        )
    // the order: a draft of the same organization, supplier and currency, or a new draft
    let orderId = text(p.orderId)
    if (orderId) {
        const po = orders().purchaseOrder(orderId, true)
        if (
            po.order.statusId !== "OrderOpen" ||
            po.organizationPartyId !== pa.organizationPartyId ||
            po.supplierPartyId !== pa.supplierPartyId ||
            (po.order.currencyUomId || currencyUomId) !== currencyUomId
        )
            denied(
                "RELEASE_ORDER_INVALID",
                "Release to a draft purchase order of the agreement's organization, supplier and currency"
            )
    } else {
        orderId = call("mantle.order.PurchaseServices.create#PurchaseOrder", {
            organizationPartyId: pa.organizationPartyId,
            vendorPartyId: pa.supplierPartyId,
            facilityId: text(p.facilityId),
            currencyUomId,
            orderName: text(p.orderName) || "Release of agreement " + pa.agreementId
        }).orderId
    }
    const line = call("mantle.order.PurchaseServices.store#PurchaseOrderItem", {
        orderId,
        productId: item.productId,
        quantity,
        quantityUomId: item.quantityUomId || null,
        unitAmount,
        itemDescription: text(p.itemDescription),
        requiredByDate: blank(p.requiredByDate) ? null : p.requiredByDate
    })
    // the agreement's price row on the line, not an entered price
    call("update#" + ORDER_ITEM, {
        orderId,
        orderItemSeqId: line.orderItemSeqId,
        productPriceId: priced.productPriceId || null,
        isModifiedPrice: "N"
    })
    const created = call("create#" + RELEASE, {
        agreementId: pa.agreementId,
        agreementItemSeqId: item.agreementItemSeqId,
        orderId,
        orderItemSeqId: line.orderItemSeqId,
        quantity,
        quantityUomId: item.quantityUomId || null,
        unitAmount,
        amount,
        currencyUomId,
        agreementRevision: revision,
        agreementRevisionDate: agreement.revisionDate || agreement.approvedDate || null,
        productPriceId: priced.productPriceId || null,
        releaseDate: ec.user.nowTimestamp,
        releasedByUserId: ec.user.userId,
        operationKey: operation?.operationKey || null
    })
    const after = usageOf(pa.agreementId, item.agreementItemSeqId)
    const answer = {
        agreementId: pa.agreementId,
        agreementRevision: revision,
        agreementReleaseId: created.agreementReleaseId,
        orderId,
        orderItemSeqId: line.orderItemSeqId,
        unitAmount,
        amount,
        remainingQuantity: item.quantity == null ? null : dec(item.quantity).subtract(after.quantity),
        remainingAmount: item.amountCap == null ? null : dec(item.amountCap).subtract(after.amount),
        overCap:
            (item.quantity != null && after.quantity.compare(dec(item.quantity)) > 0) ||
            (item.amountCap != null && after.amount.compare(dec(item.amountCap)) > 0)
    }
    if (operation) lib.complete(operation, RELEASE, created.agreementReleaseId, answer)
    return Object.assign(answer, {alreadyApplied: false})
}

// ===== the approval =====
// submit#PurchaseAgreement: a draft (or a changed active agreement) sent to the approvers of its step waiting.
function submit(p) {
    requirePermission("PURCHASE_ORDER_EDIT")
    const pa = purchaseAgreement(p.agreementId, true)
    if (pa.template) denied("TEMPLATE_NO_APPROVAL", "A template is not approved; start an agreement from it")
    if (!pending(pa.agreement)) denied("AGREEMENT_NOT_PENDING", "Agreement " + pa.agreementId + " waits for no approval")
    if (!itemsOf(pa.agreementId).some(item => inEffect(item) || ms(item.fromDate) > now()))
        denied("AGREEMENT_EMPTY", "Add the agreement's items before sending it for approval")
    const source = agreementSource(pa)
    const state = approvals().progress(source)
    if (state.missing)
        denied(
            "POLICY_MISSING",
            "No approval policy of " + partyName(pa.organizationPartyId) + " covers agreement " + pa.agreementId
        )
    const sent = approvals().notify(source, state)
    return {
        agreementId: pa.agreementId,
        agreementRevision: source.revision,
        notifiedCount: sent.notifiedCount,
        pendingStepText: state.current ? approvals().stepText(state, state.current) : ""
    }
}
// decide#PurchaseApproval with an agreement (PurchaseOrders.js decide hands it here): a purchase approver decides the step
// waiting at the agreement's revision; the last step activates a draft, sets the approved revision and stores the PDF.
function decide(p) {
    requirePermission("PURCHASE_APPROVE")
    const pa = purchaseAgreement(p.agreementId, true)
    const decision = String(p.decision || "approve")
    if (!["approve", "refuse"].includes(decision)) denied("DECISION_INVALID", "Approve or refuse the agreement")
    const request = {
        agreementId: pa.agreementId,
        agreementRevision: blank(p.agreementRevision) ? null : Number(p.agreementRevision),
        decision
    }
    const operation = blank(p.operationKey) ? null : lib.operation(p, "AgreementApproval", pa.organizationPartyId, request)
    if (operation?.old) return lib.previous(operation)
    if (pa.template) denied("TEMPLATE_NO_APPROVAL", "A template is not approved; start an agreement from it")
    if (!pending(pa.agreement)) denied("AGREEMENT_NOT_PENDING", "Agreement " + pa.agreementId + " waits for no approval")
    const revision = revisionOf(pa.agreement)
    if (!blank(p.agreementRevision) && Number(p.agreementRevision) !== revision)
        denied("STALE_REVISION", "Agreement " + pa.agreementId + " is at revision " + revision + "; review it again")
    const reason = text(p.reason)
    if (decision === "refuse" && !reason) denied("REASON_REQUIRED", "Give the reason for refusing agreement " + pa.agreementId)
    if (!itemsOf(pa.agreementId).length) denied("AGREEMENT_EMPTY", "Agreement " + pa.agreementId + " has no items")
    const source = agreementSource(pa)
    const state = approvals().progress(source)
    if (state.missing)
        denied(
            "POLICY_MISSING",
            "No approval policy of " + partyName(pa.organizationPartyId) + " covers agreement " + pa.agreementId
        )
    const partyId = ec.user.userAccount?.partyId || null
    const refusal = approvals().refusalFor(source, state, ec.user.userId, partyId)
    if (refusal) denied(refusal[0], refusal[1])
    if (decision === "approve") {
        const checked = policy.supplierUsable(pa.organizationPartyId, pa.supplierPartyId)
        if (checked.result === "STOP") denied(checked.reasonCode, checked.message)
        if (checked.result === "WARN") ec.message.addMessage(checked.message, "warning")
    }
    const {row: policyRow} = policy.effective(pa.organizationPartyId)
    const step = state.current
    const created = call("create#" + DECISION, {
        sourceEntityName: AGREEMENT,
        sourceId: pa.agreementId,
        sourceRevision: revision,
        organizationPartyId: pa.organizationPartyId,
        decisionEnumId: decision === "approve" ? "PadApproved" : "PadRefused",
        decisionDate: ec.user.nowTimestamp,
        decidedByUserId: ec.user.userId,
        decidedByPartyId: partyId,
        reason,
        policyFromDate: policyRow ? policyRow.fromDate : null,
        approvalPolicyId: step?.purchaseApprovalPolicyId || null,
        stepSeqId: step ? String(step.sequenceNum) : null,
        operationKey: operation?.operationKey || null
    })
    const answer = {
        agreementId: pa.agreementId,
        agreementRevision: revision,
        purchaseApprovalDecisionId: created.purchaseApprovalDecisionId,
        pendingStepText: null,
        agreementContentId: null
    }
    if (decision === "refuse") approvals().clearNotices(source)
    else {
        const after = approvals().progress(source)
        if (!after.complete) {
            answer.pendingStepText = approvals().stepText(after, after.current)
            approvals().notify(source, after)
        } else {
            const changes = {agreementId: pa.agreementId, approvedRevision: revision, approvedDate: ec.user.nowTimestamp}
            if (pa.agreement.statusId === "AgmStDraft") changes.statusId = "AgmStActive"
            call("update#" + AGREEMENT, changes)
            answer.agreementContentId = storeApprovedPdf(pa.agreementId, revision)
            approvals().clearNotices(source)
        }
    }
    answer.statusId = one(AGREEMENT, {agreementId: pa.agreementId}).statusId
    if (operation) lib.complete(operation, DECISION, created.purchaseApprovalDecisionId, answer)
    return Object.assign(answer, {alreadyApplied: false})
}
// The approved revision's PDF, stored once as the agreement's content (AcntApprovedVersion). Answers its id.
function storeApprovedPdf(agreementId, revision) {
    const printed = printOf(agreementRow(agreementId), null)
    const location = "dbresource://mantle/content/agreement/" + agreementId + "/approved/" + printed.fileName
    const existing = rows(CONTENT, {agreementId}).find(row => row.contentLocation === location)
    if (existing) return existing.agreementContentId
    ec.resource
        .getLocationReference(location)
        .putBytes(ec.resource.xslFoTransform(printed.printHtml, null, null, "application/pdf"))
    return call("create#" + CONTENT, {
        agreementId,
        contentLocation: location,
        contentTypeEnumId: "AcntApprovedVersion",
        description: "Agreement " + agreementId + " revision " + revision + " as approved",
        contentDate: ec.user.nowTimestamp,
        userId: ec.user.userId
    }).agreementContentId
}

// ===== history and the print as of a time =====
// The audit rows of the agreement, its items and its terms, oldest first.
function auditRows(agreementId) {
    const termIds = rows(TERM, {agreementId}).map(row => row.agreementTermId)
    const base = entity =>
        find("moqui.entity.EntityAuditLog").condition("changedEntityName", entity).condition("changedFieldName", "in", allFields)
    const found = Array.from(base(AGREEMENT).condition("pkPrimaryValue", agreementId).list()).concat(
        Array.from(base(ITEM).condition("pkPrimaryValue", agreementId).list())
    )
    if (termIds.length) found.push(...Array.from(base(TERM).condition("pkPrimaryValue", "in", termIds).list()))
    return found.sort((a, b) => ms(a.changedDate) - ms(b.changedDate))
}
// A field's value at a time: the old value of its first change after the time, else the value now.
function valueAt(logs, entity, primary, secondary, field, at, current) {
    const change = logs.find(
        row =>
            row.changedEntityName === entity &&
            row.changedFieldName === field &&
            row.pkPrimaryValue === primary &&
            (secondary == null || row.pkSecondaryValue === secondary) &&
            ms(row.changedDate) > at
    )
    return change ? change.oldValueText : current
}
// When a row was created: its first logged value of one of its fields, or null (loaded as data: always there).
function createdAt(logs, entity, primary, secondary) {
    const created = logs.find(
        row =>
            row.changedEntityName === entity &&
            row.pkPrimaryValue === primary &&
            (secondary == null || row.pkSecondaryValue === secondary) &&
            row.oldValueText == null
    )
    return created ? ms(created.changedDate) : null
}
const valueText = (field, value, currencyUomId) => {
    if (value == null || value === "") return ""
    if (dateFields.includes(field)) return lib.dateText(value)
    if (field === "statusId") return statusText(value)
    if (field === "otherPartyId") return partyName(value)
    if (field === "productId") return productText(value)
    if (field === "quantityUomId") return uomText(value)
    if (field === "termTypeEnumId") return enumText(value)
    if (field === "settlementTermId")
        return one("mantle.account.invoice.SettlementTerm", {settlementTermId: value})?.description || value
    if (field === "amountCap" || field === "price") return money(value, currencyUomId)
    if (["quantity", "termNumber", "releaseTolerancePercent"].includes(field)) return quantityText(value)
    return String(value)
}
// The agreement's history: each logged change of its key fields with the item or term, old and new values, who, when and
// why, and each price change of an item (its price rows), newest first.
function historyOf(agreementId) {
    const agreement = one(AGREEMENT, {agreementId})
    const currencyUomId = agreement?.currencyUomId
    const changes = auditRows(agreementId).map(row => ({
        changedDate: row.changedDate,
        changedDateText: lib.dateText(row.changedDate),
        whatText:
            row.changedEntityName === ITEM
                ? "Item " + row.pkSecondaryValue
                : row.changedEntityName === TERM
                  ? "Term " + row.pkPrimaryValue
                  : "Agreement",
        fieldText: fieldLabels[row.changedFieldName] || row.changedFieldName,
        fromText: valueText(row.changedFieldName, row.oldValueText, currencyUomId),
        toText: valueText(row.changedFieldName, row.newValueText, currencyUomId),
        userText: row.changedByUserId
            ? one("moqui.security.UserAccount", {userId: row.changedByUserId})?.userFullName || row.changedByUserId
            : "",
        reason: row.changeReason || ""
    }))
    for (const item of itemsOf(agreementId)) {
        let previous = null
        for (const row of priceRows(agreementId, item.agreementItemSeqId)) {
            changes.push({
                changedDate: row.fromDate,
                changedDateText: lib.dateText(row.fromDate),
                whatText: "Item " + item.agreementItemSeqId,
                fieldText: "Price",
                fromText: previous ? money(previous.price, currencyUomId) : "",
                toText: money(row.price, currencyUomId),
                userText: "",
                reason: ""
            })
            previous = row
        }
    }
    return changes.sort((a, b) => ms(b.changedDate) - ms(a.changedDate))
}
// The agreement as of a time (null for now): its header, items with their prices and caps, terms, signers and the releases
// made by then, and its revision.
function agreementAt(pa, at) {
    const agreement = pa.agreement
    const nowRead = at == null
    const when = nowRead ? now() : at
    const logs = nowRead ? [] : auditRows(pa.agreementId)
    if (!nowRead) {
        const createdLog = createdAt(logs, AGREEMENT, pa.agreementId, null)
        if (
            (createdLog != null && createdLog > when) ||
            (agreement.agreementDate != null && ms(agreement.agreementDate) > when && createdLog == null)
        )
            denied("AGREEMENT_NOT_YET", "Agreement " + pa.agreementId + " was not entered yet at that time")
    }
    const header = field =>
        nowRead ? agreement[field] : valueAt(logs, AGREEMENT, pa.agreementId, null, field, when, agreement[field])
    const items = []
    for (const item of itemsOf(pa.agreementId)) {
        if (!nowRead) {
            const created = createdAt(logs, ITEM, pa.agreementId, item.agreementItemSeqId)
            if (created != null && created > when) continue
        }
        const value = field =>
            nowRead ? item[field] : valueAt(logs, ITEM, pa.agreementId, item.agreementItemSeqId, field, when, item[field])
        const row = Object.fromEntries(itemFields.map(field => [field, value(field)]))
        const price = priceAt(pa.agreementId, item.agreementItemSeqId, when)
        items.push(
            Object.assign(row, {
                agreementItemSeqId: item.agreementItemSeqId,
                itemText: item.itemText,
                price: price?.price ?? null
            })
        )
    }
    const terms = []
    for (const term of termsOf(pa.agreementId)) {
        if (!nowRead) {
            const created = createdAt(logs, TERM, term.agreementTermId, null)
            if (created != null && created > when) continue
        }
        const value = field => (nowRead ? term[field] : valueAt(logs, TERM, term.agreementTermId, null, field, when, term[field]))
        terms.push(
            Object.assign(Object.fromEntries(termFields.map(field => [field, value(field)])), {
                agreementTermId: term.agreementTermId,
                agreementItemSeqId: term.agreementItemSeqId
            })
        )
    }
    const releases = releasesOf(pa.agreementId).filter(row => ms(row.releaseDate) <= when)
    return {
        statusId: header("statusId"),
        otherPartyId: header("otherPartyId"),
        fromDate: header("fromDate"),
        thruDate: header("thruDate"),
        currencyUomId: header("currencyUomId"),
        revision: Number(header("agreementRevision") ?? 1),
        approvedRevision: header("approvedRevision"),
        items,
        terms,
        releases
    }
}
// The print of an agreement (as of a time, or now): its HTML, revision and file name.
function printOf(pa, at) {
    const agreement = pa.agreement
    const state = agreementAt(pa, at)
    const when = at == null ? now() : at
    const currencyUomId = state.currencyUomId || agreement.currencyUomId
    const live = row => (row.fromDate == null || ms(row.fromDate) <= when) && (row.thruDate == null || ms(row.thruDate) > when)
    const itemRows = state.items.map(item => ({
        seq: item.agreementItemSeqId,
        productText: productText(item.productId),
        itemText: item.itemText || "",
        quantityText: item.quantity == null ? "" : quantityText(item.quantity) + " " + uomText(item.quantityUomId),
        priceText: item.price == null ? "" : money(item.price, currencyUomId),
        capText: item.amountCap == null ? "" : money(item.amountCap, currencyUomId),
        toleranceText: item.releaseTolerancePercent == null ? "" : quantityText(item.releaseTolerancePercent) + "%",
        datesText: [item.fromDate ? lib.dateText(item.fromDate) : "", item.thruDate ? lib.dateText(item.thruDate) : ""].join(
            " – "
        ),
        endedText: live(item) ? "" : "Not in effect"
    }))
    const termRows = state.terms.map(term => ({
        typeText: enumText(term.termTypeEnumId) || (term.settlementTermId ? "Payment term" : "Term"),
        itemText: term.agreementItemSeqId ? "Item " + term.agreementItemSeqId : "",
        valueText: [
            term.settlementTermId ? valueText("settlementTermId", term.settlementTermId) : "",
            term.termText || "",
            term.termNumber == null ? "" : quantityText(term.termNumber)
        ]
            .filter(Boolean)
            .join(" · "),
        endedText: live(term) ? "" : "Not in effect"
    }))
    const releaseRows = state.releases.map(row => ({
        seq: row.agreementItemSeqId,
        orderText: row.orderId + " / " + row.orderItemSeqId,
        dateText: lib.dateText(row.releaseDate),
        quantityText: quantityText(row.quantity) + " " + uomText(row.quantityUomId),
        amountText: money(row.amount, row.currencyUomId),
        revisionText: row.agreementRevision == null ? "" : String(row.agreementRevision)
    }))
    const signers = rows(PARTY, {agreementId: pa.agreementId}).map(
        row =>
            partyName(row.partyId) +
            " (" +
            (one("mantle.party.RoleType", {roleTypeId: row.roleTypeId})?.description || row.roleTypeId) +
            ")"
    )
    const printHtml = ec.resource.template("component://mr-mantle/template/party/PurchaseAgreement.print.html.fancy", {
        agreementId: pa.agreementId,
        description: agreement.description || "",
        organizationName: partyName(pa.organizationPartyId),
        supplierName: partyName(state.otherPartyId || pa.supplierPartyId),
        statusText: statusText(state.statusId),
        revisionText: "Revision " + state.revision,
        asOfText: at == null ? "" : lib.dateText(at),
        validityText: [
            state.fromDate ? lib.dateText(state.fromDate) : "",
            state.thruDate ? lib.dateText(state.thruDate) : "open"
        ].join(" – "),
        currencyText: currencyUomId || "",
        templateText: pa.template ? "Template" : "",
        textData: agreement.textData || "",
        signersText: signers.join(", "),
        itemRows,
        termRows,
        releaseRows
    })
    return {
        printHtml,
        agreementRevision: state.revision,
        statusId: state.statusId,
        fileName: "Agreement-" + pa.agreementId + "-r" + state.revision + ".pdf"
    }
}
// get#PurchaseAgreementPrint: the print as of a time (now when empty), with the agreement's history, for a purchasing reader.
function print(p) {
    requirePermission(...readPermissions)
    const pa = purchaseAgreement(p.agreementId)
    const at = blank(p.asOfDate) ? null : ms(p.asOfDate)
    if (at != null && !Number.isFinite(at)) denied("DATE_INVALID", "Choose a valid date and time")
    if (at != null && at > now()) denied("DATE_INVALID", "Choose a time that has passed")
    return Object.assign({agreementId: pa.agreementId, asOfText: at == null ? "" : lib.dateText(at)}, printOf(pa, at))
}

// ===== expire#PurchaseAgreements =====
// The daily job: each active purchase agreement past its thru date set Expired, each on its own (one that fails is logged and
// the others go on). Its orders stay.
function expire() {
    let expiredCount = 0
    const due = Array.from(
        find(AGREEMENT, {agreementTypeEnumId: "AgrPurchase", statusId: "AgmStActive"})
            .condition("thruDate", "less-equals", ec.user.nowTimestamp)
            .list()
    )
    for (const agreement of due) {
        try {
            ec.service
                .sync()
                .name("update#" + AGREEMENT)
                .parameters({agreementId: agreement.agreementId, statusId: "AgmStExpired"})
                .requireNewTransaction(true)
                .disableAuthz()
                .call()
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
            expiredCount++
        } catch (error) {
            ec.message.clearErrors()
            ec.logger.error("Agreement " + agreement.agreementId + " was not expired: " + error.message)
        }
    }
    return {expiredCount}
}

const operations = {store, storeItem, balance, release, submit, decide, print, expire}
;({
    AGREEMENT,
    purchaseAgreement,
    agreementRow,
    agreementSource,
    balanceOf,
    historyOf,
    releaseRefusal,
    pending,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown purchase agreement operation " + op)
        return operations[op](parameters)
    }
})
