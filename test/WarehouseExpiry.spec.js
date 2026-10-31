// The expiry gate (WH-EXPIRY, impl-warehouse §4 and F12): behind the tracking policy's expiryBlock, off by default,
// reservation skips stock whose own or lot expiry has passed and names the shortfall, and issue refuses an expired asset
// with its date; moves still work, with the expiry date as a warning, and near-expiry stock is warned with its date. With
// no policy Mantle reserves and issues expired stock as before. The users are in spec-local groups.
const org = "WHX_ORG",
    facility = "WHX_FAC",
    customer = "WHX_CUST"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const n = value => (value == null ? 0 : Number(String(value)))
const sum = (list, field) => list.reduce((total, row) => total + n(row[field]), 0)
const since = "2000-01-01T00:00:00Z"
// calendar days around today in the user's zone
const today = () => ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd")
const dayAfter = days => {
    const date = new Date(Date.parse(today() + "T00:00:00Z") + days * 86400000)
    return [
        date.getUTCFullYear(),
        String(date.getUTCMonth() + 1).padStart(2, "0"),
        String(date.getUTCDate()).padStart(2, "0")
    ].join("-")
}
let keySeq = 0
const key = () => "whx-op-" + ++keySeq

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
function product(productId) {
    call("create#mantle.product.Product", {
        productId,
        productName: productId,
        productTypeEnumId: "PtAsset",
        assetTypeEnumId: "AstTpInventory",
        amountUomId: "OTH_ea"
    })
}
function lot(lotId, expirationDate) {
    call("create#mantle.product.asset.Lot", {lotId, lotNumber: lotId, expirationDate})
}
function receive(productId, quantity, lotId, receivedDate) {
    return call("mantle.product.AssetServices.receive#Asset", {
        productId,
        quantity,
        lotId,
        facilityId: facility,
        locationSeqId: "BIN1",
        ownerPartyId: org,
        assetTypeEnumId: "AstTpInventory",
        statusId: "AstAvailable",
        receivedDate
    }).assetId
}
function order(productId, quantity) {
    const created = call("mantle.order.OrderServices.create#Order", {
        vendorPartyId: org,
        customerPartyId: customer,
        facilityId: facility
    })
    const item = call("mantle.order.OrderServices.add#OrderProductQuantity", {
        orderId: created.orderId,
        orderPartSeqId: created.orderPartSeqId,
        productId,
        quantity,
        unitAmount: 5
    })
    orderItems[created.orderId] = item.orderItemSeqId
    return created.orderId
}
const orderItems = {}
const place = orderId => invoke("mantle.order.OrderServices.place#Order", {orderId})
const reservations = orderId => rows("mantle.product.issuance.AssetReservation", {orderId})
function gate(productId, expiryBlock, nearExpiryDays) {
    call("create#mantle.facility.WarehousePolicy", {
        organizationPartyId: org,
        policyType: "tracking",
        facilityId: "_NA_",
        productId,
        fromDate: since,
        expiryBlock,
        nearExpiryDays,
        changeReason: "Expiry gate spec"
    })
}
function shipment() {
    return call("mantle.shipment.ShipmentServices.create#Shipment", {
        shipmentTypeEnumId: "ShpTpOutgoing",
        fromPartyId: org,
        toPartyId: customer,
        originFacilityId: facility
    }).shipmentId
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        call("create#moqui.security.UserGroup", {userGroupId: "WHX_MOVERS"})
        call("create#moqui.security.UserGroupPermission", {
            userGroupId: "WHX_MOVERS",
            userPermissionId: "STOCK_MOVE",
            fromDate: since
        })
        call("create#mantle.party.Party", {partyId: org, partyTypeEnumId: "PtyOrganization"})
        call("create#mantle.party.Organization", {partyId: org, organizationName: "Expiry gate"})
        call("create#mantle.party.PartyRole", {partyId: org, roleTypeId: "OrgInternal"})
        call("create#mantle.party.Party", {partyId: customer, partyTypeEnumId: "PtyPerson"})
        call("create#mantle.party.Person", {partyId: customer, firstName: "Expiry", lastName: "Customer"})
        call("create#mantle.party.PartyRole", {partyId: customer, roleTypeId: "Customer"})
        call("create#mantle.party.Party", {partyId: "WHX_MOVER", partyTypeEnumId: "PtyPerson"})
        call("create#mantle.party.Person", {partyId: "WHX_MOVER", firstName: "Expiry", lastName: "Mover"})
        call("create#moqui.security.UserAccount", {
            userId: "WHX_MOVER",
            username: "whx.mover",
            partyId: "WHX_MOVER",
            currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
            passwordHashType: "SHA"
        })
        call("create#moqui.security.UserGroupMember", {userId: "WHX_MOVER", userGroupId: "WHX_MOVERS", fromDate: since})
        call("create#mantle.party.PartyRelationship", {
            fromPartyId: "WHX_MOVER",
            toPartyId: org,
            relationshipTypeEnumId: "PrtAgent",
            toRoleTypeId: "OrgInternal",
            fromDate: since
        })
        call("create#mantle.facility.Facility", {facilityId: facility, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: org})
        for (const locationSeqId of ["BIN1", "BIN2"])
            call("create#mantle.facility.FacilityLocation", {facilityId: facility, locationSeqId, locationTypeEnumId: "FltBulk"})
        for (const productId of ["WHX_PLAIN", "WHX_GATED", "WHX_GATED_ONLY", "WHX_NEAR"]) product(productId)
        gate("WHX_GATED", "Y", null)
        gate("WHX_GATED_ONLY", "Y", null)
        gate("WHX_NEAR", "N", 30)
        lot("WHX_LOT_OLD", dayAfter(-10))
        lot("WHX_LOT_NEW", dayAfter(400))
        lot("WHX_LOT_SOON", dayAfter(5))
        ec.artifactExecution.enableAuthz()
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.message.clearErrors()
        ec.artifactExecution.enableAuthz()
    }
})

feature("with no expiry policy expired stock is reserved and issued as before", {
    when() {
        // the expired lot was received first, so first in first out reserves it
        const expired = receive("WHX_PLAIN", 5, "WHX_LOT_OLD", "2025-01-01 00:00:00")
        receive("WHX_PLAIN", 5, "WHX_LOT_NEW", "2026-01-01 00:00:00")
        const orderId = order("WHX_PLAIN", 3)
        const placed = place(orderId)
        const issued = invoke("mantle.product.AssetServices.issue#Asset", {shipmentId: shipment(), assetId: expired, quantity: 1})
        return {expired, placed, reserved: reservations(orderId), issued}
    },
    then({expired, placed, reserved, issued}) {
        placed.error == ""
        reserved.length == 1
        reserved[0].assetId == expired
        issued.error == ""
    }
})

feature("with the gate on reservation skips expired stock, and with only expired stock names the shortfall", {
    when() {
        const expired = receive("WHX_GATED", 5, "WHX_LOT_OLD", "2025-01-01 00:00:00")
        const fresh = receive("WHX_GATED", 5, "WHX_LOT_NEW", "2026-01-01 00:00:00")
        const orderId = order("WHX_GATED", 3)
        const placed = place(orderId)
        receive("WHX_GATED_ONLY", 5, "WHX_LOT_OLD", "2025-01-01 00:00:00")
        // reserved directly (no order placement), so its answer names the shortfall
        const shortId = order("WHX_GATED_ONLY", 2)
        const short = invoke("mantle.product.AssetServices.reserve#AssetForOrderItem", {
            orderId: shortId,
            orderItemSeqId: orderItems[shortId]
        })
        return {expired, fresh, placed, reserved: reservations(orderId), short, shortReserved: reservations(shortId)}
    },
    then({expired, fresh, placed, reserved, short, shortReserved}) {
        placed.error == ""
        reserved.every(r => r.assetId != expired)
        sum(
            reserved.filter(r => r.assetId == fresh),
            "quantity"
        ) == 3
        short.error == ""
        sum(shortReserved, "quantityNotAvailable") == 2
        n(short.expiredShortfall) == 2
        short.expiredSkipped.length == 1
        short.expiredSkipped[0].expiryDate == dayAfter(-10)
    }
})

feature("with the gate on issue refuses an expired asset with its date, and a fresh one issues", {
    when() {
        const expired = receive("WHX_GATED", 2, "WHX_LOT_OLD", "2025-02-01 00:00:00")
        const fresh = receive("WHX_GATED", 2, "WHX_LOT_NEW", "2026-02-01 00:00:00")
        return {
            refused: invoke("mantle.product.AssetServices.issue#Asset", {shipmentId: shipment(), assetId: expired, quantity: 1}),
            allowed: invoke("mantle.product.AssetServices.issue#Asset", {shipmentId: shipment(), assetId: fresh, quantity: 1})
        }
    },
    then({refused, allowed}) {
        refused.error.includes("ASSET_EXPIRED")
        refused.error.includes(dayAfter(-10))
        allowed.error == ""
    }
})

feature("expired stock still moves, with its date as a warning, and near-expiry stock is warned with its date", {
    when() {
        const expired = receive("WHX_GATED", 2, "WHX_LOT_OLD", "2025-03-01 00:00:00")
        const soon = receive("WHX_NEAR", 2, "WHX_LOT_SOON", "2026-03-01 00:00:00")
        login("whx.mover")
        try {
            return {
                moved: invoke("mantle.shipment.WarehouseTaskServices.move#Stock", {
                    operationKey: key(),
                    assetId: expired,
                    toLocationSeqId: "BIN2"
                }),
                near: invoke("mantle.shipment.WarehouseTaskServices.move#Stock", {
                    operationKey: key(),
                    assetId: soon,
                    toLocationSeqId: "BIN2"
                })
            }
        } finally {
            login("john.doe")
        }
    },
    then({moved, near}) {
        moved.error == ""
        moved.result.warnings[0].code == "EXPIRED"
        moved.result.warnings[0].expiryDate == dayAfter(-10)
        near.error == ""
        near.result.warnings[0].code == "NEAR_EXPIRY"
        near.result.warnings[0].expiryDate == dayAfter(5)
    }
})

feature("a narrower tracking row cannot lift a wider row's expiry block", {
    when() {
        call("create#mantle.facility.WarehousePolicy", {
            organizationPartyId: org,
            policyType: "tracking",
            facilityId: facility,
            productId: "WHX_GATED",
            fromDate: since,
            expiryBlock: "N",
            changeReason: "Narrower row"
        })
        return {
            gated: call("mantle.facility.WarehousePolicyServices.get#ExpiryGate", {
                organizationPartyId: org,
                facilityId: facility,
                productId: "WHX_GATED"
            }),
            plain: call("mantle.facility.WarehousePolicyServices.get#ExpiryGate", {
                organizationPartyId: org,
                facilityId: facility,
                productId: "WHX_PLAIN"
            })
        }
    },
    then({gated, plain}) {
        gated.expiryBlock == true
        plain.expiryBlock == false
    }
})
