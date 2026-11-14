// Smithy's component directory (mr-pass plan/design-smithy.md §13.4, DG7; SmithySite.js): a repository whose root has a
// component.xml is a component, its name, version and depends-on names read when the default branch moves (the gitECA
// rule SmithyComponent) and at a tag; findComponents lists what the caller views; a group's addons.xml, in the format
// ./moq component-get reads, lists the public components only for no user. Reads SmithyDocs's fixture. Regression suite:
// these are rules. Run: ./moq test mr-mantle --spec SmithyComponents
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const ids = {}
const op = (username, operation, input) => lib.op(username, lib.SITE7, operation, input)
const names = out => (out.componentList || []).map(c => c.name).join()

spec({
    dependsOn: ["SmithyDocs"],
    requires: ["git"],
    setupSpec() {
        login(lib.OPERATOR)
        Object.assign(ids, lib.siteIds())
    }
})

feature("component.xml is read when the default branch moves; the directory lists what the caller views", {
    when() {
        const row = lib.row("mantle.smithy.SmithyRepository", {repositoryId: ids.repositoryId})
        return {
            row: [row.componentName, row.componentVersion, row.componentDependsOn].join("|"),
            stranger: op("SST_STRANGER", "findComponents", {query: "sst"}),
            operator: op(lib.OPERATOR, "findComponents", {groupId: ids.groupId})
        }
    },
    then({row, stranger, operator}) {
        row == "sst-site|1.2.0|mr-mantle"
        names(stranger) == "sst-site"
        stranger.componentList[0].dependsOn.join() == "mr-mantle"
        stranger.componentList[0].repositoryPath == "sstgroup/site"
        names(operator) == "sst-secret,sst-site"
    }
})

feature("a group's addons.xml names this server's addresses and only the public components, for any caller", {
    when() {
        return {
            anonymous: op(null, "getAddons", {groupId: ids.groupId}).xml,
            operator: op(lib.OPERATOR, "getAddons", {groupId: ids.groupId}).xml
        }
    },
    then({anonymous, operator}) {
        anonymous.includes('<repository name="' + lib.SITE7_HOST + '">')
        // Smithy is mounted at /code here: the page's address does not clone, the framework's /git does
        anonymous.includes('<location type="git" url="https://' + lib.SITE7_HOST + '/git/${group}/${name}.git"/>')
        anonymous.includes(
            '<location type="release" url="https://' + lib.SITE7_HOST + '/code/${group}/${name}/-/archive/${version}.zip"/>'
        )
        // the version is the latest published release's tag, which SmithyReleases may have made
        new RegExp(
            '<component name="site" group="sstgroup" version="(v1\\.2\\.0)?" branch="main" repository="' +
                lib.SITE7_HOST.replace(/\./g, "\\.") +
                '" component-name="sst-site"/>'
        ).test(anonymous)
        !anonymous.includes("secret")
        // what component-get fetches anonymously: never a private component, for any caller
        !operator.includes("sst-secret")
    }
})
