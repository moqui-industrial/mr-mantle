/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * Smithy's site (mr-pass plan/design-smithy.md §13, §15.8, DG7; plans/Dogfood.md §5.8, §5.9, §7), for any site and any
 * topology: a group's landing page, a repository's Docs, releases and their assets, the component directory and a group's
 * addons.xml, the one search box, and the table of old paths. Smithy.js calls this with its kit; each operation is a
 * method of its map.
 * - Text from a repository (a landing page, a docs page, release notes) is Markdown rendered by ec.resource.markdownHtml
 *   and cleaned (StringUtilities.cleanHtml); a docs page's headings get stable anchors after the clean. Relative links
 *   are left as written: the page makes them links of the repository at the same ref (PASS screen/Smithy/Smithy.js).
 * - A release is Mantle's (a WorkEffort of type WetRelease of the repository's project) linked to a tag by a
 *   WorkEffortGitRef; its notes are its WectReleaseNotes content (mantle.work.ProjectServices); published is its status
 *   (WeComplete or WeClosed), its revision the WorkEffort's revisionNumber. A draft is a Maintainer's. Its assets are
 *   SmithyReleaseAsset rows with their files at contentLocation, under the content root (mantle.content.root).
 * - A component is a repository whose root has a component.xml: read when the default branch moves (readComponent, the
 *   gitECA rule SmithyComponent) and at a release's tag, cached by commit id.
 * - Every list and read keeps each record's own rule: the view rule of a repository (and so of its docs, releases,
 *   components), §8.2 and §8.3 of an issue, the merge request's (a held one is left out), the forum's for topics.
 * - Every path a result gives is from the host's root, the app's mount included.
 * Entity access is privileged here; every operation passes the evaluator first.
 */
kit => {
    const {core, methods, flag, text, writer} = kit
    const {M, forum, RANK, VISIBILITY_CODES, VISIBILITY_IDS} = core
    const {S, F, now, millis, me, find, one, create, update, fail, missing, invalid, page, receipt} = forum
    const WORK = "mantle.work.effort."
    const CI = "org.moqui.git.GitCiServices."
    const GMR = "moqui.resource.GitMergeRequest"
    const publicApps = () => ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
    const forumOps = () => ec.resource.script("component://mr-mantle/service/mantle/forum/Forum.js")
    const cf = () => ec.entity.conditionFactory
    const any = conditions => cf().makeCondition(conditions, "or")
    const equals = (field, value) => cf().makeCondition(field, "equals", value)
    const given = value => value !== undefined && value !== null && value !== ""
    const archived = () => fail("Conflict", "repositoryArchived: This repository is archived")
    const stale = () => fail("Conflict", "staleRevision: This changed since you read it; reload and try again")
    /* The limits of the site's reads, the same for every caller. */
    const RENDER_LIMIT = 524288
    const DOCS_FILES = 500
    const DOCS_DEPTH = 5
    const DOCS_SEARCH_FILES = 100
    const DOCS_SEARCH_BYTES = 2097152
    const DOCS_SEARCH_REPOSITORIES = 10
    const COMPONENT_BYTES = 65536
    const ASSET_LIMIT = 268435456
    const ASSET_PIECE = 8388608
    const ASSETS_PER_RELEASE = 50
    const GROUP_REPOSITORIES = 200
    const ADDONS_LIMIT = 500
    const IMPORT_LINES = 5000
    const PUBLISHED = ["WeComplete", "WeClosed"]

    // ===== shared =====
    /* A path from the host's root to a page of the site's Smithy. */
    const mountBase = siteId => publicApps().mount(siteId, "smithy")?.base ?? ""
    const encodePath = path =>
        String(path || "")
            .split("/")
            .map(encodeURIComponent)
            .join("/")
    const repoPath = (repo, rest = "") => mountBase(repo.siteId) + "/" + repo.repositoryPath + rest
    const slugOf = value =>
        text(value)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 80) || "topic"
    /* A forum topic's page: the forum of its category's scope, else the site's forum mount; null with neither. */
    function topicPath(siteId, rootCommEventId, title, contactListId) {
        const base = forum.forumPath(siteId, contactListId || null)
        return base == null ? null : base + "/t/" + encodeURIComponent(rootCommEventId) + "/" + slugOf(title)
    }
    /* A framework git read that answers {} for what is not there, never a refusal: a landing file that is gone does not
       fail the group's page. */
    function quietGit(name, parameters) {
        ec.message.pushErrors()
        try {
            const out = ec.service
                .sync()
                .name(core.GIT + name)
                .parameters(parameters)
                .call()
            return ec.message.hasError() ? {} : out || {}
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    /* A service of Mantle or the engine after Smithy's own check: its answer, or the refusal with its first line. */
    function call(name, parameters) {
        const out = ec.service.sync().name(name).parameters(parameters).call()
        if (!ec.message.hasError()) return out || {}
        const problem = text(ec.message.getErrorsString()).split("\n")[0]
        ec.message.clearErrors()
        return invalid(problem)
    }
    /* An engine read, a probe in its own transaction: its answer, or null when it refuses (an upload whose content is
       gone), which leaves the caller's transaction as it was. */
    function engine(name, parameters) {
        ec.message.pushErrors()
        try {
            const out = ec.service
                .sync()
                .name(CI + name)
                .parameters(parameters)
                .requireNewTransaction(true)
                .call()
            return ec.message.hasError() ? null : out || {}
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    /* A repository's head at its default branch: {branch, commitId}, commitId null for an empty one. */
    function headOf(repositoryId) {
        const refs = quietGit("get#GitRefs", {repositoryId, refType: "branch"})
        const branch = refs.defaultBranch || "main"
        const head = Array.from(refs.refList || []).find(ref => ref.shortName === branch)
        return {branch, commitId: head?.commitId || null, refs}
    }
    /* The entry of a path in its directory at a commit, or null. */
    function entryAt(repositoryId, commitId, path) {
        const cut = path.lastIndexOf("/")
        const tree = quietGit("get#GitTree", {repositoryId, revision: commitId, path: cut < 0 ? "" : path.slice(0, cut)})
        return Array.from(tree.entryList || []).find(entry => entry.path === path) || null
    }
    /* README.md of a directory at a commit (in any case), or null. */
    function readmeIn(repositoryId, commitId, directory) {
        const tree = quietGit("get#GitTree", {repositoryId, revision: commitId, path: directory})
        return (
            Array.from(tree.entryList || []).find(
                entry => entry.type === "file" && /^readme\.(md|markdown)$/i.test(entry.name)
            ) || null
        )
    }
    const isMarkdownEntry = entry =>
        !!entry &&
        entry.type === "file" &&
        !entry.lfs &&
        /\.(md|markdown)$/i.test(entry.name) &&
        Number(entry.size || 0) <= RENDER_LIMIT
    /* A heading's anchor: its text lower-cased, letters, digits, _ and -, spaces joined with -. */
    const anchorOf = label =>
        text(label)
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9\s_-]/g, "")
            .replace(/\s+/g, "-")
            .replace(/-+/g, "-")
    const unescape = html =>
        html
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#0?39;/g, "'")
            .replace(/&amp;/g, "&")
    /* Markdown as cleaned HTML whose headings carry stable ids, and the headings: {html, headingList}. The id is set after
       the clean and holds only letters, digits, _ and -. */
    function rendered(source) {
        const used = new Map()
        const headingList = []
        const html = StringUtilities.cleanHtml(ec.resource.markdownHtml(String(source || ""))).replace(
            /<h([1-6])>([\s\S]*?)<\/h\1>/g,
            (whole, level, inner) => {
                const label = unescape(inner.replace(/<[^>]*>/g, "")).trim()
                const first = anchorOf(label) || "section"
                const count = used.get(first) || 0
                used.set(first, count + 1)
                const anchor = count ? first + "-" + count : first
                headingList.push({level: Number(level), text: label, anchor})
                return "<h" + level + ' id="' + anchor + '">' + inner + "</h" + level + ">"
            }
        )
        return {html, headingList}
    }
    /* The rendering of a blob, kept by its id (a blob id names its content). */
    function renderedBlob(repositoryId, commitId, entry) {
        const cache = ec.cache.getCache("smithy.docs.rendered")
        const key = entry.objectId ? String(entry.objectId) : null
        const kept = key ? cache.get(key) : null
        if (kept) return JSON.parse(kept)
        const blob = quietGit("get#GitBlob", {repositoryId, revision: commitId, path: entry.path})
        if (blob.text == null) return null
        const out = rendered(blob.text)
        if (key) cache.put(key, JSON.stringify(out))
        return out
    }
    /* A file name as a title: without its extension, - and _ as spaces. */
    const titleOf = name =>
        text(name)
            .replace(/\.(md|markdown)$/i, "")
            .replace(/[-_]+/g, " ")
            .trim() || text(name)
    /* The repositories of a group and those below it that the caller views, by path (at most 200). */
    function groupRepositories(g, a) {
        return Array.from(
            find(M + "SmithyRepository", {siteId: g.group.siteId})
                .condition("repositoryPath", "like", g.group.groupPath + "/%")
                .orderBy("repositoryPath")
                .limit(GROUP_REPOSITORIES)
                .list()
        )
            .filter(repo => text(repo.repositoryPath).startsWith(g.group.groupPath + "/"))
            .map(repo => core.repositoryRights(repo, a))
            .filter(r => r.canView)
    }

    // ===== the landing page (§13.1) =====
    methods.getGroupLanding = p => {
        const g = core.group(p.groupId, p.siteId)
        const a = core.actor()
        const group = g.group
        // sourceRef: the branch the text was read at, for the page's links of the repository
        const out = {html: null, sourceRepositoryPath: null, sourcePath: null, sourceRef: null, editPath: null}
        const landing = group.landingRepositoryId ? one(M + "SmithyRepository", {repositoryId: group.landingRepositoryId}) : null
        if (landing && landing.siteId === p.siteId && group.landingPath && core.repositoryRights(landing, a).canView) {
            const head = headOf(landing.repositoryId)
            const entry = head.commitId ? entryAt(landing.repositoryId, head.commitId, group.landingPath) : null
            const shown = isMarkdownEntry(entry) ? renderedBlob(landing.repositoryId, head.commitId, entry) : null
            if (shown) {
                out.html = shown.html
                out.sourceRepositoryPath = landing.repositoryPath
                out.sourcePath = group.landingPath
                out.sourceRef = head.branch
                out.editPath = repoPath(landing, "/-/edit/" + encodePath(head.branch + "/" + group.landingPath))
            }
        }
        const repositories = groupRepositories(g, a)
        const latest = latestReleases(repositories, 1)[0] || null
        return {
            ...out,
            pinnedList: methods.findRepositories({siteId: p.siteId, groupId: group.groupId, pinned: true, limit: 12})
                .repositoryList,
            latestRelease: latest
                ? {repositoryPath: latest.r.repo.repositoryPath, release: releaseView(latest.r, latest.release)}
                : null,
            newsList: newsOf(p.siteId, group),
            activityList: activityOf(repositories, a)
        }
    }
    /* The latest topics of a group's news category, as the caller may read them. */
    function newsOf(siteId, group) {
        const contactListId = group.newsContactListId
        if (!contactListId) return []
        let topics = []
        try {
            topics = Array.from(forumOps().execute("findTopics", {siteId, contactListId, limit: 5}).topicList || [])
        } catch (error) {
            if (error?.moquiErrorKind !== "NotFound") throw error
        }
        return topics.map(topic => ({
            rootCommEventId: topic.rootCommEventId,
            title: topic.title,
            date: topic.lastActivity || null,
            path: topicPath(siteId, topic.rootCommEventId, topic.title, contactListId)
        }))
    }
    /* What happened in the repositories the caller views: pushes, merged merge requests and published releases, newest
       first, at most 10. */
    function activityOf(repositories, a) {
        if (!repositories.length) return []
        const byId = new Map(repositories.map(r => [r.repo.repositoryId, r]))
        const ids = [...byId.keys()]
        const handle = (siteId, userId) => kit.reviews.profileView(siteId, kit.reviews.partyOfUser(userId))?.handle || null
        const items = []
        for (const update of Array.from(
            find("moqui.resource.GitUpdate")
                .condition("repositoryId", "in", ids)
                .condition("source", "push")
                .orderBy("-updateDate")
                .limit(10)
                .list()
        )) {
            const r = byId.get(update.repositoryId)
            items.push({
                kind: "push",
                repositoryPath: r.repo.repositoryPath,
                title: "Pushed to " + r.repo.repositoryPath,
                actorHandle: handle(r.repo.siteId, update.userId),
                date: update.updateDate,
                path: repoPath(r.repo, "/-/commits")
            })
        }
        for (const mr of Array.from(
            find(GMR)
                .condition("repositoryId", "in", ids)
                .condition("statusId", "GmrMerged")
                .orderBy("-mergedDate")
                .limit(10)
                .list()
        )) {
            const r = byId.get(mr.repositoryId)
            const held = r.repo.mergeRequestsEnabled === "N" ? null : kit.reviews.heldRequest(r, mr, a)
            if (!held || held.pending) continue
            items.push({
                kind: "merge",
                repositoryPath: r.repo.repositoryPath,
                title: mr.title || "Merge request !" + Number(mr.mergeRequestNum),
                actorHandle: handle(r.repo.siteId, mr.mergedByUserId),
                date: mr.mergedDate,
                path: repoPath(r.repo, "/-/merge-requests/" + Number(mr.mergeRequestNum))
            })
        }
        for (const {r, release, tag} of latestReleases(repositories, 10))
            items.push({
                kind: "release",
                repositoryPath: r.repo.repositoryPath,
                title: release.description || tag,
                actorHandle: null,
                date: release.actualCompletionDate,
                path: repoPath(r.repo, "/-/releases/" + encodePath(tag))
            })
        return items.sort((x, y) => millis(y.date || 0) - millis(x.date || 0)).slice(0, 10)
    }
    methods.setGroupLanding = p => {
        const g = core.group(p.groupId, p.siteId)
        writer(p.siteId)
        core.requireRole(g, "SmrOwner")
        const group = one(M + "SmithyGroup", {groupId: g.group.groupId}, true)
        if (Number(p.expectedRevision) !== Number(group.revision || 1)) stale()
        const fields = {}
        if (p.landingRepositoryPath !== undefined || p.landingPath !== undefined) {
            if (!given(p.landingRepositoryPath) && !given(p.landingPath)) {
                fields.landingRepositoryId = null
                fields.landingPath = null
            } else {
                const repo = one(M + "SmithyRepository", {repositoryPath: text(p.landingRepositoryPath).toLowerCase()})
                const rights = repo && repo.siteId === p.siteId ? core.repositoryRights(repo, core.actor()) : null
                if (!rights || !rights.canView) invalid("landingRepositoryPath: No repository of this site has that path")
                // the landing text is read by who views the group: its repository is no narrower, and not hidden
                if (rights.visibility > g.visibility || rights.hidden)
                    invalid("landingRepositoryPath: The repository is not visible to everyone who views the group")
                const path = text(p.landingPath).replace(/^\/+/, "")
                const head = headOf(repo.repositoryId)
                const entry =
                    head.commitId && path && !path.split("/").includes("..")
                        ? entryAt(repo.repositoryId, head.commitId, path)
                        : null
                if (!isMarkdownEntry(entry)) invalid("landingPath: The default branch has no Markdown file at that path")
                fields.landingRepositoryId = repo.repositoryId
                fields.landingPath = path
            }
        }
        if (p.newsContactListId !== undefined) {
            if (!given(p.newsContactListId)) fields.newsContactListId = null
            else {
                const category = one(F + "ForumCategory", {contactListId: text(p.newsContactListId)})
                if (!category || category.siteId !== p.siteId) invalid("newsContactListId: No category of this site has that id")
                // read by who views the group: a public group's news is a published public category
                const open =
                    g.visibility === 3 ||
                    (category.publicationState === "published" &&
                        (category.visibility === "public" || (g.visibility === 2 && category.visibility === "members")))
                if (!open) invalid("newsContactListId: The category is not readable by everyone who views the group")
                fields.newsContactListId = category.contactListId
            }
        }
        const revision = Number(group.revision || 1) + 1
        update(group, {...fields, revision})
        return {revision}
    }

    // ===== Docs (§13.2) =====
    const docsRoot = repo =>
        text(repo.docsPath || "docs")
            .replace(/^\/+|\/+$/g, "")
            .split("/")
            .filter(segment => segment && segment !== "." && segment !== "..")
            .join("/") || "docs"
    function docsRepository(p) {
        const r = core.repository(p.repositoryId, p.siteId)
        if (r.repo.docsEnabled !== "Y") missing()
        return r
    }
    /* The Markdown files under the docs directory at a commit, breadth first: {path (in the directory), name, objectId,
       size}, at most DOCS_FILES files and DOCS_DEPTH levels. */
    function docsFiles(repositoryId, commitId, root) {
        const files = []
        const queue = [{path: root, depth: 0}]
        while (queue.length && files.length < DOCS_FILES) {
            const {path, depth} = queue.shift()
            const tree = quietGit("get#GitTree", {repositoryId, revision: commitId, path})
            if (tree.isFile) continue
            for (const entry of Array.from(tree.entryList || [])) {
                if (entry.type === "dir") {
                    if (depth + 1 < DOCS_DEPTH) queue.push({path: entry.path, depth: depth + 1})
                } else if (isMarkdownEntry(entry) && files.length < DOCS_FILES)
                    files.push({path: entry.path.slice(root.length + 1), name: entry.name, objectId: entry.objectId, entry})
            }
        }
        return files
    }
    /* The table of contents: each directory's README.md first (its index, titled by the directory), its other files, then
       its directories as sections; a section with no index has no path. */
    function tocOf(files) {
        const parentOf = path => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "")
        const byDirectory = new Map()
        const directories = new Set([""])
        for (const file of files) {
            const directory = parentOf(file.path)
            if (!byDirectory.has(directory)) byDirectory.set(directory, [])
            byDirectory.get(directory).push(file)
            for (let d = directory; d; d = parentOf(d)) directories.add(d)
        }
        const isIndex = file => /^readme\.(md|markdown)$/i.test(file.name)
        const out = []
        const visit = (directory, depth) => {
            const list = (byDirectory.get(directory) || [])
                .slice()
                .sort((x, y) => (isIndex(y) ? 1 : 0) - (isIndex(x) ? 1 : 0) || x.name.localeCompare(y.name))
            const index = list.find(isIndex)
            const sectionTitle = directory ? titleOf(directory.slice(directory.lastIndexOf("/") + 1)) : "Overview"
            if (directory && !index) out.push({path: null, title: sectionTitle, depth})
            for (const file of list)
                out.push({
                    path: file.path,
                    title: isIndex(file) ? sectionTitle : titleOf(file.name),
                    depth: isIndex(file) ? depth : depth + (directory ? 1 : 0)
                })
            for (const child of [...directories].filter(d => d && parentOf(d) === directory).sort()) visit(child, depth + 1)
        }
        visit("", 0)
        return out
    }
    methods.getDocsPage = p => {
        const r = docsRepository(p)
        const repositoryId = r.repo.repositoryId
        const refs = core.git("get#GitRefs", {repositoryId})
        const ref = core.splitRefPath(repositoryId, p.refPath, refs)
        if (ref.empty) missing()
        const root = docsRoot(r.repo)
        const wanted = ref.path.replace(/\/+$/, "")
        let entry = wanted ? entryAt(repositoryId, ref.commitId, root + "/" + wanted) : null
        if (!wanted || entry?.type === "dir") entry = readmeIn(repositoryId, ref.commitId, wanted ? root + "/" + wanted : root)
        if (!isMarkdownEntry(entry) || !entry.path.startsWith(root + "/")) missing()
        const shown = renderedBlob(repositoryId, ref.commitId, entry)
        if (!shown) missing()
        const first = shown.headingList.find(heading => heading.level === 1)
        return {
            ref: {kind: ref.kind, name: ref.name, fullName: ref.fullName, commitId: ref.commitId},
            path: entry.path.slice(root.length + 1),
            title: first ? first.text : titleOf(entry.name),
            html: shown.html,
            headingList: shown.headingList,
            tocList: tocOf(docsFiles(repositoryId, ref.commitId, root)),
            editPath: ref.kind === "branch" ? repoPath(r.repo, "/-/edit/" + encodePath(ref.name + "/" + entry.path)) : null,
            refList: Array.from(refs.refList || [])
                .filter(row => row.refType === "branch" || row.refType === "tag")
                .slice(0, 100)
                .map(row => ({kind: row.refType, name: row.shortName, fullName: row.refName, commitId: row.commitId}))
        }
    }
    /* The docs pages of a repository at its default branch that match a query, in their titles first, then in their
       text (at most DOCS_SEARCH_FILES files and DOCS_SEARCH_BYTES read): {title, snippet, path, date}. */
    function searchDocs(r, query, limit) {
        const repositoryId = r.repo.repositoryId
        const head = headOf(repositoryId)
        if (!head.commitId) return []
        const root = docsRoot(r.repo)
        const files = docsFiles(repositoryId, head.commitId, root)
        const wanted = query.toLowerCase()
        const result = file => ({
            type: "docs",
            title: titleOf(file.name),
            snippet: "",
            path: repoPath(r.repo, "/-/docs/" + encodePath(head.branch + "/" + file.path)),
            repositoryPath: r.repo.repositoryPath,
            date: null
        })
        const out = files
            .filter(file => file.path.toLowerCase().includes(wanted))
            .slice(0, limit)
            .map(result)
        let read = 0
        for (const file of files.slice(0, DOCS_SEARCH_FILES)) {
            if (out.length >= limit || read >= DOCS_SEARCH_BYTES) break
            if (file.path.toLowerCase().includes(wanted)) continue
            const blob = quietGit("get#GitBlob", {repositoryId, revision: head.commitId, path: file.entry.path})
            if (blob.text == null) continue
            read += blob.text.length
            const at = blob.text.toLowerCase().indexOf(wanted)
            if (at < 0) continue
            const heading = /^#\s+(.+)$/m.exec(blob.text)
            out.push({
                ...result(file),
                title: heading ? heading[1].trim() : titleOf(file.name),
                snippet: blob.text
                    .slice(Math.max(0, at - 80), at + wanted.length + 120)
                    .replace(/[#*_`>\[\]]+/g, "")
                    .replace(/\s+/g, " ")
                    .trim()
            })
        }
        return out
    }

    // ===== releases (§13.3) =====
    const tagRefName = tag => "refs/tags/" + tag
    const isPublished = release => PUBLISHED.includes(release.statusId)
    /* The release of a tag: the open WetRelease linked to it, or null. */
    function releaseOf(repositoryId, tag) {
        const link = Array.from(
            find(M + "SmithyReleaseTag", {
                repositoryId,
                refName: tagRefName(tag),
                workEffortTypeEnumId: "WetRelease",
                thruDate: null
            })
                .condition("statusId", "not-equals", "WeCancelled")
                .orderBy("workEffortId")
                .limit(1)
                .list()
        )[0]
        return link ? one(WORK + "WorkEffort", {workEffortId: link.workEffortId}) : null
    }
    const tagOfLink = link => text(link.refName).replace(/^refs\/tags\//, "")
    /* A release as the caller reads it, or Not Found: a draft is a Maintainer's. */
    function readRelease(r, tag) {
        const release = given(tag) ? releaseOf(r.repo.repositoryId, text(tag)) : null
        if (!release || (!isPublished(release) && r.rank < RANK.SmrMaintainer)) missing()
        return release
    }
    /* The published releases of repositories, newest first: [{r, release, tag}], at most limit. */
    function latestReleases(repositories, limit) {
        if (!repositories.length) return []
        const byId = new Map(repositories.map(r => [r.repo.repositoryId, r]))
        return Array.from(
            find(M + "SmithyReleaseTag", {workEffortTypeEnumId: "WetRelease", refType: "tag", thruDate: null})
                .condition("repositoryId", "in", [...byId.keys()])
                .condition("statusId", "in", PUBLISHED)
                .orderBy("-actualCompletionDate,workEffortId")
                .limit(limit)
                .list()
        ).map(link => ({
            r: byId.get(link.repositoryId),
            release: one(WORK + "WorkEffort", {workEffortId: link.workEffortId}),
            tag: tagOfLink(link)
        }))
    }
    function assetView(asset, repo) {
        return {
            assetId: asset.assetId,
            name: asset.name,
            assetKind: asset.assetKindEnumId === "SakImage" ? "image" : "file",
            imageName: asset.imageName || null,
            sizeBytes: asset.sizeBytes == null ? null : Number(asset.sizeBytes),
            sha256: asset.sha256 || null,
            path: asset.contentLocation
                ? repoPath(repo, "/-/release-assets/" + encodeURIComponent(asset.assetId) + "/" + encodeURIComponent(asset.name))
                : null
        }
    }
    const assetsOf = (repositoryId, workEffortId) =>
        Array.from(
            find(M + "SmithyReleaseAsset", {repositoryId, workEffortId})
                .orderBy("name")
                .limit(ASSETS_PER_RELEASE)
                .list()
        )
    const announcementOf = (siteId, workEffortId) =>
        Array.from(
            find(S + "PublicDiscussionLink", {siteId, sourceType: "release", sourceId: workEffortId, detachedAt: null})
                .orderBy("createdAt")
                .limit(1)
                .list()
        )[0]?.rootCommEventId || null
    function notesOf(workEffortId) {
        return text(call("mantle.work.ProjectServices.get#ReleaseNotes", {workEffortId}).notesText)
    }
    /* The release projection (§15.1). */
    function releaseView(r, release) {
        const link = Array.from(
            find(WORK + "WorkEffortGitRef", {
                workEffortId: release.workEffortId,
                repositoryId: r.repo.repositoryId,
                refType: "tag",
                thruDate: null
            })
                .limit(1)
                .list()
        )[0]
        const tag = link ? tagOfLink(link) : null
        const notes = notesOf(release.workEffortId)
        return {
            tag,
            name: release.description || tag,
            notesHtml: notes.trim() ? StringUtilities.cleanHtml(ec.resource.markdownHtml(notes)) : "",
            published: isPublished(release),
            publishedAt: isPublished(release) ? release.actualCompletionDate || null : null,
            commitId: link?.objectId || null,
            assetList: assetsOf(r.repo.repositoryId, release.workEffortId).map(asset => assetView(asset, r.repo)),
            announcementTopicId: announcementOf(r.repo.siteId, release.workEffortId),
            path: tag ? repoPath(r.repo, "/-/releases/" + encodePath(tag)) : null,
            revision: Number(release.revisionNumber || 1)
        }
    }
    methods.findReleases = p => {
        core.site(p.siteId)
        const a = core.actor()
        let repositories
        if (given(p.repositoryId)) repositories = [core.repository(p.repositoryId, p.siteId)]
        else if (given(p.groupId)) repositories = groupRepositories(core.group(p.groupId, p.siteId), a)
        else invalid("repositoryId or groupId is required")
        const pg = page(p, "smithyReleases:" + JSON.stringify([p.siteId, p.repositoryId || null, p.groupId || null]))
        if (!repositories.length) return {releaseList: [], nextCursor: null}
        const byId = new Map(repositories.map(r => [r.repo.repositoryId, r]))
        const drafts = repositories.filter(r => r.rank >= RANK.SmrMaintainer).map(r => r.repo.repositoryId)
        const others = repositories.filter(r => r.rank < RANK.SmrMaintainer).map(r => r.repo.repositoryId)
        const shown = []
        if (drafts.length) shown.push(cf().makeCondition("repositoryId", "in", drafts))
        if (others.length)
            shown.push(
                cf().makeCondition(
                    [cf().makeCondition("repositoryId", "in", others), cf().makeCondition("statusId", "in", PUBLISHED)],
                    "and"
                )
            )
        const found = Array.from(
            find(M + "SmithyReleaseTag", {workEffortTypeEnumId: "WetRelease", refType: "tag", thruDate: null})
                .condition("statusId", "not-equals", "WeCancelled")
                .condition(any(shown))
                .orderBy("-actualStartDate,-workEffortId")
                .offset(pg.offset)
                .limit(pg.limit + 1)
                .list()
        )
        return {
            releaseList: found.slice(0, pg.limit).map(link => {
                const r = byId.get(link.repositoryId)
                return {
                    ...releaseView(r, one(WORK + "WorkEffort", {workEffortId: link.workEffortId})),
                    repositoryPath: r.repo.repositoryPath
                }
            }),
            nextCursor: found.length > pg.limit ? pg.next(pg.offset + pg.limit) : null
        }
    }
    function canEdit(r) {
        return !!me() && core.confirmedNow() && !r.access.suspended && !r.git?.archivedDate && r.rank >= RANK.SmrMaintainer
    }
    methods.getRelease = p => {
        const r = core.repository(p.repositoryId, p.siteId)
        const release = readRelease(r, p.tag)
        const view = releaseView(r, release)
        const archive = format => ({format, path: repoPath(r.repo, "/-/archive/" + encodePath(view.tag) + "." + format)})
        return {
            release: view,
            archiveList: [archive("zip"), archive("tar.gz")],
            component: view.commitId ? componentAt(r.repo.repositoryId, view.commitId) : null,
            capabilities: {canEdit: canEdit(r)}
        }
    }
    /* A Maintainer's write on a repository that is not archived: {r, partyId}. */
    function maintainer(p) {
        const r = core.repository(p.repositoryId, p.siteId)
        const {partyId} = writer(p.siteId)
        core.requireRole(r, "SmrMaintainer")
        if (r.git.archivedDate) archived()
        return {r, partyId}
    }
    /* The tag's ref of a repository, or Unprocessable. */
    function tagRef(repositoryId, tag) {
        const name = text(tag).trim()
        const ref = name
            ? Array.from(core.git("get#GitRefs", {repositoryId, refType: "tag"}).refList || []).find(
                  row => row.shortName === name
              )
            : null
        if (!ref) invalid("tag: The repository has no tag " + name)
        return ref
    }
    /* Notes through the gate as a Maintainer's text in the repository's scope: refused or held text is not kept. */
    function gateNotes(r, notes, sourceFormat) {
        const format = forum.sourceFormatOf(sourceFormat || "markdown")
        const gated = forum.gateRefuse(
            forum.gate({
                siteId: r.repo.siteId,
                contactListId: core.scopeCategory(r.repo),
                kind: "release",
                body: forum.renderSource(format, notes),
                source: notes,
                sourceFormat: format,
                canModerate: true,
                confirmed: true,
                edit: true
            })
        )
        if (gated.decision === "hold") invalid("reviewRequired: These notes need a moderator's review; change them and try again")
    }
    /* A new release of a tag: a WetRelease of the repository's project named as the tag's version (or the tag, when the
       project has a release of that version from another of its repositories), linked to the tag. A release of the tag
       that was withdrawn is made again. */
    function makeRelease(r, ref, name) {
        const locked = one(M + "SmithyRepository", {repositoryId: r.repo.repositoryId}, true)
        const projectId = kit.issues.issueProject(locked)
        const version = ref.shortName.replace(/^[vV](?=\d)/, "")
        const withdrawn = Array.from(
            find(M + "SmithyReleaseTag", {
                repositoryId: r.repo.repositoryId,
                refName: ref.refName,
                workEffortTypeEnumId: "WetRelease"
            })
                .condition("statusId", "WeCancelled")
                .limit(1)
                .list()
        )[0]
        let release = withdrawn ? one(WORK + "WorkEffort", {workEffortId: withdrawn.workEffortId}) : null
        if (release)
            update(release, {
                statusId: "WeInPlanning",
                actualCompletionDate: null,
                revisionNumber: Number(release.revisionNumber || 1) + 1
            })
        else {
            const taken = candidate =>
                find(WORK + "WorkEffort", {
                    rootWorkEffortId: projectId,
                    workEffortTypeEnumId: "WetRelease",
                    workEffortName: candidate
                }).count() > 0
            const releaseName = [version, ref.shortName, r.repo.slug + " " + ref.shortName].find(candidate => !taken(candidate))
            if (!releaseName) invalid("tag: The project has a release of that name already")
            const workEffortId = call("mantle.work.ProjectServices.create#Release", {
                rootWorkEffortId: projectId,
                workEffortName: releaseName,
                description: name || null
            }).workEffortId
            release = one(WORK + "WorkEffort", {workEffortId})
            update(release, {actualStartDate: now(), revisionNumber: 1})
        }
        call("mantle.work.GitServices.store#WorkEffortRef", {
            workEffortId: release.workEffortId,
            repositoryId: r.repo.repositoryId,
            refName: ref.refName,
            objectId: ref.commitId || ref.objectId,
            linkSourceEnumId: "WglsReleaseVersion"
        })
        return release
    }
    methods.storeRelease = p => {
        const {r, partyId} = maintainer(p)
        const ref = tagRef(r.repo.repositoryId, p.tag)
        if (given(p.notes)) gateNotes(r, text(p.notes), p.sourceFormat)
        const existing = releaseOf(r.repo.repositoryId, ref.shortName)
        const work = () => {
            const release = existing
                ? one(WORK + "WorkEffort", {workEffortId: existing.workEffortId}, true)
                : makeRelease(r, ref, text(p.name).trim())
            const fields = {}
            if (given(p.name)) fields.description = text(p.name).trim().slice(0, 4000)
            const wasPublished = isPublished(release)
            const publish = p.published === undefined || p.published === null ? wasPublished : flag(p.published)
            if (publish && !wasPublished) Object.assign(fields, {statusId: "WeComplete", actualCompletionDate: now()})
            if (!publish && wasPublished) Object.assign(fields, {statusId: "WeInPlanning", actualCompletionDate: null})
            if (existing) fields.revisionNumber = Number(release.revisionNumber || 1) + 1
            if (Object.keys(fields).length) update(release, fields)
            if (given(p.notes))
                call("mantle.work.ProjectServices.store#ReleaseNotes", {
                    workEffortId: release.workEffortId,
                    notesText: text(p.notes)
                })
            // what a pipeline uploaded for the tag becomes the release's when it is published
            if (publish && !wasPublished) attachRunArtifacts(r, release, ref, partyId)
            let announcementTopicId = announcementOf(r.repo.siteId, release.workEffortId)
            if (publish && flag(p.announce) && !announcementTopicId) announcementTopicId = announce(r, release, ref, partyId)
            return {
                tag: ref.shortName,
                announcementTopicId,
                revision: Number(one(WORK + "WorkEffort", {workEffortId: release.workEffortId}).revisionNumber || 1)
            }
        }
        if (existing) {
            if (Number(p.expectedRevision) !== Number(existing.revisionNumber || 1)) stale()
            return work()
        }
        return receipt(p, "smithy.storeRelease", work)
    }
    /* A topic in the news category of the nearest group that has one, linked to the release (PublicDiscussionLink of
       source type release): the caller's post, so the forum's rules hold. */
    function announce(r, release, ref, partyId) {
        const contactListId = r.chain.map(g => g.newsContactListId).find(id => !!id)
        if (!contactListId) invalid("notAvailable: No group above this repository has a news category")
        const notes = notesOf(release.workEffortId)
        const posted = forumOps().execute("publishPost", {
            siteId: r.repo.siteId,
            contactListId,
            title: (release.description || r.repo.name || r.repo.repositoryPath) + " " + ref.shortName,
            body: notes.trim() || "Released " + r.repo.repositoryPath + " " + ref.shortName + ".",
            sourceFormat: "markdown",
            operationId: "release-" + ec.user.randomString(24).replace(/[^A-Za-z0-9_-]/g, "x")
        })
        create(S + "PublicDiscussionLink", {
            linkId: forum.id(),
            siteId: r.repo.siteId,
            sourceType: "release",
            sourceId: release.workEffortId,
            rootCommEventId: posted.rootCommEventId,
            gate: "none",
            createdByPartyId: partyId,
            createdAt: now(),
            revision: 1
        })
        return posted.rootCommEventId
    }
    methods.deleteRelease = p => {
        const {r} = maintainer(p)
        const release = readRelease(r, p.tag)
        const locked = one(WORK + "WorkEffort", {workEffortId: release.workEffortId}, true)
        if (Number(p.expectedRevision) !== Number(locked.revisionNumber || 1)) stale()
        for (const asset of assetsOf(r.repo.repositoryId, release.workEffortId)) dropAsset(asset)
        update(locked, {statusId: "WeCancelled", revisionNumber: Number(locked.revisionNumber || 1) + 1})
        for (const link of Array.from(
            find(WORK + "WorkEffortGitRef", {
                workEffortId: release.workEffortId,
                repositoryId: r.repo.repositoryId,
                thruDate: null
            }).list()
        ))
            update(link, {thruDate: now()})
        return {deleted: true}
    }

    // ===== assets =====
    const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._+ -]{0,119}$/
    const assetRoot = siteId =>
        String(ec.user.getPreference("mantle.content.root") || "dbresource://mantle/content").replace(/\/+$/, "") +
        "/smithy/" +
        siteId +
        "/release-assets"
    const fileNameOf = name =>
        text(name)
            .replace(/[^A-Za-z0-9._+-]/g, "_")
            .slice(0, 120) || "asset"
    /* Refuses an asset that would take a repository's assets past its namespace's Git LFS limit. */
    function roomFor(repo, bytes) {
        const limit = Number(kit.quota.repositoryQuota(repo).lfsBytes || 0)
        let used = 0
        for (const asset of Array.from(
            find(M + "SmithyReleaseAsset", {repositoryId: repo.repositoryId})
                .selectField("sizeBytes")
                .limit(10000)
                .list()
        ))
            used += Number(asset.sizeBytes || 0)
        if (used + bytes > limit)
            invalid("quotaExceeded: The release files would pass this repository's limit of " + limit + " bytes")
    }
    function nameFree(repositoryId, workEffortId, name) {
        if (!ASSET_NAME.test(name)) invalid("nameInvalid[name]: A file name of letters, digits, '.', '_', '+', '-' and spaces")
        if (find(M + "SmithyReleaseAsset", {repositoryId, workEffortId, name}).count() > 0)
            invalid("nameTaken[name]: The release has a file of that name")
        if (find(M + "SmithyReleaseAsset", {repositoryId, workEffortId}).count() >= ASSETS_PER_RELEASE)
            invalid("limitReached: A release has at most " + ASSETS_PER_RELEASE + " files")
    }
    function makeAsset(r, release, ref, fields) {
        const assetId = ec.entity.sequencedIdPrimary(M + "SmithyReleaseAsset", 0, 50)
        create(M + "SmithyReleaseAsset", {
            assetId,
            siteId: r.repo.siteId,
            repositoryId: r.repo.repositoryId,
            workEffortId: release.workEffortId,
            tagName: ref.shortName,
            createdAt: now(),
            ...fields
        })
        return one(M + "SmithyReleaseAsset", {assetId})
    }
    /* A run's artifact copied to a release's file: its pieces read from the engine, written once. */
    function copyArtifact(artifactId, location) {
        const pieces = []
        let total = 0
        let artifact = null
        for (;;) {
            const piece = engine("get#RunArtifact", {artifactId, offset: total, maxBytes: ASSET_PIECE, includeHidden: true})
            if (!piece || !piece.artifact) return null
            artifact = piece.artifact
            const bytes = piece.bytes ? new Uint8Array(piece.bytes) : new Uint8Array(0)
            pieces.push(bytes)
            total += bytes.length
            if (piece.done || !bytes.length) break
        }
        const whole = new Uint8Array(total)
        let at = 0
        for (const bytes of pieces) {
            whole.set(bytes, at)
            at += bytes.length
        }
        ec.resource.getLocationReference(location).putBytes(whole)
        return {artifact, size: total}
    }
    /* An artifact of a run of the release's tag (its ref, or its commit outside a merge request), with the run; null
       for one of another run or repository. */
    function tagArtifact(r, ref, artifactId) {
        const first = engine("get#RunArtifact", {artifactId, offset: 0, maxBytes: 1, includeHidden: true})
        const artifact = first?.artifact
        if (!artifact || artifact.artifactKind !== "artifact") return null
        const run = engine("get#JobRun", {jobRunId: artifact.jobRunId, includeHidden: true})?.run
        const ofTag =
            !!run &&
            run.repositoryId === r.repo.repositoryId &&
            !run.mergeRequestId &&
            (run.refName === ref.refName || (!!run.commitId && run.commitId === (ref.commitId || ref.objectId)))
        return ofTag ? {artifact, run} : null
    }
    function addArtifact(r, release, ref, artifact, run, name, partyId) {
        const size = Number(artifact.sizeBytes || 0)
        if (size > ASSET_LIMIT) invalid("notAvailable: A file over " + ASSET_LIMIT + " bytes is not a release's")
        nameFree(r.repo.repositoryId, release.workEffortId, name)
        roomFor(r.repo, size)
        const asset = makeAsset(r, release, ref, {
            name,
            assetKindEnumId: "SakFile",
            pipelineRunId: run.pipelineRunId,
            artifactId: artifact.artifactId,
            uploadedByPartyId: partyId
        })
        const location = assetRoot(r.repo.siteId) + "/" + asset.assetId + "/" + fileNameOf(name)
        const copied = copyArtifact(artifact.artifactId, location)
        if (!copied) invalid("notAvailable: The run's file is no longer there")
        update(asset, {
            contentLocation: location,
            sizeBytes: copied.size,
            sha256: artifact.sha256 || ec.resource.digest(location, "sha256")
        })
        return asset
    }
    /* The artifacts of the tag's latest successful run that the release lacks by name, each on its own: one that cannot
       be copied is logged, and the rest go on. */
    function attachRunArtifacts(r, release, ref, partyId) {
        const runs = engine("find#PipelineRuns", {
            repositoryId: r.repo.repositoryId,
            refName: ref.refName,
            statusId: "success",
            pageIndex: 0,
            pageSize: 5,
            includeHidden: true
        })
        const run = Array.from(runs?.runList || []).find(row => !row.mergeRequestId)
        if (!run) return
        const jobs = Array.from(engine("get#PipelineRun", {pipelineRunId: run.pipelineRunId, includeHidden: true})?.jobList || [])
        for (const job of jobs.slice(0, 50)) {
            const artifacts = Array.from(engine("get#JobRun", {jobRunId: job.jobRunId, includeHidden: true})?.artifactList || [])
            for (const artifact of artifacts) {
                if (artifact.artifactKind !== "artifact") continue
                const name = text(artifact.fileName || artifact.name)
                if (
                    find(M + "SmithyReleaseAsset", {
                        repositoryId: r.repo.repositoryId,
                        workEffortId: release.workEffortId,
                        name
                    }).count() > 0
                )
                    continue
                ec.message.pushErrors()
                try {
                    addArtifact(r, release, ref, artifact, run, name, partyId)
                } catch (error) {
                    ec.logger.error(
                        "Release " +
                            release.workEffortId +
                            ": the run's file " +
                            name +
                            " was not attached: " +
                            (error?.message || error)
                    )
                } finally {
                    ec.message.clearErrors()
                    ec.message.popErrors()
                }
            }
        }
    }
    methods.addReleaseAsset = p => {
        const {r, partyId} = maintainer(p)
        const ref = tagRef(r.repo.repositoryId, p.tag)
        const release = readRelease(r, ref.shortName)
        const sources = [p.attachmentId, p.artifactId, p.imageName].filter(given).length
        if (sources !== 1) invalid("One of attachmentId, artifactId and imageName is required")
        return receipt(p, "smithy.addReleaseAsset", () => {
            let asset
            if (given(p.imageName)) {
                const imageName = text(p.imageName).trim()
                if (!/^[a-z0-9][a-z0-9._\/:@-]{0,254}$/.test(imageName))
                    invalid("imageName: A container image's name, as registry/name:tag")
                const name = given(p.name)
                    ? text(p.name).trim()
                    : imageName.slice(imageName.lastIndexOf("/") + 1).replace(/[:@]/g, "-")
                nameFree(r.repo.repositoryId, release.workEffortId, name)
                asset = makeAsset(r, release, ref, {name, assetKindEnumId: "SakImage", imageName, uploadedByPartyId: partyId})
            } else if (given(p.artifactId)) {
                const found = tagArtifact(r, ref, text(p.artifactId))
                if (!found) invalid("artifactId: No file of a pipeline run of this tag has that id")
                const name = given(p.name) ? text(p.name).trim() : text(found.artifact.fileName || found.artifact.name)
                asset = addArtifact(r, release, ref, found.artifact, found.run, name, partyId)
            } else {
                // a staged upload of the caller's that passed scanning (the forum's stageAttachment, purpose repositoryFile)
                const attachment = one(F + "ForumAttachment", {attachmentId: text(p.attachmentId)}, true)
                const usable =
                    attachment &&
                    attachment.siteId === p.siteId &&
                    attachment.ownerPartyId === partyId &&
                    attachment.purpose === "repositoryFile" &&
                    !attachment.communicationEventId &&
                    attachment.scanState === "clean" &&
                    !(attachment.expiresAt && millis(attachment.expiresAt) <= millis(now()))
                if (!usable) invalid("Attachment is unavailable or has not passed scanning")
                const size = Number(attachment.byteSize || 0)
                const name = given(p.name) ? text(p.name).trim() : text(attachment.filename)
                nameFree(r.repo.repositoryId, release.workEffortId, name)
                roomFor(r.repo, size)
                asset = makeAsset(r, release, ref, {name, assetKindEnumId: "SakFile", uploadedByPartyId: partyId})
                const location = assetRoot(p.siteId) + "/" + asset.assetId + "/" + fileNameOf(name)
                ec.resource.getLocationReference(location).copyFrom(attachment.location)
                update(asset, {contentLocation: location, sizeBytes: size, sha256: ec.resource.digest(location, "sha256")})
                try {
                    ec.resource.getLocationReference(attachment.location).delete()
                } catch (error) {
                    ec.logger.warn("The staged upload " + attachment.attachmentId + " was not removed: " + error)
                }
                attachment.delete()
            }
            return {
                assetId: asset.assetId,
                sha256: asset.sha256 || null,
                sizeBytes: asset.sizeBytes == null ? null : Number(asset.sizeBytes)
            }
        })
    }
    function dropAsset(asset) {
        if (asset.contentLocation)
            try {
                ec.resource.getLocationReference(asset.contentLocation).delete()
            } catch (error) {
                ec.logger.warn("The file of release asset " + asset.assetId + " was not removed: " + error)
            }
        asset.delete()
    }
    /* An asset of a repository whose release the caller reads, or Not Found. */
    function assetOf(r, assetId) {
        const asset = given(assetId) ? one(M + "SmithyReleaseAsset", {assetId: text(assetId)}) : null
        if (!asset || asset.repositoryId !== r.repo.repositoryId) missing()
        const release = one(WORK + "WorkEffort", {workEffortId: asset.workEffortId})
        if (!release || release.statusId === "WeCancelled" || (!isPublished(release) && r.rank < RANK.SmrMaintainer)) missing()
        return asset
    }
    methods.removeReleaseAsset = p => {
        const {r} = maintainer(p)
        dropAsset(assetOf(r, p.assetId))
        return {deleted: true}
    }
    methods.downloadReleaseAsset = p => {
        const r = core.repository(p.repositoryId, p.siteId)
        const asset = assetOf(r, p.assetId)
        if (!asset.contentLocation) missing()
        return {
            file: {
                filename: asset.name,
                mimeType: ec.resource.getContentType(asset.name) || "application/octet-stream",
                size: Number(asset.sizeBytes || 0),
                inline: false
            },
            sha256: asset.sha256 || null,
            location: asset.contentLocation
        }
    }

    // ===== the component directory (§13.4) =====
    const attributeOf = (attributes, name) =>
        (new RegExp("\\s" + name + '\\s*=\\s*"([^"]*)"').exec(" " + attributes) || [])[1] ?? null
    /* What a component.xml names: {name, version, dependsOn}, or null for text that names no component. */
    function parseComponent(xml) {
        const plain = String(xml || "").replace(/<!--[\s\S]*?-->/g, "")
        const head = /<component\b([^>]*)>/.exec(plain)
        const name = head ? attributeOf(head[1], "name") : null
        if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return null
        const version = attributeOf(head[1], "version")
        const dependsOn = Array.from(plain.matchAll(/<depends-on\b([^>]*?)\/?>/g))
            .map(match => attributeOf(match[1], "name"))
            .filter(depends => !!depends && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(depends))
            .slice(0, 50)
        return {name, version: version ? version.slice(0, 60) : null, dependsOn}
    }
    /* The component at a commit of a repository, or null; kept by the commit's id. */
    function componentAt(repositoryId, commitId) {
        const cache = ec.cache.getCache("smithy.component")
        const key = repositoryId + ":" + commitId
        const kept = cache.get(key)
        if (kept != null) return JSON.parse(kept)
        const entry = entryAt(repositoryId, commitId, "component.xml")
        let component = null
        if (entry && entry.type === "file" && !entry.lfs && Number(entry.size || 0) <= COMPONENT_BYTES) {
            const blob = quietGit("get#GitBlob", {repositoryId, revision: commitId, path: "component.xml"})
            component = blob.text == null ? null : parseComponent(blob.text)
        }
        cache.put(key, JSON.stringify(component))
        return component
    }
    /* The gitECA rule's: the component at the default branch's new commit, kept on the repository's row. */
    function readComponent(p) {
        const repo = p.repositoryId ? one(M + "SmithyRepository", {repositoryId: p.repositoryId}) : null
        if (!repo || !p.newId || p.changeType === "delete" || repo.componentCommitId === p.newId) return
        const component = componentAt(repo.repositoryId, p.newId)
        update(one(M + "SmithyRepository", {repositoryId: repo.repositoryId}, true), {
            componentName: component?.name || null,
            componentVersion: component?.version || null,
            componentDependsOn: component ? component.dependsOn.join(",") || null : null,
            componentCommitId: p.newId
        })
    }
    const dependsOf = repo =>
        text(repo.componentDependsOn)
            .split(",")
            .map(name => name.trim())
            .filter(name => !!name)
    /* The tag of a repository's latest published release, or null. */
    function latestTag(repositoryId) {
        const link = Array.from(
            find(M + "SmithyReleaseTag", {repositoryId, workEffortTypeEnumId: "WetRelease", refType: "tag", thruDate: null})
                .condition("statusId", "in", PUBLISHED)
                .orderBy("-actualCompletionDate,workEffortId")
                .limit(1)
                .list()
        )[0]
        return link ? tagOfLink(link) : null
    }
    methods.findComponents = p => {
        core.site(p.siteId)
        const a = core.actor()
        const scope = kit.scopeOf(p.siteId, a)
        const group = given(p.groupId) ? core.group(p.groupId, p.siteId).group : null
        const under = group ? group.groupPath + "/" : ""
        const pg = page(p, "smithyComponents:" + JSON.stringify([p.siteId, p.groupId || null, p.query || null]))
        const build = () => {
            let query = find(M + "SmithyRepository", {siteId: p.siteId}).condition("componentName", "not-equals", null)
            if (under) query = query.condition("repositoryPath", "like", under + "%")
            if (given(p.query))
                query = query.condition(
                    any(
                        ["componentName", "repositoryPath"].map(field =>
                            cf().makeCondition(field, "like", kit.likeOf(p.query)).ignoreCase()
                        )
                    )
                )
            return kit.narrowed(query, scope, "repository").orderBy("componentName,repositoryPath")
        }
        const found = kit.scan(build, pg, row => {
            if (!text(row.repositoryPath).startsWith(under)) return null
            if (given(p.query) && !kit.contains(p.query, row.componentName, row.repositoryPath)) return null
            return core.repositoryViewable(row, a) ? row : null
        })
        return {
            componentList: found.list.map(repo => ({
                name: repo.componentName,
                version: repo.componentVersion || null,
                dependsOn: dependsOf(repo),
                repositoryPath: repo.repositoryPath,
                description: one(kit.GIT_REPOSITORY, {repositoryId: repo.repositoryId})?.description || "",
                latestTag: latestTag(repo.repositoryId)
            })),
            nextCursor: found.nextCursor
        }
    }
    const xmlText = value => text(value).replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"})[c])
    methods.getAddons = p => {
        const g = core.group(p.groupId, p.siteId)
        const a = core.actor()
        const repositories = Array.from(
            find(M + "SmithyRepository", {siteId: p.siteId})
                .condition("repositoryPath", "like", g.group.groupPath + "/%")
                .condition("componentName", "not-equals", null)
                .orderBy("repositoryPath")
                .limit(ADDONS_LIMIT)
                .list()
        ).filter(repo => text(repo.repositoryPath).startsWith(g.group.groupPath + "/") && core.repositoryViewable(repo, a))
        // the addresses: the site's canonical host, where the page's address clones only under a mount at /; else the
        // framework's own clone addresses, without archives
        const smithyBase = mountBase(p.siteId)
        const pageRoot = publicApps().pageUrl(p.siteId, "smithy", "")
        const hostRoot = pageRoot == null ? null : pageRoot.slice(0, pageRoot.length - smithyBase.length)
        const repositoryName = hostRoot ? hostRoot.replace(/^https:\/\//, "") : "smithy-" + p.siteId
        const locations = []
        if (hostRoot) {
            locations.push(["git", (smithyBase === "" ? hostRoot : hostRoot + "/git") + "/${group}/${name}.git"])
            locations.push(["current", hostRoot + smithyBase + "/${group}/${name}/-/archive/${branch}.zip"])
            locations.push(["release", hostRoot + smithyBase + "/${group}/${name}/-/archive/${version}.zip"])
        } else if (repositories.length) {
            const first = repositories[0]
            const https = text(quietGit("get#GitCloneUrls", {repositoryId: first.repositoryId}).httpsUrl)
            const tail = first.repositoryPath + ".git"
            if (https.endsWith(tail)) locations.push(["git", https.slice(0, https.length - tail.length) + "${group}/${name}.git"])
        }
        const lines = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            "<!-- The components of " +
                xmlText(g.group.groupPath) +
                " on " +
                xmlText(repositoryName) +
                ", for ./moq component-get: use this file as myaddons.xml, or copy its repository and component elements into one. -->",
            "<addons>",
            '    <repository name="' + xmlText(repositoryName) + '">',
            ...locations.map(([type, url]) => '        <location type="' + type + '" url="' + xmlText(url) + '"/>'),
            "    </repository>"
        ]
        for (const repo of repositories) {
            const hosted = one(kit.GIT_REPOSITORY, {repositoryId: repo.repositoryId})
            const groupPath = repo.repositoryPath.slice(0, repo.repositoryPath.lastIndexOf("/"))
            const attributes = [
                ["name", repo.slug],
                ["group", groupPath],
                ["version", latestTag(repo.repositoryId) || ""],
                ["branch", hosted?.branch || "main"],
                ["repository", repositoryName]
            ]
            if (repo.componentName !== repo.slug) attributes.push(["component-name", repo.componentName])
            lines.push("    <component " + attributes.map(([name, value]) => name + '="' + xmlText(value) + '"').join(" ") + "/>")
        }
        lines.push("</addons>")
        return {xml: lines.join("\n") + "\n"}
    }

    // ===== search (§13.5) =====
    const SEARCH_TYPES = ["repository", "group", "component", "issue", "mergeRequest", "docs", "topic"]
    methods.searchSite = p => {
        core.site(p.siteId)
        const query = text(p.query).trim()
        if (query.length < 2 || query.length > 200) invalid("query: Search needs 2 to 200 characters")
        const types = given(p.types)
            ? text(p.types)
                  .split(",")
                  .map(type => type.trim())
                  .filter(type => !!type)
            : SEARCH_TYPES
        if (!types.length || types.some(type => !SEARCH_TYPES.includes(type)))
            invalid("types: Kinds of " + SEARCH_TYPES.join(", "))
        const a = core.actor()
        const repository = given(p.repositoryId) ? core.repository(p.repositoryId, p.siteId) : null
        const group = !repository && given(p.groupId) ? core.group(p.groupId, p.siteId) : null
        const single = types.length === 1
        const pg = single
            ? page(p, "smithySearch:" + JSON.stringify([p.siteId, query, types, p.groupId || null, p.repositoryId || null]))
            : null
        const limit = single ? pg.limit : Math.min(p.limit == null ? 10 : Number(p.limit), 10)
        if (!Number.isInteger(limit) || limit < 1) invalid("limit must be from 1 through 100")
        const offset = single ? pg.offset : 0
        const place = {repository, group, a, query, limit: limit + (single ? 1 : 0), offset, siteId: p.siteId}
        const resultList = []
        let more = false
        for (const type of SEARCH_TYPES.filter(type => types.includes(type))) {
            const found = SEARCHES[type](place)
            if (found.length > limit) more = true
            resultList.push(...found.slice(0, limit))
        }
        return {resultList, nextCursor: single && more ? pg.next(offset + limit) : null}
    }
    /* The repositories of the search's place that the caller views: the one asked, those below the group, or the site's
       (by the list's query, at most limit + offset). */
    function placeRepositories(place, extra = () => true) {
        if (place.repository) return [place.repository].filter(r => extra(r.repo))
        const scope = kit.scopeOf(place.siteId, place.a)
        let query = find(M + "SmithyRepository", {siteId: place.siteId})
        if (place.group) query = query.condition("repositoryPath", "like", place.group.group.groupPath + "/%")
        const under = place.group ? place.group.group.groupPath + "/" : ""
        return Array.from(kit.narrowed(query, scope, "repository").orderBy("repositoryPath").limit(GROUP_REPOSITORIES).list())
            .filter(repo => text(repo.repositoryPath).startsWith(under) && extra(repo))
            .map(repo => core.repositoryRights(repo, place.a))
            .filter(r => r.canView)
    }
    const SEARCHES = {
        repository: place => {
            if (place.repository) return []
            const out = methods.findRepositories({
                siteId: place.siteId,
                query: place.query,
                ...(place.group ? {groupId: place.group.group.groupId, includeSubgroups: true} : {}),
                limit: Math.min(place.offset + place.limit, 100)
            }).repositoryList
            return out.slice(place.offset).map(repo => ({
                type: "repository",
                title: repo.name || repo.repositoryPath,
                snippet: repo.description || "",
                path: mountBase(place.siteId) + "/" + repo.repositoryPath,
                repositoryPath: repo.repositoryPath,
                date: repo.lastPushAt || null
            }))
        },
        group: place => {
            if (place.repository) return []
            const under = place.group ? place.group.group.groupPath + "/" : ""
            const out = methods.findGroups({siteId: place.siteId, query: place.query, limit: 100}).groupList
            return out
                .filter(g => g.groupPath.startsWith(under))
                .slice(place.offset, place.offset + place.limit)
                .map(g => ({
                    type: "group",
                    title: g.name || g.groupPath,
                    snippet: g.description || "",
                    path: mountBase(place.siteId) + "/" + g.groupPath,
                    repositoryPath: null,
                    date: null
                }))
        },
        component: place => {
            if (place.repository) return []
            const out = methods.findComponents({
                siteId: place.siteId,
                query: place.query,
                ...(place.group ? {groupId: place.group.group.groupId} : {}),
                limit: Math.min(place.offset + place.limit, 100)
            }).componentList
            return out.slice(place.offset).map(c => ({
                type: "component",
                title: c.name + (c.version ? " " + c.version : ""),
                snippet: c.description || "",
                path: mountBase(place.siteId) + "/" + c.repositoryPath,
                repositoryPath: c.repositoryPath,
                date: null
            }))
        },
        issue: place => {
            const trackers = placeRepositories(place, repo => repo.issuesEnabled === "Y")
            if (!trackers.length) return []
            const byId = new Map(trackers.map(r => [r.repo.repositoryId, r]))
            const out = []
            let seen = 0
            const rows = Array.from(
                find(M + "SmithyIssueTask", {siteId: place.siteId, rootVisibility: "approved"})
                    .condition("repositoryId", "in", [...byId.keys()])
                    .condition(cf().makeCondition("workEffortName", "like", kit.likeOf(place.query)).ignoreCase())
                    .orderBy("-createdAt,-issueNumber")
                    .limit(500)
                    .list()
            )
            for (const row of rows) {
                if (out.length >= place.limit) break
                const r = byId.get(row.repositoryId)
                if (!kit.contains(place.query, row.workEffortName)) continue
                const access = core.issueAccess(r, row, place.a, null)
                if (!access.canRead || seen++ < place.offset) continue
                out.push({
                    type: "issue",
                    title: (access.task?.workEffortName || "Issue") + " (#" + Number(row.issueNumber) + ")",
                    snippet: "",
                    path: repoPath(r.repo, "/-/issues/" + Number(row.issueNumber)),
                    repositoryPath: r.repo.repositoryPath,
                    date: row.createdAt || null
                })
            }
            return out
        },
        mergeRequest: place => {
            const targets = placeRepositories(place, repo => repo.mergeRequestsEnabled !== "N")
            if (!targets.length) return []
            const byId = new Map(targets.map(r => [r.repo.repositoryId, r]))
            const out = []
            let seen = 0
            for (const mr of Array.from(
                find(GMR)
                    .condition("repositoryId", "in", [...byId.keys()])
                    .condition("hiddenDate", null)
                    .condition(cf().makeCondition("title", "like", kit.likeOf(place.query)).ignoreCase())
                    .orderBy("-createdDate")
                    .limit(500)
                    .list()
            )) {
                if (out.length >= place.limit) break
                const r = byId.get(mr.repositoryId)
                if (!kit.contains(place.query, mr.title)) continue
                const held = kit.reviews.heldRequest(r, mr, place.a)
                if (!held || held.pending || seen++ < place.offset) continue
                out.push({
                    type: "mergeRequest",
                    title: (mr.title || "Merge request") + " (!" + Number(mr.mergeRequestNum) + ")",
                    snippet: "",
                    path: repoPath(r.repo, "/-/merge-requests/" + Number(mr.mergeRequestNum)),
                    repositoryPath: r.repo.repositoryPath,
                    date: mr.createdDate || null
                })
            }
            return out
        },
        docs: place => {
            const out = []
            for (const r of placeRepositories(place, repo => repo.docsEnabled === "Y").slice(0, DOCS_SEARCH_REPOSITORIES)) {
                out.push(...searchDocs(r, place.query, place.offset + place.limit - out.length))
                if (out.length >= place.offset + place.limit) break
            }
            return out.slice(place.offset)
        },
        topic: place => {
            const scope = place.repository
                ? place.repository.repo.contactListId
                : place.group
                  ? place.group.group.contactListId
                  : null
            if ((place.repository || place.group) && !scope) return []
            let topics = []
            try {
                topics = Array.from(
                    forumOps().execute("searchForum", {
                        siteId: place.siteId,
                        query: place.query,
                        limit: Math.min(place.offset + place.limit, 100),
                        ...(scope ? {scopeContactListId: scope} : {})
                    }).topicList || []
                )
            } catch (error) {
                if (error?.moquiErrorKind !== "NotFound") throw error
            }
            return topics.slice(place.offset).map(topic => ({
                type: "topic",
                title: topic.title,
                snippet: topic.snippet || "",
                path: topicPath(
                    place.siteId,
                    topic.rootCommEventId,
                    topic.title,
                    one(F + "ForumTopic", {rootCommEventId: topic.rootCommEventId})?.contactListId
                ),
                repositoryPath: null,
                date: topic.entryDate || null
            }))
        }
    }

    // ===== redirects (§13.6) =====
    const SOURCES = {site: "SrsSite", forum: "SrsForum", github: "SrsGithub", manual: "SrsManual"}
    const SOURCE_CODES = Object.fromEntries(Object.entries(SOURCES).map(([code, enumId]) => [enumId, code]))
    /* A site owner or operator: who manages the table. */
    function siteOwner(siteId, write) {
        core.site(siteId)
        const access = write ? writer(siteId).access : core.siteAccess(siteId, core.actor())
        if (!write && !me()) fail("AuthenticationRequired", "Sign in to continue")
        if (!access.owner) fail("Unauthorized", "accessDenied: Only the site's owners manage its redirects")
        return access
    }
    const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/
    const PLAIN = /^\/[^\s\\<>"'`]*$/
    /* An old address as {oldHost, oldPath}: a path, or a whole http(s) address whose host becomes oldHost; the query and
       the fragment are not part of it, nor a trailing slash. */
    function oldAddress(hostValue, pathValue) {
        let host = text(hostValue).trim().toLowerCase()
        let path = text(pathValue).trim()
        const whole = /^https?:\/\/([^/?#\s]+)([^?#\s]*)/i.exec(path)
        if (whole) {
            host = whole[1].toLowerCase()
            path = whole[2] || "/"
        }
        path = path.replace(/[?#].*$/, "")
        if (path.length > 1) path = path.replace(/\/+$/, "")
        if (host && !HOST.test(host)) invalid("oldHost: A host name")
        if (!PLAIN.test(path) || path.length > 1000) invalid("oldPath: A path starting with /")
        return {oldHost: host || null, oldPath: path}
    }
    /* The site's own host names (not a preview host's). */
    const siteHosts = siteId =>
        Array.from(
            find(S + "PublicSiteHost", {siteId})
                .limit(100)
                .list()
        )
            .filter(host => !publicApps().isPreviewHost(host))
            .map(host => text(host.hostname).toLowerCase())
    /* A target: a path of this site, or an https address of one of its hosts; never another site's. */
    function siteTarget(siteId, value) {
        const target = text(value).trim()
        const pathOf = whole => whole.replace(/[?#].*$/, "")
        const local = PLAIN.test(target) && !target.startsWith("//") && target.length <= 1000
        const whole = local ? null : /^https:\/\/([^/?#\s]+)(\/[^\s\\<>"'`]*)?$/i.exec(target)
        const ownHost = !!whole && siteHosts(siteId).includes(whole[1].toLowerCase())
        const path = local ? pathOf(target) : ownHost ? pathOf(whole[2] || "/") : null
        if (path == null || path.split("/").some(segment => segment === "." || segment === ".."))
            invalid("targetInvalid[targetPath]: A redirect leads to a path of this site or an https address of one of its hosts")
        return target
    }
    function redirectView(row) {
        return {
            redirectId: row.redirectId,
            oldHost: row.oldHost || null,
            oldPath: row.oldPath,
            targetPath: row.targetPath,
            source: SOURCE_CODES[row.sourceEnumId] || "manual",
            note: row.note || null
        }
    }
    const redirectAt = (siteId, oldHost, oldPath) =>
        Array.from(
            find(M + "SmithyRedirect", {siteId, oldPath})
                .limit(20)
                .list()
        ).find(row => (row.oldHost || null) === (oldHost || null)) || null
    methods.findRedirects = p => {
        siteOwner(p.siteId, false)
        if (given(p.source) && !SOURCES[p.source]) invalid("source: One of " + Object.keys(SOURCES).join(", "))
        const pg = page(p, "smithyRedirects:" + JSON.stringify([p.siteId, p.query || null, p.source || null]))
        let query = find(M + "SmithyRedirect", {siteId: p.siteId})
        if (given(p.source)) query = query.condition("sourceEnumId", SOURCES[p.source])
        if (given(p.query))
            query = query.condition(
                any(
                    ["oldHost", "oldPath", "targetPath"].map(field =>
                        cf().makeCondition(field, "like", kit.likeOf(p.query)).ignoreCase()
                    )
                )
            )
        const found = Array.from(
            query
                .orderBy("oldHost,oldPath")
                .offset(pg.offset)
                .limit(pg.limit + 1)
                .list()
        )
        return {
            redirectList: found.slice(0, pg.limit).map(redirectView),
            nextCursor: found.length > pg.limit ? pg.next(pg.offset + pg.limit) : null
        }
    }
    /* Writes one redirect: a new one, or the one at the same old address (replace) or of redirectId (an edit). */
    function putRedirect(siteId, partyId, fields, existing, replace) {
        const {oldHost, oldPath} = oldAddress(fields.oldHost, fields.oldPath)
        const targetPath = siteTarget(siteId, fields.targetPath)
        if (targetPath === oldPath && !oldHost) invalid("targetInvalid[targetPath]: A redirect does not lead to its own old path")
        const holder = redirectAt(siteId, oldHost, oldPath)
        if (holder && holder.redirectId !== existing?.redirectId) {
            if (!replace) invalid("nameTaken[oldPath]: The table has that old path")
            existing = holder
        }
        const values = {
            oldHost,
            oldPath,
            targetPath,
            note: given(fields.note) ? text(fields.note).slice(0, 255) : existing?.note || null
        }
        if (fields.sourceEnumId) values.sourceEnumId = fields.sourceEnumId
        if (existing) {
            update(existing, values)
            return {redirectId: existing.redirectId, created: false}
        }
        const redirectId = ec.entity.sequencedIdPrimary(M + "SmithyRedirect", 0, 50)
        create(M + "SmithyRedirect", {
            sourceEnumId: "SrsManual",
            ...values,
            redirectId,
            siteId,
            createdByPartyId: partyId,
            createdAt: now()
        })
        return {redirectId, created: true}
    }
    methods.storeRedirect = p => {
        siteOwner(p.siteId, true)
        const partyId = me()
        // one writer of the table at a time, so an old path is not taken twice
        one(S + "PublicSite", {siteId: p.siteId}, true)
        if (given(p.redirectId)) {
            const existing = one(M + "SmithyRedirect", {redirectId: text(p.redirectId)})
            if (!existing || existing.siteId !== p.siteId) missing()
            return {
                redirectId: putRedirect(p.siteId, partyId, {...redirectView(existing), ...definedOf(p)}, existing, false)
                    .redirectId
            }
        }
        return receipt(p, "smithy.storeRedirect", () => ({redirectId: putRedirect(p.siteId, partyId, p, null, false).redirectId}))
    }
    const definedOf = p =>
        Object.fromEntries(
            ["oldHost", "oldPath", "targetPath", "note"].filter(name => p[name] !== undefined).map(name => [name, p[name]])
        )
    methods.deleteRedirect = p => {
        siteOwner(p.siteId, true)
        const existing = given(p.redirectId) ? one(M + "SmithyRedirect", {redirectId: text(p.redirectId)}) : null
        if (!existing || existing.siteId !== p.siteId) missing()
        existing.delete()
        return {deleted: true}
    }
    /* One line of CSV: its fields, quoted ones with "" for a quote. */
    function csvFields(line) {
        const fields = []
        let field = ""
        let quoted = false
        for (let at = 0; at < line.length; at++) {
            const c = line[at]
            if (quoted) {
                if (c === '"' && line[at + 1] === '"') {
                    field += '"'
                    at++
                } else if (c === '"') quoted = false
                else field += c
            } else if (c === '"') quoted = true
            else if (c === ",") {
                fields.push(field)
                field = ""
            } else field += c
        }
        fields.push(field)
        return fields.map(value => value.trim())
    }
    methods.importRedirects = p => {
        siteOwner(p.siteId, true)
        const partyId = me()
        if (given(p.source) && !SOURCES[p.source]) invalid("source: One of " + Object.keys(SOURCES).join(", "))
        const sourceEnumId = SOURCES[p.source || "manual"]
        const lines = text(p.csv)
            .split(/\r?\n/)
            .map(line => line.trim())
        if (lines.length > IMPORT_LINES) invalid("csv: At most " + IMPORT_LINES + " lines")
        one(S + "PublicSite", {siteId: p.siteId}, true)
        let created = 0
        let updated = 0
        const failedList = []
        lines.forEach((line, index) => {
            if (!line || line.startsWith("#")) return
            const [old, targetPath, note] = csvFields(line)
            // a first line that names no path or address is a header
            if (index === 0 && !/^(\/|https?:\/\/)/i.test(old)) return
            ec.message.pushErrors()
            try {
                const out = putRedirect(p.siteId, partyId, {oldPath: old, targetPath, note, sourceEnumId}, null, true)
                if (out.created) created++
                else updated++
            } catch (error) {
                failedList.push({line: index + 1, message: text(error?.message || error).slice(0, 200)})
            } finally {
                ec.message.clearErrors()
                ec.message.popErrors()
            }
        })
        return {created, updated, failedList: failedList.slice(0, 200)}
    }
    /* resolve#Redirect: the target of an old path for the request's host, then for the site's own hosts; the path as it
       came, then without a trailing slash, then in lower case. */
    function resolveRedirect(p) {
        if (!p.siteId || !p.path) return null
        const host = text(p.host).trim().toLowerCase().replace(/:\d+$/, "") || null
        const raw = text(p.path).replace(/[?#].*$/, "")
        const paths = [
            ...new Set([
                raw,
                raw.length > 1 ? raw.replace(/\/+$/, "") : raw,
                raw.toLowerCase(),
                raw.replace(/\/+$/, "").toLowerCase()
            ])
        ]
        for (const path of paths) {
            if (!path) continue
            const rows = Array.from(
                find(M + "SmithyRedirect", {siteId: p.siteId, oldPath: path})
                    .limit(20)
                    .list()
            )
            const found = (host && rows.find(row => row.oldHost === host)) || rows.find(row => !row.oldHost)
            if (found) return {targetPath: found.targetPath, status: 301}
        }
        return null
    }

    // ===== a forum topic linked to a release (SmithyScope.linkCard) =====
    function releaseCard(link) {
        const release = one(WORK + "WorkEffort", {workEffortId: link.sourceId})
        const ref = release
            ? Array.from(
                  find(WORK + "WorkEffortGitRef", {workEffortId: release.workEffortId, refType: "tag", thruDate: null})
                      .limit(1)
                      .list()
              )[0]
            : null
        const repo = ref ? one(M + "SmithyRepository", {repositoryId: ref.repositoryId}) : null
        if (!repo || !isPublished(release) || !core.repositoryViewable(repo, core.actor())) return null
        const tag = tagOfLink(ref)
        return {
            title: repo.repositoryPath + " " + (release.description || tag),
            path: repoPath(repo, "/-/releases/" + encodePath(tag))
        }
    }

    return {readComponent, resolveRedirect, releaseCard, componentAt, parseComponent}
}
