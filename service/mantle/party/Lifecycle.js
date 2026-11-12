// An account's lifecycle, mantle.party.IdentityServices (mr-boss plan/design-admin.md §4.1 Offboarding, §4 UserDetail
// LifecycleActions, LifecycleOperations and LifecycleDetail, §17.2; impl-admin P6). A UserLifecycleOperation is one request about
// an account, with independent steps (UserLifecycleOperationStep) that each keep their own outcome:
// - disable (global): now, the account's access revoked at once (the framework's revoke#AccountAccess: sessions everywhere, keys,
//   app passwords, SSH keys, phones, the agent triggers that run as the user) and the account disabled for good (disabled with no
//   disabledDateTime, which login, the session refresh and the notification socket refuse); or at a future date, written to the
//   account's terminateDate, so sign-in stops at that date with no job;
// - organization removal: the account's relationships to that organization end (now or at the date); when it then works for no
//   internal organization its group memberships end too (and, when now, its sessions), else they stay for the organizations it
//   still works for, as do its owned resources;
// - restore (global): the account enabled again and its end date cleared; no revoked credential, ended membership or paused
//   schedule comes back.
// A disable, and a removal that leaves no organization, also record the participants' steps the app supplies (participantSteps:
// a registered owner's pause, run now, and each owned resource, waiting for a new owner). A participant step names only a service
// carrying the owned-resource contract of org.moqui.admin.IdentityServices (define#OwnedResourceTransfer or
// define#OwnedResourcePause), called through the framework's call#OwnedResourceService so it runs under its own authorization,
// never this service's inheritable grant: Mantle reads no app's registry and calls no service written for something else, nor one
// the caller could not call directly. One failed step
// leaves the others, and the revocation, in place, and stays to be retried (retry#LifecycleStep); a transfer step is retried with
// the new owner, whom the owner's service checks.
//
// Who may: as every identity service, the organization entity filters of the authorization the call runs under (Identity.js
// identity and scope; nothing in scope with none named, but for ADMIN). Reads need ADMIN_IDENTITY_VIEW, requests and retries
// ADMIN_IDENTITY_MANAGE. A global operation is account-wide: an identity that also works for an organization out of scope needs
// ADMIN_IDENTITY_GLOBAL, and one holding a privileged group or a sealed permission the caller lacks is refused (the framework's
// heldBeyond); a removal that leaves no organization ends memberships, so the latter applies to it too. No one changes their own
// account here. Every change is checked against the administration path. An operation carries the organization it was requested
// for (the one removed, or the target's organization in the requester's scope), which the filters apply to, so it stays readable
// there after the identity has left. A retry with the same operationKey answers the first operation.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const identityLib = ec.resource.script("component://mr-mantle/service/mantle/party/Identity.js")
const frameworkIdentity = () => ec.resource.script("component://framework/service/org/moqui/admin/Identity.js")
const {find, one, rows, denied} = lib
const access = lib.access
const OPERATION = "mantle.party.UserLifecycleOperation"
const STEP = "mantle.party.UserLifecycleOperationStep"
const ACCOUNT = "moqui.security.UserAccount"
const RELATIONSHIP = "mantle.party.PartyRelationship"
const MEMBER = "moqui.security.UserGroupMember"
const VIEW = "ADMIN_IDENTITY_VIEW"
const MANAGE = "ADMIN_IDENTITY_MANAGE"
const GLOBAL = "ADMIN_IDENTITY_GLOBAL"
const membershipRelationships = ["PrtAgent", "PrtEmployee", "PrtMember", "PrtRepresentative"]
const staffRelationships = ["PrtAgent", "PrtEmployee", "PrtMember"]
const kinds = {disable: "UlkDisable", removeOrganization: "UlkOrgRemoval", restore: "UlkRestore"}
const kindNames = {
    UlkDisable: "Disable",
    UlkOrgRemoval: "Organization removal",
    UlkRestore: "Restore",
    UlkProvision: "Provisioning"
}
// the kinds an operation is listed by: start#Lifecycle's, and People's provisioning (request#Provisioning; impl-people P7)
const kindFilters = Object.assign({provision: "UlkProvision"}, kinds)
const kindOf = enumId => Object.keys(kindFilters).find(key => kindFilters[key] === enumId)
const statusNames = {UlopCompleted: "Completed", UlopScheduled: "Scheduled", UlopAttention: "Needs attention"}
const stepNames = {UlstDone: "Done", UlstWaiting: "Waiting for a new owner", UlstFailed: "Failed", UlstSkipped: "Skipped"}
const stepTitles = {
    revokeAccess: "Sessions, keys, app passwords, SSH keys and phones revoked",
    revokeSessions: "Signed out everywhere",
    disableAccount: "Account disabled",
    endDate: "Access ends at the date",
    endRelationships: "Organization relationships ended",
    endMemberships: "Group memberships ended",
    enableAccount: "Account enabled",
    // a provisioning's steps (request#Provisioning, from a People hire; impl-people P7)
    membership: "Organization membership",
    invite: "Invitation",
    grants: "Access granted",
    notify: "The person told"
}
// the owned-resource contract a participant step's service carries (org.moqui.admin.IdentityServices define#OwnedResource*):
// the in-parameters and out-parameters an implementing service gets from the interface
const contracts = {transfer: [["fromUserId", "toUserId"], ["transferred"]], pause: [["userId"], ["pausedCount"]]}
const contractNames = ["userId", "fromUserId", "toUserId", "reason"]

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
const timeText = value => (value == null ? "" : ec.l10n.format(Number(value), "yyyy-MM-dd HH:mm"))
function requirePermission(permission) {
    if (!ec.user.userId) denied("SIGN_IN", "Sign in to administer identities")
    if (!access.has(permission)) denied("PERMISSION_DENIED", permission + " is required")
}
function partyName(partyId) {
    if (!partyId) return ""
    const organization = one("mantle.party.Organization", {partyId})
    if (organization?.organizationName) return organization.organizationName
    const person = one("mantle.party.Person", {partyId})
    return (person ? [person.firstName, person.lastName].filter(Boolean).join(" ") : "") || partyId
}
const userNames = new Map()
function userName(userId) {
    if (!userId) return ""
    if (!userNames.has(userId)) {
        const account = one(ACCOUNT, {userId})
        userNames.set(userId, account ? account.userFullName || account.username || userId : userId)
    }
    return userNames.get(userId)
}
// a framework or owner service as the caller, with authorization on, in its own transaction and error frame: its own checks
// apply, and its failure is an error the step names, never a rollback of the operation
function ownCall(name, parameters) {
    ec.message.pushErrors()
    try {
        const result = ec.service.sync().name(name).parameters(parameters).requireNewTransaction(true).call() || {}
        if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
        return result
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}
// A participant's service through the framework's call#OwnedResourceService: it carries the contract or is not called, and runs
// under its own authorization (that call's grant is not inheritable), so this service's inheritable ALL_USERS ALLOW does not
// carry into it (F-P6-1)
function participantCall(service, action, parameters) {
    const out = ownCall("org.moqui.admin.IdentityServices.call#OwnedResourceService", {
        serviceName: service,
        contract: action,
        stepParameters: parameters
    })
    return out.result || {}
}
function carriesContract(service, action) {
    const contract = contracts[action]
    const definition = contract && service ? ec.service.getServiceDefinition(service) : null
    if (!definition) return false
    const [ins, outs] = contract
    const inNames = Array.from(definition.inParameterNames || [])
    return (
        ins.every(name => inNames.includes(name)) && outs.every(name => Object.hasOwn(definition.outParameterInfoMap || {}, name))
    )
}

// ===== the request: who, what and whether =====
// The account's open relationships to organizationPartyId (any membership kind), and the internal organizations it would still
// work for after they end.
function relationshipsTo(partyId, organizationPartyId, at) {
    return rows(RELATIONSHIP, {fromPartyId: partyId, toPartyId: organizationPartyId}).filter(
        row => membershipRelationships.includes(row.relationshipTypeEnumId) && (ms(row.thruDate) ?? Infinity) > at
    )
}
function currentMemberships(userId, at) {
    return rows(MEMBER, {userId}).filter(row => (ms(row.thruDate) ?? Infinity) > at)
}
// The request as the caller may make it: the identity (refused alike when out of scope), its kind, organization and date, what it
// would change and why it is refused, if it is.
function plan(p) {
    const kind = text(p.kind)
    if (!kinds[kind]) throw new Error("A lifecycle operation is disable, removeOrganization or restore")
    const found = identityLib.identity(p.userId)
    const account = found.account
    const now = nowMs()
    const effective = p.effectiveDate != null && p.effectiveDate !== "" ? ms(p.effectiveDate) : null
    if (effective != null && !Number.isFinite(effective)) throw new Error("The effective date is not a date")
    const future = effective != null && effective > now + 60000
    if (effective != null && effective < now - 60000) throw new Error("A lifecycle operation takes effect now or later")
    const at = future ? effective : now
    let organizationPartyId = text(p.organizationPartyId) || null
    if (organizationPartyId && !found.inScope.includes(organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Organization " + organizationPartyId + " is not available")
    const result = {
        kind,
        found,
        account,
        future,
        effective: future ? effective : null,
        at,
        isGlobal: kind !== "removeOrganization",
        organizationPartyId,
        relationships: [],
        endsMemberships: false,
        leavesOrganizations: [],
        memberships: currentMemberships(account.userId, now),
        allowed: true,
        reasonCode: null,
        reason: null
    }
    const refuse = (reasonCode, reason) => {
        if (result.allowed) Object.assign(result, {allowed: false, reasonCode, reason})
    }
    if (account.userId === ec.user.userId) refuse("SELF", "Your own account's access is changed by another administrator")
    if (kind === "removeOrganization") {
        if (!organizationPartyId) throw new Error("Choose the organization to remove the account from")
        result.relationships = account.partyId ? relationshipsTo(account.partyId, organizationPartyId, at) : []
        if (!result.relationships.length)
            refuse("NOT_A_MEMBER", userName(account.userId) + " does not work for " + partyName(organizationPartyId))
        result.leavesOrganizations = found.owners.filter(id => id !== organizationPartyId)
        result.endsMemberships = !result.leavesOrganizations.length
        if (result.endsMemberships) {
            const held = frameworkIdentity().heldBeyond(account.userId)
            if (held) refuse("IDENTITY_PRIVILEGED", held + ": ending its memberships is refused")
        }
    } else {
        // the organization a global operation is recorded for: the one asked for, or the identity's first in scope
        result.organizationPartyId = organizationPartyId || found.inScope[0] || null
        const wide = identityLib.accountWideRefusal(found) || identityLib.heldBeyondRefusal(found)
        if (wide) refuse(wide.reasonCode, wide.reason)
        const closedForGood = account.disabled === "Y" && !account.disabledDateTime
        const ended = account.terminateDate && ms(account.terminateDate) <= now
        if (kind === "disable" && (closedForGood || ended)) refuse("ALREADY_DISABLED", "The account is already disabled")
        if (kind === "restore" && !closedForGood && !account.terminateDate)
            refuse("NOTHING_TO_RESTORE", "The account is enabled and has no end date")
        if (kind === "restore" && result.future) throw new Error("A restoration takes effect now")
    }
    // the administration path: a disable, or memberships ended, must leave a usable instance administrator
    if (result.allowed && (kind === "disable" || result.endsMemberships)) {
        const proposed =
            kind === "disable"
                ? {accounts: {[account.userId]: {disabled: "Y", disabledDateTime: null}}}
                : {
                      memberships: result.memberships.map(row => ({
                          userGroupId: row.userGroupId,
                          userId: row.userId,
                          fromDate: ms(row.fromDate),
                          thruDate: Math.max(at, ms(row.fromDate) ?? at)
                      }))
                  }
        const path = frameworkIdentity().administrationPath(proposed)
        if (!path.allowed) refuse(path.reasonCode, path.reason)
    }
    return result
}

// ===== preview#Lifecycle =====
// What the operation would do: the account, the relationships and memberships that end, its credentials and live sessions
// (metadata and counts only), whether owned resources go to new owners, and why it is refused, if it is.
function previewLifecycle(p) {
    requirePermission(VIEW)
    const planned = plan(p)
    const {account, found, kind} = planned
    const credentials = ownCall("org.moqui.admin.IdentityServices.get#AccountCredentials", {userId: account.userId})
    const sessions = ownCall("org.moqui.admin.IdentityServices.find#Sessions", {
        userId: account.userId,
        activeOnly: true,
        limit: 50
    })
    const credentialList = Array.from(credentials.credentialList || [])
    const factorCount = Array.from(credentials.factorList || []).length
    const activeSessionCount = Number(sessions.activeCount ?? Array.from(sessions.sessionList || []).length)
    const memberships = planned.memberships.map(row => {
        const group = one("moqui.security.UserGroup", {userGroupId: row.userGroupId})
        return {userGroupId: row.userGroupId, description: group?.description || row.userGroupId, fromDate: ms(row.fromDate)}
    })
    const consequences = []
    const when = planned.future ? " on " + timeText(planned.effective) : " now"
    if (kind === "disable") {
        if (planned.future)
            consequences.push(
                "Sign-in stops on " + timeText(planned.effective) + " (the account's end date); nothing else changes before then"
            )
        else {
            consequences.push("Signed out everywhere: " + activeSessionCount + " live session(s) end at once")
            consequences.push(
                credentialList.length +
                    " key(s), app password(s), SSH key(s) and phone(s) revoked; agent triggers run as the user paused"
            )
            consequences.push("The account is disabled: sign-in is refused until it is restored")
        }
        consequences.push("Group memberships and organization relationships stay on record, unchanged")
        consequences.push("Owned shared resources wait for a new owner; registered schedules pause")
    } else if (kind === "removeOrganization") {
        consequences.push(
            planned.relationships.length + " relationship(s) with " + partyName(planned.organizationPartyId) + " end" + when
        )
        if (planned.endsMemberships) {
            consequences.push("It works for no other organization: its " + memberships.length + " group membership(s) end" + when)
            if (!planned.future) consequences.push("Signed out everywhere, so the ended access applies at once")
            consequences.push("Owned shared resources wait for a new owner; registered schedules pause")
        } else
            consequences.push(
                "It still works for " +
                    planned.leavesOrganizations.length +
                    " other organization(s): its account, memberships, credentials and owned resources are unchanged"
            )
    } else {
        consequences.push("The account is enabled and its end date cleared")
        consequences.push(
            "Nothing revoked comes back: keys, app passwords and SSH keys are made again by the user; ended memberships and paused schedules stay as they are"
        )
    }
    return {
        allowed: planned.allowed,
        reasonCode: planned.reasonCode,
        reason: planned.reason,
        kind,
        kindText: kindNames[kinds[kind]],
        account: {
            userId: account.userId,
            userFullName: account.userFullName || account.username || account.userId,
            username: account.username || "",
            revision: stamp(account),
            disabled: account.disabled === "Y",
            terminateDate: ms(account.terminateDate)
        },
        organizationPartyId: planned.organizationPartyId,
        organizationName: partyName(planned.organizationPartyId),
        isGlobal: planned.isGlobal,
        effectiveDate: planned.effective,
        endsMemberships: planned.endsMemberships,
        movesResources: kind === "disable" || planned.endsMemberships,
        relationshipCount: planned.relationships.length,
        memberships,
        credentialCount: credentialList.length,
        factorCount,
        activeSessionCount,
        sharedBeyondScope: found.shared,
        consequences
    }
}

// ===== start#Lifecycle =====
function makeStep(operationId, seq, fields) {
    const value = ec.entity.makeValue(STEP)
    value.setFields(
        Object.assign(
            {
                operationId,
                stepSeqId: String(seq).padStart(2, "0"),
                providerKey: "identity",
                ownerApp: "Admin",
                attemptCount: 1,
                lastAttemptDate: ec.user.nowTimestamp,
                lastAttemptByUserId: ec.user.userId
            },
            fields
        ),
        true,
        null,
        null
    )
    value.create()
    return value
}
// The account's own steps, each on its own: the function that makes the change, by kind. reasonText goes to the audit log.
const identitySteps = {
    revokeAccess(operation, reasonText) {
        const out = ownCall("org.moqui.admin.IdentityServices.revoke#AccountAccess", {
            userId: operation.userId,
            reason: reasonText
        })
        const failed = Array.from(out.failedKinds || [])
        if (failed.length) throw new Error("Not revoked: " + failed.join(", "))
        const counts = out.revokedCounts || {}
        return Object.entries(counts)
            .filter(([, count]) => Number(count) > 0)
            .map(([kind, count]) => count + " " + kind)
            .join(", ")
    },
    revokeSessions(operation, reasonText) {
        const out = ownCall("org.moqui.admin.IdentityServices.revoke#AccountAccess", {
            userId: operation.userId,
            kindList: ["sessions"],
            reason: reasonText
        })
        if (Array.from(out.failedKinds || []).length) throw new Error("The sessions were not ended")
        return (out.revokedCounts?.sessions ?? 0) + " session(s) ended"
    },
    disableAccount(operation, reasonText) {
        if (reasonText) ec.context.putAll({disabled_changeReason: reasonText})
        const value = ec.entity.makeValue(ACCOUNT)
        value.setFields({userId: operation.userId, disabled: "Y", disabledDateTime: null}, true, null, null)
        value.update()
        return ""
    },
    endDate(operation, reasonText) {
        if (reasonText) ec.context.putAll({terminateDate_changeReason: reasonText})
        const value = ec.entity.makeValue(ACCOUNT)
        value.setFields({userId: operation.userId, terminateDate: iso(ms(operation.effectiveDate))}, true, null, null)
        value.update()
        return "Sign-in stops " + timeText(ms(operation.effectiveDate))
    },
    endRelationships(operation, reasonText) {
        const at = ms(operation.effectiveDate) ?? nowMs()
        const ended = relationshipsTo(operation.partyId, operation.organizationPartyId, at)
        if (reasonText) ec.context.putAll({thruDate_changeReason: reasonText})
        for (const row of ended) {
            const value = ec.entity.makeValue(RELATIONSHIP)
            value.setFields(
                {partyRelationshipId: row.partyRelationshipId, thruDate: iso(Math.max(at, ms(row.fromDate) ?? at))},
                true,
                null,
                null
            )
            value.update()
        }
        return ended.length + " relationship(s)"
    },
    endMemberships(operation, reasonText) {
        const at = ms(operation.effectiveDate) ?? nowMs()
        const ended = currentMemberships(operation.userId, at)
        if (reasonText) ec.context.putAll({thruDate_changeReason: reasonText})
        // with authorization on, so the framework's sealed-permission and privileged-group EECAs decide each row
        for (const row of ended) {
            const value = ec.entity.makeValue(MEMBER)
            value.setFields(
                {
                    userGroupId: row.userGroupId,
                    userId: row.userId,
                    fromDate: row.fromDate,
                    thruDate: iso(Math.max(at, ms(row.fromDate) ?? at))
                },
                true,
                null,
                null
            )
            value.update()
        }
        return ended.length + " membership(s)"
    },
    enableAccount(operation, reasonText) {
        if (reasonText) ec.context.putAll({disabled_changeReason: reasonText, terminateDate_changeReason: reasonText})
        const value = ec.entity.makeValue(ACCOUNT)
        value.setFields(
            {userId: operation.userId, disabled: "N", disabledDateTime: null, successiveFailedLogins: 0, terminateDate: null},
            true,
            null,
            null
        )
        value.update()
        return "Enabled; the user makes new keys and app passwords"
    },
    // a provisioning's steps (request#Provisioning; impl-people P7), run by an identity operator as themselves (retried from
    // LifecycleDetail when the HR officer who hired could not): the employment is the membership, checked again; the invitation
    // of the person's work address with the grant proposal (invite#User, the operator's delegation rules deciding); the grants
    // of an existing account (the framework's apply#GrantProposal); the person told by the invitation's mail
    membership(operation) {
        const reason = membershipReason(operation)
        if (!reason.ok) throw new Error(reason.text)
        return reason.text
    },
    invite(operation) {
        return inviteFor(operation)
    },
    grants(operation) {
        const account = operation.partyId ? one(ACCOUNT, {partyId: operation.partyId}) : null
        if (!account) return "Given when the invitation is accepted"
        const out = ownCall("org.moqui.admin.AccessServices.apply#GrantProposal", {
            userId: account.userId,
            bundleGroupIdList: proposalOf(operation),
            reason: "Hired (People)"
        })
        if (out.applied === false) throw new Error(out.reason || "The access was not granted")
        return "Groups: " + proposalOf(operation).join(", ")
    },
    notify(operation) {
        const invitation = invitationOf(operation)
        if (!invitation) throw new Error("The invitation is not sent yet")
        if (invitation.mailSent !== "Y") throw new Error("Show the invitation link from Invitations")
        return "Mailed with the invitation"
    }
}
// Run one of the account's steps: its outcome, never an exception (a failure is logged by name and the others go on)
function runIdentityStep(operation, stepKind, reasonText) {
    try {
        return {statusId: "UlstDone", reason: identitySteps[stepKind](operation, reasonText) || null}
    } catch (error) {
        ec.logger.error("Lifecycle " + operation.operationId + " step " + stepKind + " failed: " + error.message)
        ec.message.clearErrors()
        return {statusId: "UlstFailed", reasonCode: "STEP_FAILED", reason: String(error.message).slice(0, 1000)}
    }
}
// A participant's pause, run now as the caller
function runPause(operation, step, reasonText) {
    try {
        if (!carriesContract(step.actionService, "pause")) throw new Error(step.actionService + " is not a lifecycle pause")
        const out = participantCall(step.actionService, "pause", {userId: operation.userId, reason: reasonText})
        return {statusId: "UlstDone", reason: Number(out.pausedCount || 0) + " paused"}
    } catch (error) {
        ec.logger.error("Lifecycle " + operation.operationId + " pause " + step.providerKey + " failed: " + error.message)
        return {statusId: "UlstFailed", reasonCode: "STEP_FAILED", reason: String(error.message).slice(0, 1000)}
    }
}
function refreshStatus(operationId) {
    const operation = one(OPERATION, {operationId})
    const steps = rows(STEP, {operationId})
    const statusId = steps.some(step => step.statusId === "UlstFailed" || step.statusId === "UlstWaiting")
        ? "UlopAttention"
        : (ms(operation.effectiveDate) ?? 0) > nowMs()
          ? "UlopScheduled"
          : "UlopCompleted"
    if (statusId !== operation.statusId) {
        const value = ec.entity.makeValue(OPERATION)
        value.setFields({operationId, statusId}, true, null, null)
        value.update()
    }
    return statusId
}
// start#Lifecycle: the operation recorded and its steps run, each on its own.
function startLifecycle(p) {
    requirePermission(MANAGE)
    const operationKey = text(p.operationKey) || null
    if (operationKey) {
        const earlier = one(OPERATION, {operationKey})
        if (earlier) {
            if (earlier.userId !== text(p.userId) || earlier.requestedByUserId !== ec.user.userId)
                return refused("KEY_IN_USE", "That operation key belongs to another request")
            return {applied: true, retried: true, operationId: earlier.operationId, statusId: earlier.statusId}
        }
    }
    const planned = plan(p)
    const {account, kind} = planned
    if (text(p.expectedRevision) && text(p.expectedRevision) !== stamp(account))
        return refused("REVISION_CHANGED", "The account changed since you read it; reload it", {revision: stamp(account)})
    if (!planned.allowed) return refused(planned.reasonCode, planned.reason)
    const reasonText = text(p.reason).slice(0, 255) || null
    const operation = ec.entity.makeValue(OPERATION)
    operation.setSequencedIdPrimary()
    operation.setFields(
        {
            userId: account.userId,
            partyId: account.partyId || null,
            kindEnumId: kinds[kind],
            isGlobal: planned.isGlobal ? "Y" : "N",
            organizationPartyId: planned.organizationPartyId,
            effectiveDate: iso(planned.effective),
            reason: text(p.reason) || null,
            sourceReference: text(p.sourceReference) || null,
            statusId: planned.future ? "UlopScheduled" : "UlopCompleted",
            accountRevision: stamp(account),
            requestedByUserId: ec.user.userId,
            requestedDate: ec.user.nowTimestamp,
            operationKey
        },
        true,
        null,
        null
    )
    operation.create()
    const operationId = operation.get("operationId")
    const record = one(OPERATION, {operationId})
    // the account's own steps, in order: access revoked before the account changes (its own transaction, so it stays revoked
    // whatever follows), then the account, its relationships and memberships
    const order =
        kind === "disable"
            ? planned.future
                ? ["endDate"]
                : ["revokeAccess", "disableAccount"]
            : kind === "removeOrganization"
              ? ["endRelationships"].concat(
                    planned.endsMemberships ? (planned.future ? ["endMemberships"] : ["revokeSessions", "endMemberships"]) : []
                )
              : ["enableAccount"]
    let seq = 0
    for (const stepKind of order) {
        const outcome = runIdentityStep(record, stepKind, reasonText)
        makeStep(
            operationId,
            ++seq,
            Object.assign({stepKind, title: stepTitles[stepKind]}, outcome, {
                completedDate: outcome.statusId === "UlstDone" ? ec.user.nowTimestamp : null
            })
        )
    }
    // the participants' steps the app supplies: a disable, or a removal that leaves no organization (the identity leaves the staff)
    const participantSteps = kind === "disable" || planned.endsMemberships ? Array.from(p.participantSteps || []) : []
    for (const given of participantSteps) {
        const action = text(given?.action)
        const fields = {
            stepKind: action === "pause" ? "pause" : "transfer",
            providerKey: text(given?.providerKey).slice(0, 255) || "participant",
            ownerApp: text(given?.ownerApp).slice(0, 60) || null,
            title: text(given?.title).slice(0, 255) || null,
            resourceKind: text(given?.resourceKind).slice(0, 60) || null,
            resourceId: text(given?.resourceId).slice(0, 255) || null,
            resourceName: text(given?.resourceName).slice(0, 255) || null,
            actionService: text(given?.actionService).slice(0, 255) || null,
            resourceParameter: text(given?.resourceParameter).slice(0, 60) || null
        }
        let outcome
        if (!["pause", "transfer"].includes(action) || !carriesContract(fields.actionService, action)) {
            ec.logger.error("Lifecycle " + operationId + ": participant " + fields.providerKey + " names no lifecycle " + action)
            outcome = {statusId: "UlstFailed", reasonCode: "NOT_A_PARTICIPANT", reason: "Not a registered lifecycle action"}
        } else if (action === "pause") outcome = runPause(record, fields, reasonText)
        else if (!fields.resourceId || !fields.resourceParameter || contractNames.includes(fields.resourceParameter))
            outcome = {statusId: "UlstFailed", reasonCode: "NOT_A_PARTICIPANT", reason: "The resource is not named"}
        else outcome = {statusId: "UlstWaiting", attemptCount: 0, reason: "Waiting for a new owner"}
        makeStep(
            operationId,
            ++seq,
            Object.assign(fields, outcome, {completedDate: outcome.statusId === "UlstDone" ? ec.user.nowTimestamp : null})
        )
    }
    const statusId = refreshStatus(operationId)
    ec.logger.warn(
        "Lifecycle " +
            operationId +
            " " +
            kind +
            " of " +
            account.username +
            " by " +
            ec.user.username +
            " (" +
            statusId +
            ")" +
            (reasonText ? ": " + reasonText : "")
    )
    return {applied: true, reasonCode: null, reason: null, operationId, statusId, retried: false}
}

// ===== reads =====
// An operation the caller may read: the organization it was requested for is in the caller's scope (an operation of no
// organization, an identity of none, is ADMIN's); refused alike when missing or out of scope.
function scopedOperation(operationId, userScope = identityLib.scope()) {
    const row = text(operationId) ? one(OPERATION, {operationId: text(operationId)}) : null
    const visible = row && (row.organizationPartyId ? userScope.organizationIds.includes(row.organizationPartyId) : userScope.all)
    if (!visible) denied("RECORD_UNAVAILABLE", "Lifecycle operation " + text(operationId) + " is not available")
    return row
}
function stepView(step, canManage) {
    const retryable = canManage && (step.statusId === "UlstFailed" || step.statusId === "UlstWaiting")
    return {
        stepSeqId: step.stepSeqId,
        stepKind: step.stepKind,
        providerKey: step.providerKey,
        ownerApp: step.ownerApp || "",
        title: step.title || stepTitles[step.stepKind] || step.stepKind,
        resourceKind: step.resourceKind || "",
        resourceName: step.resourceName || "",
        statusId: step.statusId,
        statusText:
            step.statusId === "UlstWaiting" && step.reasonCode === "OPERATOR_REQUIRED"
                ? "Waiting for an identity operator"
                : stepNames[step.statusId] || step.statusId,
        attemptCount: Number(step.attemptCount || 0),
        reasonCode: step.reasonCode || null,
        reason: step.reason || "",
        toUserName: userName(step.toUserId),
        completedDate: ms(step.completedDate),
        lastAttemptDate: ms(step.lastAttemptDate),
        participant: step.providerKey !== "identity",
        canTransfer: retryable && step.stepKind === "transfer",
        canRetry: retryable && step.stepKind !== "transfer"
    }
}
function operationView(row, steps) {
    const done = steps.filter(step => step.statusId === "UlstDone" || step.statusId === "UlstSkipped").length
    const failed = steps.filter(step => step.statusId === "UlstFailed").length
    const waiting = steps.filter(step => step.statusId === "UlstWaiting").length
    const operatorWaits = steps.filter(step => step.statusId === "UlstWaiting" && step.reasonCode === "OPERATOR_REQUIRED").length
    return {
        operationId: row.operationId,
        userId: row.userId,
        userName: userName(row.userId) || partyName(row.partyId),
        kind: kindOf(row.kindEnumId),
        kindText: kindNames[row.kindEnumId] || row.kindEnumId,
        isGlobal: row.isGlobal === "Y",
        scopeText: row.isGlobal === "Y" ? "Global" : partyName(row.organizationPartyId),
        organizationPartyId: row.organizationPartyId || null,
        organizationName: partyName(row.organizationPartyId),
        effectiveDate: ms(row.effectiveDate),
        reason: row.reason || "",
        sourceReference: row.sourceReference || "",
        sourceText: row.sourceReference ? "People " + row.sourceReference : "Admin",
        requestedByName: userName(row.requestedByUserId),
        requestedDate: ms(row.requestedDate),
        statusId: row.statusId,
        statusText: statusNames[row.statusId] || row.statusId,
        stepCount: steps.length,
        doneCount: done,
        failedCount: failed,
        waitingCount: waiting,
        progressText: done + " of " + steps.length + " done",
        nextText: failed
            ? failed + " failed: retry"
            : operatorWaits
              ? operatorWaits + " waiting for an identity operator"
              : waiting
                ? waiting + " waiting for a new owner"
                : "",
        accountRevision: row.accountRevision || "",
        revision: stamp(row)
    }
}
// get#Lifecycle: one operation and its steps, as the caller may read them.
function getLifecycle(p) {
    requirePermission(VIEW)
    const row = scopedOperation(p.operationId)
    const steps = rows(STEP, {operationId: row.operationId}).sort((a, b) => a.stepSeqId.localeCompare(b.stepSeqId))
    const canManage = access.has(MANAGE)
    return {operation: operationView(row, steps), stepList: steps.map(step => stepView(step, canManage)), canManage}
}
// find#LifecycleOperations: the operations of the organizations the caller administers (with authorization as the caller has
// it, so an app's organization filters on UserLifecycleOperation apply too), newest first, narrowed and paged.
function findLifecycleOperations(p) {
    requirePermission(VIEW)
    const userScope = identityLib.scope()
    let organizationIds = userScope.organizationIds
    if (text(p.organizationPartyId)) {
        if (!organizationIds.includes(text(p.organizationPartyId)))
            denied("RECORD_UNAVAILABLE", "Organization " + text(p.organizationPartyId) + " is not available")
        organizationIds = [text(p.organizationPartyId)]
    }
    const factory = ec.entity.conditionFactory
    const byOrganization = factory.makeCondition("organizationPartyId", "in", organizationIds.length ? organizationIds : ["_NA_"])
    let found = ec.entity
        .find(OPERATION)
        .condition(
            userScope.all && !text(p.organizationPartyId)
                ? factory.makeCondition([byOrganization, factory.makeCondition("organizationPartyId", "equals", null)], "or")
                : byOrganization
        )
    if (text(p.userId)) found = found.condition("userId", text(p.userId))
    if (text(p.kind)) found = found.condition("kindEnumId", kindFilters[text(p.kind)] || "_NA_")
    if (text(p.statusId)) found = found.condition("statusId", text(p.statusId))
    if (p.fromDate != null && p.fromDate !== "") found = found.condition("requestedDate", ">=", iso(ms(p.fromDate)))
    if (p.thruDate != null && p.thruDate !== "") found = found.condition("requestedDate", "<", iso(ms(p.thruDate)))
    const all = Array.from(found.orderBy("-requestedDate").limit(1000).list())
    const limit = Math.max(1, Math.min(200, Number(p.pageSize || 50)))
    const offset = Math.max(0, Number(p.pageIndex || 0)) * limit
    const operationList = all
        .slice(offset, offset + limit)
        .map(row => operationView(row, rows(STEP, {operationId: row.operationId})))
    return {operationList, operationListCount: all.length, pageIndex: offset / limit, pageSize: limit}
}

// ===== retry#LifecycleStep =====
// The administration path of an account step run again (a disable, memberships ended): a refusal, or null.
function pathRefusal(operation, stepKind) {
    const at = ms(operation.effectiveDate) ?? nowMs()
    const proposed =
        stepKind === "disableAccount"
            ? {accounts: {[operation.userId]: {disabled: "Y", disabledDateTime: null}}}
            : stepKind === "endMemberships"
              ? {
                    memberships: currentMemberships(operation.userId, nowMs()).map(row => ({
                        userGroupId: row.userGroupId,
                        userId: row.userId,
                        fromDate: ms(row.fromDate),
                        thruDate: Math.max(at, ms(row.fromDate) ?? at)
                    }))
                }
              : null
    if (!proposed) return null
    const path = frameworkIdentity().administrationPath(proposed)
    return path.allowed ? null : refused(path.reasonCode, path.reason)
}
// A failed step run again, or a transfer step with its new owner (toUserId: an account in the caller's scope, other than the
// operation's; the owner's service checks it may own the resource). A global operation's account steps are account-wide again.
function retryLifecycleStep(p) {
    requirePermission(MANAGE)
    const userScope = identityLib.scope()
    const operation = scopedOperation(p.operationId, userScope)
    const step = one(STEP, {operationId: operation.operationId, stepSeqId: text(p.stepSeqId)})
    if (!step) denied("RECORD_UNAVAILABLE", "The step is not available")
    if (text(p.expectedRevision) && text(p.expectedRevision) !== stamp(step))
        return refused("REVISION_CHANGED", "The step changed since you read it; reload it", {revision: stamp(step)})
    if (!["UlstFailed", "UlstWaiting"].includes(step.statusId))
        return refused("STEP_DONE", "The step is " + (stepNames[step.statusId] || step.statusId).toLowerCase())
    const reasonText = text(p.reason).slice(0, 255) || null
    let outcome
    let toUserId = null
    if (step.providerKey === "identity") {
        // the account's own step: for a global operation the identity in scope again and the account-wide rules; for a removal
        // (whose identity may have left every organization in scope) the operation's organization in scope, and the privileged
        // rule again where it signs out or ends memberships; either way the administration path again
        if (operation.userId === ec.user.userId)
            return refused("SELF", "Your own account's access is changed by another administrator")
        if (!identitySteps[step.stepKind]) return refused("NOT_RETRYABLE", "This step cannot be run again")
        if (operation.isGlobal === "Y") {
            const found = identityLib.identity(operation.userId, userScope)
            const wide = identityLib.accountWideRefusal(found) || identityLib.heldBeyondRefusal(found)
            if (wide) return wide
        } else if (step.stepKind === "revokeSessions" || step.stepKind === "endMemberships") {
            const held = frameworkIdentity().heldBeyond(operation.userId)
            if (held) return refused("IDENTITY_PRIVILEGED", held + ": ending its memberships is refused")
        }
        const path = pathRefusal(operation, step.stepKind)
        if (path) return path
        outcome = runIdentityStep(operation, step.stepKind, reasonText)
    } else if (step.stepKind === "pause") {
        outcome = runPause(operation, step, reasonText)
    } else {
        toUserId = text(p.toUserId)
        if (!toUserId) throw new Error("Choose the new owner")
        if (toUserId === operation.userId) return refused("SAME_OWNER", "Choose someone other than the account offboarded")
        if (toUserId === ec.user.userId)
            return refused(
                "SELF_OWNER",
                "Choose a colleague: a leaver's resources are not handed to the administrator moving them"
            )
        if (!identityLib.inScope(toUserId).length)
            denied("RECORD_UNAVAILABLE", "User " + toUserId + " is not available as a new owner")
        if (!carriesContract(step.actionService, "transfer") || contractNames.includes(step.resourceParameter))
            outcome = {statusId: "UlstFailed", reasonCode: "NOT_A_PARTICIPANT", reason: "Not a registered lifecycle action"}
        else
            try {
                const out = participantCall(step.actionService, "transfer", {
                    [step.resourceParameter]: step.resourceId,
                    fromUserId: operation.userId,
                    toUserId,
                    reason: reasonText
                })
                outcome = out.transferred
                    ? {statusId: "UlstDone", reasonCode: null, reason: "Now " + userName(toUserId) + "'s"}
                    : {statusId: "UlstFailed", reasonCode: "NOT_TRANSFERRED", reason: "The owner did not move it"}
            } catch (error) {
                ec.logger.error(
                    "Lifecycle " + operation.operationId + " transfer of " + step.resourceId + " failed: " + error.message
                )
                outcome = {statusId: "UlstFailed", reasonCode: "STEP_FAILED", reason: String(error.message).slice(0, 1000)}
            }
    }
    const value = ec.entity.makeValue(STEP)
    value.setFields(
        Object.assign({reasonCode: null}, outcome, {
            operationId: step.operationId,
            stepSeqId: step.stepSeqId,
            attemptCount: Number(step.attemptCount || 0) + 1,
            lastAttemptDate: ec.user.nowTimestamp,
            lastAttemptByUserId: ec.user.userId,
            toUserId: outcome.statusId === "UlstDone" && toUserId ? toUserId : step.toUserId || null,
            completedDate: outcome.statusId === "UlstDone" ? ec.user.nowTimestamp : null
        }),
        true,
        null,
        null
    )
    value.update()
    const statusId = refreshStatus(operation.operationId)
    return {
        applied: outcome.statusId === "UlstDone",
        reasonCode: outcome.statusId === "UlstDone" ? null : outcome.reasonCode || "STEP_FAILED",
        reason: outcome.statusId === "UlstDone" ? null : outcome.reason,
        stepStatusId: outcome.statusId,
        statusId
    }
}

// ===== People's provisioning and access end (request#Provisioning, request#AccessEnd; impl-people P7, design-admin §4.1) =====
// A hire HR asked an account for, and a separation, each a committed People fact (an applied EmploymentChange), reach Admin's
// lifecycle as an operation of the employer, keyed by the change (people-provision- or people-access-end- and its id, unless the
// caller names the key): a retry answers the first operation and never makes a second identity or invitation. The steps run now
// when the caller is an identity operator of the organization (ADMIN_IDENTITY_MANAGE, the organization in their scope); else they
// wait for one (OPERATOR_REQUIRED), who runs them from LifecycleDetail as themselves, so Admin's delegation rules decide what is
// given and no step runs with authority the requester lacks. A provisioning's steps: the organization membership (the employment
// is it, F49: no second relationship), the account (an existing one, or an invitation of the person's work address), the grant
// proposal (the app's registered bundles: given at the invitation's acceptance, or to an existing account) and the person told
// (the invitation's mail). An access end's: the employer's other relationships of the person ended, and, when the person then
// works for no internal organization, the account signed out and its memberships ended (at the separation's date); a person who
// still works for another organization keeps the account's access. A failure is the step's, never the People fact's.
const CHANGE = "mantle.humanres.employment.EmploymentChange"
// the operation's own records written with authorization off, once the request is checked: its requester need not be in the
// organization's identity scope (a manager whose approval applied the separation); the steps themselves run as the caller
function recordWrite(write) {
    const already = ec.artifactExecution.disableAuthz()
    try {
        return write()
    } finally {
        if (!already) ec.artifactExecution.enableAuthz()
    }
}
const CHECKLIST_STEP = "mantle.humanres.checklist.ChecklistStep"
const INVITATION = "mantle.party.UserInvitation"
const peopleSource = changeId => "EmploymentChange:" + changeId
// The change the request is for and whether the caller may make it: an applied change of the kind, asked for by the caller, or
// the caller an HR editor of its employer (People's scope), an identity operator of the organization or the one whose decision
// applied it. Refused alike when missing (RECORD_UNAVAILABLE).
function peopleChange(p, kinds) {
    const id = text(p.employmentChangeId)
    const change = id ? one(CHANGE, {employmentChangeId: id}) : null
    if (!change || change.statusId !== "EchApplied" || !kinds.includes(change.changeKindEnumId))
        denied("RECORD_UNAVAILABLE", "Employment change " + id + " is not available")
    if (!ec.user.userId) denied("SIGN_IN", "Sign in to request access")
    const org = change.organizationPartyId
    const allowed =
        change.requestedByUserId === ec.user.userId ||
        (canOperate(org) && access.has(MANAGE)) ||
        hrEditorOf(org) ||
        decidedBy(change.employmentChangeId)
    if (!allowed) denied("RECORD_UNAVAILABLE", "Employment change " + id + " is not available")
    return change
}
function hrEditorOf(organizationPartyId) {
    if (!ec.user.hasPermission("PEOPLE_HR_EDIT") || !ec.user.hasPermission("PEOPLE_HR_VIEW")) return false
    const people = ec.resource.script("component://mr-mantle/service/mantle/humanres/People.js")
    return people.scopeOf().organizationPartyIds.includes(organizationPartyId)
}
function decidedBy(employmentChangeId) {
    const approvalIds = rows("mantle.humanres.approval.PeopleApproval", {
        approvalKindEnumId: "PakEmploymentChange",
        sourceId: employmentChangeId
    }).map(row => row.peopleApprovalId)
    return (
        approvalIds.length > 0 &&
        find("mantle.humanres.approval.PeopleApprovalDecision")
            .condition("peopleApprovalId", "in", approvalIds)
            .condition("decidedByUserId", ec.user.userId)
            .count() > 0
    )
}
// whether the caller runs the steps now: an identity operator of the organization (never of their own account)
function canOperate(organizationPartyId) {
    return !!ec.user.userId && access.has(MANAGE) && identityLib.scope().organizationIds.includes(organizationPartyId)
}
// The person's work address (EmailWork, else EmailPrimary), for an invitation.
function workAddress(partyId) {
    for (const purpose of ["EmailWork", "EmailPrimary"]) {
        const mechIds = rows("mantle.party.contact.PartyContactMech", {partyId, contactMechPurposeId: purpose})
            .filter(row => openAt(row))
            .map(row => row.contactMechId)
        if (!mechIds.length) continue
        const mech = Array.from(find("mantle.party.contact.ContactMech").condition("contactMechId", "in", mechIds).list()).find(
            row => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text(row.infoString))
        )
        if (mech) return text(mech.infoString).toLowerCase()
    }
    return null
}
// the grant proposal the operation carries (its grants step's resource)
function proposalOf(operation) {
    const step = rows(STEP, {operationId: operation.operationId, stepKind: "grants"})[0]
    return text(step?.resourceId).split(",").map(text).filter(Boolean)
}
const invitationKey = operation => "people-invite-" + operation.operationId
const invitationOf = operation => one(INVITATION, {operationKey: invitationKey(operation)})
// The employment is the organization membership (F49): the PrtEmployee relationship from the person to the organization, open
// at the operation's date or later.
function membershipReason(operation) {
    const at = ms(operation.effectiveDate) ?? nowMs()
    const open = rows(RELATIONSHIP, {
        relationshipTypeEnumId: "PrtEmployee",
        fromPartyId: operation.partyId,
        toPartyId: operation.organizationPartyId
    }).some(row => (ms(row.thruDate) ?? Infinity) > at)
    return open
        ? {ok: true, text: "The employment is the organization membership"}
        : {ok: false, text: "The person is not employed by " + partyName(operation.organizationPartyId)}
}
// The invitation (invite#User as the caller, under a key of the operation, so a retry answers it): the person's work address,
// the employer and the grant proposal; the invite and notify steps follow its outcome.
function inviteFor(operation) {
    const account = operation.partyId ? one(ACCOUNT, {partyId: operation.partyId}) : null
    if (account) return "Has the account " + (account.username || account.userId)
    const address = workAddress(operation.partyId)
    if (!address) throw new Error("No work email: add one to the person, then retry")
    const out = ownCall("mantle.party.IdentityServices.invite#User", {
        emailAddress: address,
        partyId: operation.partyId,
        organizationPartyId: operation.organizationPartyId,
        relationshipTypeEnumId: "PrtEmployee",
        bundleGroupIdList: proposalOf(operation),
        operationKey: invitationKey(operation)
    })
    if (out.applied === false) throw new Error(out.reason || "The invitation was not sent")
    const invitation = invitationOf(operation)
    const notify = rows(STEP, {operationId: operation.operationId, stepKind: "notify"})[0]
    if (notify && notify.statusId !== "UlstDone" && invitation?.mailSent === "Y")
        recordWrite(() => {
            const value = ec.entity.makeValue(STEP)
            value.setFields(
                {
                    operationId: notify.operationId,
                    stepSeqId: notify.stepSeqId,
                    statusId: "UlstDone",
                    reasonCode: null,
                    reason: "Mailed with the invitation",
                    completedDate: ec.user.nowTimestamp
                },
                true,
                null,
                null
            )
            value.update()
        })
    return "Sent to " + address + (out.linkPending ? "; show its link from Invitations" : "")
}
// A step now (an identity operator) or waiting for one; its outcome, never an exception.
function stepOutcome(operation, stepKind, runNow, reasonText) {
    if (!runNow)
        return {
            statusId: "UlstWaiting",
            attemptCount: 0,
            reasonCode: "OPERATOR_REQUIRED",
            reason: "Waiting for an identity operator"
        }
    return runIdentityStep(operation, stepKind, reasonText)
}
function newOperation(fields) {
    const operation = ec.entity.makeValue(OPERATION)
    operation.setSequencedIdPrimary()
    operation.setFields(
        Object.assign(
            {
                isGlobal: "N",
                statusId: "UlopCompleted",
                requestedByUserId: ec.user.userId,
                requestedDate: ec.user.nowTimestamp
            },
            fields
        ),
        true,
        null,
        null
    )
    operation.create()
    return one(OPERATION, {operationId: operation.get("operationId")})
}
// The change's answer recorded on it (EmploymentChange accessOperationId, the failure cleared) and its IT checklist tasks linked
// to the operation (People's ChecklistStep, the task showing Admin's outcome).
function recordOnChange(change, operationId) {
    const value = ec.entity.makeValue(CHANGE)
    value.setFields(
        {
            employmentChangeId: change.employmentChangeId,
            accessOperationId: operationId,
            accessRequestFailure: null,
            accessRequestDate: ec.user.nowTimestamp
        },
        true,
        null,
        null
    )
    value.update()
    const roots = rows("mantle.humanres.checklist.EmploymentChecklist", {employmentChangeId: change.employmentChangeId}).map(
        row => row.workEffortId
    )
    if (!roots.length) return
    const tasks = Array.from(find("mantle.work.effort.WorkEffort").condition("rootWorkEffortId", "in", roots).list()).map(
        row => row.workEffortId
    )
    if (!tasks.length) return
    for (const step of Array.from(
        find(CHECKLIST_STEP).condition("workEffortId", "in", tasks).condition("sourceLinkEnumId", "ClsItAccess").list()
    )) {
        const linked = ec.entity.makeValue(CHECKLIST_STEP)
        linked.setFields({workEffortId: step.workEffortId, operationId}, true, null, null)
        linked.update()
    }
}
function earlierAnswer(change, operationKey) {
    const earlier = one(OPERATION, {operationKey})
    if (!earlier) return null
    if (earlier.sourceReference !== peopleSource(change.employmentChangeId))
        return refused("KEY_IN_USE", "That operation key belongs to another request")
    recordWrite(() => recordOnChange(change, earlier.operationId))
    return {applied: true, retried: true, operationId: earlier.operationId, statusId: earlier.statusId}
}
// request#Provisioning: a hire HR asked an account for.
function requestProvisioning(p) {
    const change = peopleChange(p, ["EckHire"])
    if (change.accessRequested !== "Y") return refused("NOT_REQUESTED", "The hire asked for no account")
    const operationKey = text(p.operationKey).slice(0, 255) || "people-provision-" + change.employmentChangeId
    const earlier = earlierAnswer(change, operationKey)
    if (earlier) return earlier
    const ids = Array.from(
        new Set(
            Array.from(p.bundleGroupIdList || [])
                .map(text)
                .filter(Boolean)
        )
    )
    if (!ids.length) throw new Error("Name the access the account is proposed")
    for (const groupId of ids) {
        const bundle = one("moqui.security.CapabilityBundle", {userGroupId: groupId})
        if (!bundle || bundle.disabled === "Y") return refused("GRANT_INVALID", groupId + " is not a registered bundle")
    }
    const org = change.organizationPartyId
    const account = one(ACCOUNT, {partyId: change.partyId})
    const runNow = canOperate(org) && account?.userId !== ec.user.userId
    const reasonText = text(p.reason).slice(0, 255) || "Hired"
    const operation = recordWrite(() =>
        newOperation({
            userId: account?.userId || null,
            partyId: change.partyId,
            kindEnumId: "UlkProvision",
            organizationPartyId: org,
            effectiveDate: change.effectiveDate,
            reason: text(p.reason) || null,
            sourceReference: peopleSource(change.employmentChangeId),
            operationKey
        })
    )
    const operationId = operation.operationId
    const membership = membershipReason(operation)
    const record = (seq, fields) => recordWrite(() => makeStep(operationId, seq, fields))
    record(1, {
        stepKind: "membership",
        title: stepTitles.membership,
        statusId: membership.ok ? "UlstDone" : "UlstFailed",
        reasonCode: membership.ok ? null : "NOT_EMPLOYED",
        reason: membership.text,
        completedDate: membership.ok ? ec.user.nowTimestamp : null
    })
    // the grant proposal first, so the invitation reads it
    const grantsStep = record(3, {
        stepKind: "grants",
        title: stepTitles.grants,
        resourceKind: "bundles",
        resourceId: ids.join(","),
        resourceName: ids.join(", "),
        statusId: account ? "UlstWaiting" : "UlstSkipped",
        attemptCount: 0,
        reasonCode: account ? "OPERATOR_REQUIRED" : null,
        reason: account ? "Waiting for an identity operator" : "Given when the invitation is accepted"
    })
    record(4, {
        stepKind: "notify",
        title: stepTitles.notify,
        statusId: account ? "UlstSkipped" : "UlstWaiting",
        attemptCount: 0,
        reason: account ? "Has an account" : "Sent with the invitation"
    })
    let accountOutcome
    if (account) accountOutcome = {statusId: "UlstSkipped", reason: "Has the account " + (account.username || account.userId)}
    else if (!workAddress(change.partyId))
        accountOutcome = {
            statusId: "UlstFailed",
            reasonCode: "NO_EMAIL",
            reason: "No work email: add one to the person, then retry"
        }
    else accountOutcome = stepOutcome(operation, "invite", runNow, reasonText)
    record(
        2,
        Object.assign({stepKind: "invite", title: stepTitles.invite, resourceKind: "invitation"}, accountOutcome, {
            completedDate: accountOutcome.statusId === "UlstDone" ? ec.user.nowTimestamp : null
        })
    )
    if (account && runNow) {
        const outcome = runIdentityStep(operation, "grants", reasonText)
        recordWrite(() => {
            const value = ec.entity.makeValue(STEP)
            value.setFields(
                Object.assign({operationId, stepSeqId: grantsStep.get("stepSeqId"), reasonCode: null}, outcome, {
                    attemptCount: 1,
                    completedDate: outcome.statusId === "UlstDone" ? ec.user.nowTimestamp : null
                }),
                true,
                null,
                null
            )
            value.update()
        })
    }
    const statusId = recordWrite(() => refreshStatus(operationId))
    recordWrite(() => recordOnChange(change, operationId))
    ec.logger.info("Provisioning " + operationId + " of " + partyName(change.partyId) + " (" + statusId + ") for a People hire")
    return {applied: true, reasonCode: null, reason: null, operationId, statusId, retried: false}
}
// The internal organizations the person works for at the date other than the one, by any membership relationship.
function otherOrganizations(partyId, organizationPartyId, at) {
    const ids = rows(RELATIONSHIP, {fromPartyId: partyId})
        .filter(
            row =>
                membershipRelationships.includes(row.relationshipTypeEnumId) &&
                row.toPartyId !== organizationPartyId &&
                (ms(row.thruDate) ?? Infinity) > at
        )
        .map(row => row.toPartyId)
    return Array.from(new Set(ids)).filter(id => !!one("mantle.party.PartyRole", {partyId: id, roleTypeId: "OrgInternal"}))
}
// request#AccessEnd: a separation applied.
function requestAccessEnd(p) {
    const change = peopleChange(p, ["EckSeparation"])
    const account = one(ACCOUNT, {partyId: change.partyId})
    if (!account) return refused("NO_ACCOUNT", "The person has no account: there is no access to end")
    const operationKey = text(p.operationKey).slice(0, 255) || "people-access-end-" + change.employmentChangeId
    const earlier = earlierAnswer(change, operationKey)
    if (earlier) return earlier
    const org = change.organizationPartyId
    const at = ms(change.effectiveDate) ?? nowMs()
    const runNow = canOperate(org) && account.userId !== ec.user.userId
    const reasonText = text(p.reason).slice(0, 255) || "Separated"
    const operation = recordWrite(() =>
        newOperation({
            userId: account.userId,
            partyId: change.partyId,
            kindEnumId: "UlkOrgRemoval",
            organizationPartyId: org,
            effectiveDate: change.effectiveDate,
            reason: text(p.reason) || null,
            sourceReference: peopleSource(change.employmentChangeId),
            accountRevision: stamp(account),
            statusId: at > nowMs() ? "UlopScheduled" : "UlopCompleted",
            operationKey
        })
    )
    const operationId = operation.operationId
    let seq = 0
    const record = (stepKind, outcome) =>
        recordWrite(() =>
            makeStep(
                operationId,
                ++seq,
                Object.assign({stepKind, title: stepTitles[stepKind]}, outcome, {
                    completedDate: outcome.statusId === "UlstDone" ? ec.user.nowTimestamp : null
                })
            )
        )
    // the employer's other relationships of the person (the employment itself ended with the separation)
    const others = relationshipsTo(change.partyId, org, at)
    record(
        "endRelationships",
        others.length
            ? stepOutcome(operation, "endRelationships", runNow, reasonText)
            : {statusId: "UlstDone", reason: "The employment ended with the separation"}
    )
    const elsewhere = otherOrganizations(change.partyId, org, at)
    if (elsewhere.length)
        record("endMemberships", {
            statusId: "UlstSkipped",
            reason: "Works for " + elsewhere.map(partyName).join(", ") + ": the account's access stays"
        })
    else {
        const held = runNow ? frameworkIdentity().heldBeyond(account.userId) : null
        const kindsInOrder = at > nowMs() ? ["endMemberships"] : ["revokeSessions", "endMemberships"]
        for (const stepKind of kindsInOrder) {
            const path = runNow && !held ? pathRefusal(operation, stepKind) : null
            record(
                stepKind,
                held
                    ? {
                          statusId: "UlstFailed",
                          reasonCode: "IDENTITY_PRIVILEGED",
                          reason: held + ": ending its memberships is refused"
                      }
                    : path
                      ? {statusId: "UlstFailed", reasonCode: path.reasonCode, reason: path.reason}
                      : stepOutcome(operation, stepKind, runNow, reasonText)
            )
        }
    }
    const statusId = recordWrite(() => refreshStatus(operationId))
    recordWrite(() => recordOnChange(change, operationId))
    ec.logger.warn(
        "Access end " + operationId + " of " + userName(account.userId) + " (" + statusId + ") for a People separation"
    )
    return {applied: true, reasonCode: null, reason: null, operationId, statusId, retried: false}
}

const operations = {
    previewLifecycle,
    startLifecycle,
    getLifecycle,
    findLifecycleOperations,
    retryLifecycleStep,
    requestProvisioning,
    requestAccessEnd
}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown lifecycle operation " + op)
        return operations[op](parameters)
    }
})
