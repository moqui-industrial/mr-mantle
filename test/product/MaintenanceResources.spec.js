// Maintenance's equipment and facility records (mantle.product.MaintenanceResourceServices; IronStone Maintenance design §6, §13.2;
// impl-maintenance P2): the meter writer (a cumulative meter's lower reading refused and a reset accepted with its reason in the
// audit log, two readings at one time refused and the first kept, a correction of a reading taken), the equipment writer (a
// parent cycle refused; another organization's equipment refused with the parameters that change the caller's own; a write
// permission alone refused), the custody change (dated, the earlier holder ended at that date, a later date refused, F61) and the
// facility's new fields and room features (store#Facility, store#FacilityFeature) with the inherited time zone, an
// every-organization reader's list narrowed to the active organization (F83) but not a record's, the custody change inside an
// ended holding, the holder only the scope's organizations, their employees or the asset's owner (R7),
// replace#AssetPartyAssignment's own refusal of a later date, and the equipment move (stock move authority,
// both facilities, equipment only, audit-logged, out of its container).
// Standalone: spec-local organizations, facilities, a model with an hour meter, equipment, groups and users, with artifact
// authorization disabled (the rules are the services' own permission and scope checks).
// Run: ./moq test mr-mantle --spec MaintenanceResources
const prefix = "MNT_RES_SPEC"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    since = "2000-01-01T00:00:00Z"
const services = "mantle.product.MaintenanceResourceServices."
const state = {}

// The service's answer as a user, or its refusal's message (a negative case names the reason code; a positive one with the same
// parameters gets an answer).
function attempt(username, service, parameters) {
    login(username)
    ec.artifactExecution.disableAuthz()
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(service).parameters(parameters).requireNewTransaction(true).call() || {}
        return ec.message.hasError() ? {refused: ec.message.getErrorsString()} : out
    } catch (error) {
        return {refused: String(error.message)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}
function organization(partyId, name) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
function person(kind) {
    const partyId = prefix + "_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Maintenance resources", lastName: kind})
    return partyId
}
// a user of a spec-local group with the permissions, an agent of the organization
function user(kind, permissions, organizationPartyId) {
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Maintenance resources " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    const partyId = person("USER_" + kind)
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
    return id
}
function facility(suffix, ownerPartyId, parentFacilityId = null, timeZone = null) {
    const facilityId = prefix + "_F_" + suffix
    call("create#mantle.facility.Facility", {
        facilityId,
        facilityName: "Maintenance resources " + suffix,
        facilityTypeEnumId: "FcTpBuilding",
        ownerPartyId,
        parentFacilityId,
        timeZone
    })
    return facilityId
}
function asset(suffix, ownerPartyId, facilityId, fields = {}) {
    const assetId = prefix + "_AS_" + suffix
    call(
        "create#mantle.product.asset.Asset",
        Object.assign(
            {assetId, assetTypeEnumId: "AstTpEquipment", assetName: "Maintenance resources " + suffix, ownerPartyId, facilityId},
            fields
        )
    )
    return assetId
}
const stamp = text => ec.l10n.parseTimestamp(text, "yyyy-MM-dd HH:mm")
const reading = (assetId, readingDate) => ec.entity.find("mantle.product.maintenance.AssetMeter").condition({assetId, readingDate}).one()

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(orgA, "Maintenance Resources Spec A")
        organization(orgB, "Maintenance Resources Spec B")
        // A's site (its zone set) with a room that names none, B's site
        state.site = facility("SITE", orgA, null, "America/Chicago")
        state.room = facility("ROOM", orgA, state.site)
        state.otherSite = facility("OTHER", orgB)
        // an equipment model with a cumulative hour meter
        state.model = prefix + "_MODEL"
        call("create#mantle.product.Product", {productId: state.model, productName: "Maintenance resources model", productTypeEnumId: "PtAsset", assetTypeEnumId: "AstTpEquipment"})
        state.meter = prefix + "_HOURS"
        call("create#mantle.product.maintenance.ProductMeter", {
            productMeterId: state.meter,
            productId: state.model,
            productMeterTypeId: "PdMtrMotorTime",
            meterName: "Hours",
            isCumulative: "Y"
        })
        // A's compressor (of the model) with a motor under it, B's pump
        state.compressor = asset("COMP", orgA, state.room, {productId: state.model})
        state.motor = asset("MOTOR", orgA, state.room, {parentAssetId: state.compressor})
        state.otherPump = asset("OTHER", orgB, state.otherSite)
        state.holder = person("HOLDER")
        state.newHolder = person("NEWHOLDER")
        // the holders are A's employees; an outsider is no one's, and a customer owns equipment held at A's room (R7)
        for (const partyId of [state.holder, state.newHolder])
            call("create#mantle.party.PartyRelationship", {
                relationshipTypeEnumId: "PrtEmployee",
                fromPartyId: partyId,
                toPartyId: orgA,
                fromDate: since
            })
        state.outsider = person("OUTSIDER")
        state.customer = prefix + "_CUSTOMER"
        call("create#mantle.party.Party", {partyId: state.customer, partyTypeEnumId: "PtyOrganization"})
        call("create#mantle.party.Organization", {partyId: state.customer, organizationName: "Maintenance resources customer"})
        state.customerUnit = asset("CUSTUNIT", prefix + "_CUSTOMER", state.room)
        call("create#mantle.product.asset.AssetPartyAssignment", {
            assetId: state.compressor,
            partyId: state.holder,
            roleTypeId: "Custodian",
            fromDate: "2026-01-01T00:00:00Z"
        })
        state.resources = user("RESOURCES", ["MAINTENANCE_RESOURCE_VIEW", "MAINTENANCE_RESOURCE_EDIT", "FACILITY_EDIT"], orgA)
        // the move: a mover with Warehouse's stock move too, equipment in a container of the room, and stock there
        state.mover = user("MOVER", ["MAINTENANCE_RESOURCE_VIEW", "MAINTENANCE_RESOURCE_EDIT", "STOCK_MOVE"], orgA)
        call("create#mantle.product.asset.Container", {containerId: prefix + "_CART", facilityId: state.room, containerTypeEnumId: null})
        state.moved = asset("MOVED", orgA, state.room, {containerId: prefix + "_CART"})
        state.stock = asset("STOCK", orgA, state.room, {assetTypeEnumId: "AstTpInventory"})
        state.editOnly = user("EDITONLY", ["MAINTENANCE_RESOURCE_EDIT"], orgA)
        // every organization's reader, an agent of A and B, for the list's narrowing to the active organization (F83)
        state.every = user("EVERY", ["MAINTENANCE_RESOURCE_VIEW", "MAINTENANCE_ALL_ORGANIZATIONS"], orgA)
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtAgent",
            fromPartyId: prefix + "_USER_EVERY",
            toPartyId: orgB,
            toRoleTypeId: "OrgInternal",
            fromDate: since
        })
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature("a counting meter refuses a lower reading but takes a reset with its reason; one time holds one reading; a correction changes one", {
    when() {
        const record = parameters =>
            attempt(state.resources, services + "record#MaintenanceMeter", Object.assign({assetId: state.compressor, productMeterId: state.meter}, parameters))
        const first = record({meterValue: 120, readingDate: stamp("2026-03-01 08:00")})
        const second = record({meterValue: 150, readingDate: stamp("2026-04-01 08:00")})
        const lower = record({meterValue: 90, readingDate: stamp("2026-05-01 08:00")})
        const resetNoReason = record({meterValue: 3, readingDate: stamp("2026-05-01 08:00"), readingReasonEnumId: "AmrReset"})
        const reset = record({meterValue: 3, readingDate: stamp("2026-05-01 08:00"), readingReasonEnumId: "AmrReset", changeReason: "Hour meter replaced"})
        const sameTime = record({meterValue: 160, readingDate: stamp("2026-04-01 08:00")})
        const kept = reading(state.compressor, stamp("2026-04-01 08:00"))?.meterValue
        const audit = ec.entity
            .find("moqui.entity.EntityAuditLog")
            .condition({changedEntityName: "mantle.product.maintenance.AssetMeter", changedFieldName: "meterValue", pkPrimaryValue: state.compressor})
            .list()
        const resetReason = Array.from(audit).some(row => String(row.newValueText) === "3" && row.changeReason === "Hour meter replaced")
        const correction = record({
            meterValue: 125,
            readingReasonEnumId: "AmrCorrection",
            changeReason: "Misread",
            correctReadingDate: stamp("2026-03-01 08:00")
        })
        const corrected = reading(state.compressor, stamp("2026-03-01 08:00"))
        const future = record({meterValue: 400, readingDate: stamp("2099-01-01 08:00")})
        const otherMeter = record({meterValue: 1, productMeterId: null, productMeterTypeId: "PdMtrDistance"})
        return {first, second, lower, resetNoReason, reset, sameTime, kept, resetReason, correction, corrected, future, otherMeter}
    },
    then(r) {
        !r.first.refused && !r.second.refused
        r.lower.refused.includes("READING_DECREASING")
        r.resetNoReason.refused.includes("REASON_REQUIRED")
        !r.reset.refused
        r.resetReason
        r.sameTime.refused.includes("READING_EXISTS")
        String(r.kept) == "150"
        r.correction.corrected
        String(r.corrected.meterValue) == "125"
        r.corrected.readingReasonEnumId == "AmrCorrection"
        r.future.refused.includes("DATE_FUTURE")
        r.otherMeter.refused.includes("METER_UNAVAILABLE")
    }
})

feature("the equipment writer refuses a parent cycle, another organization's equipment and a write permission alone", {
    when() {
        const store = (username, parameters) => attempt(username, services + "store#MaintenanceEquipment", parameters)
        const cycle = store(state.resources, {assetId: state.compressor, parentAssetId: state.motor})
        const renamed = store(state.resources, {assetId: state.compressor, assetName: "Compressor C-1", warrantyThruDate: "2027-06-30"})
        const otherRenamed = store(state.resources, {assetId: state.otherPump, assetName: "Compressor C-1", warrantyThruDate: "2027-06-30"})
        const editOnly = store(state.editOnly, {assetId: state.compressor, assetName: "Compressor C-1"})
        const created = store(state.resources, {assetName: "Spec drill", facilityId: state.room, ownerPartyId: orgA})
        const otherOwner = store(state.resources, {assetName: "Spec drill", facilityId: state.room, ownerPartyId: orgB})
        const compressor = ec.entity.find("mantle.product.asset.Asset").condition("assetId", state.compressor).one()
        const madeAsset = created.assetId ? ec.entity.find("mantle.product.asset.Asset").condition("assetId", created.assetId).one() : null
        const listed = attempt(state.resources, services + "find#MaintenanceEquipment", {text: "Maintenance resources"})
        // every organization's reader lists both organizations' equipment, and the active one's alone once chosen (F83)
        const everyIds = () =>
            attempt(state.every, services + "find#MaintenanceEquipment", {text: "Maintenance resources"}).equipmentList.map(row => row.assetId)
        const everyAll = everyIds()
        login(state.every)
        ec.user.setPreference("ACTIVE_ORGANIZATION", orgA)
        login("john.doe")
        const everyActive = everyIds()
        // a record of another organization the holder opens is read in the record check's scope: the facility itself and its
        // equipment, while the roots stay the active organization's
        const everyRecord = attempt(state.every, services + "find#MaintenanceFacilities", {facilityId: state.otherSite}).facilityList
        const everyRoots = attempt(state.every, services + "find#MaintenanceFacilities", {roots: true, text: "Maintenance resources"}).facilityList
        const everyThere = attempt(state.every, services + "find#MaintenanceEquipment", {facilityId: state.otherSite}).equipmentList
        login(state.every)
        ec.user.setPreference("ACTIVE_ORGANIZATION", null)
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const warrantyThru = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js").calendarDateText(compressor.warrantyThruDate)
        return {cycle, renamed, otherRenamed, editOnly, created, otherOwner, compressor, warrantyThru, madeAsset, listed, everyAll, everyActive,
            everyRecord, everyRoots, everyThere}
    },
    then(r) {
        r.cycle.refused.includes("PARENT_CYCLE")
        !r.renamed.refused
        r.compressor.assetName == "Compressor C-1"
        r.warrantyThru == "2027-06-30"
        r.otherRenamed.refused.includes("RECORD_UNAVAILABLE")
        r.editOnly.refused.includes("PERMISSION_DENIED")
        r.created.created
        r.madeAsset.assetTypeEnumId == "AstTpEquipment" && r.madeAsset.statusId == "AstInUse" && r.madeAsset.ownerPartyId == orgA
        r.otherOwner.refused.includes("OWNER_UNAVAILABLE")
        r.listed.equipmentList.some(row => row.assetId == state.motor)
        !r.listed.equipmentList.some(row => row.assetId == state.otherPump)
        r.everyAll.includes(state.otherPump) && r.everyAll.includes(state.motor)
        !r.everyActive.includes(state.otherPump) && r.everyActive.includes(state.motor)
        r.everyRecord.length == 1 && r.everyRecord[0].facilityId == state.otherSite && r.everyRecord[0].facilityName != ""
        !r.everyRoots.some(row => row.facilityId == state.otherSite) && r.everyRoots.some(row => row.facilityId == state.site)
        r.everyThere.some(row => row.assetId == state.otherPump)
    }
})

feature("a custody change takes effect at its date, ending the earlier holding then; a later date is refused", {
    when() {
        const change = parameters =>
            attempt(state.resources, services + "change#MaintenanceCustody", Object.assign({assetId: state.compressor, newPartyId: state.newHolder}, parameters))
        const later = change({effectiveDate: stamp("2099-01-01 09:00")})
        const beforeHolding = change({effectiveDate: stamp("2025-06-01 09:00")})
        const dated = change({effectiveDate: stamp("2026-06-01 09:00")})
        const rows = Array.from(
            ec.entity.find("mantle.product.asset.AssetPartyAssignment").condition({assetId: state.compressor, roleTypeId: "Custodian"}).list()
        )
        const ended = rows.find(row => row.partyId === state.holder)
        const started = rows.find(row => row.partyId === state.newHolder)
        const other = attempt(state.resources, services + "change#MaintenanceCustody", {
            assetId: state.otherPump,
            newPartyId: state.newHolder,
            effectiveDate: stamp("2026-06-01 09:00")
        })
        // an operator who held it from January to March: a new operator from February would be a second holder then
        call("create#mantle.product.asset.AssetPartyAssignment", {
            assetId: state.compressor,
            partyId: state.holder,
            roleTypeId: "Operator",
            fromDate: stamp("2026-01-01 09:00"),
            thruDate: stamp("2026-03-01 09:00")
        })
        const overlapping = change({roleTypeId: "Operator", effectiveDate: stamp("2026-02-01 09:00")})
        const afterIt = change({roleTypeId: "Operator", effectiveDate: stamp("2026-03-02 09:00")})
        // the holder is one of the scope's organizations or their employees, or the asset's owner (the user's call, R7)
        const outsider = change({roleTypeId: "Operator", newPartyId: state.outsider, effectiveDate: stamp("2026-03-03 09:00")})
        const otherOrganization = change({roleTypeId: "Operator", newPartyId: orgB, effectiveDate: stamp("2026-03-03 09:00")})
        const customerOnOurs = change({roleTypeId: "Operator", newPartyId: state.customer, effectiveDate: stamp("2026-03-03 09:00")})
        const organization = change({roleTypeId: "Operator", newPartyId: orgA, effectiveDate: stamp("2026-03-03 09:00")})
        const customerOwn = change({assetId: state.customerUnit, newPartyId: state.customer})
        // the owner service refuses a later date itself (it is on the /mantle REST asset path too)
        const replacedLater = attempt("john.doe", "mantle.product.AssetServices.replace#AssetPartyAssignment", {
            assetId: state.compressor,
            roleTypeId: "Custodian",
            newPartyId: state.holder,
            effectiveDate: stamp("2099-01-01 09:00")
        })
        return {later, beforeHolding, dated, ended, started, other, overlapping, afterIt, replacedLater, outsider, otherOrganization,
            customerOnOurs, organization, customerOwn, expected: stamp("2026-06-01 09:00")}
    },
    then(r) {
        r.later.refused.includes("DATE_FUTURE")
        r.beforeHolding.refused.includes("DATE_BEFORE_HOLDING")
        r.dated.endedCount == 1
        Number(r.ended.thruDate) == Number(r.expected)
        Number(r.started.fromDate) == Number(r.expected)
        r.started.thruDate == null
        r.other.refused.includes("RECORD_UNAVAILABLE")
        r.overlapping.refused.includes("DATE_BEFORE_HOLDING")
        !r.afterIt.refused
        r.replacedLater.refused.includes("DATE_FUTURE")
        r.outsider.refused.includes("HOLDER_UNAVAILABLE")
        r.otherOrganization.refused.includes("HOLDER_UNAVAILABLE")
        r.customerOnOurs.refused.includes("HOLDER_UNAVAILABLE")
        !r.organization.refused
        !r.customerOwn.refused
    }
})

feature("an equipment move needs stock move authority and both facilities, takes equipment only, and is audit-logged out of its container", {
    when() {
        const move = (username, parameters) =>
            attempt(username, services + "move#MaintenanceEquipment", Object.assign({assetId: state.moved, toFacilityId: state.site}, parameters))
        const preview = move(state.resources, {preview: true})
        const noStockMove = move(state.resources, {})
        const stock = move(state.mover, {assetId: state.stock})
        const otherSite = move(state.mover, {toFacilityId: state.otherSite})
        const moved = move(state.mover, {})
        const asset = ec.entity.find("mantle.product.asset.Asset").condition("assetId", state.moved).one()
        const audited = ec.entity
            .find("moqui.entity.EntityAuditLog")
            .condition({changedEntityName: "mantle.product.asset.Asset", changedFieldName: "facilityId", pkPrimaryValue: state.moved})
            .list()
        return {preview, noStockMove, stock, otherSite, moved, asset, audited: Array.from(audited)}
    },
    then(r) {
        r.preview.moved == false && r.preview.effect.toFacilityId == state.site && r.preview.effect.fromFacilityId == state.room
        r.noStockMove.refused.includes("PERMISSION_DENIED")
        r.stock.refused.includes("RECORD_UNAVAILABLE")
        r.otherSite.refused.includes("RECORD_UNAVAILABLE")
        r.moved.moved
        r.asset.facilityId == state.site && r.asset.containerId == null
        r.audited.some(row => row.oldValueText == state.room && row.newValueText == state.site)
    }
})

feature("a facility keeps its capacity, booking and zone, a room inherits the zone, and room features are dated", {
    when() {
        const stored = attempt(state.resources, "mantle.facility.FacilityServices.store#Facility", {
            facilityId: state.room,
            capacity: 12,
            bookable: "Y"
        })
        const badZone = attempt(state.resources, "mantle.facility.FacilityServices.store#Facility", {facilityId: state.room, timeZone: "Mars/Olympus"})
        const room = ec.entity.find("mantle.facility.Facility").condition("facilityId", state.room).one()
        const zone = ec.resource.script("component://mr-mantle/service/mantle/product/MaintenanceResources.js").facilityTimeZone(state.room)
        const feature = parameters =>
            attempt(state.resources, "mantle.facility.FacilityServices.store#FacilityFeature", Object.assign({facilityId: state.room, featureEnumId: "RfProjector"}, parameters))
        const added = feature({})
        const twice = feature({})
        const ended = feature({end: true})
        const rows = Array.from(ec.entity.find("mantle.facility.FacilityFeature").condition({facilityId: state.room}).list())
        const listed = attempt(state.resources, services + "find#MaintenanceFacilities", {bookable: true})
        return {stored, badZone, room, zone, added, twice, ended, rows, listed}
    },
    then(r) {
        !r.stored.refused
        String(r.room.capacity) == "12" && r.room.bookable == "Y"
        r.badZone.refused.includes("VALUE_INVALID")
        r.zone.timeZone == "America/Chicago" && r.zone.inherited
        !r.added.refused
        r.twice.refused.includes("FEATURE_EXISTS")
        !r.ended.refused
        r.rows.length == 1 && r.rows[0].thruDate != null
        r.listed.facilityList.some(row => row.facilityId == state.room && row.timeZoneText == "America/Chicago (inherited)")
    }
})
