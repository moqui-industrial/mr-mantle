// The Warehouse policy families beside tracking (impl-warehouse P3): the dated operation and reservation policies, their
// resolution and trace with a store override, manager authority, the facility reservation default read by Mantle's
// reservation (and Mantle's default without one), a store's field-scoped reservation settings, the reservation check
// preview, and asset pools with dated members and their reservation preview. Users are in spec-local groups.
const W = "mantle.facility.WarehousePolicyServices.",
    AP = "mantle.product.AssetPoolServices.",
    A = "mantle.product.AssetServices."
const find = (n, p = {}) => ec.entity.find(n).condition(p).disableAuthz(),
    one = (n, p) => find(n, p).one()
function as(user, fn) {
    login(user)
    ec.artifactExecution.disableAuthz()
    try {
        return fn()
    } finally {
        ec.message.clearErrors()
        login("john.doe")
    }
}
function invoke(n, p) {
    try {
        const out = call(n, p) || {},
            error = ec.message.getErrorsString()
        ec.message.clearErrors()
        return Object.assign({}, out, {error})
    } catch (e) {
        ec.message.clearErrors()
        return {error: String(e.message || e)}
    }
}
const groups = {
    WOP_STOCK_MANAGER: ["STOCK_POLICY_PLAN", "STOCK_POLICY_MANAGE"],
    WOP_STOCK_PLANNER: ["STOCK_POLICY_PLAN"],
    WOP_STOCK_READER: []
}
const users = [
    ["WOP_MANAGER", "WOP_STOCK_MANAGER"],
    ["WOP_PLANNER", "WOP_STOCK_PLANNER"],
    ["WOP_READER", "WOP_STOCK_READER"]
]
const since = "2000-01-01T00:00:00Z"
spec({
    setupSpec() {
        as("john.doe", () => {
            for (const [group, permissions] of Object.entries(groups)) {
                call("create#moqui.security.UserGroup", {userGroupId: group})
                for (const userPermissionId of permissions)
                    call("create#moqui.security.UserGroupPermission", {userGroupId: group, userPermissionId, fromDate: since})
            }
            for (const id of ["WOP_ORG", "WOP_OTHER"]) {
                call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyOrganization"})
                call("create#mantle.party.Organization", {partyId: id, organizationName: id})
                call("create#mantle.party.PartyRole", {partyId: id, roleTypeId: "OrgInternal"})
            }
            call("create#mantle.party.Party", {partyId: "WOP_CUSTOMER", partyTypeEnumId: "PtyOrganization"})
            call("create#mantle.party.Organization", {partyId: "WOP_CUSTOMER", organizationName: "Pool customer"})
            for (const [id, group] of users) {
                call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
                call("create#mantle.party.Person", {partyId: id, firstName: id})
                call("create#moqui.security.UserAccount", {
                    userId: id,
                    username: id.toLowerCase(),
                    partyId: id,
                    currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
                    passwordHashType: "SHA"
                })
                call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: group, fromDate: since})
                call("create#mantle.party.PartyRelationship", {
                    fromPartyId: id,
                    toPartyId: "WOP_ORG",
                    relationshipTypeEnumId: "PrtAgent",
                    toRoleTypeId: "OrgInternal",
                    fromDate: since
                })
            }
            for (const [facilityId, ownerPartyId] of [
                ["WOP_FAC", "WOP_ORG"],
                ["WOP_FAC_PLAIN", "WOP_ORG"],
                ["WOP_OTHER_FAC", "WOP_OTHER"]
            ])
                call("create#mantle.facility.Facility", {facilityId, ownerPartyId, facilityTypeEnumId: "FcTpWarehouse"})
            for (const [locationSeqId, locationTypeEnumId] of [
                ["R1", "FltReceiving"],
                ["R2", "FltReceiving"],
                ["Q1", "FltQuarantine"],
                ["P1", "FltPick"]
            ])
                call("create#mantle.facility.FacilityLocation", {facilityId: "WOP_FAC", locationSeqId, locationTypeEnumId})
            call("create#mantle.product.Product", {
                productId: "WOP_PRODUCT",
                productName: "Operation policy fixture",
                productTypeEnumId: "PtAsset",
                ownerPartyId: "WOP_ORG",
                amountUomId: "OTH_ea"
            })
            for (const [productStoreId, organizationPartyId, reservationOrderEnumId, reservationAutoEnumId] of [
                ["WOP_STORE", "WOP_ORG", "AsResOrdFifoRec", null],
                ["WOP_STORE_UNSET", "WOP_ORG", null, null],
                ["WOP_STORE_NONE", "WOP_ORG", null, "AsResAutoNone"],
                ["WOP_OTHER_STORE", "WOP_OTHER", null, null]
            ])
                call("create#mantle.product.store.ProductStore", {
                    productStoreId,
                    storeName: productStoreId,
                    organizationPartyId,
                    inventoryFacilityId:
                        productStoreId === "WOP_STORE_NONE"
                            ? "WOP_FAC_PLAIN"
                            : organizationPartyId === "WOP_ORG"
                              ? "WOP_FAC"
                              : "WOP_OTHER_FAC",
                    reservationOrderEnumId,
                    reservationAutoEnumId
                })
            // older and newer stock in the policy facility and in a facility without a policy
            for (const [assetId, facilityId, receivedDate, statusId] of [
                ["WOP_OLD", "WOP_FAC", "2020-01-01T00:00:00Z", "AstAvailable"],
                ["WOP_NEW", "WOP_FAC", "2024-01-01T00:00:00Z", "AstAvailable"],
                ["WOP_HELD", "WOP_FAC", "2024-02-01T00:00:00Z", "AstOnHold"],
                ["WOP_PLAIN_OLD", "WOP_FAC_PLAIN", "2020-01-01T00:00:00Z", "AstAvailable"],
                ["WOP_PLAIN_NEW", "WOP_FAC_PLAIN", "2024-01-01T00:00:00Z", "AstAvailable"]
            ])
                call("create#mantle.product.asset.Asset", {
                    assetId,
                    assetTypeEnumId: "AstTpInventory",
                    statusId,
                    productId: "WOP_PRODUCT",
                    ownerPartyId: "WOP_ORG",
                    facilityId,
                    hasQuantity: "Y",
                    quantityOnHandTotal: 5,
                    availableToPromiseTotal: 5,
                    receivedDate
                })
            // storeless sales orders of the organization, one at each facility, and one for the pool customer
            for (const [orderId, facilityId, customerPartyId, productStoreId] of [
                ["WOP_SO_POLICY", "WOP_FAC", null],
                ["WOP_SO_PLAIN", "WOP_FAC_PLAIN", null],
                ["WOP_SO_POOL", "WOP_FAC", "WOP_CUSTOMER"],
                ["WOP_SO_HELD", "WOP_FAC", null],
                // for the automatic timing: storeless at each facility, and of a store that reserves nothing by itself
                ["WOP_SO_AUTO", "WOP_FAC", null],
                ["WOP_SO_AUTO_PLAIN", "WOP_FAC_PLAIN", null],
                ["WOP_SO_CHECK_PLAIN", "WOP_FAC_PLAIN", null],
                ["WOP_SO_STORE_NONE", "WOP_FAC_PLAIN", null, "WOP_STORE_NONE"]
            ]) {
                // open orders, so nothing reserves them before the policy is set
                call("create#mantle.order.OrderHeader", {orderId, statusId: "OrderOpen", currencyUomId: "USD", productStoreId})
                call("create#mantle.order.OrderPart", {
                    orderId,
                    orderPartSeqId: "01",
                    vendorPartyId: "WOP_ORG",
                    customerPartyId,
                    facilityId,
                    statusId: "OrderOpen"
                })
                call("create#mantle.order.OrderItem", {
                    orderId,
                    orderPartSeqId: "01",
                    orderItemSeqId: "01",
                    productId: "WOP_PRODUCT",
                    itemTypeEnumId: "ItemProduct",
                    quantity: 2,
                    unitAmount: 1
                })
            }
            // a reservation left on stock that went on hold
            call("create#mantle.product.issuance.AssetReservation", {
                assetReservationId: "WOP_RES_HELD",
                assetId: "WOP_HELD",
                productId: "WOP_PRODUCT",
                orderId: "WOP_SO_HELD",
                orderItemSeqId: "01",
                quantity: 1,
                quantityNotIssued: 1,
                quantityNotAvailable: 0,
                reservedDate: since
            })
        })
    },
    cleanupSpec() {
        as("john.doe", () => {
            for (const id of ["WOP_STORE", "WOP_STORE_UNSET", "WOP_STORE_NONE"]) {
                const store = one("mantle.product.store.ProductStore", {productStoreId: id})
                if (!store) continue
                store.set("reservationOrderEnumId", null)
                store.update()
            }
            find("mantle.facility.WarehousePolicy", {organizationPartyId: "WOP_ORG"}).deleteAll()
            for (const userId of users.map(row => row[0])) find("moqui.security.UserGroupMember", {userId}).deleteAll()
        })
    },
    cleanup() {
        ec.message.clearErrors()
        ec.artifactExecution.enableAuthz()
    }
})

feature("with no policy row the operation and reservation policy are Mantle's defaults, and locations come from their types", {
    when() {
        return as("wop_reader", () => call(W + "resolve#WarehousePolicy", {facilityId: "WOP_FAC"}))
    },
    then({operationPolicy, reservationPolicy, trace, canManage}) {
        operationPolicy.receiptSteps == 1
        operationPolicy.deliverySteps == 1
        Number(String(operationPolicy.overReceiptPercent)) == 0
        Number(String(operationPolicy.overShipmentPercent)) == 0
        operationPolicy.backorderEnumId == "WhBoBackorder"
        operationPolicy.blindCount == "N"
        operationPolicy.receivingLocationSeqId == "R1"
        operationPolicy.quarantineLocationSeqId == "Q1"
        operationPolicy.stagingLocationSeqId == null
        reservationPolicy.reservationOrderEnumId == "AsResOrdFifoRec"
        trace.find(row => row.field === "receiptSteps").level == "default"
        trace.find(row => row.field === "receivingLocationSeqId").level == "location type"
        canManage == false
    }
})

let facilityFromDate
feature("a manager sets organization and facility operation policy; each value names its source and a change keeps history", {
    when() {
        return as("wop_manager", () => {
            const organization = invoke(W + "store#OperationPolicy", {
                organizationPartyId: "WOP_ORG",
                deliverySteps: 3,
                overReceiptPercent: 5,
                changeReason: "Organization operations"
            })
            const facility = invoke(W + "store#OperationPolicy", {
                facilityId: "WOP_FAC",
                receiptSteps: 2,
                receivingLocationSeqId: "R2",
                blindCount: "Y",
                changeReason: "Two-step receipt"
            })
            facilityFromDate = facility.configuredPolicy.fromDate
            const changed = invoke(W + "store#OperationPolicy", {
                facilityId: "WOP_FAC",
                expectedFromDate: facilityFromDate,
                receiptSteps: 2,
                receivingLocationSeqId: "R2",
                blindCount: "Y",
                autoPrint: "Y",
                changeReason: "Auto-print"
            })
            const stale = invoke(W + "store#OperationPolicy", {
                facilityId: "WOP_FAC",
                expectedFromDate: facilityFromDate,
                autoPrint: "N",
                changeReason: "Stale"
            })
            const resolved = call(W + "resolve#WarehousePolicy", {facilityId: "WOP_FAC", policyType: "operation"})
            const audits = Array.from(
                find("moqui.entity.EntityAuditLog", {
                    changedEntityName: "mantle.facility.WarehousePolicy",
                    changedFieldName: "receiptSteps"
                }).list()
            )
            return {organization, facility, changed, stale, resolved, audits}
        })
    },
    then({organization, facility, changed, stale, resolved, audits}) {
        organization.error == ""
        facility.error == ""
        changed.error == ""
        stale.error.includes("changed")
        resolved.operationPolicy.receiptSteps == 2
        resolved.operationPolicy.deliverySteps == 3
        Number(String(resolved.operationPolicy.overReceiptPercent)) == 5
        Number(String(resolved.operationPolicy.overShipmentPercent)) == 0
        resolved.operationPolicy.receivingLocationSeqId == "R2"
        resolved.operationPolicy.autoPrint == "Y"
        resolved.trace.find(row => row.field === "receiptSteps").level == "facility"
        resolved.trace.find(row => row.field === "deliverySteps").level == "organization"
        resolved.trace.find(row => row.field === "overShipmentPercent").level == "default"
        resolved.history.length == 2
        Number(String(resolved.history[1].thruDate)) == Number(String(resolved.history[0].fromDate))
        resolved.warnings.length == 0
        audits.some(row => row.changeReason === "Two-step receipt" && row.changedByUserId === "WOP_MANAGER")
    }
})

feature("operation policy refuses #case", {
    where: [
        {
            case: "a planner",
            user: "wop_planner",
            values: {facilityId: "WOP_FAC_PLAIN", receiptSteps: 2},
            error: "POLICY_MANAGE_REQUIRED"
        },
        {case: "a reader", user: "wop_reader", values: {facilityId: "WOP_FAC_PLAIN", receiptSteps: 2}, error: "authority"},
        {case: "another organization", user: "wop_manager", values: {facilityId: "WOP_OTHER_FAC", receiptSteps: 2}, error: "not"},
        {case: "four steps", user: "wop_manager", values: {facilityId: "WOP_FAC_PLAIN", receiptSteps: 4}, error: "1, 2 or 3"},
        {
            case: "a negative tolerance",
            user: "wop_manager",
            values: {facilityId: "WOP_FAC_PLAIN", overShipmentPercent: -1},
            error: "0 to 100"
        },
        {
            case: "a location of the wrong type",
            user: "wop_manager",
            values: {facilityId: "WOP_FAC", expectedFromDate: "latest", receivingLocationSeqId: "Q1"},
            error: "not a FltReceiving"
        },
        {
            case: "a location of another facility",
            user: "wop_manager",
            values: {facilityId: "WOP_FAC_PLAIN", receivingLocationSeqId: "R1"},
            error: "not in the selected facility"
        },
        {
            case: "a location for the organization",
            user: "wop_manager",
            values: {organizationPartyId: "WOP_ORG", expectedFromDate: "latest", stagingLocationSeqId: "R1"},
            error: "set for a facility"
        },
        {
            case: "an unknown backorder choice",
            user: "wop_manager",
            values: {facilityId: "WOP_FAC_PLAIN", backorderEnumId: "AsResOrdFifoRec"},
            error: "backorderEnumId"
        }
    ],
    when({user, values}) {
        return as(user, () => {
            const p = Object.assign({changeReason: "Refused"}, values)
            if (p.expectedFromDate === "latest")
                p.expectedFromDate = call(W + "resolve#WarehousePolicy", {
                    organizationPartyId: "WOP_ORG",
                    facilityId: p.facilityId,
                    policyType: "operation"
                }).configuredPolicy.fromDate
            return {result: invoke(W + "store#OperationPolicy", p)}
        })
    },
    then({result, error}) {
        result.error.includes(error)
    }
})

feature("a facility reservation default without a store, overridden by a store's own setting for its orders only", {
    when() {
        return as("wop_manager", () => {
            const stored = invoke(W + "store#ReservationPolicy", {
                facilityId: "WOP_FAC",
                reservationOrderEnumId: "AsResOrdLifoRec",
                changeReason: "Newest stock first"
            })
            const plannerRefused = as("wop_planner", () =>
                invoke(W + "store#ReservationPolicy", {
                    facilityId: "WOP_FAC_PLAIN",
                    reservationOrderEnumId: "AsResOrdLifoRec",
                    changeReason: "Refused"
                })
            )
            login("wop_manager")
            ec.artifactExecution.disableAuthz()
            const facility = call(W + "resolve#WarehousePolicy", {facilityId: "WOP_FAC"}),
                store = call(W + "resolve#WarehousePolicy", {productStoreId: "WOP_STORE"}),
                unsetStore = call(W + "resolve#WarehousePolicy", {productStoreId: "WOP_STORE_UNSET"}),
                otherStore = invoke(W + "resolve#WarehousePolicy", {productStoreId: "WOP_OTHER_STORE"})
            return {stored, plannerRefused, facility, store, unsetStore, otherStore}
        })
    },
    then({stored, plannerRefused, facility, store, unsetStore, otherStore}) {
        stored.error == ""
        plannerRefused.error.includes("POLICY_MANAGE_REQUIRED")
        facility.reservationPolicy.reservationOrderEnumId == "AsResOrdLifoRec"
        facility.trace.find(row => row.field === "reservationOrderEnumId").level == "facility"
        store.facilityId == "WOP_FAC"
        store.reservationPolicy.reservationOrderEnumId == "AsResOrdFifoRec"
        store.trace.find(row => row.field === "reservationOrderEnumId").level == "store"
        unsetStore.reservationPolicy.reservationOrderEnumId == "AsResOrdLifoRec"
        unsetStore.trace.find(row => row.field === "reservationOrderEnumId").level == "facility"
        otherStore.error.includes("not available")
    }
})

feature("Mantle's reservation of a storeless order reads the facility default, and keeps FIFO where there is none", {
    when() {
        return as("john.doe", () => {
            for (const orderId of ["WOP_SO_POLICY", "WOP_SO_PLAIN"])
                call(A + "reserve#AssetForOrderItem", {orderId, orderItemSeqId: "01"})
            const reserved = orderId =>
                Array.from(find("mantle.product.issuance.AssetReservation", {orderId}).list()).map(row => row.assetId)
            return {policy: reserved("WOP_SO_POLICY"), plain: reserved("WOP_SO_PLAIN")}
        })
    },
    then({policy, plain}) {
        policy == ["WOP_NEW"]
        plain == ["WOP_PLAIN_OLD"]
    }
})

// placed without a status service, so no SECA reserves first
function place(orderId) {
    for (const entity of ["mantle.order.OrderHeader", "mantle.order.OrderPart"])
        for (const row of Array.from(find(entity, {orderId}).list())) {
            row.set("statusId", "OrderPlaced")
            row.update()
        }
}
const reservedOn = orderId => Array.from(find("mantle.product.issuance.AssetReservation", {orderId}).list()).length
feature(
    "the facility default's automatic timing holds a placed storeless order until approval, and Mantle's stays at placement",
    {
        when() {
            const stored = as("wop_manager", () => {
                const current = call(W + "resolve#WarehousePolicy", {facilityId: "WOP_FAC", policyType: "reservation"})
                return invoke(W + "store#ReservationPolicy", {
                    facilityId: "WOP_FAC",
                    expectedFromDate: current.configuredPolicy.fromDate,
                    reservationAutoEnumId: "AsResAutoApproved",
                    changeReason: "Reserve on approval"
                })
            })
            return as("john.doe", () => {
                for (const orderId of ["WOP_SO_AUTO", "WOP_SO_AUTO_PLAIN"]) {
                    place(orderId)
                    call(A + "reserve#AssetsForOrder", {orderId})
                }
                call(A + "checkReserve#AssetForOrderItem", {orderId: "WOP_SO_AUTO", orderItemSeqId: "01"})
                return {
                    stored,
                    held: reservedOn("WOP_SO_AUTO"),
                    plain: reservedOn("WOP_SO_AUTO_PLAIN"),
                    order: call(W + "get#ReservationDefault", {organizationPartyId: "WOP_ORG", facilityId: "WOP_FAC"})
                }
            })
        },
        then({stored, held, plain, order}) {
            stored.error == ""
            order.reservationOrderEnumId == "AsResOrdLifoRec"
            order.reservationAutoEnumId == "AsResAutoApproved"
            held == 0
            plain > 0
        }
    }
)
feature("checkReserve honors a store's own No Auto Reserve (F96), and reserves a storeless order as before", {
    when() {
        return as("john.doe", () => {
            for (const orderId of ["WOP_SO_STORE_NONE", "WOP_SO_CHECK_PLAIN"]) {
                place(orderId)
                call(A + "checkReserve#AssetForOrderItem", {orderId, orderItemSeqId: "01"})
            }
            return {store: reservedOn("WOP_SO_STORE_NONE"), plain: reservedOn("WOP_SO_CHECK_PLAIN")}
        })
    },
    then({store, plain}) {
        store == 0
        plain > 0
    }
})

feature("a store's reservation settings change through the field-scoped service, for a manager of its organization", {
    when() {
        return as("wop_manager", () => ({
            changed: invoke(W + "update#StoreReservation", {
                productStoreId: "WOP_STORE_UNSET",
                reservationOrderEnumId: "AsResOrdFifoExp",
                changeReason: "Expiring first"
            }),
            other: invoke(W + "update#StoreReservation", {
                productStoreId: "WOP_OTHER_STORE",
                reservationOrderEnumId: "AsResOrdFifoExp",
                changeReason: "Refused"
            }),
            foreignFacility: invoke(W + "update#StoreReservation", {
                productStoreId: "WOP_STORE_UNSET",
                inventoryFacilityId: "WOP_OTHER_FAC",
                changeReason: "Refused"
            }),
            planner: as("wop_planner", () =>
                invoke(W + "update#StoreReservation", {
                    productStoreId: "WOP_STORE_UNSET",
                    reservationOrderEnumId: "AsResOrdFifoExp",
                    changeReason: "Refused"
                })
            ),
            audits: Array.from(
                find("moqui.entity.EntityAuditLog", {
                    changedEntityName: "mantle.product.store.ProductStore",
                    changedFieldName: "reservationOrderEnumId",
                    pkPrimaryValue: "WOP_STORE_UNSET"
                }).list()
            )
        }))
    },
    then({changed, other, foreignFacility, planner, audits}) {
        changed.error == ""
        changed.reservationPolicy.reservationOrderEnumId == "AsResOrdFifoExp"
        other.error.includes("not")
        foreignFacility.error.includes("organization")
        planner.error.includes("POLICY_MANAGE_REQUIRED")
        audits.some(row => row.changeReason === "Expiring first")
    }
})

feature("the reservation check preview names a reservation on held stock without changing it", {
    when() {
        return as("wop_reader", () => ({
            preview: call(W + "preview#FacilityReservations", {facilityId: "WOP_FAC"}),
            other: invoke(W + "preview#FacilityReservations", {facilityId: "WOP_OTHER_FAC"}),
            kept: one("mantle.product.issuance.AssetReservation", {assetReservationId: "WOP_RES_HELD"})
        }))
    },
    then({preview, other, kept}) {
        preview.findings.some(row => row.assetReservationId === "WOP_RES_HELD" && row.reasonCode === "ASSET_NOT_AVAILABLE")
        !preview.findings.some(row => row.orderId === "WOP_SO_POLICY")
        other.error.includes("not")
        kept != null
    }
})

let poolId
feature("a manager keeps a pool with dated members; the preview names reservations a member's end leaves unqualified", {
    when() {
        return as("wop_manager", () => {
            const created = invoke(AP + "store#AssetPool", {
                pseudoId: "WOP-POOL",
                description: "Key account stock",
                ownerPartyId: "WOP_ORG",
                changeReason: "New pool"
            })
            poolId = created.pool.assetPoolId
            const duplicate = invoke(AP + "store#AssetPool", {
                pseudoId: "WOP-POOL",
                ownerPartyId: "WOP_ORG",
                changeReason: "Again"
            })
            const party = invoke(AP + "store#AssetPoolParty", {
                assetPoolId: poolId,
                partyId: "WOP_CUSTOMER",
                roleTypeId: "Customer",
                changeReason: "Key account"
            })
            const store = invoke(AP + "store#AssetPoolStore", {
                assetPoolId: poolId,
                productStoreId: "WOP_STORE",
                changeReason: "Store share"
            })
            const otherStore = invoke(AP + "store#AssetPoolStore", {
                assetPoolId: poolId,
                productStoreId: "WOP_OTHER_STORE",
                changeReason: "Refused"
            })
            const badRole = invoke(AP + "store#AssetPoolParty", {
                assetPoolId: poolId,
                partyId: "WOP_CUSTOMER",
                roleTypeId: "Employee",
                changeReason: "Refused"
            })
            const past = invoke(AP + "store#AssetPoolParty", {
                assetPoolId: poolId,
                partyId: "WOP_CUSTOMER",
                roleTypeId: "Customer",
                thruDate: since,
                changeReason: "Refused"
            })
            const planner = as("wop_planner", () =>
                invoke(AP + "store#AssetPoolParty", {assetPoolId: poolId, partyId: "WOP_CUSTOMER", changeReason: "Refused"})
            )
            login("wop_manager")
            ec.artifactExecution.disableAuthz()
            // the pool customer's order reserved on pool stock
            const pooled = find("mantle.product.asset.Asset", {assetId: "WOP_OLD"}).one()
            pooled.set("assetPoolId", poolId)
            pooled.update()
            call("create#mantle.product.issuance.AssetReservation", {
                assetReservationId: "WOP_RES_POOL",
                assetId: "WOP_OLD",
                productId: "WOP_PRODUCT",
                orderId: "WOP_SO_POOL",
                orderItemSeqId: "01",
                quantity: 1,
                quantityNotIssued: 1,
                quantityNotAvailable: 0,
                reservedDate: since
            })
            const before = call(AP + "preview#AssetPoolReservations", {assetPoolId: poolId})
            const ending = Date.now() + 3600000
            const ended = invoke(AP + "store#AssetPoolParty", {
                assetPoolId: poolId,
                partyId: "WOP_CUSTOMER",
                roleTypeId: "Customer",
                thruDate: new Date(ending).toISOString(),
                changeReason: "Account closes"
            })
            ec.user.setEffectiveTime(ending + 60000)
            let after
            try {
                after = call(AP + "preview#AssetPoolReservations", {assetPoolId: poolId})
            } finally {
                ec.user.setEffectiveTime(null)
            }
            const list = call(AP + "find#AssetPools", {term: "wop-pool"})
            const otherReader = as("wop_reader", () => invoke(AP + "get#AssetPool", {assetPoolId: poolId}))
            return {created, duplicate, party, store, otherStore, badRole, past, planner, before, ended, after, list, otherReader}
        })
    },
    then({created, duplicate, party, store, otherStore, badRole, past, planner, before, ended, after, list, otherReader}) {
        created.error == ""
        duplicate.error.includes("already exists")
        party.error == ""
        party.parties[0].current == true
        store.error == ""
        otherStore.error.includes("not available")
        badRole.error.includes("vendor, a customer")
        past.error.includes("now or later")
        planner.error.includes("POLICY_MANAGE_REQUIRED")
        before.reservations.find(row => row.assetReservationId === "WOP_RES_POOL").qualifies == true
        ended.error == ""
        after.reservations.find(row => row.assetReservationId === "WOP_RES_POOL").qualifies == false
        after.unqualifiedCount == 1
        list.poolList.length == 1
        list.poolList[0].partyCount == 1
        list.poolList[0].storeCount == 1
        otherReader.error == ""
    }
})

feature("a change starting after a scheduled row carries that row's values, not today's", {
    when() {
        return as("wop_manager", () => {
            const base = Date.now()
            const now = invoke(W + "store#OperationPolicy", {
                facilityId: "WOP_FAC_PLAIN",
                autoPrint: "Y",
                changeReason: "Today"
            })
            const expectedFromDate = now.configuredPolicy.fromDate
            const scheduled = invoke(W + "store#OperationPolicy", {
                facilityId: "WOP_FAC_PLAIN",
                expectedFromDate,
                fromDate: new Date(base + 600000).toISOString(),
                blindCount: "Y",
                changeReason: "Blind counts from next week"
            })
            const later = invoke(W + "store#OperationPolicy", {
                facilityId: "WOP_FAC_PLAIN",
                expectedFromDate,
                fromDate: new Date(base + 900000).toISOString(),
                deliverySteps: 2,
                changeReason: "Staging after that"
            })
            const resolved = call(W + "resolve#WarehousePolicy", {
                facilityId: "WOP_FAC_PLAIN",
                policyType: "operation",
                asOfDate: new Date(base + 1200000).toISOString()
            })
            return {now, scheduled, later, resolved}
        })
    },
    then({now, scheduled, later, resolved}) {
        now.error == ""
        scheduled.error == ""
        later.error == ""
        resolved.configuredPolicy.blindCount == "Y"
        resolved.configuredPolicy.autoPrint == "Y"
        resolved.configuredPolicy.deliverySteps == 2
    }
})

feature("a pool member keeps a scheduled end when re-saved without one, and a store must be the pool's organization's", {
    when() {
        return as("wop_manager", () => {
            const end = new Date(Date.now() + 86400000).toISOString()
            const scheduled = invoke(AP + "store#AssetPoolParty", {
                assetPoolId: poolId,
                partyId: "WOP_MANAGER",
                roleTypeId: "Customer",
                thruDate: end,
                changeReason: "Until tomorrow"
            })
            const resaved = invoke(AP + "store#AssetPoolParty", {
                assetPoolId: poolId,
                partyId: "WOP_MANAGER",
                roleTypeId: "Vendor",
                changeReason: "Role only"
            })
            const opened = invoke(AP + "store#AssetPoolParty", {
                assetPoolId: poolId,
                partyId: "WOP_MANAGER",
                clearThruDate: true,
                changeReason: "Open again"
            })
            // a store of the user's other organization is refused for a pool of this one
            login("john.doe")
            ec.artifactExecution.disableAuthz()
            const otherPool = call(AP + "store#AssetPool", {
                pseudoId: "WOP-OTHER-POOL",
                ownerPartyId: "WOP_OTHER",
                changeReason: "Other"
            })
            const mixed = invoke(AP + "store#AssetPoolStore", {
                assetPoolId: otherPool.pool.assetPoolId,
                productStoreId: "WOP_STORE",
                changeReason: "Refused"
            })
            const member = rows => rows.find(row => row.partyId === "WOP_MANAGER")
            return {
                scheduledEnd: member(scheduled.parties).thruDate,
                resavedEnd: member(resaved.parties).thruDate,
                resavedRole: member(resaved.parties).roleTypeId,
                openedEnd: member(opened.parties).thruDate,
                mixed
            }
        })
    },
    then({scheduledEnd, resavedEnd, resavedRole, openedEnd, mixed}) {
        scheduledEnd != null
        Number(String(resavedEnd)) == Number(String(scheduledEnd))
        resavedRole == "Vendor"
        openedEnd == null
        mixed.error.includes("another organization")
    }
})
