// The current user's open tasks (mantle.work.TaskServices.get#MyTasks, and the REST API's my/tasks): those assigned to
// their party, not complete, closed or cancelled, by priority, with each one's project name; another project's narrowed
// by rootWorkEffortId. What a developer's tools read as "my tasks", such as Dev AIDE's task panel on another instance.
// New spec, no Groovy original.
const TASK = "mantle.work.TaskServices"
const PROJECT = "mantle.work.ProjectServices"

spec({
    setupSpec() {
        login("john.doe")
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.artifactExecution.enableAuthz()
    }
})

feature("my open tasks, by priority, with their project", {
    when() {
        const me = ec.user.userAccount.partyId
        call(`${PROJECT}.create#Project`, {workEffortId: "PMT", workEffortName: "My tasks project"})
        call(`${PROJECT}.create#Project`, {workEffortId: "PMX", workEffortName: "Another project"})
        const task = (root, name, more) =>
            call(
                `${TASK}.create#Task`,
                Object.assign({rootWorkEffortId: root, workEffortName: name, assignToPartyId: me}, more || {})
            ).workEffortId
        const later = task("PMT", "Later", {priority: 8})
        const first = task("PMT", "First", {priority: 1})
        task("PMT", "Done", {statusId: "WeComplete"})
        task("PMT", "Not mine", {assignToPartyId: null})
        const other = task("PMX", "Elsewhere", {priority: 5})
        return {
            mine: call(`${TASK}.get#MyTasks`, {}),
            only: call(`${TASK}.get#MyTasks`, {rootWorkEffortId: "PMX"}),
            later,
            first,
            other
        }
    },
    then({mine, only, later, first, other}) {
        const ids = Array.from(mine.taskList)
            .map(task => task.workEffortId)
            .filter(id => [later, first, other].includes(id))
        ids == [first, other, later]
        Array.from(mine.taskList).every(task => task.workEffortName != "Done" && task.workEffortName != "Not mine")
        Array.from(mine.taskList).find(task => task.workEffortId == first).projectName == "My tasks project"
        Array.from(only.taskList).map(task => task.workEffortId) == [other]
    }
})
