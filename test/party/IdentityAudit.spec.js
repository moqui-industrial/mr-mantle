// Change evidence of the records that belong to an organization (service/mantle/party/IdentityServices.xml
// find#IdentityChanges; mr-boss impl-admin P17, design-admin §12 AuditChanges): through the framework's
// org.moqui.admin.AuditServices.find#Changes an audit reader of one internal organization reads the changes of its own
// staff's accounts and memberships and none of another organization's; an instance administrator reads both; Mantle's source
// answers ids only, of the entities it knows, within the caller's scope; a field registered as a marker shows no value; and a
// reset that changes no audited field leaves a row with who and why. Scope is the organization entity filters of the
// authorization (the services' ALL_USERS grant, MANTLE_USER_ORG). The reader holds the framework's ADMIN_AUDIT_VIEW through a
// spec group, never an app group. New spec, no Groovy original.
// Run: ./moq test mr-mantle --spec party/IdentityAudit
const A = "org.moqui.admin.AuditServices."
const S = "mantle.party.IdentityServices."
const dayMillis = 86400000
const effectiveTime = Date.now()
const users = {}
const parties = {}
const relationships = {}
let orgId
let otherOrgId

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
// as username with artifact authorization on, as a screen calls the services
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
const fieldsOf = (out, userId) =>
    Array.from(out.changeList || [])
        .filter(row => row.recordText.includes(userId) || row.recordText.includes(usernames[userId]))
        .map(row => row.changedFieldName)
        .sort()
        .join()
const usernames = {}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        orgId = call("mantle.party.PartyServices.create#Organization", {
            organizationName: "Audit One Co",
            roleTypeId: "OrgInternal"
        }).partyId
        otherOrgId = call("mantle.party.PartyServices.create#Organization", {
            organizationName: "Audit Two Co",
            roleTypeId: "OrgInternal"
        }).partyId
        call("create#moqui.security.UserGroup", {userGroupId: "IAU_READERS", description: "Spec audit readers"})
        call("create#moqui.security.UserGroupPermission", {
            userGroupId: "IAU_READERS",
            userPermissionId: "ADMIN_AUDIT_VIEW",
            fromDate: effectiveTime - dayMillis
        })
        call("create#moqui.security.UserGroup", {userGroupId: "IAU_STAFF", description: "Spec audited staff"})
        const person = (key, username, orgs) => {
            parties[key] = call("mantle.party.PartyServices.create#Person", {firstName: key, lastName: "Audited"}).partyId
            users[key] = call("mantle.party.PartyServices.create#PartyUserAccount", {
                partyId: parties[key],
                emailAddress: username + "@example.com",
                username,
                newPassword: "moqui1!!",
                newPasswordVerify: "moqui1!!"
            }).userId
            usernames[users[key]] = username
            for (const org of orgs)
                relationships[key] = call("create#mantle.party.PartyRelationship", {
                    relationshipTypeEnumId: "PrtEmployee",
                    fromPartyId: parties[key],
                    toPartyId: org,
                    toRoleTypeId: "OrgInternal",
                    fromDate: effectiveTime - dayMillis
                }).partyRelationshipId
        }
        person("Reader", "iau.reader", [orgId])
        person("Stranger", "iau.stranger", [orgId])
        person("One", "iau.one", [orgId])
        person("Two", "iau.two", [otherOrgId])
        call("create#moqui.security.UserGroupMember", {
            userGroupId: "IAU_READERS",
            userId: users.Reader,
            fromDate: effectiveTime - dayMillis
        })
        // what the audit log then holds of each organization's staff: an email change, allowed addresses and a membership
        for (const key of ["One", "Two"]) {
            call("update#moqui.security.UserAccount", {
                userId: users[key],
                emailAddress: "changed." + key.toLowerCase() + "@example.com",
                emailAddress_changeReason: "Spec " + key + " married",
                ipAllowed: "10.9.8.0/24"
            })
            call("create#moqui.security.UserGroupMember", {
                userGroupId: "IAU_STAFF",
                userId: users[key],
                fromDate: effectiveTime - dayMillis
            })
            // an organization membership's end as the audit log keeps one, by its relationship, and the organization's own
            // record's change, by the organization
            call("create#moqui.entity.EntityAuditLog", {
                changedEntityName: "mantle.party.PartyRelationship",
                changedFieldName: "thruDate",
                pkPrimaryValue: relationships[key],
                newValueText: String(effectiveTime),
                changedDate: effectiveTime,
                changedByUserId: users.Reader,
                changeReason: "Spec " + key + " left"
            })
            call("create#moqui.entity.EntityAuditLog", {
                changedEntityName: "mantle.party.Party",
                changedFieldName: "disabled",
                pkPrimaryValue: key === "One" ? orgId : otherOrgId,
                newValueText: "N",
                changedDate: effectiveTime,
                changedByUserId: users.Reader,
                changeReason: "Spec " + key + " organization kept"
            })
            // and an export each made, as the framework's run#Export records one
            call("create#moqui.entity.EntityAuditLog", {
                changedEntityName: "moqui.server.TransferBatch",
                changedFieldName: "export",
                pkPrimaryValue: "IAU_EXPORT_" + key,
                pkSecondaryValue: "specTarget",
                newValueText: "3 rows of Spec; fields: name",
                changedDate: effectiveTime,
                changedByUserId: users[key]
            })
        }
    },
    cleanupSpec() {
        ec.artifactExecution.enableAuthz()
        login("john.doe")
    }
})

feature("an audit reader reads the changes of its own organization's staff and none of another's", {
    when() {
        const out = {}
        const account = {changedEntityName: "moqui.security.UserAccount", changedFieldName: "emailAddress"}
        as("iau.stranger", () => {
            out.stranger = result(A + "find#Changes", {})
            out.strangerSource = result(S + "find#IdentityChanges", {projectionList: [account]})
        })
        as("iau.reader", () => {
            out.one = result(A + "find#Changes", {recordKey: users.One})
            out.two = result(A + "find#Changes", {recordKey: users.Two})
            out.identity = result(A + "find#Changes", {category: "identity"})
            out.transfers = result(A + "find#Changes", {category: "transfer"})
            out.left = result(A + "find#Changes", {auditProjectionId: "OrgMembershipThru"})
            out.organization = result(A + "find#Changes", {auditProjectionId: "OrganizationDisabled"})
            // Mantle's source, called directly: ids of what is in scope, of the entities it knows, whatever is asked for
            out.direct = result(S + "find#IdentityChanges", {
                projectionList: [
                    account,
                    {changedEntityName: "mantle.humanres.employment.Employment", changedFieldName: "*"},
                    {changedEntityName: "mantle.party.contact.ContactMech", changedFieldName: "*"}
                ],
                limit: 500
            })
        })
        // an instance administrator, under its own grant of the services (every organization with none active)
        ec.artifactExecution.enableAuthz()
        out.admin = result(A + "find#Changes", {recordKey: users.Two})
        out.adminTransfers = result(A + "find#Changes", {category: "transfer"})
        ec.artifactExecution.disableAuthz()
        out.directIds = Array.from(out.direct.auditIdList || [])
        out.directRows = out.directIds.length
            ? Array.from(
                  ec.entity
                      .find("moqui.entity.EntityAuditLog")
                      .condition("auditHistorySeqId", "in", out.directIds)
                      .disableAuthz()
                      .list()
              ).map(row => row.getMap())
            : []
        out.email = Array.from(out.one.changeList || []).find(row => row.changedFieldName === "emailAddress")
        out.allowed = Array.from(out.one.changeList || []).find(row => row.changedFieldName === "ipAllowed")
        out.member = Array.from(out.one.changeList || []).find(row => row.changedEntityName === "moqui.security.UserGroupMember")
        return out
    },
    then(out) {
        // reading needs the permission, in the framework's service and in Mantle's source
        out.stranger.error.includes("ADMIN_AUDIT_VIEW is required")
        out.strangerSource.error.includes("ADMIN_AUDIT_VIEW is required")
        // its own organization's staff: the account's changes with their values, who made them and why
        out.one.error === ""
        out.email.before === "iau.one@example.com" && out.email.after === "changed.one@example.com"
        out.email.reason === "Spec One married"
        out.email.actorName.startsWith("john.doe")
        out.email.recordText.startsWith("User: iau.one")
        out.email.linkKey === "adminUser" && out.email.linkId === users.One
        // allowed addresses are registered as a marker: that they were set, never what they are
        out.allowed.masked === true && out.allowed.marker === "set" && out.allowed.after === null
        !JSON.stringify(out.one).includes("10.9.8.0")
        // the membership, by its member
        out.member.recordText ===
            "Group: Spec audited staff · User: iau.two (Two Audited)".replace(/two/g, "one").replace("Two", "One")
        // another organization's staff: nothing found, nothing counted, by its key or in the whole category
        out.two.error === "" && out.two.changeListCount === 0 && out.two.changeList.length === 0
        out.identity.changeListCount > 0
        !JSON.stringify(out.identity).includes("iau.two") && !JSON.stringify(out.identity).includes("changed.two")
        // the source answers ids only, each of an account in scope, and nothing of an entity it does not know
        out.directIds.length > 0 && out.direct.changeCount === out.directIds.length
        Object.keys(out.direct).sort().join() === "auditIdList,changeCount,error"
        out.directRows.every(
            row => row.changedEntityName === "moqui.security.UserAccount" && row.changedFieldName === "emailAddress"
        )
        !out.directRows.some(row => row.pkPrimaryValue === users.Two)
        out.directRows.some(row => row.pkPrimaryValue === users.One)
        // an export is its maker's doing: the reader's own organization's person's, not the other's
        JSON.stringify(out.transfers).includes("IAU_EXPORT_One") && !JSON.stringify(out.transfers).includes("IAU_EXPORT_Two")
        // a membership's end by its relationship's organization, an organization's own record by itself
        JSON.stringify(out.left).includes("Spec One left") && !JSON.stringify(out.left).includes("Spec Two left")
        JSON.stringify(out.organization).includes("Spec One organization kept")
        !JSON.stringify(out.organization).includes("Spec Two organization kept")
        // the instance administrator reads the other organization's too
        out.admin.changeListCount >= 3
        JSON.stringify(out.adminTransfers).includes("IAU_EXPORT_Two")
    }
})

feature("a reset that changes no audited field leaves a row with who and why", {
    when() {
        call("update#moqui.security.UserAccount", {userId: users.One, successiveFailedLogins: 4})
        ec.artifactExecution.enableAuthz()
        const reset = result(S + "reset#Authentication", {userId: users.One, resetKind: "lock", reason: "Spec called in"})
        ec.artifactExecution.disableAuthz()
        const found = as("iau.reader", () => result(A + "find#Changes", {auditProjectionId: "AccountSignInLock"}))
        return {reset, found, row: Array.from(found.changeList || [])[0]}
    },
    then(out) {
        out.reset.applied === true
        out.found.changeListCount === 1
        out.row.description === "Sign-in lock released" && out.row.after === "Released: 1"
        out.row.reason === "Spec called in" && out.row.actorName.startsWith("john.doe")
    }
})
