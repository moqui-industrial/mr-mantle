// A technician's location shared with a work order's customer by a guest link (mr-moqui plans/Location-Sharing.md §3.7;
// mantle.other.LocationShareServices, LocationRecordShares.js, entity/LocationShare.eecas.xml): only the technician
// assigned (Assignee) to the open customer repair shares, until no later than its planned end; the share is the
// framework's, made as the technician with a link audience, names the work order and its end; the customer is mailed only
// by send#RecordGuestLink, with the share's own link, once; another technician, another organization's assigned
// technician, a work order with no customer, an overdue one and a delivery are refused; the work order's completion
// stops the share, its guest page then refuses the link, and the mail kept for the queue no longer holds the secret; a
// cancellation stops a share too. Standalone: spec-local organizations, customer, users and work orders; the services
// called in a request (LocationRecordSharesSpecScreen.xml: the link starts with this server's web root) as each user,
// with the artifact check aside (their own permission and scope checks decide).
// Run: ./moq test mr-mantle --spec LocationRecordShares
const prefix = "LRS"
const org = prefix + "_ORG",
    otherOrg = prefix + "_OTHER_ORG",
    customer = prefix + "_CUST",
    since = "2000-01-01T00:00:00Z"
const F = "org.moqui.maps.LocationServices."
const SCREEN = "component://mr-mantle/test/other/LocationRecordSharesSpecScreen.xml"
const TEMPLATE = "MANTLE_LOCATION_GUEST_LINK"
const hour = 3600000
const state = {}
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const nowMs = () => ec.user.timestampMillis(ec.user.nowTimestamp)
const codeOf = error => (/([A-Z][A-Z0-9_]+):/.exec(error || "") || [])[1] || (error ? "ERROR" : "")

// one of the record share services as a user, in a request: its result, its error and reason code
function run(username, op, parameters) {
    login(username)
    try {
        const rendered = ec.screen.makeTest().rootScreen(SCREEN).render("call", Object.assign({op}, parameters), "post")
        ec.message.clearErrors()
        const answer = JSON.parse(String(rendered.output || "{}"))
        return Object.assign({}, answer.out, {error: answer.error || "", code: codeOf(answer.error)})
    } finally {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}
const create = (username, recordId, extra = {}) =>
    run(username, "create", Object.assign({recordType: "workOrder", recordId}, extra))
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
function user(kind, permissions, organizationPartyId = org) {
    const id = prefix + "_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Location record shares " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    party(id, "Tech " + kind, null, "PtyPerson")
    call("create#mantle.party.PartyRelationship", {relationshipTypeEnumId: "PrtAgent", fromPartyId: id, toPartyId: organizationPartyId,
        toRoleTypeId: "OrgInternal", fromDate: since})
    call("create#moqui.security.UserAccount", {userId: id, username: id, partyId: id, userFullName: "Tech " + kind,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394", passwordHashType: "SHA", timeZone: "America/Chicago"})
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: since})
    return id
}
// an open work order, assigned to the technician, ending endHours from now; a customer repair (its claim's customer the
// spec's) when repair is true
function workOrder(key, repair, owner = org, assignees = [state.tech], endHours = 4) {
    const workEffortId = prefix + "_WO_" + key
    call("create#mantle.work.effort.WorkEffort", {workEffortId, workEffortTypeEnumId: "WetTask", purposeEnumId: "WepMaintenance",
        statusId: "WeInProgress", ownerPartyId: owner, workEffortName: "Heater repair " + key,
        estimatedStartDate: new Date(nowMs() - 6 * hour), estimatedCompletionDate: new Date(nowMs() + endHours * hour)})
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
    for (const partyId of assignees)
        call("create#mantle.work.effort.WorkEffortParty", {workEffortId, partyId, roleTypeId: "Assignee", fromDate: since})
    return workEffortId
}
const shareOf = shareId => one("moqui.maps.LocationShare", {shareId})
const partsOf = linkUrl => {
    const found = /\/location\/([A-Za-z0-9_-]+)#(.+)$/.exec(String(linkUrl || "")) || []
    return {selector: found[1], secret: found[2]}
}
const mailsOf = selector =>
    Array.from(find("moqui.basic.email.EmailMessage", {emailTemplateId: TEMPLATE}).list()).filter(row =>
        String(row.body || "").includes("/location/" + selector + "#"))
const setStatus = (workEffortId, statusId) => {
    const order = one("mantle.work.effort.WorkEffort", {workEffortId})
    order.statusId = statusId
    order.update()
}
const guestRead = link => {
    ec.user.logoutUser()
    try {
        return ec.service.sync().name(F + "get#LinkShare").parameters({linkKey: link.selector, linkSecret: link.secret}).call() || {}
    } finally {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        party(org, "Location Shares Service Org", "OrgInternal")
        party(otherOrg, "Location Shares Other Org", "OrgInternal")
        email(org, "service@location-shares-org.example")
        party(customer, "Location Customer", "Customer", "PtyPerson")
        email(customer, "customer@location-shares.example")
        state.tech = user("TECH", ["MAINTENANCE_ASSIGNED_VIEW", "MAINTENANCE_EXECUTE"])
        state.otherTech = user("TECH2", ["MAINTENANCE_ASSIGNED_VIEW", "MAINTENANCE_EXECUTE"])
        state.outsideTech = user("OUTSIDE", ["MAINTENANCE_ASSIGNED_VIEW", "MAINTENANCE_EXECUTE"], otherOrg)
        state.repair = workOrder("REPAIR", true, org, [state.tech, state.outsideTech])
        state.plain = workOrder("PLAIN", false)
        state.overdue = workOrder("OVERDUE", true, org, [state.tech], -1)
        state.cancelled = workOrder("CANCEL", true)
        const template = one("moqui.basic.email.EmailTemplate", {emailTemplateId: TEMPLATE})
        const server = template && one("moqui.basic.email.EmailServer", {emailServerId: template.emailServerId})
        state.mailServer = !!(server && server.smtpHost)
    },
    cleanupSpec() {
        login("john.doe")
    }
})

feature("the assigned technician shares until no later than the planned end; the link is mailed only by send, with the share's own secret, once", {
    when() {
        const tooLate = create(state.tech, state.repair, {thruDate: String(nowMs() + 5 * hour)})
        const made = create(state.tech, state.repair, {thruDate: String(nowMs() + 2 * hour), purposeText: "About 20 minutes away"})
        state.made = made
        state.link = partsOf(made.linkUrl)
        const share = shareOf(made.shareId)
        const beforeSend = mailsOf(state.link.selector).length
        const wrong = run(state.tech, "send", {shareId: made.shareId, linkSecret: "x".repeat(32)})
        const byOther = run(state.otherTech, "send", {shareId: made.shareId, linkSecret: state.link.secret})
        const sent = run(state.tech, "send", {shareId: made.shareId, linkSecret: state.link.secret})
        const mails = mailsOf(state.link.selector)
        const again = run(state.tech, "send", {shareId: made.shareId, linkSecret: state.link.secret})
        return {tooLate, made, share, beforeSend, wrong, byOther, sent, mails, again}
    },
    then({tooLate, made, share, beforeSend, wrong, byOther, sent, mails, again}) {
        tooLate.code == "END_AFTER_PLANNED" && tooLate.shareId == null
        made.error == ""
        /^https?:\/\/[^/]+\/location\/[A-Za-z0-9_-]{16}#[A-Za-z0-9_-]{32}$/.test(made.linkUrl)
        // the framework's share, the technician's own, for the work order and its planned end
        share.ownerUserId == state.tech && share.recordAdapterKey == "maintenanceWorkOrder"
        JSON.parse(share.recordKey).workEffortId == state.repair
        share.recordThruDate != null && share.purposeText == "About 20 minutes away"
        // nothing mailed by the share's making: only send mails it, with the share's own link
        beforeSend == 0
        wrong.code == "LINK_MISMATCH"
        byOther.code == "SHARE_NOT_FOUND"
        sent.error == "" && sent.mailSent == state.mailServer && (state.mailServer || sent.mailReason == "NO_MAIL_SERVER")
        mails.length == 1 && String(mails[0].body).includes(made.linkUrl)
        String(mails[0].toAddresses).includes("customer@location-shares.example")
        again.code == "ALREADY_SENT"
    }
})

feature("another technician, another organization's assigned technician, no customer, an overdue work order and a delivery are refused", {
    when() {
        const count = () => find("moqui.maps.LocationShare").condition("ownerUserId", "in", [state.tech, state.otherTech, state.outsideTech]).count()
        const before = count()
        const other = create(state.otherTech, state.repair)
        const outside = create(state.outsideTech, state.repair)
        const plain = create(state.tech, state.plain)
        const overdue = create(state.tech, state.overdue)
        const delivery = run(state.tech, "create", {recordType: "delivery", recordId: "ANY"})
        return {other, outside, plain, overdue, delivery, made: count() - before}
    },
    then({other, outside, plain, overdue, delivery, made}) {
        other.code == "NOT_ASSIGNED" && other.shareId == null
        outside.code == "RECORD_UNAVAILABLE"
        plain.code == "NO_CUSTOMER"
        overdue.code == "OVERDUE"
        delivery.code == "RECORD_KIND_NOT_READY"
        made == 0
    }
})

feature("the work order's completion stops its share: the guest page refuses the link, and the mail kept for the queue no longer holds the secret", {
    when() {
        const before = guestRead(state.link)
        setStatus(state.repair, "WeComplete")
        const share = shareOf(state.made.shareId)
        const after = guestRead(state.link)
        const mails = mailsOf(state.link.selector)
        const again = create(state.tech, state.repair)
        return {before, share, after, mails, again}
    },
    then({before, share, after, mails, again}) {
        before.statusCode == 200
        share.endedDate != null && share.revokedDate != null
        after.statusCode == 410 && after.reasonCode == "SHARE_ENDED"
        // the row stays, for the mail queue; the secret is gone from it
        mails.length == 1 && !String(mails[0].body).includes(state.link.secret)
        String(mails[0].body).includes("/location/" + state.link.selector + "#ended")
        again.code == "WORK_CLOSED"
    }
})

feature("a cancellation stops the work order's share too", {
    when() {
        const made = create(state.tech, state.cancelled)
        const live = shareOf(made.shareId).endedDate
        setStatus(state.cancelled, "WeCancelled")
        return {made, live, share: shareOf(made.shareId)}
    },
    then({made, live, share}) {
        made.error == "" && live == null
        share.endedDate != null
    }
})
