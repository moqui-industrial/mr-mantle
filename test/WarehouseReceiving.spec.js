// The Warehouse receipt entry points (mantle.shipment.WarehouseTaskServices, Receiving.js; impl-warehouse P7, design §19
// short receipt): one open receipt per purchase part, a line received with a rejected unit and a generated lot range, the
// entered unit kept, a double submit answering the first receipt, serial counts, the over-receipt tolerance, the receipt
// steps of the operation policy, the short receipt closed (Purchasing's close#PurchaseRemainders, the self-billing bill
// for the accepted quantity only) or backordered, the revision of an open receipt, "receive all as expected" and the ad
// hoc receipt. The users are in spec-local groups.
const T = "mantle.shipment.WarehouseTaskServices."
const org = "WHR_ORG",
    supplier = "WHR_SUPPLIER",
    selfBilled = "WHR_SELF"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const n = value => (value == null ? 0 : Number(String(value)))
const sum = (list, field) => list.reduce((total, row) => total + n(row[field]), 0)
const since = "2000-01-01T00:00:00Z"
let keySeq = 0
const key = () => "whr-op-" + ++keySeq

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
const run = (username, verb, parameters) => as(username, () => invoke(T + verb, parameters))
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
// an approved purchase order of the given lines ([productId, quantity, quantityUomId]) for a facility
function purchaseOrder(facilityId, lines, vendorPartyId = supplier) {
    const created = call("mantle.order.OrderServices.create#Order", {
        customerPartyId: org,
        vendorPartyId,
        currencyUomId: "USD",
        facilityId
    })
    for (const [productId, quantity, quantityUomId] of lines) {
        const added = call("mantle.order.OrderServices.add#OrderProductQuantity", {
            orderId: created.orderId,
            orderPartSeqId: created.orderPartSeqId,
            productId,
            quantity,
            unitAmount: 5,
            itemTypeEnumId: "ItemInventory"
        })
        if (quantityUomId)
            call("update#mantle.order.OrderItem", {
                orderId: created.orderId,
                orderItemSeqId: added.orderItemSeqId,
                quantityUomId
            })
    }
    call("mantle.order.OrderServices.place#Order", {orderId: created.orderId})
    call("mantle.order.OrderServices.approve#Order", {orderId: created.orderId})
    return created.orderId
}
const ensure = (orderId, facilityId, operationKey = key(), username = "whr_receiver") =>
    run(username, "ensure#PurchaseReceipt", {operationKey, orderId, orderPartSeqId: "01", facilityId})
const receiveLine = (parameters, username = "whr_receiver") =>
    run(username, "receive#ShipmentStock", Object.assign({operationKey: key()}, parameters))
const receiptsOf = (shipmentId, productId) => rows("mantle.product.receipt.AssetReceipt", {shipmentId, productId})
const billsOf = shipmentId => [
    ...new Set(
        rows("mantle.shipment.ShipmentItemSource", {shipmentId})
            .map(row => row.invoiceId)
            .filter(Boolean)
    )
]

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(org, "OrgInternal")
        call("mantle.ledger.LedgerServices.init#PartyAccountingConfiguration", {
            organizationPartyId: org,
            sourcePartyId: "DefaultSettings",
            baseCurrencyUomId: "USD"
        })
        call("mantle.ledger.LedgerServices.get#OrganizationFiscalTimePeriods", {
            organizationPartyId: org,
            filterDate: ec.user.nowTimestamp
        })
        organization("WHR_OTHER", "OrgInternal")
        organization(supplier, "Supplier")
        organization(selfBilled, "Supplier")
        user("WHR_RECEIVER", ["STOCK_RECEIVE"])
        user("WHR_BUYER", ["PURCHASE_ORDER_EDIT"])
        user("WHR_READER", [])
        user("WHR_MANAGER", ["STOCK_POLICY_MANAGE"])
        // the facilities: no operation policy (step 1), two-step with a tolerance, three-step (quarantine)
        for (const facilityId of ["WHR_FAC1", "WHR_FAC2", "WHR_FAC3"]) {
            call("create#mantle.facility.Facility", {facilityId, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: org})
            for (const [locationSeqId, locationTypeEnumId] of [
                ["PICK1", "FltPick"],
                ["RECV1", "FltReceiving"],
                ["QUAR1", "FltQuarantine"]
            ])
                call("create#mantle.facility.FacilityLocation", {facilityId, locationSeqId, locationTypeEnumId})
            for (const [locationTypeEnumId, autoStatusId] of [
                ["FltPick", "AstAvailable"],
                ["FltReceiving", "AstOnHold"],
                ["FltQuarantine", "AstQuarantine"]
            ])
                call("create#mantle.facility.FacilityLocationType", {facilityId, locationTypeEnumId, autoStatusId})
        }
        call("create#mantle.facility.Facility", {facilityId: "WHR_FAC4", facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: org})
        call("create#mantle.facility.FacilityLocation", {
            facilityId: "WHR_FAC4",
            locationSeqId: "PICK1",
            locationTypeEnumId: "FltPick"
        })
        call("create#mantle.facility.Facility", {
            facilityId: "WHR_OTHER_FAC",
            facilityTypeEnumId: "FcTpWarehouse",
            ownerPartyId: "WHR_OTHER"
        })
        call("create#moqui.basic.Uom", {
            uomId: "WHR_dz",
            description: "Dozen",
            abbreviation: "dz",
            uomTypeEnumId: "UT_OTHER_MEASURE"
        })
        call("create#moqui.basic.UomConversion", {
            uomConversionId: "WHR_DZ_EA",
            uomId: "WHR_dz",
            toUomId: "OTH_ea",
            conversionFactor: 12
        })
        for (const productId of ["WHR_PLAIN", "WHR_LOT", "WHR_SERIAL", "WHR_BULK", "WHR_DOZ"])
            call("create#mantle.product.Product", {
                productId,
                productName: productId,
                productTypeEnumId: "PtAsset",
                assetTypeEnumId: "AstTpInventory",
                amountUomId: "OTH_ea",
                ownerPartyId: org
            })
        call("create#mantle.facility.ProductFacilityLocation", {
            productId: "WHR_PLAIN",
            facilityId: "WHR_FAC1",
            locationSeqId: "PICK1"
        })
        const policy = (fields, scope = {}) =>
            call(
                "create#mantle.facility.WarehousePolicy",
                Object.assign({organizationPartyId: org, facilityId: "_NA_", productId: "_NA_", fromDate: since}, scope, fields)
            )
        policy({policyType: "tracking", lotRequired: "Y", shelfLifeDays: 365}, {productId: "WHR_LOT"})
        policy({policyType: "tracking", serialRequired: "Y", serialPattern: "WS-{seq:4}"}, {productId: "WHR_SERIAL"})
        policy(
            {policyType: "operation", receiptSteps: 2, receivingLocationSeqId: "RECV1", overReceiptPercent: 10},
            {facilityId: "WHR_FAC2"}
        )
        policy({policyType: "operation", receiptSteps: 3, quarantineLocationSeqId: "QUAR1"}, {facilityId: "WHR_FAC3"})
        policy({policyType: "operation", receiptSteps: 2}, {facilityId: "WHR_FAC4"})
        call("mantle.party.SupplierServices.store#SupplierProfile", {
            organizationPartyId: org,
            supplierPartyId: selfBilled,
            selfBillingIndicator: "Y",
            fromDate: new Date(Number(ec.user.nowTimestamp) - 60000)
        })
        call("update#mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: org, receiptInvoiceSelfBilledOnly: "Y"})
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

feature("a part has one open receipt: a second request opens it, a retry answers the first, a buyer may ask", {
    when() {
        const orderId = purchaseOrder("WHR_FAC1", [["WHR_PLAIN", 6]])
        const operationKey = key()
        const first = ensure(orderId, "WHR_FAC1", operationKey)
        const retry = ensure(orderId, "WHR_FAC1", operationKey)
        // asked for at another facility, the open receipt is answered with its own (P7 review C2)
        const second = ensure(orderId, "WHR_FAC2")
        const buyer = ensure(orderId, "WHR_FAC1", key(), "whr_buyer")
        const reader = ensure(orderId, "WHR_FAC1", key(), "whr_reader")
        const otherFacility = ensure(orderId, "WHR_OTHER_FAC")
        return {
            first,
            retry,
            second,
            buyer,
            reader,
            otherFacility,
            receipts: rows("mantle.shipment.ShipmentItemSource", {orderId})
        }
    },
    then({first, retry, second, buyer, reader, otherFacility, receipts}) {
        first.error == ""
        first.result.resultCode == "CREATED"
        retry.result.alreadyApplied == true
        retry.result.shipmentId == first.result.shipmentId
        second.result.resultCode == "EXISTING"
        second.result.shipmentId == first.result.shipmentId
        second.result.facilityId == "WHR_FAC1"
        buyer.result.shipmentId == first.result.shipmentId
        reader.error.includes("PERMISSION_DENIED")
        otherFacility.error.includes("RECORD_UNAVAILABLE")
        receipts.length == 1
    }
})

feature("part of a part is received with one rejected unit and a generated lot range; a double submit answers the first", {
    when() {
        const orderId = purchaseOrder("WHR_FAC1", [["WHR_LOT", 10]])
        const shipmentId = ensure(orderId, "WHR_FAC1").result.shipmentId
        const lots = run("whr_receiver", "generate#TrackingIdentities", {
            trackingKind: "lot",
            productId: "WHR_LOT",
            facilityId: "WHR_FAC1",
            count: 2,
            firstValue: "WL-0098"
        })
        const values = lots.identityRows.map(row => row.value)
        const noLot = receiveLine({shipmentId, productId: "WHR_LOT", quantityAccepted: 1})
        const noReason = receiveLine({
            shipmentId,
            productId: "WHR_LOT",
            quantityAccepted: 1,
            quantityRejected: 1,
            lotNumber: values[0]
        })
        const operationKey = key()
        const firstLot = {operationKey, shipmentId, productId: "WHR_LOT", quantityAccepted: 3, quantityRejected: 1}
        Object.assign(firstLot, {rejectionReasonEnumId: "ArjDamaged", lotNumber: values[0]})
        const first = receiveLine(firstLot)
        const again = receiveLine(firstLot)
        const second = receiveLine({shipmentId, productId: "WHR_LOT", quantityAccepted: 2, lotNumber: values[1]})
        const notices = rows("moqui.security.user.NotificationMessage", {
            topic: "WarehouseReceiptException",
            recordId: shipmentId
        })
        return {lots, values, noLot, noReason, first, again, second, receipts: receiptsOf(shipmentId, "WHR_LOT"), notices}
    },
    then({lots, values, noLot, noReason, first, again, second, receipts, notices}) {
        lots.error == ""
        values[0] == "WL-0098"
        values[1] == "WL-0099"
        lots.duplicateCount == 0
        noLot.error.includes("LOT_REQUIRED")
        noReason.error.includes("REASON_REQUIRED")
        first.error == ""
        first.result.quantityAccepted == "3"
        first.result.quantityRejected == "1"
        first.result.receiptSteps == 1
        first.result.remainingQuantity == "6"
        again.result.alreadyApplied == true
        second.result.remainingQuantity == "4"
        // three units accepted and one rejected, then two accepted: the retry wrote nothing
        sum(receipts, "quantityAccepted") == 5
        sum(receipts, "quantityRejected") == 1
        receipts.every(row => n(row.appliedConversionFactor) == 1 && row.enteredQuantityUomId == "OTH_ea")
        rows("mantle.product.asset.Asset", {productId: "WHR_LOT"}).every(asset => asset.expectedEndOfLife != null)
        notices.length == 1
    }
})

feature("a PO line in dozens is received in each: Mantle counts it in stock units, so the part stays open until closed", {
    when() {
        const orderId = purchaseOrder("WHR_FAC1", [["WHR_DOZ", 2, "WHR_dz"]])
        const shipmentId = ensure(orderId, "WHR_FAC1").result.shipmentId
        const expected = sum(rows("mantle.shipment.ShipmentItemSource", {shipmentId}), "quantity")
        const received = receiveLine({shipmentId, productId: "WHR_DOZ", quantityAccepted: 1})
        // one dozen of two: the part is not fulfilled (isFulfilled#OrderItem compares 12 each with 2 dozen, F186)
        const afterDozen = one("mantle.order.OrderPart", {orderId, orderPartSeqId: "01"}).statusId
        const eaches = receiveLine({shipmentId, productId: "WHR_DOZ", quantityAccepted: 6, quantityUomId: "OTH_ea"})
        const closed = run("whr_receiver", "close#ReceiptRemainder", {
            operationKey: key(),
            shipmentId,
            choice: "close",
            reason: "Half a dozen short"
        })
        return {
            expected,
            received,
            afterDozen,
            eaches,
            closed,
            receipts: receiptsOf(shipmentId, "WHR_DOZ"),
            item: one("mantle.order.OrderItem", {orderId, orderItemSeqId: "01"}),
            order: one("mantle.order.OrderHeader", {orderId}),
            shipment: one("mantle.shipment.Shipment", {shipmentId}),
            dozens: call("mantle.order.OrderServices.get#OrderItemStockFactor", {orderId, orderItemSeqId: "01"})
        }
    },
    then({expected, received, afterDozen, eaches, closed, receipts, item, order, shipment, dozens}) {
        expected == 24
        received.error == ""
        received.result.quantityAccepted == "12"
        received.result.enteredQuantityUomId == "WHR_dz"
        afterDozen == "OrderApproved"
        eaches.result.quantityAccepted == "6"
        eaches.result.remainingQuantity == "6"
        receipts.some(
            row => row.enteredQuantityUomId == "WHR_dz" && n(row.enteredQuantity) == 1 && n(row.appliedConversionFactor) == 12
        )
        // 18 each of 2 dozen: half a dozen is closed, in the line's unit
        closed.error == ""
        closed.result.orders[0].closedItems[0].cancelledQuantity == "0.5"
        n(item.quantity) == 1.5
        n(item.quantityCancelled) == 0.5
        order.statusId == "OrderCompleted"
        shipment.statusId == "ShipDelivered"
        n(dozens.stockFactor) == 12
    }
})
feature("an order line in the stock unit, or in a unit with no conversion, is counted as before (factor 1)", {
    when() {
        const orderId = purchaseOrder("WHR_FAC1", [
            ["WHR_PLAIN", 4],
            ["WHR_BULK", 3, "WT_kg"]
        ])
        return {
            plain: call("mantle.order.OrderServices.get#OrderItemStockFactor", {orderId, orderItemSeqId: "01"}),
            unrelated: call("mantle.order.OrderServices.get#OrderItemStockFactor", {orderId, orderItemSeqId: "02"}),
            plainItem: one("mantle.order.OrderItem", {orderId, orderItemSeqId: "01"}),
            shipped: call("mantle.shipment.ShipmentServices.create#OrderPartShipment", {orderId, orderPartSeqId: "01"}),
            orderId
        }
    },
    then({plain, unrelated, plainItem, shipped, orderId}) {
        plainItem.quantityUomId == "OTH_ea"
        n(plain.stockFactor) == 1
        plain.converted == false
        n(unrelated.stockFactor) == 1
        unrelated.converted == false
        sum(rows("mantle.shipment.ShipmentItemSource", {shipmentId: shipped.shipmentId}), "quantity") == 7
    }
})

feature("serialized stock needs one unique serial per accepted unit; a count that does not match is refused", {
    when() {
        const orderId = purchaseOrder("WHR_FAC1", [["WHR_SERIAL", 4]])
        const shipmentId = ensure(orderId, "WHR_FAC1").result.shipmentId
        const generated = run("whr_receiver", "generate#TrackingIdentities", {
            productId: "WHR_SERIAL",
            facilityId: "WHR_FAC1",
            count: 3
        })
        const serials = generated.identityRows.map(row => row.value)
        const mismatch = receiveLine({
            shipmentId,
            productId: "WHR_SERIAL",
            quantityAccepted: 3,
            serialNumbers: serials.slice(0, 2)
        })
        const repeated = receiveLine({
            shipmentId,
            productId: "WHR_SERIAL",
            quantityAccepted: 2,
            serialNumbers: [serials[0], serials[0]]
        })
        const good = receiveLine({shipmentId, productId: "WHR_SERIAL", quantityAccepted: 3, serialNumbers: serials})
        const again = receiveLine({shipmentId, productId: "WHR_SERIAL", quantityAccepted: 1, serialNumbers: [serials[0]]})
        const preview = run("whr_receiver", "generate#TrackingIdentities", {
            productId: "WHR_SERIAL",
            facilityId: "WHR_FAC1",
            count: 2
        })
        // a dock rejection with nothing accepted is a receipt with no stock (receive#Asset receives nothing for zero)
        const rejectOnly = receiveLine({
            shipmentId,
            productId: "WHR_SERIAL",
            quantityRejected: 1,
            rejectionReasonEnumId: "ArjDamaged"
        })
        const receipts = receiptsOf(shipmentId, "WHR_SERIAL")
        const assets = rows("mantle.product.asset.Asset", {productId: "WHR_SERIAL"})
        const restart = run("whr_receiver", "generate#TrackingIdentities", {
            productId: "WHR_SERIAL",
            facilityId: "WHR_FAC1",
            count: 2,
            startNumber: 1
        })
        return {serials, mismatch, repeated, good, again, preview, restart, rejectOnly, receipts, assets}
    },
    then({serials, mismatch, repeated, good, again, preview, restart, rejectOnly, receipts, assets}) {
        serials[0] == "WS-0001"
        mismatch.error.includes("SERIAL_COUNT_MISMATCH")
        repeated.error.includes("SERIAL_DUPLICATE")
        good.error == ""
        good.result.assetIds.length == 3
        assets.length == 3
        again.error.includes("SERIAL_DUPLICATE")
        // the pattern goes on after the highest serial made from it (P7 review B3), and a start number flags those in stock
        preview.duplicateCount == 0
        preview.identityRows[0].value == "WS-0004"
        restart.duplicateCount == 2
        restart.identityRows[0].reason == "IN_STOCK"
        rejectOnly.error == ""
        rejectOnly.result.remainingQuantity == "0"
        receipts.filter(row => n(row.quantityRejected) == 1 && row.assetId == null && row.shipmentItemSourceId != null).length ==
            1
    }
})

feature("the receipt steps post to the default location, the receiving location or quarantine; over-receipt is refused", {
    when() {
        const step1 = purchaseOrder("WHR_FAC1", [["WHR_PLAIN", 5]])
        const step2 = purchaseOrder("WHR_FAC2", [["WHR_BULK", 10]])
        const step3 = purchaseOrder("WHR_FAC3", [["WHR_PLAIN", 5]])
        const receipt1 = ensure(step1, "WHR_FAC1").result.shipmentId
        const receipt2 = ensure(step2, "WHR_FAC2").result.shipmentId
        const receipt3 = ensure(step3, "WHR_FAC3").result.shipmentId
        const over1 = receiveLine({shipmentId: receipt1, productId: "WHR_PLAIN", quantityAccepted: 6})
        const one1 = receiveLine({shipmentId: receipt1, productId: "WHR_PLAIN", quantityAccepted: 5})
        // two-step with 10% tolerance: 11 of 10 is allowed, a 12th is not
        // a pick bin asked for at a two-step receipt is not a receiving location: it posts to receiving (P7 review C4)
        const one2 = receiveLine({shipmentId: receipt2, productId: "WHR_BULK", quantityAccepted: 11, locationSeqId: "PICK1"})
        // two-step at a facility with no receiving location is refused rather than posting no location
        const noReceiving = receiveLine({
            shipmentId: ensure(purchaseOrder("WHR_FAC4", [["WHR_BULK", 2]]), "WHR_FAC4").result.shipmentId,
            productId: "WHR_BULK",
            quantityAccepted: 1
        })
        const over2 = receiveLine({shipmentId: receipt2, productId: "WHR_BULK", quantityAccepted: 1})
        const one3 = receiveLine({shipmentId: receipt3, productId: "WHR_PLAIN", quantityAccepted: 5, locationSeqId: "PICK1"})
        const statusOf = result => one("mantle.product.asset.Asset", {assetId: result.result.assetIds[0]})
        return {
            over1,
            one1,
            one2,
            over2,
            one3,
            noReceiving,
            asset1: statusOf(one1),
            asset2: statusOf(one2),
            asset3: statusOf(one3)
        }
    },
    then({over1, one1, one2, over2, one3, noReceiving, asset1, asset2, asset3}) {
        over1.error.includes("OVER_RECEIPT")
        one1.result.locationSeqId == "PICK1"
        asset1.statusId == "AstAvailable"
        one2.result.receiptSteps == 2
        one2.result.locationSeqId == "RECV1"
        asset2.statusId == "AstOnHold"
        over2.error.includes("OVER_RECEIPT")
        noReceiving.error.includes("LOCATION_REQUIRED")
        // step 3 posts into quarantine whatever pick bin is asked for
        one3.result.locationSeqId == "QUAR1"
        asset3.statusId == "AstQuarantine"
    }
})

feature(
    "a short receipt is closed with a reason: the remainder is cancelled, the order completes, only a self-biller is billed",
    {
        when() {
            const plainOrder = purchaseOrder("WHR_FAC1", [["WHR_BULK", 10]])
            const selfOrder = purchaseOrder("WHR_FAC1", [["WHR_BULK", 10]], selfBilled)
            const plain = ensure(plainOrder, "WHR_FAC1").result.shipmentId
            const self = ensure(selfOrder, "WHR_FAC1").result.shipmentId
            call("create#mantle.other.budget.BudgetCommitment", {
                budgetCommitmentId: "WHR_COMMIT",
                organizationPartyId: org,
                sourceEntityName: "mantle.order.OrderHeader",
                sourceId: selfOrder,
                sourceItemId: "01",
                sourceRevision: "1",
                stageEnumId: "BcsOrder",
                amount: 50,
                currencyUomId: "USD",
                statusId: "BcReserved"
            })
            for (const shipmentId of [plain, self])
                receiveLine({
                    shipmentId,
                    productId: "WHR_BULK",
                    quantityAccepted: 6,
                    quantityRejected: 1,
                    rejectionReasonEnumId: "ArjDamaged"
                })
            const noReason = run("whr_receiver", "close#ReceiptRemainder", {
                operationKey: key(),
                shipmentId: plain,
                choice: "close",
                reason: ""
            })
            const closedPlain = run("whr_receiver", "close#ReceiptRemainder", {
                operationKey: key(),
                shipmentId: plain,
                choice: "close",
                reason: "Supplier is out of stock"
            })
            const closedSelf = run("whr_receiver", "close#ReceiptRemainder", {
                operationKey: key(),
                shipmentId: self,
                choice: "close",
                reason: "Supplier is out of stock"
            })
            const selfBills = billsOf(self)
            const lines = selfBills.length ? rows("mantle.account.invoice.InvoiceItem", {invoiceId: selfBills[0]}) : []
            return {
                noReason,
                closedPlain,
                closedSelf,
                plainBills: billsOf(plain),
                lines,
                item: one("mantle.order.OrderItem", {orderId: selfOrder, orderItemSeqId: "01"}),
                order: one("mantle.order.OrderHeader", {orderId: selfOrder}),
                notes: rows("mantle.order.OrderNote", {orderId: selfOrder}),
                commitment: one("mantle.other.budget.BudgetCommitment", {budgetCommitmentId: "WHR_COMMIT"}),
                shipment: one("mantle.shipment.Shipment", {shipmentId: self})
            }
        },
        then({noReason, closedPlain, closedSelf, plainBills, lines, item, order, notes, commitment, shipment}) {
            noReason.error.includes("REASON_REQUIRED")
            closedPlain.error == ""
            closedSelf.result.resultCode == "CLOSED"
            closedSelf.result.orders[0].closedItems[0].cancelledQuantity == "3"
            n(item.quantity) == 7
            n(item.quantityCancelled) == 3
            order.statusId == "OrderCompleted"
            notes.some(note => note.noteText.includes("Supplier is out of stock"))
            commitment.statusId == "BcReleased"
            shipment.statusId == "ShipDelivered"
            // the receipt billing rule: no bill for the plain supplier, the self-biller's for the 6 accepted only
            plainBills.length == 0
            lines.length == 1
            n(lines[0].quantity) == 6
        }
    }
)

feature("a short receipt is backordered: it keeps what arrived and the remainder goes to the part's next receipt", {
    when() {
        const orderId = purchaseOrder("WHR_FAC1", [["WHR_BULK", 8]])
        const shipmentId = ensure(orderId, "WHR_FAC1").result.shipmentId
        receiveLine({shipmentId, productId: "WHR_BULK", quantityAccepted: 5})
        const backordered = run("whr_receiver", "close#ReceiptRemainder", {
            operationKey: key(),
            shipmentId,
            choice: "backorder",
            reason: "Rest ships next week"
        })
        const next = backordered.result?.backorders?.[0]?.shipmentId
        const reopened = ensure(orderId, "WHR_FAC1")
        return {
            backordered,
            next,
            reopened,
            first: one("mantle.shipment.Shipment", {shipmentId}),
            firstItem: one("mantle.shipment.ShipmentItem", {shipmentId, productId: "WHR_BULK"}),
            nextItem: next ? one("mantle.shipment.ShipmentItem", {shipmentId: next, productId: "WHR_BULK"}) : null
        }
    },
    then({backordered, next, reopened, first, firstItem, nextItem}) {
        backordered.error == ""
        backordered.result.resultCode == "BACKORDERED"
        first.statusId == "ShipDelivered"
        n(firstItem.quantity) == 5
        next != null
        n(nextItem.quantity) == 3
        reopened.result.shipmentId == next
    }
})

feature("Purchasing's close needs PURCHASE_ORDER_EDIT; a revision moves the open receipt, never below what arrived", {
    when() {
        const orderId = purchaseOrder("WHR_FAC1", [["WHR_BULK", 10]])
        const shipmentId = ensure(orderId, "WHR_FAC1").result.shipmentId
        receiveLine({shipmentId, productId: "WHR_BULK", quantityAccepted: 4})
        call("update#mantle.order.OrderItem", {orderId, orderItemSeqId: "01", quantity: 2})
        const revised = run("whr_buyer", "adjust#ExpectedReceipt", {operationKey: key(), orderId})
        const afterRevision = n(one("mantle.shipment.ShipmentItem", {shipmentId, productId: "WHR_BULK"}).quantity)
        call("update#mantle.order.OrderItem", {orderId, orderItemSeqId: "01", quantity: 6})
        run("whr_buyer", "adjust#ExpectedReceipt", {operationKey: key(), orderId})
        const afterIncrease = n(one("mantle.shipment.ShipmentItem", {shipmentId, productId: "WHR_BULK"}).quantity)
        const close = p =>
            as(p, () => invoke("mantle.order.OrderServices.close#PurchaseRemainders", {orderId, reason: "Not needed"}))
        const receiverClose = close("whr_receiver")
        const buyerClose = close("whr_buyer")
        return {revised, afterRevision, afterIncrease, receiverClose, buyerClose}
    },
    then({revised, afterRevision, afterIncrease, receiverClose, buyerClose}) {
        revised.error == ""
        afterRevision == 4
        afterIncrease == 6
        receiverClose.error.includes("PERMISSION_DENIED")
        buyerClose.error == ""
        buyerClose.closedItems[0].cancelledQuantity == "2"
        buyerClose.orderStatusId == "OrderCompleted"
    }
})

feature("receive all as expected needs confirmation; an ad hoc receipt needs a reason and keeps it", {
    when() {
        const orderId = purchaseOrder("WHR_FAC1", [
            ["WHR_PLAIN", 3],
            ["WHR_BULK", 2]
        ])
        const shipmentId = ensure(orderId, "WHR_FAC1").result.shipmentId
        const unconfirmed = run("whr_receiver", "receive#ExpectedShipment", {operationKey: key(), shipmentId})
        const all = run("whr_receiver", "receive#ExpectedShipment", {operationKey: key(), shipmentId, confirmed: true})
        const noReason = run("whr_receiver", "receive#AdHocStock", {
            operationKey: key(),
            facilityId: "WHR_FAC1",
            productId: "WHR_PLAIN",
            quantity: 2,
            reason: " "
        })
        const adHoc = run("whr_receiver", "receive#AdHocStock", {
            operationKey: key(),
            facilityId: "WHR_FAC1",
            productId: "WHR_PLAIN",
            quantity: 2,
            reason: "Found in the yard"
        })
        const foreign = run("whr_receiver", "receive#AdHocStock", {
            operationKey: key(),
            facilityId: "WHR_OTHER_FAC",
            productId: "WHR_PLAIN",
            quantity: 2,
            reason: "Found"
        })
        const receipt = adHoc.result
            ? one("mantle.product.receipt.AssetReceipt", {assetReceiptId: adHoc.result.assetReceiptIds[0]})
            : null
        return {
            unconfirmed,
            all,
            noReason,
            adHoc,
            foreign,
            receipt,
            shipment: one("mantle.shipment.Shipment", {shipmentId}),
            accepted: sum(rows("mantle.product.receipt.AssetReceipt", {shipmentId}), "quantityAccepted")
        }
    },
    then({unconfirmed, all, noReason, adHoc, foreign, receipt, shipment, accepted}) {
        unconfirmed.error.includes("CONFIRMATION_REQUIRED")
        all.error == ""
        all.result.lines.length == 2
        accepted == 5
        shipment.statusId == "ShipDelivered"
        noReason.error.includes("REASON_REQUIRED")
        adHoc.error == ""
        adHoc.result.locationSeqId == "PICK1"
        receipt.itemDescription == "Found in the yard"
        receipt.shipmentId == null
        foreign.error.includes("RECORD_UNAVAILABLE")
    }
})
feature("a backorder of a receipt that received nothing cancels it; a close at a receipt leaves another receipt's remainder", {
    when() {
        const emptyOrder = purchaseOrder("WHR_FAC1", [["WHR_BULK", 4]])
        const empty = ensure(emptyOrder, "WHR_FAC1").result.shipmentId
        const backordered = run("whr_receiver", "close#ReceiptRemainder", {
            operationKey: key(),
            shipmentId: empty,
            choice: "backorder",
            reason: "Nothing came"
        })
        // two open receipts of one part: 6 on the first, 4 on a second Mantle made
        const orderId = purchaseOrder("WHR_FAC1", [["WHR_BULK", 10]])
        const first = ensure(orderId, "WHR_FAC1").result.shipmentId
        call("mantle.shipment.ShipmentServices.update#ShipmentItem", {shipmentId: first, productId: "WHR_BULK", quantity: 6})
        const second = call("mantle.shipment.ShipmentServices.create#OrderPartShipment", {
            orderId,
            orderPartSeqId: "01",
            destinationFacilityId: "WHR_FAC1"
        }).shipmentId
        receiveLine({shipmentId: first, productId: "WHR_BULK", quantityAccepted: 5})
        const closed = run("whr_receiver", "close#ReceiptRemainder", {
            operationKey: key(),
            shipmentId: first,
            choice: "close",
            reason: "One short on this delivery"
        })
        return {
            backordered,
            empty: one("mantle.shipment.Shipment", {shipmentId: empty}),
            closed,
            item: one("mantle.order.OrderItem", {orderId, orderItemSeqId: "01"}),
            part: one("mantle.order.OrderPart", {orderId, orderPartSeqId: "01"}),
            secondItem: one("mantle.shipment.ShipmentItem", {shipmentId: second, productId: "WHR_BULK"})
        }
    },
    then({backordered, empty, closed, item, part, secondItem}) {
        backordered.error == ""
        backordered.result.delivered == false
        empty.statusId == "ShipCancelled"
        backordered.result.backorders.length == 1
        closed.error == ""
        closed.result.orders[0].closedItems[0].cancelledQuantity == "1"
        n(item.quantity) == 9
        part.statusId == "OrderApproved"
        n(secondItem.quantity) == 4
    }
})
feature("an ad hoc cost needs financial read, else the product's last cost is used; receipts check the open period", {
    when() {
        const base = {facilityId: "WHR_FAC1", productId: "WHR_PLAIN", quantity: 1, reason: "Found"}
        const costly = run("whr_receiver", "receive#AdHocStock", Object.assign({operationKey: key(), acquireCost: 7}, base))
        const plain = run("whr_receiver", "receive#AdHocStock", Object.assign({operationKey: key()}, base))
        // a closed fiscal period today refuses a receipt (read without locking the periods), then it is reopened
        const today = ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd")
        const current = Array.from(
            find("mantle.party.time.TimePeriod", {partyId: org})
                .condition("fromDate", "less-equals", today)
                .condition("thruDate", "greater-equals", today)
                .list()
        ).filter(period => period.isClosed !== "Y")
        for (const period of current)
            call("update#mantle.party.time.TimePeriod", {timePeriodId: period.timePeriodId, isClosed: "Y"})
        let closedPeriod
        try {
            closedPeriod = run("whr_receiver", "receive#AdHocStock", Object.assign({operationKey: key()}, base))
        } finally {
            for (const period of current)
                call("update#mantle.party.time.TimePeriod", {timePeriodId: period.timePeriodId, isClosed: "N"})
        }
        return {costly, plain, closedPeriod, current}
    },
    then({costly, plain, closedPeriod, current}) {
        costly.error.includes("COST_NOT_PERMITTED")
        plain.error == ""
        plain.result.costSource == "last" || plain.result.costSource == null
        current.length > 0
        closedPeriod.error.includes("PERIOD_CLOSED")
    }
})
