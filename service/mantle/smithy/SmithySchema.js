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
    }
})
