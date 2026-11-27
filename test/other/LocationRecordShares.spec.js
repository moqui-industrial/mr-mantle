// A technician's location shared with a work order's customer by a guest link (mr-moqui plans/Location-Sharing.md §3.7;
// mantle.other.LocationShareServices, LocationRecordShares.js, entity/LocationShare.eecas.xml): only a technician assigned
// to the open customer repair shares, until no later than its planned end; the share is the framework's, made as the
// technician with a link audience, names the work order, and the link (its secret in the fragment) is mailed to the
// customer; a work order with no customer, another technician and a delivery are refused; the work order's completion
// stops the share, and its guest page then refuses the link. Standalone: spec-local organization, customer, users and work
// orders, the services called as each user with the artifact check aside (their own permission and scope checks decide).
// Run: ./moq test mr-mantle --spec LocationRecordShares
const prefix = "LRS"
const org = prefix + "_ORG",
    customer = prefix + "_CUST",
    since = "2000-01-01T00:00:00Z"
const L = "mantle.other.LocationShareServices."
const F = "org.moqui.maps.LocationServices."
const hour = 3600000
const state = {}
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const nowMs = () => ec.user.timestampMillis(ec.user.nowTimestamp)

// a call as a user: its result with its reason code ("" when it succeeds), in its own transaction
function run(username, service, parameters) {
    login(username)
    ec.artifactExecution.disableAuthz()
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(service).parameters(parameters).requireNewTransaction(true).call() || {}
        const error = ec.message.hasError() ? ec.message.getErrorsString() : ""
        return Object.assign({}, out, {error, code: (/([A-Z][A-Z0-9_]+):/.exec(error) || [])[1] || (error ? "ERROR" : "")})
    } catch (thrown) {
        const error = String(thrown.message || thrown)
        return {error, code: (/([A-Z][A-Z0-9_]+):/.exec(error) || [])[1] || "ERROR"}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}
function party(partyId, name, roleTypeId, typeId = "PtyOrganization") {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: typeId})
    if (typeId === "PtyOrganization") call("create#mantle.party.Organization", {partyId, organizationName: name})
    else call("create#mantle.party.Person", {partyId, firstName: name, lastName: "Spec"})
    if (roleTypeId) call("create#mantle.party.PartyRole", {partyId, roleTypeId})
}
function email(partyId, address) {
    const contactMechId = call("create#mantle.party.contact.ContactMech", {contactMechTypeEnumId: "CmtEmailAddress", infoString: address}).contactMechId
    call("create#mantle.party.contact.PartyContactMech", {partyId, contactMechId, contactMechPurposeId: "EmailPrimary", fromDate: since})
}
function user(kind, permissions) {
    const id = prefix + "_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Location record shares " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    party(id, "Tech " + kind, null, "PtyPerson")
    call("create#mantle.party.PartyRelationship", {relationshipTypeEnumId: "PrtAgent", fromPartyId: id, toPartyId: org,
        toRoleTypeId: "OrgInternal", fromDate: since})
    call("create#moqui.security.UserAccount", {userId: id, username: id, partyId: id, userFullName: "Tech " + kind,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394", passwordHashType: "SHA", timeZone: "America/Chicago"})
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: since})
    return id
}
// an open work order of the organization, assigned to the technician, ending in four hours; a customer repair (its claim's
// customer the spec's) when repair is true
function workOrder(key, repair) {
    const workEffortId = prefix + "_WO_" + key
    const fields = {workEffortId, workEffortTypeEnumId: "WetTask", purposeEnumId: "WepMaintenance", statusId: "WeInProgress",
        ownerPartyId: org, workEffortName: "Heater repair " + key, estimatedStartDate: new Date(nowMs() - hour),
        estimatedCompletionDate: new Date(nowMs() + 4 * hour)}
    call("create#mantle.work.effort.WorkEffort", fields)
    let assetMaintenanceId = null
    if (repair) {
        const assetId = prefix + "_ASSET_" + key
        call("create#mantle.product.asset.Asset", {assetId, assetTypeEnumId: "AstTpInventory", ownerPartyId: customer, statusId: "AstDelivered"})
        assetMaintenanceId = prefix + "_AM_" + key
        call("create#mantle.product.maintenance.AssetMaintenance", {assetMaintenanceId, assetId, statusId: "AsMntInProcess"})
        const requestId = prefix + "_CLAIM_" + key
        call("create#mantle.request.Request", {requestId, requestTypeEnumId: "RqtWarranty", statusId: "ReqSubmitted", requestName: "Claim " + key})
        call("create#mantle.request.RequestRecord", {requestId, recordEntityName: "mantle.product.maintenance.AssetMaintenance", recordId: assetMaintenanceId})
        call("create#mantle.request.RequestParty", {requestId, partyId: customer, roleTypeId: "Customer", fromDate: since})
    }
    call("create#mantle.work.maintenance.MaintenanceWorkOrder", {workEffortId, sourceEnumId: repair ? "MsrcWarranty" : null, assetMaintenanceId})
    call("create#mantle.work.effort.WorkEffortParty", {workEffortId, partyId: state.tech, roleTypeId: "Assignee", fromDate: since})
    return workEffortId
}
const shareOf = shareId => one("moqui.maps.LocationShare", {shareId})

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        party(org, "Location Shares Service Org", "OrgInternal")
        email(org, "service@location-shares-org.example")
        party(customer, "Location Customer", "Customer", "PtyPerson")
        email(customer, "customer@location-shares.example")
        state.tech = user("TECH", ["MAINTENANCE_ASSIGNED_VIEW", "MAINTENANCE_EXECUTE"])
        state.otherTech = user("TECH2", ["MAINTENANCE_ASSIGNED_VIEW", "MAINTENANCE_EXECUTE"])
        state.repair = workOrder("REPAIR", true)
        state.plain = workOrder("PLAIN", false)
    },
    cleanupSpec() {
        login("john.doe")
    }
})

feature("the assigned technician shares their location with the repair's customer until no later than its planned end", {
    when() {
        const tooLate = run(state.tech, L + "create#RecordGuestShare", {recordType: "workOrder", recordId: state.repair,
            thruDate: new Date(nowMs() + 5 * hour), baseUrl: "https://boss.example.com"})
        const made = run(state.tech, L + "create#RecordGuestShare", {recordType: "workOrder", recordId: state.repair,
            thruDate: new Date(nowMs() + 2 * hour), purposeText: "About 20 minutes away", baseUrl: "https://boss.example.com"})
        state.made = made
        const share = shareOf(made.shareId)
        const mail = Array.from(find("moqui.basic.email.EmailMessage", {emailTemplateId: "MANTLE_LOCATION_GUEST_LINK"}).list())
            .find(row => String(row.toAddresses || "").includes("customer@location-shares.example"))
        return {tooLate, made, share, mail}
    },
    then({tooLate, made, share, mail}) {
        tooLate.code == "END_AFTER_PLANNED" && tooLate.shareId == null
        made.error == ""
        /^https:\/\/boss\.example\.com\/location\/[A-Za-z0-9_-]{16}#[A-Za-z0-9_-]{32}$/.test(made.linkUrl)
        // the framework's share, the technician's own, for the work order
        share.ownerUserId == state.tech && share.recordAdapterKey == "maintenanceWorkOrder"
        JSON.parse(share.recordKey).workEffortId == state.repair
        share.purposeText == "About 20 minutes away"
        // the link mailed to the customer by the organization
        made.mailSent == true && mail != null && String(mail.body || "").includes(made.linkUrl)
    }
})

feature("another technician, a work order with no customer and a delivery are refused", {
    when() {
        const other = run(state.otherTech, L + "create#RecordGuestShare", {recordType: "workOrder", recordId: state.repair,
            baseUrl: "https://boss.example.com"})
        const plain = run(state.tech, L + "create#RecordGuestShare", {recordType: "workOrder", recordId: state.plain,
            baseUrl: "https://boss.example.com"})
        const delivery = run(state.tech, L + "create#RecordGuestShare", {recordType: "delivery", recordId: "ANY",
            baseUrl: "https://boss.example.com"})
        const shares = find("moqui.maps.LocationShare").condition("ownerUserId", "in", [state.tech, state.otherTech]).count()
        return {other, plain, delivery, shares}
    },
    then({other, plain, delivery, shares}) {
        other.code == "NOT_ASSIGNED" && other.shareId == null
        plain.code == "NO_CUSTOMER"
        delivery.code == "RECORD_KIND_NOT_READY"
        // only the first feature's share was made
        shares == 1
    }
})

feature("the work order's completion stops its guest share, and the guest page then refuses the link", {
    when() {
        const [path, secret] = state.made.linkUrl.split("#")
        const selector = path.split("/").pop()
        const before = run("john.doe", F + "get#LinkShare", {linkKey: selector, linkSecret: secret})
        const order = one("mantle.work.effort.WorkEffort", {workEffortId: state.repair})
        order.statusId = "WeComplete"
        order.update()
        const share = shareOf(state.made.shareId)
        ec.user.logoutUser()
        const after = ec.service.sync().name(F + "get#LinkShare").parameters({linkKey: selector, linkSecret: secret}).call() || {}
        login("john.doe")
        const again = run(state.tech, L + "create#RecordGuestShare", {recordType: "workOrder", recordId: state.repair,
            baseUrl: "https://boss.example.com"})
        return {before, share, after, again}
    },
    then({before, share, after, again}) {
        before.statusCode == 200
        share.endedDate != null && share.revokedDate != null
        after.statusCode == 410 && after.reasonCode == "SHARE_ENDED"
        again.code == "WORK_CLOSED"
    }
})
