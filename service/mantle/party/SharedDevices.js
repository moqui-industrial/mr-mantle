// Shared devices within an organization's scope (mantle.party.IdentityServices create#DisplayAccount, find#DisplayAccounts,
// find#SharedDevices, register#SharedDevice, reveal#SharedDeviceCode, revoke#SharedDevice; mr-boss plan/design-admin.md §6 Devices, design-crosscut
// CX-DEVICE, impl-admin P18). The framework's device credential (org.moqui.admin.DeviceServices; mr-moqui
// docs/security/Shared-Devices.md) knows no organization: a device runs as a display account, and what it shows is what that
// account's party works for. So here:
// - a display account is made with a Person party and a member relationship to an internal organization the caller
//   administers (store#OrganizationMembership), so setup#UserOrganizationInfo gives it that organization and MANTLE_USER_ORG
//   and an app's row filters show it that organization's rows and no other's (impl-admin F33); it has no email, no password
//   and nothing that signs it in (UserAccount.displayAccount), and the registered bundles of a grant proposal, never a
//   privileged group or a sealed permission;
// - a device is listed, registered and revoked only when its display account is in the caller's identity scope (Identity.js:
//   the organization entity filters of the authorization the call runs under); another organization's display account, and
//   its devices, are refused as not available and counted, never named; a display account that also shows an organization
//   the caller does not administer needs ADMIN_IDENTITY_GLOBAL to register a device for;
// - the site a device is at is a Facility the caller reads.
// Permissions are the framework's: ADMIN_IDENTITY_MANAGE to make a display account (an account and an organization
// membership are identity records), ADMIN_ACCESS_VIEW and ADMIN_ACCESS_MANAGE for devices (the framework's services check
// them again).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, denied} = lib
const access = lib.access
const identity = ec.resource.script("component://mr-mantle/service/mantle/party/Identity.js")
const ACCOUNT = "moqui.security.UserAccount"
const DEVICE = "moqui.security.DeviceCredential"
const D = "org.moqui.admin.DeviceServices."
const text = value => String(value ?? "").trim()
const refused = (reasonCode, reason, extra = {}) => Object.assign({applied: false, reasonCode, reason}, extra)
const ms = value => (value == null || value === "" ? null : value instanceof Date ? value.getTime() : new Date(value).getTime())

function requireAny(permissions) {
    if (!ec.user.userId) denied("SIGN_IN", "Sign in to administer devices")
    if (!permissions.some(permission => access.has(permission))) denied("PERMISSION_DENIED", permissions[0] + " is required")
}
// a framework service called with authorization on; an error is the caller's
function callAuthorized(name, parameters) {
    const out = ec.service.sync().name(name).parameters(parameters).call() || {}
    if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
    return out
}
function partyName(partyId) {
    const organization = one("mantle.party.Organization", {partyId})
    return organization?.organizationName || partyId
}
// The display accounts in the caller's identity scope: Map of userId to the organizations in scope; an instance administrator
// with every organization in scope also has those of no organization.
function scopedDisplays() {
    const accounts = rows(ACCOUNT, {displayAccount: "Y"})
    const found = identity.scopedOrganizations(accounts.map(account => account.userId))
    if (identity.scope().all && !ec.user.context.activeOrgId)
        for (const account of accounts) if (!found.has(account.userId)) found.set(account.userId, [])
    return {accounts, found}
}
// The display account as the caller may use it: null when it is no display account or out of scope.
function displayInScope(userId) {
    const account = text(userId) ? one(ACCOUNT, {userId: text(userId)}) : null
    if (!account || account.displayAccount !== "Y") return null
    try {
        return identity.identity(account.userId)
    } catch (error) {
        if (error.reason !== "RECORD_UNAVAILABLE") throw error
        return null
    }
}

// ===== create#DisplayAccount =====
function createDisplayAccount(p) {
    requireAny(["ADMIN_IDENTITY_MANAGE"])
    const displayName = text(p.displayName)
    if (!displayName || displayName.length > 100 || /[\u0000-\u001f\u007f]|\$\{/.test(displayName))
        throw new Error("Name the display in at most 100 characters")
    const organizationPartyId = text(p.organizationPartyId)
    if (!organizationPartyId || !identity.scope().organizationIds.includes(organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Organization " + organizationPartyId + " is not available")
    const bundleGroupIdList = Array.from(p.bundleGroupIdList || [])
        .map(text)
        .filter(Boolean)
    if (!bundleGroupIdList.length) throw new Error("Choose what the display may read")
    const slug = displayName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ".")
        .replace(/^\.+|\.+$/g, "")
    const username = text(p.username) || "display." + (slug || "screen")
    if (!/^[A-Za-z0-9._-]{3,80}$/.test(username)) throw new Error("A username is 3 to 80 letters, digits, dots, dashes or underscores")
    if (find(ACCOUNT).condition("username", username).count() > 0)
        return refused("USERNAME_EXISTS", "Username " + username + " is already in use")
    const proposal = callAuthorized("org.moqui.admin.AccessServices.check#GrantProposal", {bundleGroupIdList})
    if (!proposal.allowed) return refused(proposal.reasonCode, proposal.reason, {bundleList: proposal.bundleList})
    const reason = text(p.reason).slice(0, 255) || null
    const partyId = callAuthorized("mantle.party.PartyServices.create#Person", {firstName: displayName, lastName: "(display)"}).partyId
    const relationship = identity.execute("storeOrganizationMembership", {
        partyId,
        organizationPartyId,
        relationshipTypeEnumId: "PrtMember",
        reason
    })
    if (!relationship.applied) throw new Error(relationship.reason)
    const account = ec.entity.makeValue(ACCOUNT)
    account.setSequencedIdPrimary()
    account.setFields({username, userFullName: displayName, partyId, displayAccount: "Y", disabled: "N"}, true, null, null)
    account.create()
    const userId = account.get("userId")
    const applied = callAuthorized("org.moqui.admin.AccessServices.apply#GrantProposal", {userId, bundleGroupIdList, reason})
    if (!applied.applied) throw new Error(applied.reason)
    // the account must be one a device may run as (no privileged group, no sealed permission): else nothing is kept
    const unfit = UserSecurityChecks.displayAccountRefusal(userId)
    if (unfit) throw new Error("A display account cannot hold that access: " + unfit)
    ec.logger.info("Display account " + username + " created by " + ec.user.username + " for " + organizationPartyId)
    return {applied: true, reasonCode: null, reason: null, userId, partyId, username, addedGroupIds: applied.addedGroupIds}
}

// ===== find#DisplayAccounts =====
function findDisplayAccounts(p) {
    requireAny(["ADMIN_ACCESS_VIEW", "ADMIN_ACCESS_MANAGE", "ADMIN_IDENTITY_VIEW"])
    const {accounts, found} = scopedDisplays()
    const at = Date.now()
    const list = accounts
        .filter(account => found.has(account.userId))
        .map(account => {
            const groups = rows("moqui.security.UserGroupMember", {userId: account.userId})
                .filter(row => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at)
                .map(row => one("moqui.security.UserGroup", {userGroupId: row.userGroupId})?.description || row.userGroupId)
            const unfit = UserSecurityChecks.displayAccountRefusal(account.userId)
            const organizations = found.get(account.userId)
            return {
                userId: account.userId,
                username: account.username || "",
                displayName: account.userFullName || account.username || account.userId,
                organizations: organizations.map(partyName).join(", "),
                organizationPartyIds: organizations,
                groups: groups.sort().join(", "),
                usable: !unfit,
                unusableReason: unfit || null,
                label: (account.userFullName || account.username) + (organizations.length ? " — " + organizations.map(partyName).join(", ") : "")
            }
        })
        .sort((a, b) => a.displayName.localeCompare(b.displayName))
    return {displayAccountList: list, otherCount: accounts.length - list.length}
}

// ===== find#SharedDevices =====
function findSharedDevices(p) {
    requireAny(["ADMIN_ACCESS_VIEW", "ADMIN_ACCESS_MANAGE"])
    const {found} = scopedDisplays()
    const out = callAuthorized(
        D + "find#Devices",
        Object.assign({}, p, {displayUserIdList: Array.from(found.keys()).concat(["_NA_"])})
    )
    const facilities = new Map()
    const facilityName = facilityId => {
        if (!facilityId) return ""
        if (!facilities.has(facilityId))
            facilities.set(facilityId, ec.entity.find("mantle.facility.Facility").condition("facilityId", facilityId).one()?.facilityName || "")
        return facilities.get(facilityId)
    }
    for (const row of Array.from(out.deviceList || [])) {
        row.organizations = (found.get(row.displayUserId) || []).map(partyName).join(", ")
        row.facilityName = facilityName(row.facilityId)
    }
    return out
}

// ===== register#SharedDevice =====
function registerSharedDevice(p) {
    requireAny(["ADMIN_ACCESS_MANAGE"])
    const display = displayInScope(p.displayUserId)
    if (!display) return refused("DISPLAY_ACCOUNT_UNAVAILABLE", "That display account is not available")
    const shared = identity.accountWideRefusal(display)
    if (shared)
        return refused(
            "IDENTITY_GLOBAL",
            (display.account.userFullName || display.account.username) +
                " also shows an organization you do not administer: registering a device for it needs ADMIN_IDENTITY_GLOBAL"
        )
    const facilityId = text(p.facilityId)
    // a site the caller reads, under the organization filters of the call
    if (facilityId && !ec.entity.find("mantle.facility.Facility").condition("facilityId", facilityId).one())
        return refused("FACILITY_UNAVAILABLE", "That site is not available")
    return callAuthorized(D + "register#Device", {
        deviceName: p.deviceName,
        routeGroupId: p.routeGroupId,
        displayUserId: display.account.userId,
        parameterValue: p.parameterValue,
        facilityId: facilityId || null,
        ipAllowed: p.ipAllowed,
        idleTimeoutMinutes: p.idleTimeoutMinutes,
        lifetimeDays: p.lifetimeDays,
        codeMinutes: p.codeMinutes,
        issueCode: p.issueCode,
        operationKey: p.operationKey,
        reason: p.reason
    })
}

// ===== reveal#SharedDeviceCode =====
function revealSharedDeviceCode(p) {
    requireAny(["ADMIN_ACCESS_MANAGE"])
    const device = text(p.deviceId) ? one(DEVICE, {deviceId: text(p.deviceId)}) : null
    if (!device || !scopedDisplays().found.has(device.displayUserId))
        return refused("DEVICE_UNAVAILABLE", "That device is not available")
    return callAuthorized(D + "issue#DeviceCode", {deviceId: device.deviceId, codeMinutes: p.codeMinutes})
}

// ===== revoke#SharedDevice =====
function revokeSharedDevice(p) {
    requireAny(["ADMIN_ACCESS_MANAGE"])
    const device = text(p.deviceId) ? one(DEVICE, {deviceId: text(p.deviceId)}) : null
    // a device whose display account is out of scope is not available, as one that does not exist
    if (!device || !scopedDisplays().found.has(device.displayUserId))
        return refused("DEVICE_UNAVAILABLE", "That device is not available")
    return callAuthorized(D + "revoke#Device", {deviceId: device.deviceId, reason: p.reason})
}

const operations = {
    createDisplayAccount,
    findDisplayAccounts,
    findSharedDevices,
    registerSharedDevice,
    revealSharedDeviceCode,
    revokeSharedDevice
}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown shared device operation " + op)
        return operations[op](parameters)
    }
})
