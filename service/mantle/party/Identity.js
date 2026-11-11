// Organization-scoped identity, mantle.party.IdentityServices (mr-boss plan/design-admin.md §4.1, §4 Users and UserDetail,
// §17.2; impl-admin P4 and its follow-up, §4). UserAccount and the framework's security records carry no organization: an
// identity belongs to the internal organizations its party works for (a current agent, employee or member relationship to a
// party with the OrgInternal role). Which of them the caller administers is not computed here: it is the organization entity
// filters of the authorization the call runs under, applied to finds on the views mantle.party.UserAccountOrganization (an
// account with each of its internal organizations) and mantle.party.InternalOrganization, as every other record of an app is
// filtered (MANTLE_USER_ORG: the caller's organizations, the active one when set; MANTLE_ACTIVE_ORG: the active organization,
// every one with none active). An app screen's inheritable ALWAYS grant lends its filters (an administrator's MANTLE_ACTIVE_ORG);
// otherwise this package's ALL_USERS grant carries MANTLE_USER_ORG (data/PartyAccessData.xml). A call whose authorization
// names neither filter set (authorization disabled, or a grant without them) has nothing in scope, but for an instance
// administrator (ADMIN), for whom it is every organization.
//
// An identity is readable when one of its organizations is in scope; an account-wide change (its sign-in, email, allowed
// addresses, a factor, a lock) of an identity that also works for an organization out of scope needs ADMIN_IDENTITY_GLOBAL
// besides ADMIN_IDENTITY_MANAGE (design §4.1: one employer's administrator does not take over an identity shared with
// another). Reads need ADMIN_IDENTITY_VIEW, changes ADMIN_IDENTITY_MANAGE, each checked with the permission, never a group name
// (ProductAccess has: ADMIN holds all, a Projects client none). A missing identity and one out of scope are refused alike
// (RECORD_UNAVAILABLE). A refusal of a change is a reason (applied false, reasonCode, reason); a missing permission is an error.
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
const ACCOUNT_ORGANIZATION = "mantle.party.UserAccountOrganization"
const INTERNAL_ORGANIZATION = "mantle.party.InternalOrganization"
const organizationFilterSets = ["MANTLE_USER_ORG", "MANTLE_ACTIVE_ORG"]
// The caller's organizations in the user context, which the filter maps read (filterOrgIds, activeOrgId), as an app screen's
// pre-actions put them; read with authorization off, since its own finds would be filtered by the maps it fills.
function organizationContext() {
    if (ec.user.userAccount?.partyId)
        ec.service.sync().name("mantle.party.PartyServices.setup#UserOrganizationInfo").disableAuthz().call()
    else Object.assign(ec.user.context, {userOrgIds: [], filterOrgIds: [], activeOrgId: null})
}
// Whether the authorization a find on entityName runs under names an organization filter set. MANTLE_ACTIVE_ORG applies only
// with an active organization (its applyCond), so with none it is asked with one in the user context for the moment (as
// CommunicationServices' get#RecordLinkInfo does).
function organizationFiltered(entityName) {
    const named = () =>
        Array.from(ec.artifactExecution.getFindFiltersForUser(entityName) || []).some(filter =>
            organizationFilterSets.includes(filter.entityFilterSetId)
        )
    if (named()) return true
    if (ec.user.context.activeOrgId) return false
    const hadActive = "activeOrgId" in ec.user.context
    const oldActive = ec.user.context.activeOrgId
    ec.user.context.activeOrgId = "_NA_"
    try {
        return named()
    } finally {
        if (hadActive) ec.user.context.activeOrgId = oldActive ?? null
        else delete ec.user.context.activeOrgId
    }
}
// A find on one of the organization views under the caller's authorization, so its organization filters apply; null (nothing
// in scope) when that authorization names no organization filter, unless the caller is an instance administrator.
function scopedFind(entityName) {
    organizationContext()
    if (!organizationFiltered(entityName) && !access.systemAdmin()) return null
    return ec.entity.find(entityName)
}
// The internal organizations the caller administers (the filtered find on InternalOrganization); all: an instance administrator,
// for whom an identity of no organization is in scope too.
function scope() {
    const organizations = scopedFind(INTERNAL_ORGANIZATION)
    const organizationIds = organizations
        ? Array.from(organizations.selectField("organizationPartyId").list()).map(row => row.organizationPartyId)
        : []
    return {organizationIds, all: access.systemAdmin()}
}
// The internal organizations the caller administers by its authorization's organization filters, or null when that
// authorization names none (and the caller is not an instance administrator), so a caller can fall back to its own rule.
// readOnly: use the organization context an app screen's pre-actions put in the user context, never setting it up (which may
// clear a stale active organization preference), for a caller under the read fence; null when there is none.
function administered(readOnly) {
    if (readOnly && !("filterOrgIds" in ec.user.context)) return null
    if (!readOnly) organizationContext()
    if (!organizationFiltered(INTERNAL_ORGANIZATION) && !access.systemAdmin()) return null
    return Array.from(ec.entity.find(INTERNAL_ORGANIZATION).selectField("organizationPartyId").list()).map(
        row => row.organizationPartyId
    )
}
// The internal organizations of each account in userIds that the caller administers: the filtered find on
// UserAccountOrganization. A Map of userId to organization ids; an account out of scope is not in it.
function scopedOrganizations(userIds) {
    const ids = Array.from(
        new Set(
            Array.from(userIds || [])
                .map(text)
                .filter(Boolean)
        )
    )
    const found = new Map()
    const accounts = ids.length ? scopedFind(ACCOUNT_ORGANIZATION) : null
    if (!accounts) return found
    for (const row of Array.from(
        accounts.condition("userId", "in", ids).selectField("userId").selectField("organizationPartyId").list()
    )) {
        if (!found.has(row.userId)) found.set(row.userId, [])
        if (!found.get(row.userId).includes(row.organizationPartyId)) found.get(row.userId).push(row.organizationPartyId)
    }
    return found
}
// inScope(userId): the internal organizations of the account the caller administers, empty when none (for another package,
// such as invitations and the lifecycle, to ask the same question).
const inScope = userId => scopedOrganizations([userId]).get(text(userId)) || []
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
// The identity userId as the caller may administer it: its account, all of its internal organizations (owners, read without
// filters), those in scope (the filtered find) and whether it works for another; refused alike when missing or out of scope.
// An identity of no organization is in scope for an instance administrator only.
function identity(userId, userScope = null) {
    const account = text(userId) ? one(ACCOUNT, {userId: text(userId)}) : null
    if (!account) denied("RECORD_UNAVAILABLE", "User " + text(userId) + " is not available")
    const owners = partyOrganizations(account.partyId)
    const scoped = inScope(account.userId).filter(id => owners.includes(id))
    if (!(scoped.length || (!owners.length && (userScope ? userScope.all : access.systemAdmin()))))
        denied("RECORD_UNAVAILABLE", "User " + text(userId) + " is not available")
    return {account, owners, inScope: scoped, shared: scoped.length < owners.length}
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
// An account-wide change of an identity holding access the caller could not be given (a privileged group the caller is not
// in, a sealed permission the caller lacks): refused (a reason), so a delegated operator cannot change an administrator's
// email or username and mail it a reset, end its factor or release its lock (review R1; the framework's rule, as for Login as).
function heldBeyondRefusal(found) {
    const held = ec.resource.script("component://framework/service/org/moqui/admin/Identity.js").heldBeyond(found.account.userId)
    return held ? refused("IDENTITY_PRIVILEGED", held + ": this account-wide change is refused") : null
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
// The staff identities in scope (the filtered find on UserAccountOrganization; one organization of it with organizationPartyId),
// narrowed by text (name, username or email, ignoring case), a group the account is in now and a state; each with its
// organizations in scope (others counted, never named), state and last sign-in. Public identities (accounts whose party works
// for no internal organization) only with includePublic and ADMIN_IDENTITY_GLOBAL, labelled as site relationships.
function findUsers(p) {
    requirePermission(VIEW)
    const organizationPartyId = text(p.organizationPartyId)
    if (organizationPartyId && !scope().organizationIds.includes(organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Organization " + organizationPartyId + " is not available")
    const includePublic = !!p.includePublic
    if (includePublic && !ec.user.hasPermission(GLOBAL))
        denied("PERMISSION_DENIED", GLOBAL + " is required for public identities")
    const factory = ec.entity.conditionFactory
    const term = text(p.text)
    const textCondition = term
        ? factory.makeCondition(
              ["username", "userFullName", "emailAddress"].map(field =>
                  factory.makeCondition(field, "like", likeText(term)).ignoreCase()
              ),
              "or"
          )
        : null
    let groupUserIds = null
    if (text(p.userGroupId))
        groupUserIds = Array.from(
            find(MEMBER)
                .condition("userGroupId", text(p.userGroupId))
                .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                .list()
        ).map(row => row.userId)
    // the accounts in scope and their organizations in scope, from the filtered view
    const scoped = new Map()
    const staff = scopedFind(ACCOUNT_ORGANIZATION)
    if (staff) {
        let rowsFound = staff.selectField("userId").selectField("organizationPartyId")
        if (textCondition) rowsFound = rowsFound.condition(textCondition)
        if (groupUserIds) rowsFound = rowsFound.condition("userId", "in", groupUserIds.length ? groupUserIds : ["_NA_"])
        for (const row of Array.from(rowsFound.limit(5000).list())) {
            if (!scoped.has(row.userId)) scoped.set(row.userId, [])
            if (!scoped.get(row.userId).includes(row.organizationPartyId)) scoped.get(row.userId).push(row.organizationPartyId)
        }
    }
    let accounts = find(ACCOUNT)
    if (!includePublic) accounts = accounts.condition("userId", "in", scoped.size ? Array.from(scoped.keys()) : ["_NA_"])
    else accounts = accounts.condition("partyId", "is-not-null", null)
    if (textCondition) accounts = accounts.condition(textCondition)
    if (groupUserIds) accounts = accounts.condition("userId", "in", groupUserIds.length ? groupUserIds : ["_NA_"])
    const limit = Math.max(1, Math.min(200, Number(p.pageSize || 50)))
    const offset = Math.max(0, Number(p.pageIndex || 0)) * limit
    const at = nowMs()
    const state = text(p.state)
    const all = Array.from(accounts.orderBy("userFullName").limit(1000).list())
        .map(account => {
            const owners = partyOrganizations(account.partyId)
            const organizations = (scoped.get(account.userId) || []).filter(id => owners.includes(id))
            const site = !owners.length
            return {account, owners, organizations, site, state: accountState(account, at)}
        })
        .filter(row => (row.site ? includePublic : row.organizations.length > 0))
        .filter(row => !organizationPartyId || row.organizations.includes(organizationPartyId))
        .filter(row => !state || row.state === state)
    const page = all.slice(offset, offset + limit).map(row => ({
        userId: row.account.userId,
        username: row.account.username || "",
        userFullName: row.account.userFullName || row.account.username || row.account.userId,
        emailAddress: row.account.emailAddress || "",
        partyId: row.account.partyId || null,
        organizations: row.organizations.map(partyName).join(", "),
        organizationPartyIds: row.organizations,
        otherOrganizationCount: row.owners.length - row.organizations.length,
        sharedBeyondScope: row.organizations.length < row.owners.length,
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
    const held = manage ? heldBeyondRefusal(found) : null
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
        canChangeAccount: manage && (!found.shared || global) && !held,
        accountChangeReason:
            manage && found.shared && !global
                ? "This identity also works for an organization you do not administer: account-wide changes need " + GLOBAL
                : held
                  ? held.reason
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
// an overlapping relationship of the same kind or a stale revision, and without ADMIN_IDENTITY_GLOBAL for a person whose
// account works for no internal organization (R2) or for one out of scope (F78).
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
    // a person with an account that works for no internal organization (a site identity: a customer, a supplier contact, an
    // administrator of no organization) would come wholly into the caller's scope, account-wide changes and all: that needs
    // ADMIN_IDENTITY_GLOBAL (review R2); a person of another organization stays shared, so its account-wide changes still do
    const hasAccount = !!one(ACCOUNT, {partyId})
    const partyOwners = hasAccount ? partyOrganizations(partyId) : []
    if (!userScope.all && hasAccount && !partyOwners.length && !ec.user.hasPermission(GLOBAL))
        return refused(
            "IDENTITY_GLOBAL",
            partyName(partyId) + " has an account of no organization: bringing it into an organization needs " + GLOBAL
        )
    // a person with an account that works for an organization out of the caller's scope (another organization's staff) would
    // become readable to the caller: that needs ADMIN_IDENTITY_GLOBAL, ADMIN's by default (the user's call, Nov 7, F78)
    if (hasAccount && partyOwners.some(id => !userScope.organizationIds.includes(id)) && !ec.user.hasPermission(GLOBAL))
        return refused(
            "IDENTITY_GLOBAL",
            partyName(partyId) + " works for an organization you do not administer: relating them to yours needs " + GLOBAL
        )
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
    const wide = accountWideRefusal(found) || heldBeyondRefusal(found)
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
// A reset changes no audit-logged field of the account (a mailed reset password, an ended factor, a released lock that was
// not a disable), so each is a row of the audit log on the account: who, the session, the reason; never a password or a factor's
// secret (mr-boss impl-admin P17).
function resetEvidence(account, fieldName, summary, reason) {
    ec.resource
        .script("component://framework/service/org/moqui/admin/ConfigurationLib.js")
        .auditRow(ACCOUNT, fieldName, account.userId, null, null, summary, reason || null)
}
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
        resetEvidence(account, "passwordReset", "Reset password mailed to the account's address", reason)
        return {
            applied: true,
            reasonCode: null,
            reason: null,
            resetKind: kind,
            message: "A reset password was mailed to the account's address; its current password stays valid"
        }
    }
    const wide = accountWideRefusal(found) || heldBeyondRefusal(found)
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
        resetEvidence(account, "factorReset", "Factor " + factorId + " ended", reason)
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
        if (released) resetEvidence(account, "signInLock", "Released: " + released, reason)
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
    // for another package (invitations, the lifecycle): the organizations administered, an identity as the caller may
    // administer it, and an account's organizations in scope, each the filtered find of the caller's authorization
    scope,
    administered,
    identity,
    inScope,
    scopedOrganizations,
    // the account-wide refusals of an identity identity() found (a reason, or null): shared beyond the caller's scope without
    // ADMIN_IDENTITY_GLOBAL, or holding access the caller could not be given (for the lifecycle, P6)
    accountWideRefusal,
    heldBeyondRefusal,
    // a find on UserAccountOrganization under the caller's organization filters (an account's row for each of its
    // organizations in scope), or null when nothing is in scope
    scopedAccounts: () => scopedFind(ACCOUNT_ORGANIZATION),
    // a find on any view that joins a record back to its internal organization, under the same filters; null when nothing
    // is in scope (the audit-log views, IdentityAudit.js)
    scopedFind,
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown identity operation " + op)
        return operations[op](parameters)
    }
})
