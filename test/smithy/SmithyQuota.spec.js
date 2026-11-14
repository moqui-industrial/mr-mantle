// Quotas (mr-pass plan/design-smithy.md §11 Quotas and SiteSettings, §5.5, §15.3; SmithyManage.js getQuotaUsage, setQuota
// and the limits; SmithyGit.js checkPush and checkLfsUpload, through mantle.smithy.SmithyGitServices): the site's owners
// set a group's and an account's limits, a group's Owner and the account itself read them, and nobody else; a push
// whose pack would take the repository past its limit is refused, by the nearest group's limit, else the site's default
// for a group, and for a personal repository by the account's; Git LFS uploads are held to the namespace's limit. A
// spec has no git client, so the push gate is asked as the pre-receive rule (service/Smithy.gitecas.xml) asks it, with
// the rule's context; the framework's tests push with git. Spec-local site, accounts, groups and db repositories.
// Regression suite: these are rules. Run: ./moq test mr-mantle --spec SmithyQuota
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const SITE = "SQT_SITE"
const ids = {}
const op = (username, operation, input) => lib.op(username, SITE, operation, input)
const push = (repositoryId, packBytes, userId = "SQT_DEVELOPER") => lib.gate("Push", {repositoryId, userId, packBytes})
const refusedFor = problems => problems.map(problem => (/^([a-zA-Z]+): /.exec(problem) || [])[1] || problem)

spec({
    requires: ["git"],
    setupSpec() {
        login(lib.OPERATOR)
        lib.site(SITE)
        lib.account(SITE, "SQT_SITE_OWNER", {member: true, siteRole: "owner"})
        lib.account(SITE, "SQT_OWNER", {handle: "sqtowner"})
        lib.account(SITE, "SQT_DEVELOPER", {handle: "sqtdeveloper"})
        lib.account(SITE, "SQT_PERSON", {handle: "sqtperson"})
        lib.account(SITE, "SQT_SUSPENDED", {handle: "sqtsuspended"})
        lib.sanction(SITE, "SQT_SUSPENDED", "suspend")
        lib.settings(SITE, {groupRepositoryBytes: 5000, groupLfsBytes: 8000, defaultRepositoryBytes: 3000})
        const group = (pathSegment, more = {}) =>
            lib.createGroup(lib.OPERATOR, {siteId: SITE, pathSegment, visibility: "public", ...more}).groupId
        ids.group = group("sqtgroup")
        ids.sub = group("small", {parentGroupId: ids.group})
        ids.code = lib.createRepository(lib.OPERATOR, {
            siteId: SITE,
            groupId: ids.group,
            slug: "code",
            visibility: "public"
        }).repositoryId
        ids.spare = lib.createRepository(lib.OPERATOR, {
            siteId: SITE,
            groupId: ids.group,
            slug: "spare",
            visibility: "public"
        }).repositoryId
        ids.inner = lib.createRepository(lib.OPERATOR, {
            siteId: SITE,
            groupId: ids.sub,
            slug: "inner",
            visibility: "public"
        }).repositoryId
        lib.role(SITE, {groupId: ids.group}, "SQT_OWNER", "SmrOwner")
        lib.role(SITE, {groupId: ids.group}, "SQT_DEVELOPER", "SmrDeveloper")
        ids.personal = op("SQT_PERSON", "createRepository", {
            slug: "mine",
            visibility: "public",
            operationId: "sqt-personal-1"
        }).repositoryId
    }
})

feature("the site's owners set a group's limits, its Owner reads them, and a Developer neither", {
    when() {
        const set = (username, fields) => op(username, "setQuota", {groupId: ids.sub, reason: "A small one", ...fields})
        const read = username => op(username, "getQuotaUsage", {groupId: ids.sub})
        const before = read("SQT_OWNER")
        return {
            before,
            byGroupOwner: set("SQT_OWNER", {maxRepositoryBytes: "1000", expectedRevision: before.revision}),
            bySiteOwner: set("SQT_SITE_OWNER", {maxRepositoryBytes: "1000", expectedRevision: before.revision}),
            stale: set("SQT_SITE_OWNER", {maxRepositoryBytes: "2000", expectedRevision: before.revision}),
            notAGroups: set("SQT_SITE_OWNER", {maxRepositories: "3", expectedRevision: before.revision + 1}),
            after: read("SQT_OWNER"),
            developer: read("SQT_DEVELOPER")
        }
    },
    then({before, byGroupOwner, bySiteOwner, stale, notAGroups, after, developer}) {
        // a subgroup that sets no limit has the site's default for a group
        before.owner == {kind: "group", groupId: ids.sub, groupPath: "sqtgroup/small"}
        before.limits.repositoryBytes == 5000
        before.limits.lfsBytes == 8000
        // a top-level group, with what is below it, holds a bounded count
        before.limits.repositories == 1000
        before.usage.repositories == 1
        byGroupOwner.kind == "Unauthorized"
        byGroupOwner.reason == "accessDenied"
        bySiteOwner.revision == before.revision + 1
        stale.reason == "staleRevision"
        notAGroups.kind == "Unprocessable"
        after.limits.repositoryBytes == 1000
        after.ownLimits.repositoryBytes == 1000
        before.ownLimits.repositoryBytes == null
        after.ownLimits.lfsBytes == null
        developer.reason == "accessDenied"
    }
})

feature("an account reads its own limits, and only the site's owners another's or set them", {
    when() {
        const mine = op("SQT_PERSON", "getQuotaUsage", {})
        return {
            mine,
            others: op("SQT_DEVELOPER", "getQuotaUsage", {handle: "sqtperson"}),
            byItself: op("SQT_PERSON", "setQuota", {handle: "sqtperson", maxRepositories: "50", expectedRevision: 0}),
            set: op("SQT_SITE_OWNER", "setQuota", {
                handle: "sqtperson",
                maxRepositoryBytes: "2000",
                bot: "true",
                expectedRevision: 0
            }),
            after: op("SQT_SITE_OWNER", "getQuotaUsage", {handle: "sqtperson"}),
            // an empty value clears the account's own limit: the site's default again
            cleared: (() => {
                op("SQT_SITE_OWNER", "setQuota", {handle: "sqtperson", maxRepositoryBytes: "", expectedRevision: 1})
                const read = op("SQT_SITE_OWNER", "getQuotaUsage", {handle: "sqtperson"})
                op("SQT_SITE_OWNER", "setQuota", {handle: "sqtperson", maxRepositoryBytes: "2000", expectedRevision: 2})
                return read.ownLimits.repositoryBytes + " " + read.limits.repositoryBytes
            })()
        }
    },
    then({mine, others, byItself, set, after, cleared}) {
        after.ownLimits.repositoryBytes == 2000
        after.ownLimits.repositories == null
        cleared == "null 3000"
        mine.owner == {kind: "account", handle: "sqtperson"}
        mine.limits.repositories == 5
        mine.limits.repositoryBytes == 3000
        mine.usage.repositories == 1
        mine.repositoryList.map(row => row.repositoryPath) == ["sqtperson/mine"]
        others.kind == "Unauthorized"
        others.reason == "accessDenied"
        byItself.reason == "accessDenied"
        set.revision == 1
        after.limits.repositoryBytes == 2000
        after.limits.repositories == 5
        after.bot == true
    }
})

feature("a push whose pack takes the repository past its namespace's limit is refused", {
    when() {
        return {
            // the group sets none: the site's default for a group, 5000
            group: [push(ids.code, 4000), push(ids.code, 6000)],
            // the subgroup's own limit, 1000
            subgroup: [push(ids.inner, 900), push(ids.inner, 1100)],
            // a personal repository: its account's limit, 2000
            personal: [push(ids.personal, 1500, "SQT_PERSON"), push(ids.personal, 2500, "SQT_PERSON")]
        }
    },
    then({group, subgroup, personal}) {
        group[0] == []
        refusedFor(group[1]) == ["quotaExceeded"]
        subgroup[0] == []
        refusedFor(subgroup[1]) == ["quotaExceeded"]
        personal[0] == []
        refusedFor(personal[1]) == ["quotaExceeded"]
    }
})

feature("a Git LFS upload is held to the namespace's limit", {
    when() {
        const upload = (repositoryId, uploadBytes) =>
            lib.gate("LfsUpload", {repositoryId, userId: "SQT_DEVELOPER", uploadBytes, objectCount: 1})
        const under = upload(ids.code, 7000)
        const over = upload(ids.code, 9000)
        const suspended = lib.gate("LfsUpload", {repositoryId: ids.code, userId: "SQT_SUSPENDED", uploadBytes: 10})
        // archived only for this check: an archived repository left in the database shows in other specs' counts
        lib.run("org.moqui.git.GitServices.archive#GitRepository", {repositoryId: ids.spare})
        let archived
        try {
            archived = upload(ids.spare, 10)
        } finally {
            lib.run("org.moqui.git.GitServices.unarchive#GitRepository", {repositoryId: ids.spare})
        }
        return {under, over, suspended, archived}
    },
    then({under, over, suspended, archived}) {
        under == []
        refusedFor(over) == ["quotaExceeded"]
        suspended == ["Your account is suspended on this site"]
        archived.length == 1
        archived[0].includes("archived")
    }
})

feature("what a repository stores counts toward its limit", {
    when() {
        const usage = () => op("SQT_OWNER", "getQuotaUsage", {groupId: ids.sub}).usage.repositoryBytes
        // about 3 KB that does not compress away, in a repository whose limit is 1000 bytes
        lib.commit(ids.inner, "Fill it", {"data.txt": ec.user.randomString(4000)})
        // a row of Smithy's whose hosted repository the framework cannot count
        lib.make("mantle.smithy.SmithyRepository", {
            repositoryId: "sqt_ghost",
            siteId: SITE,
            groupId: ids.group,
            slug: "ghost",
            repositoryPath: "sqtgroup/ghost",
            visibilityEnumId: "SmvPublic",
            revision: 1
        })
        return {
            stored: usage(),
            small: push(ids.inner, 10),
            // a push that adds nothing (deletes only) is taken, so a repository over its limit can be made smaller
            shrink: push(ids.inner, 0),
            unknown: [
                push("sqt_ghost", 10),
                lib.gate("LfsUpload", {repositoryId: ids.code, userId: "SQT_DEVELOPER", uploadBytes: 10})
            ]
        }
    },
    then({stored, small, shrink, unknown}) {
        stored > 1000
        refusedFor(small) == ["quotaExceeded"]
        shrink == []
        // what cannot be read refuses: the repository's own size for a push, its namespace's LFS bytes for an upload
        unknown[0].length == 1
        unknown[0][0].includes("cannot be read")
        unknown[1].length == 1
        unknown[1][0].includes("cannot be read")
    }
})
