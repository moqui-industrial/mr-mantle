// Replenishment routes (impl-purchasing P14b; crosscut §4.2, R-PUR-06, R-PUR-20, R-PUR-37; design-purchasing §8
// SupplyPlanning): where the buying policy sends plan buys to purchase requests, a buy suggestion becomes a purchase request
// sent to its approval, a line per customer order line (with its RequestItemOrder) and one for the rest, each covering the
// plan's requirement, so a competing conversion is DEMAND_ALREADY_COVERED and an order route is ROUTE_NOT_ALLOWED; the
// request's lines are supply to the next plan, submitted and then approved, and what is sourced moves to its order line, so
// the demand is not suggested again; RequestSourcing's drop-ship route takes the request line's customer order line
// (F-P10-7); a cancelled request's coverage ends; the plan's drop-ship route moves a customer-order shortage's sales line to
// the supplier's drop-ship facility and buys it, refusing a suggestion with no customer line or an order not approved; a
// customer-order shortage converted to a draft order keeps its sales line, and its receipt reserves the received stock for
// it (STOCK_RECEIVE), on hold at the dock, which its putaway keeps; held stock of a bought product nets within its supplier's
// lead time where the schedule says so. Review: a refused request is shown and not netted; a request line in another unit
// nets in the stock unit; a supplier with no drop-ship price is refused by name.
// Standalone: a spec-local organization (its accounting configuration, a warehouse, the buying policy with the approval
// gate on, so a drop-ship order waits at Placed), a supplier with a drop-ship facility, a customer, products and users in
// spec-local groups. Run: ./moq test mr-mantle --spec ReplenishmentRoutes
const prefix = "RPR"
const org = prefix + "_ORG",
    warehouse = prefix + "_WH",
    supplier = prefix + "_SUPPLIER",
    dropFacility = prefix + "_DROP_FAC",
    customer = prefix + "_CUSTOMER",
    address = prefix + "_ADDR",
    since = "2000-01-01T00:00:00Z"
const S = "mantle.product.SupplyPlanningServices.",
    R = "mantle.request.RequestServices.",
    O = "mantle.order.OrderServices.",
    G = "mantle.order.PurchasePegServices."
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const n = value => (value == null ? null : toDecimal(value).toNumber())
const dayMs = 86400000
const state = {}
let keySeq = 0
const key = () => "rpr-op-" + ++keySeq

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
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Replenishment routes " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId: id, firstName: "Routes", lastName: kind})
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
        passwordHashType: "SHA",
        timeZone: ec.user.userAccount?.timeZone || "America/Chicago"
    })
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: since})
    return id
}
function product(productId, fields = {}) {
    call("create#mantle.product.Product", {
        productId,
        productName: productId,
        productTypeEnumId: "PtAsset",
        assetTypeEnumId: "AstTpInventory",
        amountUomId: "OTH_ea",
        ownerPartyId: org,
        statusId: "PrdActive"
    })
    call(
        "create#mantle.product.ProductPrice",
        Object.assign(
            {
                productId,
                vendorPartyId: supplier,
                pricePurposeEnumId: "PppPurchase",
                priceTypeEnumId: "PptCurrent",
                fromDate: since,
                minQuantity: 1,
                price: 4,
                priceUomId: "USD",
                canDropShip: "Y"
            },
            fields
        )
    )
}
// a sales order of the organization at the warehouse, placed (reserved without stock) and, unless asked not to, approved
function salesOrder(productId, quantity, approve = true) {
    login("john.doe")
    const created = call(O + "create#Order", {vendorPartyId: org, customerPartyId: customer, currencyUomId: "USD"})
    const orderId = created.orderId
    call("update#mantle.order.OrderPart", {orderId, orderPartSeqId: created.orderPartSeqId, facilityId: warehouse})
    call(O + "set#OrderBillingShippingInfo", {
        orderId,
        orderPartSeqId: created.orderPartSeqId,
        shippingPostalContactMechId: address,
        carrierPartyId: "_NA_",
        shipmentMethodEnumId: "ShMthGround"
    })
    const item = call(O + "add#OrderProductQuantity", {
        orderId,
        orderPartSeqId: created.orderPartSeqId,
        productId,
        quantity,
        unitAmount: 20
    })
    run("john.doe", O + "place#Order", {orderId})
    if (approve) run("john.doe", O + "approve#Order", {orderId})
    ec.factory.waitWorkerPoolEmpty(50)
    return {orderId, orderItemSeqId: item.orderItemSeqId || "01"}
}
const plan = productIds =>
    run(state.planner, S + "run#SupplyPlan", {organizationPartyId: org, facilityIds: [warehouse], productIds})
const suggestionOf = (planned, productId) =>
    planned.planningRunId
        ? rows("mantle.request.requirement.PlanningSuggestion", {planningRunId: planned.planningRunId, productId})[0] || null
        : null
const convert = (username, ids, extra = {}) =>
    run(username, S + "convert#PlanningSuggestions", Object.assign({operationKey: key(), planningSuggestionIds: ids}, extra))
const setPolicy = fields =>
    call("update#mantle.order.purchase.PurchasePolicy", Object.assign({organizationPartyId: org, fromDate: since}, fields))
const supplyOf = requirementId => rows("mantle.request.requirement.RequirementSupply", {requirementId})

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        for (const [partyId, roleTypeId] of [
            [org, "OrgInternal"],
            [supplier, "Supplier"],
            [customer, "Customer"]
        ]) {
            call("create#mantle.party.Party", {
                partyId,
                partyTypeEnumId: "PtyOrganization",
                ownerPartyId: partyId === supplier ? "_NA_" : null
            })
            call("create#mantle.party.Organization", {partyId, organizationName: partyId})
            call("create#mantle.party.PartyRole", {partyId, roleTypeId})
        }
        call("mantle.ledger.LedgerServices.init#PartyAccountingConfiguration", {
            organizationPartyId: org,
            sourcePartyId: "DefaultSettings",
            baseCurrencyUomId: "USD"
        })
        call("create#mantle.facility.Facility", {facilityId: warehouse, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: org})
        call("create#mantle.facility.Facility", {
            facilityId: dropFacility,
            facilityTypeEnumId: "FcTpDropShip",
            ownerPartyId: supplier,
            assetAllowOtherOwner: "Y",
            assetAllowIssueOverQoh: "Y"
        })
        call("create#mantle.party.contact.ContactMech", {contactMechId: address, contactMechTypeEnumId: "CmtPostalAddress"})
        call("create#mantle.party.contact.PostalAddress", {
            contactMechId: address,
            toName: "Routes Customer",
            address1: "4 Mill Lane",
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
        // the approval gate on, so a drop-ship purchase order waits at Placed (no send); plan buys to orders until a feature
        // turns the request route on
        call("create#mantle.order.purchase.PurchasePolicy", {
            organizationPartyId: org,
            fromDate: since,
            approvalGateEnabled: "Y",
            planBuyToRequest: "N",
            changeReason: "Spec"
        })
        state.buyer = user("BUYER", ["PURCHASE_ORDER_EDIT", "SUPPLIER_PRICE_VIEW"])
        state.buyer2 = user("BUYER2", ["PURCHASE_ORDER_EDIT", "SUPPLIER_PRICE_VIEW"])
        state.planner = user("PLANNER", ["SUPPLY_PLAN_RUN"])
        state.approver = user("APPROVER", ["PURCHASE_APPROVE"])
        state.receiver = user("RECEIVER", ["STOCK_RECEIVE", "STOCK_MOVE"])
        product(prefix + "_REQ")
        product(prefix + "_CAN")
        product(prefix + "_DROP")
        product(prefix + "_PEG")
        product(prefix + "_HELD", {standardLeadTimeDays: 10})
        product(prefix + "_UNIT")
        // a box of ten, the unit of a hand-filed request line (F-P14b-4)
        call("create#moqui.basic.Uom", {uomId: prefix + "_BOX", uomTypeEnumId: "UT_OTHER_MEASURE", abbreviation: "box"})
        call("create#moqui.basic.UomConversion", {
            uomConversionId: prefix + "_BOX_EA",
            uomId: prefix + "_BOX",
            toUomId: "OTH_ea",
            conversionFactor: 10,
            fromDate: since
        })
        // the dock and a bin, so received stock on hold is put away (F-P14b-3)
        for (const [locationSeqId, locationTypeEnumId] of [
            ["REC", "FltReceiving"],
            ["BIN", "FltBulk"]
        ])
            call("create#mantle.facility.FacilityLocation", {facilityId: warehouse, locationSeqId, locationTypeEnumId})
        // minimum stock beside the customer demand: the request route's rest line
        for (const [productId, minimumStock] of [
            [prefix + "_REQ", 5],
            [prefix + "_CAN", 3],
            [prefix + "_HELD", 5],
            [prefix + "_UNIT", 20]
        ])
            call("create#mantle.facility.ProductFacility", {productId, facilityId: warehouse, minimumStock})
        state.reqSale = salesOrder(prefix + "_REQ", 2)
        state.dropSale = salesOrder(prefix + "_DROP", 3)
        state.dropPending = salesOrder(prefix + "_DROP", 1, false)
        state.pegSale = salesOrder(prefix + "_PEG", 4)
        state.otherSale = salesOrder(prefix + "_PEG", 1)
        ec.artifactExecution.enableAuthz()
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.message.clearErrors()
        login("john.doe")
        ec.artifactExecution.enableAuthz()
    }
})

feature(
    "under the request policy a buy becomes a submitted purchase request, a line per customer line and one for the rest; a competitor is DemandAlreadyCovered and an order route refused",
    {
        when() {
            setPolicy({planBuyToRequest: "Y"})
            const planned = plan([prefix + "_REQ"])
            const suggestion = suggestionOf(planned, prefix + "_REQ")
            const operationKey = key()
            const converted = convert(state.buyer, [suggestion?.planningSuggestionId], {operationKey})
            const retry = convert(state.buyer, [suggestion?.planningSuggestionId], {operationKey})
            const competing = convert(state.buyer2, [suggestion?.planningSuggestionId])
            const ordered = convert(state.buyer2, [suggestion?.planningSuggestionId], {route: "order"})
            const result = (converted.results || [])[0] || {}
            state.requestId = result.requestId
            const items = rows("mantle.request.RequestItem", {requestId: result.requestId || "_NA_"}).sort((a, b) =>
                a.requestItemSeqId.localeCompare(b.requestItemSeqId)
            )
            const customerLink = rows("mantle.request.RequestItemOrder", {requestId: result.requestId || "_NA_"})
            return {planned, suggestion, converted, retry, competing, ordered, result, items, customerLink}
        },
        then({planned, suggestion, converted, retry, competing, ordered, result, items, customerLink}) {
            planned.error == ""
            suggestion.methodEnumId == "PsmBuy"
            n(suggestion.quantity) == 7
            // the sales line reserved without stock is the requirement's customer demand
            rows("mantle.request.requirement.RequirementOrderItem", {requirementId: suggestion.requirementId}).length == 1
            converted.error == ""
            converted.createdCount == 1
            result.route == "request"
            converted.requests[0].requestId == result.requestId
            converted.requests[0].submitted == true
            one("mantle.request.Request", {requestId: result.requestId}).statusId == "ReqSubmitted"
            one("mantle.request.Request", {requestId: result.requestId}).facilityId == warehouse
            items.length == 2
            n(items[0].quantity) == 2
            n(items[1].quantity) == 5
            items[0].supplierPartyId == supplier
            n(items[0].maximumAmount) == 8
            customerLink.length == 1
            customerLink[0].orderId == state.reqSale.orderId
            customerLink[0].requestItemSeqId == items[0].requestItemSeqId
            supplyOf(suggestion.requirementId).every(row => row.supplyTypeEnumId == "RstPurchaseRequest")
            supplyOf(suggestion.requirementId).length == 2
            one("mantle.request.requirement.PlanningSuggestion", {planningSuggestionId: suggestion.planningSuggestionId})
                .stateEnumId == "PssConverted"
            retry.existingCount == 1
            retry.results[0].requestId == result.requestId
            competing.results[0].reasonCode == "DEMAND_ALREADY_COVERED"
            competing.results[0].message.includes("purchase request " + result.requestId)
            ordered.results[0].reasonCode == "ROUTE_NOT_ALLOWED"
        }
    }
)

feature(
    "an approved purchase request's demand is not suggested again; its drop-ship line moves the customer line (F-P10-7); a cancelled request's coverage ends",
    {
        when() {
            const submittedPlan = plan([prefix + "_REQ"])
            const whileSubmitted = suggestionOf(submittedPlan, prefix + "_REQ")
            const approved = run(state.approver, R + "decide#PurchaseRequestApproval", {requestId: state.requestId})
            const approvedPlan = plan([prefix + "_REQ"])
            const whileApproved = suggestionOf(approvedPlan, prefix + "_REQ")
            const items = rows("mantle.request.RequestItem", {requestId: state.requestId}).sort((a, b) =>
                a.requestItemSeqId.localeCompare(b.requestItemSeqId)
            )
            const sourced = run(state.buyer, R + "convert#PurchaseSourcing", {
                operationKey: key(),
                lines: [
                    {requestId: state.requestId, requestItemSeqId: items[0].requestItemSeqId, route: "dropship"},
                    {requestId: state.requestId, requestItemSeqId: items[1].requestItemSeqId}
                ]
            })
            const salesItem = one("mantle.order.OrderItem", state.reqSale)
            const salesPart = one("mantle.order.OrderPart", {
                orderId: salesItem.orderId,
                orderPartSeqId: salesItem.orderPartSeqId
            })
            const dropLine = rows("mantle.order.OrderItem", {
                salesOrderId: state.reqSale.orderId,
                salesOrderItemSeqId: state.reqSale.orderItemSeqId
            })[0]
            const sourcedPlan = plan([prefix + "_REQ"])
            const whileSourced = suggestionOf(sourcedPlan, prefix + "_REQ")
            // a second request by the route, cancelled
            const canPlan = plan([prefix + "_CAN"])
            const canSuggestion = suggestionOf(canPlan, prefix + "_CAN")
            const canConverted = convert(state.buyer, [canSuggestion?.planningSuggestionId])
            const canRequestId = ((canConverted.results || [])[0] || {}).requestId
            // refused, it covers nothing: shown, not netted, and its demand suggested again (review R1)
            const refused = run(state.approver, R + "decide#PurchaseRequestApproval", {
                requestId: canRequestId,
                decision: "refuse",
                reason: "Not this month"
            })
            const refusedSuggestion = suggestionOf(plan([prefix + "_CAN"]), prefix + "_CAN")
            const cancelled = run(state.buyer, R + "cancel#PurchaseRequest", {requestId: canRequestId, reason: "Not needed"})
            setPolicy({planBuyToRequest: "N"})
            return {
                whileSubmitted,
                approved,
                whileApproved,
                sourced,
                salesPart,
                dropLine,
                whileSourced,
                canSuggestion,
                canRequestId,
                refused,
                refusedSuggestion,
                cancelled
            }
        },
        then({
            whileSubmitted,
            approved,
            whileApproved,
            sourced,
            salesPart,
            dropLine,
            whileSourced,
            canSuggestion,
            canRequestId,
            refused,
            refusedSuggestion,
            cancelled
        }) {
            whileSubmitted == null
            approved.error == ""
            approved.statusId == "ReqInProgress"
            whileApproved == null
            sourced.error == ""
            sourced.createdCount == 2
            sourced.results.some(row => row.route == "dropship" && row.orderId == dropLine.orderId)
            salesPart.facilityId == dropFacility
            dropLine.orderId != null
            rows("mantle.request.RequestItemOrder", {requestId: state.requestId}).some(row => row.orderId == dropLine.orderId)
            whileSourced == null
            canSuggestion.quantity != null
            canRequestId != null
            refused.error == ""
            n(refusedSuggestion.quantity) == 3
            JSON.parse(refusedSuggestion.provenanceJson).some(
                line => line.kind == "requestNotNetted" && line.label.startsWith("Refused purchase request") && !line.netted
            )
            cancelled.error == ""
            supplyOf(canSuggestion.requirementId).length == 1
            supplyOf(canSuggestion.requirementId)[0].thruDate != null
        }
    }
)

feature(
    "the drop-ship route moves a customer-order shortage's sales line to the supplier and buys it; no customer line and an order not approved are refused",
    {
        when() {
            const planned = plan([prefix + "_DROP", prefix + "_HELD"])
            const suggestion = suggestionOf(planned, prefix + "_DROP")
            const plain = suggestionOf(planned, prefix + "_HELD")
            const noCustomer = convert(state.buyer, [plain?.planningSuggestionId], {route: "dropShip"})
            const notDropShippable = convert(state.buyer, [suggestion?.planningSuggestionId], {
                route: "dropShip",
                supplierPartyId: customer
            })
            const converted = convert(state.buyer, [suggestion?.planningSuggestionId], {route: "dropShip"})
            const result = (converted.results || [])[0] || {}
            const salesItem = one("mantle.order.OrderItem", state.dropSale)
            const dropLine = rows("mantle.order.OrderItem", {
                salesOrderId: state.dropSale.orderId,
                salesOrderItemSeqId: state.dropSale.orderItemSeqId
            })[0]
            const pendingItem = one("mantle.order.OrderItem", state.dropPending)
            return {suggestion, noCustomer, notDropShippable, converted, result, salesItem, dropLine, pendingItem}
        },
        then({suggestion, noCustomer, notDropShippable, converted, result, salesItem, dropLine, pendingItem}) {
            n(suggestion.quantity) == 4
            noCustomer.results[0].reasonCode == "NO_CUSTOMER_LINE"
            notDropShippable.results[0].reasonCode == "NOT_DROP_SHIPPABLE"
            converted.error == ""
            result.ok == true
            result.route == "dropShip"
            result.orderId == dropLine.orderId
            result.pendingLines.length == 1
            result.remainingQuantity == "1"
            one("mantle.order.OrderPart", {orderId: salesItem.orderId, orderPartSeqId: salesItem.orderPartSeqId}).facilityId ==
                dropFacility
            one("mantle.order.OrderHeader", {orderId: dropLine.orderId}).statusId == "OrderPlaced"
            one("mantle.order.OrderPart", {orderId: dropLine.orderId}).vendorPartyId == supplier
            supplyOf(suggestion.requirementId)[0].orderId == dropLine.orderId
            n(supplyOf(suggestion.requirementId)[0].quantity) == 3
            one("mantle.request.requirement.PlanningSuggestion", {planningSuggestionId: suggestion.planningSuggestionId})
                .stateEnumId == "PssPartial"
            one("mantle.order.OrderPart", {orderId: pendingItem.orderId, orderPartSeqId: pendingItem.orderPartSeqId})
                .facilityId == warehouse
        }
    }
)

feature(
    "a customer-order shortage converted to a draft order keeps its sales line, and its receipt reserves the received stock for it",
    {
        when() {
            const planned = plan([prefix + "_PEG"])
            const suggestion = suggestionOf(planned, prefix + "_PEG")
            const converted = convert(state.buyer, [suggestion?.planningSuggestionId])
            const result = (converted.results || [])[0] || {}
            // the purchase line received in full on a receipt of its own
            login("john.doe")
            ec.artifactExecution.disableAuthz()
            const shipmentId = call("create#mantle.shipment.Shipment", {
                shipmentTypeEnumId: "ShpTpPurchase",
                statusId: "ShipDelivered",
                fromPartyId: supplier,
                toPartyId: org
            }).shipmentId
            call("create#mantle.shipment.ShipmentItem", {shipmentId, productId: prefix + "_PEG", quantity: 5})
            call("create#mantle.shipment.ShipmentItemSource", {
                shipmentId,
                productId: prefix + "_PEG",
                orderId: result.orderId,
                orderItemSeqId: result.orderItemSeqId,
                quantity: 5
            })
            const assetId = call("create#mantle.product.asset.Asset", {
                productId: prefix + "_PEG",
                facilityId: warehouse,
                ownerPartyId: org,
                assetTypeEnumId: "AstTpInventory",
                statusId: "AstOnHold",
                locationSeqId: "REC",
                hasQuantity: "Y",
                receivedDate: ec.user.nowTimestamp
            }).assetId
            // its quantities by detail (the totals are their sum); receive#Asset would also have given it to waiting
            // reservations by priority, which the offer below takes back for the pegged line
            call("create#mantle.product.asset.AssetDetail", {
                assetId,
                productId: prefix + "_PEG",
                effectiveDate: ec.user.nowTimestamp,
                quantityOnHandDiff: 5,
                availableToPromiseDiff: 5
            })
            call("create#mantle.product.receipt.AssetReceipt", {
                assetId,
                productId: prefix + "_PEG",
                orderId: result.orderId,
                orderItemSeqId: result.orderItemSeqId,
                shipmentId,
                quantityAccepted: 5,
                receivedDate: ec.user.nowTimestamp
            })
            const read = run(state.buyer, G + "get#ReceiptPegs", {shipmentId})
            const peg = {shipmentId, assetId, orderId: state.pegSale.orderId, orderItemSeqId: state.pegSale.orderItemSeqId}
            const buyerReserve = run(state.buyer, G + "reserve#ReceiptPeg", peg)
            const other = run(
                state.receiver,
                G + "reserve#ReceiptPeg",
                Object.assign({}, peg, {orderId: state.otherSale.orderId, orderItemSeqId: state.otherSale.orderItemSeqId})
            )
            const notPegged = run(
                state.receiver,
                G + "reserve#ReceiptPeg",
                Object.assign({}, peg, {orderId: state.dropPending.orderId, orderItemSeqId: state.dropPending.orderItemSeqId})
            )
            const reserved = run(state.receiver, G + "reserve#ReceiptPeg", peg)
            const again = run(state.receiver, G + "reserve#ReceiptPeg", peg)
            const reservations = rows("mantle.product.issuance.AssetReservation", {
                orderId: state.pegSale.orderId,
                orderItemSeqId: state.pegSale.orderItemSeqId
            })
            const after = run(state.receiver, G + "get#ReceiptPegs", {shipmentId})
            // its putaway from the dock keeps the reservation on the stock, now available (F-P14b-3)
            const putAway = run(state.receiver, "mantle.shipment.WarehouseTaskServices.putaway#Stock", {
                operationKey: key(),
                assetId,
                toLocationSeqId: "BIN",
                reason: "Spec bin"
            })
            const kept = rows("mantle.product.issuance.AssetReservation", {
                orderId: state.pegSale.orderId,
                orderItemSeqId: state.pegSale.orderItemSeqId
            })
            const stored = one("mantle.product.asset.Asset", {assetId})
            return {
                suggestion,
                result,
                read,
                buyerReserve,
                other,
                notPegged,
                reserved,
                again,
                reservations,
                assetId,
                after,
                putAway,
                kept,
                stored
            }
        },
        then({
            suggestion,
            result,
            read,
            buyerReserve,
            other,
            notPegged,
            reserved,
            again,
            reservations,
            assetId,
            after,
            putAway,
            kept,
            stored
        }) {
            result.ok == true
            result.orderId != null
            one("mantle.order.OrderHeader", {orderId: result.orderId}).statusId == "OrderOpen"
            rows("mantle.request.requirement.RequirementOrderItem", {requirementId: suggestion.requirementId}).some(
                row => row.orderId == state.pegSale.orderId
            )
            read.error == ""
            read.pegRows.length == 2
            read.pegRows.some(row => row.orderId == state.pegSale.orderId && row.waitingText == "4" && row.canReserve == false)
            buyerReserve.error.includes("PERMISSION_DENIED")
            other.reservedQuantity == "1"
            notPegged.error.includes("NOT_PEGGED")
            reserved.error == ""
            reserved.reservedQuantity == "4"
            again.alreadyReserved == true
            reservations.filter(row => row.assetId == assetId).reduce((total, row) => total + n(row.quantity), 0) == 4
            reservations.every(row => n(row.quantityNotAvailable || 0) == 0)
            after.pegRows.some(row => row.orderId == state.pegSale.orderId && row.reservedHereText == "4")
            putAway.error == ""
            stored.statusId == "AstAvailable"
            stored.locationSeqId == "BIN"
            kept.filter(row => row.assetId == assetId).reduce((total, row) => total + n(row.quantity), 0) == 4
            kept.every(row => n(row.quantityNotAvailable || 0) == 0)
        }
    }
)

feature("held stock of a bought product is netted within its supplier's lead time where the schedule says so", {
    when() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const assetId = call("create#mantle.product.asset.Asset", {
            productId: prefix + "_HELD",
            facilityId: warehouse,
            ownerPartyId: org,
            assetTypeEnumId: "AstTpInventory",
            statusId: "AstQuarantine",
            hasQuantity: "Y",
            quantityOnHandTotal: 5,
            availableToPromiseTotal: 0
        }).assetId
        call("create#mantle.product.quality.QualityInspection", {
            assetId,
            productId: prefix + "_HELD",
            statusId: "QiDraft",
            quantity: 5,
            heldQuantity: 5,
            dueDate: new Date(Date.now() + 3 * dayMs)
        })
        const notNetted = suggestionOf(plan([prefix + "_HELD"]), prefix + "_HELD")
        call("create#mantle.request.requirement.PlanSchedule", {
            organizationPartyId: org,
            facilityIds: warehouse,
            active: "N",
            netHeldQuantity: "Y"
        })
        const netted = suggestionOf(plan([prefix + "_HELD"]), prefix + "_HELD")
        return {notNetted, netted}
    },
    then({notNetted, netted}) {
        n(notNetted.quantity) == 5
        n(notNetted.pendingReleaseQuantity) == 5
        netted == null
    }
})

feature("an approved request line in another unit is supply in the stock unit (F-P14b-4)", {
    when() {
        const created = run(state.buyer, R + "create#PurchaseRequest", {
            organizationPartyId: org,
            requestName: "Boxes",
            facilityId: warehouse
        })
        const stored = run(state.buyer, R + "store#PurchaseRequestItem", {
            requestId: created.requestId,
            productId: prefix + "_UNIT",
            quantity: 2,
            quantityUomId: prefix + "_BOX",
            maximumAmount: 80
        })
        const submitted = run(state.buyer, R + "submit#PurchaseRequest", {requestId: created.requestId})
        const approved = run(state.approver, R + "decide#PurchaseRequestApproval", {requestId: created.requestId})
        const covered = suggestionOf(plan([prefix + "_UNIT"]), prefix + "_UNIT")
        return {stored, submitted, approved, covered}
    },
    then({stored, submitted, approved, covered}) {
        stored.error == ""
        submitted.error == ""
        approved.statusId == "ReqInProgress"
        // 2 boxes of 10 cover the minimum of 20; unconverted, 18 would be suggested
        covered == null
    }
})
