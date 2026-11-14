/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * Smithy's accounts and settings (mr-pass plan/design-smithy.md §15.3, DG2): the site's settings and creation policy,
 * group requests and their decision, groups and subgroups, repositories, members and roles, visibility, rename and
 * transfer, archive and delete, quotas and usage. Smithy.js calls this with its kit and each operation is a method of its
 * map, run through execute(). Every write needs a signed-in account with a confirmed address that is not suspended on
 * the site (kit.writer), a name or a description passes the forum's rules (checkText), and a role is checked after the
 * view rule, so what the caller may not view is Not Found. The rules are SmithyCore.js's.
 */
kit => {
    const {
        core,
        methods,
        flag,
        text,
        handleOf,
        groupView,
        memberView,
        visibilityId,
        writer,
        grantOwner,
        makeGroup,
        makeRepository
    } = kit
    const {pathFree, lockNames, MERGE_METHODS} = kit
    const {M, GIT, forum, VISIBILITY_CODES, VISIBILITY_IDS, RANK, ROLE_CODES, STATUS_CODES, POLICY_CODES} = core
    const {S, now, me, find, one, create, update, fail, missing, invalid, requireUser, page, receipt, audit, sanctioned, active} =
        forum
    const FORUM = "component://mr-mantle/service/mantle/forum/Forum.js"

    // ===== what the writes share =====
    const given = value => value !== undefined
    const denied = message => fail("Unauthorized", "accessDenied: " + message)
    const revisionOf = row => Number(row?.revision || 1)
    /* An edit names the revision it read (§15.1); 0 for a record that is not there yet. */
    function fresh(current, expected) {
        if (expected == null || expected === "" || Number(expected) !== Number(current))
            fail("Conflict", "staleRevision: This changed since you read it; reload and try again")
    }
    function wholeNumber(value, name) {
        if (value == null || value === "") return null
        const number = Number(value)
        if (!Number.isSafeInteger(number) || number < 0) invalid(name + " must be a whole number")
        return number
    }
    function timestamp(value, name) {
        if (value == null || value === "") return null
        const parsed = ec.l10n.parseTimestamp(text(value), null)
        if (!parsed) invalid(name + " must be a date")
        return parsed
    }
    /* A name or a description an account writes, before the gate of DG3 (§11 "Before the gate"): a silence on the site
       refuses it, and so does a block or an approve rule of the forum (there is no queue to hold it in yet). */
    function checkText(siteId, partyId, values) {
        if (sanctioned(siteId, partyId, null, "silence")) denied("Your account may not post on this site")
        const written = values
            .filter(value => value != null && value !== "")
            .map(text)
            .join("\n")
        if (!written) return
        const ruled = ec.resource.script(FORUM).applyRules(siteId, null, written)
        if (ruled.block || ruled.approve) invalid("The site's rules do not allow that text")
    }
    /* The site's owners and operators, never a moderator (§11 SiteSettings); a write also needs what every write does. */
    function siteOwner(siteId, write) {
        core.site(siteId)
        const who = write ? writer(siteId) : {partyId: requireUser(), access: core.siteAccess(siteId, core.actor())}
        if (!who.access.owner) denied("Only the site's owners do this")
        return who
    }
    /* A framework hosting service after Smithy's own check: what it refuses is the request's fault, with its text. */
    function hosted(name, parameters) {
        const out = ec.service
            .sync()
            .name(GIT + name)
            .parameters(parameters)
            .call()
        if (!ec.message.hasError()) return out || {}
        const problem = text(ec.message.getErrorsString()).split("\n")[0]
        ec.message.clearErrors()
        ec.logger.warn("Smithy " + name + " of " + (parameters.repositoryId || "") + " refused: " + problem)
        return invalid(problem.slice(0, 200))
    }
    const archived = () => fail("Conflict", "repositoryArchived: This repository is archived")
    /* A group for a write: as the caller views it (else Not Found), by a writer with the role, its row locked; with
       names the site's names are locked first, once the caller is known to be one who may write. */
    function groupFor(p, roleEnumId, names) {
        const r = core.group(p.groupId, p.siteId)
        const who = writer(p.siteId)
        core.requireRole(r, roleEnumId)
        if (names) lockNames(p.siteId)
        return {r, group: one(M + "SmithyGroup", {groupId: r.group.groupId}, true), ...who}
    }
    /* A repository for a write, the same way. */
    function repositoryFor(p, roleEnumId, names) {
        const r = core.repository(p.repositoryId, p.siteId)
        const who = writer(p.siteId)
        core.requireRole(r, roleEnumId)
        if (names) lockNames(p.siteId)
        return {r, repo: one(M + "SmithyRepository", {repositoryId: r.repo.repositoryId}, true), ...who}
    }
    const below = (rows, field, path) => Array.from(rows).filter(row => text(row[field]).startsWith(path + "/"))
    /* The groups and the repositories below a group's path, which a top-level group's bound keeps few (the query takes
       no more than twice that); '_' is a wildcard of like, so the prefix is checked again. */
    const BELOW = core.GROUP_REPOSITORY_LIMIT * 2
    const groupsBelow = (siteId, path) =>
        below(
            find(M + "SmithyGroup", {siteId})
                .condition("groupPath", "like", path + "/%")
                .limit(BELOW)
                .list(),
            "groupPath",
            path
        )
    const repositoriesBelow = (siteId, path) =>
        below(
            find(M + "SmithyRepository", {siteId})
                .condition("repositoryPath", "like", path + "/%")
                .limit(BELOW)
                .list(),
            "repositoryPath",
            path
        )
    const personalRepositories = (siteId, ownerPartyId) =>
        Array.from(
            find(M + "SmithyRepository", {siteId, ownerPartyId})
                .limit(BELOW)
                .list()
        )
    /* Whether a top-level group, with what is below it, has as many repositories as a group may have. */
    const groupFull = (siteId, chain) =>
        find(M + "SmithyRepository", {siteId})
            .condition("repositoryPath", "like", chain[chain.length - 1].groupPath + "/%")
            .count() >= core.GROUP_REPOSITORY_LIMIT

    // ===== quotas (§11 Quotas) =====
    /* An account's limits in a site: its SmithyAccount row's, each the site's default where it is empty. */
    function accountLimits(siteId, partyId, s = core.settings(siteId)) {
        const account = one(M + "SmithyAccount", {siteId, partyId})
        const of = (field, fallback) => (account?.[field] == null ? fallback : Number(account[field]))
        return {
            account,
            repositories: of("maxRepositories", s.defaultMaxRepositories),
            repositoryBytes: of("maxRepositoryBytes", s.defaultRepositoryBytes),
            lfsBytes: of("maxLfsBytes", s.defaultLfsBytes),
            runnerMinutes: of("runnerMinutesMonthly", s.defaultRunnerMinutes)
        }
    }
    /* A group's limits: each field from the nearest group of its chain that sets it, else the site's default for a
       group. lfsGroup is the group whose LFS limit it is, which counts every repository below it. */
    function groupLimits(chain, s) {
        const nearest = field => chain.find(g => g[field] != null) || null
        const of = (field, fallback) => (nearest(field) ? Number(nearest(field)[field]) : fallback)
        return {
            // of a top-level group with what is below it; a group sets none of its own
            repositories: core.GROUP_REPOSITORY_LIMIT,
            repositoryBytes: of("maxRepositoryBytes", s.groupRepositoryBytes),
            lfsBytes: of("maxLfsBytes", s.groupLfsBytes),
            runnerMinutes: of("runnerMinutesMonthly", s.groupRunnerMinutes),
            lfsGroup: nearest("maxLfsBytes") || chain[chain.length - 1]
        }
    }
    /* What bounds a repository: its namespace's limits, and lfsRepositoryIds(), the repositories its LFS limit counts.
       A repository whose group chain is broken has no room, so bad data fails closed. */
    function repositoryQuota(repo) {
        const s = core.settings(repo.siteId)
        const ids = rows => rows.map(row => row.repositoryId)
        if (repo.ownerPartyId)
            return {
                ...accountLimits(repo.siteId, repo.ownerPartyId, s),
                lfsRepositoryIds: () => ids(personalRepositories(repo.siteId, repo.ownerPartyId))
            }
        const chain = repo.groupId ? core.groupChain(repo.groupId) : null
        if (!chain || !chain.length) return {repositoryBytes: 0, lfsBytes: 0, lfsRepositoryIds: () => [repo.repositoryId]}
        const limits = groupLimits(chain, s)
        return {...limits, lfsRepositoryIds: () => ids(repositoriesBelow(repo.siteId, limits.lfsGroup.groupPath))}
    }
    /* What repositories use, by the framework's count (N-USAGE: the stored bytes without the objects shared from a fork
       parent, and the LFS bytes), asked for at most 1,000 at a time: a Map by repositoryId, or null when the framework
       cannot say, for any of them. A caller that holds something to a limit refuses then. */
    const USAGE_CHUNK = 1000
    function usageOf(repositoryIds) {
        const used = new Map()
        for (let from = 0; from < repositoryIds.length; from += USAGE_CHUNK) {
            const asked = repositoryIds.slice(from, from + USAGE_CHUNK)
            ec.message.pushErrors()
            const out = ec.service
                .sync()
                .name(GIT + "get#GitRepositoryUsage")
                .parameters({repositoryIdList: asked})
                .call()
            const problem = ec.message.hasError() ? text(ec.message.getErrorsString()).split("\n")[0] : null
            ec.message.clearErrors()
            ec.message.popErrors()
            for (const row of Array.from(out?.usageList || [])) used.set(row.repositoryId, row)
            if (problem != null || out == null || asked.some(id => !used.has(id))) {
                ec.logger.warn(
                    "Smithy usage of " + asked.length + " repositories is not known: " + (problem || "not all answered")
                )
                return null
            }
        }
        return used
    }
    kit.quota = {accountLimits, groupLimits, repositoryQuota, usageOf}
    kit.hosted = hosted
    kit.fresh = fresh
    kit.revisionOf = revisionOf
    kit.archived = archived
    kit.maintainerAudit = (p, action, reason) =>
        audit(p.siteId, null, "repository", p.repositoryId, action, text(reason).slice(0, 255), null, null)
    kit.repositoryFor = repositoryFor

    // ===== the site's settings =====
    const POLICY_FIELDS = {
        groupCreate: "groupCreateEnumId",
        repositoryCreate: "repositoryCreateEnumId",
        forkCreate: "forkCreateEnumId"
    }
    const SETTING_NUMBERS = [
        "defaultMaxRepositories",
        "defaultRepositoryBytes",
        "defaultLfsBytes",
        "defaultRunnerMinutes",
        "groupRepositoryBytes",
        "groupLfsBytes",
        "groupRunnerMinutes",
        "maxEditBytes"
    ]
    /* Whether the site's policy lets an account make something: its owners always, anyone with a confirmed address by
       the verified policy. request is a group's: the request is the making. */
    const policyAllows = (policyEnumId, access, byRequest) =>
        access.owner || policyEnumId === "ScpVerified" || (byRequest && policyEnumId === "ScpRequest")
    methods.getSmithySettings = p => {
        core.site(p.siteId)
        const s = core.settings(p.siteId)
        const access = core.siteAccess(p.siteId, core.actor())
        // a policy the row holds that is none of the three reads as the narrowest
        const policies = Object.fromEntries(
            Object.entries(POLICY_FIELDS).map(([word, field]) => [word, POLICY_CODES[s[field]] || "operators"])
        )
        const partyId = me()
        const confirmed = !!partyId && core.confirmedNow()
        const mayWrite = confirmed && !access.suspended
        const shown = {
            ...policies,
            // what the caller may start, so a page shows only the controls that would be accepted
            capabilities: {
                signedIn: !!partyId,
                confirmed,
                siteOwner: !!partyId && access.owner,
                canRequestGroup: mayWrite && policyAllows(s.groupCreateEnumId, access, true),
                canCreateRepository: mayWrite && policyAllows(s.repositoryCreateEnumId, access, false),
                groupRequestWaiting:
                    !!partyId &&
                    find(M + "SmithyGroup", {siteId: p.siteId, requestedByPartyId: partyId, statusId: "SmgRequested"}).count() > 0
            }
        }
        if (!partyId || !access.owner) return shown
        const home = s.homeGroupId ? one(M + "SmithyGroup", {groupId: s.homeGroupId}) : null
        return {
            ...shown,
            homeGroupId: home?.groupId || null,
            homeGroupPath: home?.groupPath || null,
            ...Object.fromEntries(SETTING_NUMBERS.map(name => [name, s[name]])),
            repositoryKind: s.repositoryKind,
            revision: s.revision
        }
    }
    methods.storeSmithySettings = p => {
        const {partyId} = siteOwner(p.siteId, true)
        // the site's row is locked, so the settings row is made once
        one(S + "PublicSite", {siteId: p.siteId}, true)
        const s = core.settings(p.siteId)
        fresh(s.revision, p.expectedRevision)
        const fields = {}
        for (const [word, field] of Object.entries(POLICY_FIELDS))
            if (given(p[word]))
                fields[field] = core.idOfCode(POLICY_CODES, p[word]) || invalid(word + " must be operators, request or verified")
        for (const name of SETTING_NUMBERS) if (given(p[name])) fields[name] = wholeNumber(p[name], name)
        if (given(p.repositoryKind)) {
            if (p.repositoryKind && !["db", "local"].includes(p.repositoryKind)) invalid("repositoryKind must be db or local")
            fields.repositoryKind = p.repositoryKind || null
        }
        if (given(p.homeGroupPath)) {
            const home = p.homeGroupPath
                ? one(M + "SmithyGroup", {siteId: p.siteId, groupPath: text(p.homeGroupPath).toLowerCase()})
                : null
            if (p.homeGroupPath && (!home || home.statusId !== "SmgActive"))
                invalid("homeGroupPath names no active group of this site")
            fields.homeGroupId = home?.groupId || null
        }
        const changed = Object.keys(fields).join(" ")
        fields.revision = s.revision + 1
        if (s.row) update(s.row, fields)
        else create(M + "SmithySite", {siteId: p.siteId, ...fields})
        audit(p.siteId, null, "site", p.siteId, "storeSmithySettings", changed, s.revision, fields.revision)
        return {revision: fields.revision}
    }

    // ===== group requests and groups =====
    methods.requestGroup = p => {
        core.site(p.siteId)
        const {partyId, access} = writer(p.siteId)
        lockNames(p.siteId)
        return receipt(p, "smithy.requestGroup", () => {
            const policy = core.settings(p.siteId).groupCreateEnumId
            if (!policyAllows(policy, access, true)) invalid("policyRefused: Only the site's operators make a group here")
            if (
                !access.owner &&
                find(M + "SmithyGroup", {siteId: p.siteId, requestedByPartyId: partyId, statusId: "SmgRequested"}).count() > 0
            )
                fail("Conflict", "You have a group request waiting")
            checkText(p.siteId, partyId, [p.name, p.description, p.reason])
            const statusId = access.owner || policy === "ScpVerified" ? "SmgActive" : "SmgRequested"
            const made = makeGroup({...p, partyId, access, parent: null, statusId})
            if (statusId === "SmgActive") audit(p.siteId, null, "group", made.groupId, "createGroup", made.groupPath, null, 1)
            return {groupId: made.groupId, groupPath: made.groupPath, status: STATUS_CODES[statusId]}
        })
    }
    methods.findGroupRequests = p => {
        siteOwner(p.siteId, false)
        const statusId =
            core.idOfCode(STATUS_CODES, p.status || "requested") || invalid("status must be requested, active or refused")
        const pg = page(p, "smithy-group-requests:" + p.siteId + ":" + statusId)
        const a = core.actor()
        // a request is a top-level group; whoever decides reads it by this check, not by the view rule
        const found = Array.from(
            find(M + "SmithyGroup", {siteId: p.siteId, statusId})
                .condition("parentGroupId", null)
                .orderBy("createdAt,groupId")
                .offset(pg.offset)
                .limit(pg.limit + 1)
                .list()
        )
        return {
            requestList: found.slice(0, pg.limit).map(row => ({
                group: groupView(core.groupRights(row, a), a),
                requestedBy: handleOf(p.siteId, row.requestedByPartyId),
                requestReason: row.requestReason || "",
                createdAt: row.createdAt || null,
                decidedAt: row.decidedAt || null,
                decisionReason: row.decisionReason || ""
            })),
            nextCursor: found.length > pg.limit ? pg.next(pg.offset + pg.limit) : null
        }
    }
    methods.decideGroupRequest = p => {
        const {partyId} = siteOwner(p.siteId, true)
        const row = typeof p.groupId === "string" && p.groupId ? one(M + "SmithyGroup", {groupId: p.groupId}, true) : null
        if (!row || row.siteId !== p.siteId || row.parentGroupId) missing()
        if (!["approve", "refuse"].includes(p.decision)) invalid("decision must be approve or refuse")
        if (row.statusId !== "SmgRequested") fail("Conflict", "That request is already decided")
        const before = revisionOf(row)
        fresh(before, p.expectedRevision)
        const approve = p.decision === "approve"
        if (!approve && !text(p.reason).trim()) invalid("A reason is needed to refuse a request")
        update(row, {
            statusId: approve ? "SmgActive" : "SmgRefused",
            decidedByPartyId: partyId,
            decidedAt: now(),
            decisionReason: text(p.reason) || null,
            revision: before + 1
        })
        // the requester is the group's first Owner
        if (approve && row.requestedByPartyId) grantOwner(row, row.requestedByPartyId, partyId)
        audit(p.siteId, null, "group", row.groupId, approve ? "approveGroup" : "refuseGroup", text(p.reason), before, before + 1)
        return {status: STATUS_CODES[row.statusId], revision: before + 1}
    }
    methods.createSubgroup = p => {
        const parent = core.group(p.groupId, p.siteId)
        const {partyId, access} = writer(p.siteId)
        core.requireRole(parent, "SmrOwner")
        lockNames(p.siteId)
        return receipt(p, "smithy.createSubgroup", () => {
            checkText(p.siteId, partyId, [p.name, p.description])
            const made = makeGroup({...p, partyId, access, parent})
            return {groupId: made.groupId, groupPath: made.groupPath}
        })
    }
    /* A group's avatar is an image its Owner uploaded as one, by the rules of a profile's (Forum's storeProfile): the
       caller's own avatar upload on this site, scanned clean, not yet expired; it is kept from now, and the one it
       replaces is let go in a week. */
    function avatar(siteId, partyId, avatarId, oldAvatarId) {
        const kept = avatarId || null
        if (kept && kept !== oldAvatarId) {
            const attachment = one("mantle.forum.ForumAttachment", {attachmentId: kept}, true)
            if (
                !attachment ||
                attachment.siteId !== siteId ||
                attachment.ownerPartyId !== partyId ||
                attachment.purpose !== "avatar" ||
                attachment.communicationEventId ||
                attachment.scanState !== "clean" ||
                !text(attachment.mimeType).startsWith("image/") ||
                !attachment.expiresAt ||
                forum.millis(attachment.expiresAt) <= forum.millis(now())
            )
                invalid("avatarId names no image of yours that has passed scanning")
            update(attachment, {expiresAt: null, draftId: null})
        }
        if (oldAvatarId && oldAvatarId !== kept) {
            const abandoned = one("mantle.forum.ForumAttachment", {attachmentId: oldAvatarId}, true)
            if (abandoned) update(abandoned, {expiresAt: forum.millis(now()) + 7 * 86400000})
        }
        return kept
    }
    methods.updateGroup = p => {
        const {r, group, partyId} = groupFor(p, "SmrOwner")
        const before = revisionOf(group)
        fresh(before, p.expectedRevision)
        const fields = {}
        if (given(p.name)) {
            fields.name = text(p.name).trim()
            if (!fields.name || fields.name.length > 255) invalid("name is 1 to 255 characters")
        }
        if (given(p.description)) fields.description = text(p.description) || null
        if (given(p.name) || given(p.description)) checkText(p.siteId, partyId, [p.name, p.description])
        if (given(p.avatarId)) fields.avatarId = avatar(p.siteId, partyId, p.avatarId, group.avatarId)
        let narrowedCount = 0
        if (given(p.visibility) && p.visibility !== "") {
            const visibilityEnumId = visibilityId(p.visibility)
            const rank = core.visibilityRank(visibilityEnumId)
            const above = r.chain.slice(1)
            if (above.length && rank < Math.max(...above.map(g => core.visibilityRank(g.visibilityEnumId))))
                invalid("policyRefused[visibility]: A subgroup is no wider than its group")
            fields.visibilityEnumId = visibilityEnumId
            // a narrower group narrows what is in it: nothing below it stays wider than it is
            const wider = row => core.visibilityRank(row.visibilityEnumId) < rank
            for (const row of groupsBelow(p.siteId, group.groupPath)
                .concat(repositoriesBelow(p.siteId, group.groupPath))
                .filter(wider)) {
                update(row, {visibilityEnumId, revision: revisionOf(row) + 1})
                narrowedCount++
            }
        }
        if (given(p.issueRepositoryPath)) {
            const path = text(p.issueRepositoryPath).toLowerCase()
            const tracker = path ? one(M + "SmithyRepository", {siteId: p.siteId, repositoryPath: path}) : null
            if (path && (!tracker || !path.startsWith(group.groupPath + "/")))
                invalid("issueRepositoryPath names no repository of this group")
            fields.issueRepositoryId = tracker?.repositoryId || null
        }
        update(group, {...fields, revision: before + 1})
        if (fields.visibilityEnumId)
            audit(
                p.siteId,
                null,
                "group",
                group.groupId,
                "setVisibility",
                VISIBILITY_CODES[fields.visibilityEnumId],
                before,
                before + 1
            )
        return {revision: before + 1, narrowedCount}
    }
    methods.renameGroup = p => {
        const {r, group, partyId, access} = groupFor(p, "SmrOwner", true)
        const before = revisionOf(group)
        fresh(before, p.expectedRevision)
        const pathSegment = text(p.pathSegment)
        if (!core.validGroupSegment(pathSegment))
            invalid("nameInvalid[pathSegment]: A group's path is 2 to 39 lower case letters, digits, underscores or hyphens")
        const parent = r.chain[1] || null
        const oldPath = group.groupPath
        const newPath = parent ? parent.groupPath + "/" + pathSegment : pathSegment
        // an old path of this group is its own to take back, and an operator's page role is an Owner's everywhere
        const own = {all: access.operator, groupId: group.groupId}
        const free =
            pathSegment !== group.pathSegment &&
            (parent
                ? core.siblingFree(p.siteId, parent.groupId, null, pathSegment) && !core.pathHeld(p.siteId, newPath, partyId, own)
                : core.nameFree(p.siteId, pathSegment, partyId, "group", own))
        if (!free) invalid("nameTaken[pathSegment]: That name is taken")
        // a refused request's row holds its path in the unique index: the path is free, so the row goes
        const refused = one(M + "SmithyGroup", {siteId: p.siteId, groupPath: newPath}, true)
        if (refused) {
            find(M + "SmithyGroupParty", {groupId: refused.groupId}).deleteAll()
            refused.delete()
        }
        const moved = path => newPath + text(path).slice(oldPath.length)
        for (const sub of groupsBelow(p.siteId, oldPath)) update(sub, {groupPath: moved(sub.groupPath)})
        update(group, {pathSegment, groupPath: newPath, revision: before + 1})
        // each repository below through the one writer of a path, which keeps its old path for git
        for (const repo of repositoriesBelow(p.siteId, oldPath)) core.setPath(repo, {repositoryPath: moved(repo.repositoryPath)})
        core.keepRedirect(p.siteId, oldPath, newPath, {groupId: group.groupId})
        audit(p.siteId, null, "group", group.groupId, "renameGroup", oldPath + " to " + newPath, before, before + 1)
        return {groupPath: newPath, revision: before + 1}
    }
    methods.deleteGroup = p => {
        const {group} = groupFor(p, "SmrOwner")
        const before = revisionOf(group)
        fresh(before, p.expectedRevision)
        if (text(p.confirmPath).toLowerCase() !== group.groupPath) invalid("confirmPath must be the group's path")
        if (
            find(M + "SmithyRepository", {groupId: group.groupId}).count() > 0 ||
            find(M + "SmithyGroup", {parentGroupId: group.groupId}).count() > 0
        )
            fail("Conflict", "A group that has a repository or a subgroup is not deleted")
        audit(p.siteId, null, "group", group.groupId, "deleteGroup", group.groupPath, before, null)
        find(M + "SmithyGroupParty", {groupId: group.groupId}).deleteAll()
        find(M + "SmithyPathRedirect", {siteId: p.siteId, groupId: group.groupId}).deleteAll()
        const settings = one(M + "SmithySite", {siteId: p.siteId}, true)
        if (settings?.homeGroupId === group.groupId) update(settings, {homeGroupId: null, revision: revisionOf(settings) + 1})
        group.delete()
        return {deleted: true}
    }

    // ===== members and roles =====
    /* The Owner rows on a chain of groups that are in effect and have no end date, without one party's row on one
       group: a role with an end is not one a group can be left to. */
    function otherOwners(chain, groupId, partyId) {
        let count = 0
        for (const g of chain)
            for (const row of find(M + "SmithyGroupParty", {groupId: g.groupId, roleEnumId: "SmrOwner"})
                .limit(1000)
                .list())
                if (active(row) && !row.thruDate && !(g.groupId === groupId && row.partyId === partyId)) count++
        return count
    }
    /* Set, change or (an empty role) remove a party's role row on a group or a repository. keep: refuses a change that
       may not be made, given the row and what it becomes. */
    function setMember(entity, key, fromPath, p, actorPartyId, keep) {
        const profile = one(S + "PublicSiteProfile", {siteId: p.siteId, handle: text(p.handle).toLowerCase()})
        if (!profile) invalid("handle names no account of this site")
        const roleEnumId = p.role
            ? core.idOfCode(ROLE_CODES, p.role) || invalid("role must be guest, reporter, developer, maintainer or owner")
            : null
        const thruDate = given(p.thruDate) ? timestamp(p.thruDate, "thruDate") : undefined
        const row = one(entity, {...key, partyId: profile.partyId}, true)
        const before = row ? revisionOf(row) : null
        if (row) fresh(before, p.expectedRevision)
        const gone = {partyId: profile.partyId, roleEnumId: null, fromDate: null, thruDate: null, revision: null}
        if (!row && !roleEnumId) return {member: memberView(profile, gone, fromPath)}
        if (row) keep(row, roleEnumId, thruDate)
        const targetType = key.groupId ? "group" : "repository"
        audit(
            p.siteId,
            null,
            targetType,
            key.groupId || key.repositoryId,
            "setMember",
            profile.handle + " " + (p.role || "removed"),
            before,
            row && roleEnumId ? before + 1 : roleEnumId ? 1 : null
        )
        if (!roleEnumId) {
            row.delete()
            return {member: memberView(profile, gone, fromPath)}
        }
        const saved = row
            ? update(row, {
                  roleEnumId,
                  // a role set again on a row that had ended starts again
                  fromDate: active(row) ? row.fromDate : now(),
                  thruDate: thruDate === undefined ? (active(row) ? row.thruDate : null) : thruDate,
                  addedByPartyId: actorPartyId,
                  revision: before + 1
              })
            : create(entity, {
                  ...key,
                  partyId: profile.partyId,
                  siteId: p.siteId,
                  roleEnumId,
                  fromDate: now(),
                  thruDate: thruDate || null,
                  addedByPartyId: actorPartyId,
                  revision: 1
              })
        return {member: memberView(profile, saved, fromPath)}
    }
    methods.setGroupMember = p => {
        const {r, group, partyId} = groupFor(p, "SmrOwner")
        return setMember(
            M + "SmithyGroupParty",
            {groupId: group.groupId},
            group.groupPath,
            p,
            partyId,
            (row, roleEnumId, thruDate) => {
                // the last Owner stays: a group, with the groups above it, keeps an Owner whose role has no end
                const leaves = roleEnumId !== "SmrOwner" || !!thruDate
                if (
                    active(row) &&
                    row.roleEnumId === "SmrOwner" &&
                    leaves &&
                    otherOwners(r.chain, group.groupId, row.partyId) === 0
                )
                    fail("Conflict", "A group keeps an Owner: give the role to another account first")
            }
        )
    }
    methods.leaveGroup = p => {
        const r = core.group(p.groupId, p.siteId)
        const partyId = requireUser()
        // the group's row is locked, as a change of its members locks it, so two Owners do not leave at once
        one(M + "SmithyGroup", {groupId: r.group.groupId}, true)
        const row = one(M + "SmithyGroupParty", {groupId: r.group.groupId, partyId}, true)
        if (!row) return {left: false}
        if (active(row) && row.roleEnumId === "SmrOwner" && otherOwners(r.chain, r.group.groupId, partyId) === 0)
            fail("Conflict", "A group keeps an Owner: give the role to another account first")
        audit(p.siteId, null, "group", r.group.groupId, "leaveGroup", ROLE_CODES[row.roleEnumId] || "", revisionOf(row), null)
        row.delete()
        return {left: true}
    }
    methods.findRepositoryMembers = p => {
        const r = core.repository(p.repositoryId, p.siteId)
        requireUser()
        core.requireRole(r, "SmrMaintainer")
        const pg = page(p, "smithy-repository-members:" + p.repositoryId)
        const current = entityFind => Array.from(entityFind.conditionDate("fromDate", "thruDate", null).limit(2000).list())
        // the repository's own rows, each as it is; then, of the rows its groups give, a party's highest
        const entries = current(find(M + "SmithyRepositoryParty", {repositoryId: p.repositoryId})).map(row => ({
            row,
            fromPath: r.repo.repositoryPath
        }))
        const inherited = new Map()
        for (const g of r.chain)
            for (const row of current(find(M + "SmithyGroupParty", {groupId: g.groupId})))
                if ((RANK[row.roleEnumId] || 0) > (RANK[inherited.get(row.partyId)?.row.roleEnumId] || 0))
                    inherited.set(row.partyId, {row, fromPath: g.groupPath})
        entries.push(...inherited.values())
        // a personal repository's Owner is its namespace's account, by no row
        if (r.repo.ownerPartyId)
            entries.push({
                row: {
                    partyId: r.repo.ownerPartyId,
                    roleEnumId: "SmrOwner",
                    fromDate: r.repo.createdAt,
                    thruDate: null,
                    revision: null
                },
                fromPath: handleOf(p.siteId, r.repo.ownerPartyId)
            })
        // by role, then by where the role is and whose it is; the page's profiles are then read in one query
        entries.sort(
            (x, y) =>
                (RANK[y.row.roleEnumId] || 0) - (RANK[x.row.roleEnumId] || 0) ||
                text(x.fromPath).localeCompare(text(y.fromPath)) ||
                text(x.row.partyId).localeCompare(text(y.row.partyId))
        )
        const shown = entries.slice(pg.offset, pg.offset + pg.limit)
        const profiles = new Map(
            shown.length
                ? Array.from(
                      find(S + "PublicSiteProfile", {siteId: p.siteId})
                          .condition("partyId", "in", [...new Set(shown.map(entry => entry.row.partyId))])
                          .list()
                  ).map(profile => [profile.partyId, profile])
                : []
        )
        return {
            memberList: shown.map(entry => memberView(profiles.get(entry.row.partyId), entry.row, entry.fromPath)),
            nextCursor: entries.length > pg.offset + pg.limit ? pg.next(pg.offset + pg.limit) : null
        }
    }
    methods.setRepositoryMember = p => {
        const {repo, partyId} = repositoryFor(p, "SmrOwner")
        // a repository's Owners are its groups' or its namespace's account, so no row here is the last one
        return setMember(
            M + "SmithyRepositoryParty",
            {repositoryId: repo.repositoryId},
            repo.repositoryPath,
            p,
            partyId,
            () => {}
        )
    }

    // ===== repositories =====
    methods.createRepository = p => {
        core.site(p.siteId)
        const parent = p.groupId ? core.group(p.groupId, p.siteId) : null
        const {partyId, access} = writer(p.siteId)
        if (parent) core.requireRole(parent, "SmrMaintainer")
        lockNames(p.siteId)
        return receipt(p, "smithy.createRepository", () => {
            const s = core.settings(p.siteId)
            if (!parent) {
                // a personal repository: by the site's policy, within the account's count
                if (!policyAllows(s.repositoryCreateEnumId, access, false))
                    invalid("policyRefused: Only the site's operators make a personal repository here")
                if (
                    find(M + "SmithyRepository", {siteId: p.siteId, ownerPartyId: partyId}).count() >=
                    accountLimits(p.siteId, partyId, s).repositories
                )
                    invalid("quotaExceeded: You have as many personal repositories as this site allows")
            }
            checkText(p.siteId, partyId, [p.name, p.description])
            // a new repository of the site's kind, never one that is there
            const made = makeRepository({
                ...p,
                partyId,
                access,
                parent,
                repositoryKind: s.repositoryKind,
                branch: "main",
                bindRepositoryId: null
            })
            if (flag(p.withReadme)) {
                // the first commit, by the account
                const title = text(p.name).trim() || made.repositoryPath.slice(made.repositoryPath.lastIndexOf("/") + 1)
                const readme = "# " + title + "\n" + (text(p.description) ? "\n" + text(p.description) + "\n" : "")
                const committed = hosted("commit#GitFiles", {
                    repositoryId: made.repositoryId,
                    message: "Start with a README",
                    fileMap: {"README.md": readme}
                })
                if (!committed?.commitId) fail("Unprocessable", "The README could not be committed")
            }
            audit(p.siteId, null, "repository", made.repositoryId, "createRepository", made.repositoryPath, null, 1)
            return made
        })
    }
    const FEATURES = ["issuesEnabled", "mergeRequestsEnabled", "pipelinesEnabled", "forumEnabled", "docsEnabled"]
    methods.updateRepository = p => {
        const {r, repo, partyId} = repositoryFor(p, "SmrMaintainer")
        const before = revisionOf(repo)
        fresh(before, p.expectedRevision)
        if (r.git.archivedDate) archived()
        const fields = {}
        const hostedFields = {}
        if (given(p.name)) {
            fields.name = text(p.name).trim()
            if (!fields.name || fields.name.length > 255) invalid("name is 1 to 255 characters")
        }
        if (given(p.description)) {
            if (text(p.description).length > 255) invalid("description is at most 255 characters")
            hostedFields.description = text(p.description)
        }
        if (given(p.name) || given(p.description)) checkText(p.siteId, partyId, [p.name, p.description])
        if (given(p.defaultBranch) && p.defaultBranch !== "") hostedFields.branch = text(p.defaultBranch)
        if (given(p.defaultMergeMethod) && p.defaultMergeMethod !== "") {
            if (!["merge", "squash"].includes(p.defaultMergeMethod)) invalid("defaultMergeMethod must be merge or squash")
            hostedFields.defaultMergeMethodEnumId = core.idOfCode(MERGE_METHODS, p.defaultMergeMethod)
        }
        for (const name of FEATURES) if (given(p[name]) && p[name] !== "") fields[name] = flag(p[name]) ? "Y" : "N"
        if (given(p.docsPath)) {
            const segments = text(p.docsPath)
                .split("/")
                .filter(segment => segment !== "")
            if (segments.some(segment => segment === "." || segment === "..") || segments.join("/").length > 255)
                invalid("docsPath is a directory of the repository")
            fields.docsPath = segments.join("/") || null
        }
        if (given(p.pinnedSequence)) {
            // pinned on its group's Overview, so its group's Owner's to say
            const owner = r.chain[0] ? core.groupRights(r.chain[0], core.actor()).rank >= RANK.SmrOwner : r.rank >= RANK.SmrOwner
            if (!owner) denied("This needs the owner role on the group")
            fields.pinnedSequence = wholeNumber(p.pinnedSequence, "pinnedSequence")
        }
        if (Object.keys(hostedFields).length) hosted("update#GitRepository", {repositoryId: repo.repositoryId, ...hostedFields})
        audit(
            p.siteId,
            null,
            "repository",
            repo.repositoryId,
            "updateRepository",
            Object.keys(fields).concat(Object.keys(hostedFields)).join(" "),
            before,
            before + 1
        )
        update(repo, {...fields, revision: before + 1})
        return {revision: before + 1}
    }
    methods.setRepositoryVisibility = p => {
        const {r, repo} = repositoryFor(p, "SmrOwner")
        const before = revisionOf(repo)
        fresh(before, p.expectedRevision)
        const visibilityEnumId = visibilityId(p.visibility, null) || invalid("visibility must be public, members or private")
        const rank = core.visibilityRank(visibilityEnumId)
        const ceiling = Math.max(1, ...r.chain.map(g => core.visibilityRank(g.visibilityEnumId)))
        if (rank < ceiling) invalid("policyRefused[visibility]: A repository is no wider than its group")
        update(repo, {visibilityEnumId, revision: before + 1})
        audit(
            p.siteId,
            null,
            "repository",
            repo.repositoryId,
            "setVisibility",
            VISIBILITY_CODES[visibilityEnumId],
            before,
            before + 1
        )
        return {
            visibility: VISIBILITY_CODES[visibilityEnumId],
            effectiveVisibility: VISIBILITY_CODES[VISIBILITY_IDS[rank]],
            revision: before + 1
        }
    }
    methods.renameRepository = p => {
        const {repo, partyId, access} = repositoryFor(p, "SmrOwner", true)
        const before = revisionOf(repo)
        fresh(before, p.expectedRevision)
        const slug = text(p.slug).toLowerCase()
        if (!core.validSlug(slug))
            invalid("nameInvalid[slug]: A repository's name is letters, digits, '.', '_' and '-', and does not end in .git")
        const oldPath = repo.repositoryPath
        const newPath = oldPath.slice(0, oldPath.lastIndexOf("/") + 1) + slug
        if (
            slug === repo.slug ||
            !pathFree(
                p.siteId,
                repo.groupId || null,
                repo.ownerPartyId || null,
                slug,
                newPath,
                partyId,
                access,
                repo.repositoryId
            )
        )
            invalid("nameTaken[slug]: That name is taken")
        core.setPath(repo, {slug, repositoryPath: newPath, revision: before + 1})
        audit(p.siteId, null, "repository", repo.repositoryId, "renameRepository", oldPath + " to " + newPath, before, before + 1)
        return {repositoryPath: newPath, revision: before + 1}
    }
    methods.transferRepository = p => {
        const {r, repo, partyId, access} = repositoryFor(p, "SmrOwner", true)
        const before = revisionOf(repo)
        fresh(before, p.expectedRevision)
        const s = core.settings(p.siteId)
        let target = null
        let namespace
        let limits
        let visibilityEnumId = repo.visibilityEnumId
        if (p.targetGroupId) {
            target = core.group(p.targetGroupId, p.siteId)
            core.requireRole(target, "SmrMaintainer")
            if (target.group.statusId !== "SmgActive") invalid("policyRefused[targetGroupId]: The group is not active")
            if (repo.groupId === target.group.groupId) invalid("The repository is in that group")
            namespace = target.group.groupPath
            limits = kit.quota.groupLimits(target.chain, s)
            // no wider than its new group
            if (core.visibilityRank(visibilityEnumId) < target.visibility) visibilityEnumId = VISIBILITY_IDS[target.visibility]
        } else {
            if (repo.ownerPartyId === partyId) invalid("The repository is in your namespace")
            namespace = handleOf(p.siteId, partyId)
            if (!namespace) invalid("policyRefused[targetGroupId]: Choose a handle before taking a repository")
            if (!policyAllows(s.repositoryCreateEnumId, access, false))
                invalid("policyRefused: Only the site's operators have a personal repository here")
            limits = accountLimits(p.siteId, partyId, s)
            if (find(M + "SmithyRepository", {siteId: p.siteId, ownerPartyId: partyId}).count() >= limits.repositories)
                invalid("quotaExceeded: You have as many personal repositories as this site allows")
        }
        if (target && groupFull(p.siteId, target.chain))
            invalid("quotaExceeded: The group has as many repositories as a group may have")
        // what it stores is held to the limit of where it goes; a size that cannot be read moves nothing
        const used = usageOf([repo.repositoryId])
        if (!used) fail("Conflict", "The repository's size cannot be read now, so it is not moved; try again later")
        if (Number(used.get(repo.repositoryId).storedBytes || 0) > limits.repositoryBytes)
            invalid("quotaExceeded: The repository is larger than a repository may be there")
        // its issues are tasks of a project: while that is its old group's shared one they cannot follow it (§8.1)
        const from = r.chain[0] || null
        if (repo.workEffortId && from?.workEffortId === repo.workEffortId)
            fail("Conflict", "Its issues are in the group's shared project; give the repository its own project first")
        const oldPath = repo.repositoryPath
        const newPath = namespace + "/" + repo.slug
        const groupId = target?.group.groupId || null
        if (!pathFree(p.siteId, groupId, target ? null : partyId, repo.slug, newPath, partyId, access, repo.repositoryId))
            invalid("nameTaken[slug]: That name is taken there")
        core.setPath(repo, {
            groupId,
            ownerPartyId: target ? null : partyId,
            repositoryPath: newPath,
            visibilityEnumId,
            pinnedSequence: null,
            revision: before + 1
        })
        // the group it left no longer has it as its tracker
        const left = from ? one(M + "SmithyGroup", {groupId: from.groupId}, true) : null
        if (left?.issueRepositoryId === repo.repositoryId) update(left, {issueRepositoryId: null, revision: revisionOf(left) + 1})
        audit(
            p.siteId,
            null,
            "repository",
            repo.repositoryId,
            "transferRepository",
            oldPath + " to " + newPath,
            before,
            before + 1
        )
        return {repositoryPath: newPath, visibility: VISIBILITY_CODES[visibilityEnumId], revision: before + 1}
    }
    methods.setRepositoryArchived = p => {
        const {r, repo} = repositoryFor(p, "SmrOwner")
        const before = revisionOf(repo)
        fresh(before, p.expectedRevision)
        if (!given(p.archived) || p.archived === "") invalid("archived is required")
        const archive = flag(p.archived)
        let closedMergeRequestCount = 0
        if (archive && !r.git.archivedDate) {
            const out = hosted("archive#GitRepository", {repositoryId: repo.repositoryId})
            closedMergeRequestCount = Number(out.closedMergeRequestCount || 0)
        }
        if (!archive && r.git.archivedDate) hosted("unarchive#GitRepository", {repositoryId: repo.repositoryId})
        update(repo, {revision: before + 1})
        audit(
            p.siteId,
            null,
            "repository",
            repo.repositoryId,
            archive ? "archiveRepository" : "unarchiveRepository",
            "",
            before,
            before + 1
        )
        return {archived: archive, closedMergeRequestCount, revision: before + 1}
    }
    methods.deleteRepository = p => {
        const {repo} = repositoryFor(p, "SmrOwner")
        const before = revisionOf(repo)
        fresh(before, p.expectedRevision)
        if (text(p.confirmPath).toLowerCase() !== repo.repositoryPath) invalid("confirmPath must be the repository's path")
        // forks (DG4) and release assets (DG7) will refuse here; neither is there yet
        audit(p.siteId, null, "repository", repo.repositoryId, "deleteRepository", repo.repositoryPath, before, null)
        find(M + "SmithyRepositoryParty", {repositoryId: repo.repositoryId}).deleteAll()
        for (const group of find(M + "SmithyGroup", {siteId: p.siteId, issueRepositoryId: repo.repositoryId}).list())
            update(group, {issueRepositoryId: null, revision: revisionOf(group) + 1})
        const repositoryId = repo.repositoryId
        repo.delete()
        // Mantle's links of its commits, refs and merge requests to tasks go with it; the tasks stay in their project
        const W = "mantle.work.effort."
        const requestIds = Array.from(
            find("moqui.resource.GitMergeRequest", {repositoryId}).selectField("mergeRequestId").list()
        ).map(row => row.mergeRequestId)
        if (requestIds.length)
            for (const entity of [W + "WorkEffortGitMergeRequest", "mantle.party.communication.CommunicationEventGitAnchor"])
                find(entity).condition("mergeRequestId", "in", requestIds).deleteAll()
        for (const entity of ["WorkEffortGitRef", "WorkEffortGitCommit", "WorkEffortGitRepository"])
            find(W + entity, {repositoryId}).deleteAll()
        // the hosted repository last: what it refuses rolls the rows back
        hosted("delete#GitRepository", {repositoryId})
        return {deleted: true}
    }

    // ===== quotas and usage =====
    /* Whose quota an input names: a group (its Owner's, or the site's owners'), an account by its handle (its own, or
       the site's owners'), or with neither the caller's. */
    function quotaOwner(p, forWrite) {
        if (p.groupId && p.handle) invalid("groupId and handle are not given together")
        const access = core.siteAccess(p.siteId, core.actor())
        if (p.groupId) {
            const r = core.group(p.groupId, p.siteId)
            if (forWrite ? !access.owner : !access.owner && r.rank < RANK.SmrOwner) denied("This needs the owner role")
            return {r, access}
        }
        const partyId = requireUser()
        const profile = p.handle ? one(S + "PublicSiteProfile", {siteId: p.siteId, handle: text(p.handle).toLowerCase()}) : null
        if (p.handle && !profile) invalid("handle names no account of this site")
        if (forWrite && !profile) invalid("groupId or handle is required")
        if ((profile ? profile.partyId !== partyId : false) && !access.owner)
            denied("Only the site's owners read another account's quota")
        return {
            partyId: profile ? profile.partyId : partyId,
            handle: profile ? profile.handle : handleOf(p.siteId, partyId),
            access
        }
    }
    methods.getQuotaUsage = p => {
        core.site(p.siteId)
        requireUser()
        const owner = quotaOwner(p, false)
        const s = core.settings(p.siteId)
        let limits
        let repositories
        let about
        let revision
        if (owner.r) {
            const group = owner.r.group
            limits = kit.quota.groupLimits(owner.r.chain, s)
            repositories = repositoriesBelow(p.siteId, group.groupPath)
            about = {kind: "group", groupId: group.groupId, groupPath: group.groupPath}
            revision = revisionOf(group)
        } else {
            limits = accountLimits(p.siteId, owner.partyId, s)
            repositories = personalRepositories(p.siteId, owner.partyId)
            about = {kind: "account", handle: owner.handle}
            revision = Number(limits.account?.revision || 0)
        }
        // usage is the framework's to count; when it cannot, the counts of bytes are not known
        const used = usageOf(repositories.map(row => row.repositoryId))
        const bytes = (row, field) => Number(used.get(row.repositoryId)?.[field] || 0)
        const account = limits.account || null
        const ownRow = owner.r ? owner.r.group : account
        const own = field => (ownRow?.[field] == null ? null : Number(ownRow[field]))
        return {
            owner: about,
            limits: {
                repositories: limits.repositories,
                repositoryBytes: limits.repositoryBytes,
                lfsBytes: limits.lfsBytes,
                runnerMinutes: limits.runnerMinutes
            },
            // what the row itself sets, empty where it leaves the default (setQuota with an empty value clears one)
            ownLimits: {
                repositories: owner.r ? null : own("maxRepositories"),
                repositoryBytes: own("maxRepositoryBytes"),
                lfsBytes: own("maxLfsBytes"),
                runnerMinutes: own("runnerMinutesMonthly")
            },
            usage: {
                repositories: repositories.length,
                // a repository's limit is for one repository: the largest is what is near it
                repositoryBytes: used ? Math.max(0, ...repositories.map(row => bytes(row, "storedBytes"))) : null,
                lfsBytes: used ? repositories.reduce((sum, row) => sum + bytes(row, "lfsBytes"), 0) : null,
                // pipelines are DG5's
                runnerMinutes: 0
            },
            repositoryList: repositories.slice(0, 200).map(row => ({
                repositoryPath: row.repositoryPath,
                storedBytes: used ? bytes(row, "storedBytes") : null,
                lfsBytes: used ? bytes(row, "lfsBytes") : null
            })),
            bot: account?.bot === "Y",
            botOperatorHandle: handleOf(p.siteId, account?.botOperatorPartyId),
            revision
        }
    }
    const QUOTA_FIELDS = ["maxRepositoryBytes", "maxLfsBytes", "runnerMinutesMonthly"]
    methods.setQuota = p => {
        const {partyId: actorPartyId} = siteOwner(p.siteId, true)
        const owner = quotaOwner(p, true)
        const fields = {}
        for (const name of QUOTA_FIELDS) if (given(p[name])) fields[name] = wholeNumber(p[name], name)
        if (owner.r) {
            if (given(p.maxRepositories) || given(p.bot) || given(p.botOperatorHandle))
                invalid("maxRepositories and the bot mark are an account's, not a group's")
            const group = one(M + "SmithyGroup", {groupId: owner.r.group.groupId}, true)
            const before = revisionOf(group)
            fresh(before, p.expectedRevision)
            update(group, {...fields, revision: before + 1})
            audit(p.siteId, null, "group", group.groupId, "setQuota", text(p.reason), before, before + 1)
            return {revision: before + 1}
        }
        if (given(p.maxRepositories)) fields.maxRepositories = wholeNumber(p.maxRepositories, "maxRepositories")
        if (given(p.bot) && p.bot !== "") fields.bot = flag(p.bot) ? "Y" : "N"
        if (given(p.botOperatorHandle)) {
            const operator = p.botOperatorHandle
                ? one(S + "PublicSiteProfile", {siteId: p.siteId, handle: text(p.botOperatorHandle).toLowerCase()})
                : null
            if (p.botOperatorHandle && !operator) invalid("botOperatorHandle names no account of this site")
            fields.botOperatorPartyId = operator?.partyId || null
        }
        const account = one(M + "SmithyAccount", {siteId: p.siteId, partyId: owner.partyId}, true)
        const before = Number(account?.revision || 0)
        fresh(before, p.expectedRevision)
        Object.assign(fields, {setByPartyId: actorPartyId, reason: text(p.reason) || null, revision: before + 1})
        if (account) update(account, fields)
        else create(M + "SmithyAccount", {siteId: p.siteId, partyId: owner.partyId, ...fields})
        audit(p.siteId, null, "member", owner.partyId, "setQuota", text(p.reason), before, before + 1)
        return {revision: before + 1}
    }
}
