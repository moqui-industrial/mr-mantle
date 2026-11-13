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
/* What the one check answers a user (an empty userId: no credentials) for an action on a repository. */
const authz = (userId, repositoryId, action) =>
    run("mantle.work.GitServices.check#GitRepositoryAuthz", {
        userId,
        authzActionEnumId: "AUTHZA_" + action,
        artifactTypeEnumId: "AT_GIT_REPOSITORY",
        artifactName: repositoryId
    }).authzTypeEnumId
;({OPERATOR, run, make, row, set, site, account, role, as, op, service, createGroup, createRepository, commit, authz})
