// Facility and location setup (mantle.facility.FacilityServices, FacilitySetup.js; impl-warehouse P2): the facility and
// location saves check FACILITY_EDIT and the organization, facility parents never form a cycle, each location type's asset
// status is audit-logged, a location closes by its audit-logged thruDate only when nothing is stored or open there (each
// blocker named), and check#FacilityLocationOpen refuses a closed location. The users are in spec-local groups.
const F = "mantle.facility.FacilityServices."
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const since = "2000-01-01T00:00:00Z"

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
        if (!one("moqui.security.UserGroupPermission", {userGroupId, userPermissionId, fromDate: since}))
            call("create#moqui.security.UserGroupPermission", {userGroupId, userPermissionId, fromDate: since})
}
function closeAt(locationSeqId) {
    return as("whf_editor", () =>
        invoke(F + "close#FacilityLocation", {facilityId: "WHF_FAC", locationSeqId, changeReason: "Bin retired"})
    )
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        ensureGroup("WHF_FACILITY_EDITOR", ["FACILITY_EDIT", "STOCK_POLICY_PLAN"])
        ensureGroup("WHF_FACILITY_READER", [])
        for (const partyId of ["WHF_ORG", "WHF_OTHER"]) {
            call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
            call("create#mantle.party.Organization", {partyId, organizationName: partyId})
            call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
        }
        for (const [partyId, userGroupId] of [
            ["WHF_EDITOR", "WHF_FACILITY_EDITOR"],
            ["WHF_READER", "WHF_FACILITY_READER"]
        ]) {
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
                toPartyId: "WHF_ORG",
                relationshipTypeEnumId: "PrtAgent",
                toRoleTypeId: "OrgInternal",
                fromDate: since
            })
        }
        call("create#mantle.facility.Facility", {
            facilityId: "WHF_FAC",
            facilityName: "Fixture warehouse",
            ownerPartyId: "WHF_ORG",
            facilityTypeEnumId: "FcTpWarehouse"
        })
        call("create#mantle.facility.Facility", {facilityId: "WHF_OTHER_FAC", facilityName: "Other", ownerPartyId: "WHF_OTHER"})
        call("create#mantle.facility.FacilityLocation", {facilityId: "WHF_OTHER_FAC", locationSeqId: "X1"})
        // one location per blocker, and one that is empty but for a depleted asset
        for (const locationSeqId of ["STOCK", "DEPLETED", "EQUIP", "LEFT", "TOTE", "PICK", "COUNT", "POLICY"])
            call("create#mantle.facility.FacilityLocation", {facilityId: "WHF_FAC", locationSeqId, locationTypeEnumId: "FltBulk"})
        call("create#mantle.product.Product", {
            productId: "WHF_PRODUCT",
            productName: "Facility fixture",
            productTypeEnumId: "PtAsset",
            ownerPartyId: "WHF_ORG",
            amountUomId: "OTH_ea"
        })
        const asset = (assetId, locationSeqId, extra) =>
            call(
                "create#mantle.product.asset.Asset",
                Object.assign(
                    {
                        assetId,
                        assetTypeEnumId: "AstTpInventory",
                        statusId: "AstAvailable",
                        productId: "WHF_PRODUCT",
                        facilityId: "WHF_FAC",
                        locationSeqId,
                        ownerPartyId: "WHF_ORG",
                        hasQuantity: "Y",
                        quantityOnHandTotal: 0,
                        availableToPromiseTotal: 0
                    },
                    extra
                )
            )
        asset("WHF_STOCK", "STOCK", {quantityOnHandTotal: 5, availableToPromiseTotal: 5})
        asset("WHF_DEPLETED", "DEPLETED", {})
        asset("WHF_FORKLIFT", "EQUIP", {assetTypeEnumId: "AstTpEquipment", hasQuantity: "N", statusId: "AstInUse"})
        asset("WHF_RETIRED", "LEFT", {
            assetTypeEnumId: "AstTpEquipment",
            hasQuantity: "N",
            actualEndOfLife: "2026-01-31 00:00:00"
        })
        asset("WHF_PICKED", "PICK", {})
        call("create#mantle.product.asset.Container", {containerId: "WHF_TOTE", facilityId: "WHF_FAC", locationSeqId: "TOTE"})
        call("create#mantle.product.issuance.AssetReservation", {
            assetReservationId: "WHF_RESERVATION",
            assetId: "WHF_PICKED",
            productId: "WHF_PRODUCT",
            quantity: 2,
            quantityNotIssued: 2
        })
        call("create#mantle.product.asset.PhysicalInventory", {
            physicalInventoryId: "WHF_COUNT",
            facilityId: "WHF_FAC",
            statusId: "PIInProgress"
        })
        call("create#mantle.product.asset.PhysicalInventoryCount", {
            physicalInventoryCountId: "WHF_COUNT_LINE",
            physicalInventoryId: "WHF_COUNT",
            facilityId: "WHF_FAC",
            locationSeqId: "COUNT",
            productId: "WHF_PRODUCT"
        })
        call("create#mantle.facility.ProductFacilityLocation", {
            productId: "WHF_PRODUCT",
            facilityId: "WHF_FAC",
            locationSeqId: "POLICY"
        })
        ec.artifactExecution.enableAuthz()
    },
    cleanup() {
        ec.message.clearErrors()
        ec.artifactExecution.enableAuthz()
    }
})

feature("a facility editor creates a facility under a parent, and a user without FACILITY_EDIT is refused alike", {
    when() {
        const parameters = {
            facilityName: "Fixture annex",
            facilityTypeEnumId: "FcTpBuilding",
            ownerPartyId: "WHF_ORG",
            parentFacilityId: "WHF_FAC"
        }
        const reader = as("whf_reader", () => invoke(F + "store#Facility", parameters))
        const created = as("whf_editor", () => invoke(F + "store#Facility", parameters))
        const otherOwner = as("whf_editor", () =>
            invoke(F + "store#Facility", Object.assign({}, parameters, {ownerPartyId: "WHF_OTHER"}))
        )
        const otherParent = as("whf_editor", () =>
            invoke(F + "store#Facility", Object.assign({}, parameters, {parentFacilityId: "WHF_OTHER_FAC"}))
        )
        const otherFacility = as("whf_editor", () =>
            invoke(F + "store#Facility", {facilityId: "WHF_OTHER_FAC", facilityName: "Renamed"})
        )
        return {
            reader,
            created,
            otherOwner,
            otherParent,
            otherFacility,
            row: one("mantle.facility.Facility", {facilityId: created.facilityId})
        }
    },
    then({reader, created, otherOwner, otherParent, otherFacility, row}) {
        reader.error.includes("PERMISSION_DENIED")
        created.error == ""
        created.created == true
        row.parentFacilityId == "WHF_FAC"
        row.ownerPartyId == "WHF_ORG"
        otherOwner.error.includes("OWNER_UNAVAILABLE")
        otherParent.error.includes("FACILITY_UNAVAILABLE")
        otherFacility.error.includes("FACILITY_UNAVAILABLE")
    }
})

feature("a parent cycle is refused, and a change that leaves out the parent keeps it", {
    when() {
        return as("whf_editor", () => {
            const site = invoke(F + "store#Facility", {facilityId: "WHF_SITE", facilityName: "Site", ownerPartyId: "WHF_ORG"})
            const building = invoke(F + "store#Facility", {
                facilityId: "WHF_BUILDING",
                facilityName: "Building",
                ownerPartyId: "WHF_ORG",
                parentFacilityId: "WHF_SITE"
            })
            const floor = invoke(F + "store#Facility", {
                facilityId: "WHF_FLOOR",
                facilityName: "Floor",
                ownerPartyId: "WHF_ORG",
                parentFacilityId: "WHF_BUILDING"
            })
            const cycle = invoke(F + "store#Facility", {facilityId: "WHF_SITE", parentFacilityId: "WHF_FLOOR"})
            const itself = invoke(F + "store#Facility", {facilityId: "WHF_SITE", parentFacilityId: "WHF_SITE"})
            const renamed = invoke(F + "store#Facility", {facilityId: "WHF_FLOOR", facilityName: "Ground floor"})
            return {
                site,
                building,
                floor,
                cycle,
                itself,
                renamed,
                siteRow: one("mantle.facility.Facility", {facilityId: "WHF_SITE"}),
                floorRow: one("mantle.facility.Facility", {facilityId: "WHF_FLOOR"})
            }
        })
    },
    then({site, building, floor, cycle, itself, renamed, siteRow, floorRow}) {
        site.error == ""
        building.error == ""
        floor.error == ""
        cycle.error.includes("PARENT_CYCLE")
        itself.error.includes("PARENT_CYCLE")
        siteRow.parentFacilityId == null
        renamed.error == ""
        floorRow.facilityName == "Ground floor"
        floorRow.parentFacilityId == "WHF_BUILDING"
    }
})

feature("locations keep capacity and pick sequence, and each location type's asset status is audit-logged", {
    when() {
        return as("whf_editor", () => {
            const created = invoke(F + "store#FacilityLocation", {
                facilityId: "WHF_FAC",
                isNew: true,
                areaId: "A",
                aisleId: "01",
                levelId: "1",
                locationTypeEnumId: "FltPick",
                capacity: "12.5",
                sequenceNum: 10
            })
            const duplicate = invoke(F + "store#FacilityLocation", {facilityId: "WHF_FAC", isNew: true, locationSeqId: "A011"})
            const negative = invoke(F + "store#FacilityLocation", {facilityId: "WHF_FAC", locationSeqId: "A011", capacity: -1})
            const dock = invoke(F + "store#FacilityLocation", {
                facilityId: "WHF_FAC",
                isNew: true,
                locationSeqId: "DOCK1",
                locationTypeEnumId: "FltShipDock"
            })
            const other = invoke(F + "store#FacilityLocation", {facilityId: "WHF_OTHER_FAC", locationSeqId: "X1", capacity: 1})
            const status = invoke(F + "store#FacilityLocationType", {
                facilityId: "WHF_FAC",
                locationTypeEnumId: "FltQuarantine",
                autoStatusId: "AstQuarantine",
                changeReason: "Quarantine holds stock"
            })
            const changed = invoke(F + "store#FacilityLocationType", {
                facilityId: "WHF_FAC",
                locationTypeEnumId: "FltQuarantine",
                autoStatusId: "AstOnHold",
                changeReason: "Held, not quarantined"
            })
            const notAsset = invoke(F + "store#FacilityLocationType", {
                facilityId: "WHF_FAC",
                locationTypeEnumId: "FltQuarantine",
                autoStatusId: "PIComplete",
                changeReason: "Refused"
            })
            return {created, duplicate, negative, dock, other, status, changed, notAsset}
        })
    },
    then({created, duplicate, negative, dock, other, status, changed, notAsset}) {
        created.error == ""
        created.locationSeqId == "A011"
        one("mantle.facility.FacilityLocation", {facilityId: "WHF_FAC", locationSeqId: "A011"}).sequenceNum == 10
        String(one("mantle.facility.FacilityLocation", {facilityId: "WHF_FAC", locationSeqId: "A011"}).capacity) == "12.5"
        duplicate.error.includes("LOCATION_EXISTS")
        negative.error.includes("Capacity cannot be negative")
        dock.error == ""
        one("moqui.basic.Enumeration", {enumId: "FltShipDock"}).enumTypeId == "FacilityLocationType"
        other.error.includes("FACILITY_UNAVAILABLE")
        status.error == ""
        changed.error == ""
        notAsset.error.includes("Choose an asset status")
        one("mantle.facility.FacilityLocationType", {facilityId: "WHF_FAC", locationTypeEnumId: "FltQuarantine"}).autoStatusId ==
            "AstOnHold"
        find("moqui.entity.EntityAuditLog", {
            changedEntityName: "mantle.facility.FacilityLocationType",
            changedFieldName: "autoStatusId",
            newValueText: "AstOnHold",
            changeReason: "Held, not quarantined"
        }).count() == 1
    }
})

const blocked = [
    {locationSeqId: "STOCK", named: "WHF_STOCK", kind: "stock"},
    {locationSeqId: "EQUIP", named: "WHF_FORKLIFT", kind: "equipment"},
    {locationSeqId: "TOTE", named: "WHF_TOTE", kind: "container"},
    {locationSeqId: "PICK", named: "WHF_RESERVATION", kind: "reservation"},
    {locationSeqId: "COUNT", named: "WHF_COUNT", kind: "count"},
    {locationSeqId: "POLICY", named: "WHF_PRODUCT", kind: "productLocation"}
]
feature("closing location #locationSeqId is refused, naming its #kind blocker", {
    where: blocked,
    when({locationSeqId}) {
        return {
            closed: closeAt(locationSeqId),
            found: as("whf_editor", () => invoke(F + "get#FacilityLocationBlockers", {facilityId: "WHF_FAC", locationSeqId})),
            row: one("mantle.facility.FacilityLocation", {facilityId: "WHF_FAC", locationSeqId})
        }
    },
    then({closed, found, row, named, kind}) {
        closed.error.includes("LOCATION_IN_USE")
        closed.error.includes(named)
        found.blockers.map(blocker => blocker.kind) == [kind]
        row.thruDate == null
    }
})

feature("removing a product's location policy through store#ProductFacilityPolicy lets its location close", {
    when() {
        const removed = as("whf_editor", () =>
            invoke(F + "store#ProductFacilityPolicy", {
                productId: "WHF_PRODUCT",
                facilityId: "WHF_FAC",
                locationSeqId: "POLICY",
                removeLocation: true,
                changeReason: "Bin retired"
            })
        )
        const again = as("whf_editor", () =>
            invoke(F + "store#ProductFacilityPolicy", {
                productId: "WHF_PRODUCT",
                facilityId: "WHF_FAC",
                locationSeqId: "POLICY",
                removeLocation: true,
                changeReason: "Bin retired"
            })
        )
        return {removed, again, closed: closeAt("POLICY")}
    },
    then({removed, again, closed}) {
        removed.error == ""
        removed.locationPolicies.length == 0
        again.error.includes("no policy at the location")
        closed.error == ""
    }
})

feature(
    "a location with only a depleted asset or departed equipment closes with its reason audit-logged, and refuses as a destination",
    {
        when() {
            const reader = as("whf_reader", () =>
                invoke(F + "close#FacilityLocation", {
                    facilityId: "WHF_FAC",
                    locationSeqId: "DEPLETED",
                    changeReason: "Bin retired"
                })
            )
            const noReason = as("whf_editor", () =>
                invoke(F + "close#FacilityLocation", {facilityId: "WHF_FAC", locationSeqId: "DEPLETED"})
            )
            const depleted = closeAt("DEPLETED")
            const departed = closeAt("LEFT")
            const again = closeAt("DEPLETED")
            const openCheck = invoke(F + "check#FacilityLocationOpen", {facilityId: "WHF_FAC", locationSeqId: "STOCK"})
            const closedCheck = invoke(F + "check#FacilityLocationOpen", {facilityId: "WHF_FAC", locationSeqId: "DEPLETED"})
            const missingCheck = invoke(F + "check#FacilityLocationOpen", {facilityId: "WHF_FAC", locationSeqId: "NOWHERE"})
            const edit = as("whf_editor", () =>
                invoke(F + "store#FacilityLocation", {facilityId: "WHF_FAC", locationSeqId: "DEPLETED", capacity: 3})
            )
            const closedPolicy = as("whf_editor", () =>
                invoke(F + "store#ProductFacilityPolicy", {
                    productId: "WHF_PRODUCT",
                    facilityId: "WHF_FAC",
                    locationSeqId: "DEPLETED",
                    minimumStock: 1,
                    changeReason: "Refused"
                })
            )
            const reopened = as("whf_editor", () =>
                invoke(F + "reopen#FacilityLocation", {facilityId: "WHF_FAC", locationSeqId: "LEFT", changeReason: "Back in use"})
            )
            return {
                reader,
                noReason,
                depleted,
                departed,
                again,
                openCheck,
                closedCheck,
                missingCheck,
                edit,
                closedPolicy,
                reopened,
                depletedRow: one("mantle.facility.FacilityLocation", {facilityId: "WHF_FAC", locationSeqId: "DEPLETED"}),
                leftRow: one("mantle.facility.FacilityLocation", {facilityId: "WHF_FAC", locationSeqId: "LEFT"}),
                audits: find("moqui.entity.EntityAuditLog", {
                    changedEntityName: "mantle.facility.FacilityLocation",
                    changedFieldName: "thruDate",
                    changeReason: "Bin retired"
                }).count()
            }
        },
        then({
            reader,
            noReason,
            depleted,
            departed,
            again,
            openCheck,
            closedCheck,
            missingCheck,
            edit,
            closedPolicy,
            reopened,
            depletedRow,
            leftRow,
            audits
        }) {
            reader.error.includes("PERMISSION_DENIED")
            noReason.error.includes("REASON_REQUIRED")
            depleted.error == ""
            departed.error == ""
            depletedRow.thruDate != null
            // POLICY (the feature before), DEPLETED and LEFT
            audits == 3
            again.error.includes("LOCATION_CLOSED")
            openCheck.error == ""
            openCheck.locationTypeEnumId == "FltBulk"
            closedCheck.error.includes("LOCATION_CLOSED")
            missingCheck.error.includes("LOCATION_UNAVAILABLE")
            edit.error.includes("LOCATION_CLOSED")
            closedPolicy.error.includes("Location DEPLETED is closed")
            reopened.error == ""
            leftRow.thruDate == null
        }
    }
)

feature("another organization's location is refused like a missing one", {
    when() {
        return as("whf_editor", () => ({
            close: invoke(F + "close#FacilityLocation", {facilityId: "WHF_OTHER_FAC", locationSeqId: "X1", changeReason: "x"}),
            blockers: invoke(F + "get#FacilityLocationBlockers", {facilityId: "WHF_OTHER_FAC", locationSeqId: "X1"}),
            type: invoke(F + "store#FacilityLocationType", {
                facilityId: "WHF_OTHER_FAC",
                locationTypeEnumId: "FltPick",
                autoStatusId: "AstAvailable",
                changeReason: "x"
            })
        }))
    },
    then({close, blockers, type}) {
        close.error.includes("FACILITY_UNAVAILABLE")
        blockers.error.includes("FACILITY_UNAVAILABLE")
        type.error.includes("FACILITY_UNAVAILABLE")
    }
})
