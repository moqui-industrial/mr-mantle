// Purchasing's receipt progress (impl-purchasing P5; design-purchasing §9 Receipts): a purchase line's expected, received,
// accepted, rejected and held quantities kept apart (an inspection's rejection moves units from accepted to rejected, and
// held is the quality record's), its due date and lateness; and the late-receipt notice, sent once per order part and due
// date to the organization's buyers, never for a line received in full or not yet due. Standalone: a spec-local
// organization, supplier, product, buyer and orders written as rows, with artifact authorization disabled.
// Run: ./moq test mr-mantle --spec PurchaseReceipts
const prefix = "PUR_RCPT_SPEC"
const org = prefix + "_ORG",
    supplier = prefix + "_SUPPLIER",
    product = prefix + "_PRODUCT",
    facility = prefix + "_WH",
    buyer = prefix + "_BUYER",
    since = "2000-01-01T00:00:00Z"
const DAY = 86400000
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const receipts = () => ec.resource.script("component://mr-mantle/service/mantle/order/PurchaseReceipts.js")

function organization(partyId, name, roleTypeId, ownerPartyId) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: ownerPartyId || null})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId})
}
// an approved purchase order of the organization from the supplier: one line of the product, required by the given time
function approvedOrder(orderId, quantity, requiredBy) {
    call("create#mantle.order.OrderHeader", {orderId, statusId: "OrderApproved", currencyUomId: "USD", entryDate: since})
    call("create#mantle.order.OrderPart", {
        orderId,
        orderPartSeqId: "01",
        statusId: "OrderApproved",
        vendorPartyId: supplier,
        customerPartyId: org,
        facilityId: facility
    })
    call("create#mantle.order.OrderItem", {
        orderId,
        orderItemSeqId: "01",
        orderPartSeqId: "01",
        itemTypeEnumId: "ItemInventory",
        productId: product,
        quantity,
        unitAmount: 2,
        requiredByDate: new Date(requiredBy)
    })
}
function received(orderId, assetReceiptId, accepted, rejected = 0) {
    call("create#mantle.product.asset.Asset", {
        assetId: assetReceiptId,
        assetTypeEnumId: "AstTpInventory",
        statusId: "AstQuarantine",
        productId: product,
        facilityId: facility,
        ownerPartyId: org,
        hasQuantity: "Y",
        quantityOnHandTotal: 0,
        availableToPromiseTotal: 0
    })
    call("create#mantle.product.receipt.AssetReceipt", {
        assetReceiptId,
        assetId: assetReceiptId,
        orderId,
        orderItemSeqId: "01",
        productId: product,
        quantityAccepted: accepted,
        quantityRejected: rejected,
        receivedDate: ec.user.nowTimestamp
    })
}
const notices = orderId =>
    rows("moqui.security.user.NotificationMessage", {
        topic: "PurchaseLateReceipt",
        recordEntityName: "mantle.order.OrderHeader",
        recordId: orderId
    })

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(org, "Receipt Spec Org", "OrgInternal")
        organization(supplier, "Receipt Spec Supplier", "Supplier", org)
        call("create#mantle.facility.Facility", {facilityId: facility, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: org})
        call("create#mantle.product.Product", {
            productId: product,
            productName: "Receipt spec part",
            productTypeEnumId: "PtAsset",
            assetTypeEnumId: "AstTpInventory",
            amountUomId: "OTH_ea",
            ownerPartyId: org
        })
        // a buyer of the organization (PURCHASE_ORDER_EDIT), the notice's recipient
        call("create#moqui.security.UserGroup", {userGroupId: buyer, description: "Receipt spec buyer"})
        call("create#moqui.security.UserGroupPermission", {
            userGroupId: buyer,
            userPermissionId: "PURCHASE_ORDER_EDIT",
            fromDate: since
        })
        call("create#mantle.party.Party", {partyId: buyer, partyTypeEnumId: "PtyPerson"})
        call("create#mantle.party.Person", {partyId: buyer, firstName: "Receipt", lastName: "Buyer"})
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtAgent",
            fromPartyId: buyer,
            toPartyId: org,
            toRoleTypeId: "OrgInternal",
            fromDate: since
        })
        call("create#moqui.security.UserAccount", {userId: buyer, username: buyer, partyId: buyer})
        call("create#moqui.security.UserGroupMember", {userId: buyer, userGroupId: buyer, fromDate: since})
        const now = Number(ec.user.nowTimestamp)
        // late: due three days ago, 8 of 10 received; the inspection rejected 1 of the 8 and holds them until disposition
        approvedOrder(prefix + "_LATE", 10, now - 3 * DAY)
        received(prefix + "_LATE", prefix + "_R1", 8)
        call("create#mantle.product.quality.QualityInspection", {
            qualityInspectionId: prefix + "_QI",
            organizationPartyId: org,
            facilityId: facility,
            statusId: "QiSubmitted",
            inspectionContextEnumId: "QicReceipt",
            sourceTypeEnumId: "QisReceipt",
            assetReceiptId: prefix + "_R1",
            orderId: prefix + "_LATE",
            orderItemSeqId: "01",
            productId: product,
            quantity: 8,
            heldQuantity: 8,
            quantityAccepted: 7,
            quantityRejected: 1
        })
        // due three days ago but received in full; and due next week
        approvedOrder(prefix + "_DONE", 4, now - 3 * DAY)
        received(prefix + "_DONE", prefix + "_R2", 4)
        approvedOrder(prefix + "_SOON", 5, now + 7 * DAY)
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    }
})

feature("a line keeps expected, received, accepted, rejected and held apart, and is late only while something is due", {
    when() {
        const found = receipts().lines({organizationPartyIds: [org]}).lines
        const line = orderId => found.find(row => row.orderId === orderId) || {}
        return {late: line(prefix + "_LATE"), done: line(prefix + "_DONE"), soon: line(prefix + "_SOON"), other: found.length}
    },
    then({late, done, soon, other}) {
        String(late.expectedQuantity) == "10"
        String(late.receivedQuantity) == "8"
        String(late.acceptedQuantity) == "7"
        String(late.rejectedQuantity) == "1"
        String(late.heldQuantity) == "8"
        String(late.remainingQuantity) == "2"
        late.late == true
        String(done.remainingQuantity) == "0"
        done.late == false
        soon.late == false
        other == 3
    }
})

feature("the late-receipt notice tells the organization's buyers once per order part and due date", {
    when() {
        const first = ec.service
            .sync()
            .name("mantle.order.PurchaseReceiptServices.notify#LateReceipts")
            .parameters({organizationPartyId: org})
            .call()
        const second = ec.service
            .sync()
            .name("mantle.order.PurchaseReceiptServices.notify#LateReceipts")
            .parameters({organizationPartyId: org})
            .call()
        const message = notices(prefix + "_LATE")[0]
        const recipients = message
            ? rows("moqui.security.user.NotificationMessageUser", {notificationMessageId: message.notificationMessageId}).map(
                  row => row.userId
              )
            : []
        return {first, second, message, recipients, done: notices(prefix + "_DONE"), soon: notices(prefix + "_SOON")}
    },
    then({first, second, message, recipients, done, soon}) {
        first.notifiedCount == 1
        first.lateCount == 1
        second.notifiedCount == 0
        JSON.parse(message.messageJson).lines[0].remaining == "2"
        recipients == [buyer]
        done.length == 0
        soon.length == 0
    }
})
