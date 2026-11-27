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
 * - checkRun is the engine's run check (git-ci run-check-service): allow, wait, refuse or skip (pipelines off), the
 *   trust, the owner the run's usage counts under (the top-level group, or the account of a personal repository) and
 *   the pool. It fails closed.
 * - runUrl is the engine's run URL (git-ci run-url-service): the run's page on the site's canonical host.
 * - checkOutbound is the git server's outbound check (git-server outbound-check-service): a hidden repository's, or one
 *   of a site that no longer mounts Smithy, sends no webhook and pushes to no mirror.
 * Entity access is privileged here; every operation passes the evaluator first.
 */
kit => {
    const {core, methods, flag, text, writer} = kit
    const {M, forum, RANK} = core
    const {me, find, one, create, update, fail, missing, invalid, page, receipt, audit} = forum
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
    /* The minutes a run that has not ended holds back of its owner's month: each of its jobs that has not ended its
       timeout (the engine's default-timeout-minutes when it names none), and a run at most RUN_RESERVE_MINUTES. A run
       about to be queued holds as much for its jobCount. */
    const JOB_MINUTES = 60
    const RUN_RESERVE_MINUTES = 60
    /* The engine's batches findPipelineRuns reads for one page of runs the caller may read, at most. */
    const MAX_SCAN_BATCHES = 10
    /* What one read of a job's log answers at most: chunks (each up to the engine's batch size), and their bytes, or the
       bytes of an ended job's stored log. */
    const LOG_CHUNK_LIMIT = 100
    const LOG_MAX_BYTES = 262144

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
    /* The minutes a run of jobCount jobs holds back while it has not ended. */
    const runNeed = jobCount => (jobCount > 0 ? Math.min(jobCount * JOB_MINUTES, RUN_RESERVE_MINUTES) : 0)
    /* The minutes an owner's runs that have not ended (queued or running) hold back of its month; a run that waits for
       approval holds none until it is approved. */
    function reservedMinutes(ownerId) {
        const runIds = Array.from(
            find("moqui.resource.GitPipelineRun", {ownerId})
                .condition("statusId", "in", ["queued", "running"])
                .selectField("pipelineRunId")
                .limit(500)
                .list()
        ).map(run => run.pipelineRunId)
        if (!runIds.length) return 0
        const byRun = new Map()
        for (const job of find("moqui.resource.GitJobRun")
            .condition("pipelineRunId", "in", runIds)
            .condition("statusId", "in", ["waiting", "queued", "running"])
            .selectField("pipelineRunId,superseded,timeoutMinutes")
            .limit(5000)
            .list()) {
            if (job.superseded === "Y") continue
            byRun.set(job.pipelineRunId, (byRun.get(job.pipelineRunId) || 0) + (Number(job.timeoutMinutes) || JOB_MINUTES))
        }
        let total = 0
        for (const minutes of byRun.values()) total += Math.min(minutes, RUN_RESERVE_MINUTES)
        return total
    }
    /* Whether an owner may start a run of jobCount jobs now: null, or the refusal's text (a code and its words; plain,
       as a status's description is). What the month has used, with what the runs not ended hold back, must leave the
       run's own share (runNeed). A usage that cannot be read refuses. */
    function quotaProblem(owner, jobCount = 1) {
        if (!(owner.limit > 0))
            return owner.kind === "account"
                ? "policyRefused: A personal repository runs pipelines only with runner minutes the site's operators gave its account"
                : "quotaExceeded: The group " + owner.label + " has no runner minutes"
        const used = usageOf(owner.ownerId)
        if (!used) return "The runner minutes used could not be read now, so the run did not start; try again"
        const of = " of " + owner.label + " for " + used.periodKey
        if (used.minutesUsed >= owner.limit)
            return "quotaExceeded: The runner minutes" + of + " are used up (" + used.minutesUsed + " of " + owner.limit + ")"
        const need = runNeed(jobCount)
        if (!need) return null
        const reserved = reservedMinutes(owner.ownerId)
        const left = owner.limit - used.minutesUsed - reserved
        if (left < need)
            return (
                "quotaExceeded: The runner minutes left" +
                of +
                " (" +
                Math.max(left, 0) +
                ", with " +
                reserved +
                " held for runs that have not ended) do not cover this run's " +
                need
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
    const APPROVAL = M + "SmithyRunApproval"
    /* Whether an account has had a merge request merged in a repository by another account, through merge#MergeRequest
       (mergedByUserId) and so with a change (a merge commit or new commits): its contributions are no longer outside
       ones. A merge request the git host marked merged because the target already held its head counts for nothing. */
    function contributed(repositoryId, a) {
        if (!a?.userId) return false
        return Array.from(
            find(GMR, {repositoryId, authorUserId: a.userId, statusId: "GmrMerged"})
                .condition("mergedByUserId", "not-equals", a.userId)
                .selectField("mergedByUserId,mergeCommitId")
                .limit(20)
                .list()
        ).some(
            mr =>
                !!mr.mergedByUserId &&
                !!mr.mergeCommitId &&
                (!a.partyId || reviews().partyOfUser(mr.mergedByUserId) !== a.partyId)
        )
    }
    /* Who brought a merge request's head commit: the account of the first push or write that reached it in its source
       repository (a fork's), else in the target; null when none is recorded. */
    function headPusher(mr, commitId) {
        if (!commitId) return null
        for (const repositoryId of [mr.sourceRepositoryId, mr.repositoryId]) {
            if (!repositoryId) continue
            const row = one("moqui.resource.GitCommitPush", {repositoryId, commitId})
            if (row?.userId) return row.userId
        }
        return null
    }
    const pusherKey = userId => userId || "_NA_"
    /* Whether a Maintainer approved a run of this merge request at this head, brought by this pusher: an approval
       covers the head it was given for, until a new head comes. */
    const approvedHead = (mr, commitId, pusherUserId) =>
        !!mr && !!commitId && !!one(APPROVAL, {mergeRequestId: mr.mergeRequestId, commitId, pusherUserId: pusherKey(pusherUserId)})
    /* Whether a personal repository's account is suspended on its site. */
    const ownerSuspended = repo =>
        !!repo.ownerPartyId && core.siteAccess(repo.siteId, core.actorOfParty(repo.ownerPartyId)).suspended
    /* The run check, in the engine's terms (GitCiServices.check#PipelineRun): {} for a repository Smithy does not have
       (the engine's own rule), else {decision, trusted, message, ownerId, runnerPoolId}. */
    function decide(p) {
        const repo = p.repositoryId ? one(M + "SmithyRepository", {repositoryId: p.repositoryId}) : null
        if (!repo) return {}
        // pipelines off: nothing at all, no run and no status
        if (repo.pipelinesEnabled !== "Y")
            return {decision: "skip", trusted: false, message: "notAvailable: Pipelines are off in this repository"}
        if (!core.mounted(repo.siteId)) return refuse("This site no longer runs pipelines")
        if (core.repositoryRights(repo, core.actor(null)).hidden)
            return refuse("This repository is hidden by a moderator: its pipelines do not run")
        if (one("moqui.resource.GitRepository", {repositoryId: repo.repositoryId})?.archivedDate)
            return refuse("repositoryArchived: This repository is archived: its pipelines do not run")
        if (ownerSuspended(repo)) return refuse("accessDenied: This repository's account is suspended on this site")
        const s = core.settings(repo.siteId)
        const owner = ownerOf(repo, s)
        if (!owner) return refuse("This repository's group could not be read, so its pipelines do not run")
        const rankOf = a => (a.userId ? core.repositoryRights(repo, a).rank : 0)
        const user = core.actor(p.triggeredByUserId || null)
        const mr = p.mergeRequestId ? one(GMR, {mergeRequestId: p.mergeRequestId}) : null
        const commitId = p.commitId || mr?.headCommitId || null
        const pusherId = mr ? headPusher(mr, commitId) : null
        // whose code runs: a merge request's author and its head's pusher (the account that caused the run when no
        // pusher is recorded), else the account that caused the run
        const coders = []
        for (const a of mr ? [core.actor(mr.authorUserId || null), pusherId ? core.actor(pusherId) : user] : [user])
            if (!coders.some(known => known.userId === a.userId)) coders.push(a)
        // untrusted: commits from elsewhere (a fork's, a pushed-for-review or a detached merge request), or an account
        // below Developer that caused the run or whose code runs
        let trusted = flag(p.trusted)
        const elsewhere =
            !!p.sourceRepositoryId ||
            flag(p.pushedForReview) ||
            (!!mr && (!!mr.sourceRepositoryId || mr.pushedForReview === "Y" || !!mr.sourceDetachedDate))
        if (elsewhere) trusted = false
        if (user.userId && rankOf(user) < RANK.SmrDeveloper) trusted = false
        if (coders.some(a => a.userId && rankOf(a) < RANK.SmrDeveloper)) trusted = false
        // the error run of a pipeline file that is not valid (pipelineName ci.xml, no jobs): nothing runs, so nothing
        // waits and no minutes or day's runs are counted
        const jobCount = p.jobCount == null || p.jobCount === "" ? 1 : Number(p.jobCount)
        if (jobCount === 0)
            return {decision: "allow", trusted, message: null, ownerId: owner.ownerId, runnerPoolId: poolOf(owner, trusted)}
        if (!trusted && jobCount > Number(s.outsideRunMaxJobs))
            return refuse(
                "policyRefused: An outside run has at most " + s.outsideRunMaxJobs + " jobs here; this one has " + jobCount
            )
        // minutes: the owner's month with what its runs not ended hold back, read before anything is counted
        const overQuota = quotaProblem(owner, jobCount)
        if (overQuota) return refuse(overQuota)
        let decision = "allow"
        let message = null
        if (!trusted) {
            const policy = approvalPolicy(owner.chain, s)
            // a Maintainer who runs a pipeline by hand approves it by asking; any other run of theirs (a re-run, the
            // reopening of a merge request) is judged by whose code runs
            const byMaintainer = p.event === "manual" && !!user.userId && rankOf(user) >= RANK.SmrMaintainer
            // first: until each account whose code runs has had a merge request merged by another account here, each
            // new head waits for a Maintainer again
            const known =
                policy === "first" &&
                (approvedHead(mr, commitId, pusherId) ||
                    (coders.length > 0 && coders.every(a => contributed(repo.repositoryId, a))))
            if (!byMaintainer && policy !== "never" && !known) {
                decision = "wait"
                message =
                    policy === "always"
                        ? "Waiting for a Maintainer's approval: outside runs wait for one here"
                        : "Waiting for a Maintainer's approval: each new head of an outside contribution waits for one"
            }
        }
        // the day's limit of the account's trust level: runs it asks for by hand (a manual run, a deployment's), and its
        // outside runs (counted last, once the run is otherwise going to be queued)
        if (user.userId && (p.event === "manual" || p.event === "deploy" || !trusted)) {
            const counted = kit.forumScope.countPipelineRun({repositoryId: repo.repositoryId, userId: user.userId})
            if (!counted.allowed) return refuse("limitReached: " + (counted.message || "The day's pipeline runs are used up"))
        }
        return {decision, trusted, message, ownerId: owner.ownerId, runnerPoolId: poolOf(owner, trusted)}
    }
    /* Record a Maintainer's approval of a merge request's run: its head, as brought by its pusher, runs without waiting
       again. */
    function recordApproval(run) {
        const mr = run.mergeRequestId ? one(GMR, {mergeRequestId: run.mergeRequestId}) : null
        if (!mr || !run.commitId) return
        const key = {mergeRequestId: mr.mergeRequestId, commitId: run.commitId, pusherUserId: pusherKey(headPusher(mr, run.commitId))}
        if (one(APPROVAL, key)) return
        create(APPROVAL, {
            ...key,
            repositoryId: mr.repositoryId,
            approvedByUserId: ec.user.userId || null,
            pipelineRunId: run.pipelineRunId,
            approvedDate: ec.user.nowTimestamp
        })
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

    // ===== what a repository sends out (git-server outbound-check-service) =====
    /* Whether a repository may send its webhooks and push to its push mirror now: {allowed, message}. Allowed for a
       repository Smithy does not have; held for one of a site that no longer mounts Smithy, a hidden one (by itself, a
       group above it or the repository it was forked from) and a personal one whose account is suspended. It fails
       closed. */
    function checkOutbound(p) {
        try {
            const repo = p?.repositoryId ? one(M + "SmithyRepository", {repositoryId: p.repositoryId}) : null
            if (!repo) return {allowed: true, message: null}
            if (!core.mounted(repo.siteId)) return {allowed: false, message: "This site no longer runs Smithy"}
            if (core.repositoryRights(repo, core.actor(null)).hidden)
                return {allowed: false, message: "This repository is hidden by a moderator"}
            if (ownerSuspended(repo)) return {allowed: false, message: "This repository's account is suspended on this site"}
            // before a push's webhook deliveries: a webhook whose setter lost the repository is turned off (SEC-PFS-102)
            if (p.kind === "webhook") core.pauseLostWebhooks([repo.repositoryId])
            return {allowed: true, message: null}
        } catch (error) {
            ec.logger.error("Smithy's outbound check of repository " + p?.repositoryId + " failed: " + (error?.message || error))
            ec.message.clearErrors()
            return {allowed: false, message: "What this repository sends out could not be checked now"}
        }
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
    /* The pipelines of a commit that have the manual event, by name (at most 50), as the engine reads its ci.xml
       (get#PipelineDefinitions); none for a commit it cannot read. */
    function manualPipelines(repositoryId, revision) {
        const {out, problem} = engine("get#PipelineDefinitions", {repositoryId, revision})
        if (problem != null) return []
        const names = []
        for (const pipeline of Array.from(out.pipelineList || [])) {
            const name = text(pipeline.pipelineName)
            if (name && flag(pipeline.manual) && !names.includes(name)) names.push(name)
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
        // at most MAX_SCAN_BATCHES of the engine's batches for one page: past them the page ends where the scan stopped
        // and its cursor goes on from there
        let batches = 0
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
            if (++batches >= MAX_SCAN_BATCHES) {
                nextCursor = pg.next(from)
                break
            }
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
    /* The UTF-8 bytes of a text. */
    function utf8Bytes(value) {
        let bytes = 0
        for (const ch of String(value || "")) {
            const code = ch.codePointAt(0)
            bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
        }
        return bytes
    }
    /* A repository whose pipelines are off has no runs to show: its runs' logs and uploads are Not Found. */
    function pipelinesShown(r) {
        if (r.repo.pipelinesEnabled !== "Y") missing()
    }
    methods.getJobLog = p => {
        const r = viewed(p)
        pipelinesShown(r)
        const {job} = jobOf(r, p)
        const asked = p.limit == null || p.limit === "" ? LOG_CHUNK_LIMIT : Number(p.limit)
        if (!Number.isInteger(asked) || asked < 1 || asked > 500) invalid("limit must be from 1 through 500")
        const limit = Math.min(asked, LOG_CHUNK_LIMIT)
        const watch = !!ec.user.userId && p.watch !== false && p.watch !== "false"
        const {out, problem} = engine("get#JobLog", {
            jobRunId: job.jobRunId,
            afterChunkSeq: number(p.afterChunkSeq) || 0,
            offset: number(p.offset) || 0,
            limit,
            maxBytes: LOG_MAX_BYTES,
            watch,
            includeHidden: true
        })
        if (problem != null) missing()
        // at most LOG_MAX_BYTES of chunks in one answer (always the first): the rest is the next read's
        const all = Array.from(out.chunkList || [])
        const chunks = []
        let bytes = 0
        let nextChunkSeq = number(out.nextChunkSeq)
        let nextOffset = number(out.nextOffset)
        let cut = false
        for (const chunk of all) {
            const size = utf8Bytes(chunk.text)
            if (chunks.length && bytes + size > LOG_MAX_BYTES) {
                cut = true
                const dropped = all.slice(chunks.length)
                nextChunkSeq = Number(chunk.chunkSeq)
                if (nextOffset != null) nextOffset -= dropped.reduce((sum, one) => sum + utf8Bytes(one.text), 0)
                break
            }
            bytes += size
            chunks.push({chunkSeq: Number(chunk.chunkSeq), stepSeq: number(chunk.stepSeq), text: chunk.text || ""})
        }
        return {
            chunkList: chunks,
            nextChunkSeq,
            text: out.text ?? null,
            nextOffset,
            logBytes: number(out.logBytes),
            // more is there to read now: the chunk limit or the byte bound cut this answer (a running job's log may
            // still grow when it is false)
            more:
                cut ||
                all.length >= limit ||
                (out.text != null && nextOffset != null && number(out.logBytes) != null && nextOffset < number(out.logBytes)),
            finished: !!out.finished,
            state: out.statusId || job.statusId,
            notification: watch ? {topic: "GitCiJobLog", subTopic: job.jobRunId} : null,
            pollSeconds: 2
        }
    }
    /* An artifact or a report as a download, sent as this request's response by the engine (send#RunArtifact: streamed
       from its content with Range, ETag and If-Range, nothing copied). Who may read it is decided first from the rows
       alone: the upload's run must be of this repository, its job of that run, and the run one the caller reads; a
       cache, another repository's upload and a repository whose pipelines are off are Not Found. Under the REST servlet
       answers {sent, file, sha256}: the response is written, so the transport writes nothing more; with no response (the
       PASS gRPC path) {file, sha256, location}, the artifact's ci-artifact:// location the transport streams. */
    methods.downloadArtifact = p => {
        const r = viewed(p)
        pipelinesShown(r)
        const a = core.actor()
        if (!text(p.artifactId)) missing()
        const artifact = one("moqui.resource.GitRunArtifact", {artifactId: text(p.artifactId)})
        if (!artifact || !["artifact", "report"].includes(artifact.artifactKind)) missing()
        if (artifact.repositoryId !== r.repo.repositoryId) missing()
        const owning = artifact.pipelineRunId ? one("moqui.resource.GitPipelineRun", {pipelineRunId: artifact.pipelineRunId}) : null
        const job = artifact.jobRunId ? one("moqui.resource.GitJobRun", {jobRunId: artifact.jobRunId}) : null
        if (!owning || owning.repositoryId !== r.repo.repositoryId || job?.pipelineRunId !== owning.pipelineRunId) missing()
        if (!visible(r, owning, a)) missing()
        const report = artifact.artifactKind === "report"
        const fileName = text(artifact.name) + (report ? "" : ".tar.gz")
        const file = {
            filename: fileName.replace(/[^A-Za-z0-9._-]/g, "_") || "artifact",
            mimeType: report ? "application/xml" : "application/gzip",
            size: number(artifact.sizeBytes),
            // never inline: a job's output is whatever its commit wrote (a report is XML, an active type)
            inline: false
        }
        // the REST servlet's request: the engine sends it as this response, with Range, ETag and If-Range
        if (ec.web?.response) {
            const {problem} = engine("send#RunArtifact", {artifactId: artifact.artifactId, inline: false, includeHidden: true})
            if (problem != null) missing()
            return {sent: true, file, sha256: artifact.sha256 || null}
        }
        // over the PASS gRPC path (and any caller with no response): the artifact's read-only ci-artifact:// location,
        // which the transport opens as the authority (Pipelines.md, An artifact's location)
        const location = artifactLocation(artifact.artifactId, engine)
        if (!location) missing()
        return {file, sha256: artifact.sha256 || null, location}
    }
    /* An artifact's ci-artifact:// location, as get#RunArtifact's map has it (the engine's own check, a hidden run's with
       authorization off); null when the engine does not find it. read: the module's engine call ({out, problem}, or
       out alone). */
    function artifactLocation(artifactId, read) {
        const answer = read("get#RunArtifact", {artifactId, maxBytes: 1, includeHidden: true})
        const out = answer && "problem" in answer ? (answer.problem == null ? answer.out : null) : answer
        const found = out?.artifact
        if (!found) return null
        if (found.location) return text(found.location)
        // the location's form (Pipelines.md): the id, and the name it is sent under with no path separator in it
        const fileName = text(found.fileName) || text(found.name) + (found.artifactKind === "report" ? "" : ".tar.gz")
        return "ci-artifact://" + artifactId + (fileName ? "/" + fileName.replace(/[/\\]/g, "_") : "")
    }
    kit.artifactLocation = artifactLocation

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
    function requireMinutes(r, jobCount = 1) {
        const owner = ownerOf(r.repo)
        const problem = owner ? quotaProblem(owner, jobCount) : "This repository's group could not be read"
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
    /* Approve a run that waits: checked again as the run check does at queue time (pipelines on, and the owner's minutes
       with what its runs not ended hold back covering this run's jobs). A merge request's approval is recorded for its
       head and the head's pusher, so later runs of that head do not wait (SmithyRunApproval). */
    methods.approvePipelineRun = p => {
        const {r} = mover(p, "SmrMaintainer")
        pipelinesOn(r)
        const {run, jobList} = runOf(r, p)
        if (run.approvalState !== "waiting" || run.statusId !== "waiting") fail("Conflict", "The run does not wait for approval")
        requireMinutes(r, Math.max(jobList.filter(job => !ENDED.includes(job.statusId)).length, 1))
        const out = engineMove("approve#PipelineRun", {pipelineRunId: run.pipelineRunId, includeHidden: true})
        recordApproval(run)
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
    // ===== environments and deployments (DG10; docs/interfaces/Pipelines.md "Deployments") =====
    /* The engine's environment and deployment services, after Smithy's own check. Reads (find#CiEnvironments,
       find#GitDeployments, get#GitDeployment) and the environment's writes are called as the caller, with authorization
       on whatever the operation's: the engine's rights there are check#GitRepositoryAuthz's, which are Smithy's (view as
       Smithy views; update a Developer's, delete a Maintainer's, each with a confirmed address), so the engine answers
       each caller what it may read (a target's address, a deployment's raw error: a Maintainer's). {out, problem}. */
    function asCaller(name, parameters) {
        const wasDisabled = ec.artifactExecution.authzDisabled()
        if (wasDisabled) ec.artifactExecution.enableAuthz()
        try {
            return engine(name, parameters)
        } finally {
            if (wasDisabled) ec.artifactExecution.disableAuthz()
        }
    }
    /* A refusal of the engine as the operation's: Not Found, accessDenied for the engine's rights, Conflict for a state. */
    function deployRefused(name, problem) {
        ec.logger.warn("Smithy deployment call " + name + " refused: " + problem)
        if (/not found|no such/i.test(problem)) missing()
        if (/may not|not authorized|not an approver|approver|asked for it|requester/i.test(problem))
            fail("Unauthorized", "accessDenied: " + problem.slice(0, 200))
        if (/does not wait|has ended|has begun|ended|not the head|is not the head|moved/i.test(problem))
            fail("Conflict", problem.slice(0, 200))
        invalid(problem.slice(0, 200))
    }
    function asCallerMove(name, parameters) {
        const {out, problem} = asCaller(name, parameters)
        if (problem != null) deployRefused(name, problem)
        return out
    }
    /* A deployment's move (decide, cancel; a request's is requestDeploy's own), after Smithy's checks (the role, the
       requester, the state), with authorization disabled, in a transaction of its own: the engine moves a
       deployment by a conditional statement in the database, which misses a row that a held transaction (the
       operation's, under the transaction cache) still keeps, so a deployment just made would stay requested; and its
       own right check, were it called as the caller, would run Mantle's check#GitRepositoryAuthz, an XML service whose
       join turns holding on in that transaction too. The engine records the signed-in user as who asked, decided or
       cancelled. */
    function deployMove(name, parameters) {
        const {out, problem} = ec.transaction.runRequireNew(null, "A Smithy deployment move failed", () => engine(name, parameters))
        if (problem != null) deployRefused(name, problem)
        return out
    }
    const PIPELINE_NAME = /^[A-Za-z0-9._-]{1,64}$/
    /* An https or http address with a user part (user:password@) carries a credential: refused, as the engine will. */
    const withUserInfo = url => /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*@/.test(text(url).trim()) && /^https?:/i.test(text(url).trim())
    methods.findCiEnvironments = p => {
        const r = viewed(p)
        requireRoleRead(r, "SmrDeveloper")
        const {out, problem} = asCaller("find#CiEnvironments", {repositoryId: r.repo.repositoryId})
        if (problem != null) missing()
        return {
            environmentList: Array.from(out.environmentList || []).map(env => ({
                environmentId: env.environmentId,
                name: env.name,
                // a target's addresses are the engine's to give: a Maintainer's, as is the vault of its token
                targetUrl: env.targetUrl || null,
                vaultId: r.rank >= RANK.SmrMaintainer ? env.vaultId || null : null,
                cloneUrl: env.cloneUrl || null,
                requiredPipeline: env.requiredPipeline || null,
                approvalRequired: flag(env.approvalRequired),
                // who waits for an approval: every deployment, or (the engine's rule) one of a branch no rule protects,
                // which allowedRefs alone lets deploy
                approvalFor: flag(env.approvalRequired) ? "every" : "unprotected",
                dataTypes: env.dataTypes ? String(env.dataTypes).split(",").filter(name => name) : [],
                allowedRefs: env.allowedRefs || null,
                hasToken: flag(env.hasToken),
                lastCommitId: env.lastCommitId || null,
                lastDeploymentId: env.lastDeploymentId || null,
                lastDeployAt: env.lastDeployDate || null
            })),
            canChange: canWrite(r, RANK.SmrMaintainer),
            canDeploy: canWrite(r, RANK.SmrDeveloper) && r.repo.pipelinesEnabled === "Y"
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
        // which runs get its secrets and which branches deploy to it: a protected ref's, and a branch allowedRefs names
        // (patterns separated by spaces); with approvalRequired only an approved run, and an approver's decision
        const allowedRefs = given(p.allowedRefs)
            ? text(p.allowedRefs)
                  .trim()
                  .split(/\s+/)
                  .filter(ref => ref)
                  .join(" ")
            : undefined
        if (allowedRefs && !allowedRefs.split(" ").every(ref => /^[A-Za-z0-9._\/*-]{1,200}$/.test(ref)))
            invalid("allowedRefs must be branch patterns separated by spaces")
        // a pattern names branches or tags: none takes every ref (*, **, refs/heads/*...), which would give the
        // environment's secrets to any branch a Developer pushes
        if (allowedRefs && allowedRefs.split(" ").some(ref => /^[*\/]*$/.test(ref.replace(/^refs\/(?:heads\/|tags\/)?/, ""))))
            invalid("allowedRefs must name branches or tags: a pattern of only wildcards takes every one")
        // the deployment fields (DG10): an empty value clears one, a left-out one stays. The target's token is no field
        // of the environment: it is an item of an operational vault (vaultId), bound to
        // GitCiEnvironment:<environmentId>:targetToken, which a member of the vault makes in their client and a
        // deployment reads under its lease (plans/archive/Vault-Instances.md §4.6); no operation takes a token (SmithySchema.js
        // refuses the field). The engine's store#CiEnvironment clears what a change would hand to a wider audience: the
        // values of the environment's secrets when allowedRefs widens or approvalRequired goes from Y to N (SEC-GIT-91);
        // it says so as its cleared, which the save returns for Smithy's notice. Smithy has no approver groups: an
        // approval is any Maintainer's but the requester's, so approverGroupId is always cleared
        if (given(p.approverGroupId) && p.approverGroupId !== "")
            invalid("approverGroupId: Smithy has no approver groups; a Maintainer other than the requester approves")
        const cleared = value => (value === "" ? null : text(value).trim())
        const deployFields = {approverGroupId: null}
        for (const field of ["targetUrl", "cloneUrl", "requiredPipeline"]) if (given(p[field])) deployFields[field] = cleared(p[field])
        // the data types the target loads of the component's data files, signed in each attestation: names separated
        // by commas or spaces; empty for the target's defaults
        if (given(p.dataTypes)) {
            const names = text(p.dataTypes)
                .split(/[\s,]+/)
                .filter(name => name)
            if (names.length > 20 || !names.every(name => /^[A-Za-z0-9_-]{1,60}$/.test(name)))
                invalid("dataTypes must be data type names separated by commas")
            deployFields.dataTypes = names.length ? names.join(",") : null
        }
        if (deployFields.requiredPipeline && !PIPELINE_NAME.test(deployFields.requiredPipeline))
            invalid("requiredPipeline names no pipeline")
        if (deployFields.targetUrl && withUserInfo(deployFields.targetUrl))
            invalid("targetUrl: An address with no user or password in it")
        if (deployFields.cloneUrl && withUserInfo(deployFields.cloneUrl))
            invalid("cloneUrl: An address with no user or password in it")
        // the vault of the target's token: an operational vault the Maintainer is a member of, else the same refusal as
        // for none, so no other vault is named or confirmed
        if (given(p.vaultId) && p.vaultId !== "") {
            const vaultId = text(p.vaultId).trim()
            const vault = /^[A-Za-z0-9._-]{1,64}$/.test(vaultId)
                ? ec.entity.find("moqui.security.vault.Vault").condition("vaultId", vaultId).disableAuthz().one()
                : null
            const member =
                vault?.vaultKindEnumId === "VkOperational" &&
                !!ec.user.userId &&
                ec.entity
                    .find("moqui.security.vault.VaultMember")
                    .condition({vaultId, userId: ec.user.userId})
                    .conditionDate("fromDate", "thruDate", null)
                    .disableAuthz()
                    .count() > 0
            if (!member) invalid("vaultId: No operational vault of that id that you are a member of")
            deployFields.vaultId = vaultId
        } else if (given(p.vaultId)) deployFields.vaultId = null
        const store = () => {
            const out = asCallerMove("store#CiEnvironment", {
                repositoryId,
                environmentId: editing?.environmentId || null,
                name,
                ...(allowedRefs !== undefined ? {allowedRefs: allowedRefs || null} : {}),
                ...(given(p.approvalRequired) && p.approvalRequired !== "" ? {approvalRequired: flag(p.approvalRequired)} : {}),
                ...deployFields
            })
            kit.maintainerAudit(p, "storeCiEnvironment", name)
            return out
        }
        // what the engine cleared (its cleared, a sentence; none when nothing was) goes back with the save
        if (editing) {
            const out = store() || {}
            return {environmentId: editing.environmentId, cleared: out.cleared || null}
        }
        return receipt(p, "smithy.storeCiEnvironment", () => ({environmentId: store().environmentId || null}))
    }
    methods.deleteCiEnvironment = p => {
        const r = maintainer(p)
        const repositoryId = r.repo.repositoryId
        if (!environmentsOf(repositoryId).some(env => env.environmentId === p.environmentId)) missing()
        if (secretsOf(repositoryId).some(secret => secret.environmentId === p.environmentId))
            fail("Conflict", "A secret is scoped to this environment; delete it or move it first")
        asCallerMove("delete#CiEnvironment", {repositoryId, environmentId: p.environmentId})
        kit.maintainerAudit(p, "deleteCiEnvironment", p.environmentId)
        return {deleted: true}
    }
    const DEPLOY_STATES = ["requested", "waiting-pipeline", "waiting-approval", "deploying", "deployed", "failed", "refused", "cancelled"]
    const handleOfUser = (r, userId) =>
        userId ? reviews().profileView(r.repo.siteId, reviews().partyOfUser(userId))?.handle || null : null
    function deploymentView(r, d) {
        const runNum = number(d.runNum)
        let result = null
        try {
            result = d.deployResult ? JSON.parse(d.deployResult) : null
        } catch (error) {
            result = null
        }
        // the target's problems are its own words, a Maintainer's to read, as the engine gives errorText
        if (result && typeof result === "object" && r.rank < RANK.SmrMaintainer) delete result.problems
        return {
            deploymentId: d.deploymentId,
            environmentId: d.environmentId || null,
            environment: d.environment || d.environmentName || null,
            commitId: d.commitId || null,
            refName: d.refName || null,
            componentName: d.componentName || null,
            state: d.statusId,
            // it waits for an approver once its pipeline passes (its environment's rule, or a branch no rule protects)
            approvalRequired: flag(d.approvalRequired),
            runNum,
            runPath: runNum ? runPath(r.repo, runNum, null) : null,
            requestedBy: handleOfUser(r, d.requestedByUserId),
            approvedBy: handleOfUser(r, d.approvedByUserId),
            refusedBy: handleOfUser(r, d.refusedByUserId),
            approvedAt: d.approvedDate || null,
            result,
            // what the engine gives the caller (a raw error is a Maintainer's)
            message: d.errorText || null,
            createdAt: d.createdDate || null,
            startedAt: d.startedDate || null,
            finishedAt: d.finishedDate || null
        }
    }
    /* A deployment of the repository as the caller reads it: {deployment, canDecide, canCancel}, or Not Found. */
    function deploymentOf(r, p) {
        if (!text(p.deploymentId)) missing()
        const {out, problem} = asCaller("get#GitDeployment", {deploymentId: text(p.deploymentId)})
        if (problem != null || !out.deployment || out.deployment.repositoryId !== r.repo.repositoryId) missing()
        return out
    }
    const mine = d => !!ec.user.userId && d.requestedByUserId === ec.user.userId
    /* A deployment's lease (plans/archive/Vault-Instances.md §4.6 of mr-moqui): its environment's vault holds the target's token,
       which its deploy step opens under a lease asked for once its pipeline passed. Approving the lease in the framework's
       lease dialog (System › Vaults › Lease, in the approver's browser) is the deployment's approval when its approver
       decides it, as the engine holds it (decide_by_lease, and decide for a lease opened before the decision): not who
       asked, and a Maintainer with a confirmed address (check#GitRepositoryAuthz's delete right, Smithy's rights). The
       lease as read: {leaseId, state (waiting, open, ended, revoked), approvedByUserId, approverIds (the vault's approve
       role at its current key version who so decide it)}, or null for a deployment with no lease. */
    const LEASE_STATES = {VlsRequested: "waiting", VlsOpen: "open", VlsEnded: "ended", VlsRevoked: "revoked"}
    function leaseOf(r, d) {
        if (!d.leaseId) return null
        const system = entity => ec.entity.find(entity).useCache(false).disableAuthz()
        const lease = system("moqui.security.vault.VaultLease").condition("leaseId", d.leaseId).one()
        if (!lease) return null
        const vault = system("moqui.security.vault.Vault").condition("vaultId", lease.vaultId).one()
        const vaultApprovers = vault
            ? Array.from(
                  system("moqui.security.vault.VaultMember")
                      .condition({vaultId: lease.vaultId, keyVersion: vault.keyVersion, roleEnumId: "VrApprove"})
                      .list()
              ).map(row => row.userId)
            : []
        const decides = userId => {
            if (!userId || userId === d.requestedByUserId) return false
            const held = core.rights(r.repo.repositoryId, userId)
            return held.rank >= RANK.SmrMaintainer && held.confirmed
        }
        return {
            leaseId: lease.leaseId,
            state: LEASE_STATES[lease.statusId] || "ended",
            approvedByUserId: lease.approvedByUserId || null,
            approverIds: vaultApprovers.filter((userId, at, all) => all.indexOf(userId) === at && decides(userId)).slice(0, 50)
        }
    }
    /* The lease as getDeployment answers it: its state and who approved it (a handle the caller is shown) to whoever reads
       the deployment; who approves it (handles) and whether the caller is one to a Maintainer. */
    function leaseView(r, lease) {
        if (!lease) return null
        const maintainer = canWrite(r, RANK.SmrMaintainer)
        return {
            leaseId: lease.leaseId,
            state: lease.state,
            approvedBy: handleOfUser(r, lease.approvedByUserId),
            approvers: maintainer ? lease.approverIds.map(userId => handleOfUser(r, userId)).filter(Boolean) : null,
            canApprove: maintainer && !!ec.user.userId && lease.approverIds.includes(ec.user.userId)
        }
    }
    /* The states a deployment is cancelled in, as the engine cancels: before its deploy step begins. */
    const cancellable = d =>
        ["requested", "waiting-pipeline", "waiting-approval"].includes(d.statusId) || (d.statusId === "deploying" && !d.startedDate)
    methods.findDeployments = p => {
        const r = viewed(p)
        requireRoleRead(r, "SmrDeveloper")
        const limit = Math.min(Math.max(Number(p.limit || 20), 1), 100)
        const pageIndex = Math.max(Number(p.pageIndex || 0), 0)
        if (given(p.state) && p.state !== "" && !DEPLOY_STATES.includes(p.state)) invalid("state names no deployment state")
        const {out, problem} = asCaller("find#GitDeployments", {
            repositoryId: r.repo.repositoryId,
            environment: text(p.environment) || null,
            statusId: text(p.state) || null,
            commitId: text(p.commitId) || null,
            pageIndex,
            pageSize: limit
        })
        if (problem != null) missing()
        return {
            deploymentList: Array.from(out.deploymentList || []).map(d => deploymentView(r, d)),
            deploymentCount: number(out.deploymentCount) || 0,
            pageIndex,
            limit,
            canDeploy: canWrite(r, RANK.SmrDeveloper) && r.repo.pipelinesEnabled === "Y"
        }
    }
    methods.getDeployment = p => {
        const r = viewed(p)
        requireRoleRead(r, "SmrDeveloper")
        const {deployment} = deploymentOf(r, p)
        const own = mine(deployment)
        return {
            deployment: deploymentView(r, deployment),
            lease: leaseView(r, leaseOf(r, deployment)),
            // Smithy's own rules, as decideDeploy and cancelDeploy hold them: a Maintainer decides one waiting for approval,
            // never the requester; a Developer cancels their own, a Maintainer any, before its deploy step begins
            capabilities: {
                canDecide: deployment.statusId === "waiting-approval" && !own && canWrite(r, RANK.SmrMaintainer),
                canCancel: cancellable(deployment) && (canWrite(r, RANK.SmrMaintainer) || (own && canWrite(r, RANK.SmrDeveloper)))
            }
        }
    }
    methods.requestDeploy = p => {
        const {r} = mover(p, "SmrDeveloper")
        pipelinesOn(r)
        const environment = text(p.environment)
        const environmentId = text(p.environmentId)
        if (!environment && !environmentId) invalid("environment is required")
        if (environment && !ENVIRONMENT_NAME.test(environment)) invalid("environment names no environment")
        // an environment of this repository only
        if (environmentId && !environmentsOf(r.repo.repositoryId).some(env => env.environmentId === environmentId)) missing()
        const commitId = text(p.commitId)
        if (commitId && !/^[0-9a-f]{40}$/.test(commitId)) invalid("commitId is a full commit id")
        requireMinutes(r)
        return deployReceipt(p, "smithy.requestDeploy", () => {
            const {out, problem} = engine("request#GitDeployment", {
                repositoryId: r.repo.repositoryId,
                ...(environmentId ? {environmentId} : {environment}),
                refName: text(p.refName) || null,
                commitId: commitId || null
            })
            if (problem != null) deployRefused("request#GitDeployment", problem)
            const run = out.pipelineRunId ? one("moqui.resource.GitPipelineRun", {pipelineRunId: out.pipelineRunId}) : null
            return {
                deploymentId: out.deploymentId || null,
                state: out.statusId || null,
                message: out.message || null,
                runNum: run ? Number(run.runNum) : null,
                runPath: run ? runPath(r.repo, run.runNum, null) : null
            }
        })
    }
    /* receipt (ForumCore) for requestDeploy, with the deployment and the receipt row written in one transaction of
       their own, so a retry finds either both or neither: the operation's receipt is read first (a retry answers what
       the first call did), then, in a new transaction (why: deployMove), the engine's request, with authorization
       disabled after Smithy's checks, and the receipt row. A racing retry's receipt makes the slower one roll back,
       its deployment with it. */
    function deployReceipt(p, action, work) {
        const actorPartyId = forum.requireUser()
        if (!/^[A-Za-z0-9_-]{8,64}$/.test(p.operationId || ""))
            invalid("operationId must contain 8–64 letters, numbers, underscores or hyphens")
        const key = {siteId: p.siteId, actorPartyId, operationId: p.operationId, action}
        const payload = {...p}
        delete payload.operationId
        const payloadHash = forum.hash(JSON.stringify(Object.fromEntries(Object.entries(payload).sort(([a], [b]) => a.localeCompare(b)))))
        const answer = row => {
            if (row.payloadHash !== payloadHash) fail("Conflict", "Operation ID was used with different input")
            return JSON.parse(row.resultJson)
        }
        const old = one("mantle.forum.ForumOperationReceipt", key)
        if (old) return answer(old)
        return ec.transaction.runRequireNew(null, "A Smithy deployment request failed", () => {
            const result = work()
            create("mantle.forum.ForumOperationReceipt", {...key, payloadHash, resultJson: JSON.stringify(result)})
            return result
        })
    }
    methods.decideDeploy = p => {
        const {r} = mover(p, "SmrMaintainer")
        const {deployment} = deploymentOf(r, p)
        // the engine's approver for an environment with no approver group (Smithy names none) is a maintainer, the delete
        // right, which check#GitRepositoryAuthz gives a Maintainer with a confirmed address: what mover checked
        if (mine(deployment)) fail("Unauthorized", "accessDenied: Who asked for a deployment does not decide it")
        if (!["approve", "refuse"].includes(p.decision)) invalid("decision is approve or refuse")
        if (deployment.statusId !== "waiting-approval") fail("Conflict", "The deployment does not wait for approval")
        // the reason is Smithy's audit's: the engine writes a refusal's reason into its error and the commit's status
        const reason = text(p.reason).trim().slice(0, 1000)
        // a deployment with a lease is approved by opening the lease, in the approver's browser (the lease dialog): a
        // Maintainer who approves for the vault goes on to it; anyone else is told who approves it
        const lease = p.decision === "approve" ? leaseOf(r, deployment) : null
        const approvers = () =>
            lease.approverIds.length
                ? lease.approverIds
                      .map(userId => handleOfUser(r, userId))
                      .filter(Boolean)
                      .map(handle => "@" + handle)
                      .join(", ") || "a Maintainer whose profile you are not shown"
                : "none of this repository's Maintainers other than who asked is one; a manager of the vault adds one"
        // a lease opened already by someone who does not decide it (who asked, or not such a Maintainer) approves nothing:
        // the engine would refuse the deployment for it
        if (lease && lease.state === "open" && !lease.approverIds.includes(lease.approvedByUserId))
            fail(
                "Conflict",
                "The lease of its target's token was approved by someone who does not decide this deployment: refuse it, and deploy again"
            )
        if (lease && lease.state !== "open") {
            if (lease.state !== "waiting")
                fail(
                    "Conflict",
                    "The lease of its target's token has " +
                        lease.state +
                        ": the deployment fails, and deploying it takes a new request"
                )
            if (!ec.user.userId || !lease.approverIds.includes(ec.user.userId))
                fail(
                    "Conflict",
                    "vaultApproverRequired: The deployment is approved by opening the lease of its target's token, which an approver of the environment's vault does: " +
                        approvers()
                )
            kit.maintainerAudit(
                p,
                "decideDeploy",
                "sent to the lease dialog: " + deployment.deploymentId + ", lease " + lease.leaseId
            )
            return {state: deployment.statusId, leaseId: lease.leaseId}
        }
        kit.maintainerAudit(p, "decideDeploy", p.decision + " " + deployment.deploymentId + (reason ? ": " + reason : ""))
        const out = deployMove("decide#GitDeployment", {deploymentId: deployment.deploymentId, decision: p.decision})
        return {state: out.statusId || null}
    }
    methods.cancelDeploy = p => {
        const r = viewed(p)
        writer(p.siteId)
        const {deployment} = deploymentOf(r, p)
        // a Developer cancels their own, a Maintainer any; not in an archived repository (as the page's canCancel)
        core.requireRole(r, mine(deployment) ? "SmrDeveloper" : "SmrMaintainer")
        if (r.git.archivedDate) archived()
        if (!cancellable(deployment)) fail("Conflict", "The deployment has begun or ended")
        const out = deployMove("cancel#GitDeployment", {deploymentId: deployment.deploymentId})
        return {state: out.statusId || null}
    }
    /* handle#DeploymentNotice: the engine told a deployment's requester that it waits for approval, and the approver
       group when its environment names one; with none, the repository's Maintainers and Owners (other than the
       requester) are told too, on the same topic, with the repository as the record (which the rule leaves alone). */
    function deploymentNotice(p) {
        const message = forum.json(p.messageJson, {})
        if (message.statusId !== "waiting-approval") return {notified: 0}
        const repositoryId = text(message.repositoryId || p.subTopic)
        const repo = repositoryId ? one(M + "SmithyRepository", {repositoryId}) : null
        // the row as it is now, not the notice's word: an end's notice may still say waiting-approval
        const deployment = message.deploymentId
            ? ec.entity
                  .find("moqui.resource.GitDeployment")
                  .condition("deploymentId", text(message.deploymentId))
                  .useCache(false)
                  .one()
            : null
        if (!repo || !deployment || deployment.repositoryId !== repositoryId || deployment.statusId !== "waiting-approval")
            return {notified: 0}
        const environment = deployment.environmentId
            ? one("moqui.resource.GitCiEnvironment", {environmentId: deployment.environmentId})
            : null
        // an environment with an approver group (not one Smithy made: it names none) has its group told by the engine
        if (!environment || environment.approverGroupId) return {notified: 0}
        const userIds = core.maintainerUserIds(repositoryId, [deployment.requestedByUserId])
        if (!userIds.length) return {notified: 0}
        const where = repo.repositoryPath || repositoryId
        const environmentName = deployment.environmentName || environment.name
        ec.makeNotificationMessage()
            .topic("GitDeployment")
            .subTopic(repositoryId)
            .userIds(userIds)
            .record(M + "SmithyRepository", repositoryId)
            // the title is a template expanded with the message's fields: values go in the message, never in the text,
            // where a name holding ${...} would run as script (plans/Security-Review.md SEC-SCR-05)
            .title("The deployment of ${where} ${commitShort} to ${environment} waits for approval")
            .message({
                deploymentId: deployment.deploymentId,
                where,
                commitShort: text(deployment.commitId).slice(0, 12),
                repositoryId,
                repositoryPath: repo.repositoryPath || null,
                environment: environmentName,
                commitId: deployment.commitId || null,
                statusId: "waiting-approval"
            })
            .showAlert(true)
            .persistOnSend(true)
            .send()
        return {notified: userIds.length}
    }
    kit.deploymentNotice = deploymentNotice

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
        const top = owner.chain[owner.chain.length - 1] || null
        const ownOf = field => (group && group[field] != null && group[field] !== "" ? group[field] : null)
        return {
            owner: {kind: owner.kind, label: owner.label},
            poolList: poolsFor(owner) || [],
            // the values in effect, each from the group itself or the nearest group above that sets it
            runnerPoolId: trusted.value,
            outsideRunnerPoolId: outside.value,
            outsideRunApproval: approval.value || s.outsideRunApproval,
            inheritedFromPath: trusted.from || outside.from || approval.from || null,
            // the group's own values (null where it inherits), and where each value in effect comes from: a group path
            // above, "site" for the site's setting, null for the group's own
            own: {
                runnerPoolId: ownOf("runnerPoolId"),
                outsideRunnerPoolId: ownOf("outsideRunnerPoolId"),
                outsideRunApproval: ownOf("outsideRunApproval")
            },
            inheritedFrom: {
                runnerPoolId: trusted.from,
                outsideRunnerPoolId: outside.from,
                outsideRunApproval: approval.value ? approval.from : "site"
            },
            // never (outside runs that never wait) is set only by the top-level group's Owner
            canSetNever: !!top && core.groupRights(top, core.actor()).rank >= RANK.SmrOwner,
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
        // a field sent is set; one sent as null or empty is cleared, so the group inherits it again; one left out stays
        const sent = field => p[field] !== undefined
        const pools = given(p.runnerPoolId) || given(p.outsideRunnerPoolId) ? poolsFor(owner) : []
        if (pools == null) fail("Unavailable", "The runner pools could not be read now; try again")
        for (const [field, trusted] of [
            ["runnerPoolId", true],
            ["outsideRunnerPoolId", false]
        ]) {
            if (!sent(field)) continue
            const poolId = text(p[field]) || null
            if (poolId && !pools.some(pool => pool.runnerPoolId === poolId && pool.trusted === trusted))
                invalid(field + " names no pool this group may use for " + (trusted ? "trusted" : "outside") + " runs")
            fields[field] = poolId
        }
        if (sent("outsideRunApproval")) {
            const policy = text(p.outsideRunApproval) || null
            if (policy && !OUTSIDE_APPROVALS.includes(policy)) invalid("outsideRunApproval must be first, always or never")
            // outside runs that never wait are the top-level group's Owner's word, for every group below it
            const top = r.chain[r.chain.length - 1]
            if (policy === "never" && core.groupRights(top, core.actor()).rank < RANK.SmrOwner)
                fail("Unauthorized", "accessDenied: Only an Owner of the top-level group lets outside runs start without approval")
            fields.outsideRunApproval = policy
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
    /* Whether a merge request's head has another ci.xml at its root than its target branch (a file of its own, or none
       where the target has one). Only ci.xml is compared. It fails closed: a read that fails, or a file that is not
       text, counts as changed. */
    function ciFileChanged(r, mr) {
        if (!mr.headCommitId) return false
        const fileAt = (revision, includeHidden) => {
            ec.message.pushErrors()
            try {
                const out =
                    ec.service
                        .sync()
                        .name(GIT + "get#GitBlob")
                        .parameters({repositoryId: r.repo.repositoryId, revision, path: "ci.xml", includeHidden})
                        .call() || {}
                if (ec.message.hasError()) return {failed: true}
                // no size: no file there
                if (out.size == null) return {text: null}
                return typeof out.text === "string" ? {text: out.text} : {failed: true}
            } finally {
                ec.message.clearErrors()
                ec.message.popErrors()
            }
        }
        const head = fileAt(mr.headCommitId, true)
        const target = fileAt(text(mr.targetRef).replace(/^refs\/heads\//, ""), false)
        if (head.failed || target.failed) return true
        return head.text !== target.text
    }

    return {
        checkRun,
        runUrl,
        checkOutbound,
        groupMinutes,
        accountMinutes,
        mergeChecks,
        ciFileChanged,
        ownerOf,
        groupKey,
        accountKey
    }
}
