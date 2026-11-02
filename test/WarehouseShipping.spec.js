// Shipping, labels and printers (impl-warehouse P13, design-warehouse §10 Ship and PackageTracking, §12 Carriers and
// Printers, §19 label timeout and retry): a two-package shipment is rated by the local rules and by the Mantle test carrier;
// its labels are bought once each, a retry answers the first; a label timeout asks the carrier before retrying and buys no
// second label; a refused label and an invalid address fail without shipping; a method with no gateway ships with a manual
// tracking code and cost, and its packages' deliveries are recorded by hand; a label refund reverses no shipment; dispatch
// waits for tracking and an open inspection; a print failure leaves the posted result and offers a reprint; a return label
// goes through the same recorded gateway path. The organization, stock, addresses and users (in spec-local groups) are the
// spec's own; the test carrier (TEST_SHIPPING, TEST_CARRIER) is Mantle's seed.
const T = "mantle.shipment.WarehouseTaskServices.",
    P = "mantle.facility.PrintServices.",
    R = "mantle.order.ReturnServices."
const org = "WSH_ORG",
    facility = "WSH_FAC",
    customer = "WSH_CUST",
    gateway = "TEST_SHIPPING",
    carrier = "TEST_CARRIER"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const n = value => (value == null ? 0 : Number(String(value)))
const since = "2000-01-01T00:00:00Z"
const state = {}
let keySeq = 0
const key = () => "wsh-op-" + ++keySeq

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
function organization(partyId, roleTypeId) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
    call("create#mantle.party.Organization", {partyId, organizationName: partyId})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId})
}
// a postal address of the party (or the facility's shipping origin)
function address(contactMechId, postalCode, owner) {
    call("create#mantle.party.contact.ContactMech", {contactMechId, contactMechTypeEnumId: "CmtPostalAddress"})
    call("create#mantle.party.contact.PostalAddress", {
        contactMechId,
        toName: "WSH " + postalCode,
        address1: "1 Test Way",
        city: "Testville",
        postalCode,
        countryGeoId: "USA"
    })
    if (owner.facilityId)
        call("create#mantle.facility.FacilityContactMech", {
            facilityId: owner.facilityId,
            contactMechId,
            contactMechPurposeId: "PostalShippingOrigin",
            fromDate: since
        })
    else
        call("create#mantle.party.contact.PartyContactMech", {
            partyId: owner.partyId,
            contactMechId,
            contactMechPurposeId: "PostalShippingDest",
            fromDate: since
        })
}
// a packed sales shipment of WSH_A to the address, in packages of the weights given (pounds), its route segment on the
// carrier and method (and gateway) given
function packedShipment(postalContactMechId, weights, route = {}) {
    const created = call("mantle.order.OrderServices.create#Order", {
        vendorPartyId: org,
        customerPartyId: customer,
        currencyUomId: "USD",
        facilityId: facility
    })
    call("mantle.order.OrderServices.add#OrderProductQuantity", {
        orderId: created.orderId,
        orderPartSeqId: created.orderPartSeqId,
        productId: "WSH_A",
        quantity: weights.length,
        unitAmount: 10
    })
    call("mantle.order.OrderServices.set#OrderBillingShippingInfo", {
        orderId: created.orderId,
        orderPartSeqId: created.orderPartSeqId,
        shippingPostalContactMechId: postalContactMechId,
        carrierPartyId: route.carrierPartyId || "_NA_",
        shipmentMethodEnumId: route.shipmentMethodEnumId || "ShMthGround"
    })
    call("mantle.order.OrderServices.place#Order", {orderId: created.orderId})
    call("mantle.order.OrderServices.approve#Order", {orderId: created.orderId})
    const shipmentId = call("mantle.shipment.ShipmentServices.create#OrderPartShipment", {
        orderId: created.orderId,
        orderPartSeqId: created.orderPartSeqId
    }).shipmentId
    for (const weight of weights) {
        const packageSeqId = call("mantle.shipment.ShipmentServices.create#ShipmentPackage", {
            shipmentId,
            weight,
            weightUomId: "WT_lb"
        }).shipmentPackageSeqId
        call("mantle.shipment.ShipmentServices.pack#ShipmentProduct", {
            productId: "WSH_A",
            quantity: 1,
            shipmentId,
            shipmentPackageSeqId: packageSeqId
        })
        call("update#mantle.shipment.ShipmentPackage", {shipmentId, shipmentPackageSeqId: packageSeqId, weight})
    }
    call("mantle.shipment.ShipmentServices.complete#ShipmentPack", {shipmentId, getLabels: false})
    const segment = rows("mantle.shipment.ShipmentRouteSegment", {shipmentId})[0]
    call("update#mantle.shipment.ShipmentRouteSegment", {
        shipmentId,
        shipmentRouteSegmentSeqId: segment.shipmentRouteSegmentSeqId,
        shippingGatewayConfigId: route.shippingGatewayConfigId || null,
        originFacilityId: facility,
        destPostalContactMechId: postalContactMechId
    })
    return {orderId: created.orderId, shipmentId, segmentSeqId: segment.shipmentRouteSegmentSeqId}
}
const shipmentOf = shipmentId => one("mantle.shipment.Shipment", {shipmentId})
const routeSegs = shipmentId =>
    rows("mantle.shipment.ShipmentPackageRouteSeg", {shipmentId}).sort((a, b) =>
        a.shipmentPackageSeqId.localeCompare(b.shipmentPackageSeqId)
    )
const carrierLabels = shipmentId => rows("mantle.shipment.carrier.TestCarrierLabel", {shipmentId})
const gatewayRequests = shipmentId => rows("mantle.shipment.carrier.ShippingGatewayRequest", {shipmentId})
const issuedTotal = shipmentId =>
    rows("mantle.product.issuance.AssetIssuance", {shipmentId}).reduce((sum, row) => sum + n(row.quantity), 0)
const pdfText = bytes => {
    let text = ""
    for (let index = 0; index < Math.min(bytes?.length || 0, 8); index++) text += String.fromCharCode(bytes[index])
    return text
}
const labelRequest = (shipmentId, extra = {}) =>
    Object.assign({operationKey: key(), shipmentId, carrierPartyId: carrier, shipmentMethodEnumId: "ShMthGround"}, extra)

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(org, "OrgInternal")
        organization("WSH_OTHER", "OrgInternal")
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
        call("update#mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: org, returnSettlementRequired: "Y"})
        user("WSH_SHIPPER", ["SHIPMENT_SHIP"])
        user("WSH_PACKER", ["SHIPMENT_PACK"])
        user("WSH_READER", [])
        user("WSH_ADMIN", ["FACILITY_EDIT"])
        user("WSH_OUTSIDER", ["SHIPMENT_SHIP", "FACILITY_EDIT"], "WSH_OTHER")
        call("create#mantle.facility.Facility", {facilityId: facility, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: org})
        call("create#mantle.facility.FacilityLocation", {
            facilityId: facility,
            locationSeqId: "PICK1",
            locationTypeEnumId: "FltPick"
        })
        address("WSH_ORIGIN", "84101", {facilityId: facility})
        address("WSH_DEST", "89119", {partyId: customer})
        address("WSH_TIMEOUT", "99901", {partyId: customer})
        address("WSH_REFUSED", "99902", {partyId: customer})
        address("WSH_INVALID", "99903", {partyId: customer})
        address("WSH_QUEUED", "99904", {partyId: customer})
        address("WSH_STUCK", "99905", {partyId: customer})
        call("create#mantle.product.Product", {
            productId: "WSH_A",
            productName: "WSH_A",
            productTypeEnumId: "PtAsset",
            assetTypeEnumId: "AstTpInventory",
            amountUomId: "OTH_ea",
            ownerPartyId: org
        })
        call("create#mantle.product.ProductDimension", {
            productId: "WSH_A",
            dimensionTypeId: "ShippingWeight",
            value: 2,
            valueUomId: "WT_lb"
        })
        call("mantle.product.AssetServices.receive#Asset", {
            productId: "WSH_A",
            quantity: 60,
            facilityId: facility,
            locationSeqId: "PICK1",
            ownerPartyId: org,
            assetTypeEnumId: "AstTpInventory",
            acquireCost: 4,
            acquireCostUomId: "USD"
        })
        // this organization lets the test carrier buy its labels (off by default, P13 review A2)
        call("create#mantle.party.PartySetting", {
            partyId: org,
            partySettingTypeId: "ShippingTestGatewayAllowed",
            settingValue: "Y"
        })
        // a gateway that cannot be asked what it did after a timeout (no find#ShippingLabels), serving the test carrier
        call("create#mantle.shipment.carrier.ShippingGatewayConfig", {
            shippingGatewayConfigId: "WSH_NOFIND",
            description: "No lookup gateway",
            requestLabelsServiceName: "mantle.shipment.carrier.TestGatewayServices.request#ShippingLabels",
            refundLabelsServiceName: "mantle.shipment.carrier.TestGatewayServices.refund#ShippingLabels"
        })
        call("create#mantle.shipment.carrier.ShippingGatewayCarrier", {
            shippingGatewayConfigId: "WSH_NOFIND",
            carrierPartyId: carrier
        })
        call("create#moqui.basic.print.NetworkPrinter", {
            networkPrinterId: "WSH_PRINTER",
            serverHost: "127.0.0.1",
            serverPort: 9,
            description: "WSH label printer"
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

feature("a two-package shipment is rated by the local rules and by the test carrier's weight and zone table", {
    when() {
        const sh = packedShipment("WSH_DEST", [2, 3.5], {shippingGatewayConfigId: gateway})
        state.two = sh
        return {
            rates: run("wsh_shipper", T + "get#ShipmentRates", {shipmentId: sh.shipmentId}),
            reader: run("wsh_reader", T + "get#ShipmentRates", {shipmentId: sh.shipmentId}),
            outsider: run("wsh_outsider", T + "get#ShipmentRates", {shipmentId: sh.shipmentId})
        }
    },
    then({rates, reader, outsider}) {
        rates.error == ""
        rates.packageCount == 2
        rates.totalWeight == "5.5"
        // the test carrier: zone 1 (84101 to 89119); ground 6 + 0.50 a pound, rounded up: 7 + 8
        rates.rateRows.filter(row => row.rateSource == "gateway" && row.carrierPartyId == "TEST_CARRIER").length == 3
        rates.rateRows.find(row => row.rateSource == "gateway" && row.shipmentMethodEnumId == "ShMthGround").shippingTotal == "15"
        // next day: 22 + 2 a pound: 26 + 30
        rates.rateRows.find(row => row.rateSource == "gateway" && row.shipmentMethodEnumId == "ShMthNextDay").shippingTotal ==
            "56"
        rates.rateRows.find(row => row.rateSource == "gateway").canLabel == true
        // the local rules over get#OrderShippingRateLocal, for the methods with no gateway
        rates.rateRows.some(row => row.rateSource == "local" && row.carrierPartyId == "_NA_" && row.shippingTotal != null)
        rates.providerErrors.length == 0
        reader.error.includes("PERMISSION_DENIED")
        outsider.error.includes("RECORD_UNAVAILABLE")
    }
})

feature("both packages' labels are bought once through the test carrier; a retry answers the first", {
    when() {
        const shipmentId = state.two.shipmentId
        const request = labelRequest(shipmentId)
        const packer = run("wsh_packer", T + "request#PackageLabels", labelRequest(shipmentId))
        // a gateway that does not serve the carrier, and the test gateway for an organization that does not allow it (A2)
        const unbound = run("wsh_shipper", T + "request#PackageLabels", labelRequest(shipmentId, {carrierPartyId: "UPS"}))
        call("update#mantle.party.PartySetting", {
            partyId: org,
            partySettingTypeId: "ShippingTestGatewayAllowed",
            settingValue: "N"
        })
        const notAllowed = run("wsh_shipper", T + "request#PackageLabels", labelRequest(shipmentId))
        call("update#mantle.party.PartySetting", {
            partyId: org,
            partySettingTypeId: "ShippingTestGatewayAllowed",
            settingValue: "Y"
        })
        const first = run("wsh_shipper", T + "request#PackageLabels", request)
        const retry = run("wsh_shipper", T + "request#PackageLabels", request)
        const again = run("wsh_shipper", T + "request#PackageLabels", labelRequest(shipmentId))
        return {
            packer,
            unbound,
            notAllowed,
            first,
            retry,
            again,
            labels: carrierLabels(shipmentId),
            segs: routeSegs(shipmentId),
            requests: gatewayRequests(shipmentId)
        }
    },
    then({packer, unbound, notAllowed, first, retry, again, labels, segs, requests}) {
        packer.error.includes("PERMISSION_DENIED")
        unbound.error.includes("GATEWAY_NOT_FOR_CARRIER")
        notAllowed.error.includes("TEST_GATEWAY")
        first.error == ""
        first.result.resultCode == "LABELED"
        first.result.doneCount == 2
        first.result.packages.every(row => row.state == "done" && row.trackingCode.startsWith("1ZTEST"))
        retry.result.alreadyApplied == true
        again.result.resultCode == "LABELED"
        again.result.packages.every(row => row.state == "skipped" && row.reasonCode == "LABEL_EXISTS")
        // the carrier issued two labels, one a package
        labels.length == 2
        segs.every(row => row.trackingCode && pdfText(row.labelImage).startsWith("%PDF-1."))
        n(segs[0].actualAmount) + n(segs[1].actualAmount) == 15
        requests.length == 2
        requests.every(row => row.statusId == "SgrqSucceeded" && row.requestTypeEnumId == "SgrLabel")
    }
})

feature("a label timeout asks the carrier before retrying and buys no second label", {
    when() {
        // the segment's committed carrier is _NA_ with no gateway; the request chooses the test carrier and its gateway,
        // which is the gateway recorded, called and asked after the timeout (P13 review A1)
        const sh = packedShipment("WSH_TIMEOUT", [1, 1])
        state.timeout = sh
        const request = labelRequest(sh.shipmentId, {shippingGatewayConfigId: gateway})
        const first = run("wsh_shipper", T + "request#PackageLabels", request)
        const afterFirst = {
            labels: carrierLabels(sh.shipmentId).length,
            requests: gatewayRequests(sh.shipmentId).map(row => row.statusId)
        }
        const tracked = routeSegs(sh.shipmentId).filter(row => row.trackingCode).length
        // the same request again: not stored, so it runs and asks the carrier first (the in-flight window is over, the
        // requests are Unknown)
        const retry = run("wsh_shipper", T + "request#PackageLabels", request)
        return {first, afterFirst, tracked, retry, labels: carrierLabels(sh.shipmentId), requests: gatewayRequests(sh.shipmentId)}
    },
    then({first, afterFirst, tracked, retry, labels, requests}) {
        first.error == ""
        first.result.resultCode == "PENDING"
        first.result.unknownCount == 2
        first.result.packages.every(row => row.reasonCode == "CARRIER_TIMEOUT")
        // the carrier did issue the labels; the answer was lost
        afterFirst.labels == 2
        afterFirst.requests.every(statusId => statusId == "SgrqUnknown")
        tracked == 0
        retry.result.resultCode == "LABELED"
        retry.result.alreadyApplied == false
        retry.result.packages.every(row => row.state == "done" && row.recovered == true)
        // still two labels: nothing bought twice
        labels.length == 2
        requests.length == 2
        requests.every(
            row => row.statusId == "SgrqSucceeded" && n(row.attemptCount) == 2 && row.shippingGatewayConfigId == gateway
        )
        requests.every(row => row.sentDate != null)
    }
})

feature("a refused label and an invalid address fail without shipping", {
    when() {
        const refused = packedShipment("WSH_REFUSED", [1], {shippingGatewayConfigId: gateway})
        const invalid = packedShipment("WSH_INVALID", [1], {shippingGatewayConfigId: gateway})
        const validation = call("mantle.shipment.CarrierServices.validate#PostalAddress", {
            contactMechId: "WSH_INVALID",
            partyId: customer,
            shippingGatewayConfigId: gateway
        })
        return {
            refused: run("wsh_shipper", T + "request#PackageLabels", labelRequest(refused.shipmentId)),
            refusedRequests: gatewayRequests(refused.shipmentId),
            invalid: run("wsh_shipper", T + "request#PackageLabels", labelRequest(invalid.shipmentId)),
            validation,
            trust: one("mantle.party.contact.ContactMech", {contactMechId: "WSH_INVALID"}),
            ship: run("wsh_shipper", T + "ship#OutgoingShipment", {operationKey: key(), shipmentId: refused.shipmentId}),
            readiness: run("wsh_shipper", T + "get#ShipReadiness", {shipmentId: refused.shipmentId}),
            nothing: run("wsh_shipper", T + "refund#PackageLabels", {operationKey: key(), shipmentId: refused.shipmentId}),
            status: shipmentOf(refused.shipmentId).statusId
        }
    },
    then({refused, refusedRequests, invalid, trust, ship, readiness, nothing, status}) {
        nothing.result.resultCode == "NOTHING_TO_REFUND"
        refused.result.resultCode == "FAILED"
        refused.result.packages[0].reasonCode == "LABEL_REFUSED"
        refusedRequests[0].statusId == "SgrqFailed"
        invalid.result.packages[0].reasonCode == "ADDRESS_INVALID"
        trust.trustLevelEnumId == "CmtlInvalid"
        ship.error.includes("TRACKING_REQUIRED")
        readiness.canShip == false
        readiness.blockers.some(row => row.code == "TRACKING_REQUIRED")
        status == "ShipPacked"
    }
})

feature("a method with no gateway ships with a manual tracking code and cost, and its deliveries are recorded by hand", {
    when() {
        const sh = packedShipment("WSH_DEST", [2, 2])
        state.manual = sh
        const noGateway = run("wsh_shipper", T + "request#PackageLabels", {operationKey: key(), shipmentId: sh.shipmentId})
        const shipEarly = run("wsh_shipper", T + "ship#OutgoingShipment", {operationKey: key(), shipmentId: sh.shipmentId})
        const tracked = run("wsh_shipper", T + "record#ManualTracking", {
            operationKey: key(),
            shipmentId: sh.shipmentId,
            trackingCode: "LOCAL-COURIER-7",
            actualCost: 12.5
        })
        const viaGateway = run("wsh_shipper", T + "record#ManualTracking", {
            operationKey: key(),
            shipmentId: state.two.shipmentId,
            trackingCode: "X"
        })
        const shipKey = key()
        const shipped = run("wsh_shipper", T + "ship#OutgoingShipment", {operationKey: shipKey, shipmentId: sh.shipmentId})
        const shipRetry = run("wsh_shipper", T + "ship#OutgoingShipment", {operationKey: shipKey, shipmentId: sh.shipmentId})
        const segment = one("mantle.shipment.ShipmentRouteSegment", {
            shipmentId: sh.shipmentId,
            shipmentRouteSegmentSeqId: sh.segmentSeqId
        })
        const noEvidence = run("wsh_shipper", T + "record#PackageDelivery", {
            operationKey: key(),
            shipmentId: sh.shipmentId,
            shipmentPackageSeqId: "01"
        })
        const firstBox = run("wsh_shipper", T + "record#PackageDelivery", {
            operationKey: key(),
            shipmentId: sh.shipmentId,
            shipmentPackageSeqId: routeSegs(sh.shipmentId)[0].shipmentPackageSeqId,
            recipientName: "Front desk"
        })
        const afterFirst = shipmentOf(sh.shipmentId).statusId
        const secondBox = run("wsh_shipper", T + "record#PackageDelivery", {
            operationKey: key(),
            shipmentId: sh.shipmentId,
            shipmentPackageSeqId: routeSegs(sh.shipmentId)[1].shipmentPackageSeqId,
            note: "Left at the loading dock, photo on file"
        })
        return {
            noGateway,
            shipEarly,
            tracked,
            viaGateway,
            shipped,
            shipRetry,
            segment,
            noEvidence,
            firstBox,
            afterFirst,
            secondBox,
            segs: routeSegs(sh.shipmentId),
            status: shipmentOf(sh.shipmentId).statusId
        }
    },
    then({
        noGateway,
        shipEarly,
        tracked,
        viaGateway,
        shipped,
        shipRetry,
        segment,
        noEvidence,
        firstBox,
        afterFirst,
        secondBox,
        segs,
        status
    }) {
        noGateway.error.includes("NO_GATEWAY")
        shipEarly.error.includes("TRACKING_REQUIRED")
        tracked.error == ""
        tracked.result.resultCode == "TRACKING_RECORDED"
        tracked.result.costUomId == "USD"
        // the test carrier's labels are on that shipment: refund them before recording tracking by hand (B5)
        viaGateway.error.includes("LABEL_EXISTS")
        shipped.error == ""
        shipped.result.resultCode == "SHIPPED"
        shipped.result.trackingCodes.length == 2
        shipRetry.result.alreadyApplied == true
        n(segment.actualCost) == 12.5
        noEvidence.error.includes("EVIDENCE_REQUIRED")
        firstBox.result.shipmentDelivered == false
        afterFirst == "ShipShipped"
        secondBox.result.shipmentDelivered == true
        segs.every(row => row.trackingStatusEnumId == "ShTsDelivered" && row.deliveryRecordedByUserId == "WSH_SHIPPER")
        status == "ShipDelivered"
    }
})

feature("an open inspection holds dispatch; a label refund before ship reverses nothing, and after ship is refused", {
    when() {
        const shipmentId = state.two.shipmentId
        const issuedBefore = issuedTotal(shipmentId)
        // a refund before ship voids the labels and leaves the shipment, its stock and packages as they are
        const changeCarrier = run(
            "wsh_shipper",
            T + "request#PackageLabels",
            labelRequest(shipmentId, {shipmentMethodEnumId: "ShMthNextDay"})
        )
        const refund = run("wsh_shipper", T + "refund#PackageLabels", {operationKey: key(), shipmentId})
        const afterRefund = {
            status: shipmentOf(shipmentId).statusId,
            issued: issuedTotal(shipmentId),
            segs: routeSegs(shipmentId)
        }
        const again = run("wsh_shipper", T + "refund#PackageLabels", {operationKey: key(), shipmentId})
        const shipUnlabelled = run("wsh_shipper", T + "ship#OutgoingShipment", {operationKey: key(), shipmentId})
        const relabel = run("wsh_shipper", T + "request#PackageLabels", labelRequest(shipmentId))
        const inspection = call("create#mantle.product.quality.QualityInspection", {
            organizationPartyId: org,
            facilityId: facility,
            shipmentId,
            productId: "WSH_A",
            statusId: "QiDraft",
            quantity: 1
        })
        const held = run("wsh_shipper", T + "ship#OutgoingShipment", {operationKey: key(), shipmentId})
        call("update#mantle.product.quality.QualityInspection", {
            qualityInspectionId: inspection.qualityInspectionId,
            statusId: "QiCancelled"
        })
        const shipped = run("wsh_shipper", T + "ship#OutgoingShipment", {operationKey: key(), shipmentId})
        const tracked = run("wsh_shipper", T + "track#PackageLabels", {shipmentIds: [shipmentId, state.manual.shipmentId]})
        const refundShipped = run("wsh_shipper", T + "refund#PackageLabels", {operationKey: key(), shipmentId})
        return {
            changeCarrier,
            refund,
            afterRefund,
            again,
            shipUnlabelled,
            relabel,
            held,
            issuedBefore,
            shipped,
            tracked,
            refundShipped,
            labels: carrierLabels(shipmentId)
        }
    },
    then({
        changeCarrier,
        refund,
        afterRefund,
        again,
        shipUnlabelled,
        relabel,
        held,
        issuedBefore,
        shipped,
        tracked,
        refundShipped,
        labels
    }) {
        // another method while labels are on the packages: refund first (B5)
        changeCarrier.error.includes("LABEL_EXISTS")
        refund.result.resultCode == "REFUNDED"
        refund.result.statusId == "ShipPacked"
        afterRefund.status == "ShipPacked"
        afterRefund.issued == issuedBefore
        afterRefund.segs.every(row => row.gatewayRefundStatus == "refunded")
        again.result.packages.every(row => row.reasonCode == "ALREADY_REFUNDED")
        shipUnlabelled.error.includes("TRACKING_REQUIRED")
        relabel.result.resultCode == "LABELED"
        held.error.includes("INSPECTION_HOLD")
        shipped.result.resultCode == "SHIPPED"
        // tracking: the test carrier's shipment refreshes; the manual one has no gateway and is named
        tracked.okCount == 1
        tracked.results.find(row => row.shipmentId == state.manual.shipmentId).reasonCode == "NO_GATEWAY"
        // a used label is not refunded (B6)
        refundShipped.error.includes("SHIPMENT_SHIPPED")
        labels.length == 4
        labels.filter(row => row.refundedDate != null).length == 2
    }
})

feature("a gateway that cannot be asked after a timeout is sent again only when a person says so", {
    when() {
        const sh = packedShipment("WSH_TIMEOUT", [1])
        const request = labelRequest(sh.shipmentId, {shippingGatewayConfigId: "WSH_NOFIND"})
        const first = run("wsh_shipper", T + "request#PackageLabels", request)
        const retry = run("wsh_shipper", T + "request#PackageLabels", request)
        const afterRetry = carrierLabels(sh.shipmentId).length
        const sendAgain = run(
            "wsh_shipper",
            T + "request#PackageLabels",
            Object.assign({}, request, {operationKey: key(), sendAgain: "Y"})
        )
        return {
            first,
            retry,
            afterRetry,
            sendAgain,
            labels: carrierLabels(sh.shipmentId),
            requests: gatewayRequests(sh.shipmentId)
        }
    },
    then({first, retry, afterRetry, sendAgain, labels, requests}) {
        first.result.resultCode == "PENDING"
        retry.result.packages[0].reasonCode == "SEND_AGAIN_REQUIRED"
        afterRetry == 1
        // the same reference sent again: the test carrier answers the label it issued, so still one label
        sendAgain.result.resultCode == "LABELED"
        labels.length == 1
        requests.length == 1
        requests[0].statusId == "SgrqSucceeded"
    }
})

feature("a queued label is pending; the next request asks the carrier and completes it, buying no second label", {
    when() {
        const sh = packedShipment("WSH_QUEUED", [1])
        const request = labelRequest(sh.shipmentId, {shippingGatewayConfigId: gateway})
        const first = run("wsh_shipper", T + "request#PackageLabels", request)
        const afterFirst = {
            labels: carrierLabels(sh.shipmentId).length,
            tracked: routeSegs(sh.shipmentId).filter(row => row.trackingCode).length,
            requests: gatewayRequests(sh.shipmentId).map(row => row.statusId + ":" + row.reasonCode)
        }
        const retry = run("wsh_shipper", T + "request#PackageLabels", request)
        // a label the carrier keeps queued stays pending when asked, and is not bought again
        const stuck = packedShipment("WSH_STUCK", [1])
        const stuckRequest = labelRequest(stuck.shipmentId, {shippingGatewayConfigId: gateway})
        run("wsh_shipper", T + "request#PackageLabels", stuckRequest)
        const stuckRetry = run("wsh_shipper", T + "request#PackageLabels", stuckRequest)
        return {
            first,
            afterFirst,
            retry,
            labels: carrierLabels(sh.shipmentId),
            requests: gatewayRequests(sh.shipmentId),
            tracked: routeSegs(sh.shipmentId).filter(row => row.trackingCode).length,
            stuckRetry,
            stuckLabels: carrierLabels(stuck.shipmentId).length
        }
    },
    then({first, afterFirst, retry, labels, requests, tracked, stuckRetry, stuckLabels}) {
        first.error == ""
        first.result.resultCode == "PENDING"
        first.result.packages[0].state == "pending"
        first.result.packages[0].reasonCode == "LABEL_PENDING"
        afterFirst.labels == 1
        afterFirst.tracked == 0
        afterFirst.requests.join() == "SgrqUnknown:LABEL_PENDING"
        retry.result.resultCode == "LABELED"
        retry.result.packages[0].recovered == true
        labels.length == 1
        requests.length == 1
        requests[0].statusId == "SgrqSucceeded" && n(requests[0].attemptCount) == 2
        tracked == 1
        stuckRetry.result.resultCode == "PENDING"
        stuckRetry.result.packages[0].reasonCode == "LABEL_PENDING"
        stuckLabels == 1
    }
})

feature("a print failure leaves the posted result and offers a reprint; the printer bindings need the facility admin", {
    when() {
        const shipmentId = state.timeout.shipmentId
        const binding = {
            facilityId: facility,
            printerPurposeEnumId: "PtpPackageLabel",
            networkPrinterId: "WSH_PRINTER",
            copies: 2
        }
        const packer = run("wsh_packer", P + "store#FacilityPrinter", binding)
        const outsider = run("wsh_outsider", P + "store#FacilityPrinter", binding)
        const bound = run("wsh_admin", P + "store#FacilityPrinter", binding)
        const unbound = run("wsh_shipper", P + "dispatch#Document", {
            facilityId: facility,
            printerPurposeEnumId: "PtpLotLabel",
            documentType: "shipmentLabel",
            shipmentId
        })
        const printed = run("wsh_shipper", P + "dispatch#Document", {
            facilityId: facility,
            printerPurposeEnumId: "PtpPackageLabel",
            documentType: "shipmentLabel",
            shipmentId
        })
        const reprint = run("wsh_shipper", P + "dispatch#Document", {facilityId: facility, printJobId: printed.printJobIds?.[0]})
        const capabilities = run("wsh_shipper", P + "get#PrinterCapabilities", {facilityId: facility})
        return {
            packer,
            outsider,
            bound,
            unbound,
            printed,
            reprint,
            capabilities,
            row: one("mantle.facility.FacilityPrinter", {facilityId: facility, printerPurposeEnumId: "PtpPackageLabel"}),
            status: shipmentOf(shipmentId).statusId,
            segs: routeSegs(shipmentId)
        }
    },
    then({packer, outsider, bound, unbound, printed, reprint, capabilities, row, status, segs}) {
        packer.error.includes("PERMISSION_DENIED")
        outsider.error.includes("RECORD_UNAVAILABLE")
        bound.error == ""
        n(row.copies) == 2
        row.fromDate != null
        unbound.printed == false
        unbound.reasonCode == "PRINTER_NOT_BOUND"
        printed.error == ""
        printed.printed == false
        printed.reasonCode == "PRINTING_UNAVAILABLE" || printed.reasonCode == "PRINT_FAILED"
        printed.reprintable == true
        printed.printJobIds.length >= 1
        // each package's label tried and named, not stopped at the first failure (B3)
        printed.results.length == 2
        printed.results.every(row => !row.printed && row.printJobId)
        reprint.printed == false
        reprint.printJobIds[0] == printed.printJobIds[0]
        capabilities.printers[0].pdf == true
        capabilities.printers[0].zpl == false
        capabilities.printers[0].availability == "unavailable" || capabilities.printers[0].availability == "failing"
        // what was posted stays: the labels and the shipment
        status == "ShipPacked"
        segs.every(row => row.trackingCode)
    }
})

feature("a return label is requested on the same recorded gateway path", {
    when() {
        // a shipped sale to return
        const sale = call("mantle.order.OrderServices.create#Order", {
            vendorPartyId: org,
            customerPartyId: customer,
            currencyUomId: "USD",
            facilityId: facility
        })
        call("mantle.order.OrderServices.add#OrderProductQuantity", {
            orderId: sale.orderId,
            orderPartSeqId: sale.orderPartSeqId,
            productId: "WSH_A",
            quantity: 1,
            unitAmount: 10
        })
        call("mantle.order.OrderServices.set#OrderBillingShippingInfo", {
            orderId: sale.orderId,
            orderPartSeqId: sale.orderPartSeqId,
            shippingPostalContactMechId: "WSH_DEST",
            carrierPartyId: "_NA_",
            shipmentMethodEnumId: "ShMthGround"
        })
        call("mantle.order.OrderServices.place#Order", {orderId: sale.orderId})
        call("mantle.order.OrderServices.approve#Order", {orderId: sale.orderId})
        call("mantle.shipment.ShipmentServices.ship#OrderPart", {orderId: sale.orderId, orderPartSeqId: sale.orderPartSeqId})
        const returnId = call(R + "create#ReturnFromOrder", {orderId: sale.orderId, orderPartSeqId: sale.orderPartSeqId}).returnId
        const orderItemSeqId = rows("mantle.order.OrderItem", {orderId: sale.orderId}).find(
            row => row.productId === "WSH_A"
        ).orderItemSeqId
        call(R + "add#OrderItemToReturn", {
            returnId,
            orderId: sale.orderId,
            orderItemSeqId,
            returnQuantity: 1,
            returnReasonEnumId: "RrsnDefective",
            returnResponseEnumId: "RrspCredit"
        })
        call(R + "approve#Return", {returnId})
        const notConfigured = run("wsh_shipper", T + "request#ReturnLabel", {operationKey: key(), returnId})
        const shipmentId = notConfigured.result?.shipmentId
        call("update#mantle.shipment.ShipmentRouteSegment", {
            shipmentId,
            shipmentRouteSegmentSeqId: notConfigured.result?.shipmentRouteSegmentSeqId,
            shippingGatewayConfigId: gateway,
            carrierPartyId: carrier,
            shipmentMethodEnumId: "ShMthGround",
            originPostalContactMechId: "WSH_DEST",
            destPostalContactMechId: "WSH_ORIGIN",
            destinationFacilityId: facility
        })
        const labelKey = key()
        const label = run("wsh_shipper", T + "request#ReturnLabel", {
            operationKey: labelKey,
            returnId,
            weight: 2,
            weightUomId: "WT_lb"
        })
        const retry = run("wsh_shipper", T + "request#ReturnLabel", {
            operationKey: labelKey,
            returnId,
            weight: 2,
            weightUomId: "WT_lb"
        })
        const exists = run("wsh_shipper", T + "request#ReturnLabel", {operationKey: key(), returnId})
        return {notConfigured, label, retry, exists, requests: gatewayRequests(shipmentId), labels: carrierLabels(shipmentId)}
    },
    then({notConfigured, label, retry, exists, requests, labels}) {
        notConfigured.result.resultCode == "LABEL_NOT_CONFIGURED"
        label.error == ""
        label.result.resultCode == "LABEL_REQUESTED"
        label.result.trackingCode.startsWith("1ZTEST")
        retry.result.alreadyApplied == true
        exists.result.resultCode == "LABEL_EXISTS"
        requests.length == 1
        requests[0].statusId == "SgrqSucceeded"
        labels.length == 1
    }
})
