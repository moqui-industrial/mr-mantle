// Shared quality inspection (mantle.product.QualityServices, Quality.js; impl-warehouse P8, design §19 receipt to partial
// inspection): a change to a published template item starts a new row and an earlier inspection keeps the items it used; a
// receipt that needs inspection lands in quarantine with its inspection and its held quantity goes to matching; an inspector
// saves readings and submits, cannot verify, and nobody verifies what they submitted; a quality manager releases part, reserved
// to the waiting order, and scraps the rest through scrap#Asset; pegged demand is reserved before an earlier waiting order;
// scrap#Asset keeps its own permission. The organization, users and products are spec-local.
const Q = "mantle.product.QualityServices."
const T = "mantle.shipment.WarehouseTaskServices."
const org = "WHQ_ORG",
    supplier = "WHQ_SUPPLIER",
    customer = "WHQ_CUSTOMER",
    facility = "WHQ_FAC"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const n = value => (value == null ? 0 : Number(String(value)))
const since = "2000-01-01T00:00:00Z"
let keySeq = 0
const key = () => "whq-op-" + ++keySeq
// the next millisecond, so a dated change is strictly after what came before it
function tick() {
    const start = Date.now()
    while (Date.now() < start + 3) {}
}

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
function organization(partyId, roleTypeId) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
    call("create#mantle.party.Organization", {partyId, organizationName: partyId})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId})
}
function user(partyId, permissions) {
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
        toPartyId: org,
        relationshipTypeEnumId: "PrtAgent",
        toRoleTypeId: "OrgInternal",
        fromDate: since
    })
}
function purchaseOrder(productId, quantity) {
    const created = call("mantle.order.OrderServices.create#Order", {
        customerPartyId: org,
        vendorPartyId: supplier,
        currencyUomId: "USD",
        facilityId: facility
    })
    call("mantle.order.OrderServices.add#OrderProductQuantity", {
        orderId: created.orderId,
        orderPartSeqId: created.orderPartSeqId,
        productId,
        quantity,
        unitAmount: 5,
        itemTypeEnumId: "ItemInventory"
    })
    call("mantle.order.OrderServices.place#Order", {orderId: created.orderId})
    call("mantle.order.OrderServices.approve#Order", {orderId: created.orderId})
    return created.orderId
}
function salesOrder(productId, quantity) {
    const created = call("mantle.order.OrderServices.create#Order", {
        vendorPartyId: org,
        customerPartyId: customer,
        currencyUomId: "USD",
        facilityId: facility
    })
    call("mantle.order.OrderServices.add#OrderProductQuantity", {
        orderId: created.orderId,
        orderPartSeqId: created.orderPartSeqId,
        productId,
        quantity,
        unitAmount: 9
    })
    call("mantle.order.OrderServices.place#Order", {orderId: created.orderId})
    return created.orderId
}
// a purchase receipt of the product, received through the guard by the receiver
function receive(productId, quantity) {
    const orderId = purchaseOrder(productId, quantity)
    const shipmentId = run("whq_receiver", T + "ensure#PurchaseReceipt", {
        operationKey: key(),
        orderId,
        orderPartSeqId: "01",
        facilityId: facility
    }).result.shipmentId
    const received = run("whq_receiver", T + "receive#ShipmentStock", {
        operationKey: key(),
        shipmentId,
        productId,
        quantityAccepted: quantity
    })
    return {orderId, shipmentId, received}
}
// a published template of one product: a measured diameter (9.9 to 10.1) and a pass or fail finish
function template(productId) {
    const stored = run("whq_manager", Q + "store#InspectionTemplate", {
        templateName: "Incoming " + productId,
        organizationPartyId: org,
        inspectionContextEnumId: "QicReceipt",
        productId,
        samplePolicyEnumId: "QspFixed",
        sampleSize: 2,
        itemList: [
            {characteristicName: "Diameter", readingTypeEnumId: "QrtNumeric", lowerLimit: 9.9, upperLimit: 10.1, sequenceNum: 1},
            {characteristicName: "Finish", readingTypeEnumId: "QrtPassFail", sequenceNum: 2}
        ],
        action: "publish"
    })
    return stored.inspectionTemplateId
}
const itemsOf = inspectionTemplateId =>
    rows("mantle.product.quality.InspectionTemplateItem", {inspectionTemplateId}).filter(row => !row.thruDate)
const itemNamed = (inspectionTemplateId, name) => itemsOf(inspectionTemplateId).find(row => row.characteristicName === name)
const inspectionOf = id => one("mantle.product.quality.QualityInspection", {qualityInspectionId: id})
const asset = assetId => one("mantle.product.asset.Asset", {assetId})
// readings of both characteristics for the samples, then the result, by the inspector
function inspectAndSubmit(qualityInspectionId, inspectionTemplateId, accepted, rejected, username = "whq_inspector") {
    for (const sampleNumber of [1, 2]) {
        run(username, Q + "save#InspectionReading", {
            qualityInspectionId,
            inspectionTemplateItemId: itemNamed(inspectionTemplateId, "Diameter").inspectionTemplateItemId,
            sampleNumber,
            numericValue: sampleNumber === 1 ? 10.0 : 10.3
        })
        run(username, Q + "save#InspectionReading", {
            qualityInspectionId,
            inspectionTemplateItemId: itemNamed(inspectionTemplateId, "Finish").inspectionTemplateItemId,
            sampleNumber,
            passIndicator: "Y"
        })
    }
    return run(username, Q + "submit#Inspection", {
        qualityInspectionId,
        quantityAccepted: accepted,
        quantityRejected: rejected,
        resultReason: rejected ? "Diameter over the limit" : null
    })
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(org, "OrgInternal")
        organization(supplier, "Supplier")
        organization(customer, "Customer")
        call("mantle.ledger.LedgerServices.init#PartyAccountingConfiguration", {
            organizationPartyId: org,
            sourcePartyId: "DefaultSettings",
            baseCurrencyUomId: "USD"
        })
        call("mantle.ledger.LedgerServices.get#OrganizationFiscalTimePeriods", {
            organizationPartyId: org,
            filterDate: ec.user.nowTimestamp
        })
        const mapping = rows("mantle.ledger.config.AssetTypeGlAccount", {
            organizationPartyId: org,
            assetTypeEnumId: "AstTpInventory",
            classEnumId: null,
            assetId: null
        })[0]
        call("update#mantle.ledger.config.AssetTypeGlAccount", {
            assetTypeGlAccountId: mapping.assetTypeGlAccountId,
            scrapGlAccountId: "519200000"
        })
        user("WHQ_RECEIVER", ["STOCK_RECEIVE"])
        user("WHQ_INSPECTOR", ["QUALITY_INSPECT"])
        user("WHQ_MANAGER", ["QUALITY_VERIFY", "QUALITY_DISPOSE", "QUALITY_TEMPLATE_EDIT"])
        user("WHQ_BOTH", ["QUALITY_INSPECT", "QUALITY_VERIFY"])
        user("WHQ_READER", [])
        call("create#mantle.facility.Facility", {facilityId: facility, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: org})
        for (const [locationSeqId, locationTypeEnumId] of [
            ["PICK1", "FltPick"],
            ["QUAR1", "FltQuarantine"],
            ["MORG1", "FltMorgue"]
        ])
            call("create#mantle.facility.FacilityLocation", {facilityId: facility, locationSeqId, locationTypeEnumId})
        for (const [locationTypeEnumId, autoStatusId] of [
            ["FltQuarantine", "AstQuarantine"],
            ["FltMorgue", "AstMorgue"]
        ])
            call("create#mantle.facility.FacilityLocationType", {facilityId: facility, locationTypeEnumId, autoStatusId})
        for (const productId of ["WHQ_GAUGE", "WHQ_TRACKED", "WHQ_PEGGED", "WHQ_REVISED"])
            call("create#mantle.product.Product", {
                productId,
                productName: productId,
                productTypeEnumId: "PtAsset",
                assetTypeEnumId: "AstTpInventory",
                amountUomId: "OTH_ea",
                ownerPartyId: org
            })
        call("create#mantle.facility.ProductFacilityLocation", {
            productId: "WHQ_GAUGE",
            facilityId: facility,
            locationSeqId: "PICK1"
        })
        // the tracking policy asks for inspection of WHQ_TRACKED (no template applies to it)
        call("create#mantle.facility.WarehousePolicy", {
            organizationPartyId: org,
            policyType: "tracking",
            facilityId: "_NA_",
            productId: "WHQ_TRACKED",
            fromDate: since,
            inspectionRequired: "Y"
        })
        // a quarantine location for the policy-driven receipts
        call("create#mantle.facility.WarehousePolicy", {
            organizationPartyId: org,
            policyType: "operation",
            facilityId: facility,
            productId: "_NA_",
            fromDate: since,
            receiptSteps: 1,
            quarantineLocationSeqId: "QUAR1"
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

feature("a change to a published template item starts a new row, and an earlier inspection keeps the items it used", {
    when() {
        const denied = run("whq_inspector", Q + "store#InspectionTemplate", {templateName: "Not mine", organizationPartyId: org})
        const templateId = template("WHQ_REVISED")
        const diameter = itemNamed(templateId, "Diameter")
        const stock = call("mantle.product.AssetServices.receive#Asset", {
            productId: "WHQ_REVISED",
            facilityId: facility,
            locationSeqId: "QUAR1",
            quantity: 5,
            ownerPartyId: org,
            statusId: "AstQuarantine"
        })
        const earlier = run("whq_inspector", Q + "create#Inspection", {assetId: stock.assetId})
        tick()
        const noReason = run("whq_manager", Q + "store#InspectionTemplate", {
            inspectionTemplateId: templateId,
            itemList: [{inspectionTemplateItemId: diameter.inspectionTemplateItemId, upperLimit: 10.2}]
        })
        const changed = run("whq_manager", Q + "store#InspectionTemplate", {
            inspectionTemplateId: templateId,
            itemList: [{inspectionTemplateItemId: diameter.inspectionTemplateItemId, upperLimit: 10.2}],
            changeReason: "Supplier drawing revision B"
        })
        tick()
        const later = run("whq_inspector", Q + "create#Inspection", {assetId: stock.assetId, quantity: 1})
        const earlierRead = run("whq_inspector", Q + "get#Inspection", {qualityInspectionId: earlier.qualityInspectionId})
        const laterRead = run("whq_inspector", Q + "get#Inspection", {qualityInspectionId: later.qualityInspectionId})
        const history = run("whq_reader", Q + "get#InspectionTemplate", {inspectionTemplateId: templateId})
        const asOfBefore = run("whq_reader", Q + "get#InspectionTemplate", {
            inspectionTemplateId: templateId,
            asOfDate: inspectionOf(earlier.qualityInspectionId).templateAsOfDate
        })
        const rowsOf = rows("mantle.product.quality.InspectionTemplateItem", {inspectionTemplateId: templateId})
        return {
            denied,
            templateId,
            diameter,
            earlier,
            noReason,
            changed,
            later,
            earlierRead,
            laterRead,
            history,
            asOfBefore,
            rowsOf
        }
    },
    then({denied, diameter, earlier, noReason, changed, earlierRead, laterRead, history, asOfBefore, rowsOf}) {
        denied.error.includes("PERMISSION_DENIED")
        earlier.error == ""
        earlier.inspectionTemplateId != null
        noReason.error.includes("REASON_REQUIRED")
        changed.error == ""
        changed.endedItemIds.includes(diameter.inspectionTemplateItemId)
        rowsOf.length == 3
        one("mantle.product.quality.InspectionTemplateItem", {inspectionTemplateItemId: diameter.inspectionTemplateItemId})
            .thruDate != null
        earlierRead.items.some(
            item => item.inspectionTemplateItemId == diameter.inspectionTemplateItemId && item.upperLimit == "10.1"
        )
        !laterRead.items.some(item => item.inspectionTemplateItemId == diameter.inspectionTemplateItemId)
        laterRead.items.some(item => item.characteristicName == "Diameter" && item.upperLimit == "10.2")
        history.revisionRows.length == 3
        history.items.length == 2
        asOfBefore.items.some(item => item.characteristicName == "Diameter" && item.upperLimit == "10.1")
    }
})

feature("a receipt that needs inspection lands in quarantine with its inspection, and its held quantity goes to matching", {
    when() {
        const templateId = template("WHQ_GAUGE")
        const gauge = receive("WHQ_GAUGE", 10)
        const tracked = receive("WHQ_TRACKED", 3)
        const gaugeInspection = inspectionOf(gauge.received.result.qualityInspectionIds[0])
        const trackedInspection = inspectionOf(tracked.received.result.qualityInspectionIds[0])
        const status = run("whq_reader", Q + "get#SourceInspectionStatus", {orderId: gauge.orderId, orderItemSeqId: "01"})
        return {templateId, gauge, tracked, gaugeInspection, trackedInspection, status}
    },
    then({templateId, gauge, tracked, gaugeInspection, trackedInspection, status}) {
        gauge.received.error == ""
        gauge.received.result.statusId == "AstQuarantine"
        gauge.received.result.locationSeqId == "QUAR1"
        asset(gauge.received.result.assetIds[0]).statusId == "AstQuarantine"
        gaugeInspection.inspectionTemplateId == templateId
        gaugeInspection.statusId == "QiDraft"
        n(gaugeInspection.heldQuantity) == 10
        n(gaugeInspection.sampleSize) == 2
        gaugeInspection.assetReceiptId == gauge.received.result.assetReceiptIds[0]
        tracked.received.result.statusId == "AstQuarantine"
        trackedInspection.inspectionTemplateId == null
        n(status.heldQuantity) == 10
        n(status.matchEligibleQuantity) == 0
        n(status.receiptRows[0].heldQuantity) == 10
    }
})

feature("an inspector saves readings and submits; an inspector cannot verify, and nobody verifies what they submitted", {
    when() {
        const templateId = rows("mantle.product.quality.InspectionTemplate", {productId: "WHQ_GAUGE"})[0].inspectionTemplateId
        const inspectionId = rows("mantle.product.quality.QualityInspection", {productId: "WHQ_GAUGE"})[0].qualityInspectionId
        const early = run("whq_inspector", Q + "submit#Inspection", {qualityInspectionId: inspectionId, quantityAccepted: 10})
        const reader = run("whq_reader", Q + "save#InspectionReading", {
            qualityInspectionId: inspectionId,
            inspectionTemplateItemId: itemNamed(templateId, "Finish").inspectionTemplateItemId,
            passIndicator: "Y"
        })
        const wrongSample = run("whq_inspector", Q + "save#InspectionReading", {
            qualityInspectionId: inspectionId,
            inspectionTemplateItemId: itemNamed(templateId, "Finish").inspectionTemplateItemId,
            sampleNumber: 3,
            passIndicator: "Y"
        })
        const mismatch = inspectAndSubmit(inspectionId, templateId, 6, 3)
        run("whq_inspector", Q + "submit#Inspection", {
            qualityInspectionId: inspectionId,
            quantityAccepted: 6,
            quantityRejected: 4,
            resultReason: "Diameter over the limit"
        })
        const submitted = inspectionOf(inspectionId)
        const failed = rows("mantle.product.quality.InspectionReading", {qualityInspectionId: inspectionId}).filter(
            row => row.passIndicator == "N"
        )
        const inspectorVerify = run("whq_inspector", Q + "verify#Inspection", {qualityInspectionId: inspectionId})
        const disposeEarly = run("whq_manager", Q + "dispose#Inspection", {
            operationKey: key(),
            qualityInspectionId: inspectionId,
            dispositionEnumId: "QdRelease",
            quantity: 6
        })
        // a second inspection submitted by a user who also verifies: not by them
        const stock = call("mantle.product.AssetServices.receive#Asset", {
            productId: "WHQ_GAUGE",
            facilityId: facility,
            locationSeqId: "QUAR1",
            quantity: 2,
            ownerPartyId: org,
            statusId: "AstQuarantine"
        })
        const own = run("whq_both", Q + "create#Inspection", {assetId: stock.assetId})
        const ownSubmit = inspectAndSubmit(own.qualityInspectionId, templateId, 2, 0, "whq_both")
        const selfVerify = run("whq_both", Q + "verify#Inspection", {qualityInspectionId: own.qualityInspectionId})
        const verified = run("whq_manager", Q + "verify#Inspection", {qualityInspectionId: inspectionId})
        return {
            early,
            reader,
            wrongSample,
            mismatch,
            submitted,
            failed,
            inspectorVerify,
            disposeEarly,
            ownSubmit,
            selfVerify,
            verified
        }
    },
    then({
        early,
        reader,
        wrongSample,
        mismatch,
        submitted,
        failed,
        inspectorVerify,
        disposeEarly,
        ownSubmit,
        selfVerify,
        verified
    }) {
        early.error.includes("READINGS_REQUIRED")
        reader.error.includes("PERMISSION_DENIED")
        wrongSample.error.includes("SAMPLE_INVALID")
        mismatch.error.includes("QUANTITY_MISMATCH")
        submitted.statusId == "QiSubmitted"
        submitted.resultEnumId == "QirPartial"
        n(submitted.quantityAccepted) == 6
        failed.length == 1
        inspectorVerify.error.includes("PERMISSION_DENIED")
        disposeEarly.error.includes("VERIFICATION_REQUIRED")
        ownSubmit.error == ""
        selfVerify.error.includes("SELF_VERIFY")
        verified.error == ""
        verified.statusId == "QiVerified"
    }
})

feature("a quality manager releases part, reserved to the waiting order, and scraps the rest", {
    when() {
        const inspection = rows("mantle.product.quality.QualityInspection", {productId: "WHQ_GAUGE"}).find(
            row => row.statusId == "QiVerified"
        )
        const waiting = salesOrder("WHQ_GAUGE", 4)
        const over = run("whq_manager", Q + "dispose#Inspection", {
            operationKey: key(),
            qualityInspectionId: inspection.qualityInspectionId,
            dispositionEnumId: "QdRelease",
            quantity: 7
        })
        const releaseKey = key()
        const released = run("whq_manager", Q + "dispose#Inspection", {
            operationKey: releaseKey,
            qualityInspectionId: inspection.qualityInspectionId,
            dispositionEnumId: "QdRelease",
            quantity: 6
        })
        const retried = run("whq_manager", Q + "dispose#Inspection", {
            operationKey: releaseKey,
            qualityInspectionId: inspection.qualityInspectionId,
            dispositionEnumId: "QdRelease",
            quantity: 6
        })
        const waitingReservations = rows("mantle.product.issuance.AssetReservation", {orderId: waiting})
        const scrapped = run("whq_manager", Q + "dispose#Inspection", {
            operationKey: key(),
            qualityInspectionId: inspection.qualityInspectionId,
            dispositionEnumId: "QdScrap",
            quantity: 4,
            toLocationSeqId: "MORG1",
            reason: "Diameter over the limit"
        })
        const after = inspectionOf(inspection.qualityInspectionId)
        const status = run("whq_reader", Q + "get#SourceInspectionStatus", {assetReceiptId: inspection.assetReceiptId})
        return {inspection, over, released, retried, waitingReservations, scrapped, after, status}
    },
    then({inspection, over, released, retried, waitingReservations, scrapped, after, status}) {
        over.error.includes("QUANTITY_EXCEEDS_RESULT")
        released.error == ""
        released.result.statusId == "AstAvailable"
        asset(released.result.resultAssetId).statusId == "AstAvailable"
        n(asset(released.result.resultAssetId).quantityOnHandTotal) == 6
        retried.result.alreadyApplied == true
        rows("mantle.product.quality.QualityInspectionDisposition", {qualityInspectionId: inspection.qualityInspectionId})
            .length == 2
        waitingReservations.some(row => row.assetId == released.result.resultAssetId && n(row.quantity) == 4)
        scrapped.error == ""
        scrapped.result.statusId == "AstMorgue"
        scrapped.result.physicalInventoryId != null
        one("mantle.product.asset.PhysicalInventory", {physicalInventoryId: scrapped.result.physicalInventoryId})
            .scrapIndicator == "Y"
        n(asset(scrapped.result.resultAssetId).quantityOnHandTotal) == 0
        after.statusId == "QiDisposed"
        n(after.heldQuantity) == 0
        n(status.heldQuantity) == 0
        n(status.matchEligibleQuantity) == 10
        n(status.inspectionRejectedQuantity) == 4
    }
})

feature("pegged demand is reserved before an earlier waiting order, and scrap#Asset keeps its own permission", {
    when() {
        const first = salesOrder("WHQ_PEGGED", 3)
        const pegged = salesOrder("WHQ_PEGGED", 3)
        const stock = call("mantle.product.AssetServices.receive#Asset", {
            productId: "WHQ_PEGGED",
            facilityId: facility,
            locationSeqId: "QUAR1",
            quantity: 3,
            ownerPartyId: org,
            statusId: "AstQuarantine"
        })
        const created = run("whq_inspector", Q + "create#Inspection", {
            assetId: stock.assetId,
            demandOrderId: pegged,
            demandOrderItemSeqId: "01"
        })
        run("whq_inspector", Q + "submit#Inspection", {qualityInspectionId: created.qualityInspectionId, quantityAccepted: 3})
        run("whq_manager", Q + "verify#Inspection", {qualityInspectionId: created.qualityInspectionId})
        const released = run("whq_manager", Q + "dispose#Inspection", {
            operationKey: key(),
            qualityInspectionId: created.qualityInspectionId,
            dispositionEnumId: "QdRelease",
            quantity: 3
        })
        const scrapOther = run("whq_manager", T + "scrap#Asset", {
            operationKey: key(),
            assetId: released.result?.resultAssetId,
            varianceReasonEnumId: "InVrScrap",
            qualityInspectionId: created.qualityInspectionId
        })
        const scrapPlain = run("whq_manager", T + "scrap#Asset", {
            operationKey: key(),
            assetId: released.result?.resultAssetId,
            varianceReasonEnumId: "InVrScrap"
        })
        return {
            first,
            pegged,
            created,
            released,
            firstReservations: rows("mantle.product.issuance.AssetReservation", {orderId: first}),
            peggedReservations: rows("mantle.product.issuance.AssetReservation", {orderId: pegged}),
            scrapOther,
            scrapPlain
        }
    },
    then({created, released, firstReservations, peggedReservations, scrapOther, scrapPlain}) {
        created.error == ""
        released.error == ""
        released.result.reservedOrderId != null
        peggedReservations.some(row => row.assetId == released.result.resultAssetId && n(row.quantity) == 3)
        !firstReservations.some(row => row.assetId == released.result.resultAssetId)
        scrapOther.error.includes("PERMISSION_DENIED")
        scrapPlain.error.includes("PERMISSION_DENIED")
    }
})
