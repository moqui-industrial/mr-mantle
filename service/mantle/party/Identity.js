// Organization-scoped identity, mantle.party.IdentityServices (mr-boss plan/design-admin.md §4.1, §4 Users and UserDetail,
// §17.2; impl-admin P4). UserAccount and the framework's security records carry no organization: an identity is in scope
// through its party's relationships to internal organizations (agent, employee or member, to a party with the OrgInternal
// role), and the caller administers the internal organizations they work in (get#PartyOrganizationInfo: the active one, or
// every one of theirs and their direct child organizations), or every internal organization as an instance administrator
// (ADMIN). An identity is readable when one of its organizations is the caller's; an account-wide change (its sign-in, email,
// allowed addresses, a factor, a lock) of an identity that also works for an organization the caller does not administer
// needs ADMIN_IDENTITY_GLOBAL besides ADMIN_IDENTITY_MANAGE (design §4.1: one employer's administrator does not take over an
// identity shared with another). Reads need ADMIN_IDENTITY_VIEW, changes ADMIN_IDENTITY_MANAGE, each checked with the
// permission, never a group name (ProductAccess has: ADMIN holds all, a Projects client none). A missing identity and one out
// of scope are refused alike (RECORD_UNAVAILABLE). A refusal of a change is a reason (applied false, reasonCode, reason);
// a missing permission is an error.
//
// Grants come only as a proposal of registered bundles the app supplies (impl-admin §4, F11), checked and applied by the
// framework's AccessServices (check#GrantProposal, apply#GrantProposal), so Mantle names no app group. Passwords: a reset
// mails the change-only reset password of org.moqui.impl.UserServices.reset#Password and sets none. Organization
// memberships are dated PartyRelationship rows, ended and never deleted.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, denied} = lib
const access = lib.access
const ACCOUNT = "moqui.security.UserAccount"
const RELATIONSHIP = "mantle.party.PartyRelationship"
const MEMBER = "moqui.security.UserGroupMember"
const VIEW = "ADMIN_IDENTITY_VIEW"
const MANAGE = "ADMIN_IDENTITY_MANAGE"
const GLOBAL = "ADMIN_IDENTITY_GLOBAL"
// the relationships that make a party staff of an internal organization (as get#PartyInternalOrgIds and MANTLE_USER_ORG count
// them), and the representative a membership may also be
const staffRelationships = ["PrtAgent", "PrtEmployee", "PrtMember"]
const membershipRelationships = staffRelationships.concat(["PrtRepresentative"])
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
// a framework service called with authorization on, so the EECAs of the security records decide each write
function callAuthorized(name, parameters) {
    const out = ec.service.sync().name(name).parameters(parameters).call() || {}
    if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
    return out
}

// ===== scope =====
function requirePermission(permission) {
    if (!ec.user.userId) denied("SIGN_IN", "Sign in to administer identities")
    if (!access.has(permission)) denied("PERMISSION_DENIED", permission + " is required")
}
const isInternal = partyId => !!partyId && !!one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
function allInternal() {
    return rows("mantle.party.PartyRole", {roleTypeId: "OrgInternal"}).map(row => row.partyId)
}
// The internal organizations the caller administers: every one for an instance administrator, else theirs (the active one
// when set), as MANTLE_USER_ORG filters.
function scope() {
    if (access.systemAdmin()) return {organizationIds: allInternal(), all: true}
    const partyId = ec.user.userAccount?.partyId
    if (!partyId) return {organizationIds: [], all: false}
    const info =
        ec.service
            .sync()
            .name("mantle.party.PartyServices.get#PartyOrganizationInfo")
            .parameters({partyId})
            .disableAuthz()
            .call() || {}
    const memberIds = Array.from(info.userOrgIds || [])
    const filterIds = Array.from(info.filterOrgIds || []).filter(id => memberIds.includes(id))
    return {organizationIds: filterIds.length ? filterIds : memberIds, all: false}
}
function partyName(partyId) {
    if (!partyId) return ""
    const organization = one("mantle.party.Organization", {partyId})
    if (organization?.organizationName) return organization.organizationName
    const person = one("mantle.party.Person", {partyId})
    const name = person ? [person.firstName, person.lastName].filter(Boolean).join(" ") : ""
    return name || partyId
}
// The internal organizations a party works for now, from its own relationships.
function partyOrganizations(partyId) {
    if (!partyId) return []
    const at = nowMs()
    return Array.from(
        new Set(
            rows(RELATIONSHIP, {fromPartyId: partyId})
                .filter(
                    row => staffRelationships.includes(row.relationshipTypeEnumId) && openAt(row, at) && isInternal(row.toPartyId)
                )
                .map(row => row.toPartyId)
        )
    )
}
// The identity userId as the caller may administer it: its account, its organizations in scope and whether it works for
// another; refused alike when missing or out of scope. An identity of no organization is in scope for an instance
// administrator only.
function identity(userId, userScope = scope()) {
    const account = text(userId) ? one(ACCOUNT, {userId: text(userId)}) : null
    if (!account) denied("RECORD_UNAVAILABLE", "User " + text(userId) + " is not available")
    const owners = partyOrganizations(account.partyId)
    const inScope = owners.filter(id => userScope.organizationIds.includes(id))
    if (!(inScope.length || (userScope.all && !owners.length)))
        denied("RECORD_UNAVAILABLE", "User " + text(userId) + " is not available")
    return {account, owners, inScope, shared: inScope.length < owners.length}
}
// An account-wide change of the identity: refused (a reason) when it is shared beyond the caller's scope and the caller
// lacks ADMIN_IDENTITY_GLOBAL.
function accountWideRefusal(found) {
    if (found.shared && !ec.user.hasPermission(GLOBAL))
        return refused(
            "IDENTITY_GLOBAL",
            (found.account.userFullName || found.account.username) +
                " also works for an organization you do not administer: an account-wide change needs " +
                GLOBAL
        )
    return null
}
function accountState(account, at = nowMs()) {
    if (account.terminateDate && ms(account.terminateDate) < at) return "terminated"
    if (account.disabled === "Y") return account.disabledDateTime ? "locked" : "disabled"
    if (account.terminateDate) return "ending"
    return "active"
}
const stateNames = {active: "Active", ending: "Access ends", locked: "Locked", disabled: "Disabled", terminated: "Ended"}
function lastLogin(userId) {
    const row = find("moqui.security.UserLoginHistory")
        .condition({userId, successfulLogin: "Y"})
        .orderBy("-fromDate")
        .limit(1)
        .list()
    const first = Array.from(row)[0]
    return first ? ms(first.fromDate) : null
}

// ===== find#Users =====
// The staff identities of the organizations the caller administers (one of them, with organizationPartyId), narrowed by text
// (name, username or email, ignoring case), a group the account is in now and a state; each with its organizations in scope
// (others counted, never named), state and last sign-in. Public identities (accounts whose party works for no internal
// organization) only with includePublic and ADMIN_IDENTITY_GLOBAL, labelled as site relationships.
function findUsers(p) {
    requirePermission(VIEW)
    const userScope = scope()
    let organizationIds = userScope.organizationIds
    if (text(p.organizationPartyId)) {
        if (!organizationIds.includes(text(p.organizationPartyId)))
            denied("RECORD_UNAVAILABLE", "Organization " + text(p.organizationPartyId) + " is not available")
        organizationIds = [text(p.organizationPartyId)]
    }
    const includePublic = !!p.includePublic
    if (includePublic && !ec.user.hasPermission(GLOBAL))
        denied("PERMISSION_DENIED", GLOBAL + " is required for public identities")
    const partyIds = organizationIds.length
        ? Array.from(
              new Set(
                  Array.from(
                      find(RELATIONSHIP)
                          .condition("toPartyId", "in", organizationIds)
                          .condition("relationshipTypeEnumId", "in", staffRelationships)
                          .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                          .selectField("fromPartyId")
                          .list()
                  ).map(row => row.fromPartyId)
              )
          )
        : []
    let accounts = find(ACCOUNT)
    if (!includePublic) accounts = accounts.condition("partyId", "in", partyIds.length ? partyIds : ["_NA_"])
    else accounts = accounts.condition("partyId", "is-not-null", null)
    const term = text(p.text)
    if (term) {
        const factory = ec.entity.conditionFactory
        accounts = accounts.condition(
            factory.makeCondition(
                ["username", "userFullName", "emailAddress"].map(field =>
                    factory.makeCondition(field, "like", likeText(term)).ignoreCase()
                ),
                "or"
            )
        )
    }
    if (text(p.userGroupId)) {
        const memberIds = Array.from(
            find(MEMBER)
                .condition("userGroupId", text(p.userGroupId))
                .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                .list()
        ).map(row => row.userId)
        accounts = accounts.condition("userId", "in", memberIds.length ? memberIds : ["_NA_"])
    }
    const limit = Math.max(1, Math.min(200, Number(p.pageSize || 50)))
    const offset = Math.max(0, Number(p.pageIndex || 0)) * limit
    const at = nowMs()
    const state = text(p.state)
    const all = Array.from(accounts.orderBy("userFullName").limit(1000).list())
        .map(account => {
            const owners = partyOrganizations(account.partyId)
            const inScope = owners.filter(id => userScope.organizationIds.includes(id))
            const site = !owners.length
            return {account, owners, inScope, site, state: accountState(account, at)}
        })
        .filter(row => (row.site ? includePublic : row.inScope.length > 0))
        .filter(row => !state || row.state === state)
    const page = all.slice(offset, offset + limit).map(row => ({
        userId: row.account.userId,
        username: row.account.username || "",
        userFullName: row.account.userFullName || row.account.username || row.account.userId,
        emailAddress: row.account.emailAddress || "",
        partyId: row.account.partyId || null,
        organizations: row.inScope.map(partyName).join(", "),
        organizationPartyIds: row.inScope,
        otherOrganizationCount: row.owners.length - row.inScope.length,
        sharedBeyondScope: row.inScope.length < row.owners.length,
        relationshipKind: row.site ? "site" : "staff",
        relationshipText: row.site ? "Site relationship" : "Staff",
        state: row.state,
        stateText: stateNames[row.state],
        lastLoginDate: lastLogin(row.account.userId)
    }))
    return {userList: page, userListCount: all.length, pageSize: limit, pageIndex: offset / limit}
}

// ===== get#Account, get#AccountHistory =====
function memberships(userId) {
    const at = nowMs()
    const privileged = new Set(Array.from(UserSecurityChecks.privilegedGroups()))
    return rows(MEMBER, {userId})
        .map(row => {
            const group = one("moqui.security.UserGroup", {userGroupId: row.userGroupId})
            const bundle = one("moqui.security.CapabilityBundle", {userGroupId: row.userGroupId})
            return {
                userGroupId: row.userGroupId,
                description: group?.description || row.userGroupId,
                appName: bundle?.appName || "",
                registered: !!bundle && bundle.disabled !== "Y",
                privileged: privileged.has(row.userGroupId),
                fromDate: ms(row.fromDate),
                thruDate: ms(row.thruDate),
                active: openAt(row, at),
                ended: (ms(row.thruDate) ?? Infinity) <= at,
                revision: stamp(row)
            }
        })
        .sort((a, b) => Number(a.ended) - Number(b.ended) || a.userGroupId.localeCompare(b.userGroupId))
}
function organizationRows(partyId, userScope) {
    if (!partyId) return []
    const at = nowMs()
    return rows(RELATIONSHIP, {fromPartyId: partyId})
        .filter(
            row =>
                membershipRelationships.includes(row.relationshipTypeEnumId) && userScope.organizationIds.includes(row.toPartyId)
        )
        .map(row => ({
            partyRelationshipId: row.partyRelationshipId,
            organizationPartyId: row.toPartyId,
            organizationName: partyName(row.toPartyId),
            relationshipTypeEnumId: row.relationshipTypeEnumId,
            fromDate: ms(row.fromDate),
            thruDate: ms(row.thruDate),
            active: openAt(row, at),
            ended: (ms(row.thruDate) ?? Infinity) <= at,
            revision: stamp(row)
        }))
        .sort((a, b) => Number(a.ended) - Number(b.ended) || (b.fromDate ?? 0) - (a.fromDate ?? 0))
}
// get#Account: one identity for UserDetail: its account fields (no password, hash or secret), state, organizations in scope
// and how many others, the dated organization relationships the caller administers, its group memberships, its factors and
// credentials (metadata only, the framework's get#AccountCredentials) and what the caller may change.
function getAccount(p) {
    requirePermission(VIEW)
    const userScope = scope()
    const found = identity(p.userId, userScope)
    const account = found.account
    const credentials =
        ec.service
            .sync()
            .name("org.moqui.admin.IdentityServices.get#AccountCredentials")
            .parameters({userId: account.userId})
            .call() || {}
    const manage = access.has(MANAGE)
    const global = ec.user.hasPermission(GLOBAL)
    const state = accountState(account)
    return {
        account: {
            userId: account.userId,
            username: account.username || "",
            userFullName: account.userFullName || account.username || account.userId,
            emailAddress: account.emailAddress || "",
            partyId: account.partyId || null,
            disabled: account.disabled === "Y",
            locked: account.disabled === "Y" && !!account.disabledDateTime,
            lockedUntil: account.disabledDateTime ? ms(account.disabledDateTime) : null,
            terminateDate: ms(account.terminateDate),
            ipAllowed: account.ipAllowed || "",
            requirePasswordChange: account.requirePasswordChange === "Y",
            locale: account.locale || "",
            timeZone: account.timeZone || "",
            hasPassword: !!account.currentPassword,
            externalIdentity: !!account.externalUserId,
            state,
            stateText: stateNames[state],
            revision: stamp(account)
        },
        organizations: found.inScope.map(partyId => ({partyId, name: partyName(partyId)})),
        otherOrganizationCount: found.owners.length - found.inScope.length,
        sharedBeyondScope: found.shared,
        relationships: organizationRows(account.partyId, userScope),
        memberships: memberships(account.userId),
        factorList: credentials.factorList || [],
        singleUseCodeCount: credentials.singleUseCodeCount || 0,
        credentialList: credentials.credentialList || [],
        canManage: manage,
        canChangeAccount: manage && (!found.shared || global),
        accountChangeReason:
            manage && found.shared && !global
                ? "This identity also works for an organization you do not administer: account-wide changes need " + GLOBAL
                : null
    }
}
// get#AccountHistory: the identity's access events, newest first and bounded: sign-ins (successful or not, with the session
// they opened), sessions, and the audit log's changes of its account, memberships and organization relationships, each with
// its actor, time and reason; no password, token or session secret.
function getAccountHistory(p) {
    requirePermission(VIEW)
    const found = identity(p.userId)
    const account = found.account
    const limit = Math.max(1, Math.min(200, Number(p.limit || 50)))
    const events = []
    for (const row of Array.from(
        find("moqui.security.UserLoginHistory").condition({userId: account.userId}).orderBy("-fromDate").limit(limit).list()
    ))
        events.push({
            time: ms(row.fromDate),
            eventKind: "signIn",
            event: row.successfulLogin === "N" ? "Sign-in failed" : "Signed in",
            actor: account.username,
            detail: row.visitId ? "Session " + row.visitId : "",
            sessionKey: row.visitId || null,
            reason: ""
        })
    const actorNames = new Map()
    const actor = userId => {
        if (!userId) return ""
        if (!actorNames.has(userId)) {
            const row = one(ACCOUNT, {userId})
            actorNames.set(userId, row?.username || userId)
        }
        return actorNames.get(userId)
    }
    const fieldNames = {
        username: "Username",
        userFullName: "Name",
        disabled: "Disabled",
        terminateDate: "Access ends",
        emailAddress: "Email",
        ipAllowed: "Allowed IPs",
        requirePasswordChange: "Password change required",
        fromDate: "From",
        thruDate: "Until"
    }
    const audits = []
    audits.push(...rows("moqui.entity.EntityAuditLog", {changedEntityName: ACCOUNT, pkPrimaryValue: account.userId}))
    audits.push(...rows("moqui.entity.EntityAuditLog", {changedEntityName: MEMBER, pkSecondaryValue: account.userId}))
    for (const relationship of organizationRows(account.partyId, scope()))
        audits.push(
            ...rows("moqui.entity.EntityAuditLog", {
                changedEntityName: RELATIONSHIP,
                pkPrimaryValue: relationship.partyRelationshipId
            })
        )
    // a date's audit text is its millis: shown as a time
    const dateFields = ["fromDate", "thruDate", "terminateDate"]
    const shown = (name, value) =>
        value == null || value === ""
            ? ""
            : dateFields.includes(name) && /^-?\d+$/.test(String(value))
              ? Number(value) === 0
                  ? "the start"
                  : new Date(Number(value)).toISOString().slice(0, 16).replace("T", " ")
              : String(value)
    for (const row of audits) {
        const field = fieldNames[row.changedFieldName] || row.changedFieldName
        const subject =
            row.changedEntityName === MEMBER
                ? "Group " + row.pkPrimaryValue + ": "
                : row.changedEntityName === RELATIONSHIP
                  ? "Organization relationship: "
                  : ""
        events.push({
            time: ms(row.changedDate),
            eventKind: "change",
            event: subject + field + " changed",
            actor: actor(row.changedByUserId),
            detail: [row.oldValueText, row.newValueText].some(value => value != null && value !== "")
                ? shown(row.changedFieldName, row.oldValueText) + " → " + shown(row.changedFieldName, row.newValueText)
                : "",
            sessionKey: row.changedInVisitId || null,
            reason: row.changeReason || ""
        })
    }
    events.sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
    return {eventList: events.slice(0, limit)}
}

// ===== store#OrganizationMembership =====
// A dated relationship of a person to an internal organization the caller administers (employee, agent, member or
// representative): a new one from fromDate (now when empty), or with partyRelationshipId and its revision an end date set
// (ended now when thruDate is empty and end is true). Ended rows are kept. Refused (a reason) for an organization out of scope,
// an overlapping relationship of the same kind or a stale revision.
function storeOrganizationMembership(p) {
    requirePermission(MANAGE)
    const userScope = scope()
    const reason = text(p.reason).slice(0, 255) || null
    const now = nowMs()
    if (text(p.partyRelationshipId)) {
        const row = one(RELATIONSHIP, {partyRelationshipId: text(p.partyRelationshipId)})
        if (
            !row ||
            !membershipRelationships.includes(row.relationshipTypeEnumId) ||
            !userScope.organizationIds.includes(row.toPartyId)
        )
            denied("RECORD_UNAVAILABLE", "The membership is not available")
        if (text(p.expectedRevision) !== stamp(row))
            return refused("REVISION_CHANGED", "The membership changed since you read it; reload it", {revision: stamp(row)})
        if ((ms(row.thruDate) ?? Infinity) <= now) return refused("MEMBERSHIP_ENDED", "The membership has already ended")
        const thruDate = p.thruDate != null && p.thruDate !== "" ? ms(p.thruDate) : now
        if (!Number.isFinite(thruDate) || thruDate < now - 60000) throw new Error("A membership ends now or later")
        if (reason) ec.context.putAll({thruDate_changeReason: reason})
        const value = ec.entity.makeValue(RELATIONSHIP)
        value.setFields(
            {partyRelationshipId: row.partyRelationshipId, thruDate: iso(Math.max(thruDate, ms(row.fromDate) ?? thruDate))},
            true,
            null,
            null
        )
        value.update()
        const stored = one(RELATIONSHIP, {partyRelationshipId: row.partyRelationshipId})
        return {applied: true, partyRelationshipId: row.partyRelationshipId, revision: stamp(stored)}
    }
    const partyId = text(p.partyId)
    const organizationPartyId = text(p.organizationPartyId)
    if (!partyId || !one("mantle.party.Person", {partyId})) throw new Error("A membership is of a person")
    if (!organizationPartyId || !isInternal(organizationPartyId) || !userScope.organizationIds.includes(organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Organization " + organizationPartyId + " is not available")
    const relationshipTypeEnumId = text(p.relationshipTypeEnumId) || "PrtEmployee"
    if (!membershipRelationships.includes(relationshipTypeEnumId))
        throw new Error("A membership is an employee, agent, member or representative relationship")
    const fromDate = p.fromDate != null && p.fromDate !== "" ? ms(p.fromDate) : now
    const thruDate = p.thruDate != null && p.thruDate !== "" ? ms(p.thruDate) : null
    if (!Number.isFinite(fromDate) || (thruDate != null && thruDate <= fromDate))
        throw new Error("The membership must end after it starts")
    const overlapping = rows(RELATIONSHIP, {fromPartyId: partyId, toPartyId: organizationPartyId, relationshipTypeEnumId}).some(
        row => (ms(row.fromDate) ?? -Infinity) < (thruDate ?? Infinity) && (ms(row.thruDate) ?? Infinity) > fromDate
    )
    if (overlapping)
        return refused(
            "MEMBERSHIP_EXISTS",
            partyName(partyId) + " already has that relationship with " + partyName(organizationPartyId)
        )
    const value = ec.entity.makeValue(RELATIONSHIP)
    value.setSequencedIdPrimary()
    value.setFields(
        {
            relationshipTypeEnumId,
            fromPartyId: partyId,
            toPartyId: organizationPartyId,
            toRoleTypeId: "OrgInternal",
            fromDate: iso(fromDate),
            thruDate: iso(thruDate)
        },
        true,
        null,
        null
    )
    value.create()
    const partyRelationshipId = value.get("partyRelationshipId")
    return {applied: true, partyRelationshipId, revision: stamp(one(RELATIONSHIP, {partyRelationshipId}))}
}

// ===== create#StaffAccount =====
// The exceptional direct staff account (design §4 Users NewStaffAccount; invitations are the default, P5): a person (an
// existing one, or a new one from the names) with a relationship to an internal organization the caller administers, an account
// with no password (the user sets one through the mailed reset password), and the memberships of the grant proposal, all or
// nothing: the proposal is checked before anything is written, and a refusal is a reason. An existing person who also works for
// an organization the caller does not administer needs ADMIN_IDENTITY_GLOBAL.
function createStaffAccount(p) {
    requirePermission(MANAGE)
    const userScope = scope()
    const organizationPartyId = text(p.organizationPartyId)
    if (!organizationPartyId || !isInternal(organizationPartyId) || !userScope.organizationIds.includes(organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Organization " + organizationPartyId + " is not available")
    const bundleGroupIdList = Array.from(p.bundleGroupIdList || [])
        .map(text)
        .filter(Boolean)
    if (!bundleGroupIdList.length) throw new Error("Choose the access the account starts with")
    const emailAddress = text(p.emailAddress)
    if (!emailAddress) throw new Error("An email address is required: the account's reset password is mailed to it")
    const username = text(p.username) || emailAddress
    let partyId = text(p.partyId)
    if (partyId) {
        if (!one("mantle.party.Person", {partyId})) throw new Error("Party " + partyId + " is not a person")
        if (one(ACCOUNT, {partyId})) return refused("ACCOUNT_EXISTS", partyName(partyId) + " already has an account")
        const owners = partyOrganizations(partyId)
        if (owners.some(id => !userScope.organizationIds.includes(id)) && !ec.user.hasPermission(GLOBAL))
            return refused(
                "IDENTITY_GLOBAL",
                partyName(partyId) + " also works for an organization you do not administer: an account for them needs " + GLOBAL
            )
    } else if (!text(p.firstName) || !text(p.lastName))
        throw new Error("Give the person's first and last name, or choose a person")
    if (find(ACCOUNT).condition("username", username).count() > 0)
        return refused("USERNAME_EXISTS", "Username " + username + " is already in use")
    const proposal = callAuthorized("org.moqui.admin.AccessServices.check#GrantProposal", {bundleGroupIdList})
    if (!proposal.allowed) return refused(proposal.reasonCode, proposal.reason, {bundleList: proposal.bundleList})
    const reason = text(p.reason).slice(0, 255) || null
    if (!partyId)
        partyId = callAuthorized("mantle.party.PartyServices.create#Person", {
            firstName: text(p.firstName),
            lastName: text(p.lastName)
        }).partyId
    const relationship = storeOrganizationMembership({
        partyId,
        organizationPartyId,
        relationshipTypeEnumId: text(p.relationshipTypeEnumId) || "PrtEmployee",
        reason
    })
    if (!relationship.applied && relationship.reasonCode !== "MEMBERSHIP_EXISTS") throw new Error(relationship.reason)
    const userId = callAuthorized("mantle.party.PartyServices.create#PartyUserAccount", {
        partyId,
        username,
        emailAddress,
        requirePasswordChange: "Y"
    }).userId
    const applied = callAuthorized("org.moqui.admin.AccessServices.apply#GrantProposal", {userId, bundleGroupIdList, reason})
    // the proposal was checked above; a refusal now (a grant that changed meanwhile) undoes the whole account
    if (!applied.applied) throw new Error(applied.reason)
    let resetSent = false
    if (p.sendReset !== false && p.sendReset !== "false") {
        callAuthorized("org.moqui.impl.UserServices.reset#Password", {userId})
        resetSent = true
    }
    ec.logger.info("Staff account " + username + " created by " + ec.user.username + (reason ? ": " + reason : ""))
    return {applied: true, reasonCode: null, reason: null, userId, partyId, addedGroupIds: applied.addedGroupIds, resetSent}
}

// ===== store#Account =====
// The identity's account fields an identity operator keeps (design §4 UserDetail Account): email, username, allowed IPs,
// password change required, locale and time zone, at the account's revision. Each is account-wide, so a shared identity needs
// ADMIN_IDENTITY_GLOBAL; allowed IPs are checked against the administration path. Enabling, disabling and the end date are the
// lifecycle's (P6).
function storeAccount(p) {
    requirePermission(MANAGE)
    const found = identity(p.userId)
    const account = found.account
    const wide = accountWideRefusal(found)
    if (wide) return wide
    if (text(p.expectedRevision) !== stamp(account))
        return refused("REVISION_CHANGED", "The account changed since you read it; reload it", {revision: stamp(account)})
    const fields = {}
    for (const name of ["emailAddress", "username", "ipAllowed", "locale", "timeZone"])
        if (p[name] !== undefined && p[name] !== null && text(p[name]) !== text(account[name])) fields[name] = text(p[name])
    if (p.requirePasswordChange != null && p.requirePasswordChange !== "") {
        const flag =
            p.requirePasswordChange === true || p.requirePasswordChange === "Y" || p.requirePasswordChange === "true" ? "Y" : "N"
        if (flag !== (account.requirePasswordChange === "Y" ? "Y" : "N")) fields.requirePasswordChange = flag
    }
    if (fields.username === "" || fields.emailAddress === "") throw new Error("An account keeps a username and an email address")
    if (!Object.keys(fields).length) return {applied: true, reasonCode: null, reason: null, revision: stamp(account), changed: []}
    if (fields.ipAllowed !== undefined) {
        const path = ec.resource
            .script("component://framework/service/org/moqui/admin/Identity.js")
            .administrationPath({accounts: {[account.userId]: {ipAllowed: fields.ipAllowed}}})
        if (!path.allowed) return refused(path.reasonCode, path.reason)
    }
    const reason = text(p.reason).slice(0, 255)
    if (reason) ec.context.putAll(Object.fromEntries(Object.keys(fields).map(name => [name + "_changeReason", reason])))
    if (account.partyId)
        callAuthorized(
            "mantle.party.PartyServices.update#PartyUserAccount",
            Object.assign({userId: account.userId, partyId: account.partyId}, fields)
        )
    else callAuthorized("org.moqui.impl.UserServices.update#UserAccount", Object.assign({userId: account.userId}, fields))
    return {
        applied: true,
        reasonCode: null,
        reason: null,
        revision: stamp(one(ACCOUNT, {userId: account.userId})),
        changed: Object.keys(fields)
    }
}

// ===== reset#Authentication =====
// A sign-in reset of the identity (design §4 UserDetail Authentication): resetKind password sends the change-only reset
// password reset#Password mails (the current password stays valid and no password is set; the user acts on it), allowed for
// any identity in scope; factor ends one factor (invalidate#UserAuthcFactorEntry) and lock releases a tarpit lock (the
// account's failed-login lock and its artifact velocity locks, not a permanent disable), each account-wide, so a shared
// identity needs ADMIN_IDENTITY_GLOBAL, and a factor's end is checked against the administration path.
function resetAuthentication(p) {
    requirePermission(MANAGE)
    const found = identity(p.userId)
    const account = found.account
    const kind = text(p.resetKind) || "password"
    const reason = text(p.reason).slice(0, 255)
    if (kind === "password") {
        if (!account.emailAddress) return refused("NO_EMAIL", "The account has no email address to send a reset to")
        callAuthorized("org.moqui.impl.UserServices.reset#Password", {userId: account.userId})
        ec.logger.info("Password reset sent for " + account.username + " by " + ec.user.username + (reason ? ": " + reason : ""))
        return {
            applied: true,
            reasonCode: null,
            reason: null,
            resetKind: kind,
            message: "A reset password was mailed to the account's address; its current password stays valid"
        }
    }
    const wide = accountWideRefusal(found)
    if (wide) return wide
    if (kind === "factor") {
        const factorId = text(p.factorId)
        const factor = factorId ? one("moqui.security.UserAuthcFactor", {factorId}) : null
        if (!factor || factor.userId !== account.userId) denied("RECORD_UNAVAILABLE", "The factor is not available")
        const path = ec.resource
            .script("component://framework/service/org/moqui/admin/Identity.js")
            .administrationPath({endedFactorIds: [factorId]})
        if (!path.allowed) return refused(path.reasonCode, path.reason)
        callAuthorized("org.moqui.impl.UserServices.invalidate#UserAuthcFactorEntry", {factorId, userId: account.userId})
        ec.logger.info(
            "Factor " + factorId + " of " + account.username + " reset by " + ec.user.username + (reason ? ": " + reason : "")
        )
        return {
            applied: true,
            reasonCode: null,
            reason: null,
            resetKind: kind,
            message: "The factor was ended; the user enrols a new one at their next sign-in"
        }
    }
    if (kind === "lock") {
        if (account.disabled === "Y" && !account.disabledDateTime)
            return refused("ACCOUNT_DISABLED", "The account is disabled, not locked: it is restored through its lifecycle")
        let released = 0
        if (account.disabled === "Y" || Number(account.successiveFailedLogins || 0) > 0) {
            if (reason) ec.context.putAll({disabled_changeReason: reason})
            const value = ec.entity.makeValue(ACCOUNT)
            value.setFields(
                {userId: account.userId, disabled: "N", disabledDateTime: null, successiveFailedLogins: 0},
                true,
                null,
                null
            )
            value.update()
            released++
        }
        for (const lock of Array.from(
            find("moqui.security.ArtifactTarpitLock")
                .condition("userId", account.userId)
                .condition("releaseDateTime", ">", ec.user.nowTimestamp)
                .list()
        )) {
            const value = ec.entity.makeValue("moqui.security.ArtifactTarpitLock")
            value.setFields(
                {artifactTarpitLockId: lock.artifactTarpitLockId, releaseDateTime: ec.user.nowTimestamp},
                true,
                null,
                null
            )
            value.update()
            released++
        }
        ec.logger.info(
            "Sign-in locks of " + account.username + " released by " + ec.user.username + (reason ? ": " + reason : "")
        )
        return {
            applied: true,
            reasonCode: null,
            reason: null,
            resetKind: kind,
            releasedCount: released,
            message: released ? "The sign-in lock was released" : "The account had no sign-in lock"
        }
    }
    throw new Error("Unknown reset " + kind)
}

const operations = {
    findUsers,
    getAccount,
    getAccountHistory,
    storeOrganizationMembership,
    createStaffAccount,
    storeAccount,
    resetAuthentication
}
;({
    scope,
    identity,
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown identity operation " + op)
        return operations[op](parameters)
    }
})
