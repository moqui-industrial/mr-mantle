// An account's git access (mr-pass plan/design-smithy.md §11 GitAccess, §15.3; SmithyGit.js findGitAccess, addSshKey,
// removeSshKey, createAccessToken, revokeAccessToken and the Account hub's card, over the framework's
// org.moqui.impl.UserServices): a key and a token are added by the account itself with a confirmed address and its
// password again; a key in use is refused; a token is shown once and a repeated operation answers without it; the list
// is the caller's own and has no secret; and an account ends only its own. Spec-local site and accounts. Regression
// suite: these are rules. Run: ./moq test mr-mantle --spec SmithyGitAccess
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const SITE = "SGA_SITE"
const KEY_ONE = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAYu3kBlxxp/zgcdj4uhDokrO2WCYOxNjFisfzVgVTDd smithy-spec-one"
const KEY_TWO = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKBLHUPX2q0hzQfHjnmNS92tJy+7fnNF2J6vySgbig57 smithy-spec-two"
const KEY_THREE = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFUVz31TXhRUo5Z+V2JSYseq55KDJtMvmgY/+yHte/+Y smithy-spec-three"
const op = (username, operation, input) => lib.op(username, SITE, operation, input)
const add = (username, publicKey, operationId, more = {}) =>
    op(username, "addSshKey", {name: "Laptop", publicKey, password: "moqui", operationId, ...more})
const access = username => op(username, "findGitAccess", {})

spec({
    requires: ["git"],
    setupSpec() {
        login(lib.OPERATOR)
        lib.site(SITE)
        lib.account(SITE, "SGA_ONE", {handle: "sgaone"})
        lib.account(SITE, "SGA_TWO", {handle: "sgatwo"})
        lib.account(SITE, "SGA_UNCONFIRMED", {handle: "sgaunconfirmed", unconfirmed: true})
    }
})

feature("an account adds an SSH key with a confirmed address and its password again, and a key in use is refused", {
    when() {
        return {
            wrongPassword: add("SGA_ONE", KEY_ONE, "sga-key-01", {password: "not-it"}),
            unconfirmed: add("SGA_UNCONFIRMED", KEY_ONE, "sga-key-02"),
            anonymous: add(null, KEY_ONE, "sga-key-03"),
            noKey: add("SGA_ONE", "not a key", "sga-key-04"),
            added: add("SGA_ONE", KEY_ONE, "sga-key-05"),
            inUse: add("SGA_TWO", KEY_ONE, "sga-key-06"),
            other: add("SGA_TWO", KEY_TWO, "sga-key-07")
        }
    },
    then({wrongPassword, unconfirmed, anonymous, noKey, added, inUse, other}) {
        wrongPassword.kind == "AuthenticationRequired"
        unconfirmed.kind == "Unauthorized"
        unconfirmed.reason == "addressUnconfirmed"
        anonymous.kind == "AuthenticationRequired"
        noKey.kind == "Unprocessable"
        added.fingerprint == "SHA256:CUmqyK82+OhmSscz0cB9GnfV8slb8NmAUU3yyRi5AOU"
        inUse.kind == "Conflict"
        other.sshKeyId != added.sshKeyId
        // the key is the account's that added it
        lib.row("moqui.security.UserSshKey", {sshKeyId: added.sshKeyId}).userId == "SGA_ONE"
    }
})

feature("a token is shown once, and a repeated operation answers without it", {
    // the operation end to end as a public account, through the authority: the framework writes the login key in a
    // transaction of its own, which waited for a lock of the account's row until the request's deadline when the
    // receipt took that lock
    timeout: 10,
    when() {
        const create = (username, operationId, more = {}) =>
            op(username, "createAccessToken", {name: "CI", password: "moqui", operationId, ...more})
        const made = create("SGA_ONE", "sga-token-01")
        return {
            made,
            replay: create("SGA_ONE", "sga-token-01"),
            wrongPassword: create("SGA_ONE", "sga-token-02", {password: "not-it"}),
            unconfirmed: create("SGA_UNCONFIRMED", "sga-token-03"),
            past: create("SGA_ONE", "sga-token-04", {expiresAt: "2001-01-01"}),
            // another account's token is Not Found, and the account's own is revoked
            byOther: op("SGA_TWO", "revokeAccessToken", {tokenId: made.tokenId}),
            revoked: op("SGA_ONE", "revokeAccessToken", {tokenId: made.tokenId})
        }
    },
    then({made, replay, wrongPassword, unconfirmed, past, byOther, revoked}) {
        made.token.length > 20
        // the framework's 90 days when none is asked, for the page to say
        made.expiresAt != null
        made.tokenId != made.token
        replay.tokenId == made.tokenId
        replay.token == null
        wrongPassword.kind == "AuthenticationRequired"
        unconfirmed.reason == "addressUnconfirmed"
        past.kind == "Unprocessable"
        byOther.kind == "NotFound"
        revoked.revoked == true
    }
})

feature("the list is the caller's own and has no secret, and an account ends only its own key", {
    when() {
        const one = access("SGA_ONE")
        const keyId = one.sshKeyList[0].sshKeyId
        return {
            one,
            text: JSON.stringify(one),
            two: access("SGA_TWO").sshKeyList.map(key => key.name + " " + key.fingerprint.slice(0, 7)),
            card: lib.as(
                "SGA_ONE",
                () => lib.run("mantle.smithy.SmithyServices.get#AccountCard", {input: {siteId: SITE}}).result
            ),
            byOther: op("SGA_TWO", "removeSshKey", {sshKeyId: keyId}),
            removed: op("SGA_ONE", "removeSshKey", {sshKeyId: keyId}),
            after: access("SGA_ONE").sshKeyList.length
        }
    },
    then({one, text, two, card, byOther, removed, after}) {
        one.sshKeyList.map(key => key.name + " " + key.fingerprint) ==
            ["Laptop SHA256:CUmqyK82+OhmSscz0cB9GnfV8slb8NmAUU3yyRi5AOU"]
        // the token of the feature before was revoked
        one.tokenList == []
        one.confirmed == true
        text.includes("AAAAC3NzaC1lZDI1NTE5") == false
        two == ["Laptop SHA256:"]
        card.title == "Git access"
        card.sshKeyCount == 1
        card.lines.includes("1 SSH key")
        byOther.kind == "NotFound"
        removed.deleted == true
        after == 0
    }
})

feature("an account with no password to give again signs in again instead", {
    when() {
        // an account that signs in through a provider: no password, and no sign-in in the framework's history
        lib.account(SITE, "SGA_PROVIDER", {handle: "sgaprovider"})
        const asProvider = work => {
            ec.user.internalLoginUser("SGA_PROVIDER")
            try {
                return work()
            } finally {
                ec.message.clearErrors()
                ec.user.loginUser(lib.OPERATOR, "moqui")
            }
        }
        const add = operationId =>
            asProvider(() => {
                const out = ec.resource.script("component://mr-mantle/script/PassAuthority.js").handle({
                    siteId: SITE,
                    operation: "addSshKey",
                    input: {name: "Phone", publicKey: KEY_THREE, operationId},
                    sessionChecked: true
                })
                return out.error ? {kind: out.error.code, reason: out.error.reason} : out.result
            })
        lib.set("moqui.security.UserAccount", {userId: "SGA_PROVIDER"}, {currentPassword: null})
        const history = () => ec.entity.find("moqui.security.UserLoginHistory").condition("userId", "SGA_PROVIDER").disableAuthz()
        history().deleteAll()
        const stale = add("sga-provider-1")
        lib.make("moqui.security.UserLoginHistory", {
            userId: "SGA_PROVIDER",
            fromDate: ec.user.nowTimestamp,
            successfulLogin: "Y"
        })
        return {stale, recent: add("sga-provider-2")}
    },
    then({stale, recent}) {
        stale.kind == "AuthenticationRequired"
        stale.reason == "recentSignInRequired"
        recent.fingerprint.startsWith("SHA256:")
    }
})
