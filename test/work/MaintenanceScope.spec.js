// Maintenance scope (mantle/work/MaintenanceAccess.js; IronStone Maintenance design §1.1, impl-maintenance P1): capabilities from
// the maintenance permissions with the reads apart (a write permission alone reads nothing and has no organization), the
// caller's organizations and FACILITY_ALL_ORGANIZATIONS widening them; a facility's organization from its nearest owning
// ancestor and an asset's from its internal owner or its facility (a customer's asset in the organization's custody), each
// refused outside the scope as a missing one is; a work effort's service organization from its root, read broadly with
// MAINTENANCE_VIEW and only when assigned (to the step or its root, a current assignment) with MAINTENANCE_ASSIGNED_VIEW.
// Standalone: spec-local organizations, facilities, assets, work efforts, groups and users, with artifact authorization
// disabled (the rules are the module's own permission and scope checks).
// Run: ./moq test mr-mantle --spec MaintenanceScope
const prefix = "MNT_SCOPE_SPEC"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    customer = prefix + "_CUST",
    since = "2000-01-01T00:00:00Z"
const module = "component://mr-mantle/service/mantle/work/MaintenanceAccess.js"
const state = {}

// the module's answer as a user, or the reason code it refuses with
function as(username, action) {
    login(username)
    ec.artifactExecution.disableAuthz()
    const access = ec.resource.script(module)
    try {
        return action(access, access.scope())
    } catch (error) {
        return access.reasonCode(error) || "ERROR " + error.message
    } finally {
        ec.message.clearErrors()
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}
function organization(partyId, name, roleTypeId) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId})
}
function person(kind) {
    const partyId = prefix + "_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Maintenance scope", lastName: kind})
    return partyId
}
// a user of a spec-local group with the permissions, an agent of the organizations
function user(kind, permissions, organizationPartyIds) {
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Maintenance scope " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    const partyId = person("USER_" + kind)
    for (const organizationPartyId of organizationPartyIds)
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
function facility(suffix, ownerPartyId, parentFacilityId = null) {
    const facilityId = prefix + "_F_" + suffix
    call("create#mantle.facility.Facility", {
        facilityId,
        facilityName: "Maintenance scope " + suffix,
        facilityTypeEnumId: "FcTpBuilding",
        ownerPartyId,
        parentFacilityId
    })
    return facilityId
}
function asset(suffix, ownerPartyId, facilityId) {
    const assetId = prefix + "_AS_" + suffix
    call("create#mantle.product.asset.Asset", {
        assetId,
        assetTypeEnumId: "AstTpEquipment",
        assetName: "Maintenance scope " + suffix,
        ownerPartyId,
        facilityId
    })
    return assetId
}
function work(suffix, fields) {
    const workEffortId = prefix + "_W_" + suffix
    call(
        "create#mantle.work.effort.WorkEffort",
        Object.assign({workEffortId, workEffortTypeEnumId: "WetTask", workEffortName: "Maintenance scope " + suffix}, fields)
    )
    return workEffortId
}
function assign(workEffortId, partyId, thruDate = null) {
    call("create#mantle.work.effort.WorkEffortParty", {workEffortId, partyId, roleTypeId: "Worker", fromDate: since, thruDate})
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(orgA, "Maintenance Scope Spec A", "OrgInternal")
        organization(orgB, "Maintenance Scope Spec B", "OrgInternal")
        organization(customer, "Maintenance Scope Spec Customer", "Customer")
        // A's site with a room that names no owner, B's site
        state.site = facility("SITE", orgA)
        state.room = facility("ROOM", null, state.site)
        state.otherSite = facility("OTHER", orgB)
        // A's pump, a customer's compressor in A's room, B's pump
        state.pump = asset("PUMP", orgA, state.site)
        state.customerAsset = asset("CUST", customer, state.room)
        state.otherPump = asset("OTHER", orgB, state.otherSite)
        state.reader = user("READER", ["MAINTENANCE_VIEW"], [orgA])
        state.planOnly = user("PLANONLY", ["MAINTENANCE_PLAN"], [orgA])
        state.tech = user("TECH", ["MAINTENANCE_ASSIGNED_VIEW", "MAINTENANCE_EXECUTE"], [orgA])
        state.tech2 = user("TECH2", ["MAINTENANCE_ASSIGNED_VIEW", "MAINTENANCE_EXECUTE"], [orgA])
        state.every = user("EVERY", ["MAINTENANCE_VIEW", "FACILITY_ALL_ORGANIZATIONS"], [orgA])
        state.resources = user("RESOURCES", ["MAINTENANCE_RESOURCE_VIEW", "MAINTENANCE_RESOURCE_EDIT"], [orgA])
        // A's root owned by A with a step; B's root; a root with no owner in A's room; the technician assigned to the step only,
        // the second to the root, and the first's ended assignment to B's root
        state.root = work("ROOT", {ownerPartyId: orgA})
        state.step = work("STEP", {parentWorkEffortId: state.root, rootWorkEffortId: state.root})
        state.otherRoot = work("OTHER", {ownerPartyId: orgB})
        state.roomRoot = work("ROOM", {facilityId: state.room})
        assign(state.step, state.TECH_PARTY)
        assign(state.root, state.TECH2_PARTY)
        assign(state.otherRoot, state.TECH_PARTY, "2001-01-01T00:00:00Z")
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature(
    "capabilities come from the permissions, the reads apart; a write permission alone reads nothing and has no organization",
    {
        when() {
            const summary = (access, userScope) => ({
                orgs: userScope.organizationPartyIds == null ? null : Array.from(userScope.organizationPartyIds).sort(),
                all: userScope.allOrganizations,
                held: Object.keys(userScope.capabilities)
                    .filter(name => userScope.capabilities[name])
                    .sort()
            })
            return {
                reader: as(state.reader, summary),
                planOnly: as(state.planOnly, summary),
                tech: as(state.tech, summary),
                every: as(state.every, summary),
                resources: as(state.resources, summary),
                unknown: as(state.reader, (access, userScope) => {
                    try {
                        access.requireCapability(userScope, "nothing")
                        return "given"
                    } catch (error) {
                        return String(error.message)
                    }
                }),
                planRequired: as(state.reader, (access, userScope) => access.requireCapability(userScope, "plan"))
            }
        },
        then({reader, planOnly, tech, every, resources, unknown, planRequired}) {
            reader.orgs == [orgA]
            reader.all == false
            reader.held == ["anyRead", "resourceRead", "view", "workRead"]
            planOnly.orgs == []
            planOnly.held == ["plan"]
            tech.orgs == [orgA]
            tech.held == ["anyRead", "assignedView", "execute", "resourceRead", "workRead"]
            every.orgs == null
            every.all == true
            resources.held == ["anyRead", "resourceEdit", "resourceRead", "resourceView"]
            unknown.includes("Unknown maintenance capability")
            planRequired == "PERMISSION_DENIED"
        }
    }
)

feature("a facility's and an asset's organization; one outside the scope is refused as a missing one is", {
    when() {
        const check = (username, kind, id) =>
            as(username, (access, userScope) =>
                kind === "facility"
                    ? access.requireFacility(userScope, id).organizationPartyId
                    : kind === "asset"
                      ? access.requireAsset(userScope, id).organizationPartyId
                      : access.requireOrganization(userScope, id)
            )
        return {
            room: check(state.reader, "facility", state.room),
            otherSite: check(state.reader, "facility", state.otherSite),
            missingFacility: check(state.reader, "facility", prefix + "_NONE"),
            pump: check(state.reader, "asset", state.pump),
            customerAsset: check(state.reader, "asset", state.customerAsset),
            otherPump: check(state.reader, "asset", state.otherPump),
            missingAsset: check(state.reader, "asset", prefix + "_NONE"),
            orgA: check(state.reader, "organization", orgA),
            orgB: check(state.reader, "organization", orgB),
            planOnlyFacility: check(state.planOnly, "facility", state.site),
            everyOther: check(state.every, "asset", state.otherPump),
            techPump: check(state.tech, "asset", state.pump)
        }
    },
    then(found) {
        found.room == orgA
        found.otherSite == "RECORD_UNAVAILABLE"
        found.missingFacility == "RECORD_UNAVAILABLE"
        found.pump == orgA
        found.customerAsset == orgA
        found.otherPump == "RECORD_UNAVAILABLE"
        found.missingAsset == "RECORD_UNAVAILABLE"
        found.orgA == orgA
        found.orgB == "ORGANIZATION_DENIED"
        found.planOnlyFacility == "PERMISSION_DENIED"
        found.everyOther == orgB
        found.techPump == orgA
    }
})

feature("work is read broadly in its root's organization, and by a technician only where assigned to the step or its root", {
    when() {
        const read = (username, workEffortId) =>
            as(username, (access, userScope) => {
                const found = access.requireWork(userScope, workEffortId)
                return found.rootWorkEffortId + " " + found.organizationPartyId
            })
        return {
            readerStep: read(state.reader, state.step),
            readerRoom: read(state.reader, state.roomRoot),
            readerOther: read(state.reader, state.otherRoot),
            readerMissing: read(state.reader, prefix + "_NONE"),
            techStep: read(state.tech, state.step),
            techRoot: read(state.tech, state.root),
            techOther: read(state.tech, state.otherRoot),
            tech2Step: read(state.tech2, state.step),
            planOnly: read(state.planOnly, state.root),
            techAssignment: as(state.tech, (access, userScope) => access.assignment(userScope, state.step)),
            tech2Assignment: as(state.tech2, (access, userScope) => access.assignment(userScope, state.step)),
            techRootAssignment: as(state.tech, (access, userScope) => access.assignment(userScope, state.root))
        }
    },
    then(found) {
        found.readerStep == state.root + " " + orgA
        found.readerRoom == state.roomRoot + " " + orgA
        found.readerOther == "RECORD_UNAVAILABLE"
        found.readerMissing == "RECORD_UNAVAILABLE"
        found.techStep == state.root + " " + orgA
        found.techRoot == "NOT_ASSIGNED"
        // the technician's assignment to B's root has ended, and B is not their organization
        found.techOther == "RECORD_UNAVAILABLE"
        found.tech2Step == state.root + " " + orgA
        found.planOnly == "PERMISSION_DENIED"
        found.techAssignment.root == false
        found.techAssignment.step == true
        found.tech2Assignment.root == true
        found.tech2Assignment.step == true
        found.techRootAssignment.root == false
        found.techRootAssignment.step == false
    }
})
