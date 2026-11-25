// A git repository's open issues and Quick create there (mantle.work.GitServices.get#RepositoryIssues and
// create#RepositoryIssue, REST gitRepositories/{repositoryId}/issues, the hosting offer's tasks.issuesPath), as Dev
// AIDE's task panel reads them from a group server (mr-moqui plans/design-dev-aide.md 21.6):
// - a repository Smithy keeps: the issues the caller may read by Smithy's rules, by number, a confidential one left
//   out, numbered; a new one filed through Smithy's create#Issue;
// - any other: for a member of a linked project (the update right), the open tasks of general visibility, by
//   priority, with the linked projects, no numbers; a new one is a task of a linked project; a project that is not
//   linked is not found;
// - a caller who may not view the repository is refused as not found; a member who is no admin reaches the REST.
// New spec, no Groovy original. Run: ./moq test mr-mantle --spec WorkRepositoryIssues
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const GIT = "mantle.work.GitServices"
const PROJECT = "RIQ"
const SITE = "RIQ_SITE"
const ids = {}
let repositoryId, member, outsider

spec({
    requires: ["git"],
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        call("mantle.work.ProjectServices.create#Project", {workEffortId: PROJECT, workEffortName: "Issues project"})
        call("mantle.work.ProjectServices.create#Project", {workEffortId: "RIQX", workEffortName: "Unlinked project"})
        repositoryId = call(`${GIT}.create#ProjectRepository`, {workEffortId: PROJECT, repositoryKind: "db"}).repositoryId
        // a member of the project, no admin: its update right is its project role's (check#GitRepositoryAuthz)
        member = call("mantle.party.PartyServices.create#Account", {firstName: "Issue", lastName: "Member",
            emailAddress: "riq.member@test.com", username: "riq.member", newPassword: "moqui1!!", newPasswordVerify: "moqui1!!",
            loginAfterCreate: false})
        call("create#mantle.work.effort.WorkEffortParty", {workEffortId: PROJECT, partyId: member.partyId, roleTypeId: "Assignee",
            fromDate: ec.user.nowTimestamp})
        // an account with no role on the project
        outsider = call("mantle.party.PartyServices.create#Account", {firstName: "Issue", lastName: "Outsider",
            emailAddress: "riq.outsider@test.com", username: "riq.outsider", newPassword: "moqui1!!", newPasswordVerify: "moqui1!!",
            loginAfterCreate: false})
        // Smithy's tracker: a public repository with issues on, its accounts confirmed and settled
        lib.site(SITE)
        Object.assign(ids, lib.tracker(SITE, "RIQ", "riqtrack"))
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

feature("a repository's open issues are its linked projects' open tasks of general visibility, by priority", {
    when() {
        const later = task(PROJECT, "Later", {priority: 8})
        const first = task(PROJECT, "First", {priority: 1})
        task(PROJECT, "Done", {statusId: "WeComplete"})
        task(PROJECT, "The work group's", {visibilityEnumId: "WevWorkGroup"})
        task(PROJECT, "Restricted", {visibilityEnumId: "WevRestricted"})
        const general = task(PROJECT, "General", {visibilityEnumId: "WevGeneral", priority: 9})
        task("RIQX", "Elsewhere")
        return {found: call(`${GIT}.get#RepositoryIssues`, {repositoryId, pageSize: 5000}), later, first, general}
    },
    then({found, later, first, general}) {
        !ec.message.hasError()
        Array.from(found.issueList).map(issue => issue.workEffortId) == [first, later, general]
        Array.from(found.issueList)[0].projectName == "Issues project"
        Array.from(found.issueList)[0].issueNumber == null
        Array.from(found.projectList).map(project => project.workEffortId) == [PROJECT]
        found.numbered == false
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

feature("a member who is no admin lists and files through the REST; an outsider may not view and is refused", {
    when() {
        const path = "s1/mantle/gitRepositories/" + repositoryId + "/issues"
        // the rights are each account's own: with authorization on
        ec.artifactExecution.enableAuthz()
        try {
            ec.user.internalLoginUser("riq.member")
            const listed = screenTest("rest").render(path, null, "get")
            const filed = screenTest("rest").render(path, {workEffortName: "From a member"}, "post")
            ec.user.internalLoginUser("riq.outsider")
            const refused = screenTest("rest").render(path, null, "get")
            return {listed, filed, refused}
        } finally {
            ec.user.internalLoginUser("john.doe")
            ec.artifactExecution.disableAuthz()
        }
    },
    then({listed, filed, refused}) {
        listed.status == 200
        listed.output.includes("Filed from the IDE")
        filed.status == 200
        ec.entity.find("mantle.work.effort.WorkEffort").condition("workEffortName", "From a member").count() == 1
        // the outsider's own rights, asked as it with authorization on
        call("org.moqui.git.GitServices.get#GitRepositoryAccess", {repositoryId, userId: outsider.userId}).canView == false
        refused.status != 200
        refused.output.includes("not found")
        !refused.output.includes("Filed from the IDE")
    }
})

feature("a repository Smithy keeps lists the issues its rules show, by number, never a confidential one", {
    when() {
        const open = lib.file("RIQ_AUTHOR", SITE, ids.repositoryId, "Totals are wrong")
        lib.settled(SITE, "RIQ_AUTHOR")
        lib.file("RIQ_AUTHOR", SITE, ids.repositoryId, "A hole", {confidential: true})
        // its Owner may read the confidential one, and is shown none here
        return {open, found: lib.as("RIQ_OWNER", () => call(`${GIT}.get#RepositoryIssues`, {repositoryId: ids.repositoryId}))}
    },
    then({open, found}) {
        found.numbered == true
        Array.from(found.issueList).map(issue => issue.workEffortName) == ["Totals are wrong"]
        Array.from(found.issueList)[0].issueNumber == open.issueNumber
        Array.from(found.issueList)[0].workEffortId ==
            ec.entity.find("mantle.smithy.SmithyIssue").condition({repositoryId: ids.repositoryId, issueNumber: open.issueNumber}).one().workEffortId
    }
})

feature("Quick create in a repository Smithy keeps files through Smithy's create#Issue and answers its number", {
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
