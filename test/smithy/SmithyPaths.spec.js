// Smithy's path resolver, ref splitter and code reads (mr-pass plan/design-smithy.md §4.4, §7; SmithyCore.js resolvePath
// and splitRefPath, Smithy.js): a path's names are a repository, a group, an account, or a redirect from an old path or
// a GitHub form, looked up in the site and with the rest of the path as typed; what the caller may not view is Not
// Found, a redirect to it too, and so is another site's record by its id or path; a refPath splits at the longest
// branch name, a branch before a tag, else a commit id; and the reads return the repository's real tree, file, history
// and compare through the framework's services after Smithy's check. A repository bound by bind#Repository. Spec-local
// sites, accounts, groups and db repositories. Regression suite: these are rules. Run: ./moq test mr-mantle --spec SmithyPaths
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const SITE = "SMP_SITE"
const OTHER = "SMP_OTHER"
const ids = {}
const resolve = (username, path, siteId = SITE) => lib.op(username, siteId, "resolveSmithyPath", {path})
const read = (operation, input, username = null) => lib.op(username, SITE, operation, {repositoryId: ids.code, ...input})

spec({
    requires: ["git"],
    setupSpec() {
        login(lib.OPERATOR)
        lib.site(SITE)
        lib.site(OTHER)
        lib.account(SITE, "SMP_MEMBER", {handle: "smphandle"})
        lib.account(SITE, "SMP_HIDDEN", {handle: "smphidden", discoverability: "hidden"})
        ids.group = lib.createGroup(lib.OPERATOR, {siteId: SITE, pathSegment: "smpgroup", visibility: "public"}).groupId
        // a hosted repository that is there, bound to the group by an operator
        ids.code = "smp-code"
        lib.make("moqui.resource.GitRepository", {
            repositoryId: ids.code,
            repositoryKind: "db",
            branch: "main",
            description: "Code"
        })
        lib.run("org.moqui.git.GitServices.init#GitRepository", {repositoryId: ids.code})
        ids.bound = lib.service(lib.OPERATOR, "mantle.smithy.SmithyServices.bind#Repository", {
            siteId: SITE,
            repositoryId: ids.code,
            groupId: ids.group,
            slug: "code"
        })
        lib.set("mantle.smithy.SmithyRepository", {repositoryId: ids.code}, {visibilityEnumId: "SmvPublic"})
        ids.secret = lib.createRepository(lib.OPERATOR, {
            siteId: SITE,
            groupId: ids.group,
            slug: "secret",
            visibility: "private"
        }).repositoryId
        ids.first = lib.commit(ids.code, "Start", {
            "README.md": "# Hello\n\n<script>alert(1)</script>\n",
            "src/main.js": "main()\n"
        })
        const ref = (refName, refType) =>
            lib.run("org.moqui.git.GitServices.create#GitRef", {repositoryId: ids.code, refName, refType, revision: ids.first})
        ref("topic/deep", "branch")
        ref("topic", "tag")
        ref("v1", "branch")
        ref("v1", "tag")
        ids.second = lib.commit(ids.code, "Add a helper", {"src/help.js": "help()\n"})
        for (const [oldPath, repositoryId] of [
            ["smpgroup/old", ids.code],
            ["smpgroup/was-secret", ids.secret]
        ])
            lib.make("moqui.resource.GitRepositoryPathRedirect", {oldPath, repositoryId, createdDate: ec.user.nowTimestamp})
        // the other site has a group and a subgroup whose path is the first site's repository's
        ids.otherGroup = lib.createGroup(lib.OPERATOR, {siteId: OTHER, pathSegment: "smpgroup", visibility: "public"}).groupId
        ids.otherSubgroup = lib.createGroup(lib.OPERATOR, {
            siteId: OTHER,
            parentGroupId: ids.otherGroup,
            pathSegment: "code"
        }).groupId
    }
})

feature("a path's names are a repository, a group, an account or a redirect, and what may not be viewed is Not Found", {
    when() {
        return {
            // bound with no visibility said: private, never the group's
            bound: [ids.bound.repositoryPath, lib.row("moqui.resource.GitRepository", {repositoryId: ids.code}).repositoryPath],
            repository: [resolve(null, "SmpGroup/Code"), resolve(null, "smpgroup/code.git")],
            group: resolve(null, "smpgroup"),
            account: resolve(null, "smphandle"),
            // the rest of a path is kept as typed
            moved: [resolve(null, "smpgroup/old"), resolve(null, "SmpGroup/Old/Some/File.MD"), resolve(null, "smpgroup/old.git")],
            github: ["blob/main/README.md", "pull/7", "releases/tag/v1.0"].map(
                rest => resolve(null, "smpgroup/code/" + rest).redirectPath
            ),
            hidden: [
                resolve(null, "smpgroup/secret"),
                resolve(null, "smpgroup/was-secret"),
                resolve(null, "smpgroup/secret/pull/7"),
                resolve(null, "smphidden"),
                lib.op(null, SITE, "findRepositories", {ownerHandle: "smphidden"})
            ],
            absent: [resolve(null, "smpgroup/nothing"), resolve(null, "smpgroup/code/wiki"), resolve(null, "smpgroup.git")],
            shownAccount: lib.op(null, SITE, "findRepositories", {ownerHandle: "smphandle"}).repositoryList,
            operator: resolve(lib.OPERATOR, "smpgroup/was-secret")
        }
    },
    then({bound, repository, group, account, moved, github, hidden, absent, shownAccount, operator}) {
        bound == ["smpgroup/code", "smpgroup/code"]
        repository.map(out => out.kind + " " + out.repositoryId + " " + out.canonicalPath) ==
            ["repository smp-code smpgroup/code", "repository smp-code smpgroup/code"]
        group.kind == "group"
        group.groupId == ids.group
        account.kind == "account"
        account.handle == "smphandle"
        moved.map(out => out.kind + " " + out.redirectPath) ==
            ["redirect smpgroup/code", "redirect smpgroup/code/Some/File.MD", "redirect smpgroup/code"]
        github == ["smpgroup/code/-/blob/main/README.md", "smpgroup/code/-/merge-requests/7", "smpgroup/code/-/releases/v1.0"]
        hidden.map(out => out.kind) == ["NotFound", "NotFound", "NotFound", "NotFound", "NotFound"]
        absent.map(out => out.kind) == ["NotFound", "NotFound", "NotFound"]
        shownAccount == []
        operator.redirectPath == "smpgroup/secret"
    }
})

feature("a record is found only in its own site, by its id and by its path", {
    when() {
        return {
            byId: [
                lib.op(null, OTHER, "getRepository", {repositoryId: ids.code}),
                lib.op(null, OTHER, "getTree", {repositoryId: ids.code}),
                lib.op(null, OTHER, "getGroup", {groupId: ids.group}),
                lib.op(null, OTHER, "findRepositories", {groupId: ids.group})
            ],
            // the other site's own subgroup of that path, and no redirect to the first site's repository
            byPath: [
                resolve(null, "smpgroup/code", OTHER),
                resolve(null, "smpgroup/old", OTHER),
                resolve(null, "smpgroup/code/pull/7", OTHER)
            ],
            own: resolve(null, "smpgroup/code")
        }
    },
    then({byId, byPath, own}) {
        byId.map(out => out.kind) == ["NotFound", "NotFound", "NotFound", "NotFound"]
        byPath[0].kind == "group"
        byPath[0].groupId == ids.otherSubgroup
        byPath[1].kind == "NotFound"
        byPath[2].kind == "NotFound"
        own.repositoryId == ids.code
    }
})

feature("a refPath splits at the longest branch name, a branch before a tag, else a commit id", {
    when() {
        const split = refPath => {
            const out = read("getTree", {refPath})
            return out.kind || [out.ref.kind, out.ref.fullName, out.path].join(" ")
        }
        return {
            root: split(""),
            branch: split("topic/deep/src"),
            tag: split("topic/src"),
            both: split("v1"),
            commit: split(ids.first.slice(0, 8) + "/src"),
            none: [split("nope/src"), split("main/no/such/dir"), split("main/../src")]
        }
    },
    then({root, branch, tag, both, commit, none}) {
        root == "branch refs/heads/main "
        branch == "branch refs/heads/topic/deep src"
        tag == "tag refs/tags/topic src"
        both == "branch refs/heads/v1 "
        commit == "commit " + ids.first + " src"
        none == ["NotFound", "NotFound", "NotFound"]
    }
})

feature("a tree and a file are the repository's own, a README is rendered and cleaned, and a private one is Not Found", {
    when() {
        return {
            tree: read("getTree", {}),
            file: read("getTree", {refPath: "main/src/main.js"}),
            blob: read("getBlob", {refPath: "main/src/main.js"}),
            directory: read("getBlob", {refPath: "main/src"}),
            raw: read("downloadBlob", {refPath: "main/README.md"}),
            blame: read("getBlame", {refPath: "main/README.md"}),
            // a tree as a file: the transport's download, whose location stays with the authority
            archive: lib.as("SMP_MEMBER", () =>
                ec.resource.script("component://mr-mantle/script/PassAuthority.js").handle({
                    siteId: SITE,
                    operation: "downloadArchive",
                    input: {repositoryId: ids.code, refPath: "main", format: "zip"},
                    sessionChecked: true
                })
            ),
            archives: [
                read("downloadArchive", {refPath: "main", format: "zip"}).kind,
                read("downloadArchive", {refPath: "main/src", format: "zip"}, "SMP_MEMBER").kind,
                read("downloadArchive", {refPath: "main", format: "rar"}, "SMP_MEMBER").kind
            ],
            secret: lib.op(null, SITE, "getTree", {repositoryId: ids.secret})
        }
    },
    then({tree, file, blob, directory, raw, blame, archive, archives, secret}) {
        tree.empty == false
        tree.entryList.map(entry => entry.type + " " + entry.path + " " + entry.lfs) == ["dir src false", "file README.md false"]
        tree.entryList[0].lastCommit.summary == "Add a helper"
        tree.lastCommit.commitId == ids.second
        tree.readme.path == "README.md"
        tree.readme.html.includes("<h1")
        !tree.readme.html.includes("<script")
        file.isFile == true
        file.entryList == []
        blob.text == "main()\n"
        blob.size == 7
        blob.binary == false
        blob.language == "javascript"
        blob.blobId.length == 40
        blob.lastCommit.commitId == ids.first
        directory.kind == "NotFound"
        raw.file.filename == "README.md"
        raw.file.mimeType == "text/plain; charset=utf-8"
        raw.text.startsWith("# Hello")
        // each run of lines with its commit, and no address
        blame.text.startsWith("# Hello")
        blame.hunkList.map(hunk => hunk.startLine + " " + hunk.lineCount + " " + hunk.commitId + " " + hunk.summary) ==
            ["1 3 " + ids.first + " Start"]
        JSON.stringify(blame).includes("@") == false
        archive.result.file.filename.endsWith(".zip")
        archive.result.file.size > 0
        archive.result.location == null
        archive.download.location.includes("git-archive")
        archive.download.disposition == "attachment"
        // for a signed-in account, of a whole tree, as a zip or a tar.gz
        archives == ["AuthenticationRequired", "Unprocessable", "Unprocessable"]
        secret.kind == "NotFound"
    }
})

feature("the history, a commit, a compare of two refs and the refs are the repository's own", {
    when() {
        const compare = more => read("getCompare", {base: "topic/deep", head: "main", ...more})
        return {
            log: read("findCommits", {refPath: "main", limit: "1"}),
            path: read("findCommits", {refPath: "main/src/main.js"}),
            commit: read("getCommit", {commitId: ids.second.slice(0, 10)}),
            compare: compare({withDiffs: "true"}),
            merged: compare({checkMergeable: "true"}).mergeable,
            // a side is a branch, a tag or a commit id: no expression, and no ref with a path after it
            sides: [
                compare({head: "main~1"}).kind,
                compare({head: "main/src"}).kind,
                compare({base: ids.first.slice(0, 9)}).aheadBy
            ],
            branches: read("findRefs", {refType: "branch"}),
            names: read("findRefs", {refType: "branch", namesOnly: "true"}),
            repository: read("getRepository", {}),
            unknown: read("getCommit", {commitId: "0123456789"})
        }
    },
    then({log, path, commit, compare, merged, sides, branches, names, repository, unknown}) {
        log.commitList.map(c => c.summary) == ["Add a helper"]
        log.hasMore == true
        // no address is returned, and none is matched to an account
        log.commitList[0].authorEmail == null
        log.commitList[0].authorHandle == null
        path.commitList.map(c => c.commitId) == [ids.first]
        commit.commit.commitId == ids.second
        commit.fileList.map(f => f.status + " " + f.path) == ["added src/help.js"]
        commit.fileDiffList.length == 1
        commit.truncated == false
        compare.aheadBy == 1
        compare.behindBy == 0
        compare.fileList.map(f => f.path) == ["src/help.js"]
        compare.fileDiffList.length == 1
        // a trial merge only when asked
        compare.mergeable == null
        merged == true
        sides == ["NotFound", "NotFound", 1]
        branches.defaultBranch == "main"
        branches.refList.map(r => r.name + " " + r.behindBy) == ["main null", "topic/deep 1", "v1 1"]
        branches.refList[1].protected == false
        names.refList.map(r => r.name + " " + r.behindBy + " " + r.protected) ==
            ["main null null", "topic/deep null null", "v1 null null"]
        repository.cloneUrls.https.endsWith("/git/smpgroup/code.git")
        // Smithy is mounted at /code on this site, so a page's address does not clone
        repository.cloneUrls.page == null
        unknown.kind == "NotFound"
    }
})
