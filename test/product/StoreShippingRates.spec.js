// Local shipping rates (impl-commerce P6, F20; mantle.product.StoreAdminServices store#StoreShippingRate,
// get#StoreShippingRateLocal, simulate#StoreShipping; StoreCheckout.js; CarrierServices.get#OrderShippingRateLocal): band
// bounds, priority and date overlap refused; a store with rates charges the matching rate's amount (the lowest priority, the
// weight band in its unit), and no rate means no delivery (no item, rateUnavailable, left out of the bulk rates), never free;
// the simulator quotes two zones and none for a third country; a store with no rates keeps the local gateway's zero, as does
// one whose rates have all ended; readiness blocks a store on the local gateway with no rate.
// Standalone: spec-local organizations, users, stores, product, addresses and orders, artifact authorization disabled (the
// rules are the services' own checks). Run: ./moq test mr-mantle --spec StoreShippingRates
const A = "mantle.product.StoreAdminServices."
const C = "mantle.shipment.CarrierServices."
const S = "mantle.product.store."
const prefix = "STRATE"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const ids = {}
const users = {}

function system(action) {
    login("john.doe")
    const was = ec.artifactExecution.disableAuthz()
    try {
        return action()
    } finally {
        if (!was) ec.artifactExecution.enableAuthz()
    }
}
const make = (entity, values) => call("create#" + entity, values)
const list = (entity, conditions) =>
    system(() => Array.from(ec.entity.find(entity).condition(conditions).disableAuthz().list()).map(row => row.getMap()))
function organization(partyId, name) {
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
    make("mantle.party.Organization", {partyId, organizationName: name})
    make("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
    make("mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: partyId, baseCurrencyUomId: "USD"})
}
function user(kind, organizationPartyId, permissions) {
    const id = prefix + "_" + kind.toUpperCase()
    make("mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    make("mantle.party.Person", {partyId: id, firstName: "Rates", lastName: kind})
    make("mantle.party.PartyRelationship", {
        partyRelationshipId: id,
        fromPartyId: id,
        toPartyId: organizationPartyId,
        relationshipTypeEnumId: "PrtAgent",
        fromDate: 0
    })
    make("moqui.security.UserGroup", {userGroupId: id, description: "Shipping rates " + kind})
    for (const permission of permissions)
        make("moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: 0})
    make("moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId: id,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        timeZone: "America/Chicago",
        locale: "en_US"
    })
    make("moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: 0})
    return id
}
// a call as a user, in its own transaction: its result and its refusal code ("" when it succeeds)
function run(username, service, parameters = {}) {
    login(username)
    const was = ec.artifactExecution.disableAuthz()
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(service).parameters(parameters).requireNewTransaction(true).call() || {}
        return Object.assign({}, out, {error: ec.message.hasError() ? ec.message.getErrorsString() : ""})
    } catch (error) {
        return {error: String(error.message || error)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        if (!was) ec.artifactExecution.enableAuthz()
        login("john.doe")
    }
}
// a decimal (which has no valueOf) or a number as a number
const num = value => (value == null ? null : typeof value.toNumber === "function" ? value.toNumber() : Number(value))
const code = out => (/([A-Z][A-Z0-9_]+):/.exec(out.error || "") || [])[1] || (out.error ? "ERROR" : "")
// a store of organization A on the local gateway, with the _NA_ carrier's ground and next day options
function localStore(name) {
    const productStoreId = run(users.manager, A + "store#Store", {storeName: name, organizationPartyId: orgA}).productStoreId
    system(() => {
        make(S + "ProductStoreShippingGateway", {productStoreId, carrierPartyId: "_NA_", shippingGatewayConfigId: "NA_LOCAL"})
        make(S + "ProductStoreShipOption", {
            productStoreId,
            carrierPartyId: "_NA_",
            shipmentMethodEnumId: "ShMthGround",
            sequenceNum: 1
        })
        make(S + "ProductStoreShipOption", {
            productStoreId,
            carrierPartyId: "_NA_",
            shipmentMethodEnumId: "ShMthNextDay",
            sequenceNum: 2
        })
    })
    return productStoreId
}
let orderCount = 0
// an open order of the store: one part going to an address (its state and country), quantity units of the 2 lb product
function order(productStoreId, stateProvinceGeoId, countryGeoId, quantity = 1, unitAmount = 20) {
    const orderId = prefix + "_SO_" + ++orderCount
    system(() => {
        const contactMechId = prefix + "_ADDR_" + orderCount
        make("mantle.party.contact.ContactMech", {contactMechId, contactMechTypeEnumId: "CmtPostalAddress"})
        make("mantle.party.contact.PostalAddress", {
            contactMechId,
            address1: "1 Rate Street",
            city: "Rateville",
            postalCode: "12345",
            stateProvinceGeoId,
            countryGeoId
        })
        make("mantle.order.OrderHeader", {
            orderId,
            productStoreId,
            currencyUomId: "USD",
            statusId: "OrderOpen",
            entryDate: ec.user.nowTimestamp
        })
        make("mantle.order.OrderPart", {
            orderId,
            orderPartSeqId: "01",
            vendorPartyId: orgA,
            postalContactMechId: contactMechId,
            carrierPartyId: "_NA_",
            shipmentMethodEnumId: "ShMthGround",
            statusId: "OrderOpen"
        })
        make("mantle.order.OrderItem", {
            orderId,
            orderItemSeqId: "01",
            orderPartSeqId: "01",
            itemTypeEnumId: "ItemProduct",
            productId: ids.product,
            quantity,
            unitAmount
        })
    })
    return orderId
}
// the local gateway's charge for the order's part (creating its shipping item), and the part's shipping items
function localRate(orderId, shipmentMethodEnumId = "ShMthGround") {
    const out = run("john.doe", C + "get#OrderShippingRateLocal", {
        orderId,
        orderPartSeqId: "01",
        shippingGatewayConfigId: "NA_LOCAL",
        carrierPartyId: "_NA_",
        shipmentMethodEnumId
    })
    const items = list("mantle.order.OrderItem", {orderId, itemTypeEnumId: "ItemShipping"})
    return {out, total: out.shippingTotal == null ? null : num(out.shippingTotal), items}
}
const rate = (productStoreId, values) =>
    run(users.manager, A + "store#StoreShippingRate", Object.assign({productStoreId}, values))
const blocking = (productStoreId, key) =>
    run(users.reader, A + "check#StoreReadiness", {productStoreId}).findings.find(row => row.key == key)

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Shipping rates organization A")
            organization(orgB, "Shipping rates organization B")
            users.reader = user("reader", orgA, ["COMMERCE_VIEW"])
            users.manager = user("manager", orgA, ["COMMERCE_VIEW", "COMMERCE_STORE_EDIT"])
            users.other = user("other", orgB, ["COMMERCE_VIEW", "COMMERCE_STORE_EDIT"])
            ids.product = prefix + "_BOX"
            make("mantle.product.Product", {productId: ids.product, productName: "Rated box", productTypeEnumId: "PtAsset"})
            make("mantle.product.ProductDimension", {
                productId: ids.product,
                dimensionTypeId: "ShippingWeight",
                value: 2,
                valueUomId: "WT_lb"
            })
        })
        ids.rated = localStore("Rates rated")
        ids.plain = localStore("Rates plain")
        // the rated store: continental US 5.00, heavier than 10 lb 9.00; Canada 12.00, and next day in the US at priority 5
        ids.us = rate(ids.rated, {geoId: "USCN", shippingAmount: "5.00", fromWeight: "0", thruWeight: "10", weightUomId: "WT_lb"})
        ids.usHeavy = rate(ids.rated, {geoId: "USCN", shippingAmount: "9.00", fromWeight: "10", weightUomId: "WT_lb"})
        ids.canada = rate(ids.rated, {geoId: "CAN", shippingAmount: "12.00"})
        ids.nextDay = rate(ids.rated, {
            geoId: "USCN",
            shipmentMethodEnumId: "ShMthNextDay",
            carrierPartyId: "_NA_",
            shippingAmount: "20.00",
            priority: 5
        })
    }
})

feature(
    "a rate's bands are ordered, the same priority may not overlap, and only a manager of the store's organization saves one",
    {
        when() {
            const later = Date.now() + 86400000
            return {
                saved: [ids.us, ids.usHeavy, ids.canada, ids.nextDay].map(code),
                weightBand: code(
                    rate(ids.rated, {geoId: "CAN", shippingAmount: "1", fromWeight: "5", thruWeight: "5", weightUomId: "WT_lb"})
                ),
                valueBand: code(rate(ids.rated, {geoId: "CAN", shippingAmount: "1", fromAmount: "50", thruAmount: "10"})),
                noUnit: code(rate(ids.rated, {geoId: "CAN", shippingAmount: "1", fromWeight: "5"})),
                noZone: code(rate(ids.rated, {geoId: "NOWHERE", shippingAmount: "1"})),
                noCharge: code(rate(ids.rated, {geoId: "CAN"})),
                past: code(rate(ids.rated, {geoId: "MEX", shippingAmount: "1", fromDate: Date.now() - 86400000})),
                // the same zone, band and priority overlaps, as does a later start of an open-ended rate; another priority does not
                overlap: rate(ids.rated, {
                    geoId: "USCN",
                    shippingAmount: "6.00",
                    fromWeight: "5",
                    thruWeight: "20",
                    weightUomId: "WT_lb"
                }),
                otherPriority: code(
                    rate(ids.rated, {
                        geoId: "USCN",
                        shippingAmount: "6.00",
                        fromWeight: "5",
                        thruWeight: "20",
                        weightUomId: "WT_lb",
                        priority: 20
                    })
                ),
                dateOverlap: code(rate(ids.rated, {geoId: "CAN", shippingAmount: "11.00", fromDate: later})),
                reader: code(
                    run(users.reader, A + "store#StoreShippingRate", {
                        productStoreId: ids.rated,
                        geoId: "MEX",
                        shippingAmount: "1"
                    })
                ),
                other: code(
                    run(users.other, A + "store#StoreShippingRate", {
                        productStoreId: ids.rated,
                        geoId: "MEX",
                        shippingAmount: "1"
                    })
                )
            }
        },
        then(r) {
            r.saved == ["", "", "", ""]
            r.weightBand == "BAND_INVALID"
            r.valueBand == "BAND_INVALID"
            r.noUnit == "VALUE_INVALID"
            r.noZone == "VALUE_INVALID"
            r.noCharge == "VALUE_INVALID"
            r.past == "VALUE_INVALID"
            code(r.overlap) == "RATE_OVERLAP"
            r.overlap.error.includes("priority 10")
            r.otherPriority == ""
            r.dateOverlap == "RATE_OVERLAP"
            r.reader == "PERMISSION_DENIED"
            r.other == "RECORD_UNAVAILABLE"
        }
    }
)

feature("a store with rates charges the matching rate and delivers nothing where no rate matches, never for free", {
    when() {
        const texas = order(ids.rated, "USA_TX", "USA", 1)
        const heavy = order(ids.rated, "USA_TX", "USA", 6)
        const ontario = order(ids.rated, "CAN_ON", "CAN", 1)
        const tokyo = order(ids.rated, null, "JPN", 1)
        const bulk = run("john.doe", C + "get#OrderShippingRatesBulk", {orderId: tokyo, orderPartSeqId: "01"})
        const bulkTexas = run("john.doe", C + "get#OrderShippingRatesBulk", {orderId: texas, orderPartSeqId: "01"})
        return {
            texas: localRate(texas),
            texasNextDay: localRate(texas, "ShMthNextDay"),
            heavy: localRate(heavy),
            ontario: localRate(ontario),
            tokyo: localRate(tokyo),
            bulk: bulk.shippingRateInfoList || [],
            bulkTexas: bulkTexas.shippingRateInfoList || []
        }
    },
    then(r) {
        r.texas.total == 5
        // the item's own repricing (the order's shipping calculation) and this call each make the part's shipping item
        r.texas.items.length >= 1
        r.texas.items.every(row => num(row.unitAmount) == 5)
        r.texasNextDay.total == 20
        // six 2 lb boxes: 12 lb, the heavier band
        r.heavy.total == 9
        r.ontario.total == 12
        r.tokyo.total == null
        r.tokyo.out.rateUnavailable == true
        r.tokyo.items.length == 0
        r.bulk.length == 0
        r.bulkTexas.length == 2
        r.bulkTexas.some(row => row.shipmentMethodEnumId == "ShMthGround" && num(row.shippingTotal) == 5)
    }
})

feature("the simulator quotes a sample cart for two zones and none for a third country", {
    when() {
        const sample = (countryGeoId, stateProvinceGeoId) =>
            run(users.reader, A + "simulate#StoreShipping", {
                productStoreId: ids.rated,
                countryGeoId,
                stateProvinceGeoId,
                amount: "40",
                weight: "3",
                weightUomId: "WT_lb"
            })
        return {
            us: sample("USA", "USA_CA"),
            canada: sample("CAN", "CAN_BC"),
            japan: sample("JPN"),
            other: code(run(users.other, A + "simulate#StoreShipping", {productStoreId: ids.rated, countryGeoId: "USA"}))
        }
    },
    then({us, canada, japan, other}) {
        us.rated == true
        us.quotes.find(row => row.shipmentMethodEnumId == "ShMthGround").amountText.includes("5.00")
        us.quotes.find(row => row.shipmentMethodEnumId == "ShMthNextDay").amountText.includes("20.00")
        canada.quotes.every(row => row.available && row.amountText.includes("12.00"))
        japan.quotes.length == 2
        japan.quotes.every(row => !row.available)
        other == "RECORD_UNAVAILABLE"
    }
})

feature("a store with no rates keeps the local gateway's zero and readiness blocks it; a rate then charges", {
    when() {
        const before = localRate(order(ids.plain, "USA_TX", "USA"))
        const blockedBefore = blocking(ids.plain, "localRates")
        const added = rate(ids.plain, {geoId: "USCN", shippingAmount: "7.00"})
        const charged = localRate(order(ids.plain, "USA_TX", "USA"))
        const readyAfter = blocking(ids.plain, "localRates")
        // ending a rate in effect needs its reason
        const ended = run(users.manager, A + "store#StoreShippingRate", {
            productStoreId: ids.plain,
            shippingRateId: added.shippingRateId,
            end: true
        })
        return {before, blockedBefore, charged, readyAfter, ended: code(ended)}
    },
    then(r) {
        r.before.total == 0
        r.before.items.length == 0
        !r.before.out.rateUnavailable
        r.blockedBefore.ready == false
        r.blockedBefore.severity == "blocking"
        r.blockedBefore.fix == "checkout"
        r.charged.total == 7
        r.readyAfter.ready == true
        r.ended == "REASON_REQUIRED"
    }
})

feature("a change of a rate in effect ends it and starts its successor; an ended store's rates leave the default", {
    when() {
        const store = localStore("Rates changed")
        const first = rate(store, {geoId: "USCN", shippingAmount: "4.00"})
        const changed = rate(store, {
            shippingRateId: first.shippingRateId,
            shippingAmount: "4.50",
            changeReason: "Carrier price rise"
        })
        const unreasoned = code(rate(store, {shippingRateId: changed.shippingRateId, shippingAmount: "4.75"}))
        const charged = localRate(order(store, "USA_TX", "USA"))
        const ended = rate(store, {shippingRateId: changed.shippingRateId, end: true, changeReason: "Closing local delivery"})
        const after = localRate(order(store, "USA_TX", "USA"))
        return {
            first,
            changed,
            unreasoned,
            charged,
            ended: code(ended),
            after,
            rows: list(S + "ProductStoreShippingRate", {productStoreId: store}),
            audit: list("moqui.entity.EntityAuditLog", {
                changedEntityName: S + "ProductStoreShippingRate",
                pkPrimaryValue: first.shippingRateId,
                changedFieldName: "thruDate"
            })
        }
    },
    then(r) {
        r.changed.previousRateId == r.first.shippingRateId
        r.unreasoned == "REASON_REQUIRED"
        r.charged.total == 4.5
        r.ended == ""
        r.after.total == 0
        r.rows.length == 2
        r.rows.every(row => row.thruDate != null)
        r.rows.find(row => row.shippingRateId == r.changed.shippingRateId).changeReason == "Closing local delivery"
        r.audit.length >= 1
    }
})
