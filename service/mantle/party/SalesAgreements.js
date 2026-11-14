// Sales' customer agreements (mantle.party.SalesAgreementServices, G of IronStone Sales design §12.1; design §7 Agreements and
// AgreementDetail; impl-sales P15, SAL-AGREEMENT).
//
// - A customer agreement is the native Agreement (agreementTypeEnumId AgrSales or AgrProduct) of a selling organization
//   (organizationPartyId, role OrgInternal) with a customer (otherPartyId, role Customer), with its parties (AgreementParty), terms
//   (AgreementTerm), items (AgreementItem) and negotiated prices (ProductPrice rows naming the agreement and its item, sales direction:
//   the seller the vendor, the customer the customer). No table of Sales' own and no Sales status: it uses the one status flow
//   Purchasing seeded (AgmStDraft, AgmStActive, AgmStExpired, AgmStClosed, AgmStCancelled; F19) and Purchasing's audited fields and
//   revision (agreementRevision, counted once by each change here). Purchasing's agreements (AgrPurchase) are not touched.
// - Access (SalesAccess.js agreementOf): a Sales reader of the organization reads its agreements and templates; a change needs
//   SALES_AGREEMENT_EDIT; another organization's, a purchase agreement and a missing one answer RECORD_UNAVAILABLE alike. Every party,
//   template, product and term given is checked; nothing is taken from the caller that the records do not hold.
// - The lifecycle: create#SalesAgreement makes a draft (from a template's items, prices and terms when one is named);
//   activate#SalesAgreement checks the parties (the customer and a signer of the customer's), the dates, the acceptance evidence (a
//   signed document, or the evidence given, kept as AgreementContent) and the prices (each pricing item priced in the agreement's
//   currency, every price row the agreement's own parties'); end#SalesAgreement cancels a draft, closes an active or expired one now,
//   or ends an active one at a later date; renew#SalesAgreement starts a dated successor (a draft copy linked through AgreementAssoc
//   AatRenewal) whose activation ends its predecessor at its start; expire#SalesAgreements, the daily job beside Purchasing's, sets an
//   active one past its date Expired. The price resolver applies an agreement's prices only while the agreement is active and in its
//   dates (PriceResolver.js agreementApplies), so ending an agreement stops its prices for a new quote while an order priced earlier
//   keeps its price.
// - Every change names the revision it read (agreementRevision; REVISION_REQUIRED, REVISION_CHANGED naming the current one).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const salesAccess = ec.resource.script("component://mr-mantle/service/mantle/sales/SalesAccess.js")
const {find, one, rows, denied, call, ms} = lib

const AGREEMENT = "mantle.party.agreement.Agreement"
const PARTY = "mantle.party.agreement.AgreementParty"
const TERM = "mantle.party.agreement.AgreementTerm"
const ITEM = "mantle.party.agreement.AgreementItem"
const ASSOC = "mantle.party.agreement.AgreementAssoc"
const CONTENT = "mantle.party.agreement.AgreementContent"
const PRICE = "mantle.product.ProductPrice"
const types = salesAccess.agreementTypes
const renewalAssoc = "AatRenewal"
const evidenceType = "AcntDocument"
const signerRole = "AgreementSigner"
const editableStatuses = ["AgmStDraft", "AgmStActive"]
const endedStatuses = ["AgmStExpired", "AgmStClosed", "AgmStCancelled"]
const states = {
    open: ["AgmStDraft", "AgmStActive"],
    draft: ["AgmStDraft"],
    active: ["AgmStActive"],
    expiring: ["AgmStActive"],
    ended: endedStatuses,
    templates: null,
    all: null
}
const expiringDays = 30
const dayMs = 24 * 60 * 60 * 1000

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const flag = value => value === true || value === "true" || value === "Y"
// a parameter given: null is not given, an empty text clears the field (dates are passed as text, so an empty one clears too)
const given = (p, field) => p[field] !== undefined && p[field] !== null
const L = value => ec.l10n.localize(value)
const now = () => ms(ec.user.nowTimestamp)
const dayText = value => (value == null || value === "" ? "" : ec.l10n.format(new Date(ms(value)), "d MMM yyyy"))
const moneyText = (value, currencyUomId) =>
    value == null ? "" : ec.l10n.formatCurrency(ec.l10n.roundCurrency(toDecimal(value), currencyUomId), currencyUomId)
const likeText = value => "%" + String(value).replace(/[\\%_]/g, character => "\\" + character) + "%"
const partyName = partyId => (partyId ? lib.partyNames([partyId])[partyId] || partyId : "")
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "")
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")

function decimal(value, label) {
    let number
    try {
        number = toDecimal(value)
    } catch (_) {
        number = null
    }
    if (number == null || number.compare(0) < 0) denied("AMOUNT_INVALID", "Enter a valid " + label)
    return number
}
function dateOf(value, label) {
    if (blank(value)) return null
    const millis = ms(value)
    if (!Number.isFinite(millis)) denied("DATE_INVALID", label + " is not a date")
    return millis
}
const revisionOf = agreement => Number(agreement.agreementRevision ?? 1)
function requireRevision(agreement, given) {
    if (blank(given)) denied("REVISION_REQUIRED", "Reload the agreement and try again (revision " + revisionOf(agreement) + ")")
    if (Number(given) !== revisionOf(agreement))
        denied(
            "REVISION_CHANGED",
            "Agreement " + agreement.agreementId + " changed; its current revision is " + revisionOf(agreement)
        )
}
// A write with a reason: the audit log keeps it with each change (the framework reads <field>_changeReason).
function withReason(fields, reason, write) {
    const keys = fields.map(field => field + "_changeReason")
    if (reason) for (const key of keys) globalThis[key] = reason
    try {
        return write()
    } finally {
        if (reason) for (const key of keys) delete globalThis[key]
    }
}
// The revision counted once, with the other fields of the change.
function revise(agreement, fields, reason) {
    const revision = revisionOf(agreement) + 1
    const changes = Object.assign({}, fields, {agreementRevision: revision, revisionDate: new Date(now())})
    withReason(Object.keys(changes), reason, () =>
        call("update#" + AGREEMENT, Object.assign({agreementId: agreement.agreementId}, changes))
    )
    return revision
}
function requireEditable(agreement) {
    if (!editableStatuses.includes(agreement.statusId))
        denied("AGREEMENT_CLOSED", "Agreement " + agreement.agreementId + " is " + statusText(agreement.statusId))
}
const itemsOf = agreementId =>
    rows(ITEM, {agreementId}).sort((a, b) => String(a.agreementItemSeqId).localeCompare(String(b.agreementItemSeqId)))
const termsOf = agreementId =>
    rows(TERM, {agreementId}).sort((a, b) => String(a.agreementTermId).localeCompare(String(b.agreementTermId)))
const priceRows = (agreementId, agreementItemSeqId) =>
    rows(PRICE, agreementItemSeqId ? {agreementId, agreementItemSeqId} : {agreementId}).sort(
        (a, b) => (ms(a.fromDate) ?? 0) - (ms(b.fromDate) ?? 0)
    )
// An item's price row in effect at a time, else (a draft's) its latest open one.
function priceAt(agreementId, agreementItemSeqId, at = now()) {
    const found = priceRows(agreementId, agreementItemSeqId)
    return found.filter(row => lib.active(row, at)).at(-1) || found.filter(row => row.thruDate == null).at(-1) || null
}
function successorOf(agreementId) {
    return (
        rows(ASSOC, {agreementId, agreementAssocTypeEnumId: renewalAssoc})
            .map(row => one(AGREEMENT, {agreementId: row.toAgreementId}))
            .filter(row => row && row.statusId !== "AgmStCancelled")[0] || null
    )
}
function predecessorOf(agreementId) {
    const assoc = rows(ASSOC, {toAgreementId: agreementId, agreementAssocTypeEnumId: renewalAssoc})[0]
    return assoc ? one(AGREEMENT, {agreementId: assoc.agreementId}) : null
}
// A party who may sign or take part in the agreement: the organization, the customer, a current contact of the customer, or a person
// working for the organization (PrtEmployee, PrtAgent).
function partyAdmitted(agreement, partyId) {
    if (!partyId) return false
    if (partyId === agreement.organizationPartyId || partyId === agreement.otherPartyId) return true
    const current = condition =>
        find("mantle.party.PartyRelationship", condition).conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
    if (
        agreement.otherPartyId &&
        current({fromPartyId: partyId, toPartyId: agreement.otherPartyId, relationshipTypeEnumId: "PrtContact"}).count() > 0
    )
        return true
    return (
        current({fromPartyId: partyId, toPartyId: agreement.organizationPartyId})
            .condition("relationshipTypeEnumId", "in", ["PrtEmployee", "PrtAgent"])
            .count() > 0
    )
}
// The customer's side of the parties: the customer itself or a current contact of it.
function customerSide(agreement, partyId) {
    if (!agreement.otherPartyId) return false
    if (partyId === agreement.otherPartyId) return true
    return (
        find("mantle.party.PartyRelationship", {
            fromPartyId: partyId,
            toPartyId: agreement.otherPartyId,
            relationshipTypeEnumId: "PrtContact"
        })
            .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
            .count() > 0
    )
}
// The customer an agreement of the organization is with: an account of the caller's scope, the organization's or shared.
function requireCustomer(userScope, organizationPartyId, customerPartyId) {
    const account = salesAccess.accountOf(userScope, customerPartyId)
    if (!account || (account.organizationPartyId && account.organizationPartyId !== organizationPartyId))
        denied(
            "CUSTOMER_INVALID",
            "Customer " + (customerPartyId || "") + " is not an account of " + partyName(organizationPartyId)
        )
    return customerPartyId
}
function organizationCurrency(organizationPartyId) {
    return (
        one("mantle.ledger.config.PartyAcctgPreference", {organizationPartyId})?.baseCurrencyUomId ||
        ec.user.getPreference("CurrencyDefault") ||
        "USD"
    )
}

// Another active customer agreement of the organization with the same customer, in effect at some time from `from` (or now, when
// later) to `thru`, that prices one of the products given (an open pricing item of it): two would leave the customer's price to
// whichever started later (PriceResolver.js sellerAgreementIds), so activation and a priced item added to an active agreement
// refuse it (AGREEMENT_OVERLAP). A renewal's predecessor (exceptId), which the renewal's activation ends at its start, is not counted.
function overlapOf(agreement, from, thru, productIds, exceptId = null) {
    if (!agreement.otherPartyId || !productIds.length) return null
    const start = Math.max(from ?? now(), now())
    const others = Array.from(
        find(AGREEMENT, {
            organizationPartyId: agreement.organizationPartyId,
            otherPartyId: agreement.otherPartyId,
            statusId: "AgmStActive"
        })
            .condition("agreementTypeEnumId", "in", types)
            .list()
    ).filter(row => {
        if (row.agreementId === agreement.agreementId || row.agreementId === exceptId || row.isTemplate === "Y") return false
        const otherFrom = ms(row.fromDate),
            otherThru = ms(row.thruDate)
        return (otherThru == null || otherThru > start) && (thru == null || otherFrom == null || otherFrom < thru)
    })
    for (const other of others) {
        const productId = itemsOf(other.agreementId).find(
            item =>
                item.productId &&
                productIds.includes(item.productId) &&
                (item.agreementItemTypeEnumId || "AitPricing") === "AitPricing" &&
                (item.thruDate == null || ms(item.thruDate) > now())
        )?.productId
        if (productId) return {agreement: other, productId}
    }
    return null
}
const overlapText = overlap =>
    L("Agreement") +
    " " +
    (overlap.agreement.description || overlap.agreement.agreementId) +
    " (" +
    overlap.agreement.agreementId +
    ") " +
    L("already prices product") +
    " " +
    overlap.productId +
    " " +
    L("for this customer in these dates; end it, remove its item or renew it instead")

// ===== what activation needs =====
// Each reason the agreement cannot be activated now, as [code, text]; none when it can (the evidence given at activation counts).
function activationIssues(agreement, evidenceGiven = false, fromDate = null) {
    const issues = []
    if (agreement.isTemplate === "Y")
        issues.push(["TEMPLATE_NO_ACTIVATE", L("A template is never activated; start an agreement from it")])
    if (agreement.statusId !== "AgmStDraft")
        issues.push(["STATUS_INVALID", L("Only a draft is activated; this one is") + " " + statusText(agreement.statusId)])
    if (!agreement.otherPartyId) issues.push(["PARTIES_REQUIRED", L("Choose the customer")])
    else if (!rows(PARTY, {agreementId: agreement.agreementId}).some(row => customerSide(agreement, row.partyId)))
        issues.push(["PARTIES_REQUIRED", L("Add the customer's signer (the customer or one of its contacts)")])
    const from = fromDate ?? ms(agreement.fromDate) ?? now()
    const thru = ms(agreement.thruDate)
    if (thru != null && (thru <= from || thru <= now()))
        issues.push(["DATE_INVALID", L("The agreement ends before it starts or has ended already")])
    if (!evidenceGiven && !rows(CONTENT, {agreementId: agreement.agreementId, contentTypeEnumId: evidenceType}).length)
        issues.push(["EVIDENCE_REQUIRED", L("Attach the signed agreement or record the customer's acceptance")])
    const items = itemsOf(agreement.agreementId).filter(item => item.thruDate == null || ms(item.thruDate) > now())
    const terms = termsOf(agreement.agreementId)
    if (!items.length && !terms.length) issues.push(["TERMS_REQUIRED", L("Add the agreement's items, prices or terms")])
    for (const item of items) {
        if (!item.productId || (item.agreementItemTypeEnumId || "AitPricing") !== "AitPricing") continue
        if (!priceAt(agreement.agreementId, item.agreementItemSeqId))
            issues.push(["PRICE_REQUIRED", L("Item") + " " + item.agreementItemSeqId + " " + L("has no negotiated price")])
    }
    const overlap = overlapOf(
        agreement,
        from,
        thru,
        items
            .filter(item => item.productId && (item.agreementItemTypeEnumId || "AitPricing") === "AitPricing")
            .map(item => item.productId),
        predecessorOf(agreement.agreementId)?.agreementId
    )
    if (overlap) issues.push(["AGREEMENT_OVERLAP", overlapText(overlap)])
    for (const row of priceRows(agreement.agreementId)) {
        if (
            row.priceUomId !== agreement.currencyUomId ||
            row.vendorPartyId !== agreement.organizationPartyId ||
            (row.customerPartyId && row.customerPartyId !== agreement.otherPartyId)
        ) {
            issues.push([
                "PRICE_INVALID",
                L("Price") + " " + row.productPriceId + " " + L("is not in the agreement's currency or parties")
            ])
            break
        }
    }
    return issues
}

// ===== find#SalesAgreements =====
function findAgreements(p) {
    const userScope = salesAccess.scope()
    salesAccess.requireCapability(userScope, "anyRead")
    const state = blank(p.state) ? "open" : String(p.state)
    if (!Object.hasOwn(states, state)) denied("STATE_INVALID", "Choose a state of agreements")
    let query = find(AGREEMENT).condition("agreementTypeEnumId", "in", types)
    if (!blank(p.organizationPartyId)) {
        salesAccess.requireOrganization(userScope, String(p.organizationPartyId))
        query = query.condition("organizationPartyId", String(p.organizationPartyId))
    } else if (userScope.organizationPartyIds != null)
        query = query.condition(
            "organizationPartyId",
            "in",
            userScope.organizationPartyIds.length ? userScope.organizationPartyIds : ["_NA_"]
        )
    if (!blank(p.customerPartyId)) query = query.condition("otherPartyId", String(p.customerPartyId))
    if (!blank(p.agreementTypeEnumId)) query = query.condition("agreementTypeEnumId", String(p.agreementTypeEnumId))
    if (state === "templates") query = query.condition("isTemplate", "Y")
    else {
        const cf = ec.entity.conditionFactory
        query = query.condition(
            cf.makeCondition(
                [cf.makeCondition("isTemplate", "not-equals", "Y"), cf.makeCondition("isTemplate", "is-null", null)],
                "or"
            )
        )
        if (states[state]) query = query.condition("statusId", "in", states[state])
    }
    if (state === "expiring") query = query.condition("thruDate", "less-equals", new Date(now() + expiringDays * dayMs))
    if (!blank(p.text)) {
        const cf = ec.entity.conditionFactory
        query = query.condition(
            cf.makeCondition(
                ["description", "agreementId"].map(field => cf.makeCondition(field, "like", likeText(p.text)).ignoreCase()),
                "or"
            )
        )
    }
    const fromDate = dateOf(p.fromDate, "From date")
    const thruDate = dateOf(p.thruDate, "Through date")
    // in effect at some time of the range: starts before its end and ends after its start
    if (thruDate != null) query = query.condition("fromDate", "less-equals", new Date(thruDate))
    if (fromDate != null) {
        const cf = ec.entity.conditionFactory
        query = query.condition(
            cf.makeCondition(
                [cf.makeCondition("thruDate", "is-null", null), cf.makeCondition("thruDate", "greater", new Date(fromDate))],
                "or"
            )
        )
    }
    // an order's agreements: those whose prices its lines took, of an order the caller sees
    if (!blank(p.orderId)) {
        const orderId = String(p.orderId)
        if (!salesAccess.quoteOf(userScope, orderId) && !salesAccess.orderOf(userScope, orderId))
            denied("RECORD_UNAVAILABLE", "Order " + orderId + " is not available")
        const priceIds = rows("mantle.order.OrderItem", {orderId})
            .map(item => item.productPriceId)
            .filter(Boolean)
        const agreementIds = priceIds.length
            ? Array.from(
                  find(PRICE).condition("productPriceId", "in", priceIds).condition("agreementId", "is-not-null", null).list()
              ).map(row => row.agreementId)
            : []
        query = query.condition("agreementId", "in", agreementIds.length ? Array.from(new Set(agreementIds)) : ["_NA_"])
    }
    const count = query.count()
    const found = lib.page(query.orderBy(["-fromDate", "agreementId"]), p, "agreementList", count, {noLimitCap: 1000})
    const names = lib.partyNames(
        Array.from(new Set(found.rows.flatMap(row => [row.organizationPartyId, row.otherPartyId]).filter(Boolean)))
    )
    found.agreementList = found.rows.map(row => listRow(row, names))
    delete found.rows
    delete found.records
    return found
}
function listRow(row, names) {
    const thru = ms(row.thruDate)
    return {
        agreementId: row.agreementId,
        description: row.description || row.agreementId,
        agreementTypeEnumId: row.agreementTypeEnumId,
        typeText: enumText(row.agreementTypeEnumId),
        organizationPartyId: row.organizationPartyId,
        organizationName: names[row.organizationPartyId] || row.organizationPartyId || "",
        customerPartyId: row.otherPartyId || null,
        customerName: row.otherPartyId ? names[row.otherPartyId] || row.otherPartyId : "",
        statusId: row.statusId,
        statusText: row.isTemplate === "Y" ? L("Template") : statusText(row.statusId),
        isTemplate: row.isTemplate === "Y",
        currencyUomId: row.currencyUomId,
        fromText: dayText(row.fromDate),
        thruText: dayText(row.thruDate),
        intervalText: intervalText(row),
        expiring: row.statusId === "AgmStActive" && thru != null && thru <= now() + expiringDays * dayMs,
        agreementRevision: revisionOf(row)
    }
}
function intervalText(row) {
    const from = dayText(row.fromDate),
        thru = dayText(row.thruDate)
    if (!from && !thru) return L("No dates")
    return (from || L("open")) + " – " + (thru || L("no end"))
}

// ===== get#SalesAgreement =====
function getAgreement(p) {
    const userScope = salesAccess.scope()
    const found = salesAccess.agreementOf(userScope, text(p.agreementId))
    if (!found) return {agreementFound: false}
    const agreement = found.agreement
    const agreementId = agreement.agreementId
    const canChange = found.canEdit && editableStatuses.includes(agreement.statusId)
    const parties = rows(PARTY, {agreementId})
    const items = itemsOf(agreementId)
    const terms = termsOf(agreementId)
    const names = lib.partyNames(
        Array.from(
            new Set(
                [agreement.organizationPartyId, agreement.otherPartyId].concat(parties.map(row => row.partyId)).filter(Boolean)
            )
        )
    )
    const productIds = Array.from(new Set(items.map(item => item.productId).filter(Boolean)))
    const products = productIds.length
        ? Object.fromEntries(
              Array.from(find("mantle.product.Product").condition("productId", "in", productIds).list()).map(row => [
                  row.productId,
                  row
              ])
          )
        : {}
    const successor = successorOf(agreementId)
    const predecessor = predecessorOf(agreementId)
    const issues = agreement.statusId === "AgmStDraft" && agreement.isTemplate !== "Y" ? activationIssues(agreement, false) : []
    const currencyUomId = agreement.currencyUomId
    return {
        agreementFound: true,
        agreement: {
            agreementId,
            description: agreement.description || agreementId,
            textData: agreement.textData || "",
            agreementTypeEnumId: agreement.agreementTypeEnumId,
            typeText: enumText(agreement.agreementTypeEnumId),
            organizationPartyId: agreement.organizationPartyId,
            organizationName: names[agreement.organizationPartyId] || agreement.organizationPartyId,
            customerPartyId: agreement.otherPartyId || null,
            customerName: agreement.otherPartyId ? names[agreement.otherPartyId] || agreement.otherPartyId : "",
            statusId: agreement.statusId,
            statusText: agreement.isTemplate === "Y" ? L("Template") : statusText(agreement.statusId),
            isTemplate: agreement.isTemplate === "Y",
            templateAgreementId: agreement.templateAgreementId || null,
            currencyUomId,
            fromDate: agreement.fromDate,
            thruDate: agreement.thruDate,
            intervalText: intervalText(agreement),
            agreementDateText: dayText(agreement.agreementDate),
            agreementRevision: revisionOf(agreement),
            successorAgreementId: successor?.agreementId || null,
            successorName: successor ? successor.description || successor.agreementId : "",
            predecessorAgreementId: predecessor?.agreementId || null,
            predecessorName: predecessor ? predecessor.description || predecessor.agreementId : "",
            canEdit: canChange,
            canDraftEdit: found.canEdit && agreement.statusId === "AgmStDraft",
            canActivate: found.canEdit && agreement.statusId === "AgmStDraft" && agreement.isTemplate !== "Y",
            canEnd: found.canEdit && ["AgmStDraft", "AgmStActive", "AgmStExpired"].includes(agreement.statusId),
            canRenew:
                found.canEdit &&
                agreement.isTemplate !== "Y" &&
                ["AgmStActive", "AgmStExpired"].includes(agreement.statusId) &&
                !successor,
            canAgree: found.canEdit && agreement.isTemplate === "Y"
        },
        activationIssues: issues.map(([code, message]) => ({code, message})),
        parties: parties.map(row => ({
            partyId: row.partyId,
            partyName: names[row.partyId] || row.partyId,
            roleTypeId: row.roleTypeId,
            roleText: one("mantle.party.RoleType", {roleTypeId: row.roleTypeId})?.description || row.roleTypeId,
            side:
                row.partyId === agreement.organizationPartyId || !customerSide(agreement, row.partyId)
                    ? L("Seller")
                    : L("Customer")
        })),
        terms: terms.map(row => ({
            agreementTermId: row.agreementTermId,
            termTypeEnumId: row.termTypeEnumId,
            termTypeText: enumText(row.termTypeEnumId),
            settlementTermId: row.settlementTermId || null,
            settlementText: row.settlementTermId
                ? one("mantle.account.invoice.SettlementTerm", {settlementTermId: row.settlementTermId})?.description ||
                  row.settlementTermId
                : "",
            termText: row.termText || "",
            termNumber: row.termNumber,
            agreementItemSeqId: row.agreementItemSeqId || null,
            intervalText: row.fromDate || row.thruDate ? intervalText(row) : "",
            ended: row.thruDate != null && ms(row.thruDate) <= now()
        })),
        items: items.map(item => {
            const price = priceAt(agreementId, item.agreementItemSeqId)
            return {
                agreementItemSeqId: item.agreementItemSeqId,
                agreementItemTypeEnumId: item.agreementItemTypeEnumId,
                itemTypeText: enumText(item.agreementItemTypeEnumId),
                productId: item.productId || null,
                productName: item.productId ? products[item.productId]?.productName || item.productId : "",
                quantity: item.quantity,
                quantityUomId: item.quantityUomId || null,
                itemText: item.itemText || "",
                intervalText: item.fromDate || item.thruDate ? intervalText(item) : "",
                ended: item.thruDate != null && ms(item.thruDate) <= now(),
                price: price?.price ?? null,
                priceText: price ? moneyText(price.price, currencyUomId) : L("No price"),
                productPriceId: price?.productPriceId || null,
                minQuantity: price?.minQuantity ?? null
            }
        }),
        contents: rows(CONTENT, {agreementId})
            .sort((a, b) => (ms(b.contentDate) ?? 0) - (ms(a.contentDate) ?? 0))
            .map(row => ({
                agreementContentId: row.agreementContentId,
                contentTypeEnumId: row.contentTypeEnumId,
                typeText: enumText(row.contentTypeEnumId),
                description: row.description || "",
                hasFile: !!row.contentLocation,
                dateText: dayText(row.contentDate)
            })),
        connections: connections(userScope, agreementId),
        history: history(agreementId),
        termTypes: termTypeOptions()
    }
}
// The order lines priced from the agreement (their productPriceId one of its rows), of quotes and orders the caller sees.
function connections(userScope, agreementId) {
    const priceIds = priceRows(agreementId).map(row => row.productPriceId)
    if (!priceIds.length) return []
    const lines = Array.from(
        find("mantle.order.OrderItem").condition("productPriceId", "in", priceIds).orderBy("-orderId").limit(200).list()
    )
    const seen = {}
    const found = []
    for (const line of lines) {
        if (!Object.hasOwn(seen, line.orderId)) {
            const order = salesAccess.quoteOf(userScope, line.orderId) || salesAccess.orderOf(userScope, line.orderId)
            seen[line.orderId] = order ? order.order : null
        }
        const order = seen[line.orderId]
        if (!order) continue
        found.push({
            orderId: line.orderId,
            orderItemSeqId: line.orderItemSeqId,
            orderName: order.orderName || line.orderId,
            statusText: statusText(order.statusId),
            placed: !!order.placedDate,
            productId: line.productId,
            quantityText: String(Number(String(line.quantity ?? 1))),
            unitText: moneyText(line.unitAmount ?? 0, order.currencyUomId)
        })
        if (found.length >= 50) break
    }
    return found
}
const historyFields = {
    statusId: "Status",
    fromDate: "From",
    thruDate: "Through",
    otherPartyId: "Customer",
    currencyUomId: "Currency",
    agreementRevision: "Revision"
}
function history(agreementId) {
    const found = Array.from(
        find("moqui.entity.EntityAuditLog")
            .condition("changedEntityName", AGREEMENT)
            .condition("pkPrimaryValue", agreementId)
            .condition("changedFieldName", "in", Object.keys(historyFields))
            .orderBy("-changedDate")
            .limit(50)
            .list()
    )
    const users = {}
    for (const userId of Array.from(new Set(found.map(row => row.changedByUserId).filter(Boolean)))) {
        const account = one("moqui.security.UserAccount", {userId})
        users[userId] = account?.userFullName || account?.username || userId
    }
    return found.map(row => ({
        changedText: lib.dateText(row.changedDate),
        fieldText: L(historyFields[row.changedFieldName]),
        oldText: row.changedFieldName === "statusId" ? statusText(row.oldValueText) : row.oldValueText || "",
        newText: row.changedFieldName === "statusId" ? statusText(row.newValueText) : row.newValueText || "",
        reason: row.changeReason || "",
        userName: users[row.changedByUserId] || ""
    }))
}
function termTypeOptions() {
    return rows("moqui.basic.Enumeration", {enumTypeId: "TermType"})
        .filter(row => row.parentEnumId)
        .sort((a, b) => String(a.description).localeCompare(String(b.description)))
        .map(row => ({value: row.enumId, label: row.description || row.enumId}))
}

// ===== create#SalesAgreement =====
function createAgreement(p) {
    const userScope = salesAccess.scope()
    salesAccess.requireCapability(userScope, "agreementEdit")
    let template = null
    if (!blank(p.templateAgreementId)) {
        const foundTemplate = salesAccess.agreementOf(userScope, String(p.templateAgreementId))
        if (!foundTemplate || foundTemplate.agreement.isTemplate !== "Y")
            denied("TEMPLATE_INVALID", "Agreement " + p.templateAgreementId + " is not a template of yours")
        template = foundTemplate.agreement
    }
    const organizationPartyId =
        text(p.organizationPartyId) || template?.organizationPartyId || salesAccess.defaultOrganization(userScope)
    if (!organizationPartyId || !salesAccess.isInternal(organizationPartyId))
        denied("ORGANIZATION_DENIED", "Choose the selling organization")
    salesAccess.requireOrganization(userScope, organizationPartyId)
    if (template && template.organizationPartyId !== organizationPartyId)
        denied("TEMPLATE_INVALID", "Template " + template.agreementId + " is another organization's")
    const agreementTypeEnumId = text(p.agreementTypeEnumId) || template?.agreementTypeEnumId || "AgrSales"
    if (!types.includes(agreementTypeEnumId)) denied("TYPE_INVALID", "Choose a sales or product agreement")
    const isTemplate = flag(p.isTemplate)
    const customerPartyId = text(p.customerPartyId)
    if (!isTemplate && !customerPartyId) denied("CUSTOMER_INVALID", "Choose the customer")
    if (customerPartyId) requireCustomer(userScope, organizationPartyId, customerPartyId)
    const description = text(p.description) || template?.description
    if (!description) denied("NAME_REQUIRED", "Name the agreement")
    const currencyUomId = text(p.currencyUomId) || template?.currencyUomId || organizationCurrency(organizationPartyId)
    if (!one("moqui.basic.Uom", {uomId: currencyUomId})) denied("CURRENCY_INVALID", "Choose a currency")
    const fromDate = dateOf(p.fromDate, "From date")
    const thruDate = dateOf(p.thruDate, "Through date")
    if (fromDate != null && thruDate != null && thruDate <= fromDate) denied("DATE_INVALID", "The agreement ends after it starts")
    const created = call("create#" + AGREEMENT, {
        agreementTypeEnumId,
        statusId: "AgmStDraft",
        organizationPartyId,
        organizationRoleTypeId: "OrgInternal",
        otherPartyId: customerPartyId,
        otherRoleTypeId: customerPartyId ? "Customer" : null,
        agreementDate: ec.user.nowTimestamp,
        fromDate: fromDate == null ? null : new Date(fromDate),
        thruDate: thruDate == null ? null : new Date(thruDate),
        description,
        textData: text(p.textData) ?? template?.textData ?? null,
        currencyUomId,
        isTemplate: isTemplate ? "Y" : "N",
        templateAgreementId: template?.agreementId || null,
        agreementRevision: 1,
        revisionDate: ec.user.nowTimestamp
    })
    const agreement = one(AGREEMENT, {agreementId: created.agreementId})
    if (template) copyContents(template, agreement, {parties: false})
    return {agreementId: agreement.agreementId, agreementRevision: 1}
}
// A template's or predecessor's items with their prices in effect, and its terms in effect (and its parties for a renewal), copied
// onto a draft; the prices the draft's customer's, open-dated (the agreement's own dates bound them through the price guard).
function copyContents(source, target, options = {}) {
    for (const item of itemsOf(source.agreementId)) {
        if (item.thruDate != null && ms(item.thruDate) <= now()) continue
        const created = call("create#" + ITEM, {
            agreementId: target.agreementId,
            agreementItemTypeEnumId: item.agreementItemTypeEnumId || "AitPricing",
            productId: item.productId || null,
            quantity: item.quantity,
            quantityUomId: item.quantityUomId || null,
            itemText: item.itemText || null
        })
        const price = priceAt(source.agreementId, item.agreementItemSeqId)
        if (price && item.productId)
            writePrice(
                target,
                item.productId,
                created.agreementItemSeqId,
                price.price,
                price.minQuantity,
                item.quantityUomId,
                null
            )
    }
    for (const term of termsOf(source.agreementId)) {
        if (term.thruDate != null && ms(term.thruDate) <= now()) continue
        if (term.agreementItemSeqId) continue
        call("create#" + TERM, {
            agreementId: target.agreementId,
            termTypeEnumId: term.termTypeEnumId,
            settlementTermId: term.settlementTermId || null,
            termText: term.termText || null,
            termNumber: term.termNumber
        })
    }
    if (options.parties)
        for (const row of rows(PARTY, {agreementId: source.agreementId}))
            if (partyAdmitted(target, row.partyId))
                call("create#" + PARTY, {agreementId: target.agreementId, partyId: row.partyId, roleTypeId: row.roleTypeId})
}
function writePrice(agreement, productId, agreementItemSeqId, price, minQuantity, quantityUomId, fromDate) {
    return call("create#" + PRICE, {
        productId,
        vendorPartyId: agreement.organizationPartyId,
        customerPartyId: agreement.otherPartyId || null,
        pricePurposeEnumId: "PppPurchase",
        priceTypeEnumId: "PptCurrent",
        priceUomId: agreement.currencyUomId,
        quantityUomId: quantityUomId || null,
        minQuantity: minQuantity ?? 0,
        price,
        agreementId: agreement.agreementId,
        agreementItemSeqId,
        fromDate: fromDate == null ? null : new Date(fromDate)
    })
}

// ===== store#SalesAgreement =====
// A draft's header (customer, currency, dates, name, text); an active agreement's name, text and through date only.
function storeAgreement(p) {
    const userScope = salesAccess.scope()
    const agreement = salesAccess.requireAgreement(userScope, text(p.agreementId), true).agreement
    requireEditable(agreement)
    requireRevision(agreement, p.agreementRevision)
    const draft = agreement.statusId === "AgmStDraft"
    const changes = {}
    if (given(p, "description")) {
        const description = text(p.description)
        if (!description) denied("NAME_REQUIRED", "Name the agreement")
        if (description !== agreement.description) changes.description = description
    }
    if (given(p, "textData") && (text(p.textData) ?? null) !== (agreement.textData ?? null)) changes.textData = text(p.textData)
    if (given(p, "customerPartyId") && (text(p.customerPartyId) ?? null) !== (agreement.otherPartyId ?? null)) {
        if (!draft) denied("CUSTOMER_LOCKED", "An active agreement's customer stays; renew it for another")
        if (agreement.isTemplate !== "Y" && blank(p.customerPartyId)) denied("CUSTOMER_INVALID", "Choose the customer")
        if (!blank(p.customerPartyId)) requireCustomer(userScope, agreement.organizationPartyId, String(p.customerPartyId))
        changes.otherPartyId = text(p.customerPartyId)
        changes.otherRoleTypeId = changes.otherPartyId ? "Customer" : null
    }
    if (given(p, "currencyUomId") && !blank(p.currencyUomId) && String(p.currencyUomId) !== agreement.currencyUomId) {
        if (!draft) denied("CURRENCY_LOCKED", "An active agreement's currency stays")
        if (!one("moqui.basic.Uom", {uomId: String(p.currencyUomId)})) denied("CURRENCY_INVALID", "Choose a currency")
        changes.currencyUomId = String(p.currencyUomId)
    }
    const from = given(p, "fromDate") ? dateOf(p.fromDate, "From date") : ms(agreement.fromDate)
    const thru = given(p, "thruDate") ? dateOf(p.thruDate, "Through date") : ms(agreement.thruDate)
    if (given(p, "fromDate") && from !== ms(agreement.fromDate)) {
        if (!draft) denied("DATE_LOCKED", "An active agreement's start stays")
        changes.fromDate = from == null ? null : new Date(from)
    }
    if (given(p, "thruDate") && thru !== ms(agreement.thruDate)) {
        if (!draft && (thru == null ? false : thru <= now()))
            denied("DATE_INVALID", "End an active agreement now with End agreement; a new through date is later than now")
        changes.thruDate = thru == null ? null : new Date(thru)
    }
    if (from != null && thru != null && thru <= from) denied("DATE_INVALID", "The agreement ends after it starts")
    if (!Object.keys(changes).length) return {agreementId: agreement.agreementId, agreementRevision: revisionOf(agreement)}
    const revision = revise(agreement, changes, text(p.changeReason))
    // a draft's prices follow its customer and currency
    if (changes.otherPartyId !== undefined || changes.currencyUomId)
        for (const row of priceRows(agreement.agreementId))
            call("update#" + PRICE, {
                productPriceId: row.productPriceId,
                customerPartyId: changes.otherPartyId !== undefined ? changes.otherPartyId : row.customerPartyId,
                priceUomId: changes.currencyUomId || row.priceUomId
            })
    return {agreementId: agreement.agreementId, agreementRevision: revision}
}

// ===== store#AgreementParty =====
function storeParty(p) {
    const userScope = salesAccess.scope()
    const agreement = salesAccess.requireAgreement(userScope, text(p.agreementId), true).agreement
    requireEditable(agreement)
    requireRevision(agreement, p.agreementRevision)
    const partyId = text(p.partyId)
    const roleTypeId = text(p.roleTypeId) || signerRole
    if (!one("mantle.party.RoleGroupMember", {roleGroupEnumId: "RgpAgreement", roleTypeId}))
        denied("ROLE_INVALID", "Choose an agreement role")
    const existing = partyId ? one(PARTY, {agreementId: agreement.agreementId, partyId, roleTypeId}) : null
    if (flag(p.remove)) {
        if (!existing) denied("PARTY_UNAVAILABLE", "That party is not on agreement " + agreement.agreementId)
        if (
            agreement.statusId === "AgmStActive" &&
            customerSide(agreement, partyId) &&
            rows(PARTY, {agreementId: agreement.agreementId}).filter(row => customerSide(agreement, row.partyId)).length <= 1
        )
            denied("PARTIES_REQUIRED", "An active agreement keeps a signer of the customer's")
        call("delete#" + PARTY, {agreementId: agreement.agreementId, partyId, roleTypeId})
    } else {
        if (!partyAdmitted(agreement, partyId))
            denied(
                "PARTY_INVALID",
                "Choose the organization, the customer, a contact of the customer or a person of the organization"
            )
        if (existing) return {agreementId: agreement.agreementId, agreementRevision: revisionOf(agreement)}
        call("create#" + PARTY, {agreementId: agreement.agreementId, partyId, roleTypeId})
    }
    return {agreementId: agreement.agreementId, agreementRevision: revise(agreement, {}, text(p.changeReason))}
}

// ===== store#AgreementTerm =====
function storeTerm(p) {
    const userScope = salesAccess.scope()
    const agreement = salesAccess.requireAgreement(userScope, text(p.agreementId), true).agreement
    requireEditable(agreement)
    requireRevision(agreement, p.agreementRevision)
    const draft = agreement.statusId === "AgmStDraft"
    let term = blank(p.agreementTermId) ? null : one(TERM, {agreementTermId: String(p.agreementTermId)})
    if (!blank(p.agreementTermId) && (!term || term.agreementId !== agreement.agreementId))
        denied("TERM_UNAVAILABLE", "Term " + p.agreementTermId + " is not on agreement " + agreement.agreementId)
    if (term && flag(p.remove)) {
        // a draft's term is removed; an active agreement's is ended now, its history kept
        if (draft) call("delete#" + TERM, {agreementTermId: term.agreementTermId})
        else call("update#" + TERM, {agreementTermId: term.agreementTermId, thruDate: ec.user.nowTimestamp})
        return {
            agreementId: agreement.agreementId,
            agreementTermId: term.agreementTermId,
            agreementRevision: revise(agreement, {}, text(p.changeReason))
        }
    }
    const values = {}
    if (given(p, "termTypeEnumId")) {
        const type = text(p.termTypeEnumId)
        if (!type || one("moqui.basic.Enumeration", {enumId: type})?.enumTypeId !== "TermType")
            denied("TERM_TYPE_INVALID", "Choose a term type")
        values.termTypeEnumId = type
    }
    if (given(p, "settlementTermId")) {
        const settlementTermId = text(p.settlementTermId)
        if (settlementTermId && !one("mantle.account.invoice.SettlementTerm", {settlementTermId}))
            denied("TERM_TYPE_INVALID", "Choose a settlement term")
        values.settlementTermId = settlementTermId
    }
    if (given(p, "termText")) values.termText = text(p.termText)
    if (given(p, "termNumber")) values.termNumber = blank(p.termNumber) ? null : decimal(p.termNumber, "term value")
    if (given(p, "agreementItemSeqId")) {
        const itemSeqId = text(p.agreementItemSeqId)
        if (itemSeqId && !one(ITEM, {agreementId: agreement.agreementId, agreementItemSeqId: itemSeqId}))
            denied("ITEM_UNAVAILABLE", "Item " + itemSeqId + " is not on agreement " + agreement.agreementId)
        values.agreementItemSeqId = itemSeqId
    }
    for (const field of ["fromDate", "thruDate"])
        if (given(p, field)) {
            const value = dateOf(p[field], "Term date")
            values[field] = value == null ? null : new Date(value)
        }
    if (!term && !values.termTypeEnumId) denied("TERM_TYPE_INVALID", "Choose a term type")
    if (term && !draft) {
        // an active agreement's term is ended and its change started as a new term, so the earlier wording stays readable
        call("update#" + TERM, {agreementTermId: term.agreementTermId, thruDate: ec.user.nowTimestamp})
        const merged = Object.assign(
            {
                termTypeEnumId: term.termTypeEnumId,
                settlementTermId: term.settlementTermId,
                termText: term.termText,
                termNumber: term.termNumber,
                agreementItemSeqId: term.agreementItemSeqId,
                thruDate: term.thruDate
            },
            values,
            {fromDate: ec.user.nowTimestamp}
        )
        term = null
        Object.assign(values, merged)
    }
    let agreementTermId
    if (term) {
        call("update#" + TERM, Object.assign({agreementTermId: term.agreementTermId}, values))
        agreementTermId = term.agreementTermId
    } else agreementTermId = call("create#" + TERM, Object.assign({agreementId: agreement.agreementId}, values)).agreementTermId
    return {agreementId: agreement.agreementId, agreementTermId, agreementRevision: revise(agreement, {}, text(p.changeReason))}
}

// ===== store#AgreementItem =====
// An item (a product and its negotiated price, a service commitment or a section of text): a draft's changed in place; an active
// agreement's price change ends the price in effect and starts the next now, an item removed from it ended, its history kept.
function storeItem(p) {
    const userScope = salesAccess.scope()
    const agreement = salesAccess.requireAgreement(userScope, text(p.agreementId), true).agreement
    requireEditable(agreement)
    requireRevision(agreement, p.agreementRevision)
    const draft = agreement.statusId === "AgmStDraft"
    const reason = text(p.changeReason)
    let item = blank(p.agreementItemSeqId)
        ? null
        : one(ITEM, {agreementId: agreement.agreementId, agreementItemSeqId: String(p.agreementItemSeqId)})
    if (!blank(p.agreementItemSeqId) && !item)
        denied("ITEM_UNAVAILABLE", "Item " + p.agreementItemSeqId + " is not on agreement " + agreement.agreementId)
    if (item && flag(p.remove)) {
        if (draft) {
            for (const row of priceRows(agreement.agreementId, item.agreementItemSeqId))
                call("delete#" + PRICE, {productPriceId: row.productPriceId})
            for (const row of rows(TERM, {agreementId: agreement.agreementId, agreementItemSeqId: item.agreementItemSeqId}))
                call("delete#" + TERM, {agreementTermId: row.agreementTermId})
            call("delete#" + ITEM, {agreementId: agreement.agreementId, agreementItemSeqId: item.agreementItemSeqId})
        } else {
            call("update#" + ITEM, {
                agreementId: agreement.agreementId,
                agreementItemSeqId: item.agreementItemSeqId,
                thruDate: ec.user.nowTimestamp
            })
            endPrices(agreement.agreementId, item.agreementItemSeqId)
        }
        return {
            agreementId: agreement.agreementId,
            agreementItemSeqId: item.agreementItemSeqId,
            agreementRevision: revise(agreement, {}, reason)
        }
    }
    const values = {}
    if (given(p, "agreementItemTypeEnumId") && !blank(p.agreementItemTypeEnumId)) {
        const type = String(p.agreementItemTypeEnumId)
        if (!["AitPricing", "AitSection", "AitExhibit"].includes(type)) denied("ITEM_TYPE_INVALID", "Choose an item type")
        values.agreementItemTypeEnumId = type
    }
    if (given(p, "productId") && (text(p.productId) ?? null) !== (item?.productId ?? null)) {
        const productId = text(p.productId)
        if (productId) {
            const product = one("mantle.product.Product", {productId})
            if (!product) denied("PRODUCT_REQUIRED", "Choose a product")
            const owner = product.ownerPartyId
            if (owner && owner !== "_NA_" && owner !== agreement.organizationPartyId)
                denied(
                    "PRODUCT_NOT_USABLE",
                    "Product " + productId + " is not in " + partyName(agreement.organizationPartyId) + "'s catalogue"
                )
        }
        if (item && !draft) denied("PRODUCT_LOCKED", "An active agreement's item keeps its product; add another item")
        values.productId = productId
    }
    if (given(p, "quantity")) values.quantity = blank(p.quantity) ? null : decimal(p.quantity, "quantity")
    if (given(p, "quantityUomId")) values.quantityUomId = text(p.quantityUomId)
    if (given(p, "itemText")) values.itemText = text(p.itemText)
    for (const field of ["fromDate", "thruDate"])
        if (given(p, field)) {
            const value = dateOf(p[field], "Item date")
            values[field] = value == null ? null : new Date(value)
        }
    const type = values.agreementItemTypeEnumId || item?.agreementItemTypeEnumId || "AitPricing"
    const productId = Object.hasOwn(values, "productId") ? values.productId : item?.productId
    if (type === "AitPricing" && !productId) denied("PRODUCT_REQUIRED", "Choose the product the price is for")
    const from = Object.hasOwn(values, "fromDate") ? ms(values.fromDate) : ms(item?.fromDate)
    const thru = Object.hasOwn(values, "thruDate") ? ms(values.thruDate) : ms(item?.thruDate)
    if (from != null && thru != null && thru <= from) denied("DATE_INVALID", "The item ends after it starts")
    // a negotiated price is inside the agreement's interval (design §7)
    const agreementFrom = ms(agreement.fromDate),
        agreementThru = ms(agreement.thruDate)
    if (
        (from != null && agreementFrom != null && from < agreementFrom) ||
        (thru != null && agreementThru != null && thru > agreementThru)
    )
        denied("DATE_INVALID", "The item's dates are inside the agreement's")
    const price = given(p, "price") && !blank(p.price) ? decimal(p.price, "price") : null
    const minQuantity = given(p, "minQuantity") && !blank(p.minQuantity) ? decimal(p.minQuantity, "minimum quantity") : null
    if (price != null && !productId) denied("PRODUCT_REQUIRED", "Choose the product the price is for")
    // a product priced anew on an active agreement: not one another current agreement with the customer prices
    if (!draft && !item && type === "AitPricing") {
        const overlap = overlapOf(agreement, agreementFrom, agreementThru, [productId])
        if (overlap) denied("AGREEMENT_OVERLAP", overlapText(overlap))
    }
    if (!item) {
        const created = withReason(Object.keys(values), reason, () =>
            call("create#" + ITEM, Object.assign({agreementId: agreement.agreementId, agreementItemTypeEnumId: type}, values))
        )
        item = one(ITEM, {agreementId: agreement.agreementId, agreementItemSeqId: created.agreementItemSeqId})
    } else if (Object.keys(values).length) {
        withReason(Object.keys(values), reason, () =>
            call(
                "update#" + ITEM,
                Object.assign({agreementId: agreement.agreementId, agreementItemSeqId: item.agreementItemSeqId}, values)
            )
        )
        item = one(ITEM, {agreementId: agreement.agreementId, agreementItemSeqId: item.agreementItemSeqId})
    }
    if (price != null || minQuantity != null) storePrice(agreement, item, price, minQuantity, draft, reason)
    else if (draft && Object.hasOwn(values, "productId"))
        for (const row of priceRows(agreement.agreementId, item.agreementItemSeqId))
            call("update#" + PRICE, {productPriceId: row.productPriceId, productId: item.productId})
    if (item.thruDate != null && ms(item.thruDate) <= now()) endPrices(agreement.agreementId, item.agreementItemSeqId)
    return {
        agreementId: agreement.agreementId,
        agreementItemSeqId: item.agreementItemSeqId,
        agreementRevision: revise(agreement, {}, reason)
    }
}
// An item's negotiated price: a draft's one row changed in place; an active agreement's row in effect ended now and the next started.
function storePrice(agreement, item, price, minQuantity, draft, reason) {
    const current = priceAt(agreement.agreementId, item.agreementItemSeqId)
    const amount = price ?? (current ? toDecimal(current.price) : null)
    if (amount == null) denied("PRICE_REQUIRED", "Enter the negotiated price")
    const minimum = minQuantity ?? (current?.minQuantity == null ? toDecimal(0) : toDecimal(current.minQuantity))
    const from = ms(item.fromDate)
    const thru = ms(item.thruDate)
    if (draft && current) {
        withReason(["price"], reason, () =>
            call("update#" + PRICE, {
                productPriceId: current.productPriceId,
                productId: item.productId,
                price: amount,
                minQuantity: minimum,
                quantityUomId: item.quantityUomId || null,
                fromDate: from == null ? null : new Date(from),
                thruDate: thru == null ? null : new Date(thru)
            })
        )
        return
    }
    if (current && toDecimal(current.price).compare(amount) === 0 && toDecimal(current.minQuantity ?? 0).compare(minimum) === 0)
        return
    const at = now()
    if (current) call("update#" + PRICE, {productPriceId: current.productPriceId, thruDate: new Date(at)})
    const created = writePrice(
        agreement,
        item.productId,
        item.agreementItemSeqId,
        amount,
        minimum,
        item.quantityUomId,
        draft ? from : at
    )
    if (thru != null) call("update#" + PRICE, {productPriceId: created.productPriceId, thruDate: new Date(thru)})
}
function endPrices(agreementId, agreementItemSeqId) {
    const at = now()
    for (const row of priceRows(agreementId, agreementItemSeqId))
        if (row.thruDate == null || ms(row.thruDate) > at)
            call("update#" + PRICE, {productPriceId: row.productPriceId, thruDate: new Date(at)})
}

// ===== activate#SalesAgreement =====
function activateAgreement(p) {
    const userScope = salesAccess.scope()
    const agreement = salesAccess.requireAgreement(userScope, text(p.agreementId), true).agreement
    requireRevision(agreement, p.agreementRevision)
    const fromDate = dateOf(p.fromDate, "From date")
    const evidence = text(p.acceptanceEvidence)
    const issues = activationIssues(agreement, !!evidence, fromDate)
    if (issues.length) denied(issues[0][0], issues.map(issue => issue[1]).join("; "))
    if (evidence)
        call("create#" + CONTENT, {
            agreementId: agreement.agreementId,
            contentTypeEnumId: evidenceType,
            description: evidence,
            contentDate: ec.user.nowTimestamp,
            userId: ec.user.userId
        })
    const start = fromDate ?? ms(agreement.fromDate) ?? now()
    const revision = revise(
        agreement,
        {statusId: "AgmStActive", fromDate: new Date(start), agreementDate: agreement.agreementDate || ec.user.nowTimestamp},
        text(p.changeReason) || L("Activated")
    )
    // a renewal ends its predecessor at its own start
    const predecessor = predecessorOf(agreement.agreementId)
    let predecessorEnded = null
    if (
        predecessor &&
        predecessor.statusId === "AgmStActive" &&
        (predecessor.thruDate == null || ms(predecessor.thruDate) > start)
    ) {
        const closing = start <= now()
        withReason(["statusId", "thruDate"], L("Renewed by") + " " + agreement.agreementId, () =>
            call(
                "update#" + AGREEMENT,
                Object.assign(
                    {agreementId: predecessor.agreementId, thruDate: new Date(closing ? now() : start)},
                    closing ? {statusId: "AgmStClosed"} : {},
                    {agreementRevision: revisionOf(predecessor) + 1, revisionDate: ec.user.nowTimestamp}
                )
            )
        )
        predecessorEnded = predecessor.agreementId
    }
    return {agreementId: agreement.agreementId, agreementRevision: revision, statusId: "AgmStActive", predecessorEnded}
}

// ===== end#SalesAgreement =====
// A draft cancelled; an active one closed now, or ended at a later date (it stays active until then and then expires); an expired
// one closed. Its orders and their prices stay as they are.
function endAgreement(p) {
    const userScope = salesAccess.scope()
    const agreement = salesAccess.requireAgreement(userScope, text(p.agreementId), true).agreement
    requireRevision(agreement, p.agreementRevision)
    const reason = text(p.reason)
    if (!reason) denied("REASON_REQUIRED", "Give the reason for ending the agreement")
    const endDate = dateOf(p.endDate, "End date")
    let fields
    if (agreement.statusId === "AgmStDraft") fields = {statusId: "AgmStCancelled"}
    else if (agreement.statusId === "AgmStExpired") fields = {statusId: "AgmStClosed"}
    else if (agreement.statusId === "AgmStActive") {
        const at = endDate ?? now()
        const from = ms(agreement.fromDate)
        if (at > now() && from != null && at <= from) denied("DATE_INVALID", "The agreement ends after it starts")
        fields = at <= now() ? {statusId: "AgmStClosed", thruDate: new Date(now())} : {thruDate: new Date(at)}
    } else denied("AGREEMENT_CLOSED", "Agreement " + agreement.agreementId + " is " + statusText(agreement.statusId))
    const revision = revise(agreement, fields, reason)
    const ended = one(AGREEMENT, {agreementId: agreement.agreementId})
    return {agreementId: agreement.agreementId, agreementRevision: revision, statusId: ended.statusId, thruDate: ended.thruDate}
}

// ===== renew#SalesAgreement =====
// A dated successor: a draft copy (parties, items with their prices in effect, terms in effect) from the predecessor's end, linked
// through AgreementAssoc (AatRenewal); one at a time.
function renewAgreement(p) {
    const userScope = salesAccess.scope()
    const source = salesAccess.requireAgreement(userScope, text(p.agreementId), true).agreement
    requireRevision(source, p.agreementRevision)
    if (source.isTemplate === "Y") denied("TEMPLATE_NO_ACTIVATE", "A template is not renewed; start an agreement from it")
    if (!["AgmStActive", "AgmStExpired"].includes(source.statusId))
        denied("STATUS_INVALID", "Only an active or expired agreement is renewed; this one is " + statusText(source.statusId))
    const successor = successorOf(source.agreementId)
    if (successor) denied("SUCCESSOR_EXISTS", "Agreement " + successor.agreementId + " already renews " + source.agreementId)
    const sourceFrom = ms(source.fromDate),
        sourceThru = ms(source.thruDate)
    const fromDate = dateOf(p.fromDate, "From date") ?? (sourceThru != null && sourceThru > now() ? sourceThru : now())
    let thruDate = dateOf(p.thruDate, "Through date")
    if (thruDate == null && !given(p, "thruDate") && sourceFrom != null && sourceThru != null)
        thruDate = fromDate + (sourceThru - sourceFrom)
    if (thruDate != null && thruDate <= fromDate) denied("DATE_INVALID", "The renewal ends after it starts")
    const created = call("create#" + AGREEMENT, {
        agreementTypeEnumId: source.agreementTypeEnumId,
        statusId: "AgmStDraft",
        organizationPartyId: source.organizationPartyId,
        organizationRoleTypeId: source.organizationRoleTypeId || "OrgInternal",
        otherPartyId: source.otherPartyId,
        otherRoleTypeId: source.otherRoleTypeId || "Customer",
        agreementDate: ec.user.nowTimestamp,
        fromDate: new Date(fromDate),
        thruDate: thruDate == null ? null : new Date(thruDate),
        description: text(p.description) || source.description,
        textData: source.textData,
        currencyUomId: source.currencyUomId,
        isTemplate: "N",
        templateAgreementId: source.templateAgreementId || null,
        agreementRevision: 1,
        revisionDate: ec.user.nowTimestamp
    })
    const target = one(AGREEMENT, {agreementId: created.agreementId})
    copyContents(source, target, {parties: true})
    call("create#" + ASSOC, {
        agreementId: source.agreementId,
        toAgreementId: target.agreementId,
        agreementAssocTypeEnumId: renewalAssoc
    })
    // the predecessor's revision counted, so a second renewal from the same read is refused as stale
    const predecessorRevision = revise(source, {}, L("Renewed by") + " " + target.agreementId)
    return {
        agreementId: target.agreementId,
        agreementRevision: 1,
        predecessorAgreementId: source.agreementId,
        predecessorRevision
    }
}

// ===== expire#SalesAgreements =====
// The daily job: each active customer agreement past its through date set Expired, each in its own transaction (one that fails is
// logged and the others go on). Its orders stay.
function expireAgreements() {
    let expiredCount = 0
    const due = Array.from(
        find(AGREEMENT, {statusId: "AgmStActive"})
            .condition("agreementTypeEnumId", "in", types)
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

const operations = {
    findAgreements,
    getAgreement,
    createAgreement,
    storeAgreement,
    storeParty,
    storeTerm,
    storeItem,
    activateAgreement,
    endAgreement,
    renewAgreement,
    expireAgreements
}
;({
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown sales agreement operation " + op)
        return operations[op](parameters)
    }
})
