// A git repository's issues for a developer's tools (mantle.work.GitServices.get#RepositoryIssues, get#RepositoryIssue
// and create#RepositoryIssue, GitIssues.js; REST gitRepositories/{repositoryId}/issues, the hosting offer's
// tasks.issuesPath and issuePath), as Dev AIDE's task panel and hosting tool read them from a group server (mr-moqui
// plans/design-dev-aide.md 21.6):
// - any repository Smithy does not keep: for a member of a linked project (the update right), the open tasks of general
//   visibility (never a work group's, restricted, confidential or protected People task), by priority, with the linked
//   projects; a new one is a task of a linked project, another project not found; a client contact who only views gets
//   none and files none;
// - a repository Smithy keeps: the issues its rules show, by number, never a confidential one, none while issues are
//   off; only what Smithy shows (never the task's internal description); one by its number, its text its first post; a
//   new one through Smithy's create#Issue (refused an unconfirmed address); a session's key refused, and a session a
//   header login made that sends only its cookie, as PASS refuses them;
// - a caller who may not view a repository is refused as not found; members who are no admin reach the REST.
// New spec, no Groovy original. Run: ./moq test mr-mantle --spec WorkRepositoryIssues
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const GIT = "mantle.work.GitServices"
const PROJECT = "RIQ"
const SITE = "RIQ_SITE"
const ids = {}
let repositoryId, member, outsider, client

const account = (name) => call("mantle.party.PartyServices.create#Account", {firstName: "Issue", lastName: name,
    emailAddress: "riq." + name.toLowerCase() + "@test.com", username: "riq." + name.toLowerCase(), newPassword: "moqui1!!",
    newPasswordVerify: "moqui1!!", loginAfterCreate: false})

spec({
    requires: ["git"],
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        call("mantle.work.ProjectServices.create#Project", {workEffortId: PROJECT, workEffortName: "Issues project"})
        call("mantle.work.ProjectServices.create#Project", {workEffortId: "RIQX", workEffortName: "Unlinked project"})
        repositoryId = call(`${GIT}.create#ProjectRepository`, {workEffortId: PROJECT, repositoryKind: "db"}).repositoryId
        // a member of the project, no admin: its update right is its project role's (check#GitRepositoryAuthz)
        member = account("Member")
        call("create#mantle.work.effort.WorkEffortParty", {workEffortId: PROJECT, partyId: member.partyId, roleTypeId: "Assignee",
            fromDate: ec.user.nowTimestamp})
        // a client contact of a project that shares its repositories: it views the repository, and no more
        client = account("Client")
        call("create#mantle.work.effort.WorkEffortParty", {workEffortId: PROJECT, partyId: client.partyId, roleTypeId: "ClientManager",
            fromDate: ec.user.nowTimestamp})
        call("mantle.work.ProjectServices.store#ProjectSetting", {workEffortId: PROJECT, settingTypeEnumId: "WstShareRepositories", settingValue: "Y"})
        // an account with no role on the project
        outsider = account("Outsider")
        // Smithy's tracker: a public repository with issues on, its accounts confirmed and settled; a private one of the
        // group; one with issues off; an account with no confirmed address
        lib.site(SITE)
        Object.assign(ids, lib.tracker(SITE, "RIQ", "riqtrack"))
        ids.privateId = lib.createRepository(lib.OPERATOR, {siteId: SITE, groupId: ids.groupId, slug: "hidden", visibility: "private"}).repositoryId
        lib.issuesOn(SITE, ids.privateId)
        ids.quietId = lib.createRepository(lib.OPERATOR, {siteId: SITE, groupId: ids.groupId, slug: "quiet", visibility: "public"}).repositoryId
        lib.account(SITE, "RIQ_NEW", {handle: "riqnew", unconfirmed: true})
        ec.artifactExecution.enableAuthz()
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.artifactExecution.enableAuthz()
    }
})

const task = (root, name, more) =>
    call("mantle.work.TaskServices.create#Task", Object.assign({rootWorkEffortId: root, workEffortName: name}, more || {}))
        .workEffortId
// a service call's result and the errors it added, without failing the feature
function attempt(name, parameters) {
    ec.message.pushErrors()
    const out = ec.service.sync().name(name).parameters(parameters).call() || {}
    const errors = ec.message.errorsString
    ec.message.clearErrors()
    ec.message.popErrors()
    return {out, errors}
}
// REST renders as an account, with authorization on: the rights are each account's own
function asAccount(username, work) {
    ec.artifactExecution.enableAuthz()
    try {
        ec.user.internalLoginUser(username)
        return work((path, parameters, method) => screenTest("rest").render("s1/mantle/gitRepositories/" + path, parameters || null, method || "get"))
    } finally {
        ec.user.internalLoginUser("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}

feature("a repository's open issues are its linked projects' open tasks of general visibility, by priority", {
    when() {
        const later = task(PROJECT, "Later", {priority: 8})
        const first = task(PROJECT, "First", {priority: 1})
        task(PROJECT, "Done", {statusId: "WeComplete"})
        task(PROJECT, "The work group's", {visibilityEnumId: "WevWorkGroup"})
        task(PROJECT, "Restricted", {visibilityEnumId: "WevRestricted"})
        task(PROJECT, "Top secret", {visibilityEnumId: "WevConfidential"})
        // an offboarding step of People's: protected
        const kept = task(PROJECT, "Offboarding step")
        ec.entity.makeValue("mantle.humanres.checklist.ChecklistStep").setAll({workEffortId: kept, isProtected: "Y"}).create()
        const general = task(PROJECT, "General", {visibilityEnumId: "WevGeneral", priority: 9})
        task("RIQX", "Elsewhere")
        return {found: call(`${GIT}.get#RepositoryIssues`, {repositoryId, pageSize: 5000}), later, first, general, kept,
            one: call(`${GIT}.get#RepositoryIssue`, {repositoryId, issueId: first}), hidden: attempt(`${GIT}.get#RepositoryIssue`, {repositoryId, issueId: kept})}
    },
    then({found, later, first, general, one, hidden}) {
        Array.from(found.issueList).map(issue => issue.workEffortId) == [first, later, general]
        Array.from(found.issueList)[0].projectName == "Issues project"
        Array.from(found.issueList)[0].issueNumber == null
        Array.from(found.projectList).map(project => project.workEffortId) == [PROJECT]
        found.numbered == false
        one.issue.workEffortName == "First"
        one.issue.rootWorkEffortId == PROJECT
        hidden.errors.includes("not found")
    }
})

feature("Quick create files a task of a linked project; another project is not found", {
    when() {
        const made = call(`${GIT}.create#RepositoryIssue`, {repositoryId, workEffortName: "Filed from the IDE"})
        const misfiled = attempt(`${GIT}.create#RepositoryIssue`, {repositoryId, workEffortName: "Misfiled", rootWorkEffortId: "RIQX"})
        return {made, refused: misfiled.errors}
    },
    then({made, refused}) {
        made.rootWorkEffortId == PROJECT
        made.issueNumber == null
        ec.entity.find("mantle.work.effort.WorkEffort").condition("workEffortId", made.workEffortId).one().workEffortName == "Filed from the IDE"
        refused.includes("Project RIQX not found")
        ec.entity.find("mantle.work.effort.WorkEffort").condition("workEffortName", "Misfiled").count() == 0
    }
})

feature("through the REST a member who is no admin lists and files; a client contact sees no tasks and files none; an outsider is refused", {
    when() {
        const path = repositoryId + "/issues"
        const byMember = asAccount("riq.member", rest => ({listed: rest(path), filed: rest(path, {workEffortName: "From a member"}, "post")}))
        const byClient = asAccount("riq.client", rest => ({listed: rest(path), filed: rest(path, {workEffortName: "From a client"}, "post")}))
        const byOutsider = asAccount("riq.outsider", rest => rest(path))
        return {byMember, byClient, byOutsider}
    },
    then({byMember, byClient, byOutsider}) {
        byMember.listed.status == 200
        byMember.listed.output.includes("Filed from the IDE")
        byMember.filed.status == 200
        ec.entity.find("mantle.work.effort.WorkEffort").condition("workEffortName", "From a member").count() == 1
        // the client views the repository and reads none of its tasks nor its projects
        call("org.moqui.git.GitServices.get#GitRepositoryAccess", {repositoryId, userId: client.userId}).canView == true
        byClient.listed.status == 200
        Array.from(byClient.listed.jsonObject.issueList || []).length == 0
        Array.from(byClient.listed.jsonObject.projectList || []).length == 0
        byClient.filed.status != 200
        ec.entity.find("mantle.work.effort.WorkEffort").condition("workEffortName", "From a client").count() == 0
        // the outsider's own rights, asked as it with authorization on
        call("org.moqui.git.GitServices.get#GitRepositoryAccess", {repositoryId, userId: outsider.userId}).canView == false
        byOutsider.status != 200
        byOutsider.output.includes("not found")
        !byOutsider.output.includes("Filed from the IDE")
    }
})

feature("a repository Smithy keeps lists the issues its rules show, by number, never a confidential one", {
    when() {
        const open = lib.file("RIQ_AUTHOR", SITE, ids.repositoryId, "Totals are wrong")
        lib.settled(SITE, "RIQ_AUTHOR")
        const secret = lib.file("RIQ_AUTHOR", SITE, ids.repositoryId, "A hole", {confidential: true})
        // the task's description as Projects may change it, which Smithy's projection never shows
        const task = ec.entity.find("mantle.work.effort.WorkEffort").condition("workEffortId",
            ec.entity.find("mantle.smithy.SmithyIssue").condition({repositoryId: ids.repositoryId, issueNumber: open.issueNumber}).one().workEffortId).one()
        task.description = "RIQ-INTERNAL-NOTE"
        task.priority = 1
        task.update()
        // its Owner may read the confidential one, and is shown none here
        return lib.as("RIQ_OWNER", () => ({open, secret, found: call(`${GIT}.get#RepositoryIssues`, {repositoryId: ids.repositoryId}),
            one: call(`${GIT}.get#RepositoryIssue`, {repositoryId: ids.repositoryId, issueId: String(open.issueNumber), byNumber: true}),
            hidden: attempt(`${GIT}.get#RepositoryIssue`, {repositoryId: ids.repositoryId, issueId: String(secret.issueNumber), byNumber: true}),
            quiet: call(`${GIT}.get#RepositoryIssues`, {repositoryId: ids.quietId})}))
    },
    then({open, found, one, hidden, quiet}) {
        found.numbered == true
        Array.from(found.issueList).map(issue => issue.workEffortName) == ["Totals are wrong"]
        Array.from(found.issueList)[0].issueNumber == open.issueNumber
        Array.from(found.issueList)[0].workEffortId ==
            ec.entity.find("mantle.smithy.SmithyIssue").condition({repositoryId: ids.repositoryId, issueNumber: open.issueNumber}).one().workEffortId
        // its own project only
        Array.from(found.projectList).map(project => project.workEffortId) == [ids.projectId]
        one.issue.issueNumber == open.issueNumber
        one.issue.workEffortName == "Totals are wrong"
        one.issue.state == "open"
        // its text is its first post as Smithy shows it, never the task's description; no status nor priority
        one.issue.description.includes("The text of Totals are wrong")
        !JSON.stringify(one).includes("RIQ-INTERNAL-NOTE")
        !JSON.stringify(found).includes("RIQ-INTERNAL-NOTE")
        Array.from(found.issueList)[0].priority == null
        Array.from(found.issueList)[0].statusId == null
        Array.from(found.issueList)[0].state == "open"
        hidden.errors.includes("not found")
        // issues off: none, and no error
        Array.from(quiet.issueList).length == 0
        quiet.numbered == true
    }
})

feature("Quick create in a repository Smithy keeps files through Smithy's create#Issue and answers its number and project", {
    when() {
        return lib.as("RIQ_MAINT", () => call(`${GIT}.create#RepositoryIssue`, {repositoryId: ids.repositoryId,
            workEffortName: "Filed through Smithy", operationId: "riq-" + ec.user.randomString(12)}))
    },
    then(made) {
        made.issueNumber > 0
        made.rootWorkEffortId == ids.projectId
        ec.entity.find("mantle.smithy.SmithyIssue").condition({repositoryId: ids.repositoryId, issueNumber: made.issueNumber}).one()
            .workEffortId == made.workEffortId
    }
})

feature("Smithy's refusals hold: a session's key, an unconfirmed address, a stranger to a private repository", {
    when() {
        // a key a session made, as PASS refuses it for every operation
        const bySession = lib.as("RIQ_OWNER", () => {
            const key = ec.user.getLoginKey()
            ec.user.loginUserKey(key)
            return {kind: ec.user.loginKeyKind, listed: attempt(`${GIT}.get#RepositoryIssues`, {repositoryId: ids.repositoryId}),
                filed: attempt(`${GIT}.create#RepositoryIssue`, {repositoryId: ids.repositoryId, workEffortName: "By a session's key"})}
        })
        // a session a header login made, now sending only its cookie: no key this request, and held to the same rule
        const byCookie = lib.as("RIQ_OWNER", () => {
            ec.web.sessionAttributes.put("moquiHeaderLogin", "RIQ_OWNER")
            try {
                return {kind: ec.user.loginKeyKind, listed: attempt(`${GIT}.get#RepositoryIssues`, {repositoryId: ids.repositoryId})}
            } finally {
                ec.web.sessionAttributes.remove("moquiHeaderLogin")
            }
        })
        const unconfirmed = asAccount("RIQ_NEW", rest => rest(ids.repositoryId + "/issues", {workEffortName: "Unconfirmed"}, "post"))
        const stranger = asAccount("RIQ_STRANGER", rest => rest(ids.privateId + "/issues"))
        return {bySession, byCookie, unconfirmed, stranger}
    },
    then({bySession, byCookie, unconfirmed, stranger}) {
        byCookie.kind == null
        byCookie.listed.errors.includes("installed app")
        bySession.kind == "session"
        bySession.listed.errors.includes("installed app")
        bySession.filed.errors.includes("installed app")
        ec.entity.find("mantle.work.effort.WorkEffort").condition("workEffortName", "By a session's key").count() == 0
        unconfirmed.status != 200
        ec.entity.find("mantle.work.effort.WorkEffort").condition("workEffortName", "Unconfirmed").count() == 0
        stranger.status != 200
        stranger.output.includes("not found")
    }
})
