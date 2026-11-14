// Smithy's table of old paths (mr-pass plan/design-smithy.md §13.6, DG7; SmithySite.js): a site's owners keep it and nobody
// else; a target is a path of the site or an https address of one of its hosts, never another site's; an old address of
// another host keeps its host; a CSV of a site's move imports line by line, twice safely; resolve#Redirect, which PASS's
// resolver asks before Not Found, finds the target. Reads SmithyDocs's fixture. Regression suite: these are rules. Run:
// ./moq test mr-mantle --spec SmithyRedirects
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const op = (username, operation, input) => lib.op(username, lib.SITE7, operation, input)
const resolve = (host, path) =>
    lib.run("mantle.smithy.SmithySiteServices.resolve#Redirect", {siteId: lib.SITE7, host, path}).targetPath || null

spec({
    dependsOn: ["SmithyDocs"],
    setupSpec() {
        login(lib.OPERATOR)
    }
})

feature("a site owner keeps the table; a target off the site is refused", {
    when() {
        const store = (username, input, key) => op(username, "storeRedirect", {operationId: "sst-redirect-" + key, ...input})
        return {
            byMaintainer: store("SST_MAINT", {oldPath: "/m/docs/old", targetPath: "/code/sstgroup/site/-/docs"}, "1"),
            offSite: store("SST_OWNER", {oldPath: "/m/docs/old", targetPath: "https://elsewhere.test/docs"}, "2"),
            relative: store("SST_OWNER", {oldPath: "/m/docs/old", targetPath: "//elsewhere.test/docs"}, "3"),
            stored: store("SST_OWNER", {oldPath: "/m/docs/old/", targetPath: "/code/sstgroup/site/-/docs"}, "4"),
            taken: store("SST_OWNER", {oldPath: "/m/docs/old", targetPath: "/code"}, "5"),
            ownHost: store(
                "SST_OWNER",
                {oldPath: "https://forum.old.test/t/hello/12", targetPath: "https://" + lib.SITE7_HOST + "/forum"},
                "6"
            ),
            listed: op("SST_OWNER", "findRedirects", {query: "docs"}),
            stranger: op("SST_STRANGER", "findRedirects", {}).reason
        }
    },
    then({byMaintainer, offSite, relative, stored, taken, ownHost, listed, stranger}) {
        byMaintainer.reason == "accessDenied"
        offSite.reason == "targetInvalid"
        relative.reason == "targetInvalid"
        stored.redirectId != null
        taken.reason == "nameTaken"
        ownHost.redirectId != null
        listed.redirectList.map(row => row.oldPath + ">" + row.targetPath + ":" + row.source).join() ==
            "/m/docs/old>/code/sstgroup/site/-/docs:manual"
        stranger == "accessDenied"
    }
})

feature("a CSV of a site's move imports each line on its own; resolve finds the target for the host and the path", {
    when() {
        const csv =
            "old,new,note\n/m/info/License,/code/sstgroup/site/-/docs/main/LICENSE.md,the license\nhttps://forum.old.test/c/general,/forum,\n/bad,https://elsewhere.test/,\n"
        const first = op("SST_OWNER", "importRedirects", {csv, source: "site"})
        const again = op("SST_OWNER", "importRedirects", {csv, source: "site"})
        return {
            first,
            again,
            own: resolve(lib.SITE7_HOST, "/m/info/License/"),
            lower: resolve(lib.SITE7_HOST, "/M/DOCS/OLD"),
            otherHost: resolve("forum.old.test", "/c/general"),
            notThatHost: resolve(lib.SITE7_HOST, "/c/general"),
            none: resolve(lib.SITE7_HOST, "/nothing/here")
        }
    },
    then({first, again, own, lower, otherHost, notThatHost, none}) {
        first.created == 2
        first.failedList.map(row => row.line).join() == "4"
        again.created == 0
        again.updated == 2
        own == "/code/sstgroup/site/-/docs/main/LICENSE.md"
        lower == "/code/sstgroup/site/-/docs"
        otherHost == "/forum"
        notThatHost == null
        none == null
    }
})
