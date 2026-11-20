// Sales' commercial order changes (C of IronStone Sales design §12.1; design §6 OrderChanges and OrderChangeDetail, §17 SAL-CHANGE,
// CX-POSTING; impl-sales P14, F13, F43, F58; owner contract with Customer Service, design-customer-service §4). Customer Service's
// OrderChanges.js files a proposal of any kind and decides the commercial kinds under SALES_APPROVE; this module is the order owner's
// part of the same services, which OrderChanges.js calls for the commercial kinds (price, quantity increase and a new line, ship
// date, address, ship method, carrier):
// - who may file one (canFile: SALES_ORDER_CHANGE in the seller's sales scope, or the order's editor in Sales) and who reads one
//   (seesOrder: a Sales reader who sees the order), beside Customer Service's permissions;
// - each kind's fields when it is filed (validateSave) and its conflicts against the order as it is now (checkLines): an active pick
//   (ACTIVE_PICK), a shipped quantity (ALREADY_SHIPPED), a finalized invoice (BILLING_CONFLICT), a packed quantity whose draft invoice
//   only a receivables editor may release (BILLING_CONFLICT), a new line's product or price (PRODUCT_NOT_USABLE, PRICE_UNAVAILABLE);
// - the preview's effects (effects): the order total before and after, the tax, freight and credit effects;
// - apply (under SALES_ORDER_CHANGE, after OrderChanges.js has checked the approval at both revisions under the order's lock): every
//   check repeated strictly, the order held with the Change reason (hold#Order), Accounting's draft release
//   (release#ShipmentDraftInvoice) of a packed price line, the native writes (update#OrderItem, whose reservation rule releases and
//   rebuilds the line's open reservations, create#OrderItem at the seller's price, update#OrderPart), the part retaxed
//   (handle#OrderMajorChange: X1 for a storeless order, the store's rules otherwise), Accounting's credit check on an increase
//   (evaluate#OrderCredit, which may leave a Credit hold), only its own Change hold released, the approvals of the order's other
//   proposals ended (the order's revision moved), the proposal completed with the changed document's PDF stored.
// Each function runs inside OrderChanges.js' execute, with artifact authorization off; the permissions and the organization are
// checked here and there.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const salesAccess = ec.resource.script("component://mr-mantle/service/mantle/sales/SalesAccess.js")
const {find, one, rows, call, denied, access} = lib

const ORDER = "mantle.order.OrderHeader",
    PART = "mantle.order.OrderPart",
    ORDER_ITEM = "mantle.order.OrderItem",
    REQUEST = "mantle.request.Request",
    DECISION = "mantle.request.support.OrderChangeDecision",
    SOURCE = "mantle.shipment.ShipmentItemSource",
    SHIPMENT = "mantle.shipment.Shipment"
const partKinds = ["OckAddress", "OckShipMethod", "OckCarrier"]
const shippedStatuses = ["ShipShipped", "ShipDelivered"]
const deadShipmentStatuses = ["ShipCancelled", "ShipRejected"]
const openStatuses = ["ReqSubmitted", "ReqWaitingCustomer"]

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const number = value => (value == null || value === "" ? 0 : Number(String(value)))
const quantityText = value => ec.l10n.format(toDecimal(value ?? 0), "#,##0.###")
const has = permission => access.has(permission)
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const partyName = partyId => (partyId ? lib.partyNames([partyId])[partyId] || partyId : "")
const productText = productId => {
    const product = productId ? one("mantle.product.Product", {productId}) : null
    return product ? [product.pseudoId || product.productId, product.productName].filter(Boolean).join(" · ") : productId || ""
}
const money = (value, currencyUomId) =>
    value == null ? "" : currencyUomId ? ec.l10n.formatCurrency(lib.money(value, currencyUomId), currencyUomId) : String(value)
function addressText(contactMechId) {
    const address = contactMechId ? one("mantle.party.contact.PostalAddress", {contactMechId}) : null
    if (!address) return contactMechId || ""
    return [address.toName, address.address1, address.address2, address.city, address.postalCode].filter(Boolean).join(", ")
}

// ===== access =====
// Whether the user's sales scope covers the organization (SalesAccess.js: their own organizations, every one for a holder of
// SALES_ALL_ORGANIZATIONS or a system administrator); a Sales reader only.
function salesCovers(organizationPartyId) {
    const userScope = salesAccess.scope()
    return !!userScope.capabilities.anyRead && salesAccess.covers(userScope, organizationPartyId)
}
// Whether a Sales reader sees the order in Sales (SalesAccess.js orderOf: theirs, their team's, the organization's, an approver's or a
// change operator's reach), so reads its changes; never a widening of what Customer Service's permissions read.
function seesOrder(orderId) {
    const userScope = salesAccess.scope()
    return !!userScope.capabilities.anyRead && !!salesAccess.orderOf(userScope, orderId)
}
// Whether the user may file a commercial change of the order in Sales: SALES_ORDER_CHANGE in the seller's sales scope, or the order's
// editor (SALES_ORDER_EDIT on an order of theirs or their team's, or the organization's for SALES_TEAM_VIEW).
function canFile(orderId) {
    const userScope = salesAccess.scope()
    if (!userScope.capabilities.anyRead || blank(orderId)) return false
    const found = salesAccess.orderOf(userScope, orderId)
    if (!found) return false
    return !!userScope.capabilities.orderChange || !!found.canEdit
}
// Apply's own check: SALES_ORDER_CHANGE in the seller's sales scope (another organization's answers as missing).
function requireApply(ch) {
    if (!has("SALES_ORDER_CHANGE"))
        denied("FORBIDDEN", "A " + enumText(ch.kind) + " change is applied by the order's owner (Sales) under SALES_ORDER_CHANGE")
    if (!salesCovers(ch.so.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Order change " + ch.requestId + " is not available")
}
// Whether the user may apply a commercial change of this order (OrderChangeDetail's actions).
const mayApply = ch => has("SALES_ORDER_CHANGE") && salesCovers(ch.so.organizationPartyId)

// ===== filing =====
// The part an address, ship method or carrier change applies to: the one named, else the order's only part.
function partOf(so, orderPartSeqId) {
    if (!blank(orderPartSeqId)) {
        const part = so.parts.find(row => row.orderPartSeqId === String(orderPartSeqId))
        if (!part) denied("PART_REQUIRED", "Part " + orderPartSeqId + " is not on order " + so.orderId)
        return part
    }
    if (so.parts.length !== 1) denied("PART_REQUIRED", "Choose the part of order " + so.orderId + " the change is for")
    return so.parts[0]
}
// A commercial kind's fields when it is filed (save#OrderChange): each line's proposal, and a part kind's part and value. Answers
// {orderPartSeqId} for the request; the conflicts with the order (a pick, a shipment, an invoice) are the preview's, not refused here.
function validateSave(so, kind, lines, p) {
    for (const line of lines) {
        const item = line.orderItemSeqId ? one(ORDER_ITEM, {orderId: so.orderId, orderItemSeqId: line.orderItemSeqId}) : null
        if (line.changeActionEnumId === "OclPrice") {
            if (blank(line.proposedUnitAmount) || !(number(line.proposedUnitAmount) >= 0))
                denied("PRICE_REQUIRED", "Give the new unit price for line " + (line.orderItemSeqId || ""))
        } else if (line.changeActionEnumId === "OclQuantity") {
            if (!item) {
                // a new line: a product and a quantity, priced by the seller's authority when it is applied
                if (line.orderItemSeqId)
                    denied("LINE_UNAVAILABLE", "Line " + line.orderItemSeqId + " is not on order " + so.orderId)
                if (blank(line.productId)) denied("PRODUCT_REQUIRED", "Choose the product of the new line")
                if (!one("mantle.product.Product", {productId: line.productId}))
                    denied("PRODUCT_REQUIRED", "Product " + line.productId + " is not available")
            } else if (!(number(line.quantity) > number(item.quantity)))
                denied(
                    "QUANTITY_INVALID",
                    "A quantity change raises line " +
                        line.orderItemSeqId +
                        " above " +
                        quantityText(item.quantity) +
                        "; Customer Service cancels a remainder"
                )
        } else if (line.changeActionEnumId === "OclShipDate") {
            if (blank(line.requiredByDate))
                denied("DATE_REQUIRED", "Give the new ship date for line " + (line.orderItemSeqId || ""))
        }
    }
    if (!partKinds.includes(kind)) return {orderPartSeqId: null}
    const part = partOf(so, p.orderPartSeqId)
    if (kind === "OckAddress") {
        const contactMechId = text(p.addressContactMechId)
        if (!contactMechId) denied("ADDRESS_REQUIRED", "Choose the new ship-to address")
        const isAddress = !!one("mantle.party.contact.PostalAddress", {contactMechId})
        const customerOwns = rows("mantle.party.contact.PartyContactMech", {partyId: part.customerPartyId, contactMechId}).some(
            row => lib.active(row)
        )
        if (!isAddress || !customerOwns) denied("ADDRESS_INVALID", "The address is not one of the customer's")
    } else if (kind === "OckShipMethod") {
        const method = blank(p.shipmentMethodEnumId) ? null : one("moqui.basic.Enumeration", {enumId: p.shipmentMethodEnumId})
        if (method?.enumTypeId !== "ShipmentMethod") denied("METHOD_INVALID", "Choose a ship method")
    } else if (kind === "OckCarrier") {
        const carrierPartyId = text(p.carrierPartyId)
        if (
            !carrierPartyId ||
            (carrierPartyId !== "_NA_" && !one("mantle.party.PartyRole", {partyId: carrierPartyId, roleTypeId: "Carrier"}))
        )
            denied("CARRIER_INVALID", "Choose a carrier")
    }
    return {orderPartSeqId: part.orderPartSeqId}
}

// ===== the order as it is now =====
// What is picked on a line and not packed yet (an active pick), on its shipments not shipped.
function activePicked(facts) {
    let picked = 0
    for (const source of facts.sources) {
        const shipment = facts.shipments.get(source.shipmentId)
        if (!shipment || shippedStatuses.includes(shipment.statusId) || deadShipmentStatuses.includes(shipment.statusId)) continue
        picked += number(source.quantityPicked)
    }
    const packed = [...facts.packed.values()].reduce((sum, value) => sum + value, 0)
    return Math.max(0, picked - packed)
}
// The shipments of an order part that are not shipped or cancelled: a change of its address, method or carrier waits for them.
function openShipmentsOf(orderId, orderPartSeqId) {
    const itemIds = rows(ORDER_ITEM, {orderId, orderPartSeqId}).map(row => row.orderItemSeqId)
    const shipmentIds = [
        ...new Set(
            rows(SOURCE, {orderId})
                .filter(row => itemIds.includes(row.orderItemSeqId) && row.statusId !== "SisCancelled")
                .map(row => row.shipmentId)
                .filter(Boolean)
        )
    ].sort()
    return shipmentIds
        .map(shipmentId => one(SHIPMENT, {shipmentId}))
        .filter(row => row && !shippedStatuses.includes(row.statusId) && !deadShipmentStatuses.includes(row.statusId))
}
// The seller's price of a product for the order's customer (get#SellerProductPrice, the seller's authority after the change checks,
// as a quote line's; impl-sales P7), or null when none.
function sellerPrice(productId, quantity, so) {
    ec.message.pushErrors()
    try {
        const out =
            ec.service
                .sync()
                .name("mantle.product.PriceServices.get#SellerProductPrice")
                .parameters({
                    productId,
                    organizationPartyId: so.organizationPartyId,
                    customerPartyId: so.customerPartyIds[0] || null,
                    productStoreId: so.order.productStoreId || null,
                    quantity,
                    priceUomId: so.currencyUomId,
                    validDate: ec.user.nowTimestamp
                })
                .disableAuthz()
                .call() || {}
        return ec.message.hasError() || out.price == null ? null : out.price
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}
function usableForSale(productId, quantity, so) {
    ec.message.pushErrors()
    try {
        const out =
            ec.service
                .sync()
                .name("mantle.product.ProductServices.check#ProductUsable")
                .parameters({
                    productId,
                    usage: "Sell",
                    quantity,
                    vendorPartyId: so.organizationPartyId,
                    customerPartyId: so.customerPartyIds[0] || null,
                    productStoreId: so.order.productStoreId || null
                })
                .disableAuthz()
                .call() || {}
        if (ec.message.hasError()) return {usable: false, reason: ec.message.getErrorsString()}
        return {usable: out.usable !== false, reason: out.reason || null}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}
const emptyFacts = (item, productId) => ({
    item,
    orderItemSeqId: null,
    productId,
    quantity: 0,
    cancelled: 0,
    reserved: 0,
    picked: 0,
    issued: 0,
    shipped: 0,
    packed: new Map(),
    billedFinal: 0,
    billedInProcess: 0,
    short: 0,
    open: 0,
    sources: [],
    shipments: new Map()
})

// ===== checking a commercial proposal =====
// Each line (or the part) against the order as it is now: {lines, conflicts, version}, each line in OrderChanges.js' shape (item,
// orderItemSeqId, facts, quantity, cancelQuantity, reopen, substitute) with what it changes and its text after. With strict, the
// first conflict is refused by its code (apply); otherwise each is listed (get, preview).
function checkLines(ch, lineRows, strict, tools) {
    const so = ch.so
    const conflicts = []
    const conflict = (code, message) => {
        if (strict) denied(code, message)
        conflicts.push({code, message})
    }
    const currency = so.currencyUomId
    const checked = []
    for (const {item, orderItemSeqId} of lineRows) {
        const action = item.changeActionEnumId
        const facts = orderItemSeqId ? tools.lineFacts(so.orderId, orderItemSeqId) : null
        const entry = {
            item,
            orderItemSeqId,
            facts,
            quantity: number(item.quantity),
            cancelQuantity: 0,
            reopen: [],
            substitute: null
        }
        if (!facts && !(action === "OclQuantity" && !orderItemSeqId)) {
            conflict("LINE_UNAVAILABLE", "Line " + (orderItemSeqId || "") + " is not on order " + so.orderId)
            continue
        }
        if (facts) {
            const picking = activePicked(facts)
            if (picking > 0)
                conflict(
                    "ACTIVE_PICK",
                    "Line " +
                        orderItemSeqId +
                        " has " +
                        quantityText(picking) +
                        " picked for a shipment; it waits until Warehouse packs or puts it back"
                )
        }
        if (action === "OclPrice") {
            const price = toDecimal(item.proposedUnitAmount ?? 0)
            if (facts.shipped > 0)
                conflict(
                    "ALREADY_SHIPPED",
                    "Line " +
                        orderItemSeqId +
                        " has " +
                        quantityText(facts.shipped) +
                        " shipped; a credit memo or a return corrects its price"
                )
            if (facts.billedFinal > 0)
                conflict(
                    "BILLING_CONFLICT",
                    "Line " +
                        orderItemSeqId +
                        " has " +
                        quantityText(facts.billedFinal) +
                        " on a finalized invoice; Accounting corrects it with a credit memo"
                )
            // between pack and ship: the packed quantity's draft invoice is released first, by a receivables editor's authority
            entry.release = []
            for (const shipmentId of facts.packed.keys()) {
                const invoices = tools.invoicesOf(shipmentId).filter(row => row.statusId !== "InvoiceCancelled")
                if (invoices.some(row => row.statusId !== "InvoiceInProcess"))
                    conflict(
                        "BILLING_CONFLICT",
                        "Shipment " + shipmentId + " has a finalized invoice; Accounting corrects it with a credit memo"
                    )
                else if (invoices.length && !has("RECEIVABLE_EDIT"))
                    conflict(
                        "BILLING_CONFLICT",
                        "Shipment " +
                            shipmentId +
                            " has a draft invoice that a receivables editor releases first; the change waits for them"
                    )
                else if (invoices.length) entry.release.push(shipmentId)
            }
            entry.newPrice = price
            entry.afterText =
                quantityText(facts.quantity) + " × " + productText(facts.productId) + " at " + money(price, currency)
            entry.beforePrint =
                quantityText(facts.quantity) +
                " × " +
                productText(facts.productId) +
                " at " +
                money(facts.item.unitAmount, currency)
        } else if (action === "OclQuantity" && facts) {
            const newQuantity = number(item.quantity)
            if (!(newQuantity > facts.quantity))
                conflict(
                    "QUANTITY_INVALID",
                    "Line " + orderItemSeqId + " is " + quantityText(facts.quantity) + " now; the change no longer raises it"
                )
            entry.newQuantity = newQuantity
            entry.afterText = quantityText(newQuantity) + " × " + productText(facts.productId)
            entry.beforePrint = quantityText(facts.quantity) + " × " + productText(facts.productId)
        } else if (action === "OclQuantity") {
            // a new line on the first part (or the one its proposal names), at the seller's price for the order's customer
            const orderPartSeqId = ch.request.orderPartSeqId || so.parts[0].orderPartSeqId
            const quantity = number(item.quantity)
            const usable = usableForSale(item.productId, quantity, so)
            if (!usable.usable)
                conflict("PRODUCT_NOT_USABLE", productText(item.productId) + " cannot be sold now: " + (usable.reason || ""))
            const price = sellerPrice(item.productId, quantity, so)
            if (price == null) conflict("PRICE_UNAVAILABLE", productText(item.productId) + " has no price for this order")
            entry.facts = emptyFacts({unitAmount: price, orderPartSeqId}, item.productId)
            entry.newLine = {productId: item.productId, quantity, orderPartSeqId, price}
            entry.afterText =
                "New line: " +
                quantityText(quantity) +
                " × " +
                productText(item.productId) +
                (price == null ? "" : " at " + money(price, currency))
            entry.beforePrint = "—"
        } else if (action === "OclShipDate") {
            if (facts.open <= 0) conflict("ALREADY_SHIPPED", "Line " + orderItemSeqId + " has nothing left to ship")
            entry.newDate = item.requiredByDate
            entry.afterText =
                quantityText(facts.quantity) + " × " + productText(facts.productId) + " by " + lib.dateText(item.requiredByDate)
            entry.beforePrint =
                quantityText(facts.quantity) +
                " × " +
                productText(facts.productId) +
                (facts.item.requiredByDate ? " by " + lib.dateText(facts.item.requiredByDate) : "")
        }
        checked.push(entry)
    }
    // a part's address, method or carrier: no shipment of the part being prepared
    let partChange = null
    if (partKinds.includes(ch.kind)) {
        const orderPartSeqId = ch.request.orderPartSeqId || (so.parts.length === 1 ? so.parts[0].orderPartSeqId : null)
        const part = orderPartSeqId ? so.parts.find(row => row.orderPartSeqId === orderPartSeqId) : null
        if (!part) conflict("PART_REQUIRED", "The change names no part of order " + so.orderId)
        else {
            for (const shipment of openShipmentsOf(so.orderId, part.orderPartSeqId))
                conflict(
                    "ACTIVE_PICK",
                    "Shipment " +
                        shipment.shipmentId +
                        " of this part is being prepared; it waits until Warehouse ships or cancels it"
                )
            const field = {
                OckAddress: "postalContactMechId",
                OckShipMethod: "shipmentMethodEnumId",
                OckCarrier: "carrierPartyId"
            }[ch.kind]
            const value = {
                OckAddress: ch.request.addressContactMechId,
                OckShipMethod: ch.request.shipmentMethodEnumId,
                OckCarrier: ch.request.carrierPartyId
            }[ch.kind]
            const show = {OckAddress: addressText, OckShipMethod: enumText, OckCarrier: partyName}[ch.kind]
            partChange = {part, field, value, beforeText: show(part[field]) || "—", afterText: show(value) || "—"}
        }
    }
    const version = lib.hash([
        checked.map(line => {
            const f = line.facts
            return [
                line.orderItemSeqId,
                f.quantity,
                f.cancelled,
                f.reserved,
                f.picked,
                f.issued,
                f.shipped,
                f.billedFinal,
                String(f.item.unitAmount ?? "")
            ]
        }),
        partChange ? [partChange.part.orderPartSeqId, String(partChange.part[partChange.field] ?? "")] : null,
        partChange
            ? openShipmentsOf(so.orderId, partChange.part.orderPartSeqId).map(row => row.shipmentId + ":" + row.statusId)
            : null
    ])
    return {lines: checked, conflicts, version, partChange}
}

// ===== the preview's effects =====
// The order total before and after, the change of it, and the tax, freight and credit effects, in words; amounts only for a reader of
// them (amounts false: the texts without figures).
function effects(ch, checked, amounts) {
    const so = ch.so
    const currency = so.currencyUomId
    let delta = toDecimal(0)
    for (const line of checked.lines) {
        const f = line.facts
        const unit = toDecimal(f.item.unitAmount ?? 0)
        if (line.newPrice != null) delta = delta.add(line.newPrice.subtract(unit).multiply(toDecimal(f.quantity)))
        else if (line.newQuantity != null) delta = delta.add(unit.multiply(toDecimal(line.newQuantity - f.quantity)))
        else if (line.newLine && line.newLine.price != null)
            delta = delta.add(toDecimal(line.newLine.price).multiply(toDecimal(line.newLine.quantity)))
    }
    const before = toDecimal(so.order.grandTotal ?? 0)
    // the order's effective tax rate on its product lines, for an estimate; the gateway recalculates it when the change applies
    const items = rows(ORDER_ITEM, {orderId: so.orderId})
    const lineAmount = row => toDecimal(row.unitAmount ?? 0).multiply(toDecimal(row.quantity ?? 0))
    const taxTotal = items
        .filter(row => row.itemTypeEnumId === "ItemSalesTax")
        .reduce((sum, row) => sum.add(lineAmount(row)), toDecimal(0))
    const productTotal = items
        .filter(row => row.productId && row.itemTypeEnumId !== "ItemSalesTax")
        .reduce((sum, row) => sum.add(lineAmount(row)), toDecimal(0))
    const taxed = !taxTotal.isZero() && !productTotal.isZero()
    const taxDelta = taxed ? delta.multiply(taxTotal).divide(productTotal, 6) : toDecimal(0)
    const storeless = !so.order.productStoreId
    const result = {
        changesTotal: !delta.isZero(),
        taxText: taxed
            ? (amounts ? "About " + money(taxDelta, currency) + " of tax; " : "") +
              "the tax is calculated again when the change is applied"
            : "No tax on the order now; the tax is calculated again when the change is applied",
        freightText: storeless
            ? "Shipping is a charge line on this order; the change leaves it as it is"
            : "The store's shipping charges are calculated again when the change is applied",
        creditText: "",
        beforeText: amounts ? money(before, currency) : null,
        afterText: amounts ? money(before.add(delta).add(taxDelta), currency) : null,
        deltaText: amounts ? money(delta, currency) : null
    }
    // the customer's credit standing only for a reader of it (Accounting's CUSTOMER_CREDIT_VIEW, a finance reader) or an approver, who
    // sees an order's credit warning when approving it (impl-sales P11); to others only that the check runs again (P14 review)
    const creditReader = [
        "CUSTOMER_CREDIT_VIEW",
        "ACCOUNTING_VIEW",
        "SALES_APPROVE",
        "SALES_ORDER_APPROVE",
        "ORDER_APPROVE"
    ].some(has)
    if (delta.compare(toDecimal(0)) > 0 && !creditReader)
        result.creditText = "Accounting's credit check runs again on the higher total when the change is applied"
    else if (delta.compare(toDecimal(0)) > 0) {
        ec.message.pushErrors()
        try {
            const credit =
                ec.service
                    .sync()
                    .name("mantle.account.CreditServices.evaluate#OrderCredit")
                    .parameters({orderId: so.orderId, placeHold: false, forChange: true})
                    .disableAuthz()
                    .call() || {}
            const now = {pass: "within its credit now", warn: "near its credit limit now", hold: "over its credit limit now"}[
                credit.resultEnumId
            ]
            result.creditText =
                "The customer is " +
                (now || "not checked for credit") +
                "; Accounting's credit check runs again on the higher total when the change is applied"
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    } else result.creditText = "The change does not raise the order's total"
    return result
}

// ===== apply =====
// The commercial writes under the order's lock, once OrderChanges.js has checked the proposal's and the order's revisions, the
// approval and the fiscal period. tools: lineFacts, invoicesOf, storeApplied, clearNotices, linesOf.
function apply(ch, p, revision, tools) {
    requireApply(ch)
    const so = ch.so
    const checked = checkLines(ch, tools.linesOf(ch.requestId), true, tools)
    if (String(p.previewVersion) !== checked.version)
        denied(
            "STOCK_CHANGED",
            "What is reserved, picked, packed or billed on order " + so.orderId + " changed since the preview; preview it again"
        )
    const reason = "Order change " + ch.requestId
    // 1. the Change hold (hold#Order checks SALES_ORDER_CHANGE for a sales part, PurchaseOrders.js holdAllowed)
    const hold = call("mantle.order.OrderServices.hold#Order", {
        orderId: so.orderId,
        holdTypeEnumId: "OhtChange",
        sourceId: ch.requestId,
        holdComment: "Applying order change " + ch.requestId
    })
    // 2. a packed price line's draft invoice released (Accounting's contract, checked for RECEIVABLE_EDIT there)
    const released = []
    for (const line of checked.lines)
        for (const shipmentId of line.release || []) {
            call("mantle.account.InvoiceServices.release#ShipmentDraftInvoice", {shipmentId, reason})
            released.push(shipmentId)
        }
    // 3. the native writes; update#OrderItem's reservation rule releases and rebuilds the line's open reservations
    const changed = [],
        added = []
    const parts = new Set()
    for (const line of checked.lines) {
        if (line.newLine) {
            const created = call("mantle.order.OrderServices.create#OrderItem", {
                orderId: so.orderId,
                orderPartSeqId: line.newLine.orderPartSeqId,
                productId: line.newLine.productId,
                quantity: line.newLine.quantity,
                // the seller's price the preview showed and the approver saw (get#SellerProductPrice for the order's customer)
                unitAmount: line.newLine.price,
                itemTypeEnumId: "ItemProduct",
                requireInventory: false
            })
            added.push({
                orderItemSeqId: created.orderItemSeqId,
                productId: line.newLine.productId,
                quantity: line.newLine.quantity
            })
            parts.add(line.newLine.orderPartSeqId)
            continue
        }
        const f = line.facts
        const update = {orderId: so.orderId, orderItemSeqId: line.orderItemSeqId, unitAmount: f.item.unitAmount}
        if (line.newPrice != null)
            Object.assign(update, {
                unitAmount: line.newPrice,
                unitAmount_changeReason: reason,
                priceOverrideReason: reason + (ch.request.description ? ": " + ch.request.description : ""),
                priceOverrideUserId: ec.user.userId,
                priceOverrideDate: ec.user.nowTimestamp
            })
        if (line.newQuantity != null)
            Object.assign(update, {quantity: line.newQuantity, quantity_changeReason: reason, requireInventory: false})
        if (line.newDate != null) update.requiredByDate = line.newDate
        call("mantle.order.OrderServices.update#OrderItem", update)
        changed.push({orderItemSeqId: line.orderItemSeqId, action: line.item.changeActionEnumId})
        parts.add(f.item.orderPartSeqId)
    }
    if (checked.partChange) {
        const {part, field, value} = checked.partChange
        call("update#" + PART, {orderId: so.orderId, orderPartSeqId: part.orderPartSeqId, [field]: value})
        changed.push({orderPartSeqId: part.orderPartSeqId, action: ch.kind})
        parts.add(part.orderPartSeqId)
    }
    // 4. the part retaxed (and a store's shipping) while the order is held: X1 for a storeless order, the store's rules otherwise
    for (const orderPartSeqId of [...parts].filter(Boolean).sort())
        call("mantle.order.OrderServices.handle#OrderMajorChange", {orderId: so.orderId, orderPartSeqId})
    // 5. Accounting's credit check on a higher total (it may leave a Credit hold, which keeps the order held): a part held by
    // this Change hold alone is checked as the status it returns to (an approved order's included, SEC-BAP-91)
    const after = one(ORDER, {orderId: so.orderId})
    if (toDecimal(after.grandTotal ?? 0).compare(toDecimal(so.order.grandTotal ?? 0)) > 0)
        call("mantle.account.CreditServices.evaluate#OrderCredit", {
            orderId: so.orderId,
            placeHold: true,
            changeHoldReasonId: hold && !hold.alreadyHeld ? hold.orderHoldReasonId : null
        })
    // 6. only its own Change hold released; another open hold (a Credit hold) keeps the order held
    let stillHeld = false
    if (hold && !hold.alreadyHeld) {
        const out = call("mantle.order.OrderServices.release#OrderHold", {
            orderHoldReasonId: hold.orderHoldReasonId,
            releaseComment: reason + " applied"
        })
        stillHeld = !!out.stillHeld
    } else stillHeld = true
    // 7. the order's revision moved: the approvals of its other open proposals no longer hold
    const ended = []
    for (const other of rows(REQUEST, {requestTypeEnumId: "RqtOrderChange", orderId: so.orderId}).filter(
        row => row.requestId !== ch.requestId && openStatuses.includes(row.statusId)
    ))
        for (const decision of rows(DECISION, {requestId: other.requestId}).filter(row => !row.supersededDate)) {
            call("update#" + DECISION, {
                orderChangeDecisionId: decision.orderChangeDecisionId,
                supersededDate: ec.user.nowTimestamp
            })
            ended.push(other.requestId)
        }
    // 8. the proposal applied, the changed document's PDF stored
    call("update#" + REQUEST, {
        requestId: ch.requestId,
        statusId: "ReqCompleted",
        requestResolutionEnumId: "RrCompleted",
        changeAppliedDate: ec.user.nowTimestamp
    })
    const printLines = checked.lines.map((line, index) => ({
        seq: index + 1,
        actionText: enumText(line.item.changeActionEnumId),
        beforeText: line.beforePrint || "",
        afterText: line.afterText || ""
    }))
    if (checked.partChange)
        printLines.push({
            seq: printLines.length + 1,
            actionText: enumText(ch.kind) + " (part " + checked.partChange.part.orderPartSeqId + ")",
            beforeText: checked.partChange.beforeText,
            afterText: checked.partChange.afterText
        })
    const orderContentId = tools.storeApplied(ch, checked.lines, revision, printLines)
    tools.clearNotices(ch.requestId)
    const final = one(ORDER, {orderId: so.orderId})
    return {
        requestId: ch.requestId,
        orderId: so.orderId,
        statusId: final.statusId,
        orderRevision: number(final.orderRevision || 1),
        cancelled: [],
        added,
        changed,
        released,
        reopened: [],
        endedApprovals: [...new Set(ended)],
        stillHeld,
        orderContentId
    }
}

// ===== the fulfillment and billing handoffs (design §6 ShipmentDetail and InvoiceDetail; crosscut §3.8, §3.16) =====
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "")
// The sales orders of the caller's sales scope among some order ids (SalesAccess.js orderOf), each once.
function visibleOrders(orderIds) {
    const userScope = salesAccess.scope()
    if (!userScope.capabilities.anyRead) return []
    return [...new Set(orderIds.filter(Boolean))].sort().filter(orderId => !!salesAccess.orderOf(userScope, orderId))
}
// A shipment of a sales order the caller sees in Sales, read only (ShipmentDetail's Sales row): its header, the items and sources of
// those orders (another order's lines on a mixed shipment are left out), its packages and tracking. {shipmentFound: false} for a
// missing shipment and one of no order the caller sees alike.
function getShipment(p) {
    const shipmentId = text(p.shipmentId)
    const shipment = shipmentId ? one(SHIPMENT, {shipmentId}) : null
    if (!shipment) return {shipmentFound: false}
    const sources = rows(SOURCE, {shipmentId}).filter(row => row.statusId !== "SisCancelled")
    const orderIds = visibleOrders(sources.map(row => row.orderId))
    if (!orderIds.length) return {shipmentFound: false}
    const mine = sources.filter(row => orderIds.includes(row.orderId))
    const issued = rows("mantle.product.issuance.AssetIssuance", {shipmentId})
    const itemRows = mine.map(row => {
        const item = one(ORDER_ITEM, {orderId: row.orderId, orderItemSeqId: row.orderItemSeqId})
        const shippedQuantity = issued
            .filter(issue => issue.orderId === row.orderId && issue.orderItemSeqId === row.orderItemSeqId)
            .reduce((sum, issue) => sum + number(issue.quantity), 0)
        return {
            orderId: row.orderId,
            orderItemSeqId: row.orderItemSeqId,
            productText: productText(row.productId || item?.productId),
            orderedText: quantityText(item?.quantity ?? 0),
            quantityText: quantityText(row.quantity ?? 0),
            pickedText: quantityText(row.quantityPicked ?? 0),
            packedText: quantityText(shippedQuantity),
            statusText: statusText(row.statusId)
        }
    })
    const segments = rows("mantle.shipment.ShipmentRouteSegment", {shipmentId})
    const trackingRows = rows("mantle.shipment.ShipmentPackageRouteSeg", {shipmentId}).map(row => {
        const segment = segments.find(seg => seg.shipmentRouteSegmentSeqId === row.shipmentRouteSegmentSeqId) || {}
        return {
            packageSeqId: row.shipmentPackageSeqId,
            carrierName: partyName(segment.carrierPartyId),
            methodText: enumText(segment.shipmentMethodEnumId),
            trackingText: row.trackingCode || "",
            trackingUrl: row.trackingUrl || "",
            stateText: enumText(row.trackingStatusEnumId)
        }
    })
    const packageRows = rows("mantle.shipment.ShipmentPackage", {shipmentId}).map(pkg => ({
        packageSeqId: pkg.shipmentPackageSeqId,
        contentsText: rows("mantle.shipment.ShipmentPackageContent", {shipmentId, shipmentPackageSeqId: pkg.shipmentPackageSeqId})
            .map(content => quantityText(content.quantity) + " × " + productText(content.productId))
            .join(", "),
        weightText: pkg.weight == null ? "" : quantityText(pkg.weight) + (pkg.weightUomId ? " " + pkg.weightUomId : "")
    }))
    const destination = segments.map(seg => seg.destPostalContactMechId).find(Boolean)
    return {
        shipmentFound: true,
        shipment: {
            shipmentId,
            statusId: shipment.statusId,
            statusText: statusText(shipment.statusId),
            customerName: partyName(shipment.toPartyId),
            customerPartyId: shipment.toPartyId,
            organizationName: partyName(shipment.fromPartyId),
            destinationText: addressText(destination),
            estimatedShipText: shipment.estimatedShipDate ? lib.dateText(shipment.estimatedShipDate) : "",
            estimatedArrivalText: shipment.estimatedArrivalDate ? lib.dateText(shipment.estimatedArrivalDate) : "",
            shipped: shippedStatuses.includes(shipment.statusId),
            otherOrdersHidden: sources.some(row => !orderIds.includes(row.orderId))
        },
        orderIds,
        itemRows,
        packageRows,
        trackingRows
    }
}
// An invoice of a sales order the caller sees in Sales, for a receivable reader (ACCOUNTING_VIEW or RECEIVABLE_VIEW; borrowed
// authority, never a Sales permission): the orders it bills among those the caller sees. RECORD_UNAVAILABLE for a missing invoice, one
// of no such order, and a caller without the receivable read alike; Accounting's get#InvoiceFinanceDetail answers the rest.
function checkInvoice(p) {
    const invoiceId = text(p.invoiceId)
    const unavailable = () => denied("RECORD_UNAVAILABLE", "Invoice " + (invoiceId || "") + " is not available")
    if (!invoiceId || !(has("ACCOUNTING_VIEW") || has("RECEIVABLE_VIEW"))) unavailable()
    const invoice = one("mantle.account.invoice.Invoice", {invoiceId})
    if (!invoice) unavailable()
    const orderIds = visibleOrders(rows("mantle.order.OrderItemBilling", {invoiceId}).map(row => row.orderId))
    if (!orderIds.length) unavailable()
    return {invoiceId, orderIds, organizationPartyId: invoice.fromPartyId, customerPartyId: invoice.toPartyId}
}

;({
    getShipment,
    checkInvoice,
    partKinds,
    salesCovers,
    seesOrder,
    canFile,
    mayApply,
    validateSave,
    checkLines,
    effects,
    apply
})
