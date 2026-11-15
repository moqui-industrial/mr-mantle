/* The Smithy specs' shared helpers: a published site with a Smithy mount, accounts made as rows (a party, an account
 * whose password is moqui, and as asked a confirmed address, a site membership and a handle), and calls as a user or as
 * no user: an operation through the PASS authority (script/PassAuthority.js), as a page's call arrives, and a service.
 * The operator is john.doe. Each spec has its own prefix, so the specs do not share records. CC0 plus patent grant. */
const OPERATOR = "john.doe"
const run = (name, parameters) => {
    const out = ec.service.sync().name(name).parameters(parameters).disableAuthz().call() || {}
    if (ec.message.hasError()) {
        const text = ec.message.getErrorsString()
        ec.message.clearErrors()
        throw new Error(text)
    }
    return out
}
const make = (entity, fields) => run("create#" + entity, fields)
/* Work with authorization off, as a service that checked its caller reads and writes (a file's content). */
function privileged(work) {
    const was = ec.artifactExecution.disableAuthz()
    try {
        return work()
    } finally {
        if (!was) ec.artifactExecution.enableAuthz()
    }
}
const row = (entity, fields) => ec.entity.find(entity).condition(fields).disableAuthz().one()
function set(entity, key, fields) {
    const value = row(entity, key)
    for (const [name, field] of Object.entries(fields)) value.set(name, field)
    const was = ec.artifactExecution.disableAuthz()
    try {
        value.update()
    } finally {
        if (!was) ec.artifactExecution.enableAuthz()
    }
}
/* A published site whose Smithy is mounted at /code, with Forum at /forum. */
function site(siteId) {
    make("mantle.public.PublicSite", {
        siteId,
        name: siteId,
        state: "published",
        registrationMode: "closed",
        locale: "en",
        timeZone: "UTC",
        policyRevision: 1,
        generation: 1
    })
    make("mantle.public.PublicSiteApp", {siteId, appMountId: siteId + "_S", app: "smithy", pathPrefix: "/code", enabled: "Y"})
    make("mantle.public.PublicSiteApp", {siteId, appMountId: siteId + "_F", app: "forum", pathPrefix: "/forum", enabled: "Y"})
    return siteId
}
/* An account: options.member (an active member of the site, with options.siteRole), options.handle (a profile, public
   unless options.discoverability), options.unconfirmed (no confirmed address), options.internal (in a user group of
   its own besides ALL_USERS, as a BOSS user is). Its username, userId and partyId are the id. */
function account(siteId, id, options = {}) {
    const emailAddress = id.toLowerCase() + "@smithy.test"
    make("mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    make("mantle.party.Person", {partyId: id, firstName: "Smithy", lastName: id})
    make("moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId: id,
        emailAddress,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA"
    })
    if (!options.unconfirmed)
        make("moqui.security.public.VerifiedAddress", {userId: id, emailAddress, verifiedAt: ec.user.nowTimestamp})
    if (options.member || options.handle)
        make("mantle.public.PublicSiteParty", {
            siteId,
            partyId: id,
            state: "active",
            role: options.siteRole || "member",
            joinedAt: ec.user.nowTimestamp,
            fromDate: ec.user.nowTimestamp,
            revision: 1
        })
    if (options.handle)
        make("mantle.public.PublicSiteProfile", {
            siteId,
            partyId: id,
            handle: options.handle,
            displayName: id,
            discoverability: options.discoverability || "public",
            revision: 1
        })
    if (options.internal) {
        make("moqui.security.UserGroup", {userGroupId: id, description: "Smithy spec " + id})
        make("moqui.security.UserGroupMember", {
            userId: id,
            userGroupId: id,
            fromDate: ec.user.timestampMillis(ec.user.nowTimestamp) - 1000
        })
    }
    return id
}
/* A role row on a group (groupId) or a repository (repositoryId). */
function role(siteId, target, partyId, roleEnumId, more = {}) {
    make("mantle.smithy." + (target.groupId ? "SmithyGroupParty" : "SmithyRepositoryParty"), {
        ...target,
        partyId,
        siteId,
        roleEnumId,
        fromDate: ec.user.timestampMillis(ec.user.nowTimestamp) - 1000,
        revision: 1,
        ...more
    })
}
/* Work as a user (null: no user), then the operator again. */
function as(username, work) {
    if (username) ec.user.loginUser(username, "moqui")
    else ec.user.logoutUser()
    try {
        return work()
    } finally {
        ec.message.clearErrors()
        ec.user.loginUser(OPERATOR, "moqui")
    }
}
/* An operation as a user through the PASS authority: its result, or the refusal's kind ("NotFound") and reason. */
function op(username, siteId, operation, input = {}) {
    return as(username, () => {
        const out = ec.resource
            .script("component://mr-mantle/script/PassAuthority.js")
            .handle({siteId, operation, input, sessionChecked: true})
        return out.error ? {kind: out.error.code, reason: out.error.reason, message: out.error.message} : out.result
    })
}
/* A service as a user: its out-parameters, or the refusal's reason (the code before the colon) and text. */
function service(username, name, parameters) {
    return as(username, () => {
        try {
            // the rule under test is the service's own; the artifact grant of a service is its app's
            const out = ec.service.sync().name(name).parameters(parameters).disableAuthz().call() || {}
            if (!ec.message.hasError()) return out
            return refusal(ec.message.getErrorsString())
        } catch (error) {
            return refusal(String(error.message || error))
        }
    })
}
function refusal(message) {
    const text = message.replace(/^(?:Error: )+/, "")
    return {refused: true, reason: (/^([a-zA-Z]+)(?:\[[A-Za-z.]+\])?: /.exec(text) || [])[1] || "", message: text}
}
const createGroup = (username, parameters) => service(username, "mantle.smithy.SmithyServices.create#Group", parameters)
const createRepository = (username, parameters) =>
    service(username, "mantle.smithy.SmithyServices.create#Repository", {repositoryKind: "db", ...parameters})
/* A commit of files on the default branch of a repository, as the operator. */
const commit = (repositoryId, message, fileMap) =>
    run("org.moqui.git.GitServices.commit#GitFiles", {repositoryId, message, fileMap}).commitId
/* The rules of a change (the gitECA post events: a commit's links, its keywords) run on the git pool after it commits:
   waits until the repository's updates are done, running here any that are left pending. */
function settle(repositoryId) {
    const started = Date.now()
    while (Date.now() - started < 20000) {
        const busy = ec.entity
            .find("moqui.resource.GitUpdate")
            .condition("repositoryId", repositoryId)
            .condition("ecaStatus", "in", ["recording", "pending", "running"])
            .disableAuthz()
            .count()
        if (busy == 0) return
        run("org.moqui.git.GitServices.process#PendingGitUpdates", {})
    }
    throw new Error("the git updates did not settle")
}
/* What the one check answers a user (an empty userId: no credentials) for an action on a repository. */
const authz = (userId, repositoryId, action) =>
    run("mantle.work.GitServices.check#GitRepositoryAuthz", {
        userId,
        authzActionEnumId: "AUTHZA_" + action,
        artifactTypeEnumId: "AT_GIT_REPOSITORY",
        artifactName: repositoryId
    }).authzTypeEnumId
/* A site's Smithy settings row (SmithySite), made with these fields or changed to them. */
function settings(siteId, fields) {
    if (row("mantle.smithy.SmithySite", {siteId})) set("mantle.smithy.SmithySite", {siteId}, fields)
    else make("mantle.smithy.SmithySite", {siteId, revision: 1, ...fields})
}
/* A sanction of the forum on a party in a site: kind suspend or silence. */
const sanction = (siteId, partyId, kind) =>
    make("mantle.forum.ForumSanction", {
        sanctionId: siteId + "_" + partyId + "_" + kind,
        siteId,
        partyId,
        kind,
        fromDate: ec.user.timestampMillis(ec.user.nowTimestamp) - 1000,
        revision: 1
    })
/* What the push gate (the pre-receive rule's service) or the LFS upload check says of a push by a user: the errors that
   refuse it, none when it is accepted. */
function gate(name, parameters) {
    ec.service
        .sync()
        .name("mantle.smithy.SmithyGitServices.check#" + name)
        .parameters(parameters)
        .disableAuthz()
        .call()
    const problems = Array.from(ec.message.errors || []).map(String)
    ec.message.clearErrors()
    return problems
}
/* An account as one whose first posts are past: its forum state in the site with approved contributions and no post
   just made, so the gate neither holds its post as a first one nor asks it to wait between two. */
function settled(siteId, partyId) {
    const key = {siteId, partyId}
    const fields = {trustLevel: "basic", approvedContributions: 5, lastPostedAt: null, dayKey: null, dailyCounts: null}
    if (row("mantle.forum.ForumMemberState", key)) set("mantle.forum.ForumMemberState", key, fields)
    else make("mantle.forum.ForumMemberState", {...key, ...fields, dailyTopics: 0, dailyReplies: 0, revision: 1})
}
/* A tracker for the issue specs: a public group with a public db repository whose issues are on, made by the operator,
   and accounts named <prefix>_OWNER (Owner of the group), _MAINT (Maintainer), _REPORTER (Reporter), _AUTHOR and
   _STRANGER (no role), each with a confirmed address, a handle (the id in lower case, without the underscore) and
   settled. Gives {groupId, repositoryId, projectId}. */
function tracker(siteId, prefix, path) {
    const who = name => prefix + "_" + name
    for (const name of ["OWNER", "MAINT", "REPORTER", "AUTHOR", "STRANGER"]) {
        account(siteId, who(name), {handle: who(name).toLowerCase().replace("_", "")})
        settled(siteId, who(name))
    }
    const groupId = createGroup(OPERATOR, {siteId, pathSegment: path, visibility: "public"}).groupId
    const repositoryId = createRepository(OPERATOR, {siteId, groupId, slug: "code", visibility: "public"}).repositoryId
    role(siteId, {groupId}, who("OWNER"), "SmrOwner")
    role(siteId, {groupId}, who("MAINT"), "SmrMaintainer")
    role(siteId, {groupId}, who("REPORTER"), "SmrReporter")
    return {groupId, repositoryId, projectId: issuesOn(siteId, repositoryId)}
}
/* Turns a repository's issues on, as the operator; gives its project. */
function issuesOn(siteId, repositoryId) {
    const revision = op(OPERATOR, siteId, "getRepository", {repositoryId}).repository.revision
    const out = op(OPERATOR, siteId, "updateRepository", {repositoryId, issuesEnabled: true, expectedRevision: revision})
    if (out.kind) throw new Error("Issues not turned on: " + out.message)
    return row("mantle.smithy.SmithyRepository", {repositoryId}).workEffortId
}
/* Files an issue as a user: createIssue's result, or its refusal. */
const file = (username, siteId, repositoryId, title, more = {}) =>
    op(username, siteId, "createIssue", {
        repositoryId,
        title,
        body: "The text of " + title,
        operationId: "file-" + ec.user.randomString(12),
        ...more
    })
/* A comment on an issue as a user, through the forum's publishPost: its result, or its refusal. */
const comment = (username, siteId, rootCommEventId, body, more = {}) =>
    op(username, siteId, "publishPost", {rootCommEventId, body, operationId: "note-" + ec.user.randomString(12), ...more})
/* The site specs' fixture (DG7; SmithyDocs makes it, and SmithyReleases, SmithyComponents, SmithySearch and
   SmithyRedirects name SmithyDocs in dependsOn and read it with siteIds): the site SST_SITE with the canonical host
   sst.smithy.test; accounts SST_MAINT (Maintainer of the group), SST_STRANGER (no role) and SST_OWNER (the site's owner);
   the public group sstgroup with a public repository site (docs and issues on; component.xml sst-site 1.2.0 depending on
   mr-mantle; docs/README.md, docs/guide/intro.md with a script tag, landing.md; the tag v1.2.0) and a private repository
   secret (docs on; component.xml sst-secret); a public category news with a topic about a widget. */
const SITE7 = "SST_SITE"
const SITE7_HOST = "sst.smithy.test"
function turnOn(siteId, repositoryId, fields) {
    const revision = op(OPERATOR, siteId, "getRepository", {repositoryId}).repository.revision
    const out = op(OPERATOR, siteId, "updateRepository", {repositoryId, ...fields, expectedRevision: revision})
    if (out.kind) throw new Error("Repository not changed: " + out.message)
}
function siteFixture() {
    site(SITE7)
    make("mantle.public.PublicSiteHost", {hostname: SITE7_HOST, siteId: SITE7, canonical: "Y"})
    for (const name of ["SST_MAINT", "SST_STRANGER"]) {
        account(SITE7, name, {handle: name.toLowerCase().replace("_", "")})
        settled(SITE7, name)
    }
    account(SITE7, "SST_OWNER", {handle: "sstowner", siteRole: "owner"})
    const groupId = createGroup(OPERATOR, {siteId: SITE7, pathSegment: "sstgroup", visibility: "public"}).groupId
    role(SITE7, {groupId}, "SST_MAINT", "SmrMaintainer")
    const siteId = createRepository(OPERATOR, {siteId: SITE7, groupId, slug: "site", visibility: "public"}).repositoryId
    const secretId = createRepository(OPERATOR, {siteId: SITE7, groupId, slug: "secret", visibility: "private"}).repositoryId
    turnOn(SITE7, siteId, {docsEnabled: true})
    issuesOn(SITE7, siteId)
    turnOn(SITE7, secretId, {docsEnabled: true})
    commit(siteId, "Start", {
        "README.md": "# Site\n",
        "component.xml":
            '<?xml version="1.0"?>\n<component name="sst-site" version="1.2.0">\n    <depends-on name="mr-mantle"/>\n</component>\n',
        "docs/README.md": "# Site docs\n\nSee [the guide](guide/intro.md).\n",
        "docs/guide/intro.md": "# Getting started\n\nThe widget handbook.\n\n<script>alert(1)</script>\n\n## Getting started\n",
        "landing.md": "# Welcome\n\nHello from the site.<script>alert(2)</script>\n"
    })
    commit(secretId, "Start", {
        "component.xml": '<component name="sst-secret" version="0.1"/>\n',
        "docs/README.md": "# Hidden widget notes\n"
    })
    run("org.moqui.git.GitServices.create#GitRef", {repositoryId: siteId, refName: "v1.2.0", refType: "tag"})
    settle(siteId)
    settle(secretId)
    const news = make("mantle.marketing.contact.ContactList", {
        contactListTypeEnumId: "MAILBOX",
        contactListName: "News",
        isPublic: "N",
        postingEnumId: "ClpAnyUser"
    }).contactListId
    make("mantle.forum.ForumCategory", {
        contactListId: news,
        siteId: SITE7,
        slug: news,
        sequenceNum: 0,
        publicationState: "published",
        visibility: "public",
        mode: "discussion",
        policyRevision: 1
    })
    const posted = op("SST_MAINT", SITE7, "publishPost", {
        contactListId: news,
        title: "The widget is out",
        body: "A new widget for everyone",
        operationId: "sst-news-" + ec.user.randomString(12)
    })
    if (posted.kind) throw new Error("No topic: " + posted.message)
    return siteIds()
}
function siteIds() {
    const group = row("mantle.smithy.SmithyGroup", {siteId: SITE7, groupPath: "sstgroup"})
    return {
        siteId: SITE7,
        groupId: group.groupId,
        repositoryId: row("mantle.smithy.SmithyRepository", {repositoryPath: "sstgroup/site"}).repositoryId,
        secretId: row("mantle.smithy.SmithyRepository", {repositoryPath: "sstgroup/secret"}).repositoryId,
        newsId: Array.from(ec.entity.find("mantle.forum.ForumCategory").condition({siteId: SITE7}).disableAuthz().list())
            .map(category => category.contactListId)
            .find(id => row("mantle.marketing.contact.ContactList", {contactListId: id})?.contactListName === "News")
    }
}
;({
    privileged,
    SITE7,
    SITE7_HOST,
    siteFixture,
    siteIds,
    settled,
    settle,
    tracker,
    issuesOn,
    file,
    comment,
    OPERATOR,
    run,
    make,
    row,
    set,
    site,
    account,
    role,
    as,
    op,
    service,
    createGroup,
    createRepository,
    commit,
    authz,
    settings,
    sanction,
    gate
})
