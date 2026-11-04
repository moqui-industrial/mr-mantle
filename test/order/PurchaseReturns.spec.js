// Purchasing's supplier returns (impl-purchasing P8; design-purchasing §9 ReturnDetail): a buyer holding RETURN_AUTHORIZE
// authorizes a supplier return of their organization with the supplier's RMA, which makes its outbound shipment, and records
// a later RMA number; a return with no items, another organization's and a user without the permission are refused. A
// replacement (PURCHASE_ORDER_EDIT) of an authorized return is a purchase order from the supplier at no price, approved, with
// its expected receipt, linked from the return item, never more than the item leaves open; a retry answers the first. Mantle's
// own response processing at authorization orders nothing for a supplier return, so the replacement is this service's. With
// the buying policy's approval gate on, the replacement (zero total) is still approved: it commits no new spend.
// Standalone: a spec-local organization, supplier, facility and users, with artifact authorization disabled (the rules are
// the services' own permission checks). Run: ./moq test mr-mantle --spec PurchaseReturns
const helper = () => ec.resource.script("component://mr-mantle/test/ledger/AccountingReceivablesFixtures.js")
const svc = (name, p) => helper().call(name, p)
const one = (entity, key) => helper().lib.one(entity, key)
const rows = (entity, key) => helper().lib.rows(entity, key)
const prefix = "PUR_RET_SPEC"
const org = prefix + "_ORG",
    otherOrg = prefix + "_ORG2",
    supplier = prefix + "_SUPPLIER",
    facility = prefix + "_WH",
    product = "DEMO_1_1"
const R = "mantle.order.ReturnServices."
const users = {}
const ids = {}
let keySeq = 0
const key = () => prefix + "-" + Date.now() + "-" + ++keySeq

function party(partyId, name, roleTypeId) {
    svc("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
    svc("create#mantle.party.Organization", {partyId, organizationName: name})
    svc("create#mantle.party.PartyRole", {partyId, roleTypeId})
}
function user(kind, permissions, organizationPartyId = org) {
    const id = prefix + "_" + kind.toUpperCase()
    users[kind] = id
    svc("create#moqui.security.UserGroup", {userGroupId: id, description: "Purchase returns " + kind})
    for (const permission of permissions)
        svc("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: 0})
    svc("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    svc("create#moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId: id,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA"
    })
    svc("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: 0})
    svc("create#mantle.party.PartyRelationship", {
        partyRelationshipId: id,
        fromPartyId: id,
        toPartyId: organizationPartyId,
        relationshipTypeEnumId: "PrtAgent",
        fromDate: 0
    })
}
// The call as the user: its out-map, or the refusal's message in `error`.
function as(kind, name, p) {
    login(users[kind])
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(name).parameters(p).requireNewTransaction(true).call() || {}
        if (ec.message.hasError()) return {error: ec.message.getErrorsString()}
        return Object.assign({error: ""}, out)
    } catch (error) {
        return {error: String(error.message)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        login("john.doe")
    }
}
// F-P8-4: an approved order of eight at 5.00, received and accepted; its order line and receipt.
function received(quantity) {
    const order = svc("mantle.order.OrderServices.create#Order", {
        customerPartyId: org,
        vendorPartyId: supplier,
        currencyUomId: "USD",
        facilityId: facility
    })
    const item = svc("mantle.order.OrderServices.add#OrderProductQuantity", {
        orderId: order.orderId,
        orderPartSeqId: order.orderPartSeqId,
        productId: product,
        quantity,
        unitAmount: 5,
        itemTypeEnumId: "ItemInventory"
    })
    svc("mantle.order.OrderServices.place#Order", {orderId: order.orderId})
    svc("mantle.order.OrderServices.approve#Order", {orderId: order.orderId})
    const shipment = svc("mantle.shipment.ShipmentServices.create#OrderPartShipment", {
        orderId: order.orderId,
        orderPartSeqId: "01",
        destinationFacilityId: facility
    })
    svc("mantle.shipment.ShipmentServices.receive#ShipmentProduct", {
        shipmentId: shipment.shipmentId,
        productId: product,
        quantityAccepted: quantity,
        quantityRejected: 0,
        facilityId: facility
    })
    const receipt = rows("mantle.product.receipt.AssetReceipt", {shipmentId: shipment.shipmentId})[0]
    return {orderId: order.orderId, orderItemSeqId: item.orderItemSeqId, assetReceiptId: receipt.assetReceiptId}
}
// A supplier return of released stock of the receipt, authorized, issued and shipped by the warehouse.
function sentBack(source, quantity, response) {
    const returnId = svc(R + "create#ReturnFromOrder", {orderId: source.orderId, orderPartSeqId: "01"}).returnId
    const added = as("buyer", R + "add#ReceiptToReturn", {
        returnId,
        assetReceiptId: source.assetReceiptId,
        returnQuantity: quantity,
        returnResponseEnumId: response
    })
    const authorized = as("buyer", R + "authorize#SupplierReturn", {returnId, supplierRmaId: "RMA-" + returnId})
    const shipmentId = authorized.result?.shipmentId
    const issued = as("warehouse", "mantle.shipment.WarehouseTaskServices.issue#SupplierReturnStock", {
        operationKey: key(),
        shipmentId,
        returnId,
        returnItemSeqId: added.returnItemSeqId,
        quantity
    })
    const shipped = as("warehouse", "mantle.shipment.WarehouseTaskServices.ship#SupplierReturn", {
        operationKey: key(),
        shipmentId
    })
    return {
        returnId,
        returnItemSeqId: added.returnItemSeqId,
        errors: [added, authorized, issued, shipped].map(r => r.error).join("")
    }
}
// The supplier's bill of one product line, taken in by AP.
function supplierBill(quantity) {
    const invoiceId = as("ap", "mantle.account.InvoiceServices.import#Bill", {
        organizationPartyId: org,
        supplierPartyId: supplier,
        referenceNumber: prefix + "-" + key()
    }).invoiceId
    svc("mantle.account.InvoiceServices.create#InvoiceItem", {
        invoiceId,
        itemTypeEnumId: "ItemInventory",
        productId: product,
        quantity,
        amount: 5
    })
    return invoiceId
}
const allocations = (invoiceId, source, quantity) => [
    {
        invoiceItemSeqId: rows("mantle.account.invoice.InvoiceItem", {invoiceId})[0].invoiceItemSeqId,
        orderId: source.orderId,
        orderItemSeqId: source.orderItemSeqId,
        assetReceiptId: source.assetReceiptId,
        quantity: String(quantity)
    }
]
const M = "mantle.account.InvoiceMatchServices."
const appliedMatch = invoiceId => one("mantle.account.invoice.InvoiceMatch", {invoiceId, statusId: "ImApplied"})
const openHolds = invoiceId => rows("mantle.account.invoice.InvoiceHold", {invoiceId}).filter(row => !row.releasedDate)
const returnOf = () => svc(R + "create#ReturnFromOrder", {orderId: ids.orderId, orderPartSeqId: "01"}).returnId

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        party(org, "Purchase returns organization", "OrgInternal")
        svc("mantle.ledger.LedgerServices.init#PartyAccountingConfiguration", {
            organizationPartyId: org,
            sourcePartyId: "DefaultSettings",
            baseCurrencyUomId: "USD"
        })
        svc("update#mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: org, receiptInvoiceSelfBilledOnly: "Y"})
        party(otherOrg, "Purchase returns other organization", "OrgInternal")
        party(supplier, "Purchase returns supplier", "Supplier")
        svc("create#mantle.facility.Facility", {facilityId: facility, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: org})
        user("buyer", ["PURCHASE_ORDER_EDIT", "RETURN_AUTHORIZE"])
        user("editor", ["PURCHASE_ORDER_EDIT"])
        user("reader", ["PURCHASE_APPROVE"])
        user("other", ["PURCHASE_ORDER_EDIT", "RETURN_AUTHORIZE"], otherOrg)
        // the bill match of returned stock (F-P8-4): the warehouse sends back, AP takes in, matches and settles
        user("warehouse", ["STOCK_ISSUE", "SHIPMENT_SHIP"])
        user("ap", ["PAYABLE_EDIT", "PAYABLE_VIEW", "PAYABLE_IMPORT", "INVOICE_MATCH"])
        svc("mantle.ledger.LedgerServices.get#OrganizationFiscalTimePeriods", {
            organizationPartyId: org,
            filterDate: ec.user.nowTimestamp
        })
        // ten bought at 5.00, six received and accepted (not delivered, so no receipt bill)
        const order = svc("mantle.order.OrderServices.create#Order", {
            customerPartyId: org,
            vendorPartyId: supplier,
            currencyUomId: "USD",
            facilityId: facility
        })
        svc("mantle.order.OrderServices.add#OrderProductQuantity", {
            orderId: order.orderId,
            orderPartSeqId: order.orderPartSeqId,
            productId: product,
            quantity: 10,
            unitAmount: 5,
            itemTypeEnumId: "ItemInventory"
        })
        svc("mantle.order.OrderServices.place#Order", {orderId: order.orderId})
        svc("mantle.order.OrderServices.approve#Order", {orderId: order.orderId})
        const shipment = svc("mantle.shipment.ShipmentServices.create#OrderPartShipment", {
            orderId: order.orderId,
            orderPartSeqId: "01",
            destinationFacilityId: facility
        })
        svc("mantle.shipment.ShipmentServices.receive#ShipmentProduct", {
            shipmentId: shipment.shipmentId,
            productId: product,
            quantityAccepted: 6,
            quantityRejected: 0,
            facilityId: facility
        })
        ids.orderId = order.orderId
        ids.assetReceiptId = rows("mantle.product.receipt.AssetReceipt", {shipmentId: shipment.shipmentId})[0].assetReceiptId
    },
    cleanupSpec() {
        login("john.doe")
        ec.artifactExecution.enableAuthz()
    }
})

feature("a buyer authorizes a supplier return with the supplier's RMA; the refusals name their reason", {
    when() {
        ids.returnId = returnOf()
        ids.emptyReturnId = returnOf()
        const added = as("buyer", R + "add#ReceiptToReturn", {
            returnId: ids.returnId,
            assetReceiptId: ids.assetReceiptId,
            returnQuantity: 2,
            returnResponseEnumId: "RrspReplace"
        })
        const editor = as("editor", R + "authorize#SupplierReturn", {returnId: ids.returnId, supplierRmaId: "RMA-1"})
        const other = as("other", R + "authorize#SupplierReturn", {returnId: ids.returnId, supplierRmaId: "RMA-1"})
        const empty = as("buyer", R + "authorize#SupplierReturn", {returnId: ids.emptyReturnId})
        const authorized = as("buyer", R + "authorize#SupplierReturn", {returnId: ids.returnId, supplierRmaId: "RMA-1"})
        const again = as("buyer", R + "authorize#SupplierReturn", {returnId: ids.returnId, supplierRmaId: "RMA-1"})
        const recorded = as("buyer", R + "authorize#SupplierReturn", {returnId: ids.returnId, supplierRmaId: "RMA-2"})
        // Mantle's response processing at authorization answers nothing for a supplier return: no replacement yet
        ids.mantleReplacementId = rows("mantle.order.return.ReturnItem", {returnId: ids.returnId})[0].replacementOrderId
        const header = one("mantle.order.return.ReturnHeader", {returnId: ids.returnId})
        const shipment = authorized.result?.shipmentId
            ? one("mantle.shipment.Shipment", {shipmentId: authorized.result.shipmentId})
            : null
        return {added, editor, other, empty, authorized, again, recorded, header, shipment}
    },
    then({added, editor, other, empty, authorized, again, recorded, header, shipment}) {
        added.error == ""
        editor.error.includes("PERMISSION_DENIED")
        other.error.includes("RECORD_UNAVAILABLE")
        empty.error.includes("RETURN_EMPTY")
        authorized.error == ""
        authorized.result.resultCode == "AUTHORIZED"
        authorized.result.statusId == "ReturnApproved"
        shipment.shipmentTypeEnumId == "ShpTpPurchaseReturn"
        again.result.resultCode == "ALREADY_AUTHORIZED"
        recorded.result.resultCode == "RMA_RECORDED"
        header.supplierRmaId == "RMA-2"
        ids.mantleReplacementId == null
    }
})

feature("a replacement is an approved purchase order at no price with its expected receipt, at most what the item leaves", {
    when() {
        const notApproved = as("buyer", R + "create#ReplacementOrder", {operationKey: key(), returnId: ids.emptyReturnId})
        const reader = as("reader", R + "create#ReplacementOrder", {operationKey: key(), returnId: ids.returnId})
        const other = as("other", R + "create#ReplacementOrder", {operationKey: key(), returnId: ids.returnId})
        const itemSeq = rows("mantle.order.return.ReturnItem", {returnId: ids.returnId})[0].returnItemSeqId
        const tooMany = as("buyer", R + "create#ReplacementOrder", {
            operationKey: key(),
            returnId: ids.returnId,
            lineList: [{returnItemSeqId: itemSeq, quantity: 3}]
        })
        // the approval gate on: the replacement, at no price, is approved all the same
        svc("create#mantle.order.purchase.PurchasePolicy", {
            organizationPartyId: org,
            fromDate: Number(ec.user.nowTimestamp) - 1,
            approvalGateEnabled: "Y",
            changeReason: "Spec"
        })
        const operationKey = key()
        const created = as("buyer", R + "create#ReplacementOrder", {operationKey, returnId: ids.returnId})
        const retry = as("buyer", R + "create#ReplacementOrder", {operationKey, returnId: ids.returnId})
        const nothing = as("buyer", R + "create#ReplacementOrder", {operationKey: key(), returnId: ids.returnId})
        const orderId = created.result?.orderId
        return {
            notApproved,
            reader,
            other,
            tooMany,
            created,
            retry,
            nothing,
            part: orderId ? one("mantle.order.OrderPart", {orderId, orderPartSeqId: "01"}) : null,
            order: orderId ? one("mantle.order.OrderHeader", {orderId}) : null,
            lines: orderId ? rows("mantle.order.OrderItem", {orderId}) : [],
            item: one("mantle.order.return.ReturnItem", {returnId: ids.returnId, returnItemSeqId: itemSeq}),
            receipt: created.result?.shipmentId ? one("mantle.shipment.Shipment", {shipmentId: created.result.shipmentId}) : null
        }
    },
    then(r) {
        r.notApproved.error.includes("RETURN_NOT_APPROVED")
        r.reader.error.includes("PERMISSION_DENIED")
        r.other.error.includes("RECORD_UNAVAILABLE")
        r.tooMany.error.includes("QUANTITY_EXCEEDS_ELIGIBLE")
        r.created.error == ""
        r.created.result.resultCode == "CREATED"
        r.part.statusId == "OrderApproved"
        r.part.vendorPartyId == supplier
        r.part.customerPartyId == org
        r.lines.length == 1
        String(r.lines[0].quantity) == "2"
        r.lines[0].unitAmount.isZero()
        r.order.grandTotal.isZero()
        r.item.replacementOrderId == r.created.result.orderId
        String(r.item.replacedQuantity) == "2"
        r.receipt.shipmentTypeEnumId == "ShpTpPurchase"
        r.retry.result.alreadyApplied == true
        r.retry.result.orderId == r.created.result.orderId
        r.nothing.error.includes("NOTHING_TO_REPLACE")
    }
})

feature("released stock sent back unbilled leaves the bill match: a bill for the eight received holds, six eligible", {
    when() {
        // the earlier feature's approval gate off again: these orders are approved directly
        for (const row of rows("mantle.order.purchase.PurchasePolicy", {organizationPartyId: org}))
            svc("update#mantle.order.purchase.PurchasePolicy", {
                organizationPartyId: org,
                fromDate: row.fromDate,
                approvalGateEnabled: "N"
            })
        const source = received(8)
        const returned = sentBack(source, 2, "RrspCredit")
        const invoiceId = supplierBill(8)
        const whole = as("ap", M + "evaluate#InvoiceMatch", {invoiceId, allocationList: allocations(invoiceId, source, 8)})
        const applied = as("ap", M + "apply#InvoiceMatch", {invoiceId, allocationList: allocations(invoiceId, source, 6)})
        return {returned, whole, applied, holds: openHolds(invoiceId)}
    },
    then({returned, whole, applied, holds}) {
        returned.errors == ""
        whole.sourceRows[0].refusedReason == "QUANTITY_EXCESS"
        String(whole.sourceRows[0].supplierReturnedQuantity) == "2"
        String(whole.sourceRows[0].remainingQuantity) == "6"
        applied.error == ""
        applied.resultEnumId == "ImrException"
        holds.length == 1
    }
})

feature("a billed return credited and an unbilled return replaced leave their bills matched", {
    when() {
        // billed, then two sent back: the bill's match is stale and stays matched; the credit keeps it so
        const billed = received(8)
        const billId = supplierBill(8)
        const applied = as("ap", M + "apply#InvoiceMatch", {invoiceId: billId, allocationList: allocations(billId, billed, 8)})
        for (const statusId of ["InvoiceReceived", "InvoiceApproved"])
            if (one("mantle.account.invoice.Invoice", {invoiceId: billId}).statusId != statusId)
                svc("update#mantle.account.invoice.Invoice", {invoiceId: billId, statusId})
        const credited = sentBack(billed, 2, "RrspCredit")
        const staleAfterShip = appliedMatch(billId).staleDate
        svc(M + "run#MatchReevaluation", {})
        const afterShip = appliedMatch(billId)
        const preview = as("ap", R + "preview#ReturnSettlement", {returnId: credited.returnId})
        const settled = as("ap", R + "settle#Return", {
            returnId: credited.returnId,
            previewVersion: preview.previewVersion,
            operationKey: key()
        })
        svc(M + "run#MatchReevaluation", {})
        const afterCredit = appliedMatch(billId)
        // unbilled, two sent back and replaced: a bill for all eight matches again
        const replacedSource = received(8)
        const replaced = sentBack(replacedSource, 2, "RrspReplace")
        const laterBill = supplierBill(8)
        const before = as("ap", M + "evaluate#InvoiceMatch", {
            invoiceId: laterBill,
            allocationList: allocations(laterBill, replacedSource, 8)
        })
        const replacement = as("buyer", R + "create#ReplacementOrder", {operationKey: key(), returnId: replaced.returnId})
        const after = as("ap", M + "evaluate#InvoiceMatch", {
            invoiceId: laterBill,
            allocationList: allocations(laterBill, replacedSource, 8)
        })
        return {
            applied,
            credited,
            staleAfterShip,
            afterShip,
            settled,
            afterCredit,
            billHolds: openHolds(billId),
            replaced,
            before,
            replacement,
            after
        }
    },
    then(r) {
        r.applied.resultEnumId == "ImrMatched"
        r.credited.errors == ""
        r.staleAfterShip != null
        r.afterShip.staleDate == null
        r.afterShip.resultEnumId == "ImrMatched"
        r.settled.error == ""
        r.settled.resultCode == "SETTLED"
        r.afterCredit.resultEnumId == "ImrMatched"
        r.billHolds.length == 0
        r.replaced.errors == ""
        r.before.sourceRows[0].refusedReason == "QUANTITY_EXCESS"
        r.replacement.error == ""
        r.after.resultEnumId == "ImrMatched"
        String(r.after.sourceRows[0].supplierReturnedQuantity) == "0"
    }
})
