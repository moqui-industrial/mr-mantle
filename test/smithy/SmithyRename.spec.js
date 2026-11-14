// Rename, transfer and the redirects they leave (mr-pass plan/design-smithy.md §4.3, §15.3; SmithyManage.js
// renameRepository, renameGroup, transferRepository; SmithyCore.js setPath, pathHeld, keepRedirect, handleChanged and
// resolvePath): a renamed repository's path changes for git and the pages and its old path redirects; a renamed group
// takes its subgroups and repositories with it and its old path redirects; an old path is free at once for its own
// party and after 90 days for another, and the redirect ends when the path is taken; a transfer needs the Owner role
// and Maintainer of the target and narrows the visibility; a changed handle moves its namespace. Spec-local site,
// accounts, groups and db repositories. Regression suite: these are rules. Run: ./moq test mr-mantle --spec SmithyRename
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const SITE = "SRN_SITE"
const ids = {}
const op = (username, operation, input) => lib.op(username, SITE, operation, input)
const resolve = (path, username = "SRN_OWNER") => {
    const found = op(username, "resolveSmithyPath", {path})
    return found.kind + " " + (found.canonicalPath || found.redirectPath || "")
}
const revision = repositoryId => Number(lib.row("mantle.smithy.SmithyRepository", {repositoryId}).revision)
const groupRevision = groupId => Number(lib.row("mantle.smithy.SmithyGroup", {groupId}).revision)
const gitPath = repositoryId => lib.row("moqui.resource.GitRepository", {repositoryId}).repositoryPath
const group = (pathSegment, more = {}) =>
    lib.createGroup(lib.OPERATOR, {siteId: SITE, pathSegment, visibility: "public", ...more}).groupId
const repository = (groupId, slug, visibility = "public") =>
    lib.createRepository(lib.OPERATOR, {siteId: SITE, groupId, slug, visibility}).repositoryId

spec({
    requires: ["git"],
    setupSpec() {
        login(lib.OPERATOR)
        lib.site(SITE)
        lib.settings(SITE, {groupCreateEnumId: "ScpVerified", repositoryCreateEnumId: "ScpVerified"})
        lib.account(SITE, "SRN_OWNER", {handle: "srnowner"})
        lib.account(SITE, "SRN_MAINTAINER", {handle: "srnmaintainer"})
        lib.account(SITE, "SRN_OTHER", {handle: "srnother"})
        lib.account(SITE, "SRN_MOVER", {handle: "srnmover"})
        ids.group = group("srngroup")
        ids.sub = group("tools", {parentGroupId: ids.group})
        ids.code = repository(ids.group, "code")
        ids.deep = repository(ids.sub, "deep")
        ids.target = group("srntarget", {visibility: "private"})
        ids.closed = group("srnclosed", {visibility: "private"})
        lib.role(SITE, {groupId: ids.group}, "SRN_OWNER", "SmrOwner")
        lib.role(SITE, {groupId: ids.group}, "SRN_MAINTAINER", "SmrMaintainer")
        lib.role(SITE, {groupId: ids.target}, "SRN_OWNER", "SmrMaintainer")
        lib.role(SITE, {groupId: ids.target}, "SRN_MAINTAINER", "SmrGuest")
    }
})

feature("an Owner renames a repository: its path changes, the old one redirects, and its Owners alone take the old name back", {
    when() {
        const rename = (username, slug) =>
            op(username, "renameRepository", {repositoryId: ids.code, slug, expectedRevision: revision(ids.code)})
        const create = (username, slug, operationId) => op(username, "createRepository", {groupId: ids.group, slug, operationId})
        const maintainer = rename("SRN_MAINTAINER", "engine")
        const renamed = rename("SRN_OWNER", "engine")
        return {
            maintainer,
            renamed,
            taken: rename("SRN_OWNER", "tools"),
            stored: gitPath(ids.code),
            old: resolve("srngroup/code/-/tree/main"),
            // the old name still redirects: a Maintainer of the group, who is no Owner, does not take it
            held: create("SRN_MAINTAINER", "code", "srn-create-code-1"),
            // its Owner takes it back at once, and the redirect from it ends
            back: rename("SRN_OWNER", "code"),
            after: resolve("srngroup/code")
        }
    },
    then({maintainer, renamed, taken, stored, old, held, back, after}) {
        maintainer.kind == "Unauthorized"
        maintainer.reason == "accessDenied"
        renamed.repositoryPath == "srngroup/engine"
        // a subgroup has that name
        taken.reason == "nameTaken"
        stored == "srngroup/engine"
        old == "redirect srngroup/engine/-/tree/main"
        held.reason == "nameTaken"
        back.repositoryPath == "srngroup/code"
        after == "repository srngroup/code"
    }
})

feature("a renamed group takes its subgroups and repositories with it, and its old path redirects", {
    when() {
        const rename = (username, pathSegment) =>
            op(username, "renameGroup", {groupId: ids.group, pathSegment, expectedRevision: groupRevision(ids.group)})
        const maintainer = rename("SRN_MAINTAINER", "srnmoved")
        const renamed = rename("SRN_OWNER", "srnmoved")
        return {
            maintainer,
            renamed,
            handle: rename("SRN_OWNER", "srnother"),
            subgroup: lib.row("mantle.smithy.SmithyGroup", {groupId: ids.sub}).groupPath,
            repositories: [gitPath(ids.code), gitPath(ids.deep)],
            oldGroup: resolve("srngroup"),
            oldSubgroup: resolve("srngroup/tools"),
            oldRepository: resolve("srngroup/tools/deep"),
            now: resolve("srnmoved/tools/deep")
        }
    },
    then({maintainer, renamed, handle, subgroup, repositories, oldGroup, oldSubgroup, oldRepository, now}) {
        maintainer.reason == "accessDenied"
        renamed.groupPath == "srnmoved"
        // a handle of the site is in the same set of names
        handle.reason == "nameTaken"
        subgroup == "srnmoved/tools"
        repositories == ["srnmoved/code", "srnmoved/tools/deep"]
        oldGroup == "redirect srnmoved"
        oldSubgroup == "redirect srnmoved/tools"
        oldRepository == "redirect srnmoved/tools/deep"
        now == "repository srnmoved/tools/deep"
    }
})

feature("an old path is another party's to take after 90 days, and the redirect ends when it is taken", {
    when() {
        const request = operationId =>
            op("SRN_OTHER", "requestGroup", {pathSegment: "srngroup", visibility: "public", operationId})
        const early = request("srn-retake-1")
        // the redirect is 91 days old
        lib.set(
            "mantle.smithy.SmithyPathRedirect",
            {siteId: SITE, oldPath: "srngroup"},
            {createdAt: ec.user.timestampMillis(ec.user.nowTimestamp) - 91 * 86400000}
        )
        const late = request("srn-retake-2")
        return {
            early,
            late,
            redirect: lib.row("mantle.smithy.SmithyPathRedirect", {siteId: SITE, oldPath: "srngroup"}),
            now: resolve("srngroup"),
            // the group that moved is where it is
            moved: resolve("srnmoved")
        }
    },
    then({early, late, redirect, now, moved}) {
        early.kind == "Unprocessable"
        early.reason == "nameTaken"
        late.status == "active"
        redirect == null
        now == "group srngroup"
        moved == "group srnmoved"
    }
})

feature("a transfer needs the Owner role and Maintainer of the target, and narrows the visibility to the target's", {
    when() {
        const transfer = (username, targetGroupId) =>
            op(username, "transferRepository", {repositoryId: ids.code, targetGroupId, expectedRevision: revision(ids.code)})
        return {
            // an Owner's to do: a Maintainer of the repository is refused
            maintainer: transfer("SRN_MAINTAINER", ids.target),
            // a target the Owner may not view is Not Found, as a group that is not there
            closed: transfer("SRN_OWNER", ids.closed),
            moved: transfer("SRN_OWNER", ids.target),
            stored: gitPath(ids.code),
            old: resolve("srnmoved/code"),
            // in the target it holds only what the target gives: a Maintainer there is no Owner of it
            again: transfer("SRN_OWNER", ids.group)
        }
    },
    then({maintainer, closed, moved, stored, old, again}) {
        maintainer.reason == "accessDenied"
        closed.kind == "NotFound"
        moved.repositoryPath == "srntarget/code"
        // it was public, and its new group is private
        moved.visibility == "private"
        stored == "srntarget/code"
        old == "redirect srntarget/code"
        again.reason == "accessDenied"
    }
})

feature("a changed handle moves its namespace, and the old handle redirects", {
    when() {
        const made = op("SRN_MOVER", "createRepository", {slug: "notes", visibility: "public", operationId: "srn-handle-1"})
        const profile = op("SRN_MOVER", "storeProfile", {handle: "srnmoved2", discoverability: "public", expectedRevision: 1})
        return {
            made,
            profile,
            stored: gitPath(made.repositoryId),
            oldHandle: resolve("srnmover"),
            oldRepository: resolve("srnmover/notes"),
            // the old handle is its account's alone for 90 days
            taken: op("SRN_OTHER", "storeProfile", {handle: "srnmover", discoverability: "public", expectedRevision: 1})
        }
    },
    then({made, profile, stored, oldHandle, oldRepository, taken}) {
        made.repositoryPath == "srnmover/notes"
        profile.profile.handle == "srnmoved2"
        stored == "srnmoved2/notes"
        oldHandle == "redirect srnmoved2"
        oldRepository == "redirect srnmoved2/notes"
        taken.kind == "Conflict"
    }
})

feature("a repository moves into its Owner's namespace by the site's policy, within the account's count and size", {
    when() {
        const take = () => op("SRN_OWNER", "transferRepository", {repositoryId: ids.deep, expectedRevision: revision(ids.deep)})
        const account = fields => {
            if (lib.row("mantle.smithy.SmithyAccount", {siteId: SITE, partyId: "SRN_OWNER"}))
                lib.set("mantle.smithy.SmithyAccount", {siteId: SITE, partyId: "SRN_OWNER"}, fields)
            else lib.make("mantle.smithy.SmithyAccount", {siteId: SITE, partyId: "SRN_OWNER", revision: 1, ...fields})
        }
        lib.commit(ids.deep, "Start", {"README.md": "# Deep\n"})
        lib.settings(SITE, {repositoryCreateEnumId: "ScpOperators"})
        const policy = take()
        lib.settings(SITE, {repositoryCreateEnumId: "ScpVerified"})
        account({maxRepositories: 0})
        const count = take()
        account({maxRepositories: 5, maxRepositoryBytes: 1})
        const size = take()
        account({maxRepositoryBytes: null})
        // its issues are tasks of the project its group shares
        lib.set("mantle.smithy.SmithyGroup", {groupId: ids.sub}, {workEffortId: "SRN_PROJECT"})
        lib.set("mantle.smithy.SmithyRepository", {repositoryId: ids.deep}, {workEffortId: "SRN_PROJECT"})
        const shared = take()
        lib.set("mantle.smithy.SmithyRepository", {repositoryId: ids.deep}, {workEffortId: null})
        return {
            policy,
            count,
            size,
            shared,
            moved: take(),
            role: op("SRN_OWNER", "getRepository", {repositoryId: ids.deep}).myRole
        }
    },
    then({policy, count, size, shared, moved, role}) {
        policy.reason == "policyRefused"
        count.reason == "quotaExceeded"
        size.reason == "quotaExceeded"
        shared.kind == "Conflict"
        moved.repositoryPath == "srnowner/deep"
        role == "owner"
    }
})

feature("an Owner makes a subgroup and deletes an empty group with its path typed", {
    when() {
        const make = (username, operationId) =>
            op(username, "createSubgroup", {groupId: ids.group, pathSegment: "docs", name: "Docs", operationId})
        const maintainer = make("SRN_MAINTAINER", "srn-subgroup-1")
        const made = make("SRN_OWNER", "srn-subgroup-2")
        const remove = (username, groupId, confirmPath) =>
            op(username, "deleteGroup", {groupId, confirmPath, expectedRevision: groupRevision(groupId)})
        return {
            maintainer,
            made,
            // a subgroup's Owners are its group's
            role: op("SRN_OWNER", "getGroup", {groupId: made.groupId}).myRole,
            taken: op("SRN_OWNER", "createSubgroup", {groupId: ids.group, pathSegment: "code", operationId: "srn-subgroup-3"}),
            // the group has a subgroup: it is not deleted
            busy: remove("SRN_OWNER", ids.group, "srnmoved"),
            mistyped: remove("SRN_OWNER", made.groupId, "srnmoved/doc"),
            byMaintainer: remove("SRN_MAINTAINER", made.groupId, "srnmoved/docs"),
            deleted: remove("SRN_OWNER", made.groupId, "srnmoved/docs"),
            after: resolve("srnmoved/docs", "SRN_OWNER")
        }
    },
    then({maintainer, made, role, taken, busy, mistyped, byMaintainer, deleted, after}) {
        maintainer.reason == "accessDenied"
        made.groupPath == "srnmoved/docs"
        role == "owner"
        busy.kind == "Conflict"
        mistyped.kind == "Unprocessable"
        byMaintainer.reason == "accessDenied"
        deleted.deleted == true
        after.startsWith("NotFound")
    }
})

feature("the old path of a repository that is not Smithy's is nobody's to take, an operator's neither", {
    when() {
        // a Projects-only repository that had a path under a group's name and moved away
        lib.make("moqui.resource.GitRepository", {repositoryId: "srn_plain", repositoryKind: "db", branch: "main"})
        lib.run("org.moqui.git.GitServices.init#GitRepository", {repositoryId: "srn_plain"})
        for (const repositoryPath of ["srntarget/Plain", "srnelsewhere/plain"])
            lib.run("org.moqui.git.GitServices.set#GitRepositoryPath", {repositoryId: "srn_plain", repositoryPath})
        return {
            held: lib.createRepository(lib.OPERATOR, {siteId: SITE, groupId: ids.target, slug: "plain"}),
            free: lib.createRepository(lib.OPERATOR, {siteId: SITE, groupId: ids.target, slug: "plainer"})
        }
    },
    then({held, free}) {
        held.reason == "nameTaken"
        free.repositoryPath == "srntarget/plainer"
    }
})
