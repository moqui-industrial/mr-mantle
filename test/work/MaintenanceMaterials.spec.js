// Maintenance parts and stock (mantle.work.MaintenanceExecutionServices; IronStone Maintenance design §3 PlannedParts and PartsUsed,
// MT-08; impl-maintenance P9, F30, F71): a planner plans parts on a work order (the model's suggested spare part, a change ending
// the line and starting the next, a supplies part refused), the assigned technician without the stock permission is refused an
// issue, one with it issues twice (a second issuance, a retry answering the first), another owner's and supplies stock refused, a
// return above the net issued refused and a partial one received at the original cost, naming its issuance. Standalone: spec-local
// organizations, facilities, parts, groups and users; the services called as each user with the artifact check aside (their own
// permission and scope checks decide). The ledger side is test/ledger/MaintenanceExpenseRouting.
// Run: ./moq test mr-mantle --spec MaintenanceMaterials
const prefix = "MNT_MAT_SPEC"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    since = "2000-01-01T00:00:00Z"
const S = "mantle.work.MaintenanceServices.",
    X = "mantle.work.MaintenanceExecutionServices."
const state = {}
const hour = 3600000

// the service's answer as a user, or the reason code it refuses with
function as(username, service, parameters = {}) {
    login(username)
    ec.artifactExecution.disableAuthz()
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(service).parameters(parameters).requireNewTransaction(true).call() || {}
        if (!ec.message.hasError()) return out
        const match = /([A-Z][A-Z0-9_]+):/.exec(ec.message.getErrorsString())
        return match ? match[1] : "ERROR " + ec.message.getErrorsString()
    } catch (error) {
        const match = /([A-Z][A-Z0-9_]+):/.exec(String(error.message))
        return match ? match[1] : "ERROR " + error.message
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}
const one = (entity, conditions) => ec.entity.find(entity).condition(conditions).disableAuthz().one()
const rows = (entity, conditions) => Array.from(ec.entity.find(entity).condition(conditions).disableAuthz().list())
function organization(partyId, name) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
function user(kind, permissions, organizationPartyId = orgA) {
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Maintenance materials " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    const partyId = prefix + "_P_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Materials", lastName: kind})
    call("create#mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtAgent",
        fromPartyId: partyId,
        toPartyId: organizationPartyId,
        toRoleTypeId: "OrgInternal",
        fromDate: since
    })
    call("create#moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA"
    })
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: since})
    state[kind + "_PARTY"] = partyId
    return id
}
function product(productId, assetTypeEnumId, ownerPartyId = orgA) {
    call("create#mantle.product.Product", {
        productId,
        productName: productId,
        productTypeEnumId: "PtAsset",
        assetTypeEnumId,
        amountUomId: "OTH_ea",
        ownerPartyId
    })
}
function stock(productId, quantity, acquireCost, facilityId, ownerPartyId, assetTypeEnumId = "AstTpInventory") {
    const assetId = call("mantle.product.AssetServices.receive#Asset", {
        productId,
        quantity,
        facilityId,
        locationSeqId: "BIN1",
        ownerPartyId,
        assetTypeEnumId,
        statusId: "AstAvailable",
        acquireCost
    }).assetId
    call("update#mantle.product.asset.Asset", {assetId, acquireCostUomId: "USD"})
    return assetId
}
const n = value => (value == null ? null : Number(String(value)))
const asset = assetId => one("mantle.product.asset.Asset", {assetId})
const revision = workEffortId => Number(one("mantle.work.maintenance.MaintenanceWorkOrder", {workEffortId}).revision || 0)

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(orgA, "Materials Spec A")
        organization(orgB, "Materials Spec B")
        for (const [facilityId, facilityTypeEnumId, ownerPartyId] of [
            [prefix + "_SITE", "FcTpBuilding", orgA],
            [prefix + "_WH", "FcTpWarehouse", orgA],
            [prefix + "_WH_B", "FcTpWarehouse", orgB]
        ]) {
            call("create#mantle.facility.Facility", {facilityId, facilityName: facilityId, facilityTypeEnumId, ownerPartyId})
            call("create#mantle.facility.FacilityLocation", {facilityId, locationSeqId: "BIN1", locationTypeEnumId: "FltPick"})
        }
        // the equipment model with its spare part, the equipment, a part, a supplies item
        product(prefix + "_MODEL", "AstTpEquipment")
        product(prefix + "_FILTER", "AstTpInventory")
        product(prefix + "_BELT", "AstTpInventory")
        product(prefix + "_RAGS", "AstTpSupplies")
        call("create#mantle.product.ProductAssoc", {
            productId: prefix + "_MODEL",
            toProductId: prefix + "_FILTER",
            productAssocTypeEnumId: "PatSparePart",
            fromDate: since,
            quantity: 2
        })
        call("create#mantle.product.asset.Asset", {
            assetId: prefix + "_PUMP",
            assetTypeEnumId: "AstTpEquipment",
            assetName: "Materials pump",
            productId: prefix + "_MODEL",
            ownerPartyId: orgA,
            facilityId: prefix + "_SITE"
        })
        state.filterStock = stock(prefix + "_FILTER", 10, 12.5, prefix + "_WH", orgA)
        state.beltStock = stock(prefix + "_BELT", 4, 30, prefix + "_WH", orgA)
        state.ragStock = stock(prefix + "_RAGS", 50, 1, prefix + "_WH", orgA, "AstTpSupplies")
        state.otherStock = stock(prefix + "_FILTER", 10, 12.5, prefix + "_WH_B", orgB)
        state.planner = user("PLANNER", ["MAINTENANCE_VIEW", "MAINTENANCE_PLAN"])
        state.tech = user("TECH", ["MAINTENANCE_ASSIGNED_VIEW", "MAINTENANCE_EXECUTE", "STOCK_ISSUE"])
        state.nostock = user("NOSTOCK", ["MAINTENANCE_ASSIGNED_VIEW", "MAINTENANCE_EXECUTE"])
        // a corrective work order, approved on create, assigned to both technicians and started
        state.work = as(state.planner, S + "create#MaintenanceWorkOrder", {
            assetId: prefix + "_PUMP",
            workEffortName: "Pump filter clogged",
            operationKey: prefix + "-create"
        }).workEffortId
        as(state.planner, S + "schedule#MaintenanceWorkOrder", {
            workEffortId: state.work,
            expectedRevision: revision(state.work),
            assigneePartyIds: [state.TECH_PARTY, state.NOSTOCK_PARTY],
            estimatedStartDate: new Date(Date.now() - hour),
            estimatedCompletionDate: new Date(Date.now() + 4 * hour)
        })
        state.started = as(state.tech, S + "transition#MaintenanceWorkOrder", {
            workEffortId: state.work,
            action: "start",
            expectedRevision: revision(state.work)
        })
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature("a planner plans the model's suggested part and changes a line; supplies and a technician's plan are refused", {
    when() {
        const before = as(state.planner, X + "get#MaintenanceMaterials", {workEffortId: state.work})
        const suggested = as(state.planner, X + "store#MaintenanceMaterial", {workEffortId: state.work, addSuggested: "Y"})
        const added = as(state.planner, X + "store#MaintenanceMaterial", {
            workEffortId: state.work,
            productId: prefix + "_BELT",
            estimatedQuantity: 1,
            sourceFacilityId: prefix + "_WH"
        })
        const changed = as(state.planner, X + "store#MaintenanceMaterial", {
            workEffortId: state.work,
            productId: prefix + "_BELT",
            fromDate: added.fromDate,
            estimatedQuantity: 2
        })
        const stale = as(state.planner, X + "store#MaintenanceMaterial", {
            workEffortId: state.work,
            productId: prefix + "_BELT",
            fromDate: "2001-01-01 00:00:00",
            estimatedQuantity: 3
        })
        const supplies = as(state.planner, X + "store#MaintenanceMaterial", {
            workEffortId: state.work,
            productId: prefix + "_RAGS",
            estimatedQuantity: 1
        })
        const byTech = as(state.tech, X + "store#MaintenanceMaterial", {
            workEffortId: state.work,
            productId: prefix + "_BELT",
            estimatedQuantity: 9
        })
        const after = as(state.planner, X + "get#MaintenanceMaterials", {workEffortId: state.work})
        const beltRows = rows("mantle.work.effort.WorkEffortProduct", {workEffortId: state.work, productId: prefix + "_BELT"})
        return {before, suggested, after, beltRows, stale, supplies, byTech}
    },
    then({before, suggested, after, beltRows, stale, supplies, byTech}) {
        before.suggestedList.length == 1 && before.suggestedList[0].productId == prefix + "_FILTER"
        suggested.addedProductIds.length == 1
        after.suggestedList.length == 0
        after.plannedList.length == 2
        after.plannedList.find(row => row.productId == prefix + "_FILTER").quantity == "2"
        after.plannedList.find(row => row.productId == prefix + "_BELT").quantity == "2"
        // a change ends the line and starts the next: two rows, one open
        beltRows.length == 2 && beltRows.filter(row => row.thruDate == null).length == 1
        stale == "RECORD_CHANGED"
        supplies == "SUPPLIES_REFUSED"
        byTech == "PERMISSION_DENIED"
    }
})

feature("an assigned technician without the stock permission is refused; one with it issues twice, each a new issuance", {
    when() {
        const parameters = {workEffortId: state.work, productId: prefix + "_FILTER", assetId: state.filterStock, quantity: 1}
        const noStock = as(state.nostock, X + "issue#MaintenanceMaterial", Object.assign({operationKey: "mat-1"}, parameters))
        const first = as(state.tech, X + "issue#MaintenanceMaterial", Object.assign({operationKey: "mat-1"}, parameters))
        const retry = as(state.tech, X + "issue#MaintenanceMaterial", Object.assign({operationKey: "mat-1"}, parameters))
        const second = as(state.tech, X + "issue#MaintenanceMaterial", Object.assign({operationKey: "mat-2"}, parameters))
        const supplies = as(state.tech, X + "issue#MaintenanceMaterial", {
            operationKey: "mat-3",
            workEffortId: state.work,
            assetId: state.ragStock,
            quantity: 1
        })
        const otherOwner = as(state.tech, X + "issue#MaintenanceMaterial", {
            operationKey: "mat-4",
            workEffortId: state.work,
            assetId: state.otherStock,
            quantity: 1
        })
        const mismatch = as(state.tech, X + "issue#MaintenanceMaterial", {
            operationKey: "mat-5",
            workEffortId: state.work,
            productId: prefix + "_BELT",
            assetId: state.filterStock,
            quantity: 1
        })
        const issuances = rows("mantle.product.issuance.AssetIssuance", {workEffortId: state.work})
        const read = as(state.tech, X + "get#MaintenanceMaterials", {workEffortId: state.work, withStock: true})
        return {noStock, first, retry, second, supplies, otherOwner, mismatch, issuances, read}
    },
    then({noStock, first, retry, second, supplies, otherOwner, mismatch, issuances, read}) {
        state.started.statusId == "WeInProgress"
        noStock == "PERMISSION_DENIED"
        first.result.resultCode == "ISSUED"
        retry.result.alreadyApplied === true && retry.result.assetIssuanceId == first.result.assetIssuanceId
        second.result.assetIssuanceId != first.result.assetIssuanceId
        issuances.length == 2
        n(asset(state.filterStock).quantityOnHandTotal) == 8
        supplies == "SUPPLIES_REFUSED"
        // another organization's stock is outside the technician's facilities
        otherOwner == "RECORD_UNAVAILABLE"
        mismatch == "PRODUCT_MISMATCH"
        read.canIssue === true
        read.plannedList.find(row => row.productId == prefix + "_FILTER").issued == "2"
        read.plannedList.find(row => row.productId == prefix + "_FILTER").left == "0"
        read.plannedList.find(row => row.productId == prefix + "_BELT").stockOptions.length == 1
        state.firstIssuance = first.result.assetIssuanceId
    }
})

feature("a return above what is left of an issuance is refused; a partial one is a receipt at the original cost naming it", {
    when() {
        const tooMany = as(state.tech, X + "return#MaintenanceMaterial", {
            operationKey: "ret-1",
            assetIssuanceId: state.firstIssuance,
            quantity: 2
        })
        const partial = as(state.tech, X + "return#MaintenanceMaterial", {
            operationKey: "ret-2",
            assetIssuanceId: state.firstIssuance,
            quantity: 0.5,
            reason: "Half a pack unused"
        })
        const again = as(state.tech, X + "return#MaintenanceMaterial", {
            operationKey: "ret-3",
            assetIssuanceId: state.firstIssuance,
            quantity: 0.75
        })
        const receipt = one("mantle.product.receipt.AssetReceipt", {assetReceiptId: partial.result?.assetReceiptId})
        const read = as(state.planner, X + "get#MaintenanceMaterials", {workEffortId: state.work})
        return {tooMany, partial, again, receipt, read}
    },
    then({tooMany, partial, again, receipt, read}) {
        tooMany == "QUANTITY_EXCEEDS_ISSUED"
        partial.result.resultCode == "RETURNED"
        partial.result.intoOriginal === true
        receipt.sourceAssetIssuanceId == state.firstIssuance
        receipt.workEffortId == state.work
        n(receipt.quantityAccepted) == 0.5
        // the original asset, at its original cost
        n(asset(receipt.assetId).acquireCost) == 12.5
        asset(state.filterStock).acquireWorkEffortId == null
        n(asset(state.filterStock).quantityOnHandTotal) == 8.5
        // never more than what is left of the issuance
        again == "QUANTITY_EXCEEDS_ISSUED"
        read.usedList.find(row => row.productId == prefix + "_FILTER").used == "1.5"
        read.receiptList.length == 1 && read.receiptList[0].reason == "Half a pack unused"
        read.issuanceList.find(row => row.assetIssuanceId == state.firstIssuance).returnable == "0.5"
    }
})
