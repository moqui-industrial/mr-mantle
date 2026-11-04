// Purchasing's part of the bill flow (impl-purchasing P6; design-purchasing §6 Bills and money, §10): a supplier prepayment
// asked for from a purchase order is a promised payment linked to its part, for finance only and at most what the order
// leaves; a bill's hold release is asked for by AP, a match operator or a buyer, not by a reader; and a match that holds a
// bill tells the buyers of its organization (PurchaseMatchException), not the matcher. Standalone: a spec-local
// organization, supplier, facility and users, with artifact authorization disabled (the rules are the services' own
// permission checks). Run: ./moq test mr-mantle --spec PurchaseBills
const helper = () => ec.resource.script("component://mr-mantle/test/ledger/AccountingReceivablesFixtures.js")
const svc = (name, p) => helper().call(name, p)
const refused = (name, p) => helper().rejected(name, p)
const one = (entity, key) => helper().lib.one(entity, key)
const rows = (entity, key) => helper().lib.rows(entity, key)
const prefix = "PUR_BILL_SPEC"
const org = prefix + "_ORG",
    otherOrg = prefix + "_ORG2",
    supplier = prefix + "_SUPPLIER",
    facility = prefix + "_WH",
    product = "DEMO_1_1"
const P = "mantle.order.PurchaseServices."
const users = {}
const ids = {}

function party(partyId, name, roleTypeId) {
    svc("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
    svc("create#mantle.party.Organization", {partyId, organizationName: name})
    svc("create#mantle.party.PartyRole", {partyId, roleTypeId})
}
function user(kind, permissions, organizationPartyId = org) {
    const id = prefix + "_" + kind.toUpperCase()
    users[kind] = id
    svc("create#moqui.security.UserGroup", {userGroupId: id, description: "Purchase bills " + kind})
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
// A purchase order of ten of the product at 5.00 from the supplier, placed and approved unless a draft is asked for.
function purchase(draft = false) {
    login("john.doe")
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
        quantity: 10,
        unitAmount: 5,
        itemTypeEnumId: "ItemInventory"
    })
    if (!draft) {
        svc("mantle.order.OrderServices.place#Order", {orderId: order.orderId})
        svc("mantle.order.OrderServices.approve#Order", {orderId: order.orderId})
    }
    return {orderId: order.orderId, orderItemSeqId: item.orderItemSeqId}
}
// Six of the order received and accepted (not delivered, so no receipt bill), and its receipt.
function receive(orderId) {
    login("john.doe")
    const shipment = svc("mantle.shipment.ShipmentServices.create#OrderPartShipment", {
        orderId,
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
    return rows("mantle.product.receipt.AssetReceipt", {shipmentId: shipment.shipmentId})[0]
}
// The call as the user: its out-map, or the refusal's message in `error`.
function as(kind, name, p) {
    login(users[kind])
    const error = refused(name, p)
    if (error) return {error}
    login(users[kind])
    return {}
}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        party(org, "Purchase bills organization", "OrgInternal")
        svc("mantle.ledger.LedgerServices.init#PartyAccountingConfiguration", {
            organizationPartyId: org,
            sourcePartyId: "DefaultSettings",
            baseCurrencyUomId: "USD"
        })
        svc("mantle.ledger.LedgerServices.get#OrganizationFiscalTimePeriods", {
            organizationPartyId: org,
            filterDate: ec.user.nowTimestamp
        })
        svc("update#mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: org, receiptInvoiceSelfBilledOnly: "Y"})
        party(otherOrg, "Purchase bills other organization", "OrgInternal")
        party(supplier, "Purchase bills supplier", "Supplier")
        svc("create#mantle.facility.Facility", {facilityId: facility, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: org})
        user("ap", ["PAYABLE_EDIT", "PAYABLE_VIEW", "PAYABLE_IMPORT"])
        user("buyer", ["PURCHASE_ORDER_EDIT"])
        user("matcher", ["INVOICE_MATCH", "PAYABLE_VIEW"])
        user("reader", ["PAYABLE_VIEW"])
        user("otherBuyer", ["PURCHASE_ORDER_EDIT"], otherOrg)
        ids.po = purchase()
        ids.receipt = receive(ids.po.orderId)
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        login("john.doe")
    }
})

feature("a supplier prepayment is a promised payment on the order's part, for finance, at most what the order leaves", {
    when() {
        const request = {orderId: ids.po.orderId, amount: 20, operationKey: prefix + "-PREPAY-1"}
        const buyer = as("buyer", P + "request#SupplierPrepayment", request)
        login(users.ap)
        const first = svc(P + "request#SupplierPrepayment", request)
        const replay = svc(P + "request#SupplierPrepayment", request)
        const excess = as("ap", P + "request#SupplierPrepayment", {orderId: ids.po.orderId, amount: 40})
        login(users.ap)
        const rest = svc(P + "request#SupplierPrepayment", {orderId: ids.po.orderId})
        const none = as("ap", P + "request#SupplierPrepayment", {orderId: ids.po.orderId})
        const draft = as("ap", P + "request#SupplierPrepayment", {orderId: purchase(true).orderId, amount: 5})
        return {
            buyer,
            first,
            replay,
            excess,
            payment: one("mantle.account.payment.Payment", {paymentId: first.paymentId}),
            restPayment: one("mantle.account.payment.Payment", {paymentId: rest.paymentId}),
            none,
            draft
        }
    },
    then({buyer, first, replay, excess, payment, restPayment, none, draft}) {
        buyer.error.includes("PERMISSION_DENIED")
        first.paymentId != null
        replay.paymentId == first.paymentId
        replay.alreadyApplied == true
        payment.statusId == "PmntPromised"
        payment.orderId == ids.po.orderId
        payment.orderPartSeqId == "01"
        payment.fromPartyId == org
        payment.toPartyId == supplier
        payment.amount == 20
        excess.error.includes("AMOUNT_INVALID")
        restPayment.amount == 30
        none.error.includes("AMOUNT_INVALID")
        draft.error.includes("ORDER_STATE_INVALID")
    }
})

feature(
    "a match that holds a bill tells the organization's buyers; a buyer or matcher asks for its release, a reader or another organization's buyer may not",
    {
        when() {
            login(users.ap)
            const invoiceId = svc("mantle.account.InvoiceServices.import#Bill", {
                organizationPartyId: org,
                supplierPartyId: supplier,
                referenceNumber: prefix + "-BILL-1"
            }).invoiceId
            login("john.doe")
            svc("mantle.account.InvoiceServices.create#InvoiceItem", {
                invoiceId,
                itemTypeEnumId: "ItemInventory",
                productId: product,
                quantity: 6,
                amount: 6
            })
            const invoiceItemSeqId = rows("mantle.account.invoice.InvoiceItem", {invoiceId})[0].invoiceItemSeqId
            login(users.matcher)
            const match = {
                invoiceId,
                operationKey: prefix + "-MATCH-1",
                allocationList: [
                    {
                        invoiceItemSeqId,
                        orderId: ids.po.orderId,
                        orderItemSeqId: ids.po.orderItemSeqId,
                        assetReceiptId: ids.receipt.assetReceiptId,
                        quantity: "6"
                    }
                ]
            }
            const applied = svc("mantle.account.InvoiceMatchServices.apply#InvoiceMatch", match)
            // a replayed match places no hold and sends no second notice
            const replay = svc("mantle.account.InvoiceMatchServices.apply#InvoiceMatch", match)
            const notices = rows("moqui.security.user.NotificationMessage", {
                topic: "PurchaseMatchException",
                recordId: invoiceId
            })
            const recipients = notices.flatMap(notice =>
                rows("moqui.security.user.NotificationMessageUser", {notificationMessageId: notice.notificationMessageId}).map(
                    row => row.userId
                )
            )
            const request = {invoiceHoldId: applied.invoiceHoldId, releaseRequestNote: "The supplier credits the difference"}
            const reader = as("reader", "mantle.account.InvoiceServices.request#HoldRelease", request)
            const otherBuyer = as("otherBuyer", "mantle.account.InvoiceServices.request#HoldRelease", request)
            const buyer = as("buyer", "mantle.account.InvoiceServices.request#HoldRelease", request)
            const matcher = as("matcher", "mantle.account.InvoiceServices.request#HoldRelease", request)
            return {
                applied,
                replay,
                notices,
                recipients,
                reader,
                otherBuyer,
                buyer,
                matcher,
                hold: one("mantle.account.invoice.InvoiceHold", request)
            }
        },
        then({applied, replay, notices, recipients, reader, otherBuyer, buyer, matcher, hold}) {
            applied.invoiceHoldId != null
            replay.alreadyApplied == true
            notices.length == 1
            recipients.includes(users.buyer)
            !recipients.includes(users.matcher)
            !recipients.includes(users.reader)
            reader.error.includes("PERMISSION_DENIED")
            otherBuyer.error.includes("ORGANIZATION_DENIED")
            !recipients.includes(users.otherBuyer)
            buyer.error == undefined
            matcher.error == undefined
            hold.releaseRequestedByUserId == users.matcher
            hold.releasedDate == null
        }
    }
)
