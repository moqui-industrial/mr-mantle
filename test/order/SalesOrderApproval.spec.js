// A sales order's approval under the seller's approval setting (impl-sales P11, §4 Nov 11 and Nov 13, F11, F12, F52, F60; design-sales
// §1.1, §6 OrderDetail; mantle.order.OrderServices approve#Order and autoApprove#Order, mantle.order.SalesOrderServices): with the
// setting on, ORDER_APPROVE alone is refused a sales part and SALES_ORDER_APPROVE in the seller's scope admitted, a purchase part and a
// seller with the setting off approving as before; with it on a store order and a storeless order with a covering authorization both
// stay placed, their payment authorized, an order rule's decision is needed and recorded by approve#SalesOrder, and a pre-approval
// warning is shown and refuses nothing; with it off a store order auto-approves as before; a batch approval credit-holds the order over
// its customer's limit and approves the rest; another organization's hold is not released, nor a Credit hold in Sales; an accepted
// net-terms quote under the seller's option is approved through approve#Order and held by the credit check. Standalone:
// SalesQuoteIssueFixtures (A with the setting on, B and C off) and spec-local users, a store, a supplier and credit policies.
// Run: ./moq test mr-mantle --spec SalesOrderApproval
const fx = ec.resource.script("component://mr-mantle/test/order/SalesQuoteIssueFixtures.js")
const {call, system, as, make, one, revision, status, key} = fx
const orders = "mantle.order.SalesOrderServices."
const capture = ec.factory.getTool("MailCapture")
let f
const users = {}

const user = (kind, organizationPartyIds, permissions) => fx.addUser(f, kind, organizationPartyIds, permissions)
// a direct order of the seller for the account with one line of the product, placed: its id
function placedOrder(organizationPartyId, customerPartyId, quantity = 1) {
    const orderId = as(users.seller, orders + "create#SalesOrder", {organizationPartyId, customerPartyId}).orderId
    as(users.seller, orders + "store#SalesOrderLine", {orderId, orderRevision: revision(orderId), productId: f.product, quantity})
    const placed = as(users.seller, orders + "place#SalesOrder", {orderId, orderRevision: revision(orderId)})
    if (placed.refused) throw new Error(placed.refused)
    return orderId
}
// an order of the store (or storeless) with an authorized payment of its total, placed, then autoApprove#Order as the payment's
// authorization calls it
function paidOrder(organizationPartyId, customerPartyId, productStoreId) {
    return system(() => {
        const created = call("mantle.order.OrderServices.create#Order", {
            productStoreId: productStoreId || null,
            vendorPartyId: organizationPartyId,
            customerPartyId,
            currencyUomId: "USD"
        })
        call("mantle.order.OrderServices.create#OrderItem", {
            orderId: created.orderId,
            orderPartSeqId: created.orderPartSeqId,
            productId: f.product,
            itemTypeEnumId: "ItemProduct",
            quantity: 1,
            unitAmount: 100,
            requireInventory: false
        })
        call("mantle.order.OrderServices.place#Order", {orderId: created.orderId, requireInventory: false})
        const order = one("mantle.order.OrderHeader", {orderId: created.orderId})
        make("mantle.account.payment.Payment", {
            paymentTypeEnumId: "PtInvoicePayment",
            orderId: created.orderId,
            orderPartSeqId: created.orderPartSeqId,
            fromPartyId: customerPartyId,
            toPartyId: organizationPartyId,
            statusId: "PmntAuthorized",
            amount: order.grandTotal,
            amountUomId: "USD"
        })
        call("mantle.order.OrderServices.autoApprove#Order", {orderId: created.orderId})
        return created.orderId
    })
}
// a native order service as the user, artifact authorization off (the service's own permission check decides): the refusal or ""
function native(username, name, parameters) {
    login(username)
    const was = ec.artifactExecution.disableAuthz()
    ec.message.pushErrors()
    try {
        ec.service.sync().name(name).parameters(parameters).requireNewTransaction(true).call()
        return ec.message.hasError() ? ec.message.getErrorsString() : ""
    } catch (error) {
        return String(error.message)
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        if (!was) ec.artifactExecution.enableAuthz()
        login("john.doe")
    }
}
const setting = (organizationPartyId, values) =>
    system(() => {
        const policy = ec.entity
            .find("mantle.sales.policy.SalesPolicy")
            .condition("organizationPartyId", organizationPartyId)
            .one()
        call("update#mantle.sales.policy.SalesPolicy", Object.assign({salesPolicyId: policy.salesPolicyId}, values))
    })
const authorized = orderId =>
    system(() => ec.entity.find("mantle.account.payment.Payment").condition({orderId, statusId: "PmntAuthorized"}).count())

spec({
    stepwise: true,
    setupSpec() {
        capture.enable()
        f = fx.setup("SOA")
        system(() => {
            users.seller = user(
                "seller",
                [f.orgA, f.orgB, f.orgC],
                ["SALES_VIEW", "SALES_TEAM_VIEW", "SALES_ORDER_EDIT", "SALES_QUOTE_EDIT", "SALES_QUOTE_SEND"]
            )
            users.orderApprover = user("orderapprover", [f.orgA, f.orgB], ["SALES_VIEW", "ORDER_APPROVE"])
            users.salesApprover = user("salesapprover", [f.orgA], ["SALES_VIEW", "SALES_ORDER_APPROVE"])
            users.approverB = user(
                "approverb",
                [f.orgB],
                ["SALES_VIEW", "SALES_TEAM_VIEW", "SALES_ORDER_APPROVE", "ORDER_APPROVE"]
            )
            users.admin = user("admin", [f.orgA, f.orgB], ["SALES_VIEW", "SALES_CONFIGURE"])
            // A's sales orders wait for a Sales approver; B's and C's are approved as built
            setting(f.orgA, {orderApprovalRequired: "Y"})
            // A's store, whose own approval checks are off, so only the payment and the setting decide autoApprove#Order; B's too
            for (const organizationPartyId of [f.orgA, f.orgB]) {
                const productStoreId = organizationPartyId + "_STORE"
                make("mantle.product.store.ProductStore", {
                    productStoreId,
                    storeName: organizationPartyId + " store",
                    organizationPartyId,
                    defaultCurrencyUomId: "USD",
                    requireInventory: "N"
                })
                for (const settingTypeEnumId of [
                    "PsstOrdApproveNewCust",
                    "PsstOrdApproveAddrMissing",
                    "PsstOrdApproveAddrNotValid",
                    "PsstOrdApproveBillShipAddrDiff",
                    "PsstOrdApprovePayMethNameDiff",
                    "PsstOrdApprovePayMethBlacklist",
                    "PsstOrdApproveContactBlacklist"
                ].filter(enumId => !!one("moqui.basic.Enumeration", {enumId})))
                    make("mantle.product.store.ProductStoreSetting", {
                        productStoreId,
                        settingTypeEnumId,
                        fromDate: 0,
                        settingValue: "false"
                    })
            }
            // a supplier A buys from, and a second account of B for the batch
            f.supplier = f.prefix + "_SUPPLIER"
            make("mantle.party.Party", {partyId: f.supplier, partyTypeEnumId: "PtyOrganization"})
            make("mantle.party.Organization", {partyId: f.supplier, organizationName: "Orders supplier"})
            make("mantle.party.PartyRole", {partyId: f.supplier, roleTypeId: "Supplier"})
            f.accounts.b2 = f.prefix + "_ACC_B2"
            make("mantle.party.Party", {partyId: f.accounts.b2, partyTypeEnumId: "PtyOrganization", ownerPartyId: f.orgB})
            make("mantle.party.Organization", {partyId: f.accounts.b2, organizationName: "Account b2"})
            make("mantle.party.PartyRole", {partyId: f.accounts.b2, roleTypeId: "Customer"})
        })
    },
    cleanupSpec() {
        capture.reset()
        login("john.doe")
    }
})

feature(
    "with the setting on ORDER_APPROVE alone is refused a sales part and SALES_ORDER_APPROVE admitted; off, and a purchase part, as before",
    {
        when() {
            const gated = placedOrder(f.orgA, f.accounts.a)
            f.gated = gated
            const open = placedOrder(f.orgB, f.accounts.b)
            const approve = (username, orderId) => native(username, "mantle.order.OrderServices.approve#Order", {orderId})
            const purchase = system(() => {
                const created = call("mantle.order.OrderServices.create#Order", {
                    vendorPartyId: f.supplier,
                    customerPartyId: f.orgA,
                    currencyUomId: "USD"
                })
                call("mantle.order.OrderServices.create#OrderItem", {
                    orderId: created.orderId,
                    orderPartSeqId: created.orderPartSeqId,
                    productId: f.product,
                    itemTypeEnumId: "ItemProduct",
                    quantity: 1,
                    unitAmount: 10,
                    requireInventory: false
                })
                call("mantle.order.OrderServices.place#Order", {orderId: created.orderId, requireInventory: false})
                return created.orderId
            })
            return {
                gatedByOrderApprover: approve(users.orderApprover, gated),
                gatedByOtherScope: approve(users.approverB, gated),
                gatedBySalesApprover: approve(users.salesApprover, gated),
                gatedStatus: status(gated),
                openBySalesApprover: approve(users.salesApprover, open),
                openByOrderApprover: approve(users.orderApprover, open),
                openStatus: status(open),
                purchaseByOrderApprover: approve(users.orderApprover, purchase),
                purchaseStatus: status(purchase)
            }
        },
        then(r) {
            r.gatedByOrderApprover.includes("PERMISSION_DENIED: SALES_ORDER_APPROVE")
            r.gatedByOtherScope.includes("ORGANIZATION_DENIED")
            r.gatedBySalesApprover == "" && r.gatedStatus == "OrderApproved"
            r.openBySalesApprover.includes("Order Approve permission required")
            r.openByOrderApprover == "" && r.openStatus == "OrderApproved"
            r.purchaseByOrderApprover == "" && r.purchaseStatus == "OrderApproved"
        }
    }
)

feature(
    "with the setting on a store and a storeless order with a covering authorization stay placed; an order rule is decided by its approver",
    {
        when() {
            as(users.admin, "mantle.order.SalesApprovalServices.store#SalesApprovalPolicy", {
                organizationPartyId: f.orgA,
                purposeEnumId: "SapOrder",
                ruleTypeEnumId: "SarAmount",
                thresholdAmount: "50",
                currencyUomId: "USD",
                changeReason: "Orders over 50 are approved by a person"
            })
            const store = paidOrder(f.orgA, f.accounts.a, f.orgA + "_STORE")
            const storeless = paidOrder(f.orgA, f.accounts.a, null)
            const before = {
                store: status(store),
                storeless: status(storeless),
                authorized: authorized(store) + authorized(storeless)
            }
            const detail = as(users.salesApprover, orders + "get#SalesOrder", {orderId: store})
            // the native approval asks the rule's decision first; approve#SalesOrder records it, then approves
            const nativeRefusal = native(users.salesApprover, "mantle.order.OrderServices.approve#Order", {orderId: storeless})
            const approveKey = key("approve")
            const approved = as(users.salesApprover, orders + "approve#SalesOrder", {
                orderId: store,
                orderRevision: revision(store),
                operationKey: approveKey
            })
            const again = as(users.salesApprover, orders + "approve#SalesOrder", {
                orderId: store,
                orderRevision: revision(store),
                operationKey: approveKey
            })
            const stale = as(users.salesApprover, orders + "approve#SalesOrder", {orderId: storeless, orderRevision: 999}).refused
            const second = as(users.salesApprover, orders + "approve#SalesOrder", {
                orderId: storeless,
                orderRevision: revision(storeless)
            })
            // no self-approval (Sales P11 review): an approver who owns, entered and placed the order may not decide its rule
            const ownerApprover = system(() =>
                user("ownerapprover", [f.orgA], ["SALES_VIEW", "SALES_ORDER_EDIT", "SALES_ORDER_APPROVE"])
            )
            const own = as(ownerApprover, orders + "create#SalesOrder", {
                organizationPartyId: f.orgA,
                customerPartyId: f.accounts.a
            }).orderId
            as(ownerApprover, orders + "store#SalesOrderLine", {
                orderId: own,
                orderRevision: revision(own),
                productId: f.product,
                quantity: 1
            })
            as(ownerApprover, orders + "place#SalesOrder", {orderId: own, orderRevision: revision(own)})
            const self = as(ownerApprover, orders + "approve#SalesOrder", {orderId: own, orderRevision: revision(own)}).refused
            const selfStatus = status(own)
            // Sales P12 (the user's call of Nov 14): the approver keeps read-only sight of the order they decided once approved, not
            // of the organization's other approved orders (the first feature's, approved with no decision of theirs)
            const decided = as(users.salesApprover, orders + "get#SalesOrder", {orderId: store})
            const undecided = as(users.salesApprover, orders + "get#SalesOrder", {orderId: f.gated})
            const listed = as(users.salesApprover, "mantle.sales.SalesWorkspaceServices.find#SalesOrders", {
                list: "recent"
            }).orderList.map(row => row.orderId)
            // with it off a store order auto-approves as before
            const offStore = paidOrder(f.orgB, f.accounts.b2, f.orgB + "_STORE")
            const offWarnings = system(() =>
                Array.from(
                    call("mantle.order.OrderInfoServices.check#OrderPreApprove", {orderId: offStore}).approveWarnings || []
                )
            )
            return {
                before,
                detail,
                nativeRefusal,
                approved,
                again,
                stale,
                second,
                offStatus: status(offStore),
                offWarnings,
                storeStatus: status(store),
                self,
                selfStatus,
                decided,
                undecided,
                listed,
                store,
                gatedStatus: status(f.gated)
            }
        },
        then({
            before,
            detail,
            nativeRefusal,
            approved,
            again,
            stale,
            second,
            offStatus,
            offWarnings,
            storeStatus,
            self,
            selfStatus,
            decided,
            undecided,
            listed,
            store,
            gatedStatus
        }) {
            before.store == "OrderPlaced" && before.storeless == "OrderPlaced" && before.authorized == 2
            detail.orderFound && detail.order.approverOnly == true && detail.can.approve == true
            detail.approval.gateOn == true && detail.approval.requirements[0].ruleTypeEnumId == "SarAmount"
            detail.approval.requirements[0].state == "required"
            detail.warnings.some(warning => warning.startsWith("Sales order approval needed"))
            nativeRefusal.includes("SALES_APPROVAL_REQUIRED")
            approved.refused == "" &&
                approved.outcome == "approved" &&
                approved.decidedCount == 1 &&
                storeStatus == "OrderApproved"
            again.alreadyApplied == true && again.outcome == "approved"
            stale.includes("REVISION_CHANGED")
            second.refused == "" && second.outcome == "approved"
            offWarnings.length == 0 && offStatus == "OrderApproved"
            self.includes("SELF_APPROVAL") && selfStatus == "OrderPlaced"
            decided.orderFound && decided.order.approverOnly == true && decided.can.cancelRemainder == false
            gatedStatus == "OrderApproved" && undecided.orderFound == false
            listed.includes(store) && !listed.includes(f.gated)
        }
    }
)

feature(
    "a batch approval credit-holds the order over its limit and approves the rest; another organization's hold is not released",
    {
        when() {
            const within = placedOrder(f.orgB, f.accounts.b)
            const over = placedOrder(f.orgB, f.accounts.b2, 3)
            system(() =>
                call("mantle.account.CreditServices.store#Policy", {
                    organizationPartyId: f.orgB,
                    customerPartyId: f.accounts.b2,
                    creditLimit: 20,
                    actionEnumId: "CpaHold",
                    changeReason: "Credit review"
                })
            )
            const batch = as(users.approverB, orders + "apply#SalesOrderBatch", {
                operation: "approve",
                orderKeys: [within + "@" + revision(within), over + "@" + revision(over)],
                operationKey: key("batch")
            })
            const results = Object.fromEntries(Array.from(batch.results || []).map(row => [row.orderId, row]))
            // a Manual hold of B's approver on the approved order; A's order approver (not of B) cannot release it, natively or in Sales
            const held = as(users.approverB, orders + "hold#SalesOrder", {
                orderId: within,
                holdTypeEnumId: "OhtManual",
                holdComment: "Check the address"
            })
            const outsider = system(() => user("outsider", [f.orgA], ["SALES_VIEW", "ORDER_APPROVE"]))
            const nativeRelease = native(outsider, "mantle.order.OrderServices.release#OrderHold", {
                orderHoldReasonId: held.orderHoldReasonId,
                releaseComment: "Not mine"
            })
            const salesRelease = as(outsider, orders + "release#SalesOrderHold", {
                orderHoldReasonId: held.orderHoldReasonId,
                releaseComment: "Not mine"
            }).refused
            const creditHold = system(() =>
                ec.entity.find("mantle.order.OrderHoldReason").condition({orderId: over, holdTypeEnumId: "OhtCredit"}).one()
            )
            const creditRelease = as(users.approverB, orders + "release#SalesOrderHold", {
                orderHoldReasonId: creditHold?.orderHoldReasonId,
                releaseComment: "Released"
            }).refused
            const released = as(users.approverB, orders + "release#SalesOrderHold", {
                orderHoldReasonId: held.orderHoldReasonId,
                releaseComment: "Address confirmed"
            })
            return {within, over, results, batch, held, nativeRelease, salesRelease, creditRelease, released}
        },
        then({within, over, results, batch, held, nativeRelease, salesRelease, creditRelease, released}) {
            Array.from(batch.results || [])
                .filter(row => !row.ok)
                .map(row => row.reasonCode + " " + row.message)
                .join("; ") == ""
            batch.successCount == 2
            results[within].outcome == "approved"
            results[over].outcome == "held"
            held.statusId == "OrderHold"
            nativeRelease.includes("HOLD_UNAVAILABLE")
            salesRelease.includes("HOLD_UNAVAILABLE")
            creditRelease.includes("HOLD_TYPE_DENIED")
            released.refused == "" && released.statusId == "OrderApproved"
        }
    }
)

feature("an accepted net-terms quote under the seller's option is approved through approve#Order and held by the credit check", {
    when() {
        setting(f.orgC, {approveNetTermsOrders: "Y"})
        system(() => {
            fx.email(f.accounts.c, "buyer@account-c.example.test")
            call("mantle.account.CreditServices.store#Policy", {
                organizationPartyId: f.orgC,
                customerPartyId: f.accounts.c,
                creditLimit: 20,
                actionEnumId: "CpaHold",
                changeReason: "Credit review"
            })
        })
        const {orderId} = fx.proposedQuote(f, users.seller, f.orgC, f.accounts.c, null)
        const sent = as(users.seller, "send#Quote", {orderId, orderRevision: revision(orderId), operationKey: key("send")})
        const accepted = as(users.seller, "respond#Quote", {
            orderId,
            responseType: "accept",
            contactPartyId: f.accounts.c,
            operationKey: key("accept")
        })
        const holds = system(() =>
            ec.entity.find("mantle.order.OrderHoldReason").condition({orderId, holdTypeEnumId: "OhtCredit"}).count()
        )
        // the system claim is the one order's, cleared once its approval returns (Sales P11 review)
        const claimLeft = "SalesSystemApproval" in ec.context.sharedMap
        return {sent, accepted, holds, statusId: status(orderId), claimLeft}
    },
    then({sent, accepted, holds, statusId, claimLeft}) {
        sent.refused == ""
        accepted.refused == "" && accepted.outcome == "held"
        holds == 1 && statusId == "OrderHold"
        claimLeft == false
    }
})
