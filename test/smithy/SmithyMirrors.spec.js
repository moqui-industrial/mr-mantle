// A repository's push mirrors (mr-pass plan/design-smithy.md §11 RepositorySettings Mirrors, plans/Dogfood.md F6;
// SmithyImport.js findMirrors, storeMirror, deleteMirror, pushMirror, mirrorFailure, over the framework's
// org.moqui.git.GitServices mirror services): a Maintainer keeps them, a Developer is refused; the list and the receipt hold
// no secret; an edit clears the refs and the credential (removeCredential is the framework's clearCredential); a new host
// without the secret again is refused (secretRequired); a push is queued and one running is a Conflict; lastError is shown
// without a credential; the store is the Maintainer's own (authorization on), so a mirror whose giver is no longer a
// Maintainer pauses at its next push; a failure the framework tells the giver of is told to the other Maintainers and
// Owners. Mirror addresses are under .invalid, which never resolves. Spec-local site, accounts, a group and a db
// repository. Regression suite: these are rules. Run: ./moq test mr-mantle --spec SmithyMirrors
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const SITE = "SMI_SITE"
const SECRET = "mirror-secret-0123456789"
const URL = "https://mirror.invalid/acme/widgets.git"
const ids = {}
const op = (username, operation, input) => lib.op(username, SITE, operation, input)
const on = (username, operation, input = {}) => op(username, operation, {repositoryId: ids.code, ...input})
const listed = username => on(username, "findMirrors").mirrorList
const mirrorRow = mirrorId => lib.row("moqui.resource.GitRepositoryMirror", {mirrorId})
const notices = (userId, repositoryId) =>
    Array.from(ec.entity.find("moqui.security.user.NotificationMessageUser").condition({userId}).disableAuthz().list())
        .map(row => lib.row("moqui.security.user.NotificationMessage", {notificationMessageId: row.notificationMessageId}))
        .filter(message => message && message.topic === "GitMirrorFailure" && message.subTopic === repositoryId)

spec({
    requires: ["git"],
    setupSpec() {
        login(lib.OPERATOR)
        lib.site(SITE)
        for (const id of ["OWNER", "MAINT", "MAINT2", "DEV"]) lib.account(SITE, "SMI_" + id, {handle: "smi" + id.toLowerCase()})
        ids.group = lib.createGroup(lib.OPERATOR, {siteId: SITE, pathSegment: "smigroup", visibility: "public"}).groupId
        ids.code = lib.createRepository(lib.OPERATOR, {
            siteId: SITE,
            groupId: ids.group,
            slug: "code",
            visibility: "public"
        }).repositoryId
        lib.role(SITE, {groupId: ids.group}, "SMI_OWNER", "SmrOwner")
        lib.role(SITE, {groupId: ids.group}, "SMI_MAINT", "SmrMaintainer")
        lib.role(SITE, {groupId: ids.group}, "SMI_DEV", "SmrDeveloper")
        lib.role(SITE, {repositoryId: ids.code}, "SMI_MAINT2", "SmrMaintainer")
        lib.commit(ids.code, "Start", {"README.md": "# Code\n"})
    }
})

feature("a Maintainer stores a mirror as itself; the list and the receipt hold no secret; a Developer is refused", {
    when() {
        const input = {
            repositoryId: ids.code,
            url: URL,
            username: "x-access-token",
            secret: SECRET,
            refs: "refs/heads/*",
            // stored disabled: nothing is pushed while the spec looks at it
            enabled: "N",
            operationId: "smi-mirror-1"
        }
        const developer = op("SMI_DEV", "storeMirror", {...input, operationId: "smi-mirror-dev"})
        const stored = op("SMI_MAINT", "storeMirror", input)
        ids.mirror = stored.mirrorId
        const again = op("SMI_MAINT", "storeMirror", input)
        const receipt = lib.row("mantle.forum.ForumOperationReceipt", {
            siteId: SITE,
            operationId: "smi-mirror-1",
            action: "storeMirror"
        })
        const forum = ec.resource.script("component://mr-mantle/service/mantle/forum/ForumCore.js")
        const withoutSecret = {...input, siteId: SITE}
        delete withoutSecret.secret
        delete withoutSecret.operationId
        const expected = forum.hash(
            JSON.stringify(Object.fromEntries(Object.entries(withoutSecret).sort(([a], [b]) => a.localeCompare(b))))
        )
        const list = listed("SMI_MAINT")
        return {
            developer,
            developerList: on("SMI_DEV", "findMirrors"),
            stored,
            again,
            receiptHashed: receipt.payloadHash === expected,
            receiptText: JSON.stringify(receipt.getMap()),
            list,
            listText: JSON.stringify(list),
            row: mirrorRow(stored.mirrorId)
        }
    },
    then({developer, developerList, stored, again, receiptHashed, receiptText, list, listText, row}) {
        developer.reason == "accessDenied"
        developerList.reason == "accessDenied"
        stored.mirrorId != null
        again.mirrorId == stored.mirrorId
        receiptHashed == true
        !receiptText.includes(SECRET)
        list.length == 1
        list[0].url == URL
        list[0].refs == "refs/heads/*"
        list[0].hasCredential == true
        list[0].enabled == false
        !listText.includes(SECRET)
        !("credential" in list[0])
        // stored as the Maintainer: the framework holds the credential to that account's right
        row.createdByUserId == "SMI_MAINT"
        row.storedAuthzDisabled != "Y"
    }
})

feature("an edit clears the refs and the credential; a new host without the secret again is refused", {
    when() {
        const edit = (fields, username = "SMI_MAINT") => on(username, "storeMirror", {mirrorId: ids.mirror, ...fields})
        // another path on the same host is another repository: the stored token is not pointed at it without being given again
        const samePath = edit({url: "https://mirror.invalid/acme/other.git", deleteRefs: "Y"})
        const notMoved = mirrorRow(ids.mirror)
        const clearedRefs = edit({refs: ""})
        const refs = listed("SMI_MAINT")[0].refs
        const moved = edit({url: "https://elsewhere.invalid/acme/widgets.git"})
        const stillThere = listed("SMI_MAINT")[0].url
        const both = edit({removeCredential: "Y", secret: "another-secret-0123"})
        const movedWithSecret = edit({url: "https://elsewhere.invalid/acme/widgets.git", secret: "another-secret-0123"})
        const removed = edit({removeCredential: "Y"})
        const after = listed("SMI_MAINT")[0]
        return {samePath, notMoved, clearedRefs, refs, moved, stillThere, both, movedWithSecret, removed, after, row: mirrorRow(ids.mirror)}
    },
    then({samePath, notMoved, clearedRefs, refs, moved, stillThere, both, movedWithSecret, removed, after, row}) {
        samePath.reason == "secretRequired"
        notMoved.url == URL
        notMoved.deleteRefs != "Y"
        clearedRefs.mirrorId == ids.mirror
        refs == null
        moved.reason == "secretRequired"
        moved.message.includes("token or password again")
        stillThere == URL
        both.kind == "Unprocessable"
        movedWithSecret.mirrorId == ids.mirror
        removed.mirrorId == ids.mirror
        after.url == "https://elsewhere.invalid/acme/widgets.git"
        after.hasCredential == false
        row.credential == null
        row.username == null
    }
})

feature(
    "a push is queued and one running is a Conflict; lastError is shown without a credential; a Maintainer deletes a mirror",
    {
        when() {
            lib.set(
                "moqui.resource.GitRepositoryMirror",
                {mirrorId: ids.mirror},
                {
                    lastResult: "failed",
                    lastError:
                        "not pushed: https://x-access-token:ghp_abcdefghijklmnop0123@github.com/acme/widgets.git Basic dXNlcjpwYXNzd29yZDAxMjM= " +
                        "github_pat_abcdefghijklmnop0123 Bearer abcdefgh01234567 x-access-token:plainsecret99@host"
                }
            )
            const shown = listed("SMI_MAINT")[0].lastError
            // another member's push holds the mirror's lease
            const lease = "git-mirror:" + ids.mirror
            lib.make("moqui.resource.GitLease", {
                leaseName: lease,
                holderId: "another-member",
                leaseUntil: ec.user.timestampMillis(ec.user.nowTimestamp) + 600000,
                takenDate: ec.user.nowTimestamp
            })
            const busy = on("SMI_MAINT", "pushMirror", {mirrorId: ids.mirror})
            lib.run("delete#moqui.resource.GitLease", {leaseName: lease})
            const developer = on("SMI_DEV", "pushMirror", {mirrorId: ids.mirror})
            const queued = on("SMI_MAINT", "pushMirror", {mirrorId: ids.mirror})
            const spare = on("SMI_MAINT", "storeMirror", {
                url: "https://spare.invalid/a.git",
                enabled: "N",
                operationId: "smi-mirror-2"
            })
            const deleted = on("SMI_MAINT", "deleteMirror", {mirrorId: spare.mirrorId})
            return {shown, busy, developer, queued, deleted, gone: mirrorRow(spare.mirrorId)}
        },
        then({shown, busy, developer, queued, deleted, gone}) {
            shown.startsWith("not pushed: https://")
            !shown.includes("ghp_")
            !shown.includes("dXNlcjpwYXNzd29yZDAxMjM")
            !shown.includes("github_pat_")
            !shown.includes("abcdefgh01234567")
            !shown.includes("plainsecret99")
            busy.kind == "Conflict"
            developer.reason == "accessDenied"
            queued.queued == true
            deleted.deleted == true
            gone == null
        }
    }
)

feature("a mirror whose credential's giver is no longer a Maintainer pauses at its next push", {
    when() {
        const stored = on("SMI_MAINT2", "storeMirror", {
            url: "https://paused.invalid/acme/widgets.git",
            username: "x-access-token",
            secret: SECRET,
            enabled: "N",
            operationId: "smi-mirror-3"
        })
        // the role ends; the mirror is enabled by hand (no push is asked for by that write)
        lib.set(
            "mantle.smithy.SmithyRepositoryParty",
            {repositoryId: ids.code, partyId: "SMI_MAINT2"},
            {
                thruDate: ec.user.timestampMillis(ec.user.nowTimestamp) - 1
            }
        )
        lib.set("moqui.resource.GitRepositoryMirror", {mirrorId: stored.mirrorId}, {enabled: "Y"})
        lib.run("org.moqui.git.GitServices.run#GitRepositoryMirrors", {mirrorId: stored.mirrorId})
        return {row: mirrorRow(stored.mirrorId)}
    },
    then({row}) {
        row.enabled == "N"
        row.lastResult == "paused"
        row.lastError != null
        !row.lastError.includes(SECRET)
    }
})

feature("a failure the framework tells the mirror's giver of is told to the repository's other Maintainers and Owners", {
    when() {
        // as the framework sends it at the first failure after a success (mirror.rs notify_failure)
        ec.makeNotificationMessage()
            .topic("GitMirrorFailure")
            .subTopic(ids.code)
            .userId("SMI_MAINT")
            .title("The push mirror fails")
            .message({
                repositoryId: ids.code,
                mirrorId: ids.mirror,
                url: URL,
                error: "not pushed: token ghp_abcdefghijklmnop0123 refused"
            })
            .persistOnSend(true)
            .send()
        const owner = notices("SMI_OWNER", ids.code)
        return {
            owner,
            maintainer: notices("SMI_MAINT", ids.code).length,
            developer: notices("SMI_DEV", ids.code).length,
            formerMaintainer: notices("SMI_MAINT2", ids.code).length
        }
    },
    then({owner, maintainer, developer, formerMaintainer}) {
        owner.length == 1
        owner[0].recordEntityName == "mantle.smithy.SmithyRepository"
        owner[0].titleText.includes("smigroup/code")
        !owner[0].messageJson.includes("ghp_")
        // the giver has the framework's own notice only
        maintainer == 1
        developer == 0
        formerMaintainer == 0
    }
})
