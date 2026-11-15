// Smithy's pipelines (mr-pass plan/design-smithy.md §10, §15.6, DG5; SmithyPipelines.js) over the framework's engine. The
// run check (SmithyPipelineServices.check#Run): a Developer's push is trusted and runs in the pool the group chose, under
// its top-level group; an outside run (an account below Developer, a fork's merge request) waits until its author has had
// a merge request merged by another account through a merge (not one the target already held, not their own), and each
// new head of an outside merge request waits again (a Maintainer's approval covers the head it was given for; reopening
// the merge request approves nothing); an outside run has at most outsideRunMaxJobs jobs; a personal repository runs
// only with minutes an operator gave, and the minutes running jobs hold back count; used-up minutes refuse; pipelines
// off skip. Through the engine (a fake host, real commits with a ci.xml), which asks Smithy's run check and run URL
// from mr-mantle's conf: a push's runs carry Smithy's owner and the statuses link to the run's page; run, cancel,
// approve and secrets by role, holder and non-holder; the merge box shows a failed check of a run and the required
// context blocks the merge; a held merge request's run, and its artifact (sent by send#RunArtifact), are Not Found to a
// stranger and read by its author. The outbound check holds a hidden repository's webhooks. A failed job is simulated
// by a failure status the engine's way (create#GitCommitStatus as the system), since a spec cannot play the runner.
// Regression suite: these are rules. Run: ./moq test mr-mantle --spec SmithyPipelines
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const SITE = "SPL_SITE"
const HOST = "spl.smithy.test"
const CI = "org.moqui.git.GitCiServices."
const ids = {}
const op = (username, operation, input) => lib.op(username, SITE, operation, {repositoryId: ids.repositoryId, ...input})
const siteOp = (username, operation, input) => lib.op(username, SITE, operation, input)
const check = (userId, more = {}) =>
    lib.run("mantle.smithy.SmithyPipelineServices.check#Run", {
        repositoryId: ids.repositoryId,
        event: "push",
        refName: "refs/heads/main",
        triggeredByUserId: userId,
        trusted: true,
        ...more
    })
const CI_XML =
    '<ci><pipeline name="check" on="push manual merge-request">' +
    '<job name="unit" image="moqui-build"><step run="true"/></job></pipeline></ci>\n'
/* A commit of files on a branch of the repository as a user (its event's user), the engine's rules settled. */
function commitAs(username, fileMap, more = {}) {
    const commitId = lib.as(username, () =>
        lib.run("org.moqui.git.GitServices.commit#GitFiles", {
            repositoryId: ids.repositoryId,
            message: "Change",
            fileMap,
            ...more
        })
    ).commitId
    lib.settle(ids.repositoryId)
    return commitId
}
const runOf = commitId =>
    Array.from(
        ec.entity
            .find("moqui.resource.GitPipelineRun")
            .condition({repositoryId: ids.repositoryId, commitId})
            .orderBy("-runNum")
            .disableAuthz()
            .list()
    )[0]

spec({
    requires: ["git"],
    setupSpec() {
        login(lib.OPERATOR)
        lib.site(SITE)
        Object.assign(ids, lib.tracker(SITE, "SPL", "splgroup"))
        lib.account(SITE, "SPL_DEV", {handle: "spldev"})
        lib.settled(SITE, "SPL_DEV")
        lib.role(SITE, {repositoryId: ids.repositoryId}, "SPL_DEV", "SmrDeveloper")
        lib.set("mantle.smithy.SmithyRepository", {repositoryId: ids.repositoryId}, {pipelinesEnabled: "Y"})
        lib.make("mantle.public.PublicSiteHost", {hostname: HOST, siteId: SITE, canonical: "Y"})
        ids.ownerId = "smithy:group:" + ids.groupId
        // the engine on, with a fake container host: a pool of the group's own for trusted runs, a shared one for outside runs
        if (!lib.row("moqui.server.instance.InstanceHostType", {hostTypeId: "fake"}))
            lib.make("moqui.server.instance.InstanceHostType", {
                hostTypeId: "fake",
                runStartService: "org.moqui.dev.InstanceServices.start#RunFake",
                runInspectService: "org.moqui.dev.InstanceServices.inspect#RunFake",
                runRemoveService: "org.moqui.dev.InstanceServices.remove#RunFake",
                runCleanupService: "org.moqui.dev.InstanceServices.cleanup#RunsFake"
            })
        lib.make("moqui.server.instance.InstanceHost", {instanceHostId: "SPL_FAKE", hostTypeId: "fake", hostAddress: "hang"})
        for (const [runnerPoolId, trusted, ownerId] of [
            ["SPL_TRUSTED", true, ids.ownerId],
            ["SPL_OUTSIDE", false, null]
        ])
            lib.run(CI + "store#RunnerPool", {
                runnerPoolId,
                poolName: "default",
                ownerId,
                instanceHostId: "SPL_FAKE",
                trusted,
                enabled: true,
                maxConcurrent: 2,
                allowedImages: "moqui-build*"
            })
        lib.commit(ids.repositoryId, "Start", {"README.md": "# Code\n"})
        lib.settle(ids.repositoryId)
    },
    cleanupSpec() {
        // the engine off again for the specs after this one, and nothing of this spec's left running
        for (const runnerPoolId of ["SPL_TRUSTED", "SPL_OUTSIDE"])
            if (lib.row("moqui.resource.GitRunnerPool", {runnerPoolId}))
                lib.run(CI + "store#RunnerPool", {runnerPoolId, enabled: false})
        if (!ids.repositoryId) return
        for (const run of Array.from(
            ec.entity.find("moqui.resource.GitPipelineRun").condition("repositoryId", ids.repositoryId).disableAuthz().list()
        ))
            if (["waiting", "queued", "running"].includes(run.statusId)) {
                ec.service
                    .sync()
                    .name(CI + "cancel#PipelineRun")
                    .parameters({pipelineRunId: run.pipelineRunId, includeHidden: true})
                    .disableAuthz()
                    .call()
                ec.message.clearErrors()
            }
    }
})

feature(
    "the run check: trust, a contribution merged by another account, the outside job cap, the owner and its pool, a personal repository's minutes held back by running jobs, pipelines off, a used-up month",
    {
        when() {
            const settingsRevision = () => siteOp("SPL_OWNER", "getPipelineSettings", {groupId: ids.groupId}).revision
            const store = (username, fields) =>
                siteOp(username, "storePipelineSettings", {groupId: ids.groupId, expectedRevision: settingsRevision(), ...fields})
            const byMaintainer = store("SPL_MAINT", {runnerPoolId: "SPL_TRUSTED"})
            const wrongTrust = store("SPL_OWNER", {runnerPoolId: "SPL_OUTSIDE"})
            store("SPL_OWNER", {runnerPoolId: "SPL_TRUSTED", outsideRunnerPoolId: "SPL_OUTSIDE"})
            const settings = op("SPL_MAINT", "getPipelineSettings", {})
            const developer = check("SPL_DEV")
            const reporter = check("SPL_REPORTER")
            const fork = check("SPL_DEV", {event: "merge-request", sourceRepositoryId: "SPL_ELSEWHERE"})
            // a merge request the git host marked merged (the target held its head), then one merged by its own author,
            // count for nothing; one merged by another account through a merge makes the reporter known here
            lib.make("moqui.resource.GitMergeRequest", {
                mergeRequestId: "SPL_MERGED",
                repositoryId: ids.repositoryId,
                mergeRequestNum: 900,
                title: "Earlier work",
                authorUserId: "SPL_REPORTER",
                statusId: "GmrMerged",
                mergeCommitId: "a".repeat(40),
                sourceRef: "refs/heads/earlier",
                targetRef: "refs/heads/main"
            })
            const heldHead = check("SPL_REPORTER").decision
            lib.set("moqui.resource.GitMergeRequest", {mergeRequestId: "SPL_MERGED"}, {mergedByUserId: "SPL_REPORTER"})
            const selfMerged = check("SPL_REPORTER").decision
            lib.set("moqui.resource.GitMergeRequest", {mergeRequestId: "SPL_MERGED"}, {mergedByUserId: "SPL_MAINT"})
            const contributor = check("SPL_REPORTER")
            // an outside run of more jobs than the site allows
            const manyJobs = check("SPL_REPORTER", {jobCount: 11})
            // a personal repository: no runs until an operator gives its account minutes
            const personalId = siteOp("SPL_AUTHOR", "createRepository", {
                slug: "mine",
                visibility: "public",
                operationId: "spl-personal"
            }).repositoryId
            lib.set("mantle.smithy.SmithyRepository", {repositoryId: personalId}, {pipelinesEnabled: "Y"})
            const personal = () => check("SPL_AUTHOR", {repositoryId: personalId})
            const before = personal()
            siteOp(lib.OPERATOR, "setQuota", {handle: "splauthor", runnerMinutesMonthly: 60, expectedRevision: 0})
            const given = personal()
            // a running job holds its timeout of the month back: the next run's share is not covered
            const accountOwner = "smithy:account:" + SITE + ":SPL_AUTHOR"
            lib.make("moqui.resource.GitPipelineRun", {
                pipelineRunId: "SPL_HOLDING",
                repositoryId: personalId,
                runNum: 9001,
                pipelineName: "check",
                event: "push",
                ownerId: accountOwner,
                trusted: "Y",
                statusId: "running"
            })
            lib.make("moqui.resource.GitJobRun", {
                jobRunId: "SPL_HOLDING_JOB",
                pipelineRunId: "SPL_HOLDING",
                repositoryId: personalId,
                jobName: "unit",
                attempt: 1,
                statusId: "running",
                timeoutMinutes: 45
            })
            const reserved = personal()
            lib.set("moqui.resource.GitPipelineRun", {pipelineRunId: "SPL_HOLDING"}, {statusId: "success"})
            // pipelines off: no run and no status at all
            lib.set("mantle.smithy.SmithyRepository", {repositoryId: personalId}, {pipelinesEnabled: "N"})
            const off = personal()
            // the group's month used up
            const periodKey = lib.run(CI + "get#RunnerUsage", {ownerId: ids.ownerId}).periodKey
            lib.make("moqui.resource.GitRunnerUsage", {
                jobRunId: "SPL_USAGE",
                repositoryId: ids.repositoryId,
                ownerId: ids.ownerId,
                periodKey,
                secondsUsed: 120000,
                minutesUsed: 2000
            })
            const usedUp = check("SPL_DEV")
            const quota = siteOp(lib.OPERATOR, "getQuotaUsage", {groupId: ids.groupId})
            lib.set("moqui.resource.GitRunnerUsage", {jobRunId: "SPL_USAGE"}, {minutesUsed: 0, secondsUsed: 0})
            return {
                byMaintainer,
                wrongTrust,
                settings,
                developer,
                reporter,
                fork,
                heldHead,
                selfMerged,
                contributor,
                manyJobs,
                before,
                given,
                reserved,
                off,
                usedUp,
                quota
            }
        },
        then(out) {
            const {byMaintainer, wrongTrust, settings, developer, reporter, fork, contributor, before, given, usedUp, quota} = out
            byMaintainer.reason == "accessDenied"
            wrongTrust.kind == "Unprocessable"
            settings.poolList.map(pool => pool.runnerPoolId).sort() == ["SPL_OUTSIDE", "SPL_TRUSTED"]
            settings.runnerPoolId == "SPL_TRUSTED"
            settings.outsideRunApproval == "first"
            settings.usage.runnerMinutesMonthly == 2000
            developer.decision == "allow"
            developer.trusted == true
            developer.ownerId == ids.ownerId
            developer.runnerPoolId == "SPL_TRUSTED"
            reporter.decision == "wait"
            reporter.trusted == false
            reporter.runnerPoolId == "SPL_OUTSIDE"
            fork.decision == "wait"
            fork.trusted == false
            out.heldHead == "wait"
            out.selfMerged == "wait"
            contributor.decision == "allow"
            contributor.trusted == false
            out.manyJobs.decision == "refuse"
            out.manyJobs.message.startsWith("policyRefused")
            before.decision == "refuse"
            before.message.startsWith("policyRefused")
            given.decision == "allow"
            given.ownerId == "smithy:account:" + SITE + ":SPL_AUTHOR"
            out.reserved.decision == "refuse"
            out.reserved.message.startsWith("quotaExceeded")
            out.off.decision == "skip"
            usedUp.decision == "refuse"
            usedUp.message.startsWith("quotaExceeded")
            quota.usage.runnerMinutes == 2000
            quota.limits.runnerMinutes == 2000
        }
    }
)

feature("runs through the engine and the page their statuses link to; run, cancel, approve and secrets by role", {
    when() {
        const pushed = runOf(commitAs("SPL_DEV", {"ci.xml": CI_XML}))
        // two outside runs: an account without a role pushes (its event's user), and its runs wait
        const first = runOf(commitAs("SPL_AUTHOR", {"one.txt": "one\n"}))
        const second = runOf(commitAs("SPL_AUTHOR", {"two.txt": "two\n"}))
        const listed = op("SPL_STRANGER", "findPipelineRuns", {})
        // the status of the push's job, as the engine wrote it: its target is Smithy's page of the run
        const status = Array.from(
            ec.entity
                .find("moqui.resource.GitCommitStatus")
                .condition({repositoryId: ids.repositoryId, commitId: pushed.commitId})
                .disableAuthz()
                .list()
        )[0]
        const shown = op("SPL_STRANGER", "getPipelineRun", {runNum: first.runNum})
        return {
            pushed,
            first,
            second,
            statusUrl: status?.targetUrl || null,
            // the page a status links to (get#RunUrl, the engine's git-ci run-url-service)
            targetUrl: lib.run("mantle.smithy.SmithyPipelineServices.get#RunUrl", {
                repositoryId: ids.repositoryId,
                runNum: String(first.runNum),
                jobRunId: "J1"
            }).url,
            listed: listed.runList.map(run => run.runNum),
            pipelines: listed.pipelineList,
            strangerCan: shown.capabilities,
            maintainerCan: op("SPL_MAINT", "getPipelineRun", {runNum: first.runNum}).capabilities,
            runByReporter: op("SPL_REPORTER", "runPipeline", {pipelineName: "check", operationId: "spl-run-reporter"}),
            runByDeveloper: op("SPL_DEV", "runPipeline", {pipelineName: "check", operationId: "spl-run-dev"}),
            approveByDeveloper: op("SPL_DEV", "approvePipelineRun", {runNum: first.runNum}),
            approveByMaintainer: op("SPL_MAINT", "approvePipelineRun", {runNum: first.runNum}),
            cancelByReporter: op("SPL_REPORTER", "cancelPipelineRun", {runNum: second.runNum}),
            cancelByAsker: op("SPL_AUTHOR", "cancelPipelineRun", {runNum: second.runNum}),
            secretByDeveloper: op("SPL_DEV", "storeCiSecret", {
                name: "DEPLOY_KEY",
                value: "s3cret-value",
                operationId: "spl-secret-dev"
            }),
            secretByMaintainer: op("SPL_MAINT", "storeCiSecret", {
                name: "DEPLOY_KEY",
                value: "s3cret-value",
                operationId: "spl-secret-maint"
            }),
            secretsByDeveloper: op("SPL_DEV", "findCiSecrets", {}),
            secrets: op("SPL_MAINT", "findCiSecrets", {}).secretList
        }
    },
    then(out) {
        out.pushed.trusted == "Y"
        out.pushed.ownerId == ids.ownerId
        out.statusUrl.startsWith("https://" + HOST + "/code/splgroup/code/-/pipelines/" + out.pushed.runNum)
        out.first.statusId == "waiting"
        out.first.ownerId == ids.ownerId
        out.first.statusMessage.startsWith("Waiting for a Maintainer's approval")
        out.first.trusted == "N"
        out.targetUrl == "https://" + HOST + "/code/splgroup/code/-/pipelines/" + out.first.runNum + "/jobs/J1"
        out.listed.includes(out.pushed.runNum)
        out.pipelines == ["check"]
        out.strangerCan == {canCancel: false, canRerun: false, canRetry: false, canApprove: false}
        out.maintainerCan.canApprove == true
        out.runByReporter.reason == "accessDenied"
        typeof out.runByDeveloper.runNum == "number"
        out.approveByDeveloper.reason == "accessDenied"
        out.approveByMaintainer.approvalState == "approved"
        out.cancelByReporter.reason == "accessDenied"
        out.cancelByAsker.state == "cancelled"
        out.secretByDeveloper.reason == "accessDenied"
        typeof out.secretByMaintainer.secretId == "string"
        out.secretsByDeveloper.reason == "accessDenied"
        out.secrets.map(secret => [secret.name, secret.scope, "value" in secret]) == [["DEPLOY_KEY", "protected", false]]
    }
})

feature(
    "the merge box shows a failed run and its required context blocks the merge; a held merge request's run is Not Found to a stranger",
    {
        when() {
            lib.run("org.moqui.git.GitServices.store#GitBranchRule", {
                repositoryId: ids.repositoryId,
                refPattern: "main",
                requiredStatusContexts: "ci/check/unit"
            })
            commitAs("SPL_DEV", {"feature.txt": "a feature\n"}, {branch: "main", newBranch: "feature"})
            const opened = op("SPL_DEV", "createMergeRequest", {
                sourceRef: "feature",
                title: "A feature",
                operationId: "spl-open-feature"
            })
            lib.settle(ids.repositoryId)
            const mr = lib.row("moqui.resource.GitMergeRequest", {
                repositoryId: ids.repositoryId,
                mergeRequestNum: opened.mergeRequestNum
            })
            const run = Array.from(
                ec.entity
                    .find("moqui.resource.GitPipelineRun")
                    .condition("mergeRequestId", mr.mergeRequestId)
                    .orderBy("-runNum")
                    .disableAuthz()
                    .list()
            )[0]
            // the job failed: its status as the engine writes one
            lib.run("org.moqui.git.GitServices.create#GitCommitStatus", {
                repositoryId: ids.repositoryId,
                commitId: mr.headCommitId,
                context: "ci/check/unit",
                state: "failure",
                description: "1 test failed"
            })
            const box = op("SPL_STRANGER", "getMergeRequest", {mergeRequestNum: opened.mergeRequestNum})
            const merge = op("SPL_MAINT", "mergeMergeRequest", {
                mergeRequestNum: opened.mergeRequestNum,
                expectedRevision: box.mergeRequest.revision
            })
            // its text held for review: the merge request, and so its run, is its author's and its moderators'
            const root = lib.row("mantle.smithy.SmithyMergeRequest", {mergeRequestId: mr.mergeRequestId}).rootCommEventId
            lib.set("mantle.forum.ForumPostState", {communicationEventId: root}, {visibility: "pending"})
            return {
                run,
                check: box.checkList.find(one => one.context === "ci/check/unit"),
                boxRuns: box.runList.map(one => one.runNum),
                missing: box.missingList,
                merge,
                stranger: op("SPL_STRANGER", "getPipelineRun", {runNum: run.runNum}),
                strangerList: op("SPL_STRANGER", "findPipelineRuns", {}).runList.map(one => one.runNum),
                author: op("SPL_DEV", "getPipelineRun", {runNum: run.runNum}),
                owner: op("SPL_OWNER", "getPipelineRun", {runNum: run.runNum})
            }
        },
        then({run, check, boxRuns, missing, merge, stranger, strangerList, author, owner}) {
            run.event == "merge-request"
            check.required == true
            check.state != "success"
            check.runNum == run.runNum
            boxRuns.includes(run.runNum)
            missing.some(line => line.startsWith("Checks not passed") && line.includes("ci/check/unit"))
            merge.reason == "checksRequired"
            stranger.kind == "NotFound"
            !strangerList.includes(run.runNum)
            author.run.runNum == run.runNum
            author.run.mergeRequestNum != null
            owner.run.runNum == run.runNum
        }
    }
)

feature("each new head of an outside merge request waits for a Maintainer; an approval covers its head; a Maintainer's reopening approves nothing", {
    when() {
        commitAs("SPL_DEV", {"outside.txt": "outside\n"}, {branch: "main", newBranch: "outside"})
        const opened = op("SPL_DEV", "createMergeRequest", {sourceRef: "outside", title: "Outside", operationId: "spl-open-outside"})
        lib.settle(ids.repositoryId)
        const mr = lib.row("moqui.resource.GitMergeRequest", {repositoryId: ids.repositoryId, mergeRequestNum: opened.mergeRequestNum})
        // its author is an account below Developer: an outside merge request
        lib.set("moqui.resource.GitMergeRequest", {mergeRequestId: mr.mergeRequestId}, {authorUserId: "SPL_AUTHOR"})
        const head = (commitId, userId = "SPL_AUTHOR") =>
            check(userId, {event: "merge-request", mergeRequestId: mr.mergeRequestId, commitId, refName: "refs/heads/main"})
        const before = head(mr.headCommitId)
        // a run of the head that waits, approved by a Maintainer
        lib.make("moqui.resource.GitPipelineRun", {
            pipelineRunId: "SPL_WAITING",
            repositoryId: ids.repositoryId,
            runNum: 9100,
            pipelineName: "check",
            event: "merge-request",
            refName: "refs/heads/main",
            commitId: mr.headCommitId,
            mergeRequestId: mr.mergeRequestId,
            triggeredByUserId: "SPL_AUTHOR",
            ownerId: ids.ownerId,
            trusted: "N",
            approvalState: "waiting",
            statusId: "waiting"
        })
        const approved = op("SPL_MAINT", "approvePipelineRun", {runNum: 9100})
        const newHead = "b".repeat(40)
        return {
            before,
            approved,
            recorded: lib.row("mantle.smithy.SmithyRunApproval", {mergeRequestId: mr.mergeRequestId, commitId: mr.headCommitId, pusherUserId: "SPL_DEV"}),
            sameHead: head(mr.headCommitId),
            nextHead: head(newHead),
            reopened: head(newHead, "SPL_MAINT")
        }
    },
    then({before, approved, recorded, sameHead, nextHead, reopened}) {
        before.decision == "wait"
        before.trusted == false
        approved.approvalState == "approved"
        recorded.approvedByUserId != null
        sameHead.decision == "allow"
        sameHead.trusted == false
        nextHead.decision == "wait"
        reopened.decision == "wait"
    }
})

feature("an artifact of a held merge request's run is its author's to download (by its ci-artifact:// location with no response to write) and Not Found to a stranger", {
    when() {
        const mr = lib.row("moqui.resource.GitMergeRequest", {repositoryId: ids.repositoryId, sourceRef: "feature"})
        const run = Array.from(
            ec.entity.find("moqui.resource.GitPipelineRun").condition("mergeRequestId", mr.mergeRequestId).disableAuthz().list()
        )[0]
        const job = Array.from(
            ec.entity.find("moqui.resource.GitJobRun").condition("pipelineRunId", run.pipelineRunId).disableAuthz().list()
        )[0]
        // its content a stored blob (over the 64 KiB a stored file keeps in its row), as the runner's upload is
        const content = "a build's archive\n".repeat(5000)
        lib.privileged(() => ec.resource.getLocationReference("dbresource://smithy-spec/spl-artifact.tar.gz").putText(content))
        const sha256 = ec.resource.digestText(content, "sha256")
        lib.make("moqui.resource.GitRunArtifact", {
            artifactId: "SPL_ARTIFACT",
            jobRunId: job.jobRunId,
            pipelineRunId: run.pipelineRunId,
            repositoryId: ids.repositoryId,
            artifactKind: "artifact",
            name: "dist",
            blobId: sha256,
            sizeBytes: content.length,
            sha256,
            createdDate: ec.user.nowTimestamp
        })
        const author = op("SPL_DEV", "downloadArtifact", {artifactId: "SPL_ARTIFACT"})
        // the authority's whole answer, as the PASS gRPC transport gets it: the file to stream by its location
        const download = lib.as("SPL_DEV", () =>
            ec.resource.script("component://mr-mantle/script/PassAuthority.js").handle({
                siteId: SITE,
                operation: "downloadArtifact",
                input: {repositoryId: ids.repositoryId, artifactId: "SPL_ARTIFACT"},
                sessionChecked: true
            })
        ).download
        const stranger = op("SPL_STRANGER", "downloadArtifact", {artifactId: "SPL_ARTIFACT"})
        // a running job's log: more while the chunk limit cut the answer
        for (const chunkSeq of [1, 2])
            lib.make("moqui.resource.GitRunLogChunk", {jobRunId: job.jobRunId, chunkSeq, stepSeq: 1, byteOffset: (chunkSeq - 1) * 5, chunkText: "line\n"})
        const cutLog = op("SPL_DEV", "getJobLog", {runNum: run.runNum, jobRunId: job.jobRunId, limit: 1, watch: false})
        const wholeLog = op("SPL_DEV", "getJobLog", {runNum: run.runNum, jobRunId: job.jobRunId, limit: 5, watch: false})
        // pipelines off: a run's uploads and logs are Not Found
        lib.set("mantle.smithy.SmithyRepository", {repositoryId: ids.repositoryId}, {pipelinesEnabled: "N"})
        const off = op("SPL_DEV", "downloadArtifact", {artifactId: "SPL_ARTIFACT"})
        const offLog = op("SPL_DEV", "getJobLog", {runNum: run.runNum, jobRunId: job.jobRunId})
        lib.set("mantle.smithy.SmithyRepository", {repositoryId: ids.repositoryId}, {pipelinesEnabled: "Y"})
        return {author, download, stranger, off: off.kind, offLog: offLog.kind, size: content.length, cutLog, wholeLog}
    },
    then({author, download, stranger, off, offLog, size, cutLog, wholeLog}) {
        cutLog.chunkList.length == 1
        cutLog.more == true
        wholeLog.chunkList.length == 2
        wholeLog.more == false
        off == "NotFound"
        offLog == "NotFound"
        // the authority's answer with no response to write (the PASS gRPC path): the artifact's ci-artifact:// location
        // for the transport to stream, an attachment, with its name and size; the location stays out of the result
        author.location == null
        download.location == "ci-artifact://SPL_ARTIFACT/dist.tar.gz"
        download.disposition == "attachment"
        download.filename == "dist.tar.gz"
        author.file.filename == "dist.tar.gz"
        author.file.size == size
        stranger.kind == "NotFound"
    }
})

feature("the outbound check holds what a hidden repository sends out", {
    when() {
        const ask = () =>
            lib.run("mantle.smithy.SmithyGitServices.check#Outbound", {repositoryId: ids.repositoryId, kind: "webhook", event: "push"})
        const shown = ask()
        lib.set("mantle.smithy.SmithyRepository", {repositoryId: ids.repositoryId}, {hiddenAt: ec.user.nowTimestamp})
        const hidden = ask()
        lib.set("mantle.smithy.SmithyRepository", {repositoryId: ids.repositoryId}, {hiddenAt: null})
        return {shown, hidden}
    },
    then({shown, hidden}) {
        shown.allowed == true
        hidden.allowed == false
        hidden.message.includes("hidden")
    }
})

feature("pipeline settings: own values apart from those in effect, a clear, never only by the top-level group's Owner; an environment for every ref is refused", {
    when() {
        const sub = lib.createGroup(lib.OPERATOR, {siteId: SITE, parentGroupId: ids.groupId, pathSegment: "sub", visibility: "public"}).groupId
        lib.role(SITE, {groupId: sub}, "SPL_DEV", "SmrOwner")
        const read = () => siteOp("SPL_DEV", "getPipelineSettings", {groupId: sub})
        const store = fields => siteOp("SPL_DEV", "storePipelineSettings", {groupId: sub, expectedRevision: read().revision, ...fields})
        const never = store({outsideRunApproval: "never"})
        store({outsideRunApproval: "always"})
        const own = read()
        store({outsideRunApproval: null})
        const cleared = read()
        return {
            never,
            own,
            cleared,
            topNever: siteOp("SPL_OWNER", "storePipelineSettings", {
                groupId: ids.groupId,
                expectedRevision: siteOp("SPL_OWNER", "getPipelineSettings", {groupId: ids.groupId}).revision,
                outsideRunApproval: "never"
            }),
            everyRef: op("SPL_MAINT", "storeCiEnvironment", {name: "prod", allowedRefs: "refs/heads/*", operationId: "spl-env-1"}),
            branches: op("SPL_MAINT", "storeCiEnvironment", {name: "prod", allowedRefs: "release/*", operationId: "spl-env-2"})
        }
    },
    then({never, own, cleared, topNever, everyRef, branches}) {
        never.reason == "accessDenied"
        own.canSetNever == false
        own.own == {runnerPoolId: null, outsideRunnerPoolId: null, outsideRunApproval: "always"}
        own.runnerPoolId == "SPL_TRUSTED"
        own.inheritedFrom.runnerPoolId == "splgroup"
        own.inheritedFrom.outsideRunApproval == null
        cleared.own.outsideRunApproval == null
        cleared.outsideRunApproval == "first"
        cleared.inheritedFrom.outsideRunApproval == "site"
        typeof topNever.revision == "number"
        everyRef.kind == "Unprocessable"
        typeof branches.environmentId == "string"
    }
})
