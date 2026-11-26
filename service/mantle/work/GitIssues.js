/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * A git repository's issues for a developer's tools (GitServices.get#RepositoryIssues, get#RepositoryIssue and
 * create#RepositoryIssue; REST gitRepositories/{repositoryId}/issues, the hosting offer's tasks.issuesPath and
 * tasks.issuePath; mr-moqui plans/design-dev-aide.md 21.6). Each is read as the caller may, by the repository's kind:
 * - one Smithy keeps (a SmithyRepository row): through Smithy's issue operations and their rules alone, a confidential
 *   issue never shown, and as PASS has it (design-smithy §5.5, PassAuthority.js) a login key only an installed app's
 *   device key;
 * - any other: for a caller with the update right on it (a member of a linked project, not a client contact who only
 *   views), the tasks of its linked projects of general visibility, never a protected People task.
 * A caller who may not view the repository is told it is not found.
 */
const W = "mantle.work.effort."
const DONE = ["WeComplete", "WeClosed", "WeCancelled"]
const GENERAL = ["WevAllUsers", "WevGeneral"]
function asSystem(work) {
    const was = ec.artifactExecution.disableAuthz()
    try {
        return work()
    } finally {
        if (!was) ec.artifactExecution.enableAuthz()
    }
}
const one = (entity, fields) => asSystem(() => ec.entity.find(entity).condition(fields).one())
const notFound = what => {
    ec.message.addError(ec.resource.expand("${what} not found", "", {what}))
    return null
}
const capped = (size, most) => Math.min(Math.max(Number(size) || most, 1), most)

/* The repository as the caller reaches it: its rights and Smithy's row (or null); null with the error recorded when the
   caller may not view it, or comes by a login key Smithy does not take. */
function reach(repositoryId) {
    const access = ec.service.sync().name("org.moqui.git.GitServices.get#GitRepositoryAccess").parameters({repositoryId}).call()
    if (ec.message.hasError() || !access?.canView) return notFound("Git repository " + repositoryId)
    const smithy = one("mantle.smithy.SmithyRepository", {repositoryId})
    const kind = ec.user.loginKeyKind
    if (smithy && kind && kind !== "device") {
        ec.message.addError("accessDenied: A login key reaches Smithy's issues only as an installed app's; sign in to the site")
        return null
    }
    return {access, smithy}
}
/* The projects the repository is linked to now, first linked first. */
const linkedIds = repositoryId =>
    Array.from(
        new Set(
            asSystem(() =>
                Array.from(
                    ec.entity
                        .find(W + "WorkEffortGitRepository")
                        .condition("repositoryId", repositoryId)
                        .conditionDate("fromDate", "thruDate", null)
                        .orderBy("fromDate")
                        .list()
                )
            ).map(link => link.workEffortId)
        )
    )
/* The projects by id, with their names, in that order. */
function projectsOf(ids) {
    return ids
        .map(workEffortId => one(W + "WorkEffort", {workEffortId}))
        .filter(project => project)
        .map(project => ({workEffortId: project.workEffortId, workEffortName: project.workEffortName || ""}))
}
/* Whether a task is one a member reads here: of a linked project, of general visibility, not a protected People task. */
function readable(task, projectIds) {
    if (!task || task.workEffortTypeEnumId !== "WetTask" || !projectIds.includes(task.rootWorkEffortId)) return false
    if (task.visibilityEnumId && !GENERAL.includes(task.visibilityEnumId)) return false
    return !protectedIds([task.workEffortId]).length
}
const protectedIds = ids =>
    ids.length ? Array.from(ec.resource.script("component://mr-mantle/service/mantle/request/PeopleCases.js").protectedTaskIds(ids)) : []
/* A Smithy issue operation as the caller: its result, or null with Smithy's refusal recorded. */
function smithyOp(name, input) {
    const out = ec.service.sync().name("mantle.smithy.SmithyIssueServices." + name).parameters({input}).call()
    return ec.message.hasError() ? null : out?.result || null
}
/* One issue as the answers have it, from Smithy's view of it (or none) and its task. */
function item(task, issueNumber, title, names) {
    return {
        workEffortId: task?.workEffortId || null,
        issueNumber: issueNumber == null ? null : Number(issueNumber),
        workEffortName: title != null ? title : task?.workEffortName || null,
        statusId: task?.statusId || null,
        priority: task?.priority ?? null,
        rootWorkEffortId: task?.rootWorkEffortId || null,
        projectName: (task && names[task.rootWorkEffortId]) || null
    }
}

/* get#RepositoryIssues: the open issues and the projects they are of. */
function listIssues(p) {
    const empty = {issueList: [], projectList: [], numbered: false}
    const r = reach(p.repositoryId)
    if (!r) return empty
    const limit = capped(p.pageSize, 200)
    if (r.smithy) {
        // its own project only, and nothing of a tracker that is off
        if (r.smithy.issuesEnabled !== "Y") return {...empty, numbered: true}
        const projectList = r.smithy.workEffortId ? projectsOf([r.smithy.workEffortId]) : []
        const names = Object.fromEntries(projectList.map(project => [project.workEffortId, project.workEffortName]))
        const found = smithyOp("find#Issues", {siteId: r.smithy.siteId, repositoryId: p.repositoryId, state: "open", limit: Math.min(limit, 100)})
        if (!found) return {...empty, numbered: true}
        const issueList = []
        for (const view of Array.from(found.issueList || [])) {
            if (view.confidential) continue
            const issue = one("mantle.smithy.SmithyIssue", {repositoryId: p.repositoryId, issueNumber: view.issueNumber})
            if (!issue) continue
            issueList.push(item(one(W + "WorkEffort", {workEffortId: issue.workEffortId}), view.issueNumber, view.title, names))
        }
        return {issueList, projectList, numbered: true}
    }
    // the tasks of the linked projects, and the projects themselves, are their members' to read
    if (!r.access.canUpdate) return empty
    const projectIds = linkedIds(p.repositoryId)
    if (!projectIds.length) return empty
    const projectList = projectsOf(projectIds)
    const names = Object.fromEntries(projectList.map(project => [project.workEffortId, project.workEffortName]))
    const cf = ec.entity.conditionFactory
    const tasks = asSystem(() =>
        Array.from(
            ec.entity
                .find(W + "WorkEffort")
                .condition("rootWorkEffortId", "in", projectIds)
                .condition("workEffortTypeEnumId", "WetTask")
                .condition("statusId", "not-in", DONE)
                .condition(cf.makeCondition("visibilityEnumId", "in", GENERAL, true))
                .orderBy("priority")
                .orderBy("workEffortId")
                .limit(limit)
                .list()
        )
    )
    const hidden = protectedIds(tasks.map(task => task.workEffortId))
    return {
        issueList: tasks.filter(task => !hidden.includes(task.workEffortId)).map(task => item(task, null, null, names)),
        projectList,
        numbered: false
    }
}

/* get#RepositoryIssue: one issue, by its number (byNumber, a Smithy repository's) or its task's id, with its text. */
function getIssue(p) {
    const r = reach(p.repositoryId)
    if (!r) return {}
    const id = String(p.issueId || "").trim()
    if (r.smithy) {
        if (r.smithy.issuesEnabled !== "Y") return notFound("Issue " + id) || {}
        const issueNumber = p.byNumber === true || p.byNumber === "true" ? Number(id) : one("mantle.smithy.SmithyIssue", {repositoryId: p.repositoryId, workEffortId: id})?.issueNumber
        if (!(issueNumber > 0)) return notFound("Issue " + id) || {}
        const got = smithyOp("get#Issue", {siteId: r.smithy.siteId, repositoryId: p.repositoryId, issueNumber})
        if (!got) return {}
        // a confidential issue is its Owners' and its reporter's on Smithy's pages, never a tool's
        if (got.issue?.confidential) return notFound("Issue " + id) || {}
        const issue = one("mantle.smithy.SmithyIssue", {repositoryId: p.repositoryId, issueNumber})
        const task = issue ? one(W + "WorkEffort", {workEffortId: issue.workEffortId}) : null
        return {issue: {...item(task, issueNumber, got.issue?.title, {}), state: got.issue?.state || null, description: task?.description || null}}
    }
    const projectIds = r.access.canUpdate ? linkedIds(p.repositoryId) : []
    const task = projectIds.length ? one(W + "WorkEffort", {workEffortId: id}) : null
    if (!readable(task, projectIds)) return notFound("Issue " + id) || {}
    const names = Object.fromEntries(projectsOf([task.rootWorkEffortId]).map(project => [project.workEffortId, project.workEffortName]))
    return {issue: {...item(task, null, null, names), workEffortTypeEnumId: task.workEffortTypeEnumId, description: task.description || null}}
}

/* create#RepositoryIssue: an issue filed in the repository's tracker. */
function createIssue(p) {
    const r = reach(p.repositoryId)
    if (!r) return {}
    const title = String(p.workEffortName || "").trim()
    if (!title) {
        ec.message.addError(ec.l10n.localize("An issue needs a title"))
        return {}
    }
    if (r.smithy) {
        const made = smithyOp("create#Issue", {
            siteId: r.smithy.siteId,
            repositoryId: p.repositoryId,
            title,
            body: p.description || title,
            operationId: p.operationId || "gitIssue-" + ec.user.userId + "-" + Date.now()
        })
        if (!made?.issueNumber) return {}
        // read after Smithy made it: a tracker's first issue makes its project too
        const issue = one("mantle.smithy.SmithyIssue", {repositoryId: p.repositoryId, issueNumber: made.issueNumber})
        const task = issue ? one(W + "WorkEffort", {workEffortId: issue.workEffortId}) : null
        return {workEffortId: issue?.workEffortId || null, issueNumber: Number(made.issueNumber), rootWorkEffortId: task?.rootWorkEffortId || null}
    }
    // a task of a project is its members' to file: the update right, not the view a client contact has
    if (!r.access.canUpdate) {
        ec.message.addError(ec.resource.expand("You may not file issues in ${repositoryId}", "", {repositoryId: p.repositoryId}))
        return {}
    }
    const linked = linkedIds(p.repositoryId)
    if (p.rootWorkEffortId && !linked.includes(p.rootWorkEffortId)) return notFound("Project " + p.rootWorkEffortId) || {}
    if (!linked.length) return notFound("A project of " + p.repositoryId) || {}
    const rootWorkEffortId = p.rootWorkEffortId || linked[0]
    const made = ec.service
        .sync()
        .name("mantle.work.TaskServices.create#Task")
        .parameters({rootWorkEffortId, workEffortName: title, description: p.description || null})
        .call()
    if (ec.message.hasError() || !made?.workEffortId) return {}
    return {workEffortId: made.workEffortId, issueNumber: null, rootWorkEffortId}
}
;({listIssues, getIssue, createIssue})
