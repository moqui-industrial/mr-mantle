// Purchase orders (impl-purchasing P3; design-purchasing §6, F33, F36, F42): the buyer's verbs under PURCHASE_ORDER_EDIT in
// the buying organization (a draft from a supplier at its price, a line's product usable for buying, the policy's supplier
// stop, place, cancel and clone); the approval gate behind the buying policy's flag, off by default so a direct
// approve#Order keeps working, and on: a placed prepaid order is not auto-approved, approve#Order is refused without a
// current decision, the placer may not decide it and an approver's decision at the revision approves it; the hold a buyer
// places and only a purchase approver releases; the commercial revision behind its flag; the send of the PDF to the
// supplier's order address once per revision; and the print as of a time from the audit log. Standalone: a spec-local
// organization, suppliers, products, groups and users, with artifact authorization disabled (the rules are the services'
// own permission checks). Run: ./moq test mr-mantle --spec PurchaseOrders
const prefix = "PUR_ORDER_SPEC"
const org = prefix + "_ORG",
    otherOrg = prefix + "_OTHER_ORG",
    supplier = prefix + "_SUPPLIER",
    blocked = prefix + "_BLOCKED",
    otherSupplier = prefix + "_OTHER_SUPPLIER",
    product = prefix + "_PRODUCT",
    obsolete = prefix + "_OBSOLETE",
    since = "2000-01-01T00:00:00Z",
    template = prefix + "_EMAIL"
const P = "mantle.order.PurchaseServices.",
    O = "mantle.order.OrderServices."
const capture = ec.factory.getTool("MailCapture")
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const state = {}
let keySeq = 0
const key = () => prefix + "-" + ++keySeq

// a call as a user: its result with its error text ("" when it succeeds), in its own transaction
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
function user(kind, permissions, organizationPartyId = org) {
    const id = prefix + "_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Purchase order " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId: id, firstName: "Order", lastName: kind})
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
function organization(partyId, name, roleTypeId, ownerPartyId) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: ownerPartyId || null})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId})
}
function email(partyId, address, purpose) {
    const contactMechId = partyId + "_" + purpose
    call("create#mantle.party.contact.ContactMech", {
        contactMechId,
        contactMechTypeEnumId: "CmtEmailAddress",
        infoString: address
    })
    call("create#mantle.party.contact.PartyContactMech", {partyId, contactMechId, contactMechPurposeId: purpose, fromDate: since})
}
// a placed order of the buyer: a draft with one line of the spec product, placed
function placedOrder(buyer, quantity = 4) {
    const created = run(buyer, P + "create#PurchaseOrder", {organizationPartyId: org, vendorPartyId: supplier})
    run(buyer, P + "store#PurchaseOrderItem", {orderId: created.orderId, productId: product, quantity})
    run(buyer, P + "place#PurchaseOrder", {orderId: created.orderId})
    return created.orderId
}
const statusOf = orderId => one("mantle.order.OrderHeader", {orderId}).statusId
const revisionOf = orderId => Number(one("mantle.order.OrderHeader", {orderId}).orderRevision)
function policy(values) {
    // the organization's buying policy from a moment ago, ending the one in effect (the spec's own rows)
    const now = Number(ec.user.nowTimestamp)
    for (const row of rows("mantle.order.purchase.PurchasePolicy", {organizationPartyId: org}).filter(row => !row.thruDate))
        call("update#mantle.order.purchase.PurchasePolicy", {organizationPartyId: org, fromDate: row.fromDate, thruDate: now - 1})
    call(
        "create#mantle.order.purchase.PurchasePolicy",
        Object.assign({organizationPartyId: org, fromDate: now - 1, changeReason: "Spec"}, values)
    )
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(org, "Purchase Order Spec Org", "OrgInternal")
        organization(otherOrg, "Purchase Order Spec Other Org", "OrgInternal")
        call("create#mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: org, baseCurrencyUomId: "USD"})
        organization(supplier, "Order Spec Supplier", "Supplier", org)
        organization(blocked, "Order Spec Blocked", "Supplier", org)
        organization(otherSupplier, "Order Spec Other Supplier", "Supplier", otherOrg)
        email(supplier, "orders@order-spec.example.com", "EmailOrder")
        email(supplier, "info@order-spec.example.com", "EmailPrimary")
        email(org, "buying@order-spec.example.com", "EmailPrimary")
        // a mail server and template of the spec's own: the capture keeps what is sent, nothing connects
        call("create#moqui.basic.email.EmailServer", {
            emailServerId: prefix + "_SMTP",
            smtpHost: "127.0.0.1",
            smtpPort: "9",
            smtpStartTls: "N",
            smtpSsl: "N"
        })
        call("create#moqui.basic.email.EmailTemplate", {
            emailTemplateId: template,
            description: "Spec purchase order",
            emailServerId: prefix + "_SMTP",
            fromAddress: "${fromAddress}",
            subject: "${subject}"
        })
        call("create#mantle.party.supplier.SupplierProfile", {
            organizationPartyId: org,
            supplierPartyId: blocked,
            fromDate: since,
            purchaseBlockFromDate: since,
            purchaseBlockReason: "Quality hold"
        })
        for (const [productId, statusId] of [
            [product, "PrdActive"],
            [obsolete, "PrdObsolete"]
        ]) {
            call("create#mantle.product.Product", {
                productId,
                productName: productId,
                productTypeEnumId: "PtAsset",
                assetTypeEnumId: "AstTpInventory",
                amountUomId: "OTH_ea",
                ownerPartyId: org,
                statusId
            })
            call("create#mantle.product.ProductPrice", {
                productId,
                vendorPartyId: supplier,
                pricePurposeEnumId: "PppPurchase",
                priceTypeEnumId: "PptCurrent",
                fromDate: since,
                minQuantity: 1,
                price: 7.5,
                priceUomId: "USD"
            })
        }
        state.buyer = user("BUYER", ["PURCHASE_ORDER_EDIT", "SUPPLIER_PRICE_VIEW"])
        state.approver = user("APPROVER", ["PURCHASE_APPROVE", "PURCHASE_ORDER_APPROVE", "PURCHASE_HOLD_RELEASE"])
        state.buyerApprover = user("BUYAPPROVE", [
            "PURCHASE_ORDER_EDIT",
            "SUPPLIER_PRICE_VIEW",
            "PURCHASE_APPROVE",
            "PURCHASE_ORDER_APPROVE"
        ])
        state.orderApprover = user("ORDERAPPROVE", ["ORDER_APPROVE"])
        state.reader = user("READER", ["PURCHASE_APPROVE"], otherOrg)
        state.none = user("NONE", [])
        capture.enable()
    },
    cleanupSpec() {
        capture.reset()
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature(
    "a buyer creates a draft from the supplier and adds a line at its price; an obsolete product, a blocked or another organization's supplier and a user without PURCHASE_ORDER_EDIT are refused",
    {
        when() {
            const created = run(state.buyer, P + "create#PurchaseOrder", {
                organizationPartyId: org,
                vendorPartyId: supplier,
                orderName: "Spec draft"
            })
            const line = run(state.buyer, P + "store#PurchaseOrderItem", {
                orderId: created.orderId,
                productId: product,
                quantity: 3,
                costCenterId: org
            })
            const obsoleteLine = run(state.buyer, P + "store#PurchaseOrderItem", {
                orderId: created.orderId,
                productId: obsolete,
                quantity: 1
            })
            const blockedOrder = run(state.buyer, P + "create#PurchaseOrder", {organizationPartyId: org, vendorPartyId: blocked})
            const otherOrder = run(state.buyer, P + "create#PurchaseOrder", {
                organizationPartyId: org,
                vendorPartyId: otherSupplier
            })
            const otherOrgOrder = run(state.buyer, P + "create#PurchaseOrder", {
                organizationPartyId: otherOrg,
                vendorPartyId: supplier
            })
            const noPermission = run(state.none, P + "create#PurchaseOrder", {organizationPartyId: org, vendorPartyId: supplier})
            const outsider = run(state.reader, P + "place#PurchaseOrder", {orderId: created.orderId})
            state.draftId = created.orderId
            const item = one("mantle.order.OrderItem", {orderId: created.orderId, orderItemSeqId: line.orderItemSeqId})
            const part = one("mantle.order.OrderPart", {orderId: created.orderId, orderPartSeqId: "01"})
            return {created, line, obsoleteLine, blockedOrder, otherOrder, otherOrgOrder, noPermission, outsider, item, part}
        },
        then({created, line, obsoleteLine, blockedOrder, otherOrder, otherOrgOrder, noPermission, outsider, item, part}) {
            created.error == ""
            line.error == ""
            part.customerPartyId == org
            part.vendorPartyId == supplier
            item.unitAmount == 7.5
            item.costCenterId == org
            obsoleteLine.error.includes("PRODUCT_NOT_USABLE")
            obsoleteLine.error.includes("Obsolete product")
            blockedOrder.error.includes("SUPPLIER_BLOCKED")
            otherOrder.error.includes("SUPPLIER_UNAVAILABLE")
            otherOrgOrder.error.includes("RECORD_UNAVAILABLE")
            noPermission.error.includes("PERMISSION_DENIED")
            outsider.error.includes("PERMISSION_DENIED") || outsider.error.includes("RECORD_UNAVAILABLE")
        }
    }
)

feature(
    "with the approval gate off (no policy row) Mantle's approval is unchanged: an ORDER_APPROVE holder approves a placed purchase order directly",
    {
        when() {
            const orderId = placedOrder(state.buyer)
            const placed = statusOf(orderId)
            const approved = run(state.orderApprover, O + "approve#Order", {orderId})
            const noPermission = run(state.none, O + "approve#Order", {orderId: placedOrder(state.buyer)})
            return {placed, approved, status: statusOf(orderId), noPermission}
        },
        then({placed, approved, status, noPermission}) {
            placed == "OrderPlaced"
            approved.error == ""
            status == "OrderApproved"
            noPermission.error.includes("Order Approve permission required")
        }
    }
)

feature(
    "with the gate on a placed prepaid order is not auto-approved; approve#Order needs PURCHASE_ORDER_APPROVE and a decision; its placer may not decide it; an approver decides it at its revision",
    {
        given() {
            policy({approvalGateEnabled: "Y", commercialRevisionOnly: "Y"})
        },
        when() {
            const created = run(state.buyerApprover, P + "create#PurchaseOrder", {
                organizationPartyId: org,
                vendorPartyId: supplier
            })
            const orderId = created.orderId
            run(state.buyerApprover, P + "store#PurchaseOrderItem", {orderId, productId: product, quantity: 2})
            const total = one("mantle.order.OrderHeader", {orderId}).grandTotal
            call("create#mantle.account.payment.Payment", {
                orderId,
                orderPartSeqId: "01",
                statusId: "PmntAuthorized",
                amount: total,
                amountUomId: "USD",
                fromPartyId: org,
                toPartyId: supplier
            })
            run(state.buyerApprover, P + "place#PurchaseOrder", {orderId})
            const placed = statusOf(orderId)
            const orderApprove = run(state.orderApprover, O + "approve#Order", {orderId})
            const undecided = run(state.approver, O + "approve#Order", {orderId})
            const self = run(state.buyerApprover, P + "decide#PurchaseApproval", {orderId})
            const stale = run(state.approver, P + "decide#PurchaseApproval", {orderId, orderRevision: revisionOf(orderId) + 1})
            const decided = run(state.approver, P + "decide#PurchaseApproval", {
                orderId,
                orderRevision: revisionOf(orderId),
                operationKey: key()
            })
            const decision = rows("mantle.order.purchase.PurchaseApprovalDecision", {sourceId: orderId})[0]
            state.approvedId = orderId
            return {placed, orderApprove, undecided, self, stale, decided, decision, status: statusOf(orderId)}
        },
        then({placed, orderApprove, undecided, self, stale, decided, decision, status}) {
            placed == "OrderPlaced"
            orderApprove.error.includes("PURCHASE_ORDER_APPROVE")
            undecided.error.includes("PURCHASE_APPROVAL_REQUIRED")
            self.error.includes("SELF_APPROVAL")
            stale.error.includes("STALE_REVISION")
            decided.error == ""
            decided.statusId == "OrderApproved"
            decision.decisionEnumId == "PadApproved"
            decision.decidedByUserId == state.approver
            status == "OrderApproved"
        }
    }
)

feature(
    "a buyer holds the sent order, which un-sends it, and cannot release it; a purchase approver releases it to Approved and another order's credit hold stays",
    {
        when() {
            const orderId = state.approvedId
            call(O + "update#OrderStatus", {orderId, statusId: "OrderSent"})
            const held = run(state.buyer, O + "hold#Order", {
                orderId,
                holdTypeEnumId: "OhtPurchase",
                holdComment: "Supplier price check"
            })
            const heldStatus = statusOf(orderId)
            const buyerRelease = run(state.buyer, O + "release#OrderHold", {
                orderHoldReasonId: held.orderHoldReasonId,
                releaseComment: "Done"
            })
            const otherHold = call("create#mantle.order.OrderHoldReason", {
                orderId: state.draftId,
                holdTypeEnumId: "OhtCredit",
                returnStatusId: "OrderOpen",
                placedDate: ec.user.nowTimestamp
            }).orderHoldReasonId
            const released = run(state.approver, O + "release#OrderHold", {
                orderHoldReasonId: held.orderHoldReasonId,
                releaseComment: "Price confirmed"
            })
            const manual = run(state.buyer, O + "hold#Order", {orderId, holdTypeEnumId: "OhtManual"})
            return {
                held,
                heldStatus,
                buyerRelease,
                released,
                status: statusOf(orderId),
                other: one("mantle.order.OrderHoldReason", {orderHoldReasonId: otherHold}),
                manual
            }
        },
        then({held, heldStatus, buyerRelease, released, status, other, manual}) {
            held.error == ""
            heldStatus == "OrderHold"
            buyerRelease.error.includes("PURCHASE_HOLD_RELEASE")
            released.error == ""
            status == "OrderApproved"
            other.releasedDate == null
            manual.error.includes("PERMISSION_DENIED")
        }
    }
)

feature(
    "send mails the PDF to the supplier's order address, stores it on the order and marks it Sent; a second send of the revision mails no one",
    {
        when() {
            const orderId = state.approvedId
            const revision = revisionOf(orderId)
            capture.clear()
            state.sendRequest = {orderId, orderRevision: revision, operationKey: key(), emailTemplateId: template}
            const first = run(state.buyer, O + "send#PurchaseOrder", state.sendRequest)
            const message = capture.last()
            const sentCount = capture.count()
            const replayKey = key()
            const second = run(state.buyer, O + "send#PurchaseOrder", {
                orderId,
                operationKey: replayKey,
                emailTemplateId: template
            })
            const after = capture.count()
            const issued = rows("mantle.order.OrderContent", {orderId}).filter(
                row => row.orderContentTypeEnumId == "OctPurchaseOrderIssued"
            )
            const emails = rows("mantle.order.OrderEmailMessage", {orderId})
            const notApproved = run(state.buyer, O + "send#PurchaseOrder", {orderId: state.draftId, operationKey: key()})
            return {
                revision,
                first,
                message,
                sentCount,
                second,
                after,
                issued,
                emails,
                status: statusOf(orderId),
                revisionAfter: revisionOf(orderId),
                notApproved
            }
        },
        then({revision, first, message, sentCount, second, after, issued, emails, status, revisionAfter, notApproved}) {
            first.error == ""
            first.successCount == 1
            message.toList.includes("orders@order-spec.example.com")
            message.attachmentNames.some(name => name.endsWith(".pdf"))
            sentCount == 1
            status == "OrderSent"
            issued.length == 1
            emails.length == 1
            emails[0].orderRevision == revision
            // the commercial revision: the stored PDF and the status change did not move it, so the second send skips
            revisionAfter == revision
            second.error == ""
            second.recipientResults[0].reasonCode == "ALREADY_SENT"
            after == sentCount
            notApproved.error.includes("ORDER_SEND_STATE")
        }
    }
)

feature(
    "the commercial revision: a note keeps the revision where the flag is on and moves it where it is off (Mantle's default), while the issued PDF and Approved to Sent never move it; a send's retry still answers its first result",
    {
        when() {
            const orderId = state.approvedId
            const before = revisionOf(orderId)
            call("create#mantle.order.OrderNote", {orderId, noteDate: ec.user.nowTimestamp, noteText: "Flag on"})
            const flagOn = revisionOf(orderId)
            policy({approvalGateEnabled: "N", commercialRevisionOnly: "N"})
            call("create#mantle.order.OrderNote", {orderId, noteDate: Number(ec.user.nowTimestamp) + 1, noteText: "Flag off"})
            const flagOff = revisionOf(orderId)
            // with the flag off, the send's own writes still do not count: the issued PDF, and Approved to Sent after an
            // un-send (which, a status change, counts)
            call("create#mantle.order.OrderContent", {
                orderId,
                orderContentTypeEnumId: "OctPurchaseOrderIssued",
                contentLocation: "dbresource://mantle/spec/issued-again.pdf",
                contentDate: ec.user.nowTimestamp
            })
            const issuedOff = revisionOf(orderId)
            const partSeqId = rows("mantle.order.OrderPart", {orderId})[0].orderPartSeqId
            call("mantle.order.OrderServices.update#OrderStatus", {orderId, orderPartSeqId: partSeqId, statusId: "OrderApproved"})
            const unsent = revisionOf(orderId)
            call("mantle.order.OrderServices.update#OrderStatus", {orderId, orderPartSeqId: partSeqId, statusId: "OrderSent"})
            const resent = revisionOf(orderId)
            // a retry of the first send answers its result, though the revision it named has moved on since
            capture.clear()
            const replay = run(state.buyer, O + "send#PurchaseOrder", state.sendRequest)
            const replayMails = capture.count()
            const audit = rows("moqui.entity.EntityAuditLog", {
                changedEntityName: "mantle.order.OrderHeader",
                changedFieldName: "orderRevision",
                pkPrimaryValue: orderId
            })
            return {before, flagOn, flagOff, issuedOff, unsent, resent, replay, replayMails, audit}
        },
        then({before, flagOn, flagOff, issuedOff, unsent, resent, replay, replayMails, audit}) {
            flagOn == before
            flagOff == before + 1
            issuedOff == flagOff
            unsent == flagOff + 1
            resent == unsent
            replay.error == ""
            replay.alreadyApplied == true
            replay.successCount == 1
            replayMails == 0
            audit.some(row => Number(row.newValueText) == before + 1)
        }
    }
)

feature("the print as of a time reads a line's earlier quantity, unit and description back from the audit log", {
    when() {
        const orderId = state.draftId
        const item = rows("mantle.order.OrderItem", {orderId})[0]
        const before = Number(ec.user.nowTimestamp)
        ec.user.setEffectiveTime(before + 60000)
        const changed = run(state.buyer, P + "store#PurchaseOrderItem", {
            orderId,
            orderItemSeqId: item.orderItemSeqId,
            quantity: 9,
            quantityUomId: "OTH_ct",
            itemDescription: "Spec boxes"
        })
        ec.user.setEffectiveTime(before + 120000)
        const asOf = run(state.buyer, O + "get#PurchaseOrderPrint", {orderId, asOfDate: before + 30000})
        const current = run(state.buyer, O + "get#PurchaseOrderPrint", {orderId})
        const outsider = run(state.reader, O + "get#PurchaseOrderPrint", {orderId})
        ec.user.setEffectiveTime(null)
        const audit = rows("moqui.entity.EntityAuditLog", {
            changedEntityName: "mantle.order.OrderItem",
            pkPrimaryValue: orderId
        }).map(row => row.changedFieldName)
        return {changed, asOf, current, outsider, audit}
    },
    then({changed, asOf, current, outsider, audit}) {
        changed.error == ""
        asOf.error == ""
        asOf.printHtml.includes(">3 ")
        !asOf.printHtml.includes("Spec boxes")
        current.printHtml.includes(">9 ")
        current.printHtml.includes("Spec boxes")
        audit.includes("quantityUomId")
        audit.includes("itemDescription")
        outsider.error.includes("RECORD_UNAVAILABLE")
    }
})

feature("cancel refuses without a reason and cancels with one; clone makes a new draft of the lines", {
    when() {
        const orderId = state.draftId
        const noReason = run(state.buyer, P + "cancel#PurchaseOrder", {orderId})
        const cloned = run(state.buyer, P + "clone#PurchaseOrder", {orderId})
        const cancelled = run(state.buyer, P + "cancel#PurchaseOrder", {orderId, reason: "Not needed"})
        return {
            noReason,
            cloned,
            cancelled,
            clonedStatus: statusOf(cloned.orderId),
            clonedLines: rows("mantle.order.OrderItem", {orderId: cloned.orderId}).length
        }
    },
    then({noReason, cloned, cancelled, clonedStatus, clonedLines}) {
        noReason.error.includes("REASON_REQUIRED")
        cloned.error == ""
        clonedStatus == "OrderOpen"
        clonedLines == 1
        cancelled.error == ""
        cancelled.statusId == "OrderCancelled"
    }
})
