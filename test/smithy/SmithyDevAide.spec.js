// Smithy's side of the Dev AIDE's connection to a group server (mr-moqui plans/design-dev-aide.md §21; SmithyHosting.js,
// PassAuthority.js APP_KEY_OPERATIONS): the framework's REST refuses the writes of a repository Smithy keeps and names
// Smithy's REST, and allows its reads and any other repository's writes; the hosting offer names Smithy's REST of the
// host's site, forks and Mantle's task source; the agreement check answers for a repository Smithy keeps; an installed
// app's login key calls the Dev AIDE's operations through the PASS REST as its account (and nothing else), and an access
// token, a session's key, a scoped key, an expired key, another account's key and a header session with no key call
// none (design-smithy §5.5); an outside CI's status passes the write check; what an author lacks is told only to that
// author or a Maintainer. Spec-local site, accounts and db repository. Regression suite: these are rules.
// Run: ./moq test mr-mantle --spec SmithyDevAide
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const SITE = "SDA_SITE"
const HOST = "sda.smithy.test"
const REST = "/rest/s1/pass/v1/sites/" + SITE + "/smithy"
const ids = {}
const keys = {}
const hook = (verb, parameters) => lib.run("mantle.smithy.SmithyGitServices." + verb, parameters)
// A request to the PASS REST as the servlet API gives it to PassApi.js, with a login key in the api_key header as the Dev
// AIDE sends it, signed in by that key as the framework's header login does (so ec.user.loginKeyKind tells its kind; a
// key that does not sign in leaves nobody signed in): the status and the JSON answer.
function rest(key, method, path, parameters = {}) {
    return lib.as(null, () => {
        if (key) ec.user.loginUserKey(key)
        ec.message.clearErrors()
        const request = {
            requestURI: REST + "/" + path,
            method,
            getHeader: name => (String(name).toLowerCase() === "api_key" ? key : null),
            getParameterMap: () => ({...parameters})
        }
        const response = {
            status: 200,
            body: "",
            setStatus(status) {
                this.status = status
            },
            setHeader() {},
            setContentType() {},
            write(text) {
                this.body += text
            },
            sendRedirect() {}
        }
        ec.resource.script("component://mr-mantle/script/PassApi.js").service(request, response)
        return {status: response.status, body: JSON.parse(response.body || "null")}
    })
}
/* Keys issued by the framework's own services as their user: an access token (create#UserAccessToken), a session's key
   (ec.user.getLoginKey), and from an access token's row a scoped key and a device's key: the row made a
   device's as /sso/appToken's issue_device_key leaves one (deviceName, no description or scope), since the framework issues a
   device key only through the app sign-in's code or the REST login, which a server spec cannot make. kind: device,
   expired (a device's key past its thruDate), scoped (the gateway's, as create#UserScopedKey makes it) or token. */
function issued(username, kind) {
    return lib.as(username, () => {
        const out = lib.run("org.moqui.impl.UserServices.create#UserAccessToken", {description: "Laptop"})
        if (kind !== "token")
            lib.set("moqui.security.UserLoginKey", {loginKey: out.loginKey}, {
                deviceName: "Dev AIDE",
                description: null,
                // create#UserAccessToken writes scope git; a device's key has none
                scope: null,
                ...(kind === "expired" ? {thruDate: ec.user.timestampMillis(ec.user.nowTimestamp) - 60000} : {}),
                // a scoped key as create#UserScopedKey leaves one (the gateway's alone, under a device name)
                ...(kind === "scoped" ? {scope: "gateway", deviceName: "Gateway"} : {})
            })
        return out.accessToken
    })
}
spec({
    requires: ["git"],
    setupSpec() {
        login(lib.OPERATOR)
        lib.site(SITE)
        lib.make("mantle.public.PublicSiteHost", {hostname: HOST, siteId: SITE, canonical: "Y"})
        lib.settings(SITE, {forkCreateEnumId: "ScpVerified"})
        lib.account(SITE, "SDA_DEV", {member: true, handle: "sdadev"})
        lib.settled(SITE, "SDA_DEV")
        ids.groupId = lib.createGroup(lib.OPERATOR, {siteId: SITE, pathSegment: "sdagroup", visibility: "public"}).groupId
        ids.repositoryId = lib.createRepository(lib.OPERATOR, {siteId: SITE, groupId: ids.groupId, slug: "code", visibility: "public"}).repositoryId
        lib.role(SITE, {repositoryId: ids.repositoryId}, "SDA_DEV", "SmrDeveloper")
        lib.commit(ids.repositoryId, "Start", {"README.md": "# Code\n"})
        lib.run("org.moqui.git.GitServices.commit#GitFiles", {
            repositoryId: ids.repositoryId,
            message: "Add a feature",
            fileMap: {"feature.txt": "one\n"},
            branch: "main",
            newBranch: "feature"
        })
        lib.account(SITE, "SDA_OTHER", {member: true, handle: "sdaother"})
        keys.device = issued("SDA_DEV", "device")
        keys.token = issued("SDA_DEV", "token")
        keys.expired = issued("SDA_DEV", "expired")
        keys.others = issued("SDA_OTHER", "device")
        keys.session = lib.as("SDA_DEV", () => ec.user.getLoginKey(1))
        keys.scoped = issued("SDA_DEV", "scoped")
    }
})

feature("the write check refuses a Smithy repository's writes and names Smithy's REST; reads and other repositories pass", {
    when() {
        return {
            write: hook("check#RestWrite", {repositoryId: ids.repositoryId, operation: "mergeRequest.create"}),
            status: hook("check#RestWrite", {repositoryId: ids.repositoryId, operation: "commitStatus.create"}),
            // the writes Smithy's own operations keep, each named
            rerun: hook("check#RestWrite", {repositoryId: ids.repositoryId, operation: "pipeline.rerun"}),
            retry: hook("check#RestWrite", {repositoryId: ids.repositoryId, operation: "job.retry"}),
            comment: hook("check#RestWrite", {repositoryId: ids.repositoryId, operation: "mergeRequest.comment"}),
            resolve: hook("check#RestWrite", {repositoryId: ids.repositoryId, operation: "mergeRequest.resolveThread"}),
            read: hook("check#RestWrite", {repositoryId: ids.repositoryId, operation: "read"}),
            other: hook("check#RestWrite", {repositoryId: "SDA_NOT_SMITHY", operation: "ref.create"})
        }
    },
    then({write, status, rerun, retry, comment, resolve, read, other}) {
        rerun.allowed == false
        rerun.message.includes("rerunPipelineRun")
        retry.allowed == false
        retry.message.includes("retryJobRun")
        comment.allowed == false
        comment.message.includes("createReviewComment")
        resolve.allowed == false
        resolve.message.includes("resolveReviewThread")
        // an outside CI's status goes through the framework (its push right and reserved contexts decide)
        status.allowed == true
        write.allowed == false
        write.application == "smithy"
        write.restUrl == "https://" + HOST + REST
        write.message.includes("Smithy's REST")
        read.allowed == true
        read.application == "smithy"
        other.allowed == true
        !other.application
    }
})

feature("the offer names Smithy's REST of the host's site, its forks and Mantle's task source", {
    when() {
        return hook("add#HostingOffer", {
            offer: {
                baseUrl: "https://" + HOST,
                forks: false,
                git: {httpsBase: "https://" + HOST + "/git/"},
                gateway: {enabled: true, keyPath: "/rest/s1/moqui/hosting/gatewayKey", requireClient: true},
                signIn: {appLogin: "/sso/appLogin", keyRevoke: "/rest/s1/moqui/hosting/keyRevoke"},
                rest: {base: "/rest/s1/moqui", reviewThreads: true}
            }
        }).offer
    },
    then(offer) {
        // what the framework offers stays: Smithy adds to it
        offer.gateway.keyPath == "/rest/s1/moqui/hosting/gatewayKey"
        offer.gateway.requireClient == true
        offer.signIn.keyRevoke == "/rest/s1/moqui/hosting/keyRevoke"
        offer.rest.reviewThreads == true
        offer.application.name == "smithy"
        offer.application.restBase == REST
        offer.forks == true
        offer.tasks.kind == "moqui-rest"
        offer.tasks.path == "/rest/s1/mantle/my/tasks"
        offer.tasks.issuePath == "/rest/s1/mantle/workEfforts/{id}"
        offer.tasks.issuesPath == "/rest/s1/mantle/gitRepositories/{repositoryId}/issues"
        // the app a work item opens in, where one is loaded (mr-boss or mr-marble)
        !offer.tasks.app || (offer.tasks.app.taskPath.includes("{taskId}") && offer.tasks.app.projectPath.includes("{projectId}"))
        // the framework's offer stays
        offer.git.httpsBase == "https://" + HOST + "/git/"
    }
})

feature("the agreement check answers for a repository Smithy keeps and leaves any other unknown", {
    when() {
        return {
            kept: hook("check#AuthorSigned", {repositoryId: ids.repositoryId, authorUserId: "SDA_DEV"}),
            other: hook("check#AuthorSigned", {repositoryId: "SDA_NOT_SMITHY", authorUserId: "SDA_DEV"}),
            // what is missing is the author's own to read (or a Maintainer's): another account learns signed or not
            own: lib.as("SDA_DEV", () => hook("check#AuthorSigned", {repositoryId: ids.repositoryId, authorUserId: "SDA_DEV"})),
            byAddress: lib.as("SDA_OTHER", () =>
                hook("check#AuthorSigned", {repositoryId: ids.repositoryId, authorEmail: "sda_dev@smithy.test"})
            )
        }
    },
    then({kept, other, own, byAddress}) {
        own.signed == false
        own.message.includes("missing")
        byAddress.signed == false
        !byAddress.message.includes("missing")
        kept.known == true
        kept.required == false
        kept.signUrl.startsWith("https://" + HOST + "/code/sdagroup/code/-/edit/main/")
        other.known == false
    }
})

feature("an installed app's key calls the Dev AIDE's operations as its account and nothing else; an access token none", {
    when() {
        const open = (key, operationId) =>
            rest(key, "POST", "repositories/" + ids.repositoryId + "/merge-requests", {sourceRef: "feature", title: "Add a feature", operationId})
        const opened = open(keys.device, "sda-open-1")
        return {
            opened,
            again: open(keys.device, "sda-open-1"),
            list: rest(keys.device, "GET", "merge-requests", {repositoryId: ids.repositoryId}),
            fork: rest(keys.device, "POST", "repositories/" + ids.repositoryId + "/forks", {operationId: "sda-fork-1"}),
            settings: rest(keys.device, "PATCH", "settings", {}),
            tokenOpen: open(keys.token, "sda-open-2"),
            tokenList: rest(keys.token, "GET", "merge-requests", {repositoryId: ids.repositoryId}),
            unknownKey: rest("sda-no-such-key", "GET", "merge-requests", {repositoryId: ids.repositoryId}),
            // what design-dev-aide §21.4 to §21.6 also asks: a review, the issues
            review: rest(keys.device, "POST", "repositories/" + ids.repositoryId + "/merge-requests/1/reviews", {
                decision: "comment",
                body: "Read it",
                operationId: "sda-review-1"
            }),
            issues: rest(keys.device, "GET", "issues", {repositoryId: ids.repositoryId}),
            // keys that are no app's: expired, a session's, a scoped one (which only its service's login takes); and a
            // session a header login made, with no key. Another account's app key acts as that account
            expired: rest(keys.expired, "GET", "merge-requests", {repositoryId: ids.repositoryId}),
            others: rest(keys.others, "GET", "merge-requests", {repositoryId: ids.repositoryId}),
            session: rest(keys.session, "GET", "merge-requests", {repositoryId: ids.repositoryId}),
            scoped: rest(keys.scoped, "GET", "merge-requests", {repositoryId: ids.repositoryId}),
            headerSession: lib.as("SDA_DEV", () =>
                ec.resource.script("component://mr-mantle/script/PassAuthority.js").handle({
                    siteId: SITE,
                    operation: "findMergeRequests",
                    input: {repositoryId: ids.repositoryId},
                    sessionChecked: true,
                    headerLogin: true
                })
            )
        }
    },
    then({opened, again, list, fork, settings, tokenOpen, tokenList, unknownKey, review, issues, expired, others, session, scoped, headerSession}) {
        // past the key's rule (the post gate may still ask the account to wait between two posts)
        review.status != 403
        // past the key's rule (this repository's issues are off: Not Found, as to any caller)
        issues.status == 404
        expired.status == 403
        // the key's own account, which reads this public repository's merge requests
        others.status == 200
        session.status == 403
        scoped.status == 403
        headerSession.error.status == 403
        opened.status == 200
        opened.body.mergeRequestNum == 1
        // the same operationId answers the first result
        again.body.mergeRequestNum == 1
        list.status == 200
        list.body.mergeRequestList.map(item => [item.number, item.title, item.state, item.authorHandle, item.url]) ==
            [[1, "Add a feature", "open", "sdadev", "https://" + HOST + "/code/sdagroup/code/-/merge-requests/1"]]
        fork.status == 200
        fork.body.repositoryPath == "sdadev/code"
        fork.body.cloneUrls.httpsUrl.endsWith("sdadev/code.git")
        settings.status == 403
        settings.body.reason == "accessDenied"
        tokenOpen.status == 403
        tokenOpen.body.reason == "accessDenied"
        tokenList.status == 403
        unknownKey.status == 403
    }
})

feature("Smithy's comment answers its thread and whether the gate holds it; the changes keep files, heads and threads", {
    when() {
        lib.settled(SITE, "SDA_DEV")
        const comment = lib.op("SDA_DEV", SITE, "createReviewComment", {
            repositoryId: ids.repositoryId,
            mergeRequestNum: 1,
            path: "feature.txt",
            newLine: 1,
            body: "Why one?",
            operationId: "sda-comment-1"
        })
        const changes = lib.op("SDA_DEV", SITE, "getMergeRequestChanges", {repositoryId: ids.repositoryId, mergeRequestNum: 1})
        return {comment, changes}
    },
    then({comment, changes}) {
        comment.threadId != null
        comment.held == false
        changes.fileList.some(file => file.path == "feature.txt")
        changes.headCommitId != null
        changes.mergeBaseId != null
        changes.threadList.some(thread => thread.threadId == comment.threadId)
    }
})

feature("the framework's review threads are Mantle's: found, commented, answered and resolved through handle#GitReviewThread", {
    when() {
        // a repository Smithy does not keep, with a merge request of a branch
        lib.make("moqui.resource.GitRepository", {repositoryId: "sda_plain", repositoryKind: "db", branch: "main"})
        lib.run("org.moqui.git.GitServices.init#GitRepository", {repositoryId: "sda_plain"})
        lib.commit("sda_plain", "Start", {"README.md": "# Plain\n"})
        lib.run("org.moqui.git.GitServices.commit#GitFiles", {
            repositoryId: "sda_plain",
            message: "Add a line",
            fileMap: {"plain.txt": "one\n"},
            branch: "main",
            newBranch: "plain"
        })
        const mergeRequestId = lib.run("org.moqui.git.GitReviewServices.create#MergeRequest", {
            repositoryId: "sda_plain",
            sourceRef: "plain",
            title: "Plain"
        }).mergeRequestId
        const thread = (operation, more) =>
            lib.run("mantle.work.GitServices.handle#GitReviewThread", {operation, repositoryId: "sda_plain", mergeRequestId, ...more})
        const opened = thread("comment", {path: "plain.txt", newLine: 1, body: "Why one?"})
        const answered = thread("comment", {threadId: opened.threadId, body: "Because."})
        const resolvedOut = thread("resolve", {threadId: opened.threadId, resolved: true})
        // a reply given a reply's id answers the thread's root
        const replyId = thread("find", {}).threadList[0].commentList[1].commentId
        const againOut = thread("comment", {threadId: replyId, body: "Still?"})
        // a line comment on a commit that is not the head now is refused plainly
        const stale = lib.service(lib.OPERATOR, "mantle.work.GitServices.handle#GitReviewThread", {
            operation: "comment",
            repositoryId: "sda_plain",
            mergeRequestId,
            path: "plain.txt",
            newLine: 1,
            commitId: "0000000000000000000000000000000000000000",
            body: "Late"
        })
        // a client contact (PROJECT_CLIENT) who views the repository (here as an administrator too) reads no threads and
        // writes none
        lib.account(SITE, "SDA_CLIENT")
        lib.make("moqui.security.UserGroupMember", {userId: "SDA_CLIENT", userGroupId: "ADMIN", fromDate: 0})
        lib.make("moqui.security.UserGroup", {userGroupId: "SDA_CLIENTS", description: "Smithy spec clients"})
        lib.make("moqui.security.UserGroupMember", {userId: "SDA_CLIENT", userGroupId: "SDA_CLIENTS", fromDate: 0})
        lib.make("moqui.security.UserGroupPermission", {userGroupId: "SDA_CLIENTS", userPermissionId: "PROJECT_CLIENT", fromDate: 0})
        const asClient = (operation, more) =>
            lib.service("SDA_CLIENT", "mantle.work.GitServices.handle#GitReviewThread", {operation, repositoryId: "sda_plain", mergeRequestId, ...more})
        const clientFind = asClient("find", {})
        const clientComment = asClient("comment", {threadId: opened.threadId, body: "From the client"})
        // an account that may view nothing, calling the service itself with authorization disabled (with which the inner
        // services' own checks pass anyone): refused by this service's check of the caller, before anything is written
        const noViewComment = lib.service("SDA_OTHER", "mantle.work.GitServices.handle#GitReviewThread", {
            operation: "comment",
            repositoryId: "sda_plain",
            mergeRequestId,
            path: "plain.txt",
            newLine: 1,
            body: "Sneaky"
        })
        // an account that may not view the repository, calling the service itself: the merge request is not there
        const noView = lib.service("SDA_OTHER", "mantle.work.GitServices.handle#GitReviewThread", {
            operation: "find",
            repositoryId: "sda_plain",
            mergeRequestId
        })
        // another merge request named by the path: its threads are not this one's, to resolve or to answer
        lib.run("org.moqui.git.GitServices.commit#GitFiles", {
            repositoryId: "sda_plain",
            message: "Another line",
            fileMap: {"other.txt": "two\n"},
            branch: "main",
            newBranch: "other"
        })
        const otherId = lib.run("org.moqui.git.GitReviewServices.create#MergeRequest", {repositoryId: "sda_plain", sourceRef: "other", title: "Other"})
            .mergeRequestId
        const refused = (operation, more) =>
            lib.service(lib.OPERATOR, "mantle.work.GitServices.handle#GitReviewThread", {
                operation,
                repositoryId: "sda_plain",
                mergeRequestId: otherId,
                threadId: opened.threadId,
                ...more
            })
        const crossResolve = refused("resolve", {resolved: false})
        const crossReply = refused("comment", {body: "Sneaky"})
        // a hidden merge request is its author's alone
        lib.set("moqui.resource.GitMergeRequest", {mergeRequestId: otherId}, {hiddenDate: ec.user.nowTimestamp, authorUserId: "SDA_DEV"})
        const hiddenFind = lib.service(lib.OPERATOR, "mantle.work.GitServices.handle#GitReviewThread", {
            operation: "find",
            repositoryId: "sda_plain",
            mergeRequestId: otherId
        })
        return {opened, answered, resolvedOut, againOut, stale, noView, noViewComment, clientFind, clientComment, otherId, mergeRequestId,
            crossResolve, crossReply, hiddenFind, found: thread("find", {}).threadList}
    },
    then({opened, answered, resolvedOut, againOut, stale, noView, noViewComment, clientFind, clientComment, otherId, mergeRequestId,
            crossResolve, crossReply, hiddenFind, found}) {
        clientFind.threadList.length == 0
        clientComment.refused == true
        clientComment.message.trim() == "No merge request " + mergeRequestId
        noViewComment.refused == true
        noViewComment.message.trim() == "No merge request " + mergeRequestId
        noView.threadList == null
        crossResolve.refused == true
        crossResolve.message.includes("not found")
        crossReply.refused == true
        hiddenFind.refused == true
        // the framework's words, which the REST says as the path's number
        hiddenFind.message.trim() == "No merge request " + otherId
        noView.refused == true
        noView.message.trim() == "No merge request " + mergeRequestId
        stale.refused == true
        stale.message.includes("has changed since commit 000000000000")
        opened.threadId != null
        opened.held == false
        answered.threadId == opened.threadId
        againOut.threadId == opened.threadId
        resolvedOut.threadId == opened.threadId
        found.length == 1
        found[0].threadId == opened.threadId
        found[0].path == "plain.txt"
        found[0].resolved == true
        found[0].commentList.map(entry => entry.body) == ["Why one?", "Because.", "Still?"]
        found[0].commentList[0].commentId != null
    }
})
