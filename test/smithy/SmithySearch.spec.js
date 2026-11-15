// Smithy's one search box (mr-pass plan/design-smithy.md §13.5, DG7; SmithySite.js searchSite): repositories, groups,
// components, issues, merge requests, docs pages and forum topics, each kept by its own rule before it is shown, so a
// stranger never finds a private repository's items or a confidential issue, which its readers do. Reads SmithyDocs's
// fixture. Regression suite: these are rules. Run: ./moq test mr-mantle --spec SmithySearch
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const ids = {}
const op = (username, operation, input) => lib.op(username, lib.SITE7, operation, input)
const search = (username, input) => op(username, "searchSite", input)
const kinds = out => [...new Set((out.resultList || []).map(row => row.type))].sort().join()
const titles = out => (out.resultList || []).map(row => row.title)
const paths = out => (out.resultList || []).map(row => row.repositoryPath || "")

spec({
    dependsOn: ["SmithyDocs"],
    requires: ["git"],
    setupSpec() {
        login(lib.OPERATOR)
        Object.assign(ids, lib.siteIds())
        // the fixture's accounts posted a moment ago: their next posts are not held to the interval
        for (const name of ["SST_STRANGER", "SST_MAINT"]) lib.settled(lib.SITE7, name)
        const filed = lib.file("SST_STRANGER", lib.SITE7, ids.repositoryId, "Widget search bug")
        if (filed.kind) throw new Error("No issue: " + filed.message)
        const hidden = lib.file("SST_MAINT", lib.SITE7, ids.repositoryId, "Widget secret flaw", {confidential: true})
        if (hidden.kind) throw new Error("No confidential issue: " + hidden.message)
        lib.run("org.moqui.git.GitServices.commit#GitFiles", {
            repositoryId: ids.repositoryId,
            message: "Polish",
            fileMap: {"polish.txt": "polish\n"},
            branch: "main",
            newBranch: "polish"
        })
        const opened = op(lib.OPERATOR, "createMergeRequest", {
            repositoryId: ids.repositoryId,
            sourceRef: "polish",
            title: "Widget polish",
            operationId: "sst-search-mr"
        })
        if (opened.kind) throw new Error("No merge request: " + opened.message)
    }
})

feature("a stranger finds each kind it may see, and no private or confidential item", {
    when() {
        return {widget: search("SST_STRANGER", {query: "widget"}), sst: search("SST_STRANGER", {query: "sst"})}
    },
    then({widget, sst}) {
        kinds(widget) == "docs,issue,mergeRequest,topic"
        titles(widget).includes("Widget search bug (#1)")
        titles(widget).includes("Widget polish (!1)")
        titles(widget).includes("Getting started")
        titles(widget).includes("The widget is out")
        !titles(widget).some(title => title.includes("secret"))
        !paths(widget).includes("sstgroup/secret")
        kinds(sst) == "component,group,repository"
        !paths(sst).includes("sstgroup/secret")
        !titles(sst).some(title => title.includes("secret"))
        widget.resultList.find(row => row.type == "issue").path == "/code/sstgroup/site/-/issues/1"
    }
})

feature("who may read them finds a confidential issue and a private repository's docs; the rules still refuse", {
    when() {
        return {
            issues: search(lib.OPERATOR, {query: "widget", types: "issue"}),
            docs: search(lib.OPERATOR, {query: "widget", types: "docs", repositoryId: ids.secretId}),
            reporter: search("SST_MAINT", {query: "secret flaw", types: "issue"}),
            short: search(null, {query: "w"}).kind,
            scoped: search("SST_STRANGER", {query: "widget", repositoryId: ids.secretId}).kind
        }
    },
    then({issues, docs, reporter, short, scoped}) {
        titles(issues).sort().join() == "Widget search bug (#1),Widget secret flaw (#2)"
        titles(docs).join() == "Hidden widget notes"
        titles(reporter).join() == "Widget secret flaw (#2)"
        short == "Unprocessable"
        scoped == "NotFound"
    }
})
