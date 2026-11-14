/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * Smithy's core (mr-pass plan/design-smithy.md §4, §5): the name set, the access evaluator (effective visibility and
 * role) that the pages and check#GitRepositoryAuthz share, the group and repository lookups that answer Not Found for
 * what the caller may not see, the path resolver and the ref splitter. Written on ForumCore.js and calls it.
 * Entity access is privileged here; Smithy.js, the rights service and the name check turn authorization off around it.
 */
const forum = ec.resource.script("component://mr-mantle/service/mantle/forum/ForumCore.js")
const {
    S,
    now,
    millis,
    me,
    find,
    one,
    rows,
    update,
    fail,
    missing,
    invalid,
    active,
    member,
    isOperator,
    sanctioned,
    internalParty
} = forum
const M = "mantle.smithy."
const GIT = "org.moqui.git.GitServices."
const publicApps = () => ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
const confirmedAddress = () => ec.resource.script("component://mr-mantle/service/mantle/public/ConfirmedAddress.js")

// ===== enumerations: the word of an operation, the enumeration's id, and its order =====
/* From widest to narrowest; an unknown value reads as private, so bad data fails closed. */
const VISIBILITY = {SmvPublic: 1, SmvMembers: 2, SmvPrivate: 3}
const VISIBILITY_CODES = {SmvPublic: "public", SmvMembers: "members", SmvPrivate: "private"}
const VISIBILITY_IDS = ["", "SmvPublic", "SmvMembers", "SmvPrivate"]
/* The rank of a role: a higher rank holds everything a lower one does. */
const RANK = {SmrGuest: 10, SmrReporter: 20, SmrDeveloper: 30, SmrMaintainer: 40, SmrOwner: 50}
const ROLE_CODES = {
    SmrGuest: "guest",
    SmrReporter: "reporter",
    SmrDeveloper: "developer",
    SmrMaintainer: "maintainer",
    SmrOwner: "owner"
}
const STATUS_CODES = {SmgRequested: "requested", SmgActive: "active", SmgRefused: "refused"}
const POLICY_CODES = {ScpOperators: "operators", ScpRequest: "request", ScpVerified: "verified"}
const idOfCode = (codes, code) => Object.keys(codes).find(id => codes[id] === code) || null
const visibilityRank = enumId => VISIBILITY[enumId] || 3
const roleOfRank = rank =>
    Object.keys(RANK)
        .filter(id => RANK[id] <= rank)
        .pop() || null
const roleCode = rank => ROLE_CODES[roleOfRank(rank)] || null

// ===== names (§4.2) =====
const HANDLE = /^[a-z0-9][a-z0-9_-]{2,31}$/
const GROUP_SEGMENT = /^[a-z0-9][a-z0-9_-]{1,38}$/
const SLUG = /^[a-z0-9_][a-z0-9_.-]{0,99}$/
const MAX_GROUP_DEPTH = 4
/* The most repositories below one top-level group: a group has no count of its own to set (§11 Quotas), and this bounds
   what a rename, a narrowing and a quota read walk. */
const GROUP_REPOSITORY_LIMIT = 1000
/* Smithy's own first segments and the default base of each PASS app (mr-pass service/pass/Apps.js, which the
   authority cannot read), which no group path or handle takes, so a mount made later shadows none. */
const reservedNames = [
    "forum",
    "account",
    "members",
    "sites",
    "billing",
    "supplier",
    "support",
    "shop",
    "code",
    "explore",
    "search",
    "new",
    "import",
    "git",
    "admin",
    "api",
    "help",
    "about",
    "docs",
    "news",
    "releases",
    "security",
    "settings",
    "login",
    "logout",
    "register",
    "robots.txt",
    "sitemap.xml",
    "favicon.ico",
    "addons.xml"
]
const validGroupSegment = name => typeof name === "string" && GROUP_SEGMENT.test(name)
const validSlug = name =>
    typeof name === "string" &&
    SLUG.test(name) &&
    !name.includes("..") &&
    ![".", ".git", ".lock", ".atom"].some(suffix => name.endsWith(suffix))
/* The words no first segment of a site may be, in lower case: Smithy's own and the apps' bases, the pages' root (a
   page is at <mount>/pages/<route>), the framework's and the BOSS apps' roots (PublicApps.reservedPaths) and the
   site's mounts, enabled or not. All read here: the authority has no PASS. */
function reservedFirstSegments(siteId) {
    const words = new Set(reservedNames.concat(["pages"]))
    for (const path of publicApps().reservedPaths) words.add(String(path).toLowerCase())
    for (const mount of rows(S + "PublicSiteApp", {siteId}, 200)) {
        const first = String(mount.pathPrefix || "").split("/")[1]
        if (first) words.add(first.toLowerCase())
    }
    return words
}
/* The top-level group of a site that has a path: any but a refused one, whose path is free again. */
const groupHolding = (siteId, word) =>
    find(M + "SmithyGroup", {siteId, groupPath: word})
        .condition("statusId", "not-equals", "SmgRefused")
        .list()[0] || null
/* Whether a first segment is a group path of a site or, with handles, a handle of it: what a mount may not take. */
function nameHeld(siteId, name, handles = true) {
    const word = String(name || "").toLowerCase()
    return !!word && (!!groupHolding(siteId, word) || (handles && !!one(S + "PublicSiteProfile", {siteId, handle: word})))
}
/* An old path redirects until it is taken (§4.3): by the party it belongs to at once, by another after 90 days. */
const REDIRECT_DAYS = 90
const redirectExpired = createdAt => !createdAt || millis(createdAt) + REDIRECT_DAYS * 86400000 <= millis(now())
/* Whether a party is an Owner of a group by its active rows on it and the groups above. */
function ownsGroup(groupId, partyId) {
    const chain = partyId ? groupChain(groupId) : null
    return !!chain && groupRank(chain, partyId)[0] >= RANK.SmrOwner
}
/* Whether an old path still holds its place against a party: the unexpired SmithyPathRedirect of a group that the party
   is no Owner of, or of another account's handle; and the unexpired GitRepositoryPathRedirect of a repository of the
   site that the party is no Owner of (its namespace's account, or an Owner of its groups). The framework lets a
   repository take a redirected path at once, so this is asked before SmithyCore.setPath. own: what is the asker's
   whatever its rows say: all (an operator on a page), groupId or repositoryId (the one that is taking its path back). */
function pathHeld(siteId, path, partyId, own = {}) {
    const oldPath = String(path || "").toLowerCase()
    const moved = one(M + "SmithyPathRedirect", {siteId, oldPath})
    if (moved && !own.all && !redirectExpired(moved.createdAt)) {
        const mine =
            moved.redirectKindEnumId === "SrkAccount"
                ? !!partyId && moved.partyId === partyId
                : !!moved.groupId && (moved.groupId === own.groupId || ownsGroup(moved.groupId, partyId))
        if (!mine) return true
    }
    if (!oldPath.includes("/")) return false
    // the framework's key of an old path is the path in lower case
    const renamed = one("moqui.resource.GitRepositoryPathRedirect", {oldPathKey: oldPath})
    if (!renamed || renamed.repositoryId === own.repositoryId || redirectExpired(renamed.createdDate)) return false
    // the old path of a repository that is not this site's (another site's, or one with no Smithy row, as a
    // Projects-only repository) is nobody's here to take, an operator's neither
    const repo = one(M + "SmithyRepository", {repositoryId: renamed.repositoryId})
    if (!repo || repo.siteId !== siteId) return true
    if (own.all) return false
    return !(repo.ownerPartyId ? !!partyId && repo.ownerPartyId === partyId : ownsGroup(repo.groupId, partyId))
}
/* A path that is taken ends the redirect from it; the framework removes a repository's own (set#GitRepositoryPath). */
function releasePath(siteId, path) {
    const moved = one(M + "SmithyPathRedirect", {siteId, oldPath: String(path || "").toLowerCase()})
    if (moved) moved.delete()
}
/* The old path of a group or a handle, kept as a redirect to where it is now. A redirect from the new path to the same
   group or account (a name taken back) ends. */
function keepRedirect(siteId, oldPath, newPath, target) {
    releasePath(siteId, newPath)
    releasePath(siteId, oldPath)
    forum.create(M + "SmithyPathRedirect", {
        siteId,
        oldPath,
        redirectKindEnumId: target.groupId ? "SrkGroup" : "SrkAccount",
        groupId: target.groupId || null,
        partyId: target.partyId || null,
        createdAt: now()
    })
}
/* Whether a first-segment name is free in a site's one name set, for a new top-level group (kind "group") or a
   handle (kind "handle", which the party's own profile may already hold). An old path that still redirects holds its
   name against everyone but the party it belongs to. The caller has locked the site's PublicSite row, so a handle and
   a group path are not taken at the same time. */
function nameFree(siteId, name, forPartyId, kind = "group", own = {}) {
    const word = String(name || "").toLowerCase()
    if (!word || reservedFirstSegments(siteId).has(word)) return false
    if (groupHolding(siteId, word)) return false
    const profile = one(S + "PublicSiteProfile", {siteId, handle: word})
    if (profile && (kind !== "handle" || profile.partyId !== forPartyId)) return false
    return !pathHeld(siteId, word, forPartyId, own)
}
/* A handle that changed moves its personal namespace (§4.3): each repository's path through setPath, and the old handle
   kept as a redirect. Called by Forum's storeProfile, which has checked the new handle with nameFree. */
function handleChanged(siteId, partyId, oldHandle, newHandle) {
    if (!oldHandle || !newHandle || oldHandle === newHandle) return
    keepRedirect(siteId, oldHandle, newHandle, {partyId})
    for (const repo of find(M + "SmithyRepository", {siteId, ownerPartyId: partyId}).list())
        setPath(repo, {repositoryPath: newHandle + "/" + repo.slug})
}
/* Whether a name is free among a group's subgroups and repositories, which are one set, or among a personal
   namespace's repositories. */
function siblingFree(siteId, groupId, ownerPartyId, name) {
    const word = String(name || "").toLowerCase()
    if (groupId) {
        const taken = find(M + "SmithyGroup", {siteId, parentGroupId: groupId, pathSegment: word})
            .condition("statusId", "not-equals", "SmgRefused")
            .count()
        return taken === 0 && find(M + "SmithyRepository", {siteId, groupId, slug: word}).count() === 0
    }
    return find(M + "SmithyRepository", {siteId, ownerPartyId, slug: word}).count() === 0
}

// ===== the site's settings (§11 SiteSettings, §14.2 SmithySite) =====
const SETTING_DEFAULTS = {
    groupCreateEnumId: "ScpRequest",
    repositoryCreateEnumId: "ScpVerified",
    forkCreateEnumId: "ScpVerified",
    defaultMaxRepositories: 5,
    defaultRepositoryBytes: 1073741824,
    defaultLfsBytes: 1073741824,
    defaultRunnerMinutes: 0,
    groupRepositoryBytes: 5368709120,
    groupLfsBytes: 5368709120,
    groupRunnerMinutes: 2000,
    maxEditBytes: 1048576,
    repositoryKind: "db"
}
/* A site's Smithy settings, each its default where the row, or its field, is empty; row is the SmithySite or null. */
function settings(siteId) {
    const row = one(M + "SmithySite", {siteId})
    const out = {row, homeGroupId: row?.homeGroupId || null, revision: Number(row?.revision || 0)}
    for (const [name, fallback] of Object.entries(SETTING_DEFAULTS))
        out[name] =
            row?.[name] == null || row[name] === "" ? fallback : typeof fallback === "number" ? Number(row[name]) : row[name]
    return out
}

// ===== the actor =====
/* Who asks. With no userId the signed-in user on a page, where an operator is an Owner (§5.2 row 5); with one (the git
   server's check, which may be of no user) only what the party's rows give. */
function actor(userId) {
    if (userId === undefined) return {userId: ec.user.userId || null, partyId: me(), pages: true}
    const account = userId ? one("moqui.security.UserAccount", {userId}) : null
    return {userId: account ? userId : null, partyId: account?.partyId || null, pages: false}
}
/* Reads of one call evaluate the same site, group and party many times; inside withMemo the answers are kept. */
let memo = null
function withMemo(work) {
    const outer = memo
    memo = outer || new Map()
    try {
        return work()
    } finally {
        memo = outer
    }
}
function remember(key, work) {
    if (!memo) return work()
    if (!memo.has(key)) memo.set(key, work())
    return memo.get(key)
}
/* The site as an actor reads it: open when it is published, or to its owner, an operator on a page and internal staff
   (ForumCore.site's rule); joined for an active member who is not suspended; staff for its owner, moderators and
   operators. A suspended party reads as a signed-out visitor does. */
function siteAccess(siteId, a) {
    return remember("site|" + siteId + "|" + (a.partyId || "") + "|" + a.pages, () => {
        const site = one(S + "PublicSite", {siteId})
        const m = a.partyId ? member(siteId, a.partyId) : null
        const suspended = !!a.partyId && sanctioned(siteId, a.partyId, null, "suspend")
        const joined = !!m && active(m) && m.state === "active" && !suspended
        const operator = a.pages && isOperator()
        return {
            site,
            suspended,
            joined,
            operator,
            owner: operator || (joined && m.role === "owner"),
            staff: operator || (joined && ["owner", "moderator"].includes(m.role)),
            open: !!site && (site.state === "published" || (joined && m.role === "owner") || operator || internalParty(a.partyId))
        }
    })
}
/* Whether a site has Smithy: an enabled mount of the app. Without one no operation answers, and git takes no write. */
const mounted = siteId => remember("mount|" + siteId, () => !!publicApps().mount(siteId, "smithy"))
/* The site of a page operation, or Not Found: a site that is not open to the caller, and one that does not mount
   Smithy, whatever rows it has. */
function site(siteId) {
    const access = siteAccess(siteId, actor())
    if (!access.open || !mounted(siteId)) missing()
    return access.site
}

// ===== the evaluator (§5.1, §5.2) =====
/* A group and the groups above it, nearest first; null for a chain that is broken, loops or is too deep. */
function groupChain(groupId) {
    return remember("chain|" + groupId, () => {
        const chain = []
        let id = groupId
        while (id) {
            const group =
                chain.length < MAX_GROUP_DEPTH && !chain.some(g => g.groupId === id)
                    ? one(M + "SmithyGroup", {groupId: id})
                    : null
            if (!group) return null
            chain.push(group)
            id = group.parentGroupId
        }
        return chain
    })
}
const rowRank = row => (row && active(row) ? RANK[row.roleEnumId] || 0 : 0)
/* The highest rank a party's active rows give on a chain of groups: [rank, the group the row is on]. */
function groupRank(chain, partyId) {
    let best = [0, null]
    for (const group of chain) {
        const rank = rowRank(one(M + "SmithyGroupParty", {groupId: group.groupId, partyId}))
        if (rank > best[0]) best = [rank, group]
    }
    return best
}
const CLIENT_ROLES = ["Customer", "CustomerBillTo", "ClientManager", "ClientBilling"]
const LEAD_ROLES = ["ProjectManager", "Manager", "ProgrammerLead", "SysArchitect"]
/* The rank a party's project roles give on a repository (§5.2 row 4), read as check#GitRepositoryAuthz reads them: a
   lead is a Maintainer, another internal member a Developer, a client contact a Guest and only on a project that
   shares its repositories. */
function projectRank(repositoryId, a) {
    if (!a.userId || !a.partyId) return 0
    const projectIds = Array.from(
        find("mantle.work.effort.WorkEffortGitRepository", {repositoryId}).conditionDate("fromDate", "thruDate", null).list()
    ).map(link => link.workEffortId)
    if (!projectIds.length) return 0
    const client = ec.service
        .sync()
        .name("mantle.work.ProjectServices.get#ClientProjectInfo")
        .parameter("userId", a.userId)
        .call()
    if (ec.message.hasError() || client == null) return 0
    if (client.isClient)
        return projectIds.some(id => Array.from(client.shareRepositoryProjectIds || []).includes(id)) ? RANK.SmrGuest : 0
    const roles = Array.from(
        find("mantle.work.effort.WorkEffortParty", {partyId: a.partyId})
            .condition("workEffortId", "in", projectIds)
            .conditionDate("fromDate", "thruDate", null)
            .list()
    )
    const internal = roles.filter(row => !CLIENT_ROLES.includes(row.roleTypeId))
    if (internal.length) return internal.some(row => LEAD_ROLES.includes(row.roleTypeId)) ? RANK.SmrMaintainer : RANK.SmrDeveloper
    if (!roles.length) return 0
    const shared = find("mantle.work.effort.WorkEffortSetting", {settingTypeEnumId: "WstShareRepositories", settingValue: "Y"})
        .condition("workEffortId", "in", Array.from(new Set(roles.map(row => row.workEffortId))))
        .count()
    return shared > 0 ? RANK.SmrGuest : 0
}
/* Whether what a chain of groups and a record allow is viewable: the site open, every group active (else only its
   requester and the operators), not hidden (else only an Owner and the site's staff), and the effective visibility. */
function viewable(access, a, chain, rank, visibility, hidden) {
    if (!access.open || !chain) return false
    const pending = chain.filter(group => group.statusId !== "SmgActive")
    if (pending.length && !access.operator && !pending.every(group => !!a.partyId && group.requestedByPartyId === a.partyId))
        return false
    if (hidden && rank < RANK.SmrOwner && !access.staff) return false
    if (visibility === 1 || access.operator) return true
    // members-only is the site's active members; a role opens a private one only
    if (visibility === 2) return access.joined
    return rank >= RANK.SmrGuest
}
/* What an actor holds on a group: {group, chain, rank, canView, visibility (the effective one's order), hidden}. */
function groupRights(group, a) {
    return remember("group|" + group.groupId + "|" + (a.partyId || "") + "|" + a.pages, () => {
        const access = siteAccess(group.siteId, a)
        const chain = groupChain(group.groupId)
        const whole = chain && chain.every(g => g.siteId === group.siteId) ? chain : null
        let rank = 0
        if (whole && a.partyId && !access.suspended) rank = groupRank(whole, a.partyId)[0]
        if (access.operator) rank = RANK.SmrOwner
        const visibility = whole ? Math.max(...whole.map(g => visibilityRank(g.visibilityEnumId))) : 3
        const hidden = !!whole && whole.some(g => !!g.hiddenAt)
        return {
            group,
            chain: whole || [],
            access,
            rank,
            visibility,
            hidden,
            canView: viewable(access, a, whole, rank, visibility, hidden)
        }
    })
}
/* What an actor holds on a repository (a SmithyRepository row): the effective role's rank among its own row, its
   groups' rows, its personal namespace and its projects' roles, and whether it may be viewed. */
function repositoryRights(repo, a) {
    const access = siteAccess(repo.siteId, a)
    const chain = repo.groupId ? groupChain(repo.groupId) : repo.ownerPartyId ? [] : null
    const whole = chain && chain.every(g => g.siteId === repo.siteId) ? chain : null
    let rank = 0
    if (whole && a.partyId && !access.suspended) {
        rank = Math.max(
            rowRank(one(M + "SmithyRepositoryParty", {repositoryId: repo.repositoryId, partyId: a.partyId})),
            groupRank(whole, a.partyId)[0],
            repo.ownerPartyId === a.partyId ? RANK.SmrOwner : 0,
            projectRank(repo.repositoryId, a)
        )
    }
    if (access.operator) rank = RANK.SmrOwner
    const visibility = whole
        ? Math.max(visibilityRank(repo.visibilityEnumId), ...whole.map(g => visibilityRank(g.visibilityEnumId)))
        : 3
    const hidden = !!repo.hiddenAt || (!!whole && whole.some(g => !!g.hiddenAt))
    return {
        repo,
        chain: whole || [],
        access,
        rank,
        visibility,
        hidden,
        canView: viewable(access, a, whole, rank, visibility, hidden)
    }
}
/* Whether an actor may view a repository of a list, without reading its role rows when it is public in effect. */
function repositoryViewable(repo, a) {
    if (repo.groupId && !repo.hiddenAt && visibilityRank(repo.visibilityEnumId) === 1) {
        const group = one(M + "SmithyGroup", {groupId: repo.groupId})
        const rights = group && group.siteId === repo.siteId ? groupRights(group, a) : null
        if (rights && rights.canView && rights.visibility === 1 && !rights.hidden) return true
    }
    return repositoryRights(repo, a).canView
}
/* get#RepositoryRights (§5.4): what a user, or no user, holds on a hosted repository. known is false for one with no
   Smithy row. */
function rights(repositoryId, userId) {
    const repo = one(M + "SmithyRepository", {repositoryId})
    if (!repo) return {known: false, canView: false, role: null, rank: 0, confirmed: false}
    const a = actor(userId || null)
    const r = repositoryRights(repo, a)
    // a site that no longer mounts Smithy: who could view a repository still clones it, and nobody writes
    const rank = !r.canView ? 0 : mounted(repo.siteId) ? r.rank : Math.min(r.rank, RANK.SmrGuest)
    return {
        known: true,
        canView: r.canView,
        role: roleOfRank(rank),
        rank,
        confirmed: !!a.userId && confirmedAddress().confirmed(a.userId)
    }
}
/* A group of a site as the caller holds it, or Not Found. */
function group(groupId, siteId) {
    site(siteId)
    const row = typeof groupId === "string" && groupId ? one(M + "SmithyGroup", {groupId}) : null
    if (!row || row.siteId !== siteId) missing()
    const r = groupRights(row, actor())
    if (!r.canView) missing()
    return r
}
/* A repository of a site as the caller holds it, with its GitRepository row, or Not Found. */
function repository(repositoryId, siteId) {
    site(siteId)
    const row = typeof repositoryId === "string" && repositoryId ? one(M + "SmithyRepository", {repositoryId}) : null
    if (!row || row.siteId !== siteId) missing()
    const r = repositoryRights(row, actor())
    if (!r.canView) missing()
    r.git = one("moqui.resource.GitRepository", {repositoryId})
    if (!r.git) missing()
    return r
}
/* Refuses a viewer who lacks a role (accessDenied); a signed-out one is asked to sign in. */
function requireRole(r, roleEnumId) {
    if (r.rank >= RANK[roleEnumId]) return
    if (!me()) fail("AuthenticationRequired", "Sign in to continue")
    fail("Unauthorized", "accessDenied: This needs the " + ROLE_CODES[roleEnumId] + " role")
}

// ===== issues (§8) and the scope category of a conversation (§12.1) =====
const F = "mantle.forum."
/* A party as an actor that is not on a page (a notice's reader, an assignee): by its first enabled account. */
function actorOfParty(partyId) {
    if (!partyId) return {userId: null, partyId: null, pages: false}
    if (partyId === me()) return actor()
    const account = rows("moqui.security.UserAccount", {partyId}, 20).find(row => row.disabled !== "Y")
    return {userId: account?.userId || null, partyId: account ? partyId : null, pages: false}
}
/* A category that is a scope only: a mailbox list nobody is a member of and a ForumCategory that is not published, so it
   is in no category list and nobody reads it as a category (§12.5; DG6 publishes a group's with its forum). The list is
   made as a row: the list service would make the caller its owner, and so a moderator of the scope. */
function makeScopeCategory(siteId, name, parentContactListId) {
    const list = ec.entity.makeValue("mantle.marketing.contact.ContactList")
    list.setSequencedIdPrimary()
    list.set("contactListTypeEnumId", "MAILBOX")
    list.set("contactListName", String(name).slice(0, 100))
    list.set("isPublic", "N")
    list.set("postingEnumId", "ClpModerators")
    list.create()
    forum.create(F + "ForumCategory", {
        contactListId: list.contactListId,
        siteId,
        parentContactListId: parentContactListId || null,
        slug: list.contactListId,
        sequenceNum: 0,
        publicationState: "disabled",
        visibility: "members",
        mode: "discussion",
        policyRevision: 1
    })
    return list.contactListId
}
/* ensure#GroupCategory: a group's category, made on first need under its parent group's (a top-level group's has no
   parent). The group's row is locked, so two first needs make one. */
function ensureGroupCategory(groupId) {
    const group = one(M + "SmithyGroup", {groupId}, true)
    if (!group) missing()
    if (group.contactListId) return group.contactListId
    const parent = group.parentGroupId ? ensureGroupCategory(group.parentGroupId) : null
    const contactListId = makeScopeCategory(group.siteId, group.groupPath, parent)
    update(group, {contactListId})
    return contactListId
}
/* ensure#AccountCategory: the one scope category of a site's personal namespaces, made on first need. */
function ensureAccountCategory(siteId) {
    one(S + "PublicSite", {siteId}, true)
    const row = one(M + "SmithySite", {siteId}, true)
    if (row?.accountContactListId) return row.accountContactListId
    const contactListId = makeScopeCategory(siteId, "Personal repositories", null)
    if (row) update(row, {accountContactListId: contactListId})
    else forum.create(M + "SmithySite", {siteId, accountContactListId: contactListId, revision: 1})
    return contactListId
}
/* The scope category of a repository's conversations: its own, else its group's, else the site's account category. */
const scopeCategory = repo =>
    repo.contactListId || (repo.groupId ? ensureGroupCategory(repo.groupId) : ensureAccountCategory(repo.siteId))
/* What an actor holds on an issue (§5.3, §8.1, §8.3), from the rights it holds on the repository (r):
   - read: a viewer of a repository with issues on, when the task is public (WevGeneral) or the actor is a Reporter; a
     confidential one only its Owners (operators on a page among them) and its reporter;
   - write (comment, react, flag, upload): a reader with a confirmed address who is not suspended or silenced, in a
     repository that is not archived; writeRefusal says which of these refused;
   - moderate: a reader who is an Owner; for an issue that is not confidential the site's staff and the scope
     category's moderators too. */
function issueAccess(r, issue, a, scopeContactListId) {
    const task = one("mantle.work.effort.WorkEffort", {workEffortId: issue.workEffortId})
    const confidential = issue.confidential === "Y"
    const owner = r.rank >= RANK.SmrOwner
    const reporter = !!a.partyId && issue.reporterPartyId === a.partyId
    const canRead =
        r.canView &&
        r.repo.issuesEnabled === "Y" &&
        !!task &&
        (confidential ? owner || reporter : task.visibilityEnumId === "WevGeneral" || r.rank >= RANK.SmrReporter)
    const isConfirmed = !!a.userId && confirmedAddress().confirmed(a.userId)
    const silenced = !!a.partyId && sanctioned(r.repo.siteId, a.partyId, scopeContactListId || null, "silence")
    const archived = !!(r.git || one("moqui.resource.GitRepository", {repositoryId: r.repo.repositoryId}))?.archivedDate
    const writeRefusal =
        !canRead || !a.partyId
            ? null
            : !isConfirmed
              ? "addressUnconfirmed: Confirm your email address to continue"
              : r.access.suspended || silenced
                ? "accessDenied: Your account may not post on this site"
                : archived
                  ? "repositoryArchived: This repository is archived"
                  : null
    const listStaff = () => {
        const row = scopeContactListId && a.partyId ? forum.listMember(scopeContactListId, a.partyId) : null
        return !!row && ["ListOwner", "ListModerator"].includes(row.roleTypeId)
    }
    return {
        issue,
        task,
        confidential,
        owner,
        reporter,
        canRead,
        // the reporter of a confidential issue who is no Owner reads their own text and the replies addressed to them
        limited: confidential && !owner,
        writable: canRead && !!a.partyId && !writeRefusal,
        writeRefusal,
        canModerate: canRead && !r.access.suspended && (owner || (!confidential && (r.access.staff || listStaff())))
    }
}

// ===== paths (§4.3, §4.4) =====
/* The one writer of a repository's path: the framework's set#GitRepositoryPath, which keeps the old path as a
   GitRepositoryPathRedirect, and the SmithyRepository row, in one transaction. */
function setPath(repo, fields) {
    const repositoryPath = fields.repositoryPath
    ec.service
        .sync()
        .name(GIT + "set#GitRepositoryPath")
        .parameters({repositoryId: repo.repositoryId, repositoryPath})
        .call()
    if (ec.message.hasError()) {
        const text = ec.message.getErrorsString()
        ec.message.clearErrors()
        ec.logger.warn("Smithy path " + repositoryPath + " of " + repo.repositoryId + " refused: " + text)
        invalid("nameTaken[slug]: That path is not available")
    }
    return update(repo, fields)
}
const HEX = /^[0-9a-f]{7,40}$/i
/* A framework git read; an error it leaves (a repository that cannot be read) is Not Found. */
function git(name, parameters) {
    const out = ec.service
        .sync()
        .name(GIT + name)
        .parameters(parameters)
        .call()
    if (ec.message.hasError()) {
        ec.logger.warn("Smithy read " + name + " of " + parameters.repositoryId + " failed: " + ec.message.getErrorsString())
        ec.message.clearErrors()
        missing()
    }
    return out || {}
}
/* A refPath (§4.4) is a ref name followed by a path in the tree, with nothing between them: the longest prefix that
   names a branch, else a tag, else a first segment that is a commit id. Empty is the default branch and the root. Gives
   {kind, name, fullName, commitId, path}, with empty for a repository that has no commit; Not Found otherwise. */
function splitRefPath(repositoryId, refPath, known) {
    const refs = known || git("get#GitRefs", {repositoryId})
    const list = Array.from(refs.refList || [])
    const segments = String(refPath || "")
        .split("/")
        .filter(segment => segment !== "")
    if (segments.some(segment => segment === "." || segment === "..")) missing()
    if (!segments.length) {
        const name = refs.defaultBranch || "main"
        const head = list.find(ref => ref.refType === "branch" && ref.shortName === name)
        return {kind: "branch", name, fullName: "refs/heads/" + name, commitId: head?.commitId || null, path: "", empty: !head}
    }
    for (let length = segments.length; length > 0; length--) {
        const name = segments.slice(0, length).join("/")
        const ref =
            list.find(r => r.refType === "branch" && r.shortName === name) ||
            list.find(r => r.refType === "tag" && r.shortName === name)
        if (ref)
            return {
                kind: ref.refType,
                name,
                fullName: ref.refName,
                commitId: ref.commitId,
                path: segments.slice(length).join("/"),
                empty: false
            }
    }
    if (HEX.test(segments[0])) {
        const commit = git("get#GitCommit", {repositoryId, commitId: segments[0], stats: false}).commit
        if (commit?.commitId && String(commit.commitId).startsWith(segments[0].toLowerCase()))
            return {
                kind: "commit",
                name: commit.commitId,
                fullName: commit.commitId,
                commitId: commit.commitId,
                path: segments.slice(1).join("/"),
                empty: false
            }
    }
    return missing()
}
/* A branch, a tag or a commit id and nothing after it (a side of a compare), never another ref name or an expression;
   Not Found otherwise. */
function refOf(repositoryId, name, known) {
    const ref = splitRefPath(repositoryId, name, known)
    if (ref.empty || ref.path) missing()
    return ref
}
/* Whether a profile is shown to the caller: its own, a public one, or a members' one to an active member. */
function profileShown(profile, a) {
    if (!profile) return false
    if (profile.partyId === a.partyId) return true
    const access = siteAccess(profile.siteId, a)
    return profile.discoverability === "public" || (profile.discoverability === "members" && access.joined)
}
/* Whether a handle's page is there for the caller: by its profile, or by a repository of its namespace that the caller
   may view. */
function accountShown(profile, a) {
    return (
        !!profile &&
        (profileShown(profile, a) ||
            rows(M + "SmithyRepository", {siteId: profile.siteId, ownerPartyId: profile.partyId}, 200).some(row =>
                repositoryViewable(row, a)
            ))
    )
}
/* A GitHub form after a repository's path, as the section it is in Smithy; null when it is none. */
function compatibilitySection(rest) {
    const [word, ...more] = rest
    const tail = more.length ? "/" + more.join("/") : ""
    const number = more.length === 1 && /^[1-9][0-9]{0,8}$/.test(more[0])
    if (word === "issues" && (!more.length || number)) return "issues" + tail
    if (word === "pull" && number) return "merge-requests" + tail
    if (word === "pulls" && !more.length) return "merge-requests"
    if (["tree", "blob", "commits"].includes(word) && more.length) return word + tail
    if (word === "commit" && more.length === 1 && HEX.test(more[0])) return "commit" + tail
    if (word === "releases" && !more.length) return "releases"
    if (word === "releases" && more[0] === "tag" && more.length > 1) return "releases/" + more.slice(1).join("/")
    return null
}
/* resolveSmithyPath: what the name segments of a page's path are, by the lookups of §4.4 step 4 in their order, each
   within the site. The path comes as typed: the names being tested are lowered, the rest keeps its case, and a .git
   suffix is dropped only from the segment that ends a whole repository path. What the caller may not view is Not Found,
   exactly as a path with no row. */
function resolvePath(siteId, path) {
    site(siteId)
    const a = actor()
    const given = String(path || "")
        .split("/")
        .filter(segment => segment !== "")
    if (!given.length || given.length > 40 || given.some(segment => segment.length > 255 || segment === "." || segment === ".."))
        missing()
    const answer = fields => ({
        kind: null,
        groupId: null,
        repositoryId: null,
        handle: null,
        canonicalPath: null,
        redirectPath: null,
        ...fields
    })
    const lowered = given.map(segment => segment.toLowerCase())
    const whole = lowered.join("/")
    const repositoryAt = repositoryPath => one(M + "SmithyRepository", {siteId, repositoryPath})
    const viewableRepository = repositoryPath => {
        const repo = repositoryAt(repositoryPath)
        return repo && repositoryRights(repo, a).canView ? repo : null
    }
    const repo = repositoryAt(whole) || (whole.endsWith(".git") ? repositoryAt(whole.slice(0, -4)) : null)
    if (repo) {
        if (!repositoryRights(repo, a).canView) missing()
        return answer({kind: "repository", repositoryId: repo.repositoryId, canonicalPath: repo.repositoryPath})
    }
    const groupRow = one(M + "SmithyGroup", {siteId, groupPath: whole})
    if (groupRow) {
        if (!groupRights(groupRow, a).canView) missing()
        return answer({kind: "group", groupId: groupRow.groupId, canonicalPath: groupRow.groupPath})
    }
    if (lowered.length === 1) {
        const profile = one(S + "PublicSiteProfile", {siteId, handle: whole})
        if (accountShown(profile, a)) return answer({kind: "account", handle: profile.handle, canonicalPath: profile.handle})
    }
    // an old path of a repository of this site that was renamed or moved, by the longest prefix
    for (let length = lowered.length; length > 0; length--) {
        const prefix = lowered.slice(0, length).join("/")
        const redirect =
            one("moqui.resource.GitRepositoryPathRedirect", {oldPath: prefix}) ||
            (length === lowered.length && prefix.endsWith(".git")
                ? one("moqui.resource.GitRepositoryPathRedirect", {oldPath: prefix.slice(0, -4)})
                : null)
        const target = redirect ? one(M + "SmithyRepository", {repositoryId: redirect.repositoryId}) : null
        if (target && target.siteId === siteId && repositoryRights(target, a).canView)
            return answer({kind: "redirect", redirectPath: [target.repositoryPath].concat(given.slice(length)).join("/")})
    }
    // an old path of a group that was renamed or of a handle that changed, by the longest prefix
    for (let length = lowered.length; length > 0; length--) {
        const moved = one(M + "SmithyPathRedirect", {siteId, oldPath: lowered.slice(0, length).join("/")})
        if (!moved) continue
        let current = null
        if (moved.redirectKindEnumId === "SrkAccount") {
            const profile = one(S + "PublicSiteProfile", {siteId, partyId: moved.partyId})
            if (accountShown(profile, a)) current = profile.handle
        } else {
            const target = moved.groupId ? one(M + "SmithyGroup", {groupId: moved.groupId}) : null
            if (target && target.siteId === siteId && groupRights(target, a).canView) current = target.groupPath
        }
        if (current) return answer({kind: "redirect", redirectPath: [current].concat(given.slice(length)).join("/")})
        break
    }
    // a GitHub URL whose host was changed: the longest proper prefix that is a repository, then a form GitHub has
    if (lowered.length >= 3)
        for (let length = Math.min(lowered.length - 1, MAX_GROUP_DEPTH + 1); length >= 2; length--) {
            const target = viewableRepository(lowered.slice(0, length).join("/"))
            const section = target ? compatibilitySection(given.slice(length)) : null
            if (section) return answer({kind: "redirect", redirectPath: target.repositoryPath + "/-/" + section})
        }
    return missing()
}
;({
    M,
    GIT,
    forum,
    VISIBILITY,
    VISIBILITY_CODES,
    VISIBILITY_IDS,
    RANK,
    ROLE_CODES,
    STATUS_CODES,
    POLICY_CODES,
    idOfCode,
    visibilityRank,
    roleOfRank,
    roleCode,
    HANDLE,
    MAX_GROUP_DEPTH,
    reservedNames,
    validGroupSegment,
    validSlug,
    reservedFirstSegments,
    nameHeld,
    groupHolding,
    nameFree,
    siblingFree,
    pathHeld,
    releasePath,
    keepRedirect,
    handleChanged,
    ownsGroup,
    settings,
    SETTING_DEFAULTS,
    actor,
    withMemo,
    siteAccess,
    site,
    groupChain,
    groupRank,
    groupRights,
    repositoryRights,
    repositoryViewable,
    rights,
    group,
    repository,
    requireRole,
    setPath,
    git,
    HEX,
    splitRefPath,
    refOf,
    profileShown,
    accountShown,
    resolvePath,
    actorOfParty,
    ensureGroupCategory,
    ensureAccountCategory,
    scopeCategory,
    issueAccess,
    GROUP_REPOSITORY_LIMIT,
    mounted,
    // of an account by its userId (none: false), and of the signed-in account
    confirmed: userId => confirmedAddress().confirmed(userId),
    confirmedNow: () => confirmedAddress().currentConfirmed()
})
