/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * Smithy's pipelines (mr-pass plan/design-smithy.md §10, §11 Pipelines, §15.6, DG5; plans/Dogfood.md §8.4, §16 q10). The
 * engine and its records are the framework's (org.moqui.git.GitCiServices, docs/interfaces/Pipelines.md); Smithy decides
 * who sees and does what, and which runs start. Smithy.js calls this with its kit; each operation is a method of its map.
 * - Reads follow viewing the repository (Not Found otherwise, a hidden or private one too); a run of a merge request is
 *   read by who reads that merge request (a held one: its author and its moderators), so a hidden head's run, log and
 *   uploads are Not Found to anyone else. The framework is called with authorization disabled and includeHidden only
 *   after that check.
 * - Moves are Smithy's roles: Developer to run, re-run, cancel (or the account that asked for the run) and retry;
 *   Maintainer to approve an outside run and to manage secrets and environments; a group's Owner for its pipeline
 *   settings.
 * - checkRun is the engine's run check (git-ci run-check-service): allow, wait or refuse, the trust, the owner the run's
 *   usage counts under (the top-level group, or the account of a personal repository) and the pool. It fails closed.
 * - runUrl is the engine's run URL (git-ci run-url-service): the run's page on the site's canonical host.
 * Entity access is privileged here; every operation passes the evaluator first.
 */
kit => {
    const {core, methods, flag, text, writer} = kit
    const {M, forum, RANK} = core
    const {me, find, one, update, fail, missing, invalid, page, receipt, audit} = forum
    const CI = "org.moqui.git.GitCiServices."
    const GIT = core.GIT
    const GMR = "moqui.resource.GitMergeRequest"
    const ENDED = ["success", "failure", "error", "cancelled", "skipped"]
    const OUTSIDE_APPROVALS = kit.OUTSIDE_APPROVALS
    const reviews = () => kit.reviews
    const publicApps = () => ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
    const archived = () => fail("Conflict", "repositoryArchived: This repository is archived")
    const given = value => value !== undefined && value !== null
    const number = value => (value == null || value === "" ? null : Number(value))
    /* What the engine says of the largest download Smithy copies for the facade to stream (a framework need: a location
       the facade streams a run's upload from, without a copy). */
    const DOWNLOAD_LIMIT = 268435456
    const DOWNLOAD_PIECE = 8388608

    /* A service of the engine after Smithy's own check: {out, problem}, the problem its first error line, nothing in the
       message facade after it. */
    function engine(name, parameters) {
        ec.message.pushErrors()
        try {
            const out = ec.service
                .sync()
                .name(CI + name)
                .parameters(parameters)
                .call()
            if (!ec.message.hasError()) return {out: out || {}, problem: null}
            return {out: out || {}, problem: text(ec.message.getErrorsString()).split("\n")[0]}
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    /* A move of the engine: its answer, or the request's refusal with the engine's text (Not Found for a run or a job it
       does not find, Conflict for one that has ended or does not wait). */
    function engineMove(name, parameters) {
        const {out, problem} = engine(name, parameters)
        if (problem == null) return out
        ec.logger.warn("Smithy pipeline call " + name + " refused: " + problem)
        if (/not found|no such/i.test(problem)) missing()
        if (/ended|does not wait|still runs|running/i.test(problem)) fail("Conflict", problem.slice(0, 200))
        invalid(problem.slice(0, 200))
    }
    /* A quiet read of the git host: its answer, or {} for one it has nothing for (a file the commit does not have). */
    function quiet(name, parameters) {
        ec.message.pushErrors()
        try {
            const out = ec.service
                .sync()
                .name(GIT + name)
                .parameters(parameters)
                .call()
            return ec.message.hasError() ? {} : out || {}
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }

    // ===== owners, minutes and pools (Dogfood §5.1, §8.4) =====
    /* The owner of a group's runs: its top-level group, which every repository below it counts under. */
    const groupKey = groupId => "smithy:group:" + groupId
    const accountKey = (siteId, partyId) => "smithy:account:" + siteId + ":" + partyId
    /* A top-level group's runner minutes a month: its own limit, else the site's default for a group. */
    function groupMinutesLimit(top, s) {
        return top.runnerMinutesMonthly == null || top.runnerMinutesMonthly === ""
            ? Number(s.groupRunnerMinutes)
            : Number(top.runnerMinutesMonthly)
    }
    /* This month's minutes of an owner, as the engine counted them as its jobs ended: {minutesUsed, periodKey}, or null
       when they cannot be read. */
    function usageOf(ownerId) {
        const {out, problem} = engine("get#RunnerUsage", {ownerId})
        if (problem != null || out.minutesUsed == null) {
            ec.logger.warn("Smithy runner usage of " + ownerId + " is not known: " + (problem || "no answer"))
            return null
        }
        return {minutesUsed: Number(out.minutesUsed || 0), periodKey: out.periodKey || null}
    }
    /* What getQuotaUsage shows of runner minutes: {limit, used}. */
    function groupMinutes(chain, s) {
        const top = chain[chain.length - 1]
        return {limit: groupMinutesLimit(top, s), used: usageOf(groupKey(top.groupId))}
    }
    function accountMinutes(siteId, partyId, s) {
        return {limit: kit.quota.accountLimits(siteId, partyId, s).runnerMinutes, used: usageOf(accountKey(siteId, partyId))}
    }
    /* Who a repository's runs count under: {kind, ownerId, label, limit, chain}; null for a group chain that is broken,
       which runs nothing. */
    function ownerOf(repo, s = core.settings(repo.siteId)) {
        if (repo.ownerPartyId)
            return {
                kind: "account",
                ownerId: accountKey(repo.siteId, repo.ownerPartyId),
                label: kit.handleOf(repo.siteId, repo.ownerPartyId) || "this account",
                limit: kit.quota.accountLimits(repo.siteId, repo.ownerPartyId, s).runnerMinutes,
                chain: []
            }
        const chain = repo.groupId ? core.groupChain(repo.groupId) : null
        if (!chain || !chain.length) return null
        return groupOwner(chain, s)
    }
    function groupOwner(chain, s) {
        const top = chain[chain.length - 1]
        return {kind: "group", ownerId: groupKey(top.groupId), label: top.groupPath, limit: groupMinutesLimit(top, s), chain}
    }
    /* Whether an owner may start a run now: null, or the refusal's text (a code and its words; plain, as a status's
       description is). A usage that cannot be read refuses. */
    function quotaProblem(owner) {
        if (!(owner.limit > 0))
            return owner.kind === "account"
                ? "policyRefused: A personal repository runs pipelines only with runner minutes the site's operators gave its account"
                : "quotaExceeded: The group " + owner.label + " has no runner minutes"
        const used = usageOf(owner.ownerId)
        if (!used) return "The runner minutes used could not be read now, so the run did not start; try again"
        if (used.minutesUsed >= owner.limit)
            return (
                "quotaExceeded: The runner minutes of " +
                owner.label +
                " for " +
                used.periodKey +
                " are used up (" +
                used.minutesUsed +
                " of " +
                owner.limit +
                ")"
            )
        return null
    }
    /* The pools an operator allowed an owner: the enabled pools that are shared (no owner) or the owner's own; null when
       they cannot be read. */
    function poolsFor(owner) {
        const {out, problem} = engine("find#RunnerPools", {})
        if (problem != null) {
            ec.logger.warn("Smithy could not read the runner pools: " + problem)
            return null
        }
        return Array.from(out.poolList || [])
            .filter(pool => pool.enabled !== false && pool.enabled !== "N")
            .filter(pool => !pool.ownerId || pool.ownerId === owner.ownerId)
            .map(pool => ({
                runnerPoolId: pool.runnerPoolId,
                poolName: pool.poolName || "default",
                description: pool.description || "",
                trusted: flag(pool.trusted),
                shared: !pool.ownerId
            }))
    }
    /* The nearest group of a chain that sets a field: [value, group], or [null, null]. */
    function nearest(chain, field) {
        const group = chain.find(g => g[field] != null && g[field] !== "")
        return group ? [group[field], group] : [null, null]
    }
    /* When an outside run waits for approval here: the nearest group's setting, else the site's. */
    function approvalPolicy(chain, s) {
        const [own] = nearest(chain, "outsideRunApproval")
        const policy = own || s.outsideRunApproval
        return OUTSIDE_APPROVALS.includes(policy) ? policy : "first"
    }

    // ===== the run check (git-ci run-check-service) =====
    const refuse = message => ({decision: "refuse", trusted: false, message})
    /* Whether an account has had a merge request merged in a repository: its contributions are not its first. */
    const contributed = (repositoryId, userId) =>
        !!userId && find(GMR, {repositoryId, authorUserId: userId, statusId: "GmrMerged"}).count() > 0
    /* Whether a Maintainer approved a run of this merge request before: the approval covers its later heads. */
    const approvedBefore = mergeRequestId =>
        !!mergeRequestId && find("moqui.resource.GitPipelineRun", {mergeRequestId, approvalState: "approved"}).count() > 0
    /* The run check, in the engine's terms (GitCiServices.check#PipelineRun): {} for a repository Smithy does not have
       (the engine's own rule), else {decision, trusted, message, ownerId, runnerPoolId}. */
    function decide(p) {
        const repo = p.repositoryId ? one(M + "SmithyRepository", {repositoryId: p.repositoryId}) : null
        if (!repo) return {}
        if (!core.mounted(repo.siteId)) return refuse("This site no longer runs pipelines")
        if (core.repositoryRights(repo, core.actor(null)).hidden)
            return refuse("This repository is hidden by a moderator: its pipelines do not run")
        if (repo.pipelinesEnabled !== "Y") return refuse("notAvailable: Pipelines are off in this repository")
        const s = core.settings(repo.siteId)
        const owner = ownerOf(repo, s)
        if (!owner) return refuse("This repository's group could not be read, so its pipelines do not run")
        const rankOf = a => (a.userId ? core.repositoryRights(repo, a).rank : 0)
        const user = core.actor(p.triggeredByUserId || null)
        const mr = p.mergeRequestId ? one(GMR, {mergeRequestId: p.mergeRequestId}) : null
        const author = mr ? core.actor(mr.authorUserId || null) : user
        // untrusted: commits from elsewhere (a fork's, a pushed-for-review or a detached merge request), or an account
        // below Developer that caused the run or wrote the merge request
        let trusted = flag(p.trusted)
        const elsewhere =
            !!p.sourceRepositoryId ||
            flag(p.pushedForReview) ||
            (!!mr && (!!mr.sourceRepositoryId || mr.pushedForReview === "Y" || !!mr.sourceDetachedDate))
        if (elsewhere) trusted = false
        if (user.userId && rankOf(user) < RANK.SmrDeveloper) trusted = false
        if (mr && rankOf(author) < RANK.SmrDeveloper) trusted = false
        // minutes: the owner's month, read before anything is counted
        const overQuota = quotaProblem(owner)
        if (overQuota) return refuse(overQuota)
        let decision = "allow"
        let message = null
        if (!trusted) {
            const policy = approvalPolicy(owner.chain, s)
            // a Maintainer who asks for an outside run (a re-run, a run by hand) approves it by asking
            const byMaintainer = !!user.userId && rankOf(user) >= RANK.SmrMaintainer
            const known =
                policy === "first" && (contributed(repo.repositoryId, author.userId) || approvedBefore(p.mergeRequestId))
            if (!byMaintainer && policy !== "never" && !known) {
                decision = "wait"
                message =
                    policy === "always"
                        ? "Waiting for a Maintainer's approval: outside runs wait for one here"
                        : "Waiting for a Maintainer's approval: a first contribution's runs wait for one"
            }
        }
        // the day's limit of the account's trust level: runs it asks for by hand, and its outside runs (counted last,
        // once the run is otherwise going to be queued)
        if (user.userId && (p.event === "manual" || !trusted)) {
            const counted = kit.forumScope.countPipelineRun({repositoryId: repo.repositoryId, userId: user.userId})
            if (!counted.allowed) return refuse("limitReached: " + (counted.message || "The day's pipeline runs are used up"))
        }
        return {decision, trusted, message, ownerId: owner.ownerId, runnerPoolId: poolOf(owner, trusted)}
    }
    /* The pool the pipeline settings name for a run's trust, while an operator still allows it; null leaves the engine's
       choice (a pool of the job's pool name that takes the run's trust, the owner's before a shared one). */
    function poolOf(owner, trusted) {
        if (owner.kind !== "group") return null
        const [poolId] = nearest(owner.chain, trusted ? "runnerPoolId" : "outsideRunnerPoolId")
        if (!poolId) return null
        const pool = (poolsFor(owner) || []).find(row => row.runnerPoolId === poolId)
        if (pool && pool.trusted === trusted) return poolId
        ec.logger.warn("Smithy pipeline settings of " + owner.label + " name pool " + poolId + ", which is not allowed now")
        return null
    }
    /* The check fails closed: what it cannot decide is refused, with words a status may carry. */
    function checkRun(p) {
        try {
            return decide(p || {})
        } catch (error) {
            ec.logger.error("Smithy's run check of repository " + p?.repositoryId + " failed: " + (error?.message || error))
            ec.message.clearErrors()
            return refuse("The run could not be checked now, so it did not start; try again")
        }
    }

    // ===== the run's page (git-ci run-url-service) =====
    const runPath = (repo, runNum, jobRunId) =>
        "/" + repo.repositoryPath + "/-/pipelines/" + Number(runNum) + (jobRunId ? "/jobs/" + jobRunId : "")
    /* The address of a run's page, or of one of its jobs, on the site's canonical host; null for a repository Smithy
       does not have or a site with no canonical host. */
    function runUrl(p) {
        const repo = p?.repositoryId ? one(M + "SmithyRepository", {repositoryId: p.repositoryId}) : null
        if (!repo) return null
        let runNum = number(p.runNum)
        if (!Number.isInteger(runNum) && p.pipelineRunId)
            runNum = number(one("moqui.resource.GitPipelineRun", {pipelineRunId: p.pipelineRunId})?.runNum)
        if (!Number.isInteger(runNum)) return null
        return publicApps().pageUrl(repo.siteId, "smithy", runPath(repo, runNum, p.jobRunId || null))
    }

    // ===== reading runs =====
    const STATE_IDS = ["waiting", "queued", "running", "success", "failure", "error", "cancelled"]
    /* A run's merge request as the caller holds it (a cache by id for a list): null when the caller may not read it. */
    function requestHeld(r, mergeRequestId, a, cache) {
        if (cache && cache.has(mergeRequestId)) return cache.get(mergeRequestId)
        const mr = one(GMR, {mergeRequestId})
        const held = mr && mr.repositoryId === r.repo.repositoryId ? reviews().heldRequest(r, mr, a) : null
        if (cache) cache.set(mergeRequestId, held)
        return held
    }
    /* Whether the caller reads a run: a merge request's by who reads that merge request (a held one's by its author and
       its moderators); any other while it is not hidden, or by an Owner and the site's staff. */
    function visible(r, run, a, cache) {
        if (run.mergeRequestId) return !!requestHeld(r, run.mergeRequestId, a, cache)
        return !flag(run.hidden) || r.rank >= RANK.SmrOwner || r.access.staff
    }
    function runView(r, run, extra = {}) {
        const mr = run.mergeRequestId ? one(GMR, {mergeRequestId: run.mergeRequestId}) : null
        const partyId = reviews().partyOfUser(run.triggeredByUserId)
        return {
            runNum: Number(run.runNum),
            pipelineName: run.pipelineName,
            definitionSource: run.definitionSource || null,
            event: run.event,
            refName: run.refName || null,
            commitId: run.commitId || null,
            mergeRequestNum: mr ? Number(mr.mergeRequestNum) : null,
            triggeredBy: reviews().profileView(r.repo.siteId, partyId)?.handle || null,
            state: run.statusId,
            message: run.statusMessage || null,
            trusted: flag(run.trusted),
            approvalState: run.approvalState || "none",
            createdAt: run.createdDate || null,
            startedAt: run.startedDate || null,
            finishedAt: run.finishedDate || null,
            durationSeconds: number(run.durationSeconds),
            path: runPath(r.repo, run.runNum, null),
            ...extra
        }
    }
    const jobView = (r, run, job) => ({
        jobRunId: job.jobRunId,
        jobName: job.jobName,
        matrixKey: job.matrixKey || null,
        context: job.context || null,
        attempt: Number(job.attempt || 1),
        needs: Array.from(job.needs || []),
        state: job.statusId,
        message: job.statusMessage || null,
        exitCode: number(job.exitCode),
        image: job.image || null,
        queuedAt: job.queuedDate || null,
        startedAt: job.startedDate || null,
        finishedAt: job.finishedDate || null,
        durationSeconds: number(job.durationSeconds),
        minutesUsed: number(job.minutesUsed),
        testCount: number(job.testCount),
        testFailedCount: number(job.testFailedCount),
        hasLog: !!job.hasLog,
        path: runPath(r.repo, run.runNum, job.jobRunId)
    })
    /* The jobs and failed tests of runs, by run id, in one read: the latest attempt of each job. */
    function jobCounts(runIds) {
        const counts = new Map()
        if (!runIds.length) return counts
        for (const job of find("moqui.resource.GitJobRun")
            .condition("pipelineRunId", "in", runIds)
            .selectField("pipelineRunId,superseded,testFailedCount")
            .limit(5000)
            .list()) {
            if (job.superseded === "Y") continue
            const count = counts.get(job.pipelineRunId) || {jobCount: 0, failedTestCount: 0}
            count.jobCount += 1
            count.failedTestCount += Number(job.testFailedCount || 0)
            counts.set(job.pipelineRunId, count)
        }
        return counts
    }
    /* A full ref from a branch name or a full ref. */
    const fullRef = name => (!name ? null : text(name).startsWith("refs/") ? text(name) : "refs/heads/" + text(name))
    /* The pipelines of a commit's ci.xml that have the manual event, by name (at most 50). A framework read of a
       commit's pipelines would replace this reading of the file's tags. */
    function manualPipelines(repositoryId, revision) {
        const blob = quiet("get#GitBlob", {repositoryId, revision, path: "ci.xml"})
        if (typeof blob.text !== "string") return []
        const names = []
        const source = blob.text.replace(/<!--[\s\S]*?-->/g, "")
        for (const tag of source.match(/<pipeline\b[^>]*>/g) || []) {
            const attribute = name => {
                const found = new RegExp("\\s" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')").exec(tag)
                return found ? (found[1] ?? found[2]) : ""
            }
            const name = attribute("name")
            if (/^[A-Za-z0-9._-]{1,64}$/.test(name) && attribute("on").split(/\s+/).includes("manual") && !names.includes(name))
                names.push(name)
        }
        return names.slice(0, 50)
    }
    /* A repository as the caller views it, or Not Found. */
    const viewed = p => core.repository(p.repositoryId, p.siteId)
    /* A run of a repository by its number as the caller reads it: {run, jobList}, or Not Found. */
    function runOf(r, p, a = core.actor()) {
        const runNum = number(p.runNum)
        if (!Number.isInteger(runNum) || runNum < 1) missing()
        const {out, problem} = engine("get#PipelineRun", {repositoryId: r.repo.repositoryId, runNum, includeHidden: true})
        if (problem != null || !out.run || !visible(r, out.run, a)) missing()
        return {run: out.run, jobList: Array.from(out.jobList || [])}
    }
    /* A job of a run as the caller reads it, with its steps, failed tests and uploads; Not Found for another run's. */
    function jobOf(r, p, a = core.actor()) {
        const {run} = runOf(r, p, a)
        if (!text(p.jobRunId)) missing()
        const {out, problem} = engine("get#JobRun", {jobRunId: text(p.jobRunId), includeHidden: true})
        if (problem != null || !out.job || out.run?.pipelineRunId !== run.pipelineRunId) missing()
        return {run, job: out.job, out}
    }
    methods.findPipelineRuns = p => {
        const r = viewed(p)
        const a = core.actor()
        if (p.state && !STATE_IDS.includes(p.state)) invalid("state must be one of " + STATE_IDS.join(", "))
        const filters = {
            repositoryId: r.repo.repositoryId,
            refName: fullRef(p.refName),
            event: p.event || null,
            statusId: p.state || null,
            commitId: p.commitId || null,
            pipelineName: p.pipelineName || null,
            includeHidden: true
        }
        if (given(p.mergeRequestNum) && p.mergeRequestNum !== "") {
            const mr = Array.from(
                find(GMR, {repositoryId: r.repo.repositoryId, mergeRequestNum: Number(p.mergeRequestNum)})
                    .limit(1)
                    .list()
            )[0]
            if (!mr || !requestHeld(r, mr.mergeRequestId, a, null)) missing()
            filters.mergeRequestId = mr.mergeRequestId
        }
        const pg = page(p, "smithyPipelineRuns:" + JSON.stringify([p.siteId, filters]))
        // the engine's pages, each run kept by the caller's view, until this page is full
        const BATCH = 100
        const cache = new Map()
        const kept = []
        let nextCursor = null
        let from = pg.offset
        scanning: for (;;) {
            const {out, problem} = engine("find#PipelineRuns", {...filters, pageIndex: Math.floor(from / BATCH), pageSize: BATCH})
            if (problem != null) invalid(problem.slice(0, 200))
            const batch = Array.from(out.runList || [])
            for (let index = from % BATCH; index < batch.length; index++) {
                const run = batch[index]
                if (!visible(r, run, a, cache)) continue
                if (kept.length === pg.limit) {
                    nextCursor = pg.next(Math.floor(from / BATCH) * BATCH + index)
                    break scanning
                }
                kept.push(run)
            }
            if (batch.length < BATCH) break
            from = (Math.floor(from / BATCH) + 1) * BATCH
        }
        const counts = jobCounts(kept.map(run => run.pipelineRunId))
        return {
            runList: kept.map(run => runView(r, run, counts.get(run.pipelineRunId) || {jobCount: 0, failedTestCount: 0})),
            pipelineList: manualPipelines(r.repo.repositoryId, r.git.branch || "main"),
            pipelinesEnabled: r.repo.pipelinesEnabled === "Y",
            canRun: canWrite(r, RANK.SmrDeveloper) && r.repo.pipelinesEnabled === "Y",
            nextCursor
        }
    }
    /* Whether the caller may make a move that needs a role: a confirmed account that is not suspended, in a repository
       that is not archived. */
    function canWrite(r, rank) {
        return !!me() && core.confirmedNow() && !r.access.suspended && !r.git?.archivedDate && r.rank >= rank
    }
    methods.getPipelineRun = p => {
        const r = viewed(p)
        const {run, jobList} = runOf(r, p)
        const ended = ENDED.includes(run.statusId)
        const failedTestCount = jobList.reduce((sum, job) => sum + Number(job.testFailedCount || 0), 0)
        return {
            run: runView(r, run, {jobCount: jobList.length, failedTestCount}),
            jobList: jobList.map(job => jobView(r, run, job)),
            capabilities: {
                canCancel:
                    !ended &&
                    (canWrite(r, RANK.SmrDeveloper) ||
                        (canWrite(r, 0) && !!ec.user.userId && run.triggeredByUserId === ec.user.userId)),
                canRerun: ended && canWrite(r, RANK.SmrDeveloper) && r.repo.pipelinesEnabled === "Y",
                canRetry: canWrite(r, RANK.SmrDeveloper) && r.repo.pipelinesEnabled === "Y",
                canApprove: run.approvalState === "waiting" && run.statusId === "waiting" && canWrite(r, RANK.SmrMaintainer)
            }
        }
    }
    methods.getJobRun = p => {
        const r = viewed(p)
        const {run, job, out} = jobOf(r, p)
        return {
            run: runView(r, run),
            job: jobView(r, run, job),
            stepList: Array.from(out.stepList || []).map(step => ({
                stepSeq: Number(step.stepSeq),
                stepName: step.stepName || null,
                command: step.command || "",
                state: step.statusId,
                exitCode: number(step.exitCode),
                firstChunkSeq: number(step.firstChunkSeq),
                startedAt: step.startedDate || null,
                finishedAt: step.finishedDate || null
            })),
            // a failed test's file and line link to the file at the run's commit
            failedTestList: Array.from(out.failedTestList || []).map(test => ({
                suiteName: test.suiteName || "",
                testName: test.testName || "",
                filePath: test.filePath || null,
                lineNumber: number(test.lineNumber),
                message: test.message || "",
                durationMillis: number(test.durationMillis)
            })),
            artifactList: Array.from(out.artifactList || []).map(artifact => ({
                artifactId: artifact.artifactId,
                artifactKind: artifact.artifactKind,
                name: artifact.name,
                fileName: artifact.fileName || artifact.name,
                sizeBytes: number(artifact.sizeBytes),
                sha256: artifact.sha256 || null,
                expiresAt: artifact.expireDate || null
            }))
        }
    }
    /* A job's log: while it runs the chunks after afterChunkSeq, once it has ended the stored log from offset (a page
       passes back both nextChunkSeq and nextOffset). A signed-in reader is told of new lines on the notification topic
       GitCiJobLog (sub-topic the job run's id) for a few minutes after each read, on the server that took the read; a
       page polls as well, every pollSeconds, and on a cluster that is what it has. */
    methods.getJobLog = p => {
        const r = viewed(p)
        const {job} = jobOf(r, p)
        const limit = p.limit == null || p.limit === "" ? 100 : Number(p.limit)
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) invalid("limit must be from 1 through 500")
        const watch = !!ec.user.userId && p.watch !== false && p.watch !== "false"
        const {out, problem} = engine("get#JobLog", {
            jobRunId: job.jobRunId,
            afterChunkSeq: number(p.afterChunkSeq) || 0,
            offset: number(p.offset) || 0,
            limit,
            watch,
            includeHidden: true
        })
        if (problem != null) missing()
        return {
            chunkList: Array.from(out.chunkList || []).map(chunk => ({
                chunkSeq: Number(chunk.chunkSeq),
                stepSeq: number(chunk.stepSeq),
                text: chunk.text || ""
            })),
            nextChunkSeq: number(out.nextChunkSeq),
            text: out.text ?? null,
            nextOffset: number(out.nextOffset),
            logBytes: number(out.logBytes),
            finished: !!out.finished,
            state: out.statusId || job.statusId,
            notification: watch ? {topic: "GitCiJobLog", subTopic: job.jobRunId} : null,
            pollSeconds: 2
        }
    }
    /* An artifact or a report as a download: copied once to a file the facade streams (at most DOWNLOAD_LIMIT bytes). */
    methods.downloadArtifact = p => {
        const r = viewed(p)
        const a = core.actor()
        if (!text(p.artifactId)) missing()
        const first = engine("get#RunArtifact", {
            artifactId: text(p.artifactId),
            offset: 0,
            maxBytes: DOWNLOAD_PIECE,
            includeHidden: true
        })
        const artifact = first.out.artifact
        if (first.problem != null || !artifact || !["artifact", "report"].includes(artifact.artifactKind)) missing()
        const owning = engine("get#JobRun", {jobRunId: artifact.jobRunId, includeHidden: true}).out.run
        if (!owning || owning.repositoryId !== r.repo.repositoryId || !visible(r, owning, a)) missing()
        const size = Number(artifact.sizeBytes || 0)
        if (size > DOWNLOAD_LIMIT) invalid("notAvailable: This upload is too large to download here")
        const report = artifact.artifactKind === "report"
        const fileName = text(artifact.fileName || artifact.name).replace(/[^A-Za-z0-9._-]/g, "_") || "artifact"
        const location =
            "runtime://tmp/ci-artifact/" + artifact.artifactId + "-" + text(artifact.sha256 || "x").slice(0, 16) + "-" + fileName
        const stored = ec.resource.getLocationReference(location)
        if (!stored.getExists() || Number(stored.getSize()) !== size) {
            const pieces = []
            let piece = first.out
            let total = 0
            for (;;) {
                const bytes = piece.bytes ? new Uint8Array(piece.bytes) : new Uint8Array(0)
                pieces.push(bytes)
                total += bytes.length
                if (piece.done || !bytes.length || total >= size) break
                const next = engine("get#RunArtifact", {
                    artifactId: artifact.artifactId,
                    offset: total,
                    maxBytes: DOWNLOAD_PIECE,
                    includeHidden: true
                })
                if (next.problem != null) missing()
                piece = next.out
            }
            const whole = new Uint8Array(total)
            let at = 0
            for (const bytes of pieces) {
                whole.set(bytes, at)
                at += bytes.length
            }
            stored.putBytes(whole)
        }
        return {
            file: {
                filename: fileName,
                mimeType: report ? "application/xml" : "application/gzip",
                size,
                inline: false
            },
            sha256: artifact.sha256 || null,
            location
        }
    }

    // ===== moves =====
    /* A writer with a role on a repository whose pipelines are on: {r, partyId}. */
    function mover(p, role) {
        const r = viewed(p)
        writer(p.siteId)
        core.requireRole(r, role)
        if (r.git.archivedDate) archived()
        return {r}
    }
    function pipelinesOn(r) {
        if (r.repo.pipelinesEnabled !== "Y") invalid("notAvailable: Pipelines are off in this repository")
    }
    /* A move that would start jobs is refused before it reaches the engine when the owner's minutes are used up. */
    function requireMinutes(r) {
        const owner = ownerOf(r.repo)
        const problem = owner ? quotaProblem(owner) : "This repository's group could not be read"
        if (problem) invalid(problem)
    }
    /* What a move that queued a run answers: its number and state, and a refused run's reason. */
    function queuedView(r, out) {
        const runNum = number(out.runNum)
        const state = out.statusId || null
        let message = null
        if (state === "error" || state === "waiting")
            message =
                engine("get#PipelineRun", {repositoryId: r.repo.repositoryId, runNum, includeHidden: true}).out.run
                    ?.statusMessage || null
        return {runNum, state, message, path: runNum ? runPath(r.repo, runNum, null) : null}
    }
    methods.runPipeline = p => {
        const {r} = mover(p, "SmrDeveloper")
        pipelinesOn(r)
        if (!/^[A-Za-z0-9._-]{1,64}$/.test(text(p.pipelineName))) invalid("pipelineName names no pipeline")
        return receipt(p, "smithy.runPipeline", () => {
            requireMinutes(r)
            const out = engineMove("run#Pipeline", {
                repositoryId: r.repo.repositoryId,
                pipelineName: p.pipelineName,
                refName: text(p.refName) || null
            })
            return queuedView(r, out)
        })
    }
    methods.rerunPipelineRun = p => {
        const {r} = mover(p, "SmrDeveloper")
        pipelinesOn(r)
        const {run} = runOf(r, p)
        if (!ENDED.includes(run.statusId)) fail("Conflict", "The run has not ended")
        return receipt(p, "smithy.rerunPipelineRun", () => {
            requireMinutes(r)
            return queuedView(r, engineMove("rerun#PipelineRun", {pipelineRunId: run.pipelineRunId, includeHidden: true}))
        })
    }
    methods.cancelPipelineRun = p => {
        const r = viewed(p)
        writer(p.siteId)
        const {run} = runOf(r, p)
        // a Developer, or the account that asked for the run
        if (!(ec.user.userId && run.triggeredByUserId === ec.user.userId)) core.requireRole(r, "SmrDeveloper")
        if (ENDED.includes(run.statusId)) fail("Conflict", "The run has ended")
        const out = engineMove("cancel#PipelineRun", {pipelineRunId: run.pipelineRunId, includeHidden: true})
        return {state: out.statusId || "cancelled"}
    }
    methods.retryJobRun = p => {
        const {r} = mover(p, "SmrDeveloper")
        pipelinesOn(r)
        const {job} = jobOf(r, p)
        if (!ENDED.includes(job.statusId)) fail("Conflict", "The job has not ended")
        return receipt(p, "smithy.retryJobRun", () => {
            requireMinutes(r)
            const out = engineMove("retry#JobRun", {jobRunId: job.jobRunId, includeHidden: true})
            return {jobRunId: out.jobRunId || null, state: out.statusId || null}
        })
    }
    methods.approvePipelineRun = p => {
        const {r} = mover(p, "SmrMaintainer")
        const {run} = runOf(r, p)
        if (run.approvalState !== "waiting" || run.statusId !== "waiting") fail("Conflict", "The run does not wait for approval")
        const out = engineMove("approve#PipelineRun", {pipelineRunId: run.pipelineRunId, includeHidden: true})
        return {state: out.statusId || null, approvalState: out.approvalState || null}
    }

    // ===== secrets and environments (§11 Pipelines) =====
    const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
    const ENVIRONMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
    const SCOPES = ["protected", "tags", "environment"]
    /* The engine's secrets and environments of a repository, after Smithy's role check. The engine's own right for them
       is delete (a maintainer's in its terms); Smithy's Maintainer is checked here and the engine called with
       authorization disabled. */
    const secretsOf = repositoryId => Array.from(engineMove("find#CiSecrets", {repositoryId}).secretList || [])
    const environmentsOf = repositoryId => Array.from(engineMove("find#CiEnvironments", {repositoryId}).environmentList || [])
    function maintainer(p) {
        const r = viewed(p)
        writer(p.siteId)
        core.requireRole(r, "SmrMaintainer")
        return r
    }
    methods.findCiSecrets = p => {
        const r = viewed(p)
        requireRoleRead(r, "SmrMaintainer")
        return {
            secretList: secretsOf(r.repo.repositoryId).map(secret => ({
                secretId: secret.secretId,
                name: secret.name,
                scope: secret.scope || "protected",
                environmentId: secret.environmentId || null,
                environmentName: secret.environmentName || null,
                createdAt: secret.createdDate || null,
                lastUsedAt: secret.lastUsedDate || null
            })),
            canChange: canWrite(r, RANK.SmrMaintainer)
        }
    }
    /* A read that needs a role: signed in, with the role (no confirmed address needed to read). */
    function requireRoleRead(r, role) {
        if (!me()) fail("AuthenticationRequired", "Sign in to continue")
        core.requireRole(r, role)
    }
    methods.storeCiSecret = p => {
        const r = maintainer(p)
        if (r.git.archivedDate) archived()
        const repositoryId = r.repo.repositoryId
        const existing = secretsOf(repositoryId)
        const editing = text(p.secretId) ? existing.find(secret => secret.secretId === p.secretId) || missing() : null
        const name = given(p.name) && p.name !== "" ? text(p.name) : editing?.name
        if (!SECRET_NAME.test(text(name))) invalid("name must be a variable name: letters, digits and _")
        const scope = given(p.scope) && p.scope !== "" ? p.scope : editing?.scope || "protected"
        if (!SCOPES.includes(scope)) invalid("scope must be protected, tags or environment")
        const environmentId = scope === "environment" ? text(p.environmentId) || editing?.environmentId || null : null
        if (scope === "environment" && !environmentsOf(repositoryId).some(env => env.environmentId === environmentId))
            invalid("environmentId names no environment of this repository")
        if (
            existing.some(
                secret =>
                    secret.secretId !== editing?.secretId &&
                    secret.name === name &&
                    (secret.environmentId || null) === environmentId
            )
        )
            invalid("nameTaken: A secret of that name is there")
        const value = given(p.value) && p.value !== "" ? String(p.value) : null
        if (!editing && value == null) invalid("value is required")
        // a secret moved to another scope or environment takes a new value: the old one was given for the old scope
        if (
            editing &&
            value == null &&
            (scope !== (editing.scope || "protected") || environmentId !== (editing.environmentId || null))
        )
            invalid("value is required when a secret moves to another scope or environment")
        const store = () =>
            engineMove("store#CiSecret", {repositoryId, secretId: editing?.secretId || null, name, value, scope, environmentId})
        if (editing) {
            store()
            return {secretId: editing.secretId}
        }
        // the receipt keeps no trace of the value
        return receipt({...p, value: null}, "smithy.storeCiSecret", () => ({secretId: store().secretId || null}))
    }
    methods.deleteCiSecret = p => {
        const r = maintainer(p)
        const repositoryId = r.repo.repositoryId
        if (!secretsOf(repositoryId).some(secret => secret.secretId === p.secretId)) missing()
        engineMove("delete#CiSecret", {repositoryId, secretId: p.secretId})
        return {deleted: true}
    }
    methods.findCiEnvironments = p => {
        const r = viewed(p)
        requireRoleRead(r, "SmrDeveloper")
        return {
            environmentList: environmentsOf(r.repo.repositoryId).map(env => ({
                environmentId: env.environmentId,
                name: env.name,
                targetUrl: env.targetUrl || null,
                requiredPipeline: env.requiredPipeline || null,
                approvalRequired: flag(env.approvalRequired),
                allowedRefs: env.allowedRefs || null,
                hasToken: flag(env.hasToken),
                lastCommitId: env.lastCommitId || null,
                lastDeployAt: env.lastDeployDate || null
            })),
            canChange: canWrite(r, RANK.SmrMaintainer)
        }
    }
    methods.storeCiEnvironment = p => {
        const r = maintainer(p)
        if (r.git.archivedDate) archived()
        const repositoryId = r.repo.repositoryId
        const existing = environmentsOf(repositoryId)
        const editing = text(p.environmentId) ? existing.find(env => env.environmentId === p.environmentId) || missing() : null
        const name = given(p.name) && p.name !== "" ? text(p.name) : editing?.name
        if (!ENVIRONMENT_NAME.test(text(name))) invalid("name must be letters, digits, '.', '-' and '_'")
        if (existing.some(env => env.environmentId !== editing?.environmentId && env.name === name))
            invalid("nameTaken: An environment of that name is there")
        // which runs get its secrets: a protected ref's, a branch allowedRefs names (patterns separated by spaces), and with
        // approvalRequired only an approved run. The target, its token and the required pipeline are DG10's (deployments)
        const allowedRefs = given(p.allowedRefs)
            ? text(p.allowedRefs)
                  .trim()
                  .split(/\s+/)
                  .filter(ref => ref)
                  .join(" ")
            : undefined
        if (allowedRefs && !allowedRefs.split(" ").every(ref => /^[A-Za-z0-9._\/*-]{1,200}$/.test(ref)))
            invalid("allowedRefs must be branch patterns separated by spaces")
        const store = () =>
            engineMove("store#CiEnvironment", {
                repositoryId,
                environmentId: editing?.environmentId || null,
                name,
                ...(allowedRefs !== undefined ? {allowedRefs: allowedRefs || null} : {}),
                ...(given(p.approvalRequired) && p.approvalRequired !== "" ? {approvalRequired: flag(p.approvalRequired)} : {})
            })
        if (editing) {
            store()
            return {environmentId: editing.environmentId}
        }
        return receipt(p, "smithy.storeCiEnvironment", () => ({environmentId: store().environmentId || null}))
    }
    methods.deleteCiEnvironment = p => {
        const r = maintainer(p)
        const repositoryId = r.repo.repositoryId
        if (!environmentsOf(repositoryId).some(env => env.environmentId === p.environmentId)) missing()
        if (secretsOf(repositoryId).some(secret => secret.environmentId === p.environmentId))
            fail("Conflict", "A secret is scoped to this environment; delete it or move it first")
        engineMove("delete#CiEnvironment", {repositoryId, environmentId: p.environmentId})
        return {deleted: true}
    }

    // ===== pipeline settings: pools, approval, minutes (§11 Pipelines) =====
    /* The settings as a repository's or a group's Maintainer reads them: the pools an operator allowed the owner, the
       pools chosen (and the group they are inherited from), when outside runs wait, and the month's minutes. */
    methods.getPipelineSettings = p => {
        if (!!p.repositoryId === !!p.groupId) invalid("repositoryId or groupId is required")
        const s = core.settings(p.siteId)
        let r
        let owner
        let group
        let pipelineList = []
        if (p.repositoryId) {
            r = viewed(p)
            requireRoleRead(r, "SmrMaintainer")
            owner = ownerOf(r.repo, s) || missing()
            group = owner.chain[0] || null
            pipelineList = manualPipelines(r.repo.repositoryId, r.git.branch || "main")
        } else {
            r = core.group(p.groupId, p.siteId)
            requireRoleRead(r, "SmrMaintainer")
            owner = groupOwner(r.chain, s)
            group = r.group
        }
        const pick = field => {
            const [value, from] = nearest(owner.chain, field)
            return {value: value || null, from: from && from.groupId !== group?.groupId ? from.groupPath : null}
        }
        const trusted = pick("runnerPoolId")
        const outside = pick("outsideRunnerPoolId")
        const approval = pick("outsideRunApproval")
        const used = usageOf(owner.ownerId)
        const ownerRank = group ? core.groupRights(group, core.actor()).rank : 0
        return {
            owner: {kind: owner.kind, label: owner.label},
            poolList: poolsFor(owner) || [],
            runnerPoolId: trusted.value,
            outsideRunnerPoolId: outside.value,
            outsideRunApproval: approval.value || s.outsideRunApproval,
            inheritedFromPath: trusted.from || outside.from || approval.from || null,
            usage: {
                minutesUsed: used ? used.minutesUsed : null,
                runnerMinutesMonthly: owner.limit,
                periodKey: used ? used.periodKey : null
            },
            pipelineList,
            groupId: group?.groupId || null,
            canStore: !!group && ownerRank >= RANK.SmrOwner && !!me() && core.confirmedNow(),
            revision: group ? Number(group.revision || 1) : null
        }
    }
    methods.storePipelineSettings = p => {
        const r = core.group(p.groupId, p.siteId)
        writer(p.siteId)
        core.requireRole(r, "SmrOwner")
        const group = one(M + "SmithyGroup", {groupId: r.group.groupId}, true)
        const before = Number(group.revision || 1)
        if (p.expectedRevision == null || p.expectedRevision === "" || Number(p.expectedRevision) !== before)
            fail("Conflict", "staleRevision: This changed since you read it; reload and try again")
        const owner = groupOwner(r.chain, core.settings(p.siteId))
        const fields = {}
        const pools = given(p.runnerPoolId) || given(p.outsideRunnerPoolId) ? poolsFor(owner) : []
        if (pools == null) fail("Unavailable", "The runner pools could not be read now; try again")
        for (const [field, trusted] of [
            ["runnerPoolId", true],
            ["outsideRunnerPoolId", false]
        ]) {
            if (!given(p[field])) continue
            const poolId = text(p[field]) || null
            if (poolId && !pools.some(pool => pool.runnerPoolId === poolId && pool.trusted === trusted))
                invalid(field + " names no pool this group may use for " + (trusted ? "trusted" : "outside") + " runs")
            fields[field] = poolId
        }
        if (given(p.outsideRunApproval)) {
            if (p.outsideRunApproval && !OUTSIDE_APPROVALS.includes(p.outsideRunApproval))
                invalid("outsideRunApproval must be first, always or never")
            fields.outsideRunApproval = p.outsideRunApproval || null
        }
        update(group, {...fields, revision: before + 1})
        audit(p.siteId, null, "group", group.groupId, "storePipelineSettings", Object.keys(fields).join(" "), before, before + 1)
        return {revision: before + 1}
    }

    // ===== the merge box (§9.1 MergeRequestChecks) =====
    /* What the merge box shows of a merge request's runs at its head: the runs, each check of a ci/ context linked to its
       run, the required contexts that have no status yet, and whether the head changes ci.xml. A required context is
       the branch rule's; its job is defined by the ci.xml the run read, the head's own. So when the head's ci.xml is not
       the target branch's, a required ci/ check ran a file this merge request wrote: ciFileChanged, and a Maintainer
       merges it (requiredRole). */
    function mergeChecks(r, mr, checkList, requiredContexts) {
        const {out} = engine("find#PipelineRuns", {
            repositoryId: r.repo.repositoryId,
            mergeRequestId: mr.mergeRequestId,
            commitId: mr.headCommitId || "_NONE_",
            includeHidden: true,
            pageSize: 50
        })
        const runs = Array.from(out.runList || [])
        const newest = new Map()
        for (const run of runs) if (!newest.has(run.pipelineName)) newest.set(run.pipelineName, run)
        const checks = checkList.map(check => {
            const run = check.context.startsWith("ci/") ? newest.get(check.context.split("/")[1]) : null
            return {...check, runNum: run ? Number(run.runNum) : null, path: run ? runPath(r.repo, run.runNum, null) : null}
        })
        for (const context of requiredContexts)
            if (!checks.some(check => check.context === context))
                checks.push({
                    context,
                    state: "expected",
                    description: "Not reported for this head",
                    targetUrl: null,
                    required: true,
                    runNum: null,
                    path: null
                })
        const changed = requiredContexts.some(context => context.startsWith("ci/")) && ciFileChanged(r, mr)
        return {
            checkList: checks,
            runList: runs.map(run => runView(r, run)),
            ciFileChanged: changed,
            requiredRole: changed ? "SmrMaintainer" : null
        }
    }
    /* Whether a merge request's head has another ci.xml than its target branch (a file of its own, or none). */
    function ciFileChanged(r, mr) {
        if (!mr.headCommitId) return false
        const fileAt = (revision, includeHidden) =>
            quiet("get#GitBlob", {repositoryId: r.repo.repositoryId, revision, path: "ci.xml", includeHidden}).text ?? null
        return fileAt(mr.headCommitId, true) !== fileAt(text(mr.targetRef).replace(/^refs\/heads\//, ""), false)
    }

    return {checkRun, runUrl, groupMinutes, accountMinutes, mergeChecks, ciFileChanged, ownerOf, groupKey, accountKey}
}
