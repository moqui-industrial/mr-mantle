// Shared devices within an organization's scope (service/mantle/party/SharedDevices.js, mantle.party.IdentityServices; mr-boss
// impl-admin P18, design-admin §6 Devices, crosscut CX-DEVICE): a display account is made with a party, a member relationship
// to an organization the operator administers, nothing that signs it in and the proposal's registered bundles, so the
// organization filters show it that organization (setup#UserOrganizationInfo, impl-admin F33); a device is registered, its code
// shown once, listed and revoked only for a display account in the registrar's identity scope, another organization's being
// not available and counted, never named. The credential itself (the code, the cookie, the route gate) is the framework's
// (DeviceCredential spec, user::device::tests). The operators hold the framework's permissions through spec groups, never an
// app group, and call under the services' ALL_USERS grant (MANTLE_USER_ORG). New spec, no Groovy original.
// Run: ./moq test mr-mantle --spec party/SharedDevices
const S = "mantle.party.IdentityServices."
const dayMillis = 86400000
const effectiveTime = Date.now()
let orgId
let otherOrgId
let display
let otherDisplay
let registered

function result(name, params) {
    try {
        const out =
            ec.service
                .sync()
                .name(name)
                .parameters(params || {})
                .call() || {}
        const error = ec.message.hasError() ? ec.message.getErrorsString() : ""
        ec.message.clearErrors()
        return Object.assign({}, out, {error})
    } catch (e) {
        ec.message.clearErrors()
        return {error: String(e.message)}
    }
}
function as(username, run) {
    login(username, "moqui1!!")
    ec.artifactExecution.enableAuthz()
    try {
        return run()
    } finally {
        ec.artifactExecution.disableAuthz()
        login("john.doe")
    }
}
const rows = (entityName, conditions) => Array.from(ec.entity.find(entityName).condition(conditions).disableAuthz().list())

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.artifactExecution.enableAuthz()
        login("john.doe")
    }
})

feature("an identity operator makes a display account of its own organization, with no sign-in and only assignable access", {
    when() {
        orgId = call("mantle.party.PartyServices.create#Organization", {organizationName: "Device One Co", roleTypeId: "OrgInternal"}).partyId
        otherOrgId = call("mantle.party.PartyServices.create#Organization", {organizationName: "Device Two Co", roleTypeId: "OrgInternal"}).partyId
        call("create#moqui.security.UserGroup", {userGroupId: "SDV_OPERATORS", description: "Spec device operators"})
        for (const permission of ["ADMIN_IDENTITY_VIEW", "ADMIN_IDENTITY_MANAGE", "ADMIN_ACCESS_VIEW", "ADMIN_ACCESS_MANAGE"])
            call("create#moqui.security.UserGroupPermission", {userGroupId: "SDV_OPERATORS", userPermissionId: permission, fromDate: effectiveTime - dayMillis})
        // a registered bundle an app would supply for a display, and a privileged group
        call("create#moqui.security.UserGroup", {userGroupId: "SDV_READERS", description: "Spec display readers"})
        call("create#moqui.security.CapabilityBundle", {userGroupId: "SDV_READERS", appName: "Spec", description: "Spec display readers"})
        const person = (key, username, org) => {
            const partyId = call("mantle.party.PartyServices.create#Person", {firstName: key, lastName: "Devices"}).partyId
            const userId = call("mantle.party.PartyServices.create#PartyUserAccount", {
                partyId,
                emailAddress: username + "@example.com",
                username,
                newPassword: "moqui1!!",
                newPasswordVerify: "moqui1!!"
            }).userId
            call("create#mantle.party.PartyRelationship", {
                relationshipTypeEnumId: "PrtEmployee",
                fromPartyId: partyId,
                toPartyId: org,
                toRoleTypeId: "OrgInternal",
                fromDate: effectiveTime - dayMillis
            })
            call("create#moqui.security.UserGroupMember", {userGroupId: "SDV_OPERATORS", userId, fromDate: effectiveTime - dayMillis})
            return userId
        }
        person("One", "sdv.one", orgId)
        person("Two", "sdv.two", otherOrgId)
        call("create#moqui.security.ArtifactGroup", {artifactGroupId: "SDV_SCREENS", description: "Spec wall screens"})
        call("create#moqui.security.DeviceRouteGroup", {routeGroupId: "SDV_WALLS", description: "Spec walls", artifactGroupId: "SDV_SCREENS"})
        const out = as("sdv.one", () => ({
            foreign: result(S + "create#DisplayAccount", {displayName: "Other wall", organizationPartyId: otherOrgId, bundleGroupIdList: ["SDV_READERS"]}),
            privileged: result(S + "create#DisplayAccount", {displayName: "Root wall", organizationPartyId: orgId, bundleGroupIdList: ["ADMIN"]}),
            created: result(S + "create#DisplayAccount", {displayName: "Plant wall", organizationPartyId: orgId, bundleGroupIdList: ["SDV_READERS"]})
        }))
        display = out.created
        otherDisplay = as("sdv.two", () =>
            result(S + "create#DisplayAccount", {displayName: "Office wall", organizationPartyId: otherOrgId, bundleGroupIdList: ["SDV_READERS"]})
        )
        // what the organization filters give a request running as the display account
        out.organizations = (() => {
            const account = rows("moqui.security.UserAccount", {userId: display.userId})[0]
            return call("mantle.party.PartyServices.get#PartyInternalOrgIds", {partyId: account.partyId})
        })()
        return out
    },
    then({foreign, privileged, created, organizations}) {
        foreign.error.includes("RECORD_UNAVAILABLE")
        privileged.applied === false || privileged.error != ""
        rows("moqui.security.UserAccount", {username: "display.root.wall"}).length == 0
        created.error == "" && created.applied === true && created.username == "display.plant.wall"
        const account = rows("moqui.security.UserAccount", {userId: created.userId})[0]
        account.displayAccount == "Y" && account.currentPassword == null && account.emailAddress == null
        rows("moqui.security.UserGroupMember", {userId: created.userId}).map(row => row.userGroupId).join() == "SDV_READERS"
        rows("mantle.party.PartyRelationship", {fromPartyId: created.partyId, toPartyId: orgId, relationshipTypeEnumId: "PrtMember"}).length == 1
        JSON.stringify(organizations).includes(orgId) && !JSON.stringify(organizations).includes(otherOrgId)
        otherDisplay.applied === true
    }
})

feature("a device is registered, shown its code once, listed and revoked only within the registrar's organizations", {
    when() {
        const device = {deviceName: "Spec plant wall", routeGroupId: "SDV_WALLS", issueCode: false}
        const out = as("sdv.one", () => {
            const found = {
                displays: result(S + "find#DisplayAccounts"),
                foreign: result(S + "register#SharedDevice", Object.assign({displayUserId: otherDisplay.userId}, device))
            }
            registered = result(S + "register#SharedDevice", Object.assign({displayUserId: display.userId}, device))
            found.shown = result(S + "reveal#SharedDeviceCode", {deviceId: registered.deviceId})
            found.shownAgain = result(S + "reveal#SharedDeviceCode", {deviceId: registered.deviceId})
            return found
        })
        const other = as("sdv.two", () => ({
            devices: result(S + "find#SharedDevices", {}),
            reveal: result(S + "reveal#SharedDeviceCode", {deviceId: registered.deviceId}),
            revoke: result(S + "revoke#SharedDevice", {deviceId: registered.deviceId})
        }))
        out.afterForeign = rows("moqui.security.DeviceCredential", {deviceId: registered.deviceId})[0].revokedDate
        Object.assign(
            out,
            as("sdv.one", () => ({
                devices: result(S + "find#SharedDevices", {}),
                revoked: result(S + "revoke#SharedDevice", {deviceId: registered.deviceId, reason: "Spec"})
            }))
        )
        out.other = other
        return out
    },
    then({displays, foreign, shown, shownAgain, afterForeign, devices, revoked, other}) {
        displays.displayAccountList.map(row => row.userId).join() == display.userId
        displays.displayAccountList[0].usable === true && displays.displayAccountList[0].organizations == "Device One Co"
        displays.otherCount >= 1 && !JSON.stringify(displays).includes("Office wall")
        foreign.applied === false && foreign.reasonCode == "DISPLAY_ACCOUNT_UNAVAILABLE"
        registered.error == "" && registered.applied === true && !registered.registrationCode
        ;/^[a-z2-9]{4}(-[a-z2-9]{4}){4}$/.test(shown.registrationCode)
        shownAgain.applied === false && shownAgain.reasonCode == "CODE_SHOWN"
        // the other organization's registrar: the device is counted, not listed, and not theirs to see a code of or revoke
        other.devices.deviceList.length == 0 && other.devices.otherCount == 1
        other.reveal.applied === false && other.reveal.reasonCode == "DEVICE_UNAVAILABLE"
        other.revoke.applied === false && other.revoke.reasonCode == "DEVICE_UNAVAILABLE"
        afterForeign == null
        devices.deviceList.length == 1 && devices.deviceList[0].organizations == "Device One Co" && devices.deviceList[0].state == "pending"
        !JSON.stringify(devices).includes(shown.registrationCode)
        revoked.applied === true
        rows("moqui.security.DeviceCredential", {deviceId: registered.deviceId})[0].revokedDate != null
    }
})
