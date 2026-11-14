// Smithy's deploy environments and deployments (mr-pass plan/design-smithy.md "Deploy environments (DG10)", §11
// Pipelines; SmithyPipelines.js findCiEnvironments, storeCiEnvironment, findDeployments, getDeployment, requestDeploy,
// decideDeploy, cancelDeploy, deploymentNotice) over the framework's engine (org.moqui.git.GitCiServices,
// docs/interfaces/Pipelines.md "Deployments"), called as the caller: an environment is a Maintainer's, its token
// write-only (hasToken) and in no receipt; a Developer asks for a deployment, a Reporter is refused; a Maintainer
// decides, never the one who asked; a Developer cancels their own, a Maintainer any; a hidden repository's deployments
// are Not Found; with no approver group, a deployment waiting for approval is told to the Maintainers and Owners. The
// engine runs the environment's pipeline on a fake host, where nothing runs: the run's success is played by moving the
// deployment to waiting-approval as the engine does when its run passes, so the states are checked up to the decision,
// and the deploy step (which finds no component.xml here) is not. Regression suite: these are rules.
// Run: ./moq test mr-mantle --spec SmithyDeployments
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const SITE = "SDP_SITE"
const HOST = "sdp.smithy.test"
const CI = "org.moqui.git.GitCiServices."
const TOKEN = "sdp-target-token-0123456789"
const ids = {}
/* An operation in a transaction of its own, as each request is: the engine moves a deployment by a conditional
   statement, which a transaction held across operations (the feature's) would not read back. */
function op(username, operation, input = {}) {
    let out
    try {
        ec.transaction.runRequireNew(null, "Smithy deployment spec operation", () => {
            out = lib.op(username, SITE, operation, {repositoryId: ids.repositoryId, ...input})
        })
    } catch (error) {
        // a refusal marks its transaction rollback-only: the answer is the refusal
        ec.message.clearErrors()
        if (out === undefined) throw error
    }
    return out
}
const CI_XML =
    '<ci><pipeline name="deploy" on="deploy">' +
    '<job name="check" image="moqui-build"><step run="true"/></job></pipeline></ci>\n'
const deploymentRow = deploymentId => lib.row("moqui.resource.GitDeployment", {deploymentId})
/* The engine queues a deployment's run once the request commits, and moves it to waiting-pipeline then: waits for that. */
function settled(deploymentId) {
    const state = () =>
        ec.entity
            .find("moqui.resource.GitDeployment")
            .condition("deploymentId", deploymentId)
            .useCache(false)
            .disableAuthz()
            .one()?.statusId
    for (const started = Date.now(); state() === "requested" && Date.now() - started < 5000;);
    return state()
}
/* As the engine moves a deployment whose run passed, for an environment that requires approval. */
function passed(deploymentId) {
    settled(deploymentId)
    lib.set("moqui.resource.GitDeployment", {deploymentId}, {statusId: "waiting-approval"})
}
const notices = userId =>
    Array.from(ec.entity.find("moqui.security.user.NotificationMessageUser").condition({userId}).disableAuthz().list())
        .map(row => lib.row("moqui.security.user.NotificationMessage", {notificationMessageId: row.notificationMessageId}))
        .filter(message => message && message.topic === "GitDeployment" && message.subTopic === ids.repositoryId)

spec({
    requires: ["git"],
    setupSpec() {
        login(lib.OPERATOR)
        lib.site(SITE)
        Object.assign(ids, lib.tracker(SITE, "SDP", "sdpgroup"))
        lib.account(SITE, "SDP_DEV", {handle: "sdpdev"})
        lib.settled(SITE, "SDP_DEV")
        lib.role(SITE, {repositoryId: ids.repositoryId}, "SDP_DEV", "SmrDeveloper")
        lib.set("mantle.smithy.SmithyRepository", {repositoryId: ids.repositoryId}, {pipelinesEnabled: "Y"})
        lib.make("mantle.public.PublicSiteHost", {hostname: HOST, siteId: SITE, canonical: "Y"})
        ids.ownerId = "smithy:group:" + ids.groupId
        // the engine on, with a fake container host where nothing runs
        if (!lib.row("moqui.server.instance.InstanceHostType", {hostTypeId: "fake"}))
            lib.make("moqui.server.instance.InstanceHostType", {
                hostTypeId: "fake",
                runStartService: "org.moqui.dev.InstanceServices.start#RunFake",
                runInspectService: "org.moqui.dev.InstanceServices.inspect#RunFake",
                runRemoveService: "org.moqui.dev.InstanceServices.remove#RunFake",
                runCleanupService: "org.moqui.dev.InstanceServices.cleanup#RunsFake"
            })
        lib.make("moqui.server.instance.InstanceHost", {instanceHostId: "SDP_FAKE", hostTypeId: "fake", hostAddress: "hang"})
        lib.run(CI + "store#RunnerPool", {
            runnerPoolId: "SDP_TRUSTED",
            poolName: "default",
            ownerId: ids.ownerId,
            instanceHostId: "SDP_FAKE",
            trusted: true,
            enabled: true,
            maxConcurrent: 2,
            allowedImages: "moqui-build*"
        })
        ids.head = lib.commit(ids.repositoryId, "Start", {"README.md": "# Code\n", "ci.xml": CI_XML})
        lib.settle(ids.repositoryId)
    },
    cleanupSpec() {
        // the engine off again for the specs after this one, and nothing of this spec's left running
        if (lib.row("moqui.resource.GitRunnerPool", {runnerPoolId: "SDP_TRUSTED"}))
            lib.run(CI + "store#RunnerPool", {runnerPoolId: "SDP_TRUSTED", enabled: false})
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

feature("an environment is a Maintainer's: its token is write-only, in no list and no receipt", {
    when() {
        const input = {
            name: "demo",
            targetUrl: "https://deploy.sdp.example.com",
            token: TOKEN,
            requiredPipeline: "deploy",
            approvalRequired: "Y",
            allowedRefs: "main",
            operationId: "sdp-env-1"
        }
        const developer = op("SDP_DEV", "storeCiEnvironment", {...input, operationId: "sdp-env-dev"})
        const stored = op("SDP_MAINT", "storeCiEnvironment", input)
        ids.environmentId = stored.environmentId
        const withUser = op("SDP_MAINT", "storeCiEnvironment", {
            environmentId: stored.environmentId,
            cloneUrl: "https://someone:secret@git.example.com/a.git"
        })
        const receipt = lib.row("mantle.forum.ForumOperationReceipt", {
            siteId: SITE,
            operationId: "sdp-env-1",
            action: "smithy.storeCiEnvironment"
        })
        const listed = op("SDP_DEV", "findCiEnvironments")
        return {
            developer,
            stored,
            withUser,
            receiptText: receipt ? JSON.stringify(receipt.getMap()) : "",
            receiptFound: !!receipt,
            listed,
            listedText: JSON.stringify(listed),
            reporter: op("SDP_REPORTER", "findCiEnvironments")
        }
    },
    then({developer, stored, withUser, receiptText, receiptFound, listed, listedText, reporter}) {
        developer.reason == "accessDenied"
        typeof stored.environmentId == "string"
        withUser.kind == "Unprocessable"
        receiptFound == true
        !receiptText.includes(TOKEN)
        listed.environmentList.length == 1
        listed.environmentList[0].name == "demo"
        listed.environmentList[0].hasToken == true
        listed.environmentList[0].requiredPipeline == "deploy"
        listed.environmentList[0].approvalRequired == true
        listed.canChange == false
        listed.canDeploy == true
        !listedText.includes(TOKEN)
        reporter.reason == "accessDenied"
    }
})

feature("a Developer asks for a deployment and a Reporter is refused; a Maintainer decides it, never the one who asked", {
    when() {
        const ask = (username, operationId) => op(username, "requestDeploy", {environment: "demo", operationId})
        const reporter = ask("SDP_REPORTER", "sdp-deploy-rep")
        const asked = ask("SDP_DEV", "sdp-deploy-1")
        ids.deploymentId = asked.deploymentId
        const queued = settled(asked.deploymentId)
        const waiting = deploymentRow(asked.deploymentId)
        // its run passed (played): it waits for an approver
        passed(asked.deploymentId)
        const byDeveloper = op("SDP_DEV", "decideDeploy", {deploymentId: asked.deploymentId, decision: "approve"})
        const developerView = op("SDP_DEV", "getDeployment", {deploymentId: asked.deploymentId})
        const maintainerView = op("SDP_MAINT", "getDeployment", {deploymentId: asked.deploymentId})
        // a Maintainer's own request: decided by another Maintainer only
        const own = ask("SDP_MAINT", "sdp-deploy-2")
        ids.ownDeploymentId = own.deploymentId
        passed(own.deploymentId)
        const ownDecision = op("SDP_MAINT", "decideDeploy", {deploymentId: own.deploymentId, decision: "approve"})
        const ownView = op("SDP_MAINT", "getDeployment", {deploymentId: own.deploymentId})
        const refused = op("SDP_MAINT", "decideDeploy", {
            deploymentId: asked.deploymentId,
            decision: "refuse",
            reason: "Not today"
        })
        const again = op("SDP_MAINT", "decideDeploy", {deploymentId: asked.deploymentId, decision: "approve"})
        const listed = op("SDP_DEV", "findDeployments", {environment: "demo"})
        return {
            reporter,
            asked,
            queued,
            waiting,
            byDeveloper,
            developerView,
            maintainerView,
            own,
            ownDecision,
            ownView,
            refused,
            again,
            listed,
            row: deploymentRow(asked.deploymentId)
        }
    },
    then(out) {
        out.reporter.reason == "accessDenied"
        typeof out.asked.deploymentId == "string"
        out.asked.state == "waiting-pipeline"
        out.queued == "waiting-pipeline"
        typeof out.asked.runNum == "number"
        out.waiting.requestedByUserId == "SDP_DEV"
        out.waiting.commitId == ids.head
        out.byDeveloper.reason == "accessDenied"
        out.developerView.deployment.state == "waiting-approval"
        out.developerView.deployment.requestedBy == "sdpdev"
        out.developerView.capabilities.canDecide == false
        out.maintainerView.capabilities.canDecide == true
        out.ownDecision.reason == "accessDenied"
        out.ownView.capabilities.canDecide == false
        out.refused.state == "refused"
        out.again.kind == "Conflict"
        out.row.statusId == "refused"
        out.row.refusedByUserId == "SDP_MAINT"
        out.listed.deploymentList.length == 2
        out.listed.deploymentList.some(
            d => d.deploymentId == ids.deploymentId && d.state == "refused" && d.refusedBy == "sdpmaint"
        )
    }
})

feature("a Developer cancels their own deployment, a Maintainer any; another Developer's is not theirs to cancel", {
    when() {
        const mine = op("SDP_DEV", "requestDeploy", {environment: "demo", operationId: "sdp-deploy-3"})
        settled(mine.deploymentId)
        const notTheirs = op("SDP_DEV", "cancelDeploy", {deploymentId: ids.ownDeploymentId})
        const own = op("SDP_DEV", "cancelDeploy", {deploymentId: mine.deploymentId})
        const anyByMaintainer = op("SDP_OWNER", "cancelDeploy", {deploymentId: ids.ownDeploymentId})
        const ended = op("SDP_OWNER", "cancelDeploy", {deploymentId: ids.ownDeploymentId})
        return {notTheirs, own, anyByMaintainer, ended, run: deploymentRow(mine.deploymentId)}
    },
    then({notTheirs, own, anyByMaintainer, ended, run}) {
        notTheirs.reason == "accessDenied"
        own.state == "cancelled"
        anyByMaintainer.state == "cancelled"
        ended.kind == "Conflict"
        run.statusId == "cancelled"
    }
})

feature(
    "a deployment waiting for approval with no approver group is told to the Maintainers and Owners; a hidden repository's are Not Found",
    {
        when() {
            // a deployment whose run passed (played), and the engine's notice to its requester (deploy.rs notify)
            const waiting = op("SDP_DEV", "requestDeploy", {environment: "demo", operationId: "sdp-deploy-4"}).deploymentId
            passed(waiting)
            const before = {
                maintainer: notices("SDP_MAINT").length,
                owner: notices("SDP_OWNER").length,
                dev: notices("SDP_DEV").length
            }
            ec.makeNotificationMessage()
                .topic("GitDeployment")
                .subTopic(ids.repositoryId)
                .userId("SDP_DEV")
                .title("The deployment waits for approval")
                .message({
                    deploymentId: waiting,
                    repositoryId: ids.repositoryId,
                    environment: "demo",
                    commitId: ids.head,
                    statusId: "waiting-approval"
                })
                .persistOnSend(true)
                .send()
            // a notice that says waiting-approval of one that no longer waits (refused) tells nobody more
            ec.makeNotificationMessage()
                .topic("GitDeployment")
                .subTopic(ids.repositoryId)
                .userId("SDP_DEV")
                .message({deploymentId: ids.deploymentId, repositoryId: ids.repositoryId, statusId: "waiting-approval"})
                .persistOnSend(true)
                .send()
            const told = {
                maintainer: notices("SDP_MAINT").length - before.maintainer,
                owner: notices("SDP_OWNER").length - before.owner,
                requester: notices("SDP_DEV").length - before.dev,
                reporter: notices("SDP_REPORTER").length
            }
            op("SDP_OWNER", "cancelDeploy", {deploymentId: waiting})
            lib.set("mantle.smithy.SmithyRepository", {repositoryId: ids.repositoryId}, {hiddenAt: ec.user.nowTimestamp})
            const hidden = {
                list: op("SDP_DEV", "findDeployments"),
                one: op("SDP_DEV", "getDeployment", {deploymentId: ids.deploymentId}),
                ask: op("SDP_DEV", "requestDeploy", {environment: "demo", operationId: "sdp-deploy-hidden"})
            }
            lib.set("mantle.smithy.SmithyRepository", {repositoryId: ids.repositoryId}, {hiddenAt: null})
            return {told, hidden}
        },
        then({told, hidden}) {
            told.maintainer == 1
            told.owner == 1
            // the requester has the engine's own notices only
            told.requester == 2
            told.reporter == 0
            hidden.list.kind == "NotFound"
            hidden.one.kind == "NotFound"
            hidden.ask.kind == "NotFound"
        }
    }
)
