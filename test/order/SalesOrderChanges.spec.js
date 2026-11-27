// Sales' commercial order changes (impl-sales P14, design-sales §6 OrderChangeDetail, SAL-CHANGE; mantle.order.OrderChangeServices
// over OrderChanges.js and SalesOrderChanges.js): the kinds Customer Service files and the sales approver decides are applied by the
// order's owner under SALES_ORDER_CHANGE: a price change applied once under its key (the order desk refused FORBIDDEN, another
// organization's operator answered as missing, the PDF stored, the revision moved, the Change hold released); a quantity increase
// and a new line at the resolver's price with a Credit hold left in place; an active pick, a shipped and invoiced line, a stale order
// revision and an expired approval each refused by name; a shipment read under Sales by who sees its order, an invoice only by a
// receivable reader. Customer Service's own kinds are OrderChanges.spec.js'. Standalone: the
// spec's own organizations, customer, facility, products, stock and users in spec-local groups.
// Run: ./moq test mr-mantle --spec SalesOrderChanges
const S = "mantle.order.OrderChangeServices.",
    T = "mantle.shipment.WarehouseTaskServices."
const org = "SOC_ORG",
    otherOrg = "SOC_OTHER",
    customer = "SOC_CUST",
    facility = "SOC_FAC",
    since = "2000-01-01T00:00:00Z"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const n = value => (value == null ? 0 : Number(String(value)))
const code = out => (/([A-Z][A-Z0-9_]+):/.exec(out.error || "") || [])[1] || (out.error ? "ERROR" : "")
const state = {}
let keySeq = 0
const key = () => "soc-" + ++keySeq

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
        facilityId: options.vendor ? "SOC_OFAC" : facility
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
        party(customer, "Sales Change Customer", "Customer")
        state.address = call("mantle.party.ContactServices.create#PostalAddress", {
            partyId: customer,
            address1: "2 Change Street",
            city: "Springfield",
            postalCode: "11111",
            countryGeoId: "USA",
            contactMechPurposeId: "PostalShippingDest"
        }).contactMechId
        state.requester = user("SOC_REQUESTER", ["ORDER_CHANGE_REQUEST"])
        state.desk = user("SOC_DESK", ["ORDER_CHANGE_APPLY", "ORDER_CHANGE_HOLD_RELEASE", "PRICE_VIEW"])
        state.sales = user("SOC_SALES", ["SALES_APPROVE"])
        state.picker = user("SOC_PICKER", ["SHIPMENT_PICK"])
        // the order's owner applies the commercial kinds (SALES_ORDER_CHANGE in the seller's sales scope)
        state.salesChange = user("SOC_SCHANGE", ["SALES_VIEW", "SALES_ORDER_CHANGE", "ORDER_CHANGE_HOLD_RELEASE"])
        state.otherChange = user("SOC_OCHANGE", ["SALES_VIEW", "SALES_ORDER_CHANGE", "ORDER_CHANGE_HOLD_RELEASE"], otherOrg)
        // P14 review: a change operator who also edits receivables (a packed line's draft invoice), and one who cannot release the
        // Change hold apply places (a failure after the first write)
        state.arChange = user("SOC_ARCHANGE", [
            "SALES_VIEW",
            "SALES_ORDER_CHANGE",
            "ORDER_CHANGE_HOLD_RELEASE",
            "RECEIVABLE_EDIT"
        ])
        state.noRelease = user("SOC_NORELEASE", ["SALES_VIEW", "SALES_ORDER_CHANGE"])
        call("create#mantle.facility.Facility", {facilityId: facility, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: org})
        call("create#mantle.facility.FacilityLocation", {
            facilityId: facility,
            locationSeqId: "PICK1",
            locationTypeEnumId: "FltPick"
        })
        call("create#mantle.facility.Facility", {
            facilityId: "SOC_OFAC",
            facilityTypeEnumId: "FcTpWarehouse",
            ownerPartyId: otherOrg
        })
        for (const productId of ["SOC_A", "SOC_B"]) product(productId)
        receive("SOC_A", 40)
        receive("SOC_B", 10)
        // SOC_B is priced 7 by the organization (a new line's price)
        call("create#mantle.product.ProductAssoc", {
            productId: "SOC_A",
            toProductId: "SOC_B",
            productAssocTypeEnumId: "PatEquivalent",
            fromDate: since
        })
        call("create#mantle.product.ProductPrice", {
            productId: "SOC_B",
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

// a commercial proposal filed (by Customer Service or the change operator), decided by the sales approver at its revision and
// previewed by the change operator: {requestId, revision, previewVersion, saved, preview}
function approvedCommercial(filer, orderId, kind, lines, extra = {}) {
    const saved = run(
        filer,
        S + "save#OrderChange",
        Object.assign({orderId, orderChangeKindEnumId: kind, reason: "Agreed with the customer", lines}, extra)
    )
    const decided = run(state.sales, S + "decide#OrderChange", {requestId: saved.requestId, sourceRevision: saved.sourceRevision})
    const preview = run(state.salesChange, S + "preview#OrderChange", {requestId: saved.requestId}).preview
    return {
        requestId: saved.requestId,
        revision: saved.sourceRevision,
        previewVersion: preview?.previewVersion,
        saved,
        decided,
        preview
    }
}
const salesApply = (change, extra = {}, username = state.salesChange) =>
    run(
        username,
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

feature("a price change and a quantity increase with a new line are applied by the order's owner; another hold stays", {
    when() {
        // a price change Customer Service filed: the order desk may not apply it, another organization's operator does not see it,
        // the change operator applies it once under its key
        const orderId = salesOrder([["SOC_A", 2, 5]])
        const price = approvedCommercial(state.requester, orderId, "OckPrice", [{orderItemSeqId: "01", proposedUnitAmount: 4}])
        const desk = run(state.desk, S + "apply#OrderChange", {
            requestId: price.requestId,
            previewVersion: price.previewVersion,
            confirmed: "Y",
            operationKey: key()
        })
        const other = salesApply(price, {}, state.otherChange)
        const revisionBefore = revisionOfOrder(orderId)
        const priceKey = key()
        const applied = salesApply(price, {operationKey: priceKey})
        const again = salesApply(price, {operationKey: priceKey})
        // the confirmation (P20): the change operator gets as far as the recipient check, another organization's operator and the
        // approver no further than the permission and the record
        const confirm = username =>
            run(username, S + "send#OrderChangeConfirmation", {
                requestId: price.requestId,
                toAddress: "someone@elsewhere.test",
                operationKey: key()
            })
        const confirms = {own: confirm(state.salesChange), other: confirm(state.otherChange), approver: confirm(state.sales)}
        const priced = {
            item: itemOf(orderId, "01"),
            request: one("mantle.request.Request", {requestId: price.requestId}),
            holds: openHolds(orderId),
            pdf: rows("mantle.order.OrderContent", {orderId, orderContentTypeEnumId: "OctOrderChangeApplied"}),
            revision: revisionOfOrder(orderId)
        }
        // a quantity increase and a new line, filed by the change operator, on an order with a Credit hold
        const orderTwo = salesOrder([["SOC_A", 2, 5]])
        const tooLow = run(state.salesChange, S + "save#OrderChange", {
            orderId: orderTwo,
            orderChangeKindEnumId: "OckQuantity",
            lines: [{orderItemSeqId: "01", quantity: 1}]
        })
        const more = approvedCommercial(state.salesChange, orderTwo, "OckQuantity", [
            {orderItemSeqId: "01", quantity: 5},
            {productId: "SOC_B", quantity: 1}
        ])
        call("mantle.order.OrderServices.hold#Order", {orderId: orderTwo, holdTypeEnumId: "OhtCredit", holdComment: "Over limit"})
        // the customer's credit standing: the approver's to see, not the change operator's (P14 review)
        const approverPreview = run(state.sales, S + "preview#OrderChange", {requestId: more.requestId}).preview
        const moreApplied = salesApply(more)
        const items = rows("mantle.order.OrderItem", {orderId: orderTwo}).filter(row => row.itemTypeEnumId === "ItemProduct")
        return {
            price,
            desk,
            other,
            confirms,
            revisionBefore,
            applied,
            again,
            priced,
            tooLow,
            more,
            approverPreview,
            moreApplied,
            first: items.find(row => row.orderItemSeqId === "01"),
            added: items.find(row => row.productId === "SOC_B"),
            reservedFirst: reserved(orderTwo, "01"),
            credits: openHolds(orderTwo, "OhtCredit"),
            changes: openHolds(orderTwo, "OhtChange"),
            orderTwo: one("mantle.order.OrderHeader", {orderId: orderTwo})
        }
    },
    then(r) {
        r.price.saved.error === ""
        r.price.decided.error === ""
        r.price.preview.blocked === false
        r.price.preview.effects.deltaText != null
        r.price.preview.effects.changesTotal === true
        code(r.desk) === "FORBIDDEN"
        code(r.other) === "RECORD_UNAVAILABLE"
        r.applied.error === ""
        r.applied.result.changed.length === 1
        r.again.error === ""
        r.again.result.alreadyApplied === true
        n(r.priced.item.unitAmount) === 4
        n(r.priced.item.quantity) === 2
        r.priced.request.statusId === "ReqCompleted"
        r.priced.holds.length === 0
        r.priced.pdf.length === 1
        code(r.confirms.own) === "RECIPIENT_UNCHECKED"
        code(r.confirms.other) === "RECORD_UNAVAILABLE"
        code(r.confirms.approver) === "PERMISSION_DENIED"
        r.priced.revision > r.revisionBefore
        code(r.tooLow) === "QUANTITY_INVALID"
        r.more.saved.error === ""
        r.more.preview.lines.length === 2
        !r.more.preview.effects.creditText.includes("The customer is")
        r.approverPreview.effects.creditText.includes("The customer is")
        // under the commercial revision the Credit hold moves no revision, so the approval still holds
        r.moreApplied.error === ""
        r.moreApplied.result.stillHeld === true
        r.reservedFirst === 5
        n(r.first.quantity) === 5
        n(r.first.unitAmount) === 5
        n(r.added.quantity) === 1
        n(r.added.unitAmount) === 7
        r.credits.length === 1
        r.changes.length === 0
        r.orderTwo.statusId === "OrderHold"
    }
})

feature("a commercial change waits on an active pick, a shipped and invoiced line, a stale order and an expired approval", {
    when() {
        // an active pick
        const picking = salesOrder([["SOC_A", 3, 5]])
        const shipment = shipmentOf(picking)
        run(state.picker, T + "pick#ShipmentStock", {
            operationKey: key(),
            shipmentId: shipment.shipmentId,
            shipmentItemSourceId: sourceOf(picking, "01").shipmentItemSourceId,
            quantity: 1,
            locationSeqId: "PICK1"
        })
        const picked = approvedCommercial(state.requester, picking, "OckShipDate", [
            {orderItemSeqId: "01", requiredByDate: "2031-03-01T00:00:00Z"}
        ])
        const pickApply = salesApply(picked)
        // shipped and invoiced (finalized at ship): a price change is a credit memo's, not a change's
        const shippedOrder = salesOrder([["SOC_A", 1, 5]])
        const out = shipmentOf(shippedOrder)
        call("mantle.shipment.ShipmentServices.pack#ShipmentProduct", {
            shipmentId: out.shipmentId,
            shipmentPackageSeqId: out.shipmentPackageSeqId,
            productId: "SOC_A",
            quantity: 1
        })
        call("mantle.shipment.ShipmentServices.pack#Shipment", {shipmentId: out.shipmentId})
        call("mantle.shipment.ShipmentServices.ship#Shipment", {shipmentId: out.shipmentId})
        const shipped = approvedCommercial(state.requester, shippedOrder, "OckPrice", [
            {orderItemSeqId: "01", proposedUnitAmount: 3}
        ])
        const shippedApply = salesApply(shipped)
        // a stale order: the line changed after the approval
        const staleOrder = salesOrder([["SOC_A", 2, 5]])
        const stale = approvedCommercial(state.requester, staleOrder, "OckPrice", [{orderItemSeqId: "01", proposedUnitAmount: 4}])
        call("mantle.order.OrderServices.update#OrderItem", {
            orderId: staleOrder,
            orderItemSeqId: "01",
            quantity: 3,
            unitAmount: 5
        })
        const staleApply = salesApply(stale)
        // an expired approval
        const expiring = approvedCommercial(state.requester, salesOrder([["SOC_A", 2, 5]]), "OckPrice", [
            {orderItemSeqId: "01", proposedUnitAmount: 4}
        ])
        for (const row of rows("mantle.request.support.OrderChangeDecision", {requestId: expiring.requestId}))
            call("update#mantle.request.support.OrderChangeDecision", {
                orderChangeDecisionId: row.orderChangeDecisionId,
                expireDate: "2001-01-01T00:00:00Z"
            })
        const expired = salesApply(expiring)
        // the handoffs (ShipmentDetail and InvoiceDetail under Sales): the shipment of an order the change operator sees, read only, and
        // missing to another organization's; an invoice only for a receivable reader
        const shipmentRead = run(state.salesChange, "mantle.order.SalesOrderServices.get#SalesShipment", {
            shipmentId: shipment.shipmentId
        })
        const shipmentOther = run(state.otherChange, "mantle.order.SalesOrderServices.get#SalesShipment", {
            shipmentId: shipment.shipmentId
        })
        const invoiceId = rows("mantle.order.OrderItemBilling", {orderId: shippedOrder})[0]?.invoiceId
        const invoiceRead = run(state.salesChange, "mantle.order.SalesOrderServices.check#SalesInvoice", {invoiceId})
        return {
            shipmentRead,
            shipmentOther,
            invoiceRead,
            picked,
            pickApply,
            pickItem: itemOf(picking, "01"),
            pickHolds: openHolds(picking),
            shipped,
            shippedApply,
            shippedItem: itemOf(shippedOrder, "01"),
            staleApply,
            expired
        }
    },
    then(r) {
        r.picked.preview.conflicts.some(row => row.code === "ACTIVE_PICK")
        code(r.pickApply) === "ACTIVE_PICK"
        r.pickItem.requiredByDate == null
        r.pickHolds.length === 0
        r.shipped.preview.conflicts.some(row => row.code === "ALREADY_SHIPPED")
        r.shipped.preview.conflicts.some(row => row.code === "BILLING_CONFLICT")
        code(r.shippedApply) === "ALREADY_SHIPPED"
        n(r.shippedItem.unitAmount) === 5
        code(r.staleApply) === "STALE_ORDER"
        code(r.expired) === "APPROVAL_EXPIRED"
        r.shipmentRead.shipmentFound === true
        r.shipmentRead.itemRows.length === 1
        r.shipmentOther.shipmentFound === false
        code(r.invoiceRead) === "RECORD_UNAVAILABLE"
    }
})

feature(
    "a packed price line's draft invoice is released by a receivables editor; a failure after the hold leaves the order as it was",
    {
        when() {
            // part packed, not shipped: its draft invoice waits for a receivables editor, who releases it and reprices the line
            const packedOrder = salesOrder([["SOC_A", 2, 5]])
            const out = shipmentOf(packedOrder)
            call("mantle.shipment.ShipmentServices.pack#ShipmentProduct", {
                shipmentId: out.shipmentId,
                shipmentPackageSeqId: out.shipmentPackageSeqId,
                productId: "SOC_A",
                quantity: 1
            })
            call("mantle.shipment.ShipmentServices.pack#Shipment", {shipmentId: out.shipmentId})
            const billed = () => rows("mantle.order.OrderItemBilling", {orderId: packedOrder})
            const invoiceIds = [...new Set(billed().map(row => row.invoiceId))]
            const packed = approvedCommercial(state.requester, packedOrder, "OckPrice", [
                {orderItemSeqId: "01", proposedUnitAmount: 4}
            ])
            const waits = salesApply(packed)
            const arPreview = run(state.arChange, S + "preview#OrderChange", {requestId: packed.requestId}).preview
            const packedStatus = one("mantle.order.OrderHeader", {orderId: packedOrder}).statusId
            const released = salesApply(
                Object.assign({}, packed, {previewVersion: arPreview?.previewVersion}),
                {},
                state.arChange
            )
            // a failure after the first write (the Change hold placed, the price written, then its release refused): nothing stays
            const failOrder = salesOrder([["SOC_A", 2, 5]])
            const failing = approvedCommercial(state.requester, failOrder, "OckPrice", [
                {orderItemSeqId: "01", proposedUnitAmount: 4}
            ])
            const revisionBefore = revisionOfOrder(failOrder)
            const failed = salesApply(failing, {}, state.noRelease)
            const after = {
                item: itemOf(failOrder, "01"),
                holds: openHolds(failOrder),
                request: one("mantle.request.Request", {requestId: failing.requestId}),
                pdf: rows("mantle.order.OrderContent", {orderId: failOrder, orderContentTypeEnumId: "OctOrderChangeApplied"}),
                revision: revisionOfOrder(failOrder),
                status: one("mantle.order.OrderHeader", {orderId: failOrder}).statusId
            }
            const retried = salesApply(failing)
            return {
                invoiceIds,
                packed,
                packedStatus,
                waits,
                released,
                packedItem: itemOf(packedOrder, "01"),
                invoices: invoiceIds.map(invoiceId => one("mantle.account.invoice.Invoice", {invoiceId})),
                billedAfter: billed(),
                failed,
                revisionBefore,
                after,
                retried,
                retriedItem: itemOf(failOrder, "01")
            }
        },
        then(r) {
            r.invoiceIds.length === 1
            r.packed.preview.conflicts.some(row => row.code === "BILLING_CONFLICT")
            code(r.waits) === "BILLING_CONFLICT"
            r.released.error === ""
            r.released.result.released.length === 1
            n(r.packedItem.unitAmount) === 4
            r.invoices.every(row => row.statusId === "InvoiceCancelled")
            r.billedAfter.length === 0
            code(r.failed) === "PERMISSION_DENIED"
            n(r.after.item.unitAmount) === 5
            r.after.holds.length === 0
            r.after.request.statusId === "ReqSubmitted"
            r.after.pdf.length === 0
            r.after.revision === r.revisionBefore
            r.after.status === "OrderApproved"
            r.retried.error === ""
            n(r.retriedItem.unitAmount) === 4
        }
    }
)

feature("a change raising an approved order's total over the customer's credit limit leaves a Credit hold (SEC-BAP-91)", {
    when() {
        const orderId = salesOrder([["SOC_A", 2, 5]])
        const more = approvedCommercial(state.salesChange, orderId, "OckQuantity", [{orderItemSeqId: "01", quantity: 4}])
        // a hold policy whose limit the customer's open orders pass, for this feature only
        const policy = call("create#mantle.account.billing.CustomerCreditPolicy", {
            organizationPartyId: org,
            customerPartyId: customer,
            currencyUomId: "USD",
            creditLimit: 1,
            actionEnumId: "CpaHold",
            fromDate: ec.user.nowTimestamp
        }).customerCreditPolicyId
        try {
            const preview = run(state.sales, S + "preview#OrderChange", {requestId: more.requestId}).preview
            const applied = salesApply(more)
            return {
                preview,
                applied,
                credits: openHolds(orderId, "OhtCredit"),
                status: one("mantle.order.OrderHeader", {orderId}).statusId
            }
        } finally {
            call("update#mantle.account.billing.CustomerCreditPolicy", {
                customerCreditPolicyId: policy,
                thruDate: ec.user.nowTimestamp
            })
        }
    },
    then(r) {
        r.preview.effects.creditText.includes("over its credit limit now")
        r.applied.error === ""
        r.applied.result.stillHeld === true
        r.credits.length === 1
        r.status === "OrderHold"
    }
})

feature("a credit release covers the exposure it was made on: a change raising the total past it is checked again (SEC-BAP-91)", {
    when() {
        const orderId = salesOrder([["SOC_A", 2, 5]])
        const more = approvedCommercial(state.salesChange, orderId, "OckQuantity", [{orderItemSeqId: "01", quantity: 4}])
        const policy = call("create#mantle.account.billing.CustomerCreditPolicy", {
            organizationPartyId: org,
            customerPartyId: customer,
            currencyUomId: "USD",
            creditLimit: 1,
            actionEnumId: "CpaHold",
            fromDate: ec.user.nowTimestamp
        }).customerCreditPolicyId
        try {
            // a release with no expiry, made on the exposure before the change
            const before = call("mantle.account.CreditServices.evaluate#OrderCredit", {orderId, forChange: true})
            call("create#mantle.account.billing.CreditHoldDecision", {
                orderId,
                organizationPartyId: org,
                customerPartyId: customer,
                decisionEnumId: "CrdRelease",
                reason: "Known customer",
                decidedByUserId: "EX_JOHN_DOE",
                decidedDate: ec.user.nowTimestamp,
                exposureAmount: before.exposure,
                creditLimit: 1,
                currencyUomId: "USD"
            })
            const stands = call("mantle.account.CreditServices.evaluate#OrderCredit", {orderId, forChange: true}).resultEnumId
            const applied = salesApply(more)
            return {stands, applied, credits: openHolds(orderId, "OhtCredit")}
        } finally {
            call("update#mantle.account.billing.CustomerCreditPolicy", {
                customerCreditPolicyId: policy,
                thruDate: ec.user.nowTimestamp
            })
        }
    },
    then(r) {
        // the release stands on the exposure it was made on
        r.stands === "pass"
        r.applied.error === ""
        r.applied.result.stillHeld === true
        r.credits.length === 1
    }
})

// SEC-BAP-131: a line billed on a draft invoice before it shipped keeps the old price there, so a price change waits on
// Accounting; an unbilled line's price changes (the features above)
feature("a price change of a line on a draft invoice billed before shipment is a billing conflict", {
    when() {
        const orderId = salesOrder([["SOC_A", 1, 5]])
        const invoiced = run(state.arChange, "mantle.account.InvoiceServices.create#InvoiceFromSource", {
            orderId,
            organizationPartyId: org,
            operationKey: key()
        })
        const change = approvedCommercial(state.requester, orderId, "OckPrice", [{orderItemSeqId: "01", proposedUnitAmount: 4}])
        return {invoiced, change, applied: salesApply(change), item: itemOf(orderId, "01")}
    },
    then(r) {
        r.invoiced.error == "" && !!r.invoiced.invoiceId
        r.change.preview.conflicts.some(row => row.code === "BILLING_CONFLICT")
        code(r.applied) === "BILLING_CONFLICT"
        n(r.item.unitAmount) === 5
    }
})

// SEC-BAP-131 follow-up: a line with a packed shipment's draft invoice and an order-level draft invoice of its other unit: only
// the packed invoice is released, so the receivables editor's apply is still a billing conflict and the price stays
feature("an order-level draft invoice beside a packed shipment's is a billing conflict for a price change", {
    when() {
        const orderId = salesOrder([["SOC_A", 2, 5]])
        const out = shipmentOf(orderId)
        call("mantle.shipment.ShipmentServices.pack#ShipmentProduct", {
            shipmentId: out.shipmentId,
            shipmentPackageSeqId: out.shipmentPackageSeqId,
            productId: "SOC_A",
            quantity: 1
        })
        call("mantle.shipment.ShipmentServices.pack#Shipment", {shipmentId: out.shipmentId})
        const invoiced = run(state.arChange, "mantle.account.InvoiceServices.create#InvoiceFromSource", {
            orderId,
            organizationPartyId: org,
            operationKey: key()
        })
        const change = approvedCommercial(state.requester, orderId, "OckPrice", [{orderItemSeqId: "01", proposedUnitAmount: 4}])
        const preview = run(state.arChange, S + "preview#OrderChange", {requestId: change.requestId}).preview
        const applied = salesApply(Object.assign({}, change, {previewVersion: preview?.previewVersion}), {}, state.arChange)
        const billings = rows("mantle.order.OrderItemBilling", {orderId})
        return {invoiced, preview, applied, item: itemOf(orderId, "01"), billings}
    },
    then(r) {
        r.invoiced.error == ""
        new Set(r.billings.map(row => row.invoiceId)).size === 2
        r.preview.conflicts.some(row => row.code === "BILLING_CONFLICT" && row.message.includes("on a draft invoice"))
        code(r.applied) === "BILLING_CONFLICT"
        n(r.item.unitAmount) === 5
    }
})
