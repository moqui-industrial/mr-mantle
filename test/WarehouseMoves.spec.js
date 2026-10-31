// The Warehouse posting guard on moves (mantle.shipment.WarehouseTaskServices, StockPosting.js; impl-warehouse P5): a
// move checks STOCK_MOVE, the facility, the destination's location and status, answers a retry with its first result
// (the operation key scoped per user and operation), keeps quarantined stock held (F8) and re-reserves a reservation it
// carried onto held stock (F38); a relocation names each failed asset and moves the others; attaching never moves stock
// (F9) and a container moves with all its contents or not at all; the reservation repair posts what its preview named.
// The users are in spec-local groups.
const T = "mantle.shipment.WarehouseTaskServices."
const org = "WHM_ORG",
    facility = "WHM_FAC"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const n = value => (value == null ? 0 : Number(String(value)))
const sum = (list, field) => list.reduce((total, row) => total + n(row[field]), 0)
const since = "2000-01-01T00:00:00Z"
let keySeq = 0
const key = () => "whm-op-" + ++keySeq

function as(username, action) {
    login(username)
    ec.artifactExecution.disableAuthz()
    try {
        return action()
    } finally {
        ec.message.clearErrors()
        login("john.doe")
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
function ensureGroup(userGroupId, permissions) {
    if (!one("moqui.security.UserGroup", {userGroupId})) call("create#moqui.security.UserGroup", {userGroupId})
    for (const userPermissionId of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId, userPermissionId, fromDate: since})
}
function user(partyId, userGroupId, organizationPartyId) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: partyId})
    call("create#moqui.security.UserAccount", {
        userId: partyId,
        username: partyId.toLowerCase(),
        partyId,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA"
    })
    call("create#moqui.security.UserGroupMember", {userId: partyId, userGroupId, fromDate: since})
    call("create#mantle.party.PartyRelationship", {
        fromPartyId: partyId,
        toPartyId: organizationPartyId,
        relationshipTypeEnumId: "PrtAgent",
        toRoleTypeId: "OrgInternal",
        fromDate: since
    })
}
function receive(productId, quantity, locationSeqId, facilityId = facility, ownerPartyId = org) {
    return call("mantle.product.AssetServices.receive#Asset", {
        productId,
        quantity,
        facilityId,
        locationSeqId,
        ownerPartyId,
        assetTypeEnumId: "AstTpInventory",
        statusId: "AstAvailable"
    }).assetId
}
function order(productId, quantity) {
    const created = call("mantle.order.OrderServices.create#Order", {
        vendorPartyId: org,
        customerPartyId: "WHM_CUST",
        facilityId: facility
    })
    call("mantle.order.OrderServices.add#OrderProductQuantity", {
        orderId: created.orderId,
        orderPartSeqId: created.orderPartSeqId,
        productId,
        quantity,
        unitAmount: 5
    })
    call("mantle.order.OrderServices.place#Order", {orderId: created.orderId})
    return created.orderId
}
const asset = assetId => one("mantle.product.asset.Asset", {assetId})
const move = (username, parameters) => as(username, () => invoke(T + "move#Stock", parameters))

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        ensureGroup("WHM_MOVERS", ["STOCK_MOVE"])
        ensureGroup("WHM_READERS", [])
        ensureGroup("WHM_MANAGERS", ["STOCK_POLICY_MANAGE"])
        for (const partyId of [org, "WHM_OTHER"]) {
            call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
            call("create#mantle.party.Organization", {partyId, organizationName: partyId})
            call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
        }
        call("create#mantle.party.Party", {partyId: "WHM_CUST", partyTypeEnumId: "PtyPerson"})
        call("create#mantle.party.Person", {partyId: "WHM_CUST", firstName: "Move", lastName: "Customer"})
        call("create#mantle.party.PartyRole", {partyId: "WHM_CUST", roleTypeId: "Customer"})
        user("WHM_MOVER", "WHM_MOVERS", org)
        user("WHM_MOVER2", "WHM_MOVERS", org)
        user("WHM_READER", "WHM_READERS", org)
        user("WHM_MANAGER", "WHM_MANAGERS", org)
        user("WHM_OUTSIDER", "WHM_MOVERS", "WHM_OTHER")
        for (const [facilityId, ownerPartyId] of [
            [facility, org],
            ["WHM_FAC2", org],
            ["WHM_OTHER_FAC", "WHM_OTHER"]
        ])
            call("create#mantle.facility.Facility", {facilityId, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId})
        for (const [locationSeqId, locationTypeEnumId] of [
            ["PICK1", "FltPick"],
            ["PICK2", "FltPick"],
            ["BULK1", "FltBulk"],
            ["BULK2", "FltBulk"],
            ["QUAR1", "FltQuarantine"],
            ["QUAR2", "FltQuarantine"]
        ])
            call("create#mantle.facility.FacilityLocation", {facilityId: facility, locationSeqId, locationTypeEnumId})
        call("create#mantle.facility.FacilityLocation", {
            facilityId: facility,
            locationSeqId: "SHUT1",
            locationTypeEnumId: "FltBulk",
            thruDate: "2026-01-31 00:00:00"
        })
        call("create#mantle.facility.FacilityLocation", {
            facilityId: "WHM_FAC2",
            locationSeqId: "F2A",
            locationTypeEnumId: "FltBulk"
        })
        call("create#mantle.facility.FacilityLocation", {
            facilityId: "WHM_OTHER_FAC",
            locationSeqId: "O1",
            locationTypeEnumId: "FltBulk"
        })
        call("create#mantle.facility.FacilityLocationType", {
            facilityId: facility,
            locationTypeEnumId: "FltPick",
            autoStatusId: "AstAvailable"
        })
        call("create#mantle.facility.FacilityLocationType", {
            facilityId: facility,
            locationTypeEnumId: "FltQuarantine",
            autoStatusId: "AstQuarantine"
        })
        for (const productId of ["WHM_PART", "WHM_HELD", "WHM_RESERVED", "WHM_BATCH", "WHM_BOX", "WHM_REPAIR", "WHM_OTHER_P"])
            call("create#mantle.product.Product", {
                productId,
                productName: productId,
                productTypeEnumId: "PtAsset",
                assetTypeEnumId: "AstTpInventory",
                amountUomId: "OTH_ea"
            })
        for (const containerId of ["WHM_TOTE", "WHM_HELD_TOTE"])
            call("create#mantle.product.asset.Container", {containerId, facilityId: facility, locationSeqId: "BULK1"})
        ec.artifactExecution.enableAuthz()
    },
    cleanup() {
        ec.message.clearErrors()
        ec.artifactExecution.enableAuthz()
    }
})

feature("a mover moves part of an asset to a bin, and a retry with the same operation answers the first move", {
    when() {
        ec.artifactExecution.disableAuthz()
        const source = receive("WHM_PART", 10, "BULK1")
        ec.artifactExecution.enableAuthz()
        const operationKey = key()
        const parameters = {operationKey, assetId: source, quantity: 4, toLocationSeqId: "PICK1"}
        const first = move("whm_mover", parameters)
        const retry = move("whm_mover", parameters)
        const changed = move("whm_mover", Object.assign({}, parameters, {quantity: 3}))
        // another user's operation with the same client key is their own (the key is scoped per user and operation)
        const otherUser = move("whm_mover2", Object.assign({}, parameters, {quantity: 1}))
        return {
            source,
            first,
            retry,
            changed,
            otherUser,
            picked: rows("mantle.product.asset.Asset", {productId: "WHM_PART", locationSeqId: "PICK1"}),
            left: asset(source)
        }
    },
    then({source, first, retry, changed, otherUser, picked, left}) {
        first.error == ""
        first.result.resultCode == "MOVED"
        first.result.alreadyApplied == false
        first.result.fromLocationSeqId == "BULK1"
        first.result.toLocationSeqId == "PICK1"
        first.result.toAssetId != source
        retry.error == ""
        retry.result.alreadyApplied == true
        retry.result.toAssetId == first.result.toAssetId
        changed.error.includes("OPERATION_KEY_CONFLICT")
        otherUser.error == ""
        otherUser.result.alreadyApplied == false
        // 4 by the first move and 1 by the other user's: the retry moved nothing
        sum(picked, "quantityOnHandTotal") == 5
        n(left.quantityOnHandTotal) == 5
    }
})

feature("a move is refused without STOCK_MOVE, outside the user's facilities, to another facility or a closed bin", {
    when() {
        ec.artifactExecution.disableAuthz()
        const source = receive("WHM_PART", 6, "BULK2")
        const foreign = receive("WHM_OTHER_P", 6, "O1", "WHM_OTHER_FAC", "WHM_OTHER")
        ec.artifactExecution.enableAuthz()
        const base = {assetId: source, quantity: 1, toLocationSeqId: "PICK2"}
        return {
            reader: move("whm_reader", Object.assign({operationKey: key()}, base)),
            outsider: move("whm_outsider", Object.assign({operationKey: key()}, base)),
            foreign: move("whm_mover", {operationKey: key(), assetId: foreign, toLocationSeqId: "O1"}),
            otherFacility: move("whm_mover", Object.assign({operationKey: key()}, base, {toFacilityId: "WHM_FAC2"})),
            closed: move("whm_mover", Object.assign({operationKey: key()}, base, {toLocationSeqId: "SHUT1"})),
            missing: move("whm_mover", Object.assign({operationKey: key()}, base, {toLocationSeqId: "NOPE"})),
            tooMany: move("whm_mover", Object.assign({operationKey: key()}, base, {quantity: 7})),
            same: move("whm_mover", Object.assign({operationKey: key()}, base, {toLocationSeqId: "BULK2"})),
            noKey: move("whm_mover", base),
            allowed: move("whm_mover", Object.assign({operationKey: key()}, base)),
            left: asset(source)
        }
    },
    then(result) {
        result.reader.error.includes("PERMISSION_DENIED")
        result.outsider.error.includes("RECORD_UNAVAILABLE")
        result.foreign.error.includes("RECORD_UNAVAILABLE")
        result.otherFacility.error.includes("OTHER_FACILITY")
        result.closed.error.includes("LOCATION_CLOSED")
        result.missing.error.includes("LOCATION_UNAVAILABLE")
        result.tooMany.error.includes("QUANTITY_EXCEEDS_ON_HAND")
        result.same.error.includes("SAME_LOCATION")
        result.noKey.error.includes("Operation Key")
        // the same request a reader was refused succeeds for the mover
        result.allowed.error == ""
        n(result.left.quantityOnHandTotal) == 5
    }
})

feature("a move of quarantined stock into a pick bin is refused; it moves between quarantine locations (F8)", {
    when() {
        ec.artifactExecution.disableAuthz()
        const held = receive("WHM_HELD", 5, "QUAR1")
        ec.artifactExecution.enableAuthz()
        return {
            held,
            heldStatus: asset(held).statusId,
            toPick: move("whm_mover", {operationKey: key(), assetId: held, toLocationSeqId: "PICK1"}),
            partToPick: move("whm_mover", {operationKey: key(), assetId: held, quantity: 2, toLocationSeqId: "PICK1"}),
            toBulk: move("whm_mover", {operationKey: key(), assetId: held, toLocationSeqId: "BULK2"}),
            toQuarantine: move("whm_mover", {operationKey: key(), assetId: held, toLocationSeqId: "QUAR2"}),
            after: asset(held)
        }
    },
    then({heldStatus, toPick, partToPick, toBulk, toQuarantine, after}) {
        heldStatus == "AstQuarantine"
        toPick.error.includes("HELD_STOCK")
        partToPick.error.includes("HELD_STOCK")
        // a bulk location has no status of its own: the stock stays quarantined there
        toBulk.error == ""
        toBulk.result.statusId == "AstQuarantine"
        toQuarantine.error == ""
        after.locationSeqId == "QUAR2"
        after.statusId == "AstQuarantine"
    }
})

feature("a partial move of reserved stock into quarantine re-reserves what it carried onto the held asset (F38)", {
    when() {
        ec.artifactExecution.disableAuthz()
        const source = receive("WHM_RESERVED", 10, "PICK2")
        const orderId = order("WHM_RESERVED", 4)
        const other = receive("WHM_RESERVED", 10, "PICK2")
        ec.artifactExecution.enableAuthz()
        // 8 of 10 with 6 available: Mantle carries 2 of the reservation to the new quarantined asset
        const moved = move("whm_mover", {operationKey: key(), assetId: source, quantity: 8, toLocationSeqId: "QUAR1"})
        return {moved, source, other, reservations: rows("mantle.product.issuance.AssetReservation", {orderId})}
    },
    then({moved, reservations}) {
        moved.error == ""
        moved.result.statusId == "AstQuarantine"
        moved.result.reservationsChecked == true
        // nothing stays reserved on the held asset, and the order keeps its 4 on available stock
        reservations.every(r => r.assetId != moved.result.toAssetId)
        sum(reservations, "quantity") == 4
        sum(reservations, "quantityNotAvailable") == 0
    }
})

feature("a relocation of five assets with one invalid names it and moves the other four", {
    when() {
        ec.artifactExecution.disableAuthz()
        const assetIds = [1, 2, 3, 4].map(() => receive("WHM_BATCH", 3, "BULK1"))
        const held = receive("WHM_BATCH", 3, "QUAR1")
        ec.artifactExecution.enableAuthz()
        const parameters = {operationKey: key(), assetIds: assetIds.concat([held]), toLocationSeqId: "PICK2"}
        const first = as("whm_mover", () => invoke(T + "relocate#Assets", parameters))
        const retry = as("whm_mover", () => invoke(T + "relocate#Assets", parameters))
        const reader = as("whm_reader", () => invoke(T + "relocate#Assets", Object.assign({}, parameters, {operationKey: key()})))
        return {assetIds, held, first, retry, reader, moved: assetIds.map(asset)}
    },
    then({held, first, retry, reader, moved}) {
        first.error == ""
        first.movedCount == 4
        first.failedCount == 1
        first.results.find(row => row.key == held).reasonCode == "HELD_STOCK"
        first.results.filter(row => row.ok).every(row => row.result.toLocationSeqId == "PICK2")
        moved.every(row => row.locationSeqId == "PICK2")
        // the retry answers the moved ones from their operations and refuses the held one again
        retry.movedCount == 4
        retry.results.filter(row => row.ok).every(row => row.result.alreadyApplied == true)
        reader.error.includes("PERMISSION_DENIED")
    }
})

feature("an asset away from a container is not attached (F9); one where it is attaches and detaches without moving", {
    when() {
        ec.artifactExecution.disableAuthz()
        const away = receive("WHM_BOX", 4, "BULK2")
        const here = receive("WHM_BOX", 4, "BULK1")
        ec.artifactExecution.enableAuthz()
        const attachAway = as("whm_mover", () =>
            invoke(T + "attach#AssetToContainer", {operationKey: key(), assetId: away, containerId: "WHM_TOTE"})
        )
        const attached = as("whm_mover", () =>
            invoke(T + "attach#AssetToContainer", {operationKey: key(), assetId: here, containerId: "WHM_TOTE"})
        )
        const inBox = asset(here)
        const detachedPart = as("whm_mover", () =>
            invoke(T + "detach#AssetFromContainer", {operationKey: key(), assetId: here, quantity: 1})
        )
        const reader = as("whm_reader", () =>
            invoke(T + "attach#AssetToContainer", {operationKey: key(), assetId: away, containerId: "WHM_TOTE"})
        )
        return {
            attachAway,
            attached,
            inBox,
            detachedPart,
            reader,
            awayAfter: asset(away),
            outside: detachedPart.result && asset(detachedPart.result.toAssetId)
        }
    },
    then({attachAway, attached, inBox, detachedPart, reader, awayAfter, outside}) {
        attachAway.error.includes("ASSET_AWAY_FROM_CONTAINER")
        awayAfter.containerId == null
        awayAfter.locationSeqId == "BULK2"
        attached.error == ""
        inBox.containerId == "WHM_TOTE"
        inBox.locationSeqId == "BULK1"
        detachedPart.error == ""
        outside.containerId == null
        outside.locationSeqId == "BULK1"
        n(outside.quantityOnHandTotal) == 1
        reader.error.includes("PERMISSION_DENIED")
    }
})

feature("a container moves with all its contents or not at all", {
    when() {
        ec.artifactExecution.disableAuthz()
        const first = receive("WHM_BOX", 2, "BULK1")
        const second = receive("WHM_BOX", 3, "BULK1")
        const heldOne = receive("WHM_BOX", 1, "BULK1")
        for (const assetId of [first, second]) call("update#mantle.product.asset.Asset", {assetId, containerId: "WHM_TOTE"})
        call("update#mantle.product.asset.Asset", {assetId: heldOne, containerId: "WHM_HELD_TOTE", statusId: "AstQuarantine"})
        ec.artifactExecution.enableAuthz()
        const refused = as("whm_mover", () =>
            invoke(T + "move#Container", {operationKey: key(), containerId: "WHM_HELD_TOTE", toLocationSeqId: "PICK1"})
        )
        const moved = as("whm_mover", () =>
            invoke(T + "move#Container", {operationKey: key(), containerId: "WHM_TOTE", toLocationSeqId: "PICK1"})
        )
        return {
            refused,
            moved,
            heldBox: one("mantle.product.asset.Container", {containerId: "WHM_HELD_TOTE"}),
            heldAsset: asset(heldOne),
            box: one("mantle.product.asset.Container", {containerId: "WHM_TOTE"}),
            contents: rows("mantle.product.asset.Asset", {containerId: "WHM_TOTE"})
        }
    },
    then({refused, moved, heldBox, heldAsset, box, contents}) {
        refused.error.includes("HELD_STOCK")
        heldBox.locationSeqId == "BULK1"
        heldAsset.locationSeqId == "BULK1"
        heldAsset.statusId == "AstQuarantine"
        moved.error == ""
        box.locationSeqId == "PICK1"
        contents.length >= 2
        contents.every(row => row.locationSeqId == "PICK1" && row.statusId == "AstAvailable")
        moved.result.assets.length == contents.length
    }
})

feature("the reservation repair posts what its preview named, and refuses a stale preview or a user without the permission", {
    when() {
        ec.artifactExecution.disableAuthz()
        const reserved = receive("WHM_REPAIR", 5, "PICK1")
        const orderId = order("WHM_REPAIR", 2)
        const spare = receive("WHM_REPAIR", 5, "PICK2")
        // the asset leaves AstAvailable without the status service (no SECA), so its reservation is left invalid
        const row = ec.entity.find("mantle.product.asset.Asset").condition({assetId: reserved}).disableAuthz().one()
        row.statusId = "AstOnHold"
        row.update()
        ec.artifactExecution.enableAuthz()
        const preview = as("whm_manager", () =>
            invoke("mantle.facility.WarehousePolicyServices.preview#FacilityReservations", {
                facilityId: facility,
                productId: "WHM_REPAIR"
            })
        )
        const base = {facilityId: facility, productId: "WHM_REPAIR", previewFingerprint: preview.previewFingerprint}
        const mover = as("whm_mover", () => invoke(T + "repair#FacilityReservations", Object.assign({operationKey: key()}, base)))
        const stale = as("whm_manager", () =>
            invoke(T + "repair#FacilityReservations", Object.assign({operationKey: key()}, base, {previewFingerprint: "stale"}))
        )
        const repaired = as("whm_manager", () =>
            invoke(T + "repair#FacilityReservations", Object.assign({operationKey: key()}, base))
        )
        return {
            reserved,
            spare,
            preview,
            mover,
            stale,
            repaired,
            reservations: rows("mantle.product.issuance.AssetReservation", {orderId})
        }
    },
    then({reserved, spare, preview, mover, stale, repaired, reservations}) {
        preview.findings.some(f => f.reasonCode == "ASSET_NOT_AVAILABLE" && f.assetId == reserved)
        mover.error.includes("PERMISSION_DENIED")
        stale.error.includes("PREVIEW_CHANGED")
        repaired.error == ""
        repaired.result.repairedCount >= 1
        repaired.result.failedCount == 0
        reservations.every(r => r.assetId != reserved)
        sum(
            reservations.filter(r => r.assetId == spare),
            "quantity"
        ) == 2
    }
})
