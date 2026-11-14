/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * What the framework's hosting REST asks Smithy (mr-moqui docs/interfaces/Git-Hosting.md, REST; plans/design-dev-aide.md
 * §21), so a client such as the Dev AIDE finds Smithy's REST for the repositories it keeps: the write check
 * (git-server rest-write-check-service, check#GitRestWrite), the offer (offer-service, add#GitHostingOffer) and the
 * agreement check (agreement-check-service, check#GitAuthorSigned). Each is asked with authorization off and reads as
 * the system; none gives one account's data to another.
 */
const S = "mantle.public."
const REPOSITORY = "mantle.smithy.SmithyRepository"
const publicApps = () => ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
const text = value => (value == null ? "" : String(value))
function asSystem(work) {
    const was = ec.artifactExecution.disableAuthz()
    try {
        return work()
    } finally {
        if (!was) ec.artifactExecution.enableAuthz()
    }
}
const one = (entity, fields) => asSystem(() => ec.entity.find(entity).condition(fields).one())
const list = (entity, fields) => asSystem(() => Array.from(ec.entity.find(entity).condition(fields).list()))
/* The path of Smithy's PASS REST on a site, the base its routes (script/PassRoutes.js, smithy/...) are under. */
const restPath = siteId => "/rest/s1/pass/v1/sites/" + encodeURIComponent(siteId) + "/smithy"
/* The site's canonical host that serves pages (never a theme preview host), or null. */
function canonicalHost(siteId) {
    const host = one(S + "PublicSiteHost", {siteId, canonical: "Y"})
    return host && !publicApps().isPreviewHost(host) ? host.hostname : null
}
/* Smithy's REST for a site: on its canonical host when it has one, else the path on this server. */
function restUrl(siteId) {
    const host = canonicalHost(siteId)
    return (host ? "https://" + host : "") + restPath(siteId)
}
/* Whether a site is published and mounts Smithy. */
const serves = siteId =>
    !!siteId && one(S + "PublicSite", {siteId})?.state === "published" && !!publicApps().mount(siteId, "smithy")

/* check#GitRestWrite: a repository Smithy keeps (a SmithyRepository row) is changed through Smithy's REST, with its
   roles, confirmed address, gate and conversation, never through the framework's: every write is refused there, with
   Smithy's REST named; a read is allowed and says who keeps it. Any other repository is not Smithy's to answer. */
function restWrite(p) {
    const repo = p?.repositoryId ? one(REPOSITORY, {repositoryId: p.repositoryId}) : null
    if (!repo) return {allowed: true, message: null, application: null, restUrl: null}
    const url = restUrl(repo.siteId)
    // a read, and an outside CI's commit status: the framework needs the push right for a status and refuses the
    // contexts Smithy reserves (agreement/, ci/: git-server reserved-status-contexts), as design-smithy §5.5 has it
    if (p.operation === "read" || p.operation === "commitStatus.create")
        return {allowed: true, message: null, application: "smithy", restUrl: url}
    const smithyOperation = SMITHY_OPERATIONS[p.operation]
    return {
        allowed: false,
        message:
            "Smithy keeps " +
            text(repo.repositoryPath || repo.repositoryId) +
            ": make this change through Smithy's REST" +
            (smithyOperation ? " (" + smithyOperation + ")" : ""),
        application: "smithy",
        restUrl: url
    }
}
/* Smithy's operation for each write of the framework's REST that it keeps (its roles, gate and conversation hold there):
   a refusal names it. */
const SMITHY_OPERATIONS = {
    "ref.create": "createRef",
    "ref.delete": "deleteRef",
    "mergeRequest.create": "createMergeRequest",
    "mergeRequest.update": "updateMergeRequest",
    "mergeRequest.close": "setMergeRequestState",
    "mergeRequest.reopen": "setMergeRequestState",
    "mergeRequest.reviewers": "setMergeRequestReviewers",
    "mergeRequest.review": "submitReview",
    "mergeRequest.comment": "createReviewComment",
    "mergeRequest.resolveThread": "resolveReviewThread",
    "mergeRequest.merge": "mergeMergeRequest",
    "pipeline.run": "runPipeline",
    "pipeline.rerun": "rerunPipelineRun",
    "pipeline.cancel": "cancelPipelineRun",
    "pipeline.approve": "approvePipelineRun",
    "job.retry": "retryJobRun"
}

/* The site whose Smithy a client of this server reaches: the site of the host the request came to, else of this server's
   own address (the offer's baseUrl), else the one published site that mounts Smithy; null when none is, or several are
   and no host names one. */
function offeredSite(offer) {
    const hosts = []
    try {
        const requestHost = text(ec.web?.getHostName(false))
        if (requestHost) hosts.push(requestHost)
    } catch (error) {
        // no request: a job or a spec asks with the offer alone
    }
    const base = /^https?:\/\/([^/:?#]+)/i.exec(text(offer?.baseUrl))
    if (base) hosts.push(base[1])
    for (const hostname of hosts.map(host => host.toLowerCase().replace(/\.$/, ""))) {
        const host = one(S + "PublicSiteHost", {hostname})
        if (host && !publicApps().isPreviewHost(host) && serves(host.siteId)) return host.siteId
    }
    const mounted = list(S + "PublicSiteApp", {app: "smithy", enabled: "Y"})
        .map(row => row.siteId)
        .filter((siteId, index, all) => all.indexOf(siteId) === index && serves(siteId))
    return mounted.length === 1 ? mounted[0] : null
}
/* add#GitHostingOffer: the framework's offer with Smithy's REST for the site a client reaches (application: name,
   restBase, the path on this host; siteId; pageUrl, the Smithy pages' address), forks (Smithy makes them: forkRepository),
   and Mantle's task source (the moqui-rest source of the user's work items, docs/Run-Deploy.md). It names no account. */
function hostingOffer(p) {
    const offer = Object.assign({}, p?.offer || {})
    const siteId = offeredSite(offer)
    if (siteId) {
        offer.application = {
            name: "smithy",
            restBase: restPath(siteId),
            siteId,
            pageUrl: publicApps().pageUrl(siteId, "smithy", "") || null
        }
        offer.forks = true
    }
    if (!offer.tasks) offer.tasks = {kind: "moqui-rest", path: "/rest/s1/mantle/my/tasks"}
    return offer
}

/* What each word of get#AuthorSigned's missing means. */
const MISSING = {
    copyright: "a line in the copyright list",
    patent: "a line in the patent list",
    copyrightNotOwn: "a copyright line added by a commit of the account",
    patentNotOwn: "a patent line added by a commit of the account",
    eitherNotOwn: "lines added by a commit of the account",
    account: "an account here with this address",
    fileInvalid: "an agreement file Smithy can read"
}
/* check#GitAuthorSigned over Smithy's get#AuthorSigned, for a repository Smithy keeps (known false for any other):
   whether the author has signed the agreement file at the default branch, what is missing, and where to sign (the
   file's edit page on the default branch, on the site's canonical host when it has one). */
function authorSignedCheck(p) {
    const repo = p?.repositoryId ? one(REPOSITORY, {repositoryId: p.repositoryId}) : null
    if (!repo) return {known: false}
    const answer = ec.resource
        .script("component://mr-mantle/service/mantle/smithy/Smithy.js")
        .authorSigned({repositoryId: repo.repositoryId, userId: p.authorUserId || null, emailAddress: p.authorEmail || null})
    if (!answer.known) return {known: false}
    const path = text(answer.agreementPath) || "AUTHORS.md"
    const branch = text(one("moqui.resource.GitRepository", {repositoryId: repo.repositoryId})?.branch) || "main"
    const encoded = value => value.split("/").map(encodeURIComponent).join("/")
    const page = "/" + repo.repositoryPath + "/-/edit/" + encoded(branch) + "/" + encoded(path)
    const missing = Array.from(answer.missing || [], String)
    // what is missing tells whether an address is a member's confirmed one: it is the author's own to read, or a
    // Maintainer's of the repository; anyone else learns signed or not
    const core = ec.resource.script("component://mr-mantle/service/mantle/smithy/SmithyCore.js")
    const own = !!ec.user.userId && p.authorUserId === ec.user.userId && !p.authorEmail
    const detail =
        own || (!!ec.user.userId && core.repositoryRights(repo, core.actor()).rank >= core.RANK.SmrMaintainer)
    return {
        known: true,
        required: answer.required === true,
        signed: answer.signed === true,
        message: answer.signed
            ? null
            : detail
              ? "Not signed in " + path + ": missing " + missing.map(word => MISSING[word] || word).join(", ")
              : "Not signed in " + path,
        // an absolute https page on the site's own canonical host, or none (a client takes no other address)
        signUrl: publicApps().pageUrl(repo.siteId, "smithy", page) || null
    }
}
;({restWrite, hostingOffer, authorSignedCheck, restUrl, restPath})
