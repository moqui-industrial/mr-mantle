// Requests for quotation and supplier quotes (design-purchasing §5 QuoteRequests, QuoteRequestDetail, Quotes, QuoteDetail;
// impl-purchasing P11, §4, R-PUR-13, R-PUR-21, F19, F35, F41): no RFQ, invitation or quote entity (SourcingEntities.xml).
// An RFQ is a Request of type RqtPurchaseRfq whose organization is its OrgInternal RequestParty, one of the user's; its items
// are RequestItems, and an item made from an approved purchase request line is linked to it by RequestItemAssoc. Its
// revision is the time of the last change to its audit-logged material fields (an item's product, quantity, unit, required
// date, description or cancel; the response date, specification text, facility and currency). Each invited supplier's quote is a purchase
// order with one part, the supplier the vendor and the organization the customer, in OrderRequested ("Request Quote"), its
// lines from the RFQ items with RequestItemOrder links, kept in step with the items while it is requested; the supplier's
// answer, entered by a buyer on its behalf with the channel it came by and its evidence, moves it to OrderProposed with prices
// and dates, its validity in OrderPart validFromDate and validThruDate, its terms and its reference. An unsolicited quote is
// entered straight in OrderProposed. Sending publishes the RFQ as of its time, stores its PDF as RequestContent and mails it
// to each invited supplier, one failure named (InvitationDeliveryFailed) while the others go; a material change after it
// needs a new send. A quoted price becomes a supplier price only through publish#SupplierQuotePrice, Products'
// store#ProductPrice under SUPPLIER_PRICE_EDIT. Quotes are never supply: the supply plan counts placed orders and a
// conversion's drafts (SupplyPlanning.js), and a purchase request's sourcing counts RequirementSupply, which no quote has.
// Every verb but the price publish checks PURCHASE_ORDER_EDIT and the organization (FacilityScope).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const policyModule = ec.resource.script("component://mr-mantle/service/mantle/order/PurchasePolicy.js")
const orders = () => ec.resource.script("component://mr-mantle/service/mantle/order/PurchaseOrders.js")
const documents = () => ec.resource.script("component://mr-mantle/service/mantle/order/PurchaseOrderDocuments.js")
const planning = () => ec.resource.script("component://mr-mantle/service/mantle/product/SupplyPlanning.js")
// P16: each invited supplier's link to its quote's QuoteResponse page (SupplierPortal.js)
const portal = () => ec.resource.script("component://mr-mantle/service/mantle/order/SupplierPortal.js")
const {find, one, rows, call, denied, access, ms, dateText} = lib

const REQUEST = "mantle.request.Request",
    ITEM = "mantle.request.RequestItem",
    REQUEST_PARTY = "mantle.request.RequestParty",
    ITEM_ORDER = "mantle.request.RequestItemOrder",
    ITEM_ASSOC = "mantle.request.RequestItemAssoc",
    ORDER = "mantle.order.OrderHeader",
    PART = "mantle.order.OrderPart",
    ORDER_ITEM = "mantle.order.OrderItem"
const rfqType = "RqtPurchaseRfq"
const quoteStatuses = ["OrderRequested", "OrderProposed"]
const closedStatuses = ["ReqCompleted", "ReqCancelled"]
// the material fields whose change is the RFQ's revision: the items' are audit-logged by the entity ("true", F57); the header's
// are logged by store#QuoteRequest itself (headerAudit), an RFQ's only, so no other request's timeline changes (F-P11-11)
const itemRevisionFields = ["productId", "quantity", "quantityUomId", "requiredByDate", "description", "statusId"]
const headerRevisionFields = ["responseRequiredDate", "description", "facilityId", "currencyUomId"]
const readPermissions = ["PURCHASE_ORDER_EDIT", "PURCHASE_APPROVE", "PURCHASE_ORDER_APPROVE"]
const dayMs = 24 * 60 * 60 * 1000

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const dec = value => toDecimal(value == null || value === "" ? 0 : value)
const partyName = partyId => (partyId ? lib.partyNames([partyId])[partyId] || partyId : "")
const uomText = uomId => (uomId ? one("moqui.basic.Uom", {uomId})?.abbreviation || uomId : "")
const quantityText = value => (value == null ? "" : ec.l10n.format(dec(value), "#,##0.###"))
const given = (p, field) => Object.keys(p).includes(field) && p[field] !== undefined
const truthy = value => value === true || value === "true" || value === "Y"
// each changed field's reason for its audit row (a service's own parameters, as update#OrderItem takes them)
const reasonsOf = (values, reason) =>
    reason ? Object.fromEntries(Object.keys(values).map(field => [field + "_changeReason", String(reason)])) : {}

function requirePermission(...permissions) {
    // P16: a supplier's response from its PASS page answers its own quote (PurchaseOrders.js asSupplier)
    if (orders().claimed(permissions)) return
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
function decimal(value, label, allowZero = false) {
    let number
    try {
        number = toDecimal(value)
    } catch (_) {
        number = null
    }
    if (number == null || number.compare(0) < 0 || (!allowZero && number.isZero()))
        denied("QUANTITY_INVALID", "Enter a " + (allowZero ? "" : "positive ") + label)
    return number
}
function currencyOf(organizationPartyId) {
    const fromPolicy = policyModule.effective(organizationPartyId).policy.currencyUomId
    if (fromPolicy) return fromPolicy
    return (
        call("mantle.ledger.LedgerServices.find#PartyAcctgPreference", {organizationPartyId}).partyAcctgPreference
            ?.baseCurrencyUomId || null
    )
}
function requireCurrency(currencyUomId) {
    if (currencyUomId && one("moqui.basic.Uom", {uomId: currencyUomId})?.uomTypeEnumId !== "UT_CURRENCY_MEASURE")
        denied("CURRENCY_INVALID", "Choose a currency")
    return currencyUomId || null
}
function requireFacility(organizationPartyId, facilityId) {
    if (facilityId && one("mantle.facility.Facility", {facilityId})?.ownerPartyId !== organizationPartyId)
        denied("FACILITY_INVALID", "Choose a facility of " + partyName(organizationPartyId))
    return facilityId || null
}
// The buying policy's supplier check: a Stop refuses with its code, a Warn adds a warning.
function supplierCheck(organizationPartyId, supplierPartyId) {
    const checked = policyModule.supplierUsable(organizationPartyId, supplierPartyId)
    if (checked.result === "STOP") denied(checked.reasonCode, checked.message)
    if (checked.result === "WARN") ec.message.addMessage(checked.message, "warning")
    return checked
}
function productUsable(productId, quantity, facilityId, supplierPartyId, organizationPartyId) {
    const usable = call("mantle.product.ProductServices.check#ProductUsable", {
        productId,
        usage: "Purchase",
        quantity: quantity ?? 1,
        facilityId: facilityId || null,
        vendorPartyId: supplierPartyId || null,
        customerPartyId: organizationPartyId
    })
    if (!usable.usable) denied("PRODUCT_NOT_USABLE", usable.reason || productId + " is not usable for buying")
}

// ===== the RFQ =====
// An RFQ of one of the user's organizations (its OrgInternal RequestParty); a missing request, one of another type and one
// outside the user's organizations are refused alike (RECORD_UNAVAILABLE).
function rfqOf(requestId, lock = false) {
    const unavailable = () => denied("RECORD_UNAVAILABLE", "RFQ " + (requestId || "") + " is not available")
    if (blank(requestId)) unavailable()
    const request = lock ? find(REQUEST, {requestId}).forUpdate(true).one() : one(REQUEST, {requestId})
    if (!request || request.requestTypeEnumId !== rfqType) unavailable()
    const organizationPartyId =
        rows(REQUEST_PARTY, {requestId}).find(row => row.roleTypeId === "OrgInternal" && lib.active(row))?.partyId || null
    if (!organizationPartyId || !facilityScope.owns(facilityScope.scope(), organizationPartyId)) unavailable()
    return {request, requestId: String(requestId), organizationPartyId}
}
function requireOpen(rfq) {
    if (closedStatuses.includes(rfq.request.statusId)) denied("REQUEST_CLOSED", "RFQ " + rfq.requestId + " is closed")
}
const itemsOf = (requestId, withCancelled = false) =>
    rows(ITEM, {requestId})
        .filter(item => withCancelled || item.statusId !== "ReqCancelled")
        .sort((a, b) => String(a.requestItemSeqId).localeCompare(String(b.requestItemSeqId)))
// The RFQ's revision: the time of the last change to its material fields (0 before any).
function revisionOf(requestId) {
    const latest = (entity, fields) =>
        Array.from(
            find("moqui.entity.EntityAuditLog", {changedEntityName: entity, pkPrimaryValue: requestId})
                .condition("changedFieldName", "in", fields)
                .orderBy("-changedDate")
                .limit(1)
                .list()
        )[0]
    const times = [latest(ITEM, itemRevisionFields), latest(REQUEST, headerRevisionFields)]
        .filter(Boolean)
        .map(row => Number(ms(row.changedDate)))
    return times.length ? Math.max(...times) : 0
}
// The quote orders of an RFQ (its invitations): the orders its items' lines are on, with their part and status.
function invitationsOf(requestId) {
    const orderIds = Array.from(
        new Set(
            Array.from(find(ITEM_ORDER, {requestId}).selectField("orderId").list())
                .map(row => row.orderId)
                .filter(Boolean)
        )
    ).sort()
    return orderIds
        .map(orderId => {
            const order = one(ORDER, {orderId})
            const part = rows(PART, {orderId})[0]
            return order && part ? {orderId, order, part, supplierPartyId: part.vendorPartyId} : null
        })
        .filter(Boolean)
}
// When a quote order was last sent the RFQ (its emails that went or are queued), or null.
function sentAtOf(orderId) {
    const ids = rows("mantle.order.OrderEmailMessage", {orderId})
        .filter(row => row.roleTypeId === "Supplier")
        .map(row => row.emailMessageId)
    if (!ids.length) return null
    const sent = Array.from(
        find("moqui.basic.email.EmailMessage")
            .condition("emailMessageId", "in", ids)
            .condition("statusId", "in", ["ES_SENT", "ES_READY", "ES_SCHEDULED"])
            .list()
    ).map(row => Number(ms(row.sentDate || row.lastUpdatedStamp)))
    return sent.length ? Math.max(...sent) : null
}
// The latest published RFQ PDF (RequestContent), or null.
function publishedOf(requestId) {
    return (
        rows("mantle.request.RequestContent", {requestId, contentTypeEnumId: "RqCntRfqPublished"}).sort(
            (a, b) => ms(b.contentDate) - ms(a.contentDate)
        )[0] || null
    )
}

// create#QuoteRequest: a draft RFQ of one of the user's organizations, from approved purchase request lines when given.
function create(p) {
    requirePermission("PURCHASE_ORDER_EDIT")
    const organizationPartyId = requireOrganization(text(p.organizationPartyId))
    const requestName = text(p.requestName)
    if (!requestName) denied("NAME_REQUIRED", "Name the RFQ")
    const facilityId = requireFacility(organizationPartyId, text(p.facilityId))
    const currencyUomId = requireCurrency(text(p.currencyUomId) || currencyOf(organizationPartyId))
    // the response date: given, else the buying policy's response days from now
    const responseDays = Number(policyModule.effective(organizationPartyId).policy.rfqResponseDays ?? 7)
    const responseRequiredDate = blank(p.responseRequiredDate)
        ? new Date(Number(ec.user.nowTimestamp) + responseDays * dayMs)
        : p.responseRequiredDate
    const created = call("mantle.request.RequestServices.create#Request", {
        requestTypeEnumId: rfqType,
        statusId: "ReqDraft",
        requestName,
        description: text(p.description),
        facilityId,
        currencyUomId,
        responseRequiredDate
    })
    call("create#" + REQUEST_PARTY, {
        requestId: created.requestId,
        partyId: organizationPartyId,
        roleTypeId: "OrgInternal",
        fromDate: ec.user.nowTimestamp
    })
    const requestItemSeqIds = []
    for (const key of keyList(p.sourceRequestItemKeys)) requestItemSeqIds.push(itemFromSource(rfqOf(created.requestId), key))
    return {requestId: created.requestId, requestItemSeqIds}
}
const keyList = value =>
    (Array.isArray(value) ? value : String(value || "").split(","))
        .map(key => String(key).trim())
        .filter(key => key.includes(":"))
// An RFQ item from an approved purchase request line of the RFQ's organization: its product, unit, date and description, and
// the quantity left to source, linked by RequestItemAssoc (the source a later award covers).
function itemFromSource(rfq, key) {
    const [requestId, requestItemSeqId] = key.split(":")
    const source = ec.resource
        .script("component://mr-mantle/service/mantle/request/PurchaseRequests.js")
        .purchaseRequest(requestId)
    if (source.organizationPartyId !== rfq.organizationPartyId)
        denied("SOURCE_INVALID", "Purchase request " + requestId + " is another organization's")
    const line = one(ITEM, {requestId, requestItemSeqId})
    if (!line || line.statusId === "ReqCancelled")
        denied("ITEM_UNAVAILABLE", "Line " + requestItemSeqId + " is not on purchase request " + requestId)
    const link = rows("mantle.request.requirement.RequirementRequestItem", {requestId, requestItemSeqId})[0]
    const requirement = link ? one("mantle.request.requirement.Requirement", {requirementId: link.requirementId}) : null
    if (!requirement || !["RqmtStApproved", "RqmtStOrdered"].includes(requirement.statusId))
        denied("NOT_APPROVED", "Line " + key + " is not approved")
    const remaining = dec(requirement.quantity).subtract(planning().coveredOf(requirement.requirementId))
    if (remaining.compare(0) <= 0) denied("ALREADY_SOURCED", "Line " + key + " is already sourced")
    const stored = storeItem({
        requestId: rfq.requestId,
        productId: line.productId,
        description: line.description,
        quantity: remaining,
        quantityUomId: line.quantityUomId,
        requiredByDate: line.requiredByDate
    })
    call("create#" + ITEM_ASSOC, {
        requestId: rfq.requestId,
        requestItemSeqId: stored.requestItemSeqId,
        otherRequestId: requestId,
        otherRequestItemSeqId: requestItemSeqId,
        quantity: remaining
    })
    return stored.requestItemSeqId
}

// store#QuoteRequest: the RFQ's name, specification text, response date, facility and currency (the currency while no quote
// is proposed). A change of the response date or text is a new revision, to send again.
function update(p) {
    requirePermission("PURCHASE_ORDER_EDIT")
    const rfq = rfqOf(p.requestId, true)
    requireOpen(rfq)
    const changes = {}
    if (given(p, "requestName")) {
        if (blank(p.requestName)) denied("NAME_REQUIRED", "Name the RFQ")
        changes.requestName = text(p.requestName)
    }
    if (given(p, "description")) changes.description = text(p.description)
    if (given(p, "responseRequiredDate"))
        changes.responseRequiredDate = blank(p.responseRequiredDate) ? null : p.responseRequiredDate
    if (given(p, "facilityId")) changes.facilityId = requireFacility(rfq.organizationPartyId, text(p.facilityId))
    if (given(p, "currencyUomId") && text(p.currencyUomId) !== (rfq.request.currencyUomId || null)) {
        if (invitationsOf(rfq.requestId).some(row => row.order.statusId === "OrderProposed"))
            denied("CURRENCY_CHANGE_QUOTED", "RFQ " + rfq.requestId + " has quotes in its currency")
        changes.currencyUomId = requireCurrency(text(p.currencyUomId))
    }
    if (Object.keys(changes).length) call("update#" + REQUEST, Object.assign({requestId: rfq.requestId}, changes))
    headerAudit(rfq, changes, p.changeReason)
    return {requestId: rfq.requestId, sourceRevision: revisionOf(rfq.requestId)}
}
// The audit rows of an RFQ's header change (its material fields, a first value set included), written here rather than by
// the entity so that only an RFQ's timeline shows them: the RFQ's revision and its as-of print read them (F-P11-11).
function headerAudit(rfq, changes, reason) {
    const auditText = (field, value) =>
        value == null || value === "" ? null : field === "responseRequiredDate" ? String(ms(value)) : String(value)
    for (const field of headerRevisionFields) {
        if (!Object.keys(changes).includes(field)) continue
        const oldValueText = auditText(field, rfq.request[field])
        const newValueText = auditText(field, changes[field])
        if (oldValueText === newValueText) continue
        call("create#moqui.entity.EntityAuditLog", {
            changedEntityName: REQUEST,
            changedFieldName: field,
            pkPrimaryValue: rfq.requestId,
            oldValueText,
            newValueText,
            changeReason: reason ? String(reason) : null,
            changedDate: ec.user.nowTimestamp,
            changedByUserId: ec.user.userId || null
        })
    }
}

// store#QuoteRequestItem: an RFQ item, new or changed, or removed (cancelled, so the change is in its history); the quotes
// still requested follow it.
function storeItem(p) {
    requirePermission("PURCHASE_ORDER_EDIT")
    const rfq = rfqOf(p.requestId, true)
    requireOpen(rfq)
    let item = null
    if (!blank(p.requestItemSeqId)) {
        item = one(ITEM, {requestId: rfq.requestId, requestItemSeqId: p.requestItemSeqId})
        if (!item || item.statusId === "ReqCancelled")
            denied("ITEM_UNAVAILABLE", "Item " + p.requestItemSeqId + " is not on RFQ " + rfq.requestId)
    }
    if (p.changeReason) ec.context.putAll({statusId_changeReason: String(p.changeReason)})
    if (item && truthy(p.remove)) {
        call("update#" + ITEM, {requestId: rfq.requestId, requestItemSeqId: item.requestItemSeqId, statusId: "ReqCancelled"})
        followItem(rfq, item.requestItemSeqId)
        return {requestId: rfq.requestId, requestItemSeqId: item.requestItemSeqId, sourceRevision: revisionOf(rfq.requestId)}
    }
    const changes = {}
    const productId = given(p, "productId") ? text(p.productId) : (item?.productId ?? null)
    const product = productId ? one("mantle.product.Product", {productId}) : null
    if (productId && !product) denied("PRODUCT_REQUIRED", "Choose a product")
    if (given(p, "productId") && productId !== (item?.productId ?? null)) changes.productId = productId
    const quantity = given(p, "quantity") && !blank(p.quantity) ? decimal(p.quantity, "quantity") : item ? null : dec(1)
    if (quantity != null) changes.quantity = quantity
    if (given(p, "quantityUomId")) {
        const uomId = text(p.quantityUomId)
        if (uomId && !one("moqui.basic.Uom", {uomId})) denied("UOM_INVALID", "Choose a unit")
        changes.quantityUomId = uomId
    } else if (!item) changes.quantityUomId = product?.amountUomId || null
    if (given(p, "requiredByDate")) changes.requiredByDate = blank(p.requiredByDate) ? null : p.requiredByDate
    else if (!item) changes.requiredByDate = null
    if (given(p, "description")) changes.description = text(p.description)
    if (!item && !changes.description && product) changes.description = product.productName || productId
    if (!item && !productId && !changes.description) denied("ITEM_INVALID", "Choose a product or describe the item")
    if (productId && (changes.productId || changes.quantity || !item))
        productUsable(productId, changes.quantity ?? item?.quantity, rfq.request.facilityId, null, rfq.organizationPartyId)
    if (p.changeReason)
        ec.context.putAll(
            Object.fromEntries(Object.keys(changes).map(field => [field + "_changeReason", String(p.changeReason)]))
        )
    let requestItemSeqId = item?.requestItemSeqId
    if (!item)
        requestItemSeqId = call(
            "create#" + ITEM,
            Object.assign({requestId: rfq.requestId, statusId: "ReqDraft"}, changes)
        ).requestItemSeqId
    else if (Object.keys(changes).length)
        call("update#" + ITEM, Object.assign({requestId: rfq.requestId, requestItemSeqId}, changes))
    if (!item || Object.keys(changes).length) followItem(rfq, requestItemSeqId)
    return {requestId: rfq.requestId, requestItemSeqId, sourceRevision: revisionOf(rfq.requestId)}
}
// The quotes still requested follow an item: its line added, changed, or (for a removed item) taken off. A quote the supplier
// answered keeps its lines; the RFQ's new revision is sent to it again.
function followItem(rfq, requestItemSeqId) {
    const item = one(ITEM, {requestId: rfq.requestId, requestItemSeqId})
    for (const invitation of invitationsOf(rfq.requestId)) {
        if (invitation.order.statusId !== "OrderRequested") continue
        const link = rows(ITEM_ORDER, {requestId: rfq.requestId, requestItemSeqId, orderId: invitation.orderId})[0]
        const line = link ? one(ORDER_ITEM, {orderId: invitation.orderId, orderItemSeqId: link.orderItemSeqId}) : null
        const removed = !item || item.statusId === "ReqCancelled"
        if (line && (removed || (line.productId || null) !== (item.productId || null))) {
            call("delete#" + ITEM_ORDER, {requestItemOrderId: link.requestItemOrderId})
            call("mantle.order.OrderServices.delete#OrderItem", {
                orderId: invitation.orderId,
                orderItemSeqId: line.orderItemSeqId
            })
            if (removed) continue
        } else if (line) {
            // the line's price given (unpriced until the supplier answers): without one update#OrderItem prices it by the
            // resolver (F-P12-4)
            call("mantle.order.OrderServices.update#OrderItem", {
                orderId: invitation.orderId,
                orderItemSeqId: line.orderItemSeqId,
                unitAmount: line.unitAmount ?? 0,
                quantity: item.quantity,
                quantityUomId: item.quantityUomId,
                requiredByDate: item.requiredByDate,
                itemDescription: item.description
            })
            call("update#" + ITEM_ORDER, {requestItemOrderId: link.requestItemOrderId, quantity: item.quantity})
            continue
        }
        if (!removed) addLine(invitation.orderId, invitation.part.orderPartSeqId, rfq.requestId, item)
    }
}
// A quote line for an RFQ item, unpriced until the supplier answers, and its RequestItemOrder link.
function addLine(orderId, orderPartSeqId, requestId, item) {
    const created = call("mantle.order.OrderServices.create#OrderItem", {
        orderId,
        orderPartSeqId,
        productId: item.productId || null,
        itemTypeEnumId: item.productId ? "ItemProduct" : "ItemExpense",
        itemDescription: item.description || null,
        quantity: item.quantity,
        quantityUomId: item.quantityUomId || null,
        requiredByDate: item.requiredByDate || null,
        unitAmount: 0,
        isModifiedPrice: "N"
    })
    call("create#" + ITEM_ORDER, {
        requestId,
        requestItemSeqId: item.requestItemSeqId,
        orderId,
        orderItemSeqId: created.orderItemSeqId,
        quantity: item.quantity
    })
    return created.orderItemSeqId
}

// ===== invitations =====
// The live quote of a supplier for an RFQ (requested or proposed), or null.
const liveInvitation = (requestId, supplierPartyId) =>
    invitationsOf(requestId).find(row => row.supplierPartyId === supplierPartyId && quoteStatuses.includes(row.order.statusId)) ||
    null
// A quote order of the organization from the supplier, requested (an invitation) or proposed (an unsolicited quote).
function quoteOrder(rfqOrNull, organizationPartyId, supplierPartyId, statusId, currencyUomId, facilityId) {
    orders().supplierOf(organizationPartyId, supplierPartyId)
    const checked = supplierCheck(organizationPartyId, supplierPartyId)
    const created = call("mantle.order.OrderServices.create#Order", {
        customerPartyId: organizationPartyId,
        vendorPartyId: supplierPartyId,
        currencyUomId,
        facilityId: facilityId || null,
        orderName: rfqOrNull ? "RFQ " + rfqOrNull.requestId + " · " + (rfqOrNull.request.requestName || "") : null,
        statusId
    })
    // P12: marked a supplier quote, so the purchase order lists leave out the quotes never placed (F-P12-1)
    call("update#" + ORDER, {orderId: created.orderId, supplierQuote: "Y"})
    return {orderId: created.orderId, orderPartSeqId: created.orderPartSeqId, supplierResult: checked.result}
}
// store#QuoteInvitation: a supplier invited to an RFQ (its quote order in OrderRequested, a line per item), or a requested
// quote marked declined by the supplier (Reject Request, with the reason).
function invite(p) {
    requirePermission("PURCHASE_ORDER_EDIT")
    const rfq = rfqOf(p.requestId, true)
    requireOpen(rfq)
    if (truthy(p.declined)) {
        const invitation = invitationsOf(rfq.requestId).find(row => row.orderId === String(p.orderId || ""))
        if (!invitation)
            denied("INVITATION_UNAVAILABLE", "Quote " + (p.orderId || "") + " is not an invitation of RFQ " + rfq.requestId)
        if (invitation.order.statusId !== "OrderRequested")
            denied("QUOTE_PROPOSED", "Quote " + invitation.orderId + " was answered; it is closed with the award")
        const reason = text(p.reason)
        if (!reason) denied("REASON_REQUIRED", "Give the supplier's reason")
        call("mantle.order.OrderServices.update#OrderStatus", {orderId: invitation.orderId, statusId: "OrderRejected"})
        call("create#mantle.order.OrderNote", {
            orderId: invitation.orderId,
            noteDate: ec.user.nowTimestamp,
            noteText: "Declined: " + reason,
            internalNote: "Y",
            userId: ec.user.userId
        })
        return {requestId: rfq.requestId, orderId: invitation.orderId, statusId: "OrderRejected"}
    }
    const supplierPartyId = text(p.supplierPartyId)
    if (!supplierPartyId) denied("SUPPLIER_UNAVAILABLE", "Choose a supplier")
    const items = itemsOf(rfq.requestId)
    if (!items.length) denied("NO_ITEMS", "Add an item to RFQ " + rfq.requestId + " before inviting suppliers")
    const existing = liveInvitation(rfq.requestId, supplierPartyId)
    if (existing) return {requestId: rfq.requestId, orderId: existing.orderId, statusId: existing.order.statusId, existing: true}
    const created = quoteOrder(
        rfq,
        rfq.organizationPartyId,
        supplierPartyId,
        "OrderRequested",
        rfq.request.currencyUomId,
        rfq.request.facilityId
    )
    for (const item of items) addLine(created.orderId, created.orderPartSeqId, rfq.requestId, item)
    return {
        requestId: rfq.requestId,
        orderId: created.orderId,
        statusId: "OrderRequested",
        existing: false,
        supplierResult: created.supplierResult
    }
}

// ===== the print =====
// A field's value at a time: the old value of its first change after the time, else the value now.
function valueAt(logs, field, secondary, at, current) {
    const change = logs.find(
        row =>
            row.changedFieldName === field &&
            (secondary == null || row.pkSecondaryValue === secondary) &&
            ms(row.changedDate) > at
    )
    return change ? change.oldValueText : current
}
// The RFQ as of a time (null for now): its header fields and its items then.
function rfqAt(rfq, at) {
    const now = at == null
    const auditFind = (entity, fields) =>
        now
            ? []
            : Array.from(
                  find("moqui.entity.EntityAuditLog")
                      .condition("changedEntityName", entity)
                      .condition("pkPrimaryValue", rfq.requestId)
                      .condition("changedFieldName", "in", fields)
                      .orderBy("changedDate")
                      .list()
              )
    if (!now && ms(rfq.request.requestDate) > at)
        denied("REQUEST_NOT_YET", "RFQ " + rfq.requestId + " was not entered yet at that time")
    const headerLogs = auditFind(REQUEST, headerRevisionFields)
    const itemLogs = auditFind(ITEM, itemRevisionFields)
    const header = field => (now ? rfq.request[field] : valueAt(headerLogs, field, null, at, rfq.request[field]) || null)
    const lines = []
    for (const item of itemsOf(rfq.requestId, true)) {
        const seq = item.requestItemSeqId
        if (!now) {
            const created = itemLogs.find(
                row => row.changedFieldName === "quantity" && row.pkSecondaryValue === seq && row.oldValueText == null
            )
            if (created && ms(created.changedDate) > at) continue
        }
        const value = field => (now ? item[field] : valueAt(itemLogs, field, seq, at, item[field]))
        if (value("statusId") === "ReqCancelled") continue
        lines.push({
            requestItemSeqId: seq,
            productId: value("productId"),
            description: value("description"),
            quantity: value("quantity"),
            quantityUomId: value("quantityUomId"),
            requiredByDate: value("requiredByDate")
        })
    }
    const revision = now
        ? revisionOf(rfq.requestId)
        : Math.max(
              0,
              ...headerLogs
                  .concat(itemLogs)
                  .filter(row => ms(row.changedDate) <= at)
                  .map(row => Number(ms(row.changedDate)))
          )
    return {
        responseRequiredDate: header("responseRequiredDate"),
        description: header("description"),
        facilityId: header("facilityId"),
        currencyUomId: header("currencyUomId"),
        lines,
        revision
    }
}
// The print of an RFQ (as of a time, or now): its HTML, the revision and a hash of the print. A supplier's copy names the
// supplier; it never names the other suppliers, internal maximum prices or the source requests' notes.
function printOf(rfq, at, supplierPartyId) {
    const state = rfqAt(rfq, at)
    const productNames = {}
    for (const line of state.lines)
        if (line.productId && !productNames[line.productId]) {
            const product = one("mantle.product.Product", {productId: line.productId})
            productNames[line.productId] = product
                ? [product.pseudoId || product.productId, product.productName].filter(Boolean).join(" · ")
                : line.productId
        }
    const facility = state.facilityId ? one("mantle.facility.Facility", {facilityId: state.facilityId}) : null
    const revisionText = state.revision ? "Revision of " + dateText(state.revision) : "Draft"
    const printHtml = ec.resource.template("component://mr-mantle/template/order/QuoteRequest.print.html.fancy", {
        requestId: rfq.requestId,
        requestName: rfq.request.requestName || "",
        organizationName: partyName(rfq.organizationPartyId),
        supplierName: supplierPartyId ? partyName(supplierPartyId) : "",
        revisionText,
        asOfText: at == null ? "" : dateText(at),
        dueText: state.responseRequiredDate ? dateText(state.responseRequiredDate) : "",
        facilityName: facility ? facility.facilityName || facility.facilityId : "",
        currencyText: state.currencyUomId || "",
        description: state.description || "",
        lines: state.lines.map(line => ({
            seq: line.requestItemSeqId,
            productText: line.productId ? productNames[line.productId] : line.description || "",
            description: line.productId && line.description !== productNames[line.productId] ? line.description || "" : "",
            quantityText: quantityText(line.quantity),
            unitText: uomText(line.quantityUomId),
            requiredText: line.requiredByDate ? dateText(line.requiredByDate) : ""
        }))
    })
    return {
        printHtml,
        revision: state.revision,
        revisionText,
        lineCount: state.lines.length,
        contentHash: ec.user.singleUseCodeHash(printHtml),
        fileName: "RFQ-" + rfq.requestId + ".pdf"
    }
}
// get#QuoteRequestPrint: the RFQ as of a time (now when empty), for a purchasing reader of its organization.
function print(p) {
    requirePermission(...readPermissions)
    const rfq = rfqOf(p.requestId)
    const at = blank(p.asOfDate) ? null : ms(p.asOfDate)
    if (at != null && !Number.isFinite(at)) denied("DATE_INVALID", "Choose a valid date and time")
    if (at != null && at > Number(ec.user.nowTimestamp)) denied("DATE_INVALID", "Choose a time that has passed")
    return Object.assign({requestId: rfq.requestId, asOfText: at == null ? "" : dateText(at)}, printOf(rfq, at, null))
}

// ===== the send =====
// send#QuoteRequest: the RFQ as of now, published (its PDF stored as RequestContent, once per print) and mailed to each
// invited supplier still requested or proposed (those given, else those not sent the current revision), each in its own
// transaction; a supplier with no address, an invalid one or a failed delivery is InvitationDeliveryFailed by name and the
// others go. The first send moves a draft to Submitted (published). The same operation key answers the first result.
function send(p) {
    requirePermission("PURCHASE_ORDER_EDIT")
    const rfq = rfqOf(p.requestId, true)
    requireOpen(rfq)
    const wanted = Array.isArray(p.orderIds)
        ? p.orderIds.map(String)
        : String(p.orderIds || "")
              .split(",")
              .map(id => id.trim())
              .filter(Boolean)
    const request = {requestId: rfq.requestId, orderIds: wanted, note: p.note || null}
    const operation = lib.operation(p, "QuoteRequestSend", rfq.organizationPartyId, request)
    if (operation.old) return lib.previous(operation)
    if (!itemsOf(rfq.requestId).length) denied("NO_ITEMS", "Add an item to RFQ " + rfq.requestId + " before sending it")
    const revision = revisionOf(rfq.requestId)
    const live = invitationsOf(rfq.requestId).filter(row => quoteStatuses.includes(row.order.statusId))
    const targets = wanted.length
        ? live.filter(row => wanted.includes(row.orderId))
        : live.filter(row => (sentAtOf(row.orderId) ?? -1) < revision)
    if (!live.length) denied("NO_INVITATIONS", "Invite a supplier to RFQ " + rfq.requestId + " before sending it")
    if (wanted.length && targets.length !== wanted.length)
        denied("INVITATION_UNAVAILABLE", "Send only to the suppliers invited to RFQ " + rfq.requestId)

    // the published RFQ: one PDF for each print, kept as the RFQ's content and stamped with its time
    const printed = printOf(rfq, null, null)
    const key = printed.contentHash.replace(/[^A-Za-z0-9]/g, "").slice(0, 24)
    const location = "dbresource://mantle/content/rfq-published/" + rfq.requestId + "/" + key + "/" + printed.fileName
    const pdfBytes = ec.resource.xslFoTransform(printed.printHtml, null, null, "application/pdf")
    let requestContentId = rows("mantle.request.RequestContent", {requestId: rfq.requestId}).find(
        row => row.contentLocation === location
    )?.requestContentId
    if (!requestContentId) {
        ec.resource.getLocationReference(location).putBytes(pdfBytes)
        requestContentId = call("create#mantle.request.RequestContent", {
            requestId: rfq.requestId,
            contentTypeEnumId: "RqCntRfqPublished",
            contentLocation: location,
            contentDate: ec.user.nowTimestamp,
            userId: ec.user.userId,
            description: "RFQ " + rfq.requestId + " as published " + dateText(ec.user.nowTimestamp)
        }).requestContentId
    }

    const fromName = partyName(rfq.organizationPartyId)
    const fromAddress = documents().recipientsOf(rfq.organizationPartyId)[0] || null
    // P16: each supplier's copy carries its own quote's link (QuoteResponse), when the organization has a Supplier site
    const bodyFor = linkUrl =>
        ec.resource.template("component://mr-mantle/template/order/QuoteRequestEmail.html.fancy", {
            note: p.note || null,
            printHtml: printed.printHtml,
            linkUrl: linkUrl || null
        })
    const supplierResults = []
    for (const invitation of targets) {
        const result = {
            orderId: invitation.orderId,
            supplierPartyId: invitation.supplierPartyId,
            supplierName: partyName(invitation.supplierPartyId),
            recipients: [],
            resultStatus: "SENT",
            errorCode: null,
            errorMessage: null
        }
        try {
            const recipients = documents().recipientsOf(invitation.supplierPartyId)
            if (!recipients.length) denied("RECIPIENT_REQUIRED", result.supplierName + " has no order or primary email address")
            const body = bodyFor(portal().quoteLink(invitation.orderId))
            let sentCount = 0
            const failures = []
            for (const recipient of recipients) {
                if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(recipient)) {
                    failures.push(recipient + " is not a valid address")
                    result.recipients.push({recipient, status: "failed", reasonCode: "RECIPIENT_INVALID"})
                    continue
                }
                const status = mailOne(rfq, invitation, recipient, fromAddress, fromName, body, printed, pdfBytes, p)
                result.recipients.push({recipient, status, reasonCode: status === "failed" ? "DELIVERY_FAILED" : null})
                if (status === "failed") failures.push(recipient + " was not delivered")
                else sentCount++
            }
            if (!sentCount) {
                result.resultStatus = "InvitationDeliveryFailed"
                result.errorCode = result.recipients.some(row => row.reasonCode === "RECIPIENT_INVALID")
                    ? "RECIPIENT_INVALID"
                    : "DELIVERY_FAILED"
                result.errorMessage = failures.join("; ")
            }
        } catch (error) {
            result.resultStatus = "InvitationDeliveryFailed"
            result.errorCode = lib.reasonCode(error) || "DELIVERY_FAILED"
            result.errorMessage = String(error.message || error).replace(/^[A-Z_]+: /, "")
        }
        if (result.resultStatus !== "SENT")
            ec.logger.warn("RFQ " + rfq.requestId + " to " + result.supplierName + " was not sent: " + result.errorMessage)
        supplierResults.push(result)
    }
    const sentCount = supplierResults.filter(row => row.resultStatus === "SENT").length
    const failedCount = supplierResults.length - sentCount
    // published: the first send moves a draft RFQ to Submitted
    if (sentCount && rfq.request.statusId === "ReqDraft")
        call("update#" + REQUEST, {requestId: rfq.requestId, statusId: "ReqSubmitted"})
    const result = {
        requestId: rfq.requestId,
        sourceRevision: revision,
        requestContentId,
        contentHash: printed.contentHash,
        supplierResults,
        sentCount,
        failedCount,
        statusId: one(REQUEST, {requestId: rfq.requestId}).statusId
    }
    lib.complete(operation, "mantle.request.RequestContent", requestContentId, result)
    return Object.assign(result, {alreadyApplied: false})
}
// One recipient's email of the RFQ, in its own transaction: sent, queued or failed; a message that went is the quote
// order's OrderEmailMessage (the supplier's role), which tells when the supplier was last sent the RFQ.
function mailOne(rfq, invitation, recipient, fromAddress, fromName, body, printed, pdfBytes, p) {
    let emailMessageId = null
    ec.message.pushErrors()
    try {
        const out =
            ec.service
                .sync()
                .name("org.moqui.mail.EmailServices.send#EmailTemplate")
                .parameters({
                    emailTemplateId: p.emailTemplateId || "MANTLE_RFQ_EMAIL",
                    toAddresses: recipient,
                    bodyParameters: {
                        requestId: rfq.requestId,
                        orderId: invitation.orderId,
                        subject: p.subject || "Request for quotation " + rfq.requestId + " from " + fromName,
                        fromAddress,
                        fromName
                    },
                    body,
                    attachments: [{fileName: printed.fileName, contentType: "application/pdf", contentBytes: pdfBytes}]
                })
                .requireNewTransaction(true)
                .disableAuthz()
                .call() || {}
        if (!ec.message.hasError()) emailMessageId = out.emailMessageId || null
    } catch (error) {
        ec.logger.error("RFQ " + rfq.requestId + " to " + recipient + " was not sent: " + error.message)
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
    const message = emailMessageId ? one("moqui.basic.email.EmailMessage", {emailMessageId}) : null
    if (message)
        call("create#mantle.order.OrderEmailMessage", {
            orderId: invitation.orderId,
            emailMessageId,
            orderRevision: Number(invitation.order.orderRevision ?? 1),
            partyId: invitation.supplierPartyId,
            roleTypeId: "Supplier"
        })
    return message?.statusId === "ES_SENT"
        ? "sent"
        : ["ES_READY", "ES_SCHEDULED"].includes(message?.statusId)
          ? "queued"
          : "failed"
}

// ===== supplier quotes =====
// A quote order (requested or proposed) of the user's organizations, locked when asked.
function quoteOf(orderId, lock = false) {
    const po = orders().purchaseOrder(orderId, lock)
    if (!quoteStatuses.includes(po.order.statusId))
        denied("QUOTE_CLOSED", "Order " + po.orderId + " is not a requested or proposed quote")
    return po
}
const expired = part => !!part.validThruDate && ms(part.validThruDate) <= Number(ec.user.nowTimestamp)
// store#SupplierQuote: a supplier's answer entered on its behalf: the quote's reference and date, validity, terms, delivery,
// the channel it came by and its evidence (a file, or how it came). A requested quote moves to OrderProposed; with no order a
// new quote is entered straight in OrderProposed, for an RFQ's items when the RFQ is given (an unsolicited quote otherwise).
function storeQuote(p) {
    requirePermission("PURCHASE_ORDER_EDIT")
    // P16: a supplier's claim answers its one quote, never a new one
    if (orders().portalClaim() && blank(p.orderId)) denied("RECORD_UNAVAILABLE", "This quote is not available")
    let po
    let created = false
    if (blank(p.orderId)) {
        const rfq = blank(p.requestId) ? null : rfqOf(p.requestId, true)
        if (rfq) requireOpen(rfq)
        const organizationPartyId = rfq ? rfq.organizationPartyId : requireOrganization(text(p.organizationPartyId))
        const supplierPartyId = text(p.vendorPartyId)
        if (!supplierPartyId) denied("SUPPLIER_UNAVAILABLE", "Choose a supplier")
        if (rfq && liveInvitation(rfq.requestId, supplierPartyId))
            denied("QUOTE_EXISTS", partyName(supplierPartyId) + " already has a quote for RFQ " + rfq.requestId)
        const currencyUomId = requireCurrency(
            text(p.currencyUomId) || rfq?.request.currencyUomId || currencyOf(organizationPartyId)
        )
        const quote = quoteOrder(
            rfq,
            organizationPartyId,
            supplierPartyId,
            "OrderProposed",
            currencyUomId,
            rfq?.request.facilityId
        )
        if (rfq) for (const item of itemsOf(rfq.requestId)) addLine(quote.orderId, quote.orderPartSeqId, rfq.requestId, item)
        po = orders().purchaseOrder(quote.orderId, true)
        created = true
    } else {
        po = quoteOf(p.orderId, true)
    }
    const partValues = {}
    if (given(p, "otherPartyOrderId")) partValues.otherPartyOrderId = text(p.otherPartyOrderId)
    if (given(p, "otherPartyOrderDate"))
        partValues.otherPartyOrderDate = blank(p.otherPartyOrderDate) ? null : p.otherPartyOrderDate
    else if (created || po.order.statusId === "OrderRequested") partValues.otherPartyOrderDate = ec.user.nowTimestamp
    if (given(p, "validFromDate")) partValues.validFromDate = blank(p.validFromDate) ? null : p.validFromDate
    if (given(p, "validThruDate")) partValues.validThruDate = blank(p.validThruDate) ? null : p.validThruDate
    if (given(p, "estimatedDeliveryDate"))
        partValues.estimatedDeliveryDate = blank(p.estimatedDeliveryDate) ? null : p.estimatedDeliveryDate
    if (given(p, "settlementTermId")) {
        if (!blank(p.settlementTermId) && !one("mantle.account.invoice.SettlementTerm", {settlementTermId: p.settlementTermId}))
            denied("TERM_INVALID", "Choose a payment term")
        partValues.settlementTermId = text(p.settlementTermId)
    }
    if (given(p, "tradeTermEnumId")) {
        if (!blank(p.tradeTermEnumId) && one("moqui.basic.Enumeration", {enumId: p.tradeTermEnumId})?.parentEnumId !== "TtInco")
            denied("TERM_INVALID", "Choose an incoterm")
        partValues.tradeTermEnumId = text(p.tradeTermEnumId)
    }
    const from = partValues.validFromDate !== undefined ? partValues.validFromDate : po.part.validFromDate
    const thru = partValues.validThruDate !== undefined ? partValues.validThruDate : po.part.validThruDate
    if (from && thru && ms(thru) <= ms(from)) denied("DATE_INVALID", "A quote is valid through a date after it starts")
    const channel = text(p.salesChannelEnumId)
    if (channel && one("moqui.basic.Enumeration", {enumId: channel})?.enumTypeId !== "SalesChannel")
        denied("CHANNEL_INVALID", "Choose how the quote came")
    if (p.changeReason)
        ec.context.putAll(
            Object.fromEntries(Object.keys(partValues).map(field => [field + "_changeReason", String(p.changeReason)]))
        )
    if (Object.keys(partValues).length)
        call("update#" + PART, Object.assign({orderId: po.orderId, orderPartSeqId: po.orderPartSeqId}, partValues))
    if (channel) call("update#" + ORDER, {orderId: po.orderId, salesChannelEnumId: channel})
    // the answer: a requested quote is proposed by the supplier
    if (po.order.statusId === "OrderRequested")
        call("mantle.order.OrderServices.update#OrderStatus", {orderId: po.orderId, statusId: "OrderProposed"})
    // the evidence: the supplier's file, or the way it came, in the supplier's role
    let orderContentId = null
    const evidence = text(p.evidenceText)
    if (p.contentFile || evidence) {
        orderContentId = call("create#mantle.order.OrderContent", {
            orderId: po.orderId,
            orderContentTypeEnumId: "OctSupplierQuote",
            partyId: po.supplierPartyId,
            roleTypeId: "Supplier",
            contentDate: ec.user.nowTimestamp,
            userId: ec.user.userId,
            description: evidence || "Supplier quote"
        }).orderContentId
        if (p.contentFile)
            call("mantle.order.OrderServices.save#OrderContentFile", {
                orderContentId,
                orderId: po.orderId,
                contentFile: p.contentFile
            })
    }
    return {orderId: po.orderId, statusId: one(ORDER, {orderId: po.orderId}).statusId, orderContentId, created}
}
// store#SupplierQuoteItem: a quote line's offer: its price, quantity, unit, promised date, the supplier's item code and text
// (each change in the line's history), or a new line on a proposed quote with no RFQ item.
function storeQuoteItem(p) {
    requirePermission("PURCHASE_ORDER_EDIT")
    // P16: a supplier's claim prices, dates and codes the quote's own lines; it adds no line and changes no quantity, unit or text
    if (
        orders().portalClaim() &&
        (blank(p.orderItemSeqId) || ["quantity", "quantityUomId", "itemDescription"].some(field => !blank(p[field])))
    )
        denied("RECORD_UNAVAILABLE", "This quote line is not available")
    const po = quoteOf(p.orderId, true)
    const values = {}
    if (given(p, "unitAmount") && !blank(p.unitAmount)) values.unitAmount = decimal(p.unitAmount, "price", true)
    if (given(p, "quantity") && !blank(p.quantity)) values.quantity = decimal(p.quantity, "quantity")
    if (given(p, "quantityUomId")) {
        const uomId = text(p.quantityUomId)
        if (uomId && !one("moqui.basic.Uom", {uomId})) denied("UOM_INVALID", "Choose a unit")
        values.quantityUomId = uomId
    }
    if (given(p, "promisedDate")) values.promisedDate = blank(p.promisedDate) ? null : p.promisedDate
    if (given(p, "otherPartyProductId")) values.otherPartyProductId = text(p.otherPartyProductId)
    if (given(p, "itemDescription")) values.itemDescription = text(p.itemDescription)
    if (p.changeReason)
        ec.context.putAll(Object.fromEntries(Object.keys(values).map(field => [field + "_changeReason", String(p.changeReason)])))
    if (blank(p.orderItemSeqId)) {
        const productId = text(p.productId)
        if (!productId || !one("mantle.product.Product", {productId})) denied("PRODUCT_REQUIRED", "Choose a product")
        productUsable(productId, values.quantity, po.part.facilityId, po.supplierPartyId, po.organizationPartyId)
        const created = call(
            "mantle.order.OrderServices.create#OrderItem",
            Object.assign(
                {orderId: po.orderId, orderPartSeqId: po.orderPartSeqId, productId, itemTypeEnumId: "ItemProduct"},
                {quantity: values.quantity ?? 1, unitAmount: values.unitAmount ?? 0, isModifiedPrice: "Y"},
                values
            )
        )
        return {orderId: po.orderId, orderItemSeqId: created.orderItemSeqId}
    }
    const line = one(ORDER_ITEM, {orderId: po.orderId, orderItemSeqId: p.orderItemSeqId})
    if (!line) denied("ITEM_UNAVAILABLE", "Line " + p.orderItemSeqId + " is not on quote " + po.orderId)
    if (values.unitAmount != null) values.isModifiedPrice = "Y"
    // P12: any change without a price keeps the quoted one (update#OrderItem without a unitAmount prices a product line again
    // by the resolver, whatever field changed; F-P12-4)
    else if (Object.keys(values).length) Object.assign(values, {unitAmount: dec(line.unitAmount), isModifiedPrice: "Y"})
    if (Object.keys(values).length)
        call(
            "mantle.order.OrderServices.update#OrderItem",
            Object.assign({orderId: po.orderId, orderItemSeqId: line.orderItemSeqId}, values, reasonsOf(values, p.changeReason))
        )
    return {orderId: po.orderId, orderItemSeqId: line.orderItemSeqId}
}

// ===== the price publish =====
// A quote an award placed (P12): a purchase order past OrderProposed that was proposed, so its quoted prices still publish.
const awardedStatuses = ["OrderPlaced", "OrderApproved", "OrderSent", "OrderProcessing", "OrderHold", "OrderCompleted"]
const awarded = order =>
    awardedStatuses.includes(order.statusId) &&
    find("moqui.entity.EntityAuditLog", {
        changedEntityName: ORDER,
        changedFieldName: "statusId",
        pkPrimaryValue: order.orderId,
        oldValueText: "OrderProposed"
    }).count() > 0
// publish#SupplierQuotePrice (R-PUR-21): a proposed quote line's price, or a quantity tier of it, made an effective supplier
// price of the buying organization through Products' store#ProductPrice, valid for the quote's validity (from now at the
// earliest), naming the quote and line; a row of the same supplier, product, organization, currency and tier in effect is
// ended where the new one starts (expire#ProductPrice). Under SUPPLIER_PRICE_EDIT only.
function publish(p) {
    requirePermission("SUPPLIER_PRICE_EDIT")
    const po = orders().purchaseOrder(p.orderId, true)
    if (po.order.statusId !== "OrderProposed" && !awarded(po.order))
        denied("QUOTE_NOT_PROPOSED", "Quote " + po.orderId + " has no supplier's answer to publish")
    if (expired(po.part)) denied("QUOTE_EXPIRED", "Quote " + po.orderId + " expired " + dateText(po.part.validThruDate))
    const line = blank(p.orderItemSeqId) ? null : one(ORDER_ITEM, {orderId: po.orderId, orderItemSeqId: p.orderItemSeqId})
    if (!line) denied("ITEM_UNAVAILABLE", "Line " + (p.orderItemSeqId || "") + " is not on quote " + po.orderId)
    if (!line.productId) denied("PRODUCT_REQUIRED", "Line " + line.orderItemSeqId + " has no product to price")
    const price = blank(p.price) ? dec(line.unitAmount) : decimal(p.price, "price", true)
    if (price.isZero()) denied("PRICE_REQUIRED", "Line " + line.orderItemSeqId + " has no quoted price")
    const minQuantity = blank(p.minQuantity) ? dec(0) : decimal(p.minQuantity, "minimum quantity", true)
    const now = Number(ec.user.nowTimestamp)
    // from a second ahead at the earliest, so the row it ends (expire#ProductPrice: an end now or later) ends where it starts
    const fromDate = Math.max(now + 1000, ms(p.fromDate) || 0, ms(po.part.validFromDate) || 0)
    // to the quote's thru date at the latest: the supplier quoted no price after it
    const validThru = po.part.validThruDate ? ms(po.part.validThruDate) : null
    const thruDate = blank(p.thruDate) ? validThru : validThru == null ? ms(p.thruDate) : Math.min(ms(p.thruDate), validThru)
    if (thruDate != null && thruDate <= fromDate) denied("DATE_INVALID", "The price ends after it starts")
    const currencyUomId = po.order.currencyUomId
    const reason = text(p.changeReason) || "Published from quote " + po.orderId + " line " + line.orderItemSeqId
    // the row in effect for the same scope and tier ends where this one starts; a later one is refused
    const scope = {
        productId: line.productId,
        vendorPartyId: po.supplierPartyId,
        customerPartyId: po.organizationPartyId,
        priceTypeEnumId: "PptCurrent",
        pricePurposeEnumId: "PppPurchase",
        priceUomId: currencyUomId
    }
    const endedIds = []
    for (const row of rows("mantle.product.ProductPrice", scope)) {
        // a store's, an agreement's (changed on the agreement, P13) and a per-term price are other scopes
        if (row.productStoreId || row.agreementId || row.termUomId) continue
        if (dec(row.minQuantity).compare(minQuantity) !== 0) continue
        const start = ms(row.fromDate) ?? -Infinity
        const end = ms(row.thruDate) ?? Infinity
        if (end <= fromDate || (thruDate != null && start >= thruDate)) continue
        if (start >= fromDate)
            denied("PRICE_OVERLAP", "Price " + row.productPriceId + " of this tier starts " + dateText(start) + "; end it first")
        call("mantle.product.PriceServices.expire#ProductPrice", {
            productPriceId: row.productPriceId,
            thruDate: new Date(fromDate),
            changeReason: reason
        })
        endedIds.push(row.productPriceId)
    }
    const stored = call(
        "mantle.product.PriceServices.store#ProductPrice",
        Object.assign({}, scope, {
            price,
            minQuantity,
            quantityUomId: line.quantityUomId || null,
            fromDate: new Date(fromDate),
            thruDate: thruDate == null ? null : new Date(thruDate),
            otherPartyItemId: line.otherPartyProductId || null,
            sourceOrderId: po.orderId,
            sourceOrderItemSeqId: line.orderItemSeqId,
            changeReason: reason
        })
    )
    return {productPriceId: stored.productPriceId, endedPriceIds: endedIds, fromDate: new Date(fromDate)}
}

const operations = {create, update, storeItem, invite, print, send, storeQuote, storeQuoteItem, publish}
;({
    rfqType,
    quoteStatuses,
    rfqOf,
    revisionOf,
    invitationsOf,
    sentAtOf,
    publishedOf,
    // P17 (F176): the RFQ as of a time, for the supplier's page of the revision last sent to it
    rfqAt,
    expired,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown sourcing operation " + op)
        return operations[op](parameters || {})
    }
})
