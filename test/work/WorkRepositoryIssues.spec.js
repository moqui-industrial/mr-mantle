// A git repository's open issues and Quick create there (mantle.work.GitServices.get#RepositoryIssues and
// create#RepositoryIssue, REST gitRepositories/{repositoryId}/issues, the hosting offer's tasks.issuesPath), as Dev
// AIDE's task panel reads them from a group server (mr-moqui plans/design-dev-aide.md 21.6): the open tasks of the
// projects the repository is linked to, by priority, with the linked projects; a repository with no Smithy row has no
// numbers; a new issue is a task of a linked project, and of no other; a caller who may not view the repository is
// refused. New spec, no Groovy original. Run: ./moq test mr-mantle --spec WorkRepositoryIssues
const GIT = "mantle.work.GitServices"
const PROJECT = "RIQ"
let repositoryId

spec({
    requires: ["git"],
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        call("mantle.work.ProjectServices.create#Project", {workEffortId: PROJECT, workEffortName: "Issues project"})
        call("mantle.work.ProjectServices.create#Project", {workEffortId: "RIQX", workEffortName: "Unlinked project"})
        repositoryId = call(`${GIT}.create#ProjectRepository`, {workEffortId: PROJECT, repositoryKind: "db"}).repositoryId
        // an account with no role on the project, which may call the service (as a REST caller may) and nothing below it
        ec.entity.makeValue("moqui.security.UserAccount").setAll({userId: "RIQ_OUTSIDER", username: "riq.outsider",
            userFullName: "RIQ Outsider", emailAddress: "riq.outsider@example.com"}).create()
        ec.entity.makeValue("moqui.security.UserGroup").setAll({userGroupId: "RIQ_SPEC", description: "Repository issues spec"}).create()
        ec.entity.makeValue("moqui.security.UserGroupMember").setAll({userGroupId: "RIQ_SPEC", userId: "RIQ_OUTSIDER", fromDate: ec.user.nowTimestamp}).create()
        ec.entity.makeValue("moqui.security.ArtifactGroup").setAll({artifactGroupId: "RIQ_SPEC", description: "Repository issues spec"}).create()
        for (const artifactName of [`${GIT}.get#RepositoryIssues`, "org.moqui.git.GitServices.get#GitRepositoryAccess"])
            ec.entity.makeValue("moqui.security.ArtifactGroupMember").setAll({artifactGroupId: "RIQ_SPEC", artifactName,
                artifactTypeEnumId: "AT_SERVICE", inheritAuthz: "N"}).create()
        ec.entity.makeValue("moqui.security.ArtifactAuthz").setAll({artifactAuthzId: "RIQ_SPEC", userGroupId: "RIQ_SPEC", artifactGroupId: "RIQ_SPEC",
            authzTypeEnumId: "AUTHZT_ALLOW", authzActionEnumId: "AUTHZA_ALL"}).create()
        ec.artifactExecution.enableAuthz()
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.artifactExecution.enableAuthz()
    },
    cleanupSpec() {
        ec.artifactExecution.disableAuthz()
        for (const [entity, field] of [["moqui.security.ArtifactAuthz", "artifactAuthzId"], ["moqui.security.ArtifactGroupMember", "artifactGroupId"],
                ["moqui.security.ArtifactGroup", "artifactGroupId"], ["moqui.security.UserGroupMember", "userGroupId"], ["moqui.security.UserGroup", "userGroupId"]])
            ec.entity.find(entity).condition(field, "RIQ_SPEC").deleteAll()
        ec.entity.find("moqui.security.UserAccount").condition("userId", "RIQ_OUTSIDER").deleteAll()
        ec.artifactExecution.enableAuthz()
    }
})

const task = (root, name, more) =>
    call("mantle.work.TaskServices.create#Task", Object.assign({rootWorkEffortId: root, workEffortName: name}, more || {}))
        .workEffortId

feature("a repository's open issues are its linked projects' open tasks, by priority", {
    when() {
        const later = task(PROJECT, "Later", {priority: 8})
        const first = task(PROJECT, "First", {priority: 1})
        task(PROJECT, "Done", {statusId: "WeComplete"})
        task("RIQX", "Elsewhere")
        return {found: call(`${GIT}.get#RepositoryIssues`, {repositoryId}), later, first}
    },
    then({found, later, first}) {
        !ec.message.hasError()
        Array.from(found.issueList).map(issue => issue.workEffortId) == [first, later]
        Array.from(found.issueList)[0].projectName == "Issues project"
        Array.from(found.issueList)[0].issueNumber == null
        Array.from(found.projectList).map(project => project.workEffortId) == [PROJECT]
        found.numbered == false
    }
})

feature("Quick create files a task of a linked project, and of no other", {
    when() {
        const made = call(`${GIT}.create#RepositoryIssue`, {repositoryId, workEffortName: "Filed from the IDE"})
        ec.message.pushErrors()
        ec.service.sync().name(`${GIT}.create#RepositoryIssue`)
            .parameters({repositoryId, workEffortName: "Misfiled", rootWorkEffortId: "RIQX"}).call()
        const refused = ec.message.errorsString
        ec.message.clearErrors()
        ec.message.popErrors()
        return {made, refused}
    },
    then({made, refused}) {
        made.rootWorkEffortId == PROJECT
        ec.entity.find("mantle.work.effort.WorkEffort").condition("workEffortId", made.workEffortId).one().workEffortName == "Filed from the IDE"
        refused.includes("is not linked to")
        ec.entity.find("mantle.work.effort.WorkEffort").condition("workEffortName", "Misfiled").count() == 0
    }
})

feature("a caller who may not view the repository is refused", {
    when() {
        // the repository's rights are the account's own: with authorization on
        ec.artifactExecution.enableAuthz()
        ec.user.internalLoginUser("riq.outsider")
        ec.message.pushErrors()
        const found = ec.service.sync().name(`${GIT}.get#RepositoryIssues`).parameters({repositoryId}).call() || {}
        const refused = ec.message.errorsString
        ec.message.clearErrors()
        ec.message.popErrors()
        ec.user.internalLoginUser("john.doe")
        return {found, refused}
    },
    then({found, refused}) {
        refused.includes("not found")
        Array.from(found.issueList || []).length == 0
    }
})
