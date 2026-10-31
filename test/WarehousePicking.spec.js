// Picking (impl-warehouse P11, design-warehouse §9): a wave from three ready orders previews one held order as excluded and
// creates two loads, each group with its result, a retry answering the first; a picker picks one line into the pick
// container and short-picks another, which shows Short, opens a recount and leaves on-hand unchanged; a cancelled balance
// (cancel#OrderItem) flags the line to put back and nothing moves until the picker confirms; finishing a shipment names what
// is outstanding until it is backordered; a pick face below its minimum lists its bulk source and is refilled through the
// move guard; a load's bins, people and equipment. The users are in spec-local groups.
const T = "mantle.shipment.WarehouseTaskServices.",
    W = "mantle.work.ShipmentWorkServices."
const org = "WPK_ORG",
    facility = "WPK_FAC",
    customer = "JoeDist"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const n = value => (value == null ? 0 : Number(String(value)))
const since = "2000-01-01T00:00:00Z"
const state = {}
let keySeq = 0
const key = () => "wpk-op-" + ++keySeq

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
function receive(productId, quantity, locationSeqId) {
    return call("mantle.product.AssetServices.receive#Asset", {
        productId,
        quantity,
        facilityId: facility,
        locationSeqId,
        ownerPartyId: org,
        assetTypeEnumId: "AstTpInventory",
        statusId: "AstAvailable",
        acquireCost: 2
    }).assetId
}
// an approved sales order of the lines ([productId, quantity]) from the facility
function salesOrder(lines) {
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
            unitAmount: 5
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
    return created.orderId
}
const sourcesOf = shipmentId => rows("mantle.shipment.ShipmentItemSource", {shipmentId})
const sourceOf = (shipmentId, productId) => sourcesOf(shipmentId).find(row => row.productId === productId)
const onHandAt = (productId, locationSeqId) =>
    rows("mantle.product.asset.Asset", {productId, facilityId: facility, locationSeqId}).reduce(
        (sum, row) => sum + n(row.quantityOnHandTotal),
        0
    )

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        for (const partyId of [org, "WPK_OTHER"]) {
            call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
            call("create#mantle.party.Organization", {partyId, organizationName: partyId})
            call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
        }
        user("WPK_PICKER", ["SHIPMENT_PICK"])
        user("WPK_SUPERVISOR", ["SHIPMENT_LOAD_EDIT", "SHIPMENT_PICK"])
        user("WPK_MOVER", ["STOCK_MOVE"])
        user("WPK_READER", [])
        user("WPK_OUTSIDER", ["SHIPMENT_PICK", "SHIPMENT_LOAD_EDIT"], "WPK_OTHER")
        call("create#mantle.facility.Facility", {facilityId: facility, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: org})
        for (const [locationSeqId, locationTypeEnumId] of [
            ["PICK1", "FltPick"],
            ["PICK2", "FltPick"],
            ["PICK3", "FltPick"],
            ["BULK1", "FltBulk"],
            ["STAGE1", "FltStaging"]
        ])
            call("create#mantle.facility.FacilityLocation", {facilityId: facility, locationSeqId, locationTypeEnumId})
        for (const productId of ["WPK_A", "WPK_B", "WPK_FACE"])
            call("create#mantle.product.Product", {
                productId,
                productName: productId,
                productTypeEnumId: "PtAsset",
                assetTypeEnumId: "AstTpInventory",
                amountUomId: "OTH_ea",
                ownerPartyId: org
            })
        state.assetA = receive("WPK_A", 20, "PICK1")
        state.assetB = receive("WPK_B", 10, "PICK2")
        state.cart = call("create#mantle.product.asset.Container", {
            facilityId: facility,
            locationSeqId: "STAGE1",
            containerTypeEnumId: "CtBinShelf",
            serialNumber: "WPK-CART-1"
        }).containerId
        state.forklift = call("create#mantle.product.asset.Asset", {
            assetTypeEnumId: "AstTpEquipment",
            facilityId: facility,
            ownerPartyId: org,
            statusId: "AstInUse",
            assetName: "Pick cart"
        }).assetId
        state.order1 = salesOrder([["WPK_A", 2], ["WPK_B", 2]])
        state.order2 = salesOrder([["WPK_A", 3]])
        state.order3 = salesOrder([["WPK_A", 1]])
        call("mantle.order.OrderServices.hold#Order", {orderId: state.order3, holdTypeEnumId: "OhtManual", holdComment: "Check"})
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

feature("a wave from three ready orders previews the held one as excluded and creates two loads, each with its result", {
    when() {
        const orderParts = [state.order1, state.order2, state.order3].map(orderId => ({orderId, orderPartSeqId: "01"}))
        const wave = {facilityId: facility, workEffortName: "Wave", ordersPerPicklist: 1, orderParts}
        const preview = run("wpk_supervisor", W + "preview#ShipmentLoadsForOrders", wave)
        const pickerPreview = run("wpk_picker", W + "preview#ShipmentLoadsForOrders", wave)
        const outsiderPreview = run("wpk_outsider", W + "preview#ShipmentLoadsForOrders", wave)
        const operationKey = key()
        const created = run("wpk_supervisor", W + "create#ShipmentLoadsForOrders", Object.assign({operationKey,
            groups: JSON.stringify(preview.groups)}, wave))
        const retry = run("wpk_supervisor", W + "create#ShipmentLoadsForOrders", Object.assign({operationKey,
            groups: JSON.stringify(preview.groups)}, wave))
        state.loads = Array.from(created.workEffortIdList || [])
        const firstGroup = (created.groupResults || [])[0] || {}
        state.shipment1 = (firstGroup.added || [])[0]?.shipmentIds?.[0]
        return {preview, pickerPreview, outsiderPreview, created, retry}
    },
    then({preview, pickerPreview, outsiderPreview, created, retry}) {
        preview.error === ""
        preview.groups.length === 2
        preview.excludedRows.length === 1
        preview.excludedRows[0].orderId === state.order3
        preview.excludedRows[0].reasonCode === "ORDER_HELD"
        preview.partRows.every(row => n(row.reservedAtPick) >= n(row.quantity))
        pickerPreview.error.includes("PERMISSION_DENIED")
        outsiderPreview.error.includes("RECORD_UNAVAILABLE")
        created.error === ""
        n(created.picklistsCreated) === 2
        created.groupResults.length === 2
        created.groupResults.every(row => row.ok && row.workEffortId && row.added.length === 1)
        state.shipment1 != null
        one("mantle.shipment.Shipment", {shipmentId: state.shipment1}).shipWorkEffortId === state.loads[0]
        retry.result.alreadyApplied === true
        Array.from(retry.workEffortIdList).join() === state.loads.join()
        rows("mantle.work.effort.WorkEffort", {workEffortName: "Wave 1", facilityId: facility}).length === 1
    }
})

feature("a picker picks one line into the cart and short-picks another: Short, a recount, on-hand unchanged", {
    when() {
        const shipmentId = state.shipment1
        call("update#mantle.shipment.Shipment", {shipmentId, pickContainerId: state.cart})
        const lineA = sourceOf(shipmentId, "WPK_A"),
            lineB = sourceOf(shipmentId, "WPK_B")
        state.lineA = lineA.shipmentItemSourceId
        state.lineB = lineB.shipmentItemSourceId
        const wrongPlace = run("wpk_picker", T + "pick#ShipmentStock", {operationKey: key(), shipmentId,
            shipmentItemSourceId: state.lineA, quantity: 2, locationSeqId: "PICK2"})
        const tooMany = run("wpk_picker", T + "pick#ShipmentStock", {operationKey: key(), shipmentId,
            shipmentItemSourceId: state.lineA, quantity: 3, locationSeqId: "PICK1"})
        const reader = run("wpk_reader", T + "pick#ShipmentStock", {operationKey: key(), shipmentId,
            shipmentItemSourceId: state.lineA, quantity: 2, locationSeqId: "PICK1"})
        const forged = run("wpk_picker", T + "pick#ShipmentStock", {operationKey: key(), shipmentId,
            shipmentItemSourceId: sourcesOf(state.loads[1] ? one("mantle.shipment.Shipment",
                {shipWorkEffortId: state.loads[1]}).shipmentId : shipmentId)[0].shipmentItemSourceId,
            quantity: 1, locationSeqId: "PICK1"})
        const pickKey = key()
        const picked = run("wpk_picker", T + "pick#ShipmentStock", {operationKey: pickKey, shipmentId,
            shipmentItemSourceId: state.lineA, quantity: 2, locationSeqId: "PICK1"})
        const again = run("wpk_picker", T + "pick#ShipmentStock", {operationKey: pickKey, shipmentId,
            shipmentItemSourceId: state.lineA, quantity: 2, locationSeqId: "PICK1"})
        const beforeB = onHandAt("WPK_B", "PICK2")
        const short = run("wpk_picker", T + "record#ShortPick", {operationKey: key(), shipmentId,
            shipmentItemSourceId: state.lineB, quantityShort: 1, locationSeqId: "PICK2", reasonEnumId: "SprNotFound"})
        const noReason = run("wpk_picker", T + "record#ShortPick", {operationKey: key(), shipmentId,
            shipmentItemSourceId: state.lineB, quantityShort: 1, locationSeqId: "PICK2"})
        const overShort = run("wpk_picker", T + "record#ShortPick", {operationKey: key(), shipmentId,
            shipmentItemSourceId: state.lineB, quantityShort: 2, locationSeqId: "PICK2", reasonEnumId: "SprFewer"})
        const recount = short.result ? one("mantle.product.asset.PhysicalInventory",
            {physicalInventoryId: short.result.physicalInventoryId}) : null
        return {wrongPlace, tooMany, reader, forged, picked, again, short, noReason, overShort, recount, beforeB,
            afterB: onHandAt("WPK_B", "PICK2"), inCart: rows("mantle.product.asset.Asset", {containerId: state.cart}),
            lineA: one("mantle.shipment.ShipmentItemSource", {shipmentItemSourceId: state.lineA}),
            exceptions: rows("mantle.shipment.ShipmentPickException", {shipmentItemSourceId: state.lineB})}
    },
    then({wrongPlace, tooMany, reader, forged, picked, again, short, noReason, overShort, recount, beforeB, afterB, inCart,
        lineA, exceptions}) {
        wrongPlace.error.includes("NOT_RESERVED_HERE")
        tooMany.error.includes("QUANTITY_EXCEEDS_REMAINING")
        reader.error.includes("PERMISSION_DENIED")
        forged.error.includes("RECORD_UNAVAILABLE")
        picked.error === ""
        picked.result.resultCode === "PICKED"
        picked.result.moves.length >= 1
        picked.result.moves[0].fromLocationSeqId === "PICK1"
        again.result.alreadyApplied === true
        n(lineA.quantityPicked) === 2
        n(lineA.enteredQuantity) === 2
        inCart.reduce((sum, row) => sum + n(row.quantityOnHandTotal), 0) === 2
        short.error === ""
        exceptions.length === 1
        n(exceptions[0].quantityShort) === 1
        exceptions[0].resolutionEnumId === "SpresRecount"
        recount.countSourceEnumId === "CntSrcShortPick"
        recount.statusId === "PIInPlanning"
        recount.scopeLocationSeqId === "PICK2"
        beforeB === afterB
        noReason.error.includes("REASON_REQUIRED")
        overShort.error.includes("QUANTITY_EXCEEDS_REMAINING")
    }
})

feature("a cancelled balance shows in put back, and nothing moves until the picker confirms", {
    when() {
        const shipmentId = state.shipment1
        const lineA = one("mantle.shipment.ShipmentItemSource", {shipmentItemSourceId: state.lineA})
        call("mantle.order.OrderServices.cancel#OrderItem", {orderId: lineA.orderId, orderItemSeqId: lineA.orderItemSeqId,
            cancelQuantity: 1})
        const flagged = one("mantle.shipment.ShipmentItemSource", {shipmentItemSourceId: state.lineA})
        const unconfirmed = run("wpk_picker", T + "reverse#Pick", {operationKey: key(), shipmentId,
            shipmentItemSourceId: state.lineA})
        const cartBefore = rows("mantle.product.asset.Asset", {containerId: state.cart}).reduce((s, r) => s + n(r.quantityOnHandTotal), 0)
        const pickBefore = onHandAt("WPK_A", "PICK1")
        const putBack = run("wpk_picker", T + "reverse#Pick", {operationKey: key(), shipmentId,
            shipmentItemSourceId: state.lineA, confirmed: "Y"})
        return {flagged, unconfirmed, cartBefore, pickBefore, putBack,
            cartAfter: rows("mantle.product.asset.Asset", {containerId: state.cart}).reduce((s, r) => s + n(r.quantityOnHandTotal), 0),
            pickAfter: onHandAt("WPK_A", "PICK1"),
            after: one("mantle.shipment.ShipmentItemSource", {shipmentItemSourceId: state.lineA})}
    },
    then({flagged, unconfirmed, cartBefore, pickBefore, putBack, cartAfter, pickAfter, after}) {
        n(flagged.quantity) === 1
        n(flagged.putBackQuantity) === 1
        unconfirmed.error.includes("CONFIRMATION_REQUIRED")
        cartBefore === 2
        putBack.error === ""
        putBack.result.moves.length === 1
        putBack.result.moves[0].toLocationSeqId === "PICK1"
        cartAfter === 1
        pickAfter === pickBefore + 1
        n(after.quantityPicked) === 1
        after.putBackQuantity == null
    }
})

feature("finishing the shipment names what is outstanding until it is backordered, then it is picked", {
    when() {
        const shipmentId = state.shipment1
        const outstanding = run("wpk_picker", T + "finish#Pick", {operationKey: key(), shipmentId})
        const finished = run("wpk_picker", T + "finish#Pick", {operationKey: key(), shipmentId, backorderRemaining: "Y"})
        const loadOutstanding = run("wpk_supervisor", T + "finish#Pick", {operationKey: key(), workEffortId: state.loads[1]})
        const pickerLoad = run("wpk_picker", T + "finish#Pick", {operationKey: key(), workEffortId: state.loads[1]})
        return {outstanding, finished, loadOutstanding, pickerLoad, shipment: one("mantle.shipment.Shipment", {shipmentId}),
            lineB: one("mantle.shipment.ShipmentItemSource", {shipmentItemSourceId: state.lineB}),
            exception: rows("mantle.shipment.ShipmentPickException", {shipmentItemSourceId: state.lineB})[0]}
    },
    then({outstanding, finished, loadOutstanding, pickerLoad, shipment, lineB, exception}) {
        outstanding.error.includes("OUTSTANDING")
        outstanding.error.includes("WPK_B")
        finished.error === ""
        finished.result.backordered.length === 1
        shipment.statusId === "ShipPicked"
        n(lineB.quantity) === 0
        exception.resolutionEnumId === "SpresBackorder"
        loadOutstanding.error.includes("OUTSTANDING")
        pickerLoad.error.includes("PERMISSION_DENIED")
    }
})

feature("a new outgoing shipment needs SHIPMENT_LOAD_EDIT and an order that is not held", {
    when() {
        const held = run("wpk_supervisor", T + "create#OutgoingShipment", {operationKey: key(), orderId: state.order3})
        const picker = run("wpk_picker", T + "create#OutgoingShipment", {operationKey: key(), orderId: state.order3})
        const outsider = run("wpk_outsider", T + "create#OutgoingShipment", {operationKey: key(), orderId: state.order3})
        return {held, picker, outsider}
    },
    then({held, picker, outsider}) {
        held.error.includes("ORDER_HELD")
        picker.error.includes("PERMISSION_DENIED")
        outsider.error.includes("RECORD_UNAVAILABLE")
    }
})

feature("a pick face below its minimum lists its bulk source and is replenished through the move guard", {
    when() {
        as("john.doe", () => {
            receive("WPK_FACE", 2, "PICK3")
            state.bulk = receive("WPK_FACE", 20, "BULK1")
            call("create#mantle.facility.ProductFacilityLocation", {productId: "WPK_FACE", facilityId: facility,
                locationSeqId: "PICK3", minimumStock: 10, moveQuantity: 8})
        })
        const needs = run("wpk_picker", T + "find#PickFaceReplenishment", {facilityId: facility})
        const reader = run("wpk_reader", T + "find#PickFaceReplenishment", {facilityId: facility})
        const outsider = run("wpk_outsider", T + "find#PickFaceReplenishment", {facilityId: facility})
        const face = (needs.faceRows || []).find(row => row.productId === "WPK_FACE")
        const moved = run("wpk_mover", T + "move#Stock", {operationKey: key(), assetId: face.sources[0].assetId,
            quantity: face.suggestedQuantity, toLocationSeqId: face.locationSeqId})
        const after = run("wpk_mover", T + "find#PickFaceReplenishment", {facilityId: facility})
        return {needs, reader, outsider, face, moved, after}
    },
    then({needs, reader, outsider, face, moved, after}) {
        needs.error === ""
        face.locationSeqId === "PICK3"
        n(face.currentQuantity) === 2
        n(face.suggestedQuantity) === 8
        face.sources[0].locationSeqId === "BULK1"
        reader.error.includes("PERMISSION_DENIED")
        outsider.error.includes("RECORD_UNAVAILABLE")
        moved.error === ""
        onHandAt("WPK_FACE", "PICK3") === 10
        !after.faceRows.some(row => row.productId === "WPK_FACE")
    }
})

feature("a manual load with its bin, a picker and the cart; busy equipment and a picked shipment's removal are refused", {
    when() {
        const created = run("wpk_supervisor", W + "store#ShipmentLoad", {facilityId: facility, workEffortName: "Manual",
            estimatedStartDate: ec.user.nowTimestamp})
        const other = run("wpk_supervisor", W + "store#ShipmentLoad", {facilityId: facility, workEffortName: "Other"})
        const picker = run("wpk_picker", W + "store#ShipmentLoad", {facilityId: facility, workEffortName: "No"})
        const person = run("wpk_supervisor", W + "store#ShipmentLoadAssignment", {workEffortId: created.workEffortId,
            assignmentKind: "party", partyId: "WPK_PICKER", roleTypeId: "Worker"})
        const cart = run("wpk_supervisor", W + "store#ShipmentLoadAssignment", {workEffortId: created.workEffortId,
            assignmentKind: "equipment", assetId: state.forklift})
        const busy = run("wpk_supervisor", W + "store#ShipmentLoadAssignment", {workEffortId: other.workEffortId,
            assignmentKind: "equipment", assetId: state.forklift})
        const stockAsEquipment = run("wpk_supervisor", W + "store#ShipmentLoadAssignment", {workEffortId: other.workEffortId,
            assignmentKind: "equipment", assetId: state.assetA})
        const second = one("mantle.shipment.Shipment", {shipWorkEffortId: state.loads[1]}).shipmentId
        const moved = run("wpk_supervisor", W + "edit#ShipmentLoadMember", {workEffortId: state.loads[1], memberAction: "remove",
            shipmentId: second})
        const added = run("wpk_supervisor", W + "edit#ShipmentLoadMember", {workEffortId: created.workEffortId,
            memberAction: "addShipment", shipmentId: second, binLocationNumber: 3})
        const source = sourcesOf(second)[0]
        call("update#mantle.shipment.ShipmentItemSource", {shipmentItemSourceId: source.shipmentItemSourceId, binLocationNumber: 7})
        const bin = run("wpk_supervisor", W + "edit#ShipmentLoadMember", {workEffortId: created.workEffortId,
            memberAction: "bin", shipmentId: second, binLocationNumber: 4})
        const secondLine = sourcesOf(second)[0]
        run("wpk_picker", T + "pick#ShipmentStock", {operationKey: key(), shipmentId: second,
            shipmentItemSourceId: secondLine.shipmentItemSourceId, quantity: 1, locationSeqId: "PICK1"})
        const removePicked = run("wpk_supervisor", W + "edit#ShipmentLoadMember", {workEffortId: created.workEffortId,
            memberAction: "remove", shipmentId: second})
        const closedLoad = run("wpk_supervisor", W + "edit#ShipmentLoadMember", {workEffortId: state.loads[0],
            memberAction: "remove", shipmentId: state.shipment1})
        return {created, picker, person, cart, busy, stockAsEquipment, moved, added, bin, removePicked, closedLoad, second,
            source: one("mantle.shipment.ShipmentItemSource", {shipmentItemSourceId: source.shipmentItemSourceId}),
            shipment: one("mantle.shipment.Shipment", {shipmentId: second})}
    },
    then({created, picker, person, cart, busy, stockAsEquipment, moved, added, bin, removePicked, closedLoad, source, shipment}) {
        created.error === ""
        picker.error.includes("PERMISSION_DENIED")
        person.error === ""
        rows("mantle.work.effort.WorkEffortParty", {workEffortId: created.workEffortId, partyId: "WPK_PICKER"}).length === 1
        cart.error === ""
        busy.error.includes("EQUIPMENT_BUSY")
        stockAsEquipment.error.includes("EQUIPMENT_UNAVAILABLE")
        moved.error === ""
        added.error === ""
        bin.error === ""
        n(shipment.binLocationNumber) === 4
        n(source.binLocationNumber) === 4
        shipment.shipWorkEffortId === created.workEffortId
        removePicked.error.includes("PICK_STARTED")
        closedLoad.error.includes("LOAD_CLOSED")
    }
})
