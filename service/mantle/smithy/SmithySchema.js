/* CC0 plus patent grant. Smithy's operations (mr-pass plan/design-smithy.md §15): each a Mantle service that takes PASS's
   input map. PASS keeps an identical copy. */
;({
    resolveSmithyPath: {
        service: "mantle.smithy.SmithyServices.resolve#Path",
        fields: ["siteId", "path"]
    },
    getSmithyHome: {
        service: "mantle.smithy.SmithyServices.get#Home",
        fields: ["siteId"]
    },
    findGroups: {
        service: "mantle.smithy.SmithyServices.find#Groups",
        fields: ["siteId", "parentGroupId", "query", "mine", "limit", "cursor"]
    },
    getGroup: {
        service: "mantle.smithy.SmithyServices.get#Group",
        fields: ["siteId", "groupId"]
    },
    findGroupMembers: {
        service: "mantle.smithy.SmithyServices.find#GroupMembers",
        fields: ["siteId", "groupId", "limit", "cursor"]
    },
    findRepositories: {
        service: "mantle.smithy.SmithyServices.find#Repositories",
        fields: ["siteId", "groupId", "includeSubgroups", "ownerHandle", "query", "pinned", "mine", "sort", "limit", "cursor"]
    },
    getRepository: {
        service: "mantle.smithy.SmithyServices.get#Repository",
        fields: ["siteId", "repositoryId"]
    },
    getTree: {
        service: "mantle.smithy.SmithyServices.get#Tree",
        fields: ["siteId", "repositoryId", "refPath", "offset"]
    },
    getBlob: {
        service: "mantle.smithy.SmithyServices.get#Blob",
        fields: ["siteId", "repositoryId", "refPath", "plain"]
    },
    downloadBlob: {
        service: "mantle.smithy.SmithyServices.download#Blob",
        fields: ["siteId", "repositoryId", "refPath"]
    },
    getBlame: {
        service: "mantle.smithy.SmithyServices.get#Blame",
        fields: ["siteId", "repositoryId", "refPath"]
    },
    findCommits: {
        service: "mantle.smithy.SmithyServices.find#Commits",
        fields: ["siteId", "repositoryId", "refPath", "afterCommitId", "limit"]
    },
    getCommit: {
        service: "mantle.smithy.SmithyServices.get#Commit",
        fields: ["siteId", "repositoryId", "commitId", "path"]
    },
    getCompare: {
        service: "mantle.smithy.SmithyServices.get#Compare",
        fields: ["siteId", "repositoryId", "base", "head", "headRepositoryPath", "withDiffs", "checkMergeable"]
    },
    findRefs: {
        service: "mantle.smithy.SmithyServices.find#Refs",
        fields: ["siteId", "repositoryId", "refType", "query", "namesOnly", "limit", "cursor"]
    },
    downloadArchive: {
        service: "mantle.smithy.SmithyServices.download#Archive",
        fields: ["siteId", "repositoryId", "refPath", "format"]
    },
    // DG2 (§15.3): accounts and push
    getSmithySettings: {
        service: "mantle.smithy.SmithyServices.get#Settings",
        fields: ["siteId"]
    },
    storeSmithySettings: {
        service: "mantle.smithy.SmithyServices.store#Settings",
        fields: [
            "siteId",
            "homeGroupPath",
            "groupCreate",
            "repositoryCreate",
            "forkCreate",
            "defaultMaxRepositories",
            "defaultRepositoryBytes",
            "defaultLfsBytes",
            "defaultRunnerMinutes",
            "groupRepositoryBytes",
            "groupLfsBytes",
            "groupRunnerMinutes",
            "maxEditBytes",
            "repositoryKind",
            "outsideRunApproval",
            "outsideRunMaxJobs",
            "expectedRevision"
        ]
    },
    requestGroup: {
        service: "mantle.smithy.SmithyServices.request#Group",
        fields: ["siteId", "pathSegment", "name", "description", "visibility", "reason", "operationId"]
    },
    findGroupRequests: {
        service: "mantle.smithy.SmithyServices.find#GroupRequests",
        fields: ["siteId", "status", "limit", "cursor"]
    },
    decideGroupRequest: {
        service: "mantle.smithy.SmithyServices.decide#GroupRequest",
        fields: ["siteId", "groupId", "decision", "reason", "expectedRevision"]
    },
    createSubgroup: {
        service: "mantle.smithy.SmithyServices.create#Subgroup",
        fields: ["siteId", "groupId", "pathSegment", "name", "description", "visibility", "operationId"]
    },
    updateGroup: {
        service: "mantle.smithy.SmithyServices.update#Group",
        fields: ["siteId", "groupId", "name", "description", "avatarId", "visibility", "issueRepositoryPath", "expectedRevision"]
    },
    renameGroup: {
        service: "mantle.smithy.SmithyServices.rename#Group",
        fields: ["siteId", "groupId", "pathSegment", "expectedRevision"]
    },
    deleteGroup: {
        service: "mantle.smithy.SmithyServices.delete#Group",
        fields: ["siteId", "groupId", "confirmPath", "expectedRevision"]
    },
    setGroupMember: {
        service: "mantle.smithy.SmithyServices.set#GroupMember",
        fields: ["siteId", "groupId", "handle", "role", "thruDate", "expectedRevision"]
    },
    leaveGroup: {
        service: "mantle.smithy.SmithyServices.leave#Group",
        fields: ["siteId", "groupId"]
    },
    createRepository: {
        service: "mantle.smithy.SmithyServices.create#Repository",
        fields: ["siteId", "groupId", "slug", "name", "description", "visibility", "withReadme", "operationId"]
    },
    updateRepository: {
        service: "mantle.smithy.SmithyServices.update#Repository",
        fields: [
            "siteId",
            "repositoryId",
            "name",
            "description",
            "defaultBranch",
            "defaultMergeMethod",
            "issuesEnabled",
            "mergeRequestsEnabled",
            "pipelinesEnabled",
            "forumEnabled",
            "docsEnabled",
            "docsPath",
            "pinnedSequence",
            "expectedRevision"
        ]
    },
    setRepositoryVisibility: {
        service: "mantle.smithy.SmithyServices.set#RepositoryVisibility",
        fields: ["siteId", "repositoryId", "visibility", "expectedRevision"]
    },
    renameRepository: {
        service: "mantle.smithy.SmithyServices.rename#Repository",
        fields: ["siteId", "repositoryId", "slug", "expectedRevision"]
    },
    transferRepository: {
        service: "mantle.smithy.SmithyServices.transfer#Repository",
        fields: ["siteId", "repositoryId", "targetGroupId", "expectedRevision"]
    },
    setRepositoryArchived: {
        service: "mantle.smithy.SmithyServices.set#RepositoryArchived",
        fields: ["siteId", "repositoryId", "archived", "expectedRevision"]
    },
    deleteRepository: {
        service: "mantle.smithy.SmithyServices.delete#Repository",
        fields: ["siteId", "repositoryId", "confirmPath", "expectedRevision"]
    },
    findRepositoryMembers: {
        service: "mantle.smithy.SmithyServices.find#RepositoryMembers",
        fields: ["siteId", "repositoryId", "limit", "cursor"]
    },
    setRepositoryMember: {
        service: "mantle.smithy.SmithyServices.set#RepositoryMember",
        fields: ["siteId", "repositoryId", "handle", "role", "thruDate", "expectedRevision"]
    },
    getBranchRules: {
        service: "mantle.smithy.SmithyServices.get#BranchRules",
        fields: ["siteId", "repositoryId"]
    },
    storeBranchRule: {
        service: "mantle.smithy.SmithyServices.store#BranchRule",
        fields: [
            "siteId",
            "repositoryId",
            "branchRuleId",
            "refPattern",
            "allowForcePush",
            "allowDelete",
            "requireMergeRequest",
            "requiredApprovals",
            "dismissStaleApprovals",
            "requiredStatusContexts",
            "allowedMergeMethods",
            "operationId"
        ]
    },
    deleteBranchRule: {
        service: "mantle.smithy.SmithyServices.delete#BranchRule",
        fields: ["siteId", "repositoryId", "branchRuleId"]
    },
    findWebhooks: {
        service: "mantle.smithy.SmithyServices.find#Webhooks",
        fields: ["siteId", "repositoryId"]
    },
    storeWebhook: {
        service: "mantle.smithy.SmithyServices.store#Webhook",
        fields: ["siteId", "repositoryId", "webhookId", "url", "events", "secret", "active", "description", "operationId"]
    },
    deleteWebhook: {
        service: "mantle.smithy.SmithyServices.delete#Webhook",
        fields: ["siteId", "repositoryId", "webhookId"]
    },
    testWebhook: {
        service: "mantle.smithy.SmithyServices.test#Webhook",
        fields: ["siteId", "repositoryId", "webhookId"]
    },
    findWebhookDeliveries: {
        service: "mantle.smithy.SmithyServices.find#WebhookDeliveries",
        fields: ["siteId", "repositoryId", "webhookId", "limit", "cursor"]
    },
    createRef: {
        service: "mantle.smithy.SmithyServices.create#Ref",
        fields: ["siteId", "repositoryId", "refType", "name", "fromRevision", "message", "operationId"]
    },
    deleteRef: {
        service: "mantle.smithy.SmithyServices.delete#Ref",
        fields: ["siteId", "repositoryId", "refType", "name"]
    },
    findGitAccess: {
        service: "mantle.smithy.SmithyServices.find#GitAccess",
        fields: ["siteId"]
    },
    addSshKey: {
        service: "mantle.smithy.SmithyServices.add#SshKey",
        fields: ["siteId", "name", "publicKey", "password", "code", "operationId"]
    },
    removeSshKey: {
        service: "mantle.smithy.SmithyServices.remove#SshKey",
        fields: ["siteId", "sshKeyId"]
    },
    createAccessToken: {
        service: "mantle.smithy.SmithyServices.create#AccessToken",
        fields: ["siteId", "name", "expiresAt", "password", "code", "operationId"]
    },
    revokeAccessToken: {
        service: "mantle.smithy.SmithyServices.revoke#AccessToken",
        fields: ["siteId", "tokenId"]
    },
    getQuotaUsage: {
        service: "mantle.smithy.SmithyServices.get#QuotaUsage",
        fields: ["siteId", "groupId", "handle"]
    },
    setQuota: {
        service: "mantle.smithy.SmithyServices.set#Quota",
        fields: [
            "siteId",
            "groupId",
            "handle",
            "maxRepositories",
            "maxRepositoryBytes",
            "maxLfsBytes",
            "runnerMinutesMonthly",
            "bot",
            "botOperatorHandle",
            "reason",
            "expectedRevision"
        ]
    },
    // DG3 (§15.4): issues
    findIssues: {
        service: "mantle.smithy.SmithyIssueServices.find#Issues",
        fields: [
            "siteId",
            "repositoryId",
            "groupId",
            "state",
            "labelIds",
            "milestoneId",
            "assigneeHandle",
            "authorHandle",
            "query",
            "confidential",
            "sort",
            "limit",
            "cursor"
        ]
    },
    getIssue: {
        service: "mantle.smithy.SmithyIssueServices.get#Issue",
        fields: ["siteId", "repositoryId", "issueNumber"]
    },
    createIssue: {
        service: "mantle.smithy.SmithyIssueServices.create#Issue",
        fields: [
            "siteId",
            "repositoryId",
            "title",
            "body",
            "sourceFormat",
            "confidential",
            "labelIds",
            "assigneeHandles",
            "milestoneId",
            "attachmentIds",
            "draftId",
            "operationId"
        ]
    },
    updateIssue: {
        service: "mantle.smithy.SmithyIssueServices.update#Issue",
        fields: ["siteId", "repositoryId", "issueNumber", "title", "expectedRevision"]
    },
    setIssueState: {
        service: "mantle.smithy.SmithyIssueServices.set#IssueState",
        fields: ["siteId", "repositoryId", "issueNumber", "state", "reason", "duplicateOfNumber", "expectedRevision"]
    },
    setIssueLabels: {
        service: "mantle.smithy.SmithyIssueServices.set#IssueLabels",
        fields: ["siteId", "repositoryId", "issueNumber", "labelIds", "expectedRevision"]
    },
    setIssueAssignees: {
        service: "mantle.smithy.SmithyIssueServices.set#IssueAssignees",
        fields: ["siteId", "repositoryId", "issueNumber", "assigneeHandles", "expectedRevision"]
    },
    setIssueMilestone: {
        service: "mantle.smithy.SmithyIssueServices.set#IssueMilestone",
        fields: ["siteId", "repositoryId", "issueNumber", "milestoneId", "expectedRevision"]
    },
    setIssueConfidential: {
        service: "mantle.smithy.SmithyIssueServices.set#IssueConfidential",
        fields: [
            "siteId",
            "repositoryId",
            "issueNumber",
            "confidential",
            "asNewIssue",
            "title",
            "body",
            "sourceFormat",
            "expectedRevision",
            "operationId"
        ]
    },
    findLabels: {
        service: "mantle.smithy.SmithyIssueServices.find#Labels",
        fields: ["siteId", "repositoryId"]
    },
    storeLabel: {
        service: "mantle.smithy.SmithyIssueServices.store#Label",
        fields: ["siteId", "repositoryId", "labelId", "name", "color", "description", "expectedRevision", "operationId"]
    },
    deleteLabel: {
        service: "mantle.smithy.SmithyIssueServices.delete#Label",
        fields: ["siteId", "repositoryId", "labelId"]
    },
    findMilestones: {
        service: "mantle.smithy.SmithyIssueServices.find#Milestones",
        fields: ["siteId", "repositoryId", "state"]
    },
    storeMilestone: {
        service: "mantle.smithy.SmithyIssueServices.store#Milestone",
        fields: [
            "siteId",
            "repositoryId",
            "milestoneId",
            "name",
            "description",
            "dueDate",
            "state",
            "expectedRevision",
            "operationId"
        ]
    },
    findAssignees: {
        service: "mantle.smithy.SmithyIssueServices.find#Assignees",
        fields: ["siteId", "repositoryId", "query", "limit"]
    },
    // DG4 (§15.5): merge requests, forks, editing a file on its page, the contributor agreement
    findMergeRequests: {
        service: "mantle.smithy.SmithyReviewServices.find#MergeRequests",
        fields: ["siteId", "repositoryId", "groupId", "state", "authorHandle", "reviewerHandle", "targetRef", "query", "limit", "cursor"]
    },
    getMergeRequest: {
        service: "mantle.smithy.SmithyReviewServices.get#MergeRequest",
        fields: ["siteId", "repositoryId", "mergeRequestNum"]
    },
    getMergeRequestChanges: {
        service: "mantle.smithy.SmithyReviewServices.get#MergeRequestChanges",
        fields: ["siteId", "repositoryId", "mergeRequestNum", "path", "withDiffs", "agent"]
    },
    createMergeRequest: {
        service: "mantle.smithy.SmithyReviewServices.create#MergeRequest",
        fields: ["siteId", "repositoryId", "sourceRepositoryId", "sourceRef", "targetRef", "title", "body", "sourceFormat", "draft", "reviewerHandles", "operationId"]
    },
    updateMergeRequest: {
        service: "mantle.smithy.SmithyReviewServices.update#MergeRequest",
        fields: ["siteId", "repositoryId", "mergeRequestNum", "title", "targetRef", "draft", "mergeMethod", "deleteSourceBranch", "expectedRevision"]
    },
    setMergeRequestReviewers: {
        service: "mantle.smithy.SmithyReviewServices.set#Reviewers",
        fields: ["siteId", "repositoryId", "mergeRequestNum", "reviewerHandles", "expectedRevision"]
    },
    submitReview: {
        service: "mantle.smithy.SmithyReviewServices.submit#Review",
        fields: ["siteId", "repositoryId", "mergeRequestNum", "decision", "body", "sourceFormat", "commentList", "operationId"]
    },
    createReviewComment: {
        service: "mantle.smithy.SmithyReviewServices.create#ReviewComment",
        fields: ["siteId", "repositoryId", "mergeRequestNum", "threadId", "commitId", "path", "oldLine", "newLine", "body", "sourceFormat", "operationId"]
    },
    resolveReviewThread: {
        service: "mantle.smithy.SmithyReviewServices.resolve#ReviewThread",
        fields: ["siteId", "repositoryId", "mergeRequestNum", "threadId", "resolved"]
    },
    setMergeRequestState: {
        service: "mantle.smithy.SmithyReviewServices.set#MergeRequestState",
        fields: ["siteId", "repositoryId", "mergeRequestNum", "state", "expectedRevision"]
    },
    mergeMergeRequest: {
        service: "mantle.smithy.SmithyReviewServices.merge#MergeRequest",
        fields: ["siteId", "repositoryId", "mergeRequestNum", "mergeMethod", "message", "deleteSourceBranch", "expectedHeadCommitId", "expectedRevision"]
    },
    forkRepository: {
        service: "mantle.smithy.SmithyReviewServices.fork#Repository",
        fields: ["siteId", "repositoryId", "targetGroupId", "slug", "name", "visibility", "operationId"]
    },
    findForks: {
        service: "mantle.smithy.SmithyReviewServices.find#Forks",
        fields: ["siteId", "repositoryId", "limit", "cursor"]
    },
    getEditContext: {
        service: "mantle.smithy.SmithyReviewServices.get#EditContext",
        fields: ["siteId", "repositoryId", "refPath", "editAction"]
    },
    commitFile: {
        service: "mantle.smithy.SmithyReviewServices.commit#File",
        fields: ["siteId", "repositoryId", "branch", "action", "path", "newPath", "content", "attachmentId", "baseBlobId", "message", "destination", "newBranchName", "mergeRequestTitle", "operationId"]
    },
    getAgreement: {
        service: "mantle.smithy.SmithyAgreementServices.get#Agreement",
        fields: ["siteId", "repositoryId", "groupId", "handle"]
    },
    setAgreement: {
        service: "mantle.smithy.SmithyAgreementServices.set#Agreement",
        fields: ["siteId", "repositoryId", "groupId", "setting", "agreementPath", "expectedRevision"]
    },
    signAgreement: {
        service: "mantle.smithy.SmithyAgreementServices.sign#Agreement",
        fields: ["siteId", "repositoryId", "mergeRequestNum", "legalName", "years", "operationId"]
    },
    recheckAgreement: {
        service: "mantle.smithy.SmithyAgreementServices.recheck#Agreement",
        fields: ["siteId", "repositoryId", "mergeRequestNum", "operationId"]
    },
    declareBotOperator: {
        service: "mantle.smithy.SmithyAgreementServices.declare#BotOperator",
        fields: ["siteId", "repositoryId", "mergeRequestNum", "operationId"]
    },
    confirmBotOperator: {
        service: "mantle.smithy.SmithyAgreementServices.confirm#BotOperator",
        fields: ["siteId", "repositoryId", "mergeRequestNum", "expectedRevision"]
    },
    // DG6 (§15.7): the forum inside Smithy, Report and Hide, a topic made an issue, the report address
    setScopeForum: {
        service: "mantle.smithy.SmithyServices.set#ScopeForum",
        fields: ["siteId", "repositoryId", "groupId", "enabled", "contactListId", "expectedRevision"]
    },
    reportSmithyTarget: {
        service: "mantle.smithy.SmithyServices.report#Target",
        fields: ["siteId", "targetType", "targetId", "reason", "note", "operationId"]
    },
    hideSmithyTarget: {
        service: "mantle.smithy.SmithyServices.hide#Target",
        fields: ["siteId", "targetType", "targetId", "hidden", "reason", "expectedRevision"]
    },
    convertTopicToIssue: {
        service: "mantle.smithy.SmithyIssueServices.convert#TopicToIssue",
        fields: ["siteId", "repositoryId", "rootCommEventId", "postIds", "title", "confidential", "operationId"]
    },
    storeIssueMailRoute: {
        service: "mantle.smithy.SmithyIssueServices.store#MailRoute",
        fields: ["siteId", "groupId", "repositoryId", "address", "enabled", "expectedRevision"]
    },
    claimHeldReport: {
        service: "mantle.smithy.SmithyIssueServices.claim#HeldReport",
        fields: ["siteId", "token", "operationId"]
    },
    // DG5 (§15.6): pipelines
    findPipelineRuns: {
        service: "mantle.smithy.SmithyPipelineServices.find#Runs",
        fields: ["siteId", "repositoryId", "refName", "event", "state", "mergeRequestNum", "commitId", "pipelineName", "limit", "cursor"]
    },
    getPipelineRun: {
        service: "mantle.smithy.SmithyPipelineServices.get#Run",
        fields: ["siteId", "repositoryId", "runNum"]
    },
    getJobRun: {
        service: "mantle.smithy.SmithyPipelineServices.get#JobRun",
        fields: ["siteId", "repositoryId", "runNum", "jobRunId"]
    },
    getJobLog: {
        service: "mantle.smithy.SmithyPipelineServices.get#JobLog",
        fields: ["siteId", "repositoryId", "runNum", "jobRunId", "afterChunkSeq", "offset", "limit", "watch"]
    },
    downloadArtifact: {
        service: "mantle.smithy.SmithyPipelineServices.download#Artifact",
        fields: ["siteId", "repositoryId", "artifactId"]
    },
    runPipeline: {
        service: "mantle.smithy.SmithyPipelineServices.run#Pipeline",
        fields: ["siteId", "repositoryId", "pipelineName", "refName", "operationId"]
    },
    rerunPipelineRun: {
        service: "mantle.smithy.SmithyPipelineServices.rerun#Run",
        fields: ["siteId", "repositoryId", "runNum", "operationId"]
    },
    cancelPipelineRun: {
        service: "mantle.smithy.SmithyPipelineServices.cancel#Run",
        fields: ["siteId", "repositoryId", "runNum"]
    },
    retryJobRun: {
        service: "mantle.smithy.SmithyPipelineServices.retry#JobRun",
        fields: ["siteId", "repositoryId", "runNum", "jobRunId", "operationId"]
    },
    approvePipelineRun: {
        service: "mantle.smithy.SmithyPipelineServices.approve#Run",
        fields: ["siteId", "repositoryId", "runNum"]
    },
    findCiSecrets: {
        service: "mantle.smithy.SmithyPipelineServices.find#Secrets",
        fields: ["siteId", "repositoryId"]
    },
    storeCiSecret: {
        service: "mantle.smithy.SmithyPipelineServices.store#Secret",
        fields: ["siteId", "repositoryId", "secretId", "name", "value", "scope", "environmentId", "operationId"]
    },
    deleteCiSecret: {
        service: "mantle.smithy.SmithyPipelineServices.delete#Secret",
        fields: ["siteId", "repositoryId", "secretId"]
    },
    findCiEnvironments: {
        service: "mantle.smithy.SmithyPipelineServices.find#Environments",
        fields: ["siteId", "repositoryId"]
    },
    storeCiEnvironment: {
        service: "mantle.smithy.SmithyPipelineServices.store#Environment",
        fields: [
            "siteId",
            "repositoryId",
            "environmentId",
            "name",
            "allowedRefs",
            "approvalRequired",
            "targetUrl",
            "token",
            "cloneUrl",
            "requiredPipeline",
            "approverGroupId",
            "operationId"
        ]
    },
    deleteCiEnvironment: {
        service: "mantle.smithy.SmithyPipelineServices.delete#Environment",
        fields: ["siteId", "repositoryId", "environmentId"]
    },
    // DG10: deployments (design-smithy "Deploy environments")
    findDeployments: {
        service: "mantle.smithy.SmithyPipelineServices.find#Deployments",
        fields: ["siteId", "repositoryId", "environment", "state", "commitId", "pageIndex", "limit"]
    },
    getDeployment: {
        service: "mantle.smithy.SmithyPipelineServices.get#Deployment",
        fields: ["siteId", "repositoryId", "deploymentId"]
    },
    requestDeploy: {
        service: "mantle.smithy.SmithyPipelineServices.request#Deploy",
        fields: ["siteId", "repositoryId", "environment", "environmentId", "refName", "commitId", "operationId"]
    },
    decideDeploy: {
        service: "mantle.smithy.SmithyPipelineServices.decide#Deploy",
        fields: ["siteId", "repositoryId", "deploymentId", "decision", "reason"]
    },
    cancelDeploy: {
        service: "mantle.smithy.SmithyPipelineServices.cancel#Deploy",
        fields: ["siteId", "repositoryId", "deploymentId"]
    },
    getPipelineSettings: {
        service: "mantle.smithy.SmithyPipelineServices.get#Settings",
        fields: ["siteId", "repositoryId", "groupId"]
    },
    storePipelineSettings: {
        service: "mantle.smithy.SmithyPipelineServices.store#Settings",
        fields: ["siteId", "groupId", "runnerPoolId", "outsideRunnerPoolId", "outsideRunApproval", "expectedRevision"]
    },
    // DG7 (§15.8): the site
    getGroupLanding: {
        service: "mantle.smithy.SmithySiteServices.get#GroupLanding",
        fields: ["siteId", "groupId"]
    },
    setGroupLanding: {
        service: "mantle.smithy.SmithySiteServices.set#GroupLanding",
        fields: ["siteId", "groupId", "landingRepositoryPath", "landingPath", "newsContactListId", "expectedRevision"]
    },
    getDocsPage: {
        service: "mantle.smithy.SmithySiteServices.get#DocsPage",
        fields: ["siteId", "repositoryId", "refPath"]
    },
    findReleases: {
        service: "mantle.smithy.SmithySiteServices.find#Releases",
        fields: ["siteId", "repositoryId", "groupId", "limit", "cursor"]
    },
    getRelease: {
        service: "mantle.smithy.SmithySiteServices.get#Release",
        fields: ["siteId", "repositoryId", "tag"]
    },
    storeRelease: {
        service: "mantle.smithy.SmithySiteServices.store#Release",
        fields: ["siteId", "repositoryId", "tag", "name", "notes", "sourceFormat", "published", "announce", "expectedRevision", "operationId"]
    },
    deleteRelease: {
        service: "mantle.smithy.SmithySiteServices.delete#Release",
        fields: ["siteId", "repositoryId", "tag", "expectedRevision"]
    },
    addReleaseAsset: {
        service: "mantle.smithy.SmithySiteServices.add#ReleaseAsset",
        fields: ["siteId", "repositoryId", "tag", "name", "attachmentId", "artifactId", "imageName", "operationId"]
    },
    removeReleaseAsset: {
        service: "mantle.smithy.SmithySiteServices.remove#ReleaseAsset",
        fields: ["siteId", "repositoryId", "assetId"]
    },
    downloadReleaseAsset: {
        service: "mantle.smithy.SmithySiteServices.download#ReleaseAsset",
        fields: ["siteId", "repositoryId", "assetId"]
    },
    findComponents: {
        service: "mantle.smithy.SmithySiteServices.find#Components",
        fields: ["siteId", "groupId", "query", "limit", "cursor"]
    },
    getAddons: {
        service: "mantle.smithy.SmithySiteServices.get#Addons",
        fields: ["siteId", "groupId"]
    },
    searchSite: {
        service: "mantle.smithy.SmithySiteServices.search#Site",
        fields: ["siteId", "query", "types", "groupId", "repositoryId", "limit", "cursor"]
    },
    findRedirects: {
        service: "mantle.smithy.SmithySiteServices.find#Redirects",
        fields: ["siteId", "query", "source", "limit", "cursor"]
    },
    storeRedirect: {
        service: "mantle.smithy.SmithySiteServices.store#Redirect",
        fields: ["siteId", "redirectId", "oldHost", "oldPath", "targetPath", "note", "operationId"]
    },
    deleteRedirect: {
        service: "mantle.smithy.SmithySiteServices.delete#Redirect",
        fields: ["siteId", "redirectId"]
    },
    importRedirects: {
        service: "mantle.smithy.SmithySiteServices.import#Redirects",
        fields: ["siteId", "csv", "source"]
    },
    resolveRedirect: {
        service: "mantle.smithy.SmithySiteServices.resolve#OldPath",
        fields: ["siteId", "host", "path"]
    },
    // DG8 (§15.9): GitHub
    startGitHubImport: {
        service: "mantle.smithy.SmithyImportServices.start#Import",
        fields: ["siteId", "groupId", "sourceRepository", "slug", "repositoryId", "token", "options", "operationId"]
    },
    getGitHubImport: {
        service: "mantle.smithy.SmithyImportServices.get#ImportRun",
        fields: ["siteId", "importId"]
    },
    findGitHubImports: {
        service: "mantle.smithy.SmithyImportServices.find#ImportRuns",
        fields: ["siteId", "groupId", "limit", "cursor"]
    },
    resumeGitHubImport: {
        service: "mantle.smithy.SmithyImportServices.resume#Import",
        fields: ["siteId", "importId", "token", "expectedRevision"]
    },
    cancelGitHubImport: {
        service: "mantle.smithy.SmithyImportServices.cancel#Import",
        fields: ["siteId", "importId", "expectedRevision"]
    },
    findMirrors: {
        service: "mantle.smithy.SmithyImportServices.find#Mirrors",
        fields: ["siteId", "repositoryId"]
    },
    storeMirror: {
        service: "mantle.smithy.SmithyImportServices.store#Mirror",
        fields: [
            "siteId",
            "repositoryId",
            "mirrorId",
            "url",
            "username",
            "secret",
            "hostKeyFingerprint",
            "refs",
            "deleteRefs",
            "enabled",
            "removeCredential",
            "operationId"
        ]
    },
    deleteMirror: {
        service: "mantle.smithy.SmithyImportServices.delete#Mirror",
        fields: ["siteId", "repositoryId", "mirrorId"]
    },
    pushMirror: {
        service: "mantle.smithy.SmithyImportServices.push#Mirror",
        fields: ["siteId", "repositoryId", "mirrorId"]
    }
})
