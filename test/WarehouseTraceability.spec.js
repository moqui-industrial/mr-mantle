// Stock ledger, lineage and stock records (impl-warehouse P4): mantle.product.TraceabilityServices.find#Movements and
// get#Traceability, mantle.product.AssetRecordServices (asset metadata, lots, containers), the status and transit totals of
// get#ProductStockTotals, and the AssetContent record host. Spec-local organizations, facilities and users, whose
// spec-local groups hold the permissions. New spec, no Groovy original.
const T = "mantle.product.TraceabilityServices."
const A = "mantle.product.AssetRecordServices."
const org = "TRC_ORG",
    other = "TRC_OTHER",
    wh = "TRC_WH",
    wh2 = "TRC_WH2",
    otherWh = "TRC_OWH",
    productId = "TRC_P",
    lotId = "TRC_LOT"
const find = (entity, condition = {}) => ec.entity.find(entity).condition(condition).disableAuthz()
const one = (entity, condition) => find(entity, condition).one()
const day = n => new Date(Date.UTC(2026, 5, n, 12)).getTime()

function person(partyId, username, organizationId, groupId) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Trace", lastName: username})
    call("create#moqui.security.UserAccount", {
        userId: partyId,
        username,
        partyId,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA"
    })
    call("create#mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtEmployee",
        fromPartyId: partyId,
        toPartyId: organizationId,
        fromDate: "2000-01-01T00:00:00Z"
    })
    if (groupId)
        call("create#moqui.security.UserGroupMember", {userGroupId: groupId, userId: partyId, fromDate: "2000-01-01T00:00:00Z"})
}
function group(userGroupId, permissions) {
    call("create#moqui.security.UserGroup", {userGroupId, description: userGroupId})
    for (const userPermissionId of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId, userPermissionId, fromDate: "2000-01-01T00:00:00Z"})
}
function asset(assetId, facilityId, values = {}) {
    call(
        "create#mantle.product.asset.Asset",
        Object.assign(
            {
                assetId,
                productId,
                facilityId,
                locationSeqId: "PICK1",
                ownerPartyId: facilityId === otherWh ? other : org,
                statusId: "AstAvailable",
                assetTypeEnumId: "AstTpInventory",
                hasQuantity: "Y",
                quantityOnHandTotal: 0,
                availableToPromiseTotal: 0,
                acquireCost: 5,
                acquireCostUomId: "USD"
            },
            values
        )
    )
}
function detail(assetDetailId, assetId, quantity, date, values = {}) {
    call(
        "create#mantle.product.asset.AssetDetail",
        Object.assign(
            {
                assetDetailId,
                assetId,
                productId,
                effectiveDate: date,
                quantityOnHandDiff: quantity,
                availableToPromiseDiff: quantity
            },
            values
        )
    )
}
function receipt(assetReceiptId, assetId, quantity, date, shipmentId) {
    call("create#mantle.product.receipt.AssetReceipt", {
        assetReceiptId,
        assetId,
        productId,
        shipmentId,
        quantityAccepted: quantity,
        receivedDate: date,
        receivedByUserId: "TRC_CLERK"
    })
    detail(assetReceiptId, assetId, quantity, date, {assetReceiptId, shipmentId})
}
function issuance(assetIssuanceId, assetId, quantity, date, shipmentId) {
    call("create#mantle.product.issuance.AssetIssuance", {
        assetIssuanceId,
        assetId,
        productId,
        shipmentId,
        quantity,
        issuedDate: date,
        issuedByUserId: "TRC_CLERK"
    })
    detail(assetIssuanceId, assetId, -quantity, date, {assetIssuanceId, shipmentId})
}
function split(id, sourceId, targetId, quantity, date) {
    detail(id + "_IN", targetId, quantity, date, {otherAssetId: sourceId})
    detail(id + "_OUT", sourceId, -quantity, date, {otherAssetId: targetId})
}
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
function attempt(service, parameters) {
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(service).parameters(parameters).requireNewTransaction(true).call() || {}
        return Object.assign({}, out, {error: ec.message.hasError() ? ec.message.getErrorsString() : ""})
    } catch (error) {
        return {error: String(error.message)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        for (const [partyId, name] of [
            [org, "Trace org"],
            [other, "Trace other"]
        ]) {
            call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
            call("create#mantle.party.Organization", {partyId, organizationName: name})
            call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
        }
        for (const [facilityId, ownerPartyId] of [
            [wh, org],
            [wh2, org],
            [otherWh, other]
        ]) {
            call("create#mantle.facility.Facility", {facilityId, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId})
            call("create#mantle.facility.FacilityLocation", {facilityId, locationSeqId: "PICK1", locationTypeEnumId: "FltPick"})
        }
        call("create#mantle.product.Product", {
            productId,
            productName: "Trace sample",
            productTypeEnumId: "PtAsset",
            assetTypeEnumId: "AstTpInventory",
            amountUomId: "OTH_ea"
        })
        group("TRC_FINANCE", ["ACCOUNTING_VIEW"])
        group("TRC_CLERKS", ["STOCK_ADJUST", "STOCK_RECEIVE", "STOCK_MOVE"])
        person("TRC_READER", "trc.reader", org, null)
        person("TRC_FINANCE", "trc.finance", org, "TRC_FINANCE")
        person("TRC_CLERK", "trc.clerk", org, "TRC_CLERKS")
        person("TRC_OUTSIDER", "trc.outsider", other, "TRC_CLERKS")
        call("create#mantle.product.asset.Lot", {lotId, lotNumber: "TRC-1", expirationDate: "2027-06-30"})
        for (const [shipmentId, shipmentTypeEnumId] of [
            ["TRC_SHIP_IN", "ShpTpPurchase"],
            ["TRC_SHIP_TR", "ShpTpTransfer"],
            ["TRC_SHIP_OUT", "ShpTpSales"],
            ["TRC_SHIP_X", "ShpTpTransfer"]
        ])
            call("create#mantle.shipment.Shipment", {shipmentId, shipmentTypeEnumId, statusId: "ShipDelivered"})
        call("create#mantle.product.asset.PhysicalInventory", {
            physicalInventoryId: "TRC_PI",
            facilityId: wh,
            statusId: "PIComplete"
        })
        // a lot received on a purchase, part transferred to the second warehouse and sold (one unit cancelled), the rest
        // revalued (a split to a new asset) and one unit scrapped; a partial move at the second warehouse; a unit with no
        // receipt (Unknown); stock transferred to another organization's facility; and two assets split into each other
        asset("TRC_A", wh, {lotId})
        receipt("TRC_R1", "TRC_A", 10, day(1), "TRC_SHIP_IN")
        issuance("TRC_I1", "TRC_A", 4, day(2), "TRC_SHIP_TR")
        asset("TRC_B", wh2, {lotId})
        receipt("TRC_R2", "TRC_B", 4, day(3), "TRC_SHIP_TR")
        issuance("TRC_I2", "TRC_B", 2, day(4), "TRC_SHIP_OUT")
        call("update#mantle.product.issuance.AssetIssuance", {assetIssuanceId: "TRC_I2", quantityCancelled: 1})
        detail("TRC_I2_CANCEL", "TRC_B", 1, day(5), {assetIssuanceId: "TRC_I2", shipmentId: "TRC_SHIP_OUT"})
        asset("TRC_C", wh, {lotId, acquireCost: 6})
        split("TRC_REVAL", "TRC_A", "TRC_C", 6, day(6))
        call("create#mantle.product.asset.AssetBookEvent", {
            assetBookEventId: "TRC_REVAL",
            assetId: "TRC_C",
            sourceAssetId: "TRC_A",
            eventTypeEnumId: "AbeInventoryRevaluation",
            eventDate: day(6),
            organizationPartyId: org
        })
        detail("TRC_SCRAP", "TRC_C", -1, day(7), {physicalInventoryId: "TRC_PI", varianceReasonEnumId: "InVrDamaged"})
        asset("TRC_E", wh2, {lotId})
        split("TRC_MOVE", "TRC_B", "TRC_E", 1, day(8))
        asset("TRC_U", wh)
        detail("TRC_U_FIRST", "TRC_U", 3, day(1))
        issuance("TRC_I3", "TRC_C", 2, day(9), "TRC_SHIP_X")
        asset("TRC_O", otherWh)
        receipt("TRC_R3", "TRC_O", 2, day(10), "TRC_SHIP_X")
        asset("TRC_Y1", wh)
        asset("TRC_Y2", wh)
        detail("TRC_Y1_FIRST", "TRC_Y1", 2, day(1))
        split("TRC_Y12", "TRC_Y1", "TRC_Y2", 1, day(2))
        split("TRC_Y21", "TRC_Y2", "TRC_Y1", 1, day(3))
        ec.artifactExecution.enableAuthz()
    }
})

feature("the ledger names each row's source, its document, the correction chain and the revaluation split", {
    when() {
        return as("trc.reader", () => {
            const rows = call(T + "find#Movements", {productId, pageSize: 100}).movementList
            const byId = Object.fromEntries(rows.map(row => [row.assetDetailId, row]))
            return {rows, byId}
        })
    },
    then({rows, byId}) {
        byId.TRC_R1.sourceType == "receipt"
        byId.TRC_R1.documentText == "Shipment TRC_SHIP_IN"
        byId.TRC_R1.userText == "trc.clerk"
        byId.TRC_I1.sourceType == "issuance"
        byId.TRC_I1.documentText == "Shipment TRC_SHIP_TR"
        byId.TRC_I2.correctionText == "Corrected 1 time"
        byId.TRC_I2_CANCEL.correctsDetailId == "TRC_I2"
        byId.TRC_REVAL_IN.sourceType == "revaluation"
        byId.TRC_REVAL_IN.sourceText == "Revaluation split from asset TRC_A"
        byId.TRC_REVAL_OUT.sourceText == "Revaluation split to asset TRC_C"
        byId.TRC_MOVE_IN.sourceType == "split"
        byId.TRC_MOVE_IN.sourceText == "Moved part from asset TRC_B"
        byId.TRC_SCRAP.sourceType == "adjustment"
        byId.TRC_SCRAP.reasonText == "Damaged"
        byId.TRC_SCRAP.documentText == "Count TRC_PI"
        // another organization's stock is not in the ledger, and a reader without financial read gets no cost
        !rows.some(row => row.assetId === "TRC_O")
        rows.every(row => !("unitCost" in row) && !("acquireCost" in row))
    }
})
feature(
    "the ledger filters by source, facility and asset, answers cost with financial read and refuses another organization's asset",
    {
        when() {
            return {
                adjustments: as(
                    "trc.reader",
                    () => call(T + "find#Movements", {productId, sourceType: "adjustment"}).movementList
                ),
                second: as("trc.reader", () => call(T + "find#Movements", {productId, facilityIds: [wh2], pageSize: 100})),
                none: as("trc.reader", () => call(T + "find#Movements", {productId, facilityIds: []}).movementListCount),
                finance: as("trc.finance", () => call(T + "find#Movements", {assetId: "TRC_C"})),
                otherAsset: as("trc.reader", () => attempt(T + "find#Movements", {assetId: "TRC_O"}).error),
                outsider: as("trc.outsider", () => call(T + "find#Movements", {productId}).movementList.map(row => row.assetId))
            }
        },
        then({adjustments, second, none, finance, otherAsset, outsider}) {
            adjustments.map(row => row.assetDetailId) == ["TRC_SCRAP"]
            second.movementList.every(row => row.facilityId === wh2)
            second.movementListCount == 5
            none == 0
            finance.costIncluded == true
            finance.movementList.every(row => row.acquireCost === 6)
            otherAsset.includes("RECORD_UNAVAILABLE")
            outsider == ["TRC_O"]
        }
    }
)
feature("a trace from the lot reaches its purchase receipt, its sale and a restricted node, without cost for a reader", {
    when() {
        return as("trc.reader", () => call(T + "get#Traceability", {rootType: "lot", rootId: lotId, pageSize: 200}))
    },
    then(trace) {
        trace.rootKeys.includes("asset:TRC_A")
        trace.nodeList.some(row => row.nodeKey === "shipment:TRC_SHIP_IN")
        trace.nodeList.some(row => row.nodeKey === "shipment:TRC_SHIP_OUT")
        trace.nodeList.some(row => row.nodeKey === "count:TRC_PI")
        trace.edgeList.some(row => row.event === "revaluation" && row.fromKey === "asset:TRC_A" && row.toKey === "asset:TRC_C")
        trace.edgeList.some(row => row.event === "split" && row.fromKey === "asset:TRC_B" && row.toKey === "asset:TRC_E")
        // the other organization's received stock is a restricted node that names nothing
        trace.restrictedCount == 1
        !JSON.stringify(trace).includes('TRC_O"')
        !JSON.stringify(trace).includes("TRC_R3")
        trace.costIncluded == false
        trace.edgeList.every(row => !("unitCost" in row))
        trace.nodeList.every(row => !("acquireCost" in row))
        // the tree keys each occurrence by its path
        trace.treeRows[0].occurrenceKey == "r1"
        new Set(trace.treeRows.map(row => row.occurrenceKey)).size == trace.treeRows.length
    }
})
feature("an asset with no receipt shows Unknown provenance with its first known movement, and cost with financial read", {
    when() {
        return {
            unknown: as("trc.reader", () => call(T + "get#Traceability", {rootId: "TRC_U", direction: "upstream"})),
            finance: as("trc.finance", () => call(T + "get#Traceability", {rootId: "TRC_C", direction: "upstream"}))
        }
    },
    then({unknown, finance}) {
        unknown.unknownCount == 1
        unknown.edgeList.some(row => row.event === "unknown" && row.eventId === "TRC_U_FIRST" && row.quantity === 3)
        unknown.nodeList.some(row => row.kind === "unknown" && row.label === "Unknown provenance")
        finance.costIncluded == true
        finance.edgeList.some(row => row.event === "revaluation" && row.unitCost === 6 && row.previousUnitCost === 5)
    }
})
feature("a trace is cycle-safe and bounded", {
    when() {
        return as("trc.reader", () => ({
            cycle: call(T + "get#Traceability", {rootId: "TRC_Y1"}),
            bounded: call(T + "get#Traceability", {rootId: "TRC_A", maxNodes: 3}),
            shallow: call(T + "get#Traceability", {rootId: "TRC_A", direction: "downstream", maxDepth: 1}),
            other: attempt(T + "get#Traceability", {rootId: "TRC_O"}).error,
            narrowed: attempt(T + "get#Traceability", {rootId: "TRC_B", facilityIds: [wh]}).error
        }))
    },
    then({cycle, bounded, shallow, other, narrowed}) {
        cycle.nodeList.filter(row => row.kind === "asset").length == 2
        cycle.edgeList.some(row => row.joined)
        bounded.truncated == true
        bounded.nodeListCount == 3
        shallow.truncated == true
        !shallow.nodeList.some(row => row.nodeKey === "asset:TRC_B")
        other.includes("RECORD_UNAVAILABLE")
        narrowed.includes("RECORD_UNAVAILABLE")
    }
})
feature("an asset's metadata changes, audited, with stock adjust authority only; nothing else changes", {
    when() {
        const before = one("mantle.product.asset.Asset", {assetId: "TRC_U"})
        const parameters = {assetId: "TRC_U", assetName: "Returned demo unit", comments: "Box opened", statusId: "AstOnHold"}
        const reader = as("trc.reader", () => attempt(A + "update#AssetMetadata", parameters).error)
        const outsider = as("trc.outsider", () => attempt(A + "update#AssetMetadata", parameters).error)
        const stale = as(
            "trc.clerk",
            () => attempt(A + "update#AssetMetadata", Object.assign({}, parameters, {expectedLastUpdatedStamp: 1000})).error
        )
        const clerk = as(
            "trc.clerk",
            () =>
                attempt(
                    A + "update#AssetMetadata",
                    Object.assign({}, parameters, {expectedLastUpdatedStamp: before.lastUpdatedStamp})
                ).error
        )
        const after = one("mantle.product.asset.Asset", {assetId: "TRC_U"})
        const audit = Array.from(
            find("moqui.entity.EntityAuditLog", {
                changedEntityName: "mantle.product.asset.Asset",
                pkPrimaryValue: "TRC_U"
            }).list()
        ).map(row => row.changedFieldName)
        return {reader, outsider, stale, clerk, after, audit}
    },
    then({reader, outsider, stale, clerk, after, audit}) {
        reader.includes("STOCK_ADJUST")
        outsider.includes("RECORD_UNAVAILABLE")
        stale.includes("RECORD_CHANGED")
        clerk == ""
        after.assetName == "Returned demo unit"
        after.comments == "Box opened"
        after.statusId == "AstAvailable"
        audit.includes("assetName")
        audit.includes("comments")
    }
})
feature("a lot and a container are created with their authority, refusing duplicates, bad dates and others' facilities", {
    when() {
        return {
            reader: as("trc.reader", () => attempt(A + "create#Lot", {lotNumber: "TRC-2"}).error),
            lot: as("trc.clerk", () => attempt(A + "create#Lot", {lotNumber: "TRC-2", expirationDate: "2028-01-31"})),
            duplicate: as("trc.clerk", () => attempt(A + "create#Lot", {lotNumber: "TRC-2"}).error),
            dates: as(
                "trc.clerk",
                () =>
                    attempt(A + "create#Lot", {lotNumber: "TRC-3", manufacturedDate: day(20), expirationDate: "2026-06-01"}).error
            ),
            container: as("trc.clerk", () =>
                attempt(A + "create#Container", {facilityId: wh, locationSeqId: "PICK1", containerTypeEnumId: "CtBinShelf"})
            ),
            otherFacility: as("trc.clerk", () => attempt(A + "create#Container", {facilityId: otherWh}).error),
            badLocation: as("trc.clerk", () => attempt(A + "create#Container", {facilityId: wh, locationSeqId: "NOPE"}).error),
            noMove: as("trc.reader", () => attempt(A + "create#Container", {facilityId: wh}).error)
        }
    },
    then({reader, lot, duplicate, dates, container, otherFacility, badLocation, noMove}) {
        reader.includes("STOCK_RECEIVE")
        lot.error == ""
        one("mantle.product.asset.Lot", {lotId: lot.lotId}).lotNumber == "TRC-2"
        duplicate.includes("LOT_DUPLICATE")
        dates.includes("LOT_DATES")
        container.error == ""
        one("mantle.product.asset.Container", {containerId: container.containerId}).serialNumber == container.containerId
        otherFacility.includes("RECORD_UNAVAILABLE")
        badLocation.includes("LOCATION_UNAVAILABLE")
        noMove.includes("STOCK_MOVE")
    }
})
feature("stock totals count on hand by status and what shipped transfers still carry to the facility", {
    when() {
        ec.artifactExecution.disableAuthz()
        try {
            asset("TRC_HELD", wh2, {statusId: "AstQuarantine"})
            detail("TRC_HELD_IN", "TRC_HELD", 2, day(11))
            call("create#mantle.shipment.Shipment", {
                shipmentId: "TRC_SHIP_TRANSIT",
                shipmentTypeEnumId: "ShpTpTransfer",
                statusId: "ShipShipped",
                toPartyId: org
            })
            call("create#mantle.shipment.ShipmentRouteSegment", {
                shipmentId: "TRC_SHIP_TRANSIT",
                shipmentRouteSegmentSeqId: "01",
                originFacilityId: wh,
                destinationFacilityId: wh2
            })
            issuance("TRC_I_TRANSIT", "TRC_U", 2, day(12), "TRC_SHIP_TRANSIT")
            return call("mantle.product.AssetServices.get#ProductStockTotals", {productId, facilityId: wh2, ownerPartyId: org})
        } finally {
            ec.artifactExecution.enableAuthz()
        }
    },
    then(totals) {
        dec(totals.quantityByStatus.AstQuarantine).toNumber() == 2
        dec(totals.transitQuantity).toNumber() == 2
        dec(totals.heldQuantity).toNumber() == 2
    }
})
feature("an asset's files are hosted by AssetContent", {
    when() {
        ec.artifactExecution.disableAuthz()
        try {
            return call("mantle.party.CommunicationServices.get#RecordLinkInfo", {
                recordEntityName: "mantle.product.asset.Asset",
                recordId: "TRC_A",
                checkRecord: false
            })
        } finally {
            ec.artifactExecution.enableAuthz()
        }
    },
    then(info) {
        info.contentEntity.entityName == "mantle.product.asset.AssetContent"
        info.contentEntity.keyField == "assetId"
    }
})
