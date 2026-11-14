// Editing a file on its page (mr-pass plan/design-smithy.md §9.5, §15.5; SmithyReviews.js): where a save may go is by role
// and branch rule (the branch for a Developer when the rules allow a direct push, a new branch with a merge request for
// a Developer, a proposal for a viewer without push); the commit's author is the account by its name and address and
// its committer the server; a save from a blob that is no longer the file's is a conflict; a file kept in Git LFS and
// one over the site's limit are not edited here; rename and delete are the same save. Spec-local site, accounts and a
// db repository. Regression suite: these are rules. Run: ./moq test mr-mantle --spec SmithyEdit
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const SITE = "SME_SITE"
const ids = {}
const op = (username, operation, input) => lib.op(username, SITE, operation, {repositoryId: ids.repositoryId, ...input})
const context = (username, refPath, more = {}) => op(username, "getEditContext", {refPath, ...more})
const destinations = found => found.destinationList.map(entry => entry.destination + (entry.default ? "*" : ""))
const save = (username, input) => op(username, "commitFile", {operationId: "sme-save-" + ec.user.randomString(10), ...input})

spec({
    requires: ["git"],
    setupSpec() {
        login(lib.OPERATOR)
        lib.site(SITE)
        for (const name of ["SME_DEV", "SME_STRANGER"]) {
            lib.account(SITE, name, {handle: name.toLowerCase().replace("_", "")})
            lib.settled(SITE, name)
        }
        lib.account(SITE, "SME_UNCONFIRMED", {unconfirmed: true})
        const groupId = lib.createGroup(lib.OPERATOR, {siteId: SITE, pathSegment: "smegroup", visibility: "public"}).groupId
        ids.repositoryId = lib.createRepository(lib.OPERATOR, {siteId: SITE, groupId, slug: "code", visibility: "public"}).repositoryId
        lib.role(SITE, {repositoryId: ids.repositoryId}, "SME_DEV", "SmrDeveloper")
        ids.start = lib.commit(ids.repositoryId, "Start", {
            "README.md": "# Code\n",
            ".gitattributes": "*.bin filter=lfs diff=lfs merge=lfs -text\n"
        })
        lib.run("org.moqui.git.GitServices.create#GitRef", {repositoryId: ids.repositoryId, refName: "open", refType: "branch"})
        lib.run("org.moqui.git.GitServices.store#GitBranchRule", {
            repositoryId: ids.repositoryId,
            refPattern: "main",
            requireMergeRequest: "Y",
            allowForcePush: "N",
            allowDelete: "N"
        })
    }
})

feature("where an edit may be saved is by role and branch rule, the default first", {
    when() {
        const developer = context("SME_DEV", "main/README.md")
        return {
            developer,
            onOpen: context("SME_DEV", "open/README.md"),
            stranger: context("SME_STRANGER", "main/README.md"),
            anonymous: context(null, "main/README.md"),
            unconfirmed: context("SME_UNCONFIRMED", "main/README.md"),
            atCommit: context("SME_DEV", ids.start + "/README.md"),
            added: context("SME_DEV", "open/docs/new.md", {editAction: "create"}),
            absent: context("SME_DEV", "open/nothing.md")
        }
    },
    then({developer, onOpen, stranger, anonymous, unconfirmed, atCommit, added, absent}) {
        developer.editable == true
        developer.text == "# Code\n"
        developer.blobId.length == 40
        developer.protected == true
        // a protected branch changes through a merge request: a new branch is the default
        destinations(developer) == ["newBranch*"]
        developer.suggestedBranch == "smedev-patch-1"
        onOpen.protected == false
        destinations(onOpen) == ["branch*", "newBranch"]
        destinations(stranger) == ["proposal*"]
        destinations(anonymous) == []
        destinations(unconfirmed) == []
        atCommit.editable == false
        atCommit.reason == "notBranch"
        added.editable == true
        added.blobId == null
        absent.kind == "NotFound"
    }
})

feature("a save is one commit by the account: on the branch, on a new branch with a merge request, or as a proposal", {
    when() {
        const blobId = context("SME_DEV", "open/README.md").blobId
        const edit = (username, branch, more = {}) =>
            save(username, {branch, action: "update", path: "README.md", content: "# Code\n\nBy " + username + "\n", baseBlobId: blobId, ...more})
        const direct = edit("SME_DEV", "open", {message: "Say who"})
        const commit = lib.run("org.moqui.git.GitServices.get#GitCommit", {repositoryId: ids.repositoryId, commitId: direct.commitId}).commit
        const refusedDirect = edit("SME_DEV", "main", {destination: "branch"})
        const byBranch = edit("SME_DEV", "main", {message: "Say who on main\n\nWith a reason."})
        lib.settled(SITE, "SME_DEV")
        const proposal = edit("SME_STRANGER", "main")
        const request = number => op(null, "getMergeRequest", {mergeRequestNum: number}).mergeRequest
        return {
            direct,
            commit,
            refusedDirect,
            byBranch,
            proposal,
            strangerBranch: edit("SME_STRANGER", "main", {destination: "newBranch"}),
            unconfirmed: edit("SME_UNCONFIRMED", "main"),
            anonymous: edit(null, "main"),
            first: request(byBranch.mergeRequestNum),
            second: request(proposal.mergeRequestNum),
            // the stale blob: the file on open has changed since
            conflict: edit("SME_DEV", "open"),
            now: context("SME_DEV", "open/README.md")
        }
    },
    then({direct, commit, refusedDirect, byBranch, proposal, strangerBranch, unconfirmed, anonymous, first, second, conflict, now}) {
        direct.destination == "branch"
        direct.branch == "open"
        direct.mergeRequestNum == null
        // the author is the account by its name and its address; the committer is the server
        commit.authorName == "SME_DEV"
        commit.authorEmail == "sme_dev@smithy.test"
        commit.committerEmail != "sme_dev@smithy.test"
        commit.summary == "Say who"
        refusedDirect.reason == "accessDenied"
        byBranch.destination == "newBranch"
        byBranch.branch == "smedev-patch-1"
        first.sourceRef == "smedev-patch-1"
        first.targetRef == "main"
        first.title == "Say who on main"
        first.headCommitId == byBranch.commitId
        proposal.destination == "proposal"
        second.pushedForReview == true
        second.sourceRef == null
        second.author.handle == "smestranger"
        second.title == "Update README.md"
        strangerBranch.reason == "accessDenied"
        unconfirmed.reason == "addressUnconfirmed"
        anonymous.kind == "AuthenticationRequired"
        conflict.kind == "Conflict"
        conflict.reason == "fileChanged"
        now.text == "# Code\n\nBy SME_DEV\n"
    }
})

feature("a file kept in Git LFS and one over the site's limit are not edited here; rename and delete are the same save", {
    when() {
        const lfs = save("SME_DEV", {branch: "open", action: "create", path: "art/big.bin", content: "bytes"})
        lib.settings(SITE, {maxEditBytes: 200})
        const large = save("SME_DEV", {branch: "open", action: "create", path: "large.txt", content: "x".repeat(300)})
        const outside = save("SME_DEV", {branch: "open", action: "create", path: "../outside.txt", content: "x"})
        const inGit = save("SME_DEV", {branch: "open", action: "create", path: ".git/config", content: "x"})
        const control = save("SME_DEV", {branch: "open", action: "create", path: "a\u0001b.txt", content: "x"})
        // a browser sends a textarea's lines with CR LF: the file is kept with its own line endings (LF for a new one)
        const typed = save("SME_DEV", {branch: "open", action: "create", path: "lines.txt", content: "a\r\nb\r\n"})
        const lines = context("SME_DEV", "open/lines.txt")
        // a new file where a file is: the name is taken, unless the caller names the blob it replaces
        const again = save("SME_DEV", {branch: "open", action: "create", path: "lines.txt", content: "c\n"})
        const replaced = save("SME_DEV", {branch: "open", action: "create", path: "lines.txt", content: "c\n", baseBlobId: lines.blobId})
        const blobId = context("SME_DEV", "open/README.md").blobId
        const renamed = save("SME_DEV", {branch: "open", action: "rename", path: "README.md", newPath: "docs/README.md", baseBlobId: blobId})
        const moved = context("SME_DEV", "open/docs/README.md")
        const removed = save("SME_DEV", {branch: "open", action: "delete", path: "docs/README.md", baseBlobId: moved.blobId})
        return {lfs, large, outside, inGit, control, typed, lines, again, replaced, renamed, moved, removed, gone: context("SME_DEV", "open/docs/README.md")}
    },
    then({lfs, large, outside, inGit, control, typed, lines, again, replaced, renamed, moved, removed, gone}) {
        inGit.reason == "notEditable"
        control.reason == "notEditable"
        typed.destination == "branch"
        lines.text == "a\nb\n"
        again.reason == "nameTaken"
        replaced.commitId.length == 40
        lfs.reason == "notEditable"
        large.reason == "notEditable"
        outside.reason == "notEditable"
        renamed.destination == "branch"
        moved.text == "# Code\n\nBy SME_DEV\n"
        removed.commitId.length == 40
        gone.kind == "NotFound"
    }
})

feature("an upload is a staged file of the caller's, of the purpose repositoryFile, committed and then released", {
    when() {
        const location = "runtime://tmp/sme-upload-" + ec.user.randomString(8)
        ec.resource.getLocationReference(location).putText("Uploaded\n")
        const staged = (attachmentId, purpose, ownerPartyId) =>
            lib.make("mantle.forum.ForumAttachment", {
                attachmentId,
                siteId: SITE,
                purpose,
                ownerPartyId,
                location,
                filename: "notes.txt",
                mimeType: "text/plain",
                byteSize: 9,
                scanState: "clean"
            })
        staged("SME_UP_POST", "post", "SME_DEV")
        staged("SME_UP_OTHER", "repositoryFile", "SME_STRANGER")
        staged("SME_UP_FILE", "repositoryFile", "SME_DEV")
        const upload = attachmentId => save("SME_DEV", {branch: "open", action: "upload", path: "docs/notes.txt", attachmentId})
        const stage = (username, repositoryId) =>
            lib.op(username, SITE, "stageAttachment", {purpose: "repositoryFile", repositoryId, file: {name: "a.txt", size: 3, contentType: "text/x-anything"}})
        const private_ = lib.createRepository(lib.OPERATOR, {
            siteId: SITE,
            groupId: lib.row("mantle.smithy.SmithyRepository", {repositoryId: ids.repositoryId}).groupId,
            slug: "inner",
            visibility: "private"
        }).repositoryId
        return {
            aPost: upload("SME_UP_POST"),
            another: upload("SME_UP_OTHER"),
            done: upload("SME_UP_FILE"),
            file: context("SME_DEV", "open/docs/notes.txt").text,
            released: lib.row("mantle.forum.ForumAttachment", {attachmentId: "SME_UP_FILE"}),
            unseen: stage("SME_STRANGER", private_),
            unconfirmed: stage("SME_UNCONFIRMED", ids.repositoryId),
            large: lib.op("SME_STRANGER", SITE, "stageAttachment", {
                purpose: "repositoryFile",
                repositoryId: ids.repositoryId,
                file: {name: "a.bin", size: 5000, contentType: "application/octet-stream"}
            })
        }
    },
    then({aPost, another, done, file, released, unseen, unconfirmed, large}) {
        aPost.kind == "Unprocessable"
        another.kind == "Unprocessable"
        done.destination == "branch"
        file == "Uploaded\n"
        released == null
        // who may stage one: a confirmed viewer of the repository, within the site's limit for an edit (200 bytes here)
        unseen.kind == "NotFound"
        unconfirmed.reason == "addressUnconfirmed"
        large.kind == "Unprocessable"
    }
})
