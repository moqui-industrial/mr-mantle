// The Shippo shipping gateway (plan/payments-shipping-edi.md S1, ShippoServices.xml and Shippo.js) through Mantle's
// Warehouse shipping services, with the HTTP fixtures answering its REST calls with sanitized Shippo-shaped answers:
// address validation, shipment rates and an order rate, labels bought and tracked, a queued label finished later by the
// pending-label job and by the transaction webhook, a lost purchase found by its metadata and not bought again, an
// independent package failure, a refund that completes later, and the webhook kept once, refused on an unauthenticated
// remote and ignored for the other mode. The signature and URL token checks are the framework's (SmatHmacSha256Timestamp,
// SmatUrlToken, with Rust tests in crates/moqui-core). New spec, no Groovy original.
const T = "mantle.shipment.WarehouseTaskServices."
const S = "mantle.shipment.carrier.ShippoServices."
const org = "SHP_ORG",
    facility = "SHP_FAC",
    customer = "SHP_CUST",
    carrier = "SHP_CARRIER",
    gateway = "SHIPPO_SPEC",
    account = "acct_spec_carrier"
const API = "https://api.goshippo.com"
const FILES = "https://shippo-delivery.example.com/labels/"
const TOKEN = "spec-shippo-token"
const SECRET = "spec-shippo-webhook-secret"
const http = ec.factory.getTool("HttpFixtures")
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const n = value => (value == null ? 0 : Number(String(value)))
const since = "2000-01-01T00:00:00Z"
let keySeq = 0
const key = () => "shp-op-" + ++keySeq

// ---- the spec's organization, users and shipments (as WarehouseShipping's) ----

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
function organization(partyId, roleTypeId) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
    call("create#mantle.party.Organization", {partyId, organizationName: partyId})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId})
}
function address(contactMechId, toName, postalCode, owner) {
    call("create#mantle.party.contact.ContactMech", {contactMechId, contactMechTypeEnumId: "CmtPostalAddress"})
    call("create#mantle.party.contact.PostalAddress", {
        contactMechId,
        toName,
        address1: "1 Spec Way",
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
// a packed sales shipment of SHP_A in boxed packages of the weights given (pounds), on the spec's carrier and a gateway
// (the main one by default; none with a store, whose ProductStoreShippingGateway then picks it)
function packedShipment(weights, options = {}) {
    const method = options.method || "ShMthGround"
    const gw = options.store ? null : options.gateway || gateway
    const created = call("mantle.order.OrderServices.create#Order", {
        vendorPartyId: org,
        customerPartyId: customer,
        currencyUomId: "USD",
        facilityId: facility
    })
    call("mantle.order.OrderServices.add#OrderProductQuantity", {
        orderId: created.orderId,
        orderPartSeqId: created.orderPartSeqId,
        productId: "SHP_A",
        quantity: weights.length,
        unitAmount: 10
    })
    call("mantle.order.OrderServices.set#OrderBillingShippingInfo", {
        orderId: created.orderId,
        orderPartSeqId: created.orderPartSeqId,
        shippingPostalContactMechId: "SHP_DEST",
        carrierPartyId: carrier,
        shipmentMethodEnumId: method
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
            productId: "SHP_A",
            quantity: 1,
            shipmentId,
            shipmentPackageSeqId: packageSeqId
        })
        call("update#mantle.shipment.ShipmentPackage", {
            shipmentId,
            shipmentPackageSeqId: packageSeqId,
            weight,
            weightUomId: "WT_lb",
            shipmentBoxTypeId: "SHP_BOX"
        })
    }
    call("mantle.shipment.ShipmentServices.complete#ShipmentPack", {shipmentId, getLabels: false})
    if (options.store) call("update#mantle.shipment.Shipment", {shipmentId, productStoreId: options.store})
    const segment = rows("mantle.shipment.ShipmentRouteSegment", {shipmentId})[0]
    call("update#mantle.shipment.ShipmentRouteSegment", {
        shipmentId,
        shipmentRouteSegmentSeqId: segment.shipmentRouteSegmentSeqId,
        carrierPartyId: carrier,
        shipmentMethodEnumId: method,
        shippingGatewayConfigId: gw,
        originFacilityId: facility,
        destPostalContactMechId: "SHP_DEST"
    })
    const packages = rows("mantle.shipment.ShipmentPackage", {shipmentId})
        .map(row => row.shipmentPackageSeqId)
        .sort()
    return {
        orderId: created.orderId,
        orderPartSeqId: created.orderPartSeqId,
        shipmentId,
        seg: segment.shipmentRouteSegmentSeqId,
        packages
    }
}
// the metadata end of a package, as the adapter sends it (and a fixture tells packages apart by)
const marker = (sh, index) => sh.shipmentId + "/" + sh.seg + "/" + sh.packages[index] + '"'
const routeSegs = shipmentId =>
    rows("mantle.shipment.ShipmentPackageRouteSeg", {shipmentId}).sort((a, b) =>
        a.shipmentPackageSeqId.localeCompare(b.shipmentPackageSeqId)
    )
const gatewayRequests = shipmentId =>
    rows("mantle.shipment.carrier.ShippingGatewayRequest", {shipmentId}).sort((a, b) =>
        String(a.shipmentPackageSeqId + a.shippingGatewayRequestId).localeCompare(
            String(b.shipmentPackageSeqId + b.shippingGatewayRequestId)
        )
    )
const labelRequest = (shipmentId, extra = {}) => Object.assign({operationKey: key(), shipmentId}, extra)
const bytesText = bytes => {
    let text = ""
    for (let index = 0; index < Math.min(bytes?.length || 0, 8); index++) text += String.fromCharCode(bytes[index])
    return text
}

// ---- Shippo's answers (sanitized, shaped as the 2018-02-08 API's) ----

function answer(method, url, body, extra = {}) {
    http.add(
        Object.assign(
            {method, url, status: method === "POST" ? 201 : 200, contentType: "application/json", body: JSON.stringify(body)},
            extra
        )
    )
}
const rate = (id, token, amount) => ({
    object_id: id,
    amount: String(amount),
    currency: "USD",
    provider: "Spec Carrier",
    carrier_account: account,
    servicelevel: {token, name: token === "spec_ground" ? "Spec Ground" : "Spec Express"},
    estimated_days: token === "spec_ground" ? 3 : 1,
    duration_terms: "Spec terms"
})
const shipmentAnswer = (id, rates, status = "SUCCESS") => ({object_id: id, status, rates, messages: []})
function transaction(id, rateId, status, metadata, extra = {}) {
    return Object.assign(
        {
            object_id: id,
            object_state: status === "ERROR" ? "INVALID" : "VALID",
            status,
            object_created: "2026-11-02T10:00:00.000Z",
            rate: rateId,
            metadata,
            test: true,
            label_file_type: "PDF_4x6",
            label_url: status === "SUCCESS" ? FILES + id + ".pdf" : "",
            tracking_number: status === "SUCCESS" ? "9400SPEC" + id.toUpperCase() : "",
            tracking_url_provider: status === "SUCCESS" ? "https://tools.example.com/track/" + id : "",
            tracking_status: status === "SUCCESS" ? "UNKNOWN" : null,
            eta: null,
            messages: []
        },
        extra
    )
}
const labelFile = id =>
    http.add({
        method: "GET",
        url: FILES + id + ".pdf",
        status: 200,
        contentType: "application/pdf",
        body: "%PDF-1.4 spec label " + id
    })
const sent = (method, path) => http.requests().filter(row => row.method === method && row.url.startsWith(API + path))
const bodyOf = row => JSON.parse(row.body)
const header = (row, name) => {
    const found = Object.keys(row.headers || {}).find(key => key.toLowerCase() === name.toLowerCase())
    return found === undefined ? null : row.headers[found]
}
// a webhook event kept by the receive service, then consumed as the framework's consume would
function webhook(event, remote = gateway + "_REMOTE") {
    const text = JSON.stringify(event)
    const received = invoke(S + "receive#Webhook", {
        systemMessageTypeId: "ShippoWebhook",
        systemMessageRemoteId: remote,
        messageText: text
    })
    let consumed = null
    if (received.systemMessageIdList?.length)
        consumed = invoke("org.moqui.impl.SystemMessageServices.consume#ReceivedSystemMessage", {
            systemMessageId: received.systemMessageIdList[0]
        })
    return {received, consumed, text}
}

function shippoGateway(id, grace) {
    call("create#mantle.shipment.carrier.ShippingGatewayConfig", {
        shippingGatewayConfigId: id,
        shippingGatewayTypeEnumId: "ShGtwyShippo",
        description: "Shippo spec " + id,
        systemMessageRemoteId: gateway + "_REMOTE",
        getOrderRateServiceName: S + "get#OrderShippingRate",
        getShippingRatesBulkName: S + "get#ShippingRatesBulk",
        getRateServiceName: S + "get#ShippingRate",
        requestLabelsServiceName: S + "request#ShippingLabels",
        findLabelServiceName: S + "find#ShippingLabels",
        refundLabelsServiceName: S + "refund#ShippingLabels",
        trackLabelsServiceName: S + "track#ShippingLabels",
        validateAddressServiceName: S + "validate#ShippingPostalAddress"
    })
    call("create#mantle.shipment.carrier.ShippingGatewayCarrier", {
        shippingGatewayConfigId: id,
        carrierPartyId: carrier,
        gatewayAccountId: account
    })
    call("create#mantle.shipment.carrier.ShippingGatewayOption", {
        shippingGatewayConfigId: id,
        optionEnumId: "SgoLabelType",
        optionValue: "PDF_4x6"
    })
    if (grace != null)
        call("create#mantle.shipment.carrier.ShippingGatewayOption", {
            shippingGatewayConfigId: id,
            optionEnumId: "SgoLookupGraceSeconds",
            optionValue: grace
        })
}
// one package's label bought at once (the shipment's first package): its fixtures and the request as the shipper
function buyLabel(sh, id, amount) {
    answer("POST", API + "/shipments", shipmentAnswer("shp_" + id, [rate("r_" + id, "spec_ground", amount)]), {
        bodyContains: marker(sh, 0),
        times: 1
    })
    answer("POST", API + "/transactions", transaction("tx_" + id, "r_" + id, "SUCCESS", null), {
        bodyContains: "r_" + id,
        times: 1
    })
    labelFile("tx_" + id)
    return run("shp_shipper", T + "request#PackageLabels", labelRequest(sh.shipmentId))
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(org, "OrgInternal")
        organization(customer, "Customer")
        organization(carrier, "Carrier")
        call("mantle.ledger.LedgerServices.init#PartyAccountingConfiguration", {
            organizationPartyId: org,
            sourcePartyId: "DefaultSettings",
            baseCurrencyUomId: "USD"
        })
        call("mantle.ledger.LedgerServices.get#OrganizationFiscalTimePeriods", {
            organizationPartyId: org,
            filterDate: ec.user.nowTimestamp
        })
        user("SHP_SHIPPER", ["SHIPMENT_SHIP"])
        call("create#mantle.facility.Facility", {facilityId: facility, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: org})
        call("create#mantle.facility.FacilityLocation", {
            facilityId: facility,
            locationSeqId: "PICK1",
            locationTypeEnumId: "FltPick"
        })
        address("SHP_ORIGIN", "SHP Origin", "84101", {facilityId: facility})
        address("SHP_DEST", "SHP Customer", "89119", {partyId: customer})
        address("SHP_VALID", "SHP Valid", "89120", {partyId: customer})
        address("SHP_BAD", "SHP Bad", "89121", {partyId: customer})
        call("create#mantle.product.Product", {
            productId: "SHP_A",
            productName: "SHP_A",
            productTypeEnumId: "PtAsset",
            assetTypeEnumId: "AstTpInventory",
            amountUomId: "OTH_ea",
            ownerPartyId: org
        })
        call("mantle.product.AssetServices.receive#Asset", {
            productId: "SHP_A",
            quantity: 60,
            facilityId: facility,
            locationSeqId: "PICK1",
            ownerPartyId: org,
            assetTypeEnumId: "AstTpInventory",
            acquireCost: 4,
            acquireCostUomId: "USD"
        })
        call("create#mantle.shipment.ShipmentBoxType", {
            shipmentBoxTypeId: "SHP_BOX",
            description: "Spec box",
            dimensionUomId: "LEN_in",
            boxLength: 10,
            boxWidth: 8,
            boxHeight: 4,
            weightUomId: "WT_lb"
        })
        for (const [shipmentMethodEnumId, gatewayServiceCode] of [
            ["ShMthGround", "spec_ground"],
            ["ShMthNextDay", "spec_express"]
        ])
            call("create#mantle.shipment.carrier.CarrierShipmentMethod", {
                carrierPartyId: carrier,
                shipmentMethodEnumId,
                gatewayServiceCode,
                description: gatewayServiceCode
            })
        for (const [remoteId, auth] of [
            [gateway + "_REMOTE", "SmatHmacSha256Timestamp"],
            ["SHIPPO_SPEC_OPEN", "SmatNone"]
        ])
            call("create#moqui.service.message.SystemMessageRemote", {
                systemMessageRemoteId: remoteId,
                description: "Shippo spec " + auth,
                systemMessageTypeId: "ShippoWebhook",
                sendUrl: API,
                usageCode: "T",
                password: TOKEN,
                sharedSecret: SECRET,
                messageAuthEnumId: auth,
                authHeaderName: "Shippo-Auth-Signature"
            })
        // the main gateway, and gateways of their own for the features that run the pending-label job, with a lookup
        // grace of 0, bound to a store, and of a user who can no longer sign in
        for (const [id, grace] of [
            [gateway, null],
            [gateway + "_Q", null],
            [gateway + "_R", null],
            [gateway + "_G", "0"],
            [gateway + "_S", null],
            [gateway + "_U", null]
        ])
            shippoGateway(id, grace)
        call("create#mantle.product.store.ProductStore", {productStoreId: "SHP_STORE", storeName: "SHP store"})
        call("create#mantle.product.store.ProductStoreShippingGateway", {
            productStoreId: "SHP_STORE",
            carrierPartyId: carrier,
            shippingGatewayConfigId: gateway + "_S"
        })
        user("SHP_GONE", ["SHIPMENT_SHIP"])
        http.enable()
        ec.artifactExecution.enableAuthz()
    },
    setup() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        http.clear()
        ec.message.clearErrors()
        login("john.doe")
        ec.artifactExecution.enableAuthz()
    },
    cleanupSpec() {
        // the spec's labels stay in the database: with no endpoint their gateway sends nothing when a later job asks
        ec.artifactExecution.disableAuthz()
        for (const id of [gateway + "_REMOTE", "SHIPPO_SPEC_OPEN"])
            call("update#moqui.service.message.SystemMessageRemote", {systemMessageRemoteId: id, sendUrl: null})
        ec.artifactExecution.enableAuthz()
        http.reset()
    }
})

feature("Shippo validates addresses: a valid one is CmtlValid with Shippo's id, a rejected one CmtlInvalid with its message", {
    when() {
        answer(
            "POST",
            API + "/addresses",
            {object_id: "addr_ok", is_complete: true, validation_results: {is_valid: true, messages: []}},
            {
                bodyContains: "SHP Valid"
            }
        )
        answer(
            "POST",
            API + "/addresses",
            {
                object_id: "addr_bad",
                is_complete: true,
                validation_results: {
                    is_valid: false,
                    messages: [{source: "USPS", code: "Address Not Found", text: "The address as submitted could not be found."}]
                }
            },
            {bodyContains: "SHP Bad"}
        )
        const validate = contactMechId =>
            invoke("mantle.shipment.CarrierServices.validate#PostalAddress", {
                contactMechId,
                partyId: customer,
                shippingGatewayConfigId: gateway
            })
        const good = validate("SHP_VALID"),
            bad = validate("SHP_BAD")
        return {
            good,
            bad,
            goodCm: one("mantle.party.contact.ContactMech", {contactMechId: "SHP_VALID"}),
            badCm: one("mantle.party.contact.ContactMech", {contactMechId: "SHP_BAD"}),
            goodPostal: one("mantle.party.contact.PostalAddress", {contactMechId: "SHP_VALID"}),
            requests: sent("POST", "/addresses")
        }
    },
    then({good, bad, goodCm, badCm, goodPostal, requests}) {
        good.error == ""
        bad.error == ""
        goodCm.trustLevelEnumId == "CmtlValid"
        goodPostal.shipGatewayAddressId == "addr_ok"
        badCm.trustLevelEnumId == "CmtlInvalid"
        badCm.validateMessage.includes("Address Not Found")
        requests.length == 2
        bodyOf(requests[0]).validate == true
        bodyOf(requests[0]).country == "US"
        // the version is explicit; the token is sent and redacted in the record
        header(requests[0], "Shippo-API-Version") == "2018-02-08"
        header(requests[0], "Authorization") == "[redacted]"
    }
})

feature("a two-package shipment is rated per package: a service one package cannot take is left out; an order part is rated", {
    when() {
        const sh = packedShipment([2, 7])
        answer(
            "POST",
            API + "/shipments",
            shipmentAnswer("shp_r1", [rate("r_r1_g", "spec_ground", "7.10"), rate("r_r1_x", "spec_express", "22.40")]),
            {
                times: 1
            }
        )
        answer(
            "POST",
            API + "/shipments",
            shipmentAnswer("shp_r2", [rate("r_r2_g", "spec_ground", "9.35"), rate("r_r2_o", "other_service", "1.00")]),
            {
                times: 1
            }
        )
        const rates = run("shp_shipper", T + "get#ShipmentRates", {shipmentId: sh.shipmentId})
        answer("POST", API + "/shipments", shipmentAnswer("shp_o1", [rate("r_o1_g", "spec_ground", "8.25")]), {times: 1})
        const order = invoke(S + "get#OrderShippingRate", {
            orderId: sh.orderId,
            orderPartSeqId: sh.orderPartSeqId,
            shippingGatewayConfigId: gateway,
            createOrderItem: false,
            packageInfoList: [{shipmentBoxTypeId: "SHP_BOX", weight: 2, weightUomId: "WT_lb"}]
        })
        return {rates, order, shipments: sent("POST", "/shipments")}
    },
    then({rates, order, shipments}) {
        rates.error == ""
        rates.rateRows.filter(row => row.rateSource == "gateway").length == 1
        rates.rateRows.find(row => row.rateSource == "gateway").shipmentMethodEnumId == "ShMthGround"
        rates.rateRows.find(row => row.rateSource == "gateway").shippingTotal == "16.45"
        rates.rateRows.find(row => row.rateSource == "gateway").currency == "USD"
        rates.providerErrors.length == 0
        order.error == ""
        n(order.shippingTotal) == 8.25
        shipments.length == 3
        bodyOf(shipments[0]).carrier_accounts[0] == "acct_spec_carrier"
        bodyOf(shipments[0]).parcels[0].distance_unit == "in"
        bodyOf(shipments[0]).parcels[0].mass_unit == "lb"
        bodyOf(shipments[0]).async == false
    }
})

feature("labels are bought for both packages, recorded with their ids, file, charge and currency, and tracked to delivery", {
    when() {
        const sh = packedShipment([2, 3])
        for (const [index, id] of [
            [0, "a"],
            [1, "b"]
        ]) {
            answer(
                "POST",
                API + "/shipments",
                shipmentAnswer("shp_" + id, [rate("r_" + id, "spec_ground", index ? "8.40" : "7.10")]),
                {
                    bodyContains: marker(sh, index),
                    times: 1
                }
            )
            answer("POST", API + "/transactions", transaction("tx_" + id, "r_" + id, "SUCCESS", null), {
                bodyContains: marker(sh, index),
                times: 1
            })
            labelFile("tx_" + id)
        }
        const labels = run("shp_shipper", T + "request#PackageLabels", labelRequest(sh.shipmentId))
        const bought = routeSegs(sh.shipmentId)
        const purchases = sent("POST", "/transactions")
        answer(
            "GET",
            API + "/transactions/tx_a",
            transaction("tx_a", "r_a", "SUCCESS", null, {tracking_status: "TRANSIT", eta: "2026-11-05T00:00:00Z"}),
            {
                times: 1
            }
        )
        answer("GET", API + "/transactions/tx_b", transaction("tx_b", "r_b", "SUCCESS", null, {tracking_status: "PRE_TRANSIT"}), {
            times: 1
        })
        const tracked = run("shp_shipper", T + "track#PackageLabels", {shipmentId: sh.shipmentId})
        const inTransit = routeSegs(sh.shipmentId)
        // the carrier delivers package a: the event's payload is not applied as it is; the transaction is read
        answer("GET", API + "/transactions/tx_a", transaction("tx_a", "r_a", "SUCCESS", null, {tracking_status: "DELIVERED"}))
        const event = {
            event: "track_updated",
            test: true,
            data: {
                carrier: "spec",
                tracking_number: bought[0].trackingCode,
                transaction: "tx_a",
                tracking_status: {
                    status: "DELIVERED",
                    substatus: {code: "delivered", text: "Delivered", action_required: false},
                    status_details: "Delivered to the front door.",
                    status_date: "2026-11-04T15:20:00Z"
                },
                tracking_history: []
            }
        }
        const delivered = webhook(event)
        const again = webhook(event)
        return {
            labels,
            bought,
            purchases,
            tracked,
            inTransit,
            delivered,
            again,
            after: routeSegs(sh.shipmentId),
            requests: gatewayRequests(sh.shipmentId)
        }
    },
    then({labels, bought, purchases, tracked, inTransit, delivered, again, after, requests}) {
        labels.error == ""
        labels.result.resultCode == "LABELED"
        labels.result.doneCount == 2
        bought[0].gatewayLabelId == "tx_a"
        bought[0].gatewayRateId == "r_a"
        bought[0].gatewayShipmentId == "shp_a"
        bought[0].gatewayStatus == "SUCCESS"
        bought[0].labelFileType == "PDF_4x6"
        bought[0].labelUrl == FILES + "tx_a.pdf"
        bytesText(bought[0].labelImage).startsWith("%PDF-1.")
        bought[0].trackingCode == "9400SPECTX_A"
        n(bought[0].actualAmount) == 7.1
        n(bought[1].actualAmount) == 8.4
        bought[0].gatewayAmountUomId == "USD"
        requests
            .filter(row => row.requestTypeEnumId == "SgrLabel")
            .every(row => row.statusId == "SgrqSucceeded" && row.amountUomId == "USD")
        // the request id is the transaction's metadata, which a lookup searches by
        purchases.length == 2
        bodyOf(purchases[0]).metadata.startsWith("mantle " + requests[0].shippingGatewayRequestId + " ")
        bodyOf(purchases[0]).label_file_type == "PDF_4x6"
        bodyOf(purchases[0]).async == false
        purchases.every(row => header(row, "Authorization") == "[redacted]" && header(row, "Shippo-API-Version") == "2018-02-08")
        tracked.okCount == 1
        inTransit[0].trackingStatusEnumId == "ShTsTransit"
        inTransit[0].trackingEta != null
        inTransit[1].trackingStatusEnumId == "ShTsUnknown"
        delivered.received.error == ""
        delivered.consumed.error == ""
        again.received.systemMessageIdList.length == 0
        again.received.duplicateOfId == delivered.received.systemMessageIdList[0]
        after[0].trackingStatusEnumId == "ShTsDelivered"
        after[0].trackingSubStatus == "delivered"
        after[1].trackingStatusEnumId == "ShTsUnknown"
    }
})

feature("one package's refused label fails alone; the other package keeps its label", {
    when() {
        const sh = packedShipment([2, 4])
        answer("POST", API + "/shipments", shipmentAnswer("shp_p1", [rate("r_p1", "spec_ground", "7.10")]), {
            bodyContains: marker(sh, 0)
        })
        answer("POST", API + "/shipments", shipmentAnswer("shp_p2", [rate("r_p2", "spec_ground", "7.90")]), {
            bodyContains: marker(sh, 1)
        })
        answer("POST", API + "/transactions", transaction("tx_p1", "r_p1", "SUCCESS", null), {bodyContains: "r_p1"})
        answer(
            "POST",
            API + "/transactions",
            transaction("tx_p2", "r_p2", "ERROR", null, {
                messages: [{source: "SpecCarrier", code: "", text: "The destination address could not be verified."}]
            }),
            {bodyContains: "r_p2"}
        )
        labelFile("tx_p1")
        const result = run("shp_shipper", T + "request#PackageLabels", labelRequest(sh.shipmentId))
        return {result, segs: routeSegs(sh.shipmentId), requests: gatewayRequests(sh.shipmentId)}
    },
    then({result, segs, requests}) {
        result.result.resultCode == "PARTIAL"
        result.result.packages[0].state == "done"
        result.result.packages[1].state == "failed"
        result.result.packages[1].reasonCode == "ADDRESS_INVALID"
        segs[0].gatewayLabelId == "tx_p1"
        bytesText(segs[0].labelImage).startsWith("%PDF-1.")
        segs[1].gatewayLabelId == null
        segs[1].gatewayRateId == "r_p2"
        requests[0].statusId == "SgrqSucceeded"
        requests[1].statusId == "SgrqFailed"
        requests[1].reasonCode == "ADDRESS_INVALID"
    }
})

feature(
    "a queued label is pending, and the pending-label job retrieves it later (an expired link asked again) without buying again",
    {
        when() {
            const sh = packedShipment([2], {gateway: gateway + "_Q"})
            answer("POST", API + "/shipments", shipmentAnswer("shp_q", [rate("r_q", "spec_ground", "6.60")]))
            answer("POST", API + "/transactions", transaction("tx_q", "r_q", "QUEUED", null))
            const first = run("shp_shipper", T + "request#PackageLabels", labelRequest(sh.shipmentId))
            const metadata = bodyOf(sent("POST", "/transactions")[0]).metadata
            const pending = {segs: routeSegs(sh.shipmentId), requests: gatewayRequests(sh.shipmentId)}
            // later Shippo has the label: listed by its rate; its first link has expired and the transaction gives a fresh one
            answer("GET", API + "/transactions?rate=r_q*", {
                next: null,
                previous: null,
                results: [transaction("tx_q", "r_q", "SUCCESS", metadata)]
            })
            answer("GET", API + "/rates/r_q", rate("r_q", "spec_ground", "6.60"))
            http.add({method: "GET", url: FILES + "tx_q.pdf", status: 403, body: "expired"})
            answer(
                "GET",
                API + "/transactions/tx_q",
                transaction("tx_q", "r_q", "SUCCESS", metadata, {label_url: FILES + "tx_q-fresh.pdf"})
            )
            labelFile("tx_q-fresh")
            const job = invoke(T + "finish#PendingLabelRequests", {shippingGatewayConfigId: gateway + "_Q", minAgeSeconds: 0})
            return {
                first,
                pending,
                job,
                segs: routeSegs(sh.shipmentId),
                requests: gatewayRequests(sh.shipmentId),
                purchases: sent("POST", "/transactions")
            }
        },
        then({first, pending, job, segs, requests, purchases}) {
            first.result.resultCode == "PENDING"
            first.result.packages[0].reasonCode == "LABEL_PENDING"
            pending.segs[0].gatewayLabelId == null
            pending.segs[0].gatewayStatus == "QUEUED"
            pending.requests[0].statusId == "SgrqUnknown"
            pending.requests[0].reasonCode == "LABEL_PENDING"
            job.error == ""
            job.results.filter(row => row.shippingGatewayRequestId == pending.requests[0].shippingGatewayRequestId)[0].statusId ==
                "SgrqSucceeded"
            segs[0].gatewayLabelId == "tx_q"
            segs[0].labelUrl == FILES + "tx_q-fresh.pdf"
            bytesText(segs[0].labelImage).startsWith("%PDF-1.")
            n(segs[0].actualAmount) == 6.6
            requests.length == 1
            requests[0].statusId == "SgrqSucceeded"
            purchases.length == 1
        }
    }
)

feature(
    "a queued label is finished by Shippo's transaction webhook, kept once; an unauthenticated remote and the other mode are refused",
    {
        when() {
            const sh = packedShipment([3])
            answer("POST", API + "/shipments", shipmentAnswer("shp_w", [rate("r_w", "spec_ground", "7.70")]))
            answer("POST", API + "/transactions", transaction("tx_w", "r_w", "WAITING", null))
            const first = run("shp_shipper", T + "request#PackageLabels", labelRequest(sh.shipmentId))
            const metadata = bodyOf(sent("POST", "/transactions")[0]).metadata
            answer("GET", API + "/transactions?rate=r_w*", {
                next: null,
                previous: null,
                results: [transaction("tx_w", "r_w", "SUCCESS", metadata)]
            })
            answer("GET", API + "/rates/r_w", rate("r_w", "spec_ground", "7.70"))
            labelFile("tx_w")
            const event = {event: "transaction_updated", test: true, data: transaction("tx_w", "r_w", "SUCCESS", metadata)}
            const delivered = webhook(event)
            const again = webhook(event)
            const open = webhook(event, "SHIPPO_SPEC_OPEN")
            const live = webhook({
                event: "transaction_updated",
                test: false,
                data: transaction("tx_w", "r_w", "SUCCESS", metadata)
            })
            return {
                first,
                delivered,
                again,
                open,
                live,
                segs: routeSegs(sh.shipmentId),
                requests: gatewayRequests(sh.shipmentId),
                purchases: sent("POST", "/transactions"),
                message: one("moqui.service.message.SystemMessage", {
                    systemMessageId: delivered.received.systemMessageIdList?.[0]
                })
            }
        },
        then({first, delivered, again, open, live, segs, requests, purchases, message}) {
            first.result.resultCode == "PENDING"
            delivered.received.error == ""
            delivered.consumed.error == ""
            message.statusId == "SmsgConsumed"
            message.docType == "transaction_updated"
            message.messageId.startsWith("shippo-")
            again.received.systemMessageIdList.length == 0
            again.received.duplicateOfId == message.systemMessageId
            open.received.error.includes("WEBHOOK_UNAUTHENTICATED")
            live.consumed.error == ""
            segs[0].gatewayLabelId == "tx_w"
            bytesText(segs[0].labelImage).startsWith("%PDF-1.")
            requests.length == 1
            requests[0].statusId == "SgrqSucceeded"
            purchases.length == 1
        }
    }
)

feature("a purchase whose answer is lost is found by its metadata and not bought again; one not listed yet stays pending", {
    when() {
        const sh = packedShipment([2])
        answer("POST", API + "/shipments", shipmentAnswer("shp_l", [rate("r_l", "spec_ground", "7.20")]))
        http.add({method: "POST", url: API + "/transactions", error: "operation timed out", times: 1})
        const first = run("shp_shipper", T + "request#PackageLabels", labelRequest(sh.shipmentId))
        const metadata = bodyOf(sent("POST", "/transactions")[0]).metadata
        const afterFirst = gatewayRequests(sh.shipmentId)
        answer("GET", API + "/transactions?rate=r_l*", {
            next: null,
            previous: null,
            results: [transaction("tx_l", "r_l", "SUCCESS", metadata)]
        })
        answer("GET", API + "/rates/r_l", rate("r_l", "spec_ground", "7.20"))
        labelFile("tx_l")
        const retry = run("shp_shipper", T + "request#PackageLabels", labelRequest(sh.shipmentId))
        const lostPurchases = sent("POST", "/transactions").length
        http.clear()
        // another lost purchase that Shippo does not list yet: within the lookup grace it stays pending
        const other = packedShipment([2])
        answer("POST", API + "/shipments", shipmentAnswer("shp_m", [rate("r_m", "spec_ground", "7.20")]))
        http.add({method: "POST", url: API + "/transactions", error: "connection reset", times: 1})
        run("shp_shipper", T + "request#PackageLabels", labelRequest(other.shipmentId))
        answer("GET", API + "/transactions?*", {next: null, previous: null, results: []})
        const notListed = run("shp_shipper", T + "request#PackageLabels", labelRequest(other.shipmentId))
        return {
            first,
            afterFirst,
            retry,
            lostPurchases,
            segs: routeSegs(sh.shipmentId),
            requests: gatewayRequests(sh.shipmentId),
            notListed,
            otherRequests: gatewayRequests(other.shipmentId),
            otherPurchases: sent("POST", "/transactions").length
        }
    },
    then({first, afterFirst, retry, lostPurchases, segs, requests, notListed, otherRequests, otherPurchases}) {
        first.result.resultCode == "PENDING"
        first.result.packages[0].state == "unknown"
        first.result.packages[0].reasonCode == "CARRIER_TIMEOUT"
        afterFirst[0].statusId == "SgrqUnknown"
        retry.result.resultCode == "LABELED"
        retry.result.packages[0].recovered == true
        segs[0].gatewayLabelId == "tx_l"
        requests.length == 1
        requests[0].statusId == "SgrqSucceeded"
        lostPurchases == 1
        notListed.result.resultCode == "PENDING"
        notListed.result.packages[0].reasonCode == "LABEL_PENDING"
        otherRequests.length == 1
        otherRequests[0].statusId == "SgrqUnknown"
        // the lost purchase itself, and nothing bought after it
        otherPurchases == 1
    }
})

feature("a refund Shippo queues is pending until the job reads it refunded; a refund it decides at once is refunded", {
    when() {
        const queued = packedShipment([2], {gateway: gateway + "_R"}),
            direct = packedShipment([2], {gateway: gateway + "_R"})
        const bought = [buyLabel(queued, "rq", "6.10"), buyLabel(direct, "rd", "6.20")]
        answer(
            "POST",
            API + "/refunds",
            {object_id: "ref_q", status: "QUEUED", transaction: "tx_rq", test: true},
            {bodyContains: "tx_rq"}
        )
        answer(
            "POST",
            API + "/refunds",
            {object_id: "ref_d", status: "SUCCESS", transaction: "tx_rd", test: true},
            {bodyContains: "tx_rd"}
        )
        const first = run("shp_shipper", T + "refund#PackageLabels", {operationKey: key(), shipmentId: queued.shipmentId})
        const pending = {segs: routeSegs(queued.shipmentId), requests: gatewayRequests(queued.shipmentId)}
        const immediate = run("shp_shipper", T + "refund#PackageLabels", {operationKey: key(), shipmentId: direct.shipmentId})
        answer("GET", API + "/refunds/ref_q", {object_id: "ref_q", status: "SUCCESS", transaction: "tx_rq", test: true})
        const job = invoke(T + "finish#PendingLabelRequests", {shippingGatewayConfigId: gateway + "_R", minAgeSeconds: 0})
        return {
            bought,
            first,
            pending,
            immediate,
            job,
            segs: routeSegs(queued.shipmentId),
            refundRequests: gatewayRequests(queued.shipmentId).filter(row => row.requestTypeEnumId == "SgrRefund"),
            directSegs: routeSegs(direct.shipmentId),
            refunds: sent("POST", "/refunds")
        }
    },
    then({bought, first, pending, immediate, job, segs, refundRequests, directSegs, refunds}) {
        bought.every(row => row.result.resultCode == "LABELED")
        first.result.resultCode == "PENDING"
        pending.segs[0].gatewayRefundId == "ref_q"
        pending.segs[0].gatewayRefundStatus == null
        immediate.result.resultCode == "REFUNDED"
        directSegs[0].gatewayRefundStatus == "refunded"
        directSegs[0].gatewayRefundId == "ref_d"
        job.error == ""
        job.okCount == 1
        segs[0].gatewayRefundStatus == "refunded"
        refundRequests.length == 1
        refundRequests[0].statusId == "SgrqSucceeded"
        // each refund asked for once
        refunds.length == 2
    }
})

feature("a lost purchase past the lookup grace is not bought by the job (NOT_FOUND); a person's request then buys it", {
    when() {
        const sh = packedShipment([2], {gateway: gateway + "_G"})
        answer("POST", API + "/shipments", shipmentAnswer("shp_g", [rate("r_g", "spec_ground", "7.30")]), {times: 1})
        http.add({method: "POST", url: API + "/transactions", error: "operation timed out", times: 1})
        const first = run("shp_shipper", T + "request#PackageLabels", labelRequest(sh.shipmentId))
        const lost = gatewayRequests(sh.shipmentId)[0]
        // Shippo has no such transaction: the job only asks (CARRIER_TIMEOUT is one of its reasons), never buys
        answer("GET", API + "/transactions?*", {next: null, previous: null, results: []})
        const job = invoke(T + "finish#PendingLabelRequests", {shippingGatewayConfigId: gateway + "_G", minAgeSeconds: 0})
        const afterJob = gatewayRequests(sh.shipmentId)[0]
        const jobPurchases = sent("POST", "/transactions").length
        // a second run leaves NOT_FOUND alone: it is not one of the job's reasons
        const again = invoke(T + "finish#PendingLabelRequests", {shippingGatewayConfigId: gateway + "_G", minAgeSeconds: 0})
        // a person requests the label again: the lookup finds nothing past the grace, so it is bought
        answer("POST", API + "/shipments", shipmentAnswer("shp_g2", [rate("r_g2", "spec_ground", "7.30")]))
        answer("POST", API + "/transactions", transaction("tx_g2", "r_g2", "SUCCESS", null), {bodyContains: "r_g2"})
        labelFile("tx_g2")
        const person = run("shp_shipper", T + "request#PackageLabels", labelRequest(sh.shipmentId))
        return {
            first,
            lost,
            job,
            afterJob,
            jobPurchases,
            again,
            person,
            after: gatewayRequests(sh.shipmentId)[0],
            segs: routeSegs(sh.shipmentId),
            purchases: sent("POST", "/transactions").length
        }
    },
    then({first, lost, job, afterJob, jobPurchases, again, person, after, segs, purchases}) {
        first.result.packages[0].reasonCode == "CARRIER_TIMEOUT"
        lost.firstSentDate != null
        job.okCount == 1
        job.results[0].reasonCode == "NOT_FOUND"
        afterJob.statusId == "SgrqUnknown"
        afterJob.reasonCode == "NOT_FOUND"
        // the first attempt's time does not move with later asks
        String(afterJob.firstSentDate) == String(lost.firstSentDate)
        jobPurchases == 1
        again.results.length == 0
        person.result.resultCode == "LABELED"
        after.statusId == "SgrqSucceeded"
        String(after.firstSentDate) == String(lost.firstSentDate)
        segs[0].gatewayLabelId == "tx_g2"
        purchases == 2
    }
})

feature("a webhook finds a store-bound package's gateway as the label flow does (the segment names none)", {
    when() {
        const sh = packedShipment([2], {store: "SHP_STORE"})
        const bought = buyLabel(sh, "s", "6.70")
        const segment = one("mantle.shipment.ShipmentRouteSegment", {
            shipmentId: sh.shipmentId,
            shipmentRouteSegmentSeqId: sh.seg
        })
        answer("GET", API + "/transactions/tx_s", transaction("tx_s", "r_s", "SUCCESS", null, {tracking_status: "TRANSIT"}))
        const event = webhook({
            event: "track_updated",
            test: true,
            data: {carrier: "spec", tracking_number: "9400SPECTX_S", transaction: "tx_s", tracking_status: {status: "TRANSIT"}}
        })
        return {bought, segment, event, segs: routeSegs(sh.shipmentId), reads: sent("GET", "/transactions/tx_s").length}
    },
    then({bought, segment, event, segs, reads}) {
        bought.result.resultCode == "LABELED"
        segment.shippingGatewayConfigId == null
        event.consumed.error == ""
        reads == 1
        segs[0].trackingStatusEnumId == "ShTsTransit"
    }
})

feature("the job does not run a request whose user cannot sign in, and stays signed in as its caller", {
    when() {
        const sh = packedShipment([2], {gateway: gateway + "_U"})
        answer("POST", API + "/shipments", shipmentAnswer("shp_u", [rate("r_u", "spec_ground", "7.40")]))
        answer("POST", API + "/transactions", transaction("tx_u", "r_u", "QUEUED", null))
        const first = run("shp_gone", T + "request#PackageLabels", labelRequest(sh.shipmentId))
        call("update#moqui.security.UserAccount", {userId: "SHP_GONE", disabled: "Y"})
        const job = invoke(T + "finish#PendingLabelRequests", {shippingGatewayConfigId: gateway + "_U", minAgeSeconds: 0})
        return {
            first,
            job,
            userId: ec.user.userId,
            request: gatewayRequests(sh.shipmentId)[0],
            asks: sent("GET", "/transactions").length
        }
    },
    then({first, job, userId, request, asks}) {
        first.result.resultCode == "PENDING"
        job.failedCount == 1
        job.results[0].reasonCode == "USER_UNAVAILABLE"
        userId == "EX_JOHN_DOE"
        request.statusId == "SgrqUnknown"
        request.reasonCode == "LABEL_PENDING"
        asks == 0
    }
})

feature("no API token or webhook secret reaches a package, a gateway request or a system message", {
    when() {
        const sh = packedShipment([2])
        const bought = buyLabel(sh, "x", "6.90")
        answer("GET", API + "/transactions/tx_x", transaction("tx_x", "r_x", "SUCCESS", null, {tracking_status: "TRANSIT"}))
        const event = webhook({
            event: "track_updated",
            test: true,
            data: {transaction: "tx_x", tracking_status: {status: "TRANSIT"}}
        })
        const texts = []
        for (const row of routeSegs(sh.shipmentId))
            texts.push(JSON.stringify(Object.assign({}, row.getMap(), {labelImage: null})))
        for (const row of gatewayRequests(sh.shipmentId)) texts.push(JSON.stringify(row.getMap()))
        for (const row of rows("moqui.service.message.SystemMessage", {systemMessageTypeId: "ShippoWebhook"}))
            texts.push(String(row.messageText))
        return {bought, event, text: texts.join("\n")}
    },
    then({bought, event, text}) {
        bought.result.resultCode == "LABELED"
        event.consumed.error == ""
        text.includes("tx_x")
        !text.includes(TOKEN)
        !text.includes(SECRET)
    }
})
