// Purchase order revisions and acknowledgements (impl-purchasing P9; design-purchasing §6 OrderChanges and Acknowledgements):
// a buyer starts a change of a sent, partly received order (a Change hold, un-sent first) and lets an unapplied one go; the
// preview names a cut below the received quantity, a supplier change on a received part and a substitute the policy does not
// allow; a receipt posted since the preview fails the apply (RECEIPT_IN_PROGRESS) and nothing changes; the apply writes the
// lower quantity with its reason in the audit log, counts the next revision once, sets the open receipt to the new remainder and
// releases the lowered line's budget commitment to what it still needs; the approval of the new revision releases the hold to
// Approved, the resend stores its PDF, and the print as of before it shows the earlier revision's quantity; the supplier's
// acknowledgement with a later promised date keeps the requested date and moves no revision, and an older revision is refused;
// reminders to three suppliers with one bad address name it, send the other two, and send no one twice for the occurrence;
// (P17, F118) a currency change with a line's amount is refused, and an applied revision awaiting approval is neither
// acknowledged nor reminded.
// Standalone: a spec-local organization, suppliers, product, users and mail templates, with artifact authorization disabled
// (the rules are the services' own permission checks). Run: ./moq test mr-mantle --spec PurchaseRevisions
const prefix = "PUR_REV_SPEC"
const org = prefix + "_ORG",
    supplier = prefix + "_SUPPLIER",
    second = prefix + "_SECOND",
    third = prefix + "_THIRD",
    bad = prefix + "_BAD",
    product = prefix + "_PRODUCT",
    substitute = prefix + "_SUBSTITUTE",
    since = "2000-01-01T00:00:00Z",
    template = prefix + "_EMAIL",
    reminderTemplate = prefix + "_REMINDER"
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
function user(kind, permissions) {
    const id = prefix + "_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Purchase revision " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId: id, firstName: "Revision", lastName: kind})
    call("create#mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtAgent",
        fromPartyId: id,
        toPartyId: org,
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
// an order from the supplier, placed, then approved and sent as the spec's own setup (the approval is PurchaseOrders')
function sentOrder(vendorPartyId, quantity) {
    const created = run(state.buyer, P + "create#PurchaseOrder", {organizationPartyId: org, vendorPartyId})
    run(state.buyer, P + "store#PurchaseOrderItem", {orderId: created.orderId, productId: product, quantity})
    run(state.buyer, P + "place#PurchaseOrder", {orderId: created.orderId})
    call(O + "update#OrderStatus", {orderId: created.orderId, statusId: "OrderApproved"})
    call(O + "update#OrderStatus", {orderId: created.orderId, statusId: "OrderSent"})
    return created.orderId
}
const statusOf = orderId => one("mantle.order.OrderHeader", {orderId}).statusId
const revisionOf = orderId => Number(one("mantle.order.OrderHeader", {orderId}).orderRevision)
const itemOf = orderId => one("mantle.order.OrderItem", {orderId, orderItemSeqId: "01"})
const sourceOf = id => one("mantle.shipment.ShipmentItemSource", {shipmentItemSourceId: id})
// units received on the order's line on its receipt (a receipt row, as the receive guard writes it)
function receive(orderId, quantity) {
    // the row alone (the receive's own posting needs an asset, which the revision does not read)
    const value = ec.entity.makeValue("mantle.product.receipt.AssetReceipt")
    const fields = {
        assetReceiptId: prefix + "_RCPT_" + ++keySeq,
        productId: product,
        orderId,
        orderItemSeqId: "01",
        shipmentId: state.shipmentId,
        shipmentItemSourceId: state.sourceId,
        quantityAccepted: quantity,
        receivedDate: ec.user.nowTimestamp
    }
    for (const [field, input] of Object.entries(fields)) value.set(field, input)
    value.create()
}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(org, "Purchase Revision Spec Org", "OrgInternal")
        call("create#mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: org, baseCurrencyUomId: "USD"})
        organization(supplier, "Revision Spec Supplier", "Supplier", org)
        organization(second, "Revision Spec Second", "Supplier", org)
        organization(third, "Revision Spec Third", "Supplier", org)
        organization(bad, "Revision Spec Bad Address", "Supplier", org)
        email(supplier, "orders@revision-spec.example.com", "EmailOrder")
        email(second, "orders@second.revision-spec.example.com", "EmailOrder")
        email(third, "orders@third.revision-spec.example.com", "EmailOrder")
        email(bad, "orders at nowhere", "EmailOrder")
        email(org, "buying@revision-spec.example.com", "EmailPrimary")
        call("create#moqui.basic.email.EmailServer", {
            emailServerId: prefix + "_SMTP",
            smtpHost: "127.0.0.1",
            smtpPort: "9",
            smtpStartTls: "N",
            smtpSsl: "N"
        })
        for (const emailTemplateId of [template, reminderTemplate])
            call("create#moqui.basic.email.EmailTemplate", {
                emailTemplateId,
                description: "Spec " + emailTemplateId,
                emailServerId: prefix + "_SMTP",
                fromAddress: "${fromAddress}",
                subject: "${subject}"
            })
        for (const productId of [product, substitute]) {
            call("create#mantle.product.Product", {
                productId,
                productName: productId,
                productTypeEnumId: "PtAsset",
                assetTypeEnumId: "AstTpInventory",
                amountUomId: "OTH_ea",
                ownerPartyId: org,
                statusId: "PrdActive"
            })
            for (const vendorPartyId of [supplier, second, third, bad])
                call("create#mantle.product.ProductPrice", {
                    productId,
                    vendorPartyId,
                    pricePurposeEnumId: "PppPurchase",
                    priceTypeEnumId: "PptCurrent",
                    fromDate: since,
                    minQuantity: 1,
                    price: 7.5,
                    priceUomId: "USD"
                })
        }
        // the organization counts commercial changes only, so a status, file or note moves no revision
        call("create#mantle.order.purchase.PurchasePolicy", {
            organizationPartyId: org,
            fromDate: Number(ec.user.nowTimestamp) - 1000,
            commercialRevisionOnly: "Y",
            changeReason: "Spec"
        })
        state.buyer = user("BUYER", ["PURCHASE_ORDER_EDIT", "SUPPLIER_PRICE_VIEW"])
        state.approver = user("APPROVER", ["PURCHASE_APPROVE", "PURCHASE_ORDER_APPROVE"])
        state.none = user("NONE", [])
        capture.enable()

        // the sent order: ten units, four received on its open receipt, its line's budget commitment held at its revision
        state.orderId = sentOrder(supplier, 10)
        state.shipmentId = call("create#mantle.shipment.Shipment", {
            shipmentTypeEnumId: "ShpTpPurchase",
            statusId: "ShipScheduled",
            fromPartyId: supplier,
            toPartyId: org
        }).shipmentId
        call("create#mantle.shipment.ShipmentItem", {shipmentId: state.shipmentId, productId: product, quantity: 10})
        state.sourceId = call("create#mantle.shipment.ShipmentItemSource", {
            shipmentId: state.shipmentId,
            productId: product,
            orderId: state.orderId,
            orderItemSeqId: "01",
            quantity: 10,
            quantityNotHandled: 6,
            statusId: "SisPending"
        }).shipmentItemSourceId
        receive(state.orderId, 4)
        // the revision the order was sent at (its draft's line changes counted), and the one a change makes
        state.r1 = revisionOf(state.orderId)
        state.r2 = state.r1 + 1
        state.commitmentId = call("create#mantle.other.budget.BudgetCommitment", {
            organizationPartyId: org,
            sourceEntityName: "mantle.order.OrderHeader",
            sourceId: state.orderId,
            sourceItemId: "01",
            sourceRevision: String(state.r1),
            stageEnumId: "BcsOrder",
            amount: 75,
            currencyUomId: "USD",
            statusId: "BcReserved",
            decisionEnumId: "BcdWithin",
            createdDate: ec.user.nowTimestamp
        }).budgetCommitmentId
        state.sentAt = Number(ec.user.nowTimestamp)
    },
    cleanupSpec() {
        capture.reset()
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature(
    "a buyer starts a change of the sent order, which holds it with a Change reason; one without PURCHASE_ORDER_EDIT is refused, and a change nothing was applied under is let go, even when the order's count moved",
    {
        when() {
            const other = sentOrder(supplier, 2)
            const noPermission = run(state.none, O + "start#PurchaseRevision", {orderId: state.orderId, reason: "Cut"})
            const noReason = run(state.buyer, O + "start#PurchaseRevision", {orderId: state.orderId})
            const started = run(state.buyer, O + "start#PurchaseRevision", {
                orderId: state.orderId,
                orderRevision: state.r1,
                reason: "Customer cut the forecast"
            })
            const hold = one("mantle.order.OrderHoldReason", {orderHoldReasonId: started.orderHoldReasonId})
            const otherStarted = run(state.buyer, O + "start#PurchaseRevision", {orderId: other, reason: "Maybe"})
            const otherHeld = statusOf(other)
            // the order's count moving while the change is only started (by default a note or a receipt's status does) is
            // not an applied change: it is still let go
            call(O + "increment#OrderRevision", {orderId: other, revisionKind: "commercial"})
            const cancelled = run(state.buyer, O + "cancel#PurchaseRevision", {orderId: other})
            return {noPermission, noReason, started, hold, otherStarted, otherHeld, cancelled, other}
        },
        then({noPermission, noReason, started, hold, otherStarted, otherHeld, cancelled, other}) {
            noPermission.error.includes("PERMISSION_DENIED")
            noReason.error.includes("REASON_REQUIRED")
            started.error == ""
            statusOf(state.orderId) == "OrderHold"
            hold.holdTypeEnumId == "OhtChange"
            hold.sourceId == String(state.r1)
            hold.returnStatusId == "OrderApproved"
            revisionOf(state.orderId) == state.r1
            otherStarted.error == ""
            otherHeld == "OrderHold"
            cancelled.error == ""
            statusOf(other) == "OrderApproved"
        }
    }
)

feature(
    "the preview shows the received quantity and names a cut below it, a supplier change on the received part and a substitute the policy does not allow; an apply of the cut is refused",
    {
        when() {
            const cut = run(state.buyer, O + "preview#PurchaseRevision", {
                orderId: state.orderId,
                itemChanges: [{orderItemSeqId: "01", quantity: 3, productId: substitute}],
                partChanges: {vendorPartyId: second}
            })
            const refused = run(state.buyer, O + "apply#PurchaseRevision", {
                orderId: state.orderId,
                orderRevision: state.r1,
                itemChanges: [{orderItemSeqId: "01", quantity: 3}],
                reason: "Cut"
            })
            const lower = run(state.buyer, O + "preview#PurchaseRevision", {
                orderId: state.orderId,
                itemChanges: [{orderItemSeqId: "01", quantity: 8}]
            })
            state.basisKey = lower.basisKey
            const codes = cut.changeRows.map(row => row.refusalCode)
            // F118 (P17): the currency changes in a revision of its own
            const currency = run(state.buyer, O + "preview#PurchaseRevision", {
                orderId: state.orderId,
                itemChanges: [{orderItemSeqId: "01", quantity: 8}],
                partChanges: {currencyUomId: "EUR"}
            })
            return {cut, codes, refused, lower, currency}
        },
        then({cut, codes, refused, lower, currency}) {
            currency.changeRows.find(row => row.field == "currencyUomId").refusalCode == "CURRENCY_CHANGE_WITH_AMOUNTS"
            currency.canApply == false
            cut.error == ""
            cut.lineRows[0].receivedText == "4"
            cut.revisionState == "started"
            codes.includes("QUANTITY_BELOW_RECEIVED")
            codes.includes("SUBSTITUTION_NOT_ALLOWED")
            codes.includes("SUPPLIER_CHANGE_PROGRESSED")
            cut.canApply == false
            refused.error.includes("QUANTITY_BELOW_RECEIVED")
            itemOf(state.orderId).quantity == 10
            lower.canApply == true
            lower.proposedRevision == state.r2
            lower.budgetRows[0].toAmount == 60
        }
    }
)

feature("a receipt posted since the preview fails the apply with RECEIPT_IN_PROGRESS, and nothing changes", {
    when() {
        receive(state.orderId, 1)
        const failed = run(state.buyer, O + "apply#PurchaseRevision", {
            orderId: state.orderId,
            orderRevision: state.r1,
            basisKey: state.basisKey,
            itemChanges: [{orderItemSeqId: "01", quantity: 8}],
            reason: "Customer cut the forecast",
            operationKey: key()
        })
        return {failed}
    },
    then({failed}) {
        failed.error.includes("RECEIPT_IN_PROGRESS")
        itemOf(state.orderId).quantity == 10
        revisionOf(state.orderId) == state.r1
        sourceOf(state.sourceId).quantity == 10
    }
})

feature(
    "the apply writes the lower quantity with its reason, counts the next revision once, sets the open receipt to the new remainder and releases the lowered line's commitment to what it still needs; the order stays held for its approval",
    {
        when() {
            const reviewed = run(state.buyer, O + "preview#PurchaseRevision", {
                orderId: state.orderId,
                itemChanges: [{orderItemSeqId: "01", quantity: 8}]
            })
            state.applyRequest = {
                orderId: state.orderId,
                orderRevision: state.r1,
                basisKey: reviewed.basisKey,
                itemChanges: [{orderItemSeqId: "01", quantity: 8}],
                reason: "Customer cut the forecast",
                operationKey: key()
            }
            state.beforeApply = Number(ec.user.nowTimestamp) - 1
            const applied = run(state.buyer, O + "apply#PurchaseRevision", state.applyRequest)
            const replay = run(state.buyer, O + "apply#PurchaseRevision", state.applyRequest)
            const logged = rows("moqui.entity.EntityAuditLog", {
                changedEntityName: "mantle.order.OrderItem",
                changedFieldName: "quantity",
                pkPrimaryValue: state.orderId
            }).find(row => row.newValueText != null && Number(row.newValueText) === 8)
            const commitments = rows("mantle.other.budget.BudgetCommitment", {sourceId: state.orderId})
            // F118 (P17): the new revision waits for its approval, so it is neither acknowledged nor reminded
            const acknowledged = run(state.buyer, O + "record#Acknowledgement", {orderId: state.orderId})
            const reminded = run(state.buyer, O + "send#PurchaseReminder", {orderIds: [state.orderId], occurrence: "pending"})
            return {applied, replay, logged, commitments, acknowledged, reminded}
        },
        then({applied, replay, logged, commitments, acknowledged, reminded}) {
            acknowledged.error.includes("REVISION_PENDING")
            reminded.results[0].resultCode == "REVISION_PENDING"
            applied.error == ""
            applied.fromRevision == state.r1
            applied.orderRevision == state.r2
            revisionOf(state.orderId) == state.r2
            itemOf(state.orderId).quantity == 8
            logged.changeReason == "Customer cut the forecast"
            sourceOf(state.sourceId).quantity == 8
            sourceOf(state.sourceId).quantityNotHandled == 3
            commitments.find(row => row.budgetCommitmentId == state.commitmentId).statusId == "BcReleased"
            commitments.find(row => row.sourceRevision == String(state.r2)).amount == 60
            commitments.find(row => row.sourceRevision == String(state.r2)).statusId == "BcReserved"
            statusOf(state.orderId) == "OrderHold"
            replay.alreadyApplied == true
            replay.orderRevision == state.r2
        }
    }
)

feature(
    "the approval of the new revision releases the Change hold to Approved; the resend stores its PDF and mails it; the print as of before the apply shows the earlier revision's quantity",
    {
        when() {
            const stale = run(state.approver, P + "decide#PurchaseApproval", {orderId: state.orderId, orderRevision: state.r1})
            const decided = run(state.approver, P + "decide#PurchaseApproval", {
                orderId: state.orderId,
                orderRevision: state.r2,
                operationKey: key()
            })
            const approved = statusOf(state.orderId)
            capture.clear()
            const sent = run(state.buyer, O + "send#PurchaseOrder", {
                orderId: state.orderId,
                orderRevision: state.r2,
                operationKey: key(),
                emailTemplateId: template
            })
            const issued = rows("mantle.order.OrderContent", {orderId: state.orderId}).filter(
                row => row.orderContentTypeEnumId == "OctPurchaseOrderIssued"
            )
            const before = run(state.buyer, O + "get#PurchaseOrderPrint", {
                orderId: state.orderId,
                asOfDate: state.beforeApply
            })
            const now = run(state.buyer, O + "get#PurchaseOrderPrint", {orderId: state.orderId})
            const hold = rows("mantle.order.OrderHoldReason", {orderId: state.orderId}).find(
                row => row.holdTypeEnumId == "OhtChange"
            )
            return {stale, decided, approved, sent, issued, before, now, hold, mailed: capture.count()}
        },
        then({stale, decided, approved, sent, issued, before, now, hold, mailed}) {
            stale.error.includes("STALE_REVISION")
            decided.error == ""
            approved == "OrderApproved"
            hold.releasedDate != null
            hold.appliedRevision == state.r2
            sent.error == ""
            sent.orderRevision == state.r2
            mailed == 1
            statusOf(state.orderId) == "OrderSent"
            issued.length == 1
            issued[0].description.includes("revision " + state.r2)
            before.orderRevision == state.r1
            before.printHtml.includes(">10 ")
            now.orderRevision == state.r2
            now.printHtml.includes(">8 ")
            now.printHtml.includes("Customer cut the forecast")
        }
    }
)

feature(
    "the supplier's phone confirmation with a later promised date is recorded: the requested date stays, no revision moves and the history is the audit log; an older revision is refused naming the current one",
    {
        when() {
            const required = itemOf(state.orderId).requiredByDate
            const older = run(state.buyer, O + "record#Acknowledgement", {orderId: state.orderId, orderRevision: state.r1})
            const recorded = run(state.buyer, O + "record#Acknowledgement", {
                orderId: state.orderId,
                orderRevision: state.r2,
                otherPartyOrderId: "SO-4471",
                otherPartyOrderDate: ec.user.nowTimestamp,
                acknowledgementEnumId: "PakChanged",
                acknowledgementNote: "Second shift short of staff",
                lineAcknowledgements: [{orderItemSeqId: "01", promisedDate: "2099-03-15"}],
                evidenceText: "Phone call with the supplier's order desk"
            })
            const part = one("mantle.order.OrderPart", {orderId: state.orderId, orderPartSeqId: "01"})
            const promised = rows("moqui.entity.EntityAuditLog", {
                changedEntityName: "mantle.order.OrderItem",
                changedFieldName: "promisedDate",
                pkPrimaryValue: state.orderId
            })
            const evidence = rows("mantle.order.OrderContent", {orderId: state.orderId}).find(
                row => row.orderContentTypeEnumId == "OctSupplierAcknowledgement"
            )
            return {required, older, recorded, part, promised, evidence}
        },
        then({required, older, recorded, part, promised, evidence}) {
            older.error.includes("SUPERSEDED_REVISION")
            older.error.includes("revision " + state.r2)
            recorded.error == ""
            part.otherPartyOrderId == "SO-4471"
            part.acknowledgedRevision == state.r2
            part.acknowledgementEnumId == "PakChanged"
            itemOf(state.orderId).promisedDate != null
            itemOf(state.orderId).requiredByDate == required
            promised.length == 1
            promised[0].changeReason == "Second shift short of staff"
            evidence.roleTypeId == "Supplier"
            revisionOf(state.orderId) == state.r2
        }
    }
)

feature(
    "reminders to three suppliers with one bad address name it and send the other two; the same occurrence sends no one twice, and an acknowledged order is named",
    {
        when() {
            const orderIds = [sentOrder(second, 1), sentOrder(third, 1), sentOrder(bad, 1)]
            capture.clear()
            const first = run(state.buyer, O + "send#PurchaseReminder", {
                orderIds,
                occurrence: "spec-1",
                emailTemplateId: reminderTemplate
            })
            const mailed = capture.count()
            const again = run(state.buyer, O + "send#PurchaseReminder", {
                orderIds: orderIds.concat([state.orderId]),
                occurrence: "spec-1",
                emailTemplateId: reminderTemplate
            })
            const reminders = rows("mantle.order.OrderEmailMessage", {orderId: orderIds[0]}).filter(
                row => row.reminderOccurrence == "spec-1"
            )
            const codes = results => Object.fromEntries(results.map(row => [row.orderId, row.resultCode]))
            return {orderIds, first, mailed, again, reminders, firstCodes: codes(first.results), againCodes: codes(again.results)}
        },
        then({orderIds, first, mailed, again, reminders, firstCodes, againCodes}) {
            first.error == ""
            firstCodes[orderIds[0]] == "SENT"
            firstCodes[orderIds[1]] == "SENT"
            firstCodes[orderIds[2]] == "FAILED"
            first.results[2].recipientResults[0].reasonCode == "RECIPIENT_INVALID"
            first.sentCount == 2
            mailed == 2
            reminders.length == 1
            reminders[0].orderRevision == revisionOf(orderIds[0])
            againCodes[orderIds[0]] == "SKIPPED"
            againCodes[orderIds[1]] == "SKIPPED"
            againCodes[state.orderId] == "ALREADY_ACKNOWLEDGED"
            capture.count() == mailed
        }
    }
)

feature(
    "a draft's delivery date, payment term and incoterm are edited on it, logged for its print as of a time; an unknown term is refused",
    {
        when() {
            const orderId = run(state.buyer, P + "create#PurchaseOrder", {
                organizationPartyId: org,
                vendorPartyId: supplier
            }).orderId
            const term = find("mantle.account.invoice.SettlementTerm").list()[0]
            const incoterm = find("moqui.basic.Enumeration", {parentEnumId: "TtInco"}).list()[0]
            const edited = run(state.buyer, P + "update#PurchaseOrder", {
                orderId,
                estimatedDeliveryDate: "2099-04-01 00:00:00",
                settlementTermId: term.settlementTermId,
                tradeTermEnumId: incoterm.enumId
            })
            const unknown = run(state.buyer, P + "update#PurchaseOrder", {orderId, settlementTermId: "NO_SUCH_TERM"})
            const part = one("mantle.order.OrderPart", {orderId, orderPartSeqId: "01"})
            const logged = rows("moqui.entity.EntityAuditLog", {
                changedEntityName: "mantle.order.OrderPart",
                changedFieldName: "settlementTermId",
                pkPrimaryValue: orderId
            })
            return {edited, unknown, part, logged, term, incoterm}
        },
        then({edited, unknown, part, logged, term, incoterm}) {
            edited.error == ""
            part.settlementTermId == term.settlementTermId
            part.tradeTermEnumId == incoterm.enumId
            part.estimatedDeliveryDate != null
            logged.length == 1
            unknown.error.includes("TERM_INVALID")
        }
    }
)

feature(
    "with the approval gate on, an ORDER_CHANGE_HOLD_RELEASE holder's release#OrderHold of an applied revision's Change hold returns the order to Placed for its approval, not to Approved",
    {
        when() {
            const orderId = sentOrder(supplier, 2)
            run(state.buyer, O + "start#PurchaseRevision", {orderId, reason: "More"})
            call("create#mantle.order.purchase.PurchasePolicy", {
                organizationPartyId: org,
                fromDate: Number(ec.user.nowTimestamp),
                commercialRevisionOnly: "Y",
                approvalGateEnabled: "Y",
                changeReason: "Spec gate"
            })
            const applied = run(state.buyer, O + "apply#PurchaseRevision", {
                orderId,
                itemChanges: [{orderItemSeqId: "01", quantity: 3}],
                reason: "More"
            })
            call("create#moqui.security.UserGroupPermission", {
                userGroupId: state.approver,
                userPermissionId: "ORDER_CHANGE_HOLD_RELEASE",
                fromDate: since
            })
            const hold = rows("mantle.order.OrderHoldReason", {orderId}).find(row => !row.releasedDate)
            const released = run(state.approver, O + "release#OrderHold", {
                orderHoldReasonId: hold.orderHoldReasonId,
                releaseComment: "Let it through"
            })
            return {orderId, applied, released}
        },
        then({orderId, applied, released}) {
            applied.error == ""
            released.error == ""
            statusOf(orderId) == "OrderPlaced"
        }
    }
)
