// Smithy's side of the Dev AIDE's connection to a group server (mr-moqui plans/design-dev-aide.md §21; SmithyHosting.js,
// PassAuthority.js APP_KEY_OPERATIONS): the framework's REST refuses the writes of a repository Smithy keeps and names
// Smithy's REST, and allows its reads and any other repository's writes; the hosting offer names Smithy's REST of the
// host's site, forks and Mantle's task source; the agreement check answers for a repository Smithy keeps; an installed
// app's login key calls the Dev AIDE's operations through the PASS REST as its account (and nothing else), and an access
// token calls none (design-smithy §5.5). Spec-local site, accounts and db repository. Regression suite: these are rules.
// Run: ./moq test mr-mantle --spec SmithyDevAide
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const SITE = "SDA_SITE"
const HOST = "sda.smithy.test"
const REST = "/rest/s1/pass/v1/sites/" + SITE + "/smithy"
const ids = {}
const keys = {device: "sda-device-" + ec.user.randomString(24), token: "sda-token-" + ec.user.randomString(24)}
const hook = (verb, parameters) => lib.run("mantle.smithy.SmithyGitServices." + verb, parameters)
// A request to the PASS REST as the servlet API gives it to PassApi.js, with a login key in the api_key header as the Dev
// AIDE sends it, by the key's account (the framework logged it in by the key): the status and the JSON answer.
function rest(key, method, path, parameters = {}) {
    return lib.as("SDA_DEV", () => {
        const request = {
            requestURI: REST + "/" + path,
            method,
            getHeader: name => (String(name).toLowerCase() === "api_key" ? key : null),
            getParameterMap: () => ({...parameters})
        }
        const response = {
            status: 200,
            body: "",
            setStatus(status) {
                this.status = status
            },
            setHeader() {},
            setContentType() {},
            write(text) {
                this.body += text
            },
            sendRedirect() {}
        }
        ec.resource.script("component://mr-mantle/script/PassApi.js").service(request, response)
        return {status: response.status, body: JSON.parse(response.body || "null")}
    })
}
// A login key of SDA_DEV as the framework stores it (the SHA-256 of the key), a device's or an access token
const loginKey = (key, fields) =>
    lib.make("moqui.security.UserLoginKey", {
        loginKey: ec.resource.digestText(key, "sha256"),
        userId: "SDA_DEV",
        fromDate: ec.user.timestampMillis(ec.user.nowTimestamp) - 1000,
        thruDate: ec.user.timestampMillis(ec.user.nowTimestamp) + 86400000,
        ...fields
    })

spec({
    requires: ["git"],
    setupSpec() {
        login(lib.OPERATOR)
        lib.site(SITE)
        lib.make("mantle.public.PublicSiteHost", {hostname: HOST, siteId: SITE, canonical: "Y"})
        lib.settings(SITE, {forkCreateEnumId: "ScpVerified"})
        lib.account(SITE, "SDA_DEV", {member: true, handle: "sdadev"})
        lib.settled(SITE, "SDA_DEV")
        ids.groupId = lib.createGroup(lib.OPERATOR, {siteId: SITE, pathSegment: "sdagroup", visibility: "public"}).groupId
        ids.repositoryId = lib.createRepository(lib.OPERATOR, {siteId: SITE, groupId: ids.groupId, slug: "code", visibility: "public"}).repositoryId
        lib.role(SITE, {repositoryId: ids.repositoryId}, "SDA_DEV", "SmrDeveloper")
        lib.commit(ids.repositoryId, "Start", {"README.md": "# Code\n"})
        lib.run("org.moqui.git.GitServices.commit#GitFiles", {
            repositoryId: ids.repositoryId,
            message: "Add a feature",
            fileMap: {"feature.txt": "one\n"},
            branch: "main",
            newBranch: "feature"
        })
        loginKey(keys.device, {deviceName: "Dev AIDE"})
        loginKey(keys.token, {description: "Laptop"})
    }
})

feature("the write check refuses a Smithy repository's writes and names Smithy's REST; reads and other repositories pass", {
    when() {
        return {
            write: hook("check#RestWrite", {repositoryId: ids.repositoryId, operation: "mergeRequest.create"}),
            read: hook("check#RestWrite", {repositoryId: ids.repositoryId, operation: "read"}),
            other: hook("check#RestWrite", {repositoryId: "SDA_NOT_SMITHY", operation: "ref.create"})
        }
    },
    then({write, read, other}) {
        write.allowed == false
        write.application == "smithy"
        write.restUrl == "https://" + HOST + REST
        write.message.includes("Smithy's REST")
        read.allowed == true
        read.application == "smithy"
        other.allowed == true
        !other.application
    }
})

feature("the offer names Smithy's REST of the host's site, its forks and Mantle's task source", {
    when() {
        return hook("add#HostingOffer", {offer: {baseUrl: "https://" + HOST, forks: false, git: {httpsBase: "https://" + HOST + "/git/"}}}).offer
    },
    then(offer) {
        offer.application.name == "smithy"
        offer.application.restBase == REST
        offer.forks == true
        offer.tasks == {kind: "moqui-rest", path: "/rest/s1/mantle/my/tasks"}
        // the framework's offer stays
        offer.git.httpsBase == "https://" + HOST + "/git/"
    }
})

feature("the agreement check answers for a repository Smithy keeps and leaves any other unknown", {
    when() {
        return {
            kept: hook("check#AuthorSigned", {repositoryId: ids.repositoryId, authorUserId: "SDA_DEV"}),
            other: hook("check#AuthorSigned", {repositoryId: "SDA_NOT_SMITHY", authorUserId: "SDA_DEV"})
        }
    },
    then({kept, other}) {
        kept.known == true
        kept.required == false
        kept.signUrl.startsWith("https://" + HOST + "/code/sdagroup/code/-/edit/main/")
        other.known == false
    }
})

feature("an installed app's key calls the Dev AIDE's operations as its account and nothing else; an access token none", {
    when() {
        const open = (key, operationId) =>
            rest(key, "POST", "repositories/" + ids.repositoryId + "/merge-requests", {sourceRef: "feature", title: "Add a feature", operationId})
        const opened = open(keys.device, "sda-open-1")
        return {
            opened,
            again: open(keys.device, "sda-open-1"),
            list: rest(keys.device, "GET", "merge-requests", {repositoryId: ids.repositoryId}),
            fork: rest(keys.device, "POST", "repositories/" + ids.repositoryId + "/forks", {operationId: "sda-fork-1"}),
            settings: rest(keys.device, "PATCH", "settings", {}),
            tokenOpen: open(keys.token, "sda-open-2"),
            tokenList: rest(keys.token, "GET", "merge-requests", {repositoryId: ids.repositoryId}),
            unknownKey: rest("sda-no-such-key", "GET", "merge-requests", {repositoryId: ids.repositoryId})
        }
    },
    then({opened, again, list, fork, settings, tokenOpen, tokenList, unknownKey}) {
        opened.status == 200
        opened.body.mergeRequestNum == 1
        // the same operationId answers the first result
        again.body.mergeRequestNum == 1
        list.status == 200
        list.body.mergeRequestList.map(item => [item.number, item.title, item.state, item.authorHandle, item.url]) ==
            [[1, "Add a feature", "open", "sdadev", "https://" + HOST + "/code/sdagroup/code/-/merge-requests/1"]]
        fork.status == 200
        fork.body.repositoryPath == "sdadev/code"
        fork.body.cloneUrls.httpsUrl.endsWith("sdadev/code.git")
        settings.status == 403
        settings.body.reason == "accessDenied"
        tokenOpen.status == 403
        tokenOpen.body.reason == "accessDenied"
        tokenList.status == 403
        unknownKey.status == 403
    }
})
