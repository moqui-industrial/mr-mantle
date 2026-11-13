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
    }
})
