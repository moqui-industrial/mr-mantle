// The confirmed address (mr-pass plan/design-smithy.md §5.5, D17; service/mantle/public/ConfirmedAddress.js, and its
// users in Smithy: kit.writer and the push gate of mantle.smithy.SmithyGitServices): a public account's current address
// is verified by its VerifiedAddress row with verifiedAt, a changed address needs a fresh one, and case does not matter;
// an internal account is confirmed by having an address, and is not thereby verified; a Smithy write and a push are
// refused without a confirmed address; and the push gate leaves a repository with no Smithy row alone. A spec has no
// git client, so the gate is asked as the pre-receive rule asks it. Spec-local site, accounts and db repositories.
// Regression suite: these are rules. Run: ./moq test mr-mantle --spec ConfirmedAddress
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const helper = ec.resource.script("component://mr-mantle/service/mantle/public/ConfirmedAddress.js")
const SITE = "CAD_SITE"
const ids = {}
const state = userId => helper.verified(userId) + " " + helper.confirmed(userId)

spec({
    requires: ["git"],
    setupSpec() {
        login(lib.OPERATOR)
        lib.site(SITE)
        lib.account(SITE, "CAD_VERIFIED", {handle: "cadverified"})
        lib.account(SITE, "CAD_UNVERIFIED", {handle: "cadunverified", unconfirmed: true})
        lib.account(SITE, "CAD_CHANGED", {handle: "cadchanged"})
        lib.account(SITE, "CAD_INTERNAL", {unconfirmed: true, internal: true})
        lib.account(SITE, "CAD_NO_ADDRESS", {unconfirmed: true, internal: true})
        lib.account(SITE, "CAD_SUSPENDED", {handle: "cadsuspended"})
        ids.group = lib.createGroup(lib.OPERATOR, {siteId: SITE, pathSegment: "cadgroup", visibility: "public"}).groupId
        ids.code = lib.createRepository(lib.OPERATOR, {
            siteId: SITE,
            groupId: ids.group,
            slug: "code",
            visibility: "public"
        }).repositoryId
        for (const id of ["CAD_VERIFIED", "CAD_UNVERIFIED", "CAD_SUSPENDED"])
            lib.role(SITE, {groupId: ids.group}, id, "SmrDeveloper")
        lib.sanction(SITE, "CAD_SUSPENDED", "suspend")
        // a hosted repository that Smithy does not have: a Projects-only one
        lib.make("moqui.resource.GitRepository", {repositoryId: "cad_plain", repositoryKind: "db", branch: "main"})
        lib.run("org.moqui.git.GitServices.init#GitRepository", {repositoryId: "cad_plain"})
    }
})

feature("a public account's current address is verified by its row; an internal account is confirmed by having an address", {
    when() {
        // an address changed after it was verified, and one that differs from its row in case only
        lib.set("moqui.security.UserAccount", {userId: "CAD_CHANGED"}, {emailAddress: "cad.new@smithy.test"})
        lib.set("moqui.security.UserAccount", {userId: "CAD_VERIFIED"}, {emailAddress: "CAD_Verified@Smithy.Test"})
        lib.set("moqui.security.UserAccount", {userId: "CAD_NO_ADDRESS"}, {emailAddress: null})
        return {
            verified: state("CAD_VERIFIED"),
            unverified: state("CAD_UNVERIFIED"),
            changed: state("CAD_CHANGED"),
            internal: state("CAD_INTERNAL"),
            noAddress: state("CAD_NO_ADDRESS"),
            nobody: state("CAD_NOBODY"),
            // no id is nobody, never the signed-in account (here the operator, whose address is confirmed)
            noId: [state(null), state(""), state(undefined)],
            current: helper.currentConfirmed()
        }
    },
    then({verified, unverified, changed, internal, noAddress, nobody, noId, current}) {
        noId == ["false false", "false false", "false false"]
        current == true
        verified == "true true"
        unverified == "false false"
        changed == "false false"
        // its organization gave it its address: confirmed for a push, and not verified as a public account's is
        internal == "false true"
        noAddress == "false false"
        nobody == "false false"
    }
})

feature("a Smithy write and a push are refused without a confirmed address, by the role's holder too", {
    when() {
        const branch = (username, operationId) =>
            lib.op(username, SITE, "createRef", {repositoryId: ids.code, refType: "branch", name: operationId, operationId})
        lib.commit(ids.code, "Start", {"README.md": "# Code\n"})
        const push = userId => lib.gate("Push", {repositoryId: ids.code, userId, packBytes: 100})
        return {
            write: [branch("CAD_VERIFIED", "cad-branch-1"), branch("CAD_UNVERIFIED", "cad-branch-2")],
            push: [push("CAD_VERIFIED"), push("CAD_UNVERIFIED"), push(null), push("CAD_SUSPENDED")],
            upload: lib.gate("LfsUpload", {repositoryId: ids.code, userId: "CAD_UNVERIFIED", uploadBytes: 100}),
            // the one check refuses the push itself, whatever the rule says after it
            authz: ["CAD_VERIFIED", "CAD_UNVERIFIED"].map(userId => lib.authz(userId, ids.code, "UPDATE"))
        }
    },
    then({write, push, upload, authz}) {
        write[0].name == "cad-branch-1"
        write[1].kind == "Unauthorized"
        write[1].reason == "addressUnconfirmed"
        push[0] == []
        push[1].length == 1
        push[1][0].includes("confirmed email address")
        push[2].length == 1
        push[2][0].includes("confirmed email address")
        push[3] == ["Your account is suspended on this site"]
        upload.length == 1
        authz == ["AUTHZT_ALLOW", "AUTHZT_NONE"]
    }
})

feature("the push gate leaves a repository with no Smithy row alone", {
    when() {
        return {
            push: lib.gate("Push", {repositoryId: "cad_plain", userId: "CAD_UNVERIFIED", packBytes: 1e12}),
            upload: lib.gate("LfsUpload", {repositoryId: "cad_plain", userId: "CAD_UNVERIFIED", uploadBytes: 1e12})
        }
    },
    then({push, upload}) {
        push == []
        upload == []
    }
})
