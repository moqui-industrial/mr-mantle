// Order changes (impl-customer-service P10, CS-ORDER-CHANGE, F45, F46, F54, F55, F66, F78; mantle.order.OrderChangeServices,
// OrderChanges.js): the sales commercial revision behind salesCommercialRevisionOnly and its unchanged default; a short pick's
// substitute proposed with the customer's consent, approved by another person at its revision and applied by the order desk
// (priced by the resolver, reserved, the remainder cancelled, on the shipment for Warehouse to pick); a concurrent pick
// answering STOCK_CHANGED with the order unchanged, then the open remainder cancelled with its reservation released and none
// under-reserved; between pack and ship the package reopened, the line reduced and the in-process invoice right after the
// pack and ship again; a customer's cancel requested, and applied at once only under customerImmediateCancel; a price change
// decided under SALES_APPROVE and never applied here; a stale proposal, a stale order, an expired approval, the topic's
// revision, another organization's order and a Credit hold kept when the Change hold is released. Standalone: the spec's own
// organizations, customer, contact, facility, products, stock and users in spec-local groups.
// Run: ./moq test mr-mantle --spec OrderChanges
const S = "mantle.order.OrderChangeServices.",
    T = "mantle.shipment.WarehouseTaskServices."
const org = "OCH_ORG",
    otherOrg = "OCH_OTHER",
    customer = "OCH_CUST",
    facility = "OCH_FAC",
    since = "2000-01-01T00:00:00Z"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const n = value => (value == null ? 0 : Number(String(value)))
const code = out => (/([A-Z][A-Z0-9_]+):/.exec(out.error || "") || [])[1] || (out.error ? "ERROR" : "")
const state = {}
let keySeq = 0
const key = () => "och-" + ++keySeq

// a call as a user, in its own transaction so a refusal rolls back only itself: its result with its error text
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
function party(partyId, name, roleTypeId, typeId = "PtyOrganization") {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: typeId})
    if (typeId === "PtyOrganization") call("create#mantle.party.Organization", {partyId, organizationName: name})
    else call("create#mantle.party.Person", {partyId, firstName: name, lastName: "Spec"})
    if (roleTypeId) call("create#mantle.party.PartyRole", {partyId, roleTypeId})
}
function account(partyId) {
    call("create#moqui.security.UserAccount", {
        userId: partyId,
        username: partyId.toLowerCase(),
        partyId,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA"
    })
}
function user(partyId, permissions, organizationPartyId = org) {
    call("create#moqui.security.UserGroup", {userGroupId: partyId + "_G"})
    for (const userPermissionId of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: partyId + "_G", userPermissionId, fromDate: since})
    party(partyId, partyId, null, "PtyPerson")
    account(partyId)
    call("create#moqui.security.UserGroupMember", {userId: partyId, userGroupId: partyId + "_G", fromDate: since})
    call("create#mantle.party.PartyRelationship", {
        fromPartyId: partyId,
        toPartyId: organizationPartyId,
        relationshipTypeEnumId: "PrtAgent",
        toRoleTypeId: "OrgInternal",
        fromDate: since
    })
    return partyId.toLowerCase()
}
function product(productId) {
    call("create#mantle.product.Product", {
        productId,
        productName: productId,
        productTypeEnumId: "PtAsset",
        assetTypeEnumId: "AstTpInventory",
        amountUomId: "OTH_ea",
        ownerPartyId: org
    })
}
const receive = (productId, quantity) =>
    call("mantle.product.AssetServices.receive#Asset", {
        productId,
        quantity,
        facilityId: facility,
        locationSeqId: "PICK1",
        ownerPartyId: org,
        assetTypeEnumId: "AstTpInventory",
        statusId: "AstAvailable",
        acquireCost: 2,
        acquireCostUomId: "USD"
    })
// a sales order of the organization ([productId, quantity, unitAmount] lines), placed and, unless told not to, approved
function salesOrder(lines, options = {}) {
    const created = call("mantle.order.OrderServices.create#Order", {
        vendorPartyId: options.vendor || org,
        customerPartyId: customer,
        currencyUomId: "USD",
        facilityId: options.vendor ? "OCH_OFAC" : facility
    })
    for (const [productId, quantity, unitAmount] of lines)
        call("mantle.order.OrderServices.add#OrderProductQuantity", {
            orderId: created.orderId,
            orderPartSeqId: created.orderPartSeqId,
            productId,
            quantity,
            unitAmount,
            requireInventory: false
        })
    call("mantle.order.OrderServices.set#OrderBillingShippingInfo", {
        orderId: created.orderId,
        orderPartSeqId: created.orderPartSeqId,
        shippingPostalContactMechId: state.address,
        carrierPartyId: "_NA_",
        shipmentMethodEnumId: "ShMthGround"
    })
    // an order part that reserves at approval: placed, nothing on it is reserved yet
    if (options.reserveAtApproval)
        call("update#mantle.order.OrderPart", {
            orderId: created.orderId,
            orderPartSeqId: created.orderPartSeqId,
            reservationAutoEnumId: "AsResAutoApproved"
        })
    call("mantle.order.OrderServices.place#Order", {orderId: created.orderId})
    if (options.approve !== false) call("mantle.order.OrderServices.approve#Order", {orderId: created.orderId})
    return created.orderId
}
const shipmentOf = orderId => call("mantle.shipment.ShipmentServices.create#OrderPartShipment", {orderId, orderPartSeqId: "01"})
const sourceOf = (orderId, orderItemSeqId) =>
    rows("mantle.shipment.ShipmentItemSource", {orderId, orderItemSeqId}).find(row => row.statusId !== "SisCancelled")
const itemOf = (orderId, orderItemSeqId) => one("mantle.order.OrderItem", {orderId, orderItemSeqId})
const reserved = (orderId, orderItemSeqId) =>
    rows("mantle.product.issuance.AssetReservation", {orderId, orderItemSeqId}).reduce((sum, row) => sum + n(row.quantity), 0)
const openHolds = (orderId, holdTypeEnumId) =>
    rows("mantle.order.OrderHoldReason", {orderId}).filter(
        row => !row.releasedDate && (!holdTypeEnumId || row.holdTypeEnumId === holdTypeEnumId)
    )
const revisionOfOrder = orderId => n(one("mantle.order.OrderHeader", {orderId}).orderRevision || 1)
// a cancel of a line, proposed, approved and previewed: {requestId, revision, previewVersion}
function approvedCancel(orderId, orderItemSeqId, quantity) {
    const saved = run(state.requester, S + "save#OrderChange", {
        orderId,
        orderChangeKindEnumId: "OckCancel",
        reason: "The customer no longer needs them",
        lines: [{orderItemSeqId, quantity}]
    })
    run(state.approver, S + "decide#OrderChange", {requestId: saved.requestId, sourceRevision: saved.sourceRevision})
    const preview = run(state.desk, S + "preview#OrderChange", {requestId: saved.requestId}).preview
    return {requestId: saved.requestId, revision: saved.sourceRevision, previewVersion: preview?.previewVersion, saved, preview}
}
const applyChange = (change, extra = {}) =>
    run(
        state.desk,
        S + "apply#OrderChange",
        Object.assign(
            {
                requestId: change.requestId,
                sourceRevision: change.revision,
                previewVersion: change.previewVersion,
                confirmed: "Y",
                operationKey: key()
            },
            extra
        )
    )

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        for (const partyId of [org, otherOrg]) party(partyId, partyId, "OrgInternal")
        call("mantle.ledger.LedgerServices.init#PartyAccountingConfiguration", {
            organizationPartyId: org,
            sourcePartyId: "DefaultSettings",
            baseCurrencyUomId: "USD"
        })
        call("mantle.ledger.LedgerServices.get#OrganizationFiscalTimePeriods", {
            organizationPartyId: org,
            filterDate: ec.user.nowTimestamp
        })
        call("update#mantle.ledger.config.PartyAcctgPreference", {
            organizationPartyId: org,
            salesInvoiceFinalizedAtShip: "Y",
            salesCommercialRevisionOnly: "Y"
        })
        party(customer, "Order Change Customer", "Customer")
        state.address = call("mantle.party.ContactServices.create#PostalAddress", {
            partyId: customer,
            address1: "1 Change Street",
            city: "Springfield",
            postalCode: "11111",
            countryGeoId: "USA",
            contactMechPurposeId: "PostalShippingDest"
        }).contactMechId
        party("OCH_CONTACT", "Contact", null, "PtyPerson")
        account("OCH_CONTACT")
        call("create#mantle.party.PartyRelationship", {
            fromPartyId: "OCH_CONTACT",
            toPartyId: customer,
            relationshipTypeEnumId: "PrtContact",
            fromDate: since
        })
        state.contact = "och_contact"
        state.requester = user("OCH_REQUESTER", ["ORDER_CHANGE_REQUEST"])
        state.approver = user("OCH_APPROVER", ["ORDER_CHANGE_APPROVE", "ORDER_CHANGE_REQUEST"])
        state.desk = user("OCH_DESK", ["ORDER_CHANGE_APPLY", "ORDER_CHANGE_HOLD_RELEASE", "PRICE_VIEW"])
        state.sales = user("OCH_SALES", ["SALES_APPROVE"])
        state.picker = user("OCH_PICKER", ["SHIPMENT_PICK"])
        state.outsider = user(
            "OCH_OUTSIDER",
            ["ORDER_CHANGE_REQUEST", "ORDER_CHANGE_APPROVE", "ORDER_CHANGE_APPLY", "ORDER_CHANGE_HOLD_RELEASE"],
            otherOrg
        )
        call("create#mantle.facility.Facility", {facilityId: facility, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: org})
        call("create#mantle.facility.FacilityLocation", {
            facilityId: facility,
            locationSeqId: "PICK1",
            locationTypeEnumId: "FltPick"
        })
        call("create#mantle.facility.Facility", {
            facilityId: "OCH_OFAC",
            facilityTypeEnumId: "FcTpWarehouse",
            ownerPartyId: otherOrg
        })
        for (const productId of ["OCH_A", "OCH_B", "OCH_C", "OCH_D"]) product(productId)
        receive("OCH_A", 40)
        receive("OCH_B", 10)
        // OCH_B is an equivalent of OCH_A, priced 7 by the organization; OCH_D is not; OCH_C has no stock
        call("create#mantle.product.ProductAssoc", {
            productId: "OCH_A",
            toProductId: "OCH_B",
            productAssocTypeEnumId: "PatEquivalent",
            fromDate: since
        })
        call("create#mantle.product.ProductPrice", {
            productId: "OCH_B",
            vendorPartyId: org,
            pricePurposeEnumId: "PppPurchase",
            priceTypeEnumId: "PptCurrent",
            fromDate: since,
            minQuantity: 1,
            price: 7,
            priceUomId: "USD"
        })
        state.policy = call("create#mantle.request.support.ServicePolicy", {
            organizationPartyId: org,
            customerImmediateCancel: "N",
            fromDate: since
        }).servicePolicyId
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

feature("the sales commercial revision: under the flag a note and a hold do not count and a line does; by default all do", {
    when() {
        const counted = orderId => {
            const start = revisionOfOrder(orderId)
            call("create#mantle.order.OrderNote", {orderId, noteText: "A note", noteDate: ec.user.nowTimestamp})
            const afterNote = revisionOfOrder(orderId)
            const held = call("mantle.order.OrderServices.hold#Order", {
                orderId,
                holdTypeEnumId: "OhtCredit",
                holdComment: "Spec"
            })
            const afterHold = revisionOfOrder(orderId)
            call("update#mantle.order.OrderHoldReason", {
                orderHoldReasonId: held.orderHoldReasonId,
                releasedDate: ec.user.nowTimestamp,
                releaseComment: "Spec"
            })
            call("mantle.order.OrderServices.update#OrderStatus", {orderId, statusId: "OrderApproved"})
            const beforeLine = revisionOfOrder(orderId)
            call("mantle.order.OrderServices.update#OrderItem", {orderId, orderItemSeqId: "01", quantity: 3})
            return {note: afterNote - start, hold: afterHold - afterNote, line: revisionOfOrder(orderId) - beforeLine}
        }
        return {
            flagged: counted(salesOrder([["OCH_A", 2, 5]])),
            plain: counted(salesOrder([["OCH_A", 2, 5]], {vendor: otherOrg}))
        }
    },
    then({flagged, plain}) {
        flagged.note === 0
        flagged.hold === 0
        flagged.line >= 1
        // the default (no flag): a note and a status change count, as before
        plain.note === 1
        plain.hold >= 1
    }
})

feature("a short pick's substitute: proposed with consent, approved by another person and applied by the order desk", {
    when() {
        const orderId = salesOrder([["OCH_A", 4, 5]])
        const shipment = shipmentOf(orderId)
        const source = sourceOf(orderId, "01")
        const short = run(state.picker, T + "record#ShortPick", {
            operationKey: key(),
            shipmentId: shipment.shipmentId,
            shipmentItemSourceId: source.shipmentItemSourceId,
            quantityShort: 1,
            locationSeqId: "PICK1",
            reasonEnumId: "SprNotFound",
            resolutionEnumId: "SpresSubstitute",
            requestRecount: "N"
        })
        const exceptionId = short.result?.exceptionId
        const line = productId => [
            {orderItemSeqId: "01", changeActionEnumId: "OclSubstitute", productId, quantity: 1, pickExceptionId: exceptionId}
        ]
        const proposal = {orderId, orderChangeKindEnumId: "OckSubstitute", reason: "Short pick"}
        const noConsent = run(state.requester, S + "save#OrderChange", Object.assign({lines: line("OCH_B")}, proposal))
        const notEquivalent = run(
            state.requester,
            S + "save#OrderChange",
            Object.assign({lines: line("OCH_D"), customerConsentRef: "Call 1"}, proposal)
        )
        const outsider = run(
            state.outsider,
            S + "save#OrderChange",
            Object.assign({lines: line("OCH_B"), customerConsentRef: "Call 1"}, proposal)
        )
        const saved = run(
            state.requester,
            S + "save#OrderChange",
            Object.assign({lines: line("OCH_B"), customerConsentRef: "Call with the buyer, Nov 5"}, proposal)
        )
        const requestId = saved.requestId
        const notice = rows("moqui.security.user.NotificationMessage", {topic: "OrderChangeApproval", recordId: requestId})[0]
        const noRevision = run(state.approver, S + "approve#OrderChangeMessage", {recordId: requestId, message: {}})
        // the proposal changed after its notice: the notice's revision is refused, naming the current one
        const requesterAgain = run(state.requester, S + "save#OrderChange", {
            requestId,
            customerConsentRef: "Call with the buyer, Nov 5",
            lines: line("OCH_B")
        })
        const staleTopic = run(state.approver, S + "approve#OrderChangeMessage", {
            recordEntityName: "mantle.request.Request",
            recordId: requestId,
            message: {sourceRevision: saved.sourceRevision}
        })
        const approved = run(state.approver, S + "decide#OrderChange", {requestId, sourceRevision: requesterAgain.sourceRevision})
        const preview = run(state.desk, S + "preview#OrderChange", {requestId}).preview
        const approverApplies = run(state.approver, S + "apply#OrderChange", {
            requestId,
            previewVersion: preview.previewVersion,
            confirmed: "Y",
            operationKey: key()
        })
        const unconfirmed = run(state.desk, S + "apply#OrderChange", {
            requestId,
            previewVersion: preview.previewVersion,
            operationKey: key()
        })
        const applyKey = key()
        const applied = run(state.desk, S + "apply#OrderChange", {
            requestId,
            sourceRevision: requesterAgain.sourceRevision,
            previewVersion: preview.previewVersion,
            confirmed: "Y",
            operationKey: applyKey
        })
        const retry = run(state.desk, S + "apply#OrderChange", {
            requestId,
            sourceRevision: requesterAgain.sourceRevision,
            previewVersion: preview.previewVersion,
            confirmed: "Y",
            operationKey: applyKey
        })
        // the confirmation email goes only to the customer's own addresses
        const unchecked = run(state.desk, S + "send#OrderChangeConfirmation", {
            requestId,
            toAddress: "someone@elsewhere.test",
            operationKey: key()
        })
        const added = rows("mantle.order.OrderItem", {orderId}).find(row => row.productId === "OCH_B")
        return {
            noConsent,
            notEquivalent,
            outsider,
            saved,
            notice,
            requesterAgain,
            staleTopic,
            noRevision,
            approved,
            preview,
            approverApplies,
            unconfirmed,
            applied,
            retry,
            unchecked,
            original: itemOf(orderId, "01"),
            added,
            addedReserved: added ? reserved(orderId, added.orderItemSeqId) : 0,
            addedSource: added ? sourceOf(orderId, added.orderItemSeqId) : null,
            shipmentId: shipment.shipmentId,
            exception: one("mantle.shipment.ShipmentPickException", {exceptionId}),
            order: one("mantle.order.OrderHeader", {orderId}),
            holds: openHolds(orderId),
            request: one("mantle.request.Request", {requestId}),
            content: rows("mantle.order.OrderContent", {orderId, orderContentTypeEnumId: "OctOrderChangeApplied"})
        }
    },
    then(r) {
        code(r.noConsent) === "CONSENT_REQUIRED"
        code(r.notEquivalent) === "SUBSTITUTE_INVALID"
        code(r.outsider) === "RECORD_UNAVAILABLE"
        r.saved.error === ""
        r.saved.stateText === "Requested"
        r.notice != null
        r.requesterAgain.sourceRevision > r.saved.sourceRevision
        code(r.staleTopic) === "STALE_REVISION"
        code(r.noRevision) === "REVISION_REQUIRED"
        r.approved.error === ""
        r.approved.decisionEnumId === "OcdApproved"
        r.preview.blocked === false
        r.preview.lines[0].substitutePriceText != null
        code(r.approverApplies) === "PERMISSION_DENIED"
        code(r.unconfirmed) === "CONFIRMATION_REQUIRED"
        r.applied.error === ""
        r.applied.result.added.length === 1
        r.retry.result.alreadyApplied === true
        code(r.unchecked) === "RECIPIENT_UNCHECKED"
        // the substitute priced by the resolver, reserved and on the shipment; the short remainder cancelled
        r.added.productId === "OCH_B"
        n(r.added.unitAmount) === 7
        r.addedReserved === 1
        r.addedSource?.shipmentId === r.shipmentId
        n(r.original.quantity) === 3
        n(r.original.quantityCancelled) === 1
        r.exception.resolutionEnumId === "SpresSubstitute"
        r.order.statusId === "OrderApproved"
        r.holds.length === 0
        r.request.statusId === "ReqCompleted"
        r.content.length === 1
    }
})

feature(
    "a concurrent pick answers STOCK_CHANGED with the order unchanged; then the open remainder's cancel releases its reservation",
    {
        when() {
            const orderId = salesOrder([["OCH_A", 5, 5]])
            const shipment = shipmentOf(orderId)
            const change = approvedCancel(orderId, "01", 2)
            const picked = run(state.picker, T + "pick#ShipmentStock", {
                operationKey: key(),
                shipmentId: shipment.shipmentId,
                shipmentItemSourceId: sourceOf(orderId, "01").shipmentItemSourceId,
                quantity: 1,
                locationSeqId: "PICK1"
            })
            const changed = applyChange(change)
            const unchanged = {item: itemOf(orderId, "01"), holds: openHolds(orderId), reserved: reserved(orderId, "01")}
            const again = run(state.desk, S + "preview#OrderChange", {requestId: change.requestId}).preview
            const applied = applyChange(Object.assign({}, change, {previewVersion: again.previewVersion}))
            return {
                change,
                picked,
                changed,
                unchanged,
                applied,
                item: itemOf(orderId, "01"),
                reserved: reserved(orderId, "01"),
                source: sourceOf(orderId, "01")
            }
        },
        then({change, picked, changed, unchanged, applied, item, reserved, source}) {
            change.saved.error === ""
            change.preview.blocked === false
            picked.error === ""
            code(changed) === "STOCK_CHANGED"
            n(unchanged.item.quantity) === 5
            unchanged.holds.length === 0
            unchanged.reserved === 5
            applied.error === ""
            n(item.quantity) === 3
            n(item.quantityCancelled) === 2
            // F66: the line's remainder stays reserved, none above and none below it
            reserved === 3
            n(source.quantity) === 3
        }
    }
)

feature("between pack and ship the package is reopened, the line reduced, and the invoice is right after pack and ship", {
    when() {
        const orderId = salesOrder([["OCH_A", 3, 5]])
        const shipment = shipmentOf(orderId)
        call("mantle.shipment.ShipmentServices.pack#ShipmentProduct", {
            shipmentId: shipment.shipmentId,
            shipmentPackageSeqId: shipment.shipmentPackageSeqId,
            productId: "OCH_A",
            quantity: 3
        })
        call("mantle.shipment.ShipmentServices.pack#Shipment", {shipmentId: shipment.shipmentId})
        const invoiceIdOf = () =>
            [...new Set(rows("mantle.order.OrderItemBilling", {orderId}).map(row => row.invoiceId))]
                .map(invoiceId => one("mantle.account.invoice.Invoice", {invoiceId}))
                .filter(row => row.statusId !== "InvoiceCancelled")
        const packInvoice = invoiceIdOf()[0]
        const change = approvedCancel(orderId, "01", 1)
        const applied = applyChange(change)
        const afterApply = {
            shipment: one("mantle.shipment.Shipment", {shipmentId: shipment.shipmentId}),
            invoice: one("mantle.account.invoice.Invoice", {invoiceId: packInvoice.invoiceId}),
            content: rows("mantle.shipment.ShipmentPackageContent", {shipmentId: shipment.shipmentId})[0],
            item: itemOf(orderId, "01"),
            order: one("mantle.order.OrderHeader", {orderId})
        }
        call("mantle.shipment.ShipmentServices.pack#Shipment", {shipmentId: shipment.shipmentId})
        call("mantle.shipment.ShipmentServices.ship#Shipment", {shipmentId: shipment.shipmentId})
        const shippedInvoices = invoiceIdOf()
        // a cancel of what shipped is a return's
        const shippedCancel = run(state.requester, S + "save#OrderChange", {
            orderId,
            orderChangeKindEnumId: "OckCancel",
            lines: [{orderItemSeqId: "01", quantity: 1}]
        })
        return {packInvoice, applied, afterApply, shippedInvoices, shippedCancel}
    },
    then({packInvoice, applied, afterApply, shippedInvoices, shippedCancel}) {
        packInvoice.statusId === "InvoiceInProcess"
        applied.error === ""
        applied.result.reopened.length === 1
        afterApply.shipment.statusId === "ShipPicked"
        afterApply.invoice.statusId === "InvoiceCancelled"
        n(afterApply.content.quantity) === 2
        n(afterApply.item.quantity) === 2
        afterApply.order.statusId === "OrderApproved"
        shippedInvoices.length === 1
        shippedInvoices[0].statusId !== "InvoiceInProcess"
        n(shippedInvoices[0].invoiceTotal) === 10
        code(shippedCancel) === "ALREADY_SHIPPED"
    }
})

feature("a customer's cancel is requested, and applied at once only under customerImmediateCancel before anything is reserved", {
    when() {
        const ask = (orderId, kind = "OckCancel") =>
            run(state.contact, S + "save#OrderChange", {
                orderId,
                orderChangeKindEnumId: kind,
                customerConsentRef: "Account page",
                lines: [{orderItemSeqId: "01", quantity: 2}]
            })
        const offOrder = salesOrder([["OCH_C", 2, 5]], {approve: false, reserveAtApproval: true})
        const off = ask(offOrder)
        const price = ask(offOrder, "OckPrice")
        call("update#mantle.request.support.ServicePolicy", {servicePolicyId: state.policy, customerImmediateCancel: "Y"})
        const onOrder = salesOrder([["OCH_C", 2, 5]], {approve: false, reserveAtApproval: true})
        const on = ask(onOrder)
        // reserved stock: requested, not applied
        const stockedOrder = salesOrder([["OCH_A", 2, 5]], {approve: false})
        const stocked = ask(stockedOrder)
        call("update#mantle.request.support.ServicePolicy", {servicePolicyId: state.policy, customerImmediateCancel: "N"})
        return {
            off,
            offOrder: one("mantle.order.OrderHeader", {orderId: offOrder}),
            price,
            on,
            onOrder: one("mantle.order.OrderHeader", {orderId: onOrder}),
            onDecision: rows("mantle.request.support.OrderChangeDecision", {requestId: on.requestId})[0],
            stocked,
            stockedOrder: one("mantle.order.OrderHeader", {orderId: stockedOrder})
        }
    },
    then(r) {
        r.off.error === ""
        r.off.immediate === false
        r.off.stateText === "Cancellation requested"
        r.offOrder.statusId === "OrderPlaced"
        code(r.price) === "PERMISSION_DENIED"
        r.on.error === ""
        r.on.immediate === true
        r.onOrder.statusId === "OrderCancelled"
        r.onDecision.servicePolicyId != null
        r.onDecision.decidedByUserId == null
        r.stocked.immediate === false
        r.stockedOrder.statusId === "OrderPlaced"
    }
})

feature(
    "a price change is decided under SALES_APPROVE and never applied here; stale, expired and another organization's refused",
    {
        when() {
            const orderId = salesOrder([["OCH_A", 2, 5]])
            const price = run(state.requester, S + "save#OrderChange", {
                orderId,
                orderChangeKindEnumId: "OckPrice",
                reason: "Agreed discount",
                lines: [{orderItemSeqId: "01", proposedUnitAmount: 4}]
            })
            const serviceApprover = run(state.approver, S + "decide#OrderChange", {
                requestId: price.requestId,
                sourceRevision: price.sourceRevision
            })
            const salesDecided = run(state.sales, S + "decide#OrderChange", {
                requestId: price.requestId,
                sourceRevision: price.sourceRevision
            })
            const priceApply = run(state.desk, S + "apply#OrderChange", {
                requestId: price.requestId,
                previewVersion: "x",
                confirmed: "Y",
                operationKey: key()
            })
            const otherRead = run(state.outsider, S + "get#OrderChange", {requestId: price.requestId})
            const listed = run(state.requester, S + "find#OrderChanges", {orderId, state: "approved"})
            const otherList = run(state.outsider, S + "find#OrderChanges", {orderId})
            // a stale order: the line changed after the approval
            const stale = approvedCancel(orderId, "01", 1)
            call("mantle.order.OrderServices.update#OrderItem", {orderId, orderItemSeqId: "01", quantity: 3})
            const staleOrder = applyChange(stale)
            // an expired approval
            const orderTwo = salesOrder([["OCH_A", 2, 5]])
            const expiring = approvedCancel(orderTwo, "01", 1)
            for (const row of rows("mantle.request.support.OrderChangeDecision", {requestId: expiring.requestId}))
                call("update#mantle.request.support.OrderChangeDecision", {
                    orderChangeDecisionId: row.orderChangeDecisionId,
                    expireDate: "2001-01-01T00:00:00Z"
                })
            const expired = applyChange(expiring)
            // the person who proposed it does not approve it (ServicePolicy orderChangeSelfApproval empty)
            const selfFiled = run(state.approver, S + "save#OrderChange", {
                orderId: orderTwo,
                orderChangeKindEnumId: "OckCancel",
                lines: [{orderItemSeqId: "01", quantity: 1}]
            })
            const selfApproval = run(state.approver, S + "decide#OrderChange", {
                requestId: selfFiled.requestId,
                sourceRevision: selfFiled.sourceRevision
            })
            // a Credit hold placed by Accounting stays when the Change hold is released
            const orderThree = salesOrder([["OCH_A", 2, 5]])
            const credit = approvedCancel(orderThree, "01", 1)
            call("mantle.order.OrderServices.hold#Order", {
                orderId: orderThree,
                holdTypeEnumId: "OhtCredit",
                holdComment: "Over limit"
            })
            const heldApply = applyChange(credit)
            return {
                price,
                serviceApprover,
                salesDecided,
                priceApply,
                otherRead,
                listed,
                otherList,
                staleOrder,
                expired,
                selfApproval,
                heldApply,
                orderThree: one("mantle.order.OrderHeader", {orderId: orderThree}),
                credits: openHolds(orderThree, "OhtCredit"),
                changes: openHolds(orderThree, "OhtChange"),
                itemThree: itemOf(orderThree, "01")
            }
        },
        then(r) {
            r.price.error === ""
            code(r.serviceApprover) === "PERMISSION_DENIED"
            r.salesDecided.error === ""
            code(r.priceApply) === "FORBIDDEN"
            code(r.otherRead) === "RECORD_UNAVAILABLE"
            r.listed.changeList.some(row => row.requestId === r.price.requestId && row.kindText === "Price")
            r.otherList.changeList.length === 0
            code(r.staleOrder) === "STALE_ORDER"
            code(r.expired) === "APPROVAL_EXPIRED"
            code(r.selfApproval) === "SELF_APPROVAL"
            r.heldApply.error === ""
            r.heldApply.result.stillHeld === true
            r.orderThree.statusId === "OrderHold"
            r.credits.length === 1
            r.changes.length === 0
            n(r.itemThree.quantity) === 1
        }
    }
)
