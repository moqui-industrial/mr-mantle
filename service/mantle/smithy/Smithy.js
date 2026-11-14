/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * Smithy's operations (mr-pass plan/design-smithy.md §15), each a method that SmithyServices.xml's wrapper runs through
 * execute(). Here: the public reads (§15.2) of groups, repositories and code, the projections, and what makes a group
 * and a repository. SmithyManage.js adds the settings, groups, repositories, members and quotas of §15.3, and
 * SmithyGit.js its refs, branch rules, webhooks, git access and the push gate. A read of code is the framework's
 * hosting service (org.moqui.git.GitServices) after Smithy's own check; what the caller may not view is Not Found.
 * The rules are SmithyCore.js's. Entity access is privileged here; every projection passes the evaluator first.
 */
const core = ec.resource.script("component://mr-mantle/service/mantle/smithy/SmithyCore.js")
const {M, forum, VISIBILITY_CODES, VISIBILITY_IDS, RANK, ROLE_CODES, STATUS_CODES, git} = core
const {S, now, me, find, one, fail, missing, invalid, requireUser, page} = forum
const GIT_REPOSITORY = "moqui.resource.GitRepository"
const flag = value => value === true || value === "true" || value === "Y"
/* The framework's merge methods as an operation's words. */
const MERGE_METHODS = {GmmMerge: "merge", GmmSquash: "squash", GmmFastForward: "fastForward", GmmRebase: "rebase"}
const text = value => (value == null ? "" : String(value))
/* The limits of the code pages, the same for every caller (§7). */
const TREE_PAGE = 1000
const TEXT_LIMIT = 1048576
const RENDER_LIMIT = 524288
const DIFF_FILES = 100
const DIFF_LINES = 20000
const LOG_PAGE = 30
const SCAN_LIMIT = 2000
const SCAN_BATCH = 200
const notAvailable = what => invalid("notAvailable: " + what + " is not available here")
const notBuilt = what => invalid("notBuilt: " + what + " is not built yet")
const cf = () => ec.entity.conditionFactory
const any = conditions => cf().makeCondition(conditions, "or")
const equals = (field, value) => cf().makeCondition(field, "equals", value)

// ===== what a list's query can decide =====
/* What a party holds in a site, for a list's query: its active rows' groups (with their paths, which the subgroups and
   repositories below start with) and repositories, and the repositories of its projects. An operator's lists are not
   narrowed. The evaluator still decides each row. */
function scopeOf(siteId, a) {
    const access = core.siteAccess(siteId, a)
    const scope = {access, all: access.operator, partyId: null, groupIds: [], groupPaths: [], repositoryIds: []}
    if (scope.all || !a.partyId || access.suspended) return scope
    scope.partyId = a.partyId
    const current = entity =>
        Array.from(
            find(entity, {siteId, partyId: a.partyId}).conditionDate("fromDate", "thruDate", null).limit(SCAN_LIMIT).list()
        )
    scope.groupIds = current(M + "SmithyGroupParty").map(row => row.groupId)
    scope.groupPaths = scope.groupIds.map(groupId => one(M + "SmithyGroup", {groupId})?.groupPath).filter(path => !!path)
    scope.repositoryIds = current(M + "SmithyRepositoryParty").map(row => row.repositoryId)
    const projectIds = Array.from(
        find("mantle.work.effort.WorkEffortParty", {partyId: a.partyId})
            .conditionDate("fromDate", "thruDate", null)
            .limit(SCAN_LIMIT)
            .list()
    ).map(row => row.workEffortId)
    if (projectIds.length)
        for (const link of find("mantle.work.effort.WorkEffortGitRepository")
            .condition("workEffortId", "in", projectIds)
            .conditionDate("fromDate", "thruDate", null)
            .limit(SCAN_LIMIT)
            .list())
            scope.repositoryIds.push(link.repositoryId)
    return scope
}
/* A find narrowed to what a scope may view by the row's own fields: a public row, a members-only one for a member, and
   the rows the party holds something on; with no party only what is not hidden. */
function narrowed(query, scope, kind) {
    if (scope.all) return query
    const open = [equals("visibilityEnumId", "SmvPublic")]
    if (scope.access.joined) open.push(equals("visibilityEnumId", "SmvMembers"))
    const pathField = kind === "group" ? "groupPath" : "repositoryPath"
    // '_' in a path is a wildcard of like, so this takes a little more than the evaluator keeps
    for (const path of scope.groupPaths) open.push(cf().makeCondition(pathField, "like", path + "/%"))
    if (kind === "group") {
        if (scope.groupIds.length) open.push(cf().makeCondition("groupId", "in", scope.groupIds))
        if (scope.partyId) open.push(equals("requestedByPartyId", scope.partyId))
    } else {
        if (scope.groupIds.length) open.push(cf().makeCondition("groupId", "in", scope.groupIds))
        if (scope.repositoryIds.length) open.push(cf().makeCondition("repositoryId", "in", scope.repositoryIds))
        if (scope.partyId) open.push(equals("ownerPartyId", scope.partyId))
    }
    let out = query.condition(any(open))
    if (!scope.partyId) {
        out = out.condition("hiddenAt", null)
        if (kind === "group") out = out.condition("statusId", "SmgActive")
    }
    return out
}
/* A page of a list: the query's rows from the cursor's place in batches, each kept by the evaluator, until the page is
   full. The cursor's place is the row to go on from, so a later page does not read the earlier ones again. */
function scan(build, pg, keep) {
    const list = []
    let from = pg.offset
    for (;;) {
        const batch = Array.from(build().offset(from).limit(SCAN_BATCH).list())
        for (const [index, row] of batch.entries()) {
            const kept = keep(row)
            if (!kept) continue
            if (list.length === pg.limit) return {list, nextCursor: pg.next(from + index)}
            list.push(kept)
        }
        if (batch.length < SCAN_BATCH) return {list, nextCursor: null}
        from += SCAN_BATCH
    }
}
/* A typed search as a like pattern: its own '%' and '_' match one character there, and contains() decides. */
const likeOf = query => "%" + text(query).replace(/[%_\\]/g, "_") + "%"
const contains = (query, ...values) => values.some(value => text(value).toLowerCase().includes(text(query).toLowerCase()))

// ===== projections =====
const handleOf = (siteId, partyId) => (partyId ? one(S + "PublicSiteProfile", {siteId, partyId})?.handle || null : null)
/* The children of a group the caller may view, narrowed in the query: the caller passes the group's own visibility
   already, so a child is decided by its own fields and by the role held on the group. */
function below(query, r, a, kind) {
    let out = query
    if (!r.access.operator) {
        if (r.rank < RANK.SmrGuest) out = narrowed(out, {...scopeOf(r.group.siteId, a), groupPaths: []}, kind)
        if (kind === "group") out = out.condition("statusId", "SmgActive")
    }
    if (!r.access.staff && r.rank < RANK.SmrOwner) out = out.condition("hiddenAt", null)
    return out
}
/* A group as a caller who may not view it knows it: what a path below it already tells. */
const groupNamed = g => ({groupId: g.groupId, groupPath: g.groupPath})
/* A group of a repository's or a group's chain: its view when the caller may view that group itself, else its path. */
function chainView(g, a) {
    const rights = core.groupRights(g, a)
    return rights.canView ? groupView(rights, a) : groupNamed(g)
}
function groupView(r, a) {
    const g = r.group
    return {
        groupId: g.groupId,
        groupPath: g.groupPath,
        pathSegment: g.pathSegment,
        name: g.name,
        description: g.description || "",
        avatarUrl: null,
        visibility: VISIBILITY_CODES[g.visibilityEnumId] || "private",
        parentGroupId: g.parentGroupId || null,
        status: STATUS_CODES[g.statusId] || null,
        hidden: r.hidden,
        // counts are of what the caller may view, as the queries decide it: a role on this group is held below it
        repositoryCount: below(find(M + "SmithyRepository", {siteId: g.siteId, groupId: g.groupId}), r, a, "repository").count(),
        subgroupCount: below(find(M + "SmithyGroup", {siteId: g.siteId, parentGroupId: g.groupId}), r, a, "group").count(),
        revision: Number(g.revision || 1)
    }
}
function repositoryView(r) {
    const repo = r.repo
    const hosted = r.git || one(GIT_REPOSITORY, {repositoryId: repo.repositoryId})
    return {
        repositoryId: repo.repositoryId,
        repositoryPath: repo.repositoryPath,
        slug: repo.slug,
        name: repo.name,
        description: hosted?.description || "",
        visibility: VISIBILITY_CODES[repo.visibilityEnumId] || "private",
        effectiveVisibility: VISIBILITY_CODES[VISIBILITY_IDS[r.visibility]],
        groupId: repo.groupId || null,
        ownerHandle: handleOf(repo.siteId, repo.ownerPartyId),
        defaultBranch: hosted?.branch || "main",
        defaultMergeMethod: MERGE_METHODS[hosted?.defaultMergeMethodEnumId] || "merge",
        archived: !!hosted?.archivedDate,
        mirror: hosted?.repositoryKind === "remote",
        hidden: r.hidden,
        // forks are DG4's
        forkOf: null,
        forkCount: 0,
        features: {
            issues: repo.issuesEnabled === "Y",
            mergeRequests: repo.mergeRequestsEnabled !== "N",
            pipelines: repo.pipelinesEnabled === "Y",
            forum: repo.forumEnabled === "Y",
            docs: repo.docsEnabled === "Y"
        },
        docsPath: repo.docsPath || "docs",
        pinnedSequence: repo.pinnedSequence == null ? null : Number(repo.pinnedSequence),
        component: repo.componentName ? {name: repo.componentName, version: repo.componentVersion || null} : null,
        lastPushAt: hosted?.lastUpdateDate || null,
        revision: Number(repo.revision || 1)
    }
}
/* What the caller may do in a repository (§5.3), so a page shows only the controls that would be accepted. */
function repositoryCapabilities(r) {
    const signedIn = !!me()
    const confirmed = signedIn && core.confirmedNow()
    const writable = confirmed && !r.git?.archivedDate
    const holds = role => writable && r.rank >= RANK[role]
    return {
        signedIn,
        confirmed,
        role: core.roleCode(r.rank),
        canFileIssue: writable && r.repo.issuesEnabled === "Y",
        canComment: writable,
        canFork: confirmed,
        canPropose: writable,
        canPush: holds("SmrDeveloper"),
        canReview: holds("SmrDeveloper"),
        canTriage: holds("SmrReporter"),
        canMerge: holds("SmrMaintainer"),
        canAdminister: confirmed && r.rank >= RANK.SmrMaintainer,
        canOwn: confirmed && r.rank >= RANK.SmrOwner,
        canModerate: confirmed && (r.rank >= RANK.SmrOwner || r.access.staff)
    }
}
/* A role row as a member: the account by its profile and never its party id. */
const memberView = (profile, row, fromPath) => ({
    handle: profile?.handle || null,
    displayName: profile?.displayName || "",
    avatarUrl: null,
    role: ROLE_CODES[row.roleEnumId] || null,
    fromPath: fromPath || null,
    fromDate: row.fromDate || null,
    thruDate: row.thruDate || null,
    revision: row.revision == null ? null : Number(row.revision)
})
const refView = ref => ({kind: ref.kind, name: ref.name, fullName: ref.fullName, commitId: ref.commitId})
/* Commits as the pages show them: the author's name and no address, with the combined check state. An address is not
   matched to an account, which would tell whose address it is. */
function commitViews(repositoryId, commits) {
    const list = Array.from(commits || [])
    const states = list.length
        ? git("get#GitCommitStatuses", {repositoryId, commitIdList: list.map(commit => commit.commitId)}).stateByCommit || {}
        : {}
    return list.map(commit => ({
        commitId: commit.commitId,
        summary: commit.summary || "",
        message: commit.message || "",
        authorName: commit.authorName || "",
        authorHandle: null,
        authorDate: commit.authorDate || null,
        committerName: commit.committerName || "",
        commitDate: commit.committerDate || null,
        parentIds: Array.from(commit.parentIds || []),
        checkState: states[commit.commitId] || null,
        // issues are DG3's
        issueNumbers: []
    }))
}
const lastCommitView = commit =>
    commit?.commitId
        ? {
              commitId: commit.commitId,
              summary: commit.summary || "",
              authorName: commit.authorName || "",
              date: commit.committerDate || commit.authorDate || null
          }
        : null
const fileViews = files =>
    Array.from(files || []).map(file => ({
        path: file.path,
        oldPath: file.oldPath || null,
        status: file.changeType,
        insertions: Number(file.insertions || 0),
        deletions: Number(file.deletions || 0),
        binary: !!file.binary
    }))
/* The diffs a page shows: at most DIFF_FILES files and DIFF_LINES changed lines, the rest left to the file list. */
function boundedDiffs(files) {
    const shown = []
    let lines = 0
    let truncated = false
    for (const file of Array.from(files || [])) {
        const changed = Number(file.insertions || 0) + Number(file.deletions || 0)
        if (shown.length >= DIFF_FILES || lines + changed > DIFF_LINES) {
            truncated = true
            continue
        }
        if (file.html == null && file.unifiedDiff == null) continue
        lines += changed
        shown.push({
            path: file.path,
            status: file.changeType,
            unifiedDiff: file.unifiedDiff ?? null,
            html: file.html ?? null,
            hunks: file.hunks ?? null
        })
    }
    return {shown, truncated}
}
/* The framework's entry types that are no file. */
const NOT_FILES = ["dir", "submodule"]
const LANGUAGES = {
    js: "javascript",
    mjs: "javascript",
    ts: "typescript",
    rs: "rust",
    java: "java",
    groovy: "groovy",
    xml: "xml",
    xsd: "xml",
    html: "html",
    css: "css",
    json: "json",
    md: "markdown",
    markdown: "markdown",
    py: "python",
    sh: "shell",
    sql: "sql",
    toml: "toml",
    yaml: "yaml",
    yml: "yaml",
    ftl: "freemarker",
    vue: "vue",
    qvue: "vue"
}
const extension = path => (/\.([A-Za-z0-9]+)$/.exec(path) || [])[1]?.toLowerCase() || ""
const isMarkdown = path => ["md", "markdown"].includes(extension(path))
const markdown = source => StringUtilities.cleanHtml(ec.resource.markdownHtml(source))
/* A raw file's type: an image a page may show as one, else plain text or bytes, never something a browser runs. */
const RAW_IMAGES = {png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp"}
/* The entry of a path in its directory at a commit (its size, blob id and whether LFS keeps it), or null. */
function treeEntry(repositoryId, commitId, path) {
    const cut = path.lastIndexOf("/")
    const parent = git("get#GitTree", {repositoryId, revision: commitId, path: cut < 0 ? "" : path.slice(0, cut)})
    return Array.from(parent.entryList || []).find(entry => entry.path === path) || null
}
/* A file of a repository at a refPath, after the view check: {r, ref, entry, blob}; Not Found when it is no file. */
function fileAt(p) {
    const r = core.repository(p.repositoryId, p.siteId)
    const ref = core.splitRefPath(p.repositoryId, p.refPath)
    if (ref.empty || !ref.path) missing()
    const entry = treeEntry(p.repositoryId, ref.commitId, ref.path)
    if (!entry || NOT_FILES.includes(entry.type)) missing()
    return {r, ref, entry}
}

// ===== groups and discovery =====
const methods = {}
methods.resolveSmithyPath = p => core.resolvePath(p.siteId, p.path)
methods.getSmithyHome = p => {
    core.site(p.siteId)
    const homeGroupId = one(M + "SmithySite", {siteId: p.siteId})?.homeGroupId
    const home = homeGroupId ? one(M + "SmithyGroup", {groupId: homeGroupId}) : null
    const shown = home && home.siteId === p.siteId && core.groupRights(home, core.actor()).canView
    return {homeGroupId: shown ? home.groupId : null, groupPath: shown ? home.groupPath : null}
}
methods.findGroups = p => {
    core.site(p.siteId)
    const a = core.actor()
    const scope = scopeOf(p.siteId, a)
    const pg = page(p, ["smithy-groups", p.siteId, p.parentGroupId, p.query, flag(p.mine)].join(":"))
    if (p.parentGroupId) core.group(p.parentGroupId, p.siteId)
    const mine = flag(p.mine)
    if (mine) requireUser()
    if (mine && !scope.groupIds.length && !scope.all) return {groupList: [], nextCursor: null}
    const build = () => {
        let query = find(M + "SmithyGroup", {siteId: p.siteId})
        if (p.parentGroupId) query = query.condition("parentGroupId", p.parentGroupId)
        else if (!p.query && !mine) query = query.condition("parentGroupId", null)
        if (p.query)
            query = query.condition(
                any(["groupPath", "name"].map(field => cf().makeCondition(field, "like", likeOf(p.query)).ignoreCase()))
            )
        if (mine && !scope.all) query = query.condition("groupId", "in", scope.groupIds)
        return narrowed(query, scope, "group").orderBy("groupPath")
    }
    const found = scan(build, pg, row => {
        if (p.query && !contains(p.query, row.groupPath, row.name)) return null
        const r = core.groupRights(row, a)
        return r.canView ? r : null
    })
    return {groupList: found.list.map(r => groupView(r, a)), nextCursor: found.nextCursor}
}
methods.getGroup = p => {
    const r = core.group(p.groupId, p.siteId)
    const a = core.actor()
    const signedIn = !!me()
    const confirmed = signedIn && core.confirmedNow()
    return {
        group: groupView(r, a),
        // from the top-level group down to the parent; the name only of a group the caller may view itself
        ancestorList: r.chain
            .slice(1)
            .reverse()
            .map(g => ({...groupNamed(g), name: core.groupRights(g, a).canView ? g.name : null})),
        myRole: core.roleCode(r.rank),
        capabilities: {
            canCreateRepository: confirmed && r.rank >= RANK.SmrMaintainer,
            canCreateSubgroup: confirmed && r.rank >= RANK.SmrOwner && r.chain.length < core.MAX_GROUP_DEPTH,
            canOwn: confirmed && r.rank >= RANK.SmrOwner,
            canModerate: confirmed && (r.rank >= RANK.SmrOwner || r.access.staff),
            confirmed,
            signedIn
        }
    }
}
methods.findGroupMembers = p => {
    const r = core.group(p.groupId, p.siteId)
    const a = core.actor()
    const pg = page(p, "smithy-group-members:" + p.groupId)
    // a party's role is the highest of its rows on this group and the groups above; fromPath is where that row is
    const best = new Map()
    for (const g of r.chain)
        for (const row of find(M + "SmithyGroupParty", {groupId: g.groupId})
            .conditionDate("fromDate", "thruDate", null)
            .limit(SCAN_LIMIT)
            .list()) {
            const rank = RANK[row.roleEnumId] || 0
            if (rank > (best.get(row.partyId)?.rank || 0)) best.set(row.partyId, {row, rank, fromPath: g.groupPath})
        }
    // an Owner sees every member, another viewer the members whose profile is shown to them
    const owner = r.rank >= RANK.SmrOwner
    const shown = [...best.values()]
        .map(entry => ({...entry, profile: one(S + "PublicSiteProfile", {siteId: p.siteId, partyId: entry.row.partyId})}))
        .filter(entry => owner || core.profileShown(entry.profile, a))
        .sort((x, y) => y.rank - x.rank || text(x.profile?.handle).localeCompare(text(y.profile?.handle)))
    return {
        memberList: shown
            .slice(pg.offset, pg.offset + pg.limit)
            .map(({row, fromPath, profile}) => memberView(profile, row, fromPath)),
        nextCursor: shown.length > pg.offset + pg.limit ? pg.next(pg.offset + pg.limit) : null
    }
}
methods.findRepositories = p => {
    core.site(p.siteId)
    const a = core.actor()
    const scope = scopeOf(p.siteId, a)
    // sorted by path: a stored date of the last push to sort by comes with DG2, and pushed is by path until then
    if (p.sort && !["name", "pushed"].includes(p.sort)) invalid("sort must be name or pushed")
    const pg = page(
        p,
        [
            "smithy-repositories",
            p.siteId,
            p.groupId,
            flag(p.includeSubgroups),
            p.ownerHandle,
            p.query,
            flag(p.pinned),
            flag(p.mine),
            p.sort
        ].join(":")
    )
    const parent = p.groupId ? core.group(p.groupId, p.siteId) : null
    // stored paths are lower case; the prefix is checked again in the scan, since '_' is a wildcard of like
    const under = parent && flag(p.includeSubgroups) ? parent.group.groupPath + "/" : ""
    let ownerPartyId = null
    if (p.ownerHandle) {
        // a handle's namespace is there for the caller as its page is
        const profile = one(S + "PublicSiteProfile", {siteId: p.siteId, handle: text(p.ownerHandle).toLowerCase()})
        if (!core.accountShown(profile, a)) missing()
        ownerPartyId = profile.partyId
    }
    const mine = flag(p.mine)
    if (mine) requireUser()
    if (mine && !scope.all && !scope.partyId) return {repositoryList: [], nextCursor: null}
    const build = () => {
        let query = find(M + "SmithyRepository", {siteId: p.siteId})
        if (under) query = query.condition("repositoryPath", "like", under + "%")
        else if (parent) query = query.condition("groupId", p.groupId)
        if (ownerPartyId) query = query.condition("ownerPartyId", ownerPartyId)
        if (p.query)
            query = query.condition(
                any(["repositoryPath", "name"].map(field => cf().makeCondition(field, "like", likeOf(p.query)).ignoreCase()))
            )
        if (flag(p.pinned)) query = query.condition("pinnedSequence", "not-equals", null)
        if (mine && !scope.all) {
            // the caller's namespace, the repositories it has a row on, and those of the groups it has a row on
            const own = [equals("ownerPartyId", scope.partyId)]
            if (scope.repositoryIds.length) own.push(cf().makeCondition("repositoryId", "in", scope.repositoryIds))
            if (scope.groupIds.length) own.push(cf().makeCondition("groupId", "in", scope.groupIds))
            query = query.condition(any(own))
        }
        return narrowed(query, scope, "repository").orderBy(flag(p.pinned) ? "pinnedSequence,repositoryPath" : "repositoryPath")
    }
    const found = scan(build, pg, row => {
        if (!text(row.repositoryPath).startsWith(under)) return null
        if (p.query && !contains(p.query, row.repositoryPath, row.name)) return null
        const r = core.repositoryRights(row, a)
        return r.canView ? r : null
    })
    return {repositoryList: found.list.map(repositoryView), nextCursor: found.nextCursor}
}
methods.getRepository = p => {
    const r = core.repository(p.repositoryId, p.siteId)
    const a = core.actor()
    const urls = git("get#GitCloneUrls", {repositoryId: p.repositoryId})
    // the page's own address clones only where Smithy is the site's root app (§4.4, Git)
    const mount = ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
    const pageUrl =
        mount.mount(p.siteId, "smithy")?.base === ""
            ? mount.pageUrl(p.siteId, "smithy", "/" + r.repo.repositoryPath + ".git")
            : null
    const groupRow = r.chain[0]
    return {
        repository: repositoryView(r),
        // the group as the caller may view it: a role on the repository alone tells no more of it than its path
        group: groupRow ? chainView(groupRow, a) : null,
        cloneUrls: {page: pageUrl, https: urls.httpsUrl || null, ssh: urls.sshUrl || null},
        myRole: core.roleCode(r.rank),
        capabilities: repositoryCapabilities(r),
        counts: {
            // issues are DG3's
            openIssues: 0,
            openMergeRequests: find("moqui.resource.GitMergeRequest", {repositoryId: p.repositoryId})
                .condition("statusId", "in", ["GmrDraft", "GmrOpen"])
                .count()
        }
    }
}

// ===== code =====
methods.getTree = p => {
    core.repository(p.repositoryId, p.siteId)
    const ref = core.splitRefPath(p.repositoryId, p.refPath)
    const offset = p.offset == null || p.offset === "" ? 0 : Number(p.offset)
    if (!Number.isInteger(offset) || offset < 0) invalid("offset must be a whole number")
    const none = {ref: refView(ref), path: ref.path, isFile: false, entryList: [], hasMore: false, lastCommit: null, readme: null}
    if (ref.empty) return {...none, empty: true}
    const tree = git("get#GitTree", {repositoryId: p.repositoryId, revision: ref.commitId, path: ref.path})
    if (!tree.commitId) missing()
    const lastCommit = lastCommitView(
        Array.from(
            git("get#GitLog", {repositoryId: p.repositoryId, revision: ref.commitId, path: ref.path || null, limit: 1})
                .commitList || []
        )[0]
    )
    if (tree.isFile) return {...none, isFile: true, lastCommit, empty: false}
    const entries = Array.from(tree.entryList || [])
    const readmeEntry = entries.find(
        entry => !NOT_FILES.includes(entry.type) && /^readme\.(md|markdown)$/i.test(entry.name) && !entry.lfs
    )
    let readme = null
    if (readmeEntry && Number(readmeEntry.size || 0) <= RENDER_LIMIT) {
        const blob = git("get#GitBlob", {repositoryId: p.repositoryId, revision: ref.commitId, path: readmeEntry.path})
        if (blob.text != null) readme = {path: readmeEntry.path, html: markdown(blob.text)}
    }
    return {
        ...none,
        entryList: entries.slice(offset, offset + TREE_PAGE).map(entry => ({
            name: entry.name,
            path: entry.path,
            type: entry.type,
            size: entry.size ?? null,
            lfs: !!entry.lfs,
            lastCommit: lastCommitView(entry.lastCommit)
        })),
        hasMore: entries.length > offset + TREE_PAGE,
        lastCommit,
        readme,
        empty: false
    }
}
methods.getBlob = p => {
    const {ref, entry} = fileAt(p)
    const size = Number(entry.size || 0)
    const tooLarge = size > TEXT_LIMIT
    const lfs = !!entry.lfs
    const blob = lfs || tooLarge ? {} : git("get#GitBlob", {repositoryId: p.repositoryId, revision: ref.commitId, path: ref.path})
    const shown = blob.text != null ? blob.text : null
    return {
        ref: refView(ref),
        path: ref.path,
        size,
        binary: lfs ? true : tooLarge ? false : !!blob.binary,
        lfs,
        tooLarge,
        text: shown,
        html: shown != null && isMarkdown(ref.path) && !flag(p.plain) && size <= RENDER_LIMIT ? markdown(shown) : null,
        language: LANGUAGES[extension(ref.path)] || null,
        blobId: entry.objectId || null,
        lastCommit: lastCommitView(
            Array.from(
                git("get#GitLog", {repositoryId: p.repositoryId, revision: ref.commitId, path: ref.path, limit: 1}).commitList ||
                    []
            )[0]
        )
    }
}
/* Raw: the file's bytes, or its text, with a type no browser runs. An LFS file is fetched by git-lfs, not here. */
methods.downloadBlob = p => {
    const {ref, entry} = fileAt(p)
    if (entry.lfs) notAvailable("A file kept in Git LFS")
    const blob = git("get#GitBlob", {repositoryId: p.repositoryId, revision: ref.commitId, path: ref.path})
    if (blob.text == null && blob.bytes == null) missing()
    const image = RAW_IMAGES[extension(ref.path)]
    return {
        file: {
            filename: ref.path.slice(ref.path.lastIndexOf("/") + 1),
            mimeType: blob.binary ? image || "application/octet-stream" : "text/plain; charset=utf-8",
            size: Number(blob.size || 0),
            inline: !blob.binary || !!image
        },
        text: blob.text ?? null,
        bytes: blob.bytes ?? null
    }
}
/* A framework read whose refusal is the request's own (a file too large or binary for blame, a tree too large to
   archive): Unprocessable with its text; nothing out is Not Found. */
function gitOrRefuse(name, parameters) {
    const out = ec.service
        .sync()
        .name(core.GIT + name)
        .parameters(parameters)
        .call()
    if (ec.message.hasError()) {
        const problem = text(ec.message.getErrorsString()).split("\n")[0]
        ec.message.clearErrors()
        ec.logger.warn("Smithy read " + name + " of " + parameters.repositoryId + " refused: " + problem)
        invalid(problem.slice(0, 200))
    }
    return out || {}
}
/* Blame: the file's text and, for each run of lines, the commit that last changed them. An author's address is not
   returned, and none is matched to an account. */
methods.getBlame = p => {
    const {ref, entry} = fileAt(p)
    if (entry.lfs) invalid("A file kept in Git LFS has no blame")
    if (Number(entry.size || 0) > TEXT_LIMIT) invalid("The file is too large for blame")
    const blame = gitOrRefuse("get#GitBlame", {repositoryId: p.repositoryId, revision: ref.commitId, path: ref.path})
    if (!blame.commitId) missing()
    const blob = git("get#GitBlob", {repositoryId: p.repositoryId, revision: ref.commitId, path: ref.path})
    return {
        ref: refView(ref),
        path: ref.path,
        text: blob.text ?? null,
        hunkList: Array.from(blame.hunkList || []).map(hunk => ({
            startLine: Number(hunk.startLine),
            lineCount: Number(hunk.lineCount),
            commitId: hunk.commitId,
            summary: hunk.summary || "",
            authorName: hunk.authorName || "",
            authorHandle: null,
            date: hunk.authorDate || null
        }))
    }
}
/* A tree at a ref as a zip or tar.gz: the framework writes the file and the transport streams it (PassAuthority.js
   DOWNLOADS). The framework has no cap by client, so until Smithy keeps one an archive is for a signed-in account. */
methods.downloadArchive = p => {
    core.repository(p.repositoryId, p.siteId)
    if (!["zip", "tar.gz"].includes(p.format)) invalid("format must be zip or tar.gz")
    const ref = core.splitRefPath(p.repositoryId, p.refPath)
    if (ref.path) invalid("An archive is of a branch, a tag or a commit, with no path after it")
    if (ref.empty) missing()
    requireUser()
    const made = gitOrRefuse("get#GitArchive", {repositoryId: p.repositoryId, revision: ref.commitId, format: p.format})
    if (!made.archiveLocation) missing()
    return {
        file: {
            filename: made.fileName,
            mimeType: made.contentType || "application/octet-stream",
            size: Number(made.archiveSize || 0)
        },
        commitId: made.commitId || ref.commitId,
        location: made.archiveLocation
    }
}
methods.findCommits = p => {
    core.repository(p.repositoryId, p.siteId)
    const ref = core.splitRefPath(p.repositoryId, p.refPath)
    const limit = p.limit == null || p.limit === "" ? LOG_PAGE : Number(p.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid("limit must be from 1 through 100")
    if (p.afterCommitId && !/^[0-9a-f]{40}$/.test(p.afterCommitId)) invalid("afterCommitId must be a commit id")
    if (ref.empty) return {ref: refView(ref), path: ref.path, commitList: [], hasMore: false}
    const log = git("get#GitLog", {
        repositoryId: p.repositoryId,
        revision: ref.commitId,
        path: ref.path || null,
        afterCommitId: p.afterCommitId || null,
        limit
    })
    return {
        ref: refView(ref),
        path: ref.path,
        commitList: commitViews(p.repositoryId, log.commitList),
        hasMore: !!log.hasMore
    }
}
methods.getCommit = p => {
    core.repository(p.repositoryId, p.siteId)
    if (!core.HEX.test(text(p.commitId))) missing()
    const found = git("get#GitCommit", {repositoryId: p.repositoryId, commitId: p.commitId, stats: true})
    if (!found.commit?.commitId || !String(found.commit.commitId).startsWith(p.commitId.toLowerCase())) missing()
    const commitId = found.commit.commitId
    // one diff call: the file of path, or every file of a commit that changed no more than the page shows; a larger
    // commit has its file list and no diffs here, and the page asks for a file's by path
    const files = Array.from(found.fileList || [])
    const tooMany = !p.path && files.length > DIFF_FILES
    if (p.path && !files.some(file => file.path === p.path)) missing()
    const diffs = boundedDiffs(
        tooMany
            ? []
            : Array.from(
                  git("get#GitCommitDiff", {repositoryId: p.repositoryId, commitId, path: p.path || null}).fileDiffList || []
              )
    )
    const statuses = git("get#GitCommitStatuses", {repositoryId: p.repositoryId, commitId})
    return {
        commit: commitViews(p.repositoryId, [found.commit])[0],
        fileList: fileViews(files),
        insertions: Number(found.insertions || 0),
        deletions: Number(found.deletions || 0),
        fileDiffList: diffs.shown,
        truncated: diffs.truncated || tooMany,
        statusList: Array.from(statuses.statusList || []),
        // issues and merge request links are DG3's and DG4's
        linkedIssues: [],
        linkedMergeRequests: [],
        hiddenItemCount: 0
    }
}
methods.getCompare = p => {
    const r = core.repository(p.repositoryId, p.siteId)
    // a fork's ref as the head is DG4's
    if (p.headRepositoryPath && text(p.headRepositoryPath).toLowerCase() !== r.repo.repositoryPath)
        notBuilt("A compare across repositories")
    if (!p.head) invalid("head is required")
    // each side is a branch, a tag or a commit id (as a refPath's ref is found), and the compare is of their commits
    const refs = git("get#GitRefs", {repositoryId: p.repositoryId})
    const head = core.refOf(p.repositoryId, p.head, refs)
    const base = core.refOf(p.repositoryId, p.base || "", refs)
    if (base.empty) missing()
    const out = git("get#GitCompare", {
        repositoryId: p.repositoryId,
        base: base.commitId,
        head: head.commitId,
        withDiffs: flag(p.withDiffs),
        // a trial merge only when the page asks for it
        checkMergeable: flag(p.checkMergeable)
    })
    if (!out.headCommitId || !out.baseCommitId) missing()
    const diffs = boundedDiffs(flag(p.withDiffs) ? out.fileList : [])
    const open =
        head.kind === "branch" && base.kind === "branch"
            ? Array.from(
                  find("moqui.resource.GitMergeRequest", {
                      repositoryId: p.repositoryId,
                      sourceRef: head.name,
                      targetRef: base.name
                  })
                      .condition("statusId", "in", ["GmrDraft", "GmrOpen"])
                      .limit(1)
                      .list()
              )[0]
            : null
    return {
        baseCommitId: out.baseCommitId,
        headCommitId: out.headCommitId,
        mergeBaseId: out.mergeBaseId || null,
        aheadBy: Number(out.aheadBy || 0),
        behindBy: Number(out.behindBy || 0),
        commitList: commitViews(p.repositoryId, out.commitList),
        commitsTruncated: !!out.commitsTruncated,
        fileList: fileViews(out.fileList),
        fileDiffList: diffs.shown,
        insertions: Number(out.insertions || 0),
        deletions: Number(out.deletions || 0),
        mergeable: !flag(p.checkMergeable) || out.mergeable == null ? null : !!out.mergeable,
        conflictPaths: Array.from(out.conflictPaths || []),
        openMergeRequestNum: open?.mergeRequestNum ?? null
    }
}
methods.findRefs = p => {
    core.repository(p.repositoryId, p.siteId)
    if (p.refType && !["branch", "tag"].includes(p.refType)) invalid("refType must be branch or tag")
    const pg = page(p, ["smithy-refs", p.repositoryId, p.refType, p.query, flag(p.namesOnly)].join(":"))
    const refs = git("get#GitRefs", {repositoryId: p.repositoryId, refType: p.refType || null})
    const word = text(p.query).toLowerCase()
    const defaultBranch = refs.defaultBranch || "main"
    const shown = Array.from(refs.refList || [])
        .filter(ref => ["branch", "tag"].includes(ref.refType) && (!word || text(ref.shortName).toLowerCase().includes(word)))
        // the default branch first, then branches by name and tags newest first
        .sort((x, y) => {
            const lead = ref =>
                ref.refType === "branch" && ref.shortName === defaultBranch ? 0 : ref.refType === "branch" ? 1 : 2
            if (lead(x) !== lead(y)) return lead(x) - lead(y)
            return x.refType === "tag"
                ? text(y.commitDate).localeCompare(text(x.commitDate))
                : text(x.shortName).localeCompare(text(y.shortName))
        })
    // ahead and behind the default branch, a rule's protection and the open merge request are the Branches page's: asked
    // with refType branch and without namesOnly; a ref picker asks for names
    const detailed = p.refType === "branch" && !flag(p.namesOnly)
    const openBySource = new Map(
        detailed
            ? Array.from(
                  find("moqui.resource.GitMergeRequest", {repositoryId: p.repositoryId})
                      .condition("statusId", "in", ["GmrDraft", "GmrOpen"])
                      .limit(SCAN_LIMIT)
                      .list()
              ).map(request => [request.sourceRef, request.mergeRequestNum])
            : []
    )
    return {
        defaultBranch,
        refList: shown.slice(pg.offset, pg.offset + pg.limit).map(ref => {
            const compared =
                detailed && ref.shortName !== defaultBranch
                    ? git("get#GitCompare", {repositoryId: p.repositoryId, base: defaultBranch, head: ref.refName})
                    : null
            return {
                name: ref.shortName,
                refType: ref.refType,
                commitId: ref.commitId,
                summary: ref.summary || "",
                date: ref.commitDate || null,
                aheadBy: compared ? Number(compared.aheadBy || 0) : null,
                behindBy: compared ? Number(compared.behindBy || 0) : null,
                protected: detailed
                    ? !!git("get#GitBranchRules", {repositoryId: p.repositoryId, refName: ref.refName, refType: "branch"})
                          .protected
                    : null,
                mergeRequestNum: detailed ? (openBySource.get(ref.shortName) ?? null) : null,
                // releases are DG7's
                releaseTag: null
            }
        }),
        nextCursor: shown.length > pg.offset + pg.limit ? pg.next(pg.offset + pg.limit) : null
    }
}

// ===== making a group and a repository =====
function sequenced(entityName, fields) {
    const value = ec.entity.makeValue(entityName)
    value.setSequencedIdPrimary()
    for (const [name, field] of Object.entries(fields)) value.set(name, field)
    value.create()
    return value
}
const visibilityId = (code, fallback) =>
    code ? core.idOfCode(VISIBILITY_CODES, code) || invalid("visibility must be public, members or private") : fallback
/* Who writes: a signed-in caller with a confirmed address (an operator needs none) who is not suspended on the site. */
function writer(siteId) {
    const partyId = requireUser()
    const access = core.siteAccess(siteId, core.actor())
    if (!access.operator && !core.confirmedNow())
        fail("Unauthorized", "addressUnconfirmed: Confirm your email address to continue")
    if (access.suspended) fail("Unauthorized", "accessDenied: Your account is suspended on this site")
    return {partyId, access}
}
/* The site's PublicSite row locked, so a group path, a handle and a repository's path are not taken at the same time.
   Taken once the caller is known to be one who may write, so that nobody else holds the site's row. */
const lockNames = siteId => one(S + "PublicSite", {siteId}, true)
/* The Owner row a group starts with, or that an approved request gives its requester. */
function grantOwner(group, partyId, addedByPartyId) {
    const fields = {roleEnumId: "SmrOwner", fromDate: now(), thruDate: null, addedByPartyId}
    const row = one(M + "SmithyGroupParty", {groupId: group.groupId, partyId}, true)
    if (row) forum.update(row, {...fields, revision: Number(row.revision || 1) + 1})
    else forum.create(M + "SmithyGroupParty", {groupId: group.groupId, partyId, siteId: group.siteId, ...fields, revision: 1})
}
/* What a group's row holds beside its path, name, visibility and request: empty on a new group. */
const GROUP_SETTINGS = [
    "avatarId",
    "contactListId",
    "newsContactListId",
    "workEffortId",
    "issueRepositoryId",
    "landingRepositoryId",
    "landingPath",
    "agreementEnumId",
    "agreementPath",
    "runnerPoolId",
    "outsideRunnerPoolId",
    "maxRepositoryBytes",
    "maxLfsBytes",
    "runnerMinutesMonthly",
    "hiddenAt",
    "hiddenByPartyId",
    "hideReason"
]
/* A new group after its caller's own checks (who may make it): the name rules, the nesting, the visibility's ceiling and
   the row, a top-level one (no parent) or a subgroup of parent (a group's rights). The site's PublicSite row is locked by
   the caller, so a group path and a handle are not taken at the same time. g: siteId, partyId, access, parent,
   pathSegment, name, description, visibility, statusId, reason. */
function makeGroup(g) {
    const {siteId, partyId, parent} = g
    const pathSegment = text(g.pathSegment)
    if (!core.validGroupSegment(pathSegment))
        invalid("nameInvalid[pathSegment]: A group's path is 2 to 39 lower case letters, digits, underscores or hyphens")
    const name = text(g.name).trim() || pathSegment
    if (name.length > 255) invalid("name is too long")
    if (parent && (parent.group.statusId !== "SmgActive" || parent.chain.length >= core.MAX_GROUP_DEPTH))
        invalid("policyRefused[" + (g.parentField || "groupId") + "]: Subgroups nest to four levels, below an active group")
    const visibilityEnumId = visibilityId(g.visibility, parent ? VISIBILITY_IDS[parent.visibility] : "SmvPrivate")
    if (parent && core.visibilityRank(visibilityEnumId) < parent.visibility)
        invalid("policyRefused[visibility]: A subgroup is no wider than its group")
    const groupPath = parent ? parent.group.groupPath + "/" + pathSegment : pathSegment
    // an operator's page role is an Owner's everywhere, so an old path holds nothing against one
    const own = {all: !!g.access?.operator}
    const free = parent
        ? core.siblingFree(siteId, parent.group.groupId, null, pathSegment) && !core.pathHeld(siteId, groupPath, partyId, own)
        : core.nameFree(siteId, pathSegment, partyId, "group", own)
    if (!free) invalid("nameTaken[pathSegment]: That name is taken")
    const statusId = g.statusId || "SmgActive"
    const fields = {
        siteId,
        parentGroupId: parent?.group.groupId || null,
        pathSegment,
        groupPath,
        name,
        description: text(g.description) || null,
        visibilityEnumId,
        statusId,
        requestedByPartyId: partyId,
        requestReason: text(g.reason) || null,
        decidedByPartyId: null,
        decidedAt: null,
        decisionReason: null,
        createdByPartyId: partyId,
        createdAt: now(),
        revision: 1
    }
    // a refused request's path is free: its row, which the path's unique index holds, is taken over, with nothing of
    // the request it was (its limits, a hide, its settings) left on it
    const refused = one(M + "SmithyGroup", {siteId, groupPath}, true)
    const created = refused
        ? forum.update(refused, {...Object.fromEntries(GROUP_SETTINGS.map(name => [name, null])), ...fields})
        : sequenced(M + "SmithyGroup", fields)
    if (refused) find(M + "SmithyGroupParty", {groupId: refused.groupId}).deleteAll()
    // the path is taken: a redirect from it ends
    core.releasePath(siteId, groupPath)
    // an active top-level group has an Owner from the start; a subgroup's Owners are its parent's
    if (!parent && statusId === "SmgActive") grantOwner(created, partyId, partyId)
    return created
}
/* create#Group: a top-level group by the site's owner or an operator, or a subgroup by an Owner of its parent; for
   operators, seed data and specs. The operations are requestGroup and createSubgroup (SmithyManage.js). */
function createGroup(p) {
    core.site(p.siteId)
    const {partyId, access} = writer(p.siteId)
    const parent = p.parentGroupId ? core.group(p.parentGroupId, p.siteId) : null
    if (parent) core.requireRole(parent, "SmrOwner")
    else if (!access.owner) fail("Unauthorized", "accessDenied: Only the site's owner makes a group")
    lockNames(p.siteId)
    const created = makeGroup({...p, partyId, access, parent, parentField: "parentGroupId"})
    return {groupId: created.groupId, groupPath: created.groupPath}
}
/* A new repository after its caller's own checks (who may make it, the policy and the limits): the name rules, the
   visibility's ceiling, the hosted repository (a new one of repositoryKind, or with bindRepositoryId one that is
   there), the Smithy row and the path. r: siteId, partyId, access, parent (a group's rights; none: the namespace of
   partyId), slug, name, description, visibility, repositoryKind, branch, bindRepositoryId. */
function makeRepository(r) {
    const {siteId, partyId, parent} = r
    if (parent && parent.group.statusId !== "SmgActive") invalid("policyRefused[groupId]: The group is not active")
    const namespace = parent ? parent.group.groupPath : handleOf(siteId, partyId)
    if (!namespace) invalid("policyRefused[groupId]: Choose a handle before making a personal repository")
    const slug = text(r.slug || r.name).toLowerCase()
    if (!core.validSlug(slug))
        invalid("nameInvalid[slug]: A repository's name is letters, digits, '.', '_' and '-', and does not end in .git")
    const name = text(r.name).trim() || slug
    if (name.length > 255) invalid("name is too long")
    // private unless asked: a repository is never made wider than was said
    const visibilityEnumId = visibilityId(r.visibility, "SmvPrivate")
    if (parent && core.visibilityRank(visibilityEnumId) < parent.visibility)
        invalid("policyRefused[visibility]: A repository is no wider than its group")
    const repositoryPath = namespace + "/" + slug
    // a top-level group and what is below it hold a bounded count of repositories
    const top = parent ? parent.chain[parent.chain.length - 1] : null
    if (
        top &&
        find(M + "SmithyRepository", {siteId})
            .condition("repositoryPath", "like", top.groupPath + "/%")
            .count() >= core.GROUP_REPOSITORY_LIMIT
    )
        invalid("quotaExceeded: The group has as many repositories as a group may have")
    if (!pathFree(siteId, parent?.group.groupId || null, parent ? null : partyId, slug, repositoryPath, partyId, r.access))
        invalid("nameTaken[slug]: That name is taken")
    let repositoryId = text(r.bindRepositoryId)
    if (repositoryId) {
        if (!one(GIT_REPOSITORY, {repositoryId}) || one(M + "SmithyRepository", {repositoryId}))
            invalid("repositoryId names no hosted repository that Smithy does not have")
    } else {
        const repositoryKind = r.repositoryKind || "local"
        if (!["local", "db"].includes(repositoryKind)) invalid("repositoryKind must be local or db")
        do repositoryId = "smr" + ec.entity.sequencedIdPrimary(M + "SmithyRepository", 0, 50)
        while (one(GIT_REPOSITORY, {repositoryId}))
        const made = {
            repositoryId,
            repositoryKind,
            branch: text(r.branch) || "main",
            description: text(r.description).slice(0, 255) || null
        }
        ec.service
            .sync()
            .name("create#" + GIT_REPOSITORY)
            .parameters(made)
            .call()
        ec.service
            .sync()
            .name(core.GIT + "init#GitRepository")
            .parameters({repositoryId})
            .call()
        if (ec.message.hasError()) fail("Unprocessable", "The repository could not be made")
    }
    const created = forum.create(M + "SmithyRepository", {
        repositoryId,
        siteId,
        groupId: parent?.group.groupId || null,
        ownerPartyId: parent ? null : partyId,
        slug,
        name,
        visibilityEnumId,
        issuesEnabled: "N",
        mergeRequestsEnabled: "Y",
        pipelinesEnabled: "N",
        forumEnabled: "N",
        docsEnabled: "N",
        nextIssueNumber: 1,
        createdByPartyId: partyId,
        createdAt: now(),
        revision: 1
    })
    core.setPath(created, {repositoryPath})
    return {repositoryId, repositoryPath}
}
/* Whether a repository's name is free in its group (among its subgroups and repositories) or its personal namespace,
   and its path taken by no repository and held by no old path against the party (§4.3; an operator's page role is an
   Owner's everywhere). exceptRepositoryId: the repository that is being moved. */
function pathFree(siteId, groupId, ownerPartyId, slug, repositoryPath, partyId, access, exceptRepositoryId) {
    if (!core.siblingFree(siteId, groupId, ownerPartyId, slug)) return false
    const holder = one(M + "SmithyRepository", {repositoryPath})
    if (holder && holder.repositoryId !== exceptRepositoryId) return false
    const hosted = find(GIT_REPOSITORY, {repositoryPath})
    if ((exceptRepositoryId ? hosted.condition("repositoryId", "not-equals", exceptRepositoryId) : hosted).count() > 0)
        return false
    return !core.pathHeld(siteId, repositoryPath, partyId, {all: !!access?.operator, repositoryId: exceptRepositoryId})
}
/* create#Repository: a new hosted repository in a group by its Maintainer, or in the caller's namespace by the site's
   staff. bind#Repository (bind): a hosted repository that is there, of any kind, a remote mirror included, bound to a
   group by an operator. For operators, seed data and specs; the operation is createRepository (SmithyManage.js). */
function createRepository(p, bind) {
    core.site(p.siteId)
    const {partyId, access} = writer(p.siteId)
    if (bind && !access.operator) fail("Unauthorized", "accessDenied: Only an operator binds a repository that is there")
    if (bind && !p.groupId) invalid("groupId is required")
    const parent = p.groupId ? core.group(p.groupId, p.siteId) : null
    if (parent) core.requireRole(parent, "SmrMaintainer")
    else if (!access.owner) fail("Unauthorized", "accessDenied: Only the site's owner makes a personal repository")
    if (bind && !text(p.repositoryId)) invalid("repositoryId is required")
    lockNames(p.siteId)
    return makeRepository({...p, partyId, access, parent, bindRepositoryId: bind ? p.repositoryId : null})
}

// ===== the operations of §15.3, in their own modules =====
const kit = {
    core,
    methods,
    flag,
    text,
    handleOf,
    groupView,
    repositoryView,
    memberView,
    visibilityId,
    writer,
    grantOwner,
    lockNames,
    makeGroup,
    makeRepository,
    pathFree,
    MERGE_METHODS,
    GIT_REPOSITORY
}
ec.resource.script("component://mr-mantle/service/mantle/smithy/SmithyManage.js")(kit)
const gitModule = ec.resource.script("component://mr-mantle/service/mantle/smithy/SmithyGit.js")(kit)

// ===== dispatch =====
const NUMBERS = [
    "limit",
    "offset",
    "expectedRevision",
    "defaultMaxRepositories",
    "defaultRepositoryBytes",
    "defaultLfsBytes",
    "defaultRunnerMinutes",
    "groupRepositoryBytes",
    "groupLfsBytes",
    "groupRunnerMinutes",
    "maxEditBytes",
    "pinnedSequence",
    "requiredApprovals",
    "maxRepositories",
    "maxRepositoryBytes",
    "maxLfsBytes",
    "runnerMinutesMonthly"
]
const FLAGS = [
    "mine",
    "includeSubgroups",
    "pinned",
    "plain",
    "withDiffs",
    "checkMergeable",
    "namesOnly",
    "withReadme",
    "archived",
    "issuesEnabled",
    "mergeRequestsEnabled",
    "pipelinesEnabled",
    "forumEnabled",
    "docsEnabled",
    "allowForcePush",
    "allowDelete",
    "requireMergeRequest",
    "dismissStaleApprovals",
    "active",
    "bot"
]
function execute(operation, p) {
    const schema = ec.resource.script("component://mr-mantle/service/mantle/smithy/SmithySchema.js")[operation]
    const fn = methods[operation]
    if (!schema || !fn) missing()
    for (const [field, value] of Object.entries(p || {})) {
        if (!schema.fields.includes(field)) invalid("Unsupported field: " + field)
        if (value == null) continue
        const kind = typeof value
        if (
            NUMBERS.includes(field)
                ? !["number", "string"].includes(kind)
                : FLAGS.includes(field)
                  ? !["boolean", "string"].includes(kind)
                  : kind !== "string"
        )
            invalid("Invalid field type: " + field)
        if (kind === "string" && value.length > 4096) invalid("Field is too long: " + field)
    }
    return privileged(() => core.withMemo(() => fn(p || {})))
}
function privileged(work) {
    const was = ec.artifactExecution.disableAuthz()
    try {
        return work()
    } finally {
        if (!was) ec.artifactExecution.enableAuthz()
    }
}
;({
    execute,
    methods,
    createGroup: p => privileged(() => createGroup(p || {})),
    createRepository: p => privileged(() => createRepository(p || {}, false)),
    bindRepository: p => privileged(() => createRepository(p || {}, true)),
    rights: (repositoryId, userId) => privileged(() => core.rights(repositoryId, userId)),
    nameFree: (siteId, name, forPartyId, kind) => privileged(() => core.nameFree(siteId, name, forPartyId, kind)),
    // the push gate and the LFS upload check (SmithyGitServices.xml): the problems that refuse, none to accept
    checkPush: context => privileged(() => core.withMemo(() => gitModule.checkPush(context))),
    checkLfsUpload: context => privileged(() => core.withMemo(() => gitModule.checkLfsUpload(context))),
    accountCard: siteId => privileged(() => core.withMemo(() => gitModule.accountCard(siteId)))
})
