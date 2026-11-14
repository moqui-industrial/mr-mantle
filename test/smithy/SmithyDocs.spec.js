// Smithy's Docs and a group's landing page (mr-pass plan/design-smithy.md §13.1, §13.2, DG7; SmithySite.js): a page of the
// docs directory at a branch and at a tag, with its headings' stable anchors and the table of contents from the tree; a
// path outside the docs directory and a private repository's docs are Not Found; the landing text is a Markdown file of a
// repository, rendered and cleaned, and one narrower than the group is refused. This spec makes the site specs' fixture
// (SmithySpecLib.siteFixture), which SmithyReleases, SmithyComponents, SmithySearch and SmithyRedirects read. Regression
// suite: these are rules. Run: ./moq test mr-mantle --spec SmithyDocs
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const ids = {}
const op = (username, operation, input) => lib.op(username, lib.SITE7, operation, input)
const docs = (username, repositoryId, refPath) => op(username, "getDocsPage", {repositoryId, refPath})

spec({
    requires: ["git"],
    setupSpec() {
        login(lib.OPERATOR)
        Object.assign(ids, lib.siteFixture())
    }
})

feature("a docs page at a branch and at a tag: the page cleaned, its anchors, the contents and its edit page", {
    when() {
        return {page: docs(null, ids.repositoryId, "main/guide/intro.md"), tagged: docs(null, ids.repositoryId, "v1.2.0")}
    },
    then({page, tagged}) {
        page.title == "Getting started"
        page.path == "guide/intro.md"
        page.ref.kind == "branch"
        page.html.includes('<h1 id="h-getting-started">')
        // a second heading of the same text has its own anchor
        page.headingList.map(heading => heading.anchor).join() == "h-getting-started,h-getting-started-1"
        !page.html.includes("<script")
        page.tocList.map(entry => entry.path + ":" + entry.depth).join() == "README.md:0,null:1,guide/intro.md:2"
        page.editPath == "/code/sstgroup/site/-/edit/main/docs/guide/intro.md"
        page.refList.some(ref => ref.kind == "tag" && ref.name == "v1.2.0")
        tagged.ref.kind == "tag"
        tagged.path == "README.md"
        tagged.title == "Site docs"
        tagged.editPath == null
    }
})

feature("a path outside the docs directory, a file that is not there and a private repository's docs are Not Found", {
    when() {
        return {
            outside: docs(null, ids.repositoryId, "main/../README.md").kind,
            absent: docs(null, ids.repositoryId, "main/guide/missing.md").kind,
            stranger: docs("SST_STRANGER", ids.secretId, "").kind,
            nobody: docs(null, ids.secretId, "").kind,
            operator: docs(lib.OPERATOR, ids.secretId, "").title
        }
    },
    then({outside, absent, stranger, nobody, operator}) {
        outside == "NotFound"
        absent == "NotFound"
        stranger == "NotFound"
        nobody == "NotFound"
        operator == "Hidden widget notes"
    }
})

feature("a group's landing text is a repository's Markdown file, rendered and cleaned; a private one is refused", {
    when() {
        const revision = op(lib.OPERATOR, "getGroup", {groupId: ids.groupId}).group.revision
        const narrower = op(lib.OPERATOR, "setGroupLanding", {
            groupId: ids.groupId,
            landingRepositoryPath: "sstgroup/secret",
            landingPath: "docs/README.md",
            expectedRevision: revision
        })
        const byMaintainer = op("SST_MAINT", "setGroupLanding", {
            groupId: ids.groupId,
            landingPath: "landing.md",
            expectedRevision: revision
        })
        const set = op(lib.OPERATOR, "setGroupLanding", {
            groupId: ids.groupId,
            landingRepositoryPath: "sstgroup/site",
            landingPath: "landing.md",
            newsContactListId: ids.newsId,
            expectedRevision: revision
        })
        return {narrower, byMaintainer, set, landing: op(null, "getGroupLanding", {groupId: ids.groupId})}
    },
    then({narrower, byMaintainer, set, landing}) {
        narrower.kind == "Unprocessable"
        byMaintainer.reason == "accessDenied"
        set.revision > 1
        landing.html.includes("Hello from the site.")
        !landing.html.includes("<script")
        landing.sourceRepositoryPath == "sstgroup/site"
        landing.editPath == "/code/sstgroup/site/-/edit/main/landing.md"
        landing.newsList.map(topic => topic.title).join() == "The widget is out"
        landing.newsList[0].path.startsWith("/forum/t/")
    }
})
