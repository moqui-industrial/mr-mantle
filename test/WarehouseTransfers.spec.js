// Transfers, stock requests and the subcontract dispatch (impl-warehouse P15, design-warehouse §8 and §19 "transfer in
// transit"): a transfer is created between two facilities of one owner, picked and issued at the origin from two assets of
// different cost, shipped short of a line nobody sent, shows in transit and not on hand at the destination, and is received
// there in two parts, each piece at its issuance's cost and owner, the transfer account netting to zero; issuances and
// receipts are summed apart (F37). A stock request is approved into a requirement, allocated by transfer, and shows
// requested, approved, allocated, transferred and received. Components dispatched to a vendor-custody facility by move stay
// the organization's at their cost, and unused ones come back the same way. The users are in spec-local groups.
const T = "mantle.shipment.WarehouseTaskServices.",
    R = "mantle.request.RequestServices."
const org = "WTR_ORG",
    origin = "WTR_FROM",
    destination = "WTR_TO",
    vendor = "WTR_VENDOR",
    supplier = "WTR_SUPPLIER",
    foreign = "WTR_FOREIGN"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const n = value => (value == null ? 0 : Number(String(value)))
const sum = (list, field) => list.reduce((total, row) => total + n(row[field]), 0)
const since = "2000-01-01T00:00:00Z"
const state = {}
let keySeq = 0
const key = () => "wtr-op-" + ++keySeq

function as(username, action) {
    login(username)
    ec.artifactExecution.disableAuthz()
    try {
        return action()
    } finally {
        ec.message.clearErrors()
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}
// a call's result with its error text ("" when it succeeds), in its own transaction so a refusal rolls back only itself
function invoke(service, parameters) {
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(service).parameters(parameters).requireNewTransaction(true).call() || {}
        return Object.assign({}, out, {error: ec.message.hasError() ? ec.message.getErrorsString() : ""})
    } catch (error) {
        return {error: String(error.message || error)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}
const run = (username, service, parameters) => as(username, () => invoke(service, parameters))
function user(partyId, permissions, organizationPartyId = org) {
    call("create#moqui.security.UserGroup", {userGroupId: partyId + "_G"})
    for (const userPermissionId of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: partyId + "_G", userPermissionId, fromDate: since})
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: partyId})
    call("create#moqui.security.UserAccount", {
        userId: partyId,
        username: partyId.toLowerCase(),
        partyId,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA"
    })
    call("create#moqui.security.UserGroupMember", {userId: partyId, userGroupId: partyId + "_G", fromDate: since})
    call("create#mantle.party.PartyRelationship", {
        fromPartyId: partyId,
        toPartyId: organizationPartyId,
        relationshipTypeEnumId: "PrtAgent",
        toRoleTypeId: "OrgInternal",
        fromDate: since
    })
}
function receive(productId, quantity, acquireCost, facilityId = origin, locationSeqId = "PICK1") {
    const assetId = call("mantle.product.AssetServices.receive#Asset", {
        productId,
        quantity,
        facilityId,
        locationSeqId,
        ownerPartyId: org,
        assetTypeEnumId: "AstTpInventory",
        statusId: "AstAvailable",
        acquireCost
    }).assetId
    // receive#Asset takes the cost's currency from an order only
    call("update#mantle.product.asset.Asset", {assetId, acquireCostUomId: "USD"})
    return assetId
}
const asset = assetId => one("mantle.product.asset.Asset", {assetId})
const sourcesOf = shipmentId => rows("mantle.shipment.ShipmentItemSource", {shipmentId})
const totals = (productId, facilityId) =>
    call("mantle.product.AssetServices.get#ProductStockTotals", {productId, facilityId, ownerPartyId: org})
// the net debit of the transfer account over the transfer's issuance and receipt postings
function transferAccount(shipmentId) {
    const issuanceIds = rows("mantle.product.issuance.AssetIssuance", {shipmentId}).map(row => row.assetIssuanceId)
    const receiptIds = rows("mantle.product.receipt.AssetReceipt", {shipmentId}).map(row => row.assetReceiptId)
    const trans = [
        ...issuanceIds.flatMap(id => rows("mantle.ledger.transaction.AcctgTrans", {assetIssuanceId: id})),
        ...receiptIds.flatMap(id => rows("mantle.ledger.transaction.AcctgTrans", {assetReceiptId: id}))
    ]
    return trans
        .flatMap(row => rows("mantle.ledger.transaction.AcctgTransEntry", {acctgTransId: row.acctgTransId, glAccountId: "142000000"}))
        .reduce((total, entry) => total + (entry.debitCreditFlag === "D" ? 1 : -1) * n(entry.amount), 0)
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        for (const partyId of [org, "WTR_OTHER"]) {
            call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
            call("create#mantle.party.Organization", {partyId, organizationName: partyId})
            call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
        }
        call("create#mantle.party.Party", {partyId: supplier, partyTypeEnumId: "PtyOrganization"})
        call("create#mantle.party.Organization", {partyId: supplier, organizationName: "Coating supplier"})
        call("create#mantle.party.PartyRole", {partyId: supplier, roleTypeId: "Supplier"})
        call("mantle.ledger.LedgerServices.init#PartyAccountingConfiguration", {
            organizationPartyId: org,
            sourcePartyId: "DefaultSettings",
            baseCurrencyUomId: "USD"
        })
        call("mantle.ledger.LedgerServices.get#OrganizationFiscalTimePeriods", {
            organizationPartyId: org,
            filterDate: ec.user.nowTimestamp
        })
        // the organization's operation policy asks for the stock request check (P15 review B3); WTR_OTHER has none
        call("create#mantle.facility.WarehousePolicy", {organizationPartyId: org, policyType: "operation", facilityId: "_NA_",
            productId: "_NA_", fromDate: since, inventoryRequestCheck: "Y", changeReason: "Stock requests name a facility"})
        user("WTR_MOVER", ["STOCK_MOVE"])
        user("WTR_ISSUER", ["STOCK_ISSUE", "SHIPMENT_PICK"])
        user("WTR_RECEIVER", ["STOCK_RECEIVE", "ACCOUNTING_VIEW"])
        user("WTR_PLANNER", ["STOCK_POLICY_PLAN"])
        user("WTR_OUTSIDER", ["STOCK_MOVE", "STOCK_ISSUE", "STOCK_RECEIVE"], "WTR_OTHER")
        for (const facilityId of [origin, destination, vendor])
            call("create#mantle.facility.Facility", {facilityId, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: org})
        call("create#mantle.facility.Facility", {facilityId: foreign, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: "WTR_OTHER"})
        for (const facilityId of [origin, destination, vendor])
            for (const [locationSeqId, locationTypeEnumId] of [
                ["PICK1", "FltPick"],
                ["RECV1", "FltReceiving"]
            ])
                call("create#mantle.facility.FacilityLocation", {facilityId, locationSeqId, locationTypeEnumId})
        // the vendor-custody facility: the organization's, the supplier its custodian (F22)
        call("create#mantle.facility.FacilityParty", {facilityId: vendor, partyId: supplier, roleTypeId: "Custodian", fromDate: since})
        for (const productId of ["WTR_A", "WTR_B", "WTR_COMP"])
            call("create#mantle.product.Product", {
                productId,
                productName: productId,
                productTypeEnumId: "PtAsset",
                assetTypeEnumId: "AstTpInventory",
                amountUomId: "OTH_ea",
                ownerPartyId: org
            })
        call("create#mantle.product.Product", {productId: "WTR_COATING", productName: "Coating", productTypeEnumId: "PtService"})
        state.cheap = receive("WTR_A", 10, 2)
        state.dear = receive("WTR_A", 10, 4)
        state.other = receive("WTR_B", 5, 1)
        state.component = receive("WTR_COMP", 8, 3)
        // a production run with an operation, and the service purchase order item linked to the operation
        call("create#mantle.work.effort.WorkEffort", {workEffortId: "WTR_RUN", workEffortTypeEnumId: "WetTask",
            purposeEnumId: "WepProductionRun", workEffortName: "Coated parts", ownerPartyId: org})
        call("create#mantle.work.effort.WorkEffort", {workEffortId: "WTR_OP", workEffortTypeEnumId: "WetTask",
            parentWorkEffortId: "WTR_RUN", workEffortName: "Coating"})
        call("create#mantle.order.OrderHeader", {orderId: "WTR_PO", statusId: "OrderApproved", currencyUomId: "USD"})
        call("create#mantle.order.OrderPart", {orderId: "WTR_PO", orderPartSeqId: "01", vendorPartyId: supplier,
            customerPartyId: org, statusId: "OrderApproved"})
        call("create#mantle.order.OrderItem", {orderId: "WTR_PO", orderItemSeqId: "01", orderPartSeqId: "01",
            productId: "WTR_COATING", quantity: 8, unitAmount: 1.5, itemTypeEnumId: "ItemProduct"})
        call("create#mantle.order.OrderItemWorkEffort", {orderId: "WTR_PO", orderItemSeqId: "01", workEffortId: "WTR_OP"})
        // a goods item on the same order linked to the operation: not a service
        call("create#mantle.order.OrderItem", {orderId: "WTR_PO", orderItemSeqId: "02", orderPartSeqId: "01",
            productId: "WTR_COMP", quantity: 1, unitAmount: 1, itemTypeEnumId: "ItemProduct"})
        call("create#mantle.order.OrderItemWorkEffort", {orderId: "WTR_PO", orderItemSeqId: "02", workEffortId: "WTR_OP"})
        ec.artifactExecution.enableAuthz()
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.message.clearErrors()
        login("john.doe")
        ec.artifactExecution.enableAuthz()
    }
})

feature("a transfer goes between two facilities of one owner; the same facility, two owners and an outsider are refused", {
    when() {
        const lines = [{productId: "WTR_A", quantity: 6}, {productId: "WTR_B", quantity: 2}]
        const same = run("wtr_mover", T + "create#Transfer", {operationKey: key(), originFacilityId: origin,
            destinationFacilityId: origin, lines})
        const owners = run("wtr_mover", T + "create#Transfer", {operationKey: key(), originFacilityId: origin,
            destinationFacilityId: foreign, lines})
        const outsider = run("wtr_outsider", T + "create#Transfer", {operationKey: key(), originFacilityId: origin,
            destinationFacilityId: destination, lines})
        const issuer = run("wtr_issuer", T + "create#Transfer", {operationKey: key(), originFacilityId: origin,
            destinationFacilityId: destination, lines})
        const operationKey = key()
        const created = run("wtr_mover", T + "create#Transfer", {operationKey, originFacilityId: origin,
            destinationFacilityId: destination, lines, reference: "Restock east"})
        const retry = run("wtr_mover", T + "create#Transfer", {operationKey, originFacilityId: origin,
            destinationFacilityId: destination, lines, reference: "Restock east"})
        state.transfer = created.result?.shipmentId
        state.lineA = created.result?.lines?.[0]?.shipmentItemSourceId
        state.lineB = created.result?.lines?.[1]?.shipmentItemSourceId
        const notShipped = run("wtr_receiver", T + "receive#TransferStock", {operationKey: key(), shipmentId: state.transfer,
            productId: "WTR_A", quantityAccepted: 1})
        return {same, owners, outsider, issuer, created, retry, notShipped, shipment: one("mantle.shipment.Shipment",
            {shipmentId: state.transfer}), segment: rows("mantle.shipment.ShipmentRouteSegment", {shipmentId: state.transfer})[0]}
    },
    then({same, owners, outsider, issuer, created, retry, notShipped, shipment, segment}) {
        same.error.includes("SAME_FACILITY")
        owners.error.includes("RECORD_UNAVAILABLE") || owners.error.includes("OWNER_MISMATCH")
        outsider.error.includes("RECORD_UNAVAILABLE")
        issuer.error.includes("PERMISSION_DENIED")
        created.error === ""
        created.result.resultCode === "CREATED"
        created.result.lines.length === 2
        retry.result.alreadyApplied === true && retry.result.shipmentId === state.transfer
        shipment.shipmentTypeEnumId === "ShpTpTransfer"
        shipment.fromPartyId === org && shipment.toPartyId === org
        segment.originFacilityId === origin && segment.destinationFacilityId === destination
        notShipped.error.includes("TRANSFER_NOT_SHIPPED")
    }
})

feature("the origin picks and issues from two assets of different cost, and ships short of the line nobody sent", {
    when() {
        // P11's pick entry point takes a transfer line's scanned stock (a transfer has no reservation)
        const picked = run("wtr_issuer", T + "pick#ShipmentStock", {operationKey: key(), shipmentId: state.transfer,
            shipmentItemSourceId: state.lineA, assetId: state.cheap, quantity: 3})
        // no asset named: the stock the line's pick took
        const fromPick = run("wtr_issuer", T + "issue#TransferStock", {operationKey: key(), shipmentId: state.transfer,
            shipmentItemSourceId: state.lineA, quantity: 3})
        const tooMuch = run("wtr_issuer", T + "issue#TransferStock", {operationKey: key(), shipmentId: state.transfer,
            shipmentItemSourceId: state.lineA, assetId: state.dear, quantity: 4})
        const wrongProduct = run("wtr_issuer", T + "issue#TransferStock", {operationKey: key(), shipmentId: state.transfer,
            shipmentItemSourceId: state.lineA, assetId: state.other, quantity: 1})
        const second = run("wtr_issuer", T + "issue#TransferStock", {operationKey: key(), shipmentId: state.transfer,
            shipmentItemSourceId: state.lineA, assetId: state.dear, quantity: 3})
        const outstanding = run("wtr_issuer", T + "ship#Transfer", {operationKey: key(), shipmentId: state.transfer})
        const shipped = run("wtr_issuer", T + "ship#Transfer", {operationKey: key(), shipmentId: state.transfer, shipShort: true})
        const late = run("wtr_issuer", T + "issue#TransferStock", {operationKey: key(), shipmentId: state.transfer,
            shipmentItemSourceId: state.lineA, assetId: state.dear, quantity: 1})
        return {picked, fromPick, tooMuch, wrongProduct, second, outstanding, shipped, late,
            shipment: one("mantle.shipment.Shipment", {shipmentId: state.transfer}),
            lineB: one("mantle.shipment.ShipmentItemSource", {shipmentItemSourceId: state.lineB}),
            cheap: asset(state.cheap), dear: asset(state.dear)}
    },
    then({picked, fromPick, tooMuch, wrongProduct, second, outstanding, shipped, late, shipment, lineB, cheap, dear}) {
        picked.error === "" && picked.result.resultCode === "PICKED"
        fromPick.error === "" && fromPick.result.assetId === state.cheap
        tooMuch.error.includes("QUANTITY_EXCEEDS_REMAINING")
        wrongProduct.error.includes("PRODUCT_MISMATCH")
        second.error === "" && second.result.remainingQuantity === "0"
        outstanding.error.includes("OUTSTANDING")
        shipped.error === "" && shipped.result.shortLines.length === 1
        late.error.includes("TRANSFER_SHIPPED")
        shipment.statusId === "ShipShipped"
        lineB.statusId === "SisCancelled"
        n(cheap.quantityOnHandTotal) === 7 && n(dear.quantityOnHandTotal) === 7
    }
})

feature("in transit: the destination shows the transfer in transit, nothing on hand, the transfer account holds its value", {
    when() {
        return {at: totals("WTR_A", destination), account: transferAccount(state.transfer)}
    },
    then({at, account}) {
        n(at.transitQuantity) === 6
        n(at.quantityOnHandTotal) === 0
        account === 18
    }
})

feature("the destination receives in two parts, each piece at its issuance's cost and owner; nothing more than in transit", {
    when() {
        const operationKey = key()
        const outsider = run("wtr_outsider", T + "receive#TransferStock", {operationKey: key(), shipmentId: state.transfer,
            productId: "WTR_A", quantityAccepted: 1})
        const first = run("wtr_receiver", T + "receive#TransferStock", {operationKey, shipmentId: state.transfer,
            productId: "WTR_A", quantityAccepted: 4, locationSeqId: "PICK1"})
        const retry = run("wtr_receiver", T + "receive#TransferStock", {operationKey, shipmentId: state.transfer,
            productId: "WTR_A", quantityAccepted: 4, locationSeqId: "PICK1"})
        const between = totals("WTR_A", destination)
        const over = run("wtr_receiver", T + "receive#TransferStock", {operationKey: key(), shipmentId: state.transfer,
            productId: "WTR_A", quantityAccepted: 3, locationSeqId: "PICK1"})
        const last = run("wtr_receiver", T + "receive#TransferStock", {operationKey: key(), shipmentId: state.transfer,
            productId: "WTR_A", quantityAccepted: 2, locationSeqId: "PICK1"})
        const received = rows("mantle.product.asset.Asset", {productId: "WTR_A", facilityId: destination})
        return {outsider, first, retry, between, over, last, received, after: totals("WTR_A", destination),
            account: transferAccount(state.transfer), shipment: one("mantle.shipment.Shipment", {shipmentId: state.transfer}),
            issued: sum(rows("mantle.product.issuance.AssetIssuance", {shipmentId: state.transfer}), "quantity"),
            accepted: sum(rows("mantle.product.receipt.AssetReceipt", {shipmentId: state.transfer}), "quantityAccepted"),
            linked: rows("mantle.product.receipt.AssetReceipt", {shipmentId: state.transfer}).every(row => row.sourceAssetIssuanceId)}
    },
    then({outsider, first, retry, between, over, last, received, after, account, shipment, issued, accepted, linked}) {
        outsider.error.includes("RECORD_UNAVAILABLE")
        first.error === "" && first.result.resultCode === "RECEIVED"
        first.result.costCarried === true && first.result.ownerPartyIds.length === 1 && first.result.ownerPartyIds[0] === org
        first.result.inTransitQuantity === "2"
        first.result.delivered === false
        retry.result.alreadyApplied === true
        n(between.transitQuantity) === 2 && n(between.quantityOnHandTotal) === 4
        over.error.includes("OVER_RECEIPT")
        last.error === "" && last.result.delivered === true
        // 3 at the cheap issuance's cost, 3 at the dear one's, all the organization's
        sum(received.filter(row => n(row.acquireCost) === 2), "quantityOnHandTotal") === 3
        sum(received.filter(row => n(row.acquireCost) === 4), "quantityOnHandTotal") === 3
        received.every(row => row.ownerPartyId === org && row.acquireCostUomId === "USD")
        n(after.transitQuantity) === 0 && n(after.quantityOnHandTotal) === 6
        account === 0
        shipment.statusId === "ShipDelivered"
        // issuances and receipts summed apart (F37): 6 sent, 6 received
        issued === 6 && accepted === 6 && linked
    }
})

feature("a stock request is approved into a requirement, allocated by transfer and shows its progress", {
    when() {
        const noFacility = as("wtr_mover", () => invoke(R + "create#Request", {requestTypeEnumId: "RqtInventory",
            requestName: "No facility"}))
        // the check is the organization's policy: without it Mantle's default stands, on create and on update
        const unchecked = as("wtr_outsider", () => invoke(R + "create#Request", {requestTypeEnumId: "RqtInventory",
            requestName: "No facility, no check"}))
        const plain = as("wtr_mover", () => invoke(R + "create#Request", {requestTypeEnumId: "RqtSupport", requestName: "Plain"}))
        const switched = as("wtr_mover", () => invoke(R + "update#Request", {requestId: plain.requestId,
            requestTypeEnumId: "RqtInventory", facilityId: foreign}))
        const created = as("wtr_mover", () => invoke(R + "create#Request", {requestTypeEnumId: "RqtInventory",
            requestName: "Bins for the east line", facilityId: destination}))
        state.request = created.requestId
        const item = run("wtr_mover", R + "add#InventoryRequestItem", {requestId: state.request, productId: "WTR_A", quantity: 2})
        const service = run("wtr_mover", R + "add#InventoryRequestItem", {requestId: state.request, productId: "WTR_COATING",
            quantity: 1})
        const draftAllocate = run("wtr_mover", T + "allocate#InventoryRequest", {operationKey: key(), requestId: state.request,
            fromFacilityId: origin, allocationRows: [{requestItemSeqId: item.requestItemSeqId, quantity: 2}]})
        call("mantle.request.RequestServices.update#Request", {requestId: state.request, statusId: "ReqSubmitted"})
        const moverApprove = run("wtr_mover", R + "approve#InventoryRequest", {operationKey: key(), requestId: state.request})
        const approved = run("wtr_planner", R + "approve#InventoryRequest", {operationKey: key(), requestId: state.request})
        const over = run("wtr_mover", T + "allocate#InventoryRequest", {operationKey: key(), requestId: state.request,
            fromFacilityId: origin, allocationRows: [{requestItemSeqId: item.requestItemSeqId, quantity: 3}]})
        const allocated = run("wtr_mover", T + "allocate#InventoryRequest", {operationKey: key(), requestId: state.request,
            fromFacilityId: origin, allocationRows: [{requestItemSeqId: item.requestItemSeqId, quantity: 2}]})
        const before = run("wtr_mover", R + "get#InventoryRequestProgress", {requestId: state.request})
        const shipmentId = allocated.result?.shipmentId
        const lineId = allocated.result?.allocations?.[0]?.shipmentItemSourceId
        run("wtr_issuer", T + "issue#TransferStock", {operationKey: key(), shipmentId, shipmentItemSourceId: lineId,
            assetId: state.cheap, quantity: 2})
        run("wtr_issuer", T + "ship#Transfer", {operationKey: key(), shipmentId})
        const inTransit = run("wtr_mover", R + "get#InventoryRequestProgress", {requestId: state.request})
        run("wtr_receiver", T + "receive#TransferStock", {operationKey: key(), shipmentId, productId: "WTR_A",
            quantityAccepted: 2, locationSeqId: "PICK1"})
        const after = run("wtr_mover", R + "get#InventoryRequestProgress", {requestId: state.request})
        const outsider = run("wtr_outsider", R + "get#InventoryRequestProgress", {requestId: state.request})
        const links = rows("mantle.request.requirement.RequirementRequestItem", {requestId: state.request})
        return {noFacility, unchecked, switched, created, item, service, draftAllocate, moverApprove, approved, over, allocated,
            outsider, links,
            before: (before.itemRows || [])[0] || {}, inTransit: (inTransit.itemRows || [])[0] || {},
            after: (after.itemRows || [])[0] || {},
            parties: rows("mantle.request.RequestParty", {requestId: state.request, roleTypeId: "OrgInternal"})}
    },
    then({noFacility, unchecked, switched, created, item, service, draftAllocate, moverApprove, approved, over, allocated,
        before, inTransit, after, outsider, links, parties}) {
        noFacility.error.includes("FACILITY_REQUIRED")
        unchecked.error === "" && !!unchecked.requestId
        switched.error.includes("RECORD_UNAVAILABLE")
        created.error === "" && parties.length === 1 && parties[0].partyId === org
        item.error === ""
        service.error.includes("NOT_STOCK")
        draftAllocate.error.includes("NOT_APPROVED")
        moverApprove.error.includes("PERMISSION_DENIED")
        approved.error === "" && approved.result.requirementIds.length === 1
        links.length === 1
        over.error.includes("QUANTITY_EXCEEDS_APPROVED")
        allocated.error === "" && allocated.result.kind === "transfer"
        before.requested === "2" && before.approved === "2" && before.allocated === "2"
        before.transferred === "0" && before.received === "0"
        inTransit.transferred === "2" && inTransit.inTransit === "2" && inTransit.received === "0"
        after.received === "2" && after.remaining === "0" && after.links.length === 1
        outsider.error.includes("RECORD_UNAVAILABLE")
    }
})

feature("within the request's facility the allocation is a guarded move; another request type needs no facility", {
    when() {
        const support = as("wtr_mover", () => invoke(R + "create#Request", {requestTypeEnumId: "RqtSupport",
            requestName: "Unchanged default"}))
        const created = as("wtr_mover", () => invoke(R + "create#Request", {requestTypeEnumId: "RqtInventory",
            requestName: "Bins for the pick face", facilityId: origin, statusId: "ReqSubmitted"}))
        const item = run("wtr_mover", R + "add#InventoryRequestItem", {requestId: created.requestId, productId: "WTR_B", quantity: 2})
        const itemA = run("wtr_mover", R + "add#InventoryRequestItem", {requestId: created.requestId, productId: "WTR_A",
            quantity: 1})
        run("wtr_planner", R + "approve#InventoryRequest", {operationKey: key(), requestId: created.requestId})
        // stock of another facility is not moved inside it as this request's (P15 review A1), nor an item given twice (B2)
        const elsewhere = rows("mantle.product.asset.Asset", {productId: "WTR_A", facilityId: destination})
            .find(row => n(row.quantityOnHandTotal) > 0)
        const otherFacility = run("wtr_mover", T + "allocate#InventoryRequest", {operationKey: key(),
            requestId: created.requestId, fromFacilityId: origin,
            allocationRows: [{requestItemSeqId: itemA.requestItemSeqId, quantity: 1, assetId: elsewhere.assetId,
                toLocationSeqId: "RECV1"}]})
        const twice = run("wtr_mover", T + "allocate#InventoryRequest", {operationKey: key(), requestId: created.requestId,
            fromFacilityId: origin, allocationRows: [{requestItemSeqId: item.requestItemSeqId, quantity: 1},
                {requestItemSeqId: item.requestItemSeqId, quantity: 1}]})
        const noAsset = run("wtr_mover", T + "allocate#InventoryRequest", {operationKey: key(), requestId: created.requestId,
            fromFacilityId: origin, allocationRows: [{requestItemSeqId: item.requestItemSeqId, quantity: 2}]})
        const moved = run("wtr_mover", T + "allocate#InventoryRequest", {operationKey: key(), requestId: created.requestId,
            fromFacilityId: origin, allocationRows: [{requestItemSeqId: item.requestItemSeqId, quantity: 2, assetId: state.other,
                toLocationSeqId: "RECV1"}]})
        const progress = run("wtr_mover", R + "get#InventoryRequestProgress", {requestId: created.requestId})
        return {support, noAsset, otherFacility, twice, moved, row: (progress.itemRows || [])[0] || {},
            at: asset(moved.result?.allocations?.[0]?.assetId || "-")}
    },
    then({support, noAsset, otherFacility, twice, moved, row, at}) {
        support.error === "" && !!support.requestId
        noAsset.error.includes("ASSET_REQUIRED")
        otherFacility.error.includes("OTHER_FACILITY")
        twice.error.includes("DUPLICATE_ITEM")
        moved.error === "" && moved.result.kind === "move"
        at.locationSeqId === "RECV1" && n(at.quantityOnHandTotal) === 2
        row.allocated === "2" && row.transferred === "2" && row.received === "2" && row.links[0].kind === "move"
    }
})

feature("components dispatched to a vendor-custody facility by move stay the organization's; unused ones come back", {
    when() {
        const keys = {subcontractWorkEffortId: "WTR_OP", subcontractOrderId: "WTR_PO", subcontractOrderItemSeqId: "01"}
        const lines = [{productId: "WTR_COMP", quantity: 5}]
        const notCustody = run("wtr_mover", T + "create#Transfer", Object.assign({operationKey: key(), originFacilityId: origin,
            destinationFacilityId: destination, lines}, keys))
        const notService = run("wtr_mover", T + "create#Transfer", Object.assign({operationKey: key(), originFacilityId: origin,
            destinationFacilityId: vendor, lines}, keys, {subcontractOrderItemSeqId: "02"}))
        // a dispatch sent partly by move and shipped short has nothing in transit: it is delivered at once (B6)
        const short = run("wtr_mover", T + "create#Transfer", Object.assign({operationKey: key(), originFacilityId: origin,
            destinationFacilityId: vendor, lines: [{productId: "WTR_COMP", quantity: 2}]}, keys))
        const shortMove = run("wtr_mover", T + "dispatch#SubcontractStock", {operationKey: key(),
            shipmentId: short.result?.shipmentId, shipmentItemSourceId: short.result?.lines?.[0]?.shipmentItemSourceId,
            assetId: state.component, quantity: 1, toLocationSeqId: "PICK1"})
        const shortShip = run("wtr_issuer", T + "ship#Transfer", {operationKey: key(), shipmentId: short.result?.shipmentId,
            shipShort: true})
        const created = run("wtr_mover", T + "create#Transfer", Object.assign({operationKey: key(), originFacilityId: origin,
            destinationFacilityId: vendor, lines}, keys))
        const shipmentId = created.result?.shipmentId
        const lineId = created.result?.lines?.[0]?.shipmentItemSourceId
        const plainTransfer = run("wtr_mover", T + "dispatch#SubcontractStock", {operationKey: key(), shipmentId: state.transfer,
            shipmentItemSourceId: state.lineA, assetId: state.dear, toLocationSeqId: "PICK1"})
        const firstMove = run("wtr_mover", T + "dispatch#SubcontractStock", {operationKey: key(), shipmentId,
            shipmentItemSourceId: lineId, assetId: state.component, quantity: 3, toLocationSeqId: "PICK1"})
        const secondMove = run("wtr_mover", T + "dispatch#SubcontractStock", {operationKey: key(), shipmentId,
            shipmentItemSourceId: lineId, assetId: state.component, quantity: 2, toLocationSeqId: "PICK1"})
        const atVendor = rows("mantle.product.asset.Asset", {productId: "WTR_COMP", facilityId: vendor})
        // the return of unused components, the same way back
        const back = run("wtr_mover", T + "create#Transfer", Object.assign({operationKey: key(), originFacilityId: vendor,
            destinationFacilityId: origin, lines: [{productId: "WTR_COMP", quantity: 1}]}, keys))
        const returned = run("wtr_mover", T + "dispatch#SubcontractStock", {operationKey: key(), shipmentId: back.result?.shipmentId,
            shipmentItemSourceId: back.result?.lines?.[0]?.shipmentItemSourceId, assetId: atVendor[0]?.assetId,
            toLocationSeqId: "PICK1"})
        return {notCustody, notService, shortMove, shortShip, created, plainTransfer, firstMove, secondMove, atVendor, back,
            returned, shortShipment: one("mantle.shipment.Shipment", {shipmentId: short.result?.shipmentId || "-"}),
            shipment: one("mantle.shipment.Shipment", {shipmentId}),
            vendorAfter: rows("mantle.product.asset.Asset", {productId: "WTR_COMP", facilityId: vendor}),
            postings: rows("mantle.product.issuance.AssetIssuance", {shipmentId}).length}
    },
    then({notCustody, notService, shortMove, shortShip, shortShipment, created, plainTransfer, firstMove, secondMove, atVendor,
        back, returned, shipment, vendorAfter, postings}) {
        notCustody.error.includes("NOT_CUSTODY")
        notService.error.includes("NOT_SERVICE")
        shortMove.error === "" && shortShip.error === "" && shortShip.result.delivered === true
        shortShipment.statusId === "ShipDelivered"
        created.error === "" && created.result.subcontract === true && created.result.custodianPartyId === supplier
        shipment.subcontractWorkEffortId === "WTR_OP" && shipment.subcontractOrderId === "WTR_PO"
        plainTransfer.error.includes("NOT_SUBCONTRACT")
        firstMove.error === "" && firstMove.result.delivered === false && firstMove.result.ownerPartyId === org
        secondMove.error === "" && secondMove.result.delivered === true
        shipment.statusId === "ShipDelivered"
        postings === 0
        sum(atVendor, "quantityOnHandTotal") === 6
        atVendor.every(row => row.ownerPartyId === org && n(row.acquireCost) === 3)
        back.error === "" && returned.error === "" && returned.result.delivered === true
        sum(vendorAfter, "quantityOnHandTotal") === 5
    }
})

feature("picked stock of two assets is sent without naming them; a rejected piece keeps its value at the transfer account", {
    when() {
        const created = run("wtr_mover", T + "create#Transfer", {operationKey: key(), originFacilityId: origin,
            destinationFacilityId: destination, lines: [{productId: "WTR_A", quantity: 4}]})
        const shipmentId = created.result?.shipmentId,
            lineId = created.result?.lines?.[0]?.shipmentItemSourceId
        for (const assetId of [state.cheap, state.dear])
            run("wtr_issuer", T + "pick#ShipmentStock", {operationKey: key(), shipmentId, shipmentItemSourceId: lineId,
                assetId, quantity: 2})
        const issued = run("wtr_issuer", T + "issue#TransferStock", {operationKey: key(), shipmentId,
            shipmentItemSourceId: lineId})
        run("wtr_issuer", T + "ship#Transfer", {operationKey: key(), shipmentId})
        const received = run("wtr_receiver", T + "receive#TransferStock", {operationKey: key(), shipmentId, productId: "WTR_A",
            quantityAccepted: 3, quantityRejected: 1, rejectionReasonEnumId: "ArjDamaged", locationSeqId: "PICK1"})
        return {issued, received, account: transferAccount(shipmentId)}
    },
    then({issued, received, account}) {
        issued.error === "" && issued.result.assetIds.length === 2
        received.error === "" && received.result.delivered === true
        // 2 at 2 and 2 at 4 sent (12); 2 at 2 and 1 at 4 received (8): the rejected unit's 4 stays until a write-off (§5)
        account === 4
    }
})
