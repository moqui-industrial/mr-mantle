// Customer return policies and authorization (impl-customer-service P9, CS-RETURN-POLICY, CX-RETURNS, CX-APPROVAL; F21, F22,
// F23, F45, F46, F61; mantle.order.ReturnPolicyServices, ReturnPolicies.js): with no policy a return is manual review and its
// authorization needs a reason; the policy saves and their refusals; eligibility under a lock across drafts (shipped and
// invoiced less every return not cancelled); the authorization over approve#Return (the return shipment, no credit,
// responseImmediate N unless the policy and the settlement authority allow it, the RMA stored, the decision, a retry, a stale
// revision); an exception approved through the topic's handler at the message's revision (none and stale refused); a remainder
// closed; a cancel before any effect cancelling the return shipment (F22) and refused after receipt; the RMA link's record kind.
// Standalone: spec-local organization, customer, stock and users, artifact authorization disabled (the rules are the services'
// own checks). Run: ./moq test mr-mantle --spec ReturnPolicies
const helper = () => ec.resource.script("component://mr-mantle/test/ledger/AccountingReceivablesFixtures.js")
const svc = (name, p) => helper().call(name, p)
const one = (entity, key) => helper().lib.one(entity, key)
const rows = (entity, key) => helper().lib.rows(entity, key)
const P = "mantle.order.ReturnPolicyServices."
const prefix = "RTPS"
const org = prefix + "_ORG",
    customer = prefix + "_CUST",
    facility = prefix + "_WH",
    productA = "DEMO_1_1",
    productB = "DEMO_3_1"
const users = {}
const ids = {}
let keySeq = 0
const key = () => prefix + "-" + ++keySeq

function party(partyId, name, roleTypeId) {
    svc("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
    svc("create#mantle.party.Organization", {partyId, organizationName: name})
    svc("create#mantle.party.PartyRole", {partyId, roleTypeId})
}
function user(kind, permissions) {
    const id = prefix + "_" + kind.toUpperCase()
    users[kind] = id
    svc("create#moqui.security.UserGroup", {userGroupId: id, description: "Return policy " + kind})
    for (const permission of permissions)
        svc("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: 0})
    svc("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    svc("create#mantle.party.Person", {partyId: id, firstName: "Returns", lastName: kind})
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
// a call as a user: its result with its refusal code ("" when it succeeds), in its own transaction
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
const code = out => (/([A-Z][A-Z0-9_]+):/.exec(out.error || "") || [])[1] || (out.error ? "ERROR" : "")
// a sale of the lines, paid, placed, approved and shipped (invoiced at ship)
function sale(lines) {
    login("john.doe")
    const order = svc("mantle.order.OrderServices.create#Order", {
        vendorPartyId: org,
        customerPartyId: customer,
        facilityId: facility
    })
    for (const [productId, quantity, unitAmount] of lines)
        svc("mantle.order.OrderServices.add#OrderProductQuantity", {
            orderId: order.orderId,
            orderPartSeqId: order.orderPartSeqId,
            productId,
            quantity,
            unitAmount
        })
    svc("mantle.order.OrderServices.place#Order", {orderId: order.orderId})
    svc("mantle.order.OrderServices.approve#Order", {orderId: order.orderId})
    svc("mantle.shipment.ShipmentServices.ship#OrderPart", {orderId: order.orderId, orderPartSeqId: order.orderPartSeqId})
    return order.orderId
}
const itemSeq = (orderId, productId) =>
    rows("mantle.order.OrderItem", {orderId}).find(row => row.productId === productId && !row.parentItemSeqId).orderItemSeqId
const line = (orderId, productId, quantity, reason = "RrsnDefective", response = "RrspCredit") => ({
    orderItemSeqId: itemSeq(orderId, productId),
    quantity,
    returnReasonEnumId: reason,
    returnResponseEnumId: response
})
const items = returnId => rows("mantle.order.return.ReturnItem", {returnId}).filter(row => !row.parentItemSeqId)
const shipmentOf = returnId => rows("mantle.shipment.ShipmentItemSource", {returnId})[0]?.shipmentId || null

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        party(org, "Return policy organization", "OrgInternal")
        svc("mantle.ledger.LedgerServices.init#PartyAccountingConfiguration", {
            organizationPartyId: org,
            sourcePartyId: "DefaultSettings",
            baseCurrencyUomId: "USD"
        })
        svc("mantle.ledger.LedgerServices.get#OrganizationFiscalTimePeriods", {
            organizationPartyId: org,
            filterDate: ec.user.nowTimestamp
        })
        // the organization keeps Mantle's default (returnSettlementRequired N): Mantle answers an immediate item at approval
        party(customer, "Return policy customer", "Customer")
        svc("create#mantle.facility.Facility", {facilityId: facility, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: org})
        for (const productId of [productA, productB])
            svc("mantle.product.AssetServices.receive#Asset", {
                productId,
                facilityId: facility,
                ownerPartyId: org,
                quantity: 20,
                acquireCost: 5
            })
        user("agent", ["SUPPORT_CASE_EDIT"])
        user("authorizer", ["RETURN_AUTHORIZE"])
        user("receivable", ["RETURN_AUTHORIZE", "RECEIVABLE_EDIT"])
        user("creditor", ["RETURN_AUTHORIZE", "RECEIVABLE_EDIT", "INVOICE_APPROVE"])
        user("manager", ["RETURN_EXCEPTION_APPROVE"])
        user("admin", ["RETURN_POLICY_EDIT"])
        ids.orderId = sale([
            [productA, 4, 20],
            [productB, 2, 10]
        ])
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        login("john.doe")
    }
})

feature("with no policy a return is manual review, and its authorization needs a reason", {
    when() {
        const evaluated = run(users.agent, P + "evaluate#ReturnPolicy", {orderId: ids.orderId})
        const submitted = run(users.agent, P + "submit#CustomerReturn", {
            operationKey: key(),
            orderId: ids.orderId,
            lineList: [line(ids.orderId, productA, 1)],
            customerReference: "JQ-RMA-1"
        })
        ids.manualReturn = submitted.returnId
        const noReason = run(users.authorizer, P + "authorize#Return", {operationKey: key(), returnId: ids.manualReturn})
        const agentAuthorize = run(users.agent, P + "authorize#Return", {
            operationKey: key(),
            returnId: ids.manualReturn,
            reason: "x"
        })
        return {
            evaluated,
            submitted,
            noReason,
            agentAuthorize,
            header: one("mantle.order.return.ReturnHeader", {returnId: ids.manualReturn})
        }
    },
    then({evaluated, submitted, noReason, agentAuthorize, header}) {
        evaluated.outcome == "ManualReview"
        evaluated.lineRows.find(row => row.productId == productA).eligibleQuantity == "4"
        submitted.error == ""
        submitted.outcome == "ManualReview"
        header.statusId == "ReturnRequested"
        header.manualReview == "Y"
        header.customerReference == "JQ-RMA-1"
        code(noReason) == "REASON_REQUIRED"
        code(agentAuthorize) == "PERMISSION_DENIED"
    }
})

feature("policies: dated rows saved by the administrator, the same conditions refused over the same dates", {
    when() {
        const agent = run(users.agent, P + "save#Policy", {organizationPartyId: org, policyName: "Agent's"})
        const saved = run(users.admin, P + "save#Policy", {
            organizationPartyId: org,
            policyName: "Standard returns",
            windowDays: "30",
            windowFromEnumId: "RpwDelivered",
            authorizationDays: "14",
            allowedReasonEnumIds: "RrsnDefective,RrsnDamagedShip",
            instantCredit: "Y",
            instructions: "Pack the item in its box."
        })
        ids.policyId = saved.returnPolicyId
        const overlap = run(users.admin, P + "save#Policy", {organizationPartyId: org, policyName: "Another default"})
        const badStore = run(users.admin, P + "save#Policy", {
            organizationPartyId: org,
            policyName: "Store",
            productStoreId: "POPC_DEFAULT"
        })
        const reason = run(users.admin, P + "save#ReturnReason", {
            organizationPartyId: org,
            returnReasonEnumId: "RrsnDefective",
            customerLabel: "It does not work",
            evidenceRequired: "Y"
        })
        const found = run(users.authorizer, P + "find#Policies", {organizationPartyId: org})
        return {agent, saved, overlap, badStore, reason, found}
    },
    then({agent, saved, overlap, badStore, reason, found}) {
        code(agent) == "PERMISSION_DENIED"
        saved.error == ""
        code(overlap) == "EQUAL_RANK_OVERLAP"
        code(badStore) == "STORE_UNAVAILABLE"
        reason.error == ""
        found.policies.length == 1
        found.policies[0].state == "In effect"
        found.reasons.length == 1
    }
})

feature("two drafts cannot together return more than was shipped and invoiced", {
    when() {
        const first = run(users.agent, P + "submit#CustomerReturn", {
            operationKey: key(),
            orderId: ids.orderId,
            draft: true,
            lineList: [line(ids.orderId, productB, 2)]
        })
        const second = run(users.agent, P + "submit#CustomerReturn", {
            operationKey: key(),
            orderId: ids.orderId,
            draft: true,
            lineList: [line(ids.orderId, productB, 1)]
        })
        // raising the first draft past what is left, through the checked line save
        const raise = run(users.agent, P + "save#ReturnItem", {
            returnId: first.returnId,
            returnItemSeqId: items(first.returnId)[0].returnItemSeqId,
            returnQuantity: 3
        })
        const evaluated = run(users.agent, P + "evaluate#ReturnPolicy", {orderId: ids.orderId})
        ids.draftReturn = first.returnId
        return {
            first,
            second,
            raise,
            evaluated,
            firstStatus: one("mantle.order.return.ReturnHeader", {returnId: first.returnId}).statusId
        }
    },
    then({first, second, raise, evaluated, firstStatus}) {
        first.error == ""
        firstStatus == "ReturnCreated"
        code(second) == "QUANTITY_EXCEEDS_ELIGIBLE"
        code(raise) == "QUANTITY_EXCEEDS_ELIGIBLE"
        evaluated.lineRows.find(row => row.productId == productB).eligibleQuantity == "0"
        evaluated.lineRows.find(row => row.productId == productA).eligibleQuantity == "3"
    }
})

feature(
    "authorize: the return shipment and no credit, responses not immediate without the settlement authority, the RMA stored",
    {
        when() {
            const submitted = run(users.agent, P + "submit#CustomerReturn", {
                operationKey: key(),
                orderId: ids.orderId,
                lineList: [line(ids.orderId, productA, 1)]
            })
            ids.authorizedReturn = submitted.returnId
            const stale = run(users.authorizer, P + "authorize#Return", {
                operationKey: key(),
                returnId: submitted.returnId,
                sourceRevision: "1"
            })
            const opKey = key()
            const authorized = run(users.authorizer, P + "authorize#Return", {
                operationKey: opKey,
                returnId: submitted.returnId,
                sourceRevision: submitted.sourceRevision,
                immediate: true
            })
            const retry = run(users.authorizer, P + "authorize#Return", {
                operationKey: opKey,
                returnId: submitted.returnId,
                sourceRevision: submitted.sourceRevision,
                immediate: true
            })
            const header = one("mantle.order.return.ReturnHeader", {returnId: submitted.returnId})
            return {
                submitted,
                stale,
                authorized,
                retry,
                header,
                item: items(submitted.returnId)[0],
                billings: rows("mantle.order.return.ReturnItemBilling", {returnId: submitted.returnId}).length,
                rma: rows("mantle.order.return.ReturnContent", {
                    returnId: submitted.returnId,
                    contentTypeEnumId: "RtcntAuthorization"
                }),
                decisions: rows("mantle.order.return.ReturnAuthorizationDecision", {returnId: submitted.returnId})
            }
        },
        then({submitted, stale, authorized, retry, header, item, billings, rma, decisions}) {
            submitted.outcome == "Eligible"
            submitted.returnPolicyId == ids.policyId
            code(stale) == "STALE_REVISION"
            authorized.error == ""
            authorized.result.resultCode == "AUTHORIZED"
            authorized.result.shipmentId != null
            authorized.result.immediateItems.length == 0
            retry.result.alreadyApplied == true
            header.statusId == "ReturnApproved"
            header.authorizationExpireDate != null
            header.returnPolicyId == ids.policyId
            item.responseImmediate == "N"
            billings == 0
            rma.length == 1
            decisions.length == 1
            decisions[0].decisionEnumId == "RdAuthorized"
            decisions[0].sourceRevision == submitted.sourceRevision
        }
    }
)

feature(
    "an instant credit at authorization needs the policy and the settlement authority, INVOICE_APPROVE where Mantle answers it",
    {
        when() {
            const submit = () =>
                run(users.agent, P + "submit#CustomerReturn", {
                    operationKey: key(),
                    orderId: ids.orderId,
                    lineList: [line(ids.orderId, productA, 1)]
                }).returnId
            // RECEIVABLE_EDIT without INVOICE_APPROVE: authorized, the credit waits for receipt (F-P9-6)
            const waitingId = submit()
            const waiting = run(users.receivable, P + "authorize#Return", {
                operationKey: key(),
                returnId: waitingId,
                immediate: true
            })
            const submitted = submit()
            const authorized = run(users.creditor, P + "authorize#Return", {
                operationKey: key(),
                returnId: submitted,
                immediate: true
            })
            ids.immediateReturn = submitted
            return {
                waiting,
                waitingItem: items(waitingId)[0],
                waitingBillings: rows("mantle.order.return.ReturnItemBilling", {returnId: waitingId}).length,
                authorized,
                item: items(submitted)[0],
                billings: rows("mantle.order.return.ReturnItemBilling", {returnId: submitted}).length
            }
        },
        then({waiting, waitingItem, waitingBillings, authorized, item, billings}) {
            waiting.error == ""
            waiting.result.immediateItems.length == 0
            waitingItem.responseImmediate == "N"
            waitingBillings == 0
            authorized.error == ""
            authorized.result.immediateItems.length == 1
            item.responseImmediate == "Y"
            billings == 1
        }
    }
)

feature("an exception: the reason the policy does not allow, approved through the topic at the message's revision", {
    when() {
        // the manual-review draft of feature 1 is cancelled so its unit is free again
        run(users.agent, P + "cancel#CustomerReturn", {returnId: ids.manualReturn})
        const submitted = run(users.agent, P + "submit#CustomerReturn", {
            operationKey: key(),
            orderId: ids.orderId,
            lineList: [line(ids.orderId, productA, 1, "RrsnDidNotWant")],
            exceptionReason: "Long-standing customer"
        })
        ids.exceptionReturn = submitted.returnId
        const blocked = run(users.authorizer, P + "authorize#Return", {operationKey: key(), returnId: submitted.returnId})
        const noRevision = run(users.manager, P + "approve#ReturnException", {
            recordEntityName: "mantle.order.return.ReturnHeader",
            recordId: submitted.returnId,
            message: {}
        })
        const staleMessage = run(users.manager, P + "approve#ReturnException", {
            recordEntityName: "mantle.order.return.ReturnHeader",
            recordId: submitted.returnId,
            message: {sourceRevision: "1"}
        })
        const refuseNoReason = run(users.manager, P + "refuse#ReturnException", {
            recordEntityName: "mantle.order.return.ReturnHeader",
            recordId: submitted.returnId,
            message: {sourceRevision: submitted.sourceRevision}
        })
        const approved = run(users.manager, P + "approve#ReturnException", {
            recordEntityName: "mantle.order.return.ReturnHeader",
            recordId: submitted.returnId,
            message: {sourceRevision: submitted.sourceRevision}
        })
        const authorized = run(users.authorizer, P + "authorize#Return", {operationKey: key(), returnId: submitted.returnId})
        return {submitted, blocked, noRevision, staleMessage, refuseNoReason, approved, authorized}
    },
    then({submitted, blocked, noRevision, staleMessage, refuseNoReason, approved, authorized}) {
        submitted.outcome == "ExceptionRequired"
        submitted.exceptions.includes("REASON_NOT_ALLOWED")
        submitted.exceptionNotified == 1
        code(blocked) == "EXCEPTION_REQUIRED"
        code(noRevision) == "REVISION_REQUIRED"
        code(staleMessage) == "STALE_REVISION"
        code(refuseNoReason) == "REASON_REQUIRED"
        approved.error == ""
        authorized.error == ""
        authorized.result.resultCode == "AUTHORIZED"
    }
})

feature("cancel before any effect cancels the return shipment; a cancel after receipt and a close with nothing awaited refused", {
    when() {
        const shipmentId = shipmentOf(ids.exceptionReturn)
        const cancelled = run(users.authorizer, P + "cancel#CustomerReturn", {
            returnId: ids.exceptionReturn,
            reason: "Customer kept it"
        })
        const shipment = one("mantle.shipment.Shipment", {shipmentId})
        // one unit of the immediate return arrived (its received quantity, as a receipt records it)
        login("john.doe")
        const source = rows("mantle.shipment.ShipmentItemSource", {returnId: ids.immediateReturn})[0]
        svc("update#mantle.order.return.ReturnItem", {
            returnId: ids.immediateReturn,
            returnItemSeqId: source.returnItemSeqId,
            receivedQuantity: 1
        })
        const afterReceipt = run(users.authorizer, P + "cancel#CustomerReturn", {returnId: ids.immediateReturn, reason: "x"})
        const notAwaiting = run(users.authorizer, P + "close#ReturnRemainder", {returnId: ids.manualReturn, reason: "x"})
        return {cancelled, shipment, afterReceipt, notAwaiting}
    },
    then({cancelled, shipment, afterReceipt, notAwaiting}) {
        cancelled.statusId == "ReturnCancelled"
        shipment.statusId == "ShipCancelled"
        code(afterReceipt) == "RETURN_HAS_EFFECT"
        code(notAwaiting) == "RETURN_NOT_AWAITING"
    }
})

feature("a replacement at authorization where the organization does not settle separately: only an advance replacement", {
    when() {
        // the unit the cancelled exception return freed, for a replacement
        const submitted = run(users.agent, P + "submit#CustomerReturn", {
            operationKey: key(),
            orderId: ids.orderId,
            lineList: [line(ids.orderId, productA, 1, "RrsnDefective", "RrspReplace")]
        })
        const refused = run(users.authorizer, P + "authorize#Return", {operationKey: key(), returnId: submitted.returnId})
        const refusedItem = items(submitted.returnId)[0]
        const refusedStatus = one("mantle.order.return.ReturnHeader", {returnId: submitted.returnId}).statusId
        // the policy changed from now to allow an advance replacement
        const changed = run(users.admin, P + "save#Policy", {returnPolicyId: ids.policyId, advanceReplacement: "Y"})
        const authorized = run(users.authorizer, P + "authorize#Return", {operationKey: key(), returnId: submitted.returnId})
        return {refused, refusedItem, refusedStatus, changed, authorized, item: items(submitted.returnId)[0]}
    },
    then({refused, refusedItem, refusedStatus, changed, authorized, item}) {
        code(refused) == "REPLACEMENT_AFTER_RECEIPT"
        !refusedItem.replacementOrderId
        refusedStatus == "ReturnRequested"
        changed.error == ""
        authorized.error == ""
        authorized.result.resultCode == "AUTHORIZED"
        item.replacementOrderId != null
    }
})

feature("the RMA link's record kind, and the RMA print", {
    when() {
        const access = ec.resource.script("component://mr-mantle/service/mantle/party/ExternalAccess.js")
        const record = access.recordOf("ReturnHeader", ids.authorizedReturn)
        const cancelledRecord = access.recordOf("ReturnHeader", ids.exceptionReturn)
        const printed = run(users.agent, P + "get#ReturnAuthorizationPrint", {returnId: ids.authorizedReturn})
        const draftPrint = run(users.agent, P + "get#ReturnAuthorizationPrint", {returnId: ids.draftReturn})
        const found = run(users.agent, P + "find#ServiceReturns", {view: "authorized", customerPartyId: customer})
        return {record, cancelledRecord, printed, draftPrint, found}
    },
    then({record, cancelledRecord, printed, draftPrint, found}) {
        record.organizationPartyId == org
        record.partyId == customer
        cancelledRecord == null
        printed.printHtml.includes("Pack the item in its box.")
        code(draftPrint) == "RETURN_NOT_AUTHORIZED"
        found.returnRows.some(row => row.returnId == ids.authorizedReturn)
        found.amountsWithheld == true
    }
})
