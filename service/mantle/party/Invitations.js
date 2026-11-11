// Staff invitations, mantle.party.IdentityServices (mr-boss plan/design-admin.md §4.1 Invitations, §4 Invitations and
// AcceptInvitation, §16; impl-admin P5). A UserInvitation binds an address, an internal organization (the relationship the
// person will have to it) and a grant proposal (registered bundles the app supplies) to a single-use token, kept only as its
// hash, with an expiry.
//
// Inviting, resending, revoking and reading need ADMIN_IDENTITY_MANAGE (reading ADMIN_IDENTITY_VIEW) and an organization the
// caller administers, as Identity.js's scope() answers it (called by name; impl-admin P5 relies on it, and on the
// organization entity filters of UserInvitation under an app's authz). The proposal is checked as the inviter by the framework's
// check#GrantProposal, and an invitation never carries a privileged group or a group granting a sealed permission (ADMIN among
// them), whoever sends it.
//
// The token is mailed (EmailTemplate MANTLE_STAFF_INVITATION, sent with no EmailMessage record) or, when the instance cannot
// send mail (the template's mail server has no SMTP host), shown once to whoever issued it: reveal#InvitationLink makes a new
// token at that moment and records linkShownDate (audited, without the token). A resend makes a new token, so the earlier
// one no longer matches. The token is never stored, listed or logged.
//
// Acceptance runs for the holder of the token, signed in or not (the token route /i/<token>): an account signed in with the
// invited address, or a new account (create#PartyUserAccount, the invited address, the person's own password); an existing
// account with that address must sign in first. It rechecks what the inviter could do now (enabled, ADMIN_IDENTITY_MANAGE,
// the organization theirs, each bundle still registered and delegable by them) from the records, since the framework has no
// way to run a check as another user (impl-admin F-P5-2), then writes the organization relationship and the memberships
// itself, with authorization on so the framework's sealed and privileged EECAs still decide each membership. Nothing in the
// redemption request names the organization or the access. When a bundle's group requires a second factor and the account has
// none, the acceptance makes an authenticator factor that the token holder confirms with its first code
// (confirm#InvitationFactor) within a day, in the session that accepted (or signed in as the account). Every spent token
// (accepted, revoked, expired, superseded or unknown) reads the same.
//
// An invitation that would bring an existing identity into the organization (a person with an account and no internal
// organization, a site identity, or one who works for an organization outside the inviter's) needs ADMIN_IDENTITY_GLOBAL,
// as relating that person directly does (impl-admin P4 R2, F-P5-8): checked as the inviter when it is sent or resent, and
// for the inviter from the records, against the account that redeems it, at acceptance.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const identityLib = ec.resource.script("component://mr-mantle/service/mantle/party/Identity.js")
const {find, one, rows, denied} = lib
const access = lib.access
const INVITATION = "mantle.party.UserInvitation"
const ACCOUNT = "moqui.security.UserAccount"
const RELATIONSHIP = "mantle.party.PartyRelationship"
const MEMBER = "moqui.security.UserGroupMember"
const VIEW = "ADMIN_IDENTITY_VIEW"
const MANAGE = "ADMIN_IDENTITY_MANAGE"
const GLOBAL = "ADMIN_IDENTITY_GLOBAL"
const TEMPLATE = "MANTLE_STAFF_INVITATION"
const staffRelationships = ["PrtEmployee", "PrtAgent", "PrtMember"]
const MINUTE = 60000
const DAY = 86400000
// how long the issuer may see the link of a token made for a link (no mail server), the factor step stays open after
// acceptance, and the done step reads as done
const REVEAL_WINDOW = 15 * MINUTE
const FACTOR_WINDOW = DAY
const DONE_WINDOW = 15 * MINUTE
const NOT_VALID = "This invitation is no longer valid"

const ms = value =>
    value == null || value === ""
        ? null
        : value instanceof Date
          ? value.getTime()
          : /^-?\d+$/.test(String(value))
            ? Number(value)
            : Date.parse(String(value))
const nowMs = () => ms(ec.user.nowTimestamp)
const iso = value => (value == null ? null : new Date(value).toISOString())
const text = value => String(value ?? "").trim()
const stamp = row => String(ms(row?.lastUpdatedStamp) ?? "")
const openAt = (row, at = nowMs()) => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at
const refused = (reasonCode, reason, extra = {}) => Object.assign({applied: false, reasonCode, reason}, extra)
const likeText = value => "%" + String(value).replace(/[\\%_]/g, character => "\\" + character) + "%"
const validToken = token => /^[A-Za-z0-9_-]{8,128}$/.test(String(token ?? ""))
const sameAddress = (a, b) => !!text(a) && text(a).toLowerCase() === text(b).toLowerCase()
// a framework or Mantle service with authorization as it is, its error thrown
function callService(name, parameters) {
    const out = ec.service.sync().name(name).parameters(parameters).call() || {}
    if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
    return out
}
function update(entityName, fields) {
    const value = ec.entity.makeValue(entityName)
    value.setFields(fields, true, null, null)
    value.update()
}
function requirePermission(permission) {
    if (!ec.user.userId) denied("SIGN_IN", "Sign in to administer invitations")
    if (!access.has(permission)) denied("PERMISSION_DENIED", permission + " is required")
}
function partyName(partyId) {
    if (!partyId) return ""
    const organization = one("mantle.party.Organization", {partyId})
    if (organization?.organizationName) return organization.organizationName
    const person = one("mantle.party.Person", {partyId})
    const name = person ? [person.firstName, person.lastName].filter(Boolean).join(" ") : ""
    return name || partyId
}
function userName(userId) {
    const account = userId ? one(ACCOUNT, {userId}) : null
    return account ? account.userFullName || account.username : ""
}
// the account with an address, ignoring case (create#UserAccount refuses a second one)
function accountOfAddress(emailAddress) {
    const factory = ec.entity.conditionFactory
    return Array.from(
        find(ACCOUNT)
            .condition(factory.makeCondition("emailAddress", "equals", text(emailAddress)).ignoreCase())
            .limit(1)
            .list()
    )[0]
}
const isInternal = partyId => !!partyId && !!one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
// the invitation row read again with a lock, so two requests on one invitation (two accepts, two reveals) run one at a time
const locked = row => (row ? find(INVITATION, {invitationId: row.invitationId}).forUpdate(true).one() : null)
const internalOrgIds = partyId =>
    partyId ? Array.from(callService("mantle.party.PartyServices.get#PartyInternalOrgIds", {partyId}).userOrgIds || []) : []
// Bringing an existing person into an organization through an invitation: one with an account and no internal organization
// (a site identity) or one who works for an organization outside organizationIds needs ADMIN_IDENTITY_GLOBAL (hasGlobal), as
// store#OrganizationMembership asks it (impl-admin P4 R2, F-P5-8); the memberships an invitation gives are account-wide.
function identityRefusal(partyId, organizationIds, hasGlobal, reason) {
    if (!partyId || hasGlobal) return null
    const owners = internalOrgIds(partyId)
    if (owners.some(id => !organizationIds.includes(id)))
        return refused(
            "IDENTITY_GLOBAL",
            reason || partyName(partyId) + " also works for an organization you do not administer: inviting them needs " + GLOBAL
        )
    if (!owners.length && one(ACCOUNT, {partyId}))
        return refused(
            "IDENTITY_GLOBAL",
            reason || partyName(partyId) + " has an account of no organization: inviting it into an organization needs " + GLOBAL
        )
    return null
}
// The existing person an invitation goes to: the one chosen, else the owner of the account with the address.
const invitedParty = (partyId, emailAddress) => partyId || accountOfAddress(emailAddress)?.partyId || null
const bundleIds = row => text(row.bundleGroupIds).split(",").map(text).filter(Boolean)
function bundleSummary(ids) {
    return ids.map(groupId => {
        const bundle = one("moqui.security.CapabilityBundle", {userGroupId: groupId})
        const group = one("moqui.security.UserGroup", {userGroupId: groupId})
        return {appName: bundle?.appName || "", description: bundle?.description || group?.description || groupId}
    })
}
// pending, accepted, revoked or expired (a pending one past its expiry)
function stateOf(row, at = nowMs()) {
    if (row.statusId === "UinvAccepted") return "accepted"
    if (row.statusId === "UinvRevoked") return "revoked"
    return (ms(row.expiresDate) ?? 0) <= at ? "expired" : "pending"
}
const stateNames = {pending: "Pending", accepted: "Accepted", revoked: "Revoked", expired: "Expired"}

// ===== the caller's organizations (Identity.js scope(), by name) =====
function scopedInvitation(invitationId) {
    const row = text(invitationId) ? one(INVITATION, {invitationId: text(invitationId)}) : null
    if (!row || !identityLib.scope().organizationIds.includes(row.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Invitation " + text(invitationId) + " is not available")
    return row
}

// ===== the grant proposal of an invitation =====
// What no invitation carries, whoever sends it: a privileged group (ADMIN among them) or a group granting a sealed permission;
// the reason of the first such bundle, or null.
function invitationRefusal(ids) {
    const privileged = new Set(Array.from(UserSecurityChecks.privilegedGroups()))
    const sealed = new Set(Array.from(UserSecurityChecks.sealedPermissions()))
    const at = nowMs()
    for (const groupId of ids) {
        if (groupId === "ADMIN" || privileged.has(groupId))
            return refused("PRIVILEGED_GROUP", groupId + " is a privileged group: an invitation never grants it")
        const grant = rows("moqui.security.UserGroupPermission", {userGroupId: groupId}).find(
            row => (ms(row.thruDate) ?? Infinity) > at && sealed.has(row.userPermissionId)
        )
        if (grant)
            return refused(
                "SEALED_PERMISSION",
                groupId + " grants the sealed permission " + grant.userPermissionId + ": an invitation never grants it"
            )
    }
    return null
}
// Whether userId holds permissionId now through its current groups (ALL_USERS among them), ADMIN holding every one, as the
// framework's hasPermission reads it for the current user.
function userGroups(userId) {
    const at = nowMs()
    return ["ALL_USERS"].concat(
        rows(MEMBER, {userId})
            .filter(row => openAt(row, at))
            .map(row => row.userGroupId)
    )
}
function holds(userId, permissionId, groups = userGroups(userId)) {
    if (groups.includes("ADMIN")) return true
    const at = nowMs()
    return Array.from(
        find("moqui.security.UserGroupPermission")
            .condition("userGroupId", "in", groups)
            .condition("userPermissionId", permissionId)
            .list()
    ).some(row => openAt(row, at))
}
// At acceptance: what the inviter could do now, from the records (the framework runs a check only as the current user):
// their account usable, ADMIN_IDENTITY_MANAGE held, the organization one they work for (any for ADMIN), and each bundle still
// registered, delegable by them, and neither privileged nor carrying a sealed grant. A refusal names what changed.
function inviterRefusal(row, authority = {}) {
    const inviter = row.inviterUserId ? one(ACCOUNT, {userId: row.inviterUserId}) : null
    const at = nowMs()
    if (
        !inviter ||
        (inviter.disabled === "Y" && !inviter.disabledDateTime) ||
        (inviter.terminateDate && ms(inviter.terminateDate) <= at)
    )
        return refused("INVITER_UNAVAILABLE", "The person who invited you can no longer give this access")
    const groups = userGroups(inviter.userId)
    if (!holds(inviter.userId, MANAGE, groups))
        return refused("INVITER_UNAVAILABLE", "The person who invited you can no longer give this access")
    if (!isInternal(row.organizationPartyId)) return refused("ORGANIZATION_UNAVAILABLE", "The organization is not available")
    authority.global = holds(inviter.userId, GLOBAL, groups)
    authority.organizations = []
    if (!groups.includes("ADMIN")) {
        const organizations = internalOrgIds(inviter.partyId)
        if (!organizations.includes(row.organizationPartyId))
            return refused("INVITER_UNAVAILABLE", "The person who invited you no longer administers the organization")
        authority.organizations = organizations
    }
    const ids = bundleIds(row)
    if (!ids.length) return refused("GRANT_CHANGED", "The invitation names no access")
    const blocked = invitationRefusal(ids)
    if (blocked) return refused("GRANT_CHANGED", blocked.reason)
    for (const groupId of ids) {
        const bundle = one("moqui.security.CapabilityBundle", {userGroupId: groupId})
        if (!bundle || bundle.disabled === "Y" || !one("moqui.security.UserGroup", {userGroupId: groupId}))
            return refused("GRANT_CHANGED", groupId + " is no longer a registered bundle")
        if (bundle.delegablePermissionId && !holds(inviter.userId, bundle.delegablePermissionId, groups))
            return refused("GRANT_CHANGED", groupId + " is no longer the inviter's to give")
    }
    return null
}

// ===== tokens and mail =====
function newToken() {
    // 43 characters of [A-Za-z0-9_-] (the token route's form), 256 bits
    return ec.user.randomString(43)
}
function byToken(token) {
    if (!validToken(token)) return null
    return one(INVITATION, {tokenHash: ec.user.singleUseCodeHash(String(token))})
}
// The template's mail server can send: it has an SMTP host (Admin's first setup check reads the same).
function canSendMail() {
    const template = one("moqui.basic.email.EmailTemplate", {emailTemplateId: TEMPLATE})
    const server = template?.emailServerId ? one("moqui.basic.email.EmailServer", {emailServerId: template.emailServerId}) : null
    return !!text(server?.smtpHost)
}
function acceptUrl(token, baseUrl) {
    let root = text(baseUrl)
    if (!root) {
        const template = one("moqui.basic.email.EmailTemplate", {emailTemplateId: TEMPLATE})
        if (template?.webHostName) root = "https://" + template.webHostName
        else if (template?.emailServerId)
            root = text(one("moqui.basic.email.EmailServer", {emailServerId: template.emailServerId})?.webBaseUrl)
    }
    return root.replace(/\/+$/, "") + "/i/" + token
}
// Mail the token's link; the outcome, never an error (a failed send leaves the invitation pending, to resend). No
// EmailMessage record is made, so the link is not stored.
function sendMail(row, token, baseUrl) {
    try {
        const out =
            ec.service
                .sync()
                .name("org.moqui.mail.EmailServices.send#EmailTemplate")
                .parameters({
                    emailTemplateId: TEMPLATE,
                    toAddresses: row.emailAddress,
                    createEmailMessage: false,
                    bodyParameters: {
                        organizationName: partyName(row.organizationPartyId),
                        inviterName: userName(row.inviterUserId),
                        bundleSummary: bundleSummary(bundleIds(row))
                            .map(bundle => bundle.description)
                            .join(", "),
                        message: row.message || null,
                        expiresText: new Date(ms(row.expiresDate)).toISOString().slice(0, 10),
                        acceptUrl: acceptUrl(token, baseUrl)
                    }
                })
                .call() || {}
        if (ec.message.hasError() || out.sendError) {
            const error = out.sendError || ec.message.getErrorsString()
            ec.message.clearErrors()
            ec.logger.warn("Invitation " + row.invitationId + " was not mailed: " + error)
            return false
        }
        return true
    } catch (error) {
        ec.message.clearErrors()
        ec.logger.warn("Invitation " + row.invitationId + " was not mailed: " + error.message)
        return false
    }
}
// A new token for the invitation, mailed when the instance can send mail; else the issuer reveals its link once
// (reveal#InvitationLink). Its expiry from now, expireDays (7 by default, 1 to 30).
function issue(row, p) {
    const now = nowMs()
    const days = Math.min(Math.max(Number(p.expireDays || 7), 1), 30)
    const token = newToken()
    const mail = canSendMail()
    const fields = {
        invitationId: row.invitationId,
        tokenHash: ec.user.singleUseCodeHash(token),
        expiresDate: iso(now + days * DAY),
        sentDate: iso(now),
        sendCount: Number(row.sendCount || 0) + 1,
        mailSent: "N",
        linkShownDate: null,
        inviterUserId: ec.user.userId
    }
    update(INVITATION, fields)
    const current = Object.assign({}, row, fields)
    const mailSent = mail ? sendMail(current, token, p.baseUrl) : false
    if (mailSent) update(INVITATION, {invitationId: row.invitationId, mailSent: "Y"})
    return {mailSent, linkPending: !mail, expiresDate: ms(fields.expiresDate)}
}

// ===== invite#User =====
// One staff invitation: an address (an existing person's, or a new person's with a name), an internal organization the caller
// administers, the relationship (employee by default) and the grant proposal (registered bundles, checked as the caller, never
// privileged or sealed). A pending invitation of the same address to the organization is refused (resend it). A retry with
// the same operationKey answers the invitation it made.
function inviteUser(p) {
    requirePermission(MANAGE)
    const operationKey = text(p.operationKey).slice(0, 255) || null
    if (operationKey) {
        const earlier = one(INVITATION, {operationKey})
        if (earlier) {
            if (
                earlier.inviterUserId !== ec.user.userId &&
                !identityLib.scope().organizationIds.includes(earlier.organizationPartyId)
            )
                denied("RECORD_UNAVAILABLE", "The operation key is in use")
            return {
                applied: true,
                retried: true,
                invitationId: earlier.invitationId,
                state: stateOf(earlier),
                mailSent: earlier.mailSent === "Y",
                linkPending: false,
                expiresDate: ms(earlier.expiresDate)
            }
        }
    }
    const proposed = invitationProposal(p)
    if (proposed.refusal) return proposed.refusal
    const {emailAddress, partyId, organizationPartyId, relationshipTypeEnumId, ids} = proposed
    const value = ec.entity.makeValue(INVITATION)
    value.setSequencedIdPrimary()
    value.setFields(
        {
            emailAddress,
            firstName: text(p.firstName) || null,
            lastName: text(p.lastName) || null,
            partyId,
            organizationPartyId,
            relationshipTypeEnumId,
            bundleGroupIds: ids.join(","),
            message: text(p.message).slice(0, 2000) || null,
            statusId: "UinvPending",
            // a placeholder, replaced at once by issue()
            tokenHash: ec.user.singleUseCodeHash(newToken()),
            inviterUserId: ec.user.userId,
            sendCount: 0,
            operationKey
        },
        true,
        null,
        null
    )
    value.create()
    const invitationId = value.get("invitationId")
    const sent = issue(one(INVITATION, {invitationId}), p)
    ec.logger.info(
        "Invitation " +
            invitationId +
            " to " +
            partyName(organizationPartyId) +
            " sent by " +
            ec.user.username +
            (sent.mailSent ? " by mail" : sent.linkPending ? ", the link to be shown" : ", mail failed")
    )
    return Object.assign({applied: true, reasonCode: null, reason: null, invitationId, state: "pending"}, sent)
}
// What invite#User checks before it writes, as the caller and changing nothing: the organization in the caller's scope, the
// relationship, the address, the person, no pending invitation of the address there, the identity's other organizations and
// the proposal (never a privileged group or a sealed-granting one; each bundle delegable by the caller). {refusal} for what a
// person can act on, an Error for the rest, else what the invitation will hold. The import of invitations validates a row
// with it, so a row's preview and its apply decide alike.
function invitationProposal(p) {
    requirePermission(MANAGE)
    const userScope = identityLib.scope()
    const organizationPartyId = text(p.organizationPartyId)
    if (!organizationPartyId || !isInternal(organizationPartyId) || !userScope.organizationIds.includes(organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Organization " + organizationPartyId + " is not available")
    const relationshipTypeEnumId = text(p.relationshipTypeEnumId) || "PrtEmployee"
    if (!staffRelationships.includes(relationshipTypeEnumId))
        throw new Error("An invitation is for an employee, agent or member relationship")
    const emailAddress = text(p.emailAddress).toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailAddress)) throw new Error("Enter the address to invite")
    const ids = Array.from(
        new Set(
            Array.from(p.bundleGroupIdList || [])
                .map(text)
                .filter(Boolean)
        )
    )
    if (!ids.length) throw new Error("Choose the access the invitation proposes")
    let partyId = text(p.partyId) || null
    if (partyId) {
        if (!one("mantle.party.Person", {partyId})) throw new Error("Party " + partyId + " is not a person")
        const account = one(ACCOUNT, {partyId})
        if (account && !sameAddress(account.emailAddress, emailAddress))
            return {
                refusal: refused("ADDRESS_MISMATCH", partyName(partyId) + "'s account has another address: invite that address")
            }
        const holder = accountOfAddress(emailAddress)
        if (holder && holder.partyId !== partyId)
            return {
                refusal: refused(
                    "ADDRESS_IN_USE",
                    "Another person's account has " + emailAddress + ": invite that person instead"
                )
            }
    } else if (!text(p.firstName) && !text(p.lastName) && !accountOfAddress(emailAddress))
        throw new Error("Give the person's name, or choose a person")
    const pending = Array.from(
        find(INVITATION).condition({organizationPartyId, statusId: "UinvPending"}).condition("emailAddress", emailAddress).list()
    ).find(row => stateOf(row) === "pending")
    if (pending) return {refusal: refused("INVITATION_EXISTS", emailAddress + " already has a pending invitation: resend it")}
    const outside = identityRefusal(invitedParty(partyId, emailAddress), userScope.organizationIds, ec.user.hasPermission(GLOBAL))
    if (outside) return {refusal: outside}
    const blocked = invitationRefusal(ids)
    if (blocked) return {refusal: blocked}
    const proposal = callService("org.moqui.admin.AccessServices.check#GrantProposal", {bundleGroupIdList: ids})
    if (!proposal.allowed) return {refusal: refused(proposal.reasonCode, proposal.reason)}
    return {emailAddress, partyId, organizationPartyId, relationshipTypeEnumId, ids}
}

// ===== the import of staff invitations (mr-boss impl-admin P15; design-admin §4 Invitations' bulk invite, §11.1) =====
// The row services of the import target staffInvitations (the framework's moqui.server.TransferTarget, seeded in
// data/PartyInvitationData.xml), called by org.moqui.admin.DataTransferServices for each row of a staged file, as the
// importer. A row is an address, an optional existing person, a display name, and the access as registered bundles; the batch
// is for one organization (its scope), and its expiry, relationship and note are the batch's options. A row is validated by
// what invite#User checks (invitationProposal) and applied by invite#User itself, under the row's operation key, so a bulk
// invitation is the single one made many times: the same authority, scope and proposal rules, never a password, a factor, a
// token, a group that is not a registered bundle, or another organization.
const rowText = value => String(value ?? "").trim()
function invitationRow(p) {
    const values = p.rowValues?.getMap ? p.rowValues.getMap() : Object.assign({}, p.rowValues || {})
    const options = p.batchOptions?.getMap ? p.batchOptions.getMap() : Object.assign({}, p.batchOptions || {})
    const fixed = p.fixedValues?.getMap ? p.fixedValues.getMap() : Object.assign({}, p.fixedValues || {})
    const organizationPartyId = rowText(p.scopeKey)
    if (!organizationPartyId) throw new Error("Choose the organization the invitations are for")
    const rowOrganization = rowText(values.organizationPartyId)
    if (rowOrganization && rowOrganization !== organizationPartyId)
        throw new Error(
            "This import is for " + partyName(organizationPartyId) + ": import another organization's invitations apart"
        )
    const displayName = rowText(values.displayName)
    if (
        displayName.length > 100 ||
        /[\u0000-\u001f\u007f]/.test(displayName) ||
        displayName.includes("${") ||
        /[<>]/.test(displayName)
    )
        throw new Error("A name is at most 100 characters of plain text")
    const cut = displayName.lastIndexOf(" ")
    const split = value =>
        rowText(value)
            .split(/[;|,\s]+/)
            .map(rowText)
            .filter(Boolean)
    // the bundles the registration always includes (an app's own root group) come first; the row's follow
    const ids = Array.from(new Set(split(fixed.alwaysBundleGroupIds).concat(split(values.bundleGroupIds))))
    if (ids.some(id => !/^[A-Za-z0-9_]{1,40}$/.test(id))) throw new Error("Name the access by its bundles' ids")
    if (ids.length > 20) throw new Error("At most 20 bundles for one invitation")
    return {
        emailAddress: rowText(values.emailAddress).toLowerCase(),
        partyId: rowText(values.partyId) || null,
        firstName: (cut > 0 ? displayName.slice(0, cut) : displayName).trim() || null,
        lastName: (cut > 0 ? displayName.slice(cut + 1) : "").trim() || null,
        displayName,
        organizationPartyId,
        relationshipTypeEnumId: rowText(options.relationshipTypeEnumId) || "PrtEmployee",
        bundleGroupIdList: ids,
        rowBundleIds: split(values.bundleGroupIds),
        expireDays: rowText(options.expireDays) ? Number(options.expireDays) : null,
        message: rowText(options.message) || null
    }
}
const plainReason = error => String(error?.message ?? error).replace(/^[A-Z_]+: /, "")
function validateInvitationImportRow(p) {
    requirePermission(MANAGE)
    let row
    try {
        row = invitationRow(p)
        // at an apply: the invitation this row's own key already made (an apply that stopped before its result was kept) is
        // not a pending invitation in the row's way; invite#User answers it under the key
        const made = rowText(p.operationKey) ? one(INVITATION, {operationKey: rowText(p.operationKey)}) : null
        const proposed = made && made.inviterUserId === ec.user.userId ? {} : invitationProposal(row)
        if (proposed.refusal) return {valid: false, errors: [proposed.refusal.reason], normalizedValues: {}}
    } catch (error) {
        ec.message.clearErrors()
        return {valid: false, errors: [plainReason(error)], normalizedValues: {}}
    }
    return {
        valid: true,
        errors: [],
        warnings: accountOfAddress(row.emailAddress) ? ["The address has an account: its owner signs in to accept"] : [],
        normalizedValues: {
            emailAddress: row.emailAddress,
            partyId: row.partyId,
            displayName: row.displayName || null,
            organizationPartyId: row.organizationPartyId,
            bundleGroupIds: row.rowBundleIds.join(";")
        },
        displayText:
            row.emailAddress +
            ": " +
            bundleSummary(row.bundleGroupIdList)
                .map(bundle => bundle.description || bundle.userGroupId)
                .join(", ")
    }
}
function applyInvitationImportRow(p) {
    requirePermission(MANAGE)
    const row = invitationRow(p)
    let baseUrl = null
    try {
        baseUrl = ec.web.getWebappRootUrl() || null
    } catch (error) {
        baseUrl = null
    }
    const invited = callService("mantle.party.IdentityServices.invite#User", {
        emailAddress: row.emailAddress,
        partyId: row.partyId,
        firstName: row.firstName,
        lastName: row.lastName,
        organizationPartyId: row.organizationPartyId,
        relationshipTypeEnumId: row.relationshipTypeEnumId,
        bundleGroupIdList: row.bundleGroupIdList,
        expireDays: row.expireDays,
        message: row.message,
        operationKey: rowText(p.operationKey),
        baseUrl
    })
    if (!invited.applied) return {applied: false, reasonCode: invited.reasonCode, reason: invited.reason, resultRef: null}
    return {
        applied: true,
        resultRef: invited.invitationId,
        resultText: invited.mailSent
            ? "Invitation sent"
            : invited.retried
              ? "Invitation already made"
              : "Invitation made; its email was not sent: resend it from Invitations"
    }
}
// The organizations the caller may import invitations into and read the imports of: those they administer.
function findInvitationImportScopes() {
    if (!ec.user.userId || (!access.has(MANAGE) && !access.has(VIEW))) return {scopeList: []}
    return {
        scopeList: identityLib
            .scope()
            .organizationIds.filter(isInternal)
            .map(partyId => ({scopeKey: partyId, title: partyName(partyId)}))
            .sort((a, b) => a.title.localeCompare(b.title))
    }
}

// ===== find#Invitations =====
// The invitations of the organizations the caller administers (one of them with organizationPartyId), narrowed by text
// (address or name) and state, newest first, paged; never a token or its hash.
function findInvitations(p) {
    requirePermission(VIEW)
    let organizationIds = identityLib.scope().organizationIds
    if (text(p.organizationPartyId)) {
        if (!organizationIds.includes(text(p.organizationPartyId)))
            denied("RECORD_UNAVAILABLE", "Organization " + text(p.organizationPartyId) + " is not available")
        organizationIds = [text(p.organizationPartyId)]
    }
    // with authorization as the caller has it, so an app's organization filters on UserInvitation apply too
    let found = ec.entity
        .find(INVITATION)
        .condition("organizationPartyId", "in", organizationIds.length ? organizationIds : ["_NA_"])
    const term = text(p.text)
    if (term) {
        const factory = ec.entity.conditionFactory
        found = found.condition(
            factory.makeCondition(
                ["emailAddress", "firstName", "lastName"].map(field =>
                    factory.makeCondition(field, "like", likeText(term)).ignoreCase()
                ),
                "or"
            )
        )
    }
    const state = text(p.state)
    const at = nowMs()
    const canManage = access.has(MANAGE)
    const all = Array.from(found.orderBy("-sentDate").limit(1000).list())
        .map(row => ({row, state: stateOf(row, at)}))
        .filter(item => !state || item.state === state)
    const limit = Math.max(1, Math.min(200, Number(p.pageSize || 50)))
    const offset = Math.max(0, Number(p.pageIndex || 0)) * limit
    const invitationList = all.slice(offset, offset + limit).map(({row, state}) => {
        const person = row.partyId ? partyName(row.partyId) : [row.firstName, row.lastName].filter(Boolean).join(" ")
        return {
            invitationId: row.invitationId,
            emailAddress: row.emailAddress,
            personName: person || row.emailAddress,
            partyId: row.partyId || null,
            userId: row.userId || null,
            organizationPartyId: row.organizationPartyId,
            organizationName: partyName(row.organizationPartyId),
            bundleSummary: bundleSummary(bundleIds(row))
                .map(bundle => bundle.description)
                .join(", "),
            state,
            stateText: stateNames[state],
            expiresDate: ms(row.expiresDate),
            sentDate: ms(row.sentDate),
            sendCount: Number(row.sendCount || 0),
            mailSent: row.mailSent === "Y",
            linkShown: !!row.linkShownDate,
            acceptedDate: ms(row.acceptedDate),
            revokedDate: ms(row.revokedDate),
            inviterName: userName(row.inviterUserId),
            revision: stamp(row),
            canResend: canManage && (state === "pending" || state === "expired"),
            canRevoke: canManage && (state === "pending" || state === "expired")
        }
    })
    return {invitationList, invitationListCount: all.length, pageIndex: offset / limit, pageSize: limit}
}

// ===== resend#Invitation, revoke#Invitation, reveal#InvitationLink =====
// A new token for a pending or expired invitation, at its revision: the earlier token no longer matches.
function resendInvitation(p) {
    requirePermission(MANAGE)
    const row = scopedInvitation(p.invitationId)
    if (text(p.expectedRevision) !== stamp(row))
        return refused("REVISION_CHANGED", "The invitation changed since you read it; reload it", {revision: stamp(row)})
    const state = stateOf(row)
    if (state !== "pending" && state !== "expired")
        return refused("INVITATION_CLOSED", "The invitation is " + stateNames[state].toLowerCase() + ": it cannot be resent")
    // the grant proposal and the identity it reaches are checked again as the one who resends it
    const outside = identityRefusal(
        invitedParty(row.partyId, row.emailAddress),
        identityLib.scope().organizationIds,
        ec.user.hasPermission(GLOBAL)
    )
    if (outside) return outside
    const ids = bundleIds(row)
    const blocked = invitationRefusal(ids)
    if (blocked) return blocked
    const proposal = callService("org.moqui.admin.AccessServices.check#GrantProposal", {bundleGroupIdList: ids})
    if (!proposal.allowed) return refused(proposal.reasonCode, proposal.reason)
    const sent = issue(row, p)
    ec.logger.info("Invitation " + row.invitationId + " resent by " + ec.user.username)
    return Object.assign(
        {
            applied: true,
            reasonCode: null,
            reason: null,
            invitationId: row.invitationId,
            revision: stamp(one(INVITATION, {invitationId: row.invitationId}))
        },
        sent
    )
}
function revokeInvitation(p) {
    requirePermission(MANAGE)
    const row = scopedInvitation(p.invitationId)
    if (text(p.expectedRevision) !== stamp(row))
        return refused("REVISION_CHANGED", "The invitation changed since you read it; reload it", {revision: stamp(row)})
    const state = stateOf(row)
    if (state !== "pending" && state !== "expired")
        return refused("INVITATION_CLOSED", "The invitation is " + stateNames[state].toLowerCase() + ": it cannot be revoked")
    const reason = text(p.reason).slice(0, 255)
    if (reason) ec.context.putAll({statusId_changeReason: reason, revokedDate_changeReason: reason})
    update(INVITATION, {
        invitationId: row.invitationId,
        statusId: "UinvRevoked",
        revokedDate: ec.user.nowTimestamp,
        revokedByUserId: ec.user.userId
    })
    ec.logger.info("Invitation " + row.invitationId + " revoked by " + ec.user.username)
    return {applied: true, reasonCode: null, reason: null, revision: stamp(one(INVITATION, {invitationId: row.invitationId}))}
}
// The acceptance link of an invitation whose token could not be mailed (no mail server), once, to whoever issued it, within
// fifteen minutes: a new token is made now and only its hash kept, and linkShownDate (audited) records the showing.
function revealInvitationLink(p) {
    requirePermission(MANAGE)
    const row = locked(scopedInvitation(p.invitationId))
    if (row.inviterUserId !== ec.user.userId)
        denied("RECORD_UNAVAILABLE", "The link is shown only to whoever sent the invitation")
    if (
        stateOf(row) !== "pending" ||
        row.mailSent === "Y" ||
        row.linkShownDate ||
        nowMs() - (ms(row.sentDate) ?? 0) > REVEAL_WINDOW
    )
        return refused("LINK_SHOWN", "The link is shown only once, when the invitation is sent: resend it for a new link")
    const token = newToken()
    update(INVITATION, {
        invitationId: row.invitationId,
        tokenHash: ec.user.singleUseCodeHash(token),
        linkShownDate: ec.user.nowTimestamp
    })
    ec.logger.info("Invitation " + row.invitationId + " link shown to " + ec.user.username)
    return {applied: true, reasonCode: null, reason: null, acceptUrl: acceptUrl(token, p.baseUrl), emailAddress: row.emailAddress}
}

// ===== the token holder: check#InvitationToken, get#InvitationSummary, accept#Invitation, confirm#InvitationFactor =====
// The session that accepted: the Visit the acceptance ran in, or the account itself signed in. Only it sees the factor step
// and its key (impl-admin F-P5-9), so a forwarded or later-read email does not give out the account's authenticator key.
function currentVisitId() {
    try {
        return ec.user.visitId || null
    } catch (error) {
        return null
    }
}
function acceptingSession(row) {
    if (ec.user.userId && ec.user.userId === row.userId) return true
    return !!row.acceptVisitId && currentVisitId() === row.acceptVisitId
}
// The step a token is at: invitation (pending and in date), factor (accepted, its new factor not yet confirmed, within a
// day, for the accepting session), done (accepted in the last fifteen minutes) or spent (every other token, an unknown one
// too).
function stepOf(row, at = nowMs()) {
    if (!row) return "spent"
    const state = stateOf(row, at)
    if (state === "pending") return "invitation"
    if (state !== "accepted") return "spent"
    const accepted = ms(row.acceptedDate) ?? 0
    if (row.factorId && at - accepted <= FACTOR_WINDOW && acceptingSession(row)) {
        const factor = one("moqui.security.UserAuthcFactor", {factorId: row.factorId})
        if (factor && factor.needsValidation === "Y" && (ms(factor.thruDate) ?? Infinity) > at) return "factor"
    }
    return at - accepted <= DONE_WINDOW ? "done" : "spent"
}
// The token route's check (/i/<token>): every well-formed token is let through, so the page says "This invitation is no
// longer valid" for a spent one and an unknown one alike (the route's own page would tell them apart); routeContext says only
// whether it is open. Read only.
function checkInvitationToken(p) {
    if (!validToken(p.token)) return {valid: false, routeContext: null}
    return {valid: true, routeContext: {open: stepOf(byToken(p.token)) !== "spent"}}
}
function factorRequired(ids, userId) {
    const required = ids.some(groupId => one("moqui.security.UserGroup", {userGroupId: groupId})?.requireAuthcFactor === "Y")
    if (!required || !userId) return required
    const at = nowMs()
    return !rows("moqui.security.UserAuthcFactor", {userId}).some(
        row => openAt(row, at) && row.factorTypeEnumId !== "UafSingleUse" && row.factorTypeEnumId !== "UafEmail"
    )
}
// What the token holder may see (design §4 AcceptInvitation InvitationSummary): who invited them to which organization, the
// invited address, the access proposed by name (no group ids), the expiry, and how they accept: as the account signed in
// with that address, by signing in first, or with a new account; a wrong account signed in is told to sign out. On the factor
// step, the authenticator's setup. A spent token answers step spent and nothing else.
function getInvitationSummary(p) {
    const row = byToken(p.token)
    const step = stepOf(row)
    if (step === "spent") return {open: false, step, message: NOT_VALID}
    const out = {open: true, step, organizationName: partyName(row.organizationPartyId)}
    if (step === "done") return Object.assign(out, {signedInAsInvited: !!ec.user.userId && ec.user.userId === row.userId})
    if (step === "factor") {
        const factor = one("moqui.security.UserAuthcFactor", {factorId: row.factorId})
        const account = one(ACCOUNT, {userId: row.userId})
        const issuer = "IronStone " + out.organizationName
        return Object.assign(out, {
            factor: {
                qrLabel: account?.username || "",
                qrIssuer: issuer,
                qrSecret: factor.factorOption,
                qrUri: ec.user.totpUri(account?.username || "", issuer, factor.factorOption)
            }
        })
    }
    const ids = bundleIds(row)
    const current = ec.user.userId ? one(ACCOUNT, {userId: ec.user.userId}) : null
    const holder = accountOfAddress(row.emailAddress)
    const partyAccount = row.partyId ? one(ACCOUNT, {partyId: row.partyId}) : null
    const accountMode = current
        ? sameAddress(current.emailAddress, row.emailAddress)
            ? "signedIn"
            : "wrongAccount"
        : holder || partyAccount
          ? "signIn"
          : "create"
    return Object.assign(out, {
        inviterName: userName(row.inviterUserId),
        emailAddress: row.emailAddress,
        personName: row.partyId ? partyName(row.partyId) : [row.firstName, row.lastName].filter(Boolean).join(" "),
        bundleList: bundleSummary(ids),
        expiresDate: ms(row.expiresDate),
        accountMode,
        signedInName: current ? current.userFullName || current.username : null,
        factorRequired: factorRequired(ids, accountMode === "signedIn" ? current.userId : null)
    })
}
// Accept an open invitation as its token's holder: the account signed in with the invited address, or a new account
// (username, display name, password, verify; the invited address) when no account has the address. The inviter's authority
// and the proposal are checked again; then the organization relationship, the memberships (authorization on, so the
// framework's EECAs decide each) and, when a bundle's group requires a factor the account lacks, an authenticator factor to
// confirm; all or nothing. A second accept by the same account answers the first.
function acceptInvitation(p) {
    const row = locked(byToken(p.token))
    const step = stepOf(row)
    if (row && step !== "invitation" && ec.user.userId && row.userId === ec.user.userId)
        return {applied: true, reasonCode: null, reason: null, userId: row.userId, step, retried: true}
    if (step !== "invitation") return refused("INVITATION_SPENT", NOT_VALID)
    const authority = {}
    const blocked = inviterRefusal(row, authority)
    if (blocked) return blocked
    const notTheirs =
        "The person who invited you cannot add this account to the organization: ask them to have it invited by an administrator of all organizations"
    const outside = partyId => identityRefusal(partyId, authority.organizations, authority.global, notTheirs)
    const now = nowMs()
    let account
    let created = false
    if (ec.user.userId) {
        account = one(ACCOUNT, {userId: ec.user.userId})
        if (!sameAddress(account?.emailAddress, row.emailAddress))
            return refused(
                "WRONG_ACCOUNT",
                "You are signed in as " +
                    (account?.username || ec.user.username) +
                    ", whose address is not the one invited: sign out first"
            )
        if (row.partyId && account.partyId !== row.partyId)
            return refused("WRONG_ACCOUNT", "This invitation is for another person's account")
        const held = outside(account.partyId)
        if (held) return held
    } else {
        if (accountOfAddress(row.emailAddress) || (row.partyId && one(ACCOUNT, {partyId: row.partyId})))
            return refused("ACCOUNT_EXISTS", "An account already has this address: sign in to it, then open the link again")
        const username = text(p.username)
        if (!username) throw new Error("Choose a username")
        if (!text(p.newPassword) || text(p.newPassword) !== text(p.newPasswordVerify))
            throw new Error("Enter the password twice, the same both times")
        let partyId = row.partyId
        const held = outside(partyId)
        if (held) return held
        const displayName = text(p.userFullName)
        if (!partyId) {
            let firstName = row.firstName
            let lastName = row.lastName
            if (!firstName && !lastName) {
                const parts = displayName.split(/\s+/).filter(Boolean)
                firstName = parts.length > 1 ? parts.slice(0, -1).join(" ") : parts[0] || row.emailAddress
                lastName = parts.length > 1 ? parts[parts.length - 1] : ""
            }
            partyId = callService("mantle.party.PartyServices.create#Person", {firstName, lastName: lastName || null}).partyId
        }
        const userId = callService("mantle.party.PartyServices.create#PartyUserAccount", {
            partyId,
            username,
            emailAddress: row.emailAddress,
            userFullName: displayName || [row.firstName, row.lastName].filter(Boolean).join(" ") || null,
            newPassword: String(p.newPassword),
            newPasswordVerify: String(p.newPasswordVerify)
        }).userId
        account = one(ACCOUNT, {userId})
        created = true
    }
    if (!account.partyId) return refused("NO_PERSON", "This account has no person record: ask the person who invited you")
    const reason = ("Invitation " + row.invitationId).slice(0, 255)
    // the organization relationship, unless one of that kind is open
    const relationshipTypeEnumId = row.relationshipTypeEnumId || "PrtEmployee"
    const openRelationship = rows(RELATIONSHIP, {
        fromPartyId: account.partyId,
        toPartyId: row.organizationPartyId,
        relationshipTypeEnumId
    }).some(rel => openAt(rel, now))
    if (!openRelationship) {
        const value = ec.entity.makeValue(RELATIONSHIP)
        value.setSequencedIdPrimary()
        value.setFields(
            {
                relationshipTypeEnumId,
                fromPartyId: account.partyId,
                toPartyId: row.organizationPartyId,
                toRoleTypeId: "OrgInternal",
                fromDate: iso(now)
            },
            true,
            null,
            null
        )
        value.create()
    }
    // the memberships of the proposal, with authorization on so the sealed and privileged EECAs decide each
    const ids = bundleIds(row)
    const needsFactor = factorRequired(ids, account.userId)
    ec.context.putAll({fromDate_changeReason: reason, thruDate_changeReason: reason})
    const wasDisabled = ec.artifactExecution.authzDisabled()
    if (wasDisabled) ec.artifactExecution.enableAuthz()
    const added = []
    try {
        for (const groupId of ids) {
            const current = rows(MEMBER, {userGroupId: groupId, userId: account.userId}).some(
                member => (ms(member.thruDate) ?? Infinity) > now
            )
            if (current) continue
            const value = ec.entity.makeValue(MEMBER)
            value.setFields({userGroupId: groupId, userId: account.userId, fromDate: iso(now)}, true, null, null)
            value.create()
            added.push(groupId)
        }
    } finally {
        if (wasDisabled) ec.artifactExecution.disableAuthz()
    }
    let factorId = null
    if (needsFactor)
        factorId = callService("org.moqui.impl.UserServices.create#UserAuthcFactorTotp", {
            userId: account.userId,
            needsValidation: "Y"
        }).factorId
    ec.context.putAll({statusId_changeReason: created ? "Accepted with a new account" : "Accepted by " + account.username})
    update(INVITATION, {
        invitationId: row.invitationId,
        statusId: "UinvAccepted",
        acceptedDate: iso(now),
        userId: account.userId,
        partyId: account.partyId,
        factorId,
        acceptVisitId: factorId ? currentVisitId() : null
    })
    ec.logger.info("Invitation " + row.invitationId + " accepted by " + account.username + (created ? " (new account)" : ""))
    return {
        applied: true,
        reasonCode: null,
        reason: null,
        userId: account.userId,
        accountCreated: created,
        addedGroupIds: added,
        step: factorId ? "factor" : "done"
    }
}
// The first code of the authenticator factor the acceptance made, from the token's holder, within a day of the acceptance;
// a wrong code counts as a failed sign-in of the account.
function confirmInvitationFactor(p) {
    const row = locked(byToken(p.token))
    if (stepOf(row) !== "factor") return refused("INVITATION_SPENT", NOT_VALID)
    const out = callService("org.moqui.impl.UserServices.validate#UserAuthcFactorCode", {
        userId: row.userId,
        code: text(p.code),
        countFailure: true
    })
    if (!out.verified || out.factorId !== row.factorId)
        return refused("CODE_INVALID", "That code is not right: try the current one")
    return {applied: true, reasonCode: null, reason: null, step: "done"}
}

const operations = {
    inviteUser,
    validateInvitationImportRow,
    applyInvitationImportRow,
    findInvitationImportScopes,
    findInvitations,
    resendInvitation,
    revokeInvitation,
    revealInvitationLink,
    checkInvitationToken,
    getInvitationSummary,
    acceptInvitation,
    confirmInvitationFactor
}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown invitation operation " + op)
        return operations[op](parameters)
    }
})
