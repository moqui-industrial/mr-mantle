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
;({
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
