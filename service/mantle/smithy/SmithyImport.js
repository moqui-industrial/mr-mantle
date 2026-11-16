/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * Smithy's GitHub import and push mirrors (mr-pass plan/design-smithy.md §11 Import, §15.9, §18.2; plans/Dogfood.md §9,
 * DG8). Smithy.js calls this with its kit; each operation is a method of its map, run through execute().
 * - The import fills a repository of a group with a GitHub repository's labels, milestones, issues (their numbers kept,
 *   their comments, reactions and final states) and pull requests (merge requests of the same number in their final state,
 *   their reviews and line comments), for an operator or the group's Owner, with a token given for the run, kept
 *   encrypted in a SystemMessageRemote and dropped when the run ends.
 * - A run (SmithyImportRun) is checkpointed: a step (run#Import, by the smithy_run_imports job as the account that started
 *   it, or by a spec) takes at most a few API requests from where the cursor is, writes each source item in a transaction
 *   of its own, and saves the cursor. Each item has one SmithyImportMap row, so a run that meets an item again makes
 *   nothing of it: a second run adds nothing. A step waits on GitHub's rate limit (X-RateLimit-Remaining and -Reset,
 *   Retry-After) by waitingUntil. What could not be carried is in the run's report.
 * - People are placeholder accounts by GitHub login (a party, a public profile, a SmithyAccount with githubLogin,
 *   githubUserId and placeholder Y), made when the run meets them. An account whose sign-in through a GitHub provider
 *   names the same GitHub id claims the placeholder (claimGithub, by the framework's sso-linked-service, ssoLinked): its posts,
 *   issues, merge requests, assignments and reactions become the account's.
 * - Text goes through the site's rules as the forum's importers carry text: rendered from Markdown and cleaned, the rules
 *   applied (a censor replaces, a block leaves the text out and reports it), no hold, no daily limit, no notice.
 * - Final states and dates are written on the rows (a task's status and resolution, a merge request's state and dates),
 *   so no status rule writes a line now or sends a notice for history.
 * - The API: smithy_github_api names its base, https://api.github.com by default; a GitHub Enterprise Server's /api/v3,
 *   or a resource location of recorded responses (a file a request: its path and query with each run of other characters
 *   as _, .json, holding status, headers and body), which is how the specs and a replayed rehearsal run without the
 *   network.
 * - Push mirrors (Settings › Mirrors) are the framework's (F6), kept by a Maintainer after Smithy's check: the store runs as
 *   the Maintainer with authorization on, so a mirror whose credential's giver loses the role pauses; a failure is told to
 *   the repository's Maintainers and Owners (mirrorFailure).
 * Entity access is privileged here; every operation checks who asks first.
 */
kit => {
    const {core, methods, flag, text, writer, lockNames, makeRepository} = kit
    const {M, GIT, forum, RANK, VISIBILITY_CODES} = core
    const {
        S,
        F,
        E,
        now,
        millis,
        stamp,
        me,
        find,
        one,
        rows,
        create,
        update,
        fail,
        missing,
        invalid,
        page,
        receipt,
        plainText,
        json
    } = forum
    const WORK = "mantle.work.effort."
    const RUN = M + "SmithyImportRun"
    const MAP = M + "SmithyImportMap"
    const GMR = "moqui.resource.GitMergeRequest"
    const SMR = M + "SmithyMergeRequest"
    const ANCHOR = "mantle.party.communication.CommunicationEventGitAnchor"
    const REMOTE = "moqui.service.message.SystemMessageRemote"
    const ACCOUNT = "moqui.security.UserAccount"
    /* What ensure#MergeRequest reads to leave a merge request the import is making to the import (SmithyReviews.js). */
    const IMPORT_KEY = "mantle.smithy.importingRepositoryId"
    const STAGE_CODES = {
        SmiQueued: "queued",
        SmiLabels: "labels",
        SmiIssues: "issues",
        SmiPulls: "pulls",
        SmiComments: "comments",
        SmiLinks: "links",
        SmiDone: "done",
        SmiFailed: "failed",
        SmiCancelled: "cancelled"
    }
    const ACTIVE = ["SmiQueued", "SmiLabels", "SmiIssues", "SmiPulls", "SmiComments", "SmiLinks"]
    const ENDED = ["SmiDone", "SmiFailed", "SmiCancelled"]
    /* What the import never carries (design-smithy §18.2), named on every run's page. */
    const NOT_CARRIED = [
        "the edit history of issues and pull requests",
        "GitHub Projects boards",
        "Discussions",
        "draft releases' assets",
        "check runs",
        "who merged a pull request (the merge is a line of its conversation)"
    ]
    /* GitHub's reactions the forum has; the others are counted in the report. */
    const REACTIONS = {"+1": "like", laugh: "laugh", heart: "thanks"}
    const LABEL_COLORS = [
        [15, "red"],
        [40, "orange"],
        [60, "amber"],
        [150, "green"],
        [180, "teal"],
        [200, "cyan"],
        [240, "blue"],
        [260, "indigo"],
        [300, "purple"],
        [345, "pink"],
        [360, "red"]
    ]
    const SOURCE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/
    const sourceValid = source => SOURCE.test(source) && source.split("/").every(segment => segment !== "." && segment !== "..")
    const HEX40 = /^[0-9a-f]{40}$/
    const PAGE = 100
    const BUDGET = 10
    const LEASE_MS = 10 * 60000
    const REPORT_LIMIT = 500
    const MAX_ERRORS = 5
    /* The active imports an account, and a site, may have at once; the placeholders one run may make; and the runs the
       job steps of one account, and of one site, in a pass. */
    const ACTIVE_PER_ACCOUNT = 2
    const ACTIVE_PER_SITE = 5
    const PLACEHOLDERS_PER_RUN = 5000
    const STEPPED_PER_ACCOUNT = 1
    const STEPPED_PER_SITE = 2
    const NOT_CARRIED_TEXT = "(This text was not carried: a rule of this site refused it.)"
    const given = value => value !== undefined && value !== null && value !== ""
    const lower = value => text(value).trim().toLowerCase()
    const denied = message => fail("Unauthorized", "accessDenied: " + message)
    const when = iso => {
        const ms = Date.parse(text(iso))
        return Number.isFinite(ms) ? ms : millis(now())
    }
    const firstLine = error =>
        text(error?.message || error)
            .replace(/^(?:Error: )+/, "")
            .split("\n")[0]
            .slice(0, 500)
    const coded = (code, message) => new Error(code + ": " + message)
    /* A service after the import's own checks, in the transaction in place: what it refuses fails the item. */
    function call(name, parameters) {
        const out = ec.service.sync().name(name).parameters(parameters).disableAuthz().call()
        if (!ec.message.hasError()) return out || {}
        const problem = text(ec.message.getErrorsString()).split("\n")[0]
        ec.message.clearErrors()
        throw new Error(problem)
    }
    /* A service in a transaction of its own whose refusal the import gets past: {out, problem}. */
    function probe(name, parameters) {
        // what a refusal says never carries a credential it was given (a fetch's address and password, a mirror's credential)
        const hide = value => [parameters?.password, parameters?.credential].reduce((out, token) => scrub({token: text(token)}, out), value)
        ec.message.pushErrors()
        try {
            const out = ec.service.sync().name(name).parameters(parameters).requireNewTransaction(true).disableAuthz().call()
            return ec.message.hasError()
                ? {out: out || {}, problem: hide(text(ec.message.getErrorsString()).split("\n")[0])}
                : {out: out || {}, problem: null}
        } catch (error) {
            return {out: {}, problem: hide(firstLine(error))}
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    const inNew = work => ec.transaction.runRequireNew(null, "A Smithy import write failed", work)

    // ===== the API =====
    const apiBase = () => text(System.getProperty("smithy_github_api") || "https://api.github.com").replace(/\/+$/, "")
    const recorded = base => !/^https?:\/\//.test(base)
    const recordName = path => path.replace(/^\/+/, "").replace(/[^A-Za-z0-9.-]+/g, "_") + ".json"
    /* One GET of the API: {status, headers (link and the rate limit's, lower case), body (parsed JSON or null)}. */
    function request(path, token) {
        const base = apiBase()
        if (recorded(base)) {
            const raw = ec.resource.getLocationReference(base + "/" + recordName(path))?.getText()
            if (raw == null) return {status: 404, headers: {}, body: {message: "Not Found"}}
            const answer = JSON.parse(raw)
            const headers = {}
            for (const [name, value] of Object.entries(answer.headers || {})) headers[name.toLowerCase()] = text(value)
            return {status: Number(answer.status || 200), headers, body: answer.body ?? null}
        }
        const response = ec.service
            .rest()
            .uri(base + path)
            .addHeader("Accept", "application/vnd.github+json")
            .addHeader("X-GitHub-Api-Version", "2022-11-28")
            .addHeader("User-Agent", "moqui-smithy-import")
            .addHeader("Authorization", "Bearer " + token)
            .timeout(30)
            // the GitHub API host is the operator's smithy_github_api, which may be a GitHub Enterprise on a private network
            .allowInternal()
            .call()
        const headers = {}
        for (const name of ["link", "x-ratelimit-remaining", "x-ratelimit-reset", "retry-after"])
            headers[name] = text(response.headerFirst(name))
        let body = null
        try {
            const raw = response.text()
            body = raw ? JSON.parse(raw) : null
        } catch (error) {
            body = null
        }
        return {status: Number(response.statusCode), headers, body}
    }
    /* The rate limit a response tells: limited (this request was refused for it) and until (epoch ms) when no request
       should be made before then. */
    function limitOf(response) {
        const remaining = response.headers["x-ratelimit-remaining"]
        const reset = Number(response.headers["x-ratelimit-reset"] || 0)
        const retry = Number(response.headers["retry-after"] || 0)
        const refused = response.status === 403 || response.status === 429
        const limited = refused && (remaining === "0" || retry > 0)
        let until = null
        if (refused && retry > 0) until = millis(now()) + retry * 1000
        else if (remaining === "0") until = reset > 0 ? reset * 1000 : millis(now()) + 60000
        if (until != null) until = Math.max(until, millis(now()) + 1000)
        return {limited, until}
    }
    /* A GitHub host as placeholders record it: lower case, without its api. (api.github.com is github.com). */
    const normalHost = host => lower(host).replace(/\.$/, "").replace(/^api\./, "")
    const hostOf = url => {
        const found = /^https?:\/\/([^/:?#@]+)(?::\d+)?(?:[/?#]|$)/i.exec(text(url).trim())
        return found ? normalHost(found[1]) : null
    }
    /* The GitHub the API reads from: github.com for api.github.com and for recorded responses, else the Enterprise
       Server's host. */
    const apiHost = () => (recorded(apiBase()) ? "github.com" : hostOf(apiBase()) || "github.com")
    /* A login as SmithyAccount keeps it: github.com's as it is, another host's as login@host. */
    const loginKey = (login, host) => (host === "github.com" ? login : login + "@" + host)
    const hostMatches = (row, host) => (row?.githubHost || "github.com") === host
    /* A token never shows in what is reported or logged. */
    const scrub = (ctx, value) => {
        let out = text(value)
        if (ctx?.token && ctx.token.length >= 4) out = out.split(ctx.token).join("[token]")
        return out
            .replace(/(https?:\/\/)[^/@\s]*@/gi, "$1[credential]@")
            .replace(/x-access-token:[^@\s]+@/gi, "x-access-token:[token]@")
            .replace(/\b(Basic|Bearer|token)\s+[A-Za-z0-9+/=._~-]{8,}/gi, "$1 [credential]")
            .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g, "[token]")
    }
    const hasNext = response => /rel="next"/.test(response.headers.link || "")
    const repoApi = run => {
        const [owner, name] = text(run.sourceRepository).split("/")
        return "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(name)
    }

    // ===== the token =====
    function storeToken(token) {
        const remote = ec.entity.makeValue(REMOTE)
        remote.setSequencedIdPrimary()
        remote.set("description", "Smithy GitHub import")
        remote.set("password", token)
        remote.create()
        return remote.systemMessageRemoteId
    }
    function tokenOf(run) {
        return run.tokenRemoteId ? text(one(REMOTE, {systemMessageRemoteId: run.tokenRemoteId})?.password) : ""
    }
    function dropToken(run) {
        if (!run.tokenRemoteId) return
        const remote = one(REMOTE, {systemMessageRemoteId: run.tokenRemoteId})
        if (remote) remote.delete()
        run.set("tokenRemoteId", null)
    }

    // ===== who asks =====
    /* The group of an import as the caller holds it: Not Found for one the caller may not view; accessDenied but for its
       Owners and operators (an operator holds the Owner's rank everywhere). */
    function ownerOf(siteId, groupId) {
        const g = core.group(groupId, siteId)
        core.requireRole(g, "SmrOwner")
        return g
    }
    function runFor(p, lock) {
        core.site(p.siteId)
        const run = typeof p.importId === "string" && p.importId ? one(RUN, {importId: p.importId}, lock) : null
        if (!run || run.siteId !== p.siteId) missing()
        const g = ownerOf(p.siteId, run.groupId)
        return {run, g}
    }
    function optionsOf(value) {
        if (value == null) return {issues: true, pullRequests: true}
        const NAMES = "options names issues, pullRequests and publishPrivate"
        if (typeof value !== "object" || Array.isArray(value)) invalid(NAMES)
        for (const name of Object.keys(value)) if (!["issues", "pullRequests", "publishPrivate"].includes(name)) invalid(NAMES)
        const out = {
            issues: value.issues == null ? true : flag(value.issues),
            pullRequests: value.pullRequests == null ? true : flag(value.pullRequests)
        }
        if (!out.issues && !out.pullRequests) invalid("options: Import issues, pull requests or both")
        // the Owner's word that a private GitHub repository's issues may be shown wider than to its own members
        if (flag(value.publishPrivate)) out.publishPrivate = true
        return out
    }

    // ===== the operations =====
    methods.startGitHubImport = p => {
        const g = ownerOf(p.siteId, p.groupId)
        const {partyId, access} = writer(p.siteId)
        const source = text(p.sourceRepository).trim()
        if (!sourceValid(source)) invalid("nameInvalid[sourceRepository]: Name a GitHub repository as owner/name")
        const token = text(p.token).trim()
        if (!token || token.length > 1000) invalid("token: A GitHub token that may read the repository is required")
        const options = optionsOf(p.options)
        // GitHub is asked before anything is locked or written: a slow answer holds no lock of the site's
        const answer = request(repoApi({sourceRepository: source}), token)
        const limit = limitOf(answer)
        if (answer.status === 401) invalid("sourceRefused: GitHub refused the token")
        // the run starts only once GitHub has said what the repository is (whether it is private among it): not while
        // its rate limit holds the token
        if (limit.limited)
            invalid("rateLimited: GitHub's rate limit holds this token now; start the import again once it resets")
        if (answer.status !== 200 || !answer.body)
            invalid("sourceRefused: GitHub has no repository " + source + " that the token may read")
        const facts = answer.body
        // the token goes to the API's host alone: a clone address elsewhere is no source this import fetches from
        if (facts.clone_url && !cloneOnApiHost(facts.clone_url))
            invalid("sourceRefused: GitHub's clone address for " + source + " is not on the API's host")
        const sourcePrivate = facts.private === true || (!!facts.visibility && facts.visibility !== "public")
        // the receipt keeps no trace of the token, not even its hash
        return receipt({...p, token: undefined}, "startGitHubImport", () => {
            // what one account, and one site, has running at once
            const running = Array.from(find(RUN, {siteId: p.siteId}).condition("statusId", "in", ACTIVE).limit(200).list())
            if (running.filter(run => run.startedByPartyId === partyId).length >= ACTIVE_PER_ACCOUNT)
                invalid("limitReached: You have as many imports running as one account may; wait for one to end")
            if (running.length >= ACTIVE_PER_SITE)
                invalid("limitReached: This site has as many imports running as it allows; try again later")
            let repositoryId
            let createdByImport = false
            if (given(p.repositoryId)) {
                const r = core.repository(p.repositoryId, p.siteId)
                if (!r.chain.some(group => group.groupId === g.group.groupId))
                    invalid("repositoryId: The repository is not in this group")
                core.requireRole(r, "SmrOwner")
                if (r.git.archivedDate) fail("Conflict", "repositoryArchived: This repository is archived")
                if (sourcePrivate && r.visibility < 3 && !options.publishPrivate)
                    invalid(
                        "policyRefused: " +
                            source +
                            " is private on GitHub and this repository is wider; import into a private one, or say publishPrivate"
                    )
                repositoryId = r.repo.repositoryId
            } else {
                if (sourcePrivate && g.visibility < 3 && !options.publishPrivate)
                    invalid(
                        "policyRefused: " +
                            source +
                            " is private on GitHub and this group is wider; import into a private group, or say publishPrivate"
                    )
                createdByImport = true
                lockNames(p.siteId)
                repositoryId = makeRepository({
                    siteId: p.siteId,
                    groupId: g.group.groupId,
                    slug: p.slug,
                    visibility: VISIBILITY_CODES[g.group.visibilityEnumId] || "private",
                    repositoryKind: core.settings(p.siteId).repositoryKind,
                    partyId,
                    access,
                    parent: g
                }).repositoryId
            }
            const active = Array.from(find(RUN, {siteId: p.siteId}).condition("statusId", "in", ACTIVE).limit(200).list()).filter(
                run => run.repositoryId === repositoryId || lower(run.sourceRepository) === lower(source)
            )
            if (active.length) fail("Conflict", "importActive: An import of this repository or this source is running")
            // the numbers are kept (design-smithy §8.4): a repository with issues or merge requests the import did not make
            // is refused, so no number of GitHub's can be taken by another
            const made = (entity, sourceType) =>
                find(entity, {repositoryId}).count() >
                find(MAP, {siteId: p.siteId, repositoryId, sourceType, statusId: "SmmDone"}).count()
            if (made(M + "SmithyIssue", "issue") || made(GMR, "pull"))
                fail(
                    "Conflict",
                    "numbersTaken: The repository has issues or merge requests of its own; import into one that has none"
                )
            const importId = ec.entity.sequencedIdPrimary(RUN, 0, 50)
            create(RUN, {
                importId,
                siteId: p.siteId,
                groupId: g.group.groupId,
                repositoryId,
                sourceEnumId: "SisGithub",
                sourceRepository: source,
                tokenRemoteId: storeToken(token),
                options: JSON.stringify(options),
                statusId: "SmiQueued",
                cursorJson: JSON.stringify({
                    fullName: text(facts.full_name) || source,
                    cloneUrl: text(facts.clone_url) || null,
                    defaultBranch: text(facts.default_branch) || null,
                    // importedHistory is set only on a repository the import made
                    createdByImport
                }),
                countsJson: "{}",
                reportJson: JSON.stringify({items: [], notCarried: {}}),
                waitingUntil: limit.until != null ? stamp(limit.until) : null,
                startedByPartyId: partyId,
                createdAt: now(),
                revision: 1
            })
            return {importId, repositoryId}
        })
    }
    function runView(run, full) {
        const repo = one(M + "SmithyRepository", {repositoryId: run.repositoryId})
        const view = {
            importId: run.importId,
            groupId: run.groupId,
            repositoryPath: repo?.repositoryPath || null,
            sourceRepository: run.sourceRepository,
            stage: STAGE_CODES[run.statusId] || null,
            createdAt: run.createdAt || null,
            finishedAt: run.finishedAt || null
        }
        if (!full) return view
        const report = json(run.reportJson, {})
        return {
            ...view,
            options: json(run.options, {}),
            counts: json(run.countsJson, {}),
            reportList: Array.from(report.items || []),
            notCarried: {...(report.notCarried || {}), never: NOT_CARRIED},
            waitingUntil: run.waitingUntil && millis(run.waitingUntil) > millis(now()) ? run.waitingUntil : null,
            running: !!run.leaseUntil && millis(run.leaseUntil) > millis(now()),
            revision: Number(run.revision || 1)
        }
    }
    methods.getGitHubImport = p => ({importRun: runView(runFor(p, false).run, true)})
    methods.findGitHubImports = p => {
        core.site(p.siteId)
        let query = find(RUN, {siteId: p.siteId})
        if (given(p.groupId)) query = query.condition("groupId", ownerOf(p.siteId, p.groupId).group.groupId)
        else if (!core.siteAccess(p.siteId, core.actor()).operator) denied("Name the group whose imports you own")
        const pg = page(p, "smithyImports:" + JSON.stringify([p.siteId, p.groupId || null]))
        const found = Array.from(
            query
                .orderBy("-createdAt,-importId")
                .offset(pg.offset)
                .limit(pg.limit + 1)
                .list()
        )
        return {
            importList: found.slice(0, pg.limit).map(run => runView(run, false)),
            nextCursor: found.length > pg.limit ? pg.next(pg.offset + pg.limit) : null
        }
    }
    function fresh(run, expected) {
        if (expected == null || expected === "" || Number(expected) !== Number(run.revision || 1))
            fail("Conflict", "staleRevision: This changed since you read it; reload and try again")
    }
    const leased = run => !!run.leaseUntil && millis(run.leaseUntil) > millis(now())
    methods.resumeGitHubImport = p => {
        writer(p.siteId)
        const {run} = runFor(p, true)
        fresh(run, p.expectedRevision)
        if (leased(run)) fail("Conflict", "importActive: A step of this import is running; try again shortly")
        if (run.statusId === "SmiDone") invalid("notAvailable: The import is done; start it again to bring what changed")
        const token = text(p.token).trim()
        if (token.length > 1000) invalid("token is too long")
        const fields = {revision: Number(run.revision || 1) + 1}
        if (token) {
            dropToken(run)
            fields.tokenRemoteId = storeToken(token)
        } else if (!run.tokenRemoteId) invalid("token: A GitHub token is needed to go on")
        if (ENDED.includes(run.statusId)) {
            const cursor = json(run.cursorJson, {})
            fields.statusId = ACTIVE.includes(cursor.stage) ? cursor.stage : "SmiQueued"
            fields.finishedAt = null
            fields.cursorJson = JSON.stringify({...cursor, errors: 0})
        }
        update(run, fields)
        return {stage: STAGE_CODES[run.statusId], revision: Number(run.revision)}
    }
    methods.cancelGitHubImport = p => {
        writer(p.siteId)
        const {run} = runFor(p, true)
        fresh(run, p.expectedRevision)
        if (!ENDED.includes(run.statusId)) {
            const cursor = json(run.cursorJson, {})
            dropToken(run)
            update(run, {
                cursorJson: JSON.stringify({...cursor, stage: run.statusId}),
                statusId: "SmiCancelled",
                finishedAt: now(),
                revision: Number(run.revision || 1) + 1
            })
            closeLeftovers(run)
        }
        return {stage: STAGE_CODES[run.statusId], revision: Number(run.revision || 1)}
    }
    /* The git host's merge requests a failed item left open (made with the head, the item rolled back before Smithy's row
       and conversation were written): closed, so none stays mergeable with no conversation. A resumed run opens its own
       again (openHosted takes a closed leftover of the same head back). */
    function closeLeftovers(run) {
        const starter = rows(ACCOUNT, {partyId: run.startedByPartyId}, 20).map(row => row.userId)
        if (!starter.length) return
        for (const mr of Array.from(
            find(GMR, {repositoryId: run.repositoryId})
                .condition("statusId", "in", ["GmrOpen", "GmrDraft"])
                .condition("authorUserId", "in", starter)
                .condition("pushedForReview", "Y")
                .limit(1000)
                .list()
        ))
            if (!one(SMR, {mergeRequestId: mr.mergeRequestId}) && mapPull(run, mr.mergeRequestNum))
                update(one(GMR, {mergeRequestId: mr.mergeRequestId}, true), {statusId: "GmrClosed", closedDate: now()})
    }
    /* Whether the run's map has a pull request item of that number that is not done (a failed one), by the report's
       row: the leftover is the import's, not a proposal of the account's own. */
    const mapPull = (run, number) => {
        // the row by its key, its status read here: a find by the whole key answers the row whatever else it names
        const row = one(MAP, {siteId: run.siteId, repositoryId: run.repositoryId, sourceType: "pullNumber", sourceId: text(number)})
        return !!row && row.statusId !== "SmmDone"
    }

    // ===== a step =====
    /* run#Import: a step of an import, as the account that started it. Takes at most budget API requests (10). Answers the
       stage, waitingUntil, and done when the run has ended. */
    function runStep(p) {
        const importId = text(p.importId)
        const claimed = inNew(() => claim(importId))
        if (!claimed.ctx) return claimed.result
        const ctx = claimed.ctx
        ctx.budget = Math.min(Math.max(Number(p.budget || BUDGET), 1), 200)
        try {
            advance(ctx)
        } catch (error) {
            ec.message.clearErrors()
            const problem = scrub(ctx, firstLine(error))
            ec.logger.error("Smithy import " + importId + " step failed: " + problem)
            ctx.cursor.errors = Number(ctx.cursor.errors || 0) + 1
            if (ctx.cursor.errors >= MAX_ERRORS) end(ctx, "SmiFailed", "run", importId, "The import failed: " + problem)
        } finally {
            inNew(() => save(ctx))
        }
        return {
            stage: STAGE_CODES[ctx.statusId],
            waitingUntil: ctx.waitingUntil != null ? stamp(ctx.waitingUntil) : null,
            requests: ctx.requests,
            done: ENDED.includes(ctx.statusId)
        }
    }
    function claim(importId) {
        const run = importId ? one(RUN, {importId}, true) : null
        if (!run) missing()
        const stage = STAGE_CODES[run.statusId]
        if (ENDED.includes(run.statusId)) return {result: {stage, done: true, requests: 0}}
        if (run.waitingUntil && millis(run.waitingUntil) > millis(now()))
            return {result: {stage, waitingUntil: run.waitingUntil, requests: 0, done: false}}
        if (leased(run)) return {result: {stage, running: true, requests: 0, done: false}}
        if (me() !== run.startedByPartyId) return {result: {stage, refused: true, requests: 0, done: false}}
        update(run, {leaseUntil: stamp(millis(now()) + LEASE_MS), waitingUntil: null})
        const ctx = {
            importId,
            siteId: run.siteId,
            groupId: run.groupId,
            repositoryId: run.repositoryId,
            sourceRepository: run.sourceRepository,
            api: repoApi(run),
            token: tokenOf(run),
            options: json(run.options, {issues: true, pullRequests: true}),
            statusId: run.statusId,
            cursor: json(run.cursorJson, {}),
            counts: json(run.countsJson, {}),
            report: json(run.reportJson, {items: [], notCarried: {}}),
            waitingUntil: null,
            requests: 0,
            host: apiHost()
        }
        const stop = errorText => end(ctx, "SmiFailed", "run", importId, errorText)
        // what the run writes into must still be there and open to it, and the account that started it must still own
        // the group (an operator owns every group) with a confirmed address; else the run fails (a resume goes on)
        const g = one(M + "SmithyGroup", {groupId: run.groupId})
        const repo = one(M + "SmithyRepository", {repositoryId: run.repositoryId})
        const git = repo ? one("moqui.resource.GitRepository", {repositoryId: run.repositoryId}) : null
        const groupRights = g ? core.groupRights(g, core.actor()) : null
        const repoRights = repo ? core.repositoryRights(repo, core.actor()) : null
        if (!repo || !git || repo.siteId !== run.siteId) stop("repositoryGone: The repository the import fills is gone")
        else if (!core.mounted(run.siteId)) stop("accessLost: This site no longer runs Smithy")
        else if (!g || groupRights.rank < RANK.SmrOwner)
            stop("accessLost: The account that started the import no longer owns the group")
        else if (groupRights.hidden || repoRights.hidden)
            stop("repositoryHidden: The repository or its group is hidden by a moderator")
        else if (git.archivedDate) stop("repositoryArchived: The repository is archived")
        else if (
            !ec.resource.script("component://mr-mantle/service/mantle/public/ConfirmedAddress.js").confirmed(ec.user.userId)
        )
            stop("addressUnconfirmed: The account that started the import has no confirmed address")
        else if (!ctx.token) stop("sourceRefused: The run has no token")
        return {ctx}
    }
    function save(ctx) {
        const run = one(RUN, {importId: ctx.importId}, true)
        if (!run) return
        const cancelled = run.statusId === "SmiCancelled"
        const ended = ENDED.includes(ctx.statusId)
        const fields = {
            cursorJson: JSON.stringify(ctx.cursor),
            countsJson: JSON.stringify(ctx.counts),
            reportJson: JSON.stringify(ctx.report),
            leaseUntil: null,
            waitingUntil: ctx.waitingUntil != null ? stamp(ctx.waitingUntil) : null
        }
        if (!cancelled) fields.statusId = ctx.statusId
        if (ended && !cancelled) {
            fields.finishedAt = now()
            dropToken(run)
            fields.tokenRemoteId = null
        }
        update(run, fields)
        // a run that ended (done or failed) leaves no hosted merge request of a failed item open, as a cancel does not
        if (ended && !cancelled) closeLeftovers(run)
    }
    function end(ctx, statusId, sourceType, sourceId, errorText) {
        if (statusId !== "SmiDone") ctx.cursor.stage = ctx.statusId
        ctx.statusId = statusId
        if (errorText) note(ctx, sourceType, sourceId, errorText)
    }
    function note(ctx, sourceType, sourceId, errorText) {
        const items = (ctx.report.items = ctx.report.items || [])
        if (items.length < REPORT_LIMIT)
            items.push({sourceType, sourceId: text(sourceId), errorText: scrub(ctx, errorText).slice(0, 500)})
        else ctx.report.more = Number(ctx.report.more || 0) + 1
    }
    function count(ctx, type, field, by = 1) {
        const row = (ctx.counts[type] = ctx.counts[type] || {imported: 0, source: 0, failed: 0})
        row[field] = Number(row[field] || 0) + by
    }
    function notCarried(ctx, kind, what) {
        const by = (ctx.report.notCarried = ctx.report.notCarried || {})
        const counts = (by[kind] = by[kind] || {})
        counts[what] = Number(counts[what] || 0) + 1
    }
    function setStage(ctx, statusId, cursor) {
        ctx.statusId = statusId
        ctx.cursor = {...cursorFacts(ctx.cursor), ...(cursor || {})}
    }
    const cursorFacts = cursor => ({
        fullName: cursor.fullName,
        cloneUrl: cursor.cloneUrl,
        defaultBranch: cursor.defaultBranch,
        createdByImport: cursor.createdByImport === true,
        projectId: cursor.projectId,
        scopeId: cursor.scopeId,
        errors: 0
    })
    /* One GET as a step's request: null when the rate limit stops the step (the cursor stays), else the response. A
       refusal the run cannot get past ends it. */
    function get(ctx, path) {
        ctx.requests++
        const response = request(ctx.api + path, ctx.token)
        const limit = limitOf(response)
        if (limit.until != null) ctx.waitingUntil = limit.until
        if (limit.limited) return null
        if (response.status === 401) {
            end(ctx, "SmiFailed", "run", ctx.importId, "sourceRefused: GitHub refused the token; resume with another")
            return null
        }
        if (response.status >= 500 || response.status === 403) {
            ctx.cursor.errors = Number(ctx.cursor.errors || 0) + 1
            if (ctx.cursor.errors >= MAX_ERRORS)
                end(ctx, "SmiFailed", "run", ctx.importId, "GitHub answered " + response.status + " to " + path)
            return null
        }
        ctx.cursor.errors = 0
        return response
    }
    const canRequest = ctx => ctx.requests < ctx.budget && ctx.waitingUntil == null && ACTIVE.includes(ctx.statusId)
    function advance(ctx) {
        while (ACTIVE.includes(ctx.statusId) && ctx.waitingUntil == null) {
            const current = one(RUN, {importId: ctx.importId})
            if (!current || current.statusId === "SmiCancelled") return
            const before = JSON.stringify([ctx.statusId, ctx.cursor])
            if (ctx.statusId !== "SmiLinks" && ctx.requests >= ctx.budget) return
            STAGES[ctx.statusId](ctx)
            // a stage that moved nothing (a request that will be tried again) ends the step
            if (JSON.stringify([ctx.statusId, ctx.cursor]) === before) return
        }
    }

    // ===== the stages =====
    const STAGES = {
        SmiQueued(ctx) {
            const answer = get(ctx, "/issues?state=all&sort=created&direction=desc&per_page=1")
            if (!answer) return
            const highest = Math.max(0, ...Array.from(answer.body || []).map(item => Number(item.number) || 0))
            const facts = inNew(() => {
                const repo = one(M + "SmithyRepository", {repositoryId: ctx.repositoryId}, true)
                // what is filed here while the run goes on takes a number past GitHub's
                if (Number(repo.nextIssueNumber || 1) <= highest) update(repo, {nextIssueNumber: highest + 1})
                return {projectId: kit.issues.issueProject(repo), scopeId: core.scopeCategory(repo)}
            })
            Object.assign(ctx.cursor, facts)
            setStage(ctx, ctx.options.issues ? "SmiLabels" : ctx.options.pullRequests ? "SmiPulls" : "SmiLinks", {
                phase: "labels",
                page: 1
            })
        },
        SmiLabels(ctx) {
            const phase = ctx.cursor.phase || "labels"
            const answer = get(
                ctx,
                phase === "labels"
                    ? "/labels?per_page=" + PAGE + "&page=" + Number(ctx.cursor.page || 1)
                    : "/milestones?state=all&per_page=" + PAGE + "&page=" + Number(ctx.cursor.page || 1)
            )
            if (!answer) return
            for (const item of Array.from(answer.body || []))
                if (phase === "labels") each(ctx, "label", item.id, () => importLabel(ctx, item))
                else each(ctx, "milestone", item.id, () => importMilestone(ctx, item))
            if (hasNext(answer)) ctx.cursor.page = Number(ctx.cursor.page || 1) + 1
            else if (phase === "labels") Object.assign(ctx.cursor, {phase: "milestones", page: 1})
            else setStage(ctx, "SmiIssues", {page: 1})
        },
        SmiIssues(ctx) {
            const answer = get(
                ctx,
                "/issues?state=all&sort=created&direction=asc&per_page=" + PAGE + "&page=" + Number(ctx.cursor.page || 1)
            )
            if (!answer) return
            for (const item of Array.from(answer.body || [])) {
                if (item.pull_request) {
                    // a pull request's own item: its reactions are read with the pull requests'
                    if (ctx.options.pullRequests && Number(item.reactions?.total_count || 0) > 0)
                        inNew(() => markDue(ctx, "issue:" + Number(item.number), null))
                    continue
                }
                each(ctx, "issue", item.id, () => importIssue(ctx, item))
            }
            if (hasNext(answer)) ctx.cursor.page = Number(ctx.cursor.page || 1) + 1
            else setStage(ctx, ctx.options.pullRequests ? "SmiPulls" : "SmiComments", {phase: "list", page: 1})
        },
        SmiPulls(ctx) {
            if ((ctx.cursor.phase || "list") === "list") {
                const answer = get(
                    ctx,
                    "/pulls?state=all&sort=created&direction=asc&per_page=" + PAGE + "&page=" + Number(ctx.cursor.page || 1)
                )
                if (!answer) return
                const pulls = Array.from(answer.body || [])
                holdPulls(ctx, pulls)
                fetchHeads(ctx, pulls)
                for (const pull of pulls) each(ctx, "pull", pull.id, () => importPull(ctx, pull))
                if (hasNext(answer)) ctx.cursor.page = Number(ctx.cursor.page || 1) + 1
                else Object.assign(ctx.cursor, {phase: "reviews", after: null, page: 1})
                return
            }
            // the reviews of each pull request made, one request a pull request
            let query = find(MAP, {siteId: ctx.siteId, repositoryId: ctx.repositoryId, sourceType: "pull", statusId: "SmmDone"})
            if (ctx.cursor.after) query = query.condition("sourceId", "greater", ctx.cursor.after)
            const next = Array.from(query.orderBy("sourceId").limit(1).list())[0]
            if (!next) return setStage(ctx, "SmiComments", {phase: "issueComments", page: 1})
            const mr = one(GMR, {mergeRequestId: next.targetId})
            if (!mr) return Object.assign(ctx.cursor, {after: next.sourceId, page: 1})
            const answer = get(
                ctx,
                "/pulls/" + Number(mr.mergeRequestNum) + "/reviews?per_page=" + PAGE + "&page=" + Number(ctx.cursor.page || 1)
            )
            if (!answer) return
            for (const review of Array.from(answer.body || []))
                each(ctx, "review", review.id, () => importReview(ctx, mr, review))
            if (hasNext(answer)) ctx.cursor.page = Number(ctx.cursor.page || 1) + 1
            else Object.assign(ctx.cursor, {after: next.sourceId, page: 1})
        },
        SmiComments(ctx) {
            const phase = ctx.cursor.phase || "issueComments"
            if (phase === "reactions") return reactionsUnit(ctx)
            const answer = get(
                ctx,
                (phase === "issueComments" ? "/issues/comments" : "/pulls/comments") +
                    "?sort=created&direction=asc&per_page=" +
                    PAGE +
                    "&page=" +
                    Number(ctx.cursor.page || 1)
            )
            if (!answer) return
            for (const item of Array.from(answer.body || []))
                if (phase === "issueComments") each(ctx, "comment", item.id, () => importComment(ctx, item))
                else if (ctx.options.pullRequests) each(ctx, "reviewComment", item.id, () => importReviewComment(ctx, item))
            if (hasNext(answer)) ctx.cursor.page = Number(ctx.cursor.page || 1) + 1
            else if (phase === "issueComments" && ctx.options.pullRequests)
                Object.assign(ctx.cursor, {phase: "reviewComments", page: 1})
            else Object.assign(ctx.cursor, {phase: "reactions", after: null, page: 1})
        },
        SmiLinks(ctx) {
            inNew(() => finish(ctx))
            end(ctx, "SmiDone")
        }
    }

    // ===== an item =====
    function mapRow(ctx, sourceType, sourceId) {
        return one(MAP, {siteId: ctx.siteId, repositoryId: ctx.repositoryId, sourceType, sourceId: text(sourceId)})
    }
    function mark(ctx, sourceType, sourceId, fields) {
        const key = {siteId: ctx.siteId, repositoryId: ctx.repositoryId, sourceType, sourceId: text(sourceId)}
        const row = one(MAP, key, true)
        const values = {importId: ctx.importId, errorText: null, ...fields}
        return row ? update(row, values) : create(MAP, {...key, ...values})
    }
    const target = (ctx, sourceType, sourceId) => {
        const row = sourceId == null ? null : mapRow(ctx, sourceType, sourceId)
        return row && row.statusId === "SmmDone" ? row.targetId : null
    }
    /* A source item in a transaction of its own: nothing when its row says it is done or skipped; a failure is rolled back
       and kept on its row and in the report, and the run goes on. The work answers {problem} to report what it carried
       only in part. */
    function each(ctx, sourceType, sourceId, work) {
        count(ctx, sourceType, "source")
        const had = mapRow(ctx, sourceType, sourceId)
        if (had && ["SmmDone", "SmmSkipped"].includes(had.statusId)) return
        let out
        try {
            out = inNew(work) || {}
        } catch (error) {
            ec.message.clearErrors()
            const problem = scrub(ctx, firstLine(error))
            ec.logger.warn("Smithy import " + ctx.importId + ": " + sourceType + " " + sourceId + " was not carried: " + problem)
            inNew(() => mark(ctx, sourceType, sourceId, {statusId: "SmmFailed", errorText: problem}))
            count(ctx, sourceType, "failed")
            note(ctx, sourceType, sourceId, problem)
            // a cap of the run (its placeholders) ends it: every item after would fail the same way
            if (/^limitReached: /.test(problem)) end(ctx, "SmiFailed", "run", ctx.importId, problem)
            return
        }
        if (out.skipped) return
        count(ctx, sourceType, "imported")
        if (out.problem) note(ctx, sourceType, sourceId, out.problem)
    }

    // ===== people =====
    /* The party of a GitHub user in the site, of the GitHub the API reads (githubHost): the account with that GitHub id (a
       placeholder, or the account that claimed it), whose login is brought up to date (a login can be renamed and then
       taken by another user; the id is not); else the account with that login and no id known; else a new placeholder,
       the login taken from a row of another id that still had it. A placeholder is no member of the site and its profile
       is not discoverable: it is shown only as the author of what it wrote (SmithyCore.authorShown). */
    function personOf(ctx, user) {
        const host = ctx.host || apiHost()
        const login = lower(user?.login) || "ghost"
        const key = loginKey(login, host)
        const githubUserId = user?.id != null ? text(user.id) : null
        const siteId = ctx.siteId
        const byId = () =>
            githubUserId
                ? Array.from(find(M + "SmithyAccount", {siteId, githubUserId}).limit(20).list()).find(row => hostMatches(row, host))
                : null
        const byLogin = () => {
            const row = one(M + "SmithyAccount", {siteId, githubLogin: key})
            return row && !row.githubUserId ? row : null
        }
        const known = () => {
            const found = byId()
            if (found) {
                if (found.githubLogin !== key) relogin(siteId, found, key)
                return found
            }
            return byLogin()
        }
        let account = known()
        if (account) return account.partyId
        lockNames(siteId)
        account = known()
        if (account) return account.partyId
        if (Number(ctx.counts.user?.imported || 0) >= PLACEHOLDERS_PER_RUN)
            throw coded("limitReached", "The run has made as many placeholder accounts as one run may (" + PLACEHOLDERS_PER_RUN + ")")
        const partyId = call("mantle.party.PartyServices.create#Person", {
            firstName: login.slice(0, 60),
            lastName: "(imported)"
        }).partyId
        create(S + "PublicSiteProfile", {
            siteId,
            partyId,
            handle: handleFor(siteId, login),
            displayName: text(user?.login) || login,
            discoverability: "hidden",
            revision: 1
        })
        // the login is this id's now: a row of another id that had it loses it
        const holder = one(M + "SmithyAccount", {siteId, githubLogin: key}, true)
        if (holder) update(holder, {githubLogin: null})
        create(M + "SmithyAccount", {
            siteId,
            partyId,
            githubLogin: key,
            githubUserId,
            githubHost: host,
            placeholder: "Y",
            revision: 1
        })
        mark(ctx, "user", githubUserId || key, {targetType: "party", targetId: partyId, statusId: "SmmDone"})
        count(ctx, "user", "imported")
        return partyId
    }
    /* A known id's login as GitHub names it now, taken from any other row of the site that had it. */
    function relogin(siteId, account, key) {
        const holder = one(M + "SmithyAccount", {siteId, githubLogin: key}, true)
        if (holder && holder.partyId !== account.partyId) update(holder, {githubLogin: null})
        update(one(M + "SmithyAccount", {siteId, partyId: account.partyId}, true), {githubLogin: key})
    }
    /* A placeholder's handle (§18.2): the login when it is a valid, free handle, else gh-<login> cut to 32 characters,
       with a digit suffix when that is taken. The caller has locked the site's names. */
    function handleFor(siteId, login) {
        const free = handle => core.HANDLE.test(handle) && core.nameFree(siteId, handle, null, "handle")
        if (free(login)) return login
        const base = ("gh-" + login.replace(/[^a-z0-9_-]+/g, "-").replace(/-+$/, "")).slice(0, 32)
        if (free(base)) return base
        for (let n = 2; n < 1000; n++) {
            const candidate = base.slice(0, 32 - String(n).length) + n
            if (free(candidate)) return candidate
        }
        return (
            "gh-" +
            forum
                .id()
                .toLowerCase()
                .replace(/[^a-z0-9]/g, "")
                .slice(0, 20)
        )
    }

    // ===== text =====
    /* A text as an import carries it: Markdown rendered and cleaned, the site's rules applied in the scope; a block rule's
       text is left out (refused). No hold: imported text is history. */
    function textOf(ctx, source) {
        const raw = text(source)
        if (!raw.trim()) return {html: "", source: "", refused: false}
        const ruled = forum.applyRules(ctx.siteId, ctx.cursor.scopeId || null, forum.renderSource("markdown", raw))
        if (ruled.block) return {html: forum.renderSource("markdown", NOT_CARRIED_TEXT), source: NOT_CARRIED_TEXT, refused: true}
        return {html: text(ruled.body), source: raw, refused: false}
    }
    function titleOf(ctx, title) {
        const raw = text(title).replace(/\s+/g, " ").trim().slice(0, 250) || "(no title)"
        const ruled = forum.applyRules(ctx.siteId, ctx.cursor.scopeId || null, raw)
        return ruled.block ? "(title not carried)" : text(ruled.body)
    }
    const refusedProblem = (...texts) =>
        texts.some(item => item?.refused) ? "textRefused: A rule of this site refused a text; it was left out" : null

    // ===== the conversation =====
    /* A record topic (kind record, in the repository's scope) whose first post is the text, by its author at its date. */
    function openRecord(ctx, author, date, title, body) {
        const postId = forum.id()
        create(E + "CommunicationEvent", {
            communicationEventId: postId,
            communicationEventTypeId: "Message",
            contactListId: null,
            fromPartyId: author,
            subject: title,
            body: body.html,
            statusId: "CeReceived",
            entryDate: stamp(date)
        })
        create(F + "ForumTopic", {
            rootCommEventId: postId,
            siteId: ctx.siteId,
            contactListId: ctx.cursor.scopeId || null,
            kind: "record",
            revision: 1,
            nextOrdinal: 2,
            visiblePostCount: 1,
            reactionCount: 0,
            lastActivity: stamp(date),
            pinned: "N",
            unlisted: "N"
        })
        create(F + "ForumPostState", {
            communicationEventId: postId,
            rootCommEventId: postId,
            ordinal: 1,
            revision: 1,
            visibility: "approved",
            approvedRevision: 1,
            wiki: "N",
            reactionCount: 0
        })
        create(F + "ForumPostRevision", {
            communicationEventId: postId,
            revision: 1,
            sourceFormat: "markdown",
            sourceText: body.source,
            sanitizedBody: body.html,
            editorPartyId: author,
            editedAt: stamp(date),
            publicHistoryAllowed: "Y"
        })
        return postId
    }
    /* A post of a record topic: o.author, o.date (ms), o.body ({html, source}) or o.line (a state line, kind event),
       o.parent (the post it answers; the first post when empty). */
    function addPost(rootCommEventId, o) {
        const topic = one(F + "ForumTopic", {rootCommEventId}, true)
        if (!topic) throw coded("noRecord", "The conversation is not there")
        const root = one(E + "CommunicationEvent", {communicationEventId: rootCommEventId})
        const postId = forum.id()
        const ordinal = Number(topic.nextOrdinal || 2)
        const html = o.line != null ? o.line : o.body.html
        create(E + "CommunicationEvent", {
            communicationEventId: postId,
            communicationEventTypeId: "Message",
            contactListId: null,
            fromPartyId: o.author || null,
            rootCommEventId,
            parentCommEventId: o.parent || rootCommEventId,
            subject: root?.subject || null,
            body: html,
            statusId: "CeReceived",
            entryDate: stamp(o.date)
        })
        create(F + "ForumPostState", {
            communicationEventId: postId,
            rootCommEventId,
            ordinal,
            revision: 1,
            visibility: "approved",
            approvedRevision: 1,
            wiki: "N",
            reactionCount: 0,
            ...(o.line != null ? {postKind: "event"} : {})
        })
        if (o.line == null)
            create(F + "ForumPostRevision", {
                communicationEventId: postId,
                revision: 1,
                sourceFormat: "markdown",
                sourceText: o.body.source,
                sanitizedBody: o.body.html,
                editorPartyId: o.author || null,
                editedAt: stamp(o.date),
                publicHistoryAllowed: "Y"
            })
        update(topic, {
            nextOrdinal: ordinal + 1,
            visiblePostCount: Number(topic.visiblePostCount || 0) + (o.line != null ? 0 : 1),
            lastActivity: millis(topic.lastActivity) > o.date ? topic.lastActivity : stamp(o.date),
            revision: Number(topic.revision || 1) + 1
        })
        return postId
    }
    /* The first post of the issue or the merge request numbered n here: an issue first, then a merge request (§8.4). */
    function recordOf(ctx, number) {
        const issue = one(M + "SmithyIssue", {repositoryId: ctx.repositoryId, issueNumber: Number(number)})
        if (issue) return issue.rootCommEventId
        const mr = Array.from(
            find(GMR, {repositoryId: ctx.repositoryId, mergeRequestNum: Number(number)})
                .limit(1)
                .list()
        )[0]
        return mr ? one(SMR, {mergeRequestId: mr.mergeRequestId})?.rootCommEventId || null : null
    }
    /* An item whose reactions are still to read (sourceId issue:n or comment:id). */
    function markDue(ctx, sourceId, postId) {
        if (mapRow(ctx, "reactionsDue", sourceId)) return
        mark(ctx, "reactionsDue", sourceId, {targetType: "post", targetId: postId, statusId: null})
    }

    // ===== labels and milestones =====
    function colorOf(hex) {
        const value = /^[0-9a-f]{6}$/i.test(text(hex)) ? text(hex) : "888888"
        const [r, g, b] = [0, 2, 4].map(at => parseInt(value.slice(at, at + 2), 16) / 255)
        const high = Math.max(r, g, b)
        const low = Math.min(r, g, b)
        if (high - low < 0.15) return "grey"
        let hue = high === r ? ((g - b) / (high - low)) % 6 : high === g ? (b - r) / (high - low) + 2 : (r - g) / (high - low) + 4
        hue = (hue * 60 + 360) % 360
        return LABEL_COLORS.find(([upTo]) => hue < upTo)?.[1] || "red"
    }
    function importLabel(ctx, item) {
        const name = titleOf(ctx, text(item.name).replace(/[<>]/g, "")).slice(0, 100)
        // a label of that name the repository has is the one
        for (const own of rows(M + "SmithyLabel", {repositoryId: ctx.repositoryId}, 500)) {
            const label = one(WORK + "WorkEffortCategory", {workEffortCategoryId: own.workEffortCategoryId})
            if (lower(label?.description) === lower(name)) {
                mark(ctx, "label", item.id, {targetType: "label", targetId: own.workEffortCategoryId, statusId: "SmmDone"})
                return {}
            }
        }
        const labelId = call("create#" + WORK + "WorkEffortCategory", {
            categoryTypeEnumId: "WcatLabel",
            description: name,
            colorName: colorOf(item.color),
            ownerPartyId: one(WORK + "WorkEffort", {workEffortId: ctx.cursor.projectId})?.ownerPartyId || null
        }).workEffortCategoryId
        create(M + "SmithyLabel", {
            repositoryId: ctx.repositoryId,
            workEffortCategoryId: labelId,
            siteId: ctx.siteId,
            description: text(item.description).replace(/[<>]/g, "").slice(0, 255) || null
        })
        mark(ctx, "label", item.id, {targetType: "label", targetId: labelId, statusId: "SmmDone"})
        return {}
    }
    function importMilestone(ctx, item) {
        const name = titleOf(ctx, item.title).slice(0, 255)
        const mine = rows(M + "SmithyMilestone", {repositoryId: ctx.repositoryId}, 500)
            .map(own => one(WORK + "WorkEffort", {workEffortId: own.workEffortId}))
            .find(row => lower(row?.workEffortName) === lower(name))
        let milestoneId = mine?.workEffortId
        if (!milestoneId) {
            milestoneId = call("mantle.work.ProjectServices.create#Milestone", {
                rootWorkEffortId: ctx.cursor.projectId,
                workEffortName: name.replace(/[<>]/g, "") || "Milestone " + Number(item.number)
            }).workEffortId
            create(M + "SmithyMilestone", {repositoryId: ctx.repositoryId, workEffortId: milestoneId, siteId: ctx.siteId})
            // the values as GitHub has them, and a closed one closed, on the row: no status rule runs for history
            const closed = item.state === "closed"
            update(one(WORK + "WorkEffort", {workEffortId: milestoneId}), {
                workEffortName: name,
                description: plainText(textOf(ctx, item.description).html).slice(0, 4000) || null,
                estimatedCompletionDate: item.due_on ? stamp(when(item.due_on)) : null,
                ...(closed ? {statusId: "WeComplete", actualCompletionDate: stamp(when(item.closed_at))} : {})
            })
        }
        mark(ctx, "milestone", item.id, {targetType: "milestone", targetId: milestoneId, statusId: "SmmDone"})
        return {}
    }

    // ===== issues =====
    /* GitHub's state and reason as a task's status and resolution (§8.5). */
    function issueState(item) {
        if (item.state !== "closed") return ["WeInPlanning", "WerUnresolved"]
        if (item.state_reason === "not_planned") return ["WeCancelled", "WerWontComplete"]
        if (item.state_reason === "duplicate") return ["WeCancelled", "WerDuplicate"]
        return ["WeComplete", "WerCompleted"]
    }
    const STATE_LINES = {WeComplete: "closed as completed", WeCancelled: "closed as not planned"}
    function importIssue(ctx, item) {
        const number = Number(item.number)
        if (!Number.isInteger(number) || number < 1) throw coded("numberInvalid", "The issue has no number")
        if (one(M + "SmithyIssue", {repositoryId: ctx.repositoryId, issueNumber: number}))
            throw coded("numberTaken", "Issue #" + number + " is there already in this repository")
        const author = personOf(ctx, item.user)
        const created = when(item.created_at)
        const title = titleOf(ctx, item.title)
        const body = textOf(ctx, item.body)
        const postId = openRecord(ctx, author, created, title, body)
        const projectId = ctx.cursor.projectId
        const workEffortId = projectId + "-" + ec.entity.sequencedIdPrimary("Project_" + projectId, null, 1)
        // the row first: the task's own rule (ensure#Issue) then finds its issue there
        create(M + "SmithyIssue", {
            repositoryId: ctx.repositoryId,
            issueNumber: number,
            siteId: ctx.siteId,
            workEffortId,
            rootCommEventId: postId,
            confidential: "N",
            reporterPartyId: author,
            createdAt: stamp(created),
            revision: 1
        })
        const [statusId, resolutionEnumId] = issueState(item)
        call("mantle.work.TaskServices.create#Task", {
            workEffortId,
            rootWorkEffortId: projectId,
            workEffortName: "Issue #" + number,
            visibilityEnumId: "WevGeneral",
            ownerPartyId: author
        })
        // the title and the text's copy have any characters (a '<' among them), and the final state is history: the row's
        // values, so no status rule writes a line or a notice now
        update(one(WORK + "WorkEffort", {workEffortId}), {
            workEffortName: title,
            description: plainText(body.html).slice(0, 30000) || null,
            statusId,
            resolutionEnumId,
            actualCompletionDate: item.state === "closed" ? stamp(when(item.closed_at)) : null
        })
        for (const label of Array.from(item.labels || [])) {
            const labelId = target(ctx, "label", label?.id)
            if (labelId && !one(WORK + "WorkEffortCategoryAppl", {workEffortId, workEffortCategoryId: labelId}))
                create(WORK + "WorkEffortCategoryAppl", {workEffortId, workEffortCategoryId: labelId})
        }
        const milestoneId = target(ctx, "milestone", item.milestone?.id)
        if (milestoneId)
            create(WORK + "WorkEffortAssoc", {
                workEffortId: milestoneId,
                toWorkEffortId: workEffortId,
                workEffortAssocTypeEnumId: "WeatMilestone",
                fromDate: stamp(created)
            })
        for (const user of Array.from(item.assignees || [])) {
            const partyId = personOf(ctx, user)
            if (!one(WORK + "WorkEffortParty", {workEffortId, partyId, roleTypeId: "Assignee"}))
                create(WORK + "WorkEffortParty", {
                    workEffortId,
                    partyId,
                    roleTypeId: "Assignee",
                    fromDate: stamp(created),
                    statusId: "WeptAssigned"
                })
        }
        if (item.state === "closed") addPost(postId, {line: STATE_LINES[statusId] || "closed", date: when(item.closed_at)})
        if (Number(item.reactions?.total_count || 0) > 0) markDue(ctx, "issue:" + number, postId)
        mark(ctx, "issue", item.id, {targetType: "issue", targetId: postId, statusId: "SmmDone"})
        return {problem: refusedProblem(body)}
    }
    function importComment(ctx, item) {
        const number = Number((/\/issues\/(\d+)$/.exec(text(item.issue_url)) || [])[1])
        const root = number ? recordOf(ctx, number) : null
        if (!root) {
            // a comment of a pull request that was not to be imported
            if (!ctx.options.pullRequests && !one(M + "SmithyIssue", {repositoryId: ctx.repositoryId, issueNumber: number})) {
                mark(ctx, "comment", item.id, {statusId: "SmmSkipped"})
                return {skipped: true}
            }
            throw coded("noRecord", "The comment's issue or pull request #" + number + " was not imported")
        }
        const body = textOf(ctx, item.body)
        const postId = addPost(root, {author: personOf(ctx, item.user), date: when(item.created_at), body})
        if (Number(item.reactions?.total_count || 0) > 0) markDue(ctx, "comment:" + item.id, postId)
        mark(ctx, "comment", item.id, {targetType: "post", targetId: postId, statusId: "SmmDone"})
        return {problem: refusedProblem(body)}
    }

    // ===== pull requests =====
    const FETCH_REFS = GIT + "fetch#GitRefs"
    const plainTitle = title => text(title).replace(/[<>]/g, "").trim().slice(0, 250) || "Merge request"
    const headRefOf = number => "refs/merge-requests/" + number + "/head"
    /* The git host's merge request of a pull request number when it is this import's: the run's map names it (the hold
       of openHosted, or a failed item's leftover) and Smithy has no row of it yet. */
    function heldRow(ctx, number) {
        const row = Array.from(find(GMR, {repositoryId: ctx.repositoryId, mergeRequestNum: number}).limit(1).list())[0]
        if (!row) return {row: null, ours: false}
        const mapped = mapRow(ctx, "pullNumber", number)
        const ours =
            !!mapped && mapped.targetId === row.mergeRequestId && !!row.importedByUserId && !one(SMR, {mergeRequestId: row.mergeRequestId})
        return {row, ours}
    }
    /* The pull requests of a page that are not carried yet, each held by its number in the git host before its head is
       fetched (openHosted), so the fetch writes the head of a merge request of this import and of no other. The
       repository reads commits by id through its refs only from now on (reviewHiddenDate, as a hidden merge request
       would set it), so a commit that is only another fork's or a hidden merge request's is not present to the import. */
    function holdPulls(ctx, pulls) {
        if (pulls.length)
            ec.entity
                .find("moqui.resource.GitRepository")
                .condition("repositoryId", ctx.repositoryId)
                .condition("reviewHiddenDate", null)
                .disableAuthz()
                .updateAll({reviewHiddenDate: now()})
        for (const pull of pulls) {
            const number = Number(pull.number)
            const done = mapRow(ctx, "pull", pull.id)
            if (!Number.isInteger(number) || number < 1 || (done && ["SmmDone", "SmmSkipped"].includes(done.statusId))) continue
            // what it refuses is the item's, reported when the item is taken (importPull holds it again)
            openHosted(ctx, number, text(pull.head?.sha), pull)
        }
    }
    /* What fetchHeads asks for of a page of pull requests: refs/pull/<n>/head into refs/merge-requests/<n>/head for each
       merge request this import holds (heldRow) with no head whose commit the repository does not read yet; never one
       of a number another merge request has, one with a head, or one of a pull request already carried. */
    function headRefMap(ctx, pulls) {
        const refMap = {}
        for (const pull of pulls) {
            const number = Number(pull.number)
            if (!Number.isInteger(number) || number < 1 || mapRow(ctx, "pull", pull.id)?.statusId === "SmmDone") continue
            const {row, ours} = heldRow(ctx, number)
            if (ours && !row.headCommitId && !commitPresent(ctx.repositoryId, text(pull.head?.sha)))
                refMap["refs/pull/" + number + "/head"] = headRefOf(number)
        }
        return refMap
    }
    /* After the fetch: each held merge request whose ref was written gets its head when the ref is the pull request's
       head commit; a ref that names another commit (the remote moved, or sent something else) leaves it headless,
       reported. */
    function takeFetchedHeads(ctx, pulls, fetched) {
        const written = new Set(Array.from(fetched || []).map(String))
        for (const pull of pulls) {
            const number = Number(pull.number)
            if (!Number.isInteger(number) || !written.has(headRefOf(number))) continue
            const sha = text(pull.head?.sha)
            const {row, ours} = heldRow(ctx, number)
            if (!ours || row.headCommitId) continue
            const value = refCommit(ctx.repositoryId, headRefOf(number))
            if (!HEX40.test(sha) || value !== sha) {
                note(ctx, "pull", number, "headMismatch: The fetched head of pull request #" + number + " is not its head " + sha.slice(0, 12))
                continue
            }
            try {
                inNew(() => setHead(ctx, row, sha))
            } catch (error) {
                ec.message.clearErrors()
                note(ctx, "pull", number, "headNotSet: " + scrub(ctx, firstLine(error)))
            }
        }
    }
    kit.importHeads = {headRefMap, takeFetchedHeads}
    /* The heads of a page of pull requests (headRefMap) by fetch#GitRefs, then taken (takeFetchedHeads); a head that is
       not fetched is in the repository only when its commits are on a branch (a merged pull request's, with a merge
       commit). The fetch runs with authorization disabled, as the import's other calls of the host: the import is the
       group Owner's or an operator's (Smithy's check at its start), who holds no delete right of the framework's, and
       the refs asked for are only those the framework would let a caller with authorization on write (the first head
       of an imported merge request), of this import's merge requests. The token goes only to the API's own host. Its
       problems go to the run's report. Never against recorded responses. */
    function fetchHeads(ctx, pulls) {
        if (!pulls.length || recorded(apiBase()) || !ctx.cursor.cloneUrl) return
        if (!cloneOnApiHost(ctx.cursor.cloneUrl)) {
            note(ctx, "pull", "heads", "headsNotFetched: GitHub's clone address is not on the API's host")
            return
        }
        const refMap = headRefMap(ctx, pulls)
        if (!Object.keys(refMap).length) return
        const {out, problem} = probe(FETCH_REFS, {
            repositoryId: ctx.repositoryId,
            remoteUrl: ctx.cursor.cloneUrl,
            username: "x-access-token",
            password: ctx.token,
            refMap
        })
        if (problem) note(ctx, "pull", "heads", "headsNotFetched: " + scrub(ctx, problem))
        for (const item of Array.from(out.problems || []).slice(0, 50))
            note(ctx, "pull", "heads", "headNotFetched: " + scrub(ctx, firstLine(item)))
        takeFetchedHeads(ctx, pulls, out.fetched)
    }
    /* Whether a clone address is https on the host the API is of (github.com for api.github.com, an Enterprise
       Server's own host), so the token given for the API goes nowhere else. */
    const cloneOnApiHost = url => /^https:\/\//i.test(text(url).trim()) && hostOf(url) === apiHost()
    /* Whether the repository has a commit as its readers read it: in its store and on one of its branches or tags (not
       only a hidden merge request's head, nor only another fork's commit of a shared store). A read by id with
       authorization disabled finds any commit of the store, so the store is asked first (a commit not there costs no
       walk) and then the refs that contain it (get#GitCommitRefs). */
    function commitPresent(repositoryId, commitId) {
        if (!HEX40.test(text(commitId)) || readCommit(repositoryId, commitId, false) !== commitId) return false
        const {out, problem} = probe(GIT + "get#GitCommitRefs", {repositoryId, commitId, limit: 500})
        return problem == null && Array.from(out.refList || []).length > 0
    }
    /* The commit a merge request's own ref names (its head may be hidden: the import's are until Smithy's row is
       written), or null. */
    const refCommit = (repositoryId, refName) => readCommit(repositoryId, refName, true)
    function readCommit(repositoryId, revision, includeHidden) {
        ec.message.pushErrors()
        try {
            const out = ec.service
                .sync()
                .name(GIT + "get#GitCommit")
                .parameters({repositoryId, commitId: revision, stats: false, includeHidden})
                .disableAuthz()
                .call()
            return ec.message.hasError() ? null : text(out?.commit?.commitId) || null
        } catch (error) {
            return null
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    /* The final state of a pull request on GitHub, as the git host keeps a merge request's. */
    const pullStatus = pull =>
        pull.merged_at ? "GmrMerged" : pull.state === "closed" ? "GmrClosed" : pull.draft ? "GmrDraft" : "GmrOpen"
    /* A merge request's head set to a commit now in the repository (a fetched one): its ref, then its merge base and
       mergeability, as create#MergeRequest sets an imported one's. */
    function setHead(ctx, mr, sha) {
        call("org.moqui.git.GitReviewServices.sync#MergeRequestHead", {mergeRequestId: mr.mergeRequestId, headCommitId: sha})
        const open = ["GmrOpen", "GmrDraft"].includes(mr.statusId)
        const compared = probe(GIT + "get#GitCompare", {
            repositoryId: ctx.repositoryId,
            base: "refs/heads/" + mr.targetRef,
            head: headRefOf(Number(mr.mergeRequestNum)),
            checkMergeable: open,
            includeHidden: true
        }).out
        update(one(GMR, {mergeRequestId: mr.mergeRequestId}, true), {
            headCommitId: sha,
            baseCommitId: compared.mergeBaseId || null,
            mergeableEnumId:
                mr.statusId === "GmrMerged" || compared.alreadyMerged
                    ? "GmaMerged"
                    : !open || !compared.headCommitId
                      ? "GmaUnchecked"
                      : compared.mergeable
                        ? "GmaMergeable"
                        : "GmaConflict",
            conflictPaths: open ? Array.from(compared.conflictPaths || []).join("\n") || null : null
        })
    }
    /* The git host's merge request of a pull request: imported by create#MergeRequest (imported, its number, final state
       and dates; no event fires) as one pushed for review, with its head when the commit is in the repository, else with
       none until fetchHeads brings it; hidden until Smithy's row and conversation are written (importPull shows it), so
       a leftover of a failed item is read by nobody. In a transaction of its own, with the import's mark so that
       Smithy's rule leaves its conversation to the import, and the pull request's number on the map, so a leftover is
       the import's (closeLeftovers). One this import holds is taken again, its head set once the commit is here.
       {mergeRequestId, problem, taken}. */
    function openHosted(ctx, number, sha, pull) {
        const shared = ec.context.sharedMap
        shared[IMPORT_KEY] = ctx.repositoryId
        try {
            return inNew(() => {
                const {row, ours} = heldRow(ctx, number)
                if (row && (!ours || (row.headCommitId && row.headCommitId !== sha)))
                    return {mergeRequestId: null, problem: "numberTaken: Merge request !" + number + " is there already", taken: true}
                if (row) {
                    if (!row.headCommitId && commitPresent(ctx.repositoryId, sha)) setHead(ctx, row, sha)
                    return {mergeRequestId: row.mergeRequestId, problem: null}
                }
                const branches = Array.from(
                    call(GIT + "get#GitRefs", {repositoryId: ctx.repositoryId, refType: "branch"}).refList || []
                ).map(ref => ref.shortName)
                const asked = text(pull.base?.ref).replace(/^refs\/heads\//, "")
                const statusId = pullStatus(pull)
                const created = call("org.moqui.git.GitReviewServices.create#MergeRequest", {
                    repositoryId: ctx.repositoryId,
                    imported: true,
                    mergeRequestNum: number,
                    title: plainTitle(pull.title),
                    targetRef: branches.includes(asked) ? asked : ctx.cursor.defaultBranch || "main",
                    pushedForReview: true,
                    headCommitId: commitPresent(ctx.repositoryId, sha) ? sha : null,
                    hidden: true,
                    statusId,
                    createdDate: stamp(when(pull.created_at)),
                    mergedDate: pull.merged_at ? stamp(when(pull.merged_at)) : null,
                    closedDate: statusId === "GmrMerged" || statusId === "GmrClosed" ? stamp(when(pull.closed_at || pull.merged_at)) : null
                })
                mark(ctx, "pullNumber", number, {targetType: "mergeRequest", targetId: created.mergeRequestId, statusId: null})
                return {mergeRequestId: created.mergeRequestId, problem: null}
            })
        } catch (error) {
            ec.message.clearErrors()
            const problem = scrub(ctx, firstLine(error))
            return {mergeRequestId: null, problem, taken: /^GitNumberTaken: /.test(problem)}
        } finally {
            shared[IMPORT_KEY] = null
        }
    }
    function importPull(ctx, pull) {
        const number = Number(pull.number)
        if (!Number.isInteger(number) || number < 1) throw coded("numberInvalid", "The pull request has no number")
        const sha = text(pull.head?.sha)
        // the host first: its rules lock what this transaction must not hold yet (held before the fetch: holdPulls)
        const hosted = openHosted(ctx, number, sha, pull)
        if (hosted.taken) throw coded("numberTaken", "Merge request !" + number + " is there already in this repository")
        if (!hosted.mergeRequestId) throw coded("notOpened", hosted.problem || "The merge request was not opened")
        const mergeRequestId = hosted.mergeRequestId
        // its head is not here (not on a branch, not fetched): kept without commits
        const kept = !one(GMR, {mergeRequestId}, true).headCommitId
        const author = personOf(ctx, pull.user)
        const created = when(pull.created_at)
        const merged = !!pull.merged_at
        const closed = merged || pull.state === "closed"
        // an open pull request whose head is not here cannot be merged here: it is kept closed
        const statusId = merged ? "GmrMerged" : closed || kept ? "GmrClosed" : pull.draft ? "GmrDraft" : "GmrOpen"
        const title = titleOf(ctx, pull.title)
        const body = textOf(ctx, pull.body)
        update(one(GMR, {mergeRequestId}, true), {
            statusId,
            title: plainTitle(title),
            description: plainText(body.html).slice(0, 30000) || null,
            createdDate: stamp(created),
            lastUpdatedDate: stamp(when(pull.updated_at || pull.created_at)),
            mergedDate: merged ? stamp(when(pull.merged_at)) : null,
            mergeCommitId: merged && HEX40.test(text(pull.merge_commit_sha)) ? pull.merge_commit_sha : null,
            closedDate: closed ? stamp(when(pull.closed_at || pull.merged_at)) : kept ? now() : null
        })
        const postId = openRecord(ctx, author, created, title, body)
        create(SMR, {
            mergeRequestId,
            siteId: ctx.siteId,
            repositoryId: ctx.repositoryId,
            rootCommEventId: postId,
            authorPartyId: author,
            // a merged or closed one is history and its agreement is not computed (§18.2); an open or draft one is
            // computed below, as any open merge request's is
            agreementStateEnumId: "SmasOff",
            createdAt: stamp(created),
            revision: 1
        })
        if (merged) addPost(postId, {line: "merged", date: when(pull.merged_at)})
        else if (closed) addPost(postId, {line: "closed", date: when(pull.closed_at)})
        // shown now that Smithy's row and conversation are there (the same transaction)
        update(one(GMR, {mergeRequestId}, true), {hiddenDate: null})
        if (["GmrOpen", "GmrDraft"].includes(statusId)) kit.agreement.compute(mergeRequestId)
        mark(ctx, "pull", pull.id, {targetType: "mergeRequest", targetId: mergeRequestId, statusId: "SmmDone"})
        mark(ctx, "pullNumber", number, {targetType: "mergeRequest", targetId: mergeRequestId, statusId: "SmmDone"})
        const problems = [
            kept
                ? "headNotFetched: The head " +
                  (sha || "?").slice(0, 12) +
                  " of pull request #" +
                  number +
                  " is not in the repository; it is kept without its commits"
                : null,
            refusedProblem(body)
        ].filter(problem => !!problem)
        return {problem: problems.join("; ") || null}
    }
    const REVIEW_LINES = {APPROVED: "approved", CHANGES_REQUESTED: "requested changes"}
    function importReview(ctx, mr, review) {
        const root = one(SMR, {mergeRequestId: mr.mergeRequestId})?.rootCommEventId
        if (!root) throw coded("noRecord", "The merge request's conversation is not there")
        const author = personOf(ctx, review.user)
        const date = when(review.submitted_at)
        const body = textOf(ctx, review.body)
        const postId = body.html ? addPost(root, {author, date, body}) : null
        if (REVIEW_LINES[review.state]) addPost(root, {author, date, line: REVIEW_LINES[review.state]})
        mark(ctx, "review", review.id, {targetType: "post", targetId: postId, statusId: "SmmDone"})
        return {problem: refusedProblem(body)}
    }
    /* A line comment: a reply in its thread, or a new thread with its anchor (the line on its side; a comment whose line
       is gone from the pull request's diff is outdated, at its original line). */
    function importReviewComment(ctx, item) {
        const number = Number((/\/pulls\/(\d+)$/.exec(text(item.pull_request_url)) || [])[1])
        const mr = number
            ? Array.from(find(GMR, {repositoryId: ctx.repositoryId, mergeRequestNum: number}).limit(1).list())[0]
            : null
        const root = mr ? one(SMR, {mergeRequestId: mr.mergeRequestId})?.rootCommEventId : null
        if (!root) throw coded("noRecord", "The comment's pull request #" + number + " was not imported")
        const author = personOf(ctx, item.user)
        const body = textOf(ctx, item.body)
        const date = when(item.created_at)
        const thread = item.in_reply_to_id != null ? target(ctx, "reviewComment", item.in_reply_to_id) : null
        if (item.in_reply_to_id != null && !thread)
            throw coded("noRecord", "The comment it answers (" + item.in_reply_to_id + ") was not imported")
        const postId = addPost(root, {author, date, body, parent: thread})
        if (!thread) {
            const outdated = item.line == null
            const line = Number(outdated ? item.original_line : item.line) || null
            const left = text(item.side || item.original_side) === "LEFT"
            const hunk = text(item.diff_hunk).split("\n")
            const commitId = [item.commit_id, item.original_commit_id].find(id => HEX40.test(text(id))) || null
            create(ANCHOR, {
                communicationEventId: postId,
                mergeRequestId: mr.mergeRequestId,
                repositoryId: ctx.repositoryId,
                commitId,
                path: text(item.path).slice(0, 255),
                oldLine: left ? line : null,
                newLine: left ? null : line,
                lineText: text(hunk[hunk.length - 1]).slice(1, 256) || null,
                outdated: outdated ? "Y" : "N"
            })
        }
        // the thread of a reply is its first post
        mark(ctx, "reviewComment", item.id, {targetType: "post", targetId: thread || postId, statusId: "SmmDone"})
        return {problem: refusedProblem(body)}
    }

    // ===== reactions =====
    function reactionsUnit(ctx) {
        let query = find(MAP, {siteId: ctx.siteId, repositoryId: ctx.repositoryId, sourceType: "reactionsDue", statusId: null})
        if (ctx.cursor.after) query = query.condition("sourceId", "greater", ctx.cursor.after)
        const due = Array.from(query.orderBy("sourceId").limit(1).list())[0]
        if (!due) return setStage(ctx, "SmiLinks", {})
        const [kind, id] = text(due.sourceId).split(":")
        const postId = due.targetId || (kind === "issue" ? recordOf(ctx, id) : null)
        if (!postId) {
            inNew(() => mark(ctx, "reactionsDue", due.sourceId, {statusId: "SmmSkipped", errorText: "No post"}))
            return Object.assign(ctx.cursor, {after: due.sourceId, page: 1})
        }
        const answer = get(
            ctx,
            (kind === "issue" ? "/issues/" + Number(id) : "/issues/comments/" + encodeURIComponent(id)) +
                "/reactions?per_page=" +
                PAGE +
                "&page=" +
                Number(ctx.cursor.page || 1)
        )
        if (!answer) return
        for (const reaction of Array.from(answer.body || [])) {
            const key = REACTIONS[reaction.content]
            if (!key) {
                count(ctx, "reaction", "source")
                if (!mapRow(ctx, "reaction", reaction.id)) {
                    notCarried(ctx, "reactions", text(reaction.content))
                    inNew(() => mark(ctx, "reaction", reaction.id, {statusId: "SmmSkipped", errorText: "No such reaction here"}))
                }
                continue
            }
            each(ctx, "reaction", reaction.id, () => {
                const partyId = personOf(ctx, reaction.user)
                const state = one(F + "ForumPostState", {communicationEventId: postId}, true)
                const row = {communicationEventId: postId, partyId, reactionKey: key}
                if (state && !one(F + "ForumReaction", row)) {
                    create(F + "ForumReaction", {
                        ...row,
                        rootCommEventId: state.rootCommEventId,
                        createdAt: stamp(when(reaction.created_at))
                    })
                    const counts = json(state.reactionCounts, {})
                    counts[key] = Number(counts[key] || 0) + 1
                    update(state, {reactionCounts: JSON.stringify(counts), reactionCount: Number(state.reactionCount || 0) + 1})
                    const topic = one(F + "ForumTopic", {rootCommEventId: state.rootCommEventId}, true)
                    if (topic) update(topic, {reactionCount: Number(topic.reactionCount || 0) + 1})
                }
                mark(ctx, "reaction", reaction.id, {targetType: "post", targetId: postId, statusId: "SmmDone"})
                return {}
            })
        }
        if (hasNext(answer)) ctx.cursor.page = Number(ctx.cursor.page || 1) + 1
        else {
            inNew(() => mark(ctx, "reactionsDue", due.sourceId, {statusId: "SmmDone"}))
            Object.assign(ctx.cursor, {after: due.sourceId, page: 1})
        }
    }

    // ===== the end =====
    /* Numbers past the highest imported, the history marked imported (the agreement takes imported commits by their
       authors' GitHub logins), the issues on when they were imported, and an old path for a source whose owner/name is
       not this repository's path (its GitHub forms are answered by resolve#Redirect). */
    function finish(ctx) {
        const repo = one(M + "SmithyRepository", {repositoryId: ctx.repositoryId}, true)
        const highest = (entity, field) =>
            Number(
                Array.from(
                    find(entity, {repositoryId: ctx.repositoryId})
                        .orderBy("-" + field)
                        .limit(1)
                        .list()
                )[0]?.[field] || 0
            )
        const next = Math.max(
            Number(repo.nextIssueNumber || 1),
            highest(M + "SmithyIssue", "issueNumber") + 1,
            highest(GMR, "mergeRequestNum") + 1
        )
        update(repo, {
            nextIssueNumber: next,
            // the agreement takes imported commits by their authors' GitHub logins only in a repository the import made:
            // one that had history of its own keeps its commits judged by who pushed them
            ...(ctx.cursor.createdByImport ? {importedHistory: "Y"} : {}),
            ...(ctx.options.issues ? {issuesEnabled: "Y"} : {}),
            revision: Number(repo.revision || 1) + 1
        })
        // the GitHub address as an old path, for a public repository only (a private one's name is told to nobody), by
        // the redirects' own rules (SmithySite.js putRedirect): never over a live name, the server's paths or a row there
        const oldPath = "/" + lower(ctx.sourceRepository)
        if (lower(ctx.sourceRepository) === lower(repo.repositoryPath)) return
        const anyone = core.repositoryRights(repo, core.actor(null))
        if (!anyone.canView || anyone.visibility !== 1 || anyone.hidden) return
        const mount = ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
        const targetPath = (mount.mount(ctx.siteId, "smithy")?.base ?? "") + "/" + repo.repositoryPath
        ec.message.pushErrors()
        try {
            kit.putRedirect(
                ctx.siteId,
                me(),
                {oldPath, targetPath, note: "GitHub " + ctx.sourceRepository, sourceEnumId: "SrsGithub"},
                null,
                false
            )
        } catch (error) {
            note(ctx, "run", ctx.importId, "redirectNotMade: " + firstLine(error))
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }

    // ===== the job =====
    /* run#Imports: a step of each import that is due (not waiting, not running), as the account that started it; an
       import whose account is gone fails. Each stands alone. */
    /* Ends a run the job cannot step as its account: failed with the reason in its report, its token dropped. */
    function lose(importId, errorText) {
        inNew(() => {
            const locked = one(RUN, {importId}, true)
            if (!locked || !ACTIVE.includes(locked.statusId)) return
            const report = json(locked.reportJson, {items: []})
            report.items = [...(report.items || []), {sourceType: "run", sourceId: importId, errorText}]
            const cursor = json(locked.cursorJson, {})
            dropToken(locked)
            update(locked, {
                statusId: "SmiFailed",
                finishedAt: now(),
                cursorJson: JSON.stringify({...cursor, stage: locked.statusId}),
                reportJson: JSON.stringify(report),
                tokenRemoteId: null,
                leaseUntil: null
            })
        })
    }
    function runImports() {
        const at = now()
        const due = Array.from(
            find(RUN)
                .condition("statusId", "in", ACTIVE)
                .condition(ec.entity.conditionFactory.makeCondition(
                    [
                        ec.entity.conditionFactory.makeCondition("waitingUntil", "equals", null),
                        ec.entity.conditionFactory.makeCondition("waitingUntil", "less-equals", at)
                    ],
                    "or"
                ))
                .condition(ec.entity.conditionFactory.makeCondition(
                    [
                        ec.entity.conditionFactory.makeCondition("leaseUntil", "equals", null),
                        ec.entity.conditionFactory.makeCondition("leaseUntil", "less-equals", at)
                    ],
                    "or"
                ))
                .orderBy("createdAt,importId")
                .limit(200)
                .list()
        )
        // a pass steps a few runs of one account and of one site, so one does not take every pass
        const byAccount = new Map()
        const bySite = new Map()
        let stepped = 0
        for (const run of due) {
            if (stepped >= 20) break
            if ((byAccount.get(run.startedByPartyId) || 0) >= STEPPED_PER_ACCOUNT) continue
            if ((bySite.get(run.siteId) || 0) >= STEPPED_PER_SITE) continue
            byAccount.set(run.startedByPartyId, (byAccount.get(run.startedByPartyId) || 0) + 1)
            bySite.set(run.siteId, (bySite.get(run.siteId) || 0) + 1)
            try {
                const account = rows(ACCOUNT, {partyId: run.startedByPartyId}, 20).find(row => row.disabled !== "Y")
                if (!account) {
                    lose(run.importId, "accessLost: The account that started the import is gone")
                    continue
                }
                // as the account that started it, signed in for the step without its own sessions ending (ForumCore.asUser)
                let entered = false
                try {
                    forum.asUser(account.username, () => {
                        entered = true
                        try {
                            ec.service
                                .sync()
                                .name("mantle.smithy.SmithyImportServices.run#Import")
                                .parameters({importId: run.importId})
                                .call()
                        } finally {
                            ec.message.clearErrors()
                        }
                    })
                    stepped++
                } catch (error) {
                    ec.message.clearErrors()
                    if (entered) throw error
                    // the account cannot sign in now (disabled, ended, locked): the run ends
                    lose(run.importId, "accessLost: The account that started the import cannot sign in")
                }
            } catch (error) {
                ec.message.clearErrors()
                let token = ""
                try {
                    token = tokenOf(run)
                } catch (ignored) {
                    token = ""
                }
                ec.logger.error("Smithy import " + run.importId + " was not stepped: " + scrub({token}, firstLine(error)))
            }
        }
        return {stepped}
    }

    // ===== the claim of a placeholder =====
    /* claim#GithubAccount: an account whose sign-in through a GitHub provider (an OauthFlow of type OctGitHub) linked a
       GitHub id takes, in each site, the placeholder of that id: its login, and its posts, issues, merge requests,
       assignments and reactions. Safe to run twice. */
    /* The GitHub a flow signs in with, only when its endpoints are exactly GitHub's own, so the id its user info gives
       is the signed-in user's: github.com when each address is empty (the client type's defaults) or exactly github.com's
       (https://github.com/login/oauth/authorize, .../access_token, https://api.github.com/user); an Enterprise Server's
       host when all three are exactly its own (https://<host>/login/oauth/authorize, .../access_token,
       https://<host>/api/v3/user). Any other address (a user's profile such as /users/<login>, a proxy, a delegate) is
       null: nothing it links is claimed. */
    const GITHUB_ENDPOINTS = [
        "https://github.com/login/oauth/authorize",
        "https://github.com/login/oauth/access_token",
        "https://api.github.com/user"
    ]
    function flowHost(oauth) {
        const urls = [oauth.authorizeUrl, oauth.tokenUrl, oauth.userInfoUrl].map(url => text(url).trim())
        if (urls.every((url, index) => !url || url === GITHUB_ENDPOINTS[index])) return "github.com"
        const server = /^https:\/\/([a-z0-9.-]+)\/login\/oauth\/authorize$/.exec(urls[0])
        const host = server ? server[1] : null
        if (!host || host === "github.com" || host.endsWith(".github.com")) return null
        return urls[1] === "https://" + host + "/login/oauth/access_token" && urls[2] === "https://" + host + "/api/v3/user"
            ? normalHost(host)
            : null
    }
    const LINK = M + "SmithyGithubLink"
    /* handle#SsoLinked, the framework's sso-linked-service: a real sign-in through a GitHub flow whose endpoints are
       GitHub's own (flowHost), whose user info came from that GitHub (providerHost: api.github.com for github.com, else
       the Enterprise Server's host), that linked the id the account holds now: the proof is recorded and the
       placeholders claimed. Anything else claims nothing. */
    function ssoLinked(p) {
        const oauth = text(p.authFlowId) ? one("moqui.security.sso.OauthFlow", {authFlowId: text(p.authFlowId)}) : null
        if (oauth?.clientTypeEnumId !== "OctGitHub") return {claimed: 0}
        const host = flowHost(oauth)
        // a flow that keeps its client type's endpoints is github.com's; one with its own passes flowHost's exact rule
        if (!host || (p.urlsOverridden !== true && host !== "github.com")) return {claimed: 0}
        if (lower(p.providerHost).replace(/\.$/, "") !== (host === "github.com" ? "api.github.com" : host)) return {claimed: 0}
        const account = text(p.userId) ? one(ACCOUNT, {userId: text(p.userId)}) : null
        if (!account || text(account.externalUserId) !== text(p.externalUserId) || account.externalAuthFlowId !== text(p.authFlowId))
            return {claimed: 0}
        return claimGithub(account.userId, true)
    }
    /* claim#GithubAccount. proven: the caller is the sign-in hook (ssoLinked), which records the link as proven
       (SmithyGithubLink) when the flow's endpoints are GitHub's own; any other call (a membership that became active)
       claims only for a link proven so, of the account's id and flow now. */
    function claimGithub(userId, proven) {
        const account = userId ? one(ACCOUNT, {userId}) : null
        if (!account?.partyId || !account.externalUserId || !account.externalAuthFlowId) return {claimed: 0}
        const oauth = one("moqui.security.sso.OauthFlow", {authFlowId: account.externalAuthFlowId})
        if (oauth?.clientTypeEnumId !== "OctGitHub") return {claimed: 0}
        // the id is of the GitHub the flow's user info comes from; a placeholder is of the GitHub the import read
        const host = flowHost(oauth)
        if (!host) return {claimed: 0}
        const githubUserId = text(account.externalUserId)
        const link = {githubUserId, githubHost: host, authFlowId: account.externalAuthFlowId}
        let held = one(LINK, {userId}, true)
        if (proven) {
            if (held) update(held, {...link, provenAt: now()})
            else create(LINK, {userId, ...link, provenAt: now()})
            held = one(LINK, {userId})
        }
        if (!held || held.githubUserId !== githubUserId || held.githubHost !== host || held.authFlowId !== link.authFlowId)
            return {claimed: 0}
        let claimed = 0
        for (const found of Array.from(
            find(M + "SmithyAccount", {githubUserId: text(account.externalUserId)})
                .limit(50)
                .list()
        )) {
            if (found.placeholder !== "Y" || found.partyId === account.partyId || !hostMatches(found, host)) continue
            // only in a site the account is an active member of, not suspended there: elsewhere the records wait
            if (!core.siteAccess(found.siteId, core.actorOfParty(account.partyId)).joined) continue
            // each site stands alone: one that fails is logged, the others are claimed
            try {
                inNew(() => {
                    const placeholder = one(M + "SmithyAccount", {siteId: found.siteId, partyId: found.partyId}, true)
                    if (!placeholder || placeholder.placeholder !== "Y") return
                    claimOne(placeholder, account)
                    claimed++
                })
            } catch (error) {
                ec.message.clearErrors()
                ec.logger.error(
                    "The GitHub placeholder " + found.partyId + " of site " + found.siteId + " was not claimed by " + userId + ": " + firstLine(error)
                )
            }
        }
        return {claimed}
    }
    /* Moves the rows of entity whose field is from to to (or by each), 500 at a time; false when rows are left after the
       last batch, so the caller keeps what refers to them. */
    function moveAll(entity, field, from, to, each) {
        for (let batch = 0; batch < 400; batch++) {
            const list = Array.from(
                find(entity, {[field]: from})
                    .limit(500)
                    .list()
            )
            for (const row of list) each ? each(row) : update(row, {[field]: to})
            if (list.length < 500) return true
        }
        return !find(entity, {[field]: from}).count()
    }
    /* A row whose key has the party: made again with the account's party, unless the account has it, and the old one
       removed (dropped: what the account had already, with what it counts). */
    function moveKeyed(entity, from, to, key, dropped) {
        return moveAll(entity, "partyId", from, to, row => {
            const fields = {...row.getMap(), partyId: to}
            const same = {}
            for (const name of key) same[name] = fields[name]
            if (!one(entity, same)) create(entity, fields)
            else if (dropped) dropped(row)
            row.delete()
        })
    }
    /* A reaction the account had already given is one reaction: the post's and the topic's counts lose the
       placeholder's. */
    function reactionDropped(row) {
        const state = one(F + "ForumPostState", {communicationEventId: row.communicationEventId}, true)
        if (state) {
            const counts = json(state.reactionCounts, {})
            if (counts[row.reactionKey]) counts[row.reactionKey] = Math.max(0, Number(counts[row.reactionKey]) - 1)
            update(state, {reactionCounts: JSON.stringify(counts), reactionCount: Math.max(0, Number(state.reactionCount || 0) - 1)})
        }
        const topic = row.rootCommEventId ? one(F + "ForumTopic", {rootCommEventId: row.rootCommEventId}, true) : null
        if (topic) update(topic, {reactionCount: Math.max(0, Number(topic.reactionCount || 0) - 1)})
    }
    function claimOne(placeholder, account) {
        const siteId = placeholder.siteId
        const from = placeholder.partyId
        const to = account.partyId
        const login = placeholder.githubLogin
        const githubUserId = placeholder.githubUserId
        update(placeholder, {githubLogin: null, githubUserId: null})
        if (login)
            for (const other of Array.from(
                find(M + "SmithyAccount", {siteId, githubLogin: login})
                    .limit(10)
                    .list()
            ))
                if (other.partyId !== to) update(other, {githubLogin: null})
        const own = one(M + "SmithyAccount", {siteId, partyId: to}, true)
        const identity = {githubLogin: login, githubUserId, githubHost: placeholder.githubHost || null, claimedAt: now()}
        if (own) update(own, {...identity, revision: Number(own.revision || 1) + 1})
        else create(M + "SmithyAccount", {siteId, partyId: to, ...identity, revision: 1})
        const moved = [
            moveAll(E + "CommunicationEvent", "fromPartyId", from, to),
            moveAll(F + "ForumPostRevision", "editorPartyId", from, to),
            moveAll(M + "SmithyIssue", "reporterPartyId", from, to),
            moveAll(WORK + "WorkEffort", "ownerPartyId", from, to),
            moveAll(SMR, "authorPartyId", from, to, row => {
                update(row, {authorPartyId: to})
                const mr = one(GMR, {mergeRequestId: row.mergeRequestId}, true)
                if (mr && account.userId) update(mr, {authorUserId: account.userId})
            }),
            moveKeyed(WORK + "WorkEffortParty", from, to, ["workEffortId", "partyId", "roleTypeId", "fromDate"]),
            moveKeyed(F + "ForumReaction", from, to, ["communicationEventId", "partyId", "reactionKey"], reactionDropped)
        ]
        // the placeholder stays while anything still names it: the claim of this site is rolled back, and runs again
        if (moved.includes(false)) throw coded("claimIncomplete", "The placeholder has more records than one claim moves")
        moveAll(MAP, "targetId", from, to, row => (row.sourceType === "user" ? update(row, {targetId: to}) : null))
        for (const entity of [S + "PublicSiteProfile", S + "PublicSiteParty"]) {
            const row = one(entity, {siteId, partyId: from})
            if (row) row.delete()
        }
        placeholder.delete()
        forum.systemAudit(
            siteId,
            null,
            "member",
            to,
            "claim-github-placeholder",
            "Records of a GitHub import claimed by a GitHub sign-in"
        )
    }

    // ===== push mirrors (F6) =====
    /* A repository's mirrors as its Maintainer holds them. */
    function mirrored(p, write) {
        const r = core.repository(p.repositoryId, p.siteId)
        if (write) writer(p.siteId)
        core.requireRole(r, "SmrMaintainer")
        return r
    }
    /* What the framework's mirror services refused, as the operation's refusal. */
    function mirrorRefused(problem) {
        if (/^GitMirrorBusy: /.test(problem)) fail("Conflict", "A push of this mirror is running")
        if (/credential goes only where it was given for/.test(problem))
            invalid(
                "secretRequired[secret]: A new address, username or host key needs the token or password again, or remove the credential"
            )
        if (/^you may not /i.test(problem)) denied("Mirrors need the maintainer role and a confirmed address")
        invalid(problem.replace(/^[A-Za-z]+: /, "").slice(0, 200))
    }
    /* A framework mirror service after Smithy's own check, with authorization disabled. */
    function hostCall(name, parameters) {
        const {out, problem} = probe(GIT + name, parameters)
        if (problem != null) mirrorRefused(problem)
        return out
    }
    /* store#GitRepositoryMirror as the Maintainer, with authorization on: the framework keeps who gave the credential
       (createdByUserId) and pauses the mirror, without using it, once that account no longer holds the delete right
       (check#GitRepositoryAuthz: a Maintainer or higher with a confirmed address). One stored with authorization
       disabled would be the application's and never paused. */
    function storeAsMaintainer(parameters) {
        const wasDisabled = ec.artifactExecution.authzDisabled()
        if (wasDisabled) ec.artifactExecution.enableAuthz()
        ec.message.pushErrors()
        let out = null
        let problem = null
        try {
            out = ec.service.sync().name(GIT + "store#GitRepositoryMirror").parameters(parameters).requireNewTransaction(true).call()
            if (ec.message.hasError()) problem = text(ec.message.getErrorsString()).split("\n")[0]
        } catch (error) {
            problem = firstLine(error)
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
            if (wasDisabled) ec.artifactExecution.disableAuthz()
        }
        // what a refusal says never carries the credential it was given
        if (problem != null) mirrorRefused(scrub({token: text(parameters.credential)}, problem))
        return out || {}
    }
    const mirrorsOf = repositoryId => Array.from(hostCall("find#GitRepositoryMirrors", {repositoryId}).mirrorList || [])
    /* An address with no user or password in it: the credential is apart. */
    const MIRROR_URL = /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/[^\s@]*$/
    methods.findMirrors = p => {
        const r = mirrored(p, false)
        return {
            mirrorList: mirrorsOf(r.repo.repositoryId).map(row => ({
                mirrorId: row.mirrorId,
                url: row.url,
                refs: row.refPattern || null,
                deleteRefs: row.deleteRefs === "Y" || row.deleteRefs === true,
                enabled: row.enabled !== "N" && row.enabled !== false,
                hasCredential: !!row.hasCredential,
                lastPushDate: row.lastPushDate || null,
                lastResult: row.lastResult || null,
                // a push's error may carry the address it was given with a credential in it
                lastError: row.lastError ? scrub(null, row.lastError) : null,
                nextAttemptDate: row.nextAttemptDate || null
            }))
        }
    }
    /* What a mirror's receipt is of: the input without its secret. */
    const mirrorReceipt = p => ({...p, secret: undefined})
    kit.mirrorReceipt = mirrorReceipt
    methods.storeMirror = p => {
        const r = mirrored(p, true)
        const store = () => {
            const stored = given(p.mirrorId) ? mirrorsOf(r.repo.repositoryId).find(row => row.mirrorId === p.mirrorId) : null
            if (given(p.mirrorId) && !stored) missing()
            const url = text(p.url).trim()
            // a stored credential goes only to the address it was given for: any other address (another path on the same
            // host, where the framework would keep it, is another repository) needs it again, or its removal
            if (stored && stored.hasCredential && url && url !== stored.url && !given(p.secret) && !flag(p.removeCredential))
                invalid(
                    "secretRequired[secret]: A new address, username or host key needs the token or password again, or remove the credential"
                )
            if ((url || !given(p.mirrorId)) && !MIRROR_URL.test(url))
                invalid("url: An https address, with the credential given apart")
            const refs = text(p.refs).trim()
            if (refs.length > 1000 || /[\s;]/.test(refs.replace(/,\s*/g, ","))) invalid("refs: Ref patterns, comma separated")
            const editing = given(p.mirrorId)
            const removeCredential = flag(p.removeCredential)
            if (removeCredential && (given(p.username) || given(p.secret)))
                invalid("removeCredential: Remove the credential, or give a new one, not both")
            const out = storeAsMaintainer({
                repositoryId: r.repo.repositoryId,
                ...(editing ? {mirrorId: p.mirrorId} : {}),
                ...(url ? {url} : {}),
                ...(given(p.username) ? {username: text(p.username)} : {}),
                ...(given(p.secret) ? {credential: text(p.secret)} : {}),
                // the credential taken off: no username, no secret
                ...(removeCredential ? {clearCredential: true} : {}),
                ...(given(p.hostKeyFingerprint) ? {hostKeyFingerprint: text(p.hostKeyFingerprint)} : {}),
                // refs posted empty on an edit is all branches and tags again: the pattern is cleared
                ...(refs ? {refPattern: refs} : editing && p.refs !== undefined && p.refs !== null ? {clearRefPattern: true} : {}),
                ...(given(p.deleteRefs) ? {deleteRefs: flag(p.deleteRefs) ? "Y" : "N"} : {}),
                ...(given(p.enabled) ? {enabled: flag(p.enabled) ? "Y" : "N"} : {})
            })
            return {mirrorId: out.mirrorId || p.mirrorId}
        }
        // the receipt keeps no trace of the secret, not even its hash
        return given(p.mirrorId) ? store() : receipt(mirrorReceipt(p), "storeMirror", store)
    }
    methods.deleteMirror = p => {
        const r = mirrored(p, true)
        if (!mirrorsOf(r.repo.repositoryId).some(row => row.mirrorId === p.mirrorId)) missing()
        hostCall("delete#GitRepositoryMirror", {mirrorId: p.mirrorId})
        return {deleted: true}
    }
    methods.pushMirror = p => {
        const r = mirrored(p, true)
        if (!mirrorsOf(r.repo.repositoryId).some(row => row.mirrorId === p.mirrorId)) missing()
        hostCall("push#GitRepositoryMirror", {mirrorId: p.mirrorId})
        return {queued: true}
    }
    /* handle#MirrorFailure, for the SmithyMirrorFailure rule: the framework tells only the account that stored a mirror
       of its first failure after a success (topic GitMirrorFailure); a repository Smithy keeps tells its other
       Maintainers and Owners too, on the same topic, with the repository as the record (which the rule leaves alone).
       Each holder is counted as Smithy's rights count (an active row of the repository or its groups, its owner; not
       suspended), at most 100. How many were told. */
    function mirrorFailure(p) {
        const message = json(p.messageJson, {})
        const repositoryId = text(message.repositoryId || p.subTopic)
        const repo = repositoryId ? one(M + "SmithyRepository", {repositoryId}) : null
        if (!repo) return {notified: 0}
        const mirror = message.mirrorId ? one("moqui.resource.GitRepositoryMirror", {mirrorId: text(message.mirrorId)}) : null
        if (!mirror || mirror.repositoryId !== repositoryId) return {notified: 0}
        const userIds = core.maintainerUserIds(repositoryId, [mirror.createdByUserId])
        if (!userIds.length) return {notified: 0}
        const url = scrub(null, message.url || mirror.url)
        ec.makeNotificationMessage()
            .topic("GitMirrorFailure")
            .subTopic(repositoryId)
            .userIds(userIds)
            .record(M + "SmithyRepository", repositoryId)
            // the title is a template expanded with the message's fields: values go in the message, never in the text,
            // where a path or URL holding ${...} would run as script (plans/Security-Review.md SEC-SCR-05)
            .title("The push mirror of ${where} to ${url} fails")
            .message({
                where: repo.repositoryPath || repositoryId,
                repositoryId,
                repositoryPath: repo.repositoryPath || null,
                mirrorId: mirror.mirrorId,
                url,
                error: scrub(null, message.error || "")
            })
            .type("warning")
            .showAlert(true)
            .persistOnSend(true)
            .send()
        return {notified: userIds.length}
    }

    return {runStep, runImports, claimGithub, ssoLinked, mirrorFailure, IMPORT_KEY}
}
