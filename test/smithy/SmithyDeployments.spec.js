// Smithy's deploy environments and deployments (mr-pass plan/design-smithy.md "Deploy environments (DG10)", §11
// Pipelines; SmithyPipelines.js findCiEnvironments, storeCiEnvironment, findDeployments, getDeployment, requestDeploy,
// decideDeploy, cancelDeploy, deploymentNotice) over the framework's engine (org.moqui.git.GitCiServices,
// docs/interfaces/Pipelines.md "Deployments"), called as the caller: an environment is a Maintainer's, its target's
// token an item of an operational vault the Maintainer is a member of (vaultId; Smithy takes no token, and hasToken says
// the vault holds it); a Developer asks for a deployment, a Reporter is refused; a Maintainer
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
const TOKEN = "sdp-target-token-0123456789abcdefghij"
const VAULT = "SDP_VAULT"
const OTHER_VAULT = "SDP_OTHER_VAULT"
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
        // the operational vault of the target's token, SDP_MAINT a member of it, and another vault nobody here is in (a
        // vault's own rules are the framework's: its rows only, as a member's client would leave them)
        for (const vaultId of [VAULT, OTHER_VAULT])
            if (!lib.row("moqui.security.vault.Vault", {vaultId}))
                lib.make("moqui.security.vault.Vault", {
                    vaultId,
                    vaultKindEnumId: "VkOperational",
                    lockEnumId: "VlSharedKey",
                    ownerUserId: vaultId === VAULT ? "SDP_MAINT" : "SDP_OWNER",
                    keyVersion: 1,
                    revision: 1,
                    vaultName: vaultId
                })
        if (!lib.row("moqui.security.vault.VaultMember", {vaultId: VAULT, userId: "SDP_MAINT", keyVersion: 1}))
            lib.make("moqui.security.vault.VaultMember", {
                vaultId: VAULT,
                userId: "SDP_MAINT",
                keyVersion: 1,
                roleEnumId: "VrManage",
                fromDate: ec.user.nowTimestamp
            })
    },
    cleanupSpec() {
        if (lib.row("moqui.security.vault.VaultItem", {vaultItemId: "SDP_TOKEN_ITEM"}))
            lib.run("delete#moqui.security.vault.VaultItem", {vaultItemId: "SDP_TOKEN_ITEM"})
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

feature("an environment is a Maintainer's: its token is an item of a vault the Maintainer is in, never a parameter, in no list or receipt", {
    when() {
        const input = {
            name: "demo",
            targetUrl: "https://deploy.sdp.example.com",
            vaultId: VAULT,
            requiredPipeline: "deploy",
            dataTypes: "seed, seed-initial",
            approvalRequired: "Y",
            allowedRefs: "main",
            operationId: "sdp-env-1"
        }
        const developer = op("SDP_DEV", "storeCiEnvironment", {...input, operationId: "sdp-env-dev"})
        const stored = op("SDP_MAINT", "storeCiEnvironment", input)
        ids.environmentId = stored.environmentId
        // the token, made in the vault by a member's client: the item bound to the environment
        if (lib.row("moqui.security.vault.VaultItem", {vaultItemId: "SDP_TOKEN_ITEM"}))
            lib.run("delete#moqui.security.vault.VaultItem", {vaultItemId: "SDP_TOKEN_ITEM"})
        lib.make("moqui.security.vault.VaultItem", {
            vaultItemId: "SDP_TOKEN_ITEM",
            vaultId: VAULT,
            keyVersion: 1,
            revision: 1,
            vaultItemTypeId: "api-key",
            bindingKey: "GitCiEnvironment:" + stored.environmentId + ":targetToken",
            itemName: "demo target token",
            bodyCipher: "sealed",
            createdDate: ec.user.nowTimestamp
        })
        const withUser = op("SDP_MAINT", "storeCiEnvironment", {
            environmentId: stored.environmentId,
            cloneUrl: "https://someone:secret@git.example.com/a.git"
        })
        const targetWithUser = op("SDP_MAINT", "storeCiEnvironment", {
            environmentId: stored.environmentId,
            targetUrl: "https://deployer:secret@deploy.sdp.example.com"
        })
        // Smithy names no approver group (a framework group, another site's, would be told of the repository and decide)
        const withGroup = lib.service("SDP_MAINT", "mantle.smithy.SmithyPipelineServices.store#Environment", {
            input: {siteId: SITE, repositoryId: ids.repositoryId, environmentId: stored.environmentId, approverGroupId: "ADMIN"}
        })
        const receipt = lib.row("mantle.forum.ForumOperationReceipt", {
            siteId: SITE,
            operationId: "sdp-env-1",
            action: "smithy.storeCiEnvironment"
        })
        const listed = op("SDP_DEV", "findCiEnvironments")
        // a token is never a parameter; a vault the Maintainer is not a member of, or none of that id, is refused alike;
        // and an environment without approval: only unprotected branches wait
        const withToken = op("SDP_MAINT", "storeCiEnvironment", {environmentId: stored.environmentId, token: TOKEN})
        const otherVault = op("SDP_MAINT", "storeCiEnvironment", {environmentId: stored.environmentId, vaultId: OTHER_VAULT})
        const noVault = op("SDP_MAINT", "storeCiEnvironment", {environmentId: stored.environmentId, vaultId: "SDP_NO_VAULT"})
        const manyTypes = op("SDP_MAINT", "storeCiEnvironment", {
            environmentId: stored.environmentId,
            dataTypes: Array.from({length: 21}, (_, k) => "type" + k).join(",")
        })
        const badType = op("SDP_MAINT", "storeCiEnvironment", {environmentId: stored.environmentId, dataTypes: "seed;demo"})
        const unapproved = op("SDP_MAINT", "storeCiEnvironment", {name: "preview", allowedRefs: "main", operationId: "sdp-env-2"})
        const byMaintainer = op("SDP_MAINT", "findCiEnvironments").environmentList
        op("SDP_MAINT", "deleteCiEnvironment", {environmentId: unapproved.environmentId})
        return {
            withToken,
            otherVault,
            noVault,
            manyTypes,
            badType,
            byMaintainer,
            developer,
            stored,
            withUser,
            targetWithUser,
            groupRefused: withGroup.refused === true && withGroup.message.includes("approverGroupId"),
            receiptText: receipt ? JSON.stringify(receipt.getMap()) : "",
            receiptFound: !!receipt,
            listed,
            listedText: JSON.stringify(listed),
            reporter: op("SDP_REPORTER", "findCiEnvironments")
        }
    },
    then({
        developer,
        stored,
        withUser,
        targetWithUser,
        groupRefused,
        receiptText,
        receiptFound,
        listed,
        listedText,
        reporter,
        withToken,
        otherVault,
        noVault,
        manyTypes,
        badType,
        byMaintainer
    }) {
        // no operation takes a token
        withToken.kind == "Unprocessable"
        withToken.message == "Unsupported request field: token"
        // Smithy's own refusals, by their field, before the engine's
        otherVault.kind == "Unprocessable"
        otherVault.message.startsWith("vaultId:")
        noVault.message == otherVault.message
        manyTypes.message.startsWith("dataTypes must be")
        badType.message.startsWith("dataTypes must be")
        // the target's address is the engine's to give: a Maintainer's, not a Developer's
        listed.environmentList[0].targetUrl == null
        listed.environmentList[0].vaultId == null
        byMaintainer.find(env => env.name == "demo").targetUrl == "https://deploy.sdp.example.com"
        byMaintainer.find(env => env.name == "demo").vaultId == VAULT
        listed.environmentList[0].dataTypes == ["seed", "seed-initial"]
        listed.environmentList[0].approvalFor == "every"
        byMaintainer.find(env => env.name == "preview").approvalFor == "unprotected"
        developer.reason == "accessDenied"
        typeof stored.environmentId == "string"
        withUser.kind == "Unprocessable"
        targetWithUser.kind == "Unprocessable"
        targetWithUser.message.includes("targetUrl")
        groupRefused == true
        !("approverGroupId" in listed.environmentList[0])
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
        const reporterReads = {
            list: op("SDP_REPORTER", "findDeployments"),
            one: op("SDP_REPORTER", "getDeployment", {deploymentId: asked.deploymentId})
        }
        return {
            reporterReads,
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
        out.developerView.deployment.approvalRequired == true
        out.developerView.deployment.requestedBy == "sdpdev"
        out.developerView.capabilities.canDecide == false
        out.maintainerView.capabilities.canDecide == true
        out.ownDecision.reason == "accessDenied"
        out.ownView.capabilities.canDecide == false
        out.refused.state == "refused"
        out.again.kind == "Conflict"
        out.row.statusId == "refused"
        out.row.refusedByUserId == "SDP_MAINT"
        // the reason is Smithy's audit's, not the engine's error or the commit's status
        !String(out.row.errorText || "").includes("Not today")
        out.reporterReads.list.reason == "accessDenied"
        out.reporterReads.one.reason == "accessDenied"
        out.listed.deploymentList.length == 2
        out.listed.deploymentList.some(
            d => d.deploymentId == ids.deploymentId && d.state == "refused" && d.refusedBy == "sdpmaint"
        )
    }
})

feature("a Developer cancels their own deployment, a Maintainer any; another Developer's is not theirs to cancel", {
    when() {
        const runsToday = () => {
            const counts = JSON.parse(
                lib.row("mantle.forum.ForumMemberState", {siteId: SITE, partyId: "SDP_DEV"})?.dailyCounts || "{}"
            )
            return Object.entries(counts)
                .filter(([name]) => /pipeline/i.test(name))
                .reduce((sum, [, count]) => sum + Number(count || 0), 0)
        }
        const before = runsToday()
        const mine = op("SDP_DEV", "requestDeploy", {environment: "demo", operationId: "sdp-deploy-3"})
        settled(mine.deploymentId)
        const counted = runsToday() - before
        // a retry answers the first call's deployment and makes none
        const deployments = () =>
            ec.entity.find("moqui.resource.GitDeployment").condition("repositoryId", ids.repositoryId).disableAuthz().count()
        const made = deployments()
        const retried = op("SDP_DEV", "requestDeploy", {environment: "demo", operationId: "sdp-deploy-3"})
        const madeAfter = deployments()
        const notTheirs = op("SDP_DEV", "cancelDeploy", {deploymentId: ids.ownDeploymentId})
        const own = op("SDP_DEV", "cancelDeploy", {deploymentId: mine.deploymentId})
        const anyByMaintainer = op("SDP_OWNER", "cancelDeploy", {deploymentId: ids.ownDeploymentId})
        const ended = op("SDP_OWNER", "cancelDeploy", {deploymentId: ids.ownDeploymentId})
        // deploying, its step not begun (as the engine leaves one until its step claims it): cancelled, as the page says
        const ready = op("SDP_DEV", "requestDeploy", {environment: "demo", operationId: "sdp-deploy-5"}).deploymentId
        settled(ready)
        lib.set("moqui.resource.GitDeployment", {deploymentId: ready}, {statusId: "deploying"})
        const readyView = op("SDP_OWNER", "getDeployment", {deploymentId: ready}).capabilities
        // in an archived repository nothing is cancelled, as the page offers no Cancel there
        lib.set("moqui.resource.GitRepository", {repositoryId: ids.repositoryId}, {archivedDate: ec.user.nowTimestamp})
        const archivedView = op("SDP_OWNER", "getDeployment", {deploymentId: ready}).capabilities
        const archivedCancel = op("SDP_OWNER", "cancelDeploy", {deploymentId: ready})
        lib.set("moqui.resource.GitRepository", {repositoryId: ids.repositoryId}, {archivedDate: null})
        const readyCancel = op("SDP_OWNER", "cancelDeploy", {deploymentId: ready})
        // the target's answer: its problems (its own words) are a Maintainer's to read
        lib.set(
            "moqui.resource.GitDeployment",
            {deploymentId: mine.deploymentId},
            {
                deployResult: JSON.stringify({status: "deployed", component: "code", problems: ["/srv/moqui/secret path"]})
            }
        )
        const resultFor = username => op(username, "getDeployment", {deploymentId: mine.deploymentId}).deployment.result
        return {
            notTheirs,
            own,
            anyByMaintainer,
            ended,
            run: deploymentRow(mine.deploymentId),
            counted,
            retried,
            mine,
            made,
            madeAfter,
            readyView,
            readyCancel,
            archivedView,
            archivedCancel,
            developerResult: resultFor("SDP_DEV"),
            maintainerResult: resultFor("SDP_MAINT")
        }
    },
    then(out) {
        const {notTheirs, own, anyByMaintainer, ended, run, counted, retried, mine, made, madeAfter, readyView, readyCancel} = out
        out.archivedView.canCancel == false
        out.archivedCancel.kind == "Conflict"
        out.archivedCancel.reason == "repositoryArchived"
        out.developerResult.status == "deployed"
        !("problems" in out.developerResult)
        out.maintainerResult.problems == ["/srv/moqui/secret path"]
        // a deploy run counts in the day's runs as a manual one
        counted == 1
        retried.deploymentId == mine.deploymentId
        madeAfter == made
        readyView.canCancel == true
        readyCancel.state == "cancelled"
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
            // Smithy's notice names its values in a fixed title template (SEC-SCR-05): the title still reads in full
            const ownerTitle = notices("SDP_OWNER").slice(-1)[0]?.titleText || ""
            const told = {
                ownerTitle,
                maintainer: notices("SDP_MAINT").length - before.maintainer,
                owner: notices("SDP_OWNER").length - before.owner,
                requester: notices("SDP_DEV").length - before.dev,
                reporter: notices("SDP_REPORTER").length
            }
            op("SDP_OWNER", "cancelDeploy", {deploymentId: waiting})
            // a Maintainer's own request: the other Maintainers and Owners are told, not the requester again
            const owned = op("SDP_MAINT", "requestDeploy", {environment: "demo", operationId: "sdp-deploy-6"}).deploymentId
            passed(owned)
            const beforeOwned = {maintainer: notices("SDP_MAINT").length, owner: notices("SDP_OWNER").length}
            ec.makeNotificationMessage()
                .topic("GitDeployment")
                .subTopic(ids.repositoryId)
                .userId("SDP_MAINT")
                .message({deploymentId: owned, repositoryId: ids.repositoryId, statusId: "waiting-approval"})
                .persistOnSend(true)
                .send()
            const toldOwned = {
                requester: notices("SDP_MAINT").length - beforeOwned.maintainer,
                owner: notices("SDP_OWNER").length - beforeOwned.owner
            }
            op("SDP_OWNER", "cancelDeploy", {deploymentId: owned})
            lib.set("mantle.smithy.SmithyRepository", {repositoryId: ids.repositoryId}, {hiddenAt: ec.user.nowTimestamp})
            const hidden = {
                list: op("SDP_DEV", "findDeployments"),
                one: op("SDP_DEV", "getDeployment", {deploymentId: ids.deploymentId}),
                ask: op("SDP_DEV", "requestDeploy", {environment: "demo", operationId: "sdp-deploy-hidden"})
            }
            lib.set("mantle.smithy.SmithyRepository", {repositoryId: ids.repositoryId}, {hiddenAt: null})
            return {told, toldOwned, hidden}
        },
        then({told, toldOwned, hidden}) {
            toldOwned.requester == 1
            toldOwned.owner == 1
            told.ownerTitle.startsWith("The deployment of ")
            told.ownerTitle.includes(" to demo waits for approval")
            !told.ownerTitle.includes("${")
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

feature("another repository's deployment and environment are Not Found through this one", {
    when() {
        const other = lib.createRepository(lib.OPERATOR, {
            siteId: SITE,
            groupId: ids.groupId,
            slug: "other",
            visibility: "public"
        }).repositoryId
        const onOther = (username, operation, input) => op(username, operation, {repositoryId: other, ...input})
        const environmentId = onOther("SDP_MAINT", "storeCiEnvironment", {
            name: "elsewhere",
            allowedRefs: "main",
            operationId: "sdp-env-other"
        }).environmentId
        lib.make("moqui.resource.GitDeployment", {
            deploymentId: "SDP_OTHER_DEPLOY",
            repositoryId: other,
            environmentId,
            environmentName: "elsewhere",
            commitId: ids.head,
            refName: "refs/heads/main",
            statusId: "waiting-approval",
            requestedByUserId: "SDP_DEV",
            createdDate: ec.user.nowTimestamp
        })
        return {
            // the same Maintainer, through the repository the deployment is of: found
            there: onOther("SDP_MAINT", "getDeployment", {deploymentId: "SDP_OTHER_DEPLOY"}),
            decide: op("SDP_MAINT", "decideDeploy", {deploymentId: "SDP_OTHER_DEPLOY", decision: "refuse"}),
            cancel: op("SDP_OWNER", "cancelDeploy", {deploymentId: "SDP_OTHER_DEPLOY"}),
            one: op("SDP_MAINT", "getDeployment", {deploymentId: "SDP_OTHER_DEPLOY"}),
            request: op("SDP_DEV", "requestDeploy", {environmentId, operationId: "sdp-deploy-other"}),
            row: deploymentRow("SDP_OTHER_DEPLOY")
        }
    },
    then({there, decide, cancel, one, request, row}) {
        there.deployment.deploymentId == "SDP_OTHER_DEPLOY"
        there.capabilities.canDecide == true
        decide.kind == "NotFound"
        cancel.kind == "NotFound"
        one.kind == "NotFound"
        request.kind == "NotFound"
        row.statusId == "waiting-approval"
    }
})
