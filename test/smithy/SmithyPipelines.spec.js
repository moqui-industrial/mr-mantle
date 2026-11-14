// Smithy's pipelines (mr-pass plan/design-smithy.md §10, §15.6, DG5; SmithyPipelines.js) over the framework's engine. The
// run check (SmithyPipelineServices.check#Run): a Developer's push is trusted and runs in the pool the group chose, under
// its top-level group; an outside run (an account below Developer, a fork's merge request) waits until its author has a
// merged merge request; a personal repository runs only with minutes an operator gave; used-up minutes refuse. Through
// the engine (a fake host, real commits with a ci.xml): the statuses link to the run's page (get#RunUrl); run, cancel,
// approve and secrets by role, holder and non-holder; the merge box shows a failed check of a run and the required
// context blocks the merge; a held merge request's run is Not Found to a stranger and read by its author. A failed job
// is simulated by a failure status the engine's way (create#GitCommitStatus as the system), since a spec cannot play
// the runner. The engine does not ask the run check or the run URL of a component's conf until the framework merges a
// component's <git-ci> (crates/moqui-core context/conf.rs merge_config_nodes), so the hooks are called here directly and
// the engine's runs carry its own defaults. Regression suite: these are rules. Run: ./moq test mr-mantle --spec SmithyPipelines
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
    "the run check: trust, approval of a first contribution, the owner and its pool, a personal repository's minutes, a used-up month",
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
            // a merged merge request makes the reporter's runs no first contribution
            lib.make("moqui.resource.GitMergeRequest", {
                mergeRequestId: "SPL_MERGED",
                repositoryId: ids.repositoryId,
                mergeRequestNum: 900,
                title: "Earlier work",
                authorUserId: "SPL_REPORTER",
                statusId: "GmrMerged",
                sourceRef: "refs/heads/earlier",
                targetRef: "refs/heads/main"
            })
            const contributor = check("SPL_REPORTER")
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
            return {byMaintainer, wrongTrust, settings, developer, reporter, fork, contributor, before, given, usedUp, quota}
        },
        then({byMaintainer, wrongTrust, settings, developer, reporter, fork, contributor, before, given, usedUp, quota}) {
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
            contributor.decision == "allow"
            contributor.trusted == false
            before.decision == "refuse"
            before.message.startsWith("policyRefused")
            given.decision == "allow"
            given.ownerId == "smithy:account:" + SITE + ":SPL_AUTHOR"
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
        const shown = op("SPL_STRANGER", "getPipelineRun", {runNum: first.runNum})
        return {
            pushed,
            first,
            second,
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
        out.first.statusId == "waiting"
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
