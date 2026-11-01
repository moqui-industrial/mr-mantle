// Warehouse reports (impl-warehouse P17, WH-REPORT): mantle.product.InventoryReportServices.get#InventoryAtDate (stock at a
// date from the ledger by effective date, places from the asset audit log, a revaluation split read as one row, incomplete
// history before a facility's first movement, days in the user's zone on a pinned clock) and find#OperationsHistory (the
// documents of a period with totals by unit, never across units). Spec-local organizations, facilities, products and users
// (prefix WRP_), in America/Chicago. New spec, no Groovy original.
const R = "mantle.product.InventoryReportServices."
const org = "WRP_ORG",
    other = "WRP_OTHER",
    wh = "WRP_WH",
    wh2 = "WRP_WH2",
    otherWh = "WRP_OWH",
    lotId = "WRP_LOT"
const ASSET = "mantle.product.asset.Asset"
const DAY = 86400000
// a June day at noon in Chicago
const june = n => new Date(Date.UTC(2026, 5, n, 17)).getTime()
// the pinned clock: the latest 04:30 UTC, still the day before in Chicago
const pinned = Math.floor((Date.now() - 4.5 * 3600000) / DAY) * DAY + 4.5 * 3600000
const utcDay = ms => {
    const date = new Date(ms)
    return [
        date.getUTCFullYear(),
        String(date.getUTCMonth() + 1).padStart(2, "0"),
        String(date.getUTCDate()).padStart(2, "0")
    ].join("-")
}

function party(partyId, name, role) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    if (role) call("create#mantle.party.PartyRole", {partyId, roleTypeId: role})
}
function person(partyId, username, organizationId) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Report", lastName: username})
    call("create#moqui.security.UserAccount", {
        userId: partyId,
        username,
        partyId,
        timeZone: "America/Chicago",
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA"
    })
    call("create#mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtEmployee",
        fromPartyId: partyId,
        toPartyId: organizationId,
        fromDate: "2000-01-01T00:00:00Z"
    })
}
function asset(assetId, productId, facilityId, locationSeqId, values = {}) {
    call(
        "create#" + ASSET,
        Object.assign(
            {
                assetId,
                productId,
                facilityId,
                locationSeqId,
                ownerPartyId: facilityId === otherWh ? other : org,
                statusId: "AstAvailable",
                assetTypeEnumId: "AstTpInventory",
                hasQuantity: "Y",
                quantityOnHandTotal: 0,
                availableToPromiseTotal: 0
            },
            values
        )
    )
}
function detail(assetDetailId, assetId, productId, quantity, date, values = {}) {
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
function receipt(id, assetId, productId, quantity, date, shipmentId, rejected = 0) {
    call("create#mantle.product.receipt.AssetReceipt", {
        assetReceiptId: id,
        assetId,
        productId,
        shipmentId,
        quantityAccepted: quantity,
        quantityRejected: rejected,
        receivedDate: date
    })
    detail(id, assetId, productId, quantity, date, {assetReceiptId: id, shipmentId})
}
function issuance(id, assetId, productId, quantity, date, shipmentId) {
    call("create#mantle.product.issuance.AssetIssuance", {
        assetIssuanceId: id,
        assetId,
        productId,
        shipmentId,
        facilityId: wh,
        quantity,
        issuedDate: date
    })
    detail(id, assetId, productId, -quantity, date, {assetIssuanceId: id, shipmentId})
}
function split(id, sourceId, targetId, quantity, date) {
    detail(id + "_OUT", sourceId, "WRP_P", -quantity, date, {otherAssetId: targetId})
    detail(id + "_IN", targetId, "WRP_P", quantity, date, {otherAssetId: sourceId})
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
const atDate = (username, parameters) => as(username, () => attempt(R + "get#InventoryAtDate", parameters))
const history = (username, parameters) => as(username, () => attempt(R + "find#OperationsHistory", parameters))
const rowAt = (out, locationSeqId) => (out.stockRows || []).find(row => row.locationSeqId === locationSeqId) || {}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        party(org, "Report org", "OrgInternal")
        party(other, "Report other", "OrgInternal")
        party("WRP_SUPPLIER", "Report supplier", "Supplier")
        party("WRP_CUSTOMER", "Report customer", "Customer")
        party("WRP_CARRIER", "Report carrier", "Carrier")
        for (const [facilityId, ownerPartyId] of [
            [wh, org],
            [wh2, org],
            [otherWh, other]
        ]) {
            call("create#mantle.facility.Facility", {facilityId, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId})
            for (const locationSeqId of ["A1", "B1"])
                call("create#mantle.facility.FacilityLocation", {facilityId, locationSeqId, locationTypeEnumId: "FltPick"})
        }
        for (const [productId, productName, amountUomId] of [
            ["WRP_P", "Report sealant", "OTH_ea"],
            ["WRP_K", "Report gasket sheet", "WT_kg"],
            ["WRP_D", "Report boundary part", "OTH_ea"]
        ])
            call("create#mantle.product.Product", {
                productId,
                productName,
                productTypeEnumId: "PtAsset",
                assetTypeEnumId: "AstTpInventory",
                amountUomId
            })
        person("WRP_READER", "wrp.reader", org)
        person("WRP_OUTSIDER", "wrp.outsider", other)
        call("create#mantle.product.asset.Lot", {lotId, lotNumber: "WRP-1"})
        call("create#mantle.shipment.Shipment", {
            shipmentId: "WRP_SHIP_IN",
            shipmentTypeEnumId: "ShpTpPurchase",
            statusId: "ShipDelivered",
            fromPartyId: "WRP_SUPPLIER",
            toPartyId: org,
            estimatedArrivalDate: june(1)
        })
        call("create#mantle.shipment.ShipmentRouteSegment", {
            shipmentId: "WRP_SHIP_IN",
            shipmentRouteSegmentSeqId: "01",
            destinationFacilityId: wh
        })
        call("create#mantle.shipment.ShipmentItem", {shipmentId: "WRP_SHIP_IN", productId: "WRP_P", quantity: 16})
        call("create#mantle.shipment.ShipmentItem", {shipmentId: "WRP_SHIP_IN", productId: "WRP_K", quantity: 12.5})
        call("create#mantle.shipment.Shipment", {
            shipmentId: "WRP_SHIP_OUT",
            shipmentTypeEnumId: "ShpTpSales",
            statusId: "ShipDelivered",
            fromPartyId: org,
            toPartyId: "WRP_CUSTOMER",
            estimatedShipDate: june(14)
        })
        call("create#mantle.shipment.ShipmentRouteSegment", {
            shipmentId: "WRP_SHIP_OUT",
            shipmentRouteSegmentSeqId: "01",
            originFacilityId: wh,
            carrierPartyId: "WRP_CARRIER"
        })
        call("create#mantle.shipment.ShipmentItem", {shipmentId: "WRP_SHIP_OUT", productId: "WRP_P", quantity: 3})
        call("create#mantle.shipment.ShipmentItemSource", {
            shipmentItemSourceId: "WRP_SIS_OUT",
            shipmentId: "WRP_SHIP_OUT",
            productId: "WRP_P",
            quantity: 3,
            quantityPicked: 3
        })
        call("create#mantle.shipment.Shipment", {
            shipmentId: "WRP_SHIP_OTHER",
            shipmentTypeEnumId: "ShpTpPurchase",
            statusId: "ShipDelivered",
            fromPartyId: "WRP_SUPPLIER",
            toPartyId: other
        })
        call("create#mantle.shipment.ShipmentRouteSegment", {
            shipmentId: "WRP_SHIP_OTHER",
            shipmentRouteSegmentSeqId: "01",
            destinationFacilityId: otherWh
        })
        call("create#mantle.product.asset.PhysicalInventory", {
            physicalInventoryId: "WRP_PI",
            facilityId: wh,
            statusId: "PIComplete"
        })
        // the lot at A1: received 10 and 5 (one rejected), 3 issued, 1 damaged, 6 split to WRP_A2 by a revaluation, 2 moved
        // to WRP_A3 at B1; WRP_A2 moved whole from A1 to B1 on June 22 (its audit row); kilograms of gasket at A1; the lot at
        // the second warehouse; another organization's stock
        asset("WRP_A1", "WRP_P", wh, "A1", {lotId})
        receipt("WRP_R1", "WRP_A1", "WRP_P", 10, june(1), "WRP_SHIP_IN")
        receipt("WRP_R2", "WRP_A1", "WRP_P", 5, june(12), "WRP_SHIP_IN", 1)
        issuance("WRP_I1", "WRP_A1", "WRP_P", 3, june(15), "WRP_SHIP_OUT")
        detail("WRP_ADJ", "WRP_A1", "WRP_P", -1, june(18), {physicalInventoryId: "WRP_PI", varianceReasonEnumId: "InVrDamaged"})
        asset("WRP_A2", "WRP_P", wh, "B1", {lotId})
        split("WRP_REVAL", "WRP_A1", "WRP_A2", 6, june(20))
        call("create#mantle.product.asset.AssetBookEvent", {
            assetBookEventId: "WRP_REVAL",
            assetId: "WRP_A2",
            sourceAssetId: "WRP_A1",
            eventTypeEnumId: "AbeInventoryRevaluation",
            eventDate: june(20),
            organizationPartyId: org
        })
        call("create#moqui.entity.EntityAuditLog", {
            auditHistorySeqId: "WRP_AUDIT_A2",
            changedEntityName: ASSET,
            changedFieldName: "locationSeqId",
            pkPrimaryValue: "WRP_A2",
            oldValueText: "A1",
            newValueText: "B1",
            changedDate: june(22)
        })
        asset("WRP_A3", "WRP_P", wh, "B1", {lotId})
        split("WRP_MOVE", "WRP_A1", "WRP_A3", 2, june(25))
        asset("WRP_K1", "WRP_K", wh, "A1")
        receipt("WRP_RK", "WRP_K1", "WRP_K", 12.5, june(5), "WRP_SHIP_IN")
        asset("WRP_B1", "WRP_P", wh2, "A1", {lotId})
        detail("WRP_B1_FIRST", "WRP_B1", "WRP_P", 4, june(3))
        asset("WRP_O1", "WRP_P", otherWh, "A1", {lotId})
        receipt("WRP_RO", "WRP_O1", "WRP_P", 7, june(4), "WRP_SHIP_OTHER")
        // received an hour before the pinned clock: the evening of the day before in Chicago
        asset("WRP_D1", "WRP_D", wh2, "B1")
        detail("WRP_D1_LATE", "WRP_D1", "WRP_D", 4, pinned - 3600000)
        ec.artifactExecution.enableAuthz()
    }
})

feature("stock at a past date for a lot shows its opening, receipts, issues, adjustments, moves and closing", {
    when() {
        return atDate("wrp.reader", {lotId, facilityId: wh, fromDate: "2026-06-10", asOfDate: "2026-06-30", pageSize: 50})
    },
    then(out) {
        out.error == ""
        out.fromDay == "2026-06-10"
        out.asOfDay == "2026-06-30"
        out.complete == true
        rowAt(out, "A1").openingQuantity == 10
        rowAt(out, "A1").receiptQuantity == 5
        rowAt(out, "A1").issueQuantity == 3
        rowAt(out, "A1").adjustmentQuantity == -1
        // the revaluation split nets out in its row; the whole move of WRP_A2 and the partial move to WRP_A3 leave it
        rowAt(out, "A1").moveQuantity == -8
        rowAt(out, "A1").closingQuantity == 3
        rowAt(out, "B1").openingQuantity == 0
        rowAt(out, "B1").moveQuantity == 8
        rowAt(out, "B1").closingQuantity == 8
        rowAt(out, "A1").unitText != ""
        // another organization's stock and the second warehouse's are not in it
        out.stockRows.length == 2
    }
})
feature("the history reads a revaluation split's pair as one row and keeps each row's balance", {
    when() {
        const out = atDate("wrp.reader", {lotId, facilityId: wh, fromDate: "2026-06-10", asOfDate: "2026-06-30", pageSize: 50})
        const atA1 = (out.historyRows || []).filter(row => row.locationSeqId === "A1")
        return {
            out,
            kinds: atA1.map(row => row.kind).join(","),
            balances: atA1.map(row => row.balance).join(","),
            split: atA1.find(row => row.kind === "revaluation") || {},
            receipt: atA1.find(row => row.kind === "receipt") || {},
            atB1: (out.historyRows || []).filter(row => row.locationSeqId === "B1").map(row => row.quantity)
        }
    },
    then({out, kinds, balances, split, receipt, atB1}) {
        kinds == "receipt,issue,adjustment,revaluation,move,move"
        balances == "15,12,11,11,5,3"
        split.quantity == 0
        split.movedQuantity == 6
        split.text == "Revaluation split of 6 from asset WRP_A1 to asset WRP_A2"
        receipt.documentText == "Shipment WRP_SHIP_IN"
        receipt.recordedDateText != ""
        atB1.join(",") == "6,2"
        out.historyRowsCount == 8
    }
})
feature("a place filter reads an asset's place then, from its audit log", {
    when() {
        return {
            atA1: atDate("wrp.reader", {lotId, facilityId: wh, locationSeqId: "A1", asOfDate: "2026-06-21"}),
            atB1: atDate("wrp.reader", {lotId, facilityId: wh, locationSeqId: "B1", asOfDate: "2026-06-21"}),
            nowB1: atDate("wrp.reader", {lotId, facilityId: wh, locationSeqId: "B1", asOfDate: "2026-06-30"})
        }
    },
    then({atA1, atB1, nowB1}) {
        // before its move WRP_A2's 6 were at A1 with WRP_A1's 5
        rowAt(atA1, "A1").closingQuantity == 11
        atA1.stockRows.length == 1
        atB1.stockRows.length == 0
        rowAt(nowB1, "B1").closingQuantity == 8
    }
})
feature("history from before a facility's first movement is incomplete, not zero", {
    when() {
        return {
            early: atDate("wrp.reader", {lotId, facilityId: wh, fromDate: "2026-05-01", asOfDate: "2026-06-30"}),
            before: atDate("wrp.reader", {lotId, facilityId: wh, fromDate: "2026-05-01", asOfDate: "2026-05-15"})
        }
    },
    then({early, before}) {
        early.complete == false
        rowAt(early, "A1").openingQuantity == null
        rowAt(early, "A1").complete == false
        rowAt(early, "A1").closingQuantity == 3
        early.historyStartText.startsWith("2026-06-01")
        before.complete == false
        before.stockRows.length == 0
    }
})
feature("stock at a date is scoped to the user's organizations and the caller's facilities, with totals by unit", {
    when() {
        return {
            all: atDate("wrp.reader", {facilityId: wh, asOfDate: "2026-06-30"}),
            second: atDate("wrp.reader", {lotId, facilityIds: [wh2], asOfDate: "2026-06-30"}),
            none: atDate("wrp.reader", {lotId, facilityIds: [], asOfDate: "2026-06-30"}),
            refused: atDate("wrp.reader", {facilityId: otherWh, asOfDate: "2026-06-30"}),
            outsider: atDate("wrp.outsider", {lotId, asOfDate: "2026-06-30"}),
            reversed: atDate("wrp.reader", {fromDate: "2026-06-30", asOfDate: "2026-06-01"})
        }
    },
    then({all, second, none, refused, outsider, reversed}) {
        all.totalRows.length == 2
        all.totalRows.find(row => row.quantityUomId === "WT_kg").closingQuantity == 12.5
        all.totalRows.find(row => row.quantityUomId === "OTH_ea").closingQuantity == 11
        second.stockRows.map(row => row.facilityId).join(",") == "WRP_WH2"
        second.stockRows[0].closingQuantity == 4
        none.stockRows.length == 0
        refused.error.includes("FACILITY_UNAVAILABLE")
        outsider.stockRows.map(row => row.facilityId).join(",") == "WRP_OWH"
        reversed.error.includes("DATE_RANGE")
    }
})
feature("the cut-off is the end of a day in the user's zone, on a pinned clock at a day boundary", {
    when() {
        ec.user.setEffectiveTime(pinned)
        try {
            const today = as("wrp.reader", () => ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd"))
            const yesterday = utcDay(Date.parse(today) - DAY)
            return {
                today,
                utcToday: utcDay(pinned),
                current: atDate("wrp.reader", {productId: "WRP_D", fromDate: yesterday}),
                earlier: atDate("wrp.reader", {productId: "WRP_D", fromDate: yesterday, asOfDate: yesterday}),
                future: atDate("wrp.reader", {productId: "WRP_D", asOfDate: utcDay(pinned)})
            }
        } finally {
            ec.user.setEffectiveTime(null)
        }
    },
    then({today, utcToday, current, earlier, future}) {
        // the pinned clock is on the day before the UTC day in Chicago, and the row an hour before it is on that day
        today != utcToday
        current.asOfDay == today
        current.stockRows.length == 1
        current.stockRows[0].closingQuantity == 4
        earlier.stockRows.length == 0
        future.error.includes("DATE_FUTURE")
    }
})
feature("operations history lists each document and product with its quantities and totals by unit, never across units", {
    when() {
        const out = history("wrp.reader", {fromDate: "2026-06-01", thruDate: "2026-06-30", pageSize: 50})
        const rowOf = (shipmentId, productId) =>
            (out.historyRows || []).find(row => row.shipmentId === shipmentId && row.productId === productId) || {}
        return {
            out,
            received: rowOf("WRP_SHIP_IN", "WRP_P"),
            gasket: rowOf("WRP_SHIP_IN", "WRP_K"),
            shipped: rowOf("WRP_SHIP_OUT", "WRP_P"),
            each: (out.totalRows || []).find(row => row.quantityUomId === "OTH_ea") || {},
            kilograms: (out.totalRows || []).find(row => row.quantityUomId === "WT_kg") || {}
        }
    },
    then({out, received, gasket, shipped, each, kilograms}) {
        out.error == ""
        out.complete == true
        out.historyRowsCount == 3
        received.operation == "receipt"
        received.expectedQuantity == 16
        received.acceptedQuantity == 15
        received.rejectedQuantity == 1
        received.partyName == "Report supplier"
        received.expectedDateText == "2026-06-01"
        received.daysFromExpected == 11
        received.pickedQuantity == null
        gasket.acceptedQuantity == 12.5
        shipped.operation == "shipment"
        shipped.pickedQuantity == 3
        shipped.shippedQuantity == 3
        shipped.deliveredQuantity == 3
        shipped.carrierName == "Report carrier"
        shipped.daysFromExpected == 1
        out.totalRows.length == 2
        each.expectedQuantity == 19
        each.acceptedQuantity == 15
        each.shippedQuantity == 3
        kilograms.expectedQuantity == 12.5
        kilograms.acceptedQuantity == 12.5
        kilograms.shippedQuantity == null
    }
})
feature("operations history filters by operation, party, carrier, product and the document date, in the scope", {
    when() {
        const ids = out => (out.historyRows || []).map(row => row.shipmentId + ":" + row.productId).join(",")
        const period = {fromDate: "2026-06-01", thruDate: "2026-06-30"}
        return {
            shipments: ids(history("wrp.reader", Object.assign({operation: "shipment"}, period))),
            supplier: ids(history("wrp.reader", Object.assign({partyId: "WRP_SUPPLIER"}, period))),
            carrier: ids(history("wrp.reader", Object.assign({carrierPartyId: "WRP_CARRIER"}, period))),
            gasket: ids(history("wrp.reader", Object.assign({productId: "WRP_K"}, period))),
            byDocument: ids(history("wrp.reader", {dateBasis: "document", fromDate: "2026-06-14", thruDate: "2026-06-14"})),
            second: ids(history("wrp.reader", Object.assign({facilityIds: [wh2]}, period))),
            outsider: ids(history("wrp.outsider", period)),
            unknown: history("wrp.reader", {operation: "drop"}).error
        }
    },
    then({shipments, supplier, carrier, gasket, byDocument, second, outsider, unknown}) {
        shipments == "WRP_SHIP_OUT:WRP_P"
        supplier.split(",").sort().join(",") == "WRP_SHIP_IN:WRP_K,WRP_SHIP_IN:WRP_P"
        carrier == "WRP_SHIP_OUT:WRP_P"
        gasket == "WRP_SHIP_IN:WRP_K"
        byDocument == "WRP_SHIP_OUT:WRP_P"
        second == ""
        outsider == "WRP_SHIP_OTHER:WRP_P"
        unknown.includes("OPERATION_INVALID")
    }
})
feature("the ledger filters by shipment for the history's drill to its movements", {
    when() {
        const out = as("wrp.reader", () =>
            call("mantle.product.TraceabilityServices.find#Movements", {shipmentId: "WRP_SHIP_OUT"})
        )
        return {
            ids: Array.from(out.movementList || [])
                .map(row => row.assetDetailId)
                .join(",")
        }
    },
    then({ids}) {
        ids == "WRP_I1"
    }
})
