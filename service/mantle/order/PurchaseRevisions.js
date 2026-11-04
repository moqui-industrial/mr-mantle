// Purchase order revisions and acknowledgements (design-purchasing §6 OrderChanges and Acknowledgements; impl-purchasing P9,
// §2, §4, F7, F17, F18, F36): no revision or acknowledgement record. A revision is OrderHeader.orderRevision and its time,
// its changes the audit-logged key fields with their reason; the supplier's acknowledgement is the part's reference and date,
// the revision it acknowledged and its outcome, and each line's promise, audit-logged.
// - start#PurchaseRevision locks a placed, approved or sent order with a Change hold (a sent one un-sends to Approved first,
//   D7), its source the revision it starts from; cancel#PurchaseRevision releases a hold nothing was applied under.
// - preview#PurchaseRevision answers the proposed changes beside each line's received, billed, returned and accepted
//   quantities, open receipts and amounts, with the refusals by name and a basis key of what was posted.
// - apply#PurchaseRevision, in one transaction: the open receipts and the order locked, the changes written with their reason,
//   the revision counted once (increment#OrderRevision, X2), the open receipts set to the new remainders
//   (adjust#ExpectedReceipt), the lowered lines' budget commitments released to what they still need
//   (lower#SourceCommitments), the bills matched against a changed line queued for re-evaluation (queue#MatchReevaluation)
//   and the new revision sent to its approvers. A receipt posted since the preview fails it (RECEIPT_IN_PROGRESS) and nothing
//   changes; a cut below what was received, billed, returned or accepted, and a supplier or currency change on a part that
//   was received or billed, are refused.
// - The approval of the new revision is decide#PurchaseApproval's (PurchaseOrders.js): its last step releases the revision's
//   Change hold (releaseRevisionHold), and the buyer sends the new revision (send#PurchaseOrder), whose PDF is stored.
// - record#Acknowledgement and send#PurchaseReminder (a result per order and per recipient, once per revision, template and
//   occurrence).
// A revision's own writes do not count one by one (increment#OrderRevision returns while the order's count is held here).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const orders = ec.resource.script("component://mr-mantle/service/mantle/order/PurchaseOrders.js")
const policy = ec.resource.script("component://mr-mantle/service/mantle/order/PurchasePolicy.js")
const remainders = ec.resource.script("component://mr-mantle/service/mantle/order/PurchaseRemainders.js")
const receiving = () => ec.resource.script("component://mr-mantle/service/mantle/shipment/Receiving.js")
const approvals = () => ec.resource.script("component://mr-mantle/service/mantle/order/PurchaseApprovals.js")
const documents = () => ec.resource.script("component://mr-mantle/service/mantle/order/PurchaseOrderDocuments.js")
// P13 review: a line released from a purchase agreement (PurchaseAgreements.js)
const agreements = () => ec.resource.script("component://mr-mantle/service/mantle/party/PurchaseAgreements.js")
const {find, one, rows, call, denied, ms} = lib

const ORDER = "mantle.order.OrderHeader",
    PART = "mantle.order.OrderPart",
    ITEM = "mantle.order.OrderItem",
    HOLD = "mantle.order.OrderHoldReason"
// the statuses a purchase order is revised in: placed, approved, sent, processing, or already held
const revisableStatuses = ["OrderPlaced", "OrderProcessing", "OrderApproved", "OrderSent", "OrderHold"]
// the statuses a supplier acknowledges or is reminded in: the order went out
const acknowledgeStatuses = ["OrderApproved", "OrderSent", "OrderProcessing", "OrderHold"]
const outcomes = ["PakAccepted", "PakChanged", "PakRejected"]
const itemFields = ["productId", "quantity", "unitAmount", "requiredByDate", "itemDescription"]
const partFields = [
    "vendorPartyId",
    "facilityId",
    "postalContactMechId",
    "estimatedDeliveryDate",
    "settlementTermId",
    "tradeTermEnumId"
]
const fieldLabels = {
    productId: "Product",
    quantity: "Quantity",
    unitAmount: "Price",
    requiredByDate: "Required by",
    itemDescription: "Description",
    quantityUomId: "Unit",
    quantityCancelled: "Cancelled",
    costCenterId: "Cost centre",
    vendorPartyId: "Supplier",
    facilityId: "Receive at",
    postalContactMechId: "Ship to",
    estimatedDeliveryDate: "Delivery by",
    settlementTermId: "Payment term",
    tradeTermEnumId: "Incoterm",
    currencyUomId: "Currency",
    otherPartyOrderId: "Supplier reference",
    otherPartyOrderDate: "Supplier's date",
    acknowledgedRevision: "Acknowledged revision",
    acknowledgementEnumId: "Acknowledgement",
    acknowledgementNote: "Supplier's note",
    promisedDate: "Promised date",
    promisedQuantity: "Promised quantity"
}
const dateFields = ["requiredByDate", "estimatedDeliveryDate", "otherPartyOrderDate", "promisedDate"]
const decimalFields = ["quantity", "unitAmount", "promisedQuantity", "quantityCancelled"]
const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const zero = () => toDecimal(0)
const dec = value => toDecimal(value ?? 0)
const quantityText = value => (value == null ? "" : ec.l10n.format(toDecimal(value), "#,##0.###"))
const partyName = partyId => lib.partyNames([partyId])[partyId] || partyId || ""
const revisionOf = order => Number(order.orderRevision ?? 1)

// ===== the order's count =====
// Run the writes of a revision, an acknowledgement or a hold with the order's revision count held: increment#OrderRevision
// leaves them uncounted, and the caller counts the revision once (or not at all) itself.
function uncounted(orderId, write) {
    const flag = "PurchaseRevisionCount:" + orderId
    const before = ec.context.sharedMap[flag]
    ec.context.sharedMap[flag] = true
    try {
        return write()
    } finally {
        if (before) ec.context.sharedMap[flag] = before
        else delete ec.context.sharedMap[flag]
    }
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

// ===== the revision's hold =====
// The open Change hold of an order, the newest; its sourceId is the revision the change started from.
function changeHold(orderId) {
    return (
        rows(HOLD, {orderId, holdTypeEnumId: "OhtChange"})
            .filter(row => !row.releasedDate)
            .sort((a, b) => ms(b.placedDate) - ms(a.placedDate))[0] || null
    )
}
// The order's revision state: none, started (the hold, nothing applied yet) or applied (a new revision written under the hold
// by apply, its appliedRevision, waiting for its approval). The order's own count is not the marker: by default a note or a
// receipt's status change moves it while a change is only started. A Change hold with no source is not a revision's.
function revisionState(order) {
    const hold = changeHold(order.orderId)
    if (!hold || blank(hold.sourceId)) return {state: "none", hold: null}
    return {state: blank(hold.appliedRevision) ? "started" : "applied", hold}
}
// The Change hold of a held order whose new revision waits for its approval (decide#PurchaseApproval), else null.
function awaitingApproval(po) {
    const current = revisionState(po.order)
    return po.order.statusId === "OrderHold" && current.state === "applied" ? current.hold : null
}
// Release a revision's Change hold as release#OrderHold does (the order back to the reason's return status when no other
// reason is open), by the approval of the revision or the buyer's cancel of an unapplied change: the hold is the revision's
// lock, not a release by OhtChange's permission. Answers the order's status after.
function releaseRevisionHold(hold, comment) {
    return uncounted(hold.orderId, () => {
        call("update#" + HOLD, {
            orderHoldReasonId: hold.orderHoldReasonId,
            releasedByUserId: ec.user.userId,
            releasedDate: ec.user.nowTimestamp,
            releaseComment: comment
        })
        const order = one(ORDER, {orderId: hold.orderId})
        const stillHeld = rows(HOLD, {orderId: hold.orderId}).some(row => !row.releasedDate)
        if (!stillHeld && order.statusId === "OrderHold") {
            const returnTo = hold.returnStatusId || "OrderPlaced"
            call("mantle.order.OrderServices.update#OrderStatus", {
                orderId: hold.orderId,
                statusId: returnTo,
                approvedDate: returnTo === "OrderApproved" ? ec.user.nowTimestamp : null
            })
        }
        return {statusId: one(ORDER, {orderId: hold.orderId}).statusId, stillHeld}
    })
}
// release#OrderHold of a revision's Change hold by an ORDER_APPROVE holder (F-P9-2): with the approval gate on, an applied
// revision not approved at its revision returns to Placed for its approval, not to Approved or Sent past the gate. Answers the
// status to return to.
function releaseReturn(hold, returnTo) {
    if (hold?.holdTypeEnumId !== "OhtChange" || blank(hold.sourceId) || blank(hold.appliedRevision)) return returnTo
    if (!["OrderApproved", "OrderSent"].includes(returnTo)) return returnTo
    return orders.approvalWarnings(hold.orderId).length ? "OrderPlaced" : returnTo
}

// ===== what each line has behind it =====
// Each line's ordered quantity and what was received (accepted and rejected, in the line's unit), billed, returned to the
// supplier and accepted (a service line), the quantity on open receipts, and its amount.
function lineFacts(po) {
    const items = rows(ITEM, {orderId: po.orderId})
        .filter(item => !item.parentItemSeqId)
        .sort((a, b) => String(a.orderItemSeqId).localeCompare(String(b.orderItemSeqId)))
    const billed = {}
    for (const row of rows("mantle.order.OrderItemBilling", {orderId: po.orderId}))
        billed[row.orderItemSeqId] = (billed[row.orderItemSeqId] || zero()).add(dec(row.quantity))
    const returned = {}
    for (const row of rows("mantle.order.return.ReturnItem", {orderId: po.orderId}).filter(
        row => !["ReturnCancelled", "ReturnRejected"].includes(row.statusId)
    ))
        returned[row.orderItemSeqId] = (returned[row.orderItemSeqId] || zero()).add(dec(row.returnQuantity))
    const accepted = {}
    for (const row of rows("mantle.order.purchase.ServiceAcceptance", {orderId: po.orderId}))
        accepted[row.orderItemSeqId] = (accepted[row.orderItemSeqId] || zero()).add(dec(row.acceptedQuantity))
    const sources = rows("mantle.shipment.ShipmentItemSource", {orderId: po.orderId}).filter(
        row => row.statusId !== "SisCancelled"
    )
    const facts = {}
    for (const item of items) {
        const product = item.productId ? one("mantle.product.Product", {productId: item.productId}) : null
        let factor = toDecimal(1)
        try {
            if (product) factor = remainders.lineFactor(item, product)
        } catch (error) {
            ec.logger.warn("Purchase order " + po.orderId + " line " + item.orderItemSeqId + ": " + error.message)
        }
        const receivedStock = remainders.receivedOf(po.orderId, item.orderItemSeqId).total
        const received = factor.isZero() ? receivedStock : receivedStock.divide(factor, 6, "HALF_UP")
        const expected = sources
            .filter(row => row.orderItemSeqId === item.orderItemSeqId)
            .reduce((sum, row) => sum.add(dec(row.quantityNotHandled)), zero())
        const lineBilled = billed[item.orderItemSeqId] || zero()
        const lineReturned = returned[item.orderItemSeqId] || zero()
        const lineAccepted = accepted[item.orderItemSeqId] || zero()
        let floor = received
        for (const value of [lineBilled, lineReturned, lineAccepted]) if (value.compare(floor) > 0) floor = value
        facts[item.orderItemSeqId] = {
            item,
            product,
            received,
            billed: lineBilled,
            returned: lineReturned,
            accepted: lineAccepted,
            expected,
            onReceipt: sources.some(row => row.orderItemSeqId === item.orderItemSeqId),
            floor,
            progressed: floor.compare(0) > 0
        }
    }
    return facts
}
// The key of what was posted on the order when the change was reviewed: each line's received and billed quantities, so an
// apply sees a receipt or a bill posted since (RECEIPT_IN_PROGRESS).
function basisOf(revision, facts) {
    return lib.hash({
        revision,
        lines: Object.values(facts).map(fact => [fact.item.orderItemSeqId, String(fact.received), String(fact.billed)])
    })
}

// ===== the proposed change =====
function sameValue(field, oldValue, newValue) {
    if (blank(oldValue) && blank(newValue)) return true
    if (blank(oldValue) || blank(newValue)) return false
    if (decimalFields.includes(field)) {
        try {
            return toDecimal(oldValue).eq(toDecimal(newValue))
        } catch (_) {
            return false
        }
    }
    if (dateFields.includes(field)) return lib.dateText(oldValue) === lib.dateText(newValue)
    return String(oldValue) === String(newValue)
}
// A value as text for the change rows (names for parties, terms and products; amounts as given, the screen withholds them).
function valueText(field, value, currencyUomId) {
    if (blank(value)) return ""
    if (dateFields.includes(field)) return lib.dateText(value)
    if (field === "unitAmount") return ec.l10n.formatCurrency(dec(value), currencyUomId)
    if (decimalFields.includes(field) || field === "acknowledgedRevision") return quantityText(value)
    if (field === "vendorPartyId") return partyName(value)
    if (field === "productId") {
        const product = one("mantle.product.Product", {productId: value})
        return product ? (product.pseudoId || product.productId) + " · " + (product.productName || "") : String(value)
    }
    if (field === "facilityId") return one("mantle.facility.Facility", {facilityId: value})?.facilityName || String(value)
    if (field === "settlementTermId")
        return one("mantle.account.invoice.SettlementTerm", {settlementTermId: value})?.description || String(value)
    if (field === "postalContactMechId") {
        const address = one("mantle.party.contact.PostalAddress", {contactMechId: value})
        return address ? [address.address1, address.city].filter(Boolean).join(", ") : String(value)
    }
    if (["tradeTermEnumId", "acknowledgementEnumId"].includes(field))
        return one("moqui.basic.Enumeration", {enumId: value})?.description || String(value)
    return String(value)
}
// The proposed changes as change rows, each with its refusal (null when it may be applied): itemChanges (orderItemSeqId with
// the new quantity, price, required date, description or product) and partChanges (the supplier, currency, receiving
// facility, ship-to address, delivery date, payment term and incoterm).
function proposed(po, facts, p) {
    const order = po.order
    const currency = order.currencyUomId
    const changeRows = []
    const lineAmounts = {}
    const progressedPart = Object.values(facts).some(fact => fact.received.compare(0) > 0 || fact.billed.compare(0) > 0)
    const substitution = policy.effective(po.organizationPartyId).policy.substitutionEnumId || "PsbNotAllowed"
    const row = (entity, seq, field, oldValue, newValue, refusal) =>
        changeRows.push({
            entity,
            orderItemSeqId: seq,
            field,
            whatText: (seq ? "Line " + seq + " " : "") + fieldLabels[field],
            oldValue: oldValue == null ? null : String(oldValue),
            newValue: newValue == null ? null : String(newValue),
            fromText: valueText(field, oldValue, currency),
            toText: valueText(field, newValue, currency),
            refusalCode: refusal ? refusal[0] : null,
            refusalText: refusal ? refusal[1] : ""
        })
    for (const change of Array.from(p.itemChanges || [])) {
        const seq = text(change.orderItemSeqId)
        const fact = seq ? facts[seq] : null
        if (!fact) denied("ITEM_UNAVAILABLE", "Line " + (seq || "") + " is not on purchase order " + po.orderId)
        const item = fact.item
        let quantity = dec(item.quantity),
            price = dec(item.unitAmount)
        for (const field of itemFields) {
            if (!Object.hasOwn(change, field) || change[field] === undefined) continue
            const newValue = blank(change[field]) ? null : change[field]
            if (field !== "requiredByDate" && field !== "itemDescription" && newValue == null) continue
            if (sameValue(field, item[field], newValue)) continue
            let refusal = null
            if (field === "quantity") {
                let number = null
                try {
                    number = toDecimal(newValue)
                } catch (_) {}
                if (number == null || number.compare(0) < 0) refusal = ["QUANTITY_INVALID", "Enter a quantity of zero or more"]
                else if (number.compare(fact.received) < 0)
                    refusal = [
                        "QUANTITY_BELOW_RECEIVED",
                        "Line " + seq + " has " + quantityText(fact.received) + " received; it cannot go below that"
                    ]
                else if (number.compare(fact.billed) < 0)
                    refusal = [
                        "QUANTITY_BELOW_BILLED",
                        "Line " + seq + " has " + quantityText(fact.billed) + " billed; it cannot go below that"
                    ]
                else if (number.compare(fact.returned) < 0)
                    refusal = [
                        "QUANTITY_BELOW_RETURNED",
                        "Line " + seq + " has " + quantityText(fact.returned) + " returned; it cannot go below that"
                    ]
                else if (number.compare(fact.accepted) < 0)
                    refusal = [
                        "QUANTITY_BELOW_ACCEPTED",
                        "Line " + seq + " has " + quantityText(fact.accepted) + " accepted; it cannot go below that"
                    ]
                else {
                    // P13 review: a line released from an agreement takes no more than its releases
                    refusal = agreements().releasedLineRefusal(po.orderId, seq, number, null)
                    if (!refusal) quantity = number
                }
            } else if (field === "unitAmount") {
                let number = null
                try {
                    number = toDecimal(newValue)
                } catch (_) {}
                if (number == null || number.compare(0) < 0) refusal = ["PRICE_INVALID", "Enter a price of zero or more"]
                else {
                    // P13 review: nor a higher price than its releases' agreement price
                    refusal = agreements().releasedLineRefusal(po.orderId, seq, null, number)
                    if (!refusal) price = number
                }
            } else if (field === "productId") {
                if (substitution !== "PsbAllowed")
                    refusal = ["SUBSTITUTION_NOT_ALLOWED", "The buying policy allows no substitute on a revision"]
                else if (fact.progressed || fact.onReceipt)
                    refusal = [
                        "SUBSTITUTE_PROGRESSED",
                        "Line " + seq + " was received, billed or expected on a receipt; close it and add a line instead"
                    ]
                else {
                    const usable = call("mantle.product.ProductServices.check#ProductUsable", {
                        productId: newValue,
                        usage: "Purchase",
                        quantity,
                        vendorPartyId: po.supplierPartyId,
                        customerPartyId: po.organizationPartyId
                    })
                    if (!usable.usable) refusal = ["PRODUCT_NOT_USABLE", usable.reason || newValue + " is not usable for buying"]
                }
            }
            row(ITEM, seq, field, item[field], newValue, refusal)
        }
        lineAmounts[seq] = {
            from: ec.l10n.roundCurrency(dec(item.quantity).multiply(dec(item.unitAmount)), currency),
            to: ec.l10n.roundCurrency(quantity.multiply(price), currency)
        }
    }
    const partChanges = p.partChanges || {}
    for (const field of partFields.concat(["currencyUomId"])) {
        if (!Object.hasOwn(partChanges, field) || partChanges[field] === undefined) continue
        const newValue = blank(partChanges[field]) ? null : partChanges[field]
        const oldValue = field === "currencyUomId" ? order.currencyUomId : po.part[field]
        if (["vendorPartyId", "currencyUomId", "facilityId"].includes(field) && newValue == null) continue
        if (sameValue(field, oldValue, newValue)) continue
        let refusal = null
        if (field === "vendorPartyId") {
            if (progressedPart)
                refusal = [
                    "SUPPLIER_CHANGE_PROGRESSED",
                    "Purchase order " + po.orderId + " was received or billed; its supplier stays"
                ]
            else {
                const checked = lib.check(() => orders.supplierOf(po.organizationPartyId, newValue))
                const usable = checked.allowed ? policy.supplierUsable(po.organizationPartyId, newValue) : null
                if (!checked.allowed) refusal = [checked.reasonCode, "Choose an available supplier"]
                else if (usable.result === "STOP") refusal = [usable.reasonCode, usable.message]
            }
        } else if (field === "currencyUomId") {
            if (progressedPart)
                refusal = [
                    "CURRENCY_CHANGE_PROGRESSED",
                    "Purchase order " + po.orderId + " was received or billed; its currency stays"
                ]
            else if (one("moqui.basic.Uom", {uomId: newValue})?.uomTypeEnumId !== "UT_CURRENCY_MEASURE")
                refusal = ["CURRENCY_INVALID", "Choose a currency"]
        } else if (field === "facilityId") {
            if (one("mantle.facility.Facility", {facilityId: newValue})?.ownerPartyId !== po.organizationPartyId)
                refusal = ["FACILITY_INVALID", "Choose a facility of " + partyName(po.organizationPartyId)]
            else if (Object.values(facts).some(fact => fact.onReceipt))
                refusal = ["FACILITY_ON_RECEIPT", "Purchase order " + po.orderId + " is expected on a receipt at its facility"]
        } else if (field === "settlementTermId" && newValue) {
            if (!one("mantle.account.invoice.SettlementTerm", {settlementTermId: newValue}))
                refusal = ["TERM_INVALID", "Choose a payment term"]
        } else if (field === "tradeTermEnumId" && newValue) {
            if (one("moqui.basic.Enumeration", {enumId: newValue})?.parentEnumId !== "TtInco")
                refusal = ["TERM_INVALID", "Choose an incoterm"]
        } else if (field === "postalContactMechId" && newValue) {
            if (!one("mantle.party.contact.PostalAddress", {contactMechId: newValue}))
                refusal = ["ADDRESS_INVALID", "Choose a postal address"]
        }
        row(field === "currencyUomId" ? ORDER : PART, null, field, oldValue, newValue, refusal)
    }
    let fromTotal = zero(),
        toTotal = zero()
    for (const amounts of Object.values(lineAmounts)) {
        fromTotal = fromTotal.add(amounts.from)
        toTotal = toTotal.add(amounts.to)
    }
    return {changeRows, lineAmounts, amountDelta: toTotal.subtract(fromTotal)}
}

// ===== start, cancel, preview, apply =====
// start#PurchaseRevision: a Change hold on a placed, approved or sent order (a sent one un-sends first), from its revision.
function start(p) {
    orders.requirePermission("PURCHASE_ORDER_EDIT")
    const po = orders.purchaseOrder(p.orderId, true)
    const revision = revisionOf(po.order)
    if (!revisableStatuses.includes(po.order.statusId))
        denied(
            "ORDER_NOT_REVISABLE",
            "Purchase order " + po.orderId + (po.order.statusId === "OrderOpen" ? " is a draft; edit it" : " cannot change now")
        )
    if (!blank(p.orderRevision) && Number(p.orderRevision) !== revision)
        denied("STALE_REVISION", "Purchase order " + po.orderId + " is at revision " + revision + "; review it again")
    const existing = changeHold(po.orderId)
    if (existing)
        return {orderId: po.orderId, orderRevision: revision, orderHoldReasonId: existing.orderHoldReasonId, alreadyStarted: true}
    const reason = text(p.reason)
    if (!reason) denied("REASON_REQUIRED", "Give the reason for changing purchase order " + po.orderId)
    const held = uncounted(po.orderId, () =>
        call("mantle.order.OrderServices.hold#Order", {
            orderId: po.orderId,
            holdTypeEnumId: "OhtChange",
            sourceId: String(revision),
            holdComment: reason
        })
    )
    return {
        orderId: po.orderId,
        orderRevision: revision,
        orderHoldReasonId: held.orderHoldReasonId,
        statusId: one(ORDER, {orderId: po.orderId}).statusId,
        alreadyStarted: false
    }
}
// cancel#PurchaseRevision: a change started and not applied is let go; the order returns to where it was.
function cancel(p) {
    orders.requirePermission("PURCHASE_ORDER_EDIT")
    const po = orders.purchaseOrder(p.orderId, true)
    const current = revisionState(po.order)
    if (current.state === "none") denied("REVISION_NOT_STARTED", "No change of purchase order " + po.orderId + " is open")
    if (current.state === "applied")
        denied(
            "REVISION_APPLIED",
            "Revision " +
                revisionOf(po.order) +
                " of purchase order " +
                po.orderId +
                " waits for its approval; change it again or ask an approver"
        )
    const released = releaseRevisionHold(current.hold, text(p.reason) || "Change cancelled")
    return {orderId: po.orderId, statusId: released.statusId}
}
// The order's state for a preview or an apply: the change rows, what each line has behind it and the basis key.
function review(po, p) {
    const facts = lineFacts(po)
    const change = proposed(po, facts, p)
    const revision = revisionOf(po.order)
    const current = revisionState(po.order)
    const budgetRows = Object.entries(change.lineAmounts)
        .filter(([, amounts]) => !amounts.from.eq(amounts.to))
        .map(([seq, amounts]) => ({orderItemSeqId: seq, fromAmount: amounts.from, toAmount: amounts.to}))
    return {facts, change, revision, current, budgetRows, basisKey: basisOf(revision, facts)}
}
// preview#PurchaseRevision: the proposed changes and their effects, nothing written.
function preview(p) {
    orders.requirePermission("PURCHASE_ORDER_EDIT", "PURCHASE_APPROVE")
    const po = orders.purchaseOrder(p.orderId)
    const reviewed = review(po, p)
    const currency = po.order.currencyUomId
    const lineRows = Object.values(reviewed.facts).map(fact => ({
        orderItemSeqId: fact.item.orderItemSeqId,
        productId: fact.item.productId || null,
        productText: valueText("productId", fact.item.productId, currency),
        quantity: fact.item.quantity,
        quantityText: quantityText(fact.item.quantity),
        unitAmount: fact.item.unitAmount,
        requiredByDate: fact.item.requiredByDate || null,
        requiredText: lib.dateText(fact.item.requiredByDate),
        promisedText: lib.dateText(fact.item.promisedDate),
        itemDescription: fact.item.itemDescription || "",
        receivedText: quantityText(fact.received),
        billedText: quantityText(fact.billed),
        returnedText: quantityText(fact.returned),
        acceptedText: quantityText(fact.accepted),
        expectedText: quantityText(fact.expected),
        floorText: quantityText(fact.floor),
        onReceipt: fact.onReceipt
    }))
    const refusals = reviewed.change.changeRows.filter(row => row.refusalCode)
    // the part's values a change starts from, with their text
    const partValues = {currencyUomId: po.order.currencyUomId || null}
    for (const field of partFields) partValues[field] = po.part[field] ?? null
    if (partValues.estimatedDeliveryDate) partValues.estimatedDeliveryDate = lib.dateText(partValues.estimatedDeliveryDate)
    const partTexts = Object.fromEntries(
        Object.entries(partValues).map(([field, value]) => [field, valueText(field, value, currency)])
    )
    return {
        orderId: po.orderId,
        partValues,
        partTexts,
        orderRevision: reviewed.revision,
        proposedRevision: reviewed.revision + 1,
        revisionState: reviewed.current.state,
        statusId: po.order.statusId,
        changeRows: reviewed.change.changeRows,
        lineRows,
        budgetRows: reviewed.budgetRows.map(row =>
            Object.assign(row, {
                fromText: ec.l10n.formatCurrency(row.fromAmount, currency),
                toText: ec.l10n.formatCurrency(row.toAmount, currency)
            })
        ),
        amountDelta: reviewed.change.amountDelta,
        amountDeltaText: ec.l10n.formatCurrency(reviewed.change.amountDelta, currency),
        openReceipt: lineRows.some(row => row.onReceipt),
        refusalCount: refusals.length,
        canApply: reviewed.current.state !== "none" && !refusals.length && reviewed.change.changeRows.length > 0,
        basisKey: reviewed.basisKey
    }
}
// apply#PurchaseRevision: the reviewed changes, in one transaction with their effects (the module's comment above).
function apply(p) {
    orders.requirePermission("PURCHASE_ORDER_EDIT")
    // the open receipts first, as the receive guard locks them (receipt, then order), so a receive in progress finishes first
    const unlocked = orders.purchaseOrder(p.orderId)
    const receiptIds = [
        ...new Set(
            rows(PART, {orderId: unlocked.orderId})
                .map(part => receiving().openReceipt(unlocked.orderId, part.orderPartSeqId, null))
                .filter(Boolean)
        )
    ].sort()
    for (const shipmentId of receiptIds) find("mantle.shipment.Shipment", {shipmentId}).forUpdate(true).one()
    const po = orders.purchaseOrder(p.orderId, true)
    const request = {
        orderId: po.orderId,
        orderRevision: blank(p.orderRevision) ? null : Number(p.orderRevision),
        itemChanges: Array.from(p.itemChanges || []),
        partChanges: p.partChanges || {},
        reason: text(p.reason)
    }
    const operation = blank(p.operationKey) ? null : lib.operation(p, "PurchaseRevision", po.organizationPartyId, request)
    if (operation?.old) return lib.previous(operation)
    const reviewed = review(po, p)
    if (reviewed.current.state === "none")
        denied("REVISION_NOT_STARTED", "Start the change of purchase order " + po.orderId + " first; it holds the order")
    if (!blank(p.orderRevision) && Number(p.orderRevision) !== reviewed.revision)
        denied("STALE_REVISION", "Purchase order " + po.orderId + " is at revision " + reviewed.revision + "; review it again")
    if (!blank(p.basisKey) && p.basisKey !== reviewed.basisKey)
        denied(
            "RECEIPT_IN_PROGRESS",
            "A receipt or bill of purchase order " + po.orderId + " was posted while the change was reviewed; review it again"
        )
    const changeRows = reviewed.change.changeRows
    const refusals = changeRows.filter(row => row.refusalCode)
    if (refusals.length) denied(refusals[0].refusalCode, refusals.map(row => row.refusalText).join("; "))
    if (!changeRows.length) denied("NO_CHANGE", "Nothing is changed on purchase order " + po.orderId)
    const reason = text(p.reason)
    if (!reason) denied("REASON_REQUIRED", "Give the reason for revision " + (reviewed.revision + 1))
    const fromRevision = reviewed.revision

    // the changes, with their reason, uncounted; then the revision once
    uncounted(po.orderId, () => {
        withReason(Object.keys(fieldLabels), reason, () => {
            const headerRow = changeRows.find(row => row.entity === ORDER)
            if (headerRow) call("update#" + ORDER, {orderId: po.orderId, currencyUomId: headerRow.newValue})
            const partValues = {}
            for (const row of changeRows.filter(row => row.entity === PART)) partValues[row.field] = row.newValue
            if (Object.keys(partValues).length)
                call("update#" + PART, Object.assign({orderId: po.orderId, orderPartSeqId: po.orderPartSeqId}, partValues))
            const bySeq = {}
            for (const row of changeRows.filter(row => row.entity === ITEM))
                (bySeq[row.orderItemSeqId] = bySeq[row.orderItemSeqId] || {})[row.field] = row.newValue
            for (const [orderItemSeqId, values] of Object.entries(bySeq)) {
                const changes = Object.assign({orderId: po.orderId, orderItemSeqId}, values)
                if (Object.hasOwn(values, "unitAmount")) changes.isModifiedPrice = "Y"
                if (Object.hasOwn(values, "productId")) changes.productPriceId = null
                call("update#" + ITEM, changes)
            }
        })
        call("create#mantle.order.OrderNote", {
            orderId: po.orderId,
            noteDate: ec.user.nowTimestamp,
            noteText: "Revision " + (fromRevision + 1) + ": " + reason,
            internalNote: "Y",
            userId: ec.user.userId
        })
    })
    call("mantle.order.OrderServices.increment#OrderRevision", {orderId: po.orderId, revisionKind: "commercial"})
    const revision = revisionOf(one(ORDER, {orderId: po.orderId}))
    // the hold now waits for the approval of this revision (revisionState)
    call("update#" + HOLD, {orderHoldReasonId: reviewed.current.hold.orderHoldReasonId, appliedRevision: revision})
    const quantityChanged = changeRows.some(row => row.entity === ITEM && row.field === "quantity")

    // the open receipts to the new remainders (Warehouse's contract, in this transaction)
    let adjustedSources = []
    // a receipt opened since the receipts were locked is on a line's facts too (read under the order's lock)
    if (quantityChanged && (receiptIds.length || Object.values(reviewed.facts).some(fact => fact.onReceipt))) {
        const adjusted = call("mantle.shipment.WarehouseTaskServices.adjust#ExpectedReceipt", {
            operationKey: "rev-" + po.orderId + "-" + revision,
            orderId: po.orderId,
            orderPartSeqId: po.orderPartSeqId
        })
        adjustedSources = Array.from(adjusted.result?.sources || [])
    }
    // the budget a lowered line no longer needs (Accounting's contract); a raised line is the approval's to reserve
    const loweredLines = reviewed.budgetRows.length
        ? Array.from(
              call("mantle.other.BudgetServices.lower#SourceCommitments", {
                  sourceEntityName: ORDER,
                  sourceId: po.orderId,
                  sourceRevision: String(revision),
                  stageEnumId: "BcsOrder",
                  lines: reviewed.budgetRows.map(row => ({sourceItemId: row.orderItemSeqId, amount: row.toAmount}))
              }).loweredLines || []
          )
        : []
    // the bills matched against a changed line, for the re-evaluation job (Accounting's contract)
    let queuedCount = 0
    for (const orderItemSeqId of new Set(
        changeRows.filter(row => row.entity === ITEM && row.field !== "itemDescription").map(row => row.orderItemSeqId)
    ))
        queuedCount += Number(
            call("mantle.account.InvoiceMatchServices.queue#MatchReevaluation", {
                orderId: po.orderId,
                orderItemSeqId,
                staleReason: "Purchase order " + po.orderId + " revision " + revision
            }).queuedCount || 0
        )
    // the new revision to its approvers (PurchaseOrderApproval), its decision releasing the hold
    const after = orders.purchaseOrder(po.orderId)
    approvals().notify(approvals().orderSource(after))
    const result = {
        orderId: po.orderId,
        fromRevision,
        orderRevision: revision,
        changeRows: changeRows.map(row => ({
            whatText: row.whatText,
            field: row.field,
            orderItemSeqId: row.orderItemSeqId,
            fromText: row.fromText,
            toText: row.toText
        })),
        adjustedSources,
        loweredLines: loweredLines.map(row => ({
            sourceItemId: row.sourceItemId,
            fromAmount: String(row.fromAmount),
            amount: String(row.amount),
            budgetCommitmentId: row.budgetCommitmentId
        })),
        queuedCount,
        statusId: one(ORDER, {orderId: po.orderId}).statusId
    }
    if (operation) lib.complete(operation, ORDER, po.orderId, result)
    return Object.assign(result, {alreadyApplied: false})
}

// ===== a revision's changes, from the audit log =====
// The order's revisions: each revision's time and what changed in it (the key fields logged after the revision before it and
// up to its own), newest first, with the reason given. The first is the order as entered.
function revisionList(orderId) {
    const order = one(ORDER, {orderId})
    if (!order) return []
    const counter = Array.from(
        find("moqui.entity.EntityAuditLog")
            .condition("changedEntityName", ORDER)
            .condition("changedFieldName", "orderRevision")
            .condition("pkPrimaryValue", orderId)
            .orderBy("changedDate")
            .list()
    )
    const times = {1: ms(order.entryDate)}
    for (const row of counter) if (row.newValueText != null) times[Number(row.newValueText)] = ms(row.changedDate)
    const logs = Array.from(
        find("moqui.entity.EntityAuditLog")
            .condition("changedEntityName", "in", [ORDER, PART, ITEM])
            .condition("pkPrimaryValue", orderId)
            .condition(
                "changedFieldName",
                "in",
                itemFields.concat(partFields, ["currencyUomId", "quantityUomId", "quantityCancelled", "costCenterId"])
            )
            .orderBy("changedDate")
            .limit(1000)
            .list()
    ).filter(row => row.oldValueText != null)
    const revisions = Object.keys(times)
        .map(Number)
        .sort((a, b) => a - b)
    return revisions
        .map((revision, index) => {
            const from = index ? times[revisions[index - 1]] : null
            const thru = times[revision]
            const changes = index ? logs.filter(row => ms(row.changedDate) > from && ms(row.changedDate) <= thru) : []
            return {
                revision,
                revisionDate: thru,
                changes: changes.map(row => ({
                    field: row.changedFieldName,
                    orderItemSeqId: row.changedEntityName === ITEM ? row.pkSecondaryValue : null,
                    whatText:
                        (row.changedEntityName === ITEM ? "Line " + row.pkSecondaryValue + " " : "") +
                        (fieldLabels[row.changedFieldName] || row.changedFieldName),
                    fromText: valueText(row.changedFieldName, row.oldValueText, order.currencyUomId),
                    toText: valueText(row.changedFieldName, row.newValueText, order.currencyUomId),
                    reason: row.changeReason || "",
                    changedByUserId: row.changedByUserId || null
                }))
            }
        })
        .reverse()
}
// One revision's changes, for its print (withPrices false leaves the price rows out).
function revisionChanges(orderId, revision, withPrices = true) {
    const found = revisionList(orderId).find(row => row.revision === Number(revision))
    return (found?.changes || []).filter(row => withPrices || row.field !== "unitAmount")
}

// ===== the acknowledgement =====
// record#Acknowledgement: the supplier's response to the order's current revision, entered on its behalf: its reference and
// date, the outcome and note, each line's promised date and quantity (the requested date and the ordered quantity stay: a
// supplier's promise changes no order line), and the evidence as the order's content in the supplier's role. An older
// revision is refused naming the current one.
function acknowledge(p) {
    orders.requirePermission("PURCHASE_ORDER_EDIT")
    const po = orders.purchaseOrder(p.orderId, true)
    const revision = revisionOf(po.order)
    const request = {
        orderId: po.orderId,
        orderRevision: blank(p.orderRevision) ? null : Number(p.orderRevision),
        outcome: text(p.acknowledgementEnumId),
        lines: Array.from(p.lineAcknowledgements || [])
    }
    const operation = blank(p.operationKey) ? null : lib.operation(p, "PurchaseAcknowledgement", po.organizationPartyId, request)
    if (operation?.old) return lib.previous(operation)
    if (!acknowledgeStatuses.includes(po.order.statusId))
        denied("ORDER_NOT_SENT", "Purchase order " + po.orderId + " is acknowledged once it is approved and sent")
    if (!blank(p.orderRevision) && Number(p.orderRevision) !== revision)
        denied(
            "SUPERSEDED_REVISION",
            "Revision " + p.orderRevision + " of purchase order " + po.orderId + " is superseded by revision " + revision
        )
    // a line's promise alone keeps the revision's acknowledgement as recorded (accepted when there is none yet)
    const sameRevision = Number(po.part.acknowledgedRevision ?? 0) === revision
    const outcome = text(p.acknowledgementEnumId) || (sameRevision ? po.part.acknowledgementEnumId : null) || "PakAccepted"
    if (!outcomes.includes(outcome)) denied("OUTCOME_INVALID", "Choose accepted, accepted with changes or rejected")
    const note = text(p.acknowledgementNote) || (sameRevision ? text(po.part.acknowledgementNote) : null)
    if (outcome !== "PakAccepted" && !note)
        denied("REASON_REQUIRED", "Give the supplier's reason for a changed or rejected acknowledgement")
    const items = Object.fromEntries(rows(ITEM, {orderId: po.orderId}).map(item => [item.orderItemSeqId, item]))
    const lineValues = []
    for (const line of Array.from(p.lineAcknowledgements || [])) {
        const item = items[text(line.orderItemSeqId)]
        if (!item) denied("ITEM_UNAVAILABLE", "Line " + (line.orderItemSeqId || "") + " is not on purchase order " + po.orderId)
        const values = {}
        if (!blank(line.promisedDate) && !sameValue("promisedDate", item.promisedDate, line.promisedDate))
            values.promisedDate = line.promisedDate
        if (!blank(line.promisedQuantity)) {
            let quantity = null
            try {
                quantity = toDecimal(line.promisedQuantity)
            } catch (_) {}
            if (quantity == null || quantity.compare(0) < 0)
                denied("QUANTITY_INVALID", "Enter a promised quantity of zero or more")
            if (!sameValue("promisedQuantity", item.promisedQuantity, quantity)) values.promisedQuantity = quantity
        }
        if (Object.keys(values).length) lineValues.push(Object.assign({orderItemSeqId: item.orderItemSeqId}, values))
    }
    let orderContentId = null
    uncounted(po.orderId, () => {
        withReason(Object.keys(fieldLabels), note, () => {
            const partValues = {
                orderId: po.orderId,
                orderPartSeqId: po.orderPartSeqId,
                acknowledgedRevision: revision,
                acknowledgementEnumId: outcome,
                acknowledgedDate: ec.user.nowTimestamp,
                acknowledgementNote: note
            }
            if (!blank(p.otherPartyOrderId)) partValues.otherPartyOrderId = String(p.otherPartyOrderId).trim()
            if (!blank(p.otherPartyOrderDate)) partValues.otherPartyOrderDate = p.otherPartyOrderDate
            call("update#" + PART, partValues)
            for (const values of lineValues) call("update#" + ITEM, Object.assign({orderId: po.orderId}, values))
        })
        // the evidence: the supplier's file, or the way it was received (a phone call, an email), in the supplier's role
        const evidence = text(p.evidenceText)
        if (p.contentFile || evidence) {
            orderContentId = call("create#mantle.order.OrderContent", {
                orderId: po.orderId,
                orderContentTypeEnumId: "OctSupplierAcknowledgement",
                partyId: po.supplierPartyId,
                roleTypeId: "Supplier",
                contentDate: ec.user.nowTimestamp,
                userId: ec.user.userId,
                description: evidence || "Acknowledgement of revision " + revision
            }).orderContentId
            if (p.contentFile)
                call("mantle.order.OrderServices.save#OrderContentFile", {
                    orderContentId,
                    orderId: po.orderId,
                    contentFile: p.contentFile
                })
        }
    })
    const result = {
        orderId: po.orderId,
        acknowledgedRevision: revision,
        acknowledgementEnumId: outcome,
        changedLines: lineValues.map(row => row.orderItemSeqId),
        orderContentId
    }
    if (operation) lib.complete(operation, ORDER, po.orderId, result)
    return Object.assign(result, {alreadyApplied: false})
}

// ===== reminders =====
// The addresses a reminder of the revision, template and occurrence already went to (sent or queued).
function remindedTo(orderId, revision, emailTemplateId, occurrence) {
    const ids = rows("mantle.order.OrderEmailMessage", {orderId})
        .filter(row => Number(row.orderRevision) === revision && row.reminderOccurrence === occurrence)
        .map(row => row.emailMessageId)
    if (!ids.length) return new Set()
    return new Set(
        Array.from(
            find("moqui.basic.email.EmailMessage")
                .condition("emailMessageId", "in", ids)
                .condition("emailTemplateId", emailTemplateId)
                .condition("statusId", "in", ["ES_SENT", "ES_READY", "ES_SCHEDULED"])
                .list()
        ).flatMap(row =>
            String(row.toAddresses || "")
                .split(/[,;\s]+/)
                .map(address => address.trim().toLowerCase())
                .filter(Boolean)
        )
    )
}
// One order's reminder: its supplier's order addresses (or the ones given), each in its own transaction; a recipient
// reminded of the revision, template and occurrence is skipped.
function remindOne(orderId, p, occurrence, emailTemplateId) {
    const po = orders.purchaseOrder(orderId, true)
    const order = po.order
    const revision = revisionOf(order)
    if (!acknowledgeStatuses.includes(order.statusId))
        denied("ORDER_NOT_SENT", "Purchase order " + po.orderId + " has not gone to its supplier")
    if (Number(po.part.acknowledgedRevision ?? 0) === revision)
        denied("ALREADY_ACKNOWLEDGED", "Purchase order " + po.orderId + " revision " + revision + " is acknowledged")
    const recipients = blank(p.toAddresses)
        ? documents().recipientsOf(po.supplierPartyId)
        : String(p.toAddresses)
              .split(/[,;\n]+/)
              .map(address => address.trim().toLowerCase())
              .filter(Boolean)
    if (!recipients.length) denied("RECIPIENT_REQUIRED", partyName(po.supplierPartyId) + " has no order or primary email address")
    const fromName = partyName(po.organizationPartyId)
    const fromAddress = documents().recipientsOf(po.organizationPartyId)[0] || null
    const sentText = lib.dateText(
        rows("mantle.order.OrderEmailMessage", {orderId: po.orderId})
            .filter(row => Number(row.orderRevision) === revision && !row.reminderOccurrence)
            .map(row => one("moqui.basic.email.EmailMessage", {emailMessageId: row.emailMessageId}))
            .filter(Boolean)
            .map(row => row.sentDate || row.lastUpdatedStamp)
            .sort((a, b) => ms(a) - ms(b))[0] || null
    )
    const body = ec.resource.template("component://mr-mantle/template/order/PurchaseReminderEmail.html.fancy", {
        orderId: po.orderId,
        orderName: order.orderName || "",
        revision,
        supplierName: partyName(po.supplierPartyId),
        organizationName: fromName,
        sentText,
        note: text(p.note)
    })
    const already = remindedTo(po.orderId, revision, emailTemplateId, occurrence)
    const recipientResults = []
    for (const recipient of recipients) {
        if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(recipient)) {
            recipientResults.push({recipient, status: "failed", reasonCode: "RECIPIENT_INVALID"})
            continue
        }
        if (already.has(recipient)) {
            recipientResults.push({recipient, status: "skipped", reasonCode: "ALREADY_REMINDED"})
            continue
        }
        let emailMessageId = null
        ec.message.pushErrors()
        try {
            const out =
                ec.service
                    .sync()
                    .name("org.moqui.impl.EmailServices.send#EmailTemplate")
                    .parameters({
                        emailTemplateId,
                        toAddresses: recipient,
                        bodyParameters: {
                            orderId: po.orderId,
                            subject:
                                p.subject ||
                                "Please confirm purchase order " + po.orderId + " revision " + revision + " from " + fromName,
                            fromAddress,
                            fromName
                        },
                        body
                    })
                    .requireNewTransaction(true)
                    .disableAuthz()
                    .call() || {}
            if (!ec.message.hasError()) emailMessageId = out.emailMessageId || null
        } catch (error) {
            ec.logger.error("Reminder of purchase order " + po.orderId + " to " + recipient + " was not sent: " + error.message)
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
        const message = emailMessageId ? one("moqui.basic.email.EmailMessage", {emailMessageId}) : null
        if (message)
            call("create#mantle.order.OrderEmailMessage", {
                orderId: po.orderId,
                emailMessageId,
                orderRevision: revision,
                partyId: po.supplierPartyId,
                roleTypeId: "Supplier",
                reminderOccurrence: occurrence
            })
        const status =
            message?.statusId === "ES_SENT"
                ? "sent"
                : ["ES_READY", "ES_SCHEDULED"].includes(message?.statusId)
                  ? "queued"
                  : "failed"
        recipientResults.push({
            recipient,
            emailMessageId: message ? emailMessageId : null,
            status,
            reasonCode: status === "failed" ? "DELIVERY_FAILED" : status.toUpperCase()
        })
    }
    const sentCount = recipientResults.filter(row => ["sent", "queued"].includes(row.status)).length
    const failedCount = recipientResults.filter(row => row.status === "failed").length
    return {
        orderId: po.orderId,
        orderRevision: revision,
        resultCode: sentCount ? (failedCount ? "PARTLY_SENT" : "SENT") : failedCount ? "FAILED" : "SKIPPED",
        message: sentCount
            ? "Reminded " + sentCount + " of " + recipientResults.length
            : failedCount
              ? "Not sent: " + recipientResults.map(row => row.recipient + " " + row.reasonCode).join(", ")
              : "Already reminded",
        recipientResults
    }
}
// send#PurchaseReminder: a reminder to acknowledge each order's current revision, each order in its own transaction: an order
// that fails (not sent, acknowledged, no address) is named and the others go on.
function remind(p) {
    orders.requirePermission("PURCHASE_ORDER_EDIT")
    const orderIds = [
        ...new Set(
            Array.from(p.orderIds || [])
                .concat(blank(p.orderId) ? [] : [p.orderId])
                .map(String)
        )
    ].filter(Boolean)
    if (!orderIds.length || orderIds.length > 100) denied("SELECTION_INVALID", "Choose between one and 100 purchase orders")
    const occurrence = text(p.occurrence) || ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd")
    const emailTemplateId = text(p.emailTemplateId) || "MANTLE_PURCHASE_REMINDER"
    const results = []
    for (const orderId of orderIds) {
        ec.message.pushErrors()
        try {
            const out =
                ec.service
                    .sync()
                    .name("mantle.order.OrderServices.send#PurchaseReminder")
                    .parameters({
                        orderId,
                        occurrence,
                        emailTemplateId,
                        toAddresses: orderIds.length === 1 ? p.toAddresses || null : null,
                        note: p.note || null,
                        subject: p.subject || null,
                        single: true
                    })
                    .requireNewTransaction(true)
                    .disableAuthz()
                    .call() || {}
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
            results.push(out.results[0])
        } catch (error) {
            const message = String(error.message || error)
                .split("\n")[0]
                .replace(/^(Error: )+/, "")
            results.push({orderId, resultCode: lib.reasonCode({message}) || "FAILED", message, recipientResults: []})
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    return {
        occurrence,
        results,
        sentCount: results.filter(row => ["SENT", "PARTLY_SENT"].includes(row.resultCode)).length,
        failedCount: results.filter(row => !["SENT", "PARTLY_SENT", "SKIPPED"].includes(row.resultCode)).length
    }
}
// One order's reminder in its own transaction (send#PurchaseReminder with single, as remind calls it per order).
function remindSingle(p) {
    orders.requirePermission("PURCHASE_ORDER_EDIT")
    const out = remindOne(String(p.orderId), p, text(p.occurrence), text(p.emailTemplateId) || "MANTLE_PURCHASE_REMINDER")
    return {occurrence: text(p.occurrence), results: [out], sentCount: out.resultCode.endsWith("SENT") ? 1 : 0, failedCount: 0}
}

const operations = {start, cancel, preview, apply, acknowledge, remind: p => (p.single ? remindSingle(p) : remind(p))}
;({
    revisionState,
    awaitingApproval,
    releaseRevisionHold,
    releaseReturn,
    revisionList,
    revisionChanges,
    uncounted,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown purchase revision operation " + op)
        return operations[op](parameters)
    }
})
