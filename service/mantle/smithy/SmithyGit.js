/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * Smithy over the framework's git host (mr-pass plan/design-smithy.md §15.3, §5.5, §11): a repository's refs, branch rules
 * and webhooks, each the framework's hosting service after Smithy's role check; an account's SSH keys and access tokens;
 * and the two checks the git server asks, the push gate (check#Push, a pre-receive gitECA rule) and the LFS upload check.
 * Smithy.js calls this with its kit; the operations are methods of its map, and what it returns are the checks.
 */
kit => {
    const {core, methods, flag, text, handleOf, writer, MERGE_METHODS, GIT_REPOSITORY, quota, archived, repositoryFor} = kit
    const {M, GIT, forum} = core
    const {me, find, one, fail, missing, invalid, requireUser, page, receipt, sanctioned, audit, now, millis, stamp} = forum
    const {maintainerAudit} = kit
    const USER = "org.moqui.impl.UserServices."
    const publicApps = () => ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")

    /* A framework service after Smithy's own check: {out, problem}, the problem its first error, and out null for a
       service the framework does not have. */
    function called(name, parameters) {
        const out = ec.service.sync().name(name).parameters(parameters).call()
        if (!ec.message.hasError()) return {out: out || {}, problem: null}
        const problem = text(ec.message.getErrorsString()).split("\n")[0]
        ec.message.clearErrors()
        ec.logger.warn("Smithy call of " + name + " refused: " + problem)
        return {out, problem}
    }
    /* What the git host refused that the checks before the call did not see (a change made meanwhile, a rule of
       another component): its text read as the operation's refusal. The framework gives these no code, so this reads
       its words, after refState has decided what it can. */
    function refuseWrite(problem) {
        if (/^protected branch:|^declined:/.test(problem)) fail("Unauthorized", "accessDenied: A branch rule does not allow that")
        if (/already exists$/.test(problem)) fail("Conflict", "That name is taken by a branch or a tag")
        if (/default branch cannot be deleted/.test(problem)) fail("Conflict", "The default branch is not deleted")
        if (/is archived$/.test(problem)) archived()
        if (/^no branch or tag /.test(problem)) missing()
        invalid(problem.slice(0, 200))
    }
    /* A ref as the framework has it now, asked before a write so its refusals are Smithy's own: whether it is there,
       whether it is the default branch, and what the branch rules that name it ask together. */
    function refState(repositoryId, refType, name) {
        const refs = core.git("get#GitRefs", {repositoryId})
        const refName = (refType === "tag" ? "refs/tags/" : "refs/heads/") + name
        return {
            exists: Array.from(refs.refList || []).some(ref => ref.refName === refName),
            isDefault: refType === "branch" && name === (refs.defaultBranch || "main"),
            rules: core.git("get#GitBranchRules", {repositoryId, refName, refType})
        }
    }
    /* A repository for a settings read: as the caller views it, by a signed-in Maintainer. */
    function maintained(p) {
        const r = core.repository(p.repositoryId, p.siteId)
        requireUser()
        core.requireRole(r, "SmrMaintainer")
        return r
    }
    const yes = value => flag(value) || value === true

    // ===== refs =====
    methods.createRef = p => {
        const {r} = repositoryFor(p, "SmrDeveloper")
        if (r.git.archivedDate) archived()
        if (!["branch", "tag"].includes(p.refType)) invalid("refType must be branch or tag")
        const name = text(p.name).trim()
        if (!name || name.startsWith("refs/")) invalid("name is a branch's or a tag's short name")
        return receipt(p, "smithy.createRef", () => {
            // from a branch, a tag or a commit id and nothing else; the default branch's head when empty
            const from = p.fromRevision ? core.refOf(p.repositoryId, p.fromRevision) : core.splitRefPath(p.repositoryId, "")
            if (!from.commitId) invalid("The repository has no commit to start from")
            const state = refState(p.repositoryId, p.refType, name)
            if (state.exists) fail("Conflict", "That name is taken by a branch or a tag")
            if (state.rules.protected && state.rules.mayPushDirectly === false)
                fail("Unauthorized", "accessDenied: A branch rule does not allow that")
            const {out, problem} = called(GIT + "create#GitRef", {
                repositoryId: p.repositoryId,
                refName: name,
                refType: p.refType,
                revision: from.commitId,
                message: p.refType === "tag" ? text(p.message) || null : null
            })
            if (problem != null) refuseWrite(problem)
            maintainerAudit(p, "createRef", p.refType + " " + name)
            return {name, commitId: out.commitId || from.commitId}
        })
    }
    methods.deleteRef = p => {
        const {r} = repositoryFor(p, "SmrMaintainer")
        if (r.git.archivedDate) archived()
        if (!["branch", "tag"].includes(p.refType)) invalid("refType must be branch or tag")
        const name = text(p.name).trim()
        if (!name || name.startsWith("refs/")) invalid("name is a branch's or a tag's short name")
        const state = refState(p.repositoryId, p.refType, name)
        if (!state.exists) missing()
        if (state.isDefault) fail("Conflict", "The default branch is not deleted")
        if (Array.from(state.rules.ruleList || []).some(rule => !yes(rule.allowDelete)))
            fail("Unauthorized", "accessDenied: A branch rule does not allow that")
        const {problem} = called(GIT + "delete#GitRef", {repositoryId: p.repositoryId, refName: name, refType: p.refType})
        if (problem != null) refuseWrite(problem)
        maintainerAudit(p, "deleteRef", p.refType + " " + name)
        return {deleted: true}
    }

    // ===== branch rules =====
    const RULE_FLAGS = ["allowForcePush", "allowDelete", "requireMergeRequest", "dismissStaleApprovals"]
    const words = value =>
        text(value)
            .split(",")
            .map(word => word.trim())
            .filter(word => word !== "")
    methods.getBranchRules = p => {
        maintained(p)
        const found = core.git("get#GitBranchRules", {repositoryId: p.repositoryId})
        return {
            ruleList: Array.from(found.ruleList || []).map(rule => ({
                branchRuleId: rule.branchRuleId,
                refPattern: rule.refPattern,
                ...Object.fromEntries(RULE_FLAGS.map(name => [name, yes(rule[name])])),
                requiredApprovals: Number(rule.requiredApprovals || 0),
                requiredStatusContexts: Array.from(rule.requiredStatusContexts || []),
                allowedMergeMethods: Array.from(rule.allowedMergeMethods || []).map(method => MERGE_METHODS[method] || method)
            }))
        }
    }
    const ruleOf = (p, id) => {
        const rule = typeof id === "string" && id ? one("moqui.resource.GitBranchRule", {branchRuleId: id}) : null
        if (!rule || rule.repositoryId !== p.repositoryId) missing()
        return rule
    }
    methods.storeBranchRule = p => {
        const {r} = repositoryFor(p, "SmrMaintainer")
        if (r.git.archivedDate) archived()
        if (!text(p.refPattern).trim()) invalid("refPattern is required")
        const requiredApprovals = p.requiredApprovals == null || p.requiredApprovals === "" ? 0 : Number(p.requiredApprovals)
        if (!Number.isInteger(requiredApprovals) || requiredApprovals < 0 || requiredApprovals > 100)
            invalid("requiredApprovals must be a whole number")
        const methodIds = words(p.allowedMergeMethods).map(
            word => core.idOfCode(MERGE_METHODS, word) || invalid("allowedMergeMethods are merge, squash, fastForward and rebase")
        )
        const store = rule => {
            const {out, problem} = called(GIT + "store#GitBranchRule", {
                branchRuleId: p.branchRuleId || null,
                repositoryId: p.repositoryId,
                refPattern: text(p.refPattern).trim(),
                ...Object.fromEntries(RULE_FLAGS.map(name => [name, flag(p[name]) ? "Y" : "N"])),
                requiredApprovals,
                requiredStatusContexts: words(p.requiredStatusContexts).join(",") || null,
                allowedMergeMethods: methodIds.join(",") || null,
                // public roles are not user groups (§5.4): Smithy sets none, and a push group an operator set on a
                // rule stays through an edit (the framework's service writes the field whatever is passed)
                pushUserGroupId: rule?.pushUserGroupId || null
            })
            if (problem != null) invalid(problem.slice(0, 200))
            maintainerAudit(p, "storeBranchRule", text(p.refPattern).trim())
            return {branchRuleId: out.branchRuleId}
        }
        // with an id an edit of that rule of this repository; without one a create, which needs operationId
        if (p.branchRuleId) return store(ruleOf(p, p.branchRuleId))
        return receipt(p, "smithy.storeBranchRule", () => store(null))
    }
    methods.deleteBranchRule = p => {
        repositoryFor(p, "SmrMaintainer")
        const rule = ruleOf(p, p.branchRuleId)
        const {problem} = called(GIT + "delete#GitBranchRule", {branchRuleId: p.branchRuleId})
        if (problem != null) invalid(problem.slice(0, 200))
        maintainerAudit(p, "deleteBranchRule", rule.refPattern)
        return {deleted: true}
    }

    // ===== webhooks =====
    const MAX_WEBHOOKS = 10
    /* Test deliveries of a repository's webhooks in a minute: a test makes this server call an address of the
       Maintainer's choosing. */
    const TESTS_A_MINUTE = 3
    const hookOf = (p, id) => {
        const hook = typeof id === "string" && id ? one("moqui.resource.GitWebhook", {webhookId: id}) : null
        if (!hook || hook.repositoryId !== p.repositoryId) missing()
        return hook
    }
    methods.findWebhooks = p => {
        maintained(p)
        const {out, problem} = called(GIT + "find#GitWebhooks", {repositoryId: p.repositoryId})
        if (problem != null) missing()
        return {
            webhookList: Array.from(out.webhookList || []).map(hook => ({
                webhookId: hook.webhookId,
                url: hook.url,
                events: words(hook.events),
                active: hook.active !== "N",
                description: hook.description || "",
                lastDeliveryDate: hook.lastDeliveryDate || null,
                lastDeliveryStatus: hook.lastDeliveryStatus || null,
                hasSecret: !!hook.hasSecret
            }))
        }
    }
    methods.storeWebhook = p => {
        repositoryFor(p, "SmrMaintainer")
        const store = () => {
            const {out, problem} = called(GIT + "store#GitWebhook", {
                webhookId: p.webhookId || null,
                repositoryId: p.repositoryId,
                url: text(p.url).trim(),
                events: words(p.events).join(",") || null,
                // kept when left empty on an edit
                secret: p.secret || null,
                active: p.active == null || p.active === "" || flag(p.active) ? "Y" : "N",
                description: text(p.description) || null
            })
            if (problem != null) invalid(problem.slice(0, 200))
            // the URL may carry a credential of its own, so the row names the hook and not where it goes
            maintainerAudit(p, "storeWebhook", out.webhookId)
            return {webhookId: out.webhookId}
        }
        if (!text(p.url).trim()) invalid("url is required")
        if (p.webhookId) {
            hookOf(p, p.webhookId)
            return store()
        }
        return receipt(p, "smithy.storeWebhook", () => {
            if (find("moqui.resource.GitWebhook", {repositoryId: p.repositoryId}).count() >= MAX_WEBHOOKS)
                invalid("quotaExceeded: A repository has at most " + MAX_WEBHOOKS + " webhooks")
            return store()
        })
    }
    methods.deleteWebhook = p => {
        repositoryFor(p, "SmrMaintainer")
        hookOf(p, p.webhookId)
        const {problem} = called(GIT + "delete#GitWebhook", {webhookId: p.webhookId})
        if (problem != null) invalid(problem.slice(0, 200))
        maintainerAudit(p, "deleteWebhook", p.webhookId)
        return {deleted: true}
    }
    methods.testWebhook = p => {
        repositoryFor(p, "SmrMaintainer")
        hookOf(p, p.webhookId)
        const hookIds = Array.from(find("moqui.resource.GitWebhook", {repositoryId: p.repositoryId}).limit(100).list()).map(
            hook => hook.webhookId
        )
        const recent = find("moqui.service.message.SystemMessage", {systemMessageTypeId: "GitWebhook", docType: "ping"})
            .condition("receiverId", "in", hookIds)
            .condition("initDate", "greater", stamp(millis(now()) - 60000))
            .count()
        if (recent >= TESTS_A_MINUTE) fail("Tarpit", "rateLimited: Wait a minute before testing a webhook again")
        const {out, problem} = called(GIT + "test#GitWebhook", {webhookId: p.webhookId})
        maintainerAudit(p, "testWebhook", p.webhookId)
        // delivered or not, and the status a host answered with: why a delivery failed (an address the outbound rules
        // refuse, a name that does not resolve, a host that does not answer) is not told apart
        const delivered = problem == null && !!out?.delivered
        return {
            statusCode: out?.statusCode == null || out.statusCode === "" ? null : Number(out.statusCode),
            delivered,
            errorText: delivered ? null : "The delivery failed"
        }
    }
    methods.findWebhookDeliveries = p => {
        maintained(p)
        hookOf(p, p.webhookId)
        const pg = page(p, "smithy-webhook-deliveries:" + p.webhookId)
        // the framework pages by index: a cursor's place is a multiple of the page's size
        const {out, problem} = called(GIT + "find#GitWebhookDeliveries", {
            webhookId: p.webhookId,
            pageIndex: Math.floor(pg.offset / pg.limit),
            pageSize: pg.limit
        })
        if (problem != null) missing()
        const place = (Math.floor(pg.offset / pg.limit) + 1) * pg.limit
        return {
            deliveryList: Array.from(out.deliveryList || []).map(delivery => ({
                event: delivery.event || null,
                date: delivery.initDate || null,
                statusCode: delivery.httpStatus == null || delivery.httpStatus === "" ? null : Number(delivery.httpStatus),
                delivered: delivery.statusId === "SmsgSent"
            })),
            nextCursor: Number(out.deliveryListCount || 0) > place ? pg.next(place) : null
        }
    }

    // ===== git access: the account's SSH keys and access tokens (§11 GitAccess) =====
    const MAX_CREDENTIALS = 20
    const RECENT_SIGN_IN = 15 * 60000
    /* Before a credential is made the account proves again who it is: with a password, the password (and the second
       factor's code where it has one), as Forum's setSiteRole asks; with none (it signs in through a provider), a
       sign-in within the last 15 minutes, by the framework's login history. */
    function reauthenticate(p) {
        const account = one("moqui.security.UserAccount", {userId: ec.user.userId})
        if (!account) fail("AuthenticationRequired", "Sign in to continue")
        if (!account.currentPassword) {
            const recent = find("moqui.security.UserLoginHistory", {userId: account.userId, successfulLogin: "Y"})
                .condition("fromDate", "greater", stamp(millis(now()) - RECENT_SIGN_IN))
                .count()
            if (!recent) fail("AuthenticationRequired", "recentSignInRequired: Sign in again to change your git access")
            return
        }
        const auth = ec.service
            .sync()
            .name(USER + "login#UserAccount")
            .parameters({username: account.username, password: p.password, code: p.code})
            .call()
        const refused = ec.message.hasError() || !auth?.loggedIn
        ec.message.clearErrors()
        if (refused) fail("AuthenticationRequired", "signInRequired: Enter your password again to change your git access")
    }
    /* Where git over SSH is reached, as the framework builds a clone address (get#GitCloneUrls) from the server's
       settings: what stands before a repository's path; none where the SSH server has no port. */
    function sshAddress() {
        const setting = name => text(System.getProperty(name)).trim()
        const port = setting("ssh_public_port") || setting("ssh_port")
        if (!port || port === "0") return null
        const host =
            [setting("ssh_public_host"), setting("webapp_http_host"), setting("ssh_host")].find(
                name => name && name !== "0.0.0.0"
            ) || "localhost"
        const user = ec.user.username || "username"
        return port === "22" ? user + "@" + host + ":" : "ssh://" + user + "@" + host + ":" + port + "/"
    }
    /* A change of the account's own credentials, in the site's log: what was done and never a key or a token. */
    const credentialAudit = (siteId, action, what) =>
        audit(siteId, null, "member", me(), action, text(what).slice(0, 255), null, null)
    /* The account's keys and tokens, by the framework's lists (N-KEYS); null when it has none to ask. */
    function credentials() {
        const keys = called(USER + "find#UserSshKeys", {})
        const tokens = called(USER + "find#UserAccessTokens", {})
        if (keys.out == null || tokens.out == null) return null
        return {
            // when a key or a token was last used is not kept by the framework
            sshKeyList: Array.from(keys.out.sshKeyList || []).map(key => ({
                sshKeyId: key.sshKeyId,
                name: key.description || "",
                keyType: key.keyType || null,
                fingerprint: key.fingerprint || null,
                createdAt: key.fromDate || null,
                lastUsedAt: null
            })),
            tokenList: Array.from(tokens.out.accessTokenList || []).map(token => ({
                tokenId: token.tokenId,
                name: token.description || "",
                createdAt: token.fromDate || null,
                expiresAt: token.thruDate || null,
                lastUsedAt: null
            }))
        }
    }
    methods.findGitAccess = p => {
        core.site(p.siteId)
        requireUser()
        const found = credentials() || invalid("Your keys and tokens cannot be listed now")
        return {...found, sshAddress: sshAddress(), confirmed: core.confirmedNow()}
    }
    methods.addSshKey = p => {
        core.site(p.siteId)
        writer(p.siteId)
        if (!text(p.publicKey).trim()) invalid("publicKey is required")
        reauthenticate(p)
        // the receipt's key leaves out what proved who asks
        const {password, code, ...asked} = p
        return receipt(asked, "smithy.addSshKey", () => {
            if ((credentials()?.sshKeyList.length ?? MAX_CREDENTIALS) >= MAX_CREDENTIALS)
                invalid("quotaExceeded: An account has at most " + MAX_CREDENTIALS + " SSH keys")
            const {out, problem} = called(USER + "create#UserSshKey", {
                publicKey: text(p.publicKey).trim(),
                description: text(p.name).trim().slice(0, 255) || null
            })
            // the framework gives this refusal no code: its words are read
            if (problem != null && /already in use$/.test(problem)) fail("Conflict", "That key is in use")
            if (problem != null || !out?.sshKeyId) invalid(text(problem || "That is no SSH public key").slice(0, 200))
            credentialAudit(p.siteId, "addSshKey", out.fingerprint)
            return {sshKeyId: out.sshKeyId, fingerprint: out.fingerprint || null}
        })
    }
    methods.removeSshKey = p => {
        core.site(p.siteId)
        requireUser()
        // an account's own key only, by the framework's rule; one that is not there is Not Found
        if (typeof p.sshKeyId !== "string" || !p.sshKeyId) missing()
        const {problem} = called(USER + "delete#UserSshKey", {sshKeyId: p.sshKeyId})
        if (problem != null) missing()
        credentialAudit(p.siteId, "removeSshKey", p.sshKeyId)
        return {deleted: true}
    }
    methods.createAccessToken = p => {
        core.site(p.siteId)
        writer(p.siteId)
        const name = text(p.name).trim().slice(0, 255)
        if (!name) invalid("name is required")
        let expireDays = null
        if (p.expiresAt) {
            const until = ec.l10n.parseTimestamp(text(p.expiresAt), null)
            const days = until ? (ec.user.timestampMillis(until) - ec.user.timestampMillis(ec.user.nowTimestamp)) / 86400000 : 0
            if (!(days > 0) || days > 366) invalid("expiresAt is a date within a year from now")
            expireDays = days
        }
        reauthenticate(p)
        const {password, code, ...asked} = p
        // the token is shown once: the receipt keeps the id and never the token (ForumCore.receipt leaves it out)
        // the framework writes a login key in a transaction of its own, and that row refers to the account's: the
        // account's retries are put in order by its party's row, not by the account row the key would wait for
        const inOrder = () => one("mantle.party.Party", {partyId: me()}, true)
        const create = () => {
            if ((credentials()?.tokenList.length ?? MAX_CREDENTIALS) >= MAX_CREDENTIALS)
                invalid("quotaExceeded: An account has at most " + MAX_CREDENTIALS + " access tokens")
            const {out, problem} = called(USER + "create#UserAccessToken", {
                description: name,
                ...(expireDays ? {expireDays} : {})
            })
            if (problem != null || !out?.accessToken) invalid("The token could not be made")
            credentialAudit(p.siteId, "createAccessToken", name)
            // expiresAt is when the framework ends it: the date asked, else its 90 days
            return {tokenId: out.tokenId || out.loginKey, token: out.accessToken, expiresAt: out.thruDate || null}
        }
        return receipt(asked, "smithy.createAccessToken", create, inOrder)
    }
    methods.revokeAccessToken = p => {
        core.site(p.siteId)
        requireUser()
        if (typeof p.tokenId !== "string" || !p.tokenId) missing()
        // the framework takes a token's id by either name
        const {problem} = called(USER + "revoke#UserAccessToken", {tokenId: p.tokenId, loginKey: p.tokenId})
        if (problem != null) missing()
        credentialAudit(p.siteId, "revokeAccessToken", "")
        return {revoked: true}
    }
    /* The Account hub's card (get#AccountCard, §11): the counts of the account's keys and tokens and of its
       repositories, with whether a push would be taken; null on a site that does not mount Smithy. */
    function accountCard(siteId) {
        const partyId = me()
        if (!partyId || !publicApps().mount(siteId, "smithy")) return null
        const found = credentials()
        const counted = (count, one, many) => count + " " + (count === 1 ? one : many)
        const repositories = find(M + "SmithyRepository", {siteId, ownerPartyId: partyId}).count()
        const handle = handleOf(siteId, partyId)
        const gitAccess = publicApps().pageUrl(siteId, "account", "/GitAccess")
        const links = [{text: "Git access", url: gitAccess}]
        if (handle) links.push({text: "My repositories", url: publicApps().pageUrl(siteId, "smithy", "/" + handle)})
        return {
            title: "Git access",
            lines: [
                ...(found
                    ? [
                          counted(found.sshKeyList.length, "SSH key", "SSH keys"),
                          counted(found.tokenList.length, "access token", "access tokens")
                      ]
                    : []),
                counted(repositories, "repository", "repositories"),
                ...(core.confirmedNow() ? [] : ["Confirm your email address to push"])
            ],
            url: gitAccess,
            links,
            sshKeyCount: found ? found.sshKeyList.length : null,
            tokenCount: found ? found.tokenList.length : null,
            repositoryCount: repositories,
            confirmed: core.confirmedNow()
        }
    }

    // ===== the checks the git server asks =====
    const accountUrl = siteId => publicApps().pageUrl(siteId, "account", "") || "your Account page"
    /* What refuses a push or an upload by an account, whatever its size: no confirmed address, a suspension, a site
       that no longer mounts Smithy, an archived repository. */
    function refusedAccount(repo, userId, what) {
        const account = userId ? one("moqui.security.UserAccount", {userId}) : null
        if (!account || !core.confirmed(account.userId))
            return what + " needs an account with a confirmed email address. Confirm yours at " + accountUrl(repo.siteId)
        if (account.partyId && sanctioned(repo.siteId, account.partyId, null, "suspend"))
            return "Your account is suspended on this site"
        if (!core.mounted(repo.siteId)) return "This site no longer hosts repositories: this one is read only"
        if (one(GIT_REPOSITORY, {repositoryId: repo.repositoryId})?.archivedDate)
            return "This repository is archived and read only"
        return null
    }
    const UNKNOWN = "What this repository stores cannot be read now, so nothing is added to it; try again later"
    /* The push gate (§5.5 SmithyPushGate): the problems that refuse a push to a repository Smithy has, none to accept it
       and none for a repository with no SmithyRepository row, which is pushed to as before. The one check
       (check#GitRepositoryAuthz) has decided who may push at all; this refuses an account without a confirmed address or
       under a suspension, a site without Smithy, an archived repository, and a pack that would take the repository past
       its namespace's limit for one repository. Only the pushed repository's stored bytes are asked for, and a push
       is refused when they cannot be read. A push that adds nothing (packBytes 0: deletes only) is not held to the
       size, so a repository over its limit can be made smaller. Git LFS bytes come only by an upload, which
       checkLfsUpload holds to its limit. c: the pre-receive context (repositoryId, userId, packBytes). */
    function checkPush(c) {
        const repo = c.repositoryId ? one(M + "SmithyRepository", {repositoryId: c.repositoryId}) : null
        if (!repo) return []
        const refused = refusedAccount(repo, c.userId, "A push")
        if (refused) return [refused]
        const packBytes = Math.max(0, Number(c.packBytes || 0))
        if (packBytes === 0) return []
        const limits = quota.repositoryQuota(repo)
        const used = quota.usageOf([repo.repositoryId])
        if (!used) return [UNKNOWN]
        if (Number(used.get(repo.repositoryId).storedBytes || 0) + packBytes > limits.repositoryBytes)
            return ["quotaExceeded: This push takes the repository past its size limit of " + limits.repositoryBytes + " bytes"]
        return []
    }
    /* The LFS upload check (§11 Quotas, N-LFS-HOOK): LFS uploads do not pass pre-receive, so the same account rules
       and the namespace's LFS limit are asked before an upload is accepted: the LFS bytes of the namespace's
       repositories (asked of the framework 1,000 at a time) with the upload's. Refused when they cannot be read.
       c: repositoryId, userId, uploadBytes. */
    function checkLfsUpload(c) {
        const repo = c.repositoryId ? one(M + "SmithyRepository", {repositoryId: c.repositoryId}) : null
        if (!repo) return []
        const refused = refusedAccount(repo, c.userId, "An upload")
        if (refused) return [refused]
        const limits = quota.repositoryQuota(repo)
        const ids = limits.lfsRepositoryIds()
        const used = quota.usageOf(ids.includes(repo.repositoryId) ? ids : ids.concat([repo.repositoryId]))
        if (!used) return [UNKNOWN]
        const lfsBytes = ids.reduce((sum, id) => sum + Number(used.get(id)?.lfsBytes || 0), 0)
        if (lfsBytes + Math.max(0, Number(c.uploadBytes || 0)) > limits.lfsBytes)
            return ["quotaExceeded: This upload takes its Git LFS files past the limit of " + limits.lfsBytes + " bytes"]
        return []
    }
    return {checkPush, checkLfsUpload, accountCard}
}
