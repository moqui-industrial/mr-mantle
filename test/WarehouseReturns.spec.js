// Returns in the warehouse (impl-warehouse P14; design §19 the return in two boxes, crosscut §6 customer and supplier
// returns): part of an RMA is received in one box with a unit rejected at the dock and the rest in a second box, into
// quarantine with an inspection of each box, settling nothing; the inspections restock one unit and scrap another; a
// Warehouse receiver cannot settle; a supplier return of a rejected, expired lot takes it from find#ReturnableReceipts,
// issues the quarantined asset under its Return to supplier disposition and ships, setting ReturnShipped; the return label
// request prepares the package and buys nothing twice; a return's files are record files. The organization, parties, products
// and users are spec-local (prefix WRT).
const T = "mantle.shipment.WarehouseTaskServices."
const R = "mantle.order.ReturnServices."
const Q = "mantle.product.QualityServices."
const org = "WRT_ORG",
    customer = "WRT_CUSTOMER",
    supplier = "WRT_SUPPLIER",
    facility = "WRT_FAC"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const n = value => (value == null ? 0 : Number(String(value)))
const since = "2000-01-01T00:00:00Z"
const ids = {}
let keySeq = 0
const key = () => "wrt-op-" + ++keySeq

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
function organization(partyId, roleTypeId) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
    call("create#mantle.party.Organization", {partyId, organizationName: partyId})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId})
}
function user(partyId, permissions) {
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
        toPartyId: org,
        relationshipTypeEnumId: "PrtAgent",
        toRoleTypeId: "OrgInternal",
        fromDate: since
    })
}
const asset = assetId => one("mantle.product.asset.Asset", {assetId})
const inspection = qualityInspectionId => one("mantle.product.quality.QualityInspection", {qualityInspectionId})
const returnItem = returnId => rows("mantle.order.return.ReturnItem", {returnId}).filter(row => !row.parentItemSeqId)[0]
const shipmentOf = returnId => rows("mantle.shipment.ShipmentItemSource", {returnId})[0].shipmentId
// an inspection submitted with its result by the inspector, verified by the manager (never the submitter)
function inspect(qualityInspectionId, accepted, rejected) {
    const submitted = run("wrt_inspector", Q + "submit#Inspection", {
        qualityInspectionId,
        quantityAccepted: accepted,
        quantityRejected: rejected,
        resultReason: rejected ? "Damaged in transit" : null
    })
    const verified = run("wrt_manager", Q + "verify#Inspection", {qualityInspectionId})
    return {submitted, verified}
}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(org, "OrgInternal")
        organization(customer, "Customer")
        organization(supplier, "Supplier")
        call("mantle.ledger.LedgerServices.init#PartyAccountingConfiguration", {
            organizationPartyId: org,
            sourcePartyId: "DefaultSettings",
            baseCurrencyUomId: "USD"
        })
        call("mantle.ledger.LedgerServices.get#OrganizationFiscalTimePeriods", {
            organizationPartyId: org,
            filterDate: ec.user.nowTimestamp
        })
        // returns are settled by finance (D11), and a scrap posts to its own account
        call("update#mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: org, returnSettlementRequired: "Y"})
        const mapping = rows("mantle.ledger.config.AssetTypeGlAccount", {
            organizationPartyId: org,
            assetTypeEnumId: "AstTpInventory",
            classEnumId: null,
            assetId: null
        })[0]
        call("update#mantle.ledger.config.AssetTypeGlAccount", {
            assetTypeGlAccountId: mapping.assetTypeGlAccountId,
            scrapGlAccountId: "519200000"
        })
        user("WRT_RECEIVER", ["STOCK_RECEIVE"])
        user("WRT_INSPECTOR", ["QUALITY_INSPECT"])
        user("WRT_MANAGER", ["QUALITY_VERIFY", "QUALITY_DISPOSE"])
        user("WRT_ISSUER", ["STOCK_ISSUE"])
        user("WRT_SHIPPER", ["SHIPMENT_SHIP"])
        user("WRT_READER", [])
        call("create#mantle.facility.Facility", {facilityId: facility, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: org})
        for (const [locationSeqId, locationTypeEnumId, sequenceNum] of [
            ["PICK1", "FltPick", 1],
            ["QUAR1", "FltQuarantine", 2],
            ["MORG1", "FltMorgue", 3]
        ])
            call("create#mantle.facility.FacilityLocation", {
                facilityId: facility,
                locationSeqId,
                locationTypeEnumId,
                sequenceNum
            })
        for (const [locationTypeEnumId, autoStatusId] of [
            ["FltQuarantine", "AstQuarantine"],
            ["FltMorgue", "AstMorgue"]
        ])
            call("create#mantle.facility.FacilityLocationType", {facilityId: facility, locationTypeEnumId, autoStatusId})
        for (const productId of ["WRT_KETTLE", "WRT_LOTTED"])
            call("create#mantle.product.Product", {
                productId,
                productName: productId,
                productTypeEnumId: "PtAsset",
                assetTypeEnumId: "AstTpInventory",
                amountUomId: "OTH_ea",
                ownerPartyId: org
            })
        // the lot-tracked product is inspected on receipt, and expired stock is blocked from sale (the expiry gate)
        call("create#mantle.facility.WarehousePolicy", {
            organizationPartyId: org,
            policyType: "tracking",
            facilityId: "_NA_",
            productId: "WRT_LOTTED",
            fromDate: since,
            lotRequired: "Y",
            inspectionRequired: "Y",
            expiryBlock: "Y"
        })
        // three kettles sold, shipped and invoiced
        call("mantle.product.AssetServices.receive#Asset", {
            productId: "WRT_KETTLE",
            facilityId: facility,
            locationSeqId: "PICK1",
            ownerPartyId: org,
            quantity: 10,
            acquireCost: 8
        })
        const order = call("mantle.order.OrderServices.create#Order", {
            vendorPartyId: org,
            customerPartyId: customer,
            currencyUomId: "USD",
            facilityId: facility
        })
        call("mantle.order.OrderServices.add#OrderProductQuantity", {
            orderId: order.orderId,
            orderPartSeqId: order.orderPartSeqId,
            productId: "WRT_KETTLE",
            quantity: 3,
            unitAmount: 20
        })
        call("mantle.order.OrderServices.place#Order", {orderId: order.orderId})
        call("mantle.order.OrderServices.approve#Order", {orderId: order.orderId})
        call("mantle.shipment.ShipmentServices.ship#OrderPart", {orderId: order.orderId, orderPartSeqId: "01"})
        ids.saleId = order.orderId
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

feature("an approved RMA's label request prepares its package once, and the return's files are record files", {
    when() {
        const returnId = call(R + "create#ReturnFromOrder", {orderId: ids.saleId, orderPartSeqId: "01"}).returnId
        const orderItemSeqId = rows("mantle.order.OrderItem", {orderId: ids.saleId}).find(
            row => row.productId === "WRT_KETTLE"
        ).orderItemSeqId
        call(R + "add#OrderItemToReturn", {
            returnId,
            orderId: ids.saleId,
            orderItemSeqId,
            returnQuantity: 3,
            returnReasonEnumId: "RrsnDefective",
            returnResponseEnumId: "RrspCredit"
        })
        const early = run("wrt_shipper", T + "request#ReturnLabel", {operationKey: key(), returnId})
        call(R + "approve#Return", {returnId})
        ids.returnId = returnId
        ids.returnShipmentId = shipmentOf(returnId)
        const labelKey = key()
        const denied = run("wrt_reader", T + "request#ReturnLabel", {operationKey: key(), returnId})
        const label = run("wrt_shipper", T + "request#ReturnLabel", {operationKey: labelKey, returnId})
        const retry = run("wrt_shipper", T + "request#ReturnLabel", {operationKey: labelKey, returnId})
        const packages = rows("mantle.shipment.ShipmentPackageRouteSeg", {shipmentId: ids.returnShipmentId})
        const file = call(R + "create#ReturnContent", {returnId, contentTypeEnumId: "RtcntPhoto", description: "Dented lid"})
        const info = call("mantle.party.CommunicationServices.get#RecordLinkInfo", {
            recordEntityName: "mantle.order.return.ReturnHeader",
            recordId: returnId,
            checkRecord: false
        })
        return {early, denied, label, retry, packages, file, info}
    },
    then({early, denied, label, retry, packages, file, info}) {
        early.error.includes("RETURN_NOT_APPROVED")
        denied.error.includes("PERMISSION_DENIED")
        label.error == ""
        label.result.resultCode == "LABEL_NOT_CONFIGURED"
        label.result.shipmentId == ids.returnShipmentId
        retry.result.alreadyApplied == true
        packages.length == 1
        !!file.returnContentId
        info.contentEntity.entityName == "mantle.order.return.ReturnContent"
    }
})

feature("the RMA in two boxes: a dock rejection and quarantine with an inspection per box, settling nothing", {
    when() {
        const seq = returnItem(ids.returnId).returnItemSeqId
        const line = (accepted, rejected, extra = {}) =>
            Object.assign(
                {returnId: ids.returnId, returnItemSeqId: seq, quantityAccepted: accepted, quantityRejected: rejected},
                extra
            )
        const denied = run("wrt_reader", T + "receive#ReturnItems", {
            operationKey: key(),
            shipmentId: ids.returnShipmentId,
            itemList: [line(1, 0)]
        })
        const noReason = run("wrt_receiver", T + "receive#ReturnItems", {
            operationKey: key(),
            shipmentId: ids.returnShipmentId,
            itemList: [line(1, 1)]
        })
        const notQuarantine = run("wrt_receiver", T + "receive#ReturnItems", {
            operationKey: key(),
            shipmentId: ids.returnShipmentId,
            locationSeqId: "PICK1",
            itemList: [line(1, 0)]
        })
        const boxKey = key()
        const box1 = run("wrt_receiver", T + "receive#ReturnItems", {
            operationKey: boxKey,
            shipmentId: ids.returnShipmentId,
            itemList: [line(1, 1, {rejectionReasonEnumId: "ArjDamaged", lotNumber: "WRT-RMA-LOT"})]
        })
        const retry = run("wrt_receiver", T + "receive#ReturnItems", {
            operationKey: boxKey,
            shipmentId: ids.returnShipmentId,
            itemList: [line(1, 1, {rejectionReasonEnumId: "ArjDamaged", lotNumber: "WRT-RMA-LOT"})]
        })
        const afterBox1 = {
            item: returnItem(ids.returnId),
            header: one("mantle.order.return.ReturnHeader", {returnId: ids.returnId})
        }
        const over = run("wrt_receiver", T + "receive#ReturnItems", {
            operationKey: key(),
            shipmentId: ids.returnShipmentId,
            itemList: [line(2, 0)]
        })
        const box2 = run("wrt_receiver", T + "receive#ReturnItems", {
            operationKey: key(),
            shipmentId: ids.returnShipmentId,
            itemList: [line(1, 0, {lotNumber: "WRT-RMA-LOT"})]
        })
        const receipts = rows("mantle.product.receipt.AssetReceipt", {returnId: ids.returnId})
        const billings = rows("mantle.order.return.ReturnItemBilling", {returnId: ids.returnId})
        const settle = run("wrt_receiver", R + "preview#ReturnSettlement", {returnId: ids.returnId})
        ids.inspections = [box1.result?.qualityInspectionIds?.[0], box2.result?.qualityInspectionIds?.[0]]
        return {denied, noReason, notQuarantine, box1, retry, afterBox1, over, box2, receipts, billings, settle}
    },
    then({denied, noReason, notQuarantine, box1, retry, afterBox1, over, box2, receipts, billings, settle}) {
        denied.error.includes("PERMISSION_DENIED")
        noReason.error.includes("REASON_REQUIRED")
        notQuarantine.error.includes("LOCATION_NOT_QUARANTINE")
        box1.error == ""
        box1.result.locationSeqId == "QUAR1"
        box1.result.statusId == "AstQuarantine"
        box1.result.qualityInspectionIds.length == 1
        retry.result.alreadyApplied == true
        n(afterBox1.item.receivedQuantity) == 2
        afterBox1.item.statusId == "ReturnApproved"
        afterBox1.header.statusId == "ReturnApproved"
        over.error.includes("RECEIPT_EXCEEDS_RETURN")
        box2.error == ""
        box2.result.shipmentDelivered == true
        returnItem(ids.returnId).statusId == "ReturnReceived"
        // every item handled: received, and on Accounting's settlement worklist (ReturnManResp), settled by no one yet
        one("mantle.order.return.ReturnHeader", {returnId: ids.returnId}).statusId == "ReturnManResp"
        receipts.length == 2
        receipts.reduce((total, row) => total + n(row.quantityRejected), 0) == 1
        // both boxes in the one lot of that number, not a lot of the customer's per box
        new Set(receipts.map(row => asset(row.assetId).lotId)).size == 1
        !one("mantle.product.asset.Lot", {lotId: asset(receipts[0].assetId).lotId}).mfgPartyId
        receipts.every(row => asset(row.assetId).statusId == "AstQuarantine" && asset(row.assetId).locationSeqId == "QUAR1")
        inspection(ids.inspections[0]).sourceTypeEnumId == "QisReturn"
        inspection(ids.inspections[0]).inspectionContextEnumId == "QicReturn"
        inspection(ids.inspections[0]).returnId == ids.returnId
        n(inspection(ids.inspections[0]).heldQuantity) == 1
        billings.length == 0
        settle.error.includes("FORBIDDEN")
    }
})

feature("inspection restocks one returned unit and scraps the other", {
    when() {
        const [first, second] = ids.inspections
        const firstResult = inspect(first, 1, 0)
        const released = run("wrt_manager", Q + "dispose#Inspection", {
            operationKey: key(),
            qualityInspectionId: first,
            dispositionEnumId: "QdRelease",
            quantity: 1
        })
        const secondResult = inspect(second, 0, 1)
        const scrapped = run("wrt_manager", Q + "dispose#Inspection", {
            operationKey: key(),
            qualityInspectionId: second,
            dispositionEnumId: "QdScrap",
            quantity: 1,
            toLocationSeqId: "MORG1"
        })
        return {firstResult, released, secondResult, scrapped}
    },
    then({firstResult, released, secondResult, scrapped}) {
        firstResult.submitted.error == ""
        firstResult.verified.error == ""
        released.error == ""
        asset(released.result.resultAssetId).statusId == "AstAvailable"
        n(inspection(ids.inspections[0]).heldQuantity) == 0
        secondResult.verified.error == ""
        scrapped.error == ""
        n(asset(scrapped.result.resultAssetId).quantityOnHandTotal) == 0
        rows("mantle.order.return.ReturnItemBilling", {returnId: ids.returnId}).length == 0
    }
})

feature("a supplier return of a rejected, expired lot issues the quarantined asset and ships, setting ReturnShipped", {
    when() {
        // the lot is received through the guard: inspected on receipt, so quarantined; it expired last year
        const po = call("mantle.order.OrderServices.create#Order", {
            customerPartyId: org,
            vendorPartyId: supplier,
            currencyUomId: "USD",
            facilityId: facility
        })
        call("mantle.order.OrderServices.add#OrderProductQuantity", {
            orderId: po.orderId,
            orderPartSeqId: po.orderPartSeqId,
            productId: "WRT_LOTTED",
            quantity: 4,
            unitAmount: 5,
            itemTypeEnumId: "ItemInventory"
        })
        call("mantle.order.OrderServices.place#Order", {orderId: po.orderId})
        call("mantle.order.OrderServices.approve#Order", {orderId: po.orderId})
        const receiptShipment = run("wrt_receiver", T + "ensure#PurchaseReceipt", {
            operationKey: key(),
            orderId: po.orderId,
            orderPartSeqId: "01",
            facilityId: facility
        }).result.shipmentId
        const received = run("wrt_receiver", T + "receive#ShipmentStock", {
            operationKey: key(),
            shipmentId: receiptShipment,
            productId: "WRT_LOTTED",
            quantityAccepted: 4,
            lotNumber: "WRT-LOT-1",
            expirationDate: "2025-06-30"
        })
        const qualityInspectionId = received.result.qualityInspectionIds[0]
        inspect(qualityInspectionId, 0, 4)
        const toSupplier = run("wrt_manager", Q + "dispose#Inspection", {
            operationKey: key(),
            qualityInspectionId,
            dispositionEnumId: "QdReturnSupplier",
            quantity: 4
        })
        const heldAsset = toSupplier.result.resultAssetId
        const noFilter = run("wrt_manager", R + "find#ReturnableReceipts", {})
        const eligibleRead = run("wrt_manager", R + "find#ReturnableReceipts", {vendorPartyId: supplier})
        const readerFind = run("wrt_reader", R + "find#ReturnableReceipts", {vendorPartyId: supplier})
        const row = eligibleRead.receiptRows?.[0]
        // the return: created as Warehouse's NewReturn does, then the receipt's quantity, then a second return refused
        const returnId = call(R + "create#Return", {
            customerPartyId: org,
            vendorPartyId: supplier,
            facilityId: facility,
            currencyUomId: "USD"
        }).returnId
        const added = run("wrt_manager", R + "add#ReceiptToReturn", {
            returnId,
            assetReceiptId: row.assetReceiptId,
            returnQuantity: 4
        })
        const secondReturn = call(R + "create#Return", {
            customerPartyId: org,
            vendorPartyId: supplier,
            facilityId: facility,
            currencyUomId: "USD"
        }).returnId
        const excess = run("wrt_manager", R + "add#ReceiptToReturn", {
            returnId: secondReturn,
            assetReceiptId: row.assetReceiptId,
            returnQuantity: 1
        })
        call(R + "approve#Return", {returnId})
        const shipmentId = shipmentOf(returnId)
        const item = returnItem(returnId)
        const issue = (username, quantity, operationKey = key()) =>
            run(username, T + "issue#SupplierReturnStock", {
                operationKey,
                shipmentId,
                returnId,
                returnItemSeqId: item.returnItemSeqId,
                quantity
            })
        const early = run("wrt_shipper", T + "ship#SupplierReturn", {operationKey: key(), shipmentId})
        const issuerOnly = issue("wrt_issuer", 4)
        const tooMuch = issue("wrt_manager", 5)
        const issued = issue("wrt_manager", 4)
        const status = call(Q + "get#SourceInspectionStatus", {assetReceiptId: row.assetReceiptId})
        const shipKey = key()
        const notShipper = run("wrt_manager", T + "ship#SupplierReturn", {operationKey: key(), shipmentId})
        const shipped = run("wrt_shipper", T + "ship#SupplierReturn", {operationKey: shipKey, shipmentId, trackingCode: "1Z-WRT"})
        const again = run("wrt_shipper", T + "ship#SupplierReturn", {operationKey: shipKey, shipmentId, trackingCode: "1Z-WRT"})
        const afterRead = run("wrt_manager", R + "find#ReturnableReceipts", {vendorPartyId: supplier, includeIneligible: true})
        return {
            received,
            toSupplier,
            heldAsset,
            noFilter,
            row,
            readerFind,
            added,
            excess,
            early,
            issuerOnly,
            tooMuch,
            issued,
            status,
            notShipper,
            shipped,
            again,
            returnId,
            shipmentId,
            qualityInspectionId,
            afterRead
        }
    },
    then(r) {
        r.received.error == ""
        r.toSupplier.error == ""
        asset(r.heldAsset).statusId == "AstQuarantine"
        r.noFilter.error.includes("FILTER_REQUIRED")
        r.readerFind.error.includes("PERMISSION_DENIED")
        n(r.row.acceptedQuantity) == 4
        n(r.row.quarantinedQuantity) == 4
        n(r.row.eligibleQuantity) == 4
        r.row.assets.some(row => row.assetId == r.heldAsset && n(row.returnSupplierQuantity) == 4)
        r.added.error == ""
        r.added.assetId == r.heldAsset
        r.excess.error.includes("QUANTITY_EXCEEDS_ELIGIBLE")
        r.early.error.includes("OUTSTANDING")
        r.issuerOnly.error.includes("PERMISSION_DENIED")
        r.tooMuch.error.includes("QUANTITY_EXCEEDS")
        r.issued.error == ""
        r.issued.result.assetId == r.heldAsset
        n(asset(r.heldAsset).quantityOnHandTotal) == 0
        n(inspection(r.qualityInspectionId).heldQuantity) == 0
        n(r.status.receiptRows[0].matchEligibleQuantity) == 0
        n(r.status.receiptRows[0].heldQuantity) == 0
        r.notShipper.error.includes("PERMISSION_DENIED")
        r.shipped.error == ""
        r.again.result.alreadyApplied == true
        one("mantle.shipment.Shipment", {shipmentId: r.shipmentId}).statusId == "ShipShipped"
        returnItem(r.returnId).statusId == "ReturnShipped"
        one("mantle.order.return.ReturnHeader", {returnId: r.returnId}).statusId == "ReturnShipped"
        rows("mantle.shipment.ShipmentPackageRouteSeg", {shipmentId: r.shipmentId}).every(row => row.trackingCode == "1Z-WRT")
        n(r.afterRead.receiptRows[0].eligibleQuantity) == 0
    }
})
