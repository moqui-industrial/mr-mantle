// Drop-ship (impl-purchasing P7; DropShip.js, F38–F40): a customer line reserved at a supplier's drop-ship facility makes a
// purchase order to the supplier when the sales order is approved, its parent the sales order, shipping to the customer and
// linked line by line, while a line reserved in the warehouse stays; with the approval gate off it is approved and emailed
// once the approval commits, with the gate on it waits at Placed for the approvers and goes out once approved; a line with no
// supplier price leaves its order Open and a supplier the buying policy blocks is passed over, the sales order approved
// either way; the supplier's confirmation
// (finalize#DropShipPurchaseOrder, PURCHASE_ORDER_EDIT in the buying organization) ships the order's own delivery and the
// sales shipment with the tracking code, invoices the customer once, moves the cost from Unreceived Inventory to the cost
// of goods sold, and a retry changes nothing; the supplier's bill matches against the delivery; "Drop-ship from supplier"
// moves a warehouse line to the supplier with its share of the order's promised payment and buys it. ORG_ZIZI_RETAIL (its ledger and ZIRET_WH) with a supplier, drop-ship
// facility, customer and products of the spec's own; a spec organization with the gate on. Run:
// ./moq test mr-mantle --spec DropShip
const prefix = "DROPSHIP_SPEC"
const org = "ORG_ZIZI_RETAIL",
    gateOrg = prefix + "_GATE_ORG",
    supplier = prefix + "_SUPPLIER",
    facility = prefix + "_FAC",
    blockedSupplier = prefix + "_BLOCKED",
    blockedFacility = prefix + "_BLOCKED_FAC",
    customer = prefix + "_CUSTOMER",
    address = prefix + "_ADDR",
    dropProduct = prefix + "_DROP",
    stockProduct = prefix + "_STOCK",
    plainProduct = prefix + "_PLAIN",
    unpricedProduct = prefix + "_UNPRICED",
    since = "2000-01-01T00:00:00Z"
const D = "mantle.order.DropShipServices.",
    O = "mantle.order.OrderServices."
const capture = ec.factory.getTool("MailCapture")
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const n = value => (value == null ? null : toDecimal(value).toNumber())
const state = {}

// a call as a user: its result with its error text ("" when it succeeds), in its own transaction (so the approval's
// commit sends the drop-ship order)
function run(username, service, parameters) {
    login(username)
    ec.artifactExecution.disableAuthz()
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(service).parameters(parameters).requireNewTransaction(true).call() || {}
        return Object.assign({}, out, {error: ec.message.hasError() ? ec.message.getErrorsString() : ""})
    } catch (error) {
        return {error: String(error.message || error)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}
function user(kind, permissions, organizationPartyId) {
    const id = prefix + "_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Drop-ship " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId: id, firstName: "Drop", lastName: kind})
    call("create#mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtAgent",
        fromPartyId: id,
        toPartyId: organizationPartyId,
        toRoleTypeId: "OrgInternal",
        fromDate: since
    })
    call("create#moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId: id,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA"
    })
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: since})
    return id
}
function product(productId, price, canDropShip) {
    call("create#mantle.product.Product", {
        productId,
        productName: productId,
        productTypeEnumId: "PtAsset",
        assetTypeEnumId: "AstTpInventory",
        amountUomId: "OTH_ea",
        ownerPartyId: org
    })
    if (price == null) return
    call("create#mantle.product.ProductPrice", {
        productId,
        vendorPartyId: supplier,
        pricePurposeEnumId: "PppPurchase",
        priceTypeEnumId: "PptCurrent",
        fromDate: since,
        minQuantity: 1,
        price,
        priceUomId: "USD",
        canDropShip: canDropShip ? "Y" : "N"
    })
}
// a sales order of the organization to the customer: its lines as [productId, quantity, facilityId], one part per facility,
// placed and approved by john.doe in its own transaction
function salesOrder(organizationPartyId, lines, approve = true) {
    login("john.doe")
    const created = call(O + "create#Order", {
        vendorPartyId: organizationPartyId,
        customerPartyId: customer,
        currencyUomId: "USD"
    })
    const orderId = created.orderId
    const parts = {}
    for (const [productId, quantity, facilityId] of lines) {
        if (!parts[facilityId]) {
            parts[facilityId] = Object.keys(parts).length
                ? call(O + "create#OrderPart", {
                      orderId,
                      vendorPartyId: organizationPartyId,
                      customerPartyId: customer,
                      facilityId
                  }).orderPartSeqId
                : created.orderPartSeqId
            if (!Object.keys(parts).indexOf(facilityId))
                call("update#mantle.order.OrderPart", {orderId, orderPartSeqId: parts[facilityId], facilityId})
            call(O + "set#OrderBillingShippingInfo", {
                orderId,
                orderPartSeqId: parts[facilityId],
                shippingPostalContactMechId: address,
                carrierPartyId: "_NA_",
                shipmentMethodEnumId: "ShMthGround"
            })
        }
        call(O + "add#OrderProductQuantity", {orderId, orderPartSeqId: parts[facilityId], productId, quantity, unitAmount: 20})
    }
    const placed = run("john.doe", O + "place#Order", {orderId})
    const approved = approve ? run("john.doe", O + "approve#Order", {orderId}) : {error: ""}
    return {orderId, parts, error: placed.error + approved.error}
}
const purchaseOrdersOf = salesOrderId => rows("mantle.order.OrderHeader", {parentOrderId: salesOrderId})
// the drop-ship orders are made once the sales approval commits, on a worker: wait for them
function purchaseOrdersAfter(salesOrderId, count = 1) {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && purchaseOrdersOf(salesOrderId).length < count) ec.factory.waitWorkerPoolEmpty(50)
    ec.factory.waitWorkerPoolEmpty(50)
    return purchaseOrdersOf(salesOrderId)
}
const lineOf = (salesOrderId, orderItemSeqId) =>
    rows("mantle.order.OrderItem", {salesOrderId, salesOrderItemSeqId: orderItemSeqId})[0]
const itemSeq = (orderId, productId) => rows("mantle.order.OrderItem", {orderId, productId})[0]?.orderItemSeqId
const statusOf = orderId => one("mantle.order.OrderHeader", {orderId}).statusId
// the drop-ship send runs once the approval commits, on a worker of its own: wait, a little at a time, for the order's status
function statusAfterSend(orderId, statusId = "OrderSent") {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && statusOf(orderId) !== statusId) ec.factory.waitWorkerPoolEmpty(50)
    return statusOf(orderId)
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        for (const [partyId, name, roleTypeId] of [
            [gateOrg, "Drop-ship Gate Org", "OrgInternal"],
            [supplier, "Drop-ship Supplier", "Supplier"],
            [blockedSupplier, "Drop-ship Blocked Supplier", "Supplier"],
            [prefix + "_GATE_SUPPLIER", "Drop-ship Gate Org's Supplier", "Supplier"],
            [customer, "Drop-ship Customer", "Customer"]
        ]) {
            call("create#mantle.party.Party", {
                partyId,
                partyTypeEnumId: "PtyOrganization",
                ownerPartyId: [supplier, blockedSupplier].includes(partyId)
                    ? "_NA_"
                    : partyId === prefix + "_GATE_SUPPLIER"
                      ? gateOrg
                      : null
            })
            call("create#mantle.party.Organization", {partyId, organizationName: name})
            call("create#mantle.party.PartyRole", {partyId, roleTypeId})
        }
        call("create#mantle.party.contact.ContactMech", {contactMechId: address, contactMechTypeEnumId: "CmtPostalAddress"})
        call("create#mantle.party.contact.PostalAddress", {
            contactMechId: address,
            toName: "Dana Customer",
            address1: "12 Harbor Road",
            city: "Portland",
            postalCode: "97201",
            countryGeoId: "USA"
        })
        call("create#mantle.party.contact.PartyContactMech", {
            partyId: customer,
            contactMechId: address,
            contactMechPurposeId: "PostalShippingDest",
            fromDate: since
        })
        call("create#mantle.party.contact.ContactMech", {
            contactMechId: prefix + "_EMAIL",
            contactMechTypeEnumId: "CmtEmailAddress",
            infoString: "orders@dropship-spec.example.com"
        })
        call("create#mantle.party.contact.PartyContactMech", {
            partyId: supplier,
            contactMechId: prefix + "_EMAIL",
            contactMechPurposeId: "EmailOrder",
            fromDate: since
        })
        call("create#mantle.facility.Facility", {
            facilityId: facility,
            facilityTypeEnumId: "FcTpDropShip",
            ownerPartyId: supplier,
            facilityName: "Drop-ship Supplier direct",
            assetAllowOtherOwner: "Y",
            assetAllowIssueOverQoh: "Y"
        })
        call("create#mantle.facility.Facility", {
            facilityId: blockedFacility,
            facilityTypeEnumId: "FcTpDropShip",
            ownerPartyId: blockedSupplier,
            facilityName: "Drop-ship Blocked Supplier direct",
            assetAllowOtherOwner: "Y",
            assetAllowIssueOverQoh: "Y"
        })
        call("create#mantle.party.supplier.SupplierProfile", {
            organizationPartyId: org,
            supplierPartyId: blockedSupplier,
            fromDate: since,
            purchaseBlockFromDate: since,
            purchaseBlockReason: "Quality hold"
        })
        product(dropProduct, 6, true)
        // rows the order's price rule passes over: another currency and a store's price
        for (const [price, fields] of [
            [1, {priceUomId: "EUR"}],
            [2, {productStoreId: "POPC_DEFAULT"}]
        ])
            call(
                "create#mantle.product.ProductPrice",
                Object.assign(
                    {
                        productId: dropProduct,
                        vendorPartyId: supplier,
                        pricePurposeEnumId: "PppPurchase",
                        priceTypeEnumId: "PptCurrent",
                        fromDate: since,
                        minQuantity: 1,
                        price,
                        priceUomId: "USD",
                        canDropShip: "Y"
                    },
                    fields
                )
            )
        product(unpricedProduct, null)
        product(stockProduct, 5, true)
        product(plainProduct, 4, false)
        call("create#mantle.order.purchase.PurchasePolicy", {
            organizationPartyId: gateOrg,
            fromDate: since,
            approvalGateEnabled: "Y",
            changeReason: "Spec"
        })
        // the purchase order email on a server of the spec's own: the capture keeps what is sent
        call("create#moqui.basic.email.EmailServer", {
            emailServerId: prefix + "_SMTP",
            smtpHost: "127.0.0.1",
            smtpPort: "9",
            smtpStartTls: "N",
            smtpSsl: "N"
        })
        const template = one("moqui.basic.email.EmailTemplate", {emailTemplateId: "MANTLE_PURCHASE_ORDER_EMAIL"})
        state.template = {emailServerId: template.emailServerId, fromAddress: template.fromAddress}
        call("update#moqui.basic.email.EmailTemplate", {
            emailTemplateId: "MANTLE_PURCHASE_ORDER_EMAIL",
            emailServerId: prefix + "_SMTP",
            fromAddress: "buying@dropship-spec.example.com"
        })
        state.buyer = user("BUYER", ["PURCHASE_ORDER_EDIT"], org)
        state.none = user("NONE", ["PURCHASE_APPROVE"], org)
        state.gateApprover = user("GATE_APPROVER", ["PURCHASE_APPROVE", "PURCHASE_ORDER_APPROVE"], gateOrg)
        state.gateBuyer = user("GATE_BUYER", ["PURCHASE_ORDER_EDIT"], gateOrg)
        capture.enable()
    },
    cleanupSpec() {
        capture.reset()
        ec.message.clearErrors()
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        if (state.template)
            call(
                "update#moqui.basic.email.EmailTemplate",
                Object.assign({emailTemplateId: "MANTLE_PURCHASE_ORDER_EMAIL"}, state.template)
            )
    }
})

feature(
    "a line reserved at the drop-ship facility makes an approved purchase order to the supplier on the sales order's approval, shipping to the customer and emailed; the warehouse line stays; a retry answers the same order",
    {
        when() {
            capture.clear()
            const sales = salesOrder(org, [
                [dropProduct, 2, facility],
                [stockProduct, 3, "ZIRET_WH"]
            ])
            state.sales = sales
            const purchaseOrders = purchaseOrdersAfter(sales.orderId)
            const po = purchaseOrders[0]
            state.poId = po?.orderId
            const part = po ? one("mantle.order.OrderPart", {orderId: po.orderId, orderPartSeqId: "01"}) : null
            const dropSeq = itemSeq(sales.orderId, dropProduct)
            const line = lineOf(sales.orderId, dropSeq)
            const stockLine = lineOf(sales.orderId, itemSeq(sales.orderId, stockProduct))
            const shipTo = po ? rows("mantle.order.OrderPartParty", {orderId: po.orderId, roleTypeId: "CustomerShipTo"}) : []
            const retry = run("john.doe", O + "create#DropShipPurchaseOrder", {salesOrderId: sales.orderId})
            const status = po ? statusAfterSend(po.orderId) : null
            const mails = capture.count()
            const message = capture.last()
            const print = po ? run(state.buyer, O + "get#PurchaseOrderPrint", {orderId: po.orderId}) : {}
            return {sales, purchaseOrders, po, part, line, stockLine, shipTo, retry, mails, message, print, status}
        },
        then({sales, purchaseOrders, po, part, line, stockLine, shipTo, retry, mails, message, print, status}) {
            sales.error == ""
            purchaseOrders.length == 1
            po.parentOrderId == sales.orderId
            part.vendorPartyId == supplier
            part.customerPartyId == org
            part.facilityId == facility
            part.postalContactMechId == address
            shipTo.length == 1 && shipTo[0].partyId == customer
            line.productId == dropProduct
            n(line.quantity) == 2
            n(line.unitAmount) == 6
            stockLine == null
            retry.error == ""
            retry.createdOrderIds.length == 0
            retry.purchaseOrderIds.includes(po.orderId)
            status == "OrderSent"
            mails >= 1
            message.toList.includes("orders@dropship-spec.example.com")
            message.attachmentNames.some(name => name.endsWith(".pdf"))
            print.error == ""
            print.printHtml.includes("Drop-ship to")
            print.printHtml.includes("12 Harbor Road")
            !print.printHtml.includes("Deliver to")
        }
    }
)

feature(
    "confirming delivery ships the purchase order's delivery and the sales shipment with the tracking code, invoices the customer once, moves the cost to COGS and completes the order; a retry changes nothing; a user without PURCHASE_ORDER_EDIT or of another organization is refused",
    {
        when() {
            const poId = state.poId
            const confirm = {purchaseOrderId: poId, trackingCode: "1ZDROPSHIP01"}
            const noPermission = run(state.none, O + "finalize#DropShipPurchaseOrder", confirm)
            const otherOrg = run(state.gateBuyer, O + "finalize#DropShipPurchaseOrder", confirm)
            const done = run(state.buyer, O + "finalize#DropShipPurchaseOrder", confirm)
            const retry = run(state.buyer, O + "finalize#DropShipPurchaseOrder", confirm)
            const delivery = one("mantle.shipment.Shipment", {shipmentId: done.shipmentId})
            const deliverySources = rows("mantle.shipment.ShipmentItemSource", {shipmentId: done.shipmentId})
            const salesShipmentId = (done.salesShipmentIds || [])[0]
            const salesShipment = salesShipmentId ? one("mantle.shipment.Shipment", {shipmentId: salesShipmentId}) : null
            const tracking = salesShipmentId
                ? rows("mantle.shipment.ShipmentPackageRouteSeg", {shipmentId: salesShipmentId}).map(row => row.trackingCode)
                : []
            const deliveryTracking = rows("mantle.shipment.ShipmentPackageRouteSeg", {shipmentId: done.shipmentId}).map(
                row => row.trackingCode
            )
            const dropSeq = itemSeq(state.sales.orderId, dropProduct)
            const billings = rows("mantle.order.OrderItemBilling", {orderId: state.sales.orderId, orderItemSeqId: dropSeq})
            const issuances = rows("mantle.product.issuance.AssetIssuance", {
                orderId: state.sales.orderId,
                orderItemSeqId: dropSeq
            })
            const trans = rows("mantle.ledger.transaction.AcctgTrans", {
                shipmentId: done.shipmentId,
                acctgTransTypeEnumId: "AttDropShipDelivery"
            })
            const entries = trans.length
                ? rows("mantle.ledger.transaction.AcctgTransEntry", {acctgTransId: trans[0].acctgTransId})
                : []
            const debit = entries.find(row => row.debitCreditFlag === "D")
            const credit = entries.find(row => row.debitCreditFlag === "C")
            const accountType = glAccountId => one("mantle.ledger.account.GlAccount", {glAccountId})?.glAccountTypeEnumId
            const warehouseStock = rows("mantle.product.asset.Asset", {productId: dropProduct, facilityId: "ZIRET_WH"})
            return {
                noPermission,
                otherOrg,
                done,
                retry,
                delivery,
                deliverySources,
                salesShipment,
                tracking,
                deliveryTracking,
                billings,
                issuances,
                trans,
                debit,
                credit,
                debitType: debit ? accountType(debit.glAccountId) : null,
                creditType: credit ? accountType(credit.glAccountId) : null,
                warehouseStock,
                poStatus: statusOf(state.poId),
                shipmentsAfter: rows("mantle.shipment.ShipmentItemSource", {orderId: state.poId}).length
            }
        },
        then(r) {
            r.noPermission.error.includes("PERMISSION_DENIED")
            r.otherOrg.error.includes("RECORD_UNAVAILABLE")
            r.done.error == ""
            r.done.alreadyApplied == false
            r.delivery.shipmentTypeEnumId == "ShpTpPurchase"
            r.delivery.statusId == "ShipShipped"
            r.deliverySources.length == 1 && n(r.deliverySources[0].quantity) == 2
            r.deliveryTracking.includes("1ZDROPSHIP01")
            r.salesShipment.statusId == "ShipShipped"
            r.tracking.includes("1ZDROPSHIP01")
            r.billings.length == 1
            n(r.billings[0].quantity) == 2
            r.issuances.length == 1
            r.issuances[0].acctgTransResultEnumId == "AtrNoAcquireCost"
            r.trans.length == 1
            r.trans[0].isPosted == "Y"
            n(r.debit.amount) == 12
            n(r.credit.amount) == 12
            r.debitType == "GatCogs"
            r.creditType == "GatUnreceivedInventory"
            r.warehouseStock.length == 0
            r.poStatus == "OrderCompleted"
            r.retry.error == ""
            r.retry.alreadyApplied == true
            r.shipmentsAfter == 1
            rows("mantle.order.OrderItemBilling", {orderId: state.sales.orderId}).length == 1
        }
    }
)

feature("the supplier's bill for the drop-ship order matches against the confirmed delivery", {
    when() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const invoiceId = call("mantle.account.InvoiceServices.import#Bill", {
            organizationPartyId: org,
            supplierPartyId: supplier,
            referenceNumber: prefix + "-BILL-1"
        }).invoiceId
        call("mantle.account.InvoiceServices.create#InvoiceItem", {
            invoiceId,
            itemTypeEnumId: "ItemProduct",
            productId: dropProduct,
            quantity: 2,
            amount: 6
        })
        const evaluated = run("john.doe", "mantle.account.InvoiceMatchServices.evaluate#InvoiceMatch", {invoiceId})
        return {evaluated}
    },
    then({evaluated}) {
        evaluated.error == ""
        evaluated.resultEnumId == "ImrMatched"
        evaluated.sourceRows.some(row => row.orderId == state.poId && n(row.quantity) == 2)
    }
})

feature(
    "with the approval gate on the drop-ship order waits at Placed for the approvers and goes out once an approver decides it",
    {
        when() {
            capture.clear()
            const sales = salesOrder(gateOrg, [[dropProduct, 1, facility]])
            const po = purchaseOrdersAfter(sales.orderId)[0]
            ec.factory.waitWorkerPoolEmpty(50)
            const placed = po ? statusOf(po.orderId) : null
            const notices = po
                ? rows("moqui.security.user.NotificationMessage", {topic: "PurchaseOrderApproval", recordId: po.orderId})
                : []
            const mailsBefore = capture.count()
            const decided = run(state.gateApprover, "mantle.order.PurchaseServices.decide#PurchaseApproval", {
                orderId: po?.orderId,
                operationKey: prefix + "-GATE-1"
            })
            const after = po ? statusAfterSend(po.orderId) : null
            return {sales, placed, notices, mailsBefore, decided, after, mailsAfter: capture.count()}
        },
        then({sales, placed, notices, mailsBefore, decided, after, mailsAfter}) {
            sales.error == ""
            placed == "OrderPlaced"
            notices.length >= 1
            mailsBefore == 0
            decided.error == ""
            after == "OrderSent"
            mailsAfter >= 1
        }
    }
)

feature(
    "the sales order approves while its drop-ship lines wait: a line with no supplier price leaves its order Open, unsent, and a line at a supplier the buying policy blocks is passed over and named",
    {
        when() {
            capture.clear()
            const sales = salesOrder(org, [
                [unpricedProduct, 1, facility],
                [dropProduct, 1, blockedFacility]
            ])
            const purchaseOrders = purchaseOrdersAfter(sales.orderId)
            const po = purchaseOrders[0]
            const line = po ? lineOf(sales.orderId, itemSeq(sales.orderId, unpricedProduct)) : null
            const retry = run("john.doe", O + "create#DropShipPurchaseOrder", {salesOrderId: sales.orderId})
            return {sales, purchaseOrders, po, line, retry, status: statusOf(sales.orderId), mails: capture.count()}
        },
        then({sales, purchaseOrders, po, line, retry, status, mails}) {
            sales.error == ""
            status == "OrderApproved"
            purchaseOrders.length == 1
            statusOf(po.orderId) == "OrderOpen"
            n(line.unitAmount) == 0
            mails == 0
            retry.createdOrderIds.length == 0
            retry.skippedItems.length == 1
            retry.skippedItems[0].reasonCode == "SUPPLIER_BLOCKED"
            retry.skippedItems[0].productId == dropProduct
        }
    }
)

feature(
    "Drop-ship from supplier moves a warehouse line of an approved order to the supplier with its share of the promised payment and buys it; a product without a drop-ship price, a line already dropped and a user without PURCHASE_ORDER_EDIT are refused; the setup of another organization's supplier is refused",
    {
        when() {
            const sales = salesOrder(org, [
                [stockProduct, 4, "ZIRET_WH"],
                [plainProduct, 1, "ZIRET_WH"]
            ])
            const stockSeq = itemSeq(sales.orderId, stockProduct)
            const plainSeq = itemSeq(sales.orderId, plainProduct)
            login("john.doe")
            ec.artifactExecution.disableAuthz()
            call(O + "add#OrderPartPayment", {
                orderId: sales.orderId,
                orderPartSeqId: "01",
                paymentInstrumentEnumId: "PiCompanyCheck",
                statusId: "PmntPromised"
            })
            const route = {orderId: sales.orderId, orderItemSeqId: stockSeq, supplierPartyId: supplier}
            const noPermission = run(state.none, D + "route#OrderItemToDropShip", route)
            const routed = run(state.buyer, D + "route#OrderItemToDropShip", route)
            const again = run(state.buyer, D + "route#OrderItemToDropShip", route)
            const plain = run(state.buyer, D + "route#OrderItemToDropShip", Object.assign({}, route, {orderItemSeqId: plainSeq}))
            const item = one("mantle.order.OrderItem", {orderId: sales.orderId, orderItemSeqId: stockSeq})
            const part = one("mantle.order.OrderPart", {orderId: sales.orderId, orderPartSeqId: item.orderPartSeqId})
            const reservations = rows("mantle.product.issuance.AssetReservation", {
                orderId: sales.orderId,
                orderItemSeqId: stockSeq
            })
            const reservedAt = reservations.map(row => one("mantle.product.asset.Asset", {assetId: row.assetId}).facilityId)
            const line = lineOf(sales.orderId, stockSeq)
            const view = run(state.buyer, D + "get#OrderDropShip", {orderId: sales.orderId})
            const payments = rows("mantle.account.payment.Payment", {orderId: sales.orderId})
            const setup = run(state.buyer, D + "get#DropShipSetup", {supplierPartyId: supplier})
            const otherSetup = run(state.buyer, D + "get#DropShipSetup", {supplierPartyId: prefix + "_GATE_SUPPLIER"})
            return {
                setup,
                otherSetup,
                payments,
                grandTotal: n(one("mantle.order.OrderHeader", {orderId: sales.orderId}).grandTotal),
                sales,
                noPermission,
                routed,
                again,
                plain,
                part,
                reservedAt,
                line,
                view,
                plainPart: one("mantle.order.OrderItem", {orderId: sales.orderId, orderItemSeqId: plainSeq}).orderPartSeqId
            }
        },
        then({
            sales,
            noPermission,
            routed,
            again,
            plain,
            part,
            reservedAt,
            line,
            view,
            plainPart,
            payments,
            grandTotal,
            setup,
            otherSetup
        }) {
            sales.error == ""
            noPermission.error.includes("PERMISSION_DENIED")
            routed.error == ""
            part.facilityId == facility
            part.orderPartSeqId != plainPart
            reservedAt.length >= 1 && reservedAt.every(facilityId => facilityId == facility)
            line.productId == stockProduct
            n(line.quantity) == 4
            routed.purchaseOrderIds.includes(line.orderId)
            again.error.includes("ALREADY_DROP_SHIPPED")
            plain.error.includes("NOT_DROP_SHIPPABLE")
            view.dropShip.kind == "sales"
            view.dropShip.lines.some(row => row.purchaseOrderId == line.orderId && row.state == "ordered")
            payments.length == 2
            payments.some(row => row.orderPartSeqId == part.orderPartSeqId && n(row.amount) == n(part.partTotal))
            payments.reduce((sum, row) => sum + n(row.amount), 0) == grandTotal
            setup.facilities.some(row => row.facilityId == facility)
            otherSetup.error.includes("SUPPLIER_UNAVAILABLE")
        }
    }
)
