// Customer credit and order holds (AC-11, CX-ORDER-HOLD): the policy as dated rows, an order over its customer's limit
// held on a manual approval and on Mantle's automatic one alike with its reservations kept, released by a credit manager
// with a reason, a warn policy, a customer without a policy, and a second hold reason that keeps the order held.
// Standalone: spec-local organization, customers and users.
const helper = () => ec.resource.script("component://mr-mantle/test/ledger/AccountingReceivablesFixtures.js")
const svc = (name, p) => helper().call(name, p)
const refused = (name, p) => helper().rejected(name, p)
const one = (entity, key) => helper().lib.one(entity, key)
const rows = (entity, key) => helper().lib.rows(entity, key)
const prefix = "NATIVE_CREDIT"
let f, credit, approver, heldOrderId, warnedCustomer
const facility = prefix + "_WH"

function user(kind, permissions) {
    const id = prefix + "_" + kind.toUpperCase()
    svc("create#moqui.security.UserGroup", {userGroupId: id, description: "Credit " + kind})
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
        toPartyId: f.org,
        relationshipTypeEnumId: "PrtAgent",
        fromDate: 0
    })
    return id
}
// A placed sales order of the organization to the customer: five of DEMO_1_2 at 10, with an authorized payment for its
// total when paid.
function order(customerPartyId, paid = false) {
    login("john.doe")
    const made = svc("mantle.order.OrderServices.create#Order", {
        vendorPartyId: f.org,
        customerPartyId,
        currencyUomId: "USD",
        facilityId: facility
    })
    svc("mantle.order.OrderServices.add#OrderProductQuantity", {
        orderId: made.orderId,
        orderPartSeqId: made.orderPartSeqId,
        productId: "DEMO_1_2",
        quantity: 5,
        unitAmount: 10,
        itemTypeEnumId: "ItemProduct"
    })
    if (paid)
        svc("create#mantle.account.payment.Payment", {
            paymentId: made.orderId + "_PAY",
            orderId: made.orderId,
            orderPartSeqId: made.orderPartSeqId,
            fromPartyId: customerPartyId,
            toPartyId: f.org,
            amount: 50,
            amountUomId: "USD",
            paymentInstrumentEnumId: "PiCreditCard",
            statusId: "PmntAuthorized"
        })
    svc("mantle.order.OrderServices.place#Order", {orderId: made.orderId, requireInventory: false})
    return made.orderId
}
const status = orderId => one("mantle.order.OrderHeader", {orderId}).statusId
const partStatus = (orderId, orderPartSeqId) => one("mantle.order.OrderPart", {orderId, orderPartSeqId}).statusId
// A placed order of two parts, five of DEMO_1_2 at 10 each, to the two customers given.
function twoParts(firstCustomer, secondCustomer) {
    login("john.doe")
    const made = svc("mantle.order.OrderServices.create#Order", {
        vendorPartyId: f.org,
        customerPartyId: firstCustomer,
        currencyUomId: "USD",
        facilityId: facility
    })
    const second = svc("mantle.order.OrderServices.create#OrderPart", {
        orderId: made.orderId,
        vendorPartyId: f.org,
        customerPartyId: secondCustomer,
        facilityId: facility
    })
    for (const orderPartSeqId of [made.orderPartSeqId, second.orderPartSeqId])
        svc("mantle.order.OrderServices.add#OrderProductQuantity", {
            orderId: made.orderId,
            orderPartSeqId,
            productId: "DEMO_1_2",
            quantity: 5,
            unitAmount: 10,
            itemTypeEnumId: "ItemProduct"
        })
    svc("mantle.order.OrderServices.place#Order", {orderId: made.orderId, requireInventory: false})
    return made.orderId
}
const openReasons = orderId => rows("mantle.order.OrderHoldReason", {orderId}).filter(row => !row.releasedDate)
function policy(customerPartyId, values) {
    login(credit)
    return svc(
        "mantle.account.CreditServices.store#Policy",
        Object.assign({organizationPartyId: f.org, customerPartyId, changeReason: "Credit review"}, values)
    )
}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures(prefix)
        svc("create#mantle.facility.Facility", {facilityId: facility, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: f.org})
        credit = user("manager", ["CREDIT_HOLD_RELEASE", "CUSTOMER_CREDIT_VIEW", "RECEIVABLE_VIEW"])
        approver = user("approver", ["ORDER_APPROVE"])
        warnedCustomer = prefix + "_WARNED"
        svc("create#mantle.party.Party", {partyId: warnedCustomer, partyTypeEnumId: "PtyOrganization"})
        svc("create#mantle.party.Organization", {partyId: warnedCustomer, organizationName: prefix + " warned customer"})
        svc("create#mantle.party.PartyRole", {partyId: warnedCustomer, roleTypeId: "Customer"})
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        login("john.doe")
    }
})

feature("a credit manager sets a customer's limit as dated rows; AR and the default need more authority", {
    when() {
        const first = policy(f.customer, {creditLimit: 20, actionEnumId: "CpaHold"})
        const same = policy(f.customer, {creditLimit: 20, actionEnumId: "CpaHold"})
        login(f.users.ar)
        const denied = refused("mantle.account.CreditServices.store#Policy", {
            organizationPartyId: f.org,
            customerPartyId: f.customer,
            creditLimit: 30,
            changeReason: "Raise"
        })
        login(credit)
        const noDefault = refused("mantle.account.CreditServices.store#Defaults", {
            organizationPartyId: f.org,
            creditLimit: 1000,
            changeReason: "Default"
        })
        const empty = refused("mantle.account.CreditServices.store#Policy", {
            organizationPartyId: f.org,
            customerPartyId: f.customer,
            changeReason: "Nothing"
        })
        login(f.users.financeadmin)
        const defaults = svc("mantle.account.CreditServices.store#Defaults", {
            organizationPartyId: f.org,
            creditLimit: 1000,
            actionEnumId: "CpaWarn",
            changeReason: "Default"
        })
        const ended = svc("mantle.account.CreditServices.store#Defaults", {
            organizationPartyId: f.org,
            changeReason: "No default",
            ended: "Y"
        })
        return {first, same, denied, noDefault, empty, defaults, ended}
    },
    then({first, same, denied, noDefault, empty, defaults, ended}) {
        first.changed == true
        same.changed == false
        same.customerCreditPolicyId == first.customerCreditPolicyId
        denied.includes("PERMISSION_DENIED")
        noDefault.includes("PERMISSION_DENIED")
        empty.includes("POLICY_EMPTY")
        defaults.changed == true
        ended.changed == true
    }
})

feature("an order over the limit is held on a manual approval, keeps its reservations and is not approved again", {
    when() {
        heldOrderId = order(f.customer)
        const reservationsBefore = rows("mantle.product.issuance.AssetReservation", {orderId: heldOrderId}).length
        login(approver)
        const approved = svc("mantle.order.OrderServices.approve#Order", {orderId: heldOrderId})
        const again = refused("mantle.order.OrderServices.approve#Order", {orderId: heldOrderId})
        login(credit)
        const creditStatus = svc("mantle.account.CreditServices.get#CustomerCreditStatus", {
            organizationPartyId: f.org,
            customerPartyId: f.customer
        })
        login(f.users.ap)
        const noView = refused("mantle.account.CreditServices.get#CustomerCreditStatus", {
            organizationPartyId: f.org,
            customerPartyId: f.customer
        })
        const notices = rows("moqui.security.user.NotificationMessage", {topic: "CreditHoldRelease", recordId: heldOrderId})
        const recipients = notices.length
            ? rows("moqui.security.user.NotificationMessageUser", {notificationMessageId: notices[0].notificationMessageId})
            : []
        return {
            approved,
            again,
            status: status(heldOrderId),
            reasons: openReasons(heldOrderId),
            reservationsBefore,
            reservationsAfter: rows("mantle.product.issuance.AssetReservation", {orderId: heldOrderId}).length,
            creditStatus,
            noView,
            recipients
        }
    },
    then({approved, again, status, reasons, reservationsBefore, reservationsAfter, creditStatus, noView, recipients}) {
        approved.creditHeld == true
        status == "OrderHold"
        reasons.length == 1
        reasons[0].holdTypeEnumId == "OhtCredit"
        reasons[0].holdComment.includes("over the limit")
        reservationsBefore > 0
        reservationsAfter == reservationsBefore
        again.includes("ORDER_HOLD_OPEN")
        creditStatus.policy.source == "customer"
        creditStatus.exposure.exposure.eq(50)
        creditStatus.available.eq(-30)
        creditStatus.holds.some(row => row.orderId == heldOrderId)
        noView.includes("PERMISSION_DENIED")
        recipients.some(row => row.userId == credit)
    }
})

feature("a credit manager releases the hold with a reason; the order is placed again and approval passes its decision", {
    when() {
        login(f.users.ar)
        const denied = refused("mantle.account.CreditServices.release#CreditHold", {orderId: heldOrderId, reason: "Paid soon"})
        login(credit)
        const noReason = refused("mantle.account.CreditServices.release#CreditHold", {orderId: heldOrderId, reason: " "})
        const released = svc("mantle.account.CreditServices.release#CreditHold", {
            orderId: heldOrderId,
            reason: "Known customer, paying this week"
        })
        const decision = one("mantle.account.billing.CreditHoldDecision", {creditHoldDecisionId: released.creditHoldDecisionId})
        const afterRelease = status(heldOrderId)
        login(approver)
        const approved = svc("mantle.order.OrderServices.approve#Order", {orderId: heldOrderId})
        const unread = rows("moqui.security.user.NotificationMessage", {topic: "CreditHoldRelease", recordId: heldOrderId})
            .flatMap(row =>
                rows("moqui.security.user.NotificationMessageUser", {notificationMessageId: row.notificationMessageId})
            )
            .filter(row => !row.viewedDate)
        return {denied, noReason, released, decision, afterRelease, approved, status: status(heldOrderId), unread}
    },
    then({denied, noReason, released, decision, afterRelease, approved, status, unread}) {
        denied.includes("PERMISSION_DENIED")
        noReason.includes("REASON_REQUIRED")
        // held before it was approved: back to Placed, so its approval runs its checks, and the decision passes credit
        released.statusId == "OrderPlaced"
        afterRelease == "OrderPlaced"
        approved.creditHeld == false
        approved.creditWarning == null
        status == "OrderApproved"
        decision.decisionEnumId == "CrdRelease"
        decision.decidedByUserId == credit
        decision.exposureAmount.eq(50)
        decision.creditLimit.eq(20)
        unread.length == 0
    }
})

feature("Mantle's automatic approval holds a paid order of a customer already over its limit", {
    when() {
        // the approved order of 50 is still not invoiced, so the customer is over its limit of 20 before this order
        const orderId = order(f.customer, true)
        return {status: status(orderId), reasons: openReasons(orderId)}
    },
    then({status, reasons}) {
        status == "OrderHold"
        reasons.length == 1
        reasons[0].holdTypeEnumId == "OhtCredit"
    }
})

feature("a warn policy approves with a warning, and a customer without a policy approves as before", {
    when() {
        policy(warnedCustomer, {creditLimit: 20, actionEnumId: "CpaWarn"})
        const warnedOrder = order(warnedCustomer)
        login(approver)
        const messages = svc("mantle.order.OrderServices.approve#Order", {orderId: warnedOrder}).creditWarning
        login("john.doe")
        const other = prefix + "_PLAIN"
        svc("create#mantle.party.Party", {partyId: other, partyTypeEnumId: "PtyOrganization"})
        svc("create#mantle.party.PartyRole", {partyId: other, roleTypeId: "Customer"})
        const plainOrder = order(other)
        login(approver)
        const plain = svc("mantle.order.OrderServices.approve#Order", {orderId: plainOrder})
        return {warned: status(warnedOrder), messages, plain, plainStatus: status(plainOrder)}
    },
    then({warned, messages, plain, plainStatus}) {
        warned == "OrderApproved"
        messages.includes("Credit warning")
        plain.creditHeld == false
        plainStatus == "OrderApproved"
    }
})

feature("a second hold reason keeps the order held until it is released too", {
    when() {
        const orderId = order(f.customer)
        login(approver)
        svc("mantle.order.OrderServices.approve#Order", {orderId})
        const manual = svc("mantle.order.OrderServices.hold#Order", {
            orderId,
            holdTypeEnumId: "OhtManual",
            holdComment: "Address check"
        })
        login(f.users.ar)
        const noManual = refused("mantle.order.OrderServices.hold#Order", {orderId, holdTypeEnumId: "OhtManual"})
        login(credit)
        const creditReleased = svc("mantle.account.CreditServices.release#CreditHold", {orderId, reason: "Approved limit"})
        const stillHeld = status(orderId)
        const noManualRelease = refused("mantle.order.OrderServices.release#OrderHold", {
            orderHoldReasonId: manual.orderHoldReasonId,
            releaseComment: "Checked"
        })
        login(approver)
        const released = svc("mantle.order.OrderServices.release#OrderHold", {
            orderHoldReasonId: manual.orderHoldReasonId,
            releaseComment: "Address checked"
        })
        return {creditReleased, stillHeld, noManual, noManualRelease, released, status: status(orderId)}
    },
    then({creditReleased, stillHeld, noManual, noManualRelease, released, status}) {
        creditReleased.stillHeld == true
        stillHeld == "OrderHold"
        noManual.includes("PERMISSION_DENIED")
        noManualRelease.includes("PERMISSION_DENIED")
        released.stillHeld == false
        status == "OrderPlaced"
    }
})

feature("a release decision stands until it expires; then approval holds the order again", {
    when() {
        const orderId = order(f.customer)
        login(approver)
        const held = svc("mantle.order.OrderServices.approve#Order", {orderId})
        login(credit)
        const pastRefused = refused("mantle.account.CreditServices.release#CreditHold", {
            orderId,
            reason: "Too late",
            expireDate: new Date(Number(ec.user.nowTimestamp) - 86400000)
        })
        const released = svc("mantle.account.CreditServices.release#CreditHold", {
            orderId,
            reason: "For this week",
            expireDate: new Date(Number(ec.user.nowTimestamp) + 7 * 86400000)
        })
        const standing = svc("mantle.account.CreditServices.evaluate#OrderCredit", {orderId})
        login("john.doe")
        svc("update#mantle.account.billing.CreditHoldDecision", {
            creditHoldDecisionId: released.creditHoldDecisionId,
            expireDate: new Date(Number(ec.user.nowTimestamp) - 60000)
        })
        login(approver)
        const again = svc("mantle.order.OrderServices.approve#Order", {orderId})
        return {held, pastRefused, released, standing, again, status: status(orderId)}
    },
    then({held, pastRefused, released, standing, again, status}) {
        held.creditHeld == true
        pastRefused.includes("EXPIRE_DATE_PAST")
        released.statusId == "OrderPlaced"
        standing.resultEnumId == "pass"
        standing.reasons.some(row => row.code == "CREDIT_RELEASED")
        again.creditHeld == true
        status == "OrderHold"
    }
})

feature("an order of two parts holds the part over its limit, approves the other, and releases only the held part", {
    when() {
        const plain = prefix + "_PARTS"
        login("john.doe")
        svc("create#mantle.party.Party", {partyId: plain, partyTypeEnumId: "PtyOrganization"})
        svc("create#mantle.party.PartyRole", {partyId: plain, roleTypeId: "Customer"})
        // part 01 to a customer without a policy, part 02 to the one over its limit
        const orderId = twoParts(plain, f.customer)
        const reservations = rows("mantle.product.issuance.AssetReservation", {orderId}).length
        login(approver)
        const approved = svc("mantle.order.OrderServices.approve#Order", {orderId})
        const after = {p1: partStatus(orderId, "01"), p2: partStatus(orderId, "02")}
        login(credit)
        const released = svc("mantle.account.CreditServices.release#CreditHold", {
            orderId,
            orderPartSeqId: "02",
            reason: "Part released"
        })
        const afterRelease = {p1: partStatus(orderId, "01"), p2: partStatus(orderId, "02")}
        // a completed part 01 is never touched by approving part 02
        login("john.doe")
        const other = twoParts(plain, f.customer)
        login(approver)
        svc("mantle.order.OrderServices.approve#Order", {orderId: other, orderPartSeqId: "01"})
        login("john.doe")
        svc("mantle.order.OrderServices.update#OrderStatus", {orderId: other, orderPartSeqId: "01", statusId: "OrderCompleted"})
        login(approver)
        const second = svc("mantle.order.OrderServices.approve#Order", {orderId: other, orderPartSeqId: "02"})
        return {
            approved,
            after,
            released,
            afterRelease,
            reservations,
            reservationsAfter: rows("mantle.product.issuance.AssetReservation", {orderId}).length,
            reasons: rows("mantle.order.OrderHoldReason", {orderId}),
            second,
            other: {p1: partStatus(other, "01"), p2: partStatus(other, "02")}
        }
    },
    then({approved, after, released, afterRelease, reservations, reservationsAfter, reasons, second, other}) {
        approved.creditHeld == true
        approved.heldPartSeqIds.join() == "02"
        after.p1 == "OrderApproved"
        after.p2 == "OrderHold"
        reasons.length == 1
        reasons[0].orderPartSeqId == "02"
        reservationsAfter == reservations
        released.statusId == "OrderPlaced"
        afterRelease.p1 == "OrderApproved"
        afterRelease.p2 == "OrderPlaced"
        second.creditHeld == true
        other.p1 == "OrderCompleted"
        other.p2 == "OrderHold"
    }
})

feature("two parts of one customer approved apart: releasing the held part never checks or holds the approved one", {
    when() {
        const same = prefix + "_SAME"
        login("john.doe")
        svc("create#mantle.party.Party", {partyId: same, partyTypeEnumId: "PtyOrganization"})
        svc("create#mantle.party.PartyRole", {partyId: same, roleTypeId: "Customer"})
        const orderId = twoParts(same, same)
        // part 02 approved while the customer has no policy; then a limit, and part 01 is held over it
        login(approver)
        svc("mantle.order.OrderServices.approve#Order", {orderId, orderPartSeqId: "02"})
        policy(same, {creditLimit: 20, actionEnumId: "CpaHold"})
        login(approver)
        const held = svc("mantle.order.OrderServices.approve#Order", {orderId, orderPartSeqId: "01"})
        const check = svc("mantle.order.OrderInfoServices.check#OrderPreApprove", {orderId})
        login(credit)
        const released = svc("mantle.account.CreditServices.release#CreditHold", {
            orderId,
            orderPartSeqId: "01",
            reason: "Part 01 released"
        })
        // the whole order approved after the release: only part 01 awaits approval, and its release decision passes it
        login(approver)
        const approved = svc("mantle.order.OrderServices.approve#Order", {orderId})
        return {
            held,
            warnings: check.approveWarnings,
            released,
            approved,
            p1: partStatus(orderId, "01"),
            p2: partStatus(orderId, "02"),
            reasons: rows("mantle.order.OrderHoldReason", {orderId})
        }
    },
    then({held, warnings, released, approved, p1, p2, reasons}) {
        held.creditHeld == true
        held.heldPartSeqIds.join() == "01"
        warnings.some(row => row.startsWith("ORDER_HOLD_OPEN"))
        released.statusId == "OrderPlaced"
        approved.creditHeld == false
        p1 == "OrderApproved"
        p2 == "OrderApproved"
        reasons.length == 1
        reasons[0].orderPartSeqId == "01"
    }
})
