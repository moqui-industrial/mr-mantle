// Putaway (mantle.facility.PutawayServices, Putaway.js; WarehouseTaskServices.putaway#Stock; impl-warehouse P9): the dated
// putaway rules (FACILITY_EDIT), the resolver that tries the product's default location first and then the rules, each
// checked and explained (capacity with what is coming, storage type, quarantine, an unmeasured unit), the guarded putaway
// (STOCK_MOVE: the suggestion, a reason for another bin, the receiving hold released, a retry answered), the step-1 receipt
// to the resolved destination, and a rule naming a location blocking its close. The users are in spec-local groups.
const P = "mantle.facility.PutawayServices."
const T = "mantle.shipment.WarehouseTaskServices."
const org = "WHP_ORG",
    facility = "WHP_FAC"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const since = "2000-01-01T00:00:00Z"
let keySeq = 0
const key = () => "whp-op-" + ++keySeq

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
const run = (username, service, parameters) => as(username, () => invoke(service, parameters))
function ensureGroup(userGroupId, permissions) {
    if (!one("moqui.security.UserGroup", {userGroupId})) call("create#moqui.security.UserGroup", {userGroupId})
    for (const userPermissionId of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId, userPermissionId, fromDate: since})
}
function user(partyId, userGroupId, organizationPartyId = org) {
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
        toPartyId: organizationPartyId,
        relationshipTypeEnumId: "PrtAgent",
        toRoleTypeId: "OrgInternal",
        fromDate: since
    })
}
function receive(productId, quantity, locationSeqId, statusId = "AstAvailable") {
    ec.artifactExecution.disableAuthz()
    try {
        return call("mantle.product.AssetServices.receive#Asset", {
            productId,
            quantity,
            facilityId: facility,
            locationSeqId,
            ownerPartyId: org,
            assetTypeEnumId: "AstTpInventory",
            statusId
        }).assetId
    } finally {
        ec.artifactExecution.enableAuthz()
    }
}
const asset = assetId => one("mantle.product.asset.Asset", {assetId})
const rule = (parameters, username = "whp_admin") =>
    run(username, P + "store#PutawayRule", Object.assign({facilityId: facility, changeReason: "Putaway spec"}, parameters))
const resolve = parameters => run("whp_mover", P + "resolve#Destination", parameters)
const putaway = (parameters, username = "whp_mover") => run(username, T + "putaway#Stock", parameters)
const candidate = (resolved, locationSeqId) => (resolved.candidates || []).find(row => row.locationSeqId === locationSeqId) || {}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        ensureGroup("WHP_ADMINS", ["FACILITY_EDIT"])
        ensureGroup("WHP_MOVERS", ["STOCK_MOVE"])
        ensureGroup("WHP_RECEIVERS", ["STOCK_RECEIVE"])
        ensureGroup("WHP_READERS", [])
        for (const partyId of [org, "WHP_OTHER"]) {
            call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
            call("create#mantle.party.Organization", {partyId, organizationName: partyId})
            call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
        }
        user("WHP_ADMIN", "WHP_ADMINS")
        user("WHP_MOVER", "WHP_MOVERS")
        user("WHP_RECEIVER", "WHP_RECEIVERS")
        user("WHP_READER", "WHP_READERS")
        user("WHP_OUTSIDER", "WHP_ADMINS", "WHP_OTHER")
        call("create#mantle.facility.Facility", {facilityId: facility, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: org})
        for (const [locationSeqId, locationTypeEnumId, extra] of [
            ["RECV1", "FltReceiving", {}],
            ["PICK1", "FltPick", {capacity: 10, capacityUomId: "OTH_ea", sequenceNum: 1}],
            ["PICK2", "FltPick", {sequenceNum: 2}],
            ["BULK1", "FltBulk", {capacity: 100, sequenceNum: 10}],
            ["BULK2", "FltBulk", {sequenceNum: 11}],
            ["COLD1", "FltBulk", {storageTypeEnumId: "StgCold", sequenceNum: 12}],
            ["SCALE1", "FltBulk", {capacity: 50, capacityUomId: "WT_kg", sequenceNum: 13}],
            ["QUAR1", "FltQuarantine", {}],
            ["QUAR2", "FltQuarantine", {}],
            ["SHUT1", "FltBulk", {thruDate: "2026-01-31 00:00:00"}]
        ])
            call(
                "create#mantle.facility.FacilityLocation",
                Object.assign({facilityId: facility, locationSeqId, locationTypeEnumId}, extra)
            )
        for (const [locationTypeEnumId, autoStatusId] of [
            ["FltPick", "AstAvailable"],
            ["FltReceiving", "AstOnHold"],
            ["FltQuarantine", "AstQuarantine"]
        ])
            call("create#mantle.facility.FacilityLocationType", {facilityId: facility, locationTypeEnumId, autoStatusId})
        for (const [productId, extra] of [
            ["WHP_WIDGET", {}],
            ["WHP_COLD", {storageTypeEnumId: "StgCold"}],
            ["WHP_LOOSE", {}],
            ["WHP_GADGET", {}],
            ["WHP_HEAVY", {}]
        ])
            call(
                "create#mantle.product.Product",
                Object.assign(
                    {
                        productId,
                        productName: productId,
                        productTypeEnumId: "PtAsset",
                        assetTypeEnumId: "AstTpInventory",
                        amountUomId: "OTH_ea",
                        ownerPartyId: org
                    },
                    extra
                )
            )
        // a 2 kg unit, measured on the scale-capacity bin
        call("create#mantle.product.ProductUomDimension", {
            productId: "WHP_HEAVY",
            uomDimensionTypeId: "Weight",
            value: 2,
            uomId: "WT_kg"
        })
        call("create#mantle.facility.ProductFacilityLocation", {
            productId: "WHP_WIDGET",
            facilityId: facility,
            locationSeqId: "PICK1"
        })
        ec.artifactExecution.enableAuthz()
    },
    cleanup() {
        ec.message.clearErrors()
        ec.artifactExecution.enableAuthz()
    }
})

feature("a putaway rule takes FACILITY_EDIT in the facility's organization; a change ends one row and starts the next", {
    when() {
        const parameters = {productId: "WHP_WIDGET", toLocationSeqId: "BULK1", priority: 10}
        const mover = rule(parameters, "whp_mover")
        const outsider = rule(parameters, "whp_outsider")
        const closed = rule({productId: "WHP_WIDGET", toLocationSeqId: "SHUT1"})
        const noTarget = rule({productId: "WHP_WIDGET"})
        const noReason = rule(Object.assign({}, parameters, {changeReason: " "}))
        const created = rule(parameters)
        const changed = rule({putawayRuleId: created.putawayRuleId, priority: 20})
        const listed = run("whp_mover", P + "find#PutawayRules", {facilityId: facility})
        const history = run("whp_mover", P + "find#PutawayRules", {facilityId: facility, includeHistory: true})
        const audit = Array.from(
            find("moqui.entity.EntityAuditLog", {
                changedEntityName: "mantle.facility.PutawayRule",
                changedFieldName: "thruDate",
                pkPrimaryValue: created.putawayRuleId
            }).list()
        )
        return {mover, outsider, closed, noTarget, noReason, created, changed, listed, history, audit}
    },
    then({mover, outsider, closed, noTarget, noReason, created, changed, listed, history, audit}) {
        mover.error.includes("PERMISSION_DENIED")
        outsider.error.includes("FACILITY_UNAVAILABLE")
        closed.error.includes("LOCATION_CLOSED")
        noTarget.error.includes("RULE_INVALID")
        noReason.error.includes("REASON_REQUIRED")
        created.error == ""
        changed.error == ""
        changed.rule.previousPutawayRuleId == created.putawayRuleId
        changed.rule.priority == 20
        changed.rule.toText == "Location BULK1"
        listed.rules.filter(row => row.productId === "WHP_WIDGET").length == 1
        listed.canEdit == false
        history.rules.filter(row => row.productId === "WHP_WIDGET").length == 2
        audit.length >= 1
        audit[0].changeReason == "Putaway spec"
    }
})

feature("Putaway tries the default first, explains its refusal for capacity and suggests the rule's bin", {
    when() {
        receive("WHP_WIDGET", 8, "PICK1")
        const queued = receive("WHP_WIDGET", 5, "RECV1", "AstOnHold")
        const resolved = resolve({assetId: queued})
        const capacity = run("whp_mover", P + "get#Capacity", {facilityId: facility, locationSeqIds: ["PICK1"]})
        const excluded = run("whp_mover", P + "get#Capacity", {
            facilityId: facility,
            locationSeqIds: ["PICK1"],
            excludeAssetIds: [queued],
            productId: "WHP_WIDGET",
            quantity: 2
        })
        return {queued, resolved, pick: capacity.capacityRows[0], excluded: excluded.capacityRows[0]}
    },
    then({resolved, pick, excluded}) {
        resolved.error == ""
        resolved.candidates[0].locationSeqId == "PICK1"
        resolved.candidates[0].source == "default"
        resolved.candidates[0].reasonCode == "CAPACITY_EXCEEDED"
        resolved.candidates[0].explanation.includes("holds 8 of 10")
        resolved.locationSeqId == "BULK1"
        resolved.source == "rule"
        resolved.statusAfter == "AstAvailable"
        pick.occupied == "8"
        pick.incoming == "5"
        pick.remaining == "-3"
        excluded.incoming == "0"
        excluded.fits == true
    }
})

feature("when no location fits, the stock stays where it is with the reason named", {
    when() {
        const loose = receive("WHP_LOOSE", 3, "RECV1", "AstOnHold")
        const resolved = resolve({assetId: loose})
        const refused = putaway({operationKey: key(), assetId: loose})
        return {resolved, refused, after: asset(loose)}
    },
    then({resolved, refused, after}) {
        resolved.locationSeqId == null
        resolved.reasonCode == "NO_DESTINATION"
        resolved.reasonText.includes("No default location or putaway rule applies to WHP_LOOSE")
        refused.error.includes("NO_DESTINATION")
        refused.error.includes("stays where it is")
        after.locationSeqId == "RECV1"
    }
})

feature("storage types, an unmeasured unit, weight capacity and quarantine are checked and explained", {
    when() {
        rule({productId: "WHP_COLD", toLocationTypeEnumId: "FltBulk", priority: 5})
        rule({productId: "WHP_LOOSE", toLocationSeqId: "SCALE1", priority: 5})
        rule({productId: "WHP_HEAVY", toLocationSeqId: "SCALE1", priority: 5})
        rule({productId: "WHP_HEAVY", toLocationSeqId: "BULK2", priority: 6})
        const cold = resolve({facilityId: facility, productId: "WHP_COLD", quantity: 4})
        const loose = resolve({facilityId: facility, productId: "WHP_LOOSE", quantity: 1})
        const light = resolve({facilityId: facility, productId: "WHP_HEAVY", quantity: 20})
        const heavy = resolve({facilityId: facility, productId: "WHP_HEAVY", quantity: 30})
        const held = receive("WHP_GADGET", 2, "QUAR1", "AstQuarantine")
        const toBulk = putaway({operationKey: key(), assetId: held, toLocationSeqId: "BULK2", reason: "Overflow"})
        const toQuarantine = putaway({operationKey: key(), assetId: held, toLocationSeqId: "QUAR2", reason: "Cage 2"})
        return {cold, loose, light, heavy, toBulk, toQuarantine, after: asset(held)}
    },
    then({cold, loose, light, heavy, toBulk, toQuarantine, after}) {
        candidate(cold, "BULK1").reasonCode == "STORAGE_TYPE"
        cold.locationSeqId == "COLD1"
        candidate(loose, "SCALE1").reasonCode == "CAPACITY_UNMEASURED"
        light.locationSeqId == "SCALE1"
        candidate(heavy, "SCALE1").reasonCode == "CAPACITY_EXCEEDED"
        heavy.locationSeqId == "BULK2"
        toBulk.error.includes("QUARANTINE_ONLY")
        toQuarantine.error == ""
        after.locationSeqId == "QUAR2"
        after.statusId == "AstQuarantine"
    }
})

feature("a mover puts away to the suggestion and the hold is released; another bin needs a reason; a retry answers once", {
    when() {
        const queued = receive("WHP_WIDGET", 4, "RECV1", "AstOnHold")
        const operationKey = key()
        const reader = putaway({operationKey, assetId: queued}, "whp_reader")
        const first = putaway({operationKey, assetId: queued})
        const retry = putaway({operationKey, assetId: queued})
        const other = receive("WHP_WIDGET", 1, "RECV1", "AstOnHold")
        const noReason = putaway({operationKey: key(), assetId: other, toLocationSeqId: "PICK2"})
        const withReason = putaway({operationKey: key(), assetId: other, toLocationSeqId: "PICK2", reason: "Pick face low"})
        return {reader, first, retry, noReason, withReason, moved: asset(queued), picked: asset(other)}
    },
    then({reader, first, retry, noReason, withReason, moved, picked}) {
        reader.error.includes("PERMISSION_DENIED")
        first.error == ""
        first.result.resultCode == "PUT_AWAY"
        first.result.toLocationSeqId == "BULK1"
        first.result.suggested == true
        first.result.source == "rule"
        first.result.statusId == "AstAvailable"
        retry.result.alreadyApplied == true
        moved.locationSeqId == "BULK1"
        moved.statusId == "AstAvailable"
        noReason.error.includes("REASON_REQUIRED")
        withReason.error == ""
        withReason.result.suggested == false
        picked.locationSeqId == "PICK2"
        picked.statusId == "AstAvailable"
    }
})

feature("a one-step receipt posts to the resolved destination, and a rule naming a location blocks its close", {
    when() {
        rule({productId: "WHP_GADGET", toLocationSeqId: "PICK2", priority: 1})
        const received = run("whp_receiver", T + "receive#AdHocStock", {
            operationKey: key(),
            facilityId: facility,
            productId: "WHP_GADGET",
            quantity: 3,
            reason: "Found on the dock"
        })
        const blockers = run("whp_admin", "mantle.facility.FacilityServices.get#FacilityLocationBlockers", {
            facilityId: facility,
            locationSeqId: "PICK2"
        })
        return {received, blockers}
    },
    then({received, blockers}) {
        received.error == ""
        received.result.receiptSteps == 1
        received.result.locationSeqId == "PICK2"
        received.result.putawayExplanation.includes("PICK2")
        blockers.blockers.some(row => row.kind === "putawayRule")
    }
})
