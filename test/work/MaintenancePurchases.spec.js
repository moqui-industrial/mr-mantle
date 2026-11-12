// Maintenance purchases (mantle.work.MaintenanceServices link#, get#MaintenancePurchases, accept#MaintenanceService and
// transition#MaintenanceWorkOrder's outside-service line; IronStone Maintenance design §3 PurchaseLinks and CompleteWork; MT-10;
// impl-maintenance P10, F45): a planner without Purchasing's grant asks for a motor rewind from the work order (a submitted
// purchase request of the organization, linked to the work, once under its key) and cannot approve, source or place it;
// Purchasing approves and sources it to a draft purchase order, whose line is the work's (AssetMaintenanceOrderItem, never an
// OrderItemWorkEffort) and shows on the work without its price; another order line is linked only by a buyer; at completion
// the supervisor accepts the service with the technician's photo, recorded once under its key, and completing the work
// completes no order line; a technician without Purchasing's grant cannot accept. P10 review: the request names the work order
// by id only and Purchasing's reader of it sees the work order's name only when Maintenance admits them (R3); a buyer reads the
// line's price; another organization's order line is not linked; the evidence is attached to the line once. Standalone: a spec-local organization with its
// accounting configuration, a supplier and its price, a service product, a facility, equipment, groups and users, the services
// called as each user with the artifact check aside (their own permission and scope checks decide).
// Run: ./moq test mr-mantle --spec MaintenancePurchases
const prefix = "MNT_PUR_SPEC"
const org = prefix + "_ORG",
    supplier = prefix + "_SUP",
    rewind = prefix + "_REWIND",
    since = "2000-01-01T00:00:00Z"
const S = "mantle.work.MaintenanceServices.",
    R = "mantle.request.RequestServices."
const state = {}
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())

// the service's answer as a user, or the reason code it refuses with
function as(username, service, parameters = {}) {
    login(username)
    ec.artifactExecution.disableAuthz()
    try {
        return call(service, parameters)
    } catch (error) {
        const match = /([A-Z][A-Z0-9_]+):/.exec(String(error.message))
        return match ? match[1] : "ERROR " + error.message
    } finally {
        ec.message.clearErrors()
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}
function organization(partyId, name, roleTypeId, ownerPartyId) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: ownerPartyId || partyId})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId})
}
// a user of a spec-local group with the permissions, an agent of the organization
function user(kind, permissions) {
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Maintenance purchases " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    const partyId = prefix + "_P_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Purchases", lastName: kind})
    call("create#mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtAgent",
        fromPartyId: partyId,
        toPartyId: org,
        toRoleTypeId: "OrgInternal",
        fromDate: since
    })
    call("create#moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA"
    })
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: since})
    state[kind + "_PARTY"] = partyId
    return id
}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(org, "Purchases Spec Org", "OrgInternal")
        organization(supplier, "Purchases Spec Rewinds", "Supplier", org)
        call("mantle.ledger.LedgerServices.init#PartyAccountingConfiguration", {
            organizationPartyId: org,
            sourcePartyId: "DefaultSettings",
            baseCurrencyUomId: "USD"
        })
        call("create#mantle.facility.Facility", {
            facilityId: prefix + "_SITE",
            facilityName: "Purchases site",
            facilityTypeEnumId: "FcTpBuilding",
            ownerPartyId: org
        })
        call("create#mantle.product.asset.Asset", {
            assetId: prefix + "_MOTOR",
            assetTypeEnumId: "AstTpEquipment",
            assetName: "Purchases spec motor",
            ownerPartyId: org,
            facilityId: prefix + "_SITE"
        })
        call("create#mantle.product.Product", {
            productId: rewind,
            productName: "Motor rewind",
            productTypeEnumId: "PtService",
            amountUomId: "OTH_ea",
            ownerPartyId: org,
            statusId: "PrdActive"
        })
        call("create#mantle.product.ProductPrice", {
            productId: rewind,
            vendorPartyId: supplier,
            pricePurposeEnumId: "PppPurchase",
            priceTypeEnumId: "PptCurrent",
            fromDate: since,
            minQuantity: 1,
            price: 480,
            priceUomId: "USD"
        })
        state.planner = user("PLANNER", ["MAINTENANCE_VIEW", "MAINTENANCE_PLAN"])
        // the supervisor is also Purchasing's receiver (accept#ServiceItem's own check)
        state.supervisor = user("SUPERVISOR", ["MAINTENANCE_VIEW", "MAINTENANCE_SUPERVISE", "STOCK_RECEIVE"])
        state.tech = user("TECH", ["MAINTENANCE_ASSIGNED_VIEW", "MAINTENANCE_EXECUTE"])
        state.buyer = user("BUYER", ["PURCHASE_ORDER_EDIT", "SUPPLIER_PRICE_VIEW", "MAINTENANCE_VIEW", "MAINTENANCE_PLAN"])
        state.approver = user("APPROVER", ["PURCHASE_APPROVE"])
        const created = as(state.planner, S + "create#MaintenanceWorkOrder", {
            assetId: prefix + "_MOTOR",
            workEffortName: "Motor windings burnt",
            estimatedCompletionDate: new Date(Date.now() + 7 * 86400000)
        })
        state.work = created.workEffortId
        state.assetMaintenanceId = created.assetMaintenanceId
        as(state.planner, S + "schedule#MaintenanceWorkOrder", {workEffortId: state.work, assigneePartyIds: [state.TECH_PARTY]})
        as(state.tech, S + "transition#MaintenanceWorkOrder", {workEffortId: state.work, action: "start"})
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature(
    "a planner without Purchasing's grant asks for a rewind from the work, once under its key, and cannot approve or source it",
    {
        when() {
            const ask = {
                workEffortId: state.work,
                requestName: "Rewind the motor",
                productId: rewind,
                quantity: 1,
                operationKey: prefix + "-ask"
            }
            const requested = as(state.planner, S + "link#MaintenancePurchase", ask)
            const again = as(state.planner, S + "link#MaintenancePurchase", ask)
            const tech = as(state.tech, S + "link#MaintenancePurchase", Object.assign({}, ask, {operationKey: prefix + "-tech"}))
            state.requestId = requested.requestId
            const approves = as(state.planner, R + "decide#PurchaseRequestApproval", {requestId: state.requestId})
            // Purchasing's RequestDetail: the approver reads the work order without its name; the planner, its requester, with it
            const approverWork = as(state.approver, S + "get#PurchaseRequestWork", {requestId: state.requestId})
            const plannerWork = as(state.planner, S + "get#PurchaseRequestWork", {requestId: state.requestId})
            const sources = as(state.planner, R + "convert#PurchaseSourcing", {
                requestItemKeys: [state.requestId + ":" + requested.requestItemSeqId],
                operationKey: prefix + "-src-planner"
            })
            return {requested, again, tech, approves, sources, approverWork, plannerWork}
        },
        then({requested, again, tech, approves, sources, approverWork, plannerWork}) {
            requested.resultCode == "REQUESTED"
            requested.statusId == "ReqSubmitted"
            again.requestId == requested.requestId
            again.repeated == true
            rows("mantle.request.Request", {requestId: state.requestId})[0].requestTypeEnumId == "RqtPurchase"
            rows("mantle.request.Request", {requestId: state.requestId})[0].filedByPartyId == state.PLANNER_PARTY
            !String(rows("mantle.request.Request", {requestId: state.requestId})[0].description).includes("Motor windings burnt")
            approverWork.workList.length == 1
            approverWork.workList[0].workEffortId == state.work
            approverWork.workList[0].workEffortName == null
            approverWork.workList[0].canOpen == false
            plannerWork.workList[0].workEffortName == "Motor windings burnt"
            plannerWork.workList[0].canOpen == true
            rows("mantle.request.RequestWorkEffort", {requestId: state.requestId, workEffortId: state.work}).length == 1
            rows("mantle.request.RequestParty", {requestId: state.requestId, partyId: org, roleTypeId: "OrgInternal"}).length == 1
            tech == "PERMISSION_DENIED"
            approves == "PERMISSION_DENIED"
            sources == "PERMISSION_DENIED"
        }
    }
)

feature("Purchasing sources it; the order line is the work's, never required work, and the work shows it without its price", {
    when() {
        const approved = as(state.approver, R + "decide#PurchaseRequestApproval", {requestId: state.requestId})
        const item = rows("mantle.request.RequestItem", {requestId: state.requestId})[0]
        as(state.buyer, R + "store#PurchaseRequestItem", {
            requestId: state.requestId,
            requestItemSeqId: item.requestItemSeqId,
            supplierPartyId: supplier
        })
        const sourced = as(state.buyer, R + "convert#PurchaseSourcing", {
            requestItemKeys: [state.requestId + ":" + item.requestItemSeqId],
            operationKey: prefix + "-src"
        })
        const line = rows("mantle.request.RequestItemOrder", {requestId: state.requestId})[0] || {}
        state.orderId = line.orderId
        state.orderItemSeqId = line.orderItemSeqId
        const plannerRead = as(state.planner, S + "get#MaintenancePurchases", {workEffortId: state.work})
        // a line the work did not request: a buyer links it, a planner may not
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const other = call("mantle.order.PurchaseServices.create#PurchaseOrder", {
            organizationPartyId: org,
            vendorPartyId: supplier
        })
        call("create#mantle.order.OrderItem", {
            orderId: other.orderId,
            orderItemSeqId: "01",
            orderPartSeqId: other.orderPartSeqId || "01",
            itemTypeEnumId: "ItemProduct",
            productId: rewind,
            itemDescription: "Spare rewind",
            quantity: 1,
            unitAmount: 480
        })
        const plannerLinks = as(state.planner, S + "link#MaintenancePurchase", {
            workEffortId: state.work,
            orderId: other.orderId,
            orderItemSeqId: "01"
        })
        const buyerLinks = as(state.buyer, S + "link#MaintenancePurchase", {
            workEffortId: state.work,
            orderId: other.orderId,
            orderItemSeqId: "01"
        })
        // another organization's purchase order line: not the work's to link, even for a buyer
        const elsewhere = prefix + "_ORG2"
        organization(elsewhere, "Purchases Spec Elsewhere", "OrgInternal")
        call("create#mantle.order.OrderHeader", {orderId: prefix + "_PO2", statusId: "OrderOpen", currencyUomId: "USD"})
        call("create#mantle.order.OrderPart", {
            orderId: prefix + "_PO2",
            orderPartSeqId: "01",
            vendorPartyId: supplier,
            customerPartyId: elsewhere
        })
        call("create#mantle.order.OrderItem", {
            orderId: prefix + "_PO2",
            orderItemSeqId: "01",
            orderPartSeqId: "01",
            itemTypeEnumId: "ItemProduct",
            productId: rewind,
            quantity: 1,
            unitAmount: 480
        })
        const otherOrganization = as(state.buyer, S + "link#MaintenancePurchase", {
            workEffortId: state.work,
            orderId: prefix + "_PO2",
            orderItemSeqId: "01"
        })
        const buyerRead = as(state.buyer, S + "get#MaintenancePurchases", {workEffortId: state.work})
        return {approved, sourced, plannerRead, plannerLinks, buyerLinks, otherOrganization, buyerRead}
    },
    then({approved, sourced, plannerRead, plannerLinks, buyerLinks, otherOrganization, buyerRead}) {
        approved.statusId == "ReqInProgress"
        sourced.createdCount == 1
        state.orderId != null
        rows("mantle.product.maintenance.AssetMaintenanceOrderItem", {
            assetMaintenanceId: state.assetMaintenanceId,
            orderId: state.orderId,
            orderItemSeqId: state.orderItemSeqId
        }).length == 1
        rows("mantle.order.OrderItemWorkEffort", {orderId: state.orderId}).length == 0
        plannerRead.requestList.length == 1
        plannerRead.requestList[0].statusText != ""
        const shown = plannerRead.orderLines.find(row => row.orderId == state.orderId)
        shown.linked == true
        shown.service == true
        shown.requestId == state.requestId
        shown.unitAmountText === undefined
        plannerRead.canAccept == false
        plannerLinks == "PERMISSION_DENIED"
        buyerLinks.resultCode == "LINKED"
        otherOrganization == "RECORD_UNAVAILABLE"
        rows("mantle.product.maintenance.AssetMaintenanceOrderItem", {orderId: prefix + "_PO2"}).length == 0
        buyerRead.priceRead == true
        buyerRead.orderLines.find(row => row.orderId == state.orderId).unitAmountText.includes("480")
    }
})

feature(
    "at completion the supervisor accepts the service with the technician's photo, once under its key; no order line completes",
    {
        when() {
            login("john.doe")
            ec.artifactExecution.disableAuthz()
            const photo = call("create#mantle.work.effort.WorkEffortContent", {
                workEffortId: state.work,
                contentLocation: "dbresource://mantle/work/" + prefix + "/rewound-motor.jpg",
                description: "Rewound motor on the bench",
                userId: state.tech
            }).workEffortContentId
            const techAccepts = as(state.tech, S + "accept#MaintenanceService", {
                workEffortId: state.work,
                orderId: state.orderId,
                orderItemSeqId: state.orderItemSeqId,
                acceptedQuantity: 1,
                operationKey: prefix + "-tech-acc"
            })
            const completed = as(state.supervisor, S + "transition#MaintenanceWorkOrder", {
                workEffortId: state.work,
                action: "complete",
                outcomeEnumId: "MoutRepaired",
                dispositionEnumId: "MdispAvailable",
                serviceOrderId: state.orderId,
                serviceOrderItemSeqId: state.orderItemSeqId,
                serviceAcceptedQuantity: 1,
                serviceEvidenceContentId: photo,
                serviceOperationKey: prefix + "-acc"
            })
            const again = as(state.supervisor, S + "accept#MaintenanceService", {
                workEffortId: state.work,
                orderId: state.orderId,
                orderItemSeqId: state.orderItemSeqId,
                acceptedQuantity: 1,
                workEffortContentId: photo,
                operationKey: prefix + "-acc"
            })
            const acceptances = rows("mantle.order.purchase.ServiceAcceptance", {orderId: state.orderId})
            const item = one("mantle.order.OrderItem", {orderId: state.orderId, orderItemSeqId: state.orderItemSeqId})
            const read = as(state.supervisor, S + "get#MaintenancePurchases", {workEffortId: state.work})
            const order = as(state.supervisor, S + "get#MaintenanceOrder", {orderId: state.orderId})
            return {techAccepts, completed, again, acceptances, item, read, order, photo}
        },
        then({techAccepts, completed, again, acceptances, item, read, order}) {
            techAccepts == "PERMISSION_DENIED"
            completed.statusId == "WeComplete"
            completed.serviceAcceptanceId != null
            again.alreadyApplied == true
            acceptances.length == 1
            acceptances[0].workEffortId == state.work
            acceptances[0].orderContentId != null
            rows("mantle.order.OrderContent", {
                orderId: state.orderId,
                orderItemSeqId: state.orderItemSeqId,
                orderContentTypeEnumId: "OctServiceEvidence"
            }).length == 1
            one("mantle.order.OrderContent", {orderContentId: acceptances[0].orderContentId}).orderContentTypeEnumId ==
                "OctServiceEvidence"
            item.statusId != "ItemCompleted"
            read.orderLines.find(row => row.orderId == state.orderId).acceptedText == "1"
            order.maintenanceOrder.items[0].workEffortId == state.work
        }
    }
)
