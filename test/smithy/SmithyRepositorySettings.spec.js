// A repository's settings by role (mr-pass plan/design-smithy.md §5.3, §11 RepositorySettings, §15.3; SmithyManage.js
// updateRepository, setRepositoryVisibility, updateGroup, setRepositoryArchived, deleteRepository; SmithyGit.js createRef,
// deleteRef, the branch rules and the webhooks): a Maintainer changes the general settings and a pin is its group's
// Owner's; a repository is no wider than its group and a narrower group narrows what is in it; a Developer makes a branch
// or a tag, a Reporter does not (nor pushes, by the one check), and a Maintainer deletes one, within the branch rules; a
// Maintainer keeps the branch rules and the webhooks, and a webhook's secret is never read back; an archived repository
// takes no write; an Owner deletes a repository with its path typed. Spec-local site, accounts, a group and db
// repositories. Regression suite: these are rules. Run: ./moq test mr-mantle --spec SmithyRepositorySettings
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const SITE = "SRS_SITE"
const ids = {}
const op = (username, operation, input) => lib.op(username, SITE, operation, input)
const on = (username, operation, input = {}) => op(username, operation, {repositoryId: ids.code, ...input})
const revision = (repositoryId = ids.code) => Number(lib.row("mantle.smithy.SmithyRepository", {repositoryId}).revision)
const view = (repositoryId = ids.code) => op("SRS_OWNER", "getRepository", {repositoryId}).repository
const refNames = () => on("SRS_OWNER", "findRefs", {namesOnly: "true"}).refList.map(ref => ref.refType + " " + ref.name)

spec({
    requires: ["git"],
    setupSpec() {
        login(lib.OPERATOR)
        lib.site(SITE)
        for (const id of ["OWNER", "MAINTAINER", "DEVELOPER", "REPORTER"])
            lib.account(SITE, "SRS_" + id, {handle: "srs" + id.toLowerCase()})
        ids.group = lib.createGroup(lib.OPERATOR, {siteId: SITE, pathSegment: "srsgroup", visibility: "public"}).groupId
        ids.sub = lib.createGroup(lib.OPERATOR, {
            siteId: SITE,
            parentGroupId: ids.group,
            pathSegment: "sub",
            visibility: "public"
        }).groupId
        const repository = (groupId, slug) =>
            lib.createRepository(lib.OPERATOR, {siteId: SITE, groupId, slug, visibility: "public"}).repositoryId
        ids.code = repository(ids.group, "code")
        ids.inner = repository(ids.sub, "inner")
        ids.spare = repository(ids.group, "spare")
        ids.doomed = repository(ids.group, "doomed")
        for (const id of ["OWNER", "MAINTAINER", "DEVELOPER", "REPORTER"])
            lib.role(SITE, {groupId: ids.group}, "SRS_" + id, "Smr" + id[0] + id.slice(1).toLowerCase())
        lib.commit(ids.code, "Start", {"README.md": "# Code\n"})
    }
})

feature("a Maintainer changes a repository's general settings, and its pin is its group's Owner's", {
    when() {
        const update = (username, fields) => on(username, "updateRepository", {expectedRevision: revision(), ...fields})
        const fields = {
            name: "The Code",
            description: "What it does",
            issuesEnabled: "true",
            defaultMergeMethod: "squash",
            docsPath: "/guide/"
        }
        return {
            developer: update("SRS_DEVELOPER", fields),
            maintainer: update("SRS_MAINTAINER", fields),
            view: view(),
            stale: on("SRS_MAINTAINER", "updateRepository", {name: "Late", expectedRevision: 1}),
            noBranch: update("SRS_MAINTAINER", {defaultBranch: "nope"}),
            pinByMaintainer: update("SRS_MAINTAINER", {pinnedSequence: "1"}),
            pinByOwner: update("SRS_OWNER", {pinnedSequence: "1"}),
            pinned: view().pinnedSequence
        }
    },
    then({developer, maintainer, view, stale, noBranch, pinByMaintainer, pinByOwner, pinned}) {
        developer.kind == "Unauthorized"
        developer.reason == "accessDenied"
        maintainer.revision == 2
        view.name == "The Code"
        view.description == "What it does"
        view.features.issues == true
        // what was not given stays
        view.features.mergeRequests == true
        view.defaultMergeMethod == "squash"
        view.docsPath == "guide"
        stale.kind == "Conflict"
        stale.reason == "staleRevision"
        noBranch.kind == "Unprocessable"
        pinByMaintainer.reason == "accessDenied"
        pinByOwner.revision == 3
        pinned == 1
    }
})

feature("a repository is no wider than its group, and a narrower group narrows what is in it", {
    when() {
        const groupRevision = groupId => Number(lib.row("mantle.smithy.SmithyGroup", {groupId}).revision)
        const narrow = (username, groupId, visibility) =>
            op(username, "updateGroup", {groupId, visibility, expectedRevision: groupRevision(groupId)})
        const set = (username, repositoryId, visibility) =>
            op(username, "setRepositoryVisibility", {repositoryId, visibility, expectedRevision: revision(repositoryId)})
        const byMaintainer = narrow("SRS_MAINTAINER", ids.sub, "members")
        const narrowed = narrow("SRS_OWNER", ids.sub, "members")
        return {
            byMaintainer,
            narrowed,
            inner: view(ids.inner),
            wider: set("SRS_OWNER", ids.inner, "public"),
            subWider: narrow("SRS_OWNER", ids.sub, "public"),
            maintainer: set("SRS_MAINTAINER", ids.spare, "private"),
            owner: set("SRS_OWNER", ids.spare, "private")
        }
    },
    then({byMaintainer, narrowed, inner, wider, subWider, maintainer, owner}) {
        byMaintainer.reason == "accessDenied"
        // the repository in it was public
        narrowed.narrowedCount == 1
        inner.visibility == "members"
        inner.effectiveVisibility == "members"
        wider.kind == "Unprocessable"
        wider.reason == "policyRefused"
        // a group is as wide as its Owner says, up to the group above: the repository stays as narrow as it became
        subWider.narrowedCount == 0
        view(ids.inner).visibility == "members"
        maintainer.reason == "accessDenied"
        owner.visibility == "private"
        owner.effectiveVisibility == "private"
    }
})

feature("a Developer makes a branch or a tag and a Maintainer deletes one; a Reporter does neither, nor pushes", {
    when() {
        const create = (username, refType, name, operationId, more = {}) =>
            on(username, "createRef", {refType, name, operationId, ...more})
        const remove = (username, refType, name) => on(username, "deleteRef", {refType, name})
        const made = {
            reporter: create("SRS_REPORTER", "branch", "topic", "srs-ref-1"),
            branch: create("SRS_DEVELOPER", "branch", "topic", "srs-ref-2"),
            again: create("SRS_DEVELOPER", "branch", "topic", "srs-ref-3"),
            tag: create("SRS_DEVELOPER", "tag", "v1", "srs-ref-4", {fromRevision: "topic", message: "The first"}),
            expression: create("SRS_DEVELOPER", "branch", "other", "srs-ref-5", {fromRevision: "main~1"})
        }
        const names = refNames()
        return {
            made,
            names,
            // the one check, which git asks: a Reporter views and does not push
            push: ["SRS_REPORTER", "SRS_DEVELOPER"].map(
                userId => lib.authz(userId, ids.code, "VIEW") + " " + lib.authz(userId, ids.code, "CREATE")
            ),
            byDeveloper: remove("SRS_DEVELOPER", "branch", "topic"),
            byMaintainer: remove("SRS_MAINTAINER", "branch", "topic"),
            defaultBranch: remove("SRS_MAINTAINER", "branch", "main"),
            missing: remove("SRS_MAINTAINER", "branch", "topic"),
            after: refNames()
        }
    },
    then({made, names, push, byDeveloper, byMaintainer, defaultBranch, missing, after}) {
        made.reporter.kind == "Unauthorized"
        made.reporter.reason == "accessDenied"
        made.branch.name == "topic"
        made.branch.commitId.length == 40
        made.again.kind == "Conflict"
        made.tag.commitId == made.branch.commitId
        // a branch, a tag or a commit id, never an expression
        made.expression.kind == "NotFound"
        names == ["branch main", "branch topic", "tag v1"]
        push == ["AUTHZT_ALLOW AUTHZT_NONE", "AUTHZT_ALLOW AUTHZT_ALLOW"]
        byDeveloper.reason == "accessDenied"
        byMaintainer.deleted == true
        defaultBranch.kind == "Conflict"
        missing.kind == "NotFound"
        after == ["branch main", "tag v1"]
    }
})

feature("a Maintainer keeps the branch rules, which bind a Maintainer too", {
    when() {
        const store = (username, fields, operationId) => on(username, "storeBranchRule", {operationId, ...fields})
        on("SRS_DEVELOPER", "createRef", {refType: "branch", name: "release/1", operationId: "srs-rule-0"})
        const developer = store("SRS_DEVELOPER", {refPattern: "release/*"}, "srs-rule-1")
        const stored = store(
            "SRS_MAINTAINER",
            {refPattern: "release/*", requiredApprovals: "2", allowedMergeMethods: "merge, squash"},
            "srs-rule-2"
        )
        return {
            developer,
            stored,
            rules: on("SRS_MAINTAINER", "getBranchRules").ruleList,
            byDeveloper: on("SRS_DEVELOPER", "getBranchRules"),
            // the rule does not allow a delete, so a Maintainer's delete of the branch is refused
            protectedDelete: on("SRS_MAINTAINER", "deleteRef", {refType: "branch", name: "release/1"}),
            edited: store("SRS_MAINTAINER", {branchRuleId: stored.branchRuleId, refPattern: "release/*", allowDelete: "true"}),
            allowedDelete: on("SRS_MAINTAINER", "deleteRef", {refType: "branch", name: "release/1"}),
            // a push group an operator set on the rule stays through a Maintainer's edit
            pushGroup: (() => {
                lib.set("moqui.resource.GitBranchRule", {branchRuleId: stored.branchRuleId}, {pushUserGroupId: "ADMIN"})
                store("SRS_MAINTAINER", {branchRuleId: stored.branchRuleId, refPattern: "release/*", allowDelete: "true"})
                return lib.row("moqui.resource.GitBranchRule", {branchRuleId: stored.branchRuleId}).pushUserGroupId
            })(),
            // a rule is its repository's: from another repository it is Not Found
            elsewhere: op("SRS_MAINTAINER", "deleteBranchRule", {repositoryId: ids.spare, branchRuleId: stored.branchRuleId}),
            removed: on("SRS_MAINTAINER", "deleteBranchRule", {branchRuleId: stored.branchRuleId}),
            left: on("SRS_MAINTAINER", "getBranchRules").ruleList.length
        }
    },
    then({developer, stored, rules, byDeveloper, protectedDelete, edited, allowedDelete, pushGroup, elsewhere, removed, left}) {
        pushGroup == "ADMIN"
        developer.reason == "accessDenied"
        rules.length == 1
        rules[0].branchRuleId == stored.branchRuleId
        rules[0].refPattern == "release/*"
        rules[0].allowDelete == false
        rules[0].requiredApprovals == 2
        rules[0].allowedMergeMethods == ["merge", "squash"]
        byDeveloper.reason == "accessDenied"
        protectedDelete.kind == "Unauthorized"
        protectedDelete.reason == "accessDenied"
        edited.branchRuleId == stored.branchRuleId
        allowedDelete.deleted == true
        elsewhere.kind == "NotFound"
        removed.deleted == true
        left == 0
    }
})

feature("a Maintainer keeps the webhooks, and a secret is never read back", {
    when() {
        const hook = {url: "https://hooks.example.test/smithy", events: "push, tag", secret: "srs-secret-value"}
        const developer = on("SRS_DEVELOPER", "storeWebhook", {...hook, operationId: "srs-hook-1"})
        const stored = on("SRS_MAINTAINER", "storeWebhook", {...hook, operationId: "srs-hook-2"})
        const list = on("SRS_MAINTAINER", "findWebhooks")
        return {
            developer,
            stored,
            list,
            text: JSON.stringify(list),
            byDeveloper: on("SRS_DEVELOPER", "findWebhooks"),
            badUrl: on("SRS_MAINTAINER", "storeWebhook", {url: "ftp://example.test/x", operationId: "srs-hook-3"}),
            // a hook to this server's own address is stored (the framework's outbound rules are asked at a delivery),
            // its test fails without saying why, and tests are few a minute
            tests: (() => {
                const local = on("SRS_MAINTAINER", "storeWebhook", {url: "http://127.0.0.1:9/hook", operationId: "srs-hook-4"})
                const test = () => on("SRS_MAINTAINER", "testWebhook", {webhookId: local.webhookId})
                const results = [test(), test(), test(), test()]
                on("SRS_MAINTAINER", "deleteWebhook", {webhookId: local.webhookId})
                return results
            })(),
            elsewhere: op("SRS_MAINTAINER", "deleteWebhook", {repositoryId: ids.spare, webhookId: stored.webhookId}),
            removed: on("SRS_MAINTAINER", "deleteWebhook", {webhookId: stored.webhookId}),
            left: on("SRS_MAINTAINER", "findWebhooks").webhookList.length
        }
    },
    then({developer, stored, list, text, byDeveloper, badUrl, tests, elsewhere, removed, left}) {
        JSON.stringify(tests[0]) == '{"statusCode":null,"delivered":false,"errorText":"The delivery failed"}'
        tests[2].delivered == false
        tests[3].kind == "Tarpit"
        tests[3].reason == "rateLimited"
        developer.reason == "accessDenied"
        list.webhookList.length == 1
        list.webhookList[0].webhookId == stored.webhookId
        list.webhookList[0].events == ["push", "tag"]
        list.webhookList[0].active == true
        list.webhookList[0].hasSecret == true
        text.includes("srs-secret-value") == false
        byDeveloper.reason == "accessDenied"
        badUrl.kind == "Unprocessable"
        elsewhere.kind == "NotFound"
        removed.deleted == true
        left == 0
    }
})

feature("an Owner archives a repository, which then takes no write and no push", {
    when() {
        const archive = (username, archived) => on(username, "setRepositoryArchived", {archived, expectedRevision: revision()})
        const maintainer = archive("SRS_MAINTAINER", "true")
        const archived = archive("SRS_OWNER", "true")
        const during = {
            view: view().archived,
            update: on("SRS_MAINTAINER", "updateRepository", {name: "Again", expectedRevision: revision()}),
            ref: on("SRS_DEVELOPER", "createRef", {refType: "branch", name: "late", operationId: "srs-archive-1"}),
            rule: on("SRS_MAINTAINER", "storeBranchRule", {refPattern: "main", operationId: "srs-archive-2"}),
            push: lib.gate("Push", {repositoryId: ids.code, userId: "SRS_DEVELOPER", packBytes: 100}),
            capability: op("SRS_DEVELOPER", "getRepository", {repositoryId: ids.code}).capabilities.canPush
        }
        return {
            maintainer,
            archived,
            during,
            restored: archive("SRS_OWNER", "false"),
            after: lib.gate("Push", {repositoryId: ids.code, userId: "SRS_DEVELOPER", packBytes: 100})
        }
    },
    then({maintainer, archived, during, restored, after}) {
        maintainer.reason == "accessDenied"
        archived.archived == true
        during.view == true
        during.update.kind == "Conflict"
        during.update.reason == "repositoryArchived"
        during.ref.reason == "repositoryArchived"
        during.rule.reason == "repositoryArchived"
        during.push.length == 1
        during.push[0].includes("archived")
        during.capability == false
        restored.archived == false
        after == []
    }
})

feature("an Owner deletes a repository with its path typed, and it is gone from Smithy and from the git host", {
    when() {
        const remove = (username, confirmPath) =>
            op(username, "deleteRepository", {repositoryId: ids.doomed, confirmPath, expectedRevision: revision(ids.doomed)})
        const maintainer = remove("SRS_MAINTAINER", "srsgroup/doomed")
        const mistyped = remove("SRS_OWNER", "srsgroup/doomd")
        const deleted = remove("SRS_OWNER", "srsgroup/doomed")
        return {
            maintainer,
            mistyped,
            deleted,
            after: op("SRS_OWNER", "getRepository", {repositoryId: ids.doomed}),
            path: op("SRS_OWNER", "resolveSmithyPath", {path: "srsgroup/doomed"})
        }
    },
    then({maintainer, mistyped, deleted, after, path}) {
        maintainer.reason == "accessDenied"
        mistyped.kind == "Unprocessable"
        deleted.deleted == true
        after.kind == "NotFound"
        path.kind == "NotFound"
        lib.row("mantle.smithy.SmithyRepository", {repositoryId: ids.doomed}) == null
        lib.row("moqui.resource.GitRepository", {repositoryId: ids.doomed}) == null
    }
})
