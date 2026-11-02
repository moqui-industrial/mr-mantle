// Payables: the supplier profile's finance fields, bill intake keyed by the supplier's reference, a bill from its order on
// the supplier's term, holds that stop approval and payment, the receipt billing rule for self-billing suppliers and the
// cost center a bill line posts to. Standalone: spec-local organization, suppliers and users.
const helper = () => ec.resource.script("component://mr-mantle/test/ledger/AccountingReceivablesFixtures.js")
const svc = (name, p) => helper().call(name, p)
const native = (name, p) => helper().call("mantle.account.InvoiceServices." + name, p)
const refused = (name, p) => helper().rejected(name, p)
const one = (entity, key) => helper().lib.one(entity, key)
const rows = (entity, key) => helper().lib.rows(entity, key)
const prefix = "NATIVE_AP"
const org = prefix + "_ORG",
    supplier = prefix + "_SUPPLIER",
    selfBilled = prefix + "_SELF",
    facility = prefix + "_WH",
    term = prefix + "_NET45"
const users = {}
let billId, heldId

function party(partyId, name, roleTypeId) {
    svc("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
    svc("create#mantle.party.Organization", {partyId, organizationName: name})
    svc("create#mantle.party.PartyRole", {partyId, roleTypeId})
}
function user(kind, permissions) {
    const id = prefix + "_" + kind.toUpperCase()
    users[kind] = id
    svc("create#moqui.security.UserGroup", {userGroupId: id, description: "Payables " + kind})
    for (const permission of permissions)
        svc("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: 0})
    svc("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    svc("create#moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId: id,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        timeZone: ec.user.userAccount?.timeZone || "America/Chicago"
    })
    svc("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: 0})
    svc("create#mantle.party.PartyRelationship", {
        partyRelationshipId: id,
        fromPartyId: id,
        toPartyId: org,
        relationshipTypeEnumId: "PrtAgent",
        fromDate: 0
    })
}
// A purchase order of DEMO_1_1 with a freight line, approved; with receive it is shipped, received with two units rejected
// and delivered, which runs the receipt billing SECA.
function purchase(vendorPartyId, receive, accepted = 8, rejected = 2) {
    const order = svc("mantle.order.OrderServices.create#Order", {
        customerPartyId: org,
        vendorPartyId,
        currencyUomId: "USD",
        facilityId: facility
    })
    svc("mantle.order.OrderServices.add#OrderProductQuantity", {
        orderId: order.orderId,
        orderPartSeqId: order.orderPartSeqId,
        productId: "DEMO_1_1",
        quantity: 10,
        unitAmount: 5,
        itemTypeEnumId: "ItemInventory"
    })
    svc("mantle.order.OrderServices.create#OrderItem", {
        orderId: order.orderId,
        orderPartSeqId: order.orderPartSeqId,
        unitAmount: 20,
        itemTypeEnumId: "ItemShipping",
        itemDescription: "Incoming freight"
    })
    svc("mantle.order.OrderServices.place#Order", {orderId: order.orderId})
    svc("mantle.order.OrderServices.approve#Order", {orderId: order.orderId})
    if (!receive) return {orderId: order.orderId}
    return {orderId: order.orderId, shipmentId: deliver(order.orderId, accepted, rejected)}
}
// A delivery of the order's DEMO_1_1: a shipment of the quantity received (accepted and rejected), shipped, received and
// delivered, which runs the receipt billing SECA.
function deliver(orderId, accepted, rejected) {
    const shipment = svc("mantle.shipment.ShipmentServices.create#OrderPartShipment", {
        orderId,
        orderPartSeqId: "01",
        destinationFacilityId: facility
    })
    const quantity = accepted + rejected
    for (const source of rows("mantle.shipment.ShipmentItemSource", {shipmentId: shipment.shipmentId}))
        svc("update#mantle.shipment.ShipmentItemSource", {
            shipmentItemSourceId: source.shipmentItemSourceId,
            quantity,
            quantityNotHandled: quantity
        })
    svc("update#mantle.shipment.ShipmentItem", {shipmentId: shipment.shipmentId, productId: "DEMO_1_1", quantity})
    svc("mantle.shipment.ShipmentServices.ship#Shipment", {shipmentId: shipment.shipmentId})
    svc("mantle.shipment.ShipmentServices.receive#ShipmentProduct", {
        shipmentId: shipment.shipmentId,
        productId: "DEMO_1_1",
        quantityAccepted: accepted,
        quantityRejected: rejected,
        facilityId: facility
    })
    svc("mantle.shipment.ShipmentServices.deliver#Shipment", {shipmentId: shipment.shipmentId})
    return shipment.shipmentId
}
function shipmentBills(shipmentId) {
    return [
        ...new Set(
            rows("mantle.shipment.ShipmentItemSource", {shipmentId})
                .map(row => row.invoiceId)
                .filter(Boolean)
        )
    ]
}
function selfBilledUpload(shipmentId) {
    login(users.ap)
    return native("import#Bill", {organizationPartyId: org, supplierPartyId: selfBilled, shipmentId, referenceNumber: "SELF-1"})
}
function bill(reference, amount = "100") {
    login(users.ap)
    return native("import#Bill", {organizationPartyId: org, supplierPartyId: supplier, referenceNumber: reference, amount})
}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        party(org, "Payables organization", "OrgInternal")
        svc("mantle.ledger.LedgerServices.init#PartyAccountingConfiguration", {
            organizationPartyId: org,
            sourcePartyId: "DefaultSettings",
            baseCurrencyUomId: "USD"
        })
        svc("mantle.ledger.LedgerServices.get#OrganizationFiscalTimePeriods", {
            organizationPartyId: org,
            filterDate: ec.user.nowTimestamp
        })
        party(supplier, "Payables supplier", "Supplier")
        party(selfBilled, "Self-billed supplier", "Supplier")
        svc("create#mantle.facility.Facility", {facilityId: facility, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: org})
        svc("create#mantle.account.invoice.SettlementTerm", {
            settlementTermId: term,
            description: "Net 45",
            termTypeEnumId: "TtFinPaymentDays",
            termValue: 45
        })
        user("ap", ["PAYABLE_EDIT", "PAYABLE_VIEW", "PAYABLE_IMPORT", "INVOICE_HOLD", "SUPPLIER_TERMS_EDIT"])
        user("intake", ["PAYABLE_EDIT", "PAYABLE_VIEW"])
        user("approver", ["ACCOUNTING_VIEW", "INVOICE_APPROVE", "INVOICE_HOLD_RELEASE"])
        user("holder", ["PAYABLE_VIEW", "INVOICE_HOLD", "INVOICE_HOLD_RELEASE", "INVOICE_APPROVE"])
        user("ar", ["RECEIVABLE_EDIT", "RECEIVABLE_VIEW"])
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        login("john.doe")
    }
})

feature("AP sets a supplier's term and self-billing as dated rows; a user without the terms permission is refused", {
    when() {
        const request = {organizationPartyId: org, supplierPartyId: supplier, settlementTermId: term, changeReason: "Agreed"}
        login(users.intake)
        const denied = refused("mantle.party.SupplierServices.store#SupplierProfile", request)
        login(users.ap)
        const first = svc("mantle.party.SupplierServices.store#SupplierProfile", request)
        const same = svc("mantle.party.SupplierServices.store#SupplierProfile", request)
        const selfBilling = svc("mantle.party.SupplierServices.store#SupplierProfile", {
            organizationPartyId: org,
            supplierPartyId: selfBilled,
            selfBillingIndicator: "Y",
            fromDate: new Date(Number(ec.user.nowTimestamp) - 60000)
        })
        login(users.approver)
        const finance = svc("mantle.party.SupplierServices.get#SupplierFinance", {
            organizationPartyId: org,
            supplierPartyId: selfBilled
        }).profile
        return {denied, first, same, selfBilling, finance}
    },
    then({denied, first, same, selfBilling, finance}) {
        denied.includes("PERMISSION_DENIED")
        first.changed == true
        same.changed == false
        same.supplierProfileId == first.supplierProfileId
        selfBilling.changed == true
        finance.selfBillingIndicator == "Y"
    }
})

feature("a second upload with the same supplier reference is refused, naming the first", {
    when() {
        const first = bill("SUP-1001")
        const again = refused("mantle.account.InvoiceServices.import#Bill", {
            organizationPartyId: org,
            supplierPartyId: supplier,
            referenceNumber: "SUP-1001",
            amount: "100"
        })
        login(users.intake)
        const noImport = refused("mantle.account.InvoiceServices.import#Bill", {
            organizationPartyId: org,
            supplierPartyId: supplier,
            referenceNumber: "SUP-1002",
            amount: "100"
        })
        billId = first.invoiceId
        return {first, again, noImport, saved: one("mantle.account.invoice.Invoice", {invoiceId: first.invoiceId})}
    },
    then({first, again, noImport, saved}) {
        first.attached == false
        again.includes("BILL_DUPLICATE")
        again.includes(first.invoiceId)
        noImport.includes("PERMISSION_DENIED")
        saved.statusId == "InvoiceIncoming"
        saved.settlementTermId == term
    }
})

feature("a bill from its purchase order takes the supplier's term and its line's cost center; a second is refused", {
    when() {
        login("john.doe")
        const po = purchase(supplier, false)
        helper().call("update#mantle.order.OrderItem", {orderId: po.orderId, orderItemSeqId: "01", costCenterId: org})
        login(users.ap)
        const made = native("create#InvoiceFromSource", {orderId: po.orderId, organizationPartyId: org})
        const again = refused("mantle.account.InvoiceServices.create#InvoiceFromSource", {orderId: po.orderId})
        login(users.ar)
        const wrongSide = refused("mantle.account.InvoiceServices.create#InvoiceFromSource", {orderId: po.orderId})
        const invoice = one("mantle.account.invoice.Invoice", {invoiceId: made.invoiceId})
        login(users.approver)
        const approved = native("approve#Payable", {invoiceId: made.invoiceId, lastUpdatedStamp: invoice.lastUpdatedStamp})
        const transactions = rows("mantle.ledger.transaction.AcctgTrans", {invoiceId: made.invoiceId})
        const entries = transactions.flatMap(tx =>
            rows("mantle.ledger.transaction.AcctgTransEntry", {acctgTransId: tx.acctgTransId, invoiceItemSeqId: "01"})
        )
        return {made, again, wrongSide, invoice, approved, entries}
    },
    then({made, again, wrongSide, invoice, approved, entries}) {
        invoice.settlementTermId == term
        invoice.dueDate != null
        Number(invoice.dueDate) - Number(invoice.invoiceDate) > 44 * 86400000
        again.includes("SOURCE_ALREADY_INVOICED")
        again.includes(made.invoiceId)
        wrongSide.includes("PERMISSION_DENIED")
        approved.statusId == "InvoiceApproved"
        entries.length > 0
        entries.every(entry => entry.costCenterId == org)
    }
})

feature("a held bill cannot be approved or paid, and a payment that names it stays unapplied", {
    when() {
        // a draft bill on hold is not approved
        heldId = bill("SUP-2001", "80").invoiceId
        const hold = native("hold#Invoice", {invoiceId: heldId, holdReasonEnumId: "IhrSupplierDispute", holdComment: "Short"})
        const twice = refused("mantle.account.InvoiceServices.hold#Invoice", {
            invoiceId: heldId,
            holdReasonEnumId: "IhrSupplierDispute"
        })
        const invoice = one("mantle.account.invoice.Invoice", {invoiceId: heldId})
        login(users.approver)
        const approve = refused("mantle.account.InvoiceServices.approve#Payable", {
            invoiceId: heldId,
            lastUpdatedStamp: invoice.lastUpdatedStamp
        })
        const change = refused("mantle.account.InvoiceServices.change#InvoiceState", {
            invoiceId: heldId,
            action: "approve",
            lastUpdatedStamp: invoice.lastUpdatedStamp
        })
        // an approved bill put on hold is not paid
        const approvedId = bill("SUP-2002", "60").invoiceId
        login(users.approver)
        native("approve#Payable", {
            invoiceId: approvedId,
            lastUpdatedStamp: one("mantle.account.invoice.Invoice", {invoiceId: approvedId}).lastUpdatedStamp
        })
        login(users.ap)
        native("hold#Invoice", {invoiceId: approvedId, holdReasonEnumId: "IhrBankChange"})
        login("john.doe")
        const pay = refused("mantle.account.PaymentServices.create#InvoicePayment", {invoiceId: approvedId, amount: "60"})
        // a delivered payment that names the bill: the SECA leaves it unapplied
        const payment = svc("mantle.account.PaymentServices.create#Payment", {
            fromPartyId: org,
            toPartyId: supplier,
            amount: "60",
            amountUomId: "USD",
            forInvoiceId: approvedId,
            paymentTypeEnumId: "PtInvoicePayment",
            paymentInstrumentEnumId: "PiCompanyCheck",
            statusId: "PmntPromised",
            effectiveDate: ec.user.nowTimestamp
        })
        svc("mantle.account.PaymentServices.update#Payment", {paymentId: payment.paymentId, statusId: "PmntDelivered"})
        const applied = rows("mantle.account.payment.PaymentApplication", {paymentId: payment.paymentId})
        const direct = refused("mantle.account.PaymentServices.apply#InvoicePayment", {
            paymentId: payment.paymentId,
            invoiceId: approvedId
        })
        const listed = native("find#Payables", {organizationPartyId: org, queue: "held"}).records
        return {hold, twice, approve, change, pay, applied, direct, listed, approvedId}
    },
    then({hold, twice, approve, change, pay, applied, direct, listed, approvedId}) {
        hold.invoiceHoldId != null
        twice.includes("HOLD_EXISTS")
        approve.includes("INVOICE_HELD")
        change.includes("INVOICE_HELD")
        pay.includes("INVOICE_HELD")
        applied.length == 0
        direct.includes("INVOICE_HELD")
        listed.some(row => row.invoiceId == heldId && row.isHeld && row.holdText == "Supplier dispute")
        listed.some(row => row.invoiceId == approvedId && row.holdText == "Bank detail change")
    }
})

feature("the placer cannot release a hold; a release asked for notifies, and an approver's release is recorded", {
    when() {
        login(users.holder)
        const own = native("hold#Invoice", {invoiceId: billId, holdReasonEnumId: "IhrApReview"})
        const selfRelease = refused("mantle.account.InvoiceServices.release#InvoiceHold", {
            invoiceHoldId: own.invoiceHoldId,
            releaseComment: "Checked"
        })
        login(users.ap)
        const asked = native("request#HoldRelease", {invoiceHoldId: own.invoiceHoldId, releaseRequestNote: "Supplier fixed it"})
        const noRelease = refused("mantle.account.InvoiceServices.release#InvoiceHold", {
            invoiceHoldId: own.invoiceHoldId,
            releaseComment: "Checked"
        })
        login(users.approver)
        const noReason = refused("mantle.account.InvoiceServices.release#InvoiceHold", {invoiceHoldId: own.invoiceHoldId})
        const released = native("release#InvoiceHold", {invoiceHoldId: own.invoiceHoldId, releaseComment: "Checked"})
        const holds = native("get#InvoiceHolds", {invoiceId: billId})
        const hold = one("mantle.account.invoice.InvoiceHold", {invoiceHoldId: own.invoiceHoldId})
        const notice = one("moqui.security.user.NotificationMessage", {notificationMessageId: asked.notificationMessageId})
        const recipients = rows("moqui.security.user.NotificationMessageUser", {
            notificationMessageId: asked.notificationMessageId
        })
        return {selfRelease, noRelease, noReason, released, holds, hold, notice, recipients}
    },
    then({selfRelease, noRelease, noReason, released, holds, hold, notice, recipients}) {
        // the organization's users who may release it hear of it, the asker and the users without the permission do not;
        // the release marks it read
        recipients.map(row => row.userId).sort() == [users.approver, users.holder].sort()
        recipients.every(row => row.viewedDate != null)
        selfRelease.includes("HOLD_RELEASE_SELF")
        noRelease.includes("PERMISSION_DENIED")
        noReason.includes("REASON_REQUIRED")
        released.invoiceId == billId
        hold.releasedByUserId == users.approver
        hold.releaseComment == "Checked"
        hold.releaseRequestedByUserId == users.ap
        notice.topic == "BillHoldRelease"
        holds.openHoldCount == 0
        holds.payableCapabilities.canApprove == true
    }
})

feature("an AP user sends a bill for approval and an approver approves it once released", {
    when() {
        login(users.ap)
        const invoice = one("mantle.account.invoice.Invoice", {invoiceId: billId})
        const sent = native("request#PayableApproval", {invoiceId: billId, lastUpdatedStamp: invoice.lastUpdatedStamp})
        const received = one("mantle.account.invoice.Invoice", {invoiceId: billId})
        login(users.ar)
        const arDenied = refused("mantle.account.InvoiceServices.approve#Payable", {
            invoiceId: billId,
            lastUpdatedStamp: received.lastUpdatedStamp
        })
        login(users.approver)
        const unread = () =>
            rows("moqui.security.user.NotificationMessageUser", {notificationMessageId: sent.notificationMessageId}).filter(
                row => !row.viewedDate
            ).length
        const waiting = unread()
        const approved = native("approve#Payable", {invoiceId: billId, lastUpdatedStamp: received.lastUpdatedStamp})
        return {sent, arDenied, approved, waiting, left: unread()}
    },
    then({sent, arDenied, approved, waiting, left}) {
        waiting == 2
        left == 0
        sent.statusId == "InvoiceReceived"
        sent.notificationMessageId != null
        arDenied.includes("PERMISSION_DENIED")
        approved.statusId == "InvoiceApproved"
    }
})

feature("with the receipt billing rule a receipt bills only a self-billing supplier, for accepted quantity only", {
    when() {
        login("john.doe")
        svc("update#mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: org, receiptInvoiceSelfBilledOnly: "Y"})
        const plain = purchase(supplier, true)
        const plainBills = shipmentBills(plain.shipmentId)
        const self = purchase(selfBilled, true)
        const selfBills = shipmentBills(self.shipmentId)
        const lines = selfBills.length ? rows("mantle.account.invoice.InvoiceItem", {invoiceId: selfBills[0]}) : []
        // a receipt with nothing accepted leaves no empty bill
        const rejectedAll = purchase(selfBilled, true, 0, 10)
        const rejectedBills = shipmentBills(rejectedAll.shipmentId)
        const upload = selfBilledUpload(self.shipmentId)
        // a second self-billed receipt whose supplier reference is another bill's: refused, the draft keeps no reference
        login("john.doe")
        const other = purchase(selfBilled, true)
        const otherDraft = shipmentBills(other.shipmentId)[0]
        login(users.ap)
        native("import#Bill", {organizationPartyId: org, supplierPartyId: selfBilled, referenceNumber: "SELF-2", amount: "5"})
        const conflicting = refused("mantle.account.InvoiceServices.import#Bill", {
            organizationPartyId: org,
            supplierPartyId: selfBilled,
            shipmentId: other.shipmentId,
            referenceNumber: "SELF-2"
        })
        const keptReference = one("mantle.account.invoice.Invoice", {invoiceId: otherDraft}).referenceNumber
        login(users.ap)
        const fromReceipt = native("create#InvoiceFromSource", {orderId: plain.orderId, basis: "received"})
        const receiptLines = rows("mantle.account.invoice.InvoiceItem", {invoiceId: fromReceipt.invoiceId})
        login("john.doe")
        svc("update#mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: org, receiptInvoiceSelfBilledOnly: "N"})
        return {plainBills, selfBills, lines, rejectedBills, upload, conflicting, keptReference, receiptLines}
    },
    then({plainBills, selfBills, lines, rejectedBills, upload, conflicting, keptReference, receiptLines}) {
        rejectedBills.length == 0
        conflicting.includes("BILL_DUPLICATE")
        keptReference == null
        plainBills.length == 0
        selfBills.length == 1
        lines.length == 1
        lines[0].quantity.toNumber() == 8
        lines[0].itemTypeEnumId == "ItemInventory"
        upload.attached == true
        upload.invoiceId == selfBills[0]
        receiptLines.length == 1
        receiptLines[0].quantity.toNumber() == 8
    }
})

feature("a repeat upload for a receipt is refused, naming its bill, also once the bill is approved", {
    when() {
        login("john.doe")
        const draftId = Array.from(
            helper().lib.find("mantle.account.invoice.Invoice", {fromPartyId: selfBilled, referenceNumber: "SELF-1"}).list()
        )[0].invoiceId
        const shipmentId = rows("mantle.shipment.ShipmentItemSource", {invoiceId: draftId})[0].shipmentId
        login(users.ap)
        const repeat = refused("mantle.account.InvoiceServices.import#Bill", {
            organizationPartyId: org,
            supplierPartyId: selfBilled,
            shipmentId,
            referenceNumber: "SELF-1B"
        })
        login(users.approver)
        native("approve#Payable", {
            invoiceId: draftId,
            lastUpdatedStamp: one("mantle.account.invoice.Invoice", {invoiceId: draftId}).lastUpdatedStamp
        })
        login(users.ap)
        const afterApproval = refused("mantle.account.InvoiceServices.import#Bill", {
            organizationPartyId: org,
            supplierPartyId: selfBilled,
            shipmentId,
            referenceNumber: "SELF-1C"
        })
        return {draftId, repeat, afterApproval}
    },
    then({draftId, repeat, afterApproval}) {
        repeat.includes("BILL_DUPLICATE")
        repeat.includes(draftId)
        afterApproval.includes("BILL_DUPLICATE")
        afterApproval.includes(draftId)
    }
})

feature("each delivery of an order is billed on its receipt, and a retry with the same key answers the first bill", {
    when() {
        login("john.doe")
        svc("update#mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: org, receiptInvoiceSelfBilledOnly: "Y"})
        const po = purchase(supplier, false)
        deliver(po.orderId, 4, 0)
        login(users.ap)
        const first = native("create#InvoiceFromSource", {orderId: po.orderId, basis: "received", operationKey: "AP-SRC-1"})
        const retry = native("create#InvoiceFromSource", {orderId: po.orderId, basis: "received", operationKey: "AP-SRC-1"})
        login("john.doe")
        deliver(po.orderId, 6, 0)
        login(users.ap)
        const second = native("create#InvoiceFromSource", {orderId: po.orderId, basis: "received"})
        const third = refused("mantle.account.InvoiceServices.create#InvoiceFromSource", {orderId: po.orderId, basis: "received"})
        const quantity = invoiceId => rows("mantle.account.invoice.InvoiceItem", {invoiceId})[0]?.quantity?.toNumber()
        login("john.doe")
        svc("update#mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: org, receiptInvoiceSelfBilledOnly: "N"})
        return {first, retry, second, third, firstQuantity: quantity(first.invoiceId), secondQuantity: quantity(second.invoiceId)}
    },
    then({first, retry, second, third, firstQuantity, secondQuantity}) {
        retry.invoiceId == first.invoiceId
        second.invoiceId != first.invoiceId
        firstQuantity == 4
        secondQuantity == 6
        third.includes("SOURCE_ALREADY_INVOICED")
    }
})

feature("a user who only edits receivables cannot change a supplier's identifications, by either side", {
    when() {
        login("john.doe")
        const poOnly = prefix + "_PO_ONLY"
        party(poOnly, "Purchase order supplier", "Supplier")
        purchase(poOnly, false)
        const request = side => ({
            organizationPartyId: org,
            customerPartyId: poOnly,
            side,
            partyIdTypeEnumId: "PtidFein",
            idValue: "12-3456789"
        })
        login(users.ar)
        const asCustomer = refused("mantle.account.CustomerFinanceServices.store#CustomerIdentification", request("customer"))
        const asSupplier = refused("mantle.account.CustomerFinanceServices.store#CustomerIdentification", request("supplier"))
        login(users.ap)
        const ap = refused("mantle.account.CustomerFinanceServices.store#CustomerIdentification", request("supplier"))
        return {asCustomer, asSupplier, ap}
    },
    then({asCustomer, asSupplier, ap}) {
        asCustomer.includes("CUSTOMER_SCOPE_INVALID")
        asSupplier.includes("PERMISSION_DENIED")
        ap == ""
    }
})
