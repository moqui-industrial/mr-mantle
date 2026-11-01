// Packing (impl-warehouse P12, design-warehouse §10 Pack, §12 BoxTypes, §19 multiple packages and the reopened package): a
// shipment picked into a cart packs into two boxes with their weights, and Complete pack creates the sales invoice (in process
// under D3's salesInvoiceFinalizedAtShip) and requests no label; a package reopened while its invoice is in process takes the
// lines off it, and a line the order then reduces is put back and packed again; a package whose invoice is final stays
// closed; the DEMO_PA kit packs at its components' cost with no work in process left (kitCostFromComponents, F41), and with
// the flag off it is received with no cost, as before; box types, carrier codes and a facility's box types. The organization,
// stock and users (in spec-local groups) are the spec's own.
const T = "mantle.shipment.WarehouseTaskServices.",
    PK = "mantle.shipment.PackagingServices."
const org = "WPN_ORG",
    facility = "WPN_FAC",
    customer = "JoeDist"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const n = value => (value == null ? 0 : Number(String(value)))
const since = "2000-01-01T00:00:00Z"
const state = {}
let keySeq = 0
const key = () => "wpn-op-" + ++keySeq

function as(username, action) {
    login(username)
    ec.artifactExecution.disableAuthz()
    try {
        return action()
    } finally {
        ec.message.clearErrors()
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}
// a call's result with its error text ("" when it succeeds), in its own transaction so a refusal rolls back only itself
function invoke(service, parameters) {
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(service).parameters(parameters).requireNewTransaction(true).call() || {}
        return Object.assign({}, out, {error: ec.message.hasError() ? ec.message.getErrorsString() : ""})
    } catch (error) {
        return {error: String(error.message || error)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}
const run = (username, service, parameters) => as(username, () => invoke(service, parameters))
function user(partyId, permissions, organizationPartyId = org) {
    call("create#moqui.security.UserGroup", {userGroupId: partyId + "_G"})
    for (const userPermissionId of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: partyId + "_G", userPermissionId, fromDate: since})
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: partyId})
    call("create#moqui.security.UserAccount", {
        userId: partyId,
        username: partyId.toLowerCase(),
        partyId,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA"
    })
    call("create#moqui.security.UserGroupMember", {userId: partyId, userGroupId: partyId + "_G", fromDate: since})
    call("create#mantle.party.PartyRelationship", {
        fromPartyId: partyId,
        toPartyId: organizationPartyId,
        relationshipTypeEnumId: "PrtAgent",
        toRoleTypeId: "OrgInternal",
        fromDate: since
    })
}
function receive(productId, quantity, locationSeqId, acquireCost = 2, options = {}) {
    return call("mantle.product.AssetServices.receive#Asset", {
        productId,
        quantity,
        facilityId: options.facilityId || facility,
        locationSeqId,
        ownerPartyId: options.ownerPartyId || org,
        assetTypeEnumId: "AstTpInventory",
        statusId: options.statusId || "AstAvailable",
        acquireCost,
        acquireCostUomId: "USD"
    }).assetId
}
const preference = fields =>
    call("update#mantle.ledger.config.PartyAcctgPreference", Object.assign({organizationPartyId: org}, fields))
// an approved sales order of the lines ([productId, quantity]) from the facility, and its shipment
function salesShipment(lines) {
    const created = call("mantle.order.OrderServices.create#Order", {
        vendorPartyId: org,
        customerPartyId: customer,
        currencyUomId: "USD",
        facilityId: facility
    })
    for (const [productId, quantity] of lines)
        call("mantle.order.OrderServices.add#OrderProductQuantity", {
            orderId: created.orderId,
            orderPartSeqId: created.orderPartSeqId,
            productId,
            quantity,
            unitAmount: 5,
            requireInventory: false
        })
    call("mantle.order.OrderServices.set#OrderBillingShippingInfo", {
        orderId: created.orderId,
        orderPartSeqId: created.orderPartSeqId,
        shippingPostalContactMechId: "JoeDistAddr",
        carrierPartyId: "_NA_",
        shipmentMethodEnumId: "ShMthGround"
    })
    call("mantle.order.OrderServices.place#Order", {orderId: created.orderId})
    call("mantle.order.OrderServices.approve#Order", {orderId: created.orderId})
    const shipmentId = call("mantle.shipment.ShipmentServices.create#OrderPartShipment", {
        orderId: created.orderId,
        orderPartSeqId: created.orderPartSeqId
    }).shipmentId
    return {orderId: created.orderId, shipmentId}
}
const sourceOf = (shipmentId, productId) =>
    rows("mantle.shipment.ShipmentItemSource", {shipmentId}).find(row => row.productId === productId)
const packagesOf = shipmentId => rows("mantle.shipment.ShipmentPackage", {shipmentId})
const contentOf = (shipmentId, shipmentPackageSeqId) =>
    rows("mantle.shipment.ShipmentPackageContent", {shipmentId, shipmentPackageSeqId})
const invoicesOf = shipmentId =>
    [...new Set(rows("mantle.order.OrderItemBilling", {shipmentId}).map(row => row.invoiceId))].map(invoiceId =>
        one("mantle.account.invoice.Invoice", {invoiceId})
    )
const onHandAt = (productId, locationSeqId) =>
    rows("mantle.product.asset.Asset", {productId, facilityId: facility, locationSeqId}).reduce(
        (sum, row) => sum + n(row.quantityOnHandTotal),
        0
    )
// picks a whole line from its location into the shipment's cart through the P11 guard
function pickLine(shipmentId, productId, locationSeqId) {
    const line = sourceOf(shipmentId, productId)
    return run("wpn_picker", T + "pick#ShipmentStock", {
        operationKey: key(),
        shipmentId,
        shipmentItemSourceId: line.shipmentItemSourceId,
        quantity: line.quantity,
        locationSeqId
    })
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        for (const partyId of [org, "WPN_OTHER"]) {
            call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
            call("create#mantle.party.Organization", {partyId, organizationName: partyId})
            call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
        }
        call("mantle.ledger.LedgerServices.init#PartyAccountingConfiguration", {
            organizationPartyId: org,
            sourcePartyId: "DefaultSettings",
            baseCurrencyUomId: "USD"
        })
        call("mantle.ledger.LedgerServices.get#OrganizationFiscalTimePeriods", {
            organizationPartyId: org,
            filterDate: ec.user.nowTimestamp
        })
        preference({salesInvoiceFinalizedAtShip: "Y"})
        call("create#mantle.party.Party", {partyId: "WPN_CARRIER", partyTypeEnumId: "PtyOrganization"})
        call("create#mantle.party.PartyRole", {partyId: "WPN_CARRIER", roleTypeId: "Carrier"})
        user("WPN_PACKER", ["SHIPMENT_PACK"])
        user("WPN_PICKER", ["SHIPMENT_PICK"])
        user("WPN_READER", [])
        user("WPN_ADMIN", ["FACILITY_EDIT"])
        user("WPN_OUTSIDER", ["SHIPMENT_PACK", "FACILITY_EDIT"], "WPN_OTHER")
        call("create#mantle.facility.Facility", {facilityId: facility, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: org})
        for (const [locationSeqId, locationTypeEnumId] of [
            ["PICK1", "FltPick"],
            ["PICK2", "FltPick"],
            ["PICK3", "FltPick"],
            ["PACK1", "FltStaging"]
        ])
            call("create#mantle.facility.FacilityLocation", {facilityId: facility, locationSeqId, locationTypeEnumId})
        for (const productId of ["WPN_A", "WPN_B"]) {
            call("create#mantle.product.Product", {
                productId,
                productName: productId,
                productTypeEnumId: "PtAsset",
                assetTypeEnumId: "AstTpInventory",
                amountUomId: "OTH_ea",
                ownerPartyId: org
            })
            call("create#mantle.product.ProductDimension", {
                productId,
                dimensionTypeId: "ShippingWeight",
                value: 0.5,
                valueUomId: "WT_lb"
            })
        }
        receive("WPN_A", 20, "PICK1")
        receive("WPN_B", 20, "PICK2")
        // the DEMO_PA kit's components (DEMO_1_1 x1, DEMO_2_1 x2): the second component at two costs, so a batch of three
        // kits costs 12.01, which divides to 4.0033 with a remainder
        state.kitOne = receive("DEMO_1_1", 10, "PICK3", 2)
        state.kitTwoA = receive("DEMO_2_1", 5, "PICK3", 1)
        state.kitTwoB = receive("DEMO_2_1", 5, "PICK3", 1.01)
        state.kitTwoC = receive("DEMO_2_1", 6, "PICK3", 1.02)
        // stock a pack must refuse (F285): another organization's, another facility's, quarantined; and a second WPN_A asset
        call("create#mantle.facility.Facility", {facilityId: "WPN_FAC2", facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: org})
        call("create#mantle.facility.Facility", {
            facilityId: "WPN_OFAC",
            facilityTypeEnumId: "FcTpWarehouse",
            ownerPartyId: "WPN_OTHER"
        })
        state.foreignA = receive("WPN_A", 3, null, 2, {facilityId: "WPN_OFAC", ownerPartyId: "WPN_OTHER"})
        state.elsewhereA = receive("WPN_A", 3, null, 2, {facilityId: "WPN_FAC2"})
        state.heldA = receive("WPN_A", 2, "PICK1", 2, {statusId: "AstQuarantine"})
        state.secondA = receive("WPN_A", 5, "PICK2")
        for (const [id, description, weight] of [
            ["WPN_BOX_S", "Small box", 0.25],
            ["WPN_BOX_M", "Medium box", 0.5]
        ])
            call("create#mantle.shipment.ShipmentBoxType", {
                shipmentBoxTypeId: id,
                description,
                boxWeight: weight,
                weightUomId: "WT_lb",
                maxWeight: 2
            })
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

feature("a picked shipment packs into two boxes with their weights; Complete pack makes the invoice and requests no label", {
    when() {
        const {orderId, shipmentId} = salesShipment([
            ["WPN_A", 2],
            ["WPN_B", 3]
        ])
        state.order = orderId
        state.shipment = shipmentId
        state.cart = call("create#mantle.product.asset.Container", {
            facilityId: facility,
            locationSeqId: "PACK1",
            containerTypeEnumId: "CtBinShelf",
            serialNumber: "WPN-CART-1"
        }).containerId
        call("update#mantle.shipment.Shipment", {shipmentId, pickContainerId: state.cart})
        const pickedA = pickLine(shipmentId, "WPN_A", "PICK1")
        const pickedB = pickLine(shipmentId, "WPN_B", "PICK2")
        const lineA = sourceOf(shipmentId, "WPN_A").shipmentItemSourceId
        const reader = run("wpn_reader", T + "pack#ShipmentStock", {
            operationKey: key(),
            shipmentId,
            shipmentItemSourceId: lineA,
            quantity: 2
        })
        // the named or scanned stock is checked before Mantle sees it (F285)
        const assetRefusal = assetId =>
            run("wpn_packer", T + "pack#ShipmentStock", {
                operationKey: key(),
                shipmentId,
                shipmentItemSourceId: lineA,
                quantity: 1,
                assetId
            }).error
        const stockRefusals = {
            foreign: assetRefusal(state.foreignA),
            elsewhere: assetRefusal(state.elsewhereA),
            held: assetRefusal(state.heldA),
            otherProduct: assetRefusal(state.kitOne),
            heldScan: run("wpn_packer", T + "pack#ShipmentStock", {
                operationKey: key(),
                shipmentId,
                scanInput: state.heldA,
                quantity: 1
            }).error
        }
        const outsider = run("wpn_outsider", T + "pack#ShipmentStock", {
            operationKey: key(),
            shipmentId,
            shipmentItemSourceId: lineA,
            quantity: 2
        })
        const box1 = run("wpn_packer", T + "edit#ShipmentPackage", {
            operationKey: key(),
            shipmentId,
            action: "create",
            shipmentBoxTypeId: "WPN_BOX_S"
        })
        const tooMany = run("wpn_packer", T + "pack#ShipmentStock", {
            operationKey: key(),
            shipmentId,
            shipmentItemSourceId: lineA,
            quantity: 3,
            shipmentPackageSeqId: box1.result?.shipmentPackageSeqId
        })
        const packKey = key()
        const packedA = run("wpn_packer", T + "pack#ShipmentStock", {
            operationKey: packKey,
            shipmentId,
            shipmentItemSourceId: lineA,
            quantity: 2,
            shipmentPackageSeqId: box1.result?.shipmentPackageSeqId
        })
        const againA = run("wpn_packer", T + "pack#ShipmentStock", {
            operationKey: packKey,
            shipmentId,
            shipmentItemSourceId: lineA,
            quantity: 2,
            shipmentPackageSeqId: box1.result?.shipmentPackageSeqId
        })
        const box2 = run("wpn_packer", T + "edit#ShipmentPackage", {
            operationKey: key(),
            shipmentId,
            action: "create",
            shipmentBoxTypeId: "WPN_BOX_M"
        })
        const nothing = run("wpn_packer", T + "pack#ShipmentStock", {
            operationKey: key(),
            shipmentId,
            scanInput: "WPN_NOPE",
            quantity: 1,
            shipmentPackageSeqId: box2.result?.shipmentPackageSeqId
        })
        const scannedB = run("wpn_packer", T + "pack#ShipmentStock", {
            operationKey: key(),
            shipmentId,
            scanInput: "WPN_B",
            quantity: 3,
            shipmentPackageSeqId: box2.result?.shipmentPackageSeqId
        })
        const unweighed = run("wpn_packer", T + "complete#Pack", {operationKey: key(), shipmentId})
        const weighed = run("wpn_packer", T + "edit#ShipmentPackage", {
            operationKey: key(),
            shipmentId,
            action: "weigh",
            shipmentPackageSeqId: box1.result?.shipmentPackageSeqId
        })
        const heavy = run("wpn_packer", T + "edit#ShipmentPackage", {
            operationKey: key(),
            shipmentId,
            action: "update",
            shipmentPackageSeqId: box2.result?.shipmentPackageSeqId,
            weight: 2.5,
            weightUomId: "WT_lb"
        })
        const completeKey = key()
        const completed = run("wpn_packer", T + "complete#Pack", {operationKey: completeKey, shipmentId})
        const retry = run("wpn_packer", T + "complete#Pack", {operationKey: completeKey, shipmentId})
        const closed = run("wpn_packer", T + "pack#ShipmentStock", {
            operationKey: key(),
            shipmentId,
            shipmentItemSourceId: lineA,
            quantity: 1
        })
        state.box1 = box1.result?.shipmentPackageSeqId
        state.box2 = box2.result?.shipmentPackageSeqId
        return {
            stockRefusals,
            pickedA,
            pickedB,
            reader,
            outsider,
            box1,
            tooMany,
            packedA,
            againA,
            nothing,
            scannedB,
            unweighed,
            weighed,
            heavy,
            completed,
            retry,
            closed,
            packages: packagesOf(shipmentId),
            invoices: invoicesOf(shipmentId),
            routes: rows("mantle.shipment.ShipmentPackageRouteSeg", {shipmentId}),
            shipment: one("mantle.shipment.Shipment", {shipmentId}),
            contents1: contentOf(shipmentId, box1.result?.shipmentPackageSeqId),
            contents2: contentOf(shipmentId, box2.result?.shipmentPackageSeqId)
        }
    },
    then({
        stockRefusals,
        pickedA,
        pickedB,
        reader,
        outsider,
        box1,
        tooMany,
        packedA,
        againA,
        nothing,
        scannedB,
        unweighed,
        weighed,
        heavy,
        completed,
        retry,
        closed,
        packages,
        invoices,
        routes,
        shipment,
        contents1,
        contents2
    }) {
        pickedA.error === ""
        pickedB.error === ""
        stockRefusals.foreign.includes("RECORD_UNAVAILABLE")
        stockRefusals.elsewhere.includes("OTHER_FACILITY")
        stockRefusals.held.includes("HELD_STOCK")
        stockRefusals.otherProduct.includes("PRODUCT_MISMATCH")
        stockRefusals.heldScan.includes("HELD_STOCK")
        reader.error.includes("PERMISSION_DENIED")
        outsider.error.includes("RECORD_UNAVAILABLE")
        box1.result.resultCode === "CREATED"
        tooMany.error.includes("QUANTITY_EXCEEDS_REMAINING")
        packedA.error === ""
        packedA.result.resultCode === "PACKED"
        againA.result.alreadyApplied === true
        nothing.error.includes("NOT_ON_SHIPMENT")
        scannedB.error === ""
        scannedB.result.issuedQuantity === "3"
        unweighed.error.includes("WEIGHT_REQUIRED")
        // the box and its contents: 0.25 + 2 x 0.5
        n(weighed.result.weight) === 1.25
        heavy.result.warnings[0].code === "OVER_MAX_WEIGHT"
        completed.error === ""
        completed.result.resultCode === "PACKED"
        completed.result.packageCount === 2
        completed.result.labelsRequested === false
        retry.result.alreadyApplied === true
        closed.error.includes("PACK_CLOSED")
        shipment.statusId === "ShipPacked"
        packages.length === 2
        packages.every(row => n(row.weight) > 0)
        contents1.length === 1 && contents1[0].productId === "WPN_A" && n(contents1[0].quantity) === 2
        contents2.length === 1 && contents2[0].productId === "WPN_B" && n(contents2[0].quantity) === 3
        // D3: the pack invoice waits for ship; no label was requested from any carrier
        invoices.length === 1
        invoices[0].statusId === "InvoiceInProcess"
        completed.result.invoices[0].statusId === "InvoiceInProcess"
        routes.length === 2
        routes.every(row => row.labelDate == null && row.gatewayLabelId == null && row.labelUrl == null)
    }
})

feature("a package reopened while its invoice is in process leaves the invoice, and a reduced line is put back", {
    when() {
        const shipmentId = state.shipment
        const lineB = sourceOf(shipmentId, "WPN_B")
        const invoiceBefore = invoicesOf(shipmentId)[0]
        const unconfirmed = run("wpn_packer", T + "reopen#ShipmentPackage", {
            operationKey: key(),
            shipmentId,
            shipmentPackageSeqId: state.box2,
            reason: "Order change"
        })
        const reader = run("wpn_reader", T + "reopen#ShipmentPackage", {
            operationKey: key(),
            shipmentId,
            shipmentPackageSeqId: state.box2,
            reason: "Order change",
            confirmed: "Y"
        })
        const reopened = run("wpn_packer", T + "reopen#ShipmentPackage", {
            operationKey: key(),
            shipmentId,
            shipmentPackageSeqId: state.box2,
            reason: "Order change",
            confirmed: "Y"
        })
        const afterReopen = {
            shipment: one("mantle.shipment.Shipment", {shipmentId}),
            line: one("mantle.shipment.ShipmentItemSource", {shipmentItemSourceId: lineB.shipmentItemSourceId}),
            invoice: one("mantle.account.invoice.Invoice", {invoiceId: invoiceBefore.invoiceId}),
            billings: rows("mantle.order.OrderItemBilling", {shipmentId}).length,
            reservations: rows("mantle.product.issuance.AssetReservation", {
                orderId: lineB.orderId,
                orderItemSeqId: lineB.orderItemSeqId
            }),
            contents2: contentOf(shipmentId, state.box2),
            box2: packagesOf(shipmentId).find(row => row.shipmentPackageSeqId === state.box2)
        }
        // the order drops one of the three: the line is flagged, and Pick's put back returns it to the shelf
        call("mantle.order.OrderServices.cancel#OrderItem", {
            orderId: lineB.orderId,
            orderItemSeqId: lineB.orderItemSeqId,
            cancelQuantity: 1
        })
        const flagged = one("mantle.shipment.ShipmentItemSource", {shipmentItemSourceId: lineB.shipmentItemSourceId})
        const shelfBefore = onHandAt("WPN_B", "PICK2")
        const putBack = run("wpn_picker", T + "reverse#Pick", {
            operationKey: key(),
            shipmentId,
            shipmentItemSourceId: lineB.shipmentItemSourceId,
            confirmed: "Y"
        })
        const shelfAfter = onHandAt("WPN_B", "PICK2")
        const repacked = run("wpn_packer", T + "pack#ShipmentStock", {
            operationKey: key(),
            shipmentId,
            shipmentItemSourceId: lineB.shipmentItemSourceId,
            quantity: 2,
            shipmentPackageSeqId: state.box2
        })
        run("wpn_packer", T + "edit#ShipmentPackage", {
            operationKey: key(),
            shipmentId,
            action: "weigh",
            shipmentPackageSeqId: state.box2
        })
        const completed = run("wpn_packer", T + "complete#Pack", {operationKey: key(), shipmentId})
        const billedB = rows("mantle.order.OrderItemBilling", {shipmentId, orderItemSeqId: lineB.orderItemSeqId})
        return {
            unconfirmed,
            reader,
            reopened,
            afterReopen,
            flagged,
            shelfBefore,
            putBack,
            shelfAfter,
            repacked,
            completed,
            billedB,
            invoicesAfter: invoicesOf(shipmentId)
        }
    },
    then({
        unconfirmed,
        reader,
        reopened,
        afterReopen,
        flagged,
        shelfBefore,
        putBack,
        shelfAfter,
        repacked,
        completed,
        billedB,
        invoicesAfter
    }) {
        unconfirmed.error.includes("CONFIRMATION_REQUIRED")
        reader.error.includes("PERMISSION_DENIED")
        reopened.error === ""
        reopened.result.resultCode === "REOPENED"
        reopened.result.releasedInvoiceIds.length === 1
        reopened.result.unpacked[0].productId === "WPN_B"
        reopened.result.unpacked[0].quantity === "3"
        afterReopen.shipment.statusId === "ShipPicked"
        n(afterReopen.line.quantityNotHandled) === 3
        afterReopen.line.statusId === "SisPending"
        afterReopen.billings === 0
        afterReopen.invoice.statusId === "InvoiceCancelled"
        afterReopen.contents2.length === 0
        // the lowered package has no weight until it is weighed again (F288)
        afterReopen.box2.weight == null
        // the reservation is back on the picked stock in the cart, never reset
        afterReopen.reservations.length === 1
        n(afterReopen.reservations[0].quantityNotIssued) === 3
        one("mantle.product.asset.Asset", {assetId: afterReopen.reservations[0].assetId}).containerId === state.cart
        n(flagged.quantity) === 2
        n(flagged.quantityNotHandled) === 2
        n(flagged.putBackQuantity) === 1
        putBack.error === ""
        shelfAfter === shelfBefore + 1
        repacked.error === ""
        completed.error === ""
        invoicesAfter.length === 1
        invoicesAfter[0].statusId === "InvoiceInProcess"
        billedB.length === 1
        n(billedB[0].quantity) === 2
    }
})

feature("a package whose invoice is final stays closed", {
    when() {
        preference({salesInvoiceFinalizedAtShip: "N"})
        const {shipmentId} = salesShipment([["WPN_A", 1]])
        const box = run("wpn_packer", T + "edit#ShipmentPackage", {
            operationKey: key(),
            shipmentId,
            action: "create",
            shipmentBoxTypeId: "WPN_BOX_S"
        }).result.shipmentPackageSeqId
        run("wpn_packer", T + "pack#ShipmentStock", {
            operationKey: key(),
            shipmentId,
            productId: "WPN_A",
            quantity: 1,
            shipmentPackageSeqId: box
        })
        run("wpn_packer", T + "edit#ShipmentPackage", {
            operationKey: key(),
            shipmentId,
            action: "weigh",
            shipmentPackageSeqId: box
        })
        const completed = run("wpn_packer", T + "complete#Pack", {operationKey: key(), shipmentId})
        preference({salesInvoiceFinalizedAtShip: "Y"})
        const reopen = run("wpn_packer", T + "reopen#ShipmentPackage", {
            operationKey: key(),
            shipmentId,
            shipmentPackageSeqId: box,
            reason: "Too late",
            confirmed: "Y"
        })
        return {
            completed,
            reopen,
            shipment: one("mantle.shipment.Shipment", {shipmentId}),
            contents: contentOf(shipmentId, box),
            invoices: invoicesOf(shipmentId)
        }
    },
    then({completed, reopen, shipment, contents, invoices}) {
        completed.error === ""
        invoices[0].statusId !== "InvoiceInProcess"
        reopen.error.includes("INVOICE_FINALIZED")
        shipment.statusId === "ShipPacked"
        n(contents[0].quantity) === 1
    }
})

feature("the DEMO_PA kit packs at its components' cost and leaves no work in process", {
    when() {
        preference({kitCostFromComponents: "Y"})
        const {shipmentId} = salesShipment([["DEMO_PA", 3]])
        const one1 = run("wpn_packer", T + "pack#ShipmentAssembly", {
            operationKey: key(),
            shipmentId,
            productId: "DEMO_1_1",
            assemblyProductId: "DEMO_PA",
            quantity: 3
        })
        const two = run("wpn_packer", T + "pack#ShipmentAssembly", {
            operationKey: key(),
            shipmentId,
            productId: "DEMO_2_1",
            assemblyProductId: "DEMO_PA",
            quantity: 6
        })
        preference({kitCostFromComponents: "N"})
        const workEffortId = one("mantle.shipment.Shipment", {shipmentId}).assemblyWorkEffortId
        const issuances = rows("mantle.product.issuance.AssetIssuance", {workEffortId})
        const receipts = rows("mantle.product.receipt.AssetReceipt", {workEffortId})
        const value = (list, field) =>
            list.reduce(
                (sum, row) => sum + n(row[field]) * n(one("mantle.product.asset.Asset", {assetId: row.assetId}).acquireCost),
                0
            )
        // the WIP account's entries of the work effort's issuances and receipts net to zero
        const transIds = rows("mantle.ledger.transaction.AcctgTrans", {organizationPartyId: org})
            .filter(
                trans =>
                    issuances.some(row => row.assetIssuanceId === trans.assetIssuanceId) ||
                    receipts.some(row => row.assetReceiptId === trans.assetReceiptId)
            )
            .map(trans => trans.acctgTransId)
        const wip = {debit: 0, credit: 0}
        for (const acctgTransId of transIds)
            for (const entry of rows("mantle.ledger.transaction.AcctgTransEntry", {acctgTransId})) {
                const account = one("mantle.ledger.account.GlAccount", {glAccountId: entry.glAccountId})
                if (account?.glAccountTypeEnumId !== "GatWipInventory") continue
                wip[entry.debitCreditFlag === "D" ? "debit" : "credit"] += n(entry.amount)
            }
        const kitIssued = rows("mantle.product.issuance.AssetIssuance", {shipmentId, productId: "DEMO_PA"})
        // the kits go into the one package the packer packs into, and the kit-only shipment completes (F286)
        const kitPackages = packagesOf(shipmentId)
        run("wpn_packer", T + "edit#ShipmentPackage", {
            operationKey: key(),
            shipmentId,
            action: "update",
            shipmentPackageSeqId: kitPackages[0]?.shipmentPackageSeqId,
            weight: 3,
            weightUomId: "WT_lb"
        })
        const kitComplete = run("wpn_packer", T + "complete#Pack", {operationKey: key(), shipmentId})
        return {
            kitPackages,
            kitComplete,
            one1,
            two,
            issuances,
            receipts,
            issuedValue: value(issuances, "quantity"),
            receivedValue: value(receipts, "quantityAccepted"),
            wip,
            kitIssued,
            kitAssets: receipts.map(row => one("mantle.product.asset.Asset", {assetId: row.assetId}))
        }
    },
    then({kitPackages, kitComplete, one1, two, receipts, issuedValue, receivedValue, wip, kitIssued, kitAssets}) {
        kitPackages.length === 1
        kitComplete.error === ""
        kitComplete.result.packageCount === 1
        one1.error === ""
        two.error === ""
        two.result.kits.length === 2
        // a packer without financial read gets no cost in the answer
        two.result.kits.every(kit => kit.acquireCost == null)
        // 3 x DEMO_1_1 at 2.00 and 5 + 1 of DEMO_2_1 at 1.00 and 1.01: 12.01, two kits at 4.0033 and the last at 4.0034
        Math.round(issuedValue * 10000) === 120100
        Math.round(receivedValue * 10000) === 120100
        receipts.reduce((sum, row) => sum + n(row.quantityAccepted), 0) === 3
        kitAssets
            .map(asset => n(asset.acquireCost))
            .sort()
            .join() === "4.0033,4.0034"
        Math.round(wip.debit * 100) === 1201
        Math.round((wip.debit - wip.credit) * 10000) === 0
        kitIssued.reduce((sum, row) => sum + n(row.quantity), 0) === 3
    }
})

feature("a later pack of the same kit at another unit cost is received on its own asset, and WIP still nets to zero", {
    when() {
        preference({kitCostFromComponents: "Y"})
        const {shipmentId} = salesShipment([["DEMO_PA", 3]])
        const pack = (productId, quantity, assetId) =>
            run("wpn_packer", T + "pack#ShipmentAssembly", {
                operationKey: key(),
                shipmentId,
                productId,
                assemblyProductId: "DEMO_PA",
                quantity,
                assetId
            })
        const screws = pack("DEMO_2_1", 6)
        const firstTwo = pack("DEMO_1_1", 2)
        // the third kit's plate is a dearer one, named by the packer
        const dearPlate = receive("DEMO_1_1", 1, "PICK3", 2.5)
        const third = pack("DEMO_1_1", 1, dearPlate)
        preference({kitCostFromComponents: "N"})
        const workEffortId = one("mantle.shipment.Shipment", {shipmentId}).assemblyWorkEffortId
        const issuances = rows("mantle.product.issuance.AssetIssuance", {workEffortId})
        const receipts = rows("mantle.product.receipt.AssetReceipt", {workEffortId})
        const cost = row => n(one("mantle.product.asset.Asset", {assetId: row.assetId}).acquireCost)
        return {
            screws,
            firstTwo,
            third,
            receipts,
            costs: receipts.map(cost),
            issuedValue: issuances.reduce((sum, row) => sum + n(row.quantity) * cost(row), 0),
            receivedValue: receipts.reduce((sum, row) => sum + n(row.quantityAccepted) * cost(row), 0),
            packages: packagesOf(shipmentId)
        }
    },
    then({screws, firstTwo, third, receipts, costs, issuedValue, receivedValue, packages}) {
        screws.error === ""
        firstTwo.error === ""
        third.error === ""
        receipts.length === 2
        new Set(costs).size === 2
        receipts.reduce((sum, row) => sum + n(row.quantityAccepted), 0) === 3
        Math.round(issuedValue * 10000) === Math.round(receivedValue * 10000)
        packages.length === 1
    }
})

feature("a package holding one product from two assets is reopened only for a named asset (F287)", {
    when() {
        const {shipmentId} = salesShipment([["WPN_A", 2]])
        const line = sourceOf(shipmentId, "WPN_A").shipmentItemSourceId
        const box = run("wpn_packer", T + "edit#ShipmentPackage", {operationKey: key(), shipmentId, action: "create"}).result
            .shipmentPackageSeqId
        const first = run("wpn_packer", T + "pack#ShipmentStock", {
            operationKey: key(),
            shipmentId,
            shipmentItemSourceId: line,
            quantity: 1,
            shipmentPackageSeqId: box,
            assetId: state.secondA
        })
        const issuedFirst = rows("mantle.product.issuance.AssetIssuance", {shipmentId}).map(row => row.assetId)
        const second = run("wpn_packer", T + "pack#ShipmentStock", {
            operationKey: key(),
            shipmentId,
            shipmentItemSourceId: line,
            quantity: 1,
            shipmentPackageSeqId: box
        })
        const unnamed = run("wpn_packer", T + "reopen#ShipmentPackage", {
            operationKey: key(),
            shipmentId,
            shipmentPackageSeqId: box,
            reason: "Wrong unit",
            confirmed: "Y"
        })
        const named = run("wpn_packer", T + "reopen#ShipmentPackage", {
            operationKey: key(),
            shipmentId,
            shipmentPackageSeqId: box,
            assetId: state.secondA,
            reason: "Wrong unit",
            confirmed: "Y"
        })
        return {
            first,
            second,
            issuedFirst,
            unnamed,
            named,
            left: rows("mantle.product.issuance.AssetIssuance", {shipmentId}).filter(row => n(row.quantity) > 0)
        }
    },
    then({first, second, issuedFirst, unnamed, named, left}) {
        first.error === ""
        second.error === ""
        issuedFirst.includes(state.secondA)
        unnamed.error.includes("ASSET_REQUIRED")
        named.error === ""
        named.result.unpacked[0].quantity === "1"
        left.length === 1
        left[0].assetId !== state.secondA
    }
})

feature("with the flag off a kit is received with no cost, as before; its unreserved components are issued (F282)", {
    when() {
        const {orderId, shipmentId} = salesShipment([["DEMO_PA", 1]])
        // no component reservation: the assembly pack issues any available component stock to the kit's work effort
        call("mantle.product.AssetServices.remove#OrderItemReservations", {orderId, orderItemSeqId: "01"})
        run("wpn_packer", T + "pack#ShipmentAssembly", {
            operationKey: key(),
            shipmentId,
            productId: "DEMO_1_1",
            assemblyProductId: "DEMO_PA",
            quantity: 1
        })
        const two = run("wpn_packer", T + "pack#ShipmentAssembly", {
            operationKey: key(),
            shipmentId,
            productId: "DEMO_2_1",
            assemblyProductId: "DEMO_PA",
            quantity: 2
        })
        const workEffortId = one("mantle.shipment.Shipment", {shipmentId}).assemblyWorkEffortId
        const receipts = rows("mantle.product.receipt.AssetReceipt", {workEffortId})
        return {two, receipts, kit: receipts.length ? one("mantle.product.asset.Asset", {assetId: receipts[0].assetId}) : null}
    },
    then({two, receipts, kit}) {
        two.error === ""
        receipts.length === 1
        kit.acquireCost == null
        receipts[0].acctgTransResultEnumId === "AtrNoAcquireCost"
    }
})

feature("box types, carrier codes and a facility's box types are kept by the facility administrator", {
    when() {
        const reader = run("wpn_reader", PK + "store#ShipmentBoxType", {shipmentBoxTypeId: "WPN_BOX_L", description: "Large box"})
        const created = run("wpn_admin", PK + "store#ShipmentBoxType", {
            shipmentBoxTypeId: "WPN_BOX_L",
            isNew: "Y",
            description: "Large box",
            boxLength: 18,
            boxWidth: 12,
            boxHeight: 12,
            dimensionUomId: "LEN_in",
            boxWeight: 1,
            weightUomId: "WT_lb",
            maxWeight: 40
        })
        const again = run("wpn_admin", PK + "store#ShipmentBoxType", {
            shipmentBoxTypeId: "WPN_BOX_L",
            isNew: "Y",
            description: "Dup"
        })
        const badUnit = run("wpn_admin", PK + "store#ShipmentBoxType", {shipmentBoxTypeId: "WPN_BOX_L", weightUomId: "LEN_in"})
        const code = run("wpn_admin", PK + "store#CarrierShipmentBoxType", {
            carrierPartyId: "WPN_CARRIER",
            shipmentBoxTypeId: "WPN_BOX_L",
            packagingTypeCode: "02"
        })
        const notCarrier = run("wpn_admin", PK + "store#CarrierShipmentBoxType", {
            carrierPartyId: org,
            shipmentBoxTypeId: "WPN_BOX_L",
            packagingTypeCode: "02"
        })
        const used = run("wpn_admin", PK + "store#FacilityBoxType", {facilityId: facility, shipmentBoxTypeId: "WPN_BOX_L"})
        // another organization's facility administrator changes no box type WPN_ORG uses (F289)
        const sharedFacility = run("wpn_outsider", PK + "store#ShipmentBoxType", {shipmentBoxTypeId: "WPN_BOX_L", maxWeight: 10})
        const sharedPackage = run("wpn_outsider", PK + "store#ShipmentBoxType", {shipmentBoxTypeId: "WPN_BOX_S", retire: "Y"})
        const sharedCode = run("wpn_outsider", PK + "store#CarrierShipmentBoxType", {
            carrierPartyId: "WPN_CARRIER",
            shipmentBoxTypeId: "WPN_BOX_M",
            packagingTypeCode: "09"
        })
        const outsider = run("wpn_outsider", PK + "store#FacilityBoxType", {facilityId: facility, shipmentBoxTypeId: "WPN_BOX_S"})
        const {shipmentId} = salesShipment([["WPN_A", 1]])
        const notUsedHere = run("wpn_packer", T + "edit#ShipmentPackage", {
            operationKey: key(),
            shipmentId,
            action: "create",
            shipmentBoxTypeId: "WPN_BOX_S"
        })
        const usedHere = run("wpn_packer", T + "edit#ShipmentPackage", {
            operationKey: key(),
            shipmentId,
            action: "create",
            shipmentBoxTypeId: "WPN_BOX_L"
        })
        const retired = run("wpn_admin", PK + "store#ShipmentBoxType", {shipmentBoxTypeId: "WPN_BOX_L", retire: "Y"})
        const afterRetire = run("wpn_packer", T + "edit#ShipmentPackage", {
            operationKey: key(),
            shipmentId,
            action: "create",
            shipmentBoxTypeId: "WPN_BOX_L"
        })
        const removed = run("wpn_admin", PK + "store#FacilityBoxType", {
            facilityId: facility,
            shipmentBoxTypeId: "WPN_BOX_L",
            remove: "Y"
        })
        const deleted = run("wpn_packer", T + "edit#ShipmentPackage", {
            operationKey: key(),
            shipmentId,
            action: "delete",
            shipmentPackageSeqId: usedHere.result?.shipmentPackageSeqId
        })
        return {
            reader,
            created,
            again,
            badUnit,
            code,
            notCarrier,
            used,
            sharedFacility,
            sharedPackage,
            sharedCode,
            outsider,
            notUsedHere,
            usedHere,
            retired,
            afterRetire,
            removed,
            deleted,
            box: one("mantle.shipment.ShipmentBoxType", {shipmentBoxTypeId: "WPN_BOX_L"}),
            binding: one("mantle.shipment.carrier.CarrierShipmentBoxType", {
                carrierPartyId: "WPN_CARRIER",
                shipmentBoxTypeId: "WPN_BOX_L"
            }),
            packages: packagesOf(shipmentId)
        }
    },
    then({
        sharedFacility,
        sharedPackage,
        sharedCode,
        reader,
        created,
        again,
        badUnit,
        code,
        notCarrier,
        used,
        outsider,
        notUsedHere,
        usedHere,
        retired,
        afterRetire,
        removed,
        deleted,
        box,
        binding,
        packages
    }) {
        reader.error.includes("PERMISSION_DENIED")
        created.error === ""
        again.error.includes("BOX_TYPE_EXISTS")
        badUnit.error.includes("UOM_INVALID")
        code.error === ""
        binding.packagingTypeCode === "02"
        notCarrier.error.includes("CARRIER_INVALID")
        used.error === ""
        sharedFacility.error.includes("BOX_TYPE_SHARED")
        sharedPackage.error.includes("BOX_TYPE_SHARED")
        sharedCode.error.includes("BOX_TYPE_SHARED")
        outsider.error.includes("FACILITY_UNAVAILABLE")
        notUsedHere.error.includes("BOX_TYPE_UNAVAILABLE")
        usedHere.error === ""
        retired.error === ""
        box.thruDate != null
        n(box.maxWeight) === 40
        afterRetire.error.includes("BOX_TYPE_UNAVAILABLE")
        removed.error === ""
        deleted.result.resultCode === "DELETED"
        packages.length === 0
    }
})

feature("a package with no box type is not weighed and says why, and its weight entered by hand completes the pack (P18)", {
    when() {
        const {shipmentId} = salesShipment([["WPN_A", 1]])
        pickLine(shipmentId, "WPN_A", "PICK1")
        const packed = run("wpn_packer", T + "pack#ShipmentStock", {
            operationKey: key(),
            shipmentId,
            shipmentItemSourceId: sourceOf(shipmentId, "WPN_A").shipmentItemSourceId,
            quantity: 1
        })
        const seqId = packed.result?.shipmentPackageSeqId
        const weighed = run("wpn_packer", T + "edit#ShipmentPackage", {
            operationKey: key(),
            shipmentId,
            action: "weigh",
            shipmentPackageSeqId: seqId
        })
        const entered = run("wpn_packer", T + "edit#ShipmentPackage", {
            operationKey: key(),
            shipmentId,
            action: "update",
            shipmentPackageSeqId: seqId,
            weight: 3,
            weightUomId: "WT_lb"
        })
        const completed = run("wpn_packer", T + "complete#Pack", {operationKey: key(), shipmentId})
        return {packed, weighed, entered, completed, shipment: one("mantle.shipment.Shipment", {shipmentId})}
    },
    then({packed, weighed, entered, completed, shipment}) {
        packed.error === ""
        weighed.error.includes("WEIGHT_UNAVAILABLE")
        weighed.error.includes("No box type")
        entered.error === ""
        completed.error === ""
        shipment.statusId === "ShipPacked"
    }
})
