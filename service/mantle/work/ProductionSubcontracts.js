// Manufacturing's outside processing (design-manufacturing SubcontractOperations and SubcontractDetail, crosscut
// CX-SUBCONTRACT, D14; impl-manufacturing P14): request#SubcontractService asks for an operation of a released run to be done
// by a supplier (a ProductionSubcontract, an RqTpProduct Requirement of the service with a RequirementSupply demand link to
// the operation, put in the current supply plans for a buyer to convert, SupplyPlanning.js convertOutside);
// store#ProductionSubcontract changes the agreement; get#SubcontractMaterials, get#SubcontractStatus and
// find#SubcontractOperations read the components sent, held at the vendor, consumed and returned, the service line, the
// output and its acceptance, and the worklist; get#SubcontractOrder and get#SubcontractShipment read a subcontract's purchase
// order and dispatch for OrderDetail and ShipmentDetail. The service's cost events are derived here for
// record#ProductionCostEvent's sources table: the accrual at service acceptance (receive#SubcontractOutput) and the price
// variance of a matched bill (InvoiceMatch.js apply), both awaiting the cost close.
//
// The purchase price, the price basis note and the order line's amount are read only by a buyer or a supplier-price or
// financial reader (priceReaders); a production reader sees the quantities, dates and states, never the price (§2).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const {find, one, rows, call, denied, access, dateText, ms} = lib

const SUBCONTRACT = "mantle.work.production.ProductionSubcontract",
    WORK = "mantle.work.effort.WorkEffort",
    LINE = "mantle.work.production.ProductionRunLine",
    PRODUCT = "mantle.product.Product",
    FACILITY = "mantle.facility.Facility",
    ASSET = "mantle.product.asset.Asset",
    ISSUANCE = "mantle.product.issuance.AssetIssuance",
    RECEIPT = "mantle.product.receipt.AssetReceipt",
    REQUIREMENT = "mantle.request.requirement.Requirement",
    REQUIREMENT_PARTY = "mantle.request.requirement.RequirementParty",
    SUPPLY = "mantle.request.requirement.RequirementSupply",
    ITEM = "mantle.order.OrderItem",
    HEADER = "mantle.order.OrderHeader",
    PART = "mantle.order.OrderPart",
    OIWE = "mantle.order.OrderItemWorkEffort",
    ACCEPTANCE = "mantle.order.purchase.ServiceAcceptance",
    MATCH_LINE = "mantle.account.invoice.InvoiceMatchLine",
    SHIPMENT = "mantle.shipment.Shipment",
    SEGMENT = "mantle.shipment.ShipmentRouteSegment",
    EVENT = "mantle.work.production.ProductionCostEvent"
const runPurpose = "WepProductionRun"
const requestableStatuses = ["WeApproved", "WeInProgress", "WeOnHold"]
const openSubcontractStatuses = ["PscRequested", "PscOrdered"]
const demandSupplyType = "RstOperationDemand"
const readPermissions = ["PRODUCTION_VIEW", "PRODUCTION_PLAN", "PURCHASE_ORDER_EDIT"]
const priceReaders = ["PURCHASE_ORDER_EDIT", "SUPPLIER_PRICE_VIEW", "SUPPLIER_PRICE_EDIT", "ACCOUNTING_VIEW"]
const closedOrderStatuses = ["OrderCancelled", "OrderRejected"]
const draftOrderStatuses = ["OrderOpen", "OrderProposed"]
const listLimit = 500

const zero = () => toDecimal(0)
const dec = value => toDecimal(value == null || value === "" ? 0 : value)
const blank = value => value == null || String(value).trim() === ""
const str = value => (blank(value) ? null : String(value).trim())
const text = value => (value == null ? null : dec(value).compare(0) === 0 ? "0" : String(dec(value).toNumber()))
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "")
const uomText = uomId => (uomId ? one("moqui.basic.Uom", {uomId})?.abbreviation || uomId : "")
const facilityName = facility => (facility ? facility.facilityName || facility.facilityId : "")
const partyName = partyId => (partyId ? lib.partyNames([partyId])[partyId] || partyId : "")
const productName = productId => (productId ? one(PRODUCT, {productId})?.productName || productId : "")
const production = () => ec.resource.script("component://mr-mantle/service/mantle/work/Production.js")
const transfers = () => ec.resource.script("component://mr-mantle/service/mantle/shipment/Transfers.js")
const sum = (list, field) => list.reduce((total, row) => total.add(dec(row[field])), zero())
const priceRead = () => priceReaders.some(access.has)
function requireAny(permissions) {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "A signed-in user is required")
    if (!permissions.some(access.has)) denied("PERMISSION_DENIED", permissions.join(" or ") + " is required")
}

// ===== the records =====
// An operation of a production run of the user's organizations, with its run (Production.js runOf checks the owner and the
// facility); a run's id, or another kind of work, is refused alike.
function operationOf(userScope, operationWorkEffortId) {
    const operation = blank(operationWorkEffortId) ? null : one(WORK, {workEffortId: operationWorkEffortId})
    const parent = operation?.parentWorkEffortId ? one(WORK, {workEffortId: operation.parentWorkEffortId}) : null
    if (!operation || parent?.purposeEnumId !== runPurpose)
        denied("RECORD_UNAVAILABLE", "Operation " + (operationWorkEffortId || "") + " is not available")
    return {operation, run: production().runOf(userScope, parent.workEffortId)}
}
// The subcontract given, else the open one (else the latest) of the operation given; null when the operation has none.
function subcontractOf(userScope, p, lock = false) {
    let subcontract = null
    if (!blank(p.productionSubcontractId)) {
        subcontract = find(SUBCONTRACT, {productionSubcontractId: p.productionSubcontractId}).forUpdate(lock).one()
        if (!subcontract || !facilityScope.owns(userScope, subcontract.organizationPartyId))
            denied("RECORD_UNAVAILABLE", "Subcontract " + p.productionSubcontractId + " is not available")
    } else if (!blank(p.operationWorkEffortId)) {
        const all = Array.from(
            find(SUBCONTRACT, {operationWorkEffortId: p.operationWorkEffortId}).orderBy("-createdDate").forUpdate(lock).list()
        )
        subcontract = all.find(row => openSubcontractStatuses.includes(row.statusId)) || all[0] || null
    }
    return subcontract
}
// A supplier: an organization or person in the Supplier role, not one of the user's organizations.
function supplierOf(supplierPartyId) {
    if (blank(supplierPartyId)) return null
    if (!one("mantle.party.PartyRole", {partyId: supplierPartyId, roleTypeId: "Supplier"}))
        denied("SUPPLIER_INVALID", "Party " + supplierPartyId + " is not a supplier")
    return String(supplierPartyId)
}
// A vendor-custody facility of the run's organization whose Custodian is the supplier (Warehouse P15's), else a refusal.
function vendorFacilityOf(userScope, facilityId, organizationPartyId, supplierPartyId) {
    if (blank(facilityId)) return null
    const facility = one(FACILITY, {facilityId})
    if (!facility || !facilityScope.owns(userScope, facility.ownerPartyId) || facility.ownerPartyId !== organizationPartyId)
        denied("RECORD_UNAVAILABLE", "Facility " + facilityId + " is not available")
    const custodian = transfers().custodianOf(facility.facilityId)
    if (!custodian) denied("NOT_CUSTODY", facilityName(facility) + " is not a vendor-custody facility")
    if (supplierPartyId && custodian !== supplierPartyId)
        denied("CUSTODIAN_MISMATCH", facilityName(facility) + " is in the custody of " + partyName(custodian))
    return facility.facilityId
}
function serviceProductOf(productId) {
    const product = blank(productId) ? null : one(PRODUCT, {productId})
    if (!product) denied("PRODUCT_REQUIRED", "Choose the service product")
    if (product.productTypeEnumId !== "PtService") denied("NOT_SERVICE", productName(productId) + " is not a service product")
    return product
}
function positiveQuantity(value) {
    let quantity
    try {
        quantity = dec(value)
    } catch (error) {
        denied("QUANTITY_INVALID", "Give the quantity of the service")
    }
    if (quantity.compare(0) <= 0) denied("QUANTITY_INVALID", "Give the quantity of the service")
    return quantity
}
function leadDaysOf(value) {
    if (blank(value)) return null
    const days = dec(value)
    if (days.compare(0) < 0 || days.compare(365) > 0) denied("LEAD_TIME_INVALID", "The lead time is from 0 to 365 days")
    return days
}
const startOf = (requiredByDate, leadTimeDays) =>
    requiredByDate && leadTimeDays != null ? new Date(ms(requiredByDate) - dec(leadTimeDays).toNumber() * 86400000) : null
// The supplier of a requirement: its Supplier RequirementParty, replaced by an end and a new row when it changes.
function setRequirementSupplier(requirementId, supplierPartyId) {
    const current = rows(REQUIREMENT_PARTY, {requirementId, roleTypeId: "Supplier"}).filter(row => lib.active(row))
    if (current.length === 1 && current[0].partyId === supplierPartyId) return
    for (const row of current)
        call("update#" + REQUIREMENT_PARTY, {
            requirementId,
            partyId: row.partyId,
            roleTypeId: "Supplier",
            fromDate: row.fromDate,
            thruDate: ec.user.nowTimestamp
        })
    if (supplierPartyId)
        call("create#" + REQUIREMENT_PARTY, {
            requirementId,
            partyId: supplierPartyId,
            roleTypeId: "Supplier",
            fromDate: ec.user.nowTimestamp
        })
}
const planning = () => ec.resource.script("component://mr-mantle/service/mantle/product/SupplyPlanning.js")

// ===== request#SubcontractService =====
// The operation's outside processing asked for: the subcontract, its requirement (the organization's OrgInternal party, the
// supplier's Supplier party), the demand link to the operation, and its suggestion in the current supply plans.
function request(p) {
    const userScope = facilityScope.scope()
    const {operation, run} = operationOf(userScope, p.operationWorkEffortId)
    if (!requestableStatuses.includes(run.statusId))
        denied("RUN_NOT_RELEASED", "Work order " + run.workEffortId + " is " + statusText(run.statusId))
    // an operation with an open subcontract, or already on a service purchase line not cancelled, is subcontracted
    if (
        Array.from(find(SUBCONTRACT, {operationWorkEffortId: operation.workEffortId}).list()).some(row =>
            openSubcontractStatuses.includes(row.statusId)
        ) ||
        serviceLinesOf(operation.workEffortId, false).some(line => !line.cancelled)
    )
        denied(
            "SUBCONTRACT_EXISTS",
            "Operation " + (operation.workEffortName || operation.workEffortId) + " is already subcontracted"
        )
    const product = serviceProductOf(p.productId)
    const quantity = positiveQuantity(p.quantity)
    const quantityUomId = str(p.quantityUomId) || product.amountUomId || null
    const supplierPartyId = supplierOf(p.supplierPartyId)
    const vendorFacilityId = vendorFacilityOf(userScope, p.vendorFacilityId, run.ownerPartyId, supplierPartyId)
    const leadTimeDays = leadDaysOf(p.leadTimeDays)
    const requiredByDate =
        p.requiredByDate || operation.estimatedCompletionDate || run.estimatedCompletionDate || ec.user.nowTimestamp
    const requirementId = call("create#" + REQUIREMENT, {
        requirementTypeEnumId: "RqTpProduct",
        statusId: "RqmtStProposed",
        facilityId: run.facilityId || null,
        productId: product.productId,
        quantity,
        quantityUomId,
        requiredByDate,
        requirementStartDate: startOf(requiredByDate, leadTimeDays) || requiredByDate,
        description:
            "Outside processing of " +
            (operation.workEffortName || operation.workEffortId) +
            " for work order " +
            run.workEffortId
    }).requirementId
    call("create#" + REQUIREMENT_PARTY, {
        requirementId,
        partyId: run.ownerPartyId,
        roleTypeId: "OrgInternal",
        fromDate: ec.user.nowTimestamp
    })
    setRequirementSupplier(requirementId, supplierPartyId)
    call("create#" + SUPPLY, {
        requirementId,
        supplyTypeEnumId: demandSupplyType,
        workEffortId: operation.workEffortId,
        quantity,
        quantityUomId,
        operationKey: p.operationKey || null,
        fromDate: ec.user.nowTimestamp,
        createdByUserId: ec.user.userId
    })
    const productionSubcontractId = call("create#" + SUBCONTRACT, {
        organizationPartyId: run.ownerPartyId,
        workEffortId: run.workEffortId,
        operationWorkEffortId: operation.workEffortId,
        requirementId,
        supplierPartyId,
        productId: product.productId,
        quantity,
        quantityUomId,
        requiredByDate,
        leadTimeDays,
        vendorFacilityId,
        priceBasisNote: priceRead() ? str(p.priceBasisNote) : null,
        statusId: "PscRequested",
        revision: 1,
        changeReason: str(p.changeReason),
        createdDate: ec.user.nowTimestamp,
        createdByUserId: ec.user.userId,
        lastChangedByUserId: ec.user.userId
    }).productionSubcontractId
    const planningRunIds = planning().planOutside(requirementId)
    return {
        resultCode: "REQUESTED",
        productionSubcontractId,
        requirementId,
        organizationPartyId: run.ownerPartyId,
        workEffortId: run.workEffortId,
        operationWorkEffortId: operation.workEffortId,
        planningRunIds
    }
}

// ===== store#ProductionSubcontract =====
// A change of the agreement at the revision the user read: before its purchase line the planner changes the supplier, the
// quantity, the unit, the required date and the lead time (the requirement, its supplier, its demand link and its plan
// suggestions follow); after it only the lead time, the vendor facility and the price basis, since the order is the
// buyer's. The price basis is a buyer's or price reader's.
function store(p) {
    const userScope = facilityScope.scope()
    const subcontract = subcontractOf(userScope, {productionSubcontractId: p.productionSubcontractId}, true)
    if (!subcontract) denied("RECORD_UNAVAILABLE", "Subcontract " + (p.productionSubcontractId || "") + " is not available")
    const {run} = operationOf(userScope, subcontract.operationWorkEffortId)
    if (blank(p.expectedRevision) || Number(p.expectedRevision) !== Number(subcontract.revision || 0))
        denied("REVISION_CHANGED", "Subcontract " + subcontract.productionSubcontractId + " changed; reload it")
    if (!openSubcontractStatuses.includes(subcontract.statusId))
        denied(
            "SUBCONTRACT_CLOSED",
            "Subcontract " + subcontract.productionSubcontractId + " is " + statusText(subcontract.statusId)
        )
    const ordered = !!subcontract.orderId
    const agreementFields = ["supplierPartyId", "quantity", "quantityUomId", "requiredByDate"]
    const planFields = agreementFields.concat(["leadTimeDays", "vendorFacilityId", "changeReason"])
    const given = field => p[field] !== undefined && p[field] !== null
    const changesPlan = planFields.some(given)
    if (changesPlan && !access.has("PRODUCTION_PLAN")) denied("PERMISSION_DENIED", "PRODUCTION_PLAN is required")
    if (given("priceBasisNote") && !priceRead()) denied("PERMISSION_DENIED", "A buyer's or price reader's permission is required")
    const changed = name => {
        if (!given(name)) return false
        const before = subcontract[name]
        if (name === "quantity") return dec(p.quantity).compare(dec(before)) !== 0
        if (name === "requiredByDate") return ms(p.requiredByDate) !== ms(before)
        return String(p[name] ?? "") !== String(before ?? "")
    }
    if (ordered && agreementFields.some(changed))
        denied(
            "SUBCONTRACT_ORDERED",
            "Subcontract " +
                subcontract.productionSubcontractId +
                " is on order " +
                subcontract.orderId +
                "; the buyer changes it"
        )
    const supplierPartyId = given("supplierPartyId") ? supplierOf(p.supplierPartyId) : subcontract.supplierPartyId
    const quantity = given("quantity") ? positiveQuantity(p.quantity) : dec(subcontract.quantity)
    const quantityUomId = given("quantityUomId") ? str(p.quantityUomId) : subcontract.quantityUomId
    const requiredByDate = given("requiredByDate") ? p.requiredByDate : subcontract.requiredByDate
    const leadTimeDays = given("leadTimeDays") ? leadDaysOf(p.leadTimeDays) : subcontract.leadTimeDays
    const vendorFacilityId = given("vendorFacilityId")
        ? vendorFacilityOf(userScope, p.vendorFacilityId, run.ownerPartyId, supplierPartyId)
        : subcontract.vendorFacilityId
    if (vendorFacilityId && supplierPartyId && transfers().custodianOf(vendorFacilityId) !== supplierPartyId)
        denied("CUSTODIAN_MISMATCH", "The vendor facility is not in the custody of " + partyName(supplierPartyId))
    const revision = Number(subcontract.revision || 0) + 1
    call("update#" + SUBCONTRACT, {
        productionSubcontractId: subcontract.productionSubcontractId,
        supplierPartyId,
        quantity,
        quantityUomId,
        requiredByDate,
        leadTimeDays,
        vendorFacilityId,
        priceBasisNote: given("priceBasisNote") ? str(p.priceBasisNote) : subcontract.priceBasisNote,
        changeReason: given("changeReason") ? str(p.changeReason) : subcontract.changeReason,
        revision,
        lastChangedByUserId: ec.user.userId
    })
    if (!ordered && subcontract.requirementId) {
        call("update#" + REQUIREMENT, {
            requirementId: subcontract.requirementId,
            quantity,
            quantityUomId,
            requiredByDate,
            requirementStartDate: startOf(requiredByDate, leadTimeDays) || requiredByDate
        })
        setRequirementSupplier(subcontract.requirementId, supplierPartyId)
        for (const link of rows(SUPPLY, {requirementId: subcontract.requirementId, supplyTypeEnumId: demandSupplyType}))
            call("update#" + SUPPLY, {requirementSupplyId: link.requirementSupplyId, quantity, quantityUomId})
        planning().planOutside(subcontract.requirementId)
    }
    return {
        resultCode: "STORED",
        productionSubcontractId: subcontract.productionSubcontractId,
        revision,
        organizationPartyId: subcontract.organizationPartyId
    }
}

// ===== the service lines and the dispatches of an operation =====
// The purchase lines of an operation's service (OrderItemWorkEffort), with what was accepted and billed; the price only for a
// price reader.
function serviceLinesOf(operationWorkEffortId, prices) {
    return rows(OIWE, {workEffortId: operationWorkEffortId})
        .map(link => {
            const item = one(ITEM, {orderId: link.orderId, orderItemSeqId: link.orderItemSeqId})
            if (!item) return null
            const header = one(HEADER, {orderId: item.orderId})
            const part = one(PART, {orderId: item.orderId, orderPartSeqId: item.orderPartSeqId})
            const ordered = dec(item.quantity).subtract(dec(item.quantityCancelled))
            const acceptances = rows(ACCEPTANCE, {orderId: item.orderId, orderItemSeqId: item.orderItemSeqId})
            const accepted = sum(acceptances, "acceptedQuantity")
            const billings = rows("mantle.order.OrderItemBilling", {orderId: item.orderId, orderItemSeqId: item.orderItemSeqId})
            const billed = sum(billings, "quantity")
            const left = ordered.subtract(accepted)
            const exceptions = rows(MATCH_LINE, {orderId: item.orderId, orderItemSeqId: item.orderItemSeqId})
                .filter(row => row.exceptionEnumId)
                .map(row => ({
                    invoiceId: row.invoiceId,
                    invoiceMatchId: row.invoiceMatchId,
                    exceptionText: row.exceptionText || enumText(row.exceptionEnumId)
                }))
            const row = {
                orderId: item.orderId,
                orderItemSeqId: item.orderItemSeqId,
                orderStatusId: header?.statusId || null,
                orderStatusText: statusText(header?.statusId),
                draft: draftOrderStatuses.includes(header?.statusId),
                cancelled: closedOrderStatuses.includes(header?.statusId) || closedOrderStatuses.includes(item.statusId),
                supplierPartyId: part?.vendorPartyId || null,
                supplierName: partyName(part?.vendorPartyId),
                organizationPartyId: part?.customerPartyId || null,
                productId: item.productId || null,
                productName: productName(item.productId),
                description: item.itemDescription || productName(item.productId),
                quantity: text(ordered),
                quantityUomId: item.quantityUomId || null,
                uomText: uomText(item.quantityUomId),
                acceptedQuantity: text(accepted),
                billedQuantity: text(billed),
                remainingQuantity: text(left.compare(0) > 0 ? left : zero()),
                requiredWork: link.requiredWork === "Y",
                acceptances: acceptances
                    .sort((a, b) => (ms(a.acceptedDate) || 0) - (ms(b.acceptedDate) || 0))
                    .map(acceptance => ({
                        serviceAcceptanceId: acceptance.serviceAcceptanceId,
                        acceptedQuantity: text(acceptance.acceptedQuantity),
                        acceptedDateText: dateText(acceptance.acceptedDate),
                        assetReceiptId: acceptance.assetReceiptId || null,
                        qualityInspectionId: acceptance.qualityInspectionId || null,
                        acceptorName: partyName(acceptance.acceptorPartyId)
                    })),
                invoiceIds: Array.from(
                    new Set(billings.filter(row => dec(row.quantity).compare(0) > 0).map(row => row.invoiceId))
                ),
                matchExceptions: exceptions
            }
            // the price, its total and the currency only for a price reader; left out, never zero (§2)
            if (prices)
                Object.assign(row, {
                    unitAmount: text(item.unitAmount),
                    lineAmount: item.unitAmount == null ? null : text(dec(item.unitAmount).multiply(ordered)),
                    currencyUomId: header?.currencyUomId || null
                })
            return row
        })
        .filter(Boolean)
}
// The subcontract dispatches and returns of an operation (Warehouse's ShpTpTransfer shipments with its subcontract keys):
// each with its direction, its vendor facility and its lines' quantities sent, moved and received.
function shipmentsOf(operationWorkEffortId) {
    return rows(SHIPMENT, {subcontractWorkEffortId: operationWorkEffortId})
        .filter(shipment => shipment.statusId !== "ShipCancelled")
        .map(shipment => {
            const segments = rows(SEGMENT, {shipmentId: shipment.shipmentId}).sort((a, b) =>
                String(a.shipmentRouteSegmentSeqId).localeCompare(String(b.shipmentRouteSegmentSeqId))
            )
            const originFacilityId = segments[0]?.originFacilityId || null
            const destinationFacilityId = segments.length ? segments[segments.length - 1].destinationFacilityId : null
            const toVendor = !!transfers().custodianOf(destinationFacilityId)
            const lines = transfers()
                .linesOf(shipment.shipmentId)
                .map(line => ({
                    productId: line.source.productId,
                    quantity: line.quantity,
                    // what reached the other end: moved directly, or shipped and received there
                    delivered: line.moved.add(line.accepted),
                    inTransit: line.inTransit
                }))
            return {
                shipment,
                shipmentId: shipment.shipmentId,
                direction: toVendor ? "dispatch" : "return",
                directionText: toVendor ? "Sent to the supplier" : "Returned from the supplier",
                vendorFacilityId: toVendor ? destinationFacilityId : originFacilityId,
                originFacilityId,
                destinationFacilityId,
                statusId: shipment.statusId,
                statusText: statusText(shipment.statusId),
                dateText: dateText(shipment.estimatedShipDate || shipment.createdDate),
                lines
            }
        })
}
// The output line of an operation (its own, else the run's) and its receipts on that operation.
function outputOf(run, operationWorkEffortId) {
    const outputs = production()
        .linesOf(run.workEffortId)
        .filter(line => line.lineRoleEnumId === "PrlrOutput")
    const line = outputs.find(row => row.operationWorkEffortId === operationWorkEffortId) || outputs[0] || null
    const receipts = line
        ? rows(RECEIPT, {productionOutputLineId: line.productionRunLineId}).filter(
              row => !row.operationWorkEffortId || row.operationWorkEffortId === operationWorkEffortId
          )
        : []
    return {line, receipts}
}

// ===== get#SubcontractMaterials =====
// The components of the subcontracted operation (its material lines, else the run's): each with its owner, quantity and unit,
// what was sent to the vendor-custody facility and returned from it, what is held there now, and what was consumed (issued to
// the run from there); and the dispatches and returns with their state.
function materials(p) {
    requireAny(readPermissions.concat(["STOCK_ISSUE"]))
    const userScope = facilityScope.scope()
    const {operation, run} = operationOf(userScope, p.operationWorkEffortId)
    const subcontract = subcontractOf(userScope, {operationWorkEffortId: operation.workEffortId})
    const shipments = shipmentsOf(operation.workEffortId)
    const vendorFacilityId =
        subcontract?.vendorFacilityId || shipments.find(row => row.direction === "dispatch")?.vendorFacilityId || null
    const vendorFacility = vendorFacilityId ? one(FACILITY, {facilityId: vendorFacilityId}) : null
    const all = production()
        .linesOf(run.workEffortId)
        .filter(line => line.lineRoleEnumId === "PrlrMaterial")
    const own = all.filter(line => line.operationWorkEffortId === operation.workEffortId)
    const lines = own.length ? own : all
    const quantityOf = (productId, direction) =>
        shipments
            .filter(row => row.direction === direction)
            .flatMap(row => row.lines)
            .filter(row => row.productId === productId)
            .reduce((total, row) => total.add(row.delivered), zero())
    const atVendor = productId =>
        vendorFacilityId
            ? sum(rows(ASSET, {facilityId: vendorFacilityId, productId, ownerPartyId: run.ownerPartyId}), "quantityOnHandTotal")
            : zero()
    const vendorAssetIds = vendorFacilityId
        ? new Set(Array.from(find(ASSET, {facilityId: vendorFacilityId}).selectField("assetId").list()).map(row => row.assetId))
        : new Set()
    const ownerName = partyName(run.ownerPartyId)
    const materialRows = lines.map(line => {
        const totals = production().materialTotals(line)
        const consumed = rows(ISSUANCE, {productionMaterialLineId: line.productionRunLineId})
            .filter(row => vendorAssetIds.has(row.assetId))
            .reduce((total, row) => total.add(dec(row.quantity)), zero())
        return {
            productionRunLineId: line.productionRunLineId,
            productId: line.productId,
            productName: productName(line.productId),
            ownerPartyId: run.ownerPartyId,
            ownerName,
            quantity: text(line.stockQuantity),
            quantityUomId: line.stockUomId || null,
            uomText: uomText(line.stockUomId),
            sentQuantity: text(quantityOf(line.productId, "dispatch")),
            returnedQuantity: text(quantityOf(line.productId, "return")),
            atVendorQuantity: text(atVendor(line.productId)),
            consumedQuantity: text(consumed),
            issuedQuantity: text(totals.net),
            remainingQuantity: text(totals.remaining)
        }
    })
    return {
        workEffortId: run.workEffortId,
        operationWorkEffortId: operation.workEffortId,
        organizationPartyId: run.ownerPartyId,
        vendorFacilityId,
        vendorFacilityName: facilityName(vendorFacility),
        custodianName: partyName(vendorFacilityId ? transfers().custodianOf(vendorFacilityId) : null),
        materials: materialRows,
        shipments: shipments.map(row => ({
            shipmentId: row.shipmentId,
            direction: row.direction,
            directionText: row.directionText,
            statusId: row.statusId,
            statusText: row.statusText,
            dateText: row.dateText,
            vendorFacilityName: facilityName(one(FACILITY, {facilityId: row.vendorFacilityId})),
            lineText: row.lines.map(line => text(line.quantity) + " " + productName(line.productId)).join(", ")
        }))
    }
}

// ===== get#SubcontractStatus =====
// The state of an operation's outside processing, in the order of its steps.
function stateOf(subcontract, lines, shipments, received, accepted, ordered) {
    const open = lines.filter(line => !line.cancelled)
    if (subcontract?.statusId && !openSubcontractStatuses.includes(subcontract.statusId))
        return {stateText: statusText(subcontract.statusId), stateColor: "grey"}
    if (!open.length) return {stateText: "Requested", stateColor: "primary"}
    if (open.every(line => line.draft)) return {stateText: "Draft purchase order", stateColor: "warning"}
    if (ordered.compare(0) > 0 && accepted.compare(ordered) >= 0) return {stateText: "Accepted", stateColor: "positive"}
    if (received.compare(0) > 0) return {stateText: "Output received", stateColor: "info"}
    if (shipments.some(row => row.direction === "dispatch")) return {stateText: "Components sent", stateColor: "info"}
    return {stateText: "Ordered", stateColor: "primary"}
}
function agreementRow(subcontract, prices) {
    if (!subcontract) return null
    const row = {
        productionSubcontractId: subcontract.productionSubcontractId,
        statusId: subcontract.statusId,
        statusText: statusText(subcontract.statusId),
        supplierPartyId: subcontract.supplierPartyId || null,
        supplierName: partyName(subcontract.supplierPartyId),
        productId: subcontract.productId,
        productName: productName(subcontract.productId),
        quantity: text(subcontract.quantity),
        quantityUomId: subcontract.quantityUomId || null,
        uomText: uomText(subcontract.quantityUomId),
        requiredByDate: subcontract.requiredByDate || null,
        requiredByText: dateText(subcontract.requiredByDate),
        leadTimeDays: text(subcontract.leadTimeDays),
        vendorFacilityId: subcontract.vendorFacilityId || null,
        vendorFacilityName: facilityName(
            subcontract.vendorFacilityId ? one(FACILITY, {facilityId: subcontract.vendorFacilityId}) : null
        ),
        requirementId: subcontract.requirementId || null,
        requirementStatusText: subcontract.requirementId
            ? statusText(one(REQUIREMENT, {requirementId: subcontract.requirementId})?.statusId)
            : "",
        orderId: subcontract.orderId || null,
        orderItemSeqId: subcontract.orderItemSeqId || null,
        ordered: !!subcontract.orderId,
        revision: Number(subcontract.revision || 0),
        changeReason: subcontract.changeReason || null,
        createdText: dateText(subcontract.createdDate)
    }
    if (prices) row.priceBasisNote = subcontract.priceBasisNote || null
    return row
}
function status(p) {
    requireAny(readPermissions.concat(["STOCK_ISSUE"]))
    const userScope = facilityScope.scope()
    const {operation, run} = operationOf(userScope, p.operationWorkEffortId)
    const prices = priceRead()
    const financial = access.has("ACCOUNTING_VIEW")
    const subcontract = subcontractOf(userScope, {operationWorkEffortId: operation.workEffortId})
    const lines = serviceLinesOf(operation.workEffortId, prices)
    const shipments = shipmentsOf(operation.workEffortId)
    const output = outputOf(run, operation.workEffortId)
    const received = sum(output.receipts, "quantityAccepted")
    const open = lines.filter(line => !line.cancelled)
    const accepted = open.reduce((total, line) => total.add(dec(line.acceptedQuantity)), zero())
    const ordered = open.reduce((total, line) => total.add(dec(line.quantity)), zero())
    const state = stateOf(subcontract, lines, shipments, received, accepted, ordered)
    const facility = run.facilityId ? one(FACILITY, {facilityId: run.facilityId}) : null
    const events = rows(EVENT, {workEffortId: run.workEffortId, costComponentEnumId: "PrcOutside"}).filter(
        event => !event.operationWorkEffortId || event.operationWorkEffortId === operation.workEffortId
    )
    const canPlan = access.has("PRODUCTION_PLAN")
    return {
        run: {
            workEffortId: run.workEffortId,
            workEffortName: run.workEffortName || run.workEffortId,
            statusId: run.statusId,
            statusText: statusText(run.statusId),
            facilityId: run.facilityId || null,
            facilityName: facilityName(facility),
            organizationPartyId: run.ownerPartyId,
            organizationName: partyName(run.ownerPartyId)
        },
        operation: {
            workEffortId: operation.workEffortId,
            workEffortName: operation.workEffortName || operation.workEffortId,
            statusText: statusText(operation.statusId),
            estimatedCompletionText: dateText(operation.estimatedCompletionDate)
        },
        subcontract: agreementRow(subcontract, prices),
        serviceLines: lines,
        output: {
            productionRunLineId: output.line?.productionRunLineId || null,
            productId: output.line?.productId || null,
            productName: productName(output.line?.productId),
            quantity: text(output.line?.stockQuantity),
            uomText: uomText(output.line?.stockUomId),
            receivedQuantity: text(received),
            receipts: output.receipts.map(receipt => {
                const asset = one(ASSET, {assetId: receipt.assetId})
                return {
                    assetReceiptId: receipt.assetReceiptId,
                    assetId: receipt.assetId,
                    quantity: text(receipt.quantityAccepted),
                    receivedDateText: dateText(receipt.receivedDate),
                    lotId: asset?.lotId || null,
                    serialNumber: asset?.serialNumber || null,
                    held: asset?.statusId === "AstQuarantine",
                    statusText: asset?.statusId === "AstQuarantine" ? "Held for inspection" : statusText(asset?.statusId)
                }
            })
        },
        dispatchCount: shipments.filter(row => row.direction === "dispatch").length,
        returnCount: shipments.filter(row => row.direction === "return").length,
        orderedQuantity: text(ordered),
        acceptedQuantity: text(accepted),
        stateText: state.stateText,
        stateColor: state.stateColor,
        // the outside-processing cost events, their values only with financial read
        costEvents: events.map(event =>
            Object.assign(
                {
                    productionCostEventId: event.productionCostEventId,
                    eventTypeText: enumText(event.costEventTypeEnumId),
                    quantity: text(event.quantity),
                    eventDateText: dateText(event.eventDate),
                    ledgerText: enumText(event.ledgerStatusEnumId),
                    orderId: event.orderId || null,
                    invoiceId: event.invoiceId || null
                },
                financial ? {amount: text(event.amount), amountUomId: event.amountUomId || null} : {}
            )
        ),
        priceRead: prices,
        financialRead: financial,
        canRequest:
            canPlan &&
            !lines.some(line => !line.cancelled) &&
            !(subcontract && openSubcontractStatuses.includes(subcontract.statusId)),
        canEdit: (canPlan || prices) && !!subcontract && openSubcontractStatuses.includes(subcontract.statusId),
        canEditAgreement:
            canPlan && !!subcontract && !subcontract.orderId && openSubcontractStatuses.includes(subcontract.statusId),
        canEditPrice: prices && !!subcontract
    }
}

// ===== find#SubcontractOperations =====
// The outside-processing operations of the user's organizations' open runs (all runs with includeClosed): each subcontract
// and each operation with a service purchase line, newest run first, filtered by supplier, plant (the facilities under it),
// run, order status and state; a page at a time.
function findOperations(p) {
    requireAny(readPermissions)
    const userScope = facilityScope.scope()
    const prices = priceRead()
    let runQuery = find(WORK, {purposeEnumId: runPurpose})
    if (userScope.organizationPartyIds)
        runQuery = runQuery.condition("ownerPartyId", "in", userScope.organizationPartyIds.concat(["_NA_"]))
    if (!blank(p.workEffortId)) runQuery = runQuery.condition("workEffortId", p.workEffortId)
    if (!(p.includeClosed === true || p.includeClosed === "true" || p.includeClosed === "Y"))
        runQuery = runQuery.condition("statusId", "not-in", ["WeClosed", "WeCancelled"])
    if (!blank(p.facilityId)) {
        const top = one(FACILITY, {facilityId: p.facilityId})
        const tree = top ? [top.facilityId] : [String(p.facilityId)]
        for (let depth = 0, level = tree.slice(); depth < 4 && level.length; depth++) {
            level = Array.from(find(FACILITY).condition("parentFacilityId", "in", level).selectField("facilityId").list()).map(
                row => row.facilityId
            )
            tree.push(...level)
        }
        runQuery = runQuery.condition("facilityId", "in", tree)
    }
    const runs = Array.from(runQuery.orderBy("-createdDate").orderBy("-workEffortId").limit(listLimit).list()).filter(run =>
        facilityScope.owns(userScope, run.ownerPartyId)
    )
    if (!runs.length) return Object.assign({canRequest: access.has("PRODUCTION_PLAN")}, lib.pageList([], p, "operationList"))
    const runById = new Map(runs.map(run => [run.workEffortId, run]))
    const operations = Array.from(
        find(WORK)
            .condition("parentWorkEffortId", "in", Array.from(runById.keys()))
            .limit(listLimit * 4)
            .list()
    )
    const operationById = new Map(operations.map(row => [row.workEffortId, row]))
    const subcontracts = operations.length
        ? Array.from(find(SUBCONTRACT).condition("operationWorkEffortId", "in", Array.from(operationById.keys())).list())
        : []
    const linked = operations.length
        ? Array.from(
              find(OIWE).condition("workEffortId", "in", Array.from(operationById.keys())).selectField("workEffortId").list()
          )
        : []
    const operationIds = Array.from(
        new Set(subcontracts.map(row => row.operationWorkEffortId).concat(linked.map(row => row.workEffortId)))
    )
    const facilities = new Map()
    const facilityNameOf = facilityId => {
        if (!facilities.has(facilityId)) facilities.set(facilityId, facilityName(facilityId ? one(FACILITY, {facilityId}) : null))
        return facilities.get(facilityId)
    }
    let list = operationIds.map(operationWorkEffortId => {
        const operation = operationById.get(operationWorkEffortId)
        const run = runById.get(operation.parentWorkEffortId)
        const own = subcontracts.filter(row => row.operationWorkEffortId === operationWorkEffortId)
        const subcontract = own.find(row => openSubcontractStatuses.includes(row.statusId)) || own[0] || null
        const lines = serviceLinesOf(operationWorkEffortId, prices)
        const line = lines.find(row => !row.cancelled) || lines[0] || null
        const shipments = shipmentsOf(operationWorkEffortId)
        const output = outputOf(run, operationWorkEffortId)
        const received = sum(output.receipts, "quantityAccepted")
        const open = lines.filter(row => !row.cancelled)
        const accepted = open.reduce((total, row) => total.add(dec(row.acceptedQuantity)), zero())
        const ordered = open.reduce((total, row) => total.add(dec(row.quantity)), zero())
        const state = stateOf(subcontract, lines, shipments, received, accepted, ordered)
        const supplierPartyId = line?.supplierPartyId || subcontract?.supplierPartyId || null
        const productId = line?.productId || subcontract?.productId || null
        const row = {
            operationWorkEffortId,
            operationName: operation.workEffortName || operationWorkEffortId,
            workEffortId: run.workEffortId,
            runName: run.workEffortName || run.workEffortId,
            facilityName: facilityNameOf(run.facilityId),
            productionSubcontractId: subcontract?.productionSubcontractId || null,
            supplierPartyId,
            supplierName: partyName(supplierPartyId),
            productId,
            productName: productName(productId),
            orderId: line?.orderId || null,
            orderItemSeqId: line?.orderItemSeqId || null,
            orderStatusId: line?.orderStatusId || null,
            orderStatusText: line?.orderStatusText || "",
            quantity: line ? line.quantity : text(subcontract?.quantity),
            uomText: line ? line.uomText : uomText(subcontract?.quantityUomId),
            dispatchCount: shipments.filter(each => each.direction === "dispatch").length,
            receivedQuantity: text(received),
            acceptedQuantity: text(accepted),
            requiredByDate: subcontract?.requiredByDate || operation.estimatedCompletionDate || null,
            requiredByText: dateText(subcontract?.requiredByDate || operation.estimatedCompletionDate),
            stateText: state.stateText,
            stateColor: state.stateColor,
            exception: lines.some(each => each.matchExceptions.length) || (!!subcontract && !supplierPartyId)
        }
        if (prices && line) Object.assign(row, {unitAmount: line.unitAmount, currencyUomId: line.currencyUomId})
        return row
    })
    if (!blank(p.supplierPartyId)) list = list.filter(row => row.supplierPartyId === p.supplierPartyId)
    if (!blank(p.orderStatusId)) list = list.filter(row => row.orderStatusId === p.orderStatusId)
    if (!blank(p.stateText)) list = list.filter(row => row.stateText === p.stateText)
    if (p.exceptionsOnly === true || p.exceptionsOnly === "true" || p.exceptionsOnly === "Y")
        list = list.filter(row => row.exception)
    list.sort((a, b) => (ms(a.requiredByDate) || 0) - (ms(b.requiredByDate) || 0))
    return Object.assign({canRequest: access.has("PRODUCTION_PLAN")}, lib.pageList(list, p, "operationList"))
}

// ===== get#SubcontractOrder =====
// An order as Manufacturing reads it (crosscut §3.6 Manufacturing row): a subcontract purchase order with a service line of
// an operation of a run the user sees, or a sales order a run of theirs supplies; its header and each item with its
// production links (a service line's run and operation, with what was accepted; a sales line's supplying runs). Prices only
// for a price reader (a purchase) or a price viewer (a sale).
function order(p) {
    requireAny(readPermissions)
    const userScope = facilityScope.scope()
    const header = blank(p.orderId) ? null : one(HEADER, {orderId: p.orderId})
    if (!header) denied("RECORD_UNAVAILABLE", "Order " + (p.orderId || "") + " is not available")
    const items = rows(ITEM, {orderId: header.orderId}).sort((a, b) =>
        String(a.orderItemSeqId).localeCompare(String(b.orderItemSeqId))
    )
    const parts = rows(PART, {orderId: header.orderId})
    const visibleRun = workEffortId => {
        try {
            return production().runOf(userScope, workEffortId)
        } catch (error) {
            return null
        }
    }
    const internal = partyId => !!partyId && !!one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
    const purchase = parts.some(part => internal(part.customerPartyId) && !internal(part.vendorPartyId))
    const prices = purchase ? priceRead() : ["PRICE_VIEW", "PRICE_EDIT", "ACCOUNTING_VIEW"].some(access.has)
    let linkedCount = 0
    const itemRows = items.map(item => {
        const links = []
        for (const link of rows(OIWE, {orderId: item.orderId, orderItemSeqId: item.orderItemSeqId})) {
            const work = one(WORK, {workEffortId: link.workEffortId})
            const runId = work?.purposeEnumId === runPurpose ? work.workEffortId : work?.parentWorkEffortId
            const run = runId ? visibleRun(runId) : null
            if (!run) continue
            links.push({
                kind: "operation",
                workEffortId: run.workEffortId,
                runName: run.workEffortName || run.workEffortId,
                operationWorkEffortId: work.workEffortId === run.workEffortId ? null : work.workEffortId,
                operationName: work.workEffortId === run.workEffortId ? "" : work.workEffortName || work.workEffortId,
                statusText: statusText(run.statusId)
            })
        }
        for (const run of rows(WORK, {purposeEnumId: runPurpose, demandOrderId: item.orderId}))
            if ((!run.demandOrderItemSeqId || run.demandOrderItemSeqId === item.orderItemSeqId) && visibleRun(run.workEffortId))
                links.push({
                    kind: "run",
                    workEffortId: run.workEffortId,
                    runName: run.workEffortName || run.workEffortId,
                    operationWorkEffortId: null,
                    operationName: "",
                    statusText: statusText(run.statusId)
                })
        linkedCount += links.length
        const ordered = dec(item.quantity).subtract(dec(item.quantityCancelled))
        const accepted = sum(rows(ACCEPTANCE, {orderId: item.orderId, orderItemSeqId: item.orderItemSeqId}), "acceptedQuantity")
        const row = {
            orderItemSeqId: item.orderItemSeqId,
            productId: item.productId || null,
            description: item.itemDescription || productName(item.productId),
            quantity: text(ordered),
            uomText: uomText(item.quantityUomId),
            acceptedQuantity: links.some(link => link.kind === "operation") ? text(accepted) : null,
            requiredByText: dateText(item.requiredByDate),
            links,
            linkText: links
                .map(link =>
                    link.operationWorkEffortId
                        ? link.operationName + " of work order " + link.workEffortId
                        : "Work order " + link.workEffortId
                )
                .join(", ")
        }
        if (prices) Object.assign(row, {unitAmount: text(item.unitAmount), currencyUomId: header.currencyUomId || null})
        return row
    })
    // an order linked to none of the user's runs is not Manufacturing's to show
    if (!linkedCount) denied("RECORD_UNAVAILABLE", "Order " + header.orderId + " is not available")
    const part = parts[0] || {}
    return {
        orderId: header.orderId,
        orderName: header.orderName || null,
        statusId: header.statusId,
        statusText: statusText(header.statusId),
        purchase,
        directionText: purchase ? "Purchase order" : "Sales order",
        vendorPartyId: part.vendorPartyId || null,
        vendorName: partyName(part.vendorPartyId),
        customerPartyId: part.customerPartyId || null,
        customerName: partyName(part.customerPartyId),
        entryDateText: dateText(header.entryDate),
        placedDateText: dateText(header.placedDate),
        currencyUomId: prices ? header.currencyUomId || null : null,
        grandTotal: prices && header.grandTotal != null ? text(header.grandTotal) : null,
        items: itemRows,
        priceRead: prices
    }
}

// ===== get#SubcontractShipment =====
// A subcontract dispatch or return as Manufacturing reads it (crosscut §3.8 Manufacturing row, read only): its lines with
// what was sent, moved and received, the run and operation, the vendor-custody facility, its custodian, and the owner of the
// stock (the organization's throughout).
function shipment(p) {
    requireAny(readPermissions.concat(["STOCK_ISSUE"]))
    const userScope = facilityScope.scope()
    const row = blank(p.shipmentId) ? null : one(SHIPMENT, {shipmentId: p.shipmentId})
    if (!row || !row.subcontractWorkEffortId)
        denied("RECORD_UNAVAILABLE", "Shipment " + (p.shipmentId || "") + " is not available")
    const work = one(WORK, {workEffortId: row.subcontractWorkEffortId})
    const runId = work?.purposeEnumId === runPurpose ? work.workEffortId : work?.parentWorkEffortId
    let run
    try {
        run = production().runOf(userScope, runId)
    } catch (error) {
        denied("RECORD_UNAVAILABLE", "Shipment " + row.shipmentId + " is not available")
    }
    const found = shipmentsOf(row.subcontractWorkEffortId).find(each => each.shipmentId === row.shipmentId)
    const vendorFacility = found?.vendorFacilityId ? one(FACILITY, {facilityId: found.vendorFacilityId}) : null
    const origin = found?.originFacilityId ? one(FACILITY, {facilityId: found.originFacilityId}) : null
    const destination = found?.destinationFacilityId ? one(FACILITY, {facilityId: found.destinationFacilityId}) : null
    return {
        shipmentId: row.shipmentId,
        statusId: row.statusId,
        statusText: statusText(row.statusId),
        direction: found?.direction || null,
        directionText: found?.directionText || "",
        workEffortId: run.workEffortId,
        runName: run.workEffortName || run.workEffortId,
        operationWorkEffortId: work.workEffortId === run.workEffortId ? null : work.workEffortId,
        operationName: work.workEffortName || work.workEffortId,
        orderId: row.subcontractOrderId || null,
        orderItemSeqId: row.subcontractOrderItemSeqId || null,
        originName: facilityName(origin),
        destinationName: facilityName(destination),
        vendorFacilityId: vendorFacility?.facilityId || null,
        vendorFacilityName: facilityName(vendorFacility),
        custodianName: partyName(vendorFacility ? transfers().custodianOf(vendorFacility.facilityId) : null),
        ownerPartyId: run.ownerPartyId,
        ownerName: partyName(run.ownerPartyId),
        dateText: found?.dateText || "",
        lines: (found?.lines || []).map(line => ({
            productId: line.productId,
            productName: productName(line.productId),
            quantity: text(line.quantity),
            deliveredQuantity: text(line.delivered),
            inTransitQuantity: text(line.inTransit),
            ownerName: partyName(run.ownerPartyId)
        }))
    }
}

// ===== the cost events (record#ProductionCostEvent's sources) =====
// The production run of a service line's work (OrderItemWorkEffort to an operation, or to the run), else a refusal.
function runOfWork(workEffortId, what) {
    const work = workEffortId ? one(WORK, {workEffortId}) : null
    const run =
        work?.purposeEnumId === runPurpose
            ? work
            : work?.parentWorkEffortId
              ? one(WORK, {workEffortId: work.parentWorkEffortId})
              : null
    if (!run || run.purposeEnumId !== runPurpose) denied("SOURCE_INVALID", what + " is not a production run's")
    return {run, operationWorkEffortId: work.workEffortId === run.workEffortId ? null : work.workEffortId}
}
// The accrual of an accepted service: the accepted quantity at the order line's price, outside processing into the run's
// WIP, awaiting the cost close (it reaches the GL only through post#CostClose, D12); unvalued when the line has no price.
function acceptanceEvent(serviceAcceptanceId) {
    const acceptance = one(ACCEPTANCE, {serviceAcceptanceId})
    if (!acceptance) denied("SOURCE_INVALID", "Service acceptance " + serviceAcceptanceId + " is not available")
    const item = one(ITEM, {orderId: acceptance.orderId, orderItemSeqId: acceptance.orderItemSeqId})
    const header = item ? one(HEADER, {orderId: item.orderId}) : null
    const workEffortId =
        acceptance.workEffortId ||
        rows(OIWE, {orderId: acceptance.orderId, orderItemSeqId: acceptance.orderItemSeqId})[0]?.workEffortId
    const {run, operationWorkEffortId} = runOfWork(workEffortId, "Service acceptance " + serviceAcceptanceId)
    const quantity = dec(acceptance.acceptedQuantity)
    const price = item?.unitAmount == null ? null : dec(item.unitAmount)
    return {
        run,
        costEventTypeEnumId: "PcetOutsideAccrual",
        costComponentEnumId: "PrcOutside",
        operationWorkEffortId,
        productId: item?.productId || null,
        quantity,
        quantityUomId: acceptance.quantityUomId || item?.quantityUomId || null,
        rateAmount: price,
        rateEntityName: price == null ? null : ITEM,
        rateId: null,
        amount: price == null ? null : quantity.multiply(price),
        amountUomId: header?.currencyUomId || null,
        valuationStatusEnumId: price == null ? "PcvUnvalued" : "PcvValued",
        ledgerStatusEnumId: "PclAwaitingClose",
        acctgTransId: null,
        accountingDate: null,
        assetReceiptId: acceptance.assetReceiptId || null,
        orderId: acceptance.orderId,
        orderItemSeqId: acceptance.orderItemSeqId,
        eventDate: acceptance.acceptedDate || ec.user.nowTimestamp
    }
}
// The price variance of a matched bill line of a subcontract's service: the bill's price less the order's, times the
// quantity matched, added to the run's WIP (negative when the bill is lower), awaiting the cost close. The source is the
// match line, "invoiceMatchId|invoiceMatchLineSeqId".
function billVarianceEvent(sourceId) {
    const [invoiceMatchId, invoiceMatchLineSeqId] = String(sourceId).split("|")
    const line = invoiceMatchId && invoiceMatchLineSeqId ? one(MATCH_LINE, {invoiceMatchId, invoiceMatchLineSeqId}) : null
    if (!line || !line.orderId) denied("SOURCE_INVALID", "Match line " + sourceId + " is not available")
    const item = one(ITEM, {orderId: line.orderId, orderItemSeqId: line.orderItemSeqId})
    const link = rows(OIWE, {orderId: line.orderId, orderItemSeqId: line.orderItemSeqId})[0]
    const {run, operationWorkEffortId} = runOfWork(link?.workEffortId, "Match line " + sourceId)
    const quantity = dec(line.quantity)
    const variance = dec(line.invoiceUnitAmount).subtract(dec(line.orderUnitAmount))
    return {
        run,
        costEventTypeEnumId: "PcetOutsideVariance",
        costComponentEnumId: "PrcOutside",
        operationWorkEffortId,
        productId: item?.productId || null,
        quantity,
        quantityUomId: item?.quantityUomId || null,
        rateAmount: variance,
        rateEntityName: MATCH_LINE,
        rateId: null,
        amount: quantity.multiply(variance),
        amountUomId: line.currencyUomId || null,
        valuationStatusEnumId: "PcvValued",
        ledgerStatusEnumId: "PclAwaitingClose",
        acctgTransId: null,
        accountingDate: null,
        orderId: line.orderId,
        orderItemSeqId: line.orderItemSeqId,
        invoiceId: line.invoiceId,
        invoiceItemSeqId: line.invoiceItemSeqId,
        eventDate: ec.user.nowTimestamp
    }
}
// The bill match's price variances of subcontract service lines, each written once (InvoiceMatch.js apply, in its
// transaction); the event ids.
function recordBillVariances(invoiceMatchId) {
    const ids = []
    for (const line of rows(MATCH_LINE, {invoiceMatchId})) {
        if (!line.orderId || dec(line.quantity).compare(0) <= 0) continue
        if (dec(line.invoiceUnitAmount).subtract(dec(line.orderUnitAmount)).isZero()) continue
        const link = rows(OIWE, {orderId: line.orderId, orderItemSeqId: line.orderItemSeqId})[0]
        const work = link ? one(WORK, {workEffortId: link.workEffortId}) : null
        const parent = work?.parentWorkEffortId ? one(WORK, {workEffortId: work.parentWorkEffortId}) : null
        if (work?.purposeEnumId !== runPurpose && parent?.purposeEnumId !== runPurpose) continue
        const out = call("mantle.work.ProductionServices.record#ProductionCostEvent", {
            sourceEntityName: MATCH_LINE,
            sourceId: line.invoiceMatchId + "|" + line.invoiceMatchLineSeqId
        })
        ids.push(out.productionCostEventId)
    }
    return ids
}

const operations = {request, store, materials, status, findOperations, order, shipment}
;({
    acceptanceEvent,
    billVarianceEvent,
    recordBillVariances,
    priceReaders,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown subcontract operation " + op)
        return operations[op](parameters || {})
    }
})
