// Standalone Mantle fixtures define their own roles and grant only shared Moqui permissions.
function nativeTestRoles() {
    const roles = {
        NATIVE_CATALOG_ADMIN: [
            "PRODUCT_CATALOG_ADMIN",
            "PRODUCT_COST_VIEW",
            "PRODUCT_COST_ESTIMATE",
            "PRODUCT_COST_APPROVE",
            "PRICE_VIEW",
            "PRICE_EDIT",
            "SUPPLIER_PRICE_VIEW",
            "SUPPLIER_PRICE_EDIT"
        ],
        NATIVE_CATALOG_EDITOR: [],
        NATIVE_STOCK_MANAGER: ["STOCK_POLICY_PLAN", "STOCK_POLICY_MANAGE"],
        NATIVE_STOCK_PLANNER: ["STOCK_POLICY_PLAN"]
    }
    for (const [group, permissions] of Object.entries(roles)) {
        if (!one("moqui.security.UserGroup", {userGroupId: group})) call("create#moqui.security.UserGroup", {userGroupId: group})
        for (const permission of permissions)
            if (
                !one("moqui.security.UserGroupPermission", {
                    userGroupId: group,
                    userPermissionId: permission,
                    fromDate: "2000-01-01T00:00:00Z"
                })
            )
                call("create#moqui.security.UserGroupPermission", {
                    userGroupId: group,
                    userPermissionId: permission,
                    fromDate: "2000-01-01T00:00:00Z"
                })
    }
}
const F = "mantle.facility.FacilityServices.",
    W = "mantle.facility.WarehousePolicyServices.",
    P = "mantle.product."
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
let time
spec({
    setupSpec() {
        as("john.doe", () => {
            nativeTestRoles()
            time = Date.now()
            for (const id of ["WHP_ORG", "WHP_OTHER"]) {
                call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyOrganization"})
                call("create#mantle.party.Organization", {partyId: id, organizationName: id})
                call("create#mantle.party.PartyRole", {partyId: id, roleTypeId: "OrgInternal"})
            }
            for (const [id, group] of [
                ["WHP_MANAGER", "NATIVE_STOCK_MANAGER"],
                ["WHP_PLANNER", "NATIVE_STOCK_PLANNER"],
                ["WHP_EDITOR", "NATIVE_CATALOG_EDITOR"],
                ["WHP_ADMIN", "NATIVE_CATALOG_ADMIN"]
            ]) {
                if (!one("moqui.security.UserGroup", {userGroupId: group}))
                    call("create#moqui.security.UserGroup", {userGroupId: group})
                call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
                call("create#mantle.party.Person", {partyId: id, firstName: id})
                call("create#moqui.security.UserAccount", {
                    userId: id,
                    username: id.toLowerCase(),
                    partyId: id,
                    currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
                    passwordHashType: "SHA"
                })
                call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: group, fromDate: "2000-01-01T00:00:00Z"})
                call("create#mantle.party.PartyRelationship", {
                    fromPartyId: id,
                    toPartyId: "WHP_ORG",
                    relationshipTypeEnumId: "PrtAgent",
                    toRoleTypeId: "OrgInternal",
                    fromDate: "2000-01-01T00:00:00Z"
                })
            }
            call("create#mantle.facility.Facility", {
                facilityId: "WHP_FAC",
                facilityName: "Owned warehouse",
                ownerPartyId: "WHP_ORG",
                facilityTypeEnumId: "FcTpWarehouse",
                assetAllowOtherOwner: "Y"
            })
            call("create#mantle.facility.Facility", {facilityId: "WHP_OTHER_FAC", ownerPartyId: "WHP_OTHER"})
            call("create#mantle.facility.FacilityLocation", {facilityId: "WHP_FAC", locationSeqId: "A1"})
            call("create#mantle.facility.FacilityLocation", {facilityId: "WHP_OTHER_FAC", locationSeqId: "A2"})
            call("create#" + P + "Product", {
                productId: "WHP_PRODUCT",
                productName: "Policy fixture",
                productTypeEnumId: "PtAsset",
                ownerPartyId: "WHP_ORG",
                amountUomId: "OTH_ea"
            })
        })
    },
    cleanup() {
        ec.message.clearErrors()
        ec.artifactExecution.enableAuthz()
    }
})
feature(
    "the warehouse writer validates facility and location levels, replenishment and manual ABC class and audits the changes",
    {
        when() {
            return as("whp_planner", () => {
                const stored = invoke(F + "store#ProductFacilityPolicy", {
                    productId: "WHP_PRODUCT",
                    facilityId: "WHP_FAC",
                    minimumStock: 5,
                    maximumStock: 20,
                    reorderQuantity: 10,
                    daysToShip: 2,
                    reorderMethodEnumId: "RdmUpToMaximum",
                    abcClassEnumId: "AbcB",
                    changeReason: "Planner stock levels"
                })
                const located = invoke(F + "store#ProductFacilityPolicy", {
                    productId: "WHP_PRODUCT",
                    facilityId: "WHP_FAC",
                    locationSeqId: "A1",
                    minimumStock: 2,
                    moveQuantity: 5,
                    changeReason: "Pick-bin levels"
                })
                const negative = invoke(F + "store#ProductFacilityPolicy", {
                    productId: "WHP_PRODUCT",
                    facilityId: "WHP_FAC",
                    minimumStock: -1,
                    changeReason: "Refused"
                })
                const inverted = invoke(F + "store#ProductFacilityPolicy", {
                    productId: "WHP_PRODUCT",
                    facilityId: "WHP_FAC",
                    maximumStock: 4,
                    changeReason: "Refused"
                })
                const other = invoke(F + "store#ProductFacilityPolicy", {
                    productId: "WHP_PRODUCT",
                    facilityId: "WHP_OTHER_FAC",
                    minimumStock: 1,
                    changeReason: "Refused"
                })
                const wrongLocation = invoke(F + "store#ProductFacilityPolicy", {
                    productId: "WHP_PRODUCT",
                    facilityId: "WHP_FAC",
                    locationSeqId: "A2",
                    minimumStock: 1,
                    changeReason: "Refused"
                })
                const changed = invoke(F + "store#ProductFacilityPolicy", {
                    productId: "WHP_PRODUCT",
                    facilityId: "WHP_FAC",
                    minimumStock: 6,
                    expectedLastUpdatedStamp: stored.facilityPolicy.lastUpdatedStamp,
                    changeReason: "Revised minimum"
                })
                const stale = invoke(F + "store#ProductFacilityPolicy", {
                    productId: "WHP_PRODUCT",
                    facilityId: "WHP_FAC",
                    minimumStock: 7,
                    expectedLastUpdatedStamp: stored.facilityPolicy.lastUpdatedStamp,
                    changeReason: "Stale minimum"
                })
                return {
                    stored,
                    located,
                    negative,
                    inverted,
                    other,
                    wrongLocation,
                    changed,
                    stale,
                    audits: Array.from(
                        find("moqui.entity.EntityAuditLog", {
                            changedEntityName: "mantle.facility.ProductFacility",
                            changedFieldName: "minimumStock"
                        }).list()
                    )
                }
            })
        },
        then({stored, located, negative, inverted, other, wrongLocation, changed, stale, audits}) {
            stored.error == ""
            stored.facilityPolicy.maximumStock == 20
            stored.facilityPolicy.abcClassEnumId == "AbcB"
            located.locationPolicies[0].minimumStock == 2
            negative.error.includes("negative")
            inverted.error.includes("at least")
            other.error.includes("not available")
            wrongLocation.error.includes("selected facility")
            changed.error == ""
            stale.error.includes("changed")
            audits.some(r => r.changeReason === "Revised minimum" && r.changedByUserId === "WHP_PLANNER")
        }
    }
)
feature("tracking inherits by scope and date, retains history and cannot weaken an inherited expiry prohibition", {
    when() {
        return as("whp_manager", () => {
            const global = invoke(W + "store#TrackingPolicy", {
                organizationPartyId: "WHP_ORG",
                serialRequired: "Y",
                expiryBlock: "Y",
                nearExpiryDays: 7,
                changeReason: "Organization tracking"
            })
            const product = invoke(W + "store#TrackingPolicy", {
                organizationPartyId: "WHP_ORG",
                productId: "WHP_PRODUCT",
                lotRequired: "Y",
                expiryBlock: "N",
                changeReason: "Product exception"
            })
            const futureDate = new Date(time + 600000).toISOString(),
                middleDate = new Date(time + 300000).toISOString()
            const future = invoke(W + "store#TrackingPolicy", {
                organizationPartyId: "WHP_ORG",
                facilityId: "WHP_FAC",
                productId: "WHP_PRODUCT",
                fromDate: futureDate,
                lotRequired: "N",
                changeReason: "Future exception"
            })
            const middle = invoke(W + "store#TrackingPolicy", {
                organizationPartyId: "WHP_ORG",
                facilityId: "WHP_FAC",
                productId: "WHP_PRODUCT",
                fromDate: middleDate,
                lotRequired: "Y",
                shelfLifeDays: 30,
                changeReason: "Intermediate exception"
            })
            const now = call(W + "resolve#WarehousePolicy", {
                    organizationPartyId: "WHP_ORG",
                    facilityId: "WHP_FAC",
                    productId: "WHP_PRODUCT"
                }),
                later = call(W + "resolve#WarehousePolicy", {
                    organizationPartyId: "WHP_ORG",
                    facilityId: "WHP_FAC",
                    productId: "WHP_PRODUCT",
                    asOfDate: futureDate
                })
            const duplicate = invoke(W + "store#TrackingPolicy", {
                organizationPartyId: "WHP_ORG",
                facilityId: "WHP_FAC",
                productId: "WHP_PRODUCT",
                fromDate: futureDate,
                changeReason: "Duplicate refused"
            })
            const stale = invoke(W + "store#TrackingPolicy", {
                organizationPartyId: "WHP_ORG",
                productId: "WHP_PRODUCT",
                expectedFromDate: null,
                lotRequired: "N",
                changeReason: "Stale refused"
            })
            const past = invoke(W + "store#TrackingPolicy", {
                organizationPartyId: "WHP_ORG",
                facilityId: "WHP_FAC",
                productId: "WHP_PRODUCT",
                fromDate: "2000-01-01T00:00:00Z",
                changeReason: "Retroactive refused"
            })
            return {global, product, future, middle, now, later, duplicate, stale, past, middleDate, futureDate}
        })
    },
    then({global, product, future, middle, now, later, duplicate, stale, past, middleDate, futureDate}) {
        global.error == ""
        product.error == ""
        future.error == ""
        middle.error == ""
        now.trackingPolicy.lotRequired == "Y"
        now.trackingPolicy.serialRequired == "Y"
        now.trackingPolicy.expiryBlock == "Y"
        now.sources.expiryBlock.productId == "_NA_"
        later.trackingPolicy.lotRequired == "N"
        later.history.length == 2
        Number(String(later.history[1].thruDate)) == Date.parse(futureDate)
        duplicate.error.includes("already starts")
        stale.error.includes("changed")
        past.error.includes("now or later")
    }
})
feature("catalog editing and Products administration never substitute for warehouse planning authority", {
    where: [{user: "whp_editor"}, {user: "whp_admin"}],
    when({user}) {
        return as(user, () => ({
            facility: invoke(F + "store#ProductFacilityPolicy", {
                productId: "WHP_PRODUCT",
                facilityId: "WHP_FAC",
                minimumStock: 1,
                changeReason: "Refused"
            }),
            tracking: invoke(W + "store#TrackingPolicy", {
                organizationPartyId: "WHP_ORG",
                productId: "WHP_PRODUCT",
                lotRequired: "Y",
                changeReason: "Refused"
            })
        }))
    },
    then({facility, tracking}) {
        facility.error.includes("stock-planner")
        tracking.error.includes("stock-planner")
    }
})
feature(
    "strict owner reads exclude another owners stock and demand at the same custody facility while legacy availability is preserved",
    {
        when() {
            as("john.doe", () => {
                for (const [id, owner, qty, atp] of [
                    ["WHP_OWN", "WHP_ORG", 10, 8],
                    ["WHP_FOREIGN", "WHP_OTHER", 999, 999]
                ])
                    call("create#" + P + "asset.Asset", {
                        assetId: id,
                        assetTypeEnumId: "AstTpInventory",
                        statusId: "AstAvailable",
                        productId: "WHP_PRODUCT",
                        ownerPartyId: owner,
                        facilityId: "WHP_FAC",
                        hasQuantity: "Y",
                        quantityOnHandTotal: qty,
                        availableToPromiseTotal: atp
                    })
                for (const [id, vendor, qty] of [
                    ["WHP_SALE", "WHP_ORG", 3],
                    ["WHP_FOREIGN_SALE", "WHP_OTHER", 700]
                ]) {
                    call("create#mantle.order.OrderHeader", {orderId: id, statusId: "OrderApproved", currencyUomId: "USD"})
                    call("create#mantle.order.OrderPart", {
                        orderId: id,
                        orderPartSeqId: "01",
                        vendorPartyId: vendor,
                        facilityId: "WHP_FAC",
                        statusId: "OrderApproved"
                    })
                    call("create#mantle.order.OrderItem", {
                        orderId: id,
                        orderPartSeqId: "01",
                        orderItemSeqId: "01",
                        productId: "WHP_PRODUCT",
                        quantity: qty,
                        unitAmount: 1
                    })
                }
                if (ec.search.isAvailable()) {
                    ec.search.indexDocuments(ec.entity.getDataDocuments("MantleInventoryAsset", {productId: "WHP_PRODUCT"}))
                    ec.search.indexDocuments(ec.entity.getDataDocuments("MantleInventoryOrderItem", {productId: "WHP_PRODUCT"}))
                }
            })
            return as("whp_planner", () => ({
                legacy: call(P + "AssetServices.get#AvailableInventory", {productId: "WHP_PRODUCT", facilityId: "WHP_FAC"}),
                strict: call(P + "AssetServices.get#AvailableInventory", {
                    productId: "WHP_PRODUCT",
                    facilityId: "WHP_FAC",
                    ownerPartyIdList: ["WHP_ORG"]
                }),
                projected: call(P + "InventoryReportServices.get#InventoryProjectedInfo", {
                    productIdList: ["WHP_PRODUCT"],
                    facilityId: "WHP_FAC",
                    organizationPartyId: "WHP_ORG"
                })
            }))
        },
        then({legacy, strict, projected}) {
            legacy.availableToPromiseTotal == 1007
            strict.availableToPromiseTotal == 8
            projected.infoByProductId.WHP_PRODUCT.availableToPromiseTotalSum == 8
            projected.infoByProductId.WHP_PRODUCT.orderQuantitySum == 3
            projected.infoByProductId.WHP_PRODUCT.totalProjected == 5
        }
    }
)

feature("a stock planner may change product exceptions but cannot replace all-product tracking defaults", {
    when() {
        return as("whp_planner", () =>
            invoke(W + "store#TrackingPolicy", {
                organizationPartyId: "WHP_ORG",
                expiryBlock: "N",
                changeReason: "Organization default refused"
            })
        )
    },
    then({error}) {
        error.includes("manager authority")
    }
})
