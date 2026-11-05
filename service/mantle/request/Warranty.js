// Warranty claims (CS-WARRANTY; design-customer-service §5 WarrantyClaims and WarrantyAssessment, crosscut §3.2 DeliveredItems;
// impl-customer-service §4, P11, F45, F50, F67; WarrantyServices.xml, SupportWarrantyEntities.xml). A claim is its case, a Request
// of type RqtWarranty: its product a RequestItem, its asset (the sold serial or lot), order, invoice and agreement RequestRecord
// links, and its evidence's revision Request.claimRevision. The coverage is read, by §4's hierarchy: an AgrService agreement of
// the organization with the customer, in effect at the claim's date, with a warranty term (TtWarranty) for the product; then
// the product's warranty at sale (the serial or lot traced through AssetIssuance to its order, customer and ship date, the term
// from the product's PftWarranty feature, its number and time unit), with the coverage end and its source; else none, and
// only goodwill covers it. A decision is a WarrantyDecision at the claim's revision; a goodwill decision, and a covered or
// partial decision against a lookup that found the coverage ended (a rejection override, with a manual coverage end and its
// reason), need WARRANTY_APPROVE. A repair is one AssetMaintenance on the sold serial's Asset (EquipmentServices
// create#AssetMaintenance, which checks nothing itself, F51) with a WepMaintenance task, linked to the case by RequestRecord;
// this module checks the organization (the asset's facility owner or the sale's vendor) and the customer (the asset's owner or
// the sale's customer) itself. Its completion tells the case's agent and resolves nothing. A replacement goes through a return
// (ReturnPolicyServices). Every service checks its permission and the case's organization (SupportCases.caseOf) and reads and
// writes with artifact authorization off. Refusals carry reason codes (EntityLib.denied).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const time = ec.resource.script("component://mr-mantle/service/mantle/work/BusinessTime.js")
const cases = () => ec.resource.script("component://mr-mantle/service/mantle/request/SupportCases.js")
const {find, one, rows, call, denied, access, ms} = lib

const REQUEST = "mantle.request.Request",
    ITEM = "mantle.request.RequestItem",
    RECORD = "mantle.request.RequestRecord",
    REQUEST_PARTY = "mantle.request.RequestParty",
    DECISION = "mantle.request.support.WarrantyDecision",
    ASSET = "mantle.product.asset.Asset",
    ISSUANCE = "mantle.product.issuance.AssetIssuance",
    MAINTENANCE = "mantle.product.maintenance.AssetMaintenance",
    WORK = "mantle.work.effort.WorkEffort",
    AGREEMENT = "mantle.party.agreement.Agreement",
    AGREEMENT_ITEM = "mantle.party.agreement.AgreementItem",
    TERM = "mantle.party.agreement.AgreementTerm",
    ORDER = "mantle.order.OrderHeader",
    PART = "mantle.order.OrderPart",
    ORDER_ITEM = "mantle.order.OrderItem",
    BILLING = "mantle.order.OrderItemBilling",
    INVOICE = "mantle.account.invoice.Invoice",
    RETURN = "mantle.order.return.ReturnHeader",
    FACILITY = "mantle.facility.Facility",
    PRODUCT = "mantle.product.Product"
const claimType = "RqtWarranty"
const serviceAgreementType = "AgrService"
const warrantyTerm = "TtWarranty"
const warrantyFeature = "PftWarranty"
const topic = "WarrantyRepairFinished"
// the evidence a claim links, by its RequestRecord entity
const evidenceKinds = {assetId: ASSET, orderId: ORDER, invoiceId: INVOICE, agreementId: AGREEMENT}
const decisions = ["WdCovered", "WdPartial", "WdRejected", "WdGoodwill"]
const approvedDecisions = ["WdCovered", "WdPartial", "WdGoodwill"]
const readPermissions = ["SUPPORT_CASE_EDIT", "SUPPORT_CASE_MANAGE", "WARRANTY_APPROVE"]
const closedStatuses = ["ReqCompleted", "ReqCancelled"]
const closedMaintenance = ["AsMntCompleted", "AsMntCancelled"]
// the time units a warranty feature's term may be in, as calendar steps
const termUnits = {TF_day: ["day", 1], TF_wk: ["day", 7], TF_mon: ["month", 1], TF_yr: ["month", 12]}

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const number = value => (value == null || value === "" ? 0 : Number(String(value)))
const has = permission => access.has(permission)
const hasAny = permissions => permissions.some(has)
const now = () => ec.user.nowTimestamp
const nowMs = () => Number(ms(ec.user.nowTimestamp))
const stamp = millis => (millis == null ? null : new Date(Number(millis)))
// a day (yyyy-MM-dd) in a time zone (none: the user's)
const dayText = (millis, zone) => (millis == null ? "" : time.dayIn(millis, zone || null))
// The organization's time zone: its working-hours calendar's (BusinessTime.scheduleOf), else the user's. A warranty's dates
// are its days: the ship day, and the end day the term after it.
const zoneOf = organizationPartyId =>
    organizationPartyId ? time.scheduleOf({partyId: organizationPartyId}).timeZone || null : null
const partyName = partyId => (partyId ? lib.partyNames([partyId])[partyId] || partyId : "")
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "")
const isInternal = partyId => !!partyId && !!one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
const productText = productId => {
    const product = productId ? one(PRODUCT, {productId}) : null
    return product ? [product.pseudoId || product.productId, product.productName].filter(Boolean).join(" · ") : productId || ""
}
const assetText = asset =>
    asset
        ? [asset.serialNumber ? "serial " + asset.serialNumber : asset.lotId ? "lot " + asset.lotId : asset.assetId].join("")
        : ""
function requireRead() {
    if (!hasAny(readPermissions))
        denied("PERMISSION_DENIED", readPermissions.join(" or ") + " is required to read warranty claims")
}
function requirePermission(permission) {
    if (!has(permission)) denied("PERMISSION_DENIED", permission + " is required")
}
// The end of a term from a time, in the organization's time zone: the start of the day the term after the start's day (whole
// days, or calendar months kept on the same day, the month's last when it is shorter), so the term covers whole days.
function addTerm(startMs, quantity, uomId, zone) {
    const unit = termUnits[uomId]
    if (startMs == null || !unit || !(quantity > 0)) return null
    const [y, m, d] = time
        .dayIn(startMs, zone || null)
        .split("-")
        .map(Number)
    const steps = Math.round(quantity * unit[1])
    let end
    if (unit[0] === "day") end = new Date(Date.UTC(y, m - 1, d + steps))
    else {
        const lastDay = new Date(Date.UTC(y, m - 1 + steps + 1, 0)).getUTCDate()
        end = new Date(Date.UTC(y, m - 1 + steps, Math.min(d, lastDay)))
    }
    return time.dayStartIn(end.toISOString().slice(0, 10), zone || null)
}
const termText = (quantity, uomId) =>
    quantity > 0 && uomId
        ? String(quantity) +
          " " +
          ({TF_day: "day", TF_wk: "week", TF_mon: "month", TF_yr: "year"}[uomId] || enumText(uomId)) +
          (quantity === 1 ? "" : "s")
        : ""

// ===== the claim =====
// A case of one of the user's organizations; with claim (the default), of type RqtWarranty. A missing request, one that is not
// a case and another organization's are refused alike (RECORD_UNAVAILABLE), a case of another type NOT_A_CLAIM.
function claimOf(requestId, options = {}) {
    const theCase = cases().caseOf(requestId, !!options.lock)
    const isClaim = theCase.request.requestTypeEnumId === claimType
    if (options.claim !== false && !isClaim)
        denied("NOT_A_CLAIM", "Case " + theCase.requestId + " is not a warranty claim; record its evidence first")
    return Object.assign(theCase, {isClaim, claimRevision: number(theCase.request.claimRevision)})
}
// The claim's evidence: its product line (the first open RequestItem) and its asset, order, invoice and agreement links, with
// the repairs and returns it links.
function evidenceOf(requestId) {
    const item =
        rows(ITEM, {requestId})
            .filter(row => row.statusId !== "ReqCancelled")
            .sort((a, b) => String(a.requestItemSeqId).localeCompare(String(b.requestItemSeqId)))[0] || null
    const links = rows(RECORD, {requestId})
    const linked = entity => links.filter(row => row.recordEntityName === entity).map(row => row.recordId)
    const evidence = {
        item,
        productId: item?.productId || null,
        quantity: item?.quantity ?? null,
        faultText: item?.description || ""
    }
    for (const [field, entity] of Object.entries(evidenceKinds)) evidence[field] = linked(entity)[0] || null
    evidence.maintenanceIds = linked(MAINTENANCE)
    evidence.returnIds = linked(RETURN)
    return evidence
}
// The decisions of a claim, newest first; the current one is the newest at the claim's revision that is not superseded.
const decisionsOf = requestId =>
    rows(DECISION, {requestId}).sort(
        (a, b) =>
            ms(b.decisionDate) - ms(a.decisionDate) || String(b.warrantyDecisionId).localeCompare(String(a.warrantyDecisionId))
    )
const currentDecisionOf = (requestId, revision) =>
    decisionsOf(requestId).find(row => !row.supersededDate && number(row.sourceRevision) === revision) || null
// The claim's state for the lists (design WarrantyClaims' groups), read, not stored.
function stateOf(request, evidence, current) {
    if (closedStatuses.includes(request.statusId)) return "closed"
    if (!evidence.productId && !evidence.assetId) return "needsEvidence"
    if (request.statusId === "ReqWaitingCustomer") return "followUp"
    if (current) return current.decisionEnumId === "WdRejected" ? "rejected" : "approved"
    return "assessment"
}
const stateTexts = {
    needsEvidence: "Needs evidence",
    assessment: "Assessment",
    approved: "Approved repair or replacement",
    rejected: "Rejected",
    followUp: "Customer follow-up",
    closed: "Closed"
}

// ===== the sale =====
// The sales order part of an order item: its vendor (an internal organization) and customer (not internal), else null.
function salePartOf(orderId, orderItemSeqId) {
    const item = orderItemSeqId ? one(ORDER_ITEM, {orderId, orderItemSeqId}) : null
    const parts = rows(PART, {orderId})
    const part = (item ? parts.find(row => row.orderPartSeqId === item.orderPartSeqId) : null) || parts[0] || null
    if (!part || !isInternal(part.vendorPartyId) || !part.customerPartyId || isInternal(part.customerPartyId)) return null
    return {part, item}
}
// The sale of a serial, a lot or an order's product, traced through AssetIssuance: the latest issuance to a sales order (of
// the organization, to the customer, when given), with its order, line, shipment, customer and ship date (the issue date: a
// sales order's stock is issued when it ships). Null when none is found. A serial is one unit: its latest sale of the
// organization, over every asset of its product with that serial number (a return is received as a new asset), is its
// holder's, so a serial returned and sold again to another customer is no longer the first customer's.
function traceSale(facts) {
    let issuances = []
    const asset = facts.assetId ? one(ASSET, {assetId: facts.assetId}) : null
    const serial = !!asset?.serialNumber
    if (serial) {
        const assetIds = rows(ASSET, {serialNumber: asset.serialNumber, productId: asset.productId}).map(row => row.assetId)
        issuances = Array.from(find(ISSUANCE).condition("assetId", "in", assetIds.slice(0, 500)).list())
    } else if (facts.assetId) issuances = rows(ISSUANCE, {assetId: facts.assetId})
    else if (facts.lotId) {
        const assetIds = rows(ASSET, {lotId: facts.lotId})
            .filter(row => !facts.productId || row.productId === facts.productId)
            .map(row => row.assetId)
        if (assetIds.length) issuances = Array.from(find(ISSUANCE).condition("assetId", "in", assetIds.slice(0, 500)).list())
    } else if (facts.orderId && facts.productId) issuances = rows(ISSUANCE, {orderId: facts.orderId, productId: facts.productId})
    const candidates = issuances.filter(row => row.orderId && row.issuedDate).sort((a, b) => ms(b.issuedDate) - ms(a.issuedDate))
    for (const issuance of candidates) {
        const sale = salePartOf(issuance.orderId, issuance.orderItemSeqId)
        if (!sale) continue
        if (facts.organizationPartyId && sale.part.vendorPartyId !== facts.organizationPartyId) continue
        if (facts.customerPartyId && sale.part.customerPartyId !== facts.customerPartyId) {
            if (serial) return null
            continue
        }
        return {
            issuance,
            assetId: issuance.assetId || null,
            orderId: issuance.orderId,
            orderItemSeqId: issuance.orderItemSeqId || null,
            shipmentId: issuance.shipmentId || null,
            productId: issuance.productId || sale.item?.productId || null,
            vendorPartyId: sale.part.vendorPartyId,
            customerPartyId: sale.part.customerPartyId,
            shipMs: Number(ms(issuance.issuedDate))
        }
    }
    return null
}
// The product's warranty feature in effect at a date (a PftWarranty ProductFeatureAppl not merely selectable), with its term.
function productWarrantyOf(productId, atMs) {
    if (!productId) return null
    const appls = Array.from(
        find("mantle.product.feature.ProductFeatureAppl", {productId})
            .conditionDate("fromDate", "thruDate", stamp(atMs ?? nowMs()))
            .list()
    ).filter(row => row.applTypeEnumId !== "PfatSelectable")
    for (const appl of appls) {
        const feature = one("mantle.product.feature.ProductFeature", {productFeatureId: appl.productFeatureId})
        if (feature?.productFeatureTypeEnumId !== warrantyFeature) continue
        return {
            productFeatureId: feature.productFeatureId,
            description: feature.description || feature.productFeatureId,
            quantity: feature.numberSpecified == null ? null : Number(String(feature.numberSpecified)),
            uomId: feature.numberUomId || null
        }
    }
    return null
}
// The organization's service agreements with the customer that cover the product with a warranty term (TtWarranty on an item
// of the product, or on no item), each with its term and end; the ones in effect at the date first.
function agreementTermsOf(organizationPartyId, customerPartyId, productId, atMs) {
    if (!organizationPartyId || !customerPartyId) return []
    const found = []
    for (const agreement of rows(AGREEMENT, {
        agreementTypeEnumId: serviceAgreementType,
        organizationPartyId,
        otherPartyId: customerPartyId
    })) {
        if (agreement.statusId && !["AgmStActive", "AgmStExpired", "AgmStClosed"].includes(agreement.statusId)) continue
        for (const term of rows(TERM, {agreementId: agreement.agreementId, termTypeEnumId: warrantyTerm})) {
            const itemProduct = term.agreementItemSeqId
                ? one(AGREEMENT_ITEM, {agreementId: agreement.agreementId, agreementItemSeqId: term.agreementItemSeqId})
                      ?.productId
                : null
            if (itemProduct && itemProduct !== productId) continue
            const fromMs = Math.max(ms(agreement.fromDate) ?? -Infinity, ms(term.fromDate) ?? -Infinity)
            const thruMs = Math.min(ms(agreement.thruDate) ?? Infinity, ms(term.thruDate) ?? Infinity)
            const inEffect = (!agreement.statusId || agreement.statusId === "AgmStActive") && fromMs <= atMs && thruMs > atMs
            found.push({agreement, term, fromMs, thruMs: thruMs === Infinity ? null : thruMs, inEffect})
        }
    }
    return found.sort((a, b) => Number(b.inEffect) - Number(a.inEffect) || (b.thruMs ?? Infinity) - (a.thruMs ?? Infinity))
}
const agreementLabel = agreement =>
    "Service agreement " + agreement.agreementId + (agreement.description ? " (" + agreement.description + ")" : "")

// ===== the coverage =====
// The coverage of a serial, lot or product for a customer of an organization at a date (the claim's), by §4's hierarchy: the
// agreement first, then the product's warranty at sale, else none (goodwill only). Each step is in the trace.
function coverageOf(facts) {
    const asOfMs = facts.asOfMs ?? nowMs()
    const zone = zoneOf(facts.organizationPartyId)
    const day = millis => dayText(millis, zone)
    const asset = facts.assetId ? one(ASSET, {assetId: facts.assetId}) : null
    const sale = traceSale({
        assetId: facts.assetId,
        lotId: asset ? null : facts.lotId,
        orderId: facts.orderId,
        productId: facts.productId || asset?.productId,
        organizationPartyId: facts.organizationPartyId,
        customerPartyId: facts.customerPartyId
    })
    const productId = facts.productId || asset?.productId || sale?.productId || null
    const trace = []
    const result = {
        asOfDate: stamp(asOfMs),
        asOfText: day(asOfMs),
        productId,
        productText: productText(productId),
        assetId: asset?.assetId || null,
        serialNumber: asset?.serialNumber || null,
        lotId: asset?.lotId || facts.lotId || null,
        identText: assetText(asset),
        saleOrderId: sale?.orderId || null,
        saleOrderItemSeqId: sale?.orderItemSeqId || null,
        shipmentId: sale?.shipmentId || null,
        shipDate: sale ? stamp(sale.shipMs) : null,
        shipText: sale ? day(sale.shipMs) : "",
        customerPartyId: sale?.customerPartyId || facts.customerPartyId || null,
        agreementId: null,
        agreementText: "",
        termText: "",
        termsSourceText: "",
        coverageStartDate: null,
        coverageStartText: "",
        coverageEndDate: null,
        coverageEndText: "",
        coverageEndSourceText: "",
        covered: false,
        trace
    }
    // 1. the agreement
    const terms = agreementTermsOf(facts.organizationPartyId, facts.customerPartyId, productId, asOfMs)
    const inEffect = terms.find(row => row.inEffect)
    if (inEffect) {
        Object.assign(result, {
            basisEnumId: "WcbAgreement",
            agreementId: inEffect.agreement.agreementId,
            agreementText: agreementLabel(inEffect.agreement),
            termText: inEffect.term.termText || "Warranty coverage",
            termsSourceText: agreementLabel(inEffect.agreement) + ", its warranty term",
            coverageStartDate: Number.isFinite(inEffect.fromMs) ? stamp(inEffect.fromMs) : null,
            coverageStartText: Number.isFinite(inEffect.fromMs) ? day(inEffect.fromMs) : "",
            coverageEndDate: stamp(inEffect.thruMs),
            coverageEndText: inEffect.thruMs == null ? "While the agreement is in effect" : day(inEffect.thruMs),
            coverageEndSourceText:
                inEffect.thruMs == null
                    ? agreementLabel(inEffect.agreement) + " has no end"
                    : "The end of " + agreementLabel(inEffect.agreement),
            covered: true
        })
        trace.push({step: "agreement", text: agreementLabel(inEffect.agreement) + " covers it on " + result.asOfText})
    } else if (terms.length)
        trace.push({
            step: "agreement",
            text:
                agreementLabel(terms[0].agreement) +
                (terms[0].thruMs != null && terms[0].thruMs <= asOfMs ? " ended " + day(terms[0].thruMs) : " is not in effect")
        })
    else trace.push({step: "agreement", text: "No service agreement with a warranty term covers it"})
    // 2. the product's warranty at sale
    const warranty = sale ? productWarrantyOf(productId, sale.shipMs) : null
    if (sale)
        trace.push({
            step: "sale",
            text:
                "Shipped " +
                day(sale.shipMs) +
                " on order " +
                sale.orderId +
                (sale.shipmentId ? ", shipment " + sale.shipmentId : "") +
                " to " +
                partyName(sale.customerPartyId)
        })
    else
        trace.push({
            step: "sale",
            text: asset || facts.lotId ? "No delivery of it to the customer was found" : "No serial, lot or order to trace"
        })
    const warrantyEndMs = warranty ? addTerm(sale.shipMs, warranty.quantity, warranty.uomId, zone) : null
    if (sale && warranty)
        trace.push({
            step: "term",
            text:
                warrantyEndMs == null
                    ? "The product's warranty " + warranty.description + " has no term in days, weeks, months or years"
                    : "The product's warranty " + warranty.description + ": " + termText(warranty.quantity, warranty.uomId)
        })
    else if (sale) trace.push({step: "term", text: "The product had no warranty when it was sold"})
    if (!inEffect && warranty && warrantyEndMs != null) {
        Object.assign(result, {
            basisEnumId: "WcbProductWarranty",
            termText: termText(warranty.quantity, warranty.uomId) + " from shipment",
            termsSourceText: "Product warranty " + warranty.description + " (" + warranty.productFeatureId + ")",
            coverageStartDate: stamp(sale.shipMs),
            coverageStartText: day(sale.shipMs),
            coverageEndDate: stamp(warrantyEndMs),
            coverageEndText: day(warrantyEndMs),
            coverageEndSourceText:
                "Shipped " +
                day(sale.shipMs) +
                " (order " +
                sale.orderId +
                ") plus " +
                termText(warranty.quantity, warranty.uomId) +
                " of " +
                warranty.description,
            covered: asOfMs < warrantyEndMs
        })
        trace.push({
            step: "end",
            text: result.covered
                ? "Covered until " + result.coverageEndText
                : "The warranty ended " + result.coverageEndText + ", before the claim of " + result.asOfText
        })
    } else if (!inEffect) {
        Object.assign(result, {basisEnumId: "WcbNone", coverageEndSourceText: "No agreement or product warranty was found"})
        trace.push({step: "end", text: "Not covered: only goodwill can cover it"})
    }
    result.basisText = enumText(result.basisEnumId)
    return result
}
// The coverage of a claim at its date.
function claimCoverage(theCase, evidence) {
    return coverageOf({
        organizationPartyId: theCase.organizationPartyId,
        customerPartyId: theCase.customerPartyId,
        productId: evidence.productId,
        assetId: evidence.assetId,
        orderId: evidence.orderId,
        asOfMs: Number(ms(theCase.request.requestDate || theCase.request.lastUpdatedStamp) || nowMs())
    })
}

// ===== the evidence's checks =====
// An asset of the claim: of the case's organization (its facility's owner, or the vendor of the sale it was issued on) and of
// its customer (its owner, or the customer of that sale). Customer-owned equipment stays the customer's: nothing here changes
// its owner or status. A missing asset and another's are refused alike (ASSET_UNAVAILABLE).
function assetOf(theCase, assetId) {
    const asset = blank(assetId) ? null : one(ASSET, {assetId})
    const unavailable = () =>
        denied("ASSET_UNAVAILABLE", "Serial or asset " + (assetId || "") + " is not available on this claim")
    if (!asset) unavailable()
    // its latest sale by the organization decides whose it is (a serial sold again is the later customer's, on the asset of
    // that sale); without one, the facility's owner and the asset's owner (customer-owned equipment)
    const sale = traceSale({assetId: asset.assetId, organizationPartyId: theCase.organizationPartyId})
    const current = sale?.assetId && sale.assetId !== asset.assetId ? one(ASSET, {assetId: sale.assetId}) || asset : asset
    const facilityOwner = current.facilityId ? one(FACILITY, {facilityId: current.facilityId})?.ownerPartyId : null
    const ours = sale ? sale.vendorPartyId === theCase.organizationPartyId : facilityOwner === theCase.organizationPartyId
    const theirs =
        !!theCase.customerPartyId &&
        (sale ? sale.customerPartyId === theCase.customerPartyId : current.ownerPartyId === theCase.customerPartyId)
    if (!ours || !theirs) unavailable()
    return {asset: current, sale}
}
// A serial number of the customer's: the asset by its serial (and product, when given) that the claim's checks pass.
function assetBySerial(theCase, serialNumber, productId) {
    const candidates = rows(ASSET, productId ? {serialNumber, productId} : {serialNumber})
    for (const candidate of candidates) {
        try {
            return assetOf(theCase, candidate.assetId)
        } catch (error) {
            if (lib.reasonCode(error) !== "ASSET_UNAVAILABLE") throw error
        }
    }
    denied("ASSET_UNAVAILABLE", "No delivered serial " + serialNumber + " of this customer was found")
}
function checkOrder(theCase, orderId) {
    const parts = rows(PART, {orderId})
    const ok =
        parts.length > 0 &&
        parts.every(
            part => part.vendorPartyId === theCase.organizationPartyId && part.customerPartyId === theCase.customerPartyId
        )
    if (!ok) denied("ORDER_UNAVAILABLE", "Order " + orderId + " is not a sale of this organization to this customer")
}
function checkInvoice(theCase, invoiceId) {
    const invoice = one(INVOICE, {invoiceId})
    if (!invoice || invoice.fromPartyId !== theCase.organizationPartyId || invoice.toPartyId !== theCase.customerPartyId)
        denied("INVOICE_UNAVAILABLE", "Invoice " + invoiceId + " is not one of this organization to this customer")
}
function checkAgreement(theCase, agreementId) {
    const agreement = one(AGREEMENT, {agreementId})
    if (
        !agreement ||
        agreement.agreementTypeEnumId !== serviceAgreementType ||
        agreement.organizationPartyId !== theCase.organizationPartyId ||
        agreement.otherPartyId !== theCase.customerPartyId
    )
        denied("AGREEMENT_UNAVAILABLE", "Agreement " + agreementId + " is not a service agreement with this customer")
}
// The invoice of an order line, when it was billed (OrderItemBilling).
const invoiceOfLine = (orderId, orderItemSeqId) =>
    orderId && orderItemSeqId ? rows(BILLING, {orderId, orderItemSeqId}).find(row => row.invoiceId)?.invoiceId || null : null

// The claim's RequestRecord links, written here after this module's own checks of the record's organization and customer
// (RequestServices.link#RequestRecord asks the user's record visibility, which keeps an invoice from an agent who reads no
// finance records, though the invoice is evidence of the sale)
function linkRecord(requestId, recordEntityName, recordId) {
    if (one(RECORD, {requestId, recordEntityName, recordId})) return
    call("create#" + RECORD, {requestId, recordEntityName, recordId, linkedByUserId: ec.user.userId, linkedDate: now()})
}
function unlinkRecord(requestId, recordEntityName, recordId) {
    if (one(RECORD, {requestId, recordEntityName, recordId})) call("delete#" + RECORD, {requestId, recordEntityName, recordId})
}

// ===== save#WarrantyClaim =====
function save(p) {
    requirePermission("SUPPORT_CASE_EDIT")
    const organizationPartyId = blank(p.requestId) ? cases().requireOrganization(p.organizationPartyId) : null
    const operation = !blank(p.operationKey)
        ? lib.operation(p, "WarrantyClaimSave", organizationPartyId || claimOf(p.requestId, {claim: false}).organizationPartyId, {
              requestId: p.requestId || null,
              customerPartyId: p.customerPartyId || null,
              productId: p.productId || null,
              assetId: p.assetId || null,
              serialNumber: p.serialNumber || null,
              orderId: p.orderId || null,
              invoiceId: p.invoiceId || null,
              agreementId: p.agreementId || null,
              faultText: p.faultText || null
          })
        : null
    if (operation?.old) return lib.previous(operation)
    let requestId = text(p.requestId)
    let created = false
    if (!requestId) {
        // a new claim: its case through create#Case (the queue, template and assignment rules apply)
        requestId = call("mantle.request.SupportCaseServices.create#Case", {
            organizationPartyId,
            customerPartyId: p.customerPartyId,
            contactPartyId: p.contactPartyId || null,
            requestTypeEnumId: claimType,
            requestCategoryId: p.requestCategoryId || null,
            requestName:
                text(p.requestName) || "Warranty claim" + (text(p.serialNumber) ? " · serial " + text(p.serialNumber) : ""),
            description: p.description || null,
            priority: p.priority || null,
            salesChannelEnumId: p.salesChannelEnumId || null,
            assigneePartyId: p.assigneePartyId || null,
            templateFormId: p.templateFormId || null,
            templateValues: p.templateValues || null
        }).requestId
        created = true
    }
    const theCase = claimOf(requestId, {lock: true, claim: false})
    cases().refuseMerged(theCase)
    if (closedStatuses.includes(theCase.request.statusId)) denied("CASE_CLOSED", "Case " + theCase.requestId + " is closed")
    if (!theCase.customerPartyId) denied("CUSTOMER_REQUIRED", "Case " + theCase.requestId + " has no customer")
    if (!blank(p.claimRevision) && number(p.claimRevision) !== theCase.claimRevision)
        denied(
            "STALE_REVISION",
            "Claim " + theCase.requestId + " is at revision " + theCase.claimRevision + " now; review it again"
        )
    const evidence = evidenceOf(theCase.requestId)
    // the asset, by id or serial, and what its sale gives
    let found = null
    if (!blank(p.assetId)) found = assetOf(theCase, p.assetId)
    else if (!blank(p.serialNumber)) found = assetBySerial(theCase, text(p.serialNumber), text(p.productId))
    const next = {
        assetId: found ? found.asset.assetId : evidence.assetId,
        productId: text(p.productId) || found?.asset.productId || evidence.productId,
        orderId: text(p.orderId) || (found ? found.sale?.orderId : null) || evidence.orderId,
        invoiceId: text(p.invoiceId) || null,
        agreementId: p.agreementId === undefined ? evidence.agreementId : text(p.agreementId),
        quantity: Number(String(blank(p.quantity) ? (evidence.quantity ?? 1) : p.quantity)),
        faultText: p.faultText === undefined ? evidence.faultText : text(p.faultText) || ""
    }
    if (next.productId && !one(PRODUCT, {productId: next.productId}))
        denied("PRODUCT_UNAVAILABLE", "Product " + next.productId + " is not available")
    if (found && next.productId && found.asset.productId && found.asset.productId !== next.productId)
        denied("ASSET_PRODUCT_MISMATCH", "Serial " + assetText(found.asset) + " is not of product " + productText(next.productId))
    if (!(next.quantity > 0)) denied("QUANTITY_INVALID", "A claim's quantity is above zero")
    if (next.orderId) checkOrder(theCase, next.orderId)
    if (!next.invoiceId)
        next.invoiceId =
            found?.sale && found.sale.orderId === next.orderId
                ? invoiceOfLine(found.sale.orderId, found.sale.orderItemSeqId)
                : evidence.invoiceId
    if (next.invoiceId) checkInvoice(theCase, next.invoiceId)
    if (next.agreementId) checkAgreement(theCase, next.agreementId)
    // write the evidence that changed
    let changed = false
    if (!theCase.isClaim) {
        call("update#" + REQUEST, {requestId: theCase.requestId, requestTypeEnumId: claimType})
        changed = true
    }
    if (next.productId) {
        const itemValues = {productId: next.productId, quantity: next.quantity, description: next.faultText || null}
        if (evidence.item) {
            const differs =
                evidence.item.productId !== itemValues.productId ||
                number(evidence.item.quantity) !== itemValues.quantity ||
                (evidence.item.description || "") !== (itemValues.description || "")
            if (differs) {
                call(
                    "update#" + ITEM,
                    Object.assign({requestId: theCase.requestId, requestItemSeqId: evidence.item.requestItemSeqId}, itemValues)
                )
                changed = true
            }
        } else {
            call("create#" + ITEM, Object.assign({requestId: theCase.requestId, requestItemSeqId: "01"}, itemValues))
            changed = true
        }
    }
    for (const [field, entity] of Object.entries(evidenceKinds)) {
        if ((next[field] || null) === (evidence[field] || null)) continue
        if (evidence[field]) unlinkRecord(theCase.requestId, entity, evidence[field])
        if (next[field]) linkRecord(theCase.requestId, entity, next[field])
        changed = true
    }
    let claimRevision = theCase.claimRevision
    if (changed) {
        claimRevision = theCase.claimRevision + 1
        call("update#" + REQUEST, {requestId: theCase.requestId, claimRevision})
        // the decisions made before no longer count
        for (const row of rows(DECISION, {requestId: theCase.requestId}).filter(row => !row.supersededDate))
            call("update#" + DECISION, {warrantyDecisionId: row.warrantyDecisionId, supersededDate: now()})
    }
    const result = {requestId: theCase.requestId, claimRevision, changed, created}
    if (operation) lib.complete(operation, REQUEST, theCase.requestId, result)
    return result
}

// ===== get#WarrantyCoverage =====
// The coverage of a claim (requestId), or of a serial, lot or product of a customer of one of the user's organizations.
function coverage(p) {
    requireRead()
    if (!blank(p.requestId)) {
        const theCase = claimOf(p.requestId)
        return {coverage: claimCoverage(theCase, evidenceOf(theCase.requestId))}
    }
    const organizationPartyId = cases().requireOrganization(p.organizationPartyId)
    if (!cases().servedCustomer(p.customerPartyId, organizationPartyId))
        denied("CUSTOMER_UNAVAILABLE", "Customer " + (p.customerPartyId || "") + " is not available")
    if (blank(p.assetId) && blank(p.lotId) && blank(p.productId))
        denied("EVIDENCE_REQUIRED", "Name the serial, lot or product to look up")
    if (!blank(p.assetId)) assetOf({organizationPartyId, customerPartyId: p.customerPartyId}, p.assetId)
    return {
        coverage: coverageOf({
            organizationPartyId,
            customerPartyId: p.customerPartyId,
            productId: text(p.productId),
            assetId: text(p.assetId),
            lotId: text(p.lotId),
            orderId: text(p.orderId),
            asOfMs: p.asOfDate ? Number(ms(p.asOfDate)) : nowMs()
        })
    }
}

// ===== decide#WarrantyClaim =====
function decide(p) {
    requirePermission("SUPPORT_CASE_EDIT")
    const theCase = claimOf(p.requestId, {lock: true})
    cases().refuseMerged(theCase)
    if (closedStatuses.includes(theCase.request.statusId)) denied("CASE_CLOSED", "Case " + theCase.requestId + " is closed")
    if (blank(p.claimRevision)) denied("REVISION_REQUIRED", "Name the claim's revision you decide")
    if (number(p.claimRevision) !== theCase.claimRevision)
        denied(
            "STALE_REVISION",
            "Claim " + theCase.requestId + " is at revision " + theCase.claimRevision + " now; review it again"
        )
    const decisionEnumId = text(p.decisionEnumId)
    if (!decisions.includes(decisionEnumId || ""))
        denied("DECISION_INVALID", "Choose covered, partly covered, rejected or goodwill")
    const operation = !blank(p.operationKey)
        ? lib.operation(p, "WarrantyDecide", theCase.organizationPartyId, {
              requestId: theCase.requestId,
              claimRevision: theCase.claimRevision,
              decisionEnumId,
              overrideCoverageEndDate: p.overrideCoverageEndDate ? String(ms(p.overrideCoverageEndDate)) : null,
              chargeEstimate: p.chargeEstimate == null ? null : String(p.chargeEstimate),
              customerConsentRef: p.customerConsentRef || null,
              reason: p.reason || null
          })
        : null
    if (operation?.old) return lib.previous(operation)
    const evidence = evidenceOf(theCase.requestId)
    if (!evidence.productId && !evidence.assetId) denied("EVIDENCE_REQUIRED", "Record the product or serial before deciding")
    const found = claimCoverage(theCase, evidence)
    const reason = text(p.reason)
    // a manual coverage end needs its reason; covering what the lookup found ended is a rejection override (WARRANTY_APPROVE)
    const overrideMs = p.overrideCoverageEndDate ? Number(ms(p.overrideCoverageEndDate)) : null
    const overrideReason = text(p.overrideReason)
    if (overrideMs != null && !overrideReason) denied("OVERRIDE_REASON_REQUIRED", "Give the reason for the coverage end you set")
    const asOfMs = Number(ms(found.asOfDate))
    const covered = overrideMs != null ? asOfMs < overrideMs : found.covered
    const covering = decisionEnumId === "WdCovered" || decisionEnumId === "WdPartial"
    if (covering && !covered)
        denied(
            "NOT_COVERED",
            "The coverage " +
                (found.coverageEndText ? "ended " + found.coverageEndText : "was not found") +
                ": reject the claim, approve it as goodwill, or set the coverage end with a reason"
        )
    const overriding = covering && overrideMs != null && !found.covered
    if ((decisionEnumId === "WdGoodwill" || overriding) && !has("WARRANTY_APPROVE"))
        denied(
            "PERMISSION_DENIED",
            "WARRANTY_APPROVE is required to " + (overriding ? "cover a claim the lookup found expired" : "approve goodwill")
        )
    if (decisionEnumId !== "WdCovered" && !reason) denied("REASON_REQUIRED", "Give the reason for the decision")
    // a chargeable repair: the estimate in its currency (the organization's when not given), and later the customer's consent
    let chargeEstimate = null,
        chargeCurrencyUomId = null
    if (!blank(p.chargeEstimate)) {
        if (decisionEnumId === "WdCovered" || decisionEnumId === "WdGoodwill")
            denied("CHARGE_NOT_ALLOWED", "A covered or goodwill repair is not charged")
        chargeEstimate = toDecimal(String(p.chargeEstimate))
        if (chargeEstimate.compare(toDecimal("0")) < 0) denied("CHARGE_INVALID", "A charge estimate is not below zero")
        chargeCurrencyUomId =
            text(p.chargeCurrencyUomId) ||
            call("mantle.ledger.LedgerServices.find#PartyAcctgPreference", {organizationPartyId: theCase.organizationPartyId})
                .partyAcctgPreference?.baseCurrencyUomId ||
            null
        if (!chargeCurrencyUomId) denied("CURRENCY_REQUIRED", "Choose the currency of the charge estimate")
        chargeEstimate = lib.money(chargeEstimate, chargeCurrencyUomId)
    }
    for (const row of rows(DECISION, {requestId: theCase.requestId}).filter(row => !row.supersededDate))
        call("update#" + DECISION, {warrantyDecisionId: row.warrantyDecisionId, supersededDate: now()})
    const decidedByPartyId = ec.user.userAccount?.partyId || null
    const out = call("create#" + DECISION, {
        requestId: theCase.requestId,
        sourceRevision: theCase.claimRevision,
        organizationPartyId: theCase.organizationPartyId,
        decisionEnumId,
        coverageBasisEnumId: found.basisEnumId,
        termsText: text(p.termsText) || found.termText || null,
        termsSourceText: found.termsSourceText || null,
        agreementId: found.agreementId || null,
        coverageEndDate: overrideMs != null ? stamp(overrideMs) : found.coverageEndDate,
        coverageEndSourceText:
            overrideMs != null
                ? "Set by " + (partyName(decidedByPartyId) || ec.user.username) + ": " + overrideReason
                : found.coverageEndSourceText || null,
        overrideReason: overrideReason || null,
        reason: reason || null,
        decisionDate: now(),
        decidedByUserId: ec.user.userId,
        decidedByPartyId,
        approvedByUserId: decisionEnumId === "WdGoodwill" || overriding ? ec.user.userId : null,
        chargeEstimate,
        chargeCurrencyUomId,
        customerConsentRef: text(p.customerConsentRef),
        nextDueDate: p.nextDueDate || null
    })
    const result = {
        warrantyDecisionId: out.warrantyDecisionId,
        decisionEnumId,
        state: decisionEnumId === "WdRejected" ? "rejected" : "approved"
    }
    if (operation) lib.complete(operation, DECISION, out.warrantyDecisionId, result)
    return result
}

// ===== link#WarrantyWork, update#WarrantyWork =====
// A repair of the claim's serial: a new AssetMaintenance (MntTpWarranty) with its WepMaintenance task, or an open one of the
// asset, linked to the case. It needs a current decision that covers the claim (covered, partial, goodwill), or a chargeable
// repair the customer agreed to.
function linkWork(p) {
    requirePermission("SUPPORT_CASE_EDIT")
    const theCase = claimOf(p.requestId, {lock: true})
    cases().refuseMerged(theCase)
    if (closedStatuses.includes(theCase.request.statusId)) denied("CASE_CLOSED", "Case " + theCase.requestId + " is closed")
    const current = currentDecisionOf(theCase.requestId, theCase.claimRevision)
    if (!current) denied("NOT_DECIDED", "Decide claim " + theCase.requestId + " before its repair")
    const chargeable = current.chargeEstimate != null && toDecimal(String(current.chargeEstimate)).compare(toDecimal("0")) > 0
    if (!approvedDecisions.includes(current.decisionEnumId) && !chargeable)
        denied(
            "NOT_APPROVED",
            "Claim " + theCase.requestId + " was rejected; a repair needs a chargeable repair the customer agrees to"
        )
    if (chargeable && blank(current.customerConsentRef))
        denied("CONSENT_REQUIRED", "Record the customer's consent to the charge estimate first")
    const evidence = evidenceOf(theCase.requestId)
    if (!evidence.assetId)
        denied("ASSET_REQUIRED", "A repair is of the sold serial; record it first (a replacement goes through a return)")
    const {asset} = assetOf(theCase, evidence.assetId)
    const operation = !blank(p.operationKey)
        ? lib.operation(p, "WarrantyWorkLink", theCase.organizationPartyId, {
              requestId: theCase.requestId,
              assetMaintenanceId: p.assetMaintenanceId || null,
              comments: p.comments || null
          })
        : null
    if (operation?.old) return lib.previous(operation)
    let assetMaintenanceId = text(p.assetMaintenanceId)
    let taskWorkEffortId = null
    if (assetMaintenanceId) {
        const maintenance = one(MAINTENANCE, {assetMaintenanceId})
        if (!maintenance || maintenance.assetId !== asset.assetId || closedMaintenance.includes(maintenance.statusId))
            denied(
                "MAINTENANCE_UNAVAILABLE",
                "Maintenance " + assetMaintenanceId + " is not an open repair of " + assetText(asset)
            )
        taskWorkEffortId = maintenance.taskWorkEffortId || null
    } else {
        const requiredWork = text(p.comments)
        if (!requiredWork) denied("WORK_REQUIRED", "Describe the repair")
        if (!blank(p.assigneePartyId) && !cases().organizationsOf(p.assigneePartyId).includes(theCase.organizationPartyId))
            denied("ASSIGNEE_UNAVAILABLE", partyName(p.assigneePartyId) + " does not work for the organization")
        taskWorkEffortId = call("create#" + WORK, {
            workEffortTypeEnumId: "WetTask",
            purposeEnumId: "WepMaintenance",
            statusId: "WeApproved",
            workEffortName: ("Warranty repair of " + assetText(asset) + " · claim " + theCase.requestId).substring(0, 255),
            description: requiredWork,
            ownerPartyId: theCase.organizationPartyId,
            facilityId: text(p.facilityId) || asset.facilityId || null,
            estimatedCompletionDate: p.dueDate || null
        }).workEffortId
        if (!blank(p.assigneePartyId))
            call("create#mantle.work.effort.WorkEffortParty", {
                workEffortId: taskWorkEffortId,
                partyId: p.assigneePartyId,
                roleTypeId: "Assignee",
                fromDate: now()
            })
        assetMaintenanceId = call("mantle.product.EquipmentServices.create#AssetMaintenance", {
            assetId: asset.assetId,
            statusId: "AsMntCreated",
            maintenanceTypeEnumId: "MntTpWarranty",
            maintenanceDate: now(),
            taskWorkEffortId,
            comments: requiredWork
        }).assetMaintenanceId
    }
    linkRecord(theCase.requestId, MAINTENANCE, assetMaintenanceId)
    const result = {assetMaintenanceId, taskWorkEffortId}
    if (operation) lib.complete(operation, MAINTENANCE, assetMaintenanceId, result)
    return result
}
// The status steps from one maintenance status to another (the Default flow), and the task's status for each.
const maintenanceSteps = {
    AsMntInProcess: {AsMntCreated: ["AsMntInProcess"], AsMntScheduled: ["AsMntInProcess"]},
    AsMntCompleted: {
        AsMntCreated: ["AsMntInProcess", "AsMntCompleted"],
        AsMntScheduled: ["AsMntInProcess", "AsMntCompleted"],
        AsMntInProcess: ["AsMntCompleted"]
    },
    AsMntCancelled: {AsMntCreated: ["AsMntCancelled"], AsMntScheduled: ["AsMntCancelled"]}
}
const taskStatuses = {AsMntInProcess: "WeInProgress", AsMntCompleted: "WeComplete", AsMntCancelled: "WeCancelled"}
function updateWork(p) {
    requirePermission("SUPPORT_CASE_EDIT")
    const theCase = claimOf(p.requestId)
    const evidence = evidenceOf(theCase.requestId)
    const assetMaintenanceId = text(p.assetMaintenanceId)
    const maintenance = assetMaintenanceId ? one(MAINTENANCE, {assetMaintenanceId}) : null
    if (!maintenance || !evidence.maintenanceIds.includes(assetMaintenanceId))
        denied("MAINTENANCE_UNAVAILABLE", "Maintenance " + (assetMaintenanceId || "") + " is not a repair of this claim")
    assetOf(theCase, maintenance.assetId)
    const steps = maintenanceSteps[p.statusId]?.[maintenance.statusId]
    if (!steps)
        denied(
            "STATUS_INVALID",
            "The repair is " + statusText(maintenance.statusId) + " and cannot become " + (statusText(p.statusId) || "that")
        )
    const result = text(p.comments)
    for (const statusId of steps)
        call("update#" + MAINTENANCE, {
            assetMaintenanceId,
            statusId,
            comments:
                statusId === steps[steps.length - 1] && result
                    ? [maintenance.comments, result].filter(Boolean).join("\n")
                    : maintenance.comments
        })
    const task = maintenance.taskWorkEffortId ? one(WORK, {workEffortId: maintenance.taskWorkEffortId}) : null
    const taskStatus = taskStatuses[p.statusId]
    if (task && task.statusId !== taskStatus && !["WeComplete", "WeClosed", "WeCancelled"].includes(task.statusId)) {
        try {
            call("update#" + WORK, {
                workEffortId: task.workEffortId,
                statusId: taskStatus,
                actualCompletionDate: p.statusId === "AsMntCompleted" ? now() : null
            })
        } catch (error) {
            ec.logger.error("Warranty repair task " + task.workEffortId + " was not moved: " + error.message)
            ec.message.clearErrors()
        }
    }
    return {statusId: p.statusId}
}

// ===== notify#WarrantyWorkFinished =====
// A repair finished: each open warranty claim linked to it tells its assignee, else the agent who linked it; the case is left
// as it is. A failure is logged and never fails the update that finished the repair.
function notifyFinished(p) {
    let sent = 0
    ec.message.pushErrors()
    try {
        const maintenance = one(MAINTENANCE, {assetMaintenanceId: p.assetMaintenanceId})
        if (!maintenance) return {sentCount: 0}
        const asset = maintenance.assetId ? one(ASSET, {assetId: maintenance.assetId}) : null
        for (const link of rows(RECORD, {recordEntityName: MAINTENANCE, recordId: p.assetMaintenanceId})) {
            const request = one(REQUEST, {requestId: link.requestId})
            if (!request || request.requestTypeEnumId !== claimType) continue
            if (!one("mantle.request.support.CaseProfile", {requestId: link.requestId})) continue
            const parties = rows(REQUEST_PARTY, {requestId: link.requestId}).filter(row => lib.active(row))
            const assigneePartyId = parties.find(row => row.roleTypeId === "Assignee")?.partyId || null
            const customerPartyId = parties.find(row => row.roleTypeId === "Customer")?.partyId || null
            let userIds = assigneePartyId
                ? rows("moqui.security.UserAccount", {partyId: assigneePartyId})
                      .filter(row => row.disabled !== "Y")
                      .map(row => row.userId)
                : []
            if (!userIds.length && link.linkedByUserId) userIds = [link.linkedByUserId]
            if (!userIds.length) continue
            ec.makeNotificationMessage()
                .topic(topic)
                .message({
                    requestId: link.requestId,
                    requestName: request.requestName || link.requestId,
                    customerName: partyName(customerPartyId),
                    assetText: assetText(asset) || p.assetMaintenanceId,
                    assetMaintenanceId: p.assetMaintenanceId
                })
                .record(REQUEST, link.requestId)
                .userIds(userIds)
                .send()
            sent += userIds.length
        }
    } catch (error) {
        ec.logger.error("Warranty repair " + p.assetMaintenanceId + ": the finished notice was not sent: " + error.message)
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
    return {sentCount: sent}
}

// ===== store#ServiceAgreement =====
// A customer's service agreement (AgrService) with its warranty term (TtWarranty), for the agreement-first coverage (F50, F101):
// made Active from its date, or changed; its term's text, and an item for the product it covers (none: every product).
function storeAgreement(p) {
    requirePermission("SUPPORT_POLICY_EDIT")
    const organizationPartyId = cases().requireOrganization(p.organizationPartyId)
    if (!cases().servedCustomer(p.customerPartyId, organizationPartyId))
        denied("CUSTOMER_UNAVAILABLE", "Customer " + (p.customerPartyId || "") + " is not available")
    const termsText = text(p.warrantyTermsText)
    if (!termsText) denied("TERMS_REQUIRED", "Give the agreement's warranty terms")
    const productId = text(p.productId)
    if (productId && !one(PRODUCT, {productId})) denied("PRODUCT_UNAVAILABLE", "Product " + productId + " is not available")
    const statusId = text(p.statusId) || "AgmStActive"
    if (!["AgmStDraft", "AgmStActive", "AgmStClosed", "AgmStCancelled"].includes(statusId))
        denied("STATUS_INVALID", "An agreement is draft, active, closed or cancelled")
    const fromDate = p.fromDate || now()
    if (p.thruDate && ms(p.thruDate) <= ms(fromDate)) denied("DATES_INVALID", "The agreement ends after it starts")
    let agreementId = text(p.agreementId)
    if (agreementId) {
        const existing = one(AGREEMENT, {agreementId})
        if (
            !existing ||
            existing.agreementTypeEnumId !== serviceAgreementType ||
            existing.organizationPartyId !== organizationPartyId ||
            existing.otherPartyId !== p.customerPartyId
        )
            denied("AGREEMENT_UNAVAILABLE", "Agreement " + agreementId + " is not a service agreement with this customer")
        call("update#" + AGREEMENT, {
            agreementId,
            description: text(p.description) ?? existing.description,
            fromDate,
            thruDate: p.thruDate || null,
            statusId
        })
    } else
        agreementId = call("create#" + AGREEMENT, {
            agreementTypeEnumId: serviceAgreementType,
            organizationPartyId,
            organizationRoleTypeId: "OrgInternal",
            otherPartyId: p.customerPartyId,
            otherRoleTypeId: "Customer",
            agreementDate: now(),
            fromDate,
            thruDate: p.thruDate || null,
            description: text(p.description),
            statusId
        }).agreementId
    let agreementItemSeqId = null
    if (productId) {
        const items = rows(AGREEMENT_ITEM, {agreementId})
        const item = items.find(row => row.productId === productId)
        if (item) agreementItemSeqId = item.agreementItemSeqId
        else {
            agreementItemSeqId = String(items.length + 1).padStart(2, "0")
            call("create#" + AGREEMENT_ITEM, {
                agreementId,
                agreementItemSeqId,
                agreementItemTypeEnumId: "AitSection",
                productId,
                itemText: "Warranty coverage"
            })
        }
    }
    const term = rows(TERM, {agreementId, termTypeEnumId: warrantyTerm}).find(
        row => (row.agreementItemSeqId || null) === agreementItemSeqId
    )
    if (term) call("update#" + TERM, {agreementTermId: term.agreementTermId, termText: termsText})
    else
        call("create#" + TERM, {
            agreementId,
            agreementItemSeqId,
            termTypeEnumId: warrantyTerm,
            termText: termsText,
            fromDate
        })
    return {agreementId}
}

// ===== reads =====
// A decision for the screens: its outcome, coverage, who decided and approved, the charge and the consent.
function decisionRow(row, revision) {
    const current = !row.supersededDate && number(row.sourceRevision) === revision
    return {
        warrantyDecisionId: row.warrantyDecisionId,
        decisionEnumId: row.decisionEnumId,
        decisionText: enumText(row.decisionEnumId),
        basisText: enumText(row.coverageBasisEnumId),
        termsText: row.termsText || "",
        termsSourceText: row.termsSourceText || "",
        coverageEndText: row.coverageEndDate ? dayText(ms(row.coverageEndDate), zoneOf(row.organizationPartyId)) : "",
        coverageEndSourceText: row.coverageEndSourceText || "",
        overrideReason: row.overrideReason || "",
        reason: row.reason || "",
        decidedText: lib.dateText(row.decisionDate),
        decidedByName: partyName(row.decidedByPartyId) || row.decidedByUserId || "",
        approverName: row.approvedByUserId
            ? partyName(one("moqui.security.UserAccount", {userId: row.approvedByUserId})?.partyId) || row.approvedByUserId
            : "",
        chargeEstimate: row.chargeEstimate == null ? null : String(row.chargeEstimate),
        chargeCurrencyUomId: row.chargeCurrencyUomId || null,
        chargeText:
            row.chargeEstimate != null && row.chargeCurrencyUomId
                ? ec.l10n.formatCurrency(row.chargeEstimate, row.chargeCurrencyUomId)
                : "",
        customerConsentRef: row.customerConsentRef || "",
        nextDueText: row.nextDueDate ? lib.dateText(row.nextDueDate) : "",
        sourceRevision: number(row.sourceRevision),
        current,
        currentText: current ? "Current" : row.supersededDate ? "Superseded" : "Earlier revision"
    }
}
// The repairs a claim links, with their task.
function repairRows(evidence) {
    if (!evidence.maintenanceIds.length) return []
    return Array.from(find(MAINTENANCE).condition("assetMaintenanceId", "in", evidence.maintenanceIds).list())
        .sort((a, b) => ms(b.maintenanceDate) - ms(a.maintenanceDate))
        .map(row => {
            const task = row.taskWorkEffortId ? one(WORK, {workEffortId: row.taskWorkEffortId}) : null
            const assignee = task
                ? rows("mantle.work.effort.WorkEffortParty", {workEffortId: task.workEffortId, roleTypeId: "Assignee"}).find(r =>
                      lib.active(r)
                  )?.partyId
                : null
            return {
                assetMaintenanceId: row.assetMaintenanceId,
                statusId: row.statusId,
                statusText: statusText(row.statusId),
                open: !closedMaintenance.includes(row.statusId),
                comments: row.comments || "",
                startedText: lib.dateText(row.maintenanceDate),
                taskWorkEffortId: task?.workEffortId || null,
                taskName: task?.workEffortName || "",
                taskStatusText: task ? statusText(task.statusId) : "",
                facilityId: task?.facilityId || null,
                dueText: task?.estimatedCompletionDate ? lib.dateText(task.estimatedCompletionDate) : "",
                assigneeName: partyName(assignee)
            }
        })
}
function get(p) {
    requireRead()
    const theCase = claimOf(p.requestId, {claim: false})
    const evidence = evidenceOf(theCase.requestId)
    const current = theCase.isClaim ? currentDecisionOf(theCase.requestId, theCase.claimRevision) : null
    const state = stateOf(theCase.request, evidence, current)
    const covered = theCase.isClaim || evidence.productId || evidence.assetId ? claimCoverage(theCase, evidence) : null
    const asset = evidence.assetId ? one(ASSET, {assetId: evidence.assetId}) : null
    const open = !closedStatuses.includes(theCase.request.statusId)
    const edit = has("SUPPORT_CASE_EDIT")
    const chargeable = current?.chargeEstimate != null && toDecimal(String(current.chargeEstimate)).compare(toDecimal("0")) > 0
    const workReason = !current
        ? "Decide the claim first"
        : !approvedDecisions.includes(current.decisionEnumId) && !chargeable
          ? "The claim was rejected"
          : chargeable && !current.customerConsentRef
            ? "Record the customer's consent to the charge first"
            : !evidence.assetId
              ? "Record the serial first; a replacement goes through a return"
              : ""
    return {
        claim: {
            requestId: theCase.requestId,
            requestName: theCase.request.requestName || theCase.requestId,
            description: theCase.request.description || "",
            isClaim: theCase.isClaim,
            statusId: theCase.request.statusId,
            statusText: statusText(theCase.request.statusId),
            organizationPartyId: theCase.organizationPartyId,
            organizationName: partyName(theCase.organizationPartyId),
            customerPartyId: theCase.customerPartyId,
            customerName: partyName(theCase.customerPartyId),
            assigneeName: partyName(theCase.assigneePartyId),
            claimDateText: lib.dateText(theCase.request.requestDate),
            claimRevision: theCase.claimRevision,
            state,
            stateText: stateTexts[state],
            productId: evidence.productId,
            productText: productText(evidence.productId),
            quantity: evidence.quantity == null ? null : Number(String(evidence.quantity)),
            faultText: evidence.faultText,
            assetId: evidence.assetId,
            assetText: assetText(asset),
            serialNumber: asset?.serialNumber || null,
            assetOwnerName: asset ? partyName(asset.ownerPartyId) : "",
            assetStatusText: asset ? statusText(asset.statusId) : "",
            orderId: evidence.orderId,
            invoiceId: evidence.invoiceId,
            agreementId: evidence.agreementId,
            returnIds: evidence.returnIds,
            priorClaims: priorClaimsOf(theCase.requestId, evidence.assetId)
        },
        coverage: covered,
        decisions: decisionsOf(theCase.requestId).map(row => decisionRow(row, theCase.claimRevision)),
        currentDecision: current ? decisionRow(current, theCase.claimRevision) : null,
        repairs: repairRows(evidence),
        returns: evidence.returnIds.map(returnId => {
            const header = one(RETURN, {returnId})
            return {returnId, displayId: header?.displayId || returnId, statusText: statusText(header?.statusId)}
        }),
        actions: {
            save: edit && open,
            decide: edit && open && theCase.isClaim && !!(evidence.productId || evidence.assetId),
            approve: has("WARRANTY_APPROVE"),
            linkWork: edit && open && theCase.isClaim && !workReason,
            linkWorkReason: workReason,
            updateWork: edit
        }
    }
}
// The other warranty claims on the same serial (prior claims), newest first.
function priorClaimsOf(requestId, assetId) {
    if (!assetId) return []
    return rows(RECORD, {recordEntityName: ASSET, recordId: assetId})
        .filter(row => row.requestId !== requestId)
        .map(row => one(REQUEST, {requestId: row.requestId}))
        .filter(request => request?.requestTypeEnumId === claimType)
        .sort((a, b) => ms(b.requestDate) - ms(a.requestDate))
        .slice(0, 20)
        .map(request => ({
            requestId: request.requestId,
            requestName: request.requestName || request.requestId,
            statusText: statusText(request.statusId),
            claimDateText: lib.dateText(request.requestDate)
        }))
}
// find#WarrantyClaims: the user's organizations' claims, by customer, product, serial, order, agreement, state, assignee and
// period, and, when given, only those of the queues named or assigned to the party named (an app's own case scope).
function findClaims(p) {
    requireRead()
    const userScope = facilityScope.scope()
    let query = find(REQUEST, {requestTypeEnumId: claimType})
    if (p.fromDate) query = query.condition("requestDate", "greater-equals", p.fromDate)
    if (p.thruDate) query = query.condition("requestDate", "less", p.thruDate)
    const partyIds = (roleTypeId, ids) =>
        Array.from(
            find(REQUEST_PARTY, {roleTypeId}).condition("partyId", "in", ids).selectField("requestId").distinct(true).list()
        ).map(row => row.requestId)
    const recordIds = (entity, recordId) => rows(RECORD, {recordEntityName: entity, recordId}).map(row => row.requestId)
    let ids = null
    const narrow = list => (ids = ids == null ? list : ids.filter(id => list.includes(id)))
    if (userScope.organizationPartyIds) narrow(partyIds("OrgInternal", userScope.organizationPartyIds))
    if (!blank(p.organizationPartyId)) narrow(partyIds("OrgInternal", [p.organizationPartyId]))
    if (!blank(p.customerPartyId)) narrow(partyIds("Customer", [p.customerPartyId]))
    if (!blank(p.assigneePartyId)) narrow(partyIds("Assignee", [p.assigneePartyId]))
    if (!blank(p.orderId)) narrow(recordIds(ORDER, p.orderId))
    if (!blank(p.agreementId)) narrow(recordIds(AGREEMENT, p.agreementId))
    if (!blank(p.serialNumber)) {
        const assetIds = rows(ASSET, {serialNumber: String(p.serialNumber).trim()}).map(row => row.assetId)
        narrow(assetIds.flatMap(assetId => recordIds(ASSET, assetId)))
    }
    if (!blank(p.productId))
        narrow(
            Array.from(find(ITEM, {productId: p.productId}).selectField("requestId").distinct(true).list()).map(
                row => row.requestId
            )
        )
    if (ids != null) {
        if (!ids.length) return lib.pageList([], p, "claimList")
        query = query.condition("requestId", "in", ids.slice(0, 2000))
    }
    const queueIds = p.queueIds == null ? null : Array.from(p.queueIds).map(String)
    const rowsOut = []
    for (const request of Array.from(query.orderBy("-requestDate").limit(500).list())) {
        const parties = rows(REQUEST_PARTY, {requestId: request.requestId}).filter(row => lib.active(row))
        const roleOf = roleTypeId => parties.find(row => row.roleTypeId === roleTypeId)?.partyId || null
        const organizationPartyId = roleOf("OrgInternal")
        if (!organizationPartyId || !facilityScope.owns(userScope, organizationPartyId)) continue
        const assigneePartyId = roleOf("Assignee")
        if (
            queueIds &&
            !queueIds.includes(String(request.requestCategoryId || "")) &&
            !(p.visibleAssigneePartyId && assigneePartyId === p.visibleAssigneePartyId)
        )
            continue
        const evidence = evidenceOf(request.requestId)
        const revision = number(request.claimRevision)
        const current = currentDecisionOf(request.requestId, revision)
        const state = stateOf(request, evidence, current)
        if (!blank(p.state) && p.state !== state) continue
        const asset = evidence.assetId ? one(ASSET, {assetId: evidence.assetId}) : null
        let found = null
        try {
            found =
                evidence.productId || evidence.assetId
                    ? coverageOf({
                          organizationPartyId,
                          customerPartyId: roleOf("Customer"),
                          productId: evidence.productId,
                          assetId: evidence.assetId,
                          orderId: evidence.orderId,
                          asOfMs: Number(ms(request.requestDate) || nowMs())
                      })
                    : null
        } catch (error) {
            ec.logger.warn("Warranty claim " + request.requestId + ": coverage not read: " + error.message)
        }
        const repairs = repairRows(evidence)
        rowsOut.push({
            requestId: request.requestId,
            requestName: request.requestName || request.requestId,
            customerPartyId: roleOf("Customer"),
            customerName: partyName(roleOf("Customer")),
            productText: productText(evidence.productId),
            assetText: assetText(asset),
            orderId: evidence.orderId,
            coverageEndText: current?.coverageEndDate
                ? dayText(ms(current.coverageEndDate), zoneOf(organizationPartyId))
                : found?.coverageEndText || "",
            coverageText: found ? (found.covered ? "Covered" : "Not covered") + " · " + found.basisText : "",
            decisionText: current ? enumText(current.decisionEnumId) : "",
            approverName: current?.approvedByUserId
                ? partyName(one("moqui.security.UserAccount", {userId: current.approvedByUserId})?.partyId)
                : "",
            workText: repairs.length
                ? repairs.map(row => row.assetMaintenanceId + " " + row.statusText).join(", ")
                : evidence.returnIds.length
                  ? "Return " + evidence.returnIds.join(", ")
                  : "",
            nextActionText: {
                needsEvidence: "Record the product and serial",
                assessment: "Decide the coverage",
                approved: repairs.some(row => row.open)
                    ? "Follow the repair"
                    : repairs.length
                      ? "Tell the customer"
                      : "Start the repair or return",
                rejected: "Tell the customer",
                followUp: "Waiting for the customer",
                closed: ""
            }[state],
            assigneeName: partyName(assigneePartyId),
            claimDateText: lib.dateText(request.requestDate),
            state,
            stateText: stateTexts[state]
        })
    }
    return lib.pageList(rowsOut, p, "claimList")
}
// find#DeliveredItems: the serials and lots the user's organizations delivered to a customer (crosscut §3.2 DeliveredItems),
// newest first, each with its order, ship date, coverage end and its source, and an open claim on it.
function deliveredItems(p) {
    requireRead()
    if (blank(p.customerPartyId)) denied("CUSTOMER_REQUIRED", "Name the customer")
    const userScope = facilityScope.scope()
    let partQuery = find(PART, {customerPartyId: p.customerPartyId})
    if (userScope.organizationPartyIds) partQuery = partQuery.condition("vendorPartyId", "in", userScope.organizationPartyIds)
    const parts = Array.from(partQuery.selectField("orderId,vendorPartyId").limit(1000).list()).filter(row =>
        isInternal(row.vendorPartyId)
    )
    const vendorOf = new Map(parts.map(row => [row.orderId, row.vendorPartyId]))
    const orderIds = [...vendorOf.keys()]
    if (!orderIds.length) return {deliveredList: []}
    const issuances = Array.from(
        find(ISSUANCE)
            .condition("orderId", "in", orderIds.slice(0, 1000))
            .condition("assetId", "is-not-null", null)
            .orderBy("-issuedDate")
            .limit(500)
            .list()
    )
    const assets = new Map(
        issuances.length
            ? Array.from(
                  find(ASSET)
                      .condition("assetId", "in", [...new Set(issuances.map(row => row.assetId))])
                      .list()
              ).map(row => [row.assetId, row])
            : []
    )
    // the customer's own open claim on it (another customer's claim on the serial is not theirs to see)
    const claimsOf = assetId =>
        rows(RECORD, {recordEntityName: ASSET, recordId: assetId})
            .map(row => one(REQUEST, {requestId: row.requestId}))
            .filter(
                request =>
                    request?.requestTypeEnumId === claimType &&
                    !closedStatuses.includes(request.statusId) &&
                    rows(REQUEST_PARTY, {requestId: request.requestId, roleTypeId: "Customer"}).some(
                        row => row.partyId === p.customerPartyId && lib.active(row)
                    )
            )
    const seen = new Set()
    const deliveredList = []
    for (const issuance of issuances) {
        const asset = assets.get(issuance.assetId)
        if (!asset || (!asset.serialNumber && !asset.lotId) || seen.has(asset.assetId)) continue
        seen.add(asset.assetId)
        const organizationPartyId = vendorOf.get(issuance.orderId)
        let found = null
        try {
            found = coverageOf({organizationPartyId, customerPartyId: p.customerPartyId, assetId: asset.assetId})
        } catch (error) {
            ec.logger.warn("Delivered item " + asset.assetId + ": coverage not read: " + error.message)
        }
        // a serial returned and sold again to another customer is no longer this customer's
        if (found && asset.serialNumber && !found.saleOrderId) continue
        const claim = claimsOf(asset.assetId)[0] || null
        deliveredList.push({
            assetId: asset.assetId,
            productId: asset.productId,
            productText: productText(asset.productId),
            serialNumber: asset.serialNumber || null,
            lotId: asset.lotId || null,
            identText: assetText(asset),
            orderId: issuance.orderId,
            orderItemSeqId: issuance.orderItemSeqId || null,
            shipmentId: issuance.shipmentId || null,
            shipText: lib.dateText(issuance.issuedDate),
            quantity: issuance.quantity == null ? null : Number(String(issuance.quantity)),
            organizationPartyId,
            coverageEndText: found?.coverageEndText || "",
            coverageSourceText: found ? found.coverageEndSourceText || found.basisText : "",
            covered: !!found?.covered,
            coveredText: found ? (found.covered ? "Covered" : "Not covered") : "",
            claimRequestId: claim?.requestId || null
        })
        if (deliveredList.length >= 200) break
    }
    return {deliveredList}
}

const operations = {
    save,
    coverage,
    decide,
    linkWork,
    updateWork,
    notifyFinished,
    storeAgreement,
    get,
    find: findClaims,
    deliveredItems
}
;({
    stateTexts,
    coverageOf,
    // each operation checks its own permission and organization, and reads and writes with artifact authorization off
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown warranty operation " + op)
        const wasDisabled = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](parameters || {})
        } finally {
            if (!wasDisabled) ec.artifactExecution.enableAuthz()
        }
    }
})
